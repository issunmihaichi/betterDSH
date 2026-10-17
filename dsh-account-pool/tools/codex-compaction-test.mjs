import assert from 'node:assert/strict';
import test from 'node:test';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { buildCodexRequest, mapCodex } from '../lib/native/codex.js';
import { CODEX_COMPACTION_KIND, CODEX_COMPACTION_TEXT, expandCodexCompactionMessages } from '../lib/native/codex-compaction.js';
import { createCodexReplayCodec, MAX_CODEX_REPLAY_BYTES } from '../lib/native/codex-replay.js';
import { createHttpUpstream, parseSse } from '../lib/upstream.js';
import { createCompactionHistoryResolver, installCodexCompactionBridge, installExternalCompactionReplay, isCodexCompactionTarget, projectCompactionFiles } from '../lib/codex-compaction-bridge.js';

const key = Buffer.alloc(32, 17), codec = createCodexReplayCodec(key);
const model = 'gpt-6.1-sol', account = { id: 'offline-a', createdAt: '2026-01-01T00:00:00Z', credentialRef: 'FIXTURE', platform: 'openai', authMode: 'oauth' };
const token = tick => `fixture.${Buffer.from(JSON.stringify({ iss: 'fixture', sub: 'owner', iat: tick,
  'https://api.openai.com/auth': { chatgpt_account_id: 'workspace' } })).toString('base64url')}.signature`;
const credential = tick => ({ access_token: token(tick), chatgpt_account_id: 'workspace' });
const options = { model, sessionId: 'offline-session', codexTurnId: 'fixture-turn', messages: [{ role: 'user', content: 'original private history' }] };
const deps = { replayCodec: codec, encryptedCompaction: true };
const retained = { type: 'message', role: 'user', content: [{ type: 'input_text', text: options.messages[0].content }] };
const native = { type: 'compaction', id: 'cmp_fixture', encrypted_content: 'PRIVATE-COMPACTION-CIPHERTEXT' };
const complete = output => ({ type: 'response.completed', response: { id: 'PRIVATE-RESPONSE-ID', status: 'completed', output,
  usage: { input_tokens: 20, input_tokens_details: { cached_tokens: 5 }, output_tokens: 4 } } });
