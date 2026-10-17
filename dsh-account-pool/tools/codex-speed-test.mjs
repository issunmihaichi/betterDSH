// Offline only: fixed fake credentials, synthetic Fetch and WebSocket fixtures.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createCodexCatalogProbe, createCodexSpeedService, codexSpeedConnectionKey, parseCodexSpeedBody } from '../lib/codex-speed.js';
import { buildCodexModelsRequest, buildCodexRequest, normalizeCodexServiceTier } from '../lib/native/codex.js';
import { createCodexWebSocketTransport } from '../lib/native/codex-websocket.js';
import { createPoolAdapter } from '../lib/adapter.js';
import { createHttpUpstream } from '../lib/upstream.js';
import { makeAccount, poolGlobalSchema, poolDomainSpec } from '../lib/domain.js';
import { mountPool, ROUTES } from '../lib/host.js';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const account = (id = 'codex', patch = {}) => makeAccount({ id, now: new Date(T0).toISOString(), platform: 'openai',
  authMode: 'oauth', credentialRef: 'FIXTURE_REF', chatgptAccountId: 'FIXTURE_ACCOUNT', models: ['m', 'other'], ...patch });
const bundle = { access_token: 'FIXTURE_ACCESS_NOT_REAL', chatgpt_account_id: 'FIXTURE_ACCOUNT' };
const target = { sessionId: 's1', provider: 'pool', model: 'm' };
const call = { ...target, messages: [{ role: 'user', content: 'hello' }] };
const complete = { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [], usage: {} } };
const ok = async function* () { yield { type: 'text-delta', index: 0, text: 'ok' }; yield { type: 'finish', reason: { kind: 'stop' } }; };
const drain = iterable => Array.fromAsync(iterable);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const proof = row => ({ accountId: row.id, connectionKey: codexSpeedConnectionKey(row), identity: buildCodexModelsRequest(row, bundle).identity });
function speedFixture({ accounts = [account()], initialSelections = [], persist = async () => {}, probe = async row => ({ identity: proof(row).identity }) } = {}) {
  let rows = accounts;
  const service = createCodexSpeedService({ initialSelections, persistSelections: persist,
    resolveTarget: t => ['s1', 's2'].includes(t.sessionId) && ['pool', 'pool-one'].includes(t.provider) && ['m', 'other'].includes(t.model),
    listAccounts: () => rows, probeAccount: probe });
  return { service, setAccounts(next) { rows = next; } };
}

test('durable schema defaults old globals safely and bounds exact speed records', () => {
  const global = { installedAt: new Date(T0).toISOString(), totalRequests: 9, codexEncryptedCompactionV2: true };
  assert.deepEqual(poolGlobalSchema.parse(global).codexSpeedSelections, []);
  const row = { ...target, mode: 'fast' };
  assert.deepEqual(poolGlobalSchema.parse({ ...global, codexSpeedSelections: [row] }).codexSpeedSelections, [row]);
  for (const record of [{ ...row, mode: 'priority' }, { ...row, arbitrary: true }, { ...row, model: '' }]) {
    assert.equal(poolGlobalSchema.safeParse({ ...global, codexSpeedSelections: [record] }).success, false);
  }
  assert.equal(poolGlobalSchema.safeParse({ ...global, codexSpeedSelections: Array(513).fill(row) }).success, false);
});

