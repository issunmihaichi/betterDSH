import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCodexRequest, mapCodex, prepareCodexImages } from '../lib/native/codex.js';
import { createHttpUpstream, parseSse } from '../lib/upstream.js';
import { createPoolAdapter } from '../lib/adapter.js';

const bundle = { access_token: 'offline-token', chatgpt_account_id: 'offline-account' };
const options = { model: 'gpt-5.3-codex', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] };
const complete = (output = [], usage = {}) => ({ type: 'response.completed', response: { status: 'completed', output, usage } });
const itemEvent = (type, output_index, item) => ({ type: `response.output_item.${type}`, output_index, item });
const textItem = (id, text) => ({ type: 'message', id, status: 'completed', content: [{ type: 'output_text', text }] });
const toolItem = (id, call_id, name, args) => ({ type: 'function_call', id, call_id, name, arguments: args, status: 'completed' });
function stream(events, { fragment = 13, crlf = false, open = false, onCancel } = {}) {
  const delimiter = crlf ? '\r\n' : '\n';
  const bytes = new TextEncoder().encode(events.map((event) => `event: ${event.type ?? 'message'}${delimiter}data: ${typeof event === 'string' ? event : JSON.stringify(event)}${delimiter}${delimiter}`).join(''));
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset < bytes.length) {
        controller.enqueue(bytes.slice(offset, offset + fragment));
        offset += fragment;
      } else if (!open) controller.close();
    },
    cancel() { onCancel?.(); },
  });
}
async function collect(events, config) { return Array.fromAsync(mapCodex(stream(events, config), parseSse)); }
function request(account = {}, opts = options, credential = bundle) { return buildCodexRequest(account, opts, credential); }
function jwt(claims) { return `offline.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`; }

// All credentials, HTTP responses and fetch implementations are offline fixtures.
test('Codex OAuth URL, headers, required body and unsupported wire fields', () => {
  const built = request({}, { ...options, system: 'system', reasoningEffort: 'high', maxTokens: 42, temperature: 0.2, stop: ['x'], tools: [{ name: 'lookup', description: 'search', parameters: { type: 'object' } }] });
  assert.equal(built.url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(built.init.redirect, 'error');
  assert.equal(built.init.headers.authorization, 'Bearer offline-token');
  assert.equal(built.init.headers['chatgpt-account-id'], 'offline-account');
  assert.equal(built.init.headers['openai-beta'], 'responses=experimental');
  assert.equal(built.init.headers.originator, 'codex_cli_rs');
  assert.match(built.init.headers['user-agent'], new RegExp(`^codex_cli_rs/${built.init.headers.version.replaceAll('.', '\\.')}$`));
  const body = JSON.parse(built.init.body);
  assert.equal(body.instructions, 'system');
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.deepEqual(body.reasoning, { effort: 'high' });
  assert.deepEqual(body.include, ['reasoning.encrypted_content']);
  assert.deepEqual(body.tools[0], { type: 'function', name: 'lookup', description: 'search', parameters: { type: 'object' }, strict: false });
  assert.deepEqual(body.input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]);
  for (const field of ['max_tokens', 'max_output_tokens', 'temperature', 'stop', 'messages']) assert.equal(body[field], undefined);
  assert.equal(JSON.parse(request({}, { ...options, reasoningEffort: 'off' }).init.body).reasoning, undefined);
  assert.equal(JSON.parse(request().init.body).model, options.model);
});

test('Codex prompt cache identity stays stable across turns and OAuth refresh', () => {
  const account = { id: 'offline-cache-row' };
  const opts = { ...options, sessionId: '  offline-cache-会话\r\n  ' };
  const first = request(account, opts);
  const key = JSON.parse(first.init.body).prompt_cache_key;
  assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(key, opts.sessionId);
  const nextTurn = { ...opts, messages: [...opts.messages,
    { role: 'assistant', content: 'first reply' }, { role: 'user', content: 'continue' },
  ] };
  for (const built of [first, request(account, opts), request(account, nextTurn),
    request(account, nextTurn, { ...bundle, access_token: 'offline-refreshed-token' }),
    request(account, { ...nextTurn, model: 'gpt-5.4' })]) {
    assert.equal(JSON.parse(built.init.body).prompt_cache_key, key);
    assert.equal(built.init.headers.session_id, key);
    assert.equal(JSON.parse(built.init.body).store, false);
  }
});

