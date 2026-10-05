/**
 * Offline test suite for the account-pool kernel and adapter.
 *
 * Zero dependencies, no network, no DSH runtime: a fake upstream and an injected
 * clock drive the whole state machine.
 *
 *   node tools/kernel-test.mjs
 */
import assert from 'node:assert/strict';

import {
  ACCOUNT_ACTIONS,
  DEFAULT_FAILURE_POLICY,
  DURATIONS,
  activeBinding,
  applyAccountAction,
  applyCooldown,
  applySuccess,
  classifyFailure,
  isSchedulable,
  loadRatio,
  matchesStatus,
  parseTs,
  selectCandidate,
  weightedPick,
} from '../lib/kernel.js';
import { createPoolAdapter, PoolExhaustedError } from '../lib/adapter.js';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

let checks = 0;
let passed = 0;
const failures = [];

async function check(label, fn) {
  checks += 1;
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failures.push({ label, error });
  }
}

// ---------------------------------------------------------------- fixtures

function makeClock(start = T0) {
  return {
    t: start,
    now() { return this.t; },
    advance(ms) { this.t += ms; },
  };
}

function account(overrides = {}) {
  return {
    id: 'a1',
    label: '',
    platform: 'anthropic',
    baseUrl: null,
    status: 'active',
    schedulable: true,
    errorMessage: '',
    priority: 100,
    loadFactor: null,
    concurrency: 4,
    expiresAt: null,
    autoPauseOnExpired: true,
    rateLimitResetAt: null,
    overloadUntil: null,
    tempUnschedulableUntil: null,
    tempUnschedulableReason: '',
    lastUsedAt: null,
    consecutiveFailures: 0,
    models: [],
    createdAt: iso(T0),
    updatedAt: iso(T0),
    ...overrides,
  };
}

function httpError(status, extra = {}) {
  return Object.assign(new Error(`HTTP ${status}`), { code: `http-${status}`, status }, extra);
}

function fromChunks(chunks) {
  return (async function* generate() { for (const chunk of chunks) yield chunk; })();
}

