import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCodexRequest, mapCodex, prepareCodexImages } from '../lib/native/codex.js';
import { createHttpUpstream, parseSse } from '../lib/upstream.js';
import { createPoolAdapter } from '../lib/adapter.js';
import { createCodexReplayCodec, MAX_CODEX_REPLAY_BYTES } from '../lib/native/codex-replay.js';
const replayCodec = createCodexReplayCodec(Buffer.alloc(32, 7));

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
function request(account = {}, opts = options, credential = bundle) { return buildCodexRequest(account, opts, credential, { replayCodec }); }
function replayAssistant(chunks) {
  const order = chunks.filter(chunk => chunk.type === 'block-start').map(chunk => chunk.index);
  const blocks = new Map(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => [chunk.index, chunk.block]));
  return { role: 'assistant', content: order.map(index => blocks.get(index)), source: { replayState: chunks.at(-1).replayState } };
}
function jwt(claims) { return `offline.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`; }

function attribution(built) {
  const body = JSON.parse(built.init.body);
  const flat = body.client_metadata;
  const meta = flat && JSON.parse(flat['x-codex-turn-metadata']);
  if (meta) {
    assert.equal(built.init.headers['x-codex-turn-metadata'], flat['x-codex-turn-metadata']);
    for (const [key, value] of Object.entries(flat)) assert.equal(typeof value, 'string', key);
    assert.equal(flat.thread_id, meta.thread_id);
    assert.equal(flat.turn_id, meta.turn_id);
    assert.equal(flat.session_id, meta.session_id);
    assert.equal(flat['x-codex-window-id'], meta.window_id);
    assert.equal(flat.request_kind, undefined, 'classification stays in canonical blob');
    assert.equal(flat.thread_source, undefined, 'source stays in canonical blob');
    assert.equal(flat['x-codex-installation-id'], meta.installation_id);
    assert.equal(built.init.headers['session-id'], meta.session_id);
    assert.equal(built.init.headers['thread-id'], meta.thread_id);
    assert.equal(built.init.headers['x-codex-window-id'], meta.window_id);
    assert.equal(built.init.headers['x-openai-subagent'], flat['x-openai-subagent']);
    assert.equal(built.init.headers['x-codex-parent-thread-id'], meta.parent_thread_id);
    assert.equal(flat['x-codex-parent-thread-id'], meta.parent_thread_id);
    for (const object of [body, flat, meta, built.init.headers]) {
      for (const key of ['x-codex-guardian', 'guardian_credits_requested', 'parent_response_id',
        'analytics_enabled', 'auto_review_enabled', 'turn_trigger']) assert.equal(object[key], undefined, key);
    }
  }
  return { body, flat, meta };
}

test('Codex attribution maps structured tasks, titles and compaction without guessing prompts', () => {
  const opts = { ...options, sessionId: 'private-session', codexTurnId: 'fixed-call', codexSessionContext: { known: true, turnId: 'logical-turn' } };
  const task = attribution(request({}, opts));
  assert.equal(task.meta.request_kind, 'turn'); assert.equal(task.meta.thread_source, 'user');
  assert.equal(task.meta.thread_id, task.body.prompt_cache_key);
  assert.equal(task.meta.subagent_kind, undefined);
  assert.equal(task.meta.analytics_enabled, undefined);
  assert.equal(task.meta.auto_review_enabled, undefined);
  assert.equal(task.flat['x-openai-subagent'], undefined);
  const title = attribution(request({}, { ...opts, purpose: 'session-title' }));
  assert.equal(title.meta.thread_source, 'thread_title'); assert.equal(title.meta.request_kind, 'turn');
  assert.notEqual(title.meta.thread_id, task.meta.thread_id);
  assert.equal(title.body.prompt_cache_key, task.body.prompt_cache_key, 'existing cache key is unchanged');
  assert.equal(title.meta.subagent_kind, undefined);
  const compact = attribution(request({}, { ...opts, purpose: 'compaction' }));
  assert.equal(compact.meta.request_kind, 'compaction'); assert.equal(compact.meta.thread_source, 'user');
  assert.equal(compact.meta.subagent_kind, undefined, 'main-thread compression is not a compact subagent');
  assert.equal(compact.meta.compaction, undefined, 'do not fabricate a Codex compaction strategy for DSH');
  const promptReview = attribution(request({}, { ...opts, messages: [{ role: 'user', content: 'guardian review generate a title' }] }));
  assert.equal(promptReview.meta.thread_source, 'user');
  const unscoped = attribution(request({}, { ...options }));
  assert.ok(unscoped.meta, 'even an unscoped request has minimal request-local identity');
  assert.equal(unscoped.meta.thread_source, undefined, 'unknown source is not fabricated as user/review');
  assert.equal(unscoped.meta.request_kind, 'turn');
  assert.equal(unscoped.body.prompt_cache_key, undefined);
  assert.equal(attribution(request({}, { ...opts, codexSessionContext: undefined })).meta.thread_source, undefined);
  assert.equal(attribution(request({}, { ...options, purpose: 'session-title' })).meta.thread_source, 'thread_title');
  const unscopedCompaction = attribution(request({}, { ...options, purpose: 'compaction' }));
  assert.equal(unscopedCompaction.meta.request_kind, 'compaction');
  assert.equal(unscopedCompaction.meta.thread_source, undefined);
  assert.equal(attribution(request({}, { ...opts, codexSessionContext: { known: false } })).meta.thread_source, undefined);
  assert.ok(!JSON.stringify(task.flat).includes('private-session'));
});