test('Codex prompt cache identity isolates scopes and omits absent sessions', () => {
  const account = { id: 'offline-cache-row' };
  const opts = { ...options, sessionId: ' offline-cache-session ' };
  const keyOf = (built) => JSON.parse(built.init.body).prompt_cache_key;
  const key = keyOf(request(account, opts));
  for (const built of [
    request(account, { ...opts, sessionId: 'other-cache-session' }),
    request(account, { ...opts, sessionId: opts.sessionId.trim() }),
    request({ ...account, id: 'other-cache-row' }, opts),
    request(account, opts, { ...bundle, chatgpt_account_id: 'other-workspace' }),
    request({ ...account, baseUrl: 'https://offline-cache.example/backend-api' }, opts),
  ]) {
    assert.notEqual(keyOf(built), key);
    assert.equal(built.init.headers.session_id, keyOf(built));
  }
  const gateway = request({ ...account, baseUrl: 'https://offline-cache.example' }, opts);
  assert.equal(keyOf(gateway), keyOf(request({ ...account, baseUrl: 'https://offline-cache.example/backend-api/codex/responses' }, opts)));
  for (const sessionId of [undefined, null, '', ' \t\r\n ', 123]) {
    const built = request(account, { ...options, sessionId });
    assert.equal(Object.hasOwn(JSON.parse(built.init.body), 'prompt_cache_key'), false);
    assert.equal(Object.hasOwn(built.init.headers, 'session_id'), false);
  }
});

test('Codex fake HTTP cache usage reaches adapter stream and final records', async () => {
  const calls = [];
  const records = [];
  let credentialReads = 0;
  const upstream = createHttpUpstream({
    resolveCredential: async () => ({ ...bundle, access_token: `offline-token-${++credentialReads}` }),
    fetchImpl: async (url, init) => {
      const turn = calls.length;
      assert.ok(turn < 2, 'unexpected retry or extra HTTP request');
      calls.push({ url, headers: { ...init.headers }, body: JSON.parse(init.body) });
      const text = `offline reply ${turn + 1}`;
      return new Response(stream([complete([textItem(`msg_cache_${turn}`, text)], {
        input_tokens: 2048 + turn * 128,
        output_tokens: 7,
        input_tokens_details: { cached_tokens: [0, 1536][turn] },
        output_tokens_details: { reasoning_tokens: 2 },
      })]), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const account = {
    id: 'offline-http-cache-row', platform: 'openai', authMode: 'oauth',
    status: 'active', schedulable: true, models: [], concurrency: 1,
  };
  const adapter = createPoolAdapter({ initialAccounts: [account], upstream, onUsage: (record) => records.push(record) });
  const sessionId = 'offline-http-cache-session';
  const turns = [options.messages, [...options.messages,
    { role: 'assistant', content: 'offline reply 1' }, { role: 'user', content: 'continue' },
  ]];
  for (let turn = 0; turn < turns.length; turn++) {
    const chunks = await Array.fromAsync(adapter.stream({ ...options, sessionId, messages: turns[turn] }));
    const usage = { inputTokens: [2048, 640][turn], outputTokens: 7,
      cacheReadTokens: [0, 1536][turn], cacheWriteTokens: 0, reasoningTokens: 2 };
    assert.equal(usage.inputTokens + usage.cacheReadTokens, 2048 + turn * 128);
    assert.deepEqual(chunks.filter((chunk) => chunk.type === 'usage').map((chunk) => chunk.usage), [usage]);
    assert.equal(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''), `offline reply ${turn + 1}`);
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } });
    assert.equal(records.length, turn + 1);
    assert.equal(records[turn].ok, true);
    assert.equal(records[turn].accountId, account.id);
    assert.equal(records[turn].sessionId, sessionId);
    assert.deepEqual(records[turn].usage, usage);
  }
  assert.equal(credentialReads, 2);
  assert.notEqual(calls[0].headers.authorization, calls[1].headers.authorization);
  assert.notDeepEqual(calls[0].body.input, calls[1].body.input);
  assert.equal(calls[0].body.prompt_cache_key, calls[1].body.prompt_cache_key);
  for (const call of calls) {
    assert.equal(call.headers.session_id, call.body.prompt_cache_key);
    assert.match(call.headers.session_id, /^[0-9a-f-]{36}$/);
    assert.equal(call.body.store, false);
  }
});

test('Sol requests meet the model catalog client minimum without substituting the model', () => {
  const built = request({}, { ...options, model: 'gpt-6.1-sol', reasoningEffort: 'high' });
  const version = built.init.headers.version.split('.').map(Number);
  assert.equal(version.length, 3);
  assert.ok(version.every(Number.isSafeInteger));
  const minimum = [0, 153, 0];
  const firstDifference = version.findIndex((part, index) => part !== minimum[index]);
  assert.ok(firstDifference === -1 || version[firstDifference] > minimum[firstDifference], 'Sol requires Codex 0.153.0 or newer');
  assert.equal(built.init.headers['user-agent'], `codex_cli_rs/${built.init.headers.version}`);
  assert.equal(built.init.headers.originator, 'codex_cli_rs');
  assert.equal(JSON.parse(built.init.body).model, 'gpt-6.1-sol');
});

