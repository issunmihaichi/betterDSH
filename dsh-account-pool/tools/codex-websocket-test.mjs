import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { createCodexWebSocketTransport } from '../lib/native/codex-websocket.js';

// Synthetic fixtures only. The real ws tests bind exclusively to loopback and
// use fixed fake credentials. No vendor requests, profile reads or installation.
const tick = () => new Promise(resolve => setImmediate(resolve));
const user = text => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const assistant = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const completed = (id = 'resp_fixture', output = []) => ({ type: 'response.completed', response: { id, status: 'completed', output } });
const frame = (socket, event) => socket.emit('message', Buffer.from(JSON.stringify(event)), false);
const failureFrame = (socket, code, status = 400) => frame(socket, { type: 'error', status, error: { code, message: 'PRIVATE-FIXTURE-SERVER-TEXT' } });
function request(input = [user('hello')], changes = {}) {
  return { url: 'https://fixture.invalid/backend-api/codex/responses', context: { scope: 'fixture-scope' }, init: {
    headers: { authorization: 'Bearer FIXTURE-NOT-REAL', 'chatgpt-account-id': 'FIXTURE-ACCOUNT', originator: 'codex_cli_rs',
      'user-agent': 'codex_cli_rs/0.160.1', version: '0.160.1', 'openai-beta': 'old', accept: 'text/event-stream',
      'content-type': 'application/json', 'x-codex-turn-metadata': '{"turn_id":"1"}', 'session-id': 'fixture-session',
      cookie: 'DO-NOT-FORWARD', 'x-untrusted': 'DO-NOT-FORWARD' },
    body: JSON.stringify({ model: 'fixture-model', instructions: 'test', stream: true, store: false,
      reasoning: { effort: 'high' }, tools: [], input, client_metadata: { turn_id: '1' }, ...changes }),
  } };
}
function mapping(extra = {}) {
  let output, callIds;
  return {
    sessionKey: 'session-hash', identityKey: 'identity-hash',
    async *mapResponse(frames) {
      output = undefined; callIds = undefined;
      for await (const text of frames) {
        const event = JSON.parse(text);
        if (event.type === 'response.output_text.delta') yield { type: 'text-delta', text: event.delta };
        if (event.type === 'response.completed' || event.type === 'response.done') {
          output = event.response.output ?? [];
          callIds = new Map(output.filter(item => item.type === 'function_call').map(item => [item.call_id, item.call_id]));
          yield { type: 'finish', reason: { kind: 'stop' } };
          return;
        }
      }
      throw Object.assign(new Error('Synthetic mapper truncated'), { code: 'MAPPER_TRUNCATED' });
    },
    getContinuationOutput: () => output,
    getContinuationCallIds: () => callIds,
    ...extra,
  };
}
function fixture(t, handler = socket => frame(socket, completed()), settings = {}) {
  const sockets = [], sent = [];
  class FakeSocket extends EventEmitter {
    constructor(url, options) {
      super(); this.url = url; this.options = options; this.readyState = 0;
      sockets.push(this);
      queueMicrotask(() => {
        if (settings.connect) { settings.connect(this); return; }
        if (this.readyState === 0) { this.readyState = 1; this.emit('open'); }
      });
    }
    send(text, callback) {
      const body = JSON.parse(text); sent.push({ body, socket: this });
      if (settings.sendFailure) { callback(new Error('PRIVATE-SEND')); return; }
      callback?.(); handler(this, body, sent.length);
    }
    terminate() {
      if (this.readyState === 3) return;
      const connecting = this.readyState === 0;
      this.readyState = 3;
      queueMicrotask(() => {
        if (connecting) this.emit('error', new Error('synthetic connecting termination'));
        this.emit('close');
      });
    }
  }
  const transport = createCodexWebSocketTransport({ webSocketImpl: FakeSocket, connectTimeoutMs: 1000,
    idleTimeoutMs: 1000, ...settings });
  t.after(async () => {
    transport.dispose(); await tick();
    for (const socket of sockets) {
      assert.equal(socket.readyState, 3);
      assert.deepEqual(socket.eventNames(), [], 'transport releases all owned socket listeners');
    }
  });
  return { transport, sockets, sent, collect: (req = request(), options = mapping()) => Array.fromAsync(transport.stream(req, options)) };
}

