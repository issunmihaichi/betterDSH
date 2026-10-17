import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttributionFacade, createDiagnostics } from '../lib/attribution.js';
import { assertOriginalShape, ORIGINAL_INJECT, REVIEWED_SHA256, loadOriginal } from '../lib/original.js';
import { Config } from '../lib/config.js';
import { apply } from '../lib/host.js';
import { fileURLToPath } from 'node:url';
import { mockContext, sessionFixture, deferred } from './fixtures.mjs';

function wire(harness, callback, { compatible = true, requestId } = {}) {
  const { state, service } = createDiagnostics({ compatible, moduleSha256: REVIEWED_SHA256[0] });
  const attribution = createAttributionFacade(harness.ctx, state, requestId ? { requestId } : {});
  callback(attribution.facade);
  return { ...attribution, state, service };
}

for (const frozen of [false, true]) test(`sync stream keeps route/message/signal references, frozen=${frozen}`, () => {
  const h = mockContext(); const { exec } = sessionFixture();
  const options = { provider: {}, model: {}, system: {}, messages: [], temperature: 0, signal: exec.signal };
  if (frozen) Object.freeze(options);
  let returned;
  const wrapped = wire(h, ctx => ctx.on('tools/pre-execute', (pending, next) => { returned = ctx.llm.stream(options); return next('arg'); }, { prepend: true }));
  assert.equal(h.handler(exec, arg => arg), 'arg');
  assert.equal(typeof returned[Symbol.asyncIterator], 'function');
  assert.equal(returned.then, undefined, 'wrapper must not return a Promise');
  const forwarded = h.requests[0];
  assert.notEqual(forwarded, options);
  for (const key of Object.keys(options)) assert.equal(forwarded[key], options[key]);
  assert.equal(Object.isFrozen(forwarded), frozen);
  assert.equal(Object.isFrozen(forwarded.codexRequestProvenance), true);
  assert.equal(Object.hasOwn(forwarded, 'sessionId'), false);
  assert.equal(Object.hasOwn(forwarded, 'purpose'), false);
  assert.equal(forwarded.codexRequestProvenance.ownerSessionId, 'session-A');
  assert.match(forwarded.codexRequestProvenance.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(wrapped.service.snapshot().augmentedRequests, 1);
  assert.equal(Object.hasOwn(options, 'codexRequestProvenance'), false);
});

test('ordinary facade binds real methods/services, preserves real disposer and options identity', () => {
  const h = mockContext(); const options = { prepend: true }; let disposer;
  const { facade } = wire(h, ctx => { assert.equal(ctx.marker(), 'bound'); assert.equal(ctx.approval, h.ctx.approval); assert.equal(ctx.get('llm'), h.ctx.llm); disposer = ctx.on('tools/pre-execute', () => {}, options); });
  assert.notEqual(facade, h.ctx); assert.equal(Object.getPrototypeOf(facade), null);
  assert.equal(h.handlers[0].options, options);
  disposer(); assert.equal(h.handlers.length, 0);
});

test('next exits ALS, including async downstream and unrelated real-service streams', async () => {
  const h = mockContext(); const { exec } = sessionFixture(); const options = {};
  wire(h, ctx => ctx.on('tools/pre-execute', async (_, next) => { ctx.llm.stream(options); return await next(); }));
  await h.handler(exec, async () => { await Promise.resolve(); h.ctx.llm.stream(options); return { kind: 'allow' }; });
  assert.ok(h.requests[0].codexRequestProvenance);
  assert.equal(h.requests[1], options);
});

test('facade downstream accidental llm use is also outside review context', async () => {
  const h = mockContext(); const { exec } = sessionFixture(); const options = {}; let facade;
  ({ facade } = wire(h, ctx => ctx.on('tools/pre-execute', (_, next) => { ctx.llm.stream(options); return next(); })));
  await h.handler(exec, async () => { await Promise.resolve(); facade.llm.stream(options); });
  assert.equal(h.requests[1], options);
});

test('owner identity is eagerly snapshotted before stream iteration', () => {
  const h = mockContext(); const { exec, session } = sessionFixture();
  wire(h, ctx => ctx.on('tools/pre-execute', () => ctx.llm.stream({})));
  const iterator = h.handler(exec, () => {}); session.id = 'changed-after-call';
  assert.equal(h.requests[0].codexRequestProvenance.ownerSessionId, 'session-A');
  assert.ok(iterator[Symbol.asyncIterator]);
});

test('concurrent executions keep distinct owners and UUIDs after awaits', async () => {
  const h = mockContext(); const barrier = deferred(); const a = sessionFixture({ id: 'A' }), b = sessionFixture({ id: 'B' });
  wire(h, ctx => ctx.on('tools/pre-execute', async () => { await barrier.promise; ctx.llm.stream({}); }));
  const pending = [h.handler(a.exec, () => {}), h.handler(b.exec, () => {})]; barrier.resolve(); await Promise.all(pending);
  assert.deepEqual(h.requests.map(option => option.codexRequestProvenance.ownerSessionId).sort(), ['A', 'B']);
  assert.equal(new Set(h.requests.map(option => option.codexRequestProvenance.requestId)).size, 2);
});

for (const cause of ['owner', 'uuid', 'options']) test(`augmentation failure ${cause} falls back once, never skips reviewer`, () => {
  const h = mockContext(); const { exec, session } = sessionFixture(); const options = cause === 'options' ? null : {};
  if (cause === 'owner') Object.defineProperty(session, 'id', { get() { throw new Error('missing'); } });
  const wrapped = wire(h, ctx => ctx.on('tools/pre-execute', () => ctx.llm.stream(options)), { requestId: cause === 'uuid' ? () => { throw new Error('failed'); } : undefined });
  h.handler(exec, () => { throw new Error('must not bypass'); });
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0], options);
  assert.equal(wrapped.service.snapshot().missingProvenance, 1); assert.equal(wrapped.service.snapshot().augmentedRequests, 0);
});

