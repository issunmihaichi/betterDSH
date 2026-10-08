import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once, getEventListeners, EventEmitter } from 'node:events';
import { matchesPoolDetection } from '../lib/detection.js';
import { accountSchema } from '../lib/domain.js';
import WebSocket, { WebSocketServer } from 'ws';
import { createHttpUpstream, buildOpenAIResponsesRequest, mapOpenAIResponses, parseSse } from '../lib/upstream.js';
import { openAIResponsesUrl } from '../lib/native/openai-responses.js';

const key = 'local-fixture-api-key';
const options = { model: 'fixture-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] };
const account = { id: 'fixture-account', platform: 'custom', authMode: 'api-key', credentialRef: key, openaiApi: 'responses', openaiTransport: 'http' };
const text = (value = '你好🌍') => ({ id: 'msg_local', type: 'message', status: 'completed', content: [{ type: 'output_text', text: value }] });
const tool = (name = 'python', id = 'call_local') => ({ id: 'fc_local', type: 'function_call', status: 'completed', call_id: id, name, arguments: '{"n":1}' });
const complete = (output = [text()], usage = { input_tokens: 20, output_tokens: 5, input_tokens_details: { cached_tokens: 7 }, output_tokens_details: { reasoning_tokens: 2 } }) => ({ type: 'response.completed', response: { status: 'completed', output, usage } });
const reasoning = { id: 'rs_local', type: 'reasoning', status: 'completed', encrypted_content: 'private-encrypted-fixture', summary: [{ type: 'summary_text', text: 'think' }] };
const streamed = () => [
  { type: 'response.created', response: { id: 'resp_local', status: 'in_progress' } },
  { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: reasoning.id, summary_index: 0, delta: 'think' },
  { type: 'response.reasoning_summary_text.done', output_index: 0, item_id: reasoning.id, summary_index: 0, text: 'think' },
  { type: 'response.output_item.done', output_index: 0, item: reasoning },
  { type: 'response.output_text.delta', output_index: 1, item_id: 'msg_local', content_index: 0, delta: '你好' },
  { type: 'response.output_text.delta', output_index: 1, item_id: 'msg_local', content_index: 0, delta: '🌍' },
  { type: 'response.output_item.done', output_index: 1, item: text() },
  { type: 'response.output_item.added', output_index: 2, item: { ...tool(), status: 'in_progress', arguments: '' } },
  { type: 'response.function_call_arguments.delta', output_index: 2, item_id: 'fc_local', delta: '{"n":' },
  { type: 'response.function_call_arguments.delta', output_index: 2, item_id: 'fc_local', delta: '1}' },
  { type: 'response.output_item.done', output_index: 2, item: tool() },
  complete([reasoning, text(), tool()]),
];
async function collectEvents(events, context) {
  return Array.fromAsync(mapOpenAIResponses((async function* () { for (const event of events) yield typeof event === 'string' ? event : JSON.stringify(event); })(), context));
}

async function fixture(t, { http, ws, upgrade } = {}) {
  const requests = [];
  const sockets = [];
  const server = createServer(async (request, response) => {
    try {
      const bytes = [];
      for await (const chunk of request) bytes.push(chunk);
      const body = Buffer.concat(bytes).toString();
      requests.push({ transport: 'http', path: request.url, headers: request.headers, body: body ? JSON.parse(body) : undefined });
      if (request.headers.authorization !== `Bearer ${key}`) { response.writeHead(401).end(); return; }
      if (http) { await http(request, response, requests.at(-1)); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      // CRLF and UTF8 are split at every byte, exercising actual network SSE.
      const bytesOut = Buffer.from(streamed().map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
      for (const byte of bytesOut) response.write(Buffer.from([byte]));
      // Deliberately leave the stream open; completion must cancel it.
    } catch (error) { response.destroy(error); }
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    requests.push({ transport: 'websocket', path: request.url, headers: request.headers });
    if (upgrade) { upgrade(request, socket, head); return; }
    if (request.headers.authorization !== `Bearer ${key}`) { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return; }
    wss.handleUpgrade(request, socket, head, (connection) => wss.emit('connection', connection, request));
  });
  wss.on('connection', (connection) => {
    sockets.push(connection);
    connection.on('error', () => {});
    connection.on('message', (raw) => {
      const body = JSON.parse(raw.toString());
      requests.at(-1).body = body;
      if (ws) ws(connection, body);
      else for (const event of streamed()) connection.send(JSON.stringify(event));
    });
  });
  const peers = new Set();
  server.on('connection', (socket) => { peers.add(socket); socket.on('close', () => peers.delete(socket)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const connection of wss.clients) connection.terminate();
    for (const socket of peers) socket.destroy();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests, sockets };
}
function makeUpstream(config = {}) { return createHttpUpstream({ webSocketConnectTimeoutMs: 500, webSocketIdleTimeoutMs: 500, ...config }); }
function verifyChunks(chunks) {
  assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), '你好🌍');
  assert.equal(chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join(''), 'think');
  const blocks = chunks.filter((c) => c.type === 'block-end');
  assert.deepEqual(blocks.map((c) => c.block.type), ['reasoning', 'text', 'tool-call']);
  assert.equal(new Set(blocks.map((c) => c.index)).size, 3);
  assert.deepEqual(blocks.at(-1).block, { type: 'tool-call', id: 'call_local', name: 'python', arguments: '{"n":1}' });
  assert.deepEqual(chunks.at(-2).usage, { inputTokens: 13, outputTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 0, reasoningTokens: 2 });
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } });
  assert.equal(JSON.stringify(chunks).includes('private-encrypted-fixture'), false);
}
function verifyHeaders(headers) {
  assert.equal(headers.authorization, `Bearer ${key}`);
  for (const field of ['chatgpt-account-id', 'openai-beta', 'originator', 'version', 'session_id']) assert.equal(headers[field], undefined);
}