test('Direct OAuth bundles preserve their selected workspace before JWT fallback', () => {
  const claims = { 'https://api.openai.com/auth': { chatgpt_account_id: 'jwt-personal-workspace' } };
  for (const field of ['chatgpt_account_id', 'chatgptAccountId', 'account_id', 'accountId']) {
    const direct = { access_token: jwt(claims), id_token: jwt(claims), [field]: 'bundle-team-workspace' };
    assert.equal(request({}, options, direct).init.headers['chatgpt-account-id'], 'bundle-team-workspace');
    assert.equal(request({ chatgptAccountId: 'manual-workspace' }, options, direct).init.headers['chatgpt-account-id'], 'manual-workspace');
  }
});

test('OAuth credential identity recovery and safe local failures', () => {
  const claims = { 'https://api.openai.com/auth': { chatgpt_account_id: 'jwt-account' } };
  assert.equal(request({ chatgptAccountId: 'explicit-account' }, options, { ...bundle, id_token: jwt(claims) }).init.headers['chatgpt-account-id'], 'explicit-account');
  assert.equal(request({}, options, { access_token: 'opaque', id_token: jwt(claims) }).init.headers['chatgpt-account-id'], 'jwt-account');
  assert.equal(request({}, options, jwt(claims)).init.headers['chatgpt-account-id'], 'jwt-account');
  assert.equal(request({ oauth: { accountId: 'account-id' } }, options, 'opaque').init.headers['chatgpt-account-id'], 'account-id');
  assert.equal(request({ chatgptAccountId: 'account-id' }, options, 'opaque').init.headers['chatgpt-account-id'], 'account-id');
  for (const credential of [null, '', { access_token: '' }, { access_token: 'secret\r\ninjection', chatgpt_account_id: 'id' }]) {
    assert.throws(() => request({}, options, credential), (error) => error.code === 'POOL_NO_CREDENTIAL' && !error.message.includes('secret'));
  }
  assert.throws(() => request({}, options, 'opaque'), { code: 'POOL_CODEX_ACCOUNT_REQUIRED' });
  assert.throws(() => request({}, options, { access_token: 'opaque', chatgpt_account_id: 'id\r\n' }), { code: 'POOL_CODEX_ACCOUNT_REQUIRED' });
});

test('administrator base URLs accept canonical suffixes and reject ambiguity', () => {
  for (const suffix of ['', '/', '/backend-api', '/backend-api/codex/', '/backend-api/codex/responses']) {
    assert.equal(request({ baseUrl: `https://relay.example${suffix}` }).url, 'https://relay.example/backend-api/codex/responses');
  }
  for (const baseUrl of ['http://relay.example', 'https://user:secret@relay.example', 'https://relay.example?secret=yes', 'https://relay.example#secret', 'https://relay.example/v1', 'https://relay.example/v1/responses', 'https://relay.example/backend-api/codex/responses/responses', 'https://relay.example/custom/responses', 'invalid-secret']) {
    assert.throws(() => request({ baseUrl }), (error) => error.code === 'POOL_UNSUPPORTED_CONTENT' && !error.message.includes('secret'));
  }
  assert.equal(request({}, { ...options, baseUrl: 'https://untrusted.example' }).url, 'https://chatgpt.com/backend-api/codex/responses');
});

test('ordered text/function history, result matching and system promotion', () => {
  const id = `call_${'long-id'.repeat(20)}`;
  const opts = { ...options, system: 'first', messages: [
    { role: 'system', content: [{ type: 'text', text: 'second' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'before' }, { type: 'reasoning', text: 'hidden' }, { type: 'tool-call', id, name: 'lookup', arguments: { q: 1 } }, { type: 'text', text: 'after' }] },
    { role: 'tool', toolCallId: id, content: [{ type: 'text', text: 'result' }] },
  ] };
  const body = JSON.parse(request({}, opts).init.body);
  assert.equal(body.instructions, 'first\n\nsecond');
  assert.deepEqual(body.input.map((item) => item.type), ['message', 'function_call', 'message', 'function_call_output']);
  assert.equal(body.input[1].arguments, '{"q":1}');
  assert.equal(body.input[1].call_id, body.input[3].call_id);
  assert.ok(body.input[1].call_id.length <= 64);
  assert.equal(body.input[0].content[0].type, 'output_text');
  for (const messages of [[{ role: 'user', content: [{ type: 'image' }] }], [{ role: 'tool', content: [{ type: 'text', text: 'result' }] }], [{ role: 'tool', toolCallId: 'call_x', content: [{ type: 'file' }] }]]) {
    assert.throws(() => request({}, { ...options, messages }), { code: 'POOL_UNSUPPORTED_CONTENT' });
  }
  assert.throws(() => request({}, { ...options, reasoningEffort: 'invented' }), { code: 'POOL_UNSUPPORTED_CONTENT' });
});

const pngData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFhQAAAAASUVORK5CYII=';
const png = { type: 'image', mediaType: 'image/png', data: pngData };
const imageRef = { attachmentId: 'sha256:offline-image', mediaType: 'image/png', width: 1, height: 1, bytes: 68, name: 'offline.png' };
const durableImage = { type: 'image', attachment: imageRef };