test('provider synchronous errors propagate unchanged without retry or allow', () => {
  const failure = new Error('provider'); const h = mockContext({ stream() { throw failure; } }); const { exec } = sessionFixture();
  wire(h, ctx => ctx.on('tools/pre-execute', () => ctx.llm.stream({})));
  assert.throws(() => h.handler(exec, () => {}), error => error === failure); assert.equal(h.requests.length, 1);
});

test('incompatible diagnostics disable augmentation; original stream still invoked', () => {
  const h = mockContext(); const { exec } = sessionFixture(); const options = {};
  const wrapped = wire(h, ctx => ctx.on('tools/pre-execute', () => ctx.llm.stream(options)), { compatible: false });
  h.handler(exec, () => {}); assert.equal(h.requests[0], options);
  assert.equal(wrapped.service.snapshot().status, 'disabled-incompatible');
});

test('non-pre-execute handlers are untouched', () => {
  const h = mockContext(); const handler = () => {}; wire(h, ctx => ctx.on('other', handler, {})); assert.equal(h.handlers[0].handler, handler);
});

test('legacy five-service shape and loader failures never register Auto', () => {
  assertOriginalShape({ apply() {}, name: 'experimental-auto-review', inject: [...ORIGINAL_INJECT] });
  for (const original of [undefined, {}, { apply() {}, name: 'wrong', inject: [...ORIGINAL_INJECT] }, { apply() {}, name: 'experimental-auto-review', inject: ['llm'] }]) assert.throws(() => assertOriginalShape(original));
  // Loader-only checks: no deployment/profile/preflight operation is invoked.
  assert.throws(() => loadOriginal({ originalModulePath: '' }));
  assert.throws(() => loadOriginal({ originalModulePath: fileURLToPath(new URL('../lib/host.js', import.meta.url)) }), /canonical installed ASAR/);
});

test('missing official review module refuses enablement without registering a replacement gate', () => {
  let registrations = 0;
  const ctx = { on: () => { registrations++; }, provide: () => { registrations++; }, effect: () => { registrations++; } };
  const originalModulePath = fileURLToPath(new URL('../lib/absent-official-review-module.js', import.meta.url));
  assert.throws(() => apply(ctx, { originalModulePath }), { code: 'MODULE_NOT_FOUND' });
  assert.equal(registrations, 0, 'never skip the security gate to simulate independence');
});

for (const kind of ['allow', 'deny', 'error']) test(`pure mocked source handler vs wrapped handler same input: ${kind}`, async () => {
  const direct = mockContext(), wrapped = mockContext(); const { exec } = sessionFixture(); const options = Object.freeze({ system: 'unchanged', messages: [] });
  const outcome = { kind: 'deny', reason: 'mock decision' }; const failure = new Error('mock original error');
  const register = ctx => ctx.on('tools/pre-execute', async (_, next) => {
    ctx.llm.stream(options);
    if (kind === 'error') throw failure;
    if (kind === 'deny') return outcome;
    return next();
  }, { prepend: true });
  register(direct.ctx); wire(wrapped, register);
  const invoke = async handler => {
    let calls = 0;
    try { return { result: await handler(exec, () => { calls += 1; return { kind: 'allow' }; }), calls }; }
    catch (error) { return { error, calls }; }
  };
  assert.deepEqual(await invoke(wrapped.handler), await invoke(direct.handler));
  assert.equal(direct.requests[0], options); assert.equal(wrapped.requests[0].messages, options.messages);
});

test('Config follows installed synchronous Standard Schema and live settings contracts', () => {
  assert.equal(Config['~standard'].version, 1);
  const defaults = Config['~standard'].validate({}).value;
  assert.equal(defaults.originalModulePath, '');
  assert.deepEqual(defaults.reviewerModel.get(), { mode: 'session' });
  assert.equal(Config.dict.reviewerModel.meta.volatile, true);
  assert.ok(Config['~standard'].validate({ originalModulePath: 'relative.js' }).issues);
  assert.ok(Config['~standard'].validate({ disabled: 'no' }).issues);
});