test('Responses usage keeps cached input out of the uncached bucket', async () => {
  for (const [label, total, cached, input] of [
    ['absent cache', 32, undefined, 32],
    ['zero cache', 32, 0, 32],
    ['partial cache', 11, 3, 8],
    ['full cache', 32, 32, 0],
    ['large cached request', 286557, 285184, 1373],
    ['inconsistent cache count', 3, 7, 0],
  ]) {
    const chunks = await collectEvents([complete([text()], { input_tokens: total, output_tokens: 70,
      ...(cached === undefined ? {} : { input_tokens_details: { cached_tokens: cached } }),
      output_tokens_details: { reasoning_tokens: 20 },
    })]);
    const usage = chunks.find((chunk) => chunk.type === 'usage').usage;
    assert.deepEqual(usage, { inputTokens: input, outputTokens: 70, cacheReadTokens: cached ?? 0,
      cacheWriteTokens: 0, reasoningTokens: 20 }, label);
    if ((cached ?? 0) <= total) {
      assert.equal(usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens, total,
        `${label}: prompt total is conserved without output or reasoning`);
    }
  }
});

// These fixtures authenticate at actual HTTP and WS servers; no external keys.
test('general Responses body preserves ordered history, tools and API options', () => {
  const built = buildOpenAIResponsesRequest(account, { ...options, system: 'instructions', maxTokens: 1, temperature: 0.2, reasoningEffort: 'high', tools: [{ name: 'python', parameters: { type: 'object' } }], messages: [
    { role: 'system', content: 'history system' },
    { role: 'assistant', content: [{ type: 'text', text: 'before' }, { type: 'tool-call', id: 'call_unchanged', name: 'python', arguments: { n: 1 } }, { type: 'text', text: 'after' }] },
    { role: 'tool', toolCallId: 'call_unchanged', content: 'result' },
  ] }, key);
  assert.equal(built.url, 'https://api.openai.com/v1/responses');
  verifyHeaders(built.init.headers);
  const body = JSON.parse(built.init.body);
  assert.equal(body.instructions, 'instructions');
  assert.equal(body.max_output_tokens, 16);
  assert.equal(body.temperature, 0.2);
  assert.deepEqual(body.reasoning, { effort: 'high', summary: 'auto' });
  assert.deepEqual(body.include, ['reasoning.encrypted_content']);
  assert.deepEqual(body.input.map((item) => item.type), ['message', 'message', 'function_call', 'message', 'function_call_output']);
  assert.equal(body.input[2].call_id, 'call_unchanged');
  assert.equal(body.input[4].call_id, 'call_unchanged');
  assert.equal(body.tools[0].name, 'python');
  assert.equal(body.tools[0].strict, false);
  assert.equal(JSON.parse(buildOpenAIResponsesRequest(account, options, key).init.body).instructions, undefined);
  for (const invalid of [{ stop: ['x'] }, { reasoningEffort: 'invented' }, { messages: [{ role: 'user', content: [{ type: 'image' }] }] }, { messages: [{ role: 'tool', content: 'missing id' }] }]) {
    assert.throws(() => buildOpenAIResponsesRequest(account, { ...options, ...invalid }, key), { code: 'POOL_UNSUPPORTED_CONTENT' });
  }
  assert.throws(() => buildOpenAIResponsesRequest(account, options, 'key\r\ninjection'), { code: 'POOL_NO_CREDENTIAL' });
});