test('Codex user images preserve text/image order, multi-image and image-only turns', () => {
  const content = [{ type: 'text', text: 'before' }, png, { type: 'text', text: 'after' }, { ...png, mediaType: 'image/jpeg' }];
  const original = structuredClone(content);
  const body = JSON.parse(request({}, { ...options, messages: [
    { role: 'user', content }, { role: 'assistant', content: 'reply' }, { role: 'user', content: [png] },
  ] }).init.body);
  assert.deepEqual(body.input[0].content, [
    { type: 'input_text', text: 'before' }, { type: 'input_image', image_url: `data:image/png;base64,${pngData}`, detail: 'auto' },
    { type: 'input_text', text: 'after' }, { type: 'input_image', image_url: `data:image/jpeg;base64,${pngData}`, detail: 'auto' },
  ]);
  assert.equal(body.input[1].content[0].type, 'output_text');
  assert.deepEqual(body.input[2].content, [body.input[0].content[1]]);
  assert.deepEqual(content, original);
});

test('Codex rejects invalid image payloads and unsupported roles without leaking content', () => {
  for (const image of [{ type: 'image' }, { ...png, data: '' }, { ...png, data: 'private-invalid-data' },
    { ...png, mediaType: 'image/svg+xml' }, { ...png, mediaType: 'private/type' }, durableImage]) {
    assert.throws(() => request({}, { ...options, messages: [{ role: 'user', content: [image] }] }), error => error.code === 'POOL_UNSUPPORTED_CONTENT' && !error.message.includes('private'));
  }
  for (const role of ['assistant', 'tool', 'system', 'developer']) {
    assert.throws(() => request({}, { ...options, messages: [{ role, toolCallId: 'call_image', content: [png] }] }), { code: 'POOL_UNSUPPORTED_CONTENT' });
  }
});

