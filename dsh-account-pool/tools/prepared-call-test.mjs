/**
 * PreparedAdapterCall contract against the real pool HTTP transport.
 * All HTTP and credentials are fixtures; this suite never contacts a provider.
 * Runtime-specific freezing/default materialization belongs in the separate
 * installed-LlmRuntime integration suite.
 * Run: node tools/prepared-call-test.mjs
 */
import assert from 'node:assert/strict';
import { createPoolAdapter, POOL_DEFAULT_MAX_TOKENS, POOL_REASONING_EFFORTS } from '../lib/adapter.js';
import { createHttpUpstream } from '../lib/upstream.js';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const clock = { now: () => T0 };
let checks = 0;
let passed = 0;
const failures = [];
async function check(label, fn) {
  checks++;
  try { await fn(); passed++; }
  catch (error) { failures.push({ label, error }); }
}
const messages = [{ role: 'user', content: [{ type: 'text', text: 'fixture request' }] }];
function account(id, extra = {}) {
  return {
    id, platform: 'custom', authMode: 'api-key', baseUrl: `https://${id}.invalid`,
    credentialRef: `FIXTURE_${id}`, status: 'active', schedulable: true,
    priority: 100, weight: 1, concurrency: 4, loadFactor: null,
    models: ['fixture-model'], groups: [], consecutiveFailures: 0,
    errorMessage: '', expiresAt: null, autoPauseOnExpired: true,
    rateLimitResetAt: null, overloadUntil: null, tempUnschedulableUntil: null,
    tempUnschedulableReason: '', lastUsedAt: null, createdAt: iso(T0), updatedAt: iso(T0),
    ...extra,
  };
}
function response(text = 'fixture response') {
  const events = [
    { choices: [{ delta: { content: text }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 7 } },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
}
async function drain(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}
function fixture({ accounts = [account('a1')], groups = [], fetchImpl, bindings = [], modelOverridesFor } = {}) {
  const calls = [];
  const usages = [];
  let credentialReads = 0;
  const upstream = createHttpUpstream({
    defaultMaxTokens: POOL_DEFAULT_MAX_TOKENS,
    resolveCredential: async () => { credentialReads++; return 'fixture-secret'; },
    fetchImpl: async (url, init) => {
      // Record only non-secret request fields. No authorization material enters diagnostics.
      calls.push({ url, signal: init.signal, body: JSON.parse(init.body) });
      return fetchImpl ? fetchImpl(url, init) : response();
    },
  });
  const adapter = createPoolAdapter({
    initialAccounts: accounts, initialGroups: groups, initialBindings: bindings,
    upstream, clock, onUsage: (usage) => usages.push(usage), modelOverridesFor,
  });
  return { adapter, calls, usages, get credentialReads() { return credentialReads; } };
}
function options(provider = 'pool', sessionId = 'session-fixture', extra = {}) {
  return { provider, model: 'fixture-model', messages, sessionId, ...extra };
}
const isAbort = (error) => error?.name === 'AbortError' || ['abort', 'aborted', 'ABORTED'].includes(error?.code);

await check('prepare: advertises exact route/model and detached reasoning metadata without HTTP or reservations', async () => {
  const f = fixture();
  const prepared = await f.adapter.prepareCall('pool', 'fixture-model');
  assert.equal(prepared.model.provider, 'pool');
  assert.equal(prepared.model.id, 'fixture-model');
  assert.equal(prepared.model.defaultMaxTokens, POOL_DEFAULT_MAX_TOKENS);
  assert.deepEqual(prepared.model.reasoning.efforts, POOL_REASONING_EFFORTS);
  assert.equal(typeof prepared.stream, 'function');
  assert.equal(f.calls.length, 0);
  assert.equal(f.credentialReads, 0);
  assert.equal(f.adapter.inflightSnapshot().size, 0);
  assert.equal(f.adapter.listBindings().length, 0);
  prepared.model.reasoning.efforts[0].name = 'mutated fixture';
  assert.equal((await f.adapter.prepareCall('pool', 'fixture-model')).model.reasoning.efforts[0].name, 'Off');
});

await check('main route: prepared HTTP dispatch preserves session, reasoning max, messages and explicit output budget', async () => {
  const f = fixture();
  const prepared = await f.adapter.prepareCall('pool', 'fixture-model');
  const chunks = await drain(prepared.stream(options('pool', 'main-session', { reasoningEffort: 'max', maxTokens: 12345 })));
  assert.equal(chunks.at(-1).reason.kind, 'stop');
  assert.equal(f.calls[0].body.model, 'fixture-model');
  assert.equal(f.calls[0].body.max_tokens, 12345);
  assert.equal(f.calls[0].body.reasoning_effort, 'max');
  assert.deepEqual(f.calls[0].body.messages, [{ role: 'user', content: 'fixture request' }]);
  assert.equal(f.adapter.getBinding('main-session').accountId, 'a1');
  assert.equal(f.usages.length, 1);
  assert.equal(f.usages[0].sessionId, 'main-session');
  assert.equal(f.usages[0].usage.inputTokens, 12);
  assert.equal(f.adapter.inflightSnapshot().size, 0);
});

await check('metadata default: prepared max token ceiling can flow unchanged to the HTTP request', async () => {
  const f = fixture();
  const prepared = await f.adapter.prepareCall('pool', 'fixture-model');
  await drain(prepared.stream(options('pool', 'default-budget', { maxTokens: prepared.model.defaultMaxTokens })));
  assert.equal(f.calls[0].body.max_tokens, 64000);
});

await check('group route: prepared dispatch only uses members, and later session turns remain sticky', async () => {
  const f = fixture({ accounts: [account('outside', { priority: 0 }), account('a1', { groups: ['g'] }), account('a2', { groups: ['g'] })], groups: [{ id: 'g', selectionMode: 'sticky', models: ['fixture-model'] }] });
  const prepared = await f.adapter.prepareCall('pool-g', 'fixture-model');
  assert.equal(prepared.model.provider, 'pool-g');
  await drain(prepared.stream(options('pool-g', 'group-session')));
  assert.ok(f.calls[0].url.startsWith('https://a1.invalid/'));
  f.adapter.upsertAccount({ ...f.adapter.getAccount('a2'), priority: 1 });
  const second = await f.adapter.prepareCall('pool-g', 'fixture-model');
  await drain(second.stream(options('pool-g', 'group-session')));
  assert.ok(f.calls[1].url.startsWith('https://a1.invalid/'));
  assert.equal(f.adapter.getBinding('group-session').accountId, 'a1');
  assert.equal(f.usages.every((usage) => usage.sessionId === 'group-session'), true);
});

await check('unknown group: a prepared call cannot silently use the main pool', async () => {
  const f = fixture();
  const prepared = await f.adapter.prepareCall('pool-missing', 'fixture-model');
  await assert.rejects(() => drain(prepared.stream(options('pool-missing'))), (error) => error.code === 'POOL_EXHAUSTED');
  assert.equal(f.calls.length, 0);
  assert.equal(f.credentialReads, 0);
});

await check('detached dispatch: prepared stream retains its originating adapter after another pool is created', async () => {
  const first = fixture({ accounts: [account('first')] });
  const prepared = await first.adapter.prepareCall('pool', 'fixture-model');
  const detachedStream = prepared.stream;
  const second = fixture({ accounts: [account('second')] });
  await second.adapter.prepareCall('pool', 'fixture-model');
  await drain(detachedStream(options('pool', 'owner-session')));
  assert.equal(first.calls.length, 1);
  assert.ok(first.calls[0].url.startsWith('https://first.invalid/'));
  assert.equal(first.adapter.getBinding('owner-session').accountId, 'first');
  assert.equal(second.calls.length, 0);
  assert.equal(second.adapter.listBindings().length, 0);
});

await check('preparation cancel: already aborted lookup performs no credential or HTTP work', async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => f.adapter.prepareCall('pool', 'fixture-model', controller.signal), isAbort);
  assert.equal(f.credentialReads, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.adapter.inflightSnapshot().size, 0);
});