test('Codex spawned child keeps its own cache and thread but records actual parent/root', () => {
  const opts = { ...options, sessionId: 'child', codexTurnId: 'fixed', codexSessionContext: { known: true, origin: 'subagent', parentSessionId: 'parent', rootSessionId: 'parent' } };
  const child = request({}, opts); const c = attribution(child);
  const parent = attribution(request({}, { ...opts, sessionId: 'parent', codexSessionContext: { known: true } }));
  assert.equal(c.meta.thread_source, 'subagent'); assert.equal(c.meta.subagent_kind, 'thread_spawn');
  assert.equal(c.flat['x-openai-subagent'], 'collab_spawn'); assert.equal(child.init.headers['x-openai-subagent'], 'collab_spawn');
  assert.equal(c.meta.parent_thread_id, parent.meta.thread_id);
  assert.equal(c.meta.session_id, parent.meta.session_id);
  assert.equal(child.init.headers['x-codex-parent-thread-id'], c.meta.parent_thread_id);
  assert.notEqual(c.meta.thread_id, parent.meta.thread_id); assert.notEqual(c.body.prompt_cache_key, parent.body.prompt_cache_key);
  assert.equal(child.init.headers.session_id, c.body.prompt_cache_key, 'cache-routing header retains existing child affinity');
  const sibling = attribution(request({}, { ...opts, sessionId: 'sibling' }));
  assert.notEqual(sibling.meta.thread_id, c.meta.thread_id);
  const compact = attribution(request({}, { ...opts, purpose: 'compaction' }));
  assert.equal(compact.meta.request_kind, 'compaction'); assert.equal(compact.meta.thread_source, 'subagent');
  const title = attribution(request({}, { ...opts, purpose: 'session-title' }));
  assert.equal(title.meta.thread_source, 'thread_title'); assert.equal(title.flat['x-openai-subagent'], undefined);
  assert.equal(title.meta.session_id, c.meta.session_id, 'title preserves the current child root session');
  assert.equal(title.meta.subagent_kind, undefined);
  assert.equal(title.meta.parent_thread_id, undefined);
  assert.notEqual(title.meta.thread_id, c.meta.thread_id);
  assert.equal(title.body.prompt_cache_key, c.body.prompt_cache_key);
  assert.equal(title.flat['x-codex-parent-thread-id'], undefined);
  assert.equal(child.init.headers['session-id'], parent.meta.session_id);
  assert.notEqual(child.init.headers['session-id'], child.init.headers.session_id, 'canonical root and legacy child cache differ');
});

test('Codex turn metadata is stable across tool sampling and OAuth refresh, isolated by account', () => {
  const opts = { ...options, sessionId: 'thread', codexSessionContext: { known: true, turnId: 'thread:turn:1' } };
  const meta = attribution(request({ id: 'a' }, opts)).meta;
  const toolSampling = attribution(request({ id: 'a' }, { ...opts, messages: [...opts.messages, { role: 'assistant', content: 'first step' }] }, { ...bundle, access_token: 'refreshed' })).meta;
  assert.deepEqual(toolSampling, meta);
  const next = attribution(request({ id: 'a' }, { ...opts, codexSessionContext: { known: true, turnId: 'thread:turn:2' } })).meta;
  assert.equal(next.thread_id, meta.thread_id); assert.notEqual(next.turn_id, meta.turn_id);
  assert.notEqual(attribution(request({ id: 'b' }, opts)).meta.turn_id, meta.turn_id);
});

test('Codex provenance is captured before credential I/O and survives retries without live session', async () => {
  let lookups = 0; const bodies = [];
  const upstream = createHttpUpstream({ resolveCredential: async () => bundle,
    resolveCodexSession: () => { lookups++; return { known: true, origin: 'subagent', parentSessionId: 'root', rootSessionId: 'root' }; },
    fetchImpl: async (url, init) => { bodies.push(JSON.parse(init.body)); return new Response(stream([complete()])); },
  });
  const opts = { ...options, sessionId: 'child' }; const account = { id: 'a', platform: 'openai', authMode: 'oauth' };
  await Array.fromAsync(upstream.stream(account, opts)); await Array.fromAsync(upstream.stream(account, opts));
  assert.equal(lookups, 1); assert.deepEqual(bodies[0].client_metadata, bodies[1].client_metadata);
});

test('Codex real retry/failover path preserves captured provenance and cache scope', async () => {
  let lookups = 0; const requests = [];
  const upstream = createHttpUpstream({ resolveCredential: () => bundle,
    resolveCodexSession: () => { lookups++; return { known: true, origin: 'subagent', parentSessionId: 'parent', rootSessionId: 'parent' }; },
    fetchImpl: async (url, init) => {
      requests.push({ headers: init.headers, body: JSON.parse(init.body) });
      if (requests.length === 1) return new Response('{}', { status: 503 });
      if (requests.length === 2) return new Response('{}', { status: 429 });
      return new Response(stream([complete()]));
    },
  });
  const row = id => ({ id, platform: 'openai', authMode: 'oauth', status: 'active', schedulable: true, concurrency: 1, models: ['gpt-5.3-codex'], priority: id === 'first' ? 100 : 0 });
  const pool = createPoolAdapter({ initialAccounts: [row('first'),row('second')], upstream, requestRetries: 1, retryWait: async () => {} });
  await Array.fromAsync(pool.stream({ ...options, provider: 'pool', sessionId: 'child' }));
  assert.equal(requests.length, 3); assert.equal(lookups, 1, 'failover does not reread a possibly torn-down child');
  assert.deepEqual(requests[0].body.client_metadata, requests[1].body.client_metadata, 'same-account retry is stable');
  const first = JSON.parse(requests[0].body.client_metadata['x-codex-turn-metadata']);
  const last = JSON.parse(requests[2].body.client_metadata['x-codex-turn-metadata']);
  assert.equal(last.thread_source, 'subagent'); assert.equal(last.subagent_kind, 'thread_spawn');
  assert.notEqual(first.thread_id, last.thread_id, 'failover retains account isolation');
  assert.notEqual(requests[0].body.prompt_cache_key, requests[2].body.prompt_cache_key);
  assert.equal(pool.inflightSnapshot().size, 0);
});