test('handshake preserves Codex path/identity, excludes HTTP-only headers and forwards each body metadata', async t => {
  const f = fixture(t);
  await f.collect();
  await f.collect(request([user('hello'), user('next')], { client_metadata: { turn_id: '2' } }));
  assert.equal(f.sockets.length, 1);
  assert.equal(f.sockets[0].url, 'wss://fixture.invalid/backend-api/codex/responses');
  const { headers, followRedirects, handshakeTimeout, maxPayload } = f.sockets[0].options;
  assert.equal(followRedirects, false); assert.equal(handshakeTimeout, 1000); assert.equal(maxPayload, 16 * 1024 * 1024);
  assert.equal(headers.authorization, 'Bearer FIXTURE-NOT-REAL'); assert.equal(headers['chatgpt-account-id'], 'FIXTURE-ACCOUNT');
  assert.equal(headers['openai-beta'], 'responses_websockets=2026-02-06'); assert.equal(headers.originator, 'codex_cli_rs');
  assert.equal(headers['x-codex-turn-metadata'], '{"turn_id":"1"}');
  for (const name of ['accept', 'content-type', 'cookie', 'x-untrusted']) assert.equal(headers[name], undefined);
  assert.equal(f.sent[0].body.type, 'response.create'); assert.equal(f.sent[0].body.stream, true);
  assert.deepEqual(f.sent[0].body.reasoning, { effort: 'high' }); assert.deepEqual(f.sent[1].body.client_metadata, { turn_id: '2' });
  assert.equal(f.sent[1].body.previous_response_id, 'resp_fixture'); assert.deepEqual(f.sent[1].body.input, [user('next')]);
  const counts = f.transport.snapshot();
  assert.equal(counts.connectionsOpened, 1); assert.equal(counts.connectionReuses, 1);
  assert.equal(counts.fullRequests, 1); assert.equal(counts.incrementalRequests, 1); assert.equal(counts.completedRequests, 2);
  assert.ok(Object.values(counts).every(value => typeof value === 'number' || typeof value === 'boolean'));
  assert.equal(JSON.stringify(counts).includes('FIXTURE'), false);
});

test('official v0.160.1 response.create retains ordinary API fields including stream:true', async t => {
  // codex-api/src/common.rs:306-345 and endpoint/responses_websocket.rs:943-1001
  // serialize the whole ResponsesApiRequest plus WS type/previous_response_id.
  const f = fixture(t);
  const req = request([user('hello')], { tool_choice: 'auto', parallel_tool_calls: true,
    include: ['reasoning.encrypted_content'], service_tier: 'priority', prompt_cache_key: 'cache-key',
    stream_options: { include_usage: true }, text: { format: { type: 'text' } }, access_programs: ['daybreak_blue'] });
  await f.collect(req);
  assert.deepEqual(f.sent[0].body, { ...JSON.parse(req.init.body), type: 'response.create' });
});

test('previous full input PLUS normalized output is exact baseline, including empty deltas', async t => {
  const output = [assistant('answer')];
  const f = fixture(t, socket => frame(socket, completed('resp_first', output)));
  await f.collect();
  await f.collect(request([user('hello'), ...output]));
  assert.deepEqual(f.sent[1].body.input, []); assert.equal(f.sent[1].body.previous_response_id, 'resp_first');
});

test('all non-input fields, scope and changed/removed/reordered history forbid delta', async t => {
  for (const changes of [{ instructions: 'changed' }, { model: 'other' }, { reasoning: { effort: 'low' } },
    { tools: [{ type: 'function', name: 'test' }] }, { new_future_field: true }, { include: [] }, { store: true },
    { stream_options: {} }, { prompt_cache_key: 'other' }, { service_tier: 'priority' }, { service_tier: 'ultrafast' }]) {
    const f = fixture(t); await f.collect();
    await f.collect(request([user('hello'), user('next')], changes));
    assert.equal(f.sent[1].body.previous_response_id, undefined, JSON.stringify(changes));
  }
  for (const input of [[], [user('edited'), user('next')], [user('next'), user('hello')]]) {
    const f = fixture(t); await f.collect(); await f.collect(request(input));
    assert.equal(f.sent[1].body.previous_response_id, undefined);
  }
  const f = fixture(t); await f.collect();
  const req = request([user('hello'), user('next')]); req.context.scope = 'other';
  await f.collect(req); assert.equal(f.sent[1].body.previous_response_id, undefined);
});

