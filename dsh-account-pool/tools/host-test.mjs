/**
 * Host-half tests: drive `mountPool` with a fake Cordis context.
 *
 * These verify the wiring without installing anything into a live profile — a
 * fake `storageDomain` (durable across re-opens, so restart semantics are
 * testable), a fake `llm` registry, and a fake `connection` route table.
 *
 *   node tools/host-test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mountPool, reconcileConfiguredAccounts, ROUTES } from '../lib/host.js';
import { poolDomainSpec, usageSchema } from '../lib/domain.js';
import { DURATIONS } from '../lib/kernel.js';

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

// ---------------------------------------------------------------- upstreams

function httpError(status) {
  return Object.assign(new Error(`HTTP ${status}`), { code: `http-${status}`, status });
}

function okStream(text = 'ok') {
  return (async function* generate() {
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 3 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();
}

function failing(failure) {
  return (async function* generate() { throw failure; })();
}

async function drain(iterable) {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

const UP_OK = () => ({ stream: () => okStream() });
const UP_429_ON_A1 = () => ({ stream: (account) => (account.id === 'a1' ? failing(httpError(429)) : okStream('from-a2')) });
const UP_400 = () => ({ stream: () => failing(httpError(400)) });

const CONFIG_ACCOUNTS = [
  { id: 'a1', platform: 'anthropic', priority: 100 },
  { id: 'a2', platform: 'anthropic', priority: 100 },
];

// ---------------------------------------------------------------- fakes

/** Process-wide durable medium: re-opening a domain sees what was written. */
function makeMedium() {
  const tables = new Map();
  const globals = new Map();
  return {
    globals,
    tableFor(domainName, tableName) {
      const key = `${domainName}:${tableName}`;
      if (!tables.has(key)) tables.set(key, new Map());
      return tables.get(key);
    },
  };
}

function makeKvTable(map) {
  return {
    get: (key) => map.get(key),
    entries: () => map.entries(),
    keys: () => map.keys(),
    get size() { return map.size; },
    put: async (key, value) => { map.set(key, value); },
    delete: async (key) => map.delete(key),
    update: async (key, fn) => { const next = fn(map.get(key)); map.set(key, next); return next; },
  };
}

function makeCtx({ medium = makeMedium(), withLlm = true, withConnection = true, withInterval = true, withCredentials = true } = {}) {
  const state = {
    medium,
    opened: [],
    registrations: [],
    adapterDisposed: 0,
    providerDeclarations: [],
    providerDeclarationsDisposed: 0,
    routes: [],
    routeDisposed: 0,
    logs: { info: [], warn: [], error: [] },
    intervals: [],
    stoppedIntervals: 0,
    domainClosed: 0,
    effects: [],
    effectsDisposed: 0,
  };

  /** Faithful single-open facility: a name is reserved until its handle closes. */
  const openByName = new Map();
  const storageDomain = {
    open: async (spec) => {
      assert.equal(spec, poolDomainSpec, 'the host must open the canonical spec');
      if (openByName.has(spec.name)) {
        const error = new Error(`domain '${spec.name}' is already open`);
        error.code = 'already-open';
        throw error;
      }
      let closed = false;
      const domain = {
        name: spec.name,
        global: {
          get: () => medium.globals.get(spec.name) ?? { ...spec.global.initial },
          set: async (value) => { medium.globals.set(spec.name, value); },
        },
        table: (tableName) => makeKvTable(medium.tableFor(spec.name, tableName)),
        close: async () => {
          if (closed) return;
          closed = true;
          state.domainClosed += 1;
          openByName.delete(spec.name);
        },
      };
      openByName.set(spec.name, domain);
      state.opened.push(domain);
      return domain;
    },
    get: (name) => openByName.get(name),
  };

  const llm = withLlm ? {
    registerAdapter: (providers, adapter) => {
      // Mirrors the real handle: a disposer that ALSO carries `replace(providers)`,
      // which is how a group edit swaps the route table without re-registering.
      const entry = { providers: [...providers], adapter, disposed: false, replaces: [] };
      state.registrations.push(entry);
      const handle = () => { entry.disposed = true; state.adapterDisposed += 1; };
      handle.replace = (next) => { entry.replaces.push([...next]); entry.providers = [...next]; };
      return handle;
    },
    registerConfigurableProviders: (entries) => {
      const record = { entries, disposed: false };
      state.providerDeclarations.push(record);
      return () => { record.disposed = true; state.providerDeclarationsDisposed += 1; };
    },
  } : undefined;

  const connection = withConnection ? {
    fetch: {
      register: (route) => {
        state.routes.push(route);
        return async () => { state.routeDisposed += 1; };
      },
    },
  } : undefined;

  const logger = {
    info: (...args) => state.logs.info.push(args.join(' ')),
    warn: (...args) => state.logs.warn.push(args.join(' ')),
    error: (...args) => state.logs.error.push(args.join(' ')),
  };

  // A faithful-enough credential store: refs resolve to what was written, and a
  // missing ref is ABSENT rather than empty.
  const secrets = new Map();
  const credentials = withCredentials ? {
    set: async (ref, value) => {
      if (typeof value !== 'string' || value === '') throw new Error('set rejects an empty value; use unset');
      secrets.set(ref, value);
    },
    unset: async (ref) => { secrets.delete(ref); },
    resolve: async (ref) => (secrets.has(ref) ? { value: secrets.get(ref), source: 'store' } : undefined),
    describe: async (ref) => (secrets.has(ref)
      ? { configured: true, writable: true, source: 'store' }
      : { configured: false, writable: true }),
  } : undefined;
  state.secrets = secrets;

  const ctx = { logger, get: (serviceName) => ({ storageDomain, llm, connection, credentials }[serviceName]) };
  ctx.effect = (fn, label) => {
    const disposer = fn();
    state.effects.push({ disposer, label });
    return disposer;
  };
  // The Loader entry identity: the Host half reads it for `settingsNs`.
  ctx.fiber = { entry: { options: { id: 'account-pool' } } };
  if (withInterval === 'throws') {
    // Cordis models the timer helpers as a SERVICE accessor: reading
    // `ctx.interval` without `timer` in `inject` throws rather than returning
    // undefined. That is what killed the live mount, so the fake reproduces it.
    Object.defineProperty(ctx, 'interval', {
      get() { throw new Error('cannot get property "timer" without inject'); },
    });
  } else if (withInterval) {
    ctx.interval = (fn, ms) => { state.intervals.push({ fn, ms }); return () => { state.stoppedIntervals += 1; }; };
  }
  // Cordis exposes hard-injected services as context properties; `storageDomain`
  // is declared in the plugin's `inject`, so it must be reachable that way.
  ctx.storageDomain = storageDomain;
  if (llm !== undefined) ctx.llm = llm;
  if (connection !== undefined) ctx.connection = connection;

  return { ctx, state };
}