test('Codex review sidecar is explicit, owner-parented, root-scoped and never a persistent cache', () => {
  const account = { id: 'review-scope' };
  const sidecar = { version: 1, kind: 'auto-review', ownerSessionId: 'owner-child', requestId: 'review-1' };
  const context = { known: true, origin: 'subagent', parentSessionId: 'grandparent', rootSessionId: 'root', turnId: 'owner-turn' };
  const opts = { ...options, codexRequestProvenance: sidecar, codexSessionContext: context };
  const built = request(account, opts); const review = attribution(built);
  const root = attribution(request(account, { ...options, sessionId: 'root' }));
  const owner = attribution(request(account, { ...options, sessionId: 'owner-child', codexSessionContext: context }));
  assert.equal(review.meta.request_kind, 'turn');
  assert.equal(review.meta.thread_source, 'guardian_review');
  assert.equal(review.flat['x-openai-subagent'], 'guardian');
  assert.equal(review.meta.subagent_kind, undefined, 'Internal Guardian is not thread_spawn');
  assert.equal(review.meta.session_id, root.meta.session_id);
  assert.equal(review.meta.parent_thread_id, owner.meta.thread_id, 'parent is the actual owner, not its parent/root');
  for (const key of ['thread_id', 'turn_id', 'window_id']) assert.notEqual(review.meta[key], owner.meta[key], key);
  assert.equal(review.body.prompt_cache_key, undefined);
  assert.equal(built.init.headers.session_id, undefined);
  assert.ok(!JSON.stringify(review.flat).includes('owner-child'));
  assert.ok(!JSON.stringify(review.flat).includes('review-1'));
  assert.deepEqual(attribution(request(account, opts, { ...bundle, access_token: 'refreshed-review-token' })).meta, review.meta);
  const next = attribution(request(account, { ...opts, codexRequestProvenance: { ...sidecar, requestId: 'review-2' } }));
  for (const key of ['thread_id', 'turn_id', 'window_id']) assert.notEqual(next.meta[key], review.meta[key], key);
  assert.equal(next.meta.parent_thread_id, review.meta.parent_thread_id);
  assert.equal(next.meta.session_id, review.meta.session_id);
  for (const unknown of [undefined, { known: false, rootSessionId: 'fake-root', origin: 'subagent' }]) {
    const fallback = attribution(request(account, { ...opts, codexSessionContext: unknown }));
    assert.equal(fallback.meta.session_id, owner.body.prompt_cache_key);
    assert.equal(fallback.meta.parent_thread_id, owner.meta.thread_id);
    assert.equal(fallback.meta.thread_source, 'guardian_review');
    assert.equal(fallback.meta.subagent_kind, undefined);
  }
  const explicit = attribution(request(account, { ...opts, sessionId: 'owner-child' }));
  assert.equal(explicit.meta.request_kind, 'turn');
  assert.equal(explicit.meta.thread_source, 'guardian_review', 'review wins over inherited user/spawn classification');
  assert.equal(explicit.body.prompt_cache_key, undefined, 'even an explicit owner session cannot persist review cache');
  for (const purpose of ['session-title', 'compaction', 'other-purpose']) {
    const conflicting = attribution(request(account, { ...opts, sessionId: 'owner-child', purpose }));
    assert.equal(conflicting.meta.thread_source, purpose === 'session-title' ? 'thread_title' : 'subagent');
    assert.equal(conflicting.meta.request_kind, purpose === 'compaction' ? 'compaction' : 'turn');
    assert.equal(conflicting.body.prompt_cache_key, owner.body.prompt_cache_key, 'sidecar cannot relabel a different explicit purpose');
    assert.notEqual(conflicting.flat['x-openai-subagent'], 'guardian');
    if (purpose === 'session-title') { assert.equal(conflicting.meta.parent_thread_id, undefined); assert.equal(conflicting.meta.subagent_kind, undefined); }
  }
  for (const sessionId of ['unrelated-session', null, '', 123]) {
    const conflicting = attribution(request(account, { ...opts, sessionId }));
    const ordinary = attribution(request(account, { ...options, sessionId, codexSessionContext: context }));
    assert.equal(conflicting.meta.thread_source, ordinary.meta.thread_source, 'conflicting generic session never guesses a review owner');
    assert.equal(conflicting.meta.parent_thread_id, ordinary.meta.parent_thread_id);
    assert.equal(conflicting.body.prompt_cache_key, ordinary.body.prompt_cache_key);
    assert.equal(conflicting.flat['x-openai-subagent'], 'collab_spawn');
  }
  const main = attribution(request(account, { ...opts, codexSessionContext: { known: true, rootSessionId: 'owner-child' } }));
  assert.equal(main.meta.thread_source, 'guardian_review');
  assert.equal(main.meta.session_id, owner.body.prompt_cache_key);
  for (const scoped of [request({ id: 'other-row' }, opts), request(account, opts, { ...bundle, chatgpt_account_id: 'other-workspace' }),
    request({ ...account, baseUrl: 'https://offline-review.example' }, opts)]) {
    const other = attribution(scoped).meta;
    for (const key of ['installation_id', 'session_id', 'parent_thread_id', 'thread_id', 'turn_id', 'window_id']) assert.notEqual(other[key], review.meta[key], key);
  }
});

