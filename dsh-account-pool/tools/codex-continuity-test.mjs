import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Buffer } from 'node:buffer';
import { buildCodexRequest, mapCodex } from '../lib/native/codex.js';
import { createHttpUpstream, parseSse } from '../lib/upstream.js';
import { createPoolAdapter } from '../lib/adapter.js';
import { DURATIONS } from '../lib/kernel.js';
import {
  CODEX_REPLAY_KEY_REF, MAX_CODEX_REPLAY_BYTES, MAX_CODEX_REQUEST_REPLAY_BYTES,
  createCodexReplayCodec, loadCodexReplayCodec, codexReplayScope, codexBlockDigest,
} from '../lib/native/codex-replay.js';

// Fixtures only. No real account, credential, model API or external HTTP access.
const key = Buffer.alloc(32, 9);
const codec = createCodexReplayCodec(key);
const jwt = (sub = 'fixture-subject', workspace = 'fixture-workspace', tick = 1, iss = 'https://auth.fixture') =>
  `fixture.${Buffer.from(JSON.stringify({ sub, iss, exp: tick, iat: tick, jti: `j-${tick}`, 'https://api.openai.com/auth': { chatgpt_account_id: workspace } })).toString('base64url')}.signature`;
const credential = { access_token: jwt(), chatgpt_account_id: 'fixture-workspace' };
const account = { id: 'fixture-account', createdAt: '2026-01-01T00:00:00.000Z', credentialRef: 'FIXTURE_ACCOUNT', platform: 'openai', authMode: 'oauth' };
const options = { model: 'gpt-6.1-sol', sessionId: 'fixture-session', messages: [{ role: 'user', content: 'continue' }] };
const request = (opts = options, row = account, bundle = credential, replayCodec = codec) => buildCodexRequest(row, opts, bundle, { replayCodec });
const reasoning = (text = 'provider-private-fixture', id = 'rs_fixture') => ({ type: 'reasoning', id, encrypted_content: text, summary: [{ type: 'summary_text', text: 'SECRET-SUMMARY-FIXTURE' }] });
const message = (text = 'answer', phase = 'final_answer', id = 'msg_fixture') => ({ type: 'message', id, status: 'completed', phase, content: [{ type: 'output_text', text }] });
const call = (id = 'call_fixture', name = 'run', args = '{}') => ({ type: 'function_call', id: `item_${id}`, call_id: id, name, arguments: args, status: 'completed' });
const complete = output => ({ type: 'response.completed', response: { status: 'completed', output } });
const sse = events => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')).body;
const collect = (events, context = request().context) => Array.fromAsync(mapCodex(sse(events), parseSse, context));
function assistant(chunks) {
  const order = chunks.filter(c => c.type === 'block-start').map(c => c.index);
  const blocks = new Map(chunks.filter(c => c.type === 'block-end').map(c => [c.index, c.block]));
  return { role: 'assistant', content: order.map(index => blocks.get(index)), source: {
    kind: 'model', provider: 'pool-fixture', model: options.model, replayState: chunks.at(-1)?.replayState,
  } };
}
const input = (history, opts = {}, row = account, bundle = credential, replayCodec = codec) =>
  JSON.parse(request({ ...options, ...opts, messages: history }, row, bundle, replayCodec).init.body).input;

function store(initial) {
  const values = new Map(initial ? [[CODEX_REPLAY_KEY_REF, initial]] : []);
  const calls = [];
  return { values, calls,
    resolve: async ref => values.has(ref) ? { value: values.get(ref) } : undefined,
    set: async (ref, value) => { calls.push([ref, value]); values.set(ref, value); },
  };
}

test('local replay key is created once, persisted before use and reused across mounts', async () => {
  const credentials = store();
  const first = await loadCodexReplayCodec(credentials);
  assert.equal(credentials.calls.length, 1);
  assert.equal(Buffer.from(credentials.values.get(CODEX_REPLAY_KEY_REF), 'base64url').length, 32);
  const second = await loadCodexReplayCodec(credentials);
  assert.equal(credentials.calls.length, 1);
  const scope = request().context.scope;
  assert.deepEqual(second.open(scope, first.seal(scope, { value: 'durable' })), { value: 'durable' });
});