function makeClock(start = T0) {
  return { t: start, now() { return this.t; }, advance(ms) { this.t += ms; } };
}

/** The adapter the host registered, or a loud failure when it registered none. */
function registeredAdapter(state) {
  const entry = state.registrations[0];
  assert.ok(entry !== undefined, 'expected the host to register a `pool` adapter');
  return entry.adapter;
}

// ------------------------------------------------- reconcile

await check('reconcile: inserts new accounts and refreshes static fields only', async () => {
  const medium = makeMedium();
  const table = makeKvTable(medium.tableFor('account_pool', 'accounts'));

  assert.deepEqual(reconcileConfiguredAccounts(table, CONFIG_ACCOUNTS, iso(T0)), { inserted: 2, refreshed: 0 });
  assert.equal(table.size, 2);

  // Simulate runtime state written by the scheduler.
  table.put('a1', { ...table.get('a1'), rateLimitResetAt: iso(T0 + 60_000), consecutiveFailures: 2 });

  assert.deepEqual(reconcileConfiguredAccounts(table, [{ id: 'a1', platform: 'anthropic', priority: 1 }], iso(T0 + 1000)), { inserted: 0, refreshed: 1 });

  const after = table.get('a1');
  assert.equal(after.priority, 1, 'operator-owned field must be refreshed');
  assert.equal(after.rateLimitResetAt, iso(T0 + 60_000), 'a restart must NOT clear a cooldown');
  assert.equal(after.consecutiveFailures, 2, 'runtime counters survive a restart');
});

await check('reconcile: a no-op config writes nothing', async () => {
  const medium = makeMedium();
  const table = makeKvTable(medium.tableFor('account_pool', 'accounts'));
  reconcileConfiguredAccounts(table, CONFIG_ACCOUNTS, iso(T0));

  const before = [...table.entries()].map(([k, v]) => [k, v.updatedAt]);
  assert.deepEqual(reconcileConfiguredAccounts(table, CONFIG_ACCOUNTS, iso(T0 + 5000)), { inserted: 0, refreshed: 0 });
  assert.deepEqual([...table.entries()].map(([k, v]) => [k, v.updatedAt]), before, 'unchanged rows must not be rewritten');
});

// ------------------------------------------------- mount

await check('mount: opens the canonical domain and registers the `pool` provider', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock(), upstream: UP_OK() });

  assert.equal(state.opened.length, 1);
  assert.equal(mounted.adapterRegistered, true);
  assert.equal(state.registrations.length, 1);
  assert.deepEqual(state.registrations[0].providers, ['pool']);
  assert.equal(mounted.inserted, 2);

  await mounted.dispose();
});