test('object key order and safe integer JSON arguments compare semantically', async t => {
  const call = { type: 'function_call', call_id: 'fc_test', name: 'test', arguments: '{ "b": 2, "a": {"x":1} }' };
  const f = fixture(t, socket => frame(socket, completed('resp_call', [call])));
  await f.collect();
  await f.collect(request([user('hello'), { arguments: '{"a":{"x":1},"b":2}', name: 'test', call_id: 'fc_test', type: 'function_call' },
    { type: 'function_call_output', call_id: 'fc_test', output: 'ok' }], { reasoning: { effort: 'high' } }));
  assert.equal(f.sent[1].body.previous_response_id, 'resp_call'); assert.equal(f.sent[1].body.input.length, 1);
});

test('duplicate JSON keys, unsafe integers, floats and malformed arguments never become unsafe semantic matches', async t => {
  for (const [before, after] of [['{"a":1,"a":2}', '{"a":2}'], ['{"x":9007199254740993}', '{"x":9007199254740992}'],
    ['{"x":1.00000000000000001}', '{"x":1}'], ['{"x":0.5}', '{ "x": 0.5 }'], ['{bad}', '{}']]) {
    const call = { type: 'function_call', call_id: 'fc_test', name: 'test', arguments: before };
    const f = fixture(t, socket => frame(socket, completed('resp_call', [call]))); await f.collect();
    await f.collect(request([user('hello'), { ...call, arguments: after }, user('next')]));
    assert.equal(f.sent[1].body.previous_response_id, undefined, before);
  }
});

test('wire call IDs remap cumulative tool-result deltas, full request clears alias state', async t => {
  const call = (id, args = '{}') => ({ type: 'function_call', call_id: id, name: 'tool', arguments: args });
  const f = fixture(t, (socket, body, count) => frame(socket, completed(`resp_${count}`, [call(`fc_${count}`)])));
  const opts = raw => mapping({ getContinuationCallIds: () => new Map([[`fc_${raw}`, `call_${raw}`]]) });
  await f.collect(request(), opts(1));
  const secondInput = [user('hello'), call('fc_1'), { type: 'function_call_output', call_id: 'fc_1', output: 'first' }];
  await f.collect(request(secondInput), opts(2));
  assert.equal(f.sent[1].body.input[0].call_id, 'call_1');
  const thirdInput = [...secondInput, call('fc_2'), { type: 'function_call_output', call_id: 'fc_1', output: 'late-first' },
    { type: 'function_call_output', call_id: 'fc_2', output: 'second' }];
  await f.collect(request(thirdInput), opts(3));
  assert.deepEqual(f.sent[2].body.input.map(item => item.call_id), ['call_1', 'call_2']);
  await f.collect(request(thirdInput, { instructions: 'full-reset' }), opts(4));
  await f.collect(request([...thirdInput, call('fc_4'), { type: 'function_call_output', call_id: 'fc_1', output: 'after-full' }],
    { instructions: 'full-reset' }), opts(5));
  assert.equal(f.sent[4].body.input[0].call_id, 'fc_1');
});

test('missing or colliding tool-call ID sidecars cannot authorize continuation', async t => {
  const call = { type: 'function_call', name: 'tool', call_id: 'fc_x', arguments: '{}' };
  for (const getContinuationCallIds of [undefined, () => new Map([['fc_x', 'call_x'], ['fc_y', 'call_x']])]) {
    const f = fixture(t, socket => frame(socket, completed('resp_x', [call])));
    await f.collect(request(), mapping({ getContinuationCallIds }));
    assert.equal(f.transport.snapshot().continuationSessions, 0); assert.equal(f.sockets[0].readyState, 3);
  }
});

