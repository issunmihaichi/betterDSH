/**
 * Upstream transport tests.
 *
 * The fake fetch returns REAL `Response` objects built from hand-written SSE
 * bodies, so the code under test exercises genuine `ReadableStream` +
 * `TextDecoder` behaviour — only the socket is fake.
 *
 * The last block is the important one: transport → adapter → kernel, proving a
 * real HTTP 429 carrying a `retry-after` header drives a real failover and a
 * real cooldown window.
 *
 *   node tools/upstream-test.mjs
 */
import assert from 'node:assert/strict';

import {
  PoolCredentialError,
  PoolUnsupportedContentError,
  buildAnthropicRequest,
  buildOpenAIRequest,
  createHttpUpstream,
  mapAnthropic,
  mapOpenAI,
  parseSse,
  retryAfterMs,
  upstreamError,
} from '../lib/upstream.js';
import { createPoolAdapter } from '../lib/adapter.js';
import { makeAccount } from '../lib/domain.js';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

let checks = 0;
let passed = 0;
const failures = [];

async function check(label, fn) {
  checks += 1;
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failures.push({ label, error });
  }
}

function makeClock(start = T0) {
  return { t: start, now() { return this.t; }, advance(ms) { this.t += ms; } };
}

async function collect(iterable) {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

/** Feed a literal SSE string through parseSse without touching a socket. */
function sseFrom(text) {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } }).body;
}

function anthropicSse({ tool = false } = {}) {
  const lines = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":25,"cache_read_input_tokens":10,"cache_creation_input_tokens":2}}}',
    '',
  ];
  if (tool) {
    lines.push(
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"SF\\"}"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
    );
  } else {
    lines.push(
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
    );
  }
  lines.push(
    'event: message_delta',
    `data: {"type":"message_delta","delta":{"stop_reason":"${tool ? 'tool_use' : 'end_turn'}"},"usage":{"output_tokens":7}}`,
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  );
  return lines.join('\n');
}

function openaiSse({ tool = false } = {}) {
  if (tool) {
    return [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":""}}]}}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]}}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"SF\\"}"}}]}}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
  }
  return [
    'data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}',
    '',
    'data: {"choices":[{"index":0,"delta":{"content":"lo"}}]}',
    '',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":3}}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
}

// ------------------------------------------------- retry-after + error mapping

await check('retryAfterMs: seconds, HTTP-date, absent, and an absurd clamp', () => {
  const withHeader = (value) => new Headers(value === undefined ? {} : { 'retry-after': value });
  assert.equal(retryAfterMs(withHeader('30')), 30_000);
  assert.equal(retryAfterMs(withHeader('0')), 0);
  assert.equal(retryAfterMs(withHeader()), undefined);
  assert.equal(retryAfterMs(new Headers()), undefined);

  const future = new Date(Date.now() + 5000).toUTCString();
  const fromDate = retryAfterMs(withHeader(future));
  assert.ok(fromDate > 0 && fromDate <= 5000, `HTTP-date must convert, got ${String(fromDate)}`);

  assert.equal(retryAfterMs(withHeader('99999999')), 6 * 60 * 60 * 1000, 'a nonsense window must be clamped');
  assert.equal(retryAfterMs(withHeader('not-a-date')), undefined);
});

await check('upstreamError: carries status, a stable code, and the retry-after hint', () => {
  const response = new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
    status: 429,
    headers: { 'retry-after': '12' },
  });
  const error = upstreamError(response, JSON.stringify({ error: { message: 'rate limited' } }));

  assert.equal(error.status, 429);
  assert.equal(error.code, 'http-429');
  assert.equal(error.providerRetryAfterMs, 12_000);
  assert.match(error.message, /rate limited/);

  const plain = upstreamError(new Response('boom', { status: 503 }), 'boom');
  assert.equal(plain.status, 503);
  assert.equal(plain.providerRetryAfterMs, undefined);
  assert.match(plain.message, /boom/);
});

// ------------------------------------------------- SSE parsing

