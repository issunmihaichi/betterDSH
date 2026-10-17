import test from 'node:test';
import assert from 'node:assert/strict';
import { createResponsesOutput } from '../lib/local-api-responses-output.js';
import { LocalApiError, publicError } from '../lib/local-api-protocol.js';
import { mapOpenAIResponses } from '../lib/native/openai-responses.js';
import { mapAnthropic, mapOpenAI } from '../lib/upstream.js';

const finish = kind => ({ type: 'finish', reason: { kind } });
const endText = (index, text, type = 'text', extras = {}) => ({ type: 'block-end', index, block: { type, text, ...extras } });
const endTool = (index, id, name, args, extras = {}) => ({ type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: args, ...extras } });
const protocolFailure = error => error instanceof LocalApiError && error.status === 502 && error.code === 'upstream_protocol_error' && !/secret/.test(error.message);
const terminals = events => events.filter(event => ['response.completed', 'response.incomplete', 'response.failed'].includes(event.type));
function sequenced(events) { assert.deepEqual(events.map(event => event.sequence_number), events.map((_, index) => index)); }
function run(chunks, options) {
  const output = createResponsesOutput('test-model', options), events = output.start();
  for (const chunk of chunks) events.push(...output.consume(chunk));
  const result = output.complete(); events.push(...result.events);
  sequenced(events);
  return { response: result.response, events, output };
}

// Small independent reducer checks that JSON and SSE agree, including the shape
// consumed by openai-node's Responses stream accumulator (not Chat Completions).
function reduce(events) {
  let response;
  const output = [];
  for (const event of events) {
    if (event.type === 'response.created') response = structuredClone(event.response);
    if (event.type === 'response.output_item.added') {
      assert.equal(event.output_index, output.length);
      output.push(structuredClone(event.item));
    }
    if (event.type === 'response.content_part.added') output[event.output_index].content[event.content_index] = structuredClone(event.part);
    if (event.type === 'response.output_text.delta') output[event.output_index].content[event.content_index].text += event.delta;
    if (event.type === 'response.reasoning_summary_part.added') output[event.output_index].summary[event.summary_index] = structuredClone(event.part);
    if (event.type === 'response.reasoning_summary_text.delta') output[event.output_index].summary[event.summary_index].text += event.delta;
    if (event.type === 'response.function_call_arguments.delta') output[event.output_index].arguments += event.delta;
    if (event.type === 'response.output_item.done') {
      const prior = output[event.output_index];
      assert.equal(prior.id, event.item.id);
      if (prior.type === 'function_call') assert.equal(prior.arguments, event.item.arguments);
      if (prior.type === 'message') assert.deepEqual(prior.content, event.item.content);
      if (prior.type === 'reasoning') assert.deepEqual(prior.summary, event.item.summary);
      output[event.output_index] = structuredClone(event.item);
    }
    if (['response.completed', 'response.incomplete'].includes(event.type)) {
      assert.deepEqual(output, event.response.output);
      response = structuredClone(event.response);
    }
    if (event.item_id !== undefined) assert.equal(output[event.output_index].id, event.item_id);
  }
  return response;
}

