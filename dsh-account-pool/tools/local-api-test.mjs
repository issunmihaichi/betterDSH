import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createLocalApiServer } from '../lib/local-api.js';

import { createPoolAdapter } from '../lib/adapter.js';
import { setTimeout as delay } from 'node:timers/promises';

const KEY = randomBytes(32).toString('base64url');
const body = (extra = {}) => ({ model: 'test-model', messages: [{ role: 'user', content: 'hello' }], ...extra });
async function fixture(t, adapter = {}, config = {}) {
  const calls = [];
  const fake = {
    async listModels(provider) { calls.push({ list: provider }); return [{ id: 'test-model', accountId: 'secret-account', credential: 'secret-key' }]; },
    async *stream(options) { calls.push(options); yield { type: 'text-delta', index: 0, text: 'Hello' }; yield { type: 'finish', reason: { kind: 'stop' } }; },
    ...adapter,
  };
  const api = await createLocalApiServer({ adapter: fake, apiKey: KEY, port: 0, ...config });
  t.after(() => api.close());
  return { ...api, calls };
}
function request(api, { path = '/v1/models', method = 'GET', headers = {}, data, rawHeaders } = {}) {
  return new Promise((resolve, reject) => {
    const bytes = data === undefined ? undefined : typeof data === 'string' ? data : JSON.stringify(data);
    const req = http.request({ hostname: '127.0.0.1', port: api.port, path, method, agent: false,
      headers: rawHeaders ?? { authorization: `Bearer ${KEY}`, ...(bytes === undefined ? {} : { 'content-type': 'application/json' }), ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }); });
      res.on('error', reject);
    });
    req.on('error', reject); req.end(bytes);
  });
}

test('chat requests translate text/tools, preserve pool route and private sticky identity, and fold usage', async t => {
  let options;
  const api = await fixture(t, { async *stream(value) {
    options = value;
    yield { type: 'text-delta', index: 0, text: 'Hello' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello!' } };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'stop' }, replayState: { credential: 'do-not-publish' } };
  } });
  const result = await request(api, { path: '/v1/chat/completions', method: 'POST', headers: { 'X-Account-Pool-Group': 'my-group', 'X-Account-Pool-Session': 'client-session' }, data: body({
    messages: [{ role: 'system', content: 'Be precise.' }, { role: 'user', content: [{ type: 'text', text: 'lookup' }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'found' }],
    tools: [{ type: 'function', function: { name: 'lookup', description: 'Look up', parameters: { type: 'object', properties: {} } } }],
    temperature: 0.3, max_completion_tokens: 100, reasoning_effort: 'high',
  }) });
  assert.equal(result.status, 200, result.text);
  assert.equal(options.provider, 'pool-my-group');
  assert.match(options.sessionId, /^local-api:[a-f0-9]{64}$/);
  assert.equal(options.system, 'Be precise.');
  assert.deepEqual(options.messages[1].content, [{ type: 'tool-call', id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' }]);
  assert.equal(options.messages[2].toolName, 'lookup');
  assert.equal(options.maxTokens, 100); assert.equal(options.temperature, 0.3); assert.equal(options.reasoningEffort, 'high');
  assert.deepEqual(options.tools, [{ name: 'lookup', description: 'Look up', parameters: { type: 'object', properties: {} } }]);
  assert.deepEqual(result.json().choices, [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }]);
  assert.deepEqual(result.json().usage, { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 1 } });
  assert.ok(!result.text.includes('do-not-publish'));
});

function events(text) { return text.split('\n\n').filter(Boolean).map(event => event.split('\n').find(line => line.startsWith('data: '))?.slice(6)).filter(Boolean).map(value => value === '[DONE]' ? value : JSON.parse(value)); }
function aborted(signal) { return new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); }); }

