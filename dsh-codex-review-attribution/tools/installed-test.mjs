// Runs only mock services against the canonical installed original via Electron.
// No real LLM adapter or real tool execution is installed or invoked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { apply, Config } from '../lib/host.js';
import { loadOriginal, preflight, REVIEWED_SHA256 } from '../lib/original.js';
import { installOriginal } from '../lib/installation.js';
import { mockContext, sessionFixture, decisionStream, deferred } from './fixtures.mjs';

if (!process.versions.electron) throw new Error('Use ELECTRON_RUN_AS_NODE=1 with installed DeepSeek Harness.exe');
const dshRoot = path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'dsh');
const require = createRequire(path.join(dshRoot, 'package.json'));
const modulePath = process.env.DSH_AUTO_REVIEW_MODULE_PATH ?? require.resolve('@deepseek-ai/dsh-experimental-auto-review');
const config = { originalModulePath: modulePath };
const loaded = loadOriginal(config);
const original = loaded.original;
const { AUTO_PRESET } = require('@deepseek-ai/dsh-permission-presets');
const { RUN_CODE_NAME } = require('@deepseek-ai/dsh-tools');
function fixture(options = {}) { const value = sessionFixture(options); value.session.preset = options.preset ?? AUTO_PRESET; return value; }

function install(harness, wrapped) { if (wrapped) apply(harness.ctx, config); else original.apply(harness.ctx); return harness; }
async function runCase({ mode, response, approval, downstream = { kind: 'allow' }, valid = true, stream, abort = false }, wrapped) {
  const { session, exec } = fixture({ mode, valid });
  if (abort) { const controller = new AbortController(); controller.abort(new Error('mock abort')); exec.signal = controller.signal; }
  const h = install(mockContext({ response, approval, sessions: [session], stream }), wrapped);
  let calls = 0; const result = await h.handler(exec, async () => { calls += 1; return downstream; });
  const requests = [...h.requests]; const diagnostics = h.provided.get('codexReviewAttribution')?.snapshot();
  await h.dispose();
  assert.equal(h.handlers.length, 0); assert.equal(h.registered, 0); assert.equal(session.preset, 'danger-full-access');
  return { result, calls, requests, diagnostics };
}

// Compare outputs of the ORIGINAL registered handler with wrapped ORIGINAL handler.
for (const mode of ['native', 'ptc']) for (const scenario of [
  { label: 'allow-low', response: '{"risk":"low","decision":"allow"}', approval: 'never' },
  { label: 'allow-medium', response: '{"risk":"medium","decision":"allow"}', approval: 'ask' },
  { label: 'deny-never', response: '{"risk":"high","decision":"deny","reason":"mock sensitive action"}', approval: 'never' },
  { label: 'ask', response: '{"risk":"medium","decision":"deny","reason":"authorization missing"}', approval: 'ask' },
  { label: 'ask-keeps-downstream-deny', response: '{"risk":"medium","decision":"deny"}', approval: 'ask', downstream: { kind: 'deny', reason: 'downstream' } },
  { label: 'allow-keeps-cancel', response: '{"risk":"low","decision":"allow"}', downstream: { kind: 'cancel' } },
  { label: 'invalid-json', response: 'not JSON' },
  { label: 'invalid-high-allow', response: '{"risk":"high","decision":"allow"}' },
  { label: 'invalid-low-deny', response: '{"risk":"low","decision":"deny"}' },
  { label: 'invalid-duplicate-member', response: '{"risk":"low","risk":"low","decision":"allow"}' },
  { label: 'provider-error', stream: () => decisionStream(undefined, { error: new Error('mock provider failure') }) },
  { label: 'provider-sync-error', stream: () => { throw new Error('mock synchronous provider failure'); } },
  { label: 'stream-aborted', stream: () => decisionStream(undefined, { finish: { kind: 'aborted', failure: { code: 'ABORTED', message: 'mock abort' } } }) },
  { label: 'stream-error', stream: () => decisionStream(undefined, { finish: { kind: 'error', failure: { code: 'MOCK', message: 'mock error' } } }) },
  { label: 'invalid-snapshot', valid: false },
]) test(`installed original vs wrapped: ${mode}/${scenario.label}`, async () => {
  const direct = await runCase({ ...scenario, mode }, false), wrapped = await runCase({ ...scenario, mode }, true);
  assert.deepEqual(wrapped.result, direct.result); assert.equal(wrapped.calls, direct.calls);
  assert.equal(wrapped.requests.length, direct.requests.length);
  for (let i = 0; i < wrapped.requests.length; i++) {
    const { signal: directSignal, ...directOptions } = direct.requests[i];
    const { signal: wrappedSignal, codexRequestProvenance, ...wrappedOptions } = wrapped.requests[i];
    assert.deepEqual(wrappedOptions, directOptions);
    assert.equal(directSignal.aborted, wrappedSignal.aborted);
    assert.deepEqual(Object.keys(codexRequestProvenance), ['version', 'kind', 'ownerSessionId', 'requestId']);
    assert.equal(codexRequestProvenance.ownerSessionId, 'session-A'); assert.equal(codexRequestProvenance.kind, 'auto-review');
    assert.equal(Object.isFrozen(wrapped.requests[i]), Object.isFrozen(direct.requests[i]));
    assert.equal(Object.hasOwn(wrapped.requests[i], 'sessionId'), false); assert.equal(Object.hasOwn(wrapped.requests[i], 'purpose'), false);
  }
});