test('start is idempotent; text is live; finish is not terminal; JSON matches SSE', () => {
  const output = createResponsesOutput('model'), events = output.start();
  assert.deepEqual(events.map(event => event.type), ['response.created', 'response.in_progress']);
  assert.deepEqual(output.start(), []);
  assert.equal(events[0].response.status, 'in_progress'); assert.deepEqual(events[0].response.output, []);
  const first = output.consume({ type: 'text-delta', index: 50, text: 'Hello' });
  assert.deepEqual(first.map(event => event.type), ['response.output_item.added', 'response.content_part.added', 'response.output_text.delta']);
  assert.equal(first[2].delta, 'Hello'); assert.deepEqual(first[2].logprobs, []); events.push(...first);
  events.push(...output.consume(endText(50, 'Hello world')));
  assert.equal(events.at(-1).type, 'response.output_item.done');
  assert.deepEqual(output.consume(finish('stop')), []); assert.deepEqual(terminals(events), []);
  const result = output.complete(); events.push(...result.events);
  assert.deepEqual(result.events.map(event => event.type), ['response.completed']);
  const response = result.response;
  assert.match(response.id, /^resp_[a-f0-9]+$/); assert.equal(response.object, 'response'); assert.equal(response.status, 'completed');
  assert.equal(response.store, false); assert.equal(response.usage, null); assert.equal(response.error, null); assert.equal(response.incomplete_details, null);
  assert.deepEqual(response.output[0].content, [{ type: 'output_text', text: 'Hello world', annotations: [] }]);
  assert.equal(response.output[0].role, 'assistant'); assert.equal(response.output[0].status, 'completed');
  assert.deepEqual(reduce(events), response); sequenced(events);
  // Later mutations never retroactively change earlier event snapshots.
  assert.equal(first[0].item.content.length, 0); assert.equal(first[0].item.status, 'in_progress');
  assert.equal(first[1].part.text, ''); assert.deepEqual(events[0].response.output, []);
  assert.deepEqual(output.complete().events, []); assert.equal(output.complete().response.id, response.id);
});

test('JSON mode can omit start; empty response is legal only with a finish', () => {
  const output = createResponsesOutput('model');
  output.consume(finish('stop'));
  const result = output.complete();
  assert.deepEqual(result.response.output, []); assert.equal(result.events[0].sequence_number, 0);
  assert.equal(result.events[0].type, 'response.completed');
});

test('tool names are buffered until end; arguments and items have legal lifecycle/identity', () => {
  const output = createResponsesOutput('model'), events = output.start();
  assert.deepEqual(output.consume({ type: 'block-start', index: 9, blockType: 'tool-call' }), []);
  assert.deepEqual(output.consume({ type: 'tool-call-delta', index: 9, id: 'call_original', argumentsDelta: '{"x":' }), []);
  assert.deepEqual(output.consume({ type: 'tool-call-delta', index: 9, id: 'call_original', argumentsDelta: '1' }), []);
  const toolEvents = output.consume(endTool(9, 'call_original', 'lookup', '{"x":1}'));
  assert.deepEqual(toolEvents.map(event => event.type), ['response.output_item.added', 'response.function_call_arguments.delta', 'response.function_call_arguments.done', 'response.output_item.done']);
  assert.equal(toolEvents[0].item.name, 'lookup'); assert.equal(toolEvents[0].item.arguments, '');
  assert.equal(toolEvents[0].item.call_id, 'call_original'); assert.match(toolEvents[0].item.id, /^fc_/);
  assert.notEqual(toolEvents[0].item.id, toolEvents[0].item.call_id);
  assert.equal(toolEvents[1].delta, '{"x":1}'); assert.equal(toolEvents[2].arguments, '{"x":1}');
  events.push(...toolEvents, ...output.consume(finish('tool-calls')));
  const result = output.complete(); events.push(...result.events);
  assert.deepEqual(result.response.output[0], toolEvents[3].item); assert.deepEqual(reduce(events), result.response); sequenced(events);
});

test('many repeated/interleaved text, reasoning and tool blocks keep stable indexes and order', () => {
  const chunks = [
    { type: 'block-start', index: 90, blockType: 'tool-call' },
    { type: 'block-start', index: 7, blockType: 'text' },
    { type: 'text-delta', index: 7, text: 'one' },
    { type: 'reasoning-delta', index: 3, text: 'summary' },
    endTool(90, 'call_a', 'a', '{}'),
    endText(7, 'one!'),
    endText(11, 'two'),
    endText(3, 'summary.', 'reasoning'),
    endTool(101, 'call_b', 'b', '{"q":"hi"}'), finish('tool-calls'),
  ];
  const { response, events } = run(chunks);
  assert.deepEqual(response.output.map(item => item.type), ['message', 'reasoning', 'function_call', 'message', 'function_call']);
  assert.deepEqual(events.filter(event => event.type === 'response.output_item.added').map(event => event.output_index), [0, 1, 2, 3, 4]);
  assert.equal(new Set(response.output.map(item => item.id)).size, 5);
  assert.ok(events.filter(event => event.content_index !== undefined).every(event => event.content_index === 0));
  assert.ok(events.filter(event => event.summary_index !== undefined).every(event => event.summary_index === 0));
  assert.deepEqual(reduce(events), response);
});