test('Responses URLs normalize copied endpoints and map HTTP(S) to WS(S)', () => {
  for (const suffix of ['', '/', '/v1', '/v1/', '/v1/responses', '/v1/responses/', '/responses']) {
    assert.equal(openAIResponsesUrl(`https://relay.example${suffix}`), 'https://relay.example/v1/responses');
    assert.equal(openAIResponsesUrl(`http://relay.example${suffix}`, true), 'ws://relay.example/v1/responses');
  }
  assert.equal(openAIResponsesUrl('wss://relay.example/proxy/v1/responses'), 'https://relay.example/proxy/v1/responses');
  assert.equal(openAIResponsesUrl('https://relay.example/proxy/v1/responses', true), 'wss://relay.example/proxy/v1/responses');
  for (const base of ['ftp://relay.example', 'https://user:secret@relay.example', 'https://relay.example?key=secret', 'https://relay.example#secret', 'invalid']) {
    assert.throws(() => openAIResponsesUrl(base), { code: 'POOL_UNSUPPORTED_CONTENT' });
  }
});

for (const transport of ['http', 'websocket']) {
  test(`schema-default null base URL uses the official OpenAI ${transport} endpoint`, async () => {
    const row = accountSchema.parse({ id: `default-${transport}`, platform: 'openai', openaiApi: 'responses', openaiTransport: transport, credentialRef: key, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    assert.equal(row.baseUrl, null);
    assert.equal(buildOpenAIResponsesRequest(row, options, key).url, 'https://api.openai.com/v1/responses');
    assert.equal(openAIResponsesUrl(null, true), 'wss://api.openai.com/v1/responses');
    class DefaultEndpointWebSocket extends EventEmitter {
      constructor(url, init) {
        super(); this.readyState = WebSocket.OPEN;
        assert.equal(url, 'wss://api.openai.com/v1/responses');
        assert.equal(init.headers.authorization, `Bearer ${key}`);
        queueMicrotask(() => this.emit('open'));
      }
      send() { queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify(complete())), false)); }
      terminate() { this.readyState = WebSocket.CLOSED; queueMicrotask(() => this.emit('close')); }
    }
    const upstream = makeUpstream({ webSocketImpl: DefaultEndpointWebSocket, fetchImpl: async (url) => {
      assert.equal(transport, 'http', 'WebSocket must never fall back to HTTP');
      assert.equal(url, 'https://api.openai.com/v1/responses');
      return new Response(`data: ${JSON.stringify(complete())}\n\n`);
    } });
    const chunks = await Array.fromAsync(upstream.stream(row, options));
    assert.equal(chunks.at(-1).reason.kind, 'stop');
  });
}

test('native-compatible prompt cache identity is stable across turns and credential refresh', () => {
  const opts = { ...options, sessionId: 'local-session' };
  const first = JSON.parse(buildOpenAIResponsesRequest(account, opts, key).init.body).prompt_cache_key;
  assert.equal(first.length, 64);
  assert.equal(first, JSON.parse(buildOpenAIResponsesRequest(account, { ...opts, messages: [], model: 'another' }, 'refreshed-key').init.body).prompt_cache_key);
  assert.notEqual(first, JSON.parse(buildOpenAIResponsesRequest({ ...account, id: 'another' }, opts, key).init.body).prompt_cache_key);
  assert.equal(JSON.parse(buildOpenAIResponsesRequest(account, options, key).init.body).prompt_cache_key, undefined);
});

