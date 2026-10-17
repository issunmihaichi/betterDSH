import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../lib/config.js';
import { createAttributionFacade, createDiagnostics } from '../lib/attribution.js';
import { validateSelection, currentSelection, reviewerChoices, installReviewerManagement } from '../lib/reviewer-model.js';
import { mockContext, sessionFixture, deferred } from './fixtures.mjs';

function poolLlm(llm) {
  llm.listProviders = () => [{ id: 'pool-g' }, { id: 'chat' }];
  llm.listConfigurableProviders = () => [{ provider: 'pool-g', displayName: 'Pool group', settingsNs: 'custom-pool' }, { provider: 'pool-dormant', displayName: 'Dormant' }, { provider: 'chat', displayName: 'Chat' }];
  llm.listModels = async provider => { assert.equal(provider, 'pool-g'); return [{ id: 'review-1', name: 'Reviewer one' }, { id: 'review-2', name: 'Reviewer two' }]; };
}
function wrapped(config, options = {}) {
  const h = mockContext(options); poolLlm(h.ctx.llm);
  h.ctx.loader = { entries: () => [{ options: { name: 'dsh-account-pool', id: 'custom-pool' }, fiber: {} }] };
  const { state } = createDiagnostics({ compatible: true });
  const { facade } = createAttributionFacade(h.ctx, state, { reviewerModel: () => currentSelection(config), ...options });
  facade.on('tools/pre-execute', (_exec, next) => ({ stream: facade.llm.stream(Object.freeze({ provider: 'chat', model: 'chat-model', system: 'fixed-policy', messages: Object.freeze([]), temperature: 0, signal: _exec.signal })), next }));
  return { ...h, facade, state };
}
async function consume(stream) { for await (const _ of stream) {} }

test('selection validates exact routes and captures detached plain or volatile config', () => {
  const config = Config({ reviewerModel: { mode: 'fixed', provider: 'pool-g', model: 'review-1' } });
  assert.deepEqual(currentSelection(config), { mode: 'fixed', provider: 'pool-g', model: 'review-1' });
  assert.deepEqual(currentSelection({}), { mode: 'session' });
  for (const value of [null, [], { mode: 'fixed' }, { mode: 'fixed', provider: ' pool-g', model: 'review-1' }, { mode: 'session', model: 'review-1' }, { mode: 'fixed', provider: 'pool-g', model: 'review-1', extra: true }]) assert.throws(() => validateSelection(value));
});

test('directory offers active advertised pool group routes only', async () => {
  const llm = {}; poolLlm(llm);
  assert.deepEqual(await reviewerChoices(llm), [
    { provider: 'pool-g', providerName: 'Pool group', model: 'review-1', modelName: 'Reviewer one' },
    { provider: 'pool-g', providerName: 'Pool group', model: 'review-2', modelName: 'Reviewer two' },
  ]);
});

test('fixed review changes only route; policy, provenance, signals, freeze and chat stay intact', async () => {
  const config = { reviewerModel: { mode: 'fixed', provider: 'pool-g', model: 'review-1' } };
  const h = wrapped(config); const { exec } = sessionFixture();
  const returned = h.handler(exec, () => {}); assert.equal(returned.stream.then, undefined);
  config.reviewerModel = { mode: 'fixed', provider: 'pool-g', model: 'review-2' };
  await consume(returned.stream);
  const options = h.requests[0];
  assert.equal(options.provider, 'pool-g'); assert.equal(options.model, 'review-1', 'eager snapshot');
  assert.equal(options.system, 'fixed-policy'); assert.equal(options.temperature, 0); assert.equal(options.signal, exec.signal);
  assert.equal(Object.isFrozen(options), true); assert.equal(Object.isFrozen(options.messages), true);
  assert.equal(options.codexRequestProvenance.ownerSessionId, 'session-A'); assert.equal(Object.isFrozen(options.codexRequestProvenance), true);
  const chat = { provider: 'chat', model: 'chat-model' }; h.ctx.llm.stream(chat);
  assert.equal(h.requests[1], chat);
  await returned.next();
  const outside = h.facade.llm.stream(chat); await consume(outside);
  assert.equal(h.requests[2], chat, 'facade outside ALS never overrides route');
});

test('session mode keeps native route and synchronous stream return type', async () => {
  const h = wrapped({}); const { exec } = sessionFixture();
  await consume(h.handler(exec, () => {}).stream);
  assert.equal(h.requests[0].provider, 'chat'); assert.equal(h.requests[0].model, 'chat-model');
});

for (const selection of [{ mode: 'fixed', provider: 'pool-g', model: 'deleted' }, { mode: 'fixed', provider: 'deleted-provider', model: 'review-1' }]) test(`unavailable fixed selection fails before dispatch (${selection.provider}/${selection.model})`, async () => {
  const h = wrapped({ reviewerModel: selection }); const { exec } = sessionFixture();
  await assert.rejects(consume(h.handler(exec, () => {}).stream), /not an available pool model/);
  assert.equal(h.requests.length, 0);
});

test('invalid fixed configuration is not caught by observational fallback', () => {
  const h = wrapped({ reviewerModel: { mode: 'fixed' } }); const { exec } = sessionFixture();
  assert.throws(() => h.handler(exec, () => {})); assert.equal(h.requests.length, 0);
});

