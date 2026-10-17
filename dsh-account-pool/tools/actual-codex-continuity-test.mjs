// Installed-runtime integration test. Run with ELECTRON_RUN_AS_NODE=1 so the
// existing app.asar loader/native persistence helpers are used, not copied mocks.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { createPoolAdapter } from '../lib/adapter.js';
import { createHttpUpstream } from '../lib/upstream.js';
import { createCodexReplayCodec } from '../lib/native/codex-replay.js';
const require = createRequire(import.meta.url);
const root = 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules';
const installed = name => require(`${root}/${name}/lib/index.js`);
const { Context } = require(`${root}/@deepseek-ai/cordis`);
const { LlmRuntime, assembleAssistantStream, createAssistantMessage, createUserMessage } = installed('@deepseek-ai/dsh-llm');
const { Session, SESSION_FORMAT_VERSION } = installed('@deepseek-ai/dsh-session');
const { default: JsonlPersistence } = installed('@deepseek-ai/dsh-session-persistence-jsonl');
function runtime() {
  const value = Object.create(LlmRuntime.prototype);
  Object.defineProperties(value, {
    ctx: { value: { effect(fn) { const it = fn(); it.next(); return () => it.next(); }, events: { dispatch() { return []; } },
      waterfall(owner, name, options, next) { return next(); }, get() { return undefined; }, logger: { warn() {} } } },
    adapters: { value: new Map() }, directory: { value: new Map() }, discoveries: { value: new Map() },
  });
  return value;
}
const key = Buffer.alloc(32, 6), model = 'gpt-6.1-sol';
const jwt = tick => `fixture.${Buffer.from(JSON.stringify({ iss: 'https://auth.fixture', sub: 'fixture-user', iat: tick,
  'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-workspace' } })).toString('base64url')}.signature`;
const row = { id: 'installed-fixture', label: 'fixture', createdAt: '2026-01-01T00:00:00.000Z', credentialRef: 'INSTALLED_FIXTURE',
  platform: 'openai', authMode: 'oauth', status: 'active', schedulable: true, priority: 100, concurrency: 4, models: [model], consecutiveFailures: 0 };
