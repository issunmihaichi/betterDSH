// Installed DSH contract + real JSONL round trip. ELECTRON_RUN_AS_NODE=1 is
// required for the existing ASAR loader/native persistence helpers. Synthetic
// isolated sessions and mocked HTTP only; never reads live credentials/config.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { createPoolAdapter } from '../lib/adapter.js';
import { createHttpUpstream } from '../lib/upstream.js';
import { createCodexReplayCodec } from '../lib/native/codex-replay.js';
import { hasCodexCompaction } from '../lib/native/codex-compaction.js';
import { createCompactionHistoryResolver, installCodexCompactionBridge, installExternalCompactionReplay, projectCompactionFiles } from '../lib/codex-compaction-bridge.js';
const require = createRequire(import.meta.url);
const installedRoot = 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules';
const load = name => require(`${installedRoot}/${name}/lib/index.js`);
const { Context } = require(`${installedRoot}/@deepseek-ai/cordis`);
const { LlmRuntime, createUserMessage } = load('@deepseek-ai/dsh-llm');
const { BasicCompactionEngine } = load('@deepseek-ai/dsh-compaction-basic');
const { Session, SESSION_FORMAT_VERSION } = load('@deepseek-ai/dsh-session');
const { default: JsonlPersistence } = load('@deepseek-ai/dsh-session-persistence-jsonl');
const fixtureRoot = resolve(process.argv[2] ?? 'C:/Users/Administrator/.dsh/github-repos/Hello-World/_codex-compaction-v2/fixtures');
await mkdir(fixtureRoot, { recursive: true });
const sessionId = randomUUID(), model = 'gpt-6.1-sol';
const row = { id: 'offline-only', createdAt: '2026-01-01T00:00:00Z', credentialRef: 'OFFLINE', platform: 'openai', authMode: 'oauth',
  status: 'active', schedulable: true, concurrency: 4, priority: 100, models: [model] };
const cipher = 'PRIVATE-REMOTE-COMPACTION-FIXTURE';
const credential = { access_token: `fixture.${Buffer.from(JSON.stringify({ iss: 'fixture', sub: 'offline', 'https://api.openai.com/auth': { chatgpt_account_id: 'workspace' } })).toString('base64url')}.sig`, chatgpt_account_id: 'workspace' };
const codec = createCodexReplayCodec(Buffer.alloc(32, 19));
let session = Session.create(sessionId, undefined, { version: SESSION_FORMAT_VERSION, id: sessionId, cwd: fixtureRoot, createdAt: Date.now(), isSeeded: false });
const fileRef = { attachmentId: 'sha256:abcdef0123456789', name: 'fixture.txt', bytes: 5 };
const prefix = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'history '.repeat(10000) }, { type: 'file', attachment: fileRef }] }), { surfaceOp: 'append' });
const tail = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'tail '.repeat(1000) }] }), { surfaceOp: 'append' });
session.append('turn/start', { turn: 1 });
session.append('request/header', { header: { config: { provider: 'pool', model } }, reason: 'initial' });
const ctx = new Context();
const llmFiber = ctx.plugin(LlmRuntime); await llmFiber;
const llm = ctx.get('llm');
let enabled = true, requests = [];
const resolveCompactionHistory = createCompactionHistoryResolver(id => id === session.id ? session : undefined,
  messages => projectCompactionFiles(messages, ref => llm.fileRequestText(ref)));
const upstream = createHttpUpstream({ codexReplayCodec: codec, resolveCodexEncryptedCompaction: () => enabled, resolveCompactionHistory,
  resolveCredential: () => credential, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    const output = body.input.some(item => item.type === 'compaction_trigger')
      ? [{ type: 'compaction', id: 'cmp_fixture', encrypted_content: cipher }]
      : [{ type: 'message', id: 'msg_fixture', status: 'completed', content: [{ type: 'output_text', text: 'offline answer' }] }];
    return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output,
      usage: { input_tokens: 100, output_tokens: 5 } } }) + '\n\n');
  } });