await check('mount: with no credentials service it degrades to management-only', async () => {
  // The transport is built FROM the credentials service, so its absence is what
  // makes an upstream impossible — not the absence of a Config field.
  const { ctx, state } = makeCtx({ withCredentials: false });
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock() });

  assert.equal(mounted.adapterRegistered, false);
  assert.equal(state.registrations.length, 0, 'never register a provider that cannot reach anything');
  assert.equal(state.providerDeclarations.length, 0, 'and never OFFER one in the directory either');
  assert.ok(
    state.logs.warn.some((line) => line.includes('management-only')),
    'the degradation must be logged, not silent',
  );
  // The management projection still works without a transport.
  assert.equal(mounted.adapter.listAccounts().length, 2);

  await mounted.dispose();
});

await check('mount: without the `llm` service it still mounts the management surface', async () => {
  const { ctx, state } = makeCtx({ withLlm: false });
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock(), upstream: UP_OK() });

  assert.equal(mounted.adapterRegistered, false);
  assert.equal(state.routes.length, 3, 'management routes do not depend on `llm`');
  assert.ok(state.logs.warn.some((line) => line.includes('`llm` service is unavailable')));

  await mounted.dispose();
});

await check('mount: registers the three management routes under /api', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock(), upstream: UP_OK() });

  assert.deepEqual(state.routes.map((r) => r.path).sort(), [ROUTES.accounts, ROUTES.usage, ROUTES.account].sort());
  for (const route of state.routes) {
    assert.ok(route.path.startsWith('/api/'), `${route.path} must live on the authenticated channel`);
    assert.equal(route.requestBody, 'buffered');
    assert.equal(typeof route.fetch, 'function');
  }
  assert.deepEqual(state.routes.find((r) => r.path === ROUTES.accounts).methods, ['GET', 'HEAD']);
  assert.deepEqual(state.routes.find((r) => r.path === ROUTES.usage).methods, ['GET', 'HEAD']);
  assert.deepEqual(state.routes.find((r) => r.path === ROUTES.account).methods, ['POST'], 'the write route is POST-only');

  await mounted.dispose();
});

await check('mount: declares the route in the configurable-provider directory keyed by the entry id', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock(), upstream: UP_OK() });

  assert.equal(state.providerDeclarations.length, 1);
  const [entry] = state.providerDeclarations[0].entries;
  assert.equal(entry.provider, 'pool');
  assert.equal(entry.settingsNs, 'account-pool', 'settingsNs is the Loader ENTRY ID the Models card edits');
  assert.deepEqual(entry.settingsPath, [], 'an empty path means the whole settings document is the provider config');
  assert.equal(typeof entry.displayName, 'string');

  await mounted.dispose();
  assert.equal(state.providerDeclarationsDisposed, 1, 'dispose withdraws the declaration');
});

// ------------------------------------------------- end-to-end through the wiring

await check('end-to-end: 429 on a1 fails over to a2 and persists account, binding and usage rows', async () => {
  const clock = makeClock();
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock, upstream: UP_429_ON_A1() });
  const adapter = registeredAdapter(state);

  const chunks = await drain(adapter.stream({ sessionId: 's1', model: 'claude-opus-4' }));
  assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'from-a2');

  await mounted.flush();

  assert.equal(state.medium.tableFor('account_pool', 'accounts').get('a1').rateLimitResetAt, iso(T0 + DURATIONS.rateLimitDefaultMs));
  assert.equal(state.medium.tableFor('account_pool', 'bindings').get('s1').accountId, 'a2');

  const usageRows = state.medium.tableFor('account_pool', 'usage');
  assert.equal(usageRows.size, 1);
  const usage = usageSchema.parse([...usageRows.values()][0]);
  assert.equal(usage.ok, true);
  assert.equal(usage.accountId, 'a2');
  assert.equal(usage.sessionId, 's1');
  assert.equal(usage.inputTokens, 12);
  assert.equal(usage.cacheReadTokens, 3);
  assert.equal(usage.accountSwitches, 1);
  assert.equal(state.medium.globals.get('account_pool').totalRequests, 1, 'flush() must cover the counter bump');

  await mounted.dispose();
});

await check('end-to-end: a client error writes no account row and still records the failure', async () => {
  const clock = makeClock();
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock, upstream: UP_400() });
  const adapter = registeredAdapter(state);

  await assert.rejects(() => drain(adapter.stream({ sessionId: 's1', model: 'm' })));
  await mounted.flush();

  const accountRows = state.medium.tableFor('account_pool', 'accounts');
  assert.equal(accountRows.get('a1').rateLimitResetAt, null);
  assert.equal(accountRows.get('a1').consecutiveFailures, 0);
  assert.equal(state.medium.tableFor('account_pool', 'bindings').size, 0);

  const usage = usageSchema.parse([...state.medium.tableFor('account_pool', 'usage').values()][0]);
  assert.equal(usage.ok, false);
  assert.equal(usage.errorCode, 'http-400');

  await mounted.dispose();
});