await check('cancel after prepare: aborted dispatch performs no work and does not cool or bind an account', async () => {
  const f = fixture();
  const controller = new AbortController();
  const prepared = await f.adapter.prepareCall('pool', 'fixture-model', controller.signal);
  const before = f.adapter.getAccount('a1');
  controller.abort();
  await assert.rejects(() => drain(prepared.stream(options('pool', 'cancel-session', { signal: controller.signal }))), isAbort);
  assert.equal(f.calls.length, 0);
  assert.equal(f.credentialReads, 0);
  assert.equal(f.adapter.getAccount('a1'), before);
  assert.equal(f.adapter.getBinding('cancel-session'), undefined);
  assert.equal(f.adapter.inflightSnapshot().size, 0);
});

await check('cancel during fetch: native AbortError never cools accounts or fails over', async () => {
  const controller = new AbortController();
  const f = fixture({ accounts: [account('a1'), account('a2')], fetchImpl: async (_url, init) => {
    controller.abort();
    init.signal.throwIfAborted();
  } });
  const before = f.adapter.listAccounts();
  const prepared = await f.adapter.prepareCall('pool', 'fixture-model');
  await assert.rejects(() => drain(prepared.stream(options('pool', 'active-cancel', { signal: controller.signal }))), isAbort);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.adapter.listAccounts(), before);
  assert.equal(f.adapter.getBinding('active-cancel'), undefined);
  assert.equal(f.adapter.inflightSnapshot().size, 0);
});