test('Codex resolves durable attachments once per request and keeps offloaded images text-only', async () => {
  const calls = [];
  const controller = new AbortController();
  const opts = { ...options, signal: controller.signal, messages: [{ role: 'user', content: [durableImage,
    { ...durableImage, attachment: { ...imageRef, name: 'second.png' } },
    { ...durableImage, offloaded: true },
  ] }] };
  const original = structuredClone(opts.messages);
  const prepared = await prepareCodexImages(opts, () => ({ async readImageRequest(ref, target, signal) {
    calls.push({ ref, target, signal });
    return { data: Buffer.from(pngData, 'base64'), mediaType: 'image/png', width: 1, height: 1 };
  } }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ref, imageRef);
  assert.deepEqual(calls[0].target, { width: 1, height: 1, maxBytes: 1_048_576 });
  assert.equal(calls[0].signal, controller.signal);
  assert.deepEqual(opts.messages, original);
  const parts = JSON.parse(request({}, prepared).init.body).input[0].content;
  assert.equal(parts.filter(part => part.type === 'input_image').length, 2);
  assert.match(parts[0].text, /offline.png/);
  assert.match(parts[2].text, /second.png/);
  assert.match(parts.at(-1).text, /image omitted/);
  await assert.rejects(() => prepareCodexImages(opts), { code: 'POOL_UNSUPPORTED_CONTENT' });
  const offloaded = await prepareCodexImages({ ...options, messages: [{ role: 'user', content: [{ ...durableImage, offloaded: true }] }] });
  assert.ok(offloaded.messages[0].content.every(part => part.type === 'text'));
  await assert.rejects(() => prepareCodexImages({ ...opts, messages: [{ role: 'assistant', content: [durableImage] }] }), { code: 'POOL_UNSUPPORTED_CONTENT' });
  controller.abort();
  await assert.rejects(() => prepareCodexImages(opts), { name: 'AbortError' });
});

test('Codex attachment cancellation prevents HTTP and adapter round trip includes images and tool history', async () => {
  const account = { id: 'images', platform: 'openai', authMode: 'oauth', status: 'active', schedulable: true, models: [options.model], groups: ['codex'], concurrency: 1 };
  let fetches = 0;
  const upstream = createHttpUpstream({ resolveCredential: () => bundle,
    resolveAttachments: () => ({ async readImageRequest() { return { data: Buffer.from(pngData, 'base64'), mediaType: 'image/png', width: 1, height: 1 }; } }),
    fetchImpl: async (url, init) => {
      fetches++;
      const input = JSON.parse(init.body).input;
      assert.ok(input[0].content.some(part => part.type === 'input_image' && part.image_url.endsWith(pngData)));
      assert.deepEqual(input.slice(1).map(item => item.type), ['function_call', 'function_call_output']);
      assert.equal(input[1].call_id, input[2].call_id);
      return new Response(stream([complete([textItem('image_reply', 'one pixel')])]), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const adapter = createPoolAdapter({ initialAccounts: [account], initialGroups: [{ id: 'codex', models: [] }], upstream });
  assert.deepEqual((await adapter.resolveModel('pool-codex', options.model)).inputModalities, ['text', 'image']);
  const chunks = await Array.fromAsync(adapter.stream({ ...options, provider: 'pool-codex', messages: [
    { role: 'user', content: [durableImage] },
    { role: 'assistant', content: [{ type: 'tool-call', name: 'lookup', id: 'call_image', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'call_image', content: 'done' },
  ] }));
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'one pixel');
  assert.equal(fetches, 1);
  const ctrl = new AbortController();
  const canceled = createHttpUpstream({ resolveCredential: () => bundle, resolveAttachments: () => ({ async readImageRequest() {
    ctrl.abort(); return { data: Buffer.from(pngData, 'base64'), mediaType: 'image/png' };
  } }), fetchImpl: () => { throw new Error('must not fetch after cancel'); } });
  await assert.rejects(() => Array.fromAsync(canceled.stream(account, { ...options, signal: ctrl.signal, messages: [{ role: 'user', content: [durableImage] }] })), { name: 'AbortError' });
  adapter.upsertAccount({ id: 'legacy', platform: 'anthropic', models: [options.model] });
  assert.deepEqual((await adapter.resolveModel('pool', options.model)).inputModalities, ['text']);
  assert.deepEqual((await adapter.resolveModel('pool-codex', options.model)).inputModalities, ['text', 'image']);
});

test('saved max to xhigh mapping reaches Codex request without sending unsupported max', async () => {
  let calls = 0;
  const account = { id: 'effort-map', platform: 'openai', authMode: 'oauth', status: 'active', schedulable: true, models: [options.model], groups: ['codex'] };
  const adapter = createPoolAdapter({ initialAccounts: [account], initialGroups: [{ id: 'codex', models: [] }],
    modelOverridesFor: () => ({ [options.model]: { reasoningEfforts: { off: null, high: 'high', max: 'xhigh' } } }),
    upstream: createHttpUpstream({ resolveCredential: () => bundle, fetchImpl: async (url, init) => {
      calls++; assert.deepEqual(JSON.parse(init.body).reasoning, { effort: 'xhigh' });
      return new Response(stream([complete([textItem('mapped', 'OK')])]), { headers: { 'content-type': 'text/event-stream' } });
    } }),
  });
  assert.deepEqual((await adapter.resolveModel('pool-codex', options.model)).reasoning.efforts.map(e => e.id), ['off', 'high', 'max']);
  const prepared = await adapter.prepareCall('pool-codex', options.model);
  await Array.fromAsync(prepared.stream({ ...options, reasoningEffort: 'max' }));
  assert.equal(calls, 1);
});

test('reserved python tool aliases avoid caller name collisions and reverse streamed calls', async () => {
  const names = ['python', 'python__pool', 'python__pool_1', 'Python'];
  const opts = {
    ...options, tools: names.map((name) => ({ name })),
    messages: [{ role: 'assistant', content: names.map((name, index) => ({ type: 'tool-call', id: `call_reserved_${index}`, name, arguments: '{}' })) }],
  };
  const built = request({}, opts);
  const body = JSON.parse(built.init.body);
  const wireNames = body.tools.map((tool) => tool.name);
  assert.equal(new Set(wireNames).size, names.length);
  assert.equal(wireNames.includes('python'), false);
  assert.equal(wireNames.includes('Python'), false);
  assert.equal(wireNames[1], 'python__pool');
  assert.equal(wireNames[2], 'python__pool_1');
  assert.deepEqual(body.input.map((item) => item.name), wireNames);
  const items = wireNames.map((name, index) => toolItem(`item_reserved_${index}`, `call_reserved_response_${index}`, name, '{}'));
  const events = items.flatMap((item, output_index) => [
    itemEvent('added', output_index, { ...item, arguments: '', status: 'in_progress' }),
    { type: 'response.function_call_arguments.delta', output_index, item_id: item.id, delta: '{}' },
    itemEvent('done', output_index, item),
  ]);
  events.push(complete(items));
  const chunks = await Array.fromAsync(mapCodex(stream(events), parseSse, built.context));
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block.name), names);
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'tool-call-delta').map((chunk) => chunk.id), items.map((item) => item.call_id));
  // No body mutations or maps leak into another request.
  assert.deepEqual(opts.tools.map((tool) => tool.name), names);
  const other = request({}, { ...options, tools: [{ name: 'python__pool' }] });
  const otherChunks = await Array.fromAsync(mapCodex(stream([complete([toolItem('other', 'call_other', 'python__pool', '{}')])]), parseSse, other.context));
  assert.equal(otherChunks.find((chunk) => chunk.type === 'block-end').block.name, 'python__pool');
});

test('reserved tool aliases change per request without losing encrypted reasoning continuation', async () => {
  const account = { id: 'python-continuation-account' };
  const initial = request(account, { ...options, tools: [{ name: 'python' }] });
  const firstWireName = JSON.parse(initial.init.body).tools[0].name;
  const call = toolItem('item_python_continuation', 'call_python_continuation', firstWireName, '{}');
  const chunks = await Array.fromAsync(mapCodex(stream([complete([
    { type: 'reasoning', id: 'rs_python', encrypted_content: 'python-private' }, call,
  ])]), parseSse, initial.context));
  const block = chunks.find((chunk) => chunk.type === 'block-end').block;
  assert.equal(block.name, 'python');
  const next = request(account, {
    ...options, tools: [{ name: 'python' }, { name: firstWireName }],
    messages: [{ role: 'assistant', content: [block] }, { role: 'tool', toolCallId: block.id, content: 'result' }],
  });
  const body = JSON.parse(next.init.body);
  assert.notEqual(body.tools[0].name, firstWireName);
  assert.deepEqual(body.input.map((item) => item.type), ['reasoning', 'function_call', 'function_call_output']);
  assert.equal(body.input[1].name, body.tools[0].name);
  assert.equal(body.input[0].encrypted_content, 'python-private');
  const historyOnly = request({}, { ...options, messages: [{ role: 'assistant', content: [block] }] });
  assert.notEqual(JSON.parse(historyOnly.init.body).input[0].name.toLowerCase(), 'python');
});

test('Codex usage counts each input token once across uncached and cache buckets', async () => {
  for (const [label, total, cached, input] of [
    ['absent cache', 32, undefined, 32],
    ['zero cache', 32, 0, 32],
    ['partial cache', 11, 3, 8],
    ['full cache', 32, 32, 0],
    ['large cached request', 286557, 285184, 1373],
    ['inconsistent cache count', 3, 7, 0],
  ]) {
    const chunks = await collect([complete([], { input_tokens: total, output_tokens: 70,
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

test('UTF8 and byte-level SSE fragmentation, complete text without duplicate snapshots', async () => {
  const item = textItem('msg_1', '你好🌍');
  const chunks = await collect([
    itemEvent('added', 0, { ...item, content: [], status: 'in_progress' }),
    { type: 'response.content_part.added', output_index: 0, item_id: 'msg_1', content_index: 0, part: { type: 'output_text', text: '' } },
    { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_1', content_index: 0, delta: '你好' },
    { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_1', content_index: 0, delta: '🌍' },
    { type: 'response.output_text.done', output_index: 0, item_id: 'msg_1', content_index: 0, text: '你好🌍' },
    itemEvent('done', 0, item), complete([item], { input_tokens: 11, output_tokens: 7, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } }),
  ], { fragment: 1 });
  assert.deepEqual(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text), ['你好', '🌍']);
  assert.equal(chunks.filter((c) => c.type === 'block-start').length, 1);
  assert.equal(chunks.filter((c) => c.type === 'block-end').length, 1);
  assert.deepEqual(chunks.at(-2), { type: 'usage', usage: { inputTokens: 8, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 0, reasoningTokens: 2 } });
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } });
});

test('multiple tool calls keep distinct stable call ids and final arguments', async () => {
  const a = toolItem('fc_item_a', 'call_A', 'lookup', '{"q":1}');
  const b = toolItem('fc_item_b', 'call_B', 'run', '{}');
  const chunks = await collect([
    itemEvent('added', 0, { ...a, arguments: '', status: 'in_progress' }),
    itemEvent('added', 1, { ...b, arguments: '', status: 'in_progress' }),
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: a.id, delta: '{"q":' },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: b.id, delta: '{}' },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: a.id, delta: '1}' },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: a.id, arguments: a.arguments },
    itemEvent('done', 0, a), itemEvent('done', 1, b), complete([a, b]),
  ]);
  assert.deepEqual(chunks.filter((c) => c.type === 'tool-call-delta').map((c) => c.id), ['call_A', 'call_B', 'call_A']);
  assert.deepEqual(chunks.filter((c) => c.type === 'block-end').map((c) => c.block), [
    { type: 'tool-call', id: 'call_A', name: 'lookup', arguments: '{"q":1}' },
    { type: 'tool-call', id: 'call_B', name: 'run', arguments: '{}' },
  ]);
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
});

test('tool metadata arriving after deltas never changes an exposed call id', async () => {
  const item = toolItem('item_X', 'call_X', 'lookup', '{"x":1}');
  const chunks = await collect([
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: '{"x":' },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, arguments: item.arguments },
    itemEvent('done', 0, item), complete([item]),
  ]);
  assert.deepEqual(chunks.filter((c) => c.type === 'tool-call-delta').map((c) => [c.id, c.argumentsDelta]), [['call_X', '{"x":'], ['call_X', '1}']]);
  assert.equal(chunks.find((c) => c.type === 'block-end').block.id, 'call_X');
});