test('different identity invalidates previous socket and response ID; missing keys disable reuse', async t => {
  const f = fixture(t); await f.collect();
  await f.collect(request([user('hello'), user('next')]), mapping({ identityKey: 'refreshed-token-identity' }));
  assert.equal(f.sockets.length, 2); assert.equal(f.sockets[0].readyState, 3); assert.equal(f.sent[1].body.previous_response_id, undefined);
  for (const extra of [{ sessionKey: undefined }, { identityKey: undefined }]) {
    await f.collect(request(), mapping(extra)); await f.collect(request(), mapping(extra));
    assert.equal(f.sockets.at(-1).readyState, 3); assert.equal(f.sent.at(-1).body.previous_response_id, undefined);
  }
});

test('same-session concurrent requests serialize and never multiplex', async t => {
  const f = fixture(t, () => {});
  const first = f.collect(); await tick();
  const second = f.collect(request([user('hello'), user('next')])); await tick();
  assert.equal(f.sockets.length, 1); assert.equal(f.sent.length, 1); assert.equal(f.transport.snapshot().queuedRequests, 1);
  frame(f.sockets[0], completed('resp_1')); await first; await tick();
  assert.equal(f.sent.length, 2); assert.equal(f.sent[1].body.previous_response_id, 'resp_1');
  frame(f.sockets[0], completed('resp_2')); await second;
});

test('queued changed identity cannot interrupt active work, then gets a fresh full connection', async t => {
  const f = fixture(t, () => {});
  const first = f.collect(); await tick();
  const second = f.collect(request(), mapping({ identityKey: 'new-identity' })); await tick();
  assert.equal(f.sockets[0].readyState, 1); frame(f.sockets[0], completed()); await first; await tick();
  assert.equal(f.sockets.length, 2); assert.equal(f.sockets[0].readyState, 3);
  assert.equal(f.sent[1].body.previous_response_id, undefined); frame(f.sockets[1], completed()); await second;
});

test('previous_response_not_found and connection limit retry once fresh/full before public output', async t => {
  for (const code of ['previous_response_not_found', 'websocket_connection_limit_reached']) {
    let dispatches = 0;
    const f = fixture(t, (socket, body, count) => {
      if (count === 2) failureFrame(socket, code);
      else frame(socket, completed(`resp_${count}`));
    });
    await f.collect();
    await f.collect(request([user('hello'), user('next')]), mapping({ onDispatch: () => { dispatches++; throw Error('ignored observer'); } }));
    assert.equal(f.sockets.length, 2); assert.equal(f.sockets[0].readyState, 3);
    assert.equal(f.sent[1].body.previous_response_id, 'resp_1'); assert.equal(f.sent[2].body.previous_response_id, undefined);
    assert.deepEqual(f.sent[2].body.input, [user('hello'), user('next')]); assert.equal(dispatches, 2);
    assert.equal(f.transport.snapshot().reconnectRetries, 1);
  }
});

test('special retry is bounded and second failure is surfaced without HTTP', async t => {
  let fallback = 0;
  const f = fixture(t, socket => failureFrame(socket, 'previous_response_not_found'));
  await assert.rejects(f.collect(request(), mapping({ httpFallback: async function* () { fallback++; } })), { code: 'previous_response_not_found' });
  assert.equal(f.sockets.length, 2); assert.equal(fallback, 0);
});

test('no retry or fallback after any mapped public chunk including usage', async t => {
  for (const code of ['previous_response_not_found', 'websocket_connection_limit_reached']) {
    let fallback = 0;
    const f = fixture(t, socket => {
      frame(socket, { type: 'response.output_text.delta', delta: 'partial' });
      setImmediate(() => failureFrame(socket, code));
    });
    const seen = [];
    await assert.rejects(async () => {
      for await (const chunk of f.transport.stream(request(), mapping({ httpFallback: async function* () { fallback++; } }))) seen.push(chunk);
    }, { code });
    assert.equal(seen.length, 1); assert.equal(f.sockets.length, 1); assert.equal(fallback, 0); assert.equal(f.sockets[0].readyState, 3);
  }
  const f = fixture(t, socket => socket.terminate()); let fallback = 0;
  await assert.rejects(f.collect(request(), mapping({
    async *mapResponse(frames) { yield { type: 'usage' }; for await (const frame of frames) yield frame; },
    httpFallback: async function* () { fallback++; },
  })));
  assert.equal(fallback, 0);
});