const noise = { type: 'message', content: [{ type: 'output_text', text: 'IGNORE-COMPACTION-NOISE' }] };
const raw = (...events) => new Response(events.map(event => 'data: ' + (typeof event === 'string' ? event : JSON.stringify(event)) + '\n\n').join(''));
const drain = iterable => Array.fromAsync(iterable);
function request(overrides = {}, trusted = deps, row = account, bundle = credential(1)) {
  return buildCodexRequest(row, { ...options, ...overrides }, bundle, trusted);
}
async function compact(...events) {
  const req = request({ purpose: 'compaction', codexCompactionV2: true });
  return drain(mapCodex(raw(...events).body, parseSse, req.context));
}
function checkpoint(response, id = 'checkpoint') {
  return { id, role: 'user', source: { kind: 'compact-checkpoint', compactionId: 'compact-fixture' }, content: [
    { type: 'text', text: 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.\n\n<compacted-summary>' },
    { type: 'text', text: CODEX_COMPACTION_TEXT, codexCompaction: response },
    { type: 'text', text: '</compacted-summary>' },
  ] };
}
async function saved() { return checkpoint((await compact(complete([native]))).at(-1).replayState.response); }

test('v2 trigger requires both trusted opt-in and compaction purpose, preserves tools/instructions', () => {
  const tools = [{ name: 'run', parameters: { type: 'object' } }];
  const req = request({ purpose: 'compaction', codexCompactionV2: true, tools, system: 'same system' });
  const body = JSON.parse(req.init.body);
  assert.equal(req.url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.deepEqual(body.input.at(-1), { type: 'compaction_trigger' });
  assert.equal(body.input[0].content[0].text, 'original private history');
  assert.equal(body.instructions, 'same system');
  assert.equal(body.tools[0].name, 'run');
  assert.equal(req.init.headers['x-codex-beta-features'], 'remote_compaction_v2');
  assert.equal(req.context.scope, request().context.scope);
  for (const overrides of [{}, { purpose: 'compaction' }, { codexCompactionV2: true }, { purpose: 'session-title', codexCompactionV2: true }]) {
    assert.equal(JSON.parse(request(overrides).init.body).input.some(item => item.type === 'compaction_trigger'), false);
  }
  assert.throws(() => request({ purpose: 'compaction', codexCompactionV2: true }, { encryptedCompaction: false }), /safely/);
  assert.throws(() => request({ purpose: 'compaction', codexCompactionV2: true }, { encryptedCompaction: true }), /safely/);
  assert.throws(() => request({ purpose: 'compaction', codexCompactionV2: true, sessionId: undefined }), /safely/);
  const off = request({}, { replayCodec: codec, encryptedCompaction: false });
  assert.equal(off.init.headers['x-codex-beta-features'], undefined);
  assert.deepEqual(off.init, request({}, { replayCodec: codec }).init);
});

test('successful terminal emits only disjoint usage and sealed checkpoint, not provider text/cipher/id', async () => {
  const chunks = await compact({ type: 'response.output_item.done', output_index: 1, item: native }, complete([noise, native]));
  assert.deepEqual(chunks.map(chunk => chunk.type), ['usage', 'finish']);
  assert.deepEqual(chunks[0].usage, { inputTokens: 15, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 0, reasoningTokens: 0 });
  assert.equal(chunks[1].replayState.response.kind, CODEX_COMPACTION_KIND);
  for (const secret of ['PRIVATE-COMPACTION-CIPHERTEXT', 'PRIVATE-RESPONSE-ID', 'IGNORE-COMPACTION-NOISE', token(1)]) assert.equal(JSON.stringify(chunks).includes(secret), false);
  const req = request({ messages: [checkpoint(chunks[1].replayState.response), { role: 'user', content: 'next' }] });
  assert.deepEqual(JSON.parse(req.init.body).input, [retained, native, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] }]);
  assert.equal(JSON.parse(req.init.body).input.some(item => item.type === 'compaction_trigger'), false);
});

test('alias and metadata are retained sealed; no-output completed can finish a done item', async () => {
  const alias = { ...native, type: 'compaction_summary', internal_chat_message_metadata_passthrough: { future: 1 } };
  const chunks = await compact({ type: 'response.output_item.done', output_index: 0, item: alias }, { type: 'response.completed', response: { status: 'completed' } });
  const body = JSON.parse(request({ messages: [checkpoint(chunks.at(-1).replayState.response)] }).init.body);
  assert.deepEqual(body.input, [retained, { ...alias, type: 'compaction' }]);
});

test('EOF/DONE/incomplete/failed/zero/multiple/inconsistent/oversized output never yields a checkpoint', async () => {
  for (const events of [[], ['[DONE]'], [{ type: 'response.output_item.done', output_index: 0, item: native }],
    [complete([])], [complete([native, { ...native, id: 'cmp_second' }])],
    [{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }],
    [{ type: 'response.failed', response: { error: { code: 'invalid_api_key', message: 'PRIVATE-ERROR-CREDENTIAL' } } }],
    [complete([{ ...native, encrypted_content: '' }])], [complete([{ ...native, encrypted_content: 'x'.repeat(MAX_CODEX_REPLAY_BYTES) }])],
    [{ type: 'response.output_item.done', output_index: 0, item: native }, complete([{ ...native, encrypted_content: 'changed' }])],
    [{ type: 'response.output_item.done', output_index: 0, item: native }, complete([])],
    [{ type: 'response.done', response: { output: [native] } }],
  ]) {
    await assert.rejects(compact(...events), error => { assert.equal(error.message.includes('PRIVATE'), false); return true; });
  }
  const abort = new AbortController(); abort.abort();
  const req = request({ purpose: 'compaction', codexCompactionV2: true, signal: abort.signal });
  await assert.rejects(drain(mapCodex(raw(complete([native])).body, parseSse, req.context)), /abort/i);
});