function okStream(text = 'ok', usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 }) {
  return fromChunks([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'usage', usage },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
}

/** An upstream whose body never runs a yield: the throw surfaces on first next(). */
function failing(failure) {
  return (async function* generate() { throw failure; })();
}

function makeUpstream(behavior) {
  const calls = [];
  return {
    calls,
    stream(account_, options) {
      calls.push({ accountId: account_.id, model: options?.model, sessionId: options?.sessionId });
      return behavior(account_, options);
    },
  };
}

async function drain(iterable) {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

function makePersistLog() {
  const log = { accounts: [], bindings: [], dropped: [] };
  return {
    log,
    putAccount: (a) => { log.accounts.push(a.id); },
    putBinding: (b) => { log.bindings.push(b.sessionHash); },
    deleteBinding: (h) => { log.dropped.push(h); },
  };
}

// ------------------------------------------------- §4 schedulability state machine

await check('isSchedulable: healthy account is schedulable', () => {
  assert.equal(isSchedulable(account(), T0), true);
});

await check('isSchedulable: status != active blocks', () => {
  assert.equal(isSchedulable(account({ status: 'error' }), T0), false);
  assert.equal(isSchedulable(account({ status: 'disabled' }), T0), false);
});

await check('isSchedulable: manual switch off blocks', () => {
  assert.equal(isSchedulable(account({ schedulable: false }), T0), false);
});

await check('isSchedulable: expiry honours autoPauseOnExpired', () => {
  const expired = iso(T0 - 1000);
  assert.equal(isSchedulable(account({ expiresAt: expired }), T0), false);
  assert.equal(isSchedulable(account({ expiresAt: expired, autoPauseOnExpired: false }), T0), true);
});

await check('isSchedulable: each cooling window blocks independently', () => {
  const future = iso(T0 + 60_000);
  assert.equal(isSchedulable(account({ overloadUntil: future }), T0), false);
  assert.equal(isSchedulable(account({ rateLimitResetAt: future }), T0), false);
  assert.equal(isSchedulable(account({ tempUnschedulableUntil: future }), T0), false);
});

await check('isSchedulable: elapsed windows free the account again', () => {
  const past = iso(T0 - 1);
  assert.equal(isSchedulable(account({ overloadUntil: past, rateLimitResetAt: past, tempUnschedulableUntil: past }), T0), true);
});

// ------------------------------------------------- §5 failure classification

await check('classifyFailure: 429 without hint uses the default window', () => {
  const d = classifyFailure(httpError(429), account(), T0);
  assert.equal(d.kind, 'rate-limit');
  assert.equal(d.field, 'rateLimitResetAt');
  assert.equal(d.untilMs, T0 + DURATIONS.rateLimitDefaultMs);
});

await check('classifyFailure: 429 honours providerRetryAfterMs', () => {
  const d = classifyFailure(httpError(429, { providerRetryAfterMs: 5_000 }), account(), T0);
  assert.equal(d.untilMs, T0 + 5_000);
});

await check('classifyFailure: 401/403 park the account and escalate', () => {
  for (const status of [401, 403]) {
    const d = classifyFailure(httpError(status), account(), T0);
    assert.equal(d.kind, 'auth-fail');
    assert.equal(d.untilMs, T0 + DURATIONS.authFailMs);
    assert.equal(d.escalates, true);
  }
});

await check('classifyFailure: 5xx uses a progressive ladder', () => {
  const first = classifyFailure(httpError(503), account({ consecutiveFailures: 0 }), T0);
  const second = classifyFailure(httpError(503), account({ consecutiveFailures: 1 }), T0);
  const third = classifyFailure(httpError(503), account({ consecutiveFailures: 2 }), T0);
  const beyond = classifyFailure(httpError(503), account({ consecutiveFailures: 9 }), T0);
  assert.equal(first.untilMs, T0 + DURATIONS.overloadLadderMs[0]);
  assert.equal(second.untilMs, T0 + DURATIONS.overloadLadderMs[1]);
  assert.equal(third.untilMs, T0 + DURATIONS.overloadLadderMs[2]);
  assert.equal(beyond.untilMs, T0 + DURATIONS.overloadLadderMs[2], 'ladder must saturate, not run off the end');
  assert.equal(classifyFailure(httpError(529), account(), T0).kind, 'overload');
});

await check('classifyFailure: 400/413/422 are the CLIENT fault -> kind none', () => {
  for (const status of [400, 413, 422]) {
    const d = classifyFailure(httpError(status), account(), T0);
    assert.equal(d.kind, 'none', `${status} must never cool an account`);
  }
});

await check('classifyFailure: abort and other 4xx are kind none', () => {
  assert.equal(classifyFailure({ code: 'aborted' }, account(), T0).kind, 'none');
  assert.equal(classifyFailure(httpError(404), account(), T0).kind, 'none');
  assert.equal(classifyFailure(httpError(409), account(), T0).kind, 'none');
});

await check('classifyFailure: configuration errors are kind none, NOT transport', () => {
  // These carry no HTTP status. Without an explicit class they would fall into
  // `transport` and park a healthy account for a problem no cooldown can fix —
  // and since they fail identically on every account, they would walk the pool.
  for (const code of ['POOL_NO_CREDENTIAL', 'POOL_UNSUPPORTED_CONTENT', 'POOL_NO_UPSTREAM']) {
    const decision = classifyFailure(Object.assign(new Error(code), { code }), account(), T0);
    assert.equal(decision.kind, 'none', `${code} must not cool an account`);
    assert.equal(decision.reason, 'configuration');
  }
  // A genuinely status-less transport fault still parks the account.
  assert.equal(classifyFailure(new Error('socket hang up'), account(), T0).kind, 'transport');
});

await check('classifyFailure: no HTTP status at all is a transport fault', () => {
  const d = classifyFailure(new Error('socket hang up'), account(), T0);
  assert.equal(d.kind, 'transport');
  assert.equal(d.untilMs, T0 + DURATIONS.transportMs);
});

// ------------------------------------------------- cooldown application

await check('applyCooldown: kind none returns the SAME reference (nothing written)', () => {
  const before = account();
  const after = applyCooldown(before, classifyFailure(httpError(400), before, T0), T0);
  assert.equal(after, before, 'identity proves no field was touched');
});

await check('applyCooldown: auth failures escalate to status error at the threshold', () => {
  let current = account();
  for (let i = 1; i <= DURATIONS.authFailuresToDisable; i += 1) {
    current = applyCooldown(current, classifyFailure(httpError(401), current, T0), T0);
    assert.equal(current.consecutiveFailures, i);
    assert.equal(current.status, i >= DURATIONS.authFailuresToDisable ? 'error' : 'active');
    assert.equal(current.tempUnschedulableReason, 'auth-fail');
  }
});

await check('applySuccess: clears transient windows and the streak, keeps the upstream quota window', () => {
  const before = account({
    consecutiveFailures: 2,
    overloadUntil: iso(T0 + 1000),
    tempUnschedulableUntil: iso(T0 + 1000),
    tempUnschedulableReason: 'overload',
    rateLimitResetAt: iso(T0 + 999_000),
  });
  const after = applySuccess(before, T0);
  assert.equal(after.consecutiveFailures, 0);
  assert.equal(after.overloadUntil, null);
  assert.equal(after.tempUnschedulableUntil, null);
  assert.equal(after.tempUnschedulableReason, '');
  assert.equal(after.rateLimitResetAt, iso(T0 + 999_000), 'a success does not refill an upstream window');
  assert.equal(after.lastUsedAt, iso(T0));
  assert.equal(before.consecutiveFailures, 2, 'input record must not be mutated');
});

// ------------------------------------------------- §6 selection

await check('loadRatio: uses loadFactor, falls back to concurrency, then 1', () => {
  const inflight = new Map([['a1', 2]]);
  assert.equal(loadRatio(account({ loadFactor: 4 }), inflight), 0.5);
  assert.equal(loadRatio(account({ loadFactor: null, concurrency: 2 }), inflight), 1);
  assert.equal(loadRatio(account({ loadFactor: null, concurrency: 0 }), inflight), 2);
});

await check('selectCandidate: same priority picks the lower load ratio', () => {
  const a1 = account({ id: 'a1', loadFactor: 4 });
  const a2 = account({ id: 'a2', loadFactor: 4 });
  const hit = selectCandidate({
    accounts: [a1, a2],
    bindings: new Map(),
    now: T0,
    inflight: new Map([['a1', 3]]),
  });
  assert.equal(hit.account.id, 'a2');
});

await check('selectCandidate: priority outranks load', () => {
  const a1 = account({ id: 'a1', priority: 10 });
  const a2 = account({ id: 'a2', priority: 20 });
  const hit = selectCandidate({
    accounts: [a1, a2],
    bindings: new Map(),
    now: T0,
    inflight: new Map([['a1', 3]]),
  });
  assert.equal(hit.account.id, 'a1', 'priority is the first key, not the load ratio');
});

await check('selectCandidate: a full account (concurrency) is not a candidate', () => {
  const a1 = account({ id: 'a1', concurrency: 1 });
  const a2 = account({ id: 'a2' });
  const hit = selectCandidate({
    accounts: [a1, a2],
    bindings: new Map(),
    now: T0,
    inflight: new Map([['a1', 1]]),
  });
  assert.equal(hit.account.id, 'a2');
});

await check('selectCandidate: model filtering and exclusions apply', () => {
  const a1 = account({ id: 'a1', models: ['claude-opus-4'] });
  const a2 = account({ id: 'a2', models: [] });
  assert.equal(selectCandidate({ accounts: [a1, a2], bindings: new Map(), now: T0, requestedModel: 'gpt-5' }).account.id, 'a2');
  assert.equal(selectCandidate({ accounts: [a1, a2], bindings: new Map(), now: T0, requestedModel: 'claude-opus-4' }).account.id, 'a1');
  assert.equal(
    selectCandidate({ accounts: [a1, a2], bindings: new Map(), now: T0, excluded: new Set(['a1']) }).account.id,
    'a2',
  );
});

await check('selectCandidate: sticky wins over a strictly better-ranked account', () => {
  const a1 = account({ id: 'a1', priority: 100 });
  const a2 = account({ id: 'a2', priority: 1 });
  const bindings = new Map([['s1', {
    sessionHash: 's1', accountId: 'a1', platform: 'anthropic',
    boundAt: iso(T0), expiresAt: iso(T0 + DURATIONS.stickyTtlMs),
  }]]);
  const hit = selectCandidate({ accounts: [a1, a2], bindings, now: T0, sessionHash: 's1' });
  assert.equal(hit.account.id, 'a1');
  assert.equal(hit.layer, 'sticky');
  assert.equal(hit.bindingState, 'hit');
});

await check('selectCandidate: a CAPACITY skip keeps the binding so the session returns', () => {
  const a1 = account({ id: 'a1', concurrency: 1 });
  const a2 = account({ id: 'a2' });
  const bindings = new Map([['s1', {
    sessionHash: 's1', accountId: 'a1', platform: 'anthropic',
    boundAt: iso(T0), expiresAt: iso(T0 + DURATIONS.stickyTtlMs),
  }]]);

  const busy = selectCandidate({
    accounts: [a1, a2], bindings, now: T0, sessionHash: 's1', inflight: new Map([['a1', 1]]),
  });
  assert.equal(busy.account.id, 'a2');
  assert.equal(busy.bindingState, 'skipped');
  assert.equal(bindings.has('s1'), true, 'skipping is transient and must not delete the binding');

  const free = selectCandidate({ accounts: [a1, a2], bindings, now: T0, sessionHash: 's1' });
  assert.equal(free.account.id, 'a1', 'once capacity frees up the session returns to its account');
});

await check('selectCandidate: an expired binding reports expired and is not a hit', () => {
  const a1 = account({ id: 'a1' });
  const bindings = new Map([['s1', {
    sessionHash: 's1', accountId: 'a1', platform: 'anthropic',
    boundAt: iso(T0), expiresAt: iso(T0 - 1),
  }]]);
  const hit = selectCandidate({ accounts: [a1], bindings, now: T0, sessionHash: 's1' });
  assert.equal(hit.bindingState, 'expired');
  assert.equal(hit.layer, 'load');
  assert.equal(activeBinding(bindings, 's1', T0), undefined);
});

await check('selectCandidate: empty candidate set yields no account', () => {
  const cooled = account({ rateLimitResetAt: iso(T0 + 60_000) });
  const hit = selectCandidate({ accounts: [cooled], bindings: new Map(), now: T0 });
  assert.equal(hit.account, undefined);
  assert.equal(hit.layer, 'none');
});

// ------------------------------------------------- §7 adapter: sticky + failover

await check('adapter: the same session sticks to one account across calls', async () => {
  const clock = makeClock();
  const a1 = account({ id: 'a1' });
  const a2 = account({ id: 'a2' });
  const upstream = makeUpstream(() => okStream());
  const adapter = createPoolAdapter({ initialAccounts: [a1, a2], upstream, clock });

  await drain(adapter.stream({ sessionId: 's1', model: 'claude-opus-4' }));
  const first = upstream.calls.at(-1).accountId;

  // Make the other account strictly preferable, then call again on the same session.
  adapter.upsertAccount(account({ id: first === 'a1' ? 'a2' : 'a1', priority: 1 }));
  await drain(adapter.stream({ sessionId: 's1', model: 'claude-opus-4' }));

  assert.equal(upstream.calls.at(-1).accountId, first, 'sticky must beat the ranking change');
  assert.equal(adapter.getBinding('s1').accountId, first);

  // A different session has no binding and does follow the ranking.
  await drain(adapter.stream({ sessionId: 's2', model: 'claude-opus-4' }));
  assert.notEqual(upstream.calls.at(-1).accountId, first);
});

await check('adapter: 429 cools the account, fails over, and binds the session to the survivor', async () => {
  const clock = makeClock();
  const a1 = account({ id: 'a1' });
  const a2 = account({ id: 'a2' });
  const usages = [];
  const cooldowns = [];
  const upstream = makeUpstream((account_) => (
    account_.id === 'a1' ? failing(httpError(429)) : okStream('from-a2')
  ));
  const adapter = createPoolAdapter({
    initialAccounts: [a1, a2], upstream, clock,
    onUsage: (u) => usages.push(u),
    onCooldown: (c) => cooldowns.push(c),
  });

  const chunks = await drain(adapter.stream({ sessionId: 's1', model: 'claude-opus-4' }));
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');

  assert.equal(text, 'from-a2', 'the request must be served by the surviving account');
  assert.equal(upstream.calls.length, 2, 'exactly one failover');
  assert.equal(parseTs(adapter.getAccount('a1').rateLimitResetAt), T0 + DURATIONS.rateLimitDefaultMs);
  assert.equal(cooldowns.length, 1);
  assert.equal(cooldowns[0].decision.kind, 'rate-limit');
  assert.equal(usages.length, 1);
  assert.equal(usages[0].ok, true);
  assert.equal(usages[0].switches, 1);
  assert.equal(usages[0].usage.inputTokens, 10);
  assert.equal(adapter.getBinding('s1').accountId, 'a2', 'sticky must not point at the cooled account');
  assert.equal(adapter.inflightSnapshot().size, 0, 'every acquired slot must be released');
});

await check('adapter: 400 changes NOTHING and is not failed over', async () => {
  const clock = makeClock();
  const a1 = account({ id: 'a1' });
  const a2 = account({ id: 'a2' });
  const usages = [];
  const upstream = makeUpstream(() => failing(httpError(400, { code: 'invalid_request_error' })));
  const adapter = createPoolAdapter({ initialAccounts: [a1, a2], upstream, clock, onUsage: (u) => usages.push(u) });
  const before = adapter.getAccount('a1');

  await assert.rejects(
    () => drain(adapter.stream({ sessionId: 's1', model: 'claude-opus-4' })),
    (error) => error.status === 400,
  );

  const after = adapter.getAccount('a1');
  assert.equal(after, before, 'a client error must not write a single field');
  assert.deepEqual(after, before);
  assert.equal(after.consecutiveFailures, 0);
  assert.equal(after.rateLimitResetAt, null);
  assert.equal(after.tempUnschedulableUntil, null);
  assert.equal(after.overloadUntil, null);
  assert.equal(upstream.calls.length, 1, 'no failover: the account is innocent');
  assert.equal(adapter.getBinding('s1'), undefined, 'a failed request must not create a binding');
  assert.equal(usages.length, 1);
  assert.equal(usages[0].ok, false);
  assert.equal(usages[0].errorCode, 'invalid_request_error');
  assert.equal(adapter.inflightSnapshot().size, 0);
});

await check('adapter: a failure AFTER the first forwarded chunk cannot be failed over', async () => {
  const clock = makeClock();
  const a1 = account({ id: 'a1' });
  const a2 = account({ id: 'a2' });
  const upstream = makeUpstream((account_) => (
    account_.id === 'a1'
      ? fromChunks([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'partial' },
        // The stream commits, then dies.
        { type: 'finish', reason: { kind: 'error', failure: httpError(429) } },
      ])
      : okStream('from-a2')
  ));
  const adapter = createPoolAdapter({ initialAccounts: [a1, a2], upstream, clock });

  const seen = [];
  await assert.rejects(async () => {
    for await (const chunk of adapter.stream({ sessionId: 's1', model: 'claude-opus-4' })) seen.push(chunk);
  });

  assert.equal(seen.filter((c) => c.type === 'text-delta').length, 1, 'the partial output was already forwarded');
  assert.equal(upstream.calls.length, 1, 'a second attempt would duplicate the partial text');
  assert.notEqual(adapter.getAccount('a1').rateLimitResetAt, null, 'the cooldown is still recorded');
});

await check('adapter: an error finish chunk before any output IS retryable', async () => {
  const clock = makeClock();
  const a1 = account({ id: 'a1' });
  const a2 = account({ id: 'a2' });
  const upstream = makeUpstream((account_) => (
    account_.id === 'a1'
      ? fromChunks([{ type: 'finish', reason: { kind: 'error', failure: httpError(503) } }])
      : okStream('recovered')
  ));
  const adapter = createPoolAdapter({ initialAccounts: [a1, a2], upstream, clock });

  const chunks = await drain(adapter.stream({ sessionId: 's1', model: 'claude-opus-4' }));
  assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'recovered');
  assert.equal(upstream.calls.length, 2);
  assert.equal(adapter.getAccount('a1').overloadUntil, iso(T0 + DURATIONS.overloadLadderMs[0]));
});