test('bad, shadowed, missing and unpersisted keys fail with fixed redacted error', async () => {
  const invalid = store('private-invalid-key');
  const cases = [invalid, {}, { resolve: async () => undefined },
    { resolve: async () => { throw new Error('SECRET'); } },
    { resolve: async () => undefined, set: async () => { throw new Error('SECRET'); } },
    { resolve: async () => undefined, set: async () => {} },
    { resolve: async () => ({ value: '' }), set: async () => { assert.fail('must not overwrite'); } },
  ];
  for (const credentials of cases) await assert.rejects(loadCodexReplayCodec(credentials), error =>
    error.code === 'POOL_CODEX_REPLAY_KEY_UNAVAILABLE' && error.message === 'Codex durable replay key is unavailable');
  assert.equal(invalid.calls.length, 0);
});

test('AEAD authenticates scope, key and every field, with strict encoding and size limits', () => {
  const scope = request().context.scope;
  const payload = { encrypted: 'provider-ciphertext', plan: [1, 2] };
  const sealed = codec.seal(scope, payload);
  assert.ok(sealed);
  assert.notDeepEqual(codec.seal(scope, payload), sealed, 'random IV per envelope');
  assert.equal(JSON.stringify(sealed).includes(payload.encrypted), false);
  assert.deepEqual(createCodexReplayCodec(key).open(scope, JSON.parse(JSON.stringify(sealed))), payload);
  assert.equal(codec.open('b'.repeat(64), sealed), undefined);
  assert.equal(createCodexReplayCodec(Buffer.alloc(32, 8)).open(scope, sealed), undefined);
  for (const field of ['iv', 'tag', 'data']) {
    const changed = { ...sealed, [field]: (sealed[field][0] === 'A' ? 'B' : 'A') + sealed[field].slice(1) };
    assert.equal(codec.open(scope, changed), undefined);
    assert.equal(codec.open(scope, { ...sealed, [field]: `${sealed[field]}=` }), undefined);
  }
  assert.equal(codec.open(scope, { get data() { assert.fail('getter must not be invoked'); }, iv: sealed.iv, tag: sealed.tag }), undefined);
  assert.equal(codec.seal(scope, 'x'.repeat(MAX_CODEX_REPLAY_BYTES)), undefined);
  assert.equal(codec.seal('invalid-scope', {}), undefined);
  assert.throws(() => createCodexReplayCodec(Buffer.alloc(31)), /Invalid Codex replay key/);
});

test('stable identity survives normal access-token rotation, not subject/workspace/account changes', () => {
  const scope = request().context.scope;
  assert.equal(request(options, account, { ...credential, access_token: jwt(undefined, undefined, 999) }).context.scope, scope);
  for (const [row, bundle, opts] of [
    [{ ...account, id: 'other' }, credential, options],
    [{ ...account, createdAt: '2026-02-01T00:00:00.000Z' }, credential, options],
    [{ ...account, credentialRef: 'OTHER' }, credential, options],
    [account, { ...credential, access_token: jwt('other') }, options],
    [account, { ...credential, access_token: jwt(undefined, 'other') }, options],
    [account, { ...credential, access_token: jwt(undefined, undefined, 1, 'https://other.fixture') }, options],
    [{ ...account, chatgptAccountId: 'selected-override' }, credential, options],
    [{ ...account, baseUrl: 'https://relay.fixture' }, credential, options],
    [account, credential, { ...options, model: 'other-model' }],
    [account, credential, { ...options, sessionId: 'fork-session' }],
  ]) assert.notEqual(request(opts, row, bundle).context.scope, scope);
  const override = { ...account, chatgptAccountId: 'always-selected' };
  assert.notEqual(request(options, override).context.scope, request(options, override, { ...credential, access_token: jwt(undefined, 'other') }).context.scope);
  const staleId = jwt('stale-subject');
  assert.notEqual(request(options, account, { ...credential, id_token: staleId }).context.scope,
    request(options, account, { ...credential, id_token: staleId, access_token: jwt('new-subject') }).context.scope);
  assert.equal(codexReplayScope(account, credential, 'workspace', 'https://fixture', options.model, undefined), undefined);
});

test('opaque bearer refresh is conservative even if stale id_token remains unchanged', () => {
  const bundle = { ...credential, access_token: 'opaque-one', id_token: jwt() };
  assert.notEqual(request(options, account, bundle).context.scope,
    request(options, account, { ...bundle, access_token: 'opaque-two' }).context.scope);
});