await check('parseSse: splits events, tolerates CRLF and a missing final blank line', async () => {
  const crlf = 'data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n';
  assert.deepEqual(await collect(parseSse(sseFrom(crlf))), ['{"a":1}', '{"b":2}']);

  // No trailing blank line — some proxies close the stream this way.
  assert.deepEqual(await collect(parseSse(sseFrom('data: {"a":1}\n\ndata: {"b":2}'))), ['{"a":1}', '{"b":2}']);

  // `event:` lines are ignored; comment lines are not data.
  assert.deepEqual(await collect(parseSse(sseFrom('event: x\n: keepalive\ndata: {"a":1}\n\n'))), ['{"a":1}']);

  // Multi-line data joins with a newline, per the SSE spec.
  assert.deepEqual(await collect(parseSse(sseFrom('data: one\ndata: two\n\n'))), ['one\ntwo']);

  // A body-less response yields nothing rather than throwing.
  assert.deepEqual(await collect(parseSse(new Response(null, { status: 204 }).body)), []);
});

// ------------------------------------------------- request building

await check('anthropic request: URL, auth headers, and body shape', () => {
  const account = makeAccount({ id: 'a1', platform: 'anthropic', baseUrl: 'https://api.anthropic.com/' });
  const { url, init } = buildAnthropicRequest(account, {
    model: 'claude-opus-4',
    system: 'be brief',
    maxTokens: 100,
    temperature: 0.2,
    stop: ['STOP'],
    tools: [{ name: 'get_weather', description: 'w', parameters: { type: 'object' } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 't1', name: 'get_weather', arguments: '{"city":"SF"}' }] },
      { role: 'tool', toolCallId: 't1', content: [{ type: 'text', text: 'sunny' }] },
    ],
  }, 'sk-test', 4096);

  assert.equal(url, 'https://api.anthropic.com/v1/messages', 'a trailing slash on baseUrl must not double up');
  assert.equal(init.headers['x-api-key'], 'sk-test');
  assert.equal(init.headers['anthropic-version'], '2023-06-01');

  const body = JSON.parse(init.body);
  assert.equal(body.model, 'claude-opus-4');
  assert.equal(body.system, 'be brief');
  assert.equal(body.max_tokens, 100);
  assert.equal(body.stream, true);
  assert.deepEqual(body.stop_sequences, ['STOP']);
  assert.equal(body.tools[0].input_schema.type, 'object');
  assert.deepEqual(body.messages[0], { role: 'user', content: [{ type: 'text', text: 'hi' }] });
  assert.deepEqual(body.messages[1].content[0], { type: 'tool_use', id: 't1', name: 'get_weather', input: { city: 'SF' } });
  assert.deepEqual(body.messages[2].content[0], { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'sunny' }] });
});

await check('openai request: bearer auth, tool_calls, and stream_options', () => {
  const account = makeAccount({ id: 'a1', platform: 'openai', baseUrl: 'https://api.openai.com' });
  const { url, init } = buildOpenAIRequest(account, {
    model: 'gpt-5',
    system: 'be brief',
    messages: [
      { role: 'assistant', content: [{ type: 'tool-call', id: 't1', name: 'f', arguments: '{"a":1}' }] },
      { role: 'tool', toolCallId: 't1', content: [{ type: 'text', text: 'ok' }] },
    ],
  }, 'sk-test', 4096);

  assert.equal(url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(init.headers.authorization, 'Bearer sk-test');

  const body = JSON.parse(init.body);
  assert.deepEqual(body.messages[0], { role: 'system', content: 'be brief' });
  assert.equal(body.messages[1].tool_calls[0].function.arguments, '{"a":1}');
  assert.deepEqual(body.messages[2], { role: 'tool', tool_call_id: 't1', content: 'ok' });
  assert.deepEqual(body.stream_options, { include_usage: true }, 'without this OpenAI omits usage entirely');
  assert.equal(body.max_tokens, 4096, 'the default applies when the request omits maxTokens');
});

await check('request building: unsupported content fails loud instead of dropping data', () => {
  const account = makeAccount({ id: 'a1', platform: 'anthropic' });
  const options = { model: 'm', messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'x' } }] }] };

  assert.throws(() => buildAnthropicRequest(account, options, 'k', 4096), PoolUnsupportedContentError);
  assert.throws(() => buildOpenAIRequest(account, options, 'k', 4096), PoolUnsupportedContentError);

  // History markers and reasoning are skipped, not fatal: they carry no content.
  const benign = {
    model: 'm',
    messages: [{ role: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'answer' }] }],
  };
  assert.equal(JSON.parse(buildAnthropicRequest(account, benign, 'k', 10).init.body).messages[0].content.length, 1);
});

// ------------------------------------------------- response mapping