test('cold JSON/key reconstruction and same-principal refresh work, foreign scopes require original history', async () => {
  const message = JSON.parse(JSON.stringify(await saved()));
  const restoredDeps = { encryptedCompaction: true, replayCodec: createCodexReplayCodec(Buffer.from(key)) };
  assert.deepEqual(JSON.parse(request({ messages: [message] }, restoredDeps, account, credential(2)).init.body).input, [retained, native]);
  let restores = 0;
  const trusted = { ...restoredDeps, resolveCompactionHistory: () => { restores++; return options.messages; } };
  for (const [opts, row, bundle, dependencies] of [
    [{ sessionId: 'fork' }, account, credential(1), trusted],
    [{ model: 'different' }, account, credential(1), trusted],
    [{}, { ...account, id: 'other' }, credential(1), trusted],
    [{}, { ...account, baseUrl: 'https://other.fixture' }, credential(1), trusted],
    [{}, account, { ...credential(1), chatgpt_account_id: 'other' }, trusted],
    [{}, account, credential(1), { ...trusted, encryptedCompaction: false }],
    [{}, account, credential(1), { ...trusted, replayCodec: undefined }],
    [{}, account, credential(1), { ...trusted, replayCodec: createCodexReplayCodec(Buffer.alloc(32, 4)) }],
  ]) {
    const body = JSON.parse(request({ ...opts, messages: [message] }, dependencies, row, bundle).init.body);
    assert.equal(body.input[0].content[0].text, 'original private history');
    assert.equal(body.input.some(item => item.type === 'compaction'), false);
    assert.equal(JSON.stringify(body).includes(CODEX_COMPACTION_TEXT), false);
  }
  assert.equal(restores, 8);
  assert.throws(() => request({ messages: [message], sessionId: 'fork' }), /safely/);
});

test('tampered content/envelope/marker cannot be silently dropped or sent as a user instruction', async () => {
  const valid = await saved();
  const variants = [];
  for (const mutate of [m => { m.content[1].codexCompaction.sealed.tag = 'a'.repeat(22); }, m => { m.content[1].text += 'edited'; },
    m => { m.content[0].text = 'edited'; }, m => { delete m.content[1].codexCompaction; }, m => { m.source.kind = 'user'; },
    m => { m.content[1].codexCompaction.version = 9; }]) {
    const message = structuredClone(valid); mutate(message); variants.push(message);
  }
  for (const message of variants) assert.throws(() => request({ messages: [message] }), /safely/);
  assert.throws(() => expandCodexCompactionMessages([valid], { resolveCompactionHistory: () => [valid] }), /safely/);
});

test('resolver uses exact checkpoint and cited original seqs, not supplied ranges or edited text', async () => {
  const message = await saved();
  const original = { id: 'original', role: 'user', source: { kind: 'user' }, content: options.messages[0].content };
  const log = [
    { seq: 0, type: 'user/message', data: original },
    { seq: 1, type: 'compaction/summary', data: { compactionId: message.source.compactionId, shadowedSeqs: [0] } },
    { seq: 2, type: 'user/message', data: message, sourceEventSeqs: [1, 0] },
  ];
  const session = { log, eventAt: seq => log[seq], deriveEventMessage: event => event.type === 'user/message' ? event.data : null };
  const resolve = createCompactionHistoryResolver(id => ['offline-session', 'fork'].includes(id) ? session : undefined);
  assert.deepEqual(resolve(message, options), [original]);
  assert.deepEqual(resolve(message, { sessionId: 'fork' }), [original]);
  assert.throws(() => resolve({ ...message, id: 'not-in-log' }, options), /safely/);
  assert.throws(() => resolve({ ...message, content: [] }, options), /safely/);
  assert.throws(() => resolve(message, { sessionId: 'missing' }), /safely/);
  log[1].data.shadowedSeqs = [2];
  assert.throws(() => resolve(message, options), /safely/);
});