await check('adapter: a pool with nothing schedulable raises POOL_EXHAUSTED', async () => {
  const clock = makeClock();
  const cooled = account({ id: 'a1', rateLimitResetAt: iso(T0 + 60_000) });
  const usages = [];
  const upstream = makeUpstream(() => okStream());
  const adapter = createPoolAdapter({
    initialAccounts: [cooled], upstream, clock, onUsage: (u) => usages.push(u),
  });

  await assert.rejects(
    () => drain(adapter.stream({ sessionId: 's1', model: 'claude-opus-4' })),
    (error) => error instanceof PoolExhaustedError && error.code === 'POOL_EXHAUSTED',
  );
  assert.equal(upstream.calls.length, 0, 'no schedulable account means no upstream call at all');
  assert.equal(usages.at(-1).ok, false);
  assert.equal(usages.at(-1).errorCode, 'POOL_EXHAUSTED');
  assert.equal(adapter.inflightSnapshot().size, 0);
});

await check('adapter: running out of switches surfaces the LAST upstream failure', async () => {
  const clock = makeClock();
  const a1 = account({ id: 'a1', concurrency: 0 });
  const a2 = account({ id: 'a2', concurrency: 0 });
  const usages = [];
  const upstream = makeUpstream(() => failing(httpError(503)));
  const adapter = createPoolAdapter({
    initialAccounts: [a1, a2], upstream, clock, maxSwitches: 1, onUsage: (u) => usages.push(u),
  });

  await assert.rejects(
    () => drain(adapter.stream({ sessionId: 's1', model: 'claude-opus-4' })),
    // The caller gets the real upstream error, not a generic "exhausted" one:
    // it is strictly more informative and matches sub2api's failover loop.
    (error) => error.status === 503,
  );
  assert.equal(upstream.calls.length, 2, 'two accounts, one switch');
  assert.equal(usages.at(-1).ok, false);
  assert.equal(usages.at(-1).errorCode, 'http-503');
  assert.equal(adapter.inflightSnapshot().size, 0);
});

