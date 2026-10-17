import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createLocalApiServer } from '../lib/local-api.js';
import { createPoolAdapter } from '../lib/adapter.js';
import { mapOpenAIResponses } from '../lib/native/openai-responses.js';
const KEY = randomBytes(32).toString('base64url');
const body = extra => ({ model: 'fixture-model', input: 'Hello', ...extra });
const aborted = signal => new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
async function fixture(t, overrides = {}, config = {}) {
  const calls = [];
  const adapter = { async listModels() { return [{ id: 'fixture-model' }]; }, async *stream(options) {
    calls.push(options);
    yield { type: 'text-delta', index: 0, text: 'Hi' };
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } };
    yield { type: 'finish', reason: { kind: 'stop' }, replayState: { token: 'PRIVATE_REPLAY' } };
  }, ...overrides };
  const api = await createLocalApiServer({ adapter, apiKey: KEY, port: 0, ...config });
  t.after(() => api.close()); return { ...api, calls, adapter };
}
async function request(api, data = body(), headers = {}, path = '/v1/responses', method = 'POST') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: api.port, path, method, agent: false,
      headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json', ...headers } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: new Headers(res.headers), text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject); req.end(method === 'GET' ? undefined : JSON.stringify(data));
  });
}
function frames(text) {
  return text.split('\n\n').filter(Boolean).map(frame => {
    const lines = frame.split('\n'); const data = lines.find(line => line.startsWith('data: '));
    assert.ok(data, frame); const event = JSON.parse(data.slice(6));
    assert.equal(lines.find(line => line.startsWith('event: '))?.slice(7), event.type); return event;
  });
}
function textOf(response) { return response.output.filter(item => item.type === 'message').flatMap(item => item.content).filter(part => part.type === 'output_text').map(part => part.text).join(''); }

test('Responses JSON uses same adapter and private session route without revealing private chunks', async t => {
  const api = await fixture(t);
  const response = await request(api, body({ instructions: 'Be concise', store: false, max_output_tokens: 77, temperature: 0.2 }), { 'X-Account-Pool-Group': 'g', 'X-Account-Pool-Session': 'my-session' });
  assert.equal(response.status, 200, response.text); const result = response.json();
  assert.equal(result.object, 'response'); assert.match(result.id, /^resp_/); assert.equal(result.status, 'completed'); assert.equal(result.store, false);
  assert.equal(textOf(result), 'Hi'); assert.equal(result.usage.input_tokens, 3); assert.equal(result.usage.output_tokens, 2);
  assert.equal(api.calls.length, 1); const call = api.calls[0];
  assert.equal(call.provider, 'pool-g'); assert.match(call.sessionId, /^local-api:[a-f0-9]{64}$/); assert.equal(call.system, 'Be concise'); assert.equal(call.maxTokens, 77); assert.equal(call.temperature, 0.2);
  assert.deepEqual(call.messages, [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }]);
  assert.doesNotMatch(response.text, /PRIVATE_REPLAY|my-session|pool-g/);
});

test('Responses SSE lifecycle and tools can be consumed by the existing native Responses transport', async t => {
  let options;
  const api = await fixture(t, { async *stream(value) {
    options = value;
    yield { type: 'text-delta', index: 0, text: 'Checking' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Checking!' } };
    yield { type: 'block-start', index: 2, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 2, argumentsDelta: '{"q":' };
    yield { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'call_1', name: 'lookup', arguments: '{"q":1}' } };
    yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 4, cacheReadTokens: 2, reasoningTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  } });
  const response = await request(api, body({ stream: true, tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} }, strict: false }] }));
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const events = frames(response.text); assert.equal(events[0].type, 'response.created'); assert.equal(events[1].type, 'response.in_progress');
  assert.equal(events.at(-1).type, 'response.completed'); assert.equal(events.filter(e => e.type === 'response.completed').length, 1);
  assert.deepEqual(events.map(e => e.sequence_number), events.map((_e, i) => i)); assert.doesNotMatch(response.text, /\[DONE\]|chatcmpl-|chat.completion/);
  const result = events.at(-1).response; assert.equal(textOf(result), 'Checking!');
  const tool = result.output.find(item => item.type === 'function_call'); assert.equal(tool.call_id, 'call_1'); assert.equal(tool.name, 'lookup'); assert.equal(tool.arguments, '{"q":1}');
  assert.equal(options.tools[0].name, 'lookup');
  async function* data() { for (const event of events) yield JSON.stringify(event); }
  const mapped = []; for await (const chunk of mapOpenAIResponses(data(), {})) mapped.push(chunk);
  assert.equal(mapped.at(-1).type, 'finish'); assert.equal(mapped.at(-1).reason.kind, 'tool-calls');
  assert.equal(mapped.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block.name, 'lookup');
});