await check('failover: prepared group stream cools 429 member, retries another member, and accounts once', async () => {
  const f = fixture({ accounts: [account('outside', { priority: 0 }), account('a1', { groups: ['g'] }), account('a2', { groups: ['g'] })], groups: [{ id: 'g', selectionMode: 'sticky' }], fetchImpl: async (url) => url.startsWith('https://a1.invalid/')
    ? new Response('{"error":{"message":"fixture limit"}}', { status: 429, headers: { 'retry-after': '5' } }) : response('recovered') });
  const prepared = await f.adapter.prepareCall('pool-g', 'fixture-model');
  const chunks = await drain(prepared.stream(options('pool-g', 'failover-session')));
  assert.equal(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''), 'recovered');
  assert.deepEqual(f.calls.map((call) => new URL(call.url).hostname), ['a1.invalid', 'a2.invalid']);
  assert.equal(f.adapter.getAccount('a1').rateLimitResetAt, iso(T0 + 5000));
  assert.equal(f.adapter.getAccount('outside').rateLimitResetAt, null);
  assert.equal(f.adapter.getBinding('failover-session').accountId, 'a2');
  assert.equal(f.usages.length, 1);
  assert.equal(f.usages[0].switches, 1);
  assert.equal(f.usages[0].ok, true);
  assert.equal(f.adapter.inflightSnapshot().size, 0);
});

await check('cancel during credential resolution prevents native HTTP and account cooldown', async () => {
  const controller = new AbortController();
  let reads=0, calls=0;
  const upstream=createHttpUpstream({resolveCredential:async()=>{reads++;controller.abort();return 'fixture-key';},fetchImpl:async()=>{calls++;return response();}});
  const adapter=createPoolAdapter({initialAccounts:[account('a1'),account('a2')],upstream});
  const before=adapter.listAccounts();
  const prepared=await adapter.prepareCall('pool','fixture-model');
  await assert.rejects(()=>drain(prepared.stream(options('pool','credential-cancel',{signal:controller.signal}))),isAbort);
  assert.equal(reads,1);assert.equal(calls,0);assert.deepEqual(adapter.listAccounts(),before);assert.equal(adapter.inflightSnapshot().size,0);
});

await check('capability: native limits are scoped to route and exact model while legacy Anthropic max stays accepted', async () => {
  const f = fixture({ accounts: [account('anthropic', { platform: 'anthropic', groups: ['claude'] }), account('gemini', { platform: 'gemini', groups: ['native'] })], groups: [{ id: 'claude', models: [] }, { id: 'native', models: [] }] });
  const ids = async (provider, model = 'fixture-model') => (await f.adapter.prepareCall(provider, model)).model.reasoning?.efforts.map((effort) => effort.id);
  assert.equal((await ids('pool-claude')).includes('max'), true);
  assert.equal((await ids('pool-native')).includes('max'), false);
  assert.equal((await ids('pool')).includes('max'), false);
  f.adapter.upsertAccount({ ...f.adapter.getAccount('gemini'), models: ['other-model'] });
  assert.equal((await ids('pool')).includes('max'), true);
  assert.equal((await ids('pool', 'other-model')).includes('max'), false);
  assert.equal(f.credentialReads, 0); assert.equal(f.calls.length, 0);
});
await check('capability: API-key OpenAI relay keeps prior max but OAuth Codex excludes it', async () => {
  const f=fixture({accounts:[account('relay',{platform:'openai',authMode:'api-key',groups:['relay']}),account('codex',{platform:'openai',authMode:'oauth',groups:['codex']})],groups:[{id:'relay',models:[]},{id:'codex',models:[]}]});
  assert.equal((await f.adapter.prepareCall('pool-relay','fixture-model')).model.reasoning.efforts.some(x=>x.id==='max'),true);
  assert.equal((await f.adapter.prepareCall('pool-codex','fixture-model')).model.reasoning.efforts.some(x=>x.id==='max'),false);
});
await check('capability: ownerless group and model do not invent supported reasoning controls',async()=>{
  const f=fixture({groups:[{id:'empty',models:['fixture-model']}]});
  for(const [route,model] of [['pool-empty','fixture-model'],['pool-missing','fixture-model'],['pool','other-model']])assert.equal((await f.adapter.prepareCall(route,model)).model.reasoning,undefined);
});
await check('capability: temporary scheduling state cannot widen advertised effort intersection',async()=>{
  const f=fixture({accounts:[account('relay',{platform:'anthropic'}),account('native',{platform:'gemini',status:'disabled',schedulable:false,rateLimitResetAt:iso(T0+60000)})]});
  const info=(await f.adapter.prepareCall('pool','fixture-model')).model;assert.equal(info.reasoning.efforts.some(x=>x.id==='max'),false);assert.equal(info.reasoning.defaultEffort,undefined);
  info.reasoning.efforts[0].name='mutated';assert.equal((await f.adapter.prepareCall('pool','fixture-model')).model.reasoning.efforts[0].name,'Off');
});

