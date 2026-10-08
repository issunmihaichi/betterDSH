/** Mock-only Gemini protocol tests; no network, accounts, or DSH runtime. */
import assert from 'node:assert/strict';
import { buildGeminiRequest, ensureGeminiProject, mapGemini } from '../lib/native/gemini.js';
import { parseSse } from '../lib/upstream.js';

const oauth = { id: 'gemini-a', platform: 'gemini', authMode: 'oauth', credentialRef: 'test:gemini:a' };
const bundle = { access_token: 'mock-access', refresh_token: 'mock-refresh', project_id: 'mock-project' };
const user = { role: 'user', content: [{ type: 'text', text: 'Hello' }] };
const options = { model: 'gemini-2.5-pro', messages: [user] };
const json = (request) => JSON.parse(request.init.body);
const contents = (request) => json(request).request?.contents ?? json(request).contents;
const collect = async (events) => { const result = []; for await (const event of events) result.push(event); return result; };
const ended = (chunks) => chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block);
const sse = (...events) => new Response(events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\r\n\r\n`).join('')).body;
const candidate = (parts, finishReason) => ({ candidates: [{ index: 0, content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }] });
const map = (events, context) => collect(mapGemini(sse(...events), parseSse, context));
const checkError = (promise, code) => assert.rejects(promise, (error) => error.code === code);
const syncError = (fn, code) => assert.throws(fn, (error) => error.code === code);
let passed = 0;
const failures = [];
async function check(name, run) {
  try { await run(); passed++; console.log(`ok ${name}`); }
  catch (error) { failures.push({ name, error }); console.error(`FAIL ${name}: ${error.message}`); }
}

await check('Code Assist URL, OAuth headers and envelope', () => {
  const request = buildGeminiRequest(oauth, { ...options, system: 'System', maxTokens: 99, temperature: 0.3, stop: ['END'] }, bundle);
  assert.equal(request.url, 'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers.authorization, 'Bearer mock-access');
  assert.equal(request.init.headers['x-goog-api-key'], undefined);
  assert.deepEqual(json(request), {
    project: 'mock-project', model: 'gemini-2.5-pro',
    request: { contents: [{ role: 'user', parts: [{ text: 'Hello' }] }], systemInstruction: { parts: [{ text: 'System' }] }, generationConfig: { maxOutputTokens: 99, temperature: 0.3, stopSequences: ['END'] } },
  });
});
await check('Bundle aliases, serialized bundle and account project fallback', () => {
  assert.equal(json(buildGeminiRequest({ ...oauth, projectId: 'account-project' }, options, 'mock-access')).project, 'account-project');
  assert.equal(json(buildGeminiRequest(oauth, options, { accessToken: 'mock-access', projectId: 'alias-project' })).project, 'alias-project');
  assert.equal(json(buildGeminiRequest(oauth, options, JSON.stringify(bundle))).project, 'mock-project');
});
await check('API key native endpoint without project or bearer', () => {
  const request = buildGeminiRequest({ id: 'api', authMode: 'api-key' }, { ...options, model: 'models/gemini-2.5-flash' }, { api_key: 'mock-api', access_token: 'wrong-for-api' });
  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
  assert.equal(request.init.headers['x-goog-api-key'], 'mock-api');
  assert.equal(request.init.headers.authorization, undefined);
  assert.deepEqual(json(request), { contents: [{ role: 'user', parts: [{ text: 'Hello' }] }] });
});
await check('Custom base keeps native path', () => {
  assert.equal(buildGeminiRequest({ ...oauth, baseUrl: 'https://mock.invalid/' }, options, bundle).url, 'https://mock.invalid/v1internal:streamGenerateContent?alt=sse');
});
await check('Missing secret/project and unsafe model fail explicitly', () => {
  syncError(() => buildGeminiRequest(oauth, options, {}), 'POOL_NO_CREDENTIAL');
  syncError(() => buildGeminiRequest(oauth, options, { access_token: 'mock-access' }), 'POOL_GEMINI_PROJECT_REQUIRED');
  for (const model of ['', '../secret', 'gemini?key=x', 'gemini/x', 'gemini#frag']) syncError(() => buildGeminiRequest(oauth, { ...options, model }, bundle), 'POOL_UNSUPPORTED_CONTENT');
});
await check('Gemini 2 and 3 thinking controls use native fields', () => {
  assert.deepEqual(json(buildGeminiRequest(oauth, { ...options, reasoningEffort: 'low' }, bundle)).request.generationConfig.thinkingConfig, { thinkingBudget: 1024, includeThoughts: true });
  assert.deepEqual(json(buildGeminiRequest(oauth, { ...options, reasoningEffort: 'off' }, bundle)).request.generationConfig.thinkingConfig, { thinkingBudget: 128, includeThoughts: false });
  assert.deepEqual(json(buildGeminiRequest(oauth, { ...options, model: 'gemini-2.5-flash', reasoningEffort: 'off' }, bundle)).request.generationConfig.thinkingConfig, { thinkingBudget: 0, includeThoughts: false });
  assert.deepEqual(json(buildGeminiRequest(oauth, { ...options, model: 'gemini-3.1-pro', reasoningEffort: 'medium' }, bundle)).request.generationConfig.thinkingConfig, { thinkingLevel: 'medium', includeThoughts: true });
  assert.deepEqual(json(buildGeminiRequest(oauth, { ...options, model: 'gemini-3.1-pro', reasoningEffort: 'high' }, bundle)).request.generationConfig.thinkingConfig, { thinkingLevel: 'high', includeThoughts: true });
  assert.deepEqual(json(buildGeminiRequest(oauth, { ...options, model: 'gemini-3-flash-preview', reasoningEffort: 'off' }, bundle)).request.generationConfig.thinkingConfig, { thinkingLevel: 'minimal', includeThoughts: false });
  syncError(() => buildGeminiRequest(oauth, { ...options, thinkingBudget: -2 }, bundle), 'POOL_UNSUPPORTED_CONTENT');
});
await check('JSON Schema retains refs and valid tool names', () => {
  const parameters = { type: 'object', properties: { input: { $ref: '#/$defs/Input' } }, $defs: { Input: { type: 'string' } }, additionalProperties: false };
  const before = JSON.stringify(parameters);
  const request = buildGeminiRequest(oauth, { ...options, tools: [{ name: 'read_file', description: 'Read', parameters }] }, bundle);
  assert.deepEqual(json(request).request.tools, [{ functionDeclarations: [{ name: 'read_file', description: 'Read', parametersJsonSchema: parameters }] }]);
  assert.equal(JSON.stringify(parameters), before);
});
await check('Encoded tool names map schema, calls and results consistently', () => {
  const name = 'mcp/server 工具';
  const request = buildGeminiRequest(oauth, {
    ...options, tools: [{ name, parameters: { type: 'object' } }], messages: [user,
      { role: 'assistant', content: [{ type: 'tool-call', id: 'history-id', name, arguments: '{"x":1}' }] },
      { role: 'tool', toolCallId: 'history-id', content: [{ type: 'text', text: 'result' }] },
    ],
  }, bundle);
  const wire = json(request).request.tools[0].functionDeclarations[0].name;
  assert.match(wire, /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/);
  assert.equal(request.context.wireToOriginal.get(wire), name);
  assert.deepEqual(contents(request)[1], { role: 'model', parts: [{ functionCall: { name: wire, args: { x: 1 } } }] });
  assert.deepEqual(contents(request)[2], { role: 'user', parts: [{ functionResponse: { name: wire, response: { output: 'result' } } }] });
});
await check('Parallel same-name calls keep distinct result association and error results', () => {
  const request = buildGeminiRequest(oauth, { ...options, messages: [
    { role: 'assistant', content: [
      { type: 'tool-call', id: 'one', name: 'read', arguments: '{"file":"a"}' },
      { type: 'tool-call', id: 'two', name: 'read', arguments: '{"file":"b"}' },
    ] },
    { role: 'tool', toolCallId: 'two', isError: true, content: [{ type: 'text', text: 'B failed' }] },
    { role: 'tool', toolCallId: 'one', content: [{ type: 'text', text: 'A' }] },
  ] }, bundle);
  assert.equal(contents(request).length, 2);
  assert.deepEqual(contents(request)[1].parts.map((part) => part.functionResponse.response), [{ output: 'A' }, { error: 'B failed' }]);
});
await check('Unknown results, malformed args, images and invalid roles fail', () => {
  syncError(() => buildGeminiRequest(oauth, { ...options, messages: [{ role: 'tool', toolCallId: 'unknown', content: [] }] }, bundle), 'POOL_UNSUPPORTED_CONTENT');
  for (const arguments_ of ['{invalid', '[]', 'null']) syncError(() => buildGeminiRequest(oauth, { ...options, messages: [{ role: 'assistant', content: [{ type: 'tool-call', id: 'call', name: 'test', arguments: arguments_ }] }] }, bundle), 'POOL_UNSUPPORTED_CONTENT');
  syncError(() => buildGeminiRequest(oauth, { ...options, messages: [{ role: 'user', content: [{ type: 'image' }] }] }, bundle), 'POOL_UNSUPPORTED_CONTENT');
  syncError(() => buildGeminiRequest(oauth, { ...options, messages: [{ role: 'system', content: [] }] }, bundle), 'POOL_UNSUPPORTED_CONTENT');
});
await check('Direct native usage separates cached input and retains output thoughts', async () => {
  const chunks = await map([
    candidate([{ text: 'Hel' }]),
    { ...candidate([{ text: 'lo' }], 'STOP'), usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5, cachedContentTokenCount: 40, thoughtsTokenCount: 3 } },
  ]);
  assert.deepEqual(ended(chunks), [{ type: 'text', text: 'Hello' }]);
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text), ['Hel', 'lo']);
  assert.deepEqual(chunks.find((chunk) => chunk.type === 'usage').usage, { inputTokens: 60, outputTokens: 8, cacheReadTokens: 40, cacheWriteTokens: 0, reasoningTokens: 3 });
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } });
});
await check('Native and OAuth Gemini cache usage conserves the prompt total', async () => {
  for (const envelope of [false, true]) {
    for (const [label, total, cached, input] of [
      ['absent cache', 32, undefined, 32],
      ['zero cache', 32, 0, 32],
      ['partial cache', 11, 3, 8],
      ['full cache', 32, 32, 0],
      ['large cached request', 286557, 285184, 1373],
      ['inconsistent cache count', 3, 7, 0],
    ]) {
      const event = { ...candidate([{ text: 'Ok' }], 'STOP'), usageMetadata: {
        promptTokenCount: total, candidatesTokenCount: 50, thoughtsTokenCount: 20,
        ...(cached === undefined ? {} : { cachedContentTokenCount: cached }),
      } };
      const chunks = await map([envelope ? { response: event } : event]);
      const usage = chunks.find((chunk) => chunk.type === 'usage').usage;
      assert.deepEqual(usage, { inputTokens: input, outputTokens: 70, cacheReadTokens: cached ?? 0,
        cacheWriteTokens: 0, reasoningTokens: 20 }, `${envelope ? 'OAuth' : 'native'}: ${label}`);
      if ((cached ?? 0) <= total) {
        assert.equal(usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens, total,
          `${label}: prompt total is conserved without output or thoughts`);
      }
    }
  }
});
await check('OAuth envelope and usage-only trailer are unwrapped', async () => {
  const chunks = await map([
    { response: candidate([{ text: 'Yes' }], 'STOP') },
    { response: { usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 2 } } },
    '[DONE]',
  ]);
  assert.equal(ended(chunks)[0].text, 'Yes');
  assert.equal(chunks.find((chunk) => chunk.type === 'usage').usage.inputTokens, 12);
});
await check('Thinking streams as reasoning and preserves native block order', async () => {
  const chunks = await map([candidate([{ text: 'Think', thought: true }, { text: 'ing', thought: true }, { text: 'Answer' }], 'STOP')]);
  assert.deepEqual(ended(chunks), [{ type: 'reasoning', text: 'Thinking' }, { type: 'text', text: 'Answer' }]);
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text), ['Think', 'ing']);
});
await check('Multiple tools get unique ids and reverse original names', async () => {
  const request = buildGeminiRequest(oauth, { ...options, tools: [{ name: 'unsafe name' }, { name: 'read' }] }, bundle);
  const wire = request.context.originalToWire.get('unsafe name');
  const chunks = await map([candidate([{ functionCall: { name: wire, args: { path: 'a' } } }, { functionCall: { name: 'read', args: { path: 'b' } } }], 'STOP')], request.context);
  const blocks = ended(chunks);
  assert.equal(blocks[0].name, 'unsafe name');
  assert.equal(blocks[1].name, 'read');
  assert.notEqual(blocks[0].id, blocks[1].id);
  assert.equal(blocks[0].arguments, '{"path":"a"}');
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
});

let replayBlocks;
let replayOptions;
let replayNative;
await check('Tool continuation restores native thinking, signatures and provider ids', async () => {
  replayOptions = { ...options, tools: [{ name: 'unsafe name', parameters: { type: 'object' } }] };
  const request = buildGeminiRequest(oauth, replayOptions, bundle);
  const wire = request.context.originalToWire.get('unsafe name');
  replayNative = [
    { thought: true, text: 'Hidden thinking', thoughtSignature: 'mock-reasoning-signature' },
    { text: 'I will read.' },
    { functionCall: { id: 'provider-native-id', name: wire, args: { path: 'a' } }, thoughtSignature: 'mock-call-signature' },
  ];
  const chunks = await map([{ response: candidate(replayNative, 'STOP') }], request.context);
  replayBlocks = ended(chunks);
  const call = replayBlocks.find((block) => block.type === 'tool-call');
  const continuation = buildGeminiRequest(oauth, { ...replayOptions, messages: [user, { role: 'assistant', content: replayBlocks }, { role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: 'result' }] }] }, bundle);
  assert.deepEqual(contents(continuation)[1].parts, replayNative);
  assert.deepEqual(contents(continuation)[2].parts[0].functionResponse, { id: 'provider-native-id', name: wire, response: { output: 'result' } });
});
await check('Dropped DSH reasoning still recovers signed native continuation by call id', () => {
  const filtered = replayBlocks.filter((block) => block.type !== 'reasoning');
  const continuation = buildGeminiRequest(oauth, { ...replayOptions, messages: [{ role: 'assistant', content: filtered }] }, bundle);
  assert.deepEqual(contents(continuation)[0].parts, replayNative);
});
await check('Rotated access token retains replay for the same stable account reference', () => {
  const continuation = buildGeminiRequest(oauth, { ...replayOptions, messages: [{ role: 'assistant', content: replayBlocks }] }, { ...bundle, access_token: 'mock-rotated' });
  assert.deepEqual(contents(continuation)[0].parts, replayNative);
});
await check('Account and model switches never forward prior signatures or provider ids', () => {
  for (const [account, model] of [[{ ...oauth, id: 'gemini-b' }, options.model], [oauth, 'gemini-2.5-flash']]) {
    const continuation = buildGeminiRequest(account, { ...replayOptions, model, messages: [{ role: 'assistant', content: replayBlocks }] }, bundle);
    const body = JSON.stringify(contents(continuation));
    assert.equal(body.includes('thoughtSignature'), false);
    assert.equal(body.includes('Hidden thinking'), false);
    assert.equal(body.includes('provider-native-id'), false);
  }
});
await check('Untrusted raw thoughtSignature is never replayed across accounts', () => {
  const continuation = buildGeminiRequest({ ...oauth, id: 'foreign' }, { ...options, messages: [{ role: 'assistant', content: [{ type: 'tool-call', id: 'untrusted', name: 'read', arguments: '{}', thoughtSignature: 'foreign-secret-signature' }] }] }, bundle);
  assert.equal(JSON.stringify(contents(continuation)).includes('foreign-secret-signature'), false);
});
await check('Signature-only trailing chunks bind to preceding tool part', async () => {
  const request = buildGeminiRequest(oauth, options, bundle);
  const chunks = await map([candidate([{ functionCall: { name: 'read', args: {} } }]), candidate([{ text: '', thoughtSignature: 'mock-tail-signature' }], 'STOP')], request.context);
  const blocks = ended(chunks);
  const continuation = buildGeminiRequest(oauth, { ...options, messages: [{ role: 'assistant', content: blocks }] }, bundle);
  assert.equal(contents(continuation)[0].parts[0].thoughtSignature, 'mock-tail-signature');
});
await check('Expired continuation cache drops private metadata', () => {
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 61 * 60 * 1000;
    const continuation = buildGeminiRequest(oauth, { ...replayOptions, messages: [{ role: 'assistant', content: replayBlocks }] }, bundle);
    assert.equal(JSON.stringify(contents(continuation)).includes('thoughtSignature'), false);
  } finally { Date.now = originalNow; }
});
await check('MAX_TOKENS maps explicitly and cached usage is not accumulated twice', async () => {
  const chunks = await map([
    { ...candidate([{ text: 'Partial' }]), usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 } },
    { ...candidate([], 'MAX_TOKENS'), usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } },
  ]);
  assert.equal(chunks.at(-1).reason.kind, 'max-tokens');
  assert.equal(chunks.find((chunk) => chunk.type === 'usage').usage.inputTokens, 10);
  assert.equal(chunks.find((chunk) => chunk.type === 'usage').usage.outputTokens, 2);
});
await check('Empty, thinking-only and signature-only streams fail', async () => {
  await checkError(map([]), 'POOL_EMPTY_RESPONSE');
  await checkError(map([candidate([], 'STOP')]), 'POOL_EMPTY_RESPONSE');
  await checkError(map([candidate([{ text: 'Only thinking', thought: true }], 'STOP')]), 'POOL_EMPTY_RESPONSE');
  await checkError(map([candidate([{ text: '', thoughtSignature: 'signature' }], 'STOP')]), 'POOL_EMPTY_RESPONSE');
  await checkError(collect(mapGemini(null)), 'POOL_EMPTY_BODY');
});
await check('Truncated and malformed SSE fail even after visible text', async () => {
  await checkError(map([candidate([{ text: 'Partial' }])]), 'POOL_GEMINI_TRUNCATED_STREAM');
  await checkError(map([candidate([{ text: 'Partial' }]), '[DONE]']), 'POOL_GEMINI_TRUNCATED_STREAM');
  await checkError(map([candidate([{ text: 'Partial' }]), '{broken']), 'POOL_GEMINI_INVALID_RESPONSE');
});
await check('Error after apparent terminal success still prevents finish', async () => {
  const chunks = [];
  let error;
  try {
    for await (const chunk of mapGemini(sse(candidate([{ text: 'Partial' }], 'STOP'), { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'private body is omitted' } }), parseSse)) chunks.push(chunk);
  } catch (caught) { error = caught; }
  assert.equal(error.code, 'http-429');
  assert.equal(error.status, 429);
  assert.equal(chunks.some((chunk) => chunk.type === 'finish'), false);
  assert.equal(error.message.includes('private body'), false);
});
await check('Blocked prompt and all failure finish reasons are explicit failures', async () => {
  await checkError(map([{ promptFeedback: { blockReason: 'SAFETY' } }]), 'POOL_GEMINI_BLOCKED');
  for (const reason of ['SAFETY', 'RECITATION', 'MALFORMED_FUNCTION_CALL', 'OTHER', 'UNEXPECTED_TOOL_CALL']) await checkError(map([candidate([{ text: 'Partial' }], reason)]), 'POOL_GEMINI_TERMINAL_ERROR');
  await checkError(map([{ response: { error: { code: 503, status: 'UNAVAILABLE' } } }]), 'http-503');
});
await check('Discovery returns project/tier details without any onboarding request', async () => {
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push(url);
    assert.deepEqual(JSON.parse(init.body).metadata, { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' });
    return Response.json({ cloudaicompanionProject: { id: 'discovered-project' }, currentTier: { id: 'free-tier' }, paidTier: { id: 'paid-tier' }, allowedTiers: [{ id: 'free-tier', isDefault: true }] });
  };
  const result = await ensureGeminiProject({ access_token: 'mock-access' }, { fetchImpl, accountId: 'a' });
  assert.equal(result.projectId, 'discovered-project');
  assert.equal(result.project_id, 'discovered-project');
  assert.equal(result.tierId, 'paid-tier');
  assert.equal(result.requiresOnboarding, false);
  assert.deepEqual(urls, ['https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist']);
  assert.equal(JSON.stringify(result).includes('mock-access'), false);
});
await check('Project discovery coalesces concurrency, caches clones and isolates accounts', async () => {
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async () => { calls++; await pending; return Response.json({ cloudaicompanionProject: 'project', currentTier: 'free-tier' }); };
  const first = ensureGeminiProject(bundle, { fetchImpl, accountId: 'a' });
  const second = ensureGeminiProject(bundle, { fetchImpl, accountId: 'a' });
  assert.equal(calls, 1);
  release();
  const [one, two] = await Promise.all([first, second]);
  one.currentTier = 'modified';
  assert.equal(two.currentTier, 'free-tier');
  assert.equal((await ensureGeminiProject(bundle, { fetchImpl, accountId: 'a' })).currentTier, 'free-tier');
  assert.equal(calls, 1);
  await ensureGeminiProject(bundle, { fetchImpl, accountId: 'b' });
  assert.equal(calls, 2);
});
await check('Project cache expires and OAuth rotation preserves refresh-token isolation', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return Response.json({ cloudaicompanionProject: 'project' }); };
  await ensureGeminiProject(bundle, { fetchImpl, accountId: 'a' });
  await ensureGeminiProject({ ...bundle, access_token: 'rotated' }, { fetchImpl, accountId: 'a' });
  assert.equal(calls, 1);
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 6 * 60 * 1000;
    await ensureGeminiProject(bundle, { fetchImpl, accountId: 'a' });
    assert.equal(calls, 2);
  } finally { Date.now = originalNow; }
});
await check('Missing discovery project reports setup required without onboarding', async () => {
  const calls = [];
  const result = await ensureGeminiProject({ access_token: 'mock-access' }, { fetchImpl: async (url) => { calls.push(url); return Response.json({ allowedTiers: [{ id: 'free-tier', isDefault: true }] }); } });
  assert.equal(result.projectId, undefined);
  assert.equal(result.requiresOnboarding, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endsWith(':loadCodeAssist'), true);
});
await check('Discovery failures preserve HTTP status, retry hint and are not cached', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response('private error body', { status: 429, headers: { 'retry-after': '4' } }); };
  for (let i = 0; i < 2; i++) await assert.rejects(ensureGeminiProject(bundle, { fetchImpl }), (error) => error.status === 429 && error.providerRetryAfterMs === 4000 && !error.message.includes('private'));
  assert.equal(calls, 2);
  await checkError(ensureGeminiProject(bundle, { fetchImpl: async () => new Response('{bad') }), 'POOL_GEMINI_INVALID_RESPONSE');
});
await check('Discovery cancellation prevents work and waiting caller can abort independently', async () => {
  const aborted = new AbortController(); aborted.abort();
  let calls = 0;
  await assert.rejects(ensureGeminiProject(bundle, { signal: aborted.signal, fetchImpl: async () => { calls++; } }), (error) => error.name === 'AbortError');
  assert.equal(calls, 0);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async () => { await pending; return Response.json({ cloudaicompanionProject: 'project' }); };
  const first = ensureGeminiProject(bundle, { fetchImpl, accountId: 'same' });
  const controller = new AbortController();
  const second = ensureGeminiProject(bundle, { fetchImpl, accountId: 'same', signal: controller.signal });
  controller.abort();
  await assert.rejects(second, (error) => error.name === 'AbortError');
  release();
  assert.equal((await first).projectId, 'project');
});

await check('Manual account project overrides the credential bundle', () => {
  assert.equal(json(buildGeminiRequest({ ...oauth, projectId: 'manual-project' }, options, bundle)).project, 'manual-project');
});
await check('Version suffix normalizes once and credential redirects are disabled', () => {
  const internal = buildGeminiRequest({ ...oauth, baseUrl: 'https://mock.invalid/v1internal/' }, options, bundle);
  assert.equal(internal.url, 'https://mock.invalid/v1internal:streamGenerateContent?alt=sse');
  assert.equal(internal.init.redirect, 'error');
  const api = buildGeminiRequest({ id: 'api', authMode: 'api-key', baseUrl: 'http://127.0.0.1:8080/v1beta' }, options, 'mock-api');
  assert.equal(api.url, 'http://127.0.0.1:8080/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse');
  for (const baseUrl of ['http://relay.invalid', 'https://user:password@relay.invalid', 'https://relay.invalid?key=x', 'https://relay.invalid#fragment', 'ftp://relay.invalid', 'https://relay.invalid/v1', 'https://relay.invalid/v1beta']) {
    syncError(() => buildGeminiRequest({ ...oauth, baseUrl }, options, bundle), 'POOL_UNSUPPORTED_CONTENT');
  }
});
await check('Credential and endpoint replacements within the same pool row isolate signatures', async () => {
  const initial = buildGeminiRequest(oauth, options, bundle);
  const blocks = ended(await map([candidate([{ functionCall: { name: 'read', args: {} }, thoughtSignature: 'old-account-signature' }], 'STOP')], initial.context));
  for (const [account, credentials] of [[oauth, { ...bundle, refresh_token: 'another-principal' }], [{ ...oauth, baseUrl: 'https://relay.invalid' }, bundle]]) {
    const request = buildGeminiRequest(account, { ...options, messages: [{ role: 'assistant', content: blocks }] }, credentials);
    assert.equal(JSON.stringify(contents(request)).includes('old-account-signature'), false);
  }
});
await check('Gemini 3 resumed tool histories use documented unsigned history sentinel', () => {
  const request = buildGeminiRequest(oauth, { ...options, model: 'gemini-3.1-pro', messages: [{ role: 'assistant', content: [{ type: 'tool-call', id: 'resumed', name: 'read', arguments: '{}' }] }] }, bundle);
  assert.equal(contents(request)[0].parts[0].thoughtSignature, 'skip_thought_signature_validator');
});
await check('Active Gemini 3 cached real signatures are not replaced by fallback', async () => {
  const opts = { ...options, model: 'gemini-3.1-pro' };
  const first = buildGeminiRequest(oauth, opts, bundle);
  const blocks = ended(await map([candidate([{ functionCall: { name: 'read', args: {} }, thoughtSignature: 'native-signature' }], 'STOP')], first.context));
  const next = buildGeminiRequest(oauth, { ...opts, messages: [{ role: 'assistant', content: blocks }] }, bundle);
  assert.equal(contents(next)[0].parts[0].thoughtSignature, 'native-signature');
});
await check('Discovery sends selected project hint and refuses redirects', async () => {
  await ensureGeminiProject(bundle, { fetchImpl: async (_url, init) => {
    assert.equal(init.redirect, 'error');
    const body = JSON.parse(init.body);
    assert.equal(body.cloudaicompanionProject, 'mock-project');
    assert.equal(body.metadata.duetProject, 'mock-project');
    return Response.json({ currentTier: { id: 'free-tier' } });
  } });
});

await check('Discovery owner cancellation does not cancel another waiting request', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let upstreamSignal;
  const fetchImpl = async (_url, init) => { upstreamSignal = init.signal; await pending; init.signal.throwIfAborted(); return Response.json({ cloudaicompanionProject: 'shared-project' }); };
  const owner = new AbortController();
  const first = ensureGeminiProject(bundle, { fetchImpl, accountId: 'owner', signal: owner.signal });
  const second = ensureGeminiProject(bundle, { fetchImpl, accountId: 'owner' });
  owner.abort();
  await assert.rejects(first, (error) => error.name === 'AbortError');
  assert.equal(upstreamSignal.aborted, false);
  release();
  assert.equal((await second).projectId, 'shared-project');
});
await check('Edited call arguments do not inherit a signature for the original arguments', async () => {
  const request = buildGeminiRequest(oauth, options, bundle);
  const blocks = ended(await map([candidate([{ functionCall: { name: 'read', args: { file: 'a' } }, thoughtSignature: 'original-signature' }], 'STOP')], request.context));
  const edited = blocks.map((block) => ({ ...block, arguments: '{"file":"b"}' }));
  const next = buildGeminiRequest(oauth, { ...options, messages: [{ role: 'assistant', content: edited }] }, bundle);
  assert.equal(JSON.stringify(contents(next)).includes('original-signature'), false);
});

await check('Native gRPC string status/code and numeric codes map to HTTP failures', async () => {
  const cases = [
    [{ code: 'RESOURCE_EXHAUSTED' }, 429], [{ status: 'RESOURCE_EXHAUSTED' }, 429], [{ code: 8 }, 429],
    [{ status: 'UNAUTHENTICATED' }, 401], [{ code: 'PERMISSION_DENIED' }, 403], [{ status: 'INVALID_ARGUMENT' }, 400],
    [{ status: 'UNAVAILABLE' }, 503], [{ status: 'DEADLINE_EXCEEDED' }, 504], [{ code: 429, status: 'UNKNOWN' }, 429],
  ];
  for (const [error, status] of cases) await assert.rejects(map([{ error }]), (caught) => caught.status === status && caught.code === `http-${status}`);
});
await check('Native quota error preserves RetryInfo delay without exposing upstream message', async () => {
  await assert.rejects(map([{ response: { error: {
    status: 'RESOURCE_EXHAUSTED', message: 'mock-private-detail',
    details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '2.5s' }],
  } } }]), (error) => error.status === 429 && error.providerRetryAfterMs === 2500 && !error.message.includes('mock-private-detail'));
  await assert.rejects(map([{ error: { code: 8, details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: { seconds: '4', nanos: 500000000 } }] } }]), (error) => error.providerRetryAfterMs === 4500);
});
await check('MAX_TOKENS keeps complete tool blocks and reports the cap finish reason', async () => {
  const chunks = await map([candidate([{ functionCall: { name: 'read', args: { path: 'complete.json' } } }], 'MAX_TOKENS')]);
  assert.equal(ended(chunks)[0].name, 'read');
  assert.deepEqual(JSON.parse(ended(chunks)[0].arguments), { path: 'complete.json' });
  assert.equal(chunks.at(-1).reason.kind, 'max-tokens');
});

console.log(`\nGemini mock tests: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const { name, error } of failures) console.error(name, error.stack);
  process.exitCode = 1;
}