test('reasoning is exposed only through official public summary shapes', () => {
  const { response, events } = run([
    { type: 'block-start', index: 1, blockType: 'reasoning', replayState: 'secret-replay' },
    { type: 'reasoning-delta', index: 1, text: 'Public summary', signature: 'secret-signature' },
    endText(1, 'Public summary.', 'reasoning', { encrypted_content: 'secret-encrypted', replayState: 'secret-replay', accountId: 'secret-account' }),
    finish('stop'),
  ]);
  const item = response.output[0];
  assert.deepEqual(Object.keys(item).sort(), ['id', 'status', 'summary', 'type']);
  assert.deepEqual(item.summary, [{ type: 'summary_text', text: 'Public summary.' }]);
  assert.ok(events.some(event => event.type === 'response.reasoning_summary_text.delta'));
  assert.ok(events.some(event => event.type === 'response.reasoning_summary_text.done'));
  assert.ok(!events.some(event => event.type === 'response.output_text.delta'));
  assert.doesNotMatch(JSON.stringify({ response, events }), /secret|encrypted|replay|signature|accountId|reasoning_content/);
  assert.deepEqual(reduce(events), response);
});

test('usage folds disjoint input/cache buckets, output/reasoning, and late reports after finish', () => {
  const { response } = run([
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 8, cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: 4, account: 'secret' } },
    finish('stop'),
    { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 1, reasoningTokens: 1 } },
  ]);
  assert.deepEqual(response.usage, { input_tokens: 18, input_tokens_details: { cached_tokens: 4 }, output_tokens: 9,
    output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 27 });
});

test('absent/null/incomplete usage is null, valid zero counts remain known zeros', () => {
  for (const usageChunks of [[], [{ type: 'usage', usage: null }], [{ type: 'usage', usage: {} }], [{ type: 'usage', usage: { inputTokens: 3 } }]]) {
    assert.equal(run([...usageChunks, finish('stop')]).response.usage, null);
  }
  assert.deepEqual(run([{ type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }, finish('stop')]).response.usage,
    { input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0 });
});

test('token limit and filter finish become incomplete only after iterator completion', () => {
  for (const [kind, reason] of [['max-tokens', 'max_output_tokens'], ['content-filter', 'content_filter']]) {
    const output = createResponsesOutput('model'), events = output.start();
    events.push(...output.consume({ type: 'text-delta', index: 0, text: 'partial' }));
    assert.deepEqual(output.consume(finish(kind)), []); assert.deepEqual(terminals(events), []);
    const result = output.complete(); events.push(...result.events);
    assert.equal(result.response.status, 'incomplete'); assert.deepEqual(result.response.incomplete_details, { reason });
    assert.equal(result.response.output[0].status, 'incomplete'); assert.equal(events.at(-1).type, 'response.incomplete');
    assert.equal(terminals(events).length, 1); assert.deepEqual(reduce(events), result.response); sequenced(events);
  }
});

test('finish then throwing iterator cannot produce an early success terminal', async () => {
  const output = createResponsesOutput('model'), events = output.start();
  async function* upstream() {
    yield { type: 'text-delta', index: 0, text: 'partial' }; yield finish('stop');
    throw new Error('secret raw upstream account token');
  }
  try { for await (const chunk of upstream()) events.push(...output.consume(chunk)); output.complete(); assert.fail('must fail'); }
  catch (error) { events.push(output.failure(publicError(error).body)); }
  assert.deepEqual(terminals(events).map(event => event.type), ['response.failed']); sequenced(events);
  assert.doesNotMatch(JSON.stringify(events), /secret raw|account token/);
  assert.equal(events.at(-1).response.output[0].content[0].text, 'partial');
});