test('SSE emits text/reasoning, completed function calls, usage and one successful finish', async t => {
  const api = await fixture(t, { async *stream() {
    yield { type: 'block-start', index: 8, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 8, id: 'call_x', argumentsDelta: '{"x":' };
    yield { type: 'tool-call-delta', index: 8, id: 'call_x', argumentsDelta: '1}' };
    yield { type: 'block-end', index: 8, block: { type: 'tool-call', id: 'call_x', name: 'lookup', arguments: '{"x":1}' } };
    yield { type: 'reasoning-delta', index: 1, text: 'Summary' };
    yield { type: 'text-delta', index: 0, text: 'Hi' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Hi' } };
    yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  } });
  const result = await request(api, { method: 'POST', path: '/v1/chat/completions', data: body({ stream: true, stream_options: { include_usage: true } }) });
  assert.equal(result.status, 200); assert.match(result.headers['content-type'], /text\/event-stream/);
  const chunks = events(result.text);
  assert.equal(chunks.at(-1), '[DONE]');
  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  assert.deepEqual(chunks[1].choices[0].delta.tool_calls, [{ index: 0, id: 'call_x', type: 'function', function: { name: 'lookup', arguments: '{"x":1}' } }]);
  assert.equal(chunks[2].choices[0].delta.reasoning_content, 'Summary');
  assert.equal(chunks[3].choices[0].delta.content, 'Hi');
  assert.equal(chunks[4].choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(chunks[5].choices, []); assert.equal(chunks[5].usage.total_tokens, 6);
  assert.equal(new Set(chunks.filter(chunk => chunk !== '[DONE]').map(chunk => chunk.id)).size, 1);
});

test('pre-output failures are sanitized 503/502, post-output and truncated streams are errors not success', async t => {
  for (const [code, status] of [['POOL_EXHAUSTED', 503], ['POOL_NO_UPSTREAM', 503], ['secret-error-code', 502]]) {
    const api = await fixture(t, { async *stream() { throw Object.assign(new Error('Bearer secret-key account-id private endpoint'), { code }); } });
    const result = await request(api, { method: 'POST', path: '/v1/chat/completions', data: body({ stream: true }) });
    assert.equal(result.status, status); assert.ok(!/secret|account-id|Bearer/.test(result.text));
  }
  for (const ending of ['throw', 'error-finish', 'aborted-finish', 'truncated', 'throw-after-finish']) {
    const api = await fixture(t, { async *stream() {
      yield { type: 'text-delta', index: 0, text: 'partial' };
      if (ending === 'throw' || ending === 'throw-after-finish') {
        if (ending === 'throw-after-finish') yield { type: 'finish', reason: { kind: 'stop' } };
        throw new Error('secret-key');
      }
      if (ending.endsWith('-finish')) yield { type: 'finish', reason: { kind: ending === 'error-finish' ? 'error' : 'aborted', failure: new Error('secret-key') } };
    } });
    const result = await request(api, { method: 'POST', path: '/v1/chat/completions', data: body({ stream: true }) });
    assert.equal(result.status, 200); assert.match(result.text, /event: error/); assert.ok(!result.text.includes('secret-key'));
    assert.ok(!result.text.includes('[DONE]')); assert.ok(!/"finish_reason":"/.test(result.text));
  }
});

test('request timeout aborts and closes iterator even if it ignores cancellation', async t => {
  let signal, returned = 0;
  const api = await fixture(t, { stream(options) { signal = options.signal; return { [Symbol.asyncIterator]() { return this; }, next() { return new Promise(() => {}); }, return() { returned++; return new Promise(() => {}); } }; } }, { requestTimeoutMs: 30 });
  const result = await request(api, { method: 'POST', path: '/v1/chat/completions', data: body() });
  assert.equal(result.status, 503); assert.equal(result.json().error.code, 'request_timeout'); assert.equal(signal.aborted, true); assert.equal(returned, 1);
  await api.close();
});

test('client disconnect cancels the same adapter signal and runs generator cleanup', async t => {
  let signal, finish;
  const done = new Promise(resolve => { finish = resolve; });
  const api = await fixture(t, { async *stream(options) { signal = options.signal; try { yield { type: 'text-delta', index: 0, text: 'start' }; await aborted(signal); } finally { finish(); } } });
  await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: api.port, path: '/v1/chat/completions', method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' } }, res => {
      res.once('data', () => { res.destroy(); resolve(); }); res.on('error', () => {});
    }); req.on('error', reject); req.end(JSON.stringify(body({ stream: true })));
  });
  await done; assert.equal(signal.aborted, true);
});