for (const transport of ['http', 'websocket']) {
  test(`authenticated actual ${transport} streams text/reasoning/tools/usage and completes before socket EOF`, { timeout: 3000 }, async (t) => {
    const server = await fixture(t);
    const controller = new AbortController();
    const clients = [];
    class TrackedWebSocket extends WebSocket { constructor(...args) { super(...args); clients.push(this); } }
    const upstream = makeUpstream({ webSocketImpl: TrackedWebSocket, ...(transport === 'websocket' ? { fetchImpl: async () => { assert.fail('WS must never fall back to HTTP'); } } : {}) });
    const row = { ...account, id: `actual-${transport}`, baseUrl: `${server.baseUrl}/v1/responses`, openaiTransport: transport };
    const chunks = await Array.fromAsync(upstream.stream(row, { ...options, signal: controller.signal, reasoningEffort: 'high' }));
    verifyChunks(chunks);
    assert.equal(server.requests.length, 1);
    const request = server.requests[0];
    assert.equal(request.path, '/v1/responses');
    verifyHeaders(request.headers);
    assert.equal(request.body.stream, transport === 'http' ? true : undefined);
    assert.equal(request.body.type, transport === 'websocket' ? 'response.create' : undefined);
    // Returned call ids and encrypted reasoning survive the next tool-result turn.
    const toolBlock = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call').block;
    const followup = buildOpenAIResponsesRequest(row, { ...options, messages: [{ role: 'assistant', content: [toolBlock] }, { role: 'tool', toolCallId: toolBlock.id, content: 'result' }] }, key);
    const body = JSON.parse(followup.init.body);
    assert.deepEqual(body.input.map((item) => item.type), ['reasoning', 'function_call', 'function_call_output']);
    assert.equal(body.input[0].encrypted_content, reasoning.encrypted_content);
    assert.equal(body.input[0].id, undefined);
    assert.equal(body.input[1].call_id, body.input[2].call_id);
    if (transport === 'websocket') {
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      const client = clients[0];
      if (client.readyState !== WebSocket.CLOSED) await once(client, 'close');
      for (const name of ['open', 'message', 'error', 'close', 'unexpected-response']) assert.equal(client.listenerCount(name), 0);
    }
  });
}

test('legacy Chat Completions remains the default and websocket/chat is rejected before I/O', async () => {
  const calls = [];
  const upstream = makeUpstream({ fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  } });
  const legacy = { ...account, openaiApi: undefined, openaiTransport: undefined };
  await Array.fromAsync(upstream.stream(legacy, options));
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  await assert.rejects(Array.fromAsync(upstream.stream({ ...legacy, openaiTransport: 'websocket' }, options)), { code: 'POOL_UNSUPPORTED_CONTENT' });
  assert.equal(calls.length, 1);
});

for (const transport of ['http', 'websocket']) {
  test(`${transport} HTTP authentication/handshake errors preserve status and retry-after`, async (t) => {
    const server = await fixture(t, {
      http: (_request, response) => response.writeHead(429, { 'retry-after': '3' }).end('{"error":{"message":"fixture limit"}}'),
      upgrade: (_request, socket) => socket.end('HTTP/1.1 429 Too Many Requests\r\nRetry-After: 3\r\nContent-Length: 0\r\n\r\n'),
    });
    await assert.rejects(Array.fromAsync(makeUpstream().stream({ ...account, baseUrl: server.baseUrl, openaiTransport: transport }, options)), { status: 429, providerRetryAfterMs: 3000 });
  });
}