test('transport incompatibility falls back once and remembers HTTP only for matching session identity', async t => {
  let http = 0;
  const f = fixture(t, socket => socket.emit('error', Error('PRIVATE network payload')));
  const options = extra => mapping({ httpFallback: async function* () { http++; yield { type: 'finish' }; }, ...extra });
  await f.collect(request(), options()); await f.collect(request(), options());
  assert.equal(f.sockets.length, 1); assert.equal(http, 2); assert.equal(f.transport.snapshot().httpFallbackSessions, 1);
  await f.collect(request(), options({ identityKey: 'rotated' })); assert.equal(f.sockets.length, 2);
  assert.equal(f.transport.snapshot().httpFallbacks, 2);
});

test('HTTP handshake auth/quota/semantic failures surface safe status and bounded retry metadata', async t => {
  for (const status of [400, 401, 403, 429]) {
    let fallback = 0, received, rejectedResponse;
    const f = fixture(t, undefined, { connect: socket => {
      const response = rejectedResponse = new EventEmitter(); Object.assign(response, { statusCode: status,
        statusMessage: 'PRIVATE-FIXTURE-STATUS', headers: { 'retry-after': '12', 'set-cookie': 'PRIVATE-FIXTURE-COOKIE' }, resume() {}, destroy() {} });
      socket.emit('unexpected-response', {}, response);
    }, upstreamError: (response, body) => { received = { response, body }; return { providerRetryAfterMs: 12_000 }; } });
    await assert.rejects(f.collect(request(), mapping({ httpFallback: async function* () { fallback++; } })), err => {
      assert.equal(err.status, status); assert.equal(err.providerRetryAfterMs, 12_000);
      assert.equal(err.message.includes('PRIVATE'), false); return true;
    });
    assert.equal(fallback, 0); assert.equal(received.body.includes('PRIVATE'), false);
    assert.equal(received.response.headers.get('set-cookie'), null);
    await tick(); assert.deepEqual(rejectedResponse.eventNames(), []);
  }
});

test('semantic framed errors and server cancellation never disappear behind fallback', async t => {
  for (const [code, status] of [['invalid_request_error', 400], ['invalid_token', 401], ['permission_denied', 403], ['usage_limit_reached', 429]]) {
    let fallback = 0;
    const f = fixture(t, socket => failureFrame(socket, code, status));
    await assert.rejects(f.collect(request(), mapping({ httpFallback: async function* () { fallback++; } })), err => {
      assert.equal(err.status, status); assert.equal(err.code, code); assert.equal(err.message.includes('PRIVATE'), false); return true;
    });
    assert.equal(fallback, 0);
  }
  const f = fixture(t, socket => frame(socket, { type: 'response.cancelled', response: { error: { code: 'previous_response_not_found' } } }));
  await assert.rejects(f.collect(), { code: 'CODEX_WS_CANCELLED' }); assert.equal(f.sockets.length, 1);
});

test('401/403/429 dominate special retry codes', async t => {
  for (const status of [401, 403, 429]) {
    const f = fixture(t, socket => failureFrame(socket, 'previous_response_not_found', status));
    await assert.rejects(f.collect(), { status }); assert.equal(f.sockets.length, 1);
  }
});

test('handshake unsupported upgrades safely fall back without following redirects', async t => {
  for (const status of [404, 405, 426, 501]) {
    let http = 0;
    const f = fixture(t, undefined, { connect: socket => socket.emit('unexpected-response', {}, {
      statusCode: status, headers: {}, resume() {}, destroy() {},
    }) });
    await f.collect(request(), mapping({ httpFallback: async function* () { http++; yield { type: 'finish' }; } }));
    assert.equal(http, 1); assert.equal(f.sockets[0].options.followRedirects, false);
  }
});