test('canonical tiers, alias handling, trusted identity and fail-closed Ultrafast proof', () => {
  const row = account();
  for (const [input, expected] of [[undefined, undefined], [null, undefined], ['default', undefined], ['standard', undefined],
    ['fast', 'priority'], ['priority', 'priority'], ['ultrafast', 'ultrafast']]) {
    assert.equal(normalizeCodexServiceTier(input), expected);
    const options = { ...call, codexServiceTier: input,
      ...(expected === 'ultrafast' ? { codexSpeedIdentity: proof(row).identity, codexSpeedModel: 'm' } : {}) };
    assert.equal(JSON.parse(buildCodexRequest(row, options, bundle).init.body).service_tier, expected);
  }
  for (const input of ['', 'UltraFast', 'ultra', 'scale', 'auto', {}, 1]) assert.throws(() => normalizeCodexServiceTier(input), { code: 'POOL_CODEX_SPEED_INVALID' });
  assert.throws(() => buildCodexRequest(row, { ...call, codexServiceTier: 'ultrafast' }, bundle), { code: 'POOL_CODEX_SPEED_UNAVAILABLE' });
  assert.throws(() => buildCodexRequest(row, { ...call, codexServiceTier: 'ultrafast', codexSpeedIdentity: proof(row).identity,
    codexSpeedModel: 'other' }, bundle), { code: 'POOL_CODEX_SPEED_UNAVAILABLE' });
  assert.throws(() => buildCodexRequest(row, { ...call, codexServiceTier: 'ultrafast', codexSpeedIdentity: proof(row).identity,
    codexSpeedModel: 'm' }, { ...bundle, access_token: 'REPLACED_FIXTURE_TOKEN' }), { code: 'POOL_CODEX_SPEED_UNAVAILABLE' });
  for (const other of [account('key', { authMode: 'api-key' }), account('other', { platform: 'custom' })]) {
    assert.throws(() => buildCodexModelsRequest(other, bundle));
    assert.throws(() => buildCodexRequest(other, { ...call, codexServiceTier: 'fast' }, bundle));
  }
  assert.throws(() => buildCodexModelsRequest(account('proxy', { baseUrl: 'https://fixture.invalid' }), bundle));
  const catalog = buildCodexModelsRequest(row, bundle);
  assert.equal(catalog.url, 'https://chatgpt.com/backend-api/codex/models?client_version=0.160.1');
  assert.equal(catalog.init.redirect, 'error'); assert.equal(catalog.init.method, 'GET');
});

test('catalog evidence uses exact service_tiers, actual credential identity, TTL and safe failure', async t => {
  let token = bundle, calls = 0, now = 0, body = { models: [{ slug: 'm', service_tiers: [{ id: 'ultrafast' }] }] };
  const probe = createCodexCatalogProbe({ clock: { now: () => now }, ttlMs: 50, resolveCredential: async () => token,
    fetchImpl: async (_url, init) => { calls++; assert.equal(init.method, 'GET'); return Response.json(body); } });
  t.after(() => probe.dispose());
  const row = account();
  assert.ok(await probe.probe(row, 'm')); assert.equal(calls, 1);
  assert.ok(await probe.probe(row, 'm')); assert.equal(calls, 1);
  assert.equal(await probe.probe(row, 'other'), undefined); assert.equal(calls, 1);
  token = { ...bundle, access_token: 'SECOND_FIXTURE_TOKEN' };
  body = { models: [{ slug: 'm', additional_speed_tiers: ['ultrafast'], service_tiers: [{ id: 'priority' }] }] };
  assert.equal(await probe.probe(row, 'm'), undefined); assert.equal(calls, 2);
  body = { models: [{ slug: 'm', service_tiers: [{ id: 'ultrafast' }] }] }; now = 51;
  assert.ok(await probe.probe(row, 'm')); assert.equal(calls, 3);
  const failing = createCodexCatalogProbe({ resolveCredential: async () => bundle,
    fetchImpl: async () => { throw new Error('PRIVATE-CREDENTIAL-ERROR'); } });
  t.after(() => failing.dispose()); assert.equal(await failing.probe(row, 'm'), undefined);
});

test('catalog limits concurrency, deduplicates identity fetches and respects waiter abort', async t => {
  let active = 0, max = 0, calls = 0; const releases = [];
  const probe = createCodexCatalogProbe({ concurrency: 2, resolveCredential: async () => bundle,
    fetchImpl: async () => { calls++; active++; max = Math.max(max, active); const wait = deferred(); releases.push(wait);
      await wait.promise; active--; return Response.json({ models: [{ slug: 'm', service_tiers: [{ id: 'ultrafast' }] }] }); } });
  t.after(() => probe.dispose());
  const first = probe.probe(account('one'), 'm'), duplicate = probe.probe(account('one'), 'm');
  const second = probe.probe(account('two'), 'm'), third = probe.probe(account('three'), 'm');
  await tick(); assert.equal(calls, 2); assert.equal(max, 2);
  const controller = new AbortController(); const cancelled = probe.probe(account('one'), 'm', controller.signal);
  controller.abort(); await assert.rejects(cancelled, { name: 'AbortError' });
  releases.splice(0).forEach(wait => wait.resolve()); await tick(); releases.splice(0).forEach(wait => wait.resolve());
  assert.ok(await first); assert.ok(await duplicate); assert.ok(await second); assert.ok(await third); assert.equal(calls, 3);
});