await check('adapter: maxSwitches bounds how many accounts one request may burn', async () => {
  const clock = makeClock();
  const accounts = [0, 1, 2, 3, 4].map((i) => account({ id: `a${i}` }));
  const upstream = makeUpstream(() => failing(httpError(503)));
  const adapter = createPoolAdapter({ initialAccounts: accounts, upstream, clock, maxSwitches: 2 });

  await assert.rejects(() => drain(adapter.stream({ sessionId: 's1', model: 'x' })));
  assert.equal(upstream.calls.length, 3, 'the first attempt plus maxSwitches retries');
});

await check('adapter: a cooled account recovers once its window elapses', async () => {
  const clock = makeClock();
  const a1 = account({ id: 'a1' });
  const upstream = makeUpstream(() => failing(httpError(429)));
  const adapter = createPoolAdapter({ initialAccounts: [a1], upstream, clock });

  await assert.rejects(() => drain(adapter.stream({ sessionId: 's1', model: 'x' })));
  assert.equal(isSchedulable(adapter.getAccount('a1'), clock.now()), false);

  clock.advance(DURATIONS.rateLimitDefaultMs + 1);
  assert.equal(isSchedulable(adapter.getAccount('a1'), clock.now()), true);
});

await check('adapter: persistence is write-through and never blocks the request', async () => {
  const clock = makeClock();
  const persist = makePersistLog();
  const upstream = makeUpstream(() => okStream());
  const adapter = createPoolAdapter({
    initialAccounts: [account({ id: 'a1' })], upstream, clock, persist,
  });

  await drain(adapter.stream({ sessionId: 's1', model: 'x' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(persist.log.bindings, ['s1']);
  assert.ok(persist.log.accounts.length >= 1);
});

// ------------------------------------------------- operator actions

await check('applyAccountAction: enable/disable stay orthogonal to cooling windows', () => {
  const cooling = account({ id: 'a1', status: 'disabled', schedulable: false, errorMessage: 'was bad', rateLimitResetAt: iso(T0 + 60_000), consecutiveFailures: 2 });
  const enabled = applyAccountAction(cooling, 'enable', { now: T0 });
  assert.equal(enabled.status, 'active');
  assert.equal(enabled.schedulable, true);
  assert.equal(enabled.errorMessage, '');
  assert.equal(enabled.rateLimitResetAt, iso(T0 + 60_000), 'enabling must NOT silently lift a real upstream window');
  assert.equal(enabled.consecutiveFailures, 2, 'and must not wipe the failure history');

  const disabled = applyAccountAction(account(), 'disable', { now: T0 });
  assert.equal(disabled.status, 'disabled');
  assert.equal(disabled.schedulable, false);
});

await check('applyAccountAction: prefer wins the priority key outright', () => {
  const a1 = account({ id: 'a1', priority: 0 });
  const a2 = account({ id: 'a2', priority: 500 });
  const a3 = account({ id: 'a3', priority: 100 });

  const preferred = applyAccountAction(a2, 'prefer', { now: T0, allAccounts: [a1, a2, a3] });
  assert.equal(preferred.priority, -1, 'strictly below the lowest sibling, so it cannot tie');

  const hit = selectCandidate({ accounts: [a1, preferred, a3], bindings: new Map(), now: T0 });
  assert.equal(hit.account.id, 'a2', 'and it therefore wins selection');
});

await check('applyAccountAction: a single-account pool prefers to 0, not -Infinity', () => {
  const solo = account({ id: 'solo' });
  assert.equal(applyAccountAction(solo, 'prefer', { now: T0, allAccounts: [solo] }).priority, 0);
  assert.equal(applyAccountAction(solo, 'prefer', { now: T0 }).priority, 0, 'no sibling list at all');
});

await check('applyAccountAction: clear-cooldown lifts every window and resurrects a hard failure', () => {
  const failed = account({
    id: 'a1',
    status: 'error',
    errorMessage: 'authentication failed 3 times consecutively',
    rateLimitResetAt: iso(T0 + 1000),
    overloadUntil: iso(T0 + 1000),
    tempUnschedulableUntil: iso(T0 + 1000),
    tempUnschedulableReason: 'auth-fail',
    consecutiveFailures: 3,
  });

  const cleared = applyAccountAction(failed, 'clear-cooldown', { now: T0 });
  assert.equal(cleared.rateLimitResetAt, null);
  assert.equal(cleared.overloadUntil, null);
  assert.equal(cleared.tempUnschedulableUntil, null);
  assert.equal(cleared.tempUnschedulableReason, '');
  assert.equal(cleared.consecutiveFailures, 0);
  assert.equal(cleared.status, 'active', 'a hard-failed account is resurrectable only by an explicit act');
  assert.equal(cleared.errorMessage, '');
  assert.equal(isSchedulable(cleared, T0), true);

  // Clearing a plain rate-limit window makes an otherwise-healthy account usable.
  const limited = account({ rateLimitResetAt: iso(T0 + 60_000) });
  assert.equal(isSchedulable(limited, T0), false);
  assert.equal(isSchedulable(applyAccountAction(limited, 'clear-cooldown', { now: T0 }), T0), true);

  // A non-error account keeps whatever status it had.
  assert.equal(applyAccountAction(account({ status: 'disabled' }), 'clear-cooldown', { now: T0 }).status, 'disabled');
});

await check('applyAccountAction: set-priority validates, unknown actions throw', () => {
  assert.equal(applyAccountAction(account(), 'set-priority', { now: T0, priority: 7 }).priority, 7);
  assert.throws(() => applyAccountAction(account(), 'set-priority', { now: T0, priority: 'high' }), RangeError);
  assert.throws(() => applyAccountAction(account(), 'set-priority', { now: T0 }), RangeError);
  assert.throws(() => applyAccountAction(account(), 'nonsense', { now: T0 }), RangeError);
  assert.deepEqual(ACCOUNT_ACTIONS, ['enable', 'disable', 'prefer', 'clear-cooldown', 'set-priority']);
});

// ------------------------------------------------- failure policy as data

await check('matchesStatus: exact numbers and class patterns', () => {
  assert.equal(matchesStatus(503, 503), true);
  assert.equal(matchesStatus(503, 500), false);
  assert.equal(matchesStatus(503, '5xx'), true);
  assert.equal(matchesStatus(500, '5xx'), true);
  assert.equal(matchesStatus(429, '5xx'), false);
  assert.equal(matchesStatus(429, '4xx'), true);
  assert.equal(matchesStatus(429, 'nonsense'), false);
});

await check('DEFAULT_FAILURE_POLICY reproduces the original hardcoded table', () => {
  // Adopting the data-driven shape must be behaviour-neutral until edited.
  assert.equal(classifyFailure(httpError(429), account(), T0).kind, 'rate-limit');
  assert.equal(classifyFailure(httpError(401), account(), T0).kind, 'auth-fail');
  assert.equal(classifyFailure(httpError(403), account(), T0).kind, 'auth-fail');
  assert.equal(classifyFailure(httpError(500), account(), T0).kind, 'overload');
  assert.equal(classifyFailure(httpError(529), account(), T0).kind, 'overload');
  assert.equal(classifyFailure(httpError(400), account(), T0).kind, 'none');
  assert.equal(classifyFailure(httpError(404), account(), T0).kind, 'none');
  assert.equal(classifyFailure(new Error('socket hang up'), account(), T0).kind, 'transport');
  assert.deepEqual(DEFAULT_FAILURE_POLICY.keywordRules, [], 'text matching is opt-in, never a default');
});

await check('classifyFailure: keyword rules stay inert unless the policy opts in', () => {
  // The dangerous case: an upstream that happens to phrase a CLIENT error with
  // rate-limit words must not walk the pool into cooldown.
  const misleading = Object.assign(new Error('rate limit exceeded in your request payload'), { status: 400 });
  assert.equal(classifyFailure(misleading, account(), T0).kind, 'none', 'default policy ignores the text');

  const optedIn = {
    ...DEFAULT_FAILURE_POLICY,
    keywordRules: [{ keywords: ['rate limit'], kind: 'rate-limit' }],
  };
  const decision = classifyFailure(misleading, account(), T0, optedIn);
  assert.equal(decision.kind, 'none', 'the STATUS rule is evaluated before keywords, so 400 still wins');
});

await check('classifyFailure: a custom policy can reclassify and add keyword rules', () => {
  const custom = {
    configErrorCodes: ['POOL_NO_CREDENTIAL'],
    statusRules: [{ match: [418], kind: 'auth-fail' }, { match: ['5xx'], kind: 'overload' }],
    keywordRules: [{ keywords: ['余额不足'], kind: 'auth-fail' }],
  };
  assert.equal(classifyFailure(httpError(418), account(), T0, custom).kind, 'auth-fail');
  assert.equal(classifyFailure(httpError(400), account(), T0, custom).kind, 'none', '400 is no longer listed but still falls through to none');

  // No status at all, so the text rule is the only thing that can match.
  const chinese = Object.assign(new Error('上游返回：余额不足，请充值'), { code: 'upstream-body' });
  assert.equal(classifyFailure(chinese, account(), T0, custom).kind, 'auth-fail');
  assert.equal(classifyFailure(chinese, account(), T0).kind, 'transport', 'the default policy sees only "no status"');
});

// ------------------------------------------------- weighted random

await check('weightedPick: always returns a candidate for any draw', () => {
  const pool = [account({ id: 'a1', weight: 0 }), account({ id: 'a2', weight: 3 })];
  assert.equal(weightedPick([], () => 0.5), undefined);
  assert.equal(weightedPick([pool[0]], () => 0.5).id, 'a1', 'a single candidate needs no draw');
  for (const draw of [0, 0.25, 0.5, 0.75, 0.999999]) {
    assert.ok(pool.includes(weightedPick(pool, () => draw)), `draw ${String(draw)} must resolve to a candidate`);
  }
});

await check('weightedPick: all-zero weights split evenly (new-api smoothing)', () => {
  // sumWeight 0 -> n*100 = 200, adjustment 100: the 0.5 boundary is exact.
  const pool = [account({ id: 'a1', weight: 0 }), account({ id: 'a2', weight: 0 })];
  assert.equal(weightedPick(pool, () => 0).id, 'a1');
  assert.equal(weightedPick(pool, () => 0.49).id, 'a1');
  assert.equal(weightedPick(pool, () => 0.5).id, 'a2');
  assert.equal(weightedPick(pool, () => 0.99).id, 'a2');
});

await check('weightedPick: a dominant weight wins, and tiny weights are scaled', () => {
  const dominant = [account({ id: 'a1', weight: 100 }), account({ id: 'a2', weight: 0 })];
  for (const draw of [0, 0.5, 0.99]) {
    assert.equal(weightedPick(dominant, () => draw).id, 'a1', 'avg >= 10 keeps factor 1');
  }

  // avg = 2 < 10 -> factor 100, so the 3:1 split lands exactly at 0.75.
  const tiny = [account({ id: 'a1', weight: 3 }), account({ id: 'a2', weight: 1 })];
  assert.equal(weightedPick(tiny, () => 0.74).id, 'a1');
  assert.equal(weightedPick(tiny, () => 0.76).id, 'a2');
  // Without the x100 scaling the total would be 4 and integer rounding would
  // make this distribution lumpy; assert the shares actually hold.
  let a1 = 0;
  for (let step = 0; step < 100; step += 1) if (weightedPick(tiny, () => step / 100).id === 'a1') a1 += 1;
  assert.equal(a1, 75, `expected a 75/25 split, got ${String(a1)}/100`);
});

await check('selectCandidate: weighted-random never jumps to a worse priority tier', () => {
  const a1 = account({ id: 'a1', priority: 10, weight: 0 });
  const a2 = account({ id: 'a2', priority: 20, weight: 1000 });
  const hit = selectCandidate({
    accounts: [a1, a2], bindings: new Map(), now: T0, mode: 'weighted-random', random: () => 0.999,
  });
  assert.equal(hit.account.id, 'a1', 'the best tier is chosen first; weight only spreads WITHIN it');
  assert.equal(hit.layer, 'weighted');

  // Once the best tier is excluded (as the adapter does after a failure), the
  // next tier is reachable.
  const next = selectCandidate({
    accounts: [a1, a2], bindings: new Map(), now: T0, mode: 'weighted-random', random: () => 0.5, excluded: new Set(['a1']),
  });
  assert.equal(next.account.id, 'a2');
});

await check('selectCandidate: weighted-random spreads within one tier', () => {
  const a1 = account({ id: 'a1', priority: 10, weight: 1 });
  const a2 = account({ id: 'a2', priority: 10, weight: 3 });
  const counts = { a1: 0, a2: 0 };
  for (let step = 0; step < 100; step += 1) {
    const id = selectCandidate({
      accounts: [a1, a2], bindings: new Map(), now: T0, mode: 'weighted-random', random: () => step / 100,
    }).account.id;
    counts[id] += 1;
  }
  assert.equal(counts.a1, 25, `expected a 25/75 split, got ${JSON.stringify(counts)}`);
  assert.equal(counts.a2, 75);
});

// ------------------------------------------------- groups

await check('groups: each group route selects only that group’s accounts', async () => {
  const clock = makeClock();
  const upstream = makeUpstream(() => okStream());
  const adapter = createPoolAdapter({
    initialAccounts: [
      account({ id: 'a1', groups: ['cheap'] }),
      account({ id: 'a2', groups: ['vip'] }),
      account({ id: 'a3', groups: [] }),
    ],
    initialGroups: [{ id: 'cheap', models: [] }, { id: 'vip', models: [] }],
    upstream,
    clock,
  });

  await drain(adapter.stream({ sessionId: 's1', provider: 'pool-cheap', model: 'm' }));
  assert.equal(upstream.calls.at(-1).accountId, 'a1');

  await drain(adapter.stream({ sessionId: 's2', provider: 'pool-vip', model: 'm' }));
  assert.equal(upstream.calls.at(-1).accountId, 'a2');

  // The default route spans everything, INCLUDING accounts that belong to no group.
  // a3 wins on LRU precisely because it has never been used — which is the point:
  // an account in no group is still part of the default pool.
  await drain(adapter.stream({ sessionId: 's3', provider: 'pool', model: 'm' }));
  assert.equal(upstream.calls.at(-1).accountId, 'a3');

  assert.deepEqual(adapter.routesFor(), ['pool', 'pool-cheap', 'pool-vip']);
});

await check('groups: an unknown group serves nothing rather than the whole pool', async () => {
  // Falling back to the full pool here would hide a typo behind real-looking traffic.
  const adapter = createPoolAdapter({
    initialAccounts: [account({ id: 'a1', groups: [] })],
    initialGroups: [],
    upstream: makeUpstream(() => okStream()),
    clock: makeClock(),
  });
  await assert.rejects(
    () => drain(adapter.stream({ sessionId: 's1', provider: 'pool-ghost', model: 'm' })),
    (error) => error.code === 'POOL_EXHAUSTED',
  );
});

await check('groups: a group allow-list filters on top of the account’s own models', async () => {
  const clock = makeClock();
  const adapter = createPoolAdapter({
    // The ACCOUNT accepts anything; only the GROUP restricts, so this isolates the
    // group filter instead of re-testing the account filter.
    initialAccounts: [account({ id: 'a1', groups: ['limits'], models: [] })],
    initialGroups: [{ id: 'limits', models: ['allowed-model'] }],
    upstream: makeUpstream(() => okStream()),
    clock,
  });

  await drain(adapter.stream({ sessionId: 's1', provider: 'pool-limits', model: 'allowed-model' }));
  assert.equal(adapter.getBinding('s1').accountId, 'a1');

  await assert.rejects(
    () => drain(adapter.stream({ sessionId: 's2', provider: 'pool-limits', model: 'other-model' })),
    (error) => error.code === 'POOL_EXHAUSTED',
  );
  // ...and the same model IS fine through the default route, proving the GROUP was
  // what excluded it.
  await drain(adapter.stream({ sessionId: 's3', provider: 'pool', model: 'other-model' }));
  assert.equal(adapter.getBinding('s3').accountId, 'a1');
});

await check('groups: deleting a group detaches it without deleting accounts', async () => {
  const adapter = createPoolAdapter({
    initialAccounts: [
      account({ id: 'a1', groups: ['cheap', 'vip'] }),
      account({ id: 'a2', groups: ['vip'] }),
    ],
    initialGroups: [{ id: 'cheap' }, { id: 'vip' }],
    upstream: makeUpstream(() => okStream()),
    clock: makeClock(),
  });

  assert.deepEqual(adapter.removeGroup('cheap'), ['a1'], 'only the accounts that listed it are edited');
  assert.deepEqual(adapter.getAccount('a1').groups, ['vip']);
  assert.equal(adapter.listAccounts().length, 2, 'a group is a view over accounts, not their owner');
  assert.deepEqual(adapter.routesFor(), ['pool', 'pool-vip'], 'and its route is gone');
  assert.deepEqual(adapter.removeGroup('cheap'), [], 'removing twice is a no-op');
});

// ------------------------------------------------- report

if (failures.length > 0) {
  for (const { label, error } of failures) {
    console.error(`✗ ${label}\n    ${error.message.split('\n').join('\n    ')}`);
  }
  console.error(`\n${passed}/${checks} 通过，${failures.length} 失败`);
  process.exitCode = 1;
} else {
  console.log(`✓ ${passed}/${checks} 通过`);
}