test('Codex invalid and unsafe sidecars never trigger review or fabricate an unknown source', () => {
  const valid = { version: 1, kind: 'auto-review', ownerSessionId: 'owner', requestId: 'id' };
  const unsafe = { toString() { throw new Error('must not coerce provenance'); } };
  const accessor = { ...valid };
  Object.defineProperty(accessor, 'requestId', { get() { throw new Error('must not invoke accessor'); } });
  for (const sidecar of [undefined, null, 'auto-review', 1, [], {}, { ...valid, version: '1' }, { ...valid, version: 2 },
    { ...valid, kind: 'guardian' }, { ...valid, ownerSessionId: '' }, { ...valid, ownerSessionId: ' \t\r\n ' },
    { ...valid, ownerSessionId: unsafe }, { ...valid, requestId: '' }, { ...valid, requestId: ' \t ' },
    { ...valid, requestId: new String('boxed') }, accessor, Object.create(valid)]) {
    const built = request({}, { ...options, codexTurnId: 'fixed-invalid', codexRequestProvenance: sidecar });
    const unknown = attribution(built);
    assert.equal(unknown.meta.thread_source, undefined);
    assert.equal(unknown.meta.parent_thread_id, undefined);
    assert.equal(unknown.flat['x-openai-subagent'], undefined);
    assert.equal(unknown.body.prompt_cache_key, undefined);
    assert.equal(built.init.headers.session_id, undefined);
    const task = attribution(request({}, { ...options, sessionId: 'task', codexSessionContext: { known: true }, codexRequestProvenance: sidecar }));
    assert.equal(task.meta.thread_source, 'user', 'invalid sidecar does not override a known task');
  }
  const cyclic = { ...valid, ignored: unsafe }; cyclic.extra = cyclic;
  assert.equal(attribution(request({}, { ...options, codexRequestProvenance: cyclic })).meta.thread_source, 'guardian_review');
  const untrustedContext = { origin: 'subagent', rootSessionId: unsafe, parentSessionId: unsafe, turnId: unsafe };
  assert.equal(attribution(request({}, { ...options, codexSessionContext: untrustedContext })).meta.thread_source, undefined);
});

test('Codex no-session metadata is minimal and request-local without legacy cache routing', async () => {
  const first = attribution(request()); const next = attribution(request());
  assert.deepEqual(Object.keys(first.meta).sort(), ['installation_id', 'request_kind', 'session_id', 'thread_id', 'turn_id', 'window_id']);
  for (const key of ['session_id', 'thread_id', 'turn_id', 'window_id']) assert.notEqual(first.meta[key], next.meta[key], key);
  assert.equal(first.meta.installation_id, next.meta.installation_id);
  assert.equal(first.meta.thread_source, undefined);
  const calls = [];
  const upstream = createHttpUpstream({ resolveCredential: () => bundle,
    fetchImpl: async (url, init) => { calls.push(attribution({ init })); return new Response(stream([complete()])); },
  });
  const account = { id: 'unscoped', platform: 'openai', authMode: 'oauth' }; const opts = { ...options };
  await Array.fromAsync(upstream.stream(account, opts)); await Array.fromAsync(upstream.stream(account, opts));
  await Array.fromAsync(upstream.stream(account, { ...options }));
  assert.deepEqual(calls[0].meta, calls[1].meta, 'WeakMap retains request-local fallback identity on repeated attempts');
  assert.notEqual(calls[0].meta.thread_id, calls[2].meta.thread_id, 'a new request is not a persistent thread');
  for (const call of calls) { assert.equal(call.body.prompt_cache_key, undefined); assert.equal(call.meta.thread_source, undefined); }
});