test('truncated streams and unclosed tools fail with sanitized LocalApiError 502', () => {
  const cases = [[], [{ type: 'text-delta', index: 0, text: 'partial' }],
    [{ type: 'block-start', index: 0, blockType: 'tool-call' }, finish('stop')],
    [{ type: 'tool-call-delta', index: 0, argumentsDelta: '{"x":' }, finish('max-tokens')],
    [finish('tool-calls')],
  ];
  for (const chunks of cases) {
    const output = createResponsesOutput('model'), events = output.start();
    for (const chunk of chunks) events.push(...output.consume(chunk));
    assert.throws(() => output.complete(), protocolFailure);
    events.push(output.failure(publicError(new Error('secret')).body));
    assert.deepEqual(terminals(events).map(event => event.type), ['response.failed']); sequenced(events);
  }
});

test('unknown or malformed chunks poison the collector; no later successful completion', () => {
  const cases = [null, [], {}, { type: 'private-event', token: 'secret' }, { type: 'block-start', index: 0, blockType: 'image' },
    { type: 'text-delta', index: -1, text: 'x' }, { type: 'text-delta', index: 0.1, text: 'x' },
    { type: 'text-delta', index: 0, text: {} }, { type: 'tool-call-delta', index: 0, argumentsDelta: 1 },
    { type: 'block-end', index: 0, block: null }, finish('error'), finish('unknown')];
  for (const chunk of cases) {
    const output = createResponsesOutput('model'); output.start();
    assert.throws(() => output.consume(chunk), protocolFailure);
    assert.throws(() => output.consume(finish('stop')), protocolFailure);
    assert.throws(() => output.complete(), protocolFailure);
    const event = output.failure(publicError(new Error('secret')).body);
    assert.equal(event.type, 'response.failed'); assert.doesNotMatch(JSON.stringify(event), /secret/);
  }
});

test('mismatched/duplicate blocks, call IDs, arguments and suffixes are rejected', () => {
  const cases = [
    [{ type: 'text-delta', index: 0, text: 'x' }, { type: 'reasoning-delta', index: 0, text: 'x' }],
    [endText(0, 'x'), { type: 'text-delta', index: 0, text: 'y' }],
    [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'block-start', index: 0, blockType: 'text' }],
    [{ type: 'text-delta', index: 0, text: 'x' }, endText(0, 'y')],
    [endTool(0, 'call', 'fn', '{}'), endTool(1, 'call', 'fn', '{}')],
    [{ type: 'tool-call-delta', index: 0, id: 'call_a' }, endTool(0, 'call_b', 'fn', '{}')],
    [{ type: 'tool-call-delta', index: 0, argumentsDelta: '{"a":' }, endTool(0, 'call', 'fn', '{"b":1}')],
    [endTool(0, 'call', 'invalid name', '{}')], [endTool(0, '', 'fn', '{}')],
    [endTool(0, 'call', 'fn', '{')], [endTool(0, 'call', 'fn', '[]')],
    [finish('stop'), { type: 'text-delta', index: 0, text: 'x' }], [finish('stop'), finish('stop')],
  ];
  for (const chunks of cases) {
    const output = createResponsesOutput('model');
    assert.throws(() => { for (const chunk of chunks) output.consume(chunk); }, protocolFailure);
    assert.throws(() => output.complete(), protocolFailure);
  }
});

test('invalid and overflowing usage counters are explicit protocol failures', () => {
  for (const value of [-1, 0.2, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const output = createResponsesOutput('model');
    assert.throws(() => output.consume({ type: 'usage', usage: { inputTokens: value } }), protocolFailure);
  }
  assert.throws(() => run([{ type: 'usage', usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 } }, finish('stop')]), protocolFailure);
  assert.throws(() => run([{ type: 'usage', usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 2 } }, finish('stop')]), protocolFailure);
});