test('content digest ignores JSON formatting but rejects changed values, type and getters', () => {
  const block = { type: 'tool-call', id: 'call_same', name: 'run', arguments: '{"z":1,"a":{"y":2,"x":3}}' };
  assert.equal(codexBlockDigest(block), codexBlockDigest({ ...block, arguments: { a: { x: 3, y: 2 }, z: 1 } }));
  for (const changed of [{ ...block, id: 'other' }, { ...block, name: 'other' }, { ...block, arguments: '{"z":2}' }]) assert.notEqual(codexBlockDigest(block), codexBlockDigest(changed));
  assert.equal(codexBlockDigest({ type: 'text', get text() { assert.fail('getter'); } }), undefined);
  assert.equal(codexBlockDigest({ type: 'tool-call', id: 'a', name: 'b', arguments: { get private() { assert.fail('getter'); } } }), undefined);
});

test('text-only answers and trailing reasoning survive JSON restart, with no private chunk leakage', async () => {
  const chunks = await collect([complete([reasoning(), message(), reasoning('tail-private', 'rs_tail')])]);
  const history = JSON.parse(JSON.stringify([assistant(chunks)]));
  const replay = input(history, {}, account, { ...credential, access_token: jwt(undefined, undefined, 200) }, createCodexReplayCodec(key));
  assert.deepEqual(replay.map(item => item.type), ['reasoning', 'message', 'reasoning']);
  assert.equal(replay[1].phase, 'final_answer');
  assert.equal(replay[2].encrypted_content, 'tail-private');
  for (const privateValue of ['provider-private-fixture', 'tail-private', 'SECRET-SUMMARY-FIXTURE', credential.access_token, 'rs_fixture']) {
    assert.equal(JSON.stringify(chunks).includes(privateValue), false);
    assert.equal(JSON.stringify(history[0].source).includes(privateValue), false);
  }
  assert.equal(replay[0].id, undefined);
  assert.deepEqual(replay[0].summary, []);
});

test('native output order and repeated reasoning occurrences are not deduplicated by ciphertext', async () => {
  const output = [reasoning('same', 'rs_1'), message('before', 'commentary', 'msg_1'), call('call_1'),
    reasoning('same', 'rs_2'), call('call_2'), message('after', 'final_answer', 'msg_2'), reasoning('same', 'rs_3')];
  const chunks = await collect([complete(output)]);
  const replay = input([assistant(chunks), { role: 'tool', toolCallId: 'call_1', content: 'one' }, { role: 'tool', toolCallId: 'call_2', content: 'two' }]);
  assert.deepEqual(replay.map(item => item.type), ['reasoning', 'message', 'function_call', 'reasoning', 'function_call', 'message', 'reasoning', 'function_call_output', 'function_call_output']);
  assert.equal(replay.filter(item => item.type === 'reasoning').length, 3);
  assert.equal(replay[1].phase, 'commentary');
  assert.equal(replay[5].phase, 'final_answer');
});

test('reverse done arrival and completed snapshots still restore original order without duplicate output', async () => {
  const output = [reasoning('one'), message('two', 'commentary'), call('call_three')];
  const chunks = await collect([
    ...output.map((item, output_index) => ({ type: 'response.output_item.done', item, output_index })).reverse(), complete(output),
  ]);
  const restored = input([assistant(chunks)]);
  assert.deepEqual(restored.map(item => item.type), ['reasoning', 'message', 'function_call']);
  assert.equal(restored[1].content[0].text, 'two');
  assert.equal(restored[2].call_id, 'fc_three');
});

test('multiple text parts, split messages and empty text preserve block alignment', async () => {
  const first = { ...message('first', 'commentary', 'msg_one'), content: [{ type: 'output_text', text: 'first' }, { type: 'output_text', text: '' }] };
  const chunks = await collect([complete([first, reasoning(), message('last', 'final_answer', 'msg_two')])]);
  const restored = input([assistant(chunks)]);
  assert.deepEqual(restored.map(item => item.type), ['message', 'reasoning', 'message']);
  assert.deepEqual(restored[0].content.map(part => part.text), ['first', '']);
  assert.equal(restored[2].content[0].text, 'last');
});