test('only proven Ultrafast is displayed; unknown plans and PRO labels confer no ability', async () => {
  const f = speedFixture({ accounts: [account('unproven', { notes: 'PRO' })], probe: async () => undefined });
  assert.deepEqual(await f.service.get(target), { version: 1, available: true, mode: 'standard', modes: ['standard', 'fast'], ultrafastAvailable: false });
  await assert.rejects(f.service.set({ ...target, mode: 'ultrafast' }), { code: 'POOL_CODEX_SPEED_UNAVAILABLE' });
  await f.service.set({ ...target, mode: 'fast' }); assert.equal((await f.service.resolveRequest(call)).serviceTier, 'priority');
  assert.equal((await f.service.get({ ...target, sessionId: 'missing' })).available, false);
  assert.equal((await f.service.get({ ...target, provider: 'other-provider' })).mode, 'standard');
});

test('session/provider/model choices survive ack and remain isolated after immediate or delayed failures', async () => {
  let fail = false, slow, writes = [];
  const f = speedFixture({ persist: async rows => { writes.push(rows); if (slow) await slow.promise; if (fail) throw new Error('PRIVATE-STORE-ERROR'); } });
  await f.service.set({ ...target, mode: 'fast' });
  assert.equal((await f.service.get({ ...target, sessionId: 's2' })).mode, 'standard');
  assert.equal((await f.service.get({ ...target, provider: 'pool-one' })).mode, 'standard');
  assert.equal((await f.service.get({ ...target, model: 'other' })).mode, 'standard');
  fail = true; await assert.rejects(f.service.set({ ...target, mode: 'standard' }), { code: 'POOL_CODEX_SPEED_SAVE_FAILED' });
  assert.equal((await f.service.get(target)).mode, 'fast');
  slow = deferred(); const changing = f.service.set({ ...target, mode: 'ultrafast' }); await tick();
  assert.equal((await f.service.resolveRequest(call)).mode, 'fast'); slow.reject(new Error('PRIVATE-DELAYED-FAILURE'));
  await assert.rejects(changing, { code: 'POOL_CODEX_SPEED_SAVE_FAILED' }); assert.equal((await f.service.get(target)).mode, 'fast');
  slow = undefined; fail = false; await f.service.set({ ...target, mode: 'standard' });
  assert.deepEqual(writes.at(-1), []);
  for (const body of [{ ...target, mode: 'priority' }, { ...target, mode: 'fast', tier: 'priority' }, { ...target, mode: 'fast', sessionId: '' }, []]) {
    assert.throws(() => parseCodexSpeedBody(body), { code: 'POOL_CODEX_SPEED_INVALID' });
  }
});

test('serialized concurrent saves and failed saves never publish optimistic state', async () => {
  const first = deferred(); let number = 0;
  const f = speedFixture({ persist: async () => { if (++number === 1) await first.promise; } });
  const a = f.service.set({ ...target, mode: 'fast' }); const b = f.service.set({ ...target, mode: 'ultrafast' });
  await tick(); assert.equal(number, 1); assert.equal((await f.service.get(target)).mode, 'standard');
  first.resolve(); await a; await b; assert.equal((await f.service.get(target)).mode, 'ultrafast');
});

test('expired/removed entitlement retains explicit selection but dispatch fails, never silently downgrades', async () => {
  let support = true; const f = speedFixture({ probe: async row => support ? { identity: proof(row).identity } : undefined });
  await f.service.set({ ...target, mode: 'ultrafast' }); support = false;
  const state = await f.service.get(target); assert.equal(state.mode, 'ultrafast'); assert.equal(state.ultrafastAvailable, false);
  await assert.rejects(f.service.resolveRequest(call), { code: 'POOL_CODEX_SPEED_UNAVAILABLE' });
  await f.service.set({ ...target, mode: 'standard' }); assert.equal((await f.service.resolveRequest(call)).mode, 'standard');
});