await check('mount: a second mount sees runtime state written by the first', async () => {
  const medium = makeMedium();
  const clock = makeClock();

  const first = makeCtx({ medium });
  const firstMounted = await mountPool(first.ctx, { accounts: CONFIG_ACCOUNTS, clock, upstream: UP_429_ON_A1() });
  await drain(registeredAdapter(first.state).stream({ sessionId: 's1', model: 'm' }));
  await firstMounted.flush();
  await firstMounted.dispose();

  // Re-open the same medium: the cooldown must still be in force.
  const second = makeCtx({ medium });
  const secondMounted = await mountPool(second.ctx, { accounts: CONFIG_ACCOUNTS, clock, upstream: UP_OK() });
  const seeded = secondMounted.adapter.getAccount('a1');
  assert.equal(seeded.rateLimitResetAt, iso(T0 + DURATIONS.rateLimitDefaultMs), 'the adapter must be seeded from durable state');
  assert.equal(seeded.consecutiveFailures, 0);

  await secondMounted.dispose();
});

// ------------------------------------------------- management routes

await check('route: the accounts endpoint reports accounts, bindings and the request counter', async () => {
  const clock = makeClock();
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock, upstream: UP_OK() });

  await drain(registeredAdapter(state).stream({ sessionId: 's1', model: 'm' }));
  await mounted.flush();

  const route = state.routes.find((r) => r.path === ROUTES.accounts);
  assert.equal((await route.fetch(new Request('http://127.0.0.1/api/accountPool.accounts', { method: 'HEAD' }))).status, 200);

  const response = await route.fetch(new Request('http://127.0.0.1/api/accountPool.accounts'));
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.accounts.length, 2);
  assert.deepEqual(body.counts, { active: 2 });
  assert.equal(body.bindings.length, 1);
  assert.equal(body.totalRequests, 1);

  await mounted.dispose();
});

await check('route: the usage endpoint returns newest-first and honours limit', async () => {
  const clock = makeClock();
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: [{ id: 'a1', platform: 'anthropic' }], clock, upstream: UP_OK() });
  const adapter = registeredAdapter(state);

  for (let i = 0; i < 3; i += 1) {
    await drain(adapter.stream({ sessionId: `s${i}`, model: 'm' }));
    clock.advance(1000);
  }
  await mounted.flush();

  const route = state.routes.find((r) => r.path === ROUTES.usage);
  const all = await (await route.fetch(new Request('http://127.0.0.1/api/accountPool.usage'))).json();
  assert.equal(all.rows.length, 3);
  assert.equal(all.limit, 100);
  assert.ok(all.rows.every((row, i) => i === 0 || all.rows[i - 1].at >= row.at), 'rows must be newest-first');

  const limited = await (await route.fetch(new Request('http://127.0.0.1/api/accountPool.usage?limit=2'))).json();
  assert.equal(limited.rows.length, 2);

  const capped = await (await route.fetch(new Request('http://127.0.0.1/api/accountPool.usage?limit=99999'))).json();
  assert.equal(capped.limit, 500, 'the limit must be capped');

  await mounted.dispose();
});

// ------------------------------------------------- prune + dispose

await check('mount: the expiry sweep prunes expired bindings, and dispose stops it', async () => {
  const clock = makeClock();
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: [{ id: 'a1', platform: 'anthropic' }], clock, upstream: UP_OK(), pruneIntervalMs: 5000 });

  assert.equal(state.intervals.length, 1);
  assert.equal(state.intervals[0].ms, 5000);

  await drain(mounted.adapter.stream({ sessionId: 's1', model: 'm' }));
  await mounted.flush();
  assert.equal(mounted.adapter.listBindings().length, 1);

  clock.advance(DURATIONS.stickyTtlMs + 1);
  state.intervals[0].fn();
  await mounted.flush();
  assert.equal(mounted.adapter.listBindings().length, 0, 'an expired binding must be swept');
  assert.equal(state.medium.tableFor('account_pool', 'bindings').size, 0, 'the sweep must persist the delete');

  await mounted.dispose();
  assert.equal(state.stoppedIntervals, 1);
});

await check('dispose: closes the domain and releases every registration, idempotently', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock(), upstream: UP_OK() });

  assert.equal(state.domainClosed, 0);
  await mounted.dispose();

  assert.equal(state.domainClosed, 1);
  assert.equal(state.adapterDisposed, 1);
  assert.equal(state.routeDisposed, 3);

  await mounted.dispose();
  assert.equal(state.domainClosed, 1, 'disposal must be idempotent');
  assert.equal(state.routeDisposed, 3, 'a second dispose must not re-run route disposers');
  assert.equal(state.providerDeclarationsDisposed, 1, 'and must not re-run the declaration disposer');
});