test('Responses full-history function call results retain names and do not use server side state', async t => {
  const api = await fixture(t);
  const response = await request(api, body({ input: [
    { role: 'developer', content: 'Be careful' }, { role: 'user', content: [{ type: 'input_text', text: 'Find it' }] },
    { type: 'function_call', id: 'fc_old', call_id: 'call_old', name: 'lookup', arguments: '{"id":1}', status: 'completed' },
    { type: 'function_call_output', call_id: 'call_old', output: 'Found' },
  ], previous_response_id: null }));
  assert.equal(response.status, 200, response.text); assert.equal(api.calls[0].system, 'Be careful');
  assert.equal(api.calls[0].messages.at(-1).toolName, 'lookup'); assert.equal(api.calls[0].messages.at(-1).toolCallId, 'call_old');
});

test('Responses strict unsupported state and content fail before dispatch', async t => {
  const api = await fixture(t);
  for (const extra of [ { store: true }, { background: true }, { previous_response_id: 'resp_old' }, { conversation: 'conv' }, { include: ['reasoning.encrypted_content'] },
    { tools: [{ type: 'web_search' }] }, { text: { format: { type: 'json_object' } } }, { max_output_tokens: null }, { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://private.invalid/image' }] }] } ]) {
    const response = await request(api, body(extra)); assert.equal(response.status, 400, JSON.stringify(extra) + ': ' + response.text);
  }
  assert.equal(api.calls.length, 0);
});

test('Responses retains existing bearer, Host, Origin, method and body limit protections', async t => {
  const api = await fixture(t, {}, { maxBodyBytes: 200 });
  for (const [headers, expected] of [[{ authorization: '' }, 401], [{ origin: 'null' }, 403], [{ host: 'localhost:' + api.port }, 403]]) assert.equal((await request(api, body(), headers)).status, expected);
  assert.equal((await request(api, body(), {}, '/v1/responses', 'GET')).status, 405);
  assert.equal((await request(api, body(), {}, '/v1/responses?stream=true')).status, 404);
  assert.equal((await request(api, body({ input: 'x'.repeat(300) }))).status, 413); assert.equal(api.calls.length, 0);
});

test('Responses pre-output failures remain sanitized HTTP errors without eager SSE headers', async t => {
  for (const [code, status] of [['POOL_EXHAUSTED', 503], ['PRIVATE_CODE', 502]]) {
    const api = await fixture(t, { async *stream() { throw Object.assign(Error('PRIVATE_UPSTREAM_KEY'), { code }); } });
    const response = await request(api, body({ stream: true })); assert.equal(response.status, status); assert.doesNotMatch(response.text, /PRIVATE_|response.created/);
  }
});

test('Responses stream failures after output and after finish never emit completed', async t => {
  for (const ending of ['truncated', 'throw', 'throw-after-finish', 'error-finish']) {
    const api = await fixture(t, { async *stream() {
      yield { type: 'text-delta', index: 0, text: 'Partial' };
      if (ending === 'throw-after-finish') yield { type: 'finish', reason: { kind: 'stop' } };
      if (ending.startsWith('throw')) throw Error('PRIVATE_FAILURE');
      if (ending === 'error-finish') yield { type: 'finish', reason: { kind: 'error', failure: Error('PRIVATE_FINISH') } };
    } });
    const response = await request(api, body({ stream: true })); assert.equal(response.status, 200);
    const events = frames(response.text); assert.equal(events.at(-1).type, 'response.failed', ending);
    assert.ok(events.every(e => e.type !== 'response.completed' && e.type !== 'response.incomplete')); assert.doesNotMatch(response.text, /PRIVATE_|\[DONE\]/);
  }
});

test('Responses max output finish is incomplete for both JSON and SSE, not completed', async t => {
  const api = await fixture(t, { async *stream() { yield { type: 'text-delta', index: 0, text: 'Short' }; yield { type: 'finish', reason: { kind: 'max-tokens' } }; } });
  for (const stream of [false, true]) {
    const response = await request(api, body({ stream })); assert.equal(response.status, 200);
    const result = stream ? frames(response.text).at(-1).response : response.json(); assert.equal(result.status, 'incomplete'); assert.equal(result.incomplete_details.reason, 'max_output_tokens');
    if (stream) assert.equal(frames(response.text).at(-1).type, 'response.incomplete');
  }
});

test('Responses deadline after output produces response.failed and cancels shared signal', async t => {
  let signal, closed;
  const api = await fixture(t, { async *stream(options) { signal = options.signal; try { yield { type: 'text-delta', index: 0, text: 'Started' }; await aborted(signal); signal.throwIfAborted(); } finally { closed = true; } } }, { requestTimeoutMs: 50 });
  const response = await request(api, body({ stream: true })); assert.equal(response.status, 200);
  assert.equal(frames(response.text).at(-1).type, 'response.failed'); assert.match(response.text, /timed out/); assert.equal(signal.aborted, true); assert.equal(closed, true);
});

test('Responses disconnect cancels the adapter and returns its generator', async t => {
  let signal, cleanup; const done = new Promise(resolve => { cleanup = resolve; });
  const api = await fixture(t, { async *stream(options) { signal = options.signal; try { yield { type: 'text-delta', index: 0, text: 'Started' }; await aborted(signal); } finally { cleanup(); } } });
  await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: api.port, path: '/v1/responses', method: 'POST', headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json' } }, res => { res.once('data', () => { res.destroy(); resolve(); }); res.on('error', () => {}); });
    req.on('error', reject); req.end(JSON.stringify(body({ stream: true })));
  });
  await done; assert.equal(signal.aborted, true);
});

