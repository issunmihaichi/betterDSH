import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCodexRequest, snapshotCodexSessionContext } from '../lib/native/codex.js';
import { buildCodexRequest as previousRequest } from '../lib/runtime-v0.4.21-codex-continuity/native/codex.js';
import { createCodexAttributionDiagnostics, summarizeCodexAttribution } from '../lib/native/codex-attribution.js';
import { createHttpUpstream } from '../lib/upstream.js';

const account = { id: 'offline-row', platform: 'openai', authMode: 'oauth' };
const credential = { access_token: 'offline-token', chatgpt_account_id: 'offline-account' };
const base = { model: 'gpt-5.3-codex', codexTurnId: 'offline-fixed-call', messages: [{ role: 'user', content: 'private-prompt-sentinel' }] };
const root = { known: true, rootSessionId: 'private-root-sentinel', turnId: 'private-turn-sentinel' };
const child = { ...root, origin: 'subagent', parentSessionId: 'private-root-sentinel' };
const cases = [
  ['task', { sessionId: 'private-root-sentinel', codexSessionContext: root }, 'user', 'turn'],
  ['subagent', { sessionId: 'private-child-sentinel', codexSessionContext: child }, 'subagent', 'turn'],
  ['title', { sessionId: 'private-child-sentinel', codexSessionContext: child, purpose: 'session-title' }, 'thread_title', 'turn'],
  ['compaction', { sessionId: 'private-root-sentinel', codexSessionContext: root, purpose: 'compaction' }, 'user', 'compaction'],
  ['child compaction', { sessionId: 'private-child-sentinel', codexSessionContext: child, purpose: 'compaction' }, 'subagent', 'compaction'],
  ['review', { codexSessionContext: child, codexRequestProvenance: { version: 1, kind: 'auto-review', ownerSessionId: 'private-child-sentinel', requestId: 'private-review-sentinel' } }, 'guardian_review', 'turn'],
  ['missing session', {}, 'unknown', 'turn'],
  ['unresolved session', { sessionId: 'private-missing-sentinel', codexSessionContext: { known: false, missingSourceReason: 'session-not-found' } }, 'unknown', 'turn'],
];
const completed = () => new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [], usage: {} } }) + '\n\n');
const drain = iterable => Array.fromAsync(iterable);

test('diagnostics reflect emitted canonical labels without changing any wire bytes', () => {
  for (const [name, extra, source, kind] of cases) {
    const opts = { ...base, ...extra };
    const before = previousRequest(account, opts, credential);
    const built = buildCodexRequest(account, opts, credential);
    assert.equal(built.url, before.url, name);
    assert.deepEqual(built.init, before.init, name);
    const meta = JSON.parse(JSON.parse(built.init.body).client_metadata['x-codex-turn-metadata']);
    assert.equal(built.context.attribution.threadSource, meta.thread_source ?? 'unknown', name);
    assert.equal(built.context.attribution.requestKind, meta.request_kind, name);
    assert.equal(built.context.attribution.threadSource, source, name);
    assert.equal(built.context.attribution.requestKind, kind, name);
    assert.ok(Object.isFrozen(built.context.attribution));
    assert.deepEqual(Object.keys(built.context.attribution).sort(), ['missingSourceReason', 'requestKind', 'threadSource']);
    assert.doesNotMatch(JSON.stringify(built.context.attribution), /private-|offline-token|offline-account/);
    assert.equal(built.init.body.includes('missingSourceReason'), false);
  }
});

test('missing-source reasons are bounded, never caller strings or accessors', () => {
  for (const reason of ['session-service-unavailable', 'session-not-found', 'source-unavailable']) {
    const context = snapshotCodexSessionContext({ known: false, missingSourceReason: reason });
    assert.equal(summarizeCodexAttribution({ request_kind: 'turn' }, context, 'present').missingSourceReason, reason);
  }
  assert.equal(summarizeCodexAttribution({}, {}, undefined).missingSourceReason, 'missing-session-id');
  const hostile = Object.create({ missingSourceReason: 'session-not-found' });
  Object.defineProperty(hostile, 'origin', { get() { throw Error('must not invoke'); } });
  assert.deepEqual(snapshotCodexSessionContext(hostile), {});
  const malicious = snapshotCodexSessionContext({ missingSourceReason: 'private-error-with-identifiers' });
  assert.equal(summarizeCodexAttribution({}, malicious, 'present').missingSourceReason, 'source-unavailable');
  assert.equal(summarizeCodexAttribution({ thread_source: 'guardian_review' }, {}, undefined).missingSourceReason, null);
});