test('completed output snapshot fills missing text and tools once; reasoning stays out of text', async () => {
  const chunks = await collect([
    { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'hidden' },
    complete([{ type: 'reasoning', id: 'rs_1', summary: [] }, textItem('msg_2', 'ok'), toolItem('item_3', 'call_C', 'run', '{}')]),
  ]);
  assert.deepEqual(chunks.filter((c) => c.type === 'block-end').map((c) => c.block.type), ['text', 'tool-call']);
  assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'ok');
});

test('failure and incomplete terminals preserve status/code without echoing credentials', async () => {
  const secret = 'Bearer private-secret-token';
  for (const [event, status, code] of [
    [{ type: 'response.failed', response: { status: 'failed', error: { code: 'rate_limit_exceeded', message: secret } } }, 429, 'rate_limit_exceeded'],
    [{ type: 'error', error: { code: 'server_error', status_code: 401, message: secret } }, 401, 'server_error'],
    [{ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }, 400, 'max_output_tokens'],
    [{ type: 'response.completed', response: { status: 'failed', error: { code: 'workspace_suspended', status: 403, message: secret } } }, 403, 'workspace_suspended'],
    [{ type: 'response.failed', response: { error: { code: 'server_is_overloaded' } } }, 503, 'server_is_overloaded'],
    [{ type: 'response.failed', response: { error: { type: 'insufficient_quota', message: secret } } }, 429, 'insufficient_quota'],
  ]) {
    await assert.rejects(collect([event]), (error) => error.status === status && error.code === code && !error.message.includes(secret));
  }
});