await check('capability overrides: HTTP maps wire efforts and off null omits the field with prepared snapshot ownership', async () => {
  let overrides = { 'fixture-model': { name: 'Custom visible name', contextWindow: 1_000_000, input: ['text', 'image'], reasoningEfforts: { off: null, high: 'medium', max: 'provider-max' } } };
  const f = fixture({ modelOverridesFor: () => overrides });
  assert.throws(() => f.adapter.validateModelOverrides({ pool: { modelOverrides: overrides } }), /输入类型/);
  const valid = { pool: { modelOverrides: { 'fixture-model': { input: ['text'], reasoningEfforts: { off: null, high: 'medium' } } } } };
  assert.doesNotThrow(() => f.adapter.validateModelOverrides(valid));
  const prepared = await f.adapter.prepareCall('pool', 'fixture-model');
  assert.equal(prepared.model.name, 'Custom visible name');
  assert.equal(prepared.model.context.contextWindow, 1_000_000);
  assert.deepEqual(prepared.model.inputModalities, ['text']);
  assert.deepEqual(prepared.model.reasoning.efforts.map(x => x.id), ['off', 'high', 'max']);
  overrides = {};
  prepared.model.reasoning.efforts[1].name = 'caller mutation';
  await drain(prepared.stream(options('pool', 'mapped-high', { reasoningEffort: 'high' })));
  assert.equal(f.calls[0].body.reasoning_effort, 'medium');
  await drain(prepared.stream(options('pool', 'mapped-off', { reasoningEffort: 'off' })));
  assert.equal(Object.hasOwn(f.calls[1].body, 'reasoning_effort'), false);
  await drain(prepared.stream(options('pool', 'mapped-custom', { reasoningEffort: 'max' })));
  assert.equal(f.calls[2].body.reasoning_effort, 'provider-max');
  assert.equal((await f.adapter.resolveModel('pool', 'fixture-model')).name, 'fixture-model');
  overrides = { 'fixture-model': { reasoningEfforts: false } };
  const disabled = await f.adapter.prepareCall('pool', 'fixture-model');
  assert.equal(disabled.model.reasoning, undefined);
  await drain(disabled.stream(options('pool', 'disabled-effort', { reasoningEffort: 'high' })));
  assert.equal(Object.hasOwn(f.calls[3].body, 'reasoning_effort'), false);
});
await check('capability overrides: native owners constrain unsupported mapped levels and mixed image input', async () => {
  const override = { 'fixture-model': { input: ['text', 'image'], reasoningEfforts: { off: '', high: 'medium', max: 'unsupported-wire', low: null, xhigh: 'max' } } };
  const native = fixture({ accounts: [account('native', { platform: 'gemini' })], modelOverridesFor: () => override });
  assert.throws(() => native.adapter.validateModelOverrides({ pool: { modelOverrides: override } }), /思考档位映射/);
  const info = await native.adapter.resolveModel('pool', 'fixture-model');
  assert.deepEqual(info.inputModalities, ['text', 'image']);
  assert.deepEqual(info.reasoning.efforts.map(x => x.id), ['off', 'high']);
  native.adapter.upsertAccount(account('generic'));
  assert.deepEqual((await native.adapter.resolveModel('pool', 'fixture-model')).inputModalities, ['text']);
  native.adapter.upsertAccount({ ...native.adapter.getAccount('native'), models: ['other-model'] });
  assert.deepEqual((await native.adapter.resolveModel('pool', 'fixture-model')).reasoning.efforts.map(x => x.id), ['off', 'high', 'xhigh', 'max']);
  const info2 = await native.adapter.resolveModel('pool', 'not-owned');
  assert.equal(info2.reasoning, undefined);
  assert.deepEqual(info2.inputModalities, ['text']);
});

for (const { label, error } of failures) console.error(`FAIL ${label}: ${error.name} (${error.code ?? 'no-code'})`);
console.log(`PreparedAdapterCall: ${passed}/${checks} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