test('Responses shares real pool failover, cooldown, stickiness and usage with Chat Completions', async t => {
  const attempted = [], usage = [];
  const row = (id, priority) => ({ id, priority, platform: 'custom', status: 'active', schedulable: true, groups: ['g'], models: ['fixture-model'] });
  const adapter = createPoolAdapter({ initialAccounts: [row('a', 0), row('b', 1)], initialGroups: [{ id: 'g', enabled: true, selectionMode: 'sticky', models: ['fixture-model'] }], requestRetries: 0,
    onUsage: record => usage.push(record), upstream: { async *stream(account) {
      attempted.push(account.id); if (account.id === 'a') throw Object.assign(Error('PRIVATE_RATE_LIMIT'), { status: 429 });
      yield { type: 'text-delta', index: 0, text: 'OK' }; yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }; yield { type: 'finish', reason: { kind: 'stop' } };
    } } });
  const api = await fixture(t, adapter); const headers = { 'X-Account-Pool-Group': 'g', 'X-Account-Pool-Session': 'same-session' };
  assert.equal((await request(api, body(), headers)).status, 200);
  assert.equal((await request(api, { model: 'fixture-model', messages: [{ role: 'user', content: 'Again' }] }, headers, '/v1/chat/completions')).status, 200);
  assert.deepEqual(attempted, ['a', 'b', 'b']); assert.equal(usage.length, 2); assert.equal(usage[0].switches, 1); assert.equal(usage[0].sessionId, usage[1].sessionId);
  assert.ok(adapter.getAccount('a').rateLimitResetAt); assert.equal(adapter.listBindings()[0].accountId, 'b'); assert.equal(adapter.inflightSnapshot().size, 0);
});