test('EOF, DONE, malformed SSE and invalid complete metadata cannot produce success', async () => {
  for (const events of [[], ['[DONE]'], [{ type: 'response.created' }], ['bad-json'], [{ type: 'response.completed' }], [{ type: 'response.done', response: {} }], [{ type: 'response.completed', response: { status: 'incomplete' } }]]) {
    const chunks = [];
    await assert.rejects(async () => { for await (const chunk of mapCodex(stream(events), parseSse)) chunks.push(chunk); });
    assert.equal(chunks.some((c) => c.type === 'finish'), false);
  }
  await assert.rejects(collect([complete([toolItem('item_X', '', 'run', '{}')])]), { code: 'CODEX_INVALID_TOOL_ID' });
});

test('encrypted reasoning restores once before tool history without rs id lookup', async () => {
  const account = { id: 'continuation-account' };
  const built = request(account);
  assert.match(built.context.scope, /^[a-f0-9]{64}$/);
  const a = toolItem('item_RA', 'call_RA', 'lookup', '{}');
  const b = toolItem('item_RB', 'call_RB', 'run', '{}');
  const reasoning = { type: 'reasoning', id: 'rs_private', call_id: 'private-rs-call', encrypted_content: 'private-encrypted-fixture' };
  const chunks = await Array.fromAsync(mapCodex(stream([
    itemEvent('done', 0, reasoning), itemEvent('done', 1, a), itemEvent('done', 2, b), complete(),
  ]), parseSse, built.context));
  assert.equal(JSON.stringify(chunks).includes('private-encrypted-fixture'), false);
  const messages = [
    { role: 'assistant', content: [a, b].map((item) => ({ type: 'tool-call', id: item.call_id, name: item.name, arguments: item.arguments })) },
    { role: 'tool', toolCallId: a.call_id, content: 'first result' },
    { role: 'tool', toolCallId: b.call_id, content: 'second result' },
  ];
  const followup = JSON.parse(request(account, { ...options, messages }).init.body);
  assert.deepEqual(followup.input.map((item) => item.type), ['reasoning', 'function_call', 'function_call', 'function_call_output', 'function_call_output']);
  assert.deepEqual(followup.input[0], { type: 'reasoning', encrypted_content: 'private-encrypted-fixture', summary: [] });
  assert.equal(followup.input[1].call_id, followup.input[3].call_id);
  assert.equal(followup.input[2].call_id, followup.input[4].call_id);
  for (const [differentAccount, differentOptions, credential] of [
    [{ ...account, id: 'other-account' }, { ...options, messages }, bundle],
    [{ ...account, chatgptAccountId: 'other-workspace' }, { ...options, messages }, bundle],
    [account, { ...options, model: 'gpt-5.4', messages }, bundle],
    [account, { ...options, messages }, { ...bundle, access_token: 'different-token' }],
    [{ ...account, baseUrl: 'https://relay.example' }, { ...options, messages }, bundle],
  ]) assert.equal(JSON.parse(request(differentAccount, differentOptions, credential).init.body).input.some((item) => item.type === 'reasoning'), false);
  const changedMessages = [{ role: 'assistant', content: [{ type: 'tool-call', id: a.call_id, name: a.name, arguments: '{"changed":true}' }] }];
  assert.equal(JSON.parse(request(account, { ...options, messages: changedMessages }).init.body).input.some((item) => item.type === 'reasoning'), false);
});