for (const kind of ['no-agent', 'non-auto', 'outer-run-code']) test(`installed skip remains exact: ${kind}`, async () => {
  for (const wrapped of [false, true]) {
    const { exec, session } = fixture();
    if (kind === 'no-agent') delete exec.agent;
    if (kind === 'non-auto') session.preset = 'read-only';
    if (kind === 'outer-run-code') exec.name = RUN_CODE_NAME;
    const h = install(mockContext({ sessions: [session] }), wrapped); const sentinel = { kind: 'allow' }; let calls = 0;
    assert.equal(await h.handler(exec, async () => { calls += 1; return sentinel; }), sentinel);
    assert.equal(calls, 1); assert.equal(h.requests.length, 0); await h.dispose();
  }
});

test('actual gate downstream does not inherit provenance and references survive clone', async () => {
  const { exec, session } = fixture(); const h = install(mockContext({ sessions: [session] }), true);
  const other = { model: 'other', messages: [] };
  await h.handler(exec, async () => { h.ctx.llm.stream(other); return { kind: 'allow' }; });
  assert.equal(h.requests[1], other); assert.equal(h.requests[1].codexRequestProvenance, undefined);
  await h.dispose();
});

test('actual incompatible install branch passes real ctx to official apply and does not bypass deny', async () => {
  const { exec, session } = fixture(); const h = mockContext({ response: '{"risk":"high","decision":"deny"}', sessions: [session] });
  // Simulate only the compatibility oracle, never modify the installed source/ASAR.
  installOriginal(h.ctx, { ...loaded, compatible: false, moduleSha256: 'mock-unreviewed-hash',
    original: { ...original, apply(ctx) { assert.equal(ctx, h.ctx); return original.apply(ctx); } } });
  let calls = 0; const result = await h.handler(exec, () => { calls += 1; return { kind: 'allow' }; });
  assert.equal(result.kind, 'deny'); assert.equal(calls, 0); assert.equal(h.requests[0].codexRequestProvenance, undefined);
  const snapshot = h.provided.get('codexReviewAttribution').snapshot(); assert.equal(snapshot.status, 'disabled-incompatible'); assert.equal(snapshot.augmentationEnabled, false);
  await h.dispose();
});

test('facade startup failure still installs official fail-closed gate', async () => {
  const { exec, session } = fixture(); const h = mockContext({ sessions: [session] }); h.ctx.llm = null;
  apply(h.ctx, config); assert.equal(h.registered, 1);
  const snapshot = h.provided.get('codexReviewAttribution').snapshot(); assert.equal(snapshot.status, 'disabled-missing'); assert.equal(snapshot.missingProvenance, 1);
  const result = await h.handler(exec, () => { throw new Error('must not bypass'); }); assert.equal(result.kind, 'deny');
  assert.match(result.reason, /failed/); await h.dispose();
});

test('actual augmentation failure preserves official reviewer denial and increments missing', async () => {
  const { exec, session } = fixture(); session.id = '';
  const h = install(mockContext({ response: '{"risk":"high","decision":"deny"}', sessions: [session] }), true);
  const result = await h.handler(exec, () => { throw new Error('must not bypass'); });
  assert.equal(result.kind, 'deny'); assert.equal(h.requests[0].codexRequestProvenance, undefined);
  assert.equal(h.provided.get('codexReviewAttribution').snapshot().missingProvenance, 1); await h.dispose();
});

test('actual exec abort results are identical', async () => {
  const stream = options => options.signal.aborted ? decisionStream(undefined, { finish: { kind: 'aborted', failure: { code: 'MOCK_ABORT', message: 'already aborted' } } }) : decisionStream('{"risk":"low","decision":"allow"}');
  const direct = await runCase({ mode: 'native', stream, abort: true }, false), wrapped = await runCase({ mode: 'native', stream, abort: true }, true);
  assert.deepEqual(wrapped.result, direct.result); assert.equal(wrapped.result.kind, 'deny'); assert.equal(wrapped.calls, 0);
});