// ------------------------------------------------- the single write route

function actionRequest(body, raw) {
  return new Request('http://127.0.0.1/api/accountPool.account', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
}

await check('route: an action applies, persists, and is visible to the next read', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock(), upstream: UP_OK() });
  const route = state.routes.find((r) => r.path === ROUTES.account);

  const disabled = await (await route.fetch(actionRequest({ id: 'a1', action: 'disable' }))).json();
  assert.equal(disabled.ok, true);
  assert.equal(disabled.account.status, 'disabled');
  assert.equal(disabled.account.schedulable, false);
  await mounted.flush();
  assert.equal(state.medium.tableFor('account_pool', 'accounts').get('a1').status, 'disabled', 'the change is persisted');

  const preferred = await (await route.fetch(actionRequest({ id: 'a2', action: 'prefer' }))).json();
  assert.equal(preferred.account.priority, 99, 'one below the lowest sibling (a1 sits at 100)');

  const accountsRoute = state.routes.find((r) => r.path === ROUTES.accounts);
  const listed = await (await accountsRoute.fetch(new Request('http://127.0.0.1/api/accountPool.accounts'))).json();
  assert.equal(listed.accounts.find((a) => a.id === 'a1').status, 'disabled');
  assert.equal(listed.accounts.find((a) => a.id === 'a2').priority, 99);

  await mounted.dispose();
});

await check('route: the write route rejects garbage and changes nothing', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock(), upstream: UP_OK() });
  const route = state.routes.find((r) => r.path === ROUTES.account);
  const snapshot = () => JSON.stringify([...state.medium.tableFor('account_pool', 'accounts').entries()]);
  const before = snapshot();

  const cases = [
    [{ id: 'a1', action: 'nope' }, 400, 'unknown-action'],
    [{ action: 'disable' }, 400, 'missing-id'],
    [{ id: 'ghost', action: 'disable' }, 404, 'unknown-account'],
    [{ id: 'a1', action: 'set-priority', priority: 'high' }, 400, 'invalid-argument'],
  ];
  for (const [body, status, code] of cases) {
    const response = await route.fetch(actionRequest(body));
    assert.equal(response.status, status, `${JSON.stringify(body)} must be rejected with ${String(status)}`);
    assert.equal((await response.json()).error.code, code);
  }

  const malformed = await route.fetch(actionRequest(null, 'not json'));
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'invalid-json');

  await mounted.flush();
  assert.equal(snapshot(), before, 'a rejected write must leave every record untouched');

  await mounted.dispose();
});

// ------------------------------------------------- domain ownership

await check('mount: registers the domain release with the FIBER, not only with apply', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock(), upstream: UP_OK() });

  const closeEffect = state.effects.find((entry) => entry.label === 'account-pool: domainClose');
  assert.ok(closeEffect !== undefined, 'the release must survive a later throw inside apply');

  // Running the fiber's own disposer closes the domain even though `dispose()`
  // was never called — which is the whole point.
  await closeEffect.disposer();
  assert.equal(state.domainClosed, 1);

  await mounted.dispose();
  assert.equal(state.domainClosed, 1, 'closing twice must be harmless');
});

await check('mount: a leaked domain is reclaimed instead of failing forever', async () => {
  const { ctx, state } = makeCtx();
  // Simulate the leak this plugin actually hit: a fiber opened the domain and
  // then failed before its disposer was collected, so the name stayed reserved.
  await ctx.storageDomain.open(poolDomainSpec);
  assert.equal(ctx.storageDomain.get('account_pool') !== undefined, true);

  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock(), upstream: UP_OK() });

  assert.equal(mounted.adapterRegistered, true, 'the mount must recover, not refuse to start');
  assert.ok(state.logs.warn.some((line) => line.includes('reclaiming')), 'and say so out loud');
  assert.equal(state.domainClosed, 1, 'the leaked handle was closed exactly once');

  await mounted.dispose();
  assert.equal(state.domainClosed, 2);
});

await check('mount: a genuinely concurrent owner is NOT silently stolen', async () => {
  const { ctx, state } = makeCtx();
  // No handle exists for the name, so the reclaim has nothing to close and the
  // original error must surface instead of being swallowed.
  ctx.storageDomain.get = () => undefined;
  ctx.storageDomain.open = async () => {
    const error = new Error("domain 'account_pool' is already open");
    error.code = 'already-open';
    throw error;
  };

  await assert.rejects(
    () => mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock(), upstream: UP_OK() }),
    (error) => error.code === 'already-open',
  );
  assert.equal(state.domainClosed, 0);
});