test('failed streams never cache private reasoning; TTL and oversized entries stay bounded', async () => {
  const account = { id: 'bounded-continuation-account' };
  const built = request(account);
  const failedCall = toolItem('item_failed_cache', 'call_failed_cache', 'run', '{}');
  await assert.rejects(Array.fromAsync(mapCodex(stream([
    itemEvent('done', 0, { type: 'reasoning', encrypted_content: 'failed-private' }),
    itemEvent('done', 1, failedCall), { type: 'response.failed', response: { error: { code: 'server_error' } } },
  ]), parseSse, built.context)));
  const replay = (item) => JSON.parse(request(account, { ...options, messages: [{ role: 'assistant', content: [{ type: 'tool-call', id: item.call_id, name: item.name, arguments: item.arguments }] }] }).init.body).input;
  assert.equal(replay(failedCall).some((item) => item.type === 'reasoning'), false);
  const largeCall = toolItem('item_large_cache', 'call_large_cache', 'run', '{}');
  await Array.fromAsync(mapCodex(stream([complete([{ type: 'reasoning', encrypted_content: 'x'.repeat(600 * 1024) }, largeCall])], { fragment: 8192 }), parseSse, built.context));
  assert.equal(replay(largeCall).some((item) => item.type === 'reasoning'), false);
  const expiresCall = toolItem('item_ttl_cache', 'call_ttl_cache', 'run', '{}');
  await Array.fromAsync(mapCodex(stream([complete([{ type: 'reasoning', encrypted_content: 'ttl-private' }, expiresCall])]), parseSse, built.context));
  assert.equal(replay(expiresCall).some((item) => item.type === 'reasoning'), true);
  const originalNow = Date.now;
  const later = originalNow() + 61 * 60 * 1000;
  try {
    Date.now = () => later;
    assert.equal(replay(expiresCall).some((item) => item.type === 'reasoning'), false);
  } finally { Date.now = originalNow; }
});

test('partial output is followed by explicit failure and stream cancellation', async () => {
  let cancelled = false;
  const seen = [];
  const body = stream([
    { type: 'response.output_text.delta', output_index: 0, delta: 'partial' },
    { type: 'response.failed', response: { error: { code: 'server_error', status: 500 } } },
  ], { open: true, onCancel() { cancelled = true; } });
  await assert.rejects(async () => { for await (const chunk of mapCodex(body, parseSse)) seen.push(chunk); }, { code: 'server_error', status: 500 });
  assert.equal(seen.some((chunk) => chunk.type === 'text-delta'), true);
  assert.equal(seen.some((chunk) => chunk.type === 'finish'), false);
  assert.equal(cancelled, true);
});

test('malformed output shape and coordinates raise typed protocol errors', async () => {
  for (const event of [
    { type: 'response.output_text.delta', output_index: -1, delta: 'bad' },
    { type: 'response.output_text.delta', output_index: 0, content_index: -1, delta: 'bad' },
    complete([{ type: 'message', content: 'wrong' }]),
    complete([{ type: 'message', content: [null] }]),
  ]) await assert.rejects(collect([event]), { code: 'CODEX_INVALID_STREAM', status: 502 });
});

test('changed tool id and inconsistent final text fail explicitly', async () => {
  const item = toolItem('item_A', 'call_A', 'run', '');
  await assert.rejects(collect([itemEvent('added', 0, item), itemEvent('done', 0, { ...item, call_id: 'call_B' })]), { code: 'CODEX_INVALID_TOOL_ID' });
  await assert.rejects(collect([{ type: 'response.output_text.delta', output_index: 0, delta: 'one' }, complete([textItem('msg_1', 'two')])]), { code: 'CODEX_INCONSISTENT_OUTPUT' });
});

test('successful terminal cancels stream immediately without waiting for socket EOF', async () => {
  let cancelled = false;
  const chunks = await Array.fromAsync(mapCodex(stream([complete()], { open: true, onCancel() { cancelled = true; } }), parseSse));
  assert.equal(chunks.at(-1).type, 'finish');
  assert.equal(cancelled, true);
});

test('multiple message parts use distinct block indexes', async () => {
  const item = { type: 'message', id: 'msg_parts', status: 'completed', content: [{ type: 'output_text', text: 'first' }, { type: 'output_text', text: 'second' }] };
  const chunks = await collect([
    { type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: 'first' },
    { type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 1, delta: 'second' },
    complete([item]),
  ]);
  const blocks = chunks.filter((c) => c.type === 'block-end');
  assert.deepEqual(blocks.map((c) => c.block.text), ['first', 'second']);
  assert.notEqual(blocks[0].index, blocks[1].index);
});

test('shared SSE parser accepts CRLF split between network chunks', async () => {
  const chunks = await collect([
    { type: 'response.output_text.delta', output_index: 0, delta: 'CRLF' },
    complete([textItem('msg_1', 'CRLF')]),
  ], { crlf: true, fragment: 1 });
  assert.equal(chunks.find((c) => c.type === 'text-delta').text, 'CRLF');
  assert.equal(chunks.at(-1).type, 'finish');
});