test('adapter freezes resolver once, filters mixed pools and cannot leak tier to other protocols', async () => {
  const codex = account(), key = account('key', { authMode: 'api-key', priority: 1 }), claude = account('claude', { platform: 'anthropic', priority: 1 });
  let mode = 'fast', resolves = 0; const attempts = [];
  const adapter = createPoolAdapter({ initialAccounts: [key, claude, codex], resolveCodexSpeed: async () => {
    resolves++; return { mode, accounts: [proof(codex)] }; }, upstream: { stream: async function* (row, opts) {
      attempts.push({ id: row.id, tier: opts.codexServiceTier }); mode = 'standard'; yield* ok();
    } } });
  await drain(adapter.stream({ ...call, codexServiceTier: 'ultrafast', codexSpeedIdentity: 'FORGED' }));
  assert.equal(resolves, 1); assert.deepEqual(attempts, [{ id: 'codex', tier: 'priority' }]);
  await drain(adapter.stream({ ...call, sessionId: 's2', codexServiceTier: 'ultrafast' })); assert.equal(attempts.at(-1).tier, undefined);
  const changed = createPoolAdapter({ initialAccounts: [account('codex', { credentialRef: 'DIFFERENT_REF' }), key],
    resolveCodexSpeed: () => ({ mode: 'ultrafast', accounts: [proof(codex)] }), upstream: { stream: () => ok() } });
  await assert.rejects(drain(changed.stream(call)), { code: 'POOL_CODEX_SPEED_UNAVAILABLE' });
});

test('capability await is included in request-to-first-token usage timing', async () => {
  let now = 0, usage;
  const row = account(); const adapter = createPoolAdapter({ initialAccounts: [row], clock: { now: () => now },
    resolveCodexSpeed: async () => { now += 50; return { mode: 'ultrafast', accounts: [proof(row)] }; },
    upstream: { stream: async function* () { now += 10; yield { type: 'text-delta', index: 0, text: 'ok' }; now += 10;
      yield { type: 'usage', usage: { outputTokens: 5 } }; yield { type: 'finish', reason: { kind: 'stop' } }; } },
    onUsage: record => { usage = record; } });
  await drain(adapter.stream(call)); assert.equal(usage.firstTokenMs, 60);
});

test('HTTP sends canonical Fast/Ultrafast and omits standard, without modifying API-key requests', async () => {
  const row = account(); const captured = [];
  const upstream = createHttpUpstream({ resolveCredential: async () => bundle,
    fetchImpl: async (url, init) => { captured.push({ url, body: JSON.parse(init.body) });
      return new Response(`event: response.completed\ndata: ${JSON.stringify(complete)}\n\n`, { headers: { 'content-type': 'text/event-stream' } }); } });
  try {
    for (const tier of [undefined, 'fast', 'ultrafast']) await drain(upstream.stream(row, { ...call, codexServiceTier: tier,
      ...(tier === 'ultrafast' ? { codexSpeedIdentity: proof(row).identity, codexSpeedModel: 'm' } : {}) }));
    assert.deepEqual(captured.map(item => item.body.service_tier), [undefined, 'priority', 'ultrafast']);
    const key = account('key', { authMode: 'api-key', openaiApi: 'responses', baseUrl: 'https://fixture.invalid/v1' });
    await drain(upstream.stream(key, { ...call, codexServiceTier: 'ultrafast' }));
    assert.equal(captured.at(-1).body.service_tier, undefined);
  } finally { upstream.dispose?.(); }
});

test('WebSocket mode transitions preserve exact tier but invalidate incremental previous_response_id', async t => {
  const sent = [], sockets = [];
  class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 0; sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.emit('open'); }); }
    send(text, callback) { sent.push(JSON.parse(text)); callback?.(); this.emit('message', Buffer.from(JSON.stringify(complete)), false); }
    terminate() { this.readyState = 3; queueMicrotask(() => this.emit('close')); }
  }
  const transport = createCodexWebSocketTransport({ webSocketImpl: Socket }); t.after(() => transport.dispose());
  const row = account(); const input = text => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
  const mapping = { sessionKey: 's', identityKey: 'a', getContinuationOutput: () => [],
    async *mapResponse(frames) { for await (const frame of frames) if (JSON.parse(frame).type === 'response.completed') {
      yield { type: 'finish', reason: { kind: 'stop' } }; return;
    } } };
  for (const [index, tier] of [undefined, 'fast', 'ultrafast', undefined].entries()) {
    const req = buildCodexRequest(row, { ...call, codexServiceTier: tier,
      ...(tier === 'ultrafast' ? { codexSpeedIdentity: proof(row).identity, codexSpeedModel: 'm' } : {}) }, bundle);
    const body = JSON.parse(req.init.body); body.input = Array.from({ length: index + 1 }, (_, n) => input(`message ${n}`)); req.init.body = JSON.stringify(body);
    await drain(transport.stream(req, mapping));
    assert.equal(sent.at(-1).previous_response_id, undefined); assert.equal(sent.at(-1).input.length, index + 1);
  }
  assert.deepEqual(sent.map(body => body.service_tier), [undefined, 'priority', 'ultrafast', undefined]); assert.equal(sockets.length, 1);
});