await check('mount: a throwing timer accessor costs the sweep, not the whole mount', async () => {
  // Regression for the live failure: `typeof ctx.interval` THREW, aborting the
  // mount after the domain was open — no routes, leaked handle, bare HTTP 404.
  const { ctx, state } = makeCtx({ withInterval: 'throws' });
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock(), upstream: UP_OK() });

  assert.equal(mounted.adapterRegistered, true, 'the plugin must still mount');
  assert.equal(state.routes.length, 3, 'and still register its routes');
  assert.equal(state.intervals.length, 0, 'only the sweep is lost');
  assert.ok(state.logs.warn.some((line) => line.includes('timer service is unavailable')));

  await mounted.dispose();
});

// ------------------------------------------------- the status dump

await check('mount: the status dump records exactly what resolved', async () => {
  // This dump exists because an UNDECLARED service is invisible to `ctx.get`,
  // and the only symptom is a bare HTTP 404 on a page that renders fine.
  const { ctx } = makeCtx();
  const dumpPath = join(tmpdir(), `account-pool-status-${String(Date.now())}.json`);

  const mounted = await mountPool(ctx, {
    accounts: CONFIG_ACCOUNTS, clock: makeClock(), upstream: UP_OK(), statusDumpPath: dumpPath,
  });

  const status = JSON.parse(readFileSync(dumpPath, 'utf8'));
  assert.deepEqual(status.capabilities, { storageDomain: true, llm: true, connection: true, timer: true });
  assert.deepEqual(status.registered, { adapter: true, providerDeclared: true, routes: 3 });
  assert.equal(status.entryId, 'account-pool', 'the dump names the identity the Models card is keyed by');
  assert.equal(status.providerRoute, 'pool');
  assert.equal(status.upstreamConfigured, true);
  assert.equal(status.accounts.total, 2);

  await mounted.dispose();
  rmSync(dumpPath, { force: true });
});

await check('mount: in degraded mode the dump names precisely what is missing', async () => {
  const { ctx } = makeCtx({ withLlm: false, withConnection: false, withCredentials: false });
  const dumpPath = join(tmpdir(), `account-pool-status-degraded-${String(Date.now())}.json`);

  const mounted = await mountPool(ctx, {
    accounts: CONFIG_ACCOUNTS, clock: makeClock(), statusDumpPath: dumpPath,
  });

  const status = JSON.parse(readFileSync(dumpPath, 'utf8'));
  assert.deepEqual(status.capabilities, { storageDomain: true, llm: false, connection: false, timer: true });
  assert.deepEqual(status.registered, { adapter: false, providerDeclared: false, routes: 0 });
  assert.equal(status.upstreamConfigured, false);

  await mounted.dispose();
  rmSync(dumpPath, { force: true });
});

await check('route: importing a sub2api backup creates accounts AND stores their secrets', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: [], clock: makeClock() });
  const route = state.routes.find((r) => r.path === ROUTES.account);

  // Field names mirror the real DataAccount struct.
  const document = {
    data: {
      accounts: [
        { name: 'Claude Main', platform: 'anthropic', type: 'oauth', credentials: { access_token: 'at-1', refresh_token: 'rt-1' }, concurrency: 8, priority: 10 },
        { name: 'Codex Backup', platform: 'openai', type: 'apikey', credentials: { api_key: 'sk-plain' }, concurrency: 2, priority: 50 },
        { name: 'No Secrets', platform: 'gemini', type: 'oauth', credentials: {}, concurrency: 1, priority: 90 },
      ],
    },
  };

  const result = await (await route.fetch(actionRequest({ action: 'import', document: JSON.stringify(document) }))).json();
  assert.equal(result.ok, true);
  assert.equal(result.format, 'sub2api');
  assert.deepEqual(result.created, ['claude-main', 'codex-backup']);
  assert.equal(result.errors.length, 1, 'the secret-less record is reported, not silently dropped');
  await mounted.flush();

  const imported = mounted.adapter.getAccount('claude-main');
  assert.equal(imported.platform, 'anthropic');
  assert.equal(imported.concurrency, 8, 'the scheduling fields survive the import');
  assert.equal(imported.credentialRef, 'ACCOUNT_POOL_CLAUDE_MAIN');
  assert.equal(
    state.secrets.get('ACCOUNT_POOL_CLAUDE_MAIN'),
    JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1' }),
    'a multi-field bundle is stored verbatim so the refresh token is not lost',
  );
  assert.equal(state.secrets.get('ACCOUNT_POOL_CODEX_BACKUP'), 'sk-plain', 'a lone key collapses to itself');
  assert.equal(state.secrets.size, 2, 'nothing was stored for the rejected record');

  // The management response must report the credential WITHOUT its value.
  const accountsRoute = state.routes.find((r) => r.path === ROUTES.accounts);
  const listed = await (await accountsRoute.fetch(new Request('http://127.0.0.1/api/accountPool.accounts'))).json();
  assert.equal(listed.accounts.find((account) => account.id === 'claude-main').credential.configured, true);
  assert.equal(JSON.stringify(listed).includes('at-1'), false, 'the secret never reaches the page');

  await mounted.dispose();
});