test('mount-local counters are bounded, defensive, and distinguish attempts from billing', () => {
  let time = 100;
  const warnings = [];
  const counter = createCodexAttributionDiagnostics({ now: () => time++, onUnknown: reason => { warnings.push(reason); throw Error('observer failure'); } });
  for (const [, extra] of cases) counter.record(buildCodexRequest(account, { ...base, ...extra }, credential).context.attribution);
  counter.record({ threadSource: 'private-arbitrary-source', requestKind: 'private-arbitrary-kind', missingSourceReason: 'private-arbitrary-reason' });
  counter.record({ threadSource: 'unknown', requestKind: 'turn', missingSourceReason: 'source-unavailable' });
  const result = counter.snapshot();
  assert.equal(result.totalAttempts, 10);
  assert.deepEqual(result.bySource, { user: 2, subagent: 2, thread_title: 1, guardian_review: 1, unknown: 4 });
  assert.deepEqual(result.byRequestKind, { turn: 8, compaction: 2 });
  assert.equal(result.missingSourceAttempts, 4);
  assert.deepEqual(warnings, ['missing-session-id', 'session-not-found', 'source-unavailable']);
  assert.equal(result.semantics, 'dispatch-attempts-not-billed-usage');
  assert.equal(result.officialAnalyticsVerified, false);
  assert.equal(result.startedAt, 100);
  assert.equal(result.lastAttemptAt, 110);
  assert.equal(result.lastMissingSourceAt, 110);
  assert.doesNotMatch(JSON.stringify(result), /private-|offline-token|offline-account/);
  result.bySource.user = 999; result.missingSourceReasons['session-not-found'] = 999;
  assert.equal(counter.snapshot().bySource.user, 2);
  assert.equal(counter.snapshot().missingSourceReasons['session-not-found'], 1);
  const fresh = createCodexAttributionDiagnostics();
  assert.equal(fresh.snapshot().totalAttempts, 0, 'new host mount resets diagnostic counters');
  const disabled = createCodexAttributionDiagnostics({ enabled: false });
  disabled.record({ threadSource: 'user', requestKind: 'turn' });
  assert.equal(disabled.snapshot().enabled, false); assert.equal(disabled.snapshot().totalAttempts, 0);
});

test('transport invokes only the trusted observer at dispatch, across retries and errors', async () => {
  const labels = []; const packets = []; const sequence = [];
  let fail = true;
  const upstream = createHttpUpstream({ resolveCredential: () => credential,
    onCodexRequest: summary => { sequence.push('observe'); labels.push(summary); },
    fetchImpl: async (url, init) => { sequence.push('fetch'); packets.push(init);
      if (fail) { fail = false; throw Error('synthetic network failure'); }
      return completed(); },
  });
  const opts = { ...base, ...cases[0][1], onCodexRequest() { throw Error('per-call observer must never run'); } };
  await assert.rejects(drain(upstream.stream(account, opts)), /synthetic network failure/);
  await drain(upstream.stream(account, opts));
  assert.deepEqual(sequence, ['observe', 'fetch', 'observe', 'fetch']);
  assert.equal(labels.length, 2);
  assert.deepEqual(labels[0], { requestKind: 'turn', threadSource: 'user', missingSourceReason: null });
  assert.deepEqual(packets[0].headers, packets[1].headers);
  assert.equal(packets[0].body, packets[1].body);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(drain(upstream.stream(account, { ...opts, signal: controller.signal })), { name: 'AbortError' });
  assert.equal(labels.length, 2, 'pre-dispatch abort is not counted');
  await assert.rejects(drain(upstream.stream(account, { ...opts, tools: 'invalid' })), /tools must be an array/);
  assert.equal(labels.length, 2, 'invalid local request is not counted');
});

test('observer exceptions do not block calls and non-Codex traffic is excluded', async () => {
  let observations = 0, fetches = 0;
  const upstream = createHttpUpstream({ resolveCredential: () => credential,
    onCodexRequest: () => { observations++; throw Error('synthetic observer failure'); },
    fetchImpl: async () => { fetches++; return completed(); },
  });
  await drain(upstream.stream(account, { ...base, ...cases[0][1] }));
  assert.equal(fetches, 1); assert.equal(observations, 1);
  const other = createHttpUpstream({ resolveCredential: () => 'offline-api-key',
    onCodexRequest: () => { observations++; },
    fetchImpl: async () => new Response('data: [DONE]\n\n'),
  });
  await drain(other.stream({ platform: 'openai', authMode: 'apikey' }, base));
  assert.equal(observations, 1);
});