for (const [label, event, expected] of [
  ['failure', { type: 'response.failed', response: { error: { code: 'rate_limit_exceeded' } } }, { code: 'rate_limit_exceeded', status: 429 }],
  ['error', { type: 'error', error: { code: 'invalid_api_key', status_code: 401 } }, { code: 'invalid_api_key', status: 401 }],
  ['top-level error status', { type: 'error', code: 'server_error', status: 503 }, { code: 'server_error', status: 503 }],
  ['incomplete', { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }, { code: 'max_output_tokens', status: 400 }],
  ['cancelled', { type: 'response.cancelled' }, { status: 502 }],
]) {
  for (const transport of ['http', 'websocket']) {
    test(`${transport} rejects ${label} terminal without success`, async (t) => {
      const server = await fixture(t, {
        http: (_request, response) => response.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${JSON.stringify(event)}\n\n`),
        ws: (connection) => connection.send(JSON.stringify(event)),
      });
      const chunks = [];
      await assert.rejects(async () => { for await (const chunk of makeUpstream().stream({ ...account, baseUrl: server.baseUrl, openaiTransport: transport }, options)) chunks.push(chunk); }, expected);
      assert.equal(chunks.some((c) => c.type === 'finish'), false);
    });
  }
}

test('WebSocket abrupt and normal early close are truncated failures', async (t) => {
  for (const close of [(socket) => socket.close(), (socket) => socket.terminate()]) {
    const server = await fixture(t, { ws: (connection) => { connection.send(JSON.stringify({ type: 'response.created' })); close(connection); } });
    await assert.rejects(Array.fromAsync(makeUpstream().stream({ ...account, baseUrl: server.baseUrl, openaiTransport: 'websocket' }, options)), { code: 'RESPONSES_WS_STREAM_TRUNCATED', status: 502 });
  }
});

test('WebSocket connection and idle waits are bounded', { timeout: 3000 }, async (t) => {
  const idle = await fixture(t, { ws: () => {} });
  await assert.rejects(Array.fromAsync(makeUpstream({ webSocketIdleTimeoutMs: 30 }).stream({ ...account, baseUrl: idle.baseUrl, openaiTransport: 'websocket' }, options)), { code: 'RESPONSES_WS_IDLE_TIMEOUT', status: 504 });
  const connect = await fixture(t, { upgrade: () => {} });
  await assert.rejects(Array.fromAsync(makeUpstream({ webSocketConnectTimeoutMs: 30 }).stream({ ...account, baseUrl: connect.baseUrl, openaiTransport: 'websocket' }, options)), { code: 'RESPONSES_WS_CONNECT_TIMEOUT', status: 504 });
});

test('WebSocket abort while waiting removes signal and socket listeners', { timeout: 3000 }, async (t) => {
  const controller = new AbortController();
  const clients = [];
  class TrackedWebSocket extends WebSocket { constructor(...args) { super(...args); clients.push(this); } }
  const reason = new DOMException('fixture aborted', 'AbortError');
  const server = await fixture(t, { ws: () => controller.abort(reason) });
  await assert.rejects(Array.fromAsync(makeUpstream({ webSocketImpl: TrackedWebSocket }).stream({ ...account, baseUrl: server.baseUrl, openaiTransport: 'websocket' }, { ...options, signal: controller.signal })), (error) => error === reason);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  if (clients[0].readyState !== WebSocket.CLOSED) await once(clients[0], 'close');
  for (const event of ['open', 'message', 'error', 'close', 'unexpected-response']) assert.equal(clients[0].listenerCount(event), 0);
});

test('WebSocket consumer return closes immediately and removes abort listener', { timeout: 3000 }, async (t) => {
  const controller = new AbortController();
  const server = await fixture(t, { ws: (connection) => connection.send(JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: 'partial' })) });
  const iterator = makeUpstream().stream({ ...account, baseUrl: server.baseUrl, openaiTransport: 'websocket' }, { ...options, signal: controller.signal });
  assert.equal((await iterator.next()).value.type, 'block-start');
  await iterator.return();
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  if (server.sockets[0].readyState !== WebSocket.CLOSED) await once(server.sockets[0], 'close');
});

test('WebSocket abort during handshake and pre-abort never leaks listeners or sends HTTP', { timeout: 3000 }, async (t) => {
  const controller = new AbortController();
  const reason = new DOMException('handshake aborted', 'AbortError');
  const server = await fixture(t, { upgrade: () => controller.abort(reason) });
  await assert.rejects(Array.fromAsync(makeUpstream().stream({ ...account, baseUrl: server.baseUrl, openaiTransport: 'websocket' }, { ...options, signal: controller.signal })), (error) => error === reason);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await assert.rejects(Array.fromAsync(makeUpstream().stream(account, { ...options, signal: controller.signal })), (error) => error === reason);
  assert.equal(server.requests.length, 1);
});

test('generic mapper rejects malformed, missing terminal and inconsistent output', async () => {
  for (const events of [[], ['[DONE]'], ['bad-json'], ['null'], ['[]'], [complete([{ ...reasoning, summary: 'bad shape' }])], [{ type: 'response.created' }], [{ type: 'response.completed' }], [{ type: 'response.done', response: {} }], [{ type: 'response.output_text.delta', output_index: 0, delta: 'one' }, complete([text('two')])]]) {
    await assert.rejects(collectEvents(events), (error) => error.name === 'OpenAIResponsesStreamError' && error.status === 502 && !error.code.startsWith('CODEX_'));
  }
});

test('generic mapper supports final snapshots without streamed deltas or reasoning duplication', async () => {
  const chunks = await collectEvents([complete([reasoning, text(), tool()])]);
  verifyChunks(chunks);
  const done = await collectEvents([{ type: 'response.done', response: { status: 'completed', output: [text()] } }]);
  assert.equal(done.at(-1).reason.kind, 'stop');
});

test('private encrypted tool replay isolates key, account, endpoint and model', async () => {
  const row = { ...account, id: 'cache-isolation' };
  const built = buildOpenAIResponsesRequest(row, options, key);
  const chunks = await collectEvents([complete([reasoning, tool()])], built.context);
  const block = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call').block;
  const next = { ...options, messages: [{ role: 'assistant', content: [block] }, { role: 'tool', toolCallId: block.id, content: 'result' }] };
  for (const [a, opts, credential] of [[{ ...row, id: 'other' }, next, key], [row, { ...next, model: 'other' }, key], [{ ...row, baseUrl: 'https://relay.example' }, next, key], [row, next, 'different-key']]) {
    assert.equal(JSON.parse(buildOpenAIResponsesRequest(a, opts, credential).init.body).input.some((i) => i.type === 'reasoning'), false);
  }
  const failed = buildOpenAIResponsesRequest({ ...row, id: 'failed-cache' }, options, key);
  await assert.rejects(collectEvents([{ type: 'response.output_item.done', output_index: 0, item: reasoning }, { type: 'response.output_item.done', output_index: 1, item: tool() }, { type: 'response.failed', response: { error: { code: 'server_error' } } }], failed.context));
  assert.equal(JSON.parse(buildOpenAIResponsesRequest({ ...row, id: 'failed-cache' }, next, key).init.body).input.some((i) => i.type === 'reasoning'), false);
});

for (const transport of ['http', 'websocket']) {
  test(`${transport} executes a real function-call and function-result round trip`, { timeout: 3000 }, async (t) => {
    const eventsFor = (body) => {
      if (!body.input.some((entry) => entry.type === 'function_call_output')) return complete([reasoning, tool()]);
      const result = body.input.find((entry) => entry.type === 'function_call_output');
      assert.equal(result.call_id, 'call_local');
      assert.equal(result.output, '42');
      assert.equal(body.input.find((entry) => entry.type === 'function_call').name, 'python');
      assert.equal(body.input.find((entry) => entry.type === 'reasoning').encrypted_content, reasoning.encrypted_content);
      return complete([text('tool result accepted')]);
    };
    const server = await fixture(t, {
      http: (_request, response, incoming) => response.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${JSON.stringify(eventsFor(incoming.body))}\n\n`),
      ws: (connection, body) => connection.send(JSON.stringify(eventsFor(body))),
    });
    const row = { ...account, id: `roundtrip-${transport}`, baseUrl: server.baseUrl, openaiTransport: transport };
    const upstream = makeUpstream();
    const first = await Array.fromAsync(upstream.stream(row, { ...options, reasoningEffort: 'high' }));
    const block = first.find((c) => c.type === 'block-end' && c.block.type === 'tool-call').block;
    const second = await Array.fromAsync(upstream.stream(row, { ...options, messages: [...options.messages, { role: 'assistant', content: [block] }, { role: 'tool', toolCallId: block.id, content: '42' }] }));
    assert.equal(second.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'tool result accepted');
    assert.equal(second.at(-1).reason.kind, 'stop');
    assert.equal(server.requests.length, 2);
    for (const request of server.requests) { assert.equal(request.transport, transport); verifyHeaders(request.headers); }
  });
}