test('aborted before connect or during output never falls back', async t => {
  const f = fixture(t, () => {}); const controller = new AbortController(); let http = 0;
  controller.abort();
  await assert.rejects(f.collect(request(), mapping({ signal: controller.signal })), { name: 'AbortError' });
  assert.equal(f.sockets.length, 0);
  const active = new AbortController();
  const pending = f.collect(request(), mapping({ signal: active.signal, httpFallback: async function* () { http++; } }));
  await tick(); active.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(http, 0); assert.equal(f.sockets[0].readyState, 3);
});

test('iterator return interrupts outstanding next immediately without waiting for timeout', async t => {
  const f = fixture(t, () => {});
  const stream = f.transport.stream(request(), mapping()); const next = stream.next(); await tick();
  const rejected = assert.rejects(next, { code: 'CODEX_WS_CANCELLED' });
  await stream.return(); await rejected;
  assert.equal(f.transport.snapshot().activeRequests, 0); assert.equal(f.sockets[0].readyState, 3);
});

test('consumer return after finish but before exhaustion does not commit continuation', async t => {
  const f = fixture(t);
  const stream = f.transport.stream(request(), mapping());
  assert.equal((await stream.next()).value.type, 'finish');
  assert.equal(f.transport.snapshot().continuationSessions, 0);
  await stream.return(); assert.equal(f.sockets[0].readyState, 3);
  await f.collect(); assert.equal(f.sockets.length, 2);
});

test('mapper validation errors, absent sidecar, invalid terminal and missing ID cannot commit', async t => {
  const f = fixture(t);
  await assert.rejects(f.collect(request(), mapping({ async *mapResponse(frames) {
    for await (const _frame of frames) throw Object.assign(Error('mapper rejected'), { code: 'MAPPER_REJECTED' });
  } })), { code: 'MAPPER_REJECTED' });
  assert.equal(f.sockets[0].readyState, 3);
  await f.collect(request(), mapping({ getContinuationOutput: () => undefined })); assert.equal(f.sockets[1].readyState, 3);
  const noId = fixture(t, socket => frame(socket, { type: 'response.completed', response: { status: 'completed', output: [] } }));
  await noId.collect(); assert.equal(noId.transport.snapshot().continuationSessions, 0); assert.equal(noId.sockets[0].readyState, 3);
  const invalid = fixture(t, socket => frame(socket, { type: 'response.done', response: { id: 'bad', status: 'in_progress' } }));
  await assert.rejects(invalid.collect(), { code: 'CODEX_WS_INVALID_TERMINAL' });
  const fake = fixture(t, () => {});
  await assert.rejects(fake.collect(request(), mapping({ async *mapResponse() { yield { type: 'finish' }; } })), { code: 'CODEX_WS_MAPPED_STREAM_TRUNCATED' });
});

test('dispose cancels active and queued requests, closes idle sockets and is idempotent', async t => {
  const f = fixture(t, () => {});
  const first = f.collect(); await tick(); const second = f.collect(); await tick();
  const rejects = [assert.rejects(first, { code: 'CODEX_WS_DISPOSED' }), assert.rejects(second, { code: 'CODEX_WS_DISPOSED' })];
  f.transport.dispose(); f.transport.dispose(); await Promise.all(rejects);
  assert.equal(f.transport.snapshot().sessions, 0); assert.equal(f.transport.snapshot().activeRequests, 0);
  await assert.rejects(f.collect(), { code: 'CODEX_WS_DISPOSED' });
});

test('dispose propagates cancellation to HTTP fallback I/O', async t => {
  const f = fixture(t, socket => socket.emit('error', Error('synthetic unsupported')));
  let fallbackSignal;
  const pending = f.collect(request(), mapping({ httpFallback: async function* ({ signal }) {
    fallbackSignal = signal;
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } }));
  await tick(); assert.ok(fallbackSignal);
  const rejected = assert.rejects(pending, { code: 'CODEX_WS_DISPOSED' }); f.transport.dispose(); await rejected;
  assert.equal(fallbackSignal.aborted, true);
});