test('strict options and content validation rejects unsupported or ambiguous semantics before dispatch', async t => {
  const api = await fixture(t);
  const invalidBodies = [
    body({ max_tokens: null }), body({ max_completion_tokens: null }), body({ max_tokens: 0 }), body({ max_tokens: 2, max_completion_tokens: 2 }),
    body({ stop: ['END'] }), body({ response_format: { type: 'json_object' } }), body({ top_p: 0.5 }), body({ seed: 2 }), body({ n: 2 }),
    body({ stream: 'yes' }), body({ stream_options: { include_usage: true } }), body({ tool_choice: 'required' }), body({ parallel_tool_calls: false }),
    body({ messages: [{ role: 'developer', content: 'priority' }] }), body({ messages: [{ role: 'user', name: 'bob', content: 'hello' }] }),
    body({ messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'x' } }] }] }),
    body({ messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: 'late' }] }),
    body({ messages: [{ role: 'tool', tool_call_id: 'missing', content: 'result' }] }),
    body({ tools: [{ type: 'function', function: { name: 'test', strict: true } }] }),
    body({ tools: [{ type: 'function', function: { name: 'test', parameters: { type: 'array' } } }] }),
  ];
  for (const data of invalidBodies) {
    const result = await request(api, { method: 'POST', path: '/v1/chat/completions', data });
    assert.equal(result.status, 400, JSON.stringify(data));
  }
  assert.equal(api.calls.length, 0);
});

test('data image URLs are translated only for image-capable routes and never fetched', async t => {
  let captured;
  const api = await fixture(t, {
    async resolveModel() { return { inputModalities: ['text', 'image'], reasoning: { efforts: [{ id: 'off' }] } }; },
    async *stream(options) { captured = options; yield { type: 'finish', reason: { kind: 'stop' } }; },
  });
  const imageBody = url => body({ messages: [{ role: 'user', content: [{ type: 'text', text: 'describe' }, { type: 'image_url', image_url: { url } }] }] });
  const result = await request(api, { method: 'POST', path: '/v1/chat/completions', data: imageBody('data:image/png;base64,AQ==') });
  assert.equal(result.status, 200); assert.deepEqual(captured.messages[0].content[1], { type: 'image', mediaType: 'image/png', data: 'AQ==' });
  for (const url of ['https://127.0.0.1/private', 'file:///secret.png', 'data:image/svg+xml;base64,AQ==', 'data:image/png;base64,AX==']) assert.equal((await request(api, { method: 'POST', path: '/v1/chat/completions', data: imageBody(url) })).status, 400);
  const noImages = await fixture(t);
  assert.equal((await request(noImages, { method: 'POST', path: '/v1/chat/completions', data: imageBody('data:image/png;base64,AQ==') })).status, 400);
  const effort = await request(api, { method: 'POST', path: '/v1/chat/completions', data: body({ reasoning_effort: 'high' }) });
  assert.equal(effort.status, 400); assert.equal(effort.json().error.code, 'unsupported_reasoning_effort');
  assert.equal((await request(api, { method: 'POST', path: '/v1/chat/completions', data: body({ reasoning_effort: 'none' }) })).status, 200);
  assert.equal(captured.reasoningEffort, 'off');
});

