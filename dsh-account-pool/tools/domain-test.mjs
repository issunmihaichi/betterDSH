/**
 * Domain-shape tests: they weld the durable schemas to what the adapter
 * actually writes.
 *
 * The failure this guards against is drift. The adapter mutates account records
 * (cooldown fields, counters, lastUsedAt) and emits usage records; the domain
 * validates every stored record. If those two disagree, the pool does not fail
 * at write time — it fails at the NEXT `open()`, when the whole domain refuses
 * to load. So the adapter is driven through real scenarios here and every record
 * it persists is validated against the schema it will be stored under.
 *
 *   node tools/domain-test.mjs
 */
import assert from 'node:assert/strict';

import { createPoolAdapter } from '../lib/adapter.js';
import { DURATIONS } from '../lib/kernel.js';
import {
  DOMAIN_NAME,
  UNIT_NAME_RE,
  accountSchema,
  assertDomainSpec,
  bindingSchema,
  groupSchema,
  makeAccount,
  poolDomainSpec,
  usageSchema,
} from '../lib/domain.js';

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
  return { t: start, now() { return this.t; }, advance(ms) { this.t += ms; } };
}

function httpError(status, extra = {}) {
  return Object.assign(new Error(`HTTP ${status}`), { code: `http-${status}`, status }, extra);
}

function fromChunks(chunks) {
  return (async function* generate() { for (const chunk of chunks) yield chunk; })();
}