test('invalidate cancels a session and removes fallback memory', async t => {
  const f = fixture(t, () => {}); const active = f.collect(); await tick(); const queued = f.collect(); await tick();
  const rejects = [assert.rejects(active, { code: 'CODEX_WS_INVALIDATED' }), assert.rejects(queued, { code: 'CODEX_WS_INVALIDATED' })];
  f.transport.invalidate('session-hash'); await Promise.all(rejects);
  assert.equal(f.transport.snapshot().sessions, 0); assert.equal(f.sockets[0].readyState, 3);
});

test('queued abort removes only waiter and leaves active response usable', async t => {
  const f = fixture(t, () => {}); const active = f.collect(); await tick();
  const controller = new AbortController(); const queued = f.collect(request(), mapping({ signal: controller.signal })); await tick();
  const rejected = assert.rejects(queued, { name: 'AbortError' }); controller.abort(); await rejected;
  assert.equal(f.transport.snapshot().queuedRequests, 0); assert.equal(f.sockets[0].readyState, 1);
  frame(f.sockets[0], completed()); await active; assert.equal(f.transport.snapshot().continuationSessions, 1);
});

test('session idle pruning and LRU enforce bounded residency without touching busy sessions', async t => {
  let clock = 100;
  const f = fixture(t, undefined, { now: () => clock, sessionIdleMs: 20, maxSessions: 2 });
  await f.collect(); clock += 1;
  await f.collect(request(), mapping({ sessionKey: 'second' })); clock += 1;
  await f.collect(request(), mapping({ sessionKey: 'third' }));
  assert.equal(f.sockets[0].readyState, 3); assert.equal(f.transport.snapshot().sessions, 2);
  clock += 21; assert.equal(f.transport.snapshot().sessions, 0); assert.equal(f.sockets[2].readyState, 3);
});

test('session and waiting request limits fail safely without unbounded sockets/jobs', async t => {
  const f = fixture(t, () => {}, { maxSessions: 1, maxPendingRequests: 2 });
  const first = f.collect(); await tick();
  await assert.rejects(f.collect(request(), mapping({ sessionKey: 'another' })), { code: 'CODEX_WS_CAPACITY' });
  const second = f.collect(); await tick();
  await assert.rejects(f.collect(), { code: 'CODEX_WS_CAPACITY' });
  const rejects = [assert.rejects(first), assert.rejects(second)]; f.transport.dispose(); await Promise.all(rejects);
  assert.equal(f.sockets.length, 1);
});

test('connect/idle timeout, close and send failure are bounded safe pre-output failures', async t => {
  for (const settings of [{ connect: () => {}, connectTimeoutMs: 10 }, { idleTimeoutMs: 10 }, { sendFailure: true }]) {
    const f = fixture(t, () => {}, settings); let fallback = 0;
    await f.collect(request(), mapping({ httpFallback: async function* () { fallback++; yield { type: 'finish' }; } }));
    assert.equal(fallback, 1); assert.equal(f.sockets[0].readyState, 3);
  }
  const f = fixture(t, socket => socket.terminate());
  await assert.rejects(f.collect(), { code: 'CODEX_WS_STREAM_TRUNCATED' });
});

test('buffer frame/byte limits fail closed and release socket without fallback', async t => {
  for (const settings of [{ maxBufferBytes: 64 }, { maxBufferedFrames: 2 }]) {
    let fallback = 0;
    const f = fixture(t, socket => {
      for (let index = 0; index < 5; index++) frame(socket, { type: 'response.created', padding: 'x'.repeat(30) });
    }, settings);
    await assert.rejects(f.collect(request(), mapping({ httpFallback: async function* () { fallback++; } })), { code: 'CODEX_WS_BUFFER_LIMIT' });
    assert.equal(fallback, 0); assert.equal(f.sockets[0].readyState, 3); assert.equal(f.transport.snapshot().bufferedBytes, 0);
  }
});