test('body size, media type, malformed JSON, routing and method constraints fail without adapter calls', async t => {
  const api = await fixture(t, {}, { maxBodyBytes: 128 });
  const big = 'x'.repeat(129);
  for (const headers of [{}, { 'content-length': String(big.length) }]) {
    const result = await request(api, { method: 'POST', path: '/v1/chat/completions', headers, data: big });
    assert.equal(result.status, 413);
  }
  assert.equal((await request(api, { method: 'POST', path: '/v1/chat/completions', data: '{bad' })).status, 400);
  assert.equal((await request(api, { method: 'POST', path: '/v1/chat/completions', data: body(), headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await request(api, { method: 'POST', path: '/v1/chat/completions', data: body(), headers: { 'content-encoding': 'gzip' } })).status, 415);
  assert.equal((await request(api, { path: '/v1/models?internal=true' })).status, 404);
  assert.equal((await request(api, { path: '/v1/embeddings', method: 'POST', data: body() })).status, 404);
  assert.equal((await request(api, { path: '/v1/models', method: 'POST' })).status, 405);
  assert.equal((await request(api, { path: '/v1/chat/completions', method: 'OPTIONS' })).status, 405);
  assert.equal((await request(api, { headers: { 'X-Account-Pool-Group': '../all' } })).status, 400);
  assert.equal((await request(api, { headers: { 'X-Account-Pool-Session': 'with spaces' } })).status, 400);
  assert.equal(api.calls.length, 0);
});

test('rotation changes only subsequent authentication and validates key configuration atomically', async t => {
  for (const apiKey of [undefined, 'x'.repeat(31), ' '.repeat(32), '中'.repeat(32)]) await assert.rejects(createLocalApiServer({ adapter: { stream() {}, listModels() {} }, apiKey, port: 0 }), /key/);
  const api = await fixture(t);
  assert.throws(() => api.setApiKey('short'), /key/);
  assert.equal((await request(api)).status, 200);
  const next = randomBytes(32).toString('base64url');
  api.setApiKey(next);
  assert.equal((await request(api)).status, 401);
  assert.equal((await request(api, { headers: { authorization: `Bearer ${next}` } })).status, 200);
  await api.close(); await api.close(); assert.throws(() => api.setApiKey(KEY), /closed/);
});

test('duplicate credentials/host/routing headers are rejected rather than selected arbitrarily', async t => {
  const api = await fixture(t);
  const pairs = ['Host', `127.0.0.1:${api.port}`, 'Authorization', `Bearer ${KEY}`];
  for (const [extra, status] of [[['Authorization', `Bearer ${KEY}`], 401], [['Host', `127.0.0.1:${api.port}`], 403], [['Origin', ''], 403], [['X-Account-Pool-Group', 'a', 'X-Account-Pool-Group', 'b'], 400]]) {
    const result = await request(api, { rawHeaders: [...pairs, ...extra] }); assert.equal(result.status, status);
  }
});

test('actual pool adapter preserves group filtering, failover, cooldown, usage and sticky bindings', async t => {
  const attempted = [], usage = [];
  const account = (id, priority, groups) => ({ id, priority, groups, platform: 'custom', authMode: 'api-key', models: ['test-model'], status: 'active', schedulable: true, credentialRef: 'secret' });
  const adapter = createPoolAdapter({ initialAccounts: [account('outside', -1, []), account('a', 0, ['g']), account('b', 1, ['g'])], initialGroups: [{ id: 'g', enabled: true, models: ['test-model'] }], requestRetries: 0,
    onUsage: value => usage.push(value), upstream: { async *stream(row, options) {
      attempted.push(row.id);
      if (row.id === 'a') throw Object.assign(new Error('secret-rate-limit'), { status: 429 });
      yield { type: 'text-delta', index: 0, text: options.messages[0].content[0].text };
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } },
  });
  const api = await createLocalApiServer({ adapter, apiKey: KEY, port: 0 }); t.after(() => api.close());
  const headers = { 'X-Account-Pool-Group': 'g', 'X-Account-Pool-Session': 'session' };
  for (let i = 0; i < 2; i++) assert.equal((await request(api, { method: 'POST', path: '/v1/chat/completions', headers, data: body() })).status, 200);
  assert.deepEqual(attempted, ['a', 'b', 'b']);
  assert.equal(usage.length, 2); assert.equal(usage[0].switches, 1); assert.equal(usage[0].usage.outputTokens, 2);
  assert.ok(adapter.getAccount('a').rateLimitResetAt); assert.equal(adapter.listBindings()[0].accountId, 'b');
  assert.equal(adapter.inflightSnapshot().size, 0);
  const models = await request(api, { headers }); assert.deepEqual(models.json().data.map(row => row.id), ['test-model']);
  const missing = await request(api, { method: 'POST', path: '/v1/chat/completions', headers: { 'X-Account-Pool-Group': 'missing' }, data: body() });
  assert.equal(missing.status, 503); assert.deepEqual(attempted, ['a', 'b', 'b']);
});

test('shutdown cancels active work, closes clients and permits immediate port reuse', async t => {
  let entered, captured;
  const started = new Promise(resolve => { entered = resolve; });
  const api = await fixture(t, { async *stream(options) { captured = options.signal; entered(); await aborted(captured); captured.throwIfAborted(); } });
  const pending = request(api, { method: 'POST', path: '/v1/chat/completions', data: body() }).catch(error => error);
  await started; await api.close(); await pending;
  assert.equal(captured.aborted, true);
  const replacement = await createLocalApiServer({ adapter: { async listModels() { return []; }, async *stream() {} }, apiKey: KEY, port: api.port });
  t.after(() => replacement.close()); assert.equal((await request(replacement)).status, 200);
});

test('SSE honors downstream backpressure and cancellation while stalled', async t => {
  let produced = 0, signal, done;
  const finished = new Promise(resolve => { done = resolve; });
  const api = await fixture(t, { async *stream(options) { signal = options.signal; try {
    for (let i = 0; i < 1000; i++) { produced++; yield { type: 'text-delta', index: 0, text: 'x'.repeat(256 * 1024) }; }
    yield { type: 'finish', reason: { kind: 'stop' } };
  } finally { done(); } } });
  const response = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: api.port, path: '/v1/chat/completions', method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' } }, res => { res.pause(); resolve(res); });
    req.on('error', reject); req.end(JSON.stringify(body({ stream: true })));
  });
  t.after(() => response.destroy());
  await delay(100);
  assert.ok(produced > 0 && produced < 64, `producer ran past bounded socket capacity: ${produced}`);
  response.destroy(); await finished; assert.equal(signal.aborted, true);
});