test('Codex review snapshot precedes credential refresh and image await, and reuses primitive identity', async () => {
  const account = { id: 'snapshot-review', platform: 'openai', authMode: 'oauth' };
  const originalReview = { version: 1, kind: 'auto-review', ownerSessionId: 'owner', requestId: 'review-snapshot' };
  const originalContext = { known: true, origin: 'subagent', parentSessionId: 'root', rootSessionId: 'root', turnId: 'owner-turn' };
  const liveReview = { ...originalReview }; const liveContext = { ...originalContext };
  const opts = { ...options, codexRequestProvenance: liveReview, messages: [{ role: 'user', content: [durableImage] }] };
  const calls = []; const lookups = []; let credentials = 0; let images = 0;
  const upstream = createHttpUpstream({
    resolveCodexSession: id => { lookups.push(id); return liveContext; },
    resolveCredential: async () => {
      credentials++;
      assert.equal(lookups.length, 1, 'resolver/snapshot runs before the first credential await');
      await Promise.resolve();
      liveReview.ownerSessionId = 'mutated-credential-owner'; liveReview.requestId = 'mutated-credential-id';
      liveContext.rootSessionId = 'mutated-credential-root'; liveContext.turnId = 'mutated-credential-turn';
      opts.codexRequestProvenance = { version: 2 }; opts.purpose = 'compaction';
      return { ...bundle, access_token: `offline-refresh-${credentials}` };
    },
    resolveAttachments: () => ({ async readImageRequest() {
      images++;
      await Promise.resolve();
      liveReview.kind = 'not-review'; liveContext.known = false;
      liveContext.parentSessionId = 'mutated-image-parent'; liveContext.origin = 'user';
      return { data: Buffer.from(pngData, 'base64'), mediaType: 'image/png', width: 1, height: 1 };
    } }),
    fetchImpl: async (url, init) => { calls.push({ built: { init }, ...attribution({ init }) }); return new Response(stream([complete()])); },
  });
  await Array.fromAsync(upstream.stream(account, opts)); await Array.fromAsync(upstream.stream(account, opts));
  assert.deepEqual(lookups, ['owner']); assert.equal(credentials, 2); assert.equal(images, 2);
  const expected = attribution(request(account, { ...options, codexRequestProvenance: originalReview, codexSessionContext: originalContext }));
  for (const call of calls) {
    assert.deepEqual(call.meta, expected.meta, 'no live sidecar/session references survive credential/image awaits');
    assert.equal(call.body.prompt_cache_key, undefined);
    assert.equal(call.built.init.headers.session_id, undefined);
    assert.ok(call.body.input[0].content.some(part => part.type === 'input_image'));
  }
  assert.notEqual(calls[0].built.init.headers.authorization, calls[1].built.init.headers.authorization);
  assert.equal(Object.hasOwn(opts, 'sessionId'), false, 'owner does not escape into original adapter options');
});

test('Codex ordinary snapshot copies primitive fields rather than retaining mutable resolver/options', async () => {
  const account = { id: 'snapshot-child', platform: 'openai', authMode: 'oauth' };
  const live = { known: true, origin: 'subagent', parentSessionId: 'parent', rootSessionId: 'root', turnId: 'logical-turn' };
  const original = { ...live }; const opts = { ...options, sessionId: 'child' }; const calls = [];
  const upstream = createHttpUpstream({ resolveCodexSession: id => { assert.equal(id, 'child'); return live; },
    resolveCredential: async () => {
      await Promise.resolve(); Object.assign(live, { known: false, origin: 'user', parentSessionId: 'mutated', rootSessionId: 'mutated', turnId: 'mutated' });
      opts.sessionId = 'mutated'; opts.purpose = 'session-title'; return bundle;
    },
    fetchImpl: async (url, init) => { calls.push(attribution({ init })); return new Response(stream([complete()])); },
  });
  await Array.fromAsync(upstream.stream(account, opts)); await Array.fromAsync(upstream.stream(account, opts));
  const expected = attribution(request(account, { ...options, sessionId: 'child', codexSessionContext: original }));
  for (const call of calls) { assert.deepEqual(call.meta, expected.meta); assert.equal(call.body.prompt_cache_key, expected.body.prompt_cache_key); }
});

test('Codex review real 503 retry and 429 failover preserve snapshots without owner sticky binding', async () => {
  const calls = []; const lookups = []; const records = []; const bindings = [];
  const sidecar = { version: 1, kind: 'auto-review', ownerSessionId: 'owner', requestId: 'review-retry' };
  const upstream = createHttpUpstream({ resolveCredential: () => bundle,
    resolveCodexSession: id => { lookups.push(id); return { known: true, origin: 'subagent', parentSessionId: 'root', rootSessionId: 'root', turnId: 'owner-turn' }; },
    fetchImpl: async (url, init) => {
      calls.push({ built: { init }, ...attribution({ init }) });
      sidecar.ownerSessionId = 'torn-down'; sidecar.requestId = 'changed';
      if (calls.length === 1) return new Response('{}', { status: 503 });
      if (calls.length === 2) return new Response('{}', { status: 429 });
      return new Response(stream([complete()]));
    },
  });
  const row = id => ({ id, platform: 'openai', authMode: 'oauth', status: 'active', schedulable: true,
    concurrency: 1, models: [options.model], priority: id === 'first' ? 100 : 0 });
  const pool = createPoolAdapter({ initialAccounts: [row('first'), row('second')], upstream,
    requestRetries: 1, retryWait: async () => {}, onUsage: record => records.push(record),
    persist: { putBinding: binding => bindings.push(binding) } });
  const opts = { ...options, provider: 'pool', codexRequestProvenance: sidecar };
  await Array.fromAsync(pool.stream(opts));
  assert.equal(calls.length, 3, 'only the requested attempts; no prewarm/history traffic');
  assert.deepEqual(lookups, ['owner'], 'same options use the captured owner even after failover');
  assert.deepEqual(calls[0].meta, calls[1].meta, 'same-account retry identity is immutable');
  for (const call of calls) {
    assert.equal(call.meta.thread_source, 'guardian_review'); assert.equal(call.flat['x-openai-subagent'], 'guardian');
    assert.equal(call.meta.subagent_kind, undefined); assert.equal(call.body.prompt_cache_key, undefined);
    assert.equal(call.built.init.headers.session_id, undefined);
  }
  const expectedLast = attribution(request(row(records.at(-1).accountId), { ...options,
    codexRequestProvenance: { version: 1, kind: 'auto-review', ownerSessionId: 'owner', requestId: 'review-retry' },
    codexSessionContext: { known: true, rootSessionId: 'root' } }));
  assert.deepEqual(calls[2].meta, expectedLast.meta, 'failover retains captured request/owner with fresh account scope');
  for (const key of ['session_id', 'thread_id', 'turn_id', 'window_id', 'parent_thread_id']) assert.notEqual(calls[0].meta[key], calls[2].meta[key], key);
  assert.equal(bindings.length, 0); assert.equal(records.at(-1).sessionId, '');
  assert.equal(Object.hasOwn(opts, 'sessionId'), false); assert.equal(pool.inflightSnapshot().size, 0);
});