const adapter = createPoolAdapter({ initialAccounts: [row], upstream });
const unregister = llm.registerAdapter(adapter.routesFor(), adapter);
const meter = {
  estimateMessage(message) { return message.content.reduce((n, block) => n + (block.type === 'text' ? Math.ceil(block.text.length / 4) : 100), 0); },
  measure(current) {
    const nodes = current.surface.nodes.map(seq => { const message = current.deriveEventMessage(current.eventAt(seq)); const tokens = message ? this.estimateMessage(message) : 0; return { seq, tokens, heuristicTokens: tokens }; });
    return { nodes, totalTokens: nodes.reduce((sum, node) => sum + node.tokens, 0) };
  },
};
const engine = Object.create(BasicCompactionEngine.prototype);
engine.config = { summarizationProvider: '', summarizationModel: '', maxTokens: 64, modelPolicies: [] };
Object.defineProperty(engine, 'ctx', { value: { llm, tokenMeter: meter, get() {}, waterfall(_name, _payload, next) { return next(); } } });
const agent = { session, options: { provider: 'pool', model } };
const restoreBridge = installCodexCompactionBridge({ engine, llm, enabled: () => enabled, canCompact: () => true, resolveCompactionHistory });
assert.ok(restoreBridge);
await engine.compactRegion(prefix.seq, prefix.seq, agent);
let checkpoint = session.deriveMessages().find(hasCodexCompaction);
assert.ok(checkpoint, 'real Basic engine frames and persists the sidecar without stripping it');
assert.ok(session.log.some(event => event.type === 'compaction/summary' && event.data.summary[0].codexCompaction));
assert.equal(JSON.stringify(session.log).includes(cipher), false);
const firstCheckpointSeq = session.surface.nodes[0];
assert.ok(firstCheckpointSeq > tail.seq, 'replacement prefix has a later seq than retained old tail');
await engine.compactRegion(firstCheckpointSeq, tail.seq, agent);
const latestSummary = session.log.findLast(event => event.type === 'compaction/summary');
assert.deepEqual(latestSummary.data.shadowedSeqs, [firstCheckpointSeq, tail.seq]);
checkpoint = session.deriveMessages().find(hasCodexCompaction);
assert.equal(requests[1].input[1].type, 'compaction', 're-compaction preserves explicit users and consumes the previous native checkpoint');
assert.equal(requests[1].input.at(-1).type, 'compaction_trigger');
assert.equal(resolveCompactionHistory(checkpoint, { sessionId }).length, 2, 'nonmonotonic cited surface restores');
session.append('turn/end', { turn: 1, reason: 'completed' });
const persistenceRoot = join(fixtureRoot, sessionId);
const storageFiber = ctx.plugin(JsonlPersistence, { root: persistenceRoot, compression: 'none' }); await storageFiber;
const backend = ctx.get('sessionPersistence');
const writer = await backend.create(session.header); await writer.append(session.log); await writer.flush();
const artifact = backend.locate(session.header).path; await writer.close(); await storageFiber.dispose();
const text = await readFile(artifact, 'utf8');
assert.equal(text.includes(cipher), false); assert.equal(text.includes(credential.access_token), false);
const freshCtx = new Context();
const freshStorage = freshCtx.plugin(JsonlPersistence, { root: persistenceRoot, compression: 'none' }); await freshStorage;
const reader = await freshCtx.get('sessionPersistence').open(sessionId, 'read');
const restoredLog = await reader.read();
session = Session.fromRestore(sessionId, restoredLog.events, reader.header, reader.inheritedEventCount, restoredLog.eventState);
agent.session = session;
checkpoint = session.deriveMessages().find(hasCodexCompaction);
assert.ok(checkpoint);
await Array.fromAsync(llm.stream({ provider: 'pool', model, sessionId, messages: [checkpoint] }));
assert.equal(requests.at(-1).input.at(-1).type, 'compaction');
assert.equal(requests.at(-1).input.filter(item => item.type === 'message' && item.role === 'user').length, 2, 'user inputs survive repeated native compaction');
enabled = false;
await Array.fromAsync(llm.stream({ provider: 'pool', model, sessionId, messages: [checkpoint] }));
const recovered = requests.at(-1).input;
assert.equal(recovered.length, 2, 'cold original prefix and tail replace nested checkpoints once');
assert.ok(recovered[0].content.some(part => part.text?.includes(llm.fileRequestText(fileRef))), 'late file restores the core public projection');
assert.equal(JSON.stringify(recovered).includes('encrypted context checkpoint'), false);
// Prepared external dispatch stays pinned even after the route now belongs to B.
let aCalls = 0, bCalls = 0, seenMessages;
const external = counter => ({ providerInfo: provider => ({ id: provider, name: provider }), providerRetryPolicy: () => undefined, prepareCall: async (provider, exactModel) => ({ model: { provider, id: exactModel, name: exactModel, inputModalities: ['text'] },
  stream: async function* (call) { counter(); seenMessages = call.messages; yield { type: 'finish', reason: { kind: 'stop' } }; } }) });
const detachA = llm.registerAdapter(['external'], external(() => aCalls++));
const prepared = await llm.prepareCall({ provider: 'external', model }, undefined);
detachA();
const detachB = llm.registerAdapter(['external'], external(() => bCalls++));
const restoreExternal = installExternalCompactionReplay({ llm, isPool: provider => provider === 'pool', resolveCompactionHistory });
assert.ok(restoreExternal);
await Array.fromAsync(prepared.stream({ ...prepared.config, sessionId, messages: [checkpoint] }));
assert.equal(aCalls, 1); assert.equal(bCalls, 0);
assert.equal(seenMessages.some(hasCodexCompaction), false);
assert.equal(seenMessages.length, 2);
restoreExternal(); assert.equal(Object.hasOwn(llm, 'adapterStream'), false, 'service proxy instance wrapper is fully restored');
detachB(); restoreBridge(); unregister(); upstream.dispose();
await reader.close(); await freshStorage.dispose(); await llmFiber.dispose();
console.log('PASS actual Basic engine framing/commit, repeated positional replacement, real JSONL cold restore, native replay, disabled restoration including files, and pinned prepared external dispatch; mock HTTP only.');