function okStream(text = 'ok') {
  return fromChunks([
    { type: 'text-delta', index: 0, text },
    { type: 'usage', usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 3 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
}

function failing(failure) {
  return (async function* generate() { throw failure; })();
}

async function drain(iterable) {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

/**
 * A recorder that validates on write — the executable form of "these two
 * modules must agree". Also stands in for the host half's persist adapter.
 */
function makeValidatingPersist() {
  const seen = { accounts: [], bindings: [], deleted: [] };
  return {
    seen,
    putAccount: (record) => {
      const parsed = accountSchema.parse(record);
      seen.accounts.push(parsed);
    },
    putBinding: (record) => {
      const parsed = bindingSchema.parse(record);
      seen.bindings.push(parsed);
    },
    deleteBinding: (sessionHash) => { seen.deleted.push(sessionHash); },
  };
}

// ------------------------------------------------- spec shape

await check('spec: declares the three tables and a non-nullable global', () => {
  assert.deepEqual(Object.keys(poolDomainSpec.tables).sort(), ['accounts', 'bindings', 'groups', 'usage']);
  assert.equal(poolDomainSpec.invalidRecords, 'backup-and-skip');
  assert.equal(poolDomainSpec.global.schema.safeParse(null).success, false);
});

await check('spec: the eager validator accepts the shipped spec and rejects bad ones', () => {
  assert.equal(assertDomainSpec(poolDomainSpec), poolDomainSpec);

  assert.throws(() => assertDomainSpec({ ...poolDomainSpec, version: 1.5 }), /non-negative integer/);
  assert.throws(() => assertDomainSpec({ ...poolDomainSpec, name: 'Bad Name' }), /must match/);
  // The real backend rejected a hyphenated name at `open()`; the local guard must
  // agree with it, or the failure only shows up in a live profile.
  assert.throws(() => assertDomainSpec({ ...poolDomainSpec, name: 'account-pool' }), /must match/);
  assert.throws(
    () => assertDomainSpec({ ...poolDomainSpec, tables: { ...poolDomainSpec.tables, 'Bad_Table': { valueSchema: accountSchema } } }),
    /must match/,
  );
  assert.throws(() => assertDomainSpec({ ...poolDomainSpec, invalidRecords: 'ignore' }), /backup-and-skip/);
  assert.throws(
    () => assertDomainSpec({
      ...poolDomainSpec,
      global: { schema: poolDomainSpec.global.schema.nullable(), initial: {} },
    }),
    /must not accept null/,
  );
  assert.throws(
    () => assertDomainSpec({ ...poolDomainSpec, tables: { broken: {} } }),
    /must declare a valueSchema/,
  );
});

await check('spec: the tables are strict, so an unknown field is rejected rather than silently dropped', () => {
  const record = makeAccount({ id: 'a1' });
  assert.equal(accountSchema.safeParse({ ...record, typoField: 1 }).success, false);
  assert.equal(bindingSchema.safeParse({
    sessionHash: 's1', accountId: 'a1', platform: 'anthropic',
    boundAt: iso(T0), expiresAt: iso(T0 + 1000), extra: true,
  }).success, false);
});

await check('spec: the name rule is PINNED to the vendor regex', () => {
  // Copied verbatim from `@deepseek-ai/dsh-storage`'s UNIT_NAME_RE. A live `open()`
  // rejected the hyphenated domain name this plugin used to carry while every
  // local test passed, so the exact pattern is pinned here as a regression guard:
  // if this assertion ever fails, the local rule has drifted from the vendor's
  // again and the plugin will only fail inside a running DSH.
  assert.equal(String(UNIT_NAME_RE), '/^[a-z][a-z0-9_]*$/');
  assert.equal(UNIT_NAME_RE.test(DOMAIN_NAME), true, `domain name '${DOMAIN_NAME}' must satisfy the vendor rule`);
  assert.equal(UNIT_NAME_RE.test('account_pool'), true);
  assert.equal(UNIT_NAME_RE.test('account-pool'), false, 'hyphens are NOT allowed in a unit or table name');
  assert.equal(UNIT_NAME_RE.test('Account_Pool'), false, 'and uppercase is not either');
  for (const table of Object.keys(poolDomainSpec.tables)) {
    assert.equal(UNIT_NAME_RE.test(table), true, `table '${table}' must satisfy the vendor rule`);
  }
});

await check('spec: a group carries an optional model allow-list and a route-safe id', () => {
  const record = groupSchema.parse({ id: 'cheap', label: '便宜池', createdAt: iso(T0), updatedAt: iso(T0) });
  assert.deepEqual(record.models, [], 'an empty allow-list means no extra restriction');
  assert.equal(record.description, '');
  assert.equal(
    groupSchema.safeParse({ id: 'Cheap Pool', createdAt: iso(T0), updatedAt: iso(T0) }).success,
    false,
    'the id is a slug so it can be a provider route suffix',
  );
  assert.equal(
    groupSchema.safeParse({ id: 'cheap', extra: 1, createdAt: iso(T0), updatedAt: iso(T0) }).success,
    false,
    'strict',
  );
});

await check('spec: an account belongs to no group until it is added', () => {
  // Empty means "the default pool only" — NOT every group, or creating a group
  // would silently sweep in every account that already existed.
  assert.deepEqual(makeAccount({ id: 'a1' }).groups, []);
});

// ------------------------------------------------- makeAccount

await check('makeAccount: fills every default and round-trips through the schema', () => {
  const record = accountSchema.parse(makeAccount({ id: 'a1', platform: 'anthropic' }));
  assert.equal(record.status, 'active');
  assert.equal(record.schedulable, true);
  assert.equal(record.priority, 100);
  assert.equal(record.concurrency, 4);
  assert.equal(record.loadFactor, null);
  assert.deepEqual(record.models, []);
  assert.equal(record.rateLimitResetAt, null);
  assert.equal(record.overloadUntil, null);
  assert.equal(record.tempUnschedulableUntil, null);
  assert.equal(record.consecutiveFailures, 0);
  assert.equal(record.baseUrl, null, 'baseUrl is nullable, not merely optional');
});

await check('makeAccount: rejects an unknown platform and a missing id', () => {
  // Built literally rather than via makeAccount: makeAccount parses, so it would
  // throw instead of producing the invalid record this test hands to safeParse.
  const base = makeAccount({ id: 'a1' });
  assert.equal(accountSchema.safeParse({ ...base, platform: 'claude' }).success, false);
  assert.equal(accountSchema.safeParse({ ...base, id: undefined }).success, false);
  assert.equal(accountSchema.safeParse({ ...base, priority: 2.5 }).success, false);
  assert.equal(accountSchema.safeParse({ ...base, concurrency: -1 }).success, false);
  assert.equal(accountSchema.safeParse({ ...base, lastUsedAt: 'yesterday' }).success, false);

  // And makeAccount itself is a validating constructor, not a passthrough.
  assert.throws(() => makeAccount({ id: 'a1', platform: 'claude' }), /Invalid option|platform/);
});

// ------------------------------------------------- adapter writes stay valid

await check('adapter: a 429 failover persists only schema-valid accounts and bindings', async () => {
  const clock = makeClock();
  const persist = makeValidatingPersist();
  const upstream = {
    stream: (account) => (account.id === 'a1' ? failing(httpError(429)) : okStream('from-a2')),
  };
  const adapter = createPoolAdapter({
    initialAccounts: [
      makeAccount({ id: 'a1', platform: 'anthropic', now: iso(T0) }),
      makeAccount({ id: 'a2', platform: 'anthropic', now: iso(T0) }),
    ],
    upstream,
    clock,
    persist,
  });

  await drain(adapter.stream({ sessionId: 's1', model: 'claude-opus-4' }));

  // a1 cooled, a2 succeeded + bound — all validated on the way through.
  assert.ok(persist.seen.accounts.length >= 2, `expected account writes, got ${persist.seen.accounts.length}`);
  assert.equal(persist.seen.bindings.length, 1);
  assert.equal(persist.seen.bindings[0].accountId, 'a2');

  const cooled = persist.seen.accounts.find((a) => a.id === 'a1');
  assert.equal(cooled.rateLimitResetAt, iso(T0 + DURATIONS.rateLimitDefaultMs));
  assert.equal(cooled.tempUnschedulableReason, 'rate-limit');

  const survived = persist.seen.accounts.find((a) => a.id === 'a2');
  assert.equal(survived.consecutiveFailures, 0);
  assert.equal(survived.lastUsedAt, iso(T0));

  // The snapshot the adapter holds must equal what it persisted.
  assert.deepEqual(accountSchema.parse(adapter.getAccount('a1')), cooled);
});

await check('adapter: an auth-failure escalation stays schema-valid when status flips to error', async () => {
  const clock = makeClock();
  const persist = makeValidatingPersist();
  const upstream = { stream: () => failing(httpError(401)) };
  const adapter = createPoolAdapter({
    initialAccounts: [makeAccount({ id: 'a1', platform: 'anthropic', now: iso(T0) })],
    upstream,
    clock,
    persist,
    maxSwitches: 0,
  });

  for (let i = 0; i < DURATIONS.authFailuresToDisable; i += 1) {
    await assert.rejects(() => drain(adapter.stream({ sessionId: `s${i}`, model: 'm' })));
    clock.advance(DURATIONS.authFailMs + 1); // let the window elapse so the next attempt runs
  }

  const final = persist.seen.accounts.at(-1);
  assert.equal(final.status, 'error');
  assert.equal(final.consecutiveFailures, DURATIONS.authFailuresToDisable);
  assert.match(final.errorMessage, /authentication failed/);
});

await check('adapter: a client error persists nothing at all', async () => {
  const clock = makeClock();
  const persist = makeValidatingPersist();
  const adapter = createPoolAdapter({
    initialAccounts: [makeAccount({ id: 'a1', platform: 'anthropic', now: iso(T0) })],
    upstream: { stream: () => failing(httpError(400)) },
    clock,
    persist,
  });

  await assert.rejects(() => drain(adapter.stream({ sessionId: 's1', model: 'm' })));
  assert.equal(persist.seen.accounts.length, 0, 'a 400 must not write an account record');
  assert.equal(persist.seen.bindings.length, 0);
});

// ------------------------------------------------- the usage record the host builds

await check('usage: the payload the adapter reports folds into a valid usage record', async () => {
  const clock = makeClock();
  const payloads = [];
  const adapter = createPoolAdapter({
    initialAccounts: [makeAccount({ id: 'a1', platform: 'anthropic', now: iso(T0) })],
    upstream: { stream: () => okStream('hi') },
    clock,
    onUsage: (payload) => payloads.push(payload),
  });

  await drain(adapter.stream({ sessionId: 's1', model: 'claude-opus-4' }));
  assert.equal(payloads.length, 1);

  const payload = payloads[0];
  // This mirrors exactly what lib/host.js will write.
  const record = usageSchema.parse({
    id: 'usage-1',
    at: iso(clock.now()),
    accountId: payload.accountId,
    sessionId: payload.sessionId,
    platform: payload.platform,
    model: payload.model,
    accountSwitches: payload.switches,
    ok: payload.ok,
    errorCode: payload.errorCode,
    inputTokens: payload.usage?.inputTokens ?? 0,
    outputTokens: payload.usage?.outputTokens ?? 0,
    cacheReadTokens: payload.usage?.cacheReadTokens ?? 0,
    cacheWriteTokens: payload.usage?.cacheWriteTokens ?? 0,
    reasoningTokens: payload.usage?.reasoningTokens ?? 0,
  });

  assert.equal(record.ok, true);
  assert.equal(record.inputTokens, 12);
  assert.equal(record.cacheReadTokens, 3);
  assert.equal(record.accountId, 'a1');
});

await check('usage: a POOL_EXHAUSTED payload with no usage folds into zeros, not undefined', async () => {
  const clock = makeClock();
  const payloads = [];
  const adapter = createPoolAdapter({
    initialAccounts: [],
    upstream: { stream: () => okStream() },
    clock,
    onUsage: (payload) => payloads.push(payload),
  });

  await assert.rejects(() => drain(adapter.stream({ sessionId: 's1', model: 'm' })));
  const payload = payloads.at(-1);
  assert.equal(payload.ok, false);
  assert.equal(payload.errorCode, 'POOL_EXHAUSTED');
  assert.equal(payload.usage, null);

  const record = usageSchema.parse({
    id: 'usage-2', at: iso(T0),
    accountId: payload.accountId, sessionId: payload.sessionId,
    platform: payload.platform, model: payload.model,
    accountSwitches: payload.switches, ok: payload.ok, errorCode: payload.errorCode,
    inputTokens: payload.usage?.inputTokens ?? 0,
    outputTokens: payload.usage?.outputTokens ?? 0,
    cacheReadTokens: payload.usage?.cacheReadTokens ?? 0,
    cacheWriteTokens: payload.usage?.cacheWriteTokens ?? 0,
    reasoningTokens: payload.usage?.reasoningTokens ?? 0,
  });
  assert.equal(record.inputTokens, 0);
  assert.equal(record.accountId, '');
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