test('Only OpenAI OAuth consumes the private review sidecar or calls the session resolver', async () => {
  const calls = [];
  const upstream = createHttpUpstream({ resolveCredential: () => 'offline-api-key',
    resolveCodexSession: () => { throw new Error('must not resolve a non-Codex session'); },
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return new Response(stream(url.endsWith('/responses') ? [complete()] : [{ choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]']));
    },
  });
  const opts = { ...options, codexRequestProvenance: { version: 1, kind: 'auto-review', ownerSessionId: 'owner', requestId: 'review' } };
  await Array.fromAsync(upstream.stream({ platform: 'openai', authMode: 'apikey' }, opts));
  await Array.fromAsync(upstream.stream({ platform: 'openai', authMode: 'apikey', openaiApi: 'responses' }, opts));
  for (const call of calls) {
    assert.equal(call.body.codexRequestProvenance, undefined); assert.equal(call.body.client_metadata, undefined);
    assert.equal(call.init.headers['x-openai-subagent'], undefined); assert.equal(call.init.headers['session-id'], undefined);
    assert.equal(call.init.headers['x-codex-turn-metadata'], undefined);
  }
  const resolverIds = []; const wire = [];
  const codex = createHttpUpstream({ resolveCredential: () => bundle,
    resolveCodexSession: id => { resolverIds.push(id); return { known: false }; },
    fetchImpl: async (url, init) => { wire.push(attribution({ init })); return new Response(stream([complete()])); },
  });
  const account = { platform: 'openai', authMode: 'oauth' };
  await Array.fromAsync(codex.stream(account, { ...opts, sessionId: 'existing-session' }));
  await Array.fromAsync(codex.stream(account, { ...opts, codexRequestProvenance: { ...opts.codexRequestProvenance, version: '1' } }));
  await Array.fromAsync(codex.stream(account, { ...opts, sessionId: 'owner' }));
  await Array.fromAsync(codex.stream(account, { ...opts, purpose: 'session-title' }));
  await Array.fromAsync(codex.stream(account, { ...opts, purpose: 'compaction' }));
  assert.deepEqual(resolverIds, ['existing-session', undefined, 'owner', undefined, undefined], 'only a compatible valid review supplies the nullish owner fallback');
  assert.equal(wire[0].meta.thread_source, undefined); assert.equal(wire[0].flat['x-openai-subagent'], undefined);
  assert.ok(wire[0].body.prompt_cache_key, 'conflicting session retains ordinary cache affinity');
  assert.equal(wire[2].meta.thread_source, 'guardian_review'); assert.equal(wire[2].body.prompt_cache_key, undefined);
  assert.equal(wire[3].meta.thread_source, 'thread_title'); assert.equal(wire[3].meta.parent_thread_id, undefined);
  assert.equal(wire[4].meta.request_kind, 'compaction'); assert.equal(wire[4].meta.thread_source, undefined);
});

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

test('Codex tool images stay in ordered native function outputs with matching call ids', async () => {
  const ids = ['call_image', `call_${'long-image-id'.repeat(20)}`];
  const opts = { ...options, messages: [
    { role: 'user', content: 'Compare the images' },
    { role: 'assistant', content: ids.map(id => ({ type: 'tool-call', id, name: 'read_image', arguments: {} })) },
    { role: 'tool', toolCallId: ids[0], content: [
      { type: 'text', text: 'before' }, png, { type: 'text', text: 'between' },
      { ...png, mediaType: 'image/webp' }, { type: 'text', text: 'after' },
    ] },
    { role: 'tool', toolCallId: ids[1], content: [png] },
  ] };
  const original = structuredClone(opts);
  const prepared = await prepareCodexImages(opts);
  const body = JSON.parse(request({}, prepared).init.body);
  assert.deepEqual(body.input.map(item => item.type), ['message', 'function_call', 'function_call', 'function_call_output', 'function_call_output']);
  assert.equal(body.input[3].call_id, body.input[1].call_id);
  assert.equal(body.input[4].call_id, body.input[2].call_id);
  assert.ok(body.input[4].call_id.length <= 64);
  assert.deepEqual(body.input[3].output, [
    { type: 'input_text', text: 'before' }, { type: 'input_image', image_url: `data:image/png;base64,${pngData}`, detail: 'auto' },
    { type: 'input_text', text: 'between' }, { type: 'input_image', image_url: `data:image/webp;base64,${pngData}`, detail: 'auto' },
    { type: 'input_text', text: 'after' },
  ]);
  assert.deepEqual(body.input[4].output, [body.input[3].output[1]]);
  assert.equal(body.input.filter(item => item.role === 'user').length, 1, 'tool output is not promoted to a user instruction');
  assert.deepEqual(opts, original, 'preparation/building must not mutate durable history');
});

test('Codex tool text-only outputs retain the legacy string representation', () => {
  for (const [content, expected] of [
    ['plain', 'plain'], [[], ''], [null, ''],
    [[{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'b' }], 'ab'],
  ]) {
    const body = JSON.parse(request({}, { ...options, messages: [{ role: 'tool', toolCallId: 'call_text', content }] }).init.body);
    assert.deepEqual(body.input, [{ type: 'function_call_output', call_id: 'fc_text', output: expected }]);
  }
  assert.throws(() => request({}, { ...options, messages: [{ role: 'tool', content: [png] }] }), { code: 'POOL_UNSUPPORTED_CONTENT' });
});

test('Codex tool durable images share request previews with user images and keep offloaded output text-only', async () => {
  let reads = 0;
  const controller = new AbortController();
  const opts = { ...options, signal: controller.signal, messages: [
    { role: 'user', content: [durableImage] },
    { role: 'tool', toolCallId: 'call_image', content: [durableImage, { ...durableImage, offloaded: true }] },
    { role: 'tool', toolCallId: 'call_offloaded', content: [{ ...durableImage, offloaded: true }] },
  ] };
  const original = structuredClone(opts.messages);
  const prepared = await prepareCodexImages(opts, () => ({ async readImageRequest(ref, target, signal) {
    reads++;
    assert.equal(ref, imageRef);
    assert.deepEqual(target, { width: 1, height: 1, maxBytes: 1_048_576 });
    assert.equal(signal, controller.signal);
    return { data: Buffer.from(pngData, 'base64'), mediaType: 'image/png', width: 1, height: 1 };
  } }));
  const body = JSON.parse(request({}, prepared).init.body);
  assert.equal(reads, 1);
  assert.deepEqual(body.input[1].output.slice(0, 2), body.input[0].content);
  assert.match(body.input[1].output[2].text, /image omitted/);
  assert.equal(typeof body.input[2].output, 'string');
  assert.match(body.input[2].output, /image omitted/);
  assert.deepEqual(opts.messages, original);
  const toolOnly = { ...options, messages: [opts.messages[1]] };
  await assert.rejects(() => prepareCodexImages(toolOnly), { code: 'POOL_UNSUPPORTED_CONTENT' });
  const offloaded = await prepareCodexImages({ ...options, messages: [opts.messages[2]] });
  assert.ok(offloaded.messages[0].content.every(part => part.type === 'text'));
  await assert.rejects(() => prepareCodexImages(toolOnly, () => ({ async readImageRequest() { return { data: new Uint8Array() }; } })), { code: 'POOL_UNSUPPORTED_CONTENT' });
  controller.abort();
  await assert.rejects(() => prepareCodexImages({ ...toolOnly, signal: controller.signal }), { name: 'AbortError' });
});

test('Codex tool image HTTP round trip preserves images and cancellation prevents dispatch', async t => {
  const account = { id: 'tool-images', platform: 'openai', authMode: 'oauth', openaiTransport: 'http' };
  let fetches = 0;
  const upstream = createHttpUpstream({ resolveCredential: () => bundle,
    resolveAttachments: () => ({ async readImageRequest() { return { data: Buffer.from(pngData, 'base64'), mediaType: 'image/png', width: 1, height: 1 }; } }),
    fetchImpl: async (url, init) => {
      fetches++;
      const input = JSON.parse(init.body).input;
      assert.deepEqual(input.map(item => item.type), ['message', 'function_call', 'function_call_output']);
      assert.equal(input[1].call_id, input[2].call_id);
      assert.equal(input[2].output.filter(part => part.type === 'input_image').length, 2);
      assert.ok(input[2].output.filter(part => part.type === 'input_image').every(part => part.image_url.endsWith(pngData)));
      return new Response(stream([complete([textItem('tool_image_reply', 'images received')])]));
    },
  });
  t.after(() => upstream.dispose());
  const opts = { ...options, messages: [
    ...options.messages,
    { role: 'assistant', content: [{ type: 'tool-call', name: 'read_image', id: 'call_image', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'call_image', content: [png, { type: 'text', text: 'second' }, durableImage] },
  ] };
  const chunks = await Array.fromAsync(upstream.stream(account, opts));
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'images received');
  assert.equal(fetches, 1);
  const controller = new AbortController();
  const canceled = createHttpUpstream({ resolveCredential: () => bundle, resolveAttachments: () => ({ async readImageRequest() {
    controller.abort(); return { data: Buffer.from(pngData, 'base64'), mediaType: 'image/png' };
  } }), fetchImpl: () => { throw new Error('must not dispatch after tool image cancellation'); } });
  t.after(() => canceled.dispose());
  await assert.rejects(() => Array.fromAsync(canceled.stream(account, { ...opts, signal: controller.signal })), { name: 'AbortError' });
});

test('Codex rejects invalid image payloads and unsupported roles without leaking content', async () => {
  for (const role of ['user', 'tool']) {
    for (const image of [{ type: 'image' }, { ...png, data: '' }, { ...png, data: 'private-invalid-data' },
      { ...png, mediaType: 'image/svg+xml' }, { ...png, mediaType: 'private/type' }, durableImage]) {
      const opts = { ...options, messages: [{ role, toolCallId: 'call_image', content: [image] }] };
      const unsupported = error => error.code === 'POOL_UNSUPPORTED_CONTENT' && !error.message.includes('private');
      assert.throws(() => request({}, opts), unsupported);
      await assert.rejects(() => prepareCodexImages(opts), unsupported);
    }
  }
  for (const role of ['assistant', 'system', 'developer', 'unknown']) {
    const opts = { ...options, messages: [{ role, toolCallId: 'call_image', content: [png] }] };
    assert.throws(() => request({}, opts), { code: 'POOL_UNSUPPORTED_CONTENT' });
    await assert.rejects(() => prepareCodexImages(opts), { code: 'POOL_UNSUPPORTED_CONTENT' });
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
  const initial = request(account, { ...options, sessionId: 'python-session', tools: [{ name: 'python' }] });
  const firstWireName = JSON.parse(initial.init.body).tools[0].name;
  const call = toolItem('item_python_continuation', 'call_python_continuation', firstWireName, '{}');
  const chunks = await Array.fromAsync(mapCodex(stream([complete([
    { type: 'reasoning', id: 'rs_python', encrypted_content: 'python-private' }, call,
  ])]), parseSse, initial.context));
  const block = chunks.find((chunk) => chunk.type === 'block-end').block;
  assert.equal(block.name, 'python');
  const next = request(account, {
    ...options, sessionId: 'python-session', tools: [{ name: 'python' }, { name: firstWireName }],
    messages: [replayAssistant(chunks), { role: 'tool', toolCallId: block.id, content: 'result' }],
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

test('sealed reasoning restores from durable message metadata without rs id lookup', async () => {
  const account = { id: 'continuation-account' };
  const opts = { ...options, sessionId: 'continuation-session' };
  const built = request(account, opts);
  assert.match(built.context.scope, /^[a-f0-9]{64}$/);
  const a = toolItem('item_RA', 'call_RA', 'lookup', '{}');
  const b = toolItem('item_RB', 'call_RB', 'run', '{}');
  const reasoning = { type: 'reasoning', id: 'rs_private', call_id: 'private-rs-call', encrypted_content: 'private-encrypted-fixture' };
  const chunks = await Array.fromAsync(mapCodex(stream([
    itemEvent('done', 0, reasoning), itemEvent('done', 1, a), itemEvent('done', 2, b), complete(),
  ]), parseSse, built.context));
  assert.equal(JSON.stringify(chunks).includes('private-encrypted-fixture'), false);
  const messages = [
    replayAssistant(chunks),
    { role: 'tool', toolCallId: a.call_id, content: 'first result' },
    { role: 'tool', toolCallId: b.call_id, content: 'second result' },
  ];
  const followup = JSON.parse(request(account, { ...opts, messages }).init.body);
  assert.deepEqual(followup.input.map((item) => item.type), ['reasoning', 'function_call', 'function_call', 'function_call_output', 'function_call_output']);
  assert.deepEqual(followup.input[0], { type: 'reasoning', encrypted_content: 'private-encrypted-fixture', summary: [] });
  assert.equal(followup.input[1].call_id, followup.input[3].call_id);
  assert.equal(followup.input[2].call_id, followup.input[4].call_id);
  for (const [differentAccount, differentOptions, credential] of [
    [{ ...account, id: 'other-account' }, { ...opts, messages }, bundle],
    [{ ...account, chatgptAccountId: 'other-workspace' }, { ...opts, messages }, bundle],
    [account, { ...opts, model: 'gpt-5.4', messages }, bundle],
    [account, { ...opts, messages }, { ...bundle, access_token: 'different-token' }],
    [{ ...account, baseUrl: 'https://relay.example' }, { ...opts, messages }, bundle],
    [account, { ...opts, sessionId: 'fork', messages }, bundle],
  ]) assert.equal(JSON.parse(request(differentAccount, differentOptions, credential).init.body).input.some((item) => item.type === 'reasoning'), false);
  const changedMessages = structuredClone(messages);
  changedMessages[0].content[0].arguments = '{"changed":true}';
  assert.equal(JSON.parse(request(account, { ...opts, messages: changedMessages }).init.body).input.some((item) => item.type === 'reasoning'), false);
});

test('failed streams never emit replay; per-response bounds replace fixed TTL eviction', async () => {
  const account = { id: 'bounded-continuation-account' };
  const opts = { ...options, sessionId: 'bounded-session' };
  const built = request(account, opts);
  const failedCall = toolItem('item_failed_cache', 'call_failed_cache', 'run', '{}');
  const seen = [];
  await assert.rejects(async () => {
    for await (const chunk of mapCodex(stream([
      itemEvent('done', 0, { type: 'reasoning', encrypted_content: 'failed-private' }),
      itemEvent('done', 1, failedCall), { type: 'response.failed', response: { error: { code: 'server_error' } } },
    ]), parseSse, built.context)) seen.push(chunk);
  });
  assert.equal(seen.some(chunk => chunk.replayState), false);
  const call = toolItem('item_durable', 'call_durable', 'run', '{}');
  const large = await Array.fromAsync(mapCodex(stream([complete([
    { type: 'reasoning', encrypted_content: 'x'.repeat(MAX_CODEX_REPLAY_BYTES + 1) }, call,
  ])], { fragment: 65536 }), parseSse, built.context));
  assert.equal(large.at(-1).replayState, undefined);
  const chunks = await Array.fromAsync(mapCodex(stream([complete([
    { type: 'reasoning', encrypted_content: 'durable-private' }, call,
  ])]), parseSse, built.context));
  const messages = JSON.parse(JSON.stringify([replayAssistant(chunks)]));
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 8 * 24 * 60 * 60 * 1000;
    assert.equal(JSON.parse(request(account, { ...opts, messages }).init.body).input[0].encrypted_content, 'durable-private');
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