await check('route: a CPA auth file imports through the same action', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: [], clock: makeClock() });
  const route = state.routes.find((r) => r.path === ROUTES.account);

  const cpa = [{ type: 'claude', access_token: 'cpa-at', refresh_token: 'cpa-rt', email: 'user@example.com' }];
  const result = await (await route.fetch(actionRequest({ action: 'import', document: cpa }))).json();

  assert.equal(result.format, 'cpa');
  assert.deepEqual(result.created, ['user-example-com']);
  await mounted.flush();
  assert.equal(mounted.adapter.getAccount('user-example-com').platform, 'anthropic');
  assert.equal(state.secrets.get('ACCOUNT_POOL_USER_EXAMPLE_COM'), JSON.stringify({ access_token: 'cpa-at', refresh_token: 'cpa-rt' }));

  await mounted.dispose();
});

await check('end-to-end: an IMPORTED account binds the pool and serves a request', async () => {
  // The whole point of the import: an account arriving from a sub2api backup must
  // end up as a registered provider sending its OWN token upstream. This runs
  // import → credential store → resolve → decode → request headers in one go.
  const { ctx, state } = makeCtx();
  const requests = [];
  const sse = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
    '',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
    '',
  ].join('\n');

  const mounted = await mountPool(ctx, {
    accounts: [],
    clock: makeClock(),
    fetchImpl: async (url, init) => {
      requests.push({ url, headers: init.headers });
      return new Response(sse, { status: 200 });
    },
  });

  // Credentials exist, so the pool builds its own transport and binds itself.
  assert.equal(mounted.adapterRegistered, true, 'the pool binds itself as a provider once credentials exist');
  assert.equal(state.providerDeclarations.length, 1, 'and is declared in the provider directory');
  assert.equal(state.providerDeclarations[0].entries[0].provider, 'pool');
  assert.equal(state.providerDeclarations[0].entries[0].settingsNs, 'account-pool');

  const route = state.routes.find((r) => r.path === ROUTES.account);
  const imported = await (await route.fetch(actionRequest({
    action: 'import',
    document: {
      accounts: [{
        name: 'Imported Claude',
        platform: 'anthropic',
        type: 'oauth',
        credentials: { access_token: 'at-real', refresh_token: 'rt-real' },
        priority: 1,
        concurrency: 1,
      }],
    },
  }))).json();
  assert.deepEqual(imported.created, ['imported-claude']);
  await mounted.flush();

  const chunks = await drain(registeredAdapter(state).stream({ sessionId: 's1', model: 'claude-opus-4' }));

  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } });
  assert.equal(requests.length, 1, 'exactly one upstream call');
  assert.equal(requests[0].url, 'https://api.anthropic.com/v1/messages', 'no baseUrl, so the platform default applies');
  assert.equal(
    requests[0].headers['x-api-key'],
    'at-real',
    'the IMPORTED access token went upstream — the bundle was decoded, not sent raw',
  );

  await mounted.dispose();
});

// ------------------------------------------------- groups

await check('groups: creating one makes it selectable immediately, without a restart', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock() });
  const route = state.routes.find((r) => r.path === ROUTES.account);
  const registration = state.registrations[0];

  assert.deepEqual(registration.providers, ['pool'], 'no groups yet, so only the default route');

  const created = await (await route.fetch(actionRequest({
    action: 'group-create',
    group: { id: 'cheap', label: '便宜池', models: ['cheap-model'] },
  }))).json();

  assert.equal(created.ok, true);
  assert.deepEqual(created.routes, ['pool', 'pool-cheap']);
  assert.deepEqual(registration.providers, ['pool', 'pool-cheap']);
  assert.equal(state.registrations.length, 1, 'the adapter was NOT re-registered — only its routes were replaced');
  assert.deepEqual(registration.replaces.at(-1), ['pool', 'pool-cheap']);

  await mounted.flush();
  assert.equal(state.medium.tableFor('account_pool', 'groups').get('cheap').label, '便宜池', 'the group is persisted');

  const updated = await (await route.fetch(actionRequest({
    action: 'group-update', id: 'cheap', group: { label: '更便宜' },
  }))).json();
  assert.equal(updated.group.label, '更便宜');
  assert.deepEqual(updated.group.models, ['cheap-model'], 'an omitted field is left alone');

  await mounted.dispose();
});