test('content edits, truncation, tool removal and malformed envelopes degrade only private replay', async () => {
  const original = assistant(await collect([complete([reasoning(), message('before', 'commentary'), call()]) ]));
  const cases = [];
  for (const mutate of [
    history => { history.content[0].text = 'edited'; },
    history => { history.content.pop(); },
    history => { history.content[1].arguments = '{"changed":true}'; },
    history => { history.content.reverse(); },
    history => { history.source.replayState.response.version = 999; },
    history => { history.source.replayState.response.kind = 'foreign'; },
    history => { history.source.replayState.response.sealed.tag = 'broken'; },
    history => { history.source.replayState = { blocks: [], response: {} }; },
  ]) { const copy = structuredClone(original); mutate(copy); cases.push(copy); }
  for (const history of cases) {
    const restored = input([history]);
    assert.equal(restored.some(item => item.type === 'reasoning'), false);
    assert.equal(restored.filter(item => item.type === 'message').flatMap(item => item.content).map(part => part.text).join(''), history.content.filter(block => block.type === 'text').map(block => block.text).join(''));
  }
  const formatting = structuredClone(original);
  formatting.content[1].arguments = {};
  assert.equal(input([formatting])[0].type, 'reasoning');
});

test('authenticated but structurally invalid replay plans also degrade to neutral content', async () => {
  const chunks = await collect([complete([reasoning(), message()])]);
  const original = assistant(chunks), response = original.source.replayState.response;
  const payload = codec.open(response.scope, response.sealed);
  for (const plan of [[], [{ type: 'unknown' }], [{ type: 'reasoning', encrypted_content: '' }],
    [{ type: 'message', blocks: [0, 0] }], [{ type: 'message', blocks: [7] }],
    [{ type: 'function_call', block: 0 }], [{ type: 'message', blocks: [0], phase: 'other' }],
  ]) {
    const copy = structuredClone(original);
    copy.source.replayState.response.sealed = codec.seal(response.scope, { ...payload, plan });
    assert.equal(input([copy]).some(item => item.type === 'reasoning'), false);
  }
});

test('no-session, title, compaction, review and copied forks do not inherit durable private replay', async () => {
  const history = [assistant(await collect([complete([reasoning(), message()])]))];
  for (const opts of [
    { sessionId: undefined }, { sessionId: 'different-fork' }, { purpose: 'session-title' }, { purpose: 'compaction' }, { purpose: 'probe' }, { purpose: 'unknown-private-purpose' },
    { codexRequestProvenance: { version: 1, kind: 'auto-review', ownerSessionId: options.sessionId, requestId: 'review-request' } },
  ]) {
    const built = request({ ...options, ...opts, messages: history });
    assert.equal(JSON.parse(built.init.body).input.some(item => item.type === 'reasoning'), false);
    const chunks = await collect([complete([reasoning(), message()])], built.context);
    if (opts.sessionId === 'different-fork') {
      assert.ok(chunks.at(-1).replayState);
      assert.notEqual(chunks.at(-1).replayState.response.scope, history[0].source.replayState.response.scope);
    } else assert.equal(chunks.at(-1).replayState, undefined);
  }
});

test('more than 512 tool calls and many messages do not evict active durable state', async () => {
  const output = [reasoning(), ...Array.from({ length: 540 }, (_, index) => call(`call_many_${index}`))];
  const large = assistant(await collect([complete(output)]));
  assert.ok(large.source.replayState);
  assert.equal(input([large]).filter(item => item.type === 'function_call').length, 540);
  const histories = [];
  for (let index = 0; index < 530; index++) histories.push(assistant(await collect([complete([reasoning(), message(`turn-${index}`)])])));
  assert.equal(input(JSON.parse(JSON.stringify(histories))).filter(item => item.type === 'reasoning').length, 530);
});

test('request replay budget retains recent whole envelopes and neutral older text', async () => {
  const size = 3 * 1024 * 1024;
  const history = [];
  for (let index = 0; index < 7; index++) history.push(assistant(await collect([complete([reasoning(`${index}${'x'.repeat(size)}`), message(`turn-${index}`)])])));
  const restored = input(history);
  const privateItems = restored.filter(item => item.type === 'reasoning');
  assert.equal(privateItems.length, Math.floor(MAX_CODEX_REQUEST_REPLAY_BYTES / (size + 1)));
  assert.equal(privateItems[0].encrypted_content[0], '2');
  assert.equal(privateItems.at(-1).encrypted_content[0], '6');
  assert.equal(restored.filter(item => item.type === 'message').length, 7);
});