test('upload deadline responds safely and cancels a stalled body before dispatch', async t => {
  const api = await fixture(t, {}, { requestTimeoutMs: 30 });
  const result = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: api.port, path: '/v1/chat/completions', method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => { req.destroy(); resolve({ status: res.statusCode, text }); }); res.on('error', reject);
    }); req.on('error', reject); req.write('{');
  });
  assert.equal(result.status, 503); assert.equal(JSON.parse(result.text).error.code, 'request_timeout'); assert.equal(api.calls.length, 0);
});

test('deadline after first output emits a terminal error and releases the generator', async t => {
  let closed = false;
  const api = await fixture(t, { async *stream({ signal }) { try { yield { type: 'text-delta', index: 0, text: 'start' }; await aborted(signal); signal.throwIfAborted(); } finally { closed = true; } } }, { requestTimeoutMs: 30 });
  const response = await request(api, { method: 'POST', path: '/v1/chat/completions', data: body({ stream: true }) });
  assert.equal(response.status, 200); assert.match(response.text, /event: error/); assert.match(response.text, /request_timeout/); assert.ok(!response.text.includes('[DONE]')); assert.equal(closed, true);
});

test('headers past the parser count threshold cannot bypass Origin rejection', async t => {
  const api = await fixture(t);
  const rawHeaders = ['Host', `127.0.0.1:${api.port}`, 'Authorization', `Bearer ${KEY}`];
  for (let i = 0; i < 70; i++) rawHeaders.push(`X-Filler-${i}`, 'a');
  rawHeaders.push('Origin', 'https://browser.example');
  assert.ok([400, 403].includes((await request(api, { rawHeaders })).status)); // Node may reject excessive headers before dispatch.
});

test('close waits boundedly for cooperative pool cleanup and usage before resolving', async t => {
  let started, usage = 0;
  const ready = new Promise(resolve => { started = resolve; });
  const adapter = createPoolAdapter({ initialAccounts: [{ id: 'only', platform: 'custom', status: 'active', schedulable: true, models: ['test-model'] }], requestRetries: 0,
    onUsage() { usage++; }, upstream: { async *stream(_account, { signal }) { started(); await aborted(signal); await delay(20); signal.throwIfAborted(); } },
  });
  const api = await createLocalApiServer({ adapter, apiKey: KEY, port: 0 }); t.after(() => api.close());
  const pending = request(api, { method: 'POST', path: '/v1/chat/completions', data: body() }).catch(error => error);
  await ready; assert.equal(adapter.inflightSnapshot().get('only'), 1);
  await api.close(); await pending;
  assert.equal(adapter.inflightSnapshot().size, 0); assert.equal(usage, 1);
});

test('nonstream response flushing remains inside the deadline for a stalled client', async t => {
  let signal;
  const api = await fixture(t, { async *stream(options) { signal = options.signal; yield { type: 'text-delta', index: 0, text: '\u0000'.repeat(8 * 1024 * 1024) }; yield { type: 'finish', reason: { kind: 'stop' } }; } }, { requestTimeoutMs: 40 });
  const response = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: api.port, path: '/v1/chat/completions', method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' } }, res => { res.pause(); resolve(res); });
    req.on('error', reject); req.end(JSON.stringify(body()));
  });
  t.after(() => response.destroy()); await delay(100); assert.equal(signal.aborted, true);
});

test('loopback model endpoint enforces bearer/host/origin and publishes only public model fields', async t => {
  const api = await fixture(t);
  assert.equal(api.baseUrl, `http://127.0.0.1:${api.port}/v1`);
  const ok = await request(api);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json(), { object: 'list', data: [{ id: 'test-model', object: 'model', created: 0, owned_by: 'account-pool' }] });
  for (const headers of [{ authorization: '' }, { authorization: `Bearer ${KEY}x` }, { authorization: 'Basic xxx' }]) assert.equal((await request(api, { headers })).status, 401);
  for (const headers of [{ host: 'evil.example' }, { host: `localhost:${api.port}` }, { origin: 'null' }, { origin: 'http://127.0.0.1' }]) assert.equal((await request(api, { headers })).status, 403);
  assert.equal(ok.headers['access-control-allow-origin'], undefined);
});