test('actual concurrent native/PTC lifecycles abort before drain, no companion deadlock', { timeout: 3000 }, async () => {
  const a = fixture({ id: 'owner-A', mode: 'native' }), b = fixture({ id: 'owner-B', mode: 'ptc' });
  const entered = deferred(); let count = 0;
  const h = install(mockContext({ sessions: [a.session, b.session], stream(options) {
    if (++count === 2) entered.resolve();
    return (async function* () {
      if (!options.signal.aborted) await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'mock lifecycle abort' } } };
    })();
  } }), true);
  const pending = [h.handler(a.exec, () => { throw new Error('must not execute'); }), h.handler(b.exec, () => { throw new Error('must not execute'); })];
  await entered.promise;
  const service = h.provided.get('codexReviewAttribution');
  assert.deepEqual(h.requests.map(option => option.codexRequestProvenance.ownerSessionId), ['owner-A', 'owner-B']);
  assert.equal(new Set(h.requests.map(option => option.codexRequestProvenance.requestId)).size, 2);
  await h.dispose(); assert.deepEqual(await Promise.all(pending), [{ kind: 'cancel' }, { kind: 'cancel' }]);
  assert.equal(h.registered, 0); assert.equal(h.handlers.length, 0); assert.equal(h.provided.size, 0);
  assert.equal(service.snapshot().status, 'disposed'); assert.equal(service.snapshot().augmentationEnabled, false);
});

test('actual lifecycle cancels when disposal occurs during downstream', { timeout: 3000 }, async () => {
  const { exec, session } = fixture(); const entered = deferred(), release = deferred(); const h = install(mockContext({ sessions: [session] }), true);
  const pending = h.handler(exec, async () => { entered.resolve(); await release.promise; return { kind: 'allow' }; }); await entered.promise;
  const closing = h.dispose(); release.resolve(); await closing; assert.deepEqual(await pending, { kind: 'cancel' });
});

test('installed canonical hash parity and deployment preflight', () => {
  assert.equal(loaded.moduleSha256, REVIEWED_SHA256[0]);
  assert.equal(preflight(config).canDisableOriginal, false);
  assert.throws(() => preflight(config, { disableOriginal: true }));
  assert.throws(() => preflight({ ...config, disabled: true }, { disableOriginal: true, companionEnabled: true }));
  assert.equal(preflight(config, { disableOriginal: true, companionEnabled: true }).canDisableOriginal, true);
  const h = mockContext(); assert.throws(() => apply(h.ctx, { originalModulePath: path.join(dshRoot, 'not-installed.js') })); assert.equal(h.registered, 0); assert.equal(h.handlers.length, 0);
});

for (const mode of ['native', 'ptc']) for (const available of [true, false]) test(`fixed reviewer with installed native gate: ${mode}/available=${available}`, async () => {
  const { session, exec } = fixture({ mode });
  const h = mockContext({ response: '{"risk":"high","decision":"deny"}', sessions: [session] });
  h.ctx.loader = { entries: () => [{ options: { name: 'dsh-account-pool', id: 'custom-pool' }, fiber: {} }] };
  h.ctx.llm.listProviders = () => [{ id: 'pool-test' }];
  h.ctx.llm.listConfigurableProviders = () => [{ provider: 'pool-test', displayName: 'test', settingsNs: 'custom-pool' }];
  h.ctx.llm.listModels = async () => available ? [{ id: 'review-model', name: 'Reviewer' }] : [];
  const headerBefore = structuredClone(session.requestHeader());
  apply(h.ctx, { ...config, reviewerModel: { mode: 'fixed', provider: 'pool-test', model: 'review-model' } });
  const result = await h.handler(exec, () => { throw new Error('reviewer must never bypass deny'); });
  assert.equal(result.kind, 'deny'); assert.deepEqual(session.requestHeader(), headerBefore, 'chat header is never mutated');
  if (available) {
    assert.equal(h.requests[0].provider, 'pool-test'); assert.equal(h.requests[0].model, 'review-model');
    assert.equal(h.requests[0].temperature, 0); assert.equal(Object.isFrozen(h.requests[0]), true);
    assert.equal(h.requests[0].codexRequestProvenance.ownerSessionId, session.id);
    assert.equal(Object.hasOwn(h.requests[0], 'reasoningEffort'), false);
  } else { assert.equal(h.requests.length, 0); assert.match(result.reason, /failed/); }
  await h.dispose();
});

test('real Cordis accepts minimal Config and fiber-owned diagnostic service', async () => {
  const { Context } = require('@deepseek-ai/cordis'); const root = new Context(); let service;
  const fiber = root.plugin({ name: 'mock-attribution-service', Config, apply(ctx, resolved) {
    assert.equal(resolved.originalModulePath, modulePath);
    service = Object.freeze({ snapshot: () => ({ version: 1 }) });
    ctx.effect(function* () { yield ctx.provide('codexReviewAttribution', service); yield () => {}; });
  } }, config);
  await fiber; assert.equal(root.get('codexReviewAttribution'), service);
  await fiber.dispose(); assert.equal(root.get('codexReviewAttribution'), undefined);
});