test('failed, truncated or consumer-cancelled streams never publish successful replay metadata', async () => {
  for (const ending of [{ type: 'response.failed', response: { error: { code: 'server_error' } } },
    { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }, undefined]) {
    const seen = [];
    await assert.rejects(async () => {
      for await (const chunk of mapCodex(sse([
        { type: 'response.output_item.done', output_index: 0, item: reasoning() },
        { type: 'response.output_item.done', output_index: 1, item: message() }, ...(ending ? [ending] : []),
      ]), parseSse, request().context)) seen.push(chunk);
    });
    assert.equal(seen.some(chunk => chunk.replayState), false);
  }
  const iterator = mapCodex(sse([complete([reasoning(), message()])]), parseSse, request().context);
  const first = await iterator.next();
  assert.equal(first.value.type, 'block-start');
  await iterator.return();
  assert.equal((await iterator.next()).done, true);
});

test('HTTP injected codec is used after refresh and cannot be replaced by model-call options', async () => {
  const history = [assistant(await collect([complete([reasoning(), message()])]))];
  let calls = 0, codecs = 0;
  const upstream = createHttpUpstream({
    resolveCredential: async () => ({ ...credential, access_token: jwt(undefined, undefined, 1234) }),
    resolveCodexReplayCodec: async () => { codecs++; return codec; },
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(JSON.parse(init.body).input[0].encrypted_content, 'provider-private-fixture');
      return new Response(sse([complete([reasoning('next-private'), message('next')])]));
    },
  });
  const chunks = await Array.fromAsync(upstream.stream(account, { ...options, messages: history, codexReplayCodec: { seal() { assert.fail('untrusted'); }, open() { assert.fail('untrusted'); } } }));
  assert.equal(calls, 1); assert.equal(codecs, 1); assert.ok(chunks.at(-1).replayState);
  assert.equal(input([assistant(chunks)])[0].encrypted_content, 'next-private');
});

test('Codex sticky binding uses an idle window, renews hits, persists across adapter reconstruction', async () => {
  const clock = { t: Date.parse('2026-01-01T00:00:00Z'), now() { return this.t; } };
  const rows = [account, { ...account, id: 'fixture-b' }].map(row => ({ ...row, status: 'active', schedulable: true, priority: 100, concurrency: 4, models: [options.model], consecutiveFailures: 0 }));
  const bindings = new Map();
  const upstream = { async *stream() { yield { type: 'finish', reason: { kind: 'stop' } }; } };
  const make = () => createPoolAdapter({ initialAccounts: rows, initialBindings: [...bindings.values()], upstream, clock,
    persist: { putBinding: binding => bindings.set(binding.sessionHash, binding) } });
  const first = make();
  await Array.fromAsync(first.stream(options));
  const initial = { ...first.getBinding(options.sessionId) };
  assert.equal(Date.parse(initial.expiresAt) - clock.t, DURATIONS.codexStickyTtlMs);
  clock.t += 2 * 24 * 60 * 60 * 1000;
  await Array.fromAsync(first.stream(options));
  const renewed = first.getBinding(options.sessionId);
  assert.equal(renewed.accountId, initial.accountId);
  assert.equal(Date.parse(renewed.expiresAt) - clock.t, DURATIONS.codexStickyTtlMs);
  assert.ok(Date.parse(renewed.expiresAt) > Date.parse(initial.expiresAt));
  clock.t += 2 * 24 * 60 * 60 * 1000;
  const restarted = make();
  await Array.fromAsync(restarted.stream(options));
  assert.equal(restarted.getBinding(options.sessionId).accountId, initial.accountId);
});

test('cooldown failover never sends account A private replay to account B', async () => {
  const history = [assistant(await collect([complete([reasoning('a-private'), message()])]))];
  const rows = [account, { ...account, id: 'fixture-b' }].map((row, index) => ({ ...row, status: 'active', schedulable: true, priority: 100 + index, concurrency: 4, models: [options.model], consecutiveFailures: 0 }));
  const calls = [];
  const upstream = createHttpUpstream({ codexReplayCodec: codec, resolveCredential: () => credential,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body); calls.push(body);
      if (calls.length === 1) return new Response('', { status: 429 });
      return new Response(sse([complete([message('rescued')])]));
    },
  });
  const adapter = createPoolAdapter({ initialAccounts: rows, upstream });
  await Array.fromAsync(adapter.stream({ ...options, messages: history }));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].input[0].encrypted_content, 'a-private');
  assert.equal(calls[1].input.some(item => item.type === 'reasoning'), false);
  assert.equal(calls[1].input[0].content[0].text, 'answer');
  assert.equal(adapter.getBinding(options.sessionId).accountId, 'fixture-b');
});