function hostFixture() {
  const maps = new Map(), routes = [], sessions = new Map([['s1', { header: { origin: 'user' } }], ['s2', { header: { origin: 'user' } }]]);
  let global = poolGlobalSchema.parse(poolDomainSpec.global.initial), rejectSave = false;
  const domain = { table(name) {
    if (!maps.has(name)) maps.set(name, new Map()); const map = maps.get(name);
    return { get: key => map.get(key), entries: () => map.entries(), put: async (key, value) => { map.set(key, value); },
      delete: async key => map.delete(key), keys: () => map.keys() };
  }, global: { get: () => global, set: async value => { if (rejectSave) throw new Error('SECRET-STORE'); global = poolGlobalSchema.parse(value); } }, close: async () => {} };
  const services = { storageDomain: { open: async () => domain }, sessions: { get: id => sessions.get(id) },
    credentials: { resolve: async () => ({ value: JSON.stringify(bundle) }) },
    llm: { registerAdapter: () => Object.assign(() => {}, { replace() {} }), registerConfigurableProviders: () => Object.assign(() => {}, { replace() {} }) },
    connection: { fetch: { register: route => { routes.push(route); return () => {}; } } } };
  const ctx = { storageDomain: services.storageDomain, get: name => services[name], effect: fn => fn(), interval: () => () => {},
    on: () => () => {}, fiber: { entry: { options: { id: 'pool-test' } } }, logger: { warn() {}, info() {} } };
  return { ctx, routes, domain, failSave(value) { rejectSave = value; } };
}

test('real Request Host GET/POST validates routes/body, saves durably and preserves unrelated globals', async t => {
  const f = hostFixture(); let catalogCalls = 0;
  const mounted = await mountPool(f.ctx, { accounts: [account()], upstream: { stream: () => ok() }, refreshEnabled: false,
    fetchImpl: async (_url, init) => { assert.equal(init.method, 'GET'); catalogCalls++; return Response.json({ models: [{ slug: 'm', service_tiers: [{ id: 'ultrafast' }] }] }); } });
  t.after(() => mounted.dispose());
  const route = f.routes.find(row => row.path === ROUTES.codexSpeed);
  const get = selection => route.fetch(new Request(`http://fixture.invalid${ROUTES.codexSpeed}?${new URLSearchParams(selection)}`));
  const post = body => route.fetch(new Request(`http://fixture.invalid${ROUTES.codexSpeed}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  assert.equal((await (await get({})).json()).available, false);
  assert.equal((await (await get({ ...target, sessionId: 'nonexistent' })).json()).mode, 'standard'); assert.equal(catalogCalls, 0);
  assert.equal((await (await post({ ...target, provider: 'not-pool', mode: 'fast' })).json()).available, false);
  const ready = await (await get(target)).json(); assert.equal(ready.ultrafastAvailable, true);
  assert.deepEqual(Object.keys(ready).sort(), ['available', 'mode', 'modes', 'ultrafastAvailable', 'version']);
  assert.equal((await post({ ...target, mode: 'priority' })).status, 400);
  assert.equal((await post({ ...target, mode: 'fast', credential: 'DO-NOT-ACCEPT' })).status, 400);
  const before = f.domain.global.get(); const success = await post({ ...target, mode: 'fast' }); assert.equal(success.status, 200);
  assert.equal((await success.json()).mode, 'fast'); assert.equal(f.domain.global.get().installedAt, before.installedAt);
  assert.equal(f.domain.global.get().totalRequests, before.totalRequests); assert.equal((await (await get({ ...target, sessionId: 's2' })).json()).mode, 'standard');
  f.failSave(true); const failure = await post({ ...target, mode: 'standard' }); assert.equal(failure.status, 503);
  assert.equal((await failure.text()).includes('SECRET-STORE'), false); assert.equal((await (await get(target)).json()).mode, 'fast');
});