await check('mapAnthropic: text stream yields real blocks, usage and a finish reason', async () => {
  const chunks = await collect(mapAnthropic(parseSse(sseFrom(anthropicSse()))));

  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'text' });
  assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'Hello');

  const end = chunks.find((c) => c.type === 'block-end');
  assert.deepEqual(end.block, { type: 'text', text: 'Hello' }, 'block-end must carry real content, not a placeholder');

  const usage = chunks.find((c) => c.type === 'usage').usage;
  assert.equal(usage.inputTokens, 25);
  assert.equal(usage.cacheReadTokens, 10);
  assert.equal(usage.cacheWriteTokens, 2);
  assert.equal(usage.outputTokens, 7);

  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } });
});

await check('mapAnthropic: a tool_use block accumulates arguments and finishes as tool-calls', async () => {
  const chunks = await collect(mapAnthropic(parseSse(sseFrom(anthropicSse({ tool: true })))));

  assert.equal(chunks[0].blockType, 'tool-call');
  assert.equal(chunks.filter((c) => c.type === 'tool-call-delta').map((c) => c.argumentsDelta).join(''), '{"city":"SF"}');
  assert.deepEqual(chunks.find((c) => c.type === 'block-end').block, {
    type: 'tool-call', id: 'toolu_1', name: 'get_weather', arguments: '{"city":"SF"}',
  });
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' });
});

await check('mapOpenAI: text, tool calls, usage and finish reasons', async () => {
  const text = await collect(mapOpenAI(parseSse(sseFrom(openaiSse()))));
  assert.equal(text.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'Hello');
  assert.deepEqual(text.find((c) => c.type === 'block-end').block, { type: 'text', text: 'Hello' });
  const usage = text.find((c) => c.type === 'usage').usage;
  assert.equal(usage.inputTokens, 11);
  assert.equal(usage.outputTokens, 4);
  assert.equal(usage.cacheReadTokens, 3);
  assert.deepEqual(text.at(-1).reason, { kind: 'stop' });

  const tool = await collect(mapOpenAI(parseSse(sseFrom(openaiSse({ tool: true })))));
  const block = tool.find((c) => c.type === 'block-end').block;
  assert.equal(block.type, 'tool-call');
  assert.equal(block.arguments, '{"city":"SF"}');
  assert.equal(block.id, 'call_1');
  assert.deepEqual(tool.at(-1).reason, { kind: 'tool-calls' });
  assert.equal(tool.some((c) => c.type === 'usage'), false, 'no usage chunk when the upstream sends none');
});

// ------------------------------------------------- transport

await check('transport: a missing credential is not an account fault', async () => {
  const upstream = createHttpUpstream({ fetchImpl: async () => { throw new Error('must not be called'); } });
  await assert.rejects(
    () => collect(upstream.stream(makeAccount({ id: 'a1', platform: 'anthropic' }), { model: 'm' })),
    (error) => error instanceof PoolCredentialError && error.code === 'POOL_NO_CREDENTIAL',
  );
});

await check('transport: a non-2xx response becomes a classified error', async () => {
  const upstream = createHttpUpstream({
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'overloaded' } }), {
      status: 529,
      headers: { 'retry-after': '5' },
    }),
    resolveCredential: () => 'sk-test',
  });

  await assert.rejects(
    () => collect(upstream.stream(makeAccount({ id: 'a1', platform: 'anthropic' }), { model: 'm' })),
    (error) => error.status === 529 && error.providerRetryAfterMs === 5000,
  );
});

await check('transport: a 200 SSE response streams mapped chunks', async () => {
  const calls = [];
  const upstream = createHttpUpstream({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(anthropicSse(), { status: 200 });
    },
    resolveCredential: () => 'sk-test',
  });

  const chunks = await collect(upstream.stream(makeAccount({ id: 'a1', platform: 'anthropic' }), { model: 'claude-opus-4' }));
  assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'Hello');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages', 'the platform default applies when baseUrl is null');
});

// ------------------------------------------------- the whole stack