test('failure retains published public text only and projects a real ResponseError', () => {
  const output = createResponsesOutput('model'), events = output.start();
  events.push(...output.consume({ type: 'text-delta', index: 0, text: 'public' }));
  output.consume({ type: 'tool-call-delta', index: 1, argumentsDelta: '{"not-yet-public":"secret"' });
  const failed = output.failure({ error: { code: 'pool_unavailable', message: 'The account pool is temporarily unavailable.', type: 'server_error',
    stack: 'secret stack', accountId: 'secret account', raw: 'secret raw', param: 'secret param' }, token: 'secret token' });
  events.push(failed); sequenced(events);
  assert.equal(failed.type, 'response.failed'); assert.equal(failed.response.status, 'failed'); assert.equal(failed.response.store, false);
  assert.deepEqual(failed.response.error, { code: 'server_error', message: 'The account pool is temporarily unavailable.' });
  assert.equal(failed.response.output.length, 1); assert.equal(failed.response.output[0].status, 'incomplete');
  assert.equal(failed.response.output[0].content[0].text, 'public'); assert.doesNotMatch(JSON.stringify(events), /secret|raw|stack|token|accountId/);
  assert.throws(() => output.complete(), protocolFailure);
});

test('raw Error is not a safeErrorBody and never leaks its message', () => {
  const output = createResponsesOutput('model');
  const event = output.failure(new Error('secret Bearer abc'));
  assert.deepEqual(event.response.error, { code: 'server_error', message: 'The upstream request failed.' });
  assert.doesNotMatch(JSON.stringify(event), /secret|Bearer|abc/);
});

test('failed malformed usage still permits a sanitized failure event', () => {
  const output = createResponsesOutput('model'); output.start();
  output.consume({ type: 'usage', usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 2 } });
  output.consume(finish('stop')); assert.throws(() => output.complete(), protocolFailure);
  const failed = output.failure(publicError(new Error('secret')).body);
  assert.equal(failed.response.usage, null); assert.equal(failed.type, 'response.failed');
});

test('all private native block/chunk/finish metadata is stripped, including replay and signatures', () => {
  const secret = { accountId: 'secret-account', credential: 'secret-key', replayState: { token: 'secret-replay' },
    encrypted_content: 'secret-encrypted', thoughtSignature: 'secret-signature', upstreamResponseId: 'secret-response' };
  const { response, events } = run([
    { type: 'text-delta', index: 0, text: 'visible', ...secret }, endText(0, 'visible', 'text', secret),
    endTool(1, 'call_public', 'visible_tool', '{}', secret), { ...finish('tool-calls'), ...secret },
  ], { ...secret, store: true, instructions: 'secret-instructions', metadata: secret, model: 'secret-override' });
  assert.doesNotMatch(JSON.stringify({ response, events }), /secret|replay|encrypted|Signature|credential|accountId|instructions|metadata/);
  assert.equal(response.store, false); assert.equal(response.model, 'test-model');
});

test('safe response options echo supported metadata only, with immutable snapshots', () => {
  const options = { max_output_tokens: 50, temperature: 0.2, tool_choice: 'none', parallel_tool_calls: true,
    reasoning: { effort: 'off', summary: 'auto', encrypted_content: 'secret' }, text: { format: { type: 'text', secret: 'secret' } },
    tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} }, description: 'Find', strict: false, account: 'secret' }] };
  const output = createResponsesOutput('model', options), events = output.start();
  options.tools[0].parameters.type = 'secret';
  output.consume(finish('stop')); const { response } = output.complete();
  assert.equal(response.max_output_tokens, 50); assert.equal(response.temperature, 0.2); assert.equal(response.tool_choice, 'none');
  assert.equal(response.parallel_tool_calls, true); assert.deepEqual(response.reasoning, { effort: 'none', summary: 'auto' });
  assert.deepEqual(response.text, { format: { type: 'text' } }); assert.equal(response.tools[0].parameters.type, 'object');
  assert.doesNotMatch(JSON.stringify({ response, events }), /secret|encrypted|account/);
});

