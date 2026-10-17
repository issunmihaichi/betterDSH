import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createLocalApiServer } from '../lib/local-api.js';
const KEY = randomBytes(32).toString('base64url');
const ORIGINS = ['http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost'];
async function fixture(t) {
  const calls = [];
  const api = await createLocalApiServer({ apiKey: KEY, port: 0, adapter: {
    async listModels() { return [{ id: 'fixture-model' }]; },
    async *stream(options) { calls.push(options);
      yield { type: 'text-delta', index: 0, text: 'OK' };
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  } });
  t.after(() => api.close()); return { ...api, calls };
}
async function request(api, { origin, headers = {}, path = '/v1/models', method = 'GET', body, rawHeaders } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: api.port, path, method, agent: false,
      headers: rawHeaders ?? { Authorization: `Bearer ${KEY}`, ...(origin === undefined ? {} : { Origin: origin }), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('error', reject); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('Project Graph native Tauri Origin is accepted for models and both inference protocols', async t => {
  const api = await fixture(t);
  for (const origin of ORIGINS) {
    const models = await request(api, { origin }); assert.equal(models.status, 200, `${origin}: ${models.text}`);
    assert.equal(JSON.parse(models.text).data[0].id, 'fixture-model');
    // Project Graph uses the OpenAI-compatible chat provider and asks for SSE usage.
    const chat = await request(api, { origin, path: '/v1/chat/completions', method: 'POST', body: {
      model: 'fixture-model', messages: [{ role: 'system', content: 'Project Graph fixture' }, { role: 'user', content: 'Hello' }],
      stream: true, stream_options: { include_usage: true }, tools: [{ type: 'function', function: { name: 'graph_lookup', parameters: { type: 'object', properties: {} } } }], tool_choice: 'auto',
    } });
    assert.equal(chat.status, 200, chat.text); assert.match(chat.text, /\[DONE\]/); assert.match(chat.text, /"total_tokens":4/);
    const responses = await request(api, { origin, path: '/v1/responses', method: 'POST', body: { model: 'fixture-model', input: 'Hello', store: false, stream: true } });
    assert.equal(responses.status, 200, responses.text); assert.match(responses.text, /event: response.completed/);
    for (const response of [models, chat, responses]) {
      assert.equal(response.headers['access-control-allow-origin'], undefined, 'Native Tauri fetch does not require broad browser CORS');
      assert.equal(response.headers['access-control-allow-credentials'], undefined);
    }
  }
  assert.equal(api.calls.length, ORIGINS.length * 2);
});

test('Tauri Origin never replaces bearer authentication', async t => {
  const api = await fixture(t);
  for (const origin of ORIGINS) {
    for (const authorization of ['', `Bearer ${KEY}wrong`, 'Basic invalid']) {
      const response = await request(api, { origin, headers: { authorization } });
      assert.equal(response.status, 401); assert.equal(JSON.parse(response.text).error.code, 'invalid_api_key');
    }
  }
  assert.equal(api.calls.length, 0);
});

test('ordinary browser, opaque, empty and spoofed Tauri origins remain forbidden', async t => {
  const api = await fixture(t);
  for (const origin of ['null', '', 'http://127.0.0.1:3000', 'http://localhost:1420', 'https://evil.invalid',
    'http://tauri.localhost.evil.invalid', 'https://tauri.localhost.evil.invalid', 'tauri://localhost.evil.invalid',
    'http://tauri.localhost:3000', 'http://tauri.localhost/', 'http://user@tauri.localhost', 'HTTP://TAURI.LOCALHOST',
    'http://tauri.localhost, https://evil.invalid']) {
    const response = await request(api, { origin }); assert.equal(response.status, 403, origin || 'empty');
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  assert.equal(api.calls.length, 0);
});

test('exact loopback Host and duplicate sensitive header rules remain enforced for Tauri', async t => {
  const api = await fixture(t);
  for (const host of ['localhost:' + api.port, '127.0.0.1:' + (api.port + 1), 'tauri.localhost:' + api.port, 'evil.invalid']) {
    assert.equal((await request(api, { origin: ORIGINS[0], headers: { host } })).status, 403, host);
  }
  const pairs = ['Host', `127.0.0.1:${api.port}`, 'Authorization', `Bearer ${KEY}`, 'Origin', ORIGINS[0]];
  for (const extra of [['Origin', ORIGINS[0]], ['oRiGiN', ORIGINS[0]], ['Origin', ''], ['Origin', 'https://evil.invalid'], ['Host', `127.0.0.1:${api.port}`]]) {
    assert.equal((await request(api, { rawHeaders: [...pairs, ...extra] })).status, 403);
  }
  assert.equal((await request(api, { rawHeaders: [...pairs, 'Authorization', `Bearer ${KEY}`] })).status, 401);
});

test('Expect 100-continue does not bypass Origin or bearer checks', { timeout: 5000 }, async t => {
  const api = await fixture(t);
  for (const [origin, authorization, expected] of [[ORIGINS[0], '', 401], ['https://evil.invalid', `Bearer ${KEY}`, 403]]) {
    const response = await new Promise((resolve, reject) => {
      let continued = false;
      const req = http.request({ hostname: '127.0.0.1', port: api.port, path: '/v1/chat/completions', method: 'POST', agent: false,
        headers: { Origin: origin, Authorization: authorization, Expect: '100-continue', 'content-type': 'application/json' } }, res => {
        res.resume(); res.on('end', () => resolve({ status: res.statusCode, continued })); res.on('error', reject);
      });
      req.once('continue', () => { continued = true; req.end('{}'); }); req.once('error', reject); req.flushHeaders();
    });
    assert.equal(response.status, expected); assert.equal(response.continued, false);
  }
  assert.equal(api.calls.length, 0);
});

test('browser preflight remains unavailable and no unauthenticated invocation is enabled', async t => {
  const api = await fixture(t);
  const missingKey = await request(api, { origin: ORIGINS[0], method: 'OPTIONS', path: '/v1/chat/completions', headers: { authorization: '', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.equal(missingKey.status, 401); assert.equal(missingKey.headers['access-control-allow-origin'], undefined);
  const withKey = await request(api, { origin: ORIGINS[0], method: 'OPTIONS', path: '/v1/chat/completions' });
  assert.equal(withKey.status, 405); assert.equal(withKey.headers['access-control-allow-methods'], undefined);
  const native = await request(api); assert.equal(native.status, 200, 'Existing native clients without Origin must still work');
});