test('malformed JSON and binary frames are incompatibility only before public output', async t => {
  for (const send of [socket => socket.emit('message', Buffer.from('not-json PRIVATE'), false),
    socket => socket.emit('message', Buffer.from([1, 2]), true)]) {
    let fallback = 0;
    const f = fixture(t, send);
    await f.collect(request(), mapping({ httpFallback: async function* () { fallback++; yield { type: 'finish' }; } }));
    assert.equal(fallback, 1);
  }
});

test('request/state bounds, URL validation and caller response IDs fail safely', async t => {
  const f = fixture(t, undefined, { maxRequestBytes: 30 });
  await assert.rejects(f.collect(), { code: 'CODEX_WS_REQUEST_LIMIT' }); assert.equal(f.sockets.length, 0);
  const state = fixture(t, undefined, { maxStateBytes: 1 }); await state.collect(); assert.equal(state.sockets[0].readyState, 3);
  for (const url of ['http://fixture.invalid/backend-api/codex/responses', 'https://user:pass@fixture.invalid/backend-api/codex/responses',
    'https://fixture.invalid/backend-api/codex/responses?secret=yes', 'https://fixture.invalid/v1/responses']) {
    const invalid = fixture(t); const req = request(); req.url = url;
    await assert.rejects(invalid.collect(req), { code: 'CODEX_WS_INVALID_URL' }); assert.equal(invalid.sockets.length, 0);
  }
  const safe = fixture(t); await safe.collect(request(undefined, { previous_response_id: 'untrusted-id', type: 'response.delete' }));
  assert.equal(safe.sent[0].body.previous_response_id, undefined); assert.equal(safe.sent[0].body.type, 'response.create');
});

test('real loopback ws server verifies handshake, incremental reuse, output and listener cleanup', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const accepted = [], sent = [];
  server.on('connection', (socket, req) => {
    accepted.push({ socket, req });
    socket.on('message', data => {
      sent.push(JSON.parse(data.toString()));
      socket.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'loopback' }));
      socket.send(JSON.stringify(completed(`resp_local_${sent.length}`, [assistant('loopback')])));
    });
  });
  const transport = createCodexWebSocketTransport({ allowInsecureLocalhost: true, connectTimeoutMs: 1000, idleTimeoutMs: 1000 });
  t.after(async () => {
    transport.dispose(); for (const { socket } of accepted) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  const first = request(); first.url = `http://127.0.0.1:${server.address().port}/backend-api/codex/responses`;
  const chunks = await Array.fromAsync(transport.stream(first, mapping()));
  const second = request([user('hello'), assistant('loopback'), user('next')]); second.url = first.url;
  await Array.fromAsync(transport.stream(second, mapping()));
  assert.equal(accepted.length, 1); assert.equal(sent[1].previous_response_id, 'resp_local_1'); assert.deepEqual(sent[1].input, [user('next')]);
  assert.equal(chunks[0].text, 'loopback'); assert.equal(accepted[0].req.url, '/backend-api/codex/responses');
  assert.equal(accepted[0].req.headers['openai-beta'], 'responses_websockets=2026-02-06');
  assert.equal(accepted[0].req.headers.authorization, 'Bearer FIXTURE-NOT-REAL'); assert.equal(accepted[0].req.headers.accept, undefined);
});

test('real loopback upgrade rejection preserves auth failure, never follows redirect or leaks response text', async t => {
  const server = createServer(); let upgrades = 0;
  server.on('upgrade', (_req, socket) => {
    upgrades++; socket.end('HTTP/1.1 403 PRIVATE-FIXTURE-STATUS\r\nContent-Length: 12\r\nConnection: close\r\n\r\nPRIVATE-BODY');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const transport = createCodexWebSocketTransport({ allowInsecureLocalhost: true });
  t.after(async () => { transport.dispose(); await new Promise(resolve => server.close(resolve)); });
  const req = request(); req.url = `http://127.0.0.1:${server.address().port}/backend-api/codex/responses`;
  let fallback = 0;
  await assert.rejects(Array.fromAsync(transport.stream(req, mapping({ httpFallback: async function* () { fallback++; } }))), err => {
    assert.equal(err.status, 403); assert.equal(err.message.includes('PRIVATE'), false); return true;
  });
  assert.equal(upgrades, 1); assert.equal(fallback, 0);
});