await check('groups: deleting one drops its route and leaves the accounts alive', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock() });
  const route = state.routes.find((r) => r.path === ROUTES.account);

  await route.fetch(actionRequest({ action: 'group-create', group: { id: 'vip' } }));
  const assigned = await (await route.fetch(actionRequest({
    action: 'update', id: 'a1', account: { groups: ['vip'] },
  }))).json();
  assert.deepEqual(assigned.account.groups, ['vip'], 'membership is editable through the account CRUD');

  const removed = await (await route.fetch(actionRequest({ action: 'group-delete', id: 'vip' }))).json();
  assert.deepEqual(removed.detached, ['a1'], 'and the response says which accounts were edited');
  assert.deepEqual(removed.routes, ['pool']);
  await mounted.flush();

  assert.deepEqual(mounted.adapter.getAccount('a1').groups, [], 'the account survives, detached');
  assert.equal(mounted.adapter.listAccounts().length, 2, 'no account was deleted');
  assert.deepEqual(state.registrations[0].replaces.at(-1), ['pool'], 'and its route is gone');

  await mounted.dispose();
});

await check('groups: a group id that does not exist is refused at WRITE time', async () => {
  // Otherwise the account silently ends up in no group — a typo would only show up
  // as "the group is empty", long after the mistake.
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock() });
  const route = state.routes.find((r) => r.path === ROUTES.account);

  const updated = await route.fetch(actionRequest({ action: 'update', id: 'a1', account: { groups: ['typo'] } }));
  assert.equal(updated.status, 400);
  assert.equal((await updated.json()).error.code, 'unknown-group');
  assert.deepEqual(mounted.adapter.getAccount('a1').groups, [], 'and the account is untouched');

  const created = await route.fetch(actionRequest({
    action: 'create', id: 'fresh', account: { platform: 'openai', groups: ['typo'] },
  }));
  assert.equal(created.status, 400, 'the create path validates too');
  assert.equal(mounted.adapter.getAccount('fresh'), undefined, 'nothing was written');

  await mounted.dispose();
});

await check('groups: the group verbs reject duplicates, unknown and non-slug ids', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock() });
  const route = state.routes.find((r) => r.path === ROUTES.account);

  await route.fetch(actionRequest({ action: 'group-create', group: { id: 'dup' } }));
  const again = await route.fetch(actionRequest({ action: 'group-create', group: { id: 'dup' } }));
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error.code, 'group-exists');

  const missing = await route.fetch(actionRequest({ action: 'group-update', id: 'ghost', group: { label: 'x' } }));
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'unknown-group');

  const badId = await route.fetch(actionRequest({ action: 'group-create', group: { id: 'Bad Id' } }));
  assert.equal(badId.status, 400, 'a non-slug id cannot become a route suffix');
  assert.equal((await badId.json()).error.code, 'invalid-account', 'a schema failure is reported as an invalid document');

  assert.deepEqual(state.registrations[0].providers, ['pool', 'pool-dup'], 'only the valid group ever became a route');

  await mounted.dispose();
});

await check('import: an optional target group is applied to every imported account', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: [], clock: makeClock() });
  const route = state.routes.find((r) => r.path === ROUTES.account);
  await route.fetch(actionRequest({ action: 'group-create', group: { id: 'imported' } }));

  const result = await (await route.fetch(actionRequest({
    action: 'import',
    group: 'imported',
    document: { accounts: [{ name: 'One', platform: 'openai', credentials: { api_key: 'k1' } }] },
  }))).json();

  assert.equal(result.group, 'imported', 'the response names the group it landed in');
  assert.deepEqual(result.created, ['one']);
  await mounted.flush();
  assert.deepEqual(mounted.adapter.getAccount('one').groups, ['imported']);

  const bad = await route.fetch(actionRequest({
    action: 'import',
    group: 'ghost',
    document: { accounts: [{ name: 'Two', platform: 'openai', credentials: { api_key: 'k2' } }] },
  }));
  assert.equal(bad.status, 400, 'a typo in the target group must not silently import ungrouped');
  assert.equal((await bad.json()).error.code, 'unknown-group');
  assert.equal(mounted.adapter.getAccount('two'), undefined, 'and nothing was written');

  // Without a target group the import still works, leaving accounts ungrouped.
  const plain = await (await route.fetch(actionRequest({
    action: 'import',
    document: { accounts: [{ name: 'Three', platform: 'openai', credentials: { api_key: 'k3' } }] },
  }))).json();
  assert.equal(plain.group, null);
  await mounted.flush();
  assert.deepEqual(mounted.adapter.getAccount('three').groups, []);

  await mounted.dispose();
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