await check('stack: a real 429 with retry-after drives a real failover and cooldown window', async () => {
  const clock = makeClock();
  const calls = [];

  const fetchImpl = async (url, init) => {
    const key = init.headers['x-api-key'];
    calls.push(key);
    if (key === 'key-a1') {
      return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
        status: 429,
        headers: { 'retry-after': '30' },
      });
    }
    return new Response(anthropicSse(), { status: 200 });
  };

  const adapter = createPoolAdapter({
    initialAccounts: [
      makeAccount({ id: 'a1', platform: 'anthropic', credentialRef: 'key-a1' }),
      makeAccount({ id: 'a2', platform: 'anthropic', credentialRef: 'key-a2' }),
    ],
    upstream: createHttpUpstream({ fetchImpl, resolveCredential: (account) => account.credentialRef }),
    clock,
  });

  const chunks = await collect(adapter.stream({ sessionId: 's1', model: 'claude-opus-4' }));

  assert.deepEqual(calls, ['key-a1', 'key-a2'], 'exactly one failover, in selection order');
  assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'Hello');

  const cooled = adapter.getAccount('a1');
  assert.equal(cooled.rateLimitResetAt, iso(T0 + 30_000), 'the upstream retry-after must set the window, not the default');
  assert.equal(cooled.tempUnschedulableReason, 'rate-limit');
  assert.equal(adapter.getBinding('s1').accountId, 'a2');

  // And the same session now sticks to a2 without touching a1 again.
  clock.advance(1000);
  calls.length = 0;
  await collect(adapter.stream({ sessionId: 's1', model: 'claude-opus-4' }));
  assert.deepEqual(calls, ['key-a2']);
});

await check('stack: a 400 from the transport never cools an account', async () => {
  const clock = makeClock();
  const adapter = createPoolAdapter({
    initialAccounts: [
      makeAccount({ id: 'a1', platform: 'openai', credentialRef: 'key-a1' }),
      makeAccount({ id: 'a2', platform: 'openai', credentialRef: 'key-a2' }),
    ],
    upstream: createHttpUpstream({
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400 }),
      resolveCredential: (account) => account.credentialRef,
    }),
    clock,
  });

  const before = adapter.getAccount('a1');
  await assert.rejects(
    () => collect(adapter.stream({ sessionId: 's1', model: 'gpt-5' })),
    (error) => error.status === 400,
  );
  assert.equal(adapter.getAccount('a1'), before, 'a malformed request must not touch pool state');
});

await check('stack: the transport advances the session across a mid-stream account switch', async () => {
  const clock = makeClock();
  let served = 0;
  const adapter = createPoolAdapter({
    initialAccounts: [
      makeAccount({ id: 'a1', platform: 'anthropic', credentialRef: 'k1' }),
      makeAccount({ id: 'a2', platform: 'anthropic', credentialRef: 'k2' }),
    ],
    upstream: createHttpUpstream({
      fetchImpl: async () => {
        served += 1;
        return new Response(served === 1 ? anthropicSse({ tool: true }) : anthropicSse(), { status: 200 });
      },
      resolveCredential: (account) => account.credentialRef,
    }),
    clock,
  });

  const first = await collect(adapter.stream({ sessionId: 's1', model: 'claude-opus-4' }));
  assert.deepEqual(first.at(-1).reason, { kind: 'tool-calls' });
  assert.equal(adapter.getAccount('a1').consecutiveFailures, 0, 'a tool-call turn is a SUCCESS, not a failure');

  const second = await collect(adapter.stream({ sessionId: 's1', model: 'claude-opus-4' }));
  assert.deepEqual(second.at(-1).reason, { kind: 'stop' });
  assert.equal(served, 2);
});

await check('stack: a missing credential neither cools an account nor burns the pool', async () => {
  const clock = makeClock();
  const adapter = createPoolAdapter({
    // Neither account has a credentialRef, so both would fail identically.
    initialAccounts: [
      makeAccount({ id: 'a1', platform: 'anthropic' }),
      makeAccount({ id: 'a2', platform: 'anthropic' }),
    ],
    upstream: createHttpUpstream({ fetchImpl: async () => { throw new Error('the network must not be reached'); } }),
    clock,
  });

  const beforeA1 = adapter.getAccount('a1');
  const beforeA2 = adapter.getAccount('a2');

  await assert.rejects(
    () => collect(adapter.stream({ sessionId: 's1', model: 'claude-opus-4' })),
    (error) => error instanceof PoolCredentialError,
  );

  assert.equal(adapter.getAccount('a1'), beforeA1, 'a config error must not touch account state');
  assert.equal(adapter.getAccount('a2'), beforeA2, 'and must not be retried against the next account');
});

// ------------------------------------------------- report

if (failures.length > 0) {
  for (const { label, error } of failures) {
    console.error(`✗ ${label}\n    ${error.message.split('\n').join('\n    ')}`);
  }
  console.error(`\n${passed}/${checks} 通过，${failures.length} 失败`);
  process.exitCode = 1;
} else {
  console.log(`✓ ${passed}/${checks} 通过`);
}
