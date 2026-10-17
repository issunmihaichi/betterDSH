import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mountPool, ROUTES } from '../lib/host.js';
import { poolDomainSpec } from '../lib/domain.js';
import { LOCAL_API_KEY_REF } from '../lib/local-api-controller.js';

function fixture() {
  const data = new Map(); const secrets = new Map(); const routes = new Map(); const effects = [];
  let globals = structuredClone(poolDomainSpec.global.initial);
  const domain = { global: { get: () => globals, set: async value => { globals = poolDomainSpec.global.schema.parse(value); } },
    table: name => { if (!data.has(name)) data.set(name, new Map()); const map = data.get(name); return {
      get: key => map.get(key), entries: () => map.entries(), keys: () => map.keys(),
      put: async (key, value) => { map.set(key, poolDomainSpec.tables[name].valueSchema.parse(value)); },
      delete: async key => map.delete(key),
    }; }, close: async () => {} };
  const services = { storageDomain: { open: async spec => { assert.equal(spec, poolDomainSpec); return domain; } },
    credentials: { resolve: async ref => secrets.has(ref) ? { value: secrets.get(ref) } : undefined,
      set: async (ref, value) => { secrets.set(ref, value); }, unset: async ref => secrets.delete(ref),
      describe: async ref => ({ configured: secrets.has(ref), writable: true }) },
    llm: { registerAdapter: () => Object.assign(() => {}, { replace() {} }), registerConfigurableProviders: () => Object.assign(() => {}, { replace() {} }) },
    connection: { fetch: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path); } } } };
  const ctx = { storageDomain: services.storageDomain, get: name => services[name], effect: fn => { const stop = fn(); effects.push(stop); return stop; },
    interval: () => () => {}, logger: { info() {}, warn() {} }, fiber: { entry: { options: { id: 'account-pool' } } } };
  const get = async () => (await routes.get(ROUTES.accounts).fetch(new Request('http://localhost' + ROUTES.accounts))).json();
  const post = body => routes.get(ROUTES.account).fetch(new Request('http://localhost' + ROUTES.account,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { ctx, get, post, domain, data, secrets };
}
async function freePort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

test('management owns the listener; real HTTP calls share pool usage and durable restart state', async () => {
  const f = fixture(); const port = await freePort(); let calls = 0;
  const options = { accounts: [{ id: 'api-test', platform: 'custom', models: ['fixture-model'] }],
    upstream: { async *stream(account, options) { calls++; assert.equal(account.id, 'api-test');
      assert.equal(options.messages[0].content[0].text, 'Hello');
      yield { type: 'text-delta', index: 0, text: 'Hi' };
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } } };
  let mounted = await mountPool(f.ctx, options);
  try {
    let status = await f.get(); assert.equal(status.localApiVersion, 1); assert.equal(status.localApi.enabled, false);
    assert.equal((await f.post({ action: 'local-api-update', enabled: true, port })).status, 409);
    const keyResponse = await f.post({ action: 'local-api-rotate-key' }); assert.equal(keyResponse.status, 200);
    const { apiKey } = await keyResponse.json(); assert.equal(f.secrets.get(LOCAL_API_KEY_REF), apiKey);
    assert.equal((await f.post({ action: 'local-api-update', enabled: true, port })).status, 200);
    status = await f.get(); assert.equal(status.localApi.running, true);
    assert.equal(JSON.stringify(status).includes(apiKey), false);
    const url = status.localApi.baseUrl;
    assert.equal((await fetch(url + '/models')).status, 401);
    const models = await fetch(url + '/models', { headers: { Authorization: 'Bearer ' + apiKey } }); assert.equal(models.status, 200);
    const chat = await fetch(url + '/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fixture-model', messages: [{ role: 'user', content: 'Hello' }] }) });
    assert.equal(chat.status, 200); assert.equal((await chat.json()).choices[0].message.content, 'Hi');
    await mounted.flush(); assert.equal(calls, 1); assert.equal(f.domain.global.get().totalRequests, 1);
    assert.equal(f.data.get('usage').size, 1);
    assert.equal((await f.post({ action: 'local-api-update', enabled: false, port, host: '0.0.0.0' })).status, 400);
    assert.equal((await f.get()).localApi.running, true);
    const next = await (await f.post({ action: 'local-api-rotate-key' })).json(); assert.notEqual(next.apiKey, apiKey);
    assert.equal((await fetch(url + '/models', { headers: { Authorization: 'Bearer ' + apiKey } })).status, 401);
    await mounted.dispose(); mounted = await mountPool(f.ctx, options);
    assert.equal((await f.get()).localApi.running, true);
    assert.equal((await fetch(url + '/models', { headers: { Authorization: 'Bearer ' + next.apiKey } })).status, 200);
    const disabled = await f.post({ action: 'local-api-update', enabled: false, port }); assert.equal(disabled.status, 200);
    assert.equal((await f.get()).localApi.running, false);
    assert.equal(f.data.get('accounts').size, 1);
    assert.equal(JSON.stringify([...f.data].map(([name, rows]) => [name, [...rows]])).includes(apiKey), false);
  } finally { await mounted.dispose(); }
});

test('occupied port and unavailable credentials leave ordinary account management intact', async () => {
  const blocker = createServer(); await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const port = blocker.address().port;
  const f = fixture(); const mounted = await mountPool(f.ctx, { upstream: { async *stream() {} } });
  try {
    await f.post({ action: 'local-api-rotate-key' });
    const response = await f.post({ action: 'local-api-update', enabled: true, port }); assert.equal(response.status, 503);
    assert.equal((await f.get()).localApi.enabled, false); assert.equal((await f.get()).localApi.running, false);
    const status = await f.get(); assert.ok(Array.isArray(status.accounts));
  } finally { await mounted.dispose(); await new Promise(resolve => blocker.close(resolve)); }
});