test('attribution UUID failure preserves selected fixed route rather than reverting to session', async () => {
  const h = wrapped({ reviewerModel: { mode: 'fixed', provider: 'pool-g', model: 'review-1' } }, { requestId() { throw new Error('uuid'); } });
  await consume(h.handler(sessionFixture().exec, () => {}).stream);
  assert.equal(h.requests[0].model, 'review-1'); assert.equal(h.requests[0].codexRequestProvenance, undefined); assert.equal(h.state.missingProvenance, 1);
});

test('concurrent calls retain separate model snapshots and owners', async () => {
  const config = { reviewerModel: { mode: 'fixed', provider: 'pool-g', model: 'review-1' } }; const h = wrapped(config);
  const a = h.handler(sessionFixture({ id: 'A' }).exec, () => {}).stream;
  config.reviewerModel = { mode: 'fixed', provider: 'pool-g', model: 'review-2' };
  const b = h.handler(sessionFixture({ id: 'B' }).exec, () => {}).stream;
  await Promise.all([consume(a), consume(b)]);
  assert.deepEqual(h.requests.map(row => [row.model, row.codexRequestProvenance.ownerSessionId]), [['review-1', 'A'], ['review-2', 'B']]);
});

test('abort during model discovery prevents provider dispatch', async () => {
  const h = wrapped({ reviewerModel: { mode: 'fixed', provider: 'pool-g', model: 'review-1' } }); const barrier = deferred();
  h.ctx.llm.listModels = async () => { await barrier.promise; return [{ id: 'review-1', name: 'one' }]; };
  const controller = new AbortController(); const { exec } = sessionFixture(); exec.signal = controller.signal;
  const consumption = consume(h.handler(exec, () => {}).stream); controller.abort(); barrier.resolve();
  await assert.rejects(consumption); assert.equal(h.requests.length, 0);
});

function management({ compatible = true } = {}) {
  const config = { reviewerModel: { mode: 'session' } }; const disposers = []; let route, revision = 4; const writes = [];
  const llm = {}; poolLlm(llm);
  class SettingsConflictError extends Error {}
  const settings = {
    describe(options) { assert.equal(options.redactSecrets, true); return [{ ns: 'custom-review-entry', revision, value: { originalModulePath: 'SECRET-PATH' } }]; },
    async mutate(ns, ops, expected) { if (expected !== revision) throw new SettingsConflictError('stale'); writes.push({ ns, ops, expected }); assert.deepEqual(ops[0].path, ['reviewerModel']); assert.equal(ops[0].op, 'set'); config.reviewerModel = structuredClone(ops[0].value); revision++; },
  };
  const child = { settings, connection: { fetch: { register(value) { route = value; return () => { route = undefined; }; } } }, effect(callback) { disposers.push(callback()); } };
  const ctx = { llm, loader: { entries: () => [{ options: { name: 'dsh-account-pool', id: 'custom-pool' }, fiber: {} }] }, fiber: { entry: { options: { id: 'custom-review-entry' } } }, inject(keys, callback) { assert.deepEqual(keys, ['connection', 'settings']); callback(child); } };
  installReviewerManagement(ctx, config, { compatible });
  const request = (method = 'GET', body) => route.fetch(new Request('http://localhost/api/autoReview.model', { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  return { request, writes, get route() { return route; }, dispose() { for (const dispose of disposers) dispose(); } };
}

test('authenticated fetch channel and sanitized response; official namespace persistence only', async () => {
  const h = management(); assert.equal(h.route.path, '/api/autoReview.model');
  const get = await h.request(); assert.equal(get.status, 200); assert.equal(get.headers.get('cache-control'), 'no-store');
  const data = await get.json(); assert.equal(data.revision, 4); assert.equal(data.settingsNs, 'custom-review-entry'); assert.equal(data.choices.length, 2); assert.equal(JSON.stringify(data).includes('SECRET-PATH'), false);
  const post = await h.request('POST', { selection: { mode: 'fixed', provider: 'pool-g', model: 'review-1' }, expectedRevision: 4 });
  assert.equal(post.status, 200); assert.equal((await post.json()).selection.model, 'review-1');
  assert.deepEqual(h.writes, [{ ns: 'custom-review-entry', ops: [{ op: 'set', path: ['reviewerModel'], value: { mode: 'fixed', provider: 'pool-g', model: 'review-1' } }], expected: 4 }]);
  const reset = await h.request('POST', { selection: { mode: 'session' }, expectedRevision: 5 });
  assert.equal(reset.status, 200); assert.deepEqual((await reset.json()).selection, { mode: 'session' });
  h.dispose(); assert.equal(h.route, undefined);
});

test('stale saves conflict, invalid routes never persist; session resets without catalog validation', async () => {
  const h = management();
  assert.equal((await h.request('POST', { selection: { mode: 'session' }, expectedRevision: 3 })).status, 409);
  for (const body of [{ selection: { mode: 'fixed', provider: 'pool-g', model: 'absent' } }, { selection: { mode: 'session' }, expectedRevision: -1 }, { selection: { mode: 'session' }, originalModulePath: 'unsafe' }, {}]) assert.equal((await h.request('POST', body)).status, 400);
  assert.equal(h.writes.length, 0);
  assert.equal((await h.request('POST', { selection: { mode: 'session' } })).status, 200);
});

test('incompatible native source rejects management without touching settings', async () => {
  const h = management({ compatible: false }); assert.equal((await h.request()).status, 503);
  assert.equal((await h.request('POST', { selection: { mode: 'session' } })).status, 503); assert.equal(h.writes.length, 0);
});