test('HTTP uses trusted setting, disabled/foreign/API-key transport restores original history', async () => {
  let enabled = true, requests = [], imageReads = 0;
  const upstream = createHttpUpstream({ resolveCredential: () => credential(1), codexReplayCodec: codec,
    resolveCodexEncryptedCompaction: () => enabled, resolveCompactionHistory: () => options.messages,
    fetchImpl: async (_url, init) => { const body = JSON.parse(init.body); requests.push({ body, headers: init.headers });
      return raw(complete(body.input.some(item => item.type === 'compaction_trigger') ? [native] : [])); } });
  const chunks = await drain(upstream.stream(account, { ...options, purpose: 'compaction', codexCompactionV2: true }));
  const message = checkpoint(chunks.at(-1).replayState.response);
  await drain(upstream.stream(account, { ...options, messages: [message] }));
  assert.deepEqual(requests.at(-1).body.input, [retained, native]);
  enabled = false;
  await drain(upstream.stream(account, { ...options, messages: [message], encryptedCompaction: true }));
  assert.equal(requests.at(-1).body.input[0].content[0].text, options.messages[0].content);
  assert.equal(requests.at(-1).headers['x-codex-beta-features'], undefined);
  const api = { ...account, authMode: 'api-key', openaiApi: 'responses', baseUrl: 'https://api.fixture/v1' };
  await drain(upstream.stream(api, { ...options, messages: [message] }));
  assert.equal(JSON.stringify(requests.at(-1).body).includes(CODEX_COMPACTION_TEXT), false);
  upstream.dispose();
  const images = createHttpUpstream({ resolveCredential: () => credential(1), codexReplayCodec: codec,
    resolveCodexEncryptedCompaction: () => false,
    resolveCompactionHistory: () => [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'fixture-image', width: 2, height: 2 } }] }],
    resolveAttachments: () => ({ readImageRequest: async () => { imageReads++; return { data: Buffer.from('fixture'), mediaType: 'image/png', width: 2, height: 2 }; } }),
    fetchImpl: async (_url, init) => { requests.push({ body: JSON.parse(init.body) }); return raw(complete([])); } });
  await drain(images.stream(account, { ...options, messages: [message] }));
  assert.equal(imageReads, 1);
  assert.ok(requests.at(-1).body.input[0].content.some(part => part.type === 'input_image'));
  images.dispose();
});

