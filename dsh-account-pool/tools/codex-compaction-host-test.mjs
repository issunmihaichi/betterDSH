import assert from 'node:assert/strict';
import test from 'node:test';
import { mountPool, ROUTES } from '../lib/host.js';
import { poolDomainSpec, poolGlobalSchema } from '../lib/domain.js';

function medium() { return { global: undefined, tables: new Map(), fail: false }; }
function fixture(shared = medium(), available = true) {
  const routes = new Map(), warnings = [], effects = [];
  const engine = { config: { summarizationProvider: '', summarizationModel: '', modelPolicies: [], maxTokens: 64 },
    regionDependencies() {}, compactRegion() {}, async summarize() { return { summary: [{ type: 'text', text: 'fallback' }] }; } };
  const llm = {
    async *adapterStream() {}, async *stream() {}, fileRequestText() { return '[offline file]'; },
    registerAdapter(_routes, adapter) { llm.adapter = adapter; const dispose = () => {}; dispose.replace = () => {}; return dispose; },
    registerConfigurableProviders() { const dispose = () => {}; dispose.replace = () => {}; return dispose; },
  };
  const secrets = new Map([['OFFLINE', JSON.stringify({ access_token: 'fixture-token', chatgpt_account_id: 'fixture-workspace' })]]);
  const credentials = { resolve: async ref => secrets.has(ref) ? { value: secrets.get(ref) } : undefined,
    set: async (ref, value) => { secrets.set(ref, value); }, describe: async ref => ({ configured: secrets.has(ref), writable: true }) };
  const storageDomain = { async open(spec) {
    assert.equal(spec, poolDomainSpec);
    return { global: { get: () => shared.global ?? spec.global.schema.parse(spec.global.initial), set: async value => {
      if (shared.fail) throw Error('Synthetic durable write failure');
      shared.global = poolGlobalSchema.parse(value);
    } }, table(name) {
      if (!shared.tables.has(name)) shared.tables.set(name, new Map());
      const map = shared.tables.get(name);
      return { get: id => map.get(id), entries: () => map.entries(), keys: () => map.keys(),
        put: async (id, value) => { map.set(id, value); }, delete: async id => map.delete(id),
        update: async (id, update) => { const value = update(map.get(id)); map.set(id, value); return value; } };
    }, async close() {} };
  } };
  const services = { storageDomain, llm, credentials, sessions: { get() {} }, connection: { fetch: { register(route) {
    routes.set(route.path, route); return () => routes.delete(route.path);
  } } } };
  const ctx = { storageDomain, get: name => services[name], logger: { info() {}, warn(...args) { warnings.push(args); } },
    fiber: { entry: { options: { id: 'offline-pool' } } }, on: () => () => {}, effect(fn) { const dispose = fn(); effects.push(dispose); return dispose; },
    inject(names, callback) {
      if (available && names.length === 1 && names[0] === 'compaction') callback({ get: () => engine, effect(fn) { const dispose = fn(); effects.push(dispose); return dispose; } });
    } };
  const options = { pruneIntervalMs: 0, accounts: [{ id: 'a', platform: 'openai', authMode: 'oauth', credentialRef: 'OFFLINE', models: ['gpt-6.1-sol'] }],
    fetchImpl: async () => new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 5, output_tokens: 2 } } }) + '\n\n') };
  const read = async () => (await routes.get(ROUTES.accounts).fetch(new Request('http://offline.test' + ROUTES.accounts))).json();
  const save = async body => routes.get(ROUTES.account).fetch(new Request('http://offline.test' + ROUTES.account,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { ctx, options, read, save, shared, llm, warnings, effects, engine };
}

test('setting is default-off, strict, durable across mounts and unrelated to accounts/transport', async () => {
  const f = fixture(); let mounted = await mountPool(f.ctx, f.options);
  const before = await f.read();
  assert.equal(before.codexCompatibilityVersion, 1);
  assert.deepEqual(before.codexCompatibility, { encryptedCompactionV2: false, available: true });
  const metadata = before.accounts;
  for (const body of [{ action: 'codex-compatibility-update' }, { action: 'codex-compatibility-update', encryptedCompactionV2: 'true' },
    { action: 'codex-compatibility-update', encryptedCompactionV2: 1 }, { action: 'codex-compatibility-update', encryptedCompactionV2: true, id: 'a' },
    { action: 'codex-compatibility-update', encryptedCompactionV2: true, account: { openaiTransport: 'websocket' } }]) {
    assert.equal((await f.save(body)).status, 400);
  }
  const response = await f.save({ action: 'codex-compatibility-update', encryptedCompactionV2: true });
  assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
  assert.deepEqual((await f.read()).accounts, metadata);
  assert.equal((await f.read()).codexCompatibility.encryptedCompactionV2, true);
  await mounted.dispose();
  const fresh = fixture(f.shared); mounted = await mountPool(fresh.ctx, fresh.options);
  assert.equal((await fresh.read()).codexCompatibility.encryptedCompactionV2, true);
  assert.equal((await fresh.save({ action: 'codex-compatibility-update', encryptedCompactionV2: false })).status, 200);
  assert.equal((await fresh.read()).codexCompatibility.encryptedCompactionV2, false);
  await mounted.dispose();
});

test('unavailable or absent compaction bridge cannot be enabled; disabling still works', async () => {
  const f = fixture(medium(), false), mounted = await mountPool(f.ctx, f.options);
  assert.deepEqual((await f.read()).codexCompatibility, { encryptedCompactionV2: false, available: false });
  const response = await f.save({ action: 'codex-compatibility-update', encryptedCompactionV2: true });
  assert.equal(response.status, 409); assert.equal((await response.json()).error.code, 'codex-compaction-unavailable');
  assert.equal((await f.save({ action: 'codex-compatibility-update', encryptedCompactionV2: false })).status, 200);
  await mounted.dispose();
});

test('durable write rejection is not a success and telemetry cannot erase the setting', async () => {
  const f = fixture(), mounted = await mountPool(f.ctx, f.options);
  f.shared.fail = true;
  const failed = await f.save({ action: 'codex-compatibility-update', encryptedCompactionV2: true });
  assert.equal(failed.status, 503); assert.equal((await failed.json()).error.code, 'persist-failed');
  assert.equal((await f.read()).codexCompatibility.encryptedCompactionV2, false);
  f.shared.fail = false;
  const stream = Array.fromAsync(mounted.adapter.stream({ provider: 'pool', model: 'gpt-6.1-sol', sessionId: 'fixture', messages: [{ role: 'user', content: 'offline' }] }));
  const saved = await f.save({ action: 'codex-compatibility-update', encryptedCompactionV2: true });
  assert.equal(saved.status, 200);
  await stream; await mounted.flush();
  const after = await f.read();
  assert.equal(after.codexCompatibility.encryptedCompactionV2, true);
  assert.equal(after.totalRequests, 1);
  await mounted.dispose();
});

test('unload restores both instance seams and does not turn off durable setting', async () => {
  const f = fixture(), originalEngine = f.engine.summarize, originalAdapterStream = f.llm.adapterStream;
  const mounted = await mountPool(f.ctx, f.options);
  assert.notEqual(f.engine.summarize, originalEngine);
  assert.notEqual(f.llm.adapterStream, originalAdapterStream);
  await f.save({ action: 'codex-compatibility-update', encryptedCompactionV2: true });
  await mounted.dispose();
  assert.equal(f.engine.summarize, originalEngine);
  assert.equal(f.llm.adapterStream, originalAdapterStream);
  assert.equal(f.shared.global.codexEncryptedCompactionV2, true);
});