test('16 MiB and 4096 native block resource ceilings cannot become successes', () => {
  const output = createResponsesOutput('model'); output.start();
  assert.throws(() => output.consume({ type: 'text-delta', index: 0, text: 'x'.repeat(16 * 1024 * 1024) }),
    error => error instanceof LocalApiError && error.status === 502 && error.code === 'response_too_large');
  assert.throws(() => output.complete(), protocolFailure);
  assert.equal(output.failure(publicError(new Error('secret')).body).type, 'response.failed');
  const blocks = createResponsesOutput('model');
  for (let index = 0; index < 4096; index++) assert.deepEqual(blocks.consume({ type: 'block-start', index, blockType: 'tool-call' }), []);
  assert.throws(() => blocks.consume({ type: 'block-start', index: 4096, blockType: 'tool-call' }), protocolFailure);
});

test('end-only text/tools, empty text, and a finish-only close are supported', () => {
  const { response, events } = run([endText(0, ''), endText(1, 'end-only'), endTool(2, 'call', 'fn', '{}'),
    { type: 'reasoning-delta', index: 3, text: 'summary' }, finish('stop')]);
  assert.equal(response.output.length, 4); assert.equal(response.output[0].content[0].text, '');
  assert.equal(response.output[3].status, 'completed'); assert.deepEqual(reduce(events), response);
});

async function* jsonEvents(events) { for (const event of events) yield JSON.stringify(event); }
async function consumeNative(chunks) {
  const output = createResponsesOutput('model'), events = output.start();
  for await (const chunk of chunks) events.push(...output.consume(chunk));
  const result = output.complete(); events.push(...result.events); sequenced(events);
  assert.deepEqual(reduce(events), result.response);
  return { ...result, events };
}

test('real OpenAI Responses native mapper text/summary/tool chunks fit the frozen interface', async () => {
  const { response, events } = await consumeNative(mapOpenAIResponses(jsonEvents([
    { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'rs_native', summary_index: 0, delta: 'summary' },
    { type: 'response.reasoning_summary_text.done', output_index: 0, item_id: 'rs_native', summary_index: 0, text: 'summary' },
    { type: 'response.output_text.delta', output_index: 1, item_id: 'msg_native', content_index: 0, delta: 'answer' },
    { type: 'response.output_text.done', output_index: 1, item_id: 'msg_native', content_index: 0, text: 'answer' },
    { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', id: 'fc_native', call_id: 'call_native', name: 'lookup', arguments: '{}', status: 'completed' } },
    { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, input_tokens_details: { cached_tokens: 2 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 1 } }, output: [] } },
  ])));
  assert.deepEqual(response.output.map(item => item.type), ['reasoning', 'message', 'function_call']);
  assert.equal(response.usage.input_tokens, 5); assert.equal(response.usage.output_tokens_details.reasoning_tokens, 1);
  assert.doesNotMatch(JSON.stringify(events), /rs_native|msg_native|fc_native/);
});

test('real Anthropic/OpenAI Chat mappers produce supported text/tools/usage/max-token chunks', async () => {
  const anthropic = await consumeNative(mapAnthropic(jsonEvents([
    { type: 'message_start', message: { usage: { input_tokens: 2, cache_read_input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
    { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ])));
  assert.equal(anthropic.response.status, 'incomplete'); assert.equal(anthropic.response.incomplete_details.reason, 'max_output_tokens');
  assert.equal(anthropic.response.usage.input_tokens, 3);
  const chat = await consumeNative(mapOpenAI(jsonEvents([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_chat', function: { name: 'lookup', arguments: '{' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] }, finish_reason: 'tool_calls' }] },
    { usage: { prompt_tokens: 6, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 1 } }, choices: [] },
  ])));
  assert.equal(chat.response.output[0].call_id, 'call_chat'); assert.equal(chat.response.usage.input_tokens, 6);
});