test('Responses HTTP abort while waiting for events releases the fetch stream', { timeout: 3000 }, async (t) => {
  const controller = new AbortController();
  const server = await fixture(t, { http: (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"type":"response.created"}\n\n');
    setImmediate(() => controller.abort(new DOMException('fixture HTTP aborted', 'AbortError')));
  } });
  await assert.rejects(Array.fromAsync(makeUpstream().stream({ ...account, baseUrl: server.baseUrl }, { ...options, signal: controller.signal })), { name: 'AbortError' });
});

test('Responses WebSocket rejects binary and malformed JSON frames and removes listeners', async (t) => {
  for (const frame of [Buffer.from('binary'), 'null', 'not-json']) {
    const server = await fixture(t, { ws: (connection) => connection.send(frame) });
    const controller = new AbortController();
    await assert.rejects(Array.fromAsync(makeUpstream().stream({ ...account, baseUrl: server.baseUrl, openaiTransport: 'websocket' }, { ...options, signal: controller.signal })), (error) => error.status === 502 && error.code.startsWith('RESPONSES_'));
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('actual WebSocket binary error cannot be hidden by a following completed frame', async (t) => {
  const server = await fixture(t, { ws: (connection) => {
    connection.send(Buffer.from('invalid binary frame'));
    connection.send(JSON.stringify(complete()));
  } });
  const chunks = [];
  await assert.rejects(async () => {
    for await (const chunk of makeUpstream().stream({ ...account, baseUrl: server.baseUrl, openaiTransport: 'websocket' }, options)) chunks.push(chunk);
  }, { code: 'RESPONSES_WS_INVALID_FRAME', status: 502 });
  assert.equal(chunks.some((chunk) => chunk.type === 'finish'), false);
});

for (const bufferKind of ['count', 'bytes']) {
  test(`WebSocket ${bufferKind} buffer failure takes precedence over queued completed frame`, async () => {
    class FloodedWebSocket extends EventEmitter {
      constructor() {
        super(); this.readyState = WebSocket.OPEN;
        queueMicrotask(() => this.emit('open'));
      }
      send() {
        queueMicrotask(() => {
          if (bufferKind === 'count') {
            const raw = Buffer.from('{"type":"response.created"}');
            for (let index = 0; index < 10001; index++) this.emit('message', raw, false);
          } else this.emit('message', Buffer.alloc(16 * 1024 * 1024 + 1, 'x'), false);
          this.emit('message', Buffer.from(JSON.stringify(complete())), false);
        });
      }
      terminate() { this.readyState = WebSocket.CLOSED; queueMicrotask(() => this.emit('close')); }
    }
    const chunks = [];
    await assert.rejects(async () => {
      for await (const chunk of makeUpstream({ webSocketImpl: FloodedWebSocket }).stream({ ...account, openaiTransport: 'websocket' }, options)) chunks.push(chunk);
    }, { code: 'RESPONSES_WS_BUFFER_LIMIT', status: 502 });
    assert.equal(chunks.some((chunk) => chunk.type === 'finish'), false);
  });
}

test('Responses stream errors preserve private pool detection text without exposing provider messages', async () => {
  const marker = 'fixture-pool-detection';
  await assert.rejects(collectEvents([{ type: 'response.failed', response: { error: { code: 'server_error', message: marker } } }]), (error) => {
    assert.equal(matchesPoolDetection(error, { poolDetectionRetry: true, poolDetectionKeywords: [marker] }), true);
    assert.equal(error.message.includes(marker), false);
    assert.equal(JSON.stringify(error).includes(marker), false);
    return true;
  });
});