test('Basic summarize hook returns persisted sidecar, preserves text fallback/cancellation and restores on dispose', async () => {
  let enabled = true, originalCalls = 0, calls = 0, fallback = 0;
  const config = { maxTokens: 64, summarizationProvider: '', summarizationModel: '', modelPolicies: [] };
  const engine = { config, regionDependencies() {}, compactRegion() {}, async summarize(input) { originalCalls++; return { summary: [{ type: 'text', text: 'neutral summary' }], input }; } };
  const original = engine.summarize;
  const llm = { async *stream(call) { calls++; assert.equal(call.codexCompactionV2, true); assert.equal(call.messages.length, 1); for (const chunk of await compact(complete([native]))) yield chunk; } };
  const restore = installCodexCompactionBridge({ engine, llm, enabled: () => enabled, canCompact: () => true, onFallback: () => fallback++ });
  const agent = { session: { id: options.sessionId, requestHeader: () => ({ config: { provider: 'pool', model } }), toolHistory: () => [] }, options: {} };
  const result = await engine.summarize({ messages: options.messages }, agent);
  assert.equal(result.summary[0].codexCompaction.kind, CODEX_COMPACTION_KIND);
  assert.equal(JSON.stringify(result).includes(native.encrypted_content), false);
  assert.equal(originalCalls, 0);
  enabled = false;
  assert.equal((await engine.summarize({ messages: options.messages }, agent)).summary[0].text, 'neutral summary');
  assert.equal(calls, 1); assert.equal(originalCalls, 1);
  enabled = true;
  llm.stream = async function* () { throw new Error('PRIVATE-UPSTREAM-TEXT'); };
  await engine.summarize({ messages: options.messages }, agent);
  assert.equal(fallback, 1); assert.equal(originalCalls, 2);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(engine.summarize({ messages: options.messages }, agent, abort.signal), /abort/i);
  assert.equal(originalCalls, 2);
  restore(); assert.equal(engine.summarize, original);
  const adapter = { routesFor: () => ['pool'], listAccounts: () => [account] };
  assert.equal(isCodexCompactionTarget(adapter, { provider: 'pool', model }), true);
  assert.equal(isCodexCompactionTarget({ ...adapter, listAccounts: () => [account, { platform: 'openai', authMode: 'api-key' }] }, { provider: 'pool', model }), false);
});

test('a different configured summarizer retains text contract instead of minting unusable model-scoped ciphertext', async () => {
  let nativeCalls = 0, textCalls = 0;
  const engine = { config: { summarizationProvider: 'pool', summarizationModel: 'other-model', maxTokens: 64, modelPolicies: [] },
    regionDependencies() {}, compactRegion() {}, async summarize() { textCalls++; return { summary: [{ type: 'text', text: 'portable summary' }] }; } };
  const llm = { async *stream() { nativeCalls++; throw Error('Native compaction must not be called for another summarizer model'); } };
  const dispose = installCodexCompactionBridge({ engine, llm, enabled: () => true, canCompact: () => true });
  const agent = { session: { id: options.sessionId, requestHeader: () => ({ config: { provider: 'pool', model } }) }, options: {} };
  assert.equal((await engine.summarize({ messages: options.messages }, agent)).summary[0].text, 'portable summary');
  assert.equal(nativeCalls, 0); assert.equal(textCalls, 1);
  dispose();
});

test('long legal re-compaction chains and nonmonotonic surface order restore without depth/age eviction', async () => {
  const root = await saved(), history = new Map();
  let outer = options.messages[0];
  for (let index = 0; index < 1000; index++) {
    const message = { ...structuredClone(root), id: 'cp-' + index };
    history.set(message.id, [outer]); outer = message;
  }
  assert.deepEqual(expandCodexCompactionMessages([outer], { resolveCompactionHistory: message => history.get(message.id) }), options.messages);
  const log = [{ seq: 0, type: 'user/message', data: { id: 'tail', role: 'user', content: 'tail' } },
    { seq: 1, type: 'user/message', data: { id: 'new-prefix', role: 'user', content: 'prefix' } },
    { seq: 2, type: 'compaction/summary', data: { compactionId: root.source.compactionId, shadowedSeqs: [1, 0] } },
    { seq: 3, type: 'user/message', data: root, sourceEventSeqs: [2, 1, 0] }];
  const session = { log, eventAt: seq => log[seq], deriveEventMessage: event => event.type === 'user/message' ? event.data : null };
  const resolver = createCompactionHistoryResolver(() => session);
  assert.deepEqual(resolver(root, options).map(message => message.content), ['prefix', 'tail']);
});

