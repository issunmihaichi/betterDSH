import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResponsesRequest } from '../lib/local-api-responses-request.js';
import { LocalApiError, publicError } from '../lib/local-api-protocol.js';

const request = (extra = {}) => ({ model: 'test-model', input: 'hello', ...extra });
const call = (extra = {}) => ({ type: 'function_call', name: 'lookup', call_id: 'call_1', arguments: '{"q":"x"}', ...extra });
const output = (extra = {}) => ({ type: 'function_call_output', call_id: 'call_1', output: 'found', ...extra });
const fn = (extra = {}) => ({ type: 'function', name: 'lookup', description: 'Look up', parameters: { type: 'object', properties: { q: { type: 'string' } } }, ...extra });
const image = (extra = {}) => ({ type: 'input_image', image_url: 'data:image/png;base64,AQ==', ...extra });
const user = content => ({ role: 'user', content });
const reject = body => assert.throws(() => parseResponsesRequest(body), error => error instanceof LocalApiError && error.status === 400 && error.code === 'invalid_request');

test('string input becomes a user message and defaults to stateless non-streaming output', () => {
  assert.deepEqual(parseResponsesRequest(request()), {
    stream: false, hasImages: false,
    options: { model: 'test-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] },
    responseOptions: { store: false },
  });
  assert.equal(parseResponsesRequest(request({ input: '' })).options.messages[0].content[0].text, '');
  assert.equal(parseResponsesRequest(request({ stream: true })).stream, true);
});

test('instructions merge with preceding system/developer text and message shorthand', () => {
  const parsed = parseResponsesRequest(request({ instructions: 'Root.', input: [
    { role: 'system', content: 'System.' },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Developer.' }, { type: 'input_text', text: ' More.' }] },
    user([{ type: 'input_text', text: 'Question.' }]),
    { type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Answer.', annotations: [], logprobs: [] }] },
    user('Follow up.'),
  ] }));
  assert.equal(parsed.options.system, 'Root.\n\nSystem.\n\nDeveloper. More.');
  assert.deepEqual(parsed.options.messages, [
    { role: 'user', content: [{ type: 'text', text: 'Question.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Answer.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Follow up.' }] },
  ]);
  assert.deepEqual(parsed.responseOptions, { store: false });
});

test('leading system/developer text never accepts images, late instructions or empty conversations', () => {
  for (const input of [
    [{ role: 'developer', content: 'Only instructions.' }],
    [user('hello'), { role: 'system', content: 'late' }],
    [user('hello'), { role: 'developer', content: 'late' }],
    [{ role: 'developer', content: [image()] }, user('hello')],
    [{ type: 'reasoning', summary: [] }, { role: 'system', content: 'late' }, user('hello')],
  ]) reject(request({ input }));
});

test('flat function tools and call/output history preserve ids, arguments and inferred toolName', () => {
  const parsed = parseResponsesRequest(request({ tools: [fn()], input: [
    user('lookup'),
    { role: 'assistant', content: 'Checking.' },
    call({ id: 'fc_1', status: 'completed' }),
    output({ id: 'fco_1', status: 'completed', name: 'lookup' }),
    { role: 'assistant', content: [{ type: 'output_text', text: 'Found it.', annotations: [] }] },
  ] }));
  assert.deepEqual(parsed.options.tools, [{ name: 'lookup', description: 'Look up', parameters: fn().parameters }]);
  assert.deepEqual(parsed.options.messages[1], { role: 'assistant', content: [
    { type: 'text', text: 'Checking.' }, { type: 'tool-call', id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
  ] });
  assert.deepEqual(parsed.options.messages[2], { role: 'tool', toolCallId: 'call_1', toolName: 'lookup', content: [{ type: 'text', text: 'found' }] });
  assert.deepEqual(parsed.responseOptions.tools, [{ ...fn(), strict: false }]);
});

test('parallel historical calls are grouped and results can arrive in either order', () => {
  const parsed = parseResponsesRequest(request({ input: [
    call(), call({ call_id: 'call_2', name: 'second', arguments: '{}' }),
    output({ call_id: 'call_2' }), output(),
  ] }));
  assert.equal(parsed.options.messages.length, 3);
  assert.deepEqual(parsed.options.messages[0].content.map(part => part.name), ['lookup', 'second']);
  assert.deepEqual(parsed.options.messages.slice(1).map(message => message.toolName), ['second', 'lookup']);
  // A final unanswered call retains existing Chat parser semantics; it is not dropped.
  assert.equal(parseResponsesRequest(request({ input: [call()] })).options.messages[0].content[0].id, 'call_1');
});

test('function outputs strictly match preceding unique call ids and optional tool names', () => {
  for (const input of [
    [output()], [output(), call()], [call(), output({ call_id: 'other' })],
    [call(), output(), output()], [call(), call()], [call(), output({ name: 'wrong' })],
    [call({ call_id: '' }), output()], [call(), output({ call_id: null })],
    [call({ name: 'bad.name' }), output()], [call(), output({ name: null })],
  ]) reject(request({ input }));
});

test('call arguments are JSON object strings, not nested Chat function definitions', () => {
  for (const argumentsValue of [undefined, null, {}, [], 'not-json', '[]', 'null', '42', '"string"']) reject(request({ input: [call({ arguments: argumentsValue })] }));
  reject(request({ input: [call({ function: { name: 'lookup', arguments: '{}' } })] }));
  assert.equal(parseResponsesRequest(request({ input: [call({ arguments: ' {} ' })] })).options.messages[0].content[0].arguments, ' {} ');
});

test('tool_choice none disables new tools without discarding historical calls/results', () => {
  const parsed = parseResponsesRequest(request({ tool_choice: 'none', tools: [fn()], input: [call(), output()] }));
  assert.equal(parsed.options.tools, undefined);
  assert.equal(parsed.options.messages[0].content[0].type, 'tool-call');
  assert.equal(parsed.options.messages[1].toolName, 'lookup');
  assert.equal(parsed.responseOptions.tool_choice, 'none');
  assert.deepEqual(parsed.responseOptions.tools, []);
  reject(request({ tool_choice: 'none', tools: [fn({ strict: true })] }));
  assert.equal(parseResponsesRequest(request({ tool_choice: 'auto' })).responseOptions.tool_choice, 'auto');
});

test('function definitions have shared Chat validation, defaults and an explicit non-strict projection', () => {
  const parsed = parseResponsesRequest(request({ tools: [{ type: 'function', name: 'bare', strict: false }] }));
  assert.deepEqual(parsed.options.tools, [{ name: 'bare', parameters: { type: 'object', properties: {} } }]);
  assert.deepEqual(parsed.responseOptions.tools, [{ type: 'function', name: 'bare', parameters: { type: 'object', properties: {} }, strict: false }]);
  for (const tools of [
    null, {}, [fn(), fn()], [fn({ strict: true })], [fn({ strict: null })], [fn({ description: null })],
    [fn({ parameters: null })], [fn({ parameters: { type: 'array' } })], [fn({ name: 'invalid.name' })],
    [{ type: 'function', function: { name: 'lookup' } }], [{ type: 'web_search' }],
    [{ type: 'file_search', vector_store_ids: ['vs_private'] }], Array.from({ length: 129 }, (_, index) => fn({ name: `f${index}` })),
  ]) reject(request({ tools }));
});

test('inline image data URLs work in user and function output text/image part lists', () => {
  const parsed = parseResponsesRequest(request({ input: [
    user([{ type: 'input_text', text: 'Describe.' }, image({ detail: 'auto' })]),
    call(), output({ output: [{ type: 'input_text', text: 'Result.' }, image({ image_url: 'data:image/webp;base64,Ag==' })] }),
  ] }));
  assert.equal(parsed.hasImages, true);
  assert.deepEqual(parsed.options.messages[0].content[1], { type: 'image', mediaType: 'image/png', data: 'AQ==' });
  assert.deepEqual(parsed.options.messages[2], { role: 'tool', toolCallId: 'call_1', toolName: 'lookup', content: [
    { type: 'text', text: 'Result.' }, { type: 'image', mediaType: 'image/webp', data: 'Ag==' },
  ] });
  for (const mediaType of ['png', 'jpeg', 'webp', 'gif']) assert.equal(parseResponsesRequest(request({ input: [user([image({ image_url: `data:image/${mediaType};base64,AQ==` })])] })).hasImages, true);
});

test('remote images, file ids, noncanonical base64 and unsupported image roles/details reject', () => {
  for (const part of [
    image({ image_url: 'https://127.0.0.1/private' }), image({ image_url: 'file:///secret.png' }),
    image({ image_url: 'data:image/svg+xml;base64,AQ==' }), image({ image_url: 'data:image/png;base64,AX==' }),
    image({ image_url: 'data:image/png;base64,AQ' }), image({ image_url: null }), image({ detail: 'high' }), image({ detail: null }),
    image({ file_id: 'file_private' }), { type: 'input_image', file_id: 'file_private' },
  ]) reject(request({ input: [user([part])] }));
  reject(request({ input: [{ role: 'assistant', content: [image()] }] }));
  reject(request({ input: [{ role: 'system', content: [image()] }, user('hello')] }));
});

test('public reasoning summaries can be replayed as marked assistant text, never opaque state', () => {
  for (const encrypted_content of [undefined, null, '']) {
    const parsed = parseResponsesRequest(request({ input: [user('Question'), {
      type: 'reasoning', id: 'rs_1', status: 'completed', encrypted_content,
      summary: [{ type: 'summary_text', text: 'Public summary.' }, { type: 'summary_text', text: 'More.' }],
    }, call(), output()] }));
    assert.deepEqual(parsed.options.messages[1].content[0], { type: 'text', text: '[Prior assistant reasoning summary]\nPublic summary.\nMore.' });
    assert.equal(parsed.options.messages[1].content[1].type, 'tool-call');
    assert.ok(!JSON.stringify(parsed).includes('rs_1'));
  }
  const empty = parseResponsesRequest(request({ input: [{ type: 'reasoning', summary: [] }, user('hello')] }));
  assert.equal(empty.options.messages.length, 1);
  for (const item of [
    { type: 'reasoning', summary: [], encrypted_content: 'opaque-secret' },
    { type: 'reasoning', summary: [], encrypted_content: {} },
    { type: 'reasoning', summary: null }, { type: 'reasoning' },
    { type: 'reasoning', summary: [{ type: 'reasoning_text', text: 'Not a public summary.' }] },
    { type: 'reasoning', summary: [{ type: 'summary_text', text: null }] },
    { type: 'reasoning', summary: [], content: [] },
  ]) reject(request({ input: [item, user('hello')] }));
});

test('generation options map to adapter options and safe response metadata, without instructions echo', () => {
  const parsed = parseResponsesRequest(request({ instructions: 'Do not echo this.', stream: true, temperature: 0.3, max_output_tokens: 123,
    reasoning: { effort: 'high', summary: 'auto' }, text: { format: { type: 'text' } },
    store: false, background: false, previous_response_id: null, include: [],
  }));
  assert.equal(parsed.options.temperature, 0.3);
  assert.equal(parsed.options.maxTokens, 123);
  assert.equal(parsed.options.reasoningEffort, 'high');
  assert.deepEqual(parsed.responseOptions, { store: false, temperature: 0.3, max_output_tokens: 123, reasoning: { effort: 'high', summary: 'auto' }, text: { format: { type: 'text' } } });
  assert.ok(!JSON.stringify(parsed.responseOptions).includes('Do not echo'));
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) assert.equal(parseResponsesRequest(request({ reasoning: { effort } })).options.reasoningEffort, effort === 'none' ? 'off' : effort);
});

test('unsupported reasoning/summary modes, numeric ranges and null generation options reject', () => {
  for (const extra of [
    { temperature: null }, { temperature: '1' }, { temperature: -0.1 }, { temperature: 2.1 }, { temperature: NaN },
    { max_output_tokens: null }, { max_output_tokens: 0 }, { max_output_tokens: 1.1 }, { max_output_tokens: 2147483648 },
    { reasoning: null }, { reasoning: {} }, { reasoning: { effort: null } }, { reasoning: { effort: 'off' } },
    { reasoning: { effort: 'high', summary: null } }, { reasoning: { effort: 'high', summary: 'concise' } },
    { reasoning: { effort: 'high', summary: 'detailed' } }, { reasoning: { summary: 'auto' } },
    { reasoning: { effort: 'none', summary: 'auto' } }, { reasoning: { effort: 'high', generate_summary: 'auto' } },
  ]) reject(request(extra));
  assert.equal(parseResponsesRequest(request({ temperature: 0, max_output_tokens: 1 })).options.temperature, 0);
  assert.equal(parseResponsesRequest(request({ temperature: 2, max_output_tokens: 2147483647 })).options.maxTokens, 2147483647);
});

test('stateful features, encrypted includes, built-ins and unenforceable controls explicitly reject', () => {
  for (const extra of [
    { store: true }, { store: null }, { previous_response_id: 'resp_private' }, { previous_response_id: '' },
    { background: true }, { background: null }, { conversation: 'conv_private' }, { conversation: null },
    { include: ['reasoning.encrypted_content'] }, { include: ['message.output_text.logprobs'] }, { include: null },
    { tool_choice: 'required' }, { tool_choice: null }, { tool_choice: { type: 'function', name: 'lookup' } },
    { parallel_tool_calls: false }, { parallel_tool_calls: true }, { max_tool_calls: 1 },
    { text: { format: { type: 'json_schema', name: 'schema', schema: {} } } }, { text: { format: { type: 'json_object' } } },
    { text: { format: { type: 'text', strict: false } } }, { text: { verbosity: 'low' } },
    { text: null }, { text: {} }, { text: { format: null } },
    { top_p: 1 }, { truncation: 'auto' }, { service_tier: 'auto' }, { prompt: { id: 'pmpt_private' } },
    { metadata: {} }, { user: 'user_private' }, { stream_options: {} }, { messages: [user('hello')] },
  ]) reject(request(extra));
});

test('malformed input, unsupported messages/parts and bad replay metadata all return local 400s', () => {
  for (const body of [null, [], 'hello', {}, request({ model: null }), request({ model: 'bad model' }), request({ stream: null }), request({ stream: 'yes' }), request({ instructions: null })]) reject(body);
  for (const input of [
    undefined, null, {}, [], [null], ['hello'], [{ role: 'tool', content: 'orphan' }], [{ role: 'user', content: null }],
    [user([])], [user([{ type: 'output_text', text: 'wrong role' }])], [user([{ type: 'text', text: 'Chat part' }])],
    [user([{ type: 'input_file', file_id: 'file_private' }])], [user([{ type: 'input_audio', data: 'private' }])],
    [{ role: 'assistant', content: null }], [{ role: 'assistant', content: [{ type: 'refusal', refusal: 'No' }] }],
    [{ role: 'assistant', content: [{ type: 'output_text', text: 'Answer', annotations: [{ type: 'url_citation' }] }] }],
    [{ role: 'assistant', content: [{ type: 'output_text', text: 'Answer', logprobs: [{ token: 'Answer' }] }] }],
    [{ role: 'user', content: 'hello', id: null }], [{ role: 'user', content: 'hello', status: 'failed' }],
    [{ role: 'user', content: 'hello', phase: 'commentary' }], [{ type: 'item_reference', id: 'msg_private' }],
    [{ type: 'web_search_call', id: 'ws_private' }], [call({ status: 'failed' })], [call(), output({ output: null })],
  ]) reject(request({ input }));
});

test('sanitized validation errors never interpolate user input or opaque state', () => {
  const secret = 'Bearer private-key private-account https://private.invalid';
  for (const body of [
    request({ [secret]: secret }), request({ model: secret }), request({ previous_response_id: secret }),
    request({ include: [secret] }), request({ input: [call({ name: secret })] }),
    request({ input: [{ type: 'reasoning', summary: [], encrypted_content: secret }] }),
    request({ input: [user([image({ image_url: secret })])] }),
    request({ input: [call({ arguments: secret })] }),
  ]) {
    try { parseResponsesRequest(body); assert.fail('Expected invalid request.'); }
    catch (error) {
      assert.ok(error instanceof LocalApiError);
      const exposed = publicError(error);
      assert.equal(exposed.status, 400);
      assert.equal(exposed.body.error.type, 'invalid_request_error');
      assert.ok(!JSON.stringify(exposed).includes(secret));
    }
  }
});

test('parsing does not mutate input or retain state across independent requests', () => {
  const body = request({ input: [user('hello'), call(), output()], tools: [fn()], reasoning: { effort: 'high', summary: 'auto' } });
  const before = structuredClone(body);
  parseResponsesRequest(body);
  assert.deepEqual(body, before);
  reject(request({ input: [output()] }));
  assert.deepEqual(parseResponsesRequest(request()).responseOptions, { store: false });
});
