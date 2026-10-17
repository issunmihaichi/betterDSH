import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalApiController, LOCAL_API_KEY_REF } from '../lib/local-api-controller.js';

function fixture(options = {}) {
  const f = { stored: options.stored, secret: options.secret, saves: [], listeners: [], failSave: false, failBind: false, failKey: false };
  f.credentials = { resolve: async () => ({ value: f.secret }), describe: async () => ({ writable: true }),
    set: async (ref, value) => { assert.equal(ref, LOCAL_API_KEY_REF); if(f.failKey) throw Error('SECRET_INTERNAL'); f.secret = value; } };
  f.controller = createLocalApiController({ adapter: {}, credentials: f.credentials,
    readConfig: () => f.stored, saveConfig: async value => { if (f.failSave) throw Error('PRIVATE_DB'); f.saves.push(value); f.stored = value; },
    createServer: async ({ apiKey, port }) => {
      if (f.failBind) throw Object.assign(Error('PRIVATE_HOST'), { code: 'EADDRINUSE' });
      const s = { apiKey, port, baseUrl: `http://127.0.0.1:${port}/v1`, closed: false,
        close: async () => { s.closed = true; }, setApiKey: value => { s.apiKey = value; } };
      f.listeners.push(s); return s;
    }, ...options.overrides });
  return f;
}
const enable = port => ({ action: 'local-api-update', enabled: true, port });
const rotate = { action: 'local-api-rotate-key' };

test('credential handle stays compatible with the already configured installed API key', () => {
  assert.equal(LOCAL_API_KEY_REF, 'ACCOUNT_POOL_LOCAL_API');
});

test('defaults off; only explicit rotation reveals key; settings/status never contain secrets', async () => {
  const f = fixture(); await f.controller.initialize();
  assert.equal(f.listeners.length, 0); assert.equal(f.controller.snapshot().keyConfigured, false);
  await assert.rejects(f.controller.update(enable(19389)), { code: 'local-api-key-required' });
  const generated = await f.controller.rotateKey(rotate);
  assert.match(generated.apiKey, /^sk-pool-[A-Za-z0-9_-]{43}$/);
  assert.equal(f.secret, generated.apiKey);
  const saved = await f.controller.update(enable(19389));
  assert.equal(saved.localApi.running, true); assert.equal(saved.apiKey, undefined);
  assert.ok(!JSON.stringify(f.stored).includes(generated.apiKey));
  assert.ok(!JSON.stringify(f.controller.snapshot()).includes(generated.apiKey));
  const next = await f.controller.rotateKey(rotate);
  assert.notEqual(next.apiKey, generated.apiKey); assert.equal(f.listeners.length, 1);
  assert.equal(f.listeners[0].apiKey, next.apiKey);
  await f.controller.close(); assert.equal(f.listeners[0].closed, true);
});

test('enabled state and key survive reconstruction; missing key fails closed and remains manageable', async () => {
  const key = 'sk-pool-' + 'a'.repeat(43);
  const f = fixture({ stored: { enabled: true, port: 19400 }, secret: key });
  assert.equal((await f.controller.initialize()).running, true); await f.controller.close();
  const absent = fixture({ stored: f.stored });
  const state = await absent.controller.initialize(); assert.equal(state.running, false); assert.equal(state.enabled, true); assert.ok(state.error);
  await absent.controller.rotateKey(rotate); await absent.controller.update(enable(19400));
  assert.equal(absent.controller.snapshot().running, true); await absent.controller.close();
});

test('bad inputs, read-only key and storage failures do not silently succeed', async () => {
  const f = fixture(); await f.controller.initialize();
  for (const body of [enable(0), enable(65536), enable(1.5), { ...enable(19400), host: '0.0.0.0' }, { ...enable(19400), enabled: 'true' }]) {
    await assert.rejects(f.controller.update(body), { code: 'invalid-local-api' });
  }
  await assert.rejects(f.controller.rotateKey({ ...rotate, apiKey: 'mine' }), { code: 'invalid-local-api' });
  f.failKey = true;
  await assert.rejects(f.controller.rotateKey(rotate), e => e.code === 'local-api-key-save-failed' && !e.message.includes('SECRET_INTERNAL'));
  f.failKey = false; await f.controller.rotateKey(rotate); await f.controller.update(enable(19400));
  f.failSave = true;
  await assert.rejects(f.controller.update(enable(19401)), { code: 'local-api-save-failed' });
  assert.deepEqual(f.stored, { enabled: true, port: 19400 });
  assert.equal(f.listeners[0].closed, false); assert.equal(f.listeners[1].closed, true);
  assert.equal(f.controller.snapshot().port, 19400);
  f.failSave = false; f.failBind = true;
  await assert.rejects(f.controller.update(enable(19401)), e => e.code === 'local-api-listen-failed' && !e.message.includes('PRIVATE_HOST'));
  assert.equal(f.listeners[0].closed, false); await f.controller.close();
});

test('enable/disable are serialized and disposal prevents future resurrection', async () => {
  const f = fixture(); await f.controller.initialize(); await f.controller.rotateKey(rotate);
  const one = f.controller.update(enable(19402));
  const two = f.controller.update({ ...enable(19403), enabled: false });
  await Promise.all([one, two]);
  assert.equal(f.controller.snapshot().running, false); assert.equal(f.listeners[0].closed, true);
  assert.deepEqual(f.stored, { enabled: false, port: 19403 });
  await f.controller.close(); await f.controller.close();
  await assert.rejects(f.controller.update(enable(19402)), { code: 'local-api-closed' });
});

test('missing upstream does not prevent management or start an unusable gateway', async () => {
  const f = fixture({ overrides: { available: false } });
  await f.controller.initialize(); await f.controller.rotateKey(rotate);
  await assert.rejects(f.controller.update(enable(19402)), { code: 'local-api-unavailable' });
  assert.equal(f.listeners.length, 0); await f.controller.close();
});