test('external adapter restoration retains its prepared registration and projects files through current public handle', async () => {
  const message = await saved(), prepared = { registration: { id: 'original-adapter' } };
  let seen;
  const llm = { async *adapterStream(call, captured) { seen = { call, captured }; yield { type: 'finish', reason: { kind: 'stop' } }; } };
  const original = llm.adapterStream;
  const restored = [{ role: 'user', content: [{ type: 'file', attachment: { attachmentId: 'sha256:fixture', name: 'example.txt', bytes: 1 } }] }];
  const project = messages => projectCompactionFiles(messages, ref => 'CURRENT-SAFE-HANDLE:' + ref.attachmentId);
  const dispose = installExternalCompactionReplay({ llm, isPool: provider => provider === 'pool', resolveCompactionHistory: () => project(restored) });
  await drain(llm.adapterStream({ ...options, provider: 'other', messages: [message] }, prepared));
  assert.equal(seen.captured, prepared);
  assert.equal(seen.captured.registration.id, 'original-adapter');
  assert.deepEqual(seen.call.messages[0].content, [{ type: 'text', text: 'CURRENT-SAFE-HANDLE:sha256:fixture' }]);
  await drain(llm.adapterStream({ ...options, provider: 'pool', messages: [message] }, prepared));
  assert.equal(seen.call.messages[0], message);
  assert.throws(() => projectCompactionFiles(restored), /safely/);
  dispose(); assert.equal(llm.adapterStream, original);
});

test('WS advertises v2, full compaction then a fresh ordinary full baseline before next incremental request', async () => {
  const sockets = [], bodies = [], headers = [];
  class Socket extends EventEmitter {
    constructor(_url, opts) { super(); this.readyState = 0; sockets.push(this); headers.push(opts.headers); queueMicrotask(() => { this.readyState = 1; this.emit('open'); }); }
    send(data) {
      const body = JSON.parse(data); bodies.push(body);
      const isCompact = body.input.some(item => item.type === 'compaction_trigger');
      const output = isCompact ? [native] : [{ type: 'message', id: 'msg_ws', status: 'completed', content: [{ type: 'output_text', text: 'answer' }] }];
      queueMicrotask(() => this.emit('message', JSON.stringify({ ...complete(output), response: { ...complete(output).response, id: 'resp_' + bodies.length } }), false));
    }
    close() { this.readyState = 3; this.emit('close'); }
    terminate() { this.close(); }
  }
  const upstream = createHttpUpstream({ codexReplayCodec: codec, resolveCodexEncryptedCompaction: () => true,
    resolveCredential: () => credential(1), webSocketImpl: Socket, fetchImpl: async () => { throw Error('No HTTP fallback expected'); } });
  const row = { ...account, openaiTransport: 'websocket' };
  const prime = await drain(upstream.stream(row, options));
  const primeAssistant = { role: 'assistant', content: [{ type: 'text', text: 'answer' }], source: {
    kind: 'model', provider: 'pool', model, replayState: prime.at(-1).replayState } };
  const compacted = await drain(upstream.stream(row, { ...options, messages: [...options.messages, primeAssistant], purpose: 'compaction', codexCompactionV2: true }));
  assert.equal(bodies[1].input.at(-1).type, 'compaction_trigger');
  const message = checkpoint(compacted.at(-1).replayState.response);
  const first = await drain(upstream.stream(row, { ...options, messages: [message, { role: 'user', content: 'next' }] }));
  assert.equal(bodies[2].previous_response_id, undefined, 'compaction replaces, rather than appends to the old ordinary continuation');
  assert.deepEqual(bodies[2].input.slice(0, 2), [retained, native]);
  const assistant = { role: 'assistant', content: [{ type: 'text', text: 'answer' }], source: { kind: 'model', provider: 'pool', model, replayState: first.at(-1).replayState } };
  await drain(upstream.stream(row, { ...options, messages: [message, { role: 'user', content: 'next' }, assistant, { role: 'user', content: 'later' }] }));
  assert.equal(bodies[3].previous_response_id, 'resp_3');
  assert.equal(bodies[3].input.length, 1);
  assert.equal(headers[0]['x-codex-beta-features'], 'remote_compaction_v2');
  assert.equal(headers[0]['openai-beta'], 'responses_websockets=2026-02-06');
  upstream.dispose();
});