const privateFixture = 'INSTALLED-PRIVATE-REASONING-FIXTURE';
const r = id => ({ type: 'reasoning', id, encrypted_content: privateFixture });
const text = (value, phase = 'final_answer', id = 'msg_fixture') => ({ type: 'message', id, phase, status: 'completed', content: [{ type: 'output_text', text: value }] });
const tool = { type: 'function_call', id: 'item_fixture', call_id: 'call_fixture', name: 'run', arguments: '{"b":2,"a":1}', status: 'completed' };
const fixtureRoot = resolve(process.argv[2] ?? 'C:/Users/Administrator/.dsh/github-repos/Hello-World/_codex-continuity/fixtures');
await mkdir(fixtureRoot, { recursive: true });
let checks = 0;
for (const [label, output, expected] of [
  ['pure-text with trailing reasoning', [r('rs_before'), text('answer'), r('rs_after')], ['reasoning', 'message', 'reasoning']],
  ['commentary text and tools with repeated reasoning', [r('rs_before'), text('before', 'commentary'), tool, r('rs_after')], ['reasoning', 'message', 'function_call', 'reasoning']],
]) {
  const sessionId = randomUUID();
  let tick = 1, requests = [];
  const upstream = createHttpUpstream({ codexReplayCodec: createCodexReplayCodec(key),
    resolveCredential: () => ({ access_token: jwt(tick), chatgpt_account_id: 'fixture-workspace' }),
    fetchImpl: async (url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } }) + '\n\n');
    },
  });
  const adapter = createPoolAdapter({ initialAccounts: [row], upstream });
  const llm = runtime(); llm.registerAdapter(adapter.routesFor(), adapter);
  const user = createUserMessage({ content: [{ type: 'text', text: 'offline' }], source: { kind: 'user' } });
  const options = { provider: 'pool', model, sessionId, tools: [{ name: 'run' }], messages: [user] };
  const chunks = await Array.fromAsync(llm.stream(options));
  const stream = chunks.map((chunk, index) => ({ type: 'chunk', time: Date.now() + index, chunk }));
  const live = assembleAssistantStream(stream);
  assert.ok(live.replayState, 'installed assembler retains finish replay');
  // Match the installed AgentLoop's settlement path, including embedded stream.
  const message = createAssistantMessage({ content: live.blocks(), source: { provider: 'pool', model, replayState: live.replayState } });
  const session = Session.create(sessionId, undefined, { version: SESSION_FORMAT_VERSION, id: sessionId, cwd: fixtureRoot, createdAt: Date.now(), isSeeded: false });
  session.append('user/message', user, { surfaceOp: 'append' });
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  // Leave a legal open lifecycle prefix: the restart occurs just after settlement,
  // before tools/step closure, exactly the continuity-sensitive crash boundary.
  session.append('assistant/message', { turn: 1, step: 1, message, stream, usage: live.usage }, { surfaceOp: 'append' });
  const ctx = new Context();
  const persistenceRoot = join(fixtureRoot, sessionId);
  const storageFiber = ctx.plugin(JsonlPersistence, { root: persistenceRoot, compression: 'none' });
  await storageFiber;
  const backend = ctx.get('sessionPersistence');
  const writer = await backend.create(session.header);
  await writer.append(session.log);
  await writer.flush();
  const artifact = backend.locate(session.header).path;
  await writer.close();
  await storageFiber.dispose();
  const storedText = await readFile(artifact, 'utf8');
  assert.equal(storedText.includes(privateFixture), false, 'provider ciphertext stays out of raw session JSONL');
  assert.equal(storedText.includes(jwt(1)), false, 'credential never enters session JSONL');
  // New backend, Context, adapter, codec and refreshed bearer: a cold restart.
  const freshCtx = new Context();
  const freshFiber = freshCtx.plugin(JsonlPersistence, { root: persistenceRoot, compression: 'none' });
  await freshFiber;
  const fresh = freshCtx.get('sessionPersistence');
  const reader = await fresh.open(sessionId, 'read');
  const slice = await reader.read();
  const resumed = Session.fromRestore(sessionId, slice.events, reader.header, reader.inheritedEventCount, slice.eventState);
  const restored = resumed.log.find(event => event.type === 'assistant/message').data.message;
  assert.deepEqual(restored.source.replayState, live.replayState);
  tick = 2;
  const restartedUpstream = createHttpUpstream({ codexReplayCodec: createCodexReplayCodec(key),
    resolveCredential: () => ({ access_token: jwt(tick), chatgpt_account_id: 'fixture-workspace' }),
    fetchImpl: async (url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [text('next')] } }) + '\n\n');
    },
  });
  const restartedAdapter = createPoolAdapter({ initialAccounts: [row], initialBindings: adapter.listBindings(), upstream: restartedUpstream });
  const restarted = runtime(); restarted.registerAdapter(restartedAdapter.routesFor(), restartedAdapter);
  const history = [restored];
  if (output.includes(tool)) history.push({ role: 'tool', toolCallId: tool.call_id, content: 'offline result', source: { kind: 'tool', callId: tool.call_id } });
  await Array.fromAsync(restarted.stream({ ...options, messages: history }));
  assert.deepEqual(requests.at(-1).input.slice(0, expected.length).map(item => item.type), expected);
  assert.equal(requests.at(-1).input[0].encrypted_content, privateFixture);
  await Array.fromAsync(restarted.stream({ ...options, sessionId: randomUUID(), messages: history }));
  assert.equal(requests.at(-1).input.some(item => item.type === 'reasoning'), false, 'copied fork rejects private state');
  await reader.close(); await freshFiber.dispose();
  checks++;
  console.log(`ok installed assembler + Agent settlement shape + real JSONL flush/cold restore: ${label}`);
}
console.log(`${checks}/${checks} installed continuity round trips passed; mock HTTP only, no real credentials or sessions`);
