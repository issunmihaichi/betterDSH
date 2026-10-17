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
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import plugin, { Config, PROVIDER_LABEL, defaultCredentialRef, mountPool, reconcileConfiguredAccounts, resolveAccountCredential, ROUTES } from '../lib/host.js';
import { poolDomainSpec, usageSchema } from '../lib/domain.js';
import { DURATIONS } from '../lib/kernel.js';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

let checks = 0;
let passed = 0;
const failures = [];
const importOnly = process.argv.includes('--import-only');
const nameFilter = process.argv.find((arg) => arg.startsWith('--name='))?.slice('--name='.length);

async function check(label, fn) {
  if (importOnly && !/import/i.test(label)) return;
  if (nameFilter && !new RegExp(nameFilter, 'i').test(label)) return;
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
      // Mirrors the real `DirectoryRegistrationHandle`: withdraws everything, and
      // atomically replaces the entry list — which is how a group edit adds or
      // drops a row without a second registration.
      const record = { entries: [...entries], disposed: false, replaces: [] };
      state.providerDeclarations.push(record);
      const handle = () => { record.disposed = true; state.providerDeclarationsDisposed += 1; };
      handle.replace = (next) => { record.replaces.push([...next]); record.entries = [...next]; };
      return handle;
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
  const events = new Map();
  state.emit = async (event, ...args) => {
    for (const listener of [...(events.get(event) ?? [])]) await listener(...args);
  };
  ctx.on = (event, listener) => {
    if (!events.has(event)) events.set(event, new Set());
    events.get(event).add(listener);
    return () => events.get(event).delete(listener);
  };
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

// ------------------------------------------------- the entry's Config schema

/**
 * The Models page draws a configurable-provider row only when its `settingsNs`
 * resolves to a settings NAMESPACE, and a namespace exists only because this
 * entry exports `Config`. The other half of that contract is that declaring a
 * partial schema must not reshape the operator's config.
 */
await check('config: the entry declares a schema, and it does not swallow what it omits', async () => {
  assert.ok(Config !== undefined, 'Config is exported, which is what makes `account-pool` a settings namespace');
  const resolved = Config({
    statusDumpPath: 'C:/tmp/account-pool-status.json',
    accounts: [{ id: 'main', label: '主号', mimicry: 'claude-code' }],
    somethingAddedLater: { nested: true },
  });
  assert.equal(resolved.statusDumpPath, 'C:/tmp/account-pool-status.json');
  assert.deepEqual(
    resolved.accounts,
    [{ id: 'main', label: '主号', mimicry: 'claude-code' }],
    'the account list is passed through, not reshaped',
  );
  assert.deepEqual(resolved.somethingAddedLater, { nested: true }, 'a key the schema does not mention survives resolution');
  assert.equal(plugin.Config, Config, 'the default plugin export declares the settings namespace');
  assert.equal(Config.dict.providerDisplayName.meta.volatile, true);
  assert.equal(Config({}).providerDisplayName.get(), PROVIDER_LABEL);
  assert.deepEqual(
    Object.keys(Config({})),
    ['providerDisplayName', 'accounts', 'defaultContextWindow', 'providers', 'models'],
    'an empty config includes the live provider label and array defaults',
  );
});

await check('mount: volatile provider label updates the default picker while the directory contains only groups', async () => {
  const { ctx, state } = makeCtx();
  ctx.fiber.entry.options.id = 'account-pool-custom-id';
  const config = Config({ providerDisplayName: 'Before' });
  const label = config.providerDisplayName;
  const mounted = await mountPool(ctx, { ...config, clock: makeClock(), upstream: UP_OK() });
  assert.equal(mounted.adapter.providerInfo('pool').name, 'Before');
  assert.deepEqual(state.providerDeclarations[0].entries, [], 'the default route has no configurable directory row');
  const writeRoute = state.routes.find((r) => r.path === ROUTES.account);
  await writeRoute.fetch(actionRequest({ action: 'group-create', group: { id: 'real', label: 'Real' } }));
  assert.deepEqual(state.providerDeclarations[0].entries.map((entry) => entry.provider), ['pool-real']);
  assert.equal(state.providerDeclarations[0].entries[0].displayName, 'Sub-Real');
  // This is cosmokit's shared write protocol, used by Loader's updateVolatile.
  label[Symbol.for('cosmokit.volatile.write')](Config({ providerDisplayName: 'After' }).providerDisplayName.get());
  await state.emit('loader/volatile-update', [['providerDisplayName']]);
  assert.equal(mounted.adapter.providerInfo('pool').name, 'After');
  assert.deepEqual(state.providerDeclarations[0].entries.map((entry) => entry.provider), ['pool-real']);
  assert.equal(state.providerDeclarations[0].entries[0].displayName, 'Sub-Real');
  assert.equal(state.opened.length, 1);
  assert.equal(state.registrations.length, 1);
  const route = state.routes.find((r) => r.path === ROUTES.accounts);
  const body = await (await route.fetch(new Request('http://127.0.0.1' + ROUTES.accounts))).json();
  assert.equal(body.settingsNs, 'account-pool-custom-id');
  assert.equal(state.providerDeclarations[0].entries[0].settingsNs, body.settingsNs);
  await mounted.dispose();
  label[Symbol.for('cosmokit.volatile.write')]('Disposed');
  await state.emit('loader/volatile-update', [['providerDisplayName']]);
  assert.equal(mounted.adapter.providerInfo('pool').name, 'After', 'dispose removes the live-setting listener');
});

await check('mount: plain provider label and schema-resolved default name the picker without a default directory row', async () => {
  for (const options of [{ providerDisplayName: 'Plain' }, Config({})]) {
    const { ctx, state } = makeCtx();
    const mounted = await mountPool(ctx, { ...options, clock: makeClock(), upstream: UP_OK() });
    const expected = typeof options.providerDisplayName === 'string' ? 'Plain' : PROVIDER_LABEL;
    assert.equal(mounted.adapter.providerInfo('pool').name, expected);
    assert.deepEqual(state.providerDeclarations[0].entries, []);
    await mounted.dispose();
  }
});

// ------------------------------------------------- reconcile

await check('reconcile: inserts missing accounts and preserves existing management fields', async () => {
  const medium = makeMedium();
  const table = makeKvTable(medium.tableFor('account_pool', 'accounts'));
  assert.deepEqual(reconcileConfiguredAccounts(table, CONFIG_ACCOUNTS, iso(T0)), { inserted: 2, refreshed: 0 });
  table.put('a1', { ...table.get('a1'), priority: 5, label: 'UI label', concurrency: 12, schedulable: false, rateLimitResetAt: iso(T0 + 60_000), consecutiveFailures: 2 });
  const before = table.get('a1');
  assert.deepEqual(reconcileConfiguredAccounts(table, [{ id: 'a1', platform: 'custom', priority: 1, label: 'config label', concurrency: 2, schedulable: true }], iso(T0 + 1000)), { inserted: 0, refreshed: 0 });
  assert.deepEqual(table.get('a1'), before, 'stale configuration cannot overwrite any durable field');
});

await check('reconcile: configured beta initializes new rows and cannot replace a UI-edited beta', async () => {
  const medium = makeMedium();
  const table = makeKvTable(medium.tableFor('account_pool', 'accounts'));
  reconcileConfiguredAccounts(table, [{ id: 'a1', betas: ['initial-beta'] }], iso(T0));
  assert.deepEqual(table.get('a1').betas, ['initial-beta']);
  table.put('a1', { ...table.get('a1'), betas: ['ui-beta'], overloadUntil: iso(T0 + 60000) });
  const before = table.get('a1');
  assert.deepEqual(reconcileConfiguredAccounts(table, [{ id: 'a1', betas: ['changed-config-beta'] }], iso(T0 + 1000)), { inserted: 0, refreshed: 0 });
  assert.deepEqual(table.get('a1'), before);
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
  assert.equal(state.routes.length, 5, 'management routes do not depend on `llm`');
  assert.ok(state.logs.warn.some((line) => line.includes('`llm` service is unavailable')));

  await mounted.dispose();
});

await check('mount: registers the management and session speed routes under /api', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock(), upstream: UP_OK() });

  assert.deepEqual(
    state.routes.map((r) => r.path).sort(),
    [ROUTES.accounts, ROUTES.usage, ROUTES.account, ROUTES.oauth, ROUTES.codexSpeed].sort(),
  );
  for (const route of state.routes) {
    assert.ok(route.path.startsWith('/api/'), `${route.path} must live on the authenticated channel`);
    assert.equal(route.requestBody, 'buffered');
    assert.equal(typeof route.fetch, 'function');
  }
  assert.deepEqual(state.routes.find((r) => r.path === ROUTES.accounts).methods, ['GET', 'HEAD']);
  assert.deepEqual(state.routes.find((r) => r.path === ROUTES.usage).methods, ['GET', 'HEAD']);
  assert.deepEqual(state.routes.find((r) => r.path === ROUTES.oauth).methods, ['GET', 'HEAD'], 'the provider directory is read-only');
  assert.deepEqual(state.routes.find((r) => r.path === ROUTES.account).methods, ['POST'], 'the write route is POST-only');

  await mounted.dispose();
});

await check('mount: declares only group routes in the configurable-provider directory keyed by the entry id', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock(), upstream: UP_OK() });

  assert.equal(state.providerDeclarations.length, 1);
  assert.deepEqual(state.providerDeclarations[0].entries, [], 'no group means no configurable provider row');
  const route = state.routes.find((r) => r.path === ROUTES.account);
  await route.fetch(actionRequest({ action: 'group-create', group: { id: 'real' } }));
  assert.equal(state.providerDeclarations[0].entries.length, 1);
  const [entry] = state.providerDeclarations[0].entries;
  assert.equal(entry.provider, 'pool-real');
  assert.equal(entry.settingsNs, 'account-pool', 'settingsNs is the Loader ENTRY ID the Models row edits');
  assert.deepEqual(entry.settingsPath, [], 'an empty path means the whole settings document is the provider config');
  assert.equal(typeof entry.displayName, 'string');

  await mounted.dispose();
  assert.equal(state.providerDeclarationsDisposed, 1, 'dispose withdraws the declaration');
});

await check('models: a route advertises what its accounts AND its group allow, plus the config list', async () => {
  // A picker can only offer what the adapter advertises, so an empty list makes a
  // route registered, named — and impossible to select.
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, {
    accounts: [
      { id: 'a1', platform: 'anthropic', models: ['cheap-model', 'both-model'] },
      { id: 'a2', platform: 'anthropic', models: ['loose-model'] },
    ],
    clock: makeClock(),
    upstream: UP_OK(),
    models: ['config-model'],
  });
  const route = state.routes.find((r) => r.path === ROUTES.account);
  await route.fetch(actionRequest({
    action: 'group-create',
    group: { id: 'cheap', label: '便宜池', models: ['both-model', 'group-model'] },
  }));
  await route.fetch(actionRequest({ action: 'update', id: 'a1', account: { groups: ['cheap'] } }));

  const ids = async (provider) => (await mounted.adapter.listModels(provider)).map((entry) => entry.id);

  assert.deepEqual(
    await ids('pool-cheap'),
    ['both-model'],
    'a group catalog offers only models admitted by a member and its own allow-list',
  );
  assert.deepEqual(
    await ids('pool'),
    ['cheap-model', 'both-model', 'loose-model', 'config-model'],
    'with no preferred group the default route covers every account',
  );

  await route.fetch(actionRequest({ action: 'group-update', id: 'cheap', group: { preferred: true } }));
  assert.deepEqual(
    await ids('pool'),
    ['cheap-model', 'both-model', 'loose-model', 'config-model'],
    'the legacy preferred flag does not narrow the default route',
  );
  assert.deepEqual(await ids('pool-nope'), [], 'an unknown group advertises nothing');

  const [first] = await mounted.adapter.listModels('pool-cheap');
  assert.equal(first.provider, 'pool-cheap', 'each entry names the route it belongs to');
  assert.equal(first.name, first.id);

  await mounted.dispose();
});

await check('models: unrestricted account inherits group menu models in both routes without duplicate maintenance', async () => {
  const {ctx,state}=makeCtx();
  const mounted=await mountPool(ctx,{accounts:[{id:'relay',platform:'anthropic',models:['claude-fixture']}],clock:makeClock(),upstream:UP_OK()});
  const route=state.routes.find(r=>r.path===ROUTES.account);
  await route.fetch(actionRequest({action:'group-create',group:{id:'relay',label:'Relay',models:['claude-fixture','gpt-fixture']}}));
  await route.fetch(actionRequest({action:'group-create',group:{id:'orphan',models:['unsupported-orphan']}}));
  await route.fetch(actionRequest({action:'update',id:'relay',account:{groups:['relay']}}));
  const ids=async(provider)=>(await mounted.adapter.listModels(provider)).map(x=>x.id);
  assert.deepEqual(await ids('pool-relay'),['claude-fixture']);
  const before=state.registrations[0].replaces.length;
  const updated=await(await route.fetch(actionRequest({action:'update',id:'relay',account:{models:[]}}))).json();
  assert.equal(updated.ok,true);assert.deepEqual(updated.account.models,[]);assert.deepEqual(updated.account.groups,['relay']);
  assert.ok(state.registrations[0].replaces.length>before,'Saving the unrestricted mode invalidates the native catalog');
  for(const provider of ['pool','pool-relay'])assert.deepEqual(await ids(provider),['claude-fixture','gpt-fixture']);
  await route.fetch(actionRequest({action:'group-update',id:'relay',group:{models:['claude-fixture','gpt-fixture','third-fixture']}}));
  for(const provider of ['pool','pool-relay'])assert.deepEqual(await ids(provider),['claude-fixture','gpt-fixture','third-fixture']);
  assert.deepEqual(mounted.adapter.getAccount('relay').models,[],'Editing group models leaves the account unrestricted');
  assert.deepEqual(await ids('pool-orphan'),[],'Groups without members do not contribute catalog entries');
  await mounted.dispose();const fresh=makeCtx({medium:state.medium});const reopened=await mountPool(fresh.ctx,{clock:makeClock(),upstream:UP_OK()});
  for(const provider of ['pool','pool-relay'])assert.deepEqual((await reopened.adapter.listModels(provider)).map(x=>x.id),['claude-fixture','gpt-fixture','third-fixture']);
  assert.deepEqual(reopened.adapter.getAccount('relay').models,[]);await reopened.dispose();
});

await check('models: an exact model declares the thinking levels DSH validates against', async () => {
  // DSH rejects a REQUESTED effort the adapter does not declare, BEFORE any I/O —
  // and the profile's `agent-default-model` hands every session `reasoningEffort:
  // max`. Without this metadata every pool turn died with zero tokens and zero
  // session events, which reads as "the session cannot start".
  const { ctx } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock(), upstream: UP_OK() });

  const resolved = await mounted.adapter.resolveModel('pool', 'claude-fable-5-1-reversed');
  const ids = resolved.reasoning.efforts.map((effort) => effort.id);
  assert.deepEqual(ids, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], "DSH's own levels, in escalation order");
  assert.ok(ids.includes('max'), 'the effort an `agent-default-model` hands down must be one of them');
  assert.equal(
    resolved.reasoning.efforts.every((effort) => typeof effort.name === 'string' && effort.name.length > 0),
    true,
    'DSH refuses an effort without a display name',
  );
  assert.equal('defaultEffort' in resolved.reasoning, false, 'no effort is injected into calls that named none');
  assert.equal(resolved.defaultMaxTokens, 64000, 'the output budget DSH materializes instead of the transport fallback');
  assert.equal(resolved.provider, 'pool');
  assert.equal(resolved.id, 'claude-fable-5-1-reversed');

  await mounted.dispose();
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

await check('usage timing: sink and authenticated route persist finite metrics and default historical rows', async () => {
  const clock = makeClock();
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: [{ id: 'a1', platform: 'anthropic' }], clock,
    upstream: { async *stream() {
      clock.advance(20); yield { type: 'block-start', index: 0, blockType: 'text' };
      clock.advance(20); yield { type: 'text-delta', text: 'fixture answer' };
      clock.advance(160); yield { type: 'usage', usage: { outputTokens: 8 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      clock.advance(20000);
    } } });
  for await (const chunk of mounted.adapter.stream({ sessionId: 'timing-fixture', model: 'm' })) {
    if (chunk.type === 'finish') clock.advance(10000);
  }
  await mounted.flush();
  const table = state.medium.tableFor('account_pool', 'usage');
  const stored = usageSchema.parse([...table.values()][0]);
  const expected = { firstTokenMs: 40, outputDurationMs: 160, outputTps: 50 };
  for (const [key, value] of Object.entries(expected)) assert.equal(stored[key], value);
  table.set('legacy-fixture', { id: 'legacy-fixture', at: iso(T0), ok: true, model: 'old' });
  const route = state.routes.find(entry => entry.path === ROUTES.usage);
  const response = await route.fetch(new Request('http://127.0.0.1/api/accountPool.usage'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.usageTimingVersion, 1);
  assert.equal(body.rows.length, 2);
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(body.rows[0][key], value);
    assert.equal(body.rows[1][key], null, 'historical rows serialize null, never fabricated zero');
  }
  const accountsRoute = state.routes.find(entry => entry.path === ROUTES.accounts);
  assert.equal((await (await accountsRoute.fetch(new Request('http://127.0.0.1/api/accountPool.accounts'))).json()).usageTimingVersion, 1);
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

await check('usage effort: selected and mapped levels persist across config changes and remount', async () => {
  const medium = makeMedium();
  const config = Config({ accounts: [{ id: 'effort-account', platform: 'custom', models: ['m'] }],
    providers: { pool: { modelOverrides: { m: { reasoningEfforts: { off: null, high: 'xhigh' } } } } } });
  const first = makeCtx({ medium });
  const mounted = await mountPool(first.ctx, { ...config, clock: makeClock(), upstream: UP_OK() });
  try {
    await drain(mounted.adapter.stream({ model: 'm', reasoningEffort: 'high' }));
    await drain(mounted.adapter.stream({ model: 'm', reasoningEffort: 'off' }));
    await mounted.flush();
    const route = first.state.routes.find(row => row.path === ROUTES.usage);
    const body = await (await route.fetch(new Request('http://127.0.0.1/api/accountPool.usage'))).json();
    assert.deepEqual(body.rows.map(row => [row.reasoningEffort, row.mappedReasoningEffort]).sort(), [['high', 'xhigh'], ['off', null]].sort());
  } finally { await mounted.dispose(); }
  const next = makeCtx({ medium });
  const remounted = await mountPool(next.ctx, { clock: makeClock(), upstream: UP_OK() });
  try {
    const route = next.state.routes.find(row => row.path === ROUTES.usage);
    const body = await (await route.fetch(new Request('http://127.0.0.1/api/accountPool.usage'))).json();
    assert.deepEqual(body.rows.map(row => [row.reasoningEffort, row.mappedReasoningEffort]).sort(), [['high', 'xhigh'], ['off', null]].sort(), 'history is not reconstructed from current provider settings');
  } finally { await remounted.dispose(); }
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
  assert.equal(state.routeDisposed, 5);

  await mounted.dispose();
  assert.equal(state.domainClosed, 1, 'disposal must be idempotent');
  assert.equal(state.routeDisposed, 5, 'a second dispose must not re-run route disposers');
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

await check('route: set-mimicry makes an imported subscription account send a disguised request', async () => {
  // The whole chain in one go: management route → domain row → transport headers
  // and body. A disguise that is internally consistent but never wired to the
  // route would pass every unit test and fail here.
  const { ctx, state } = makeCtx();
  const requests = [];
  const sse = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
    '',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
    '',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');

  const mounted = await mountPool(ctx, {
    accounts: [],
    clock: makeClock(),
    fetchImpl: async (url, init) => {
      requests.push({ url, headers: init.headers, body: init.body });
      return new Response(sse, { status: 200 });
    },
  });
  const route = state.routes.find((r) => r.path === ROUTES.account);

  const imported = await (await route.fetch(actionRequest({
    action: 'import',
    document: {
      accounts: [{
        name: 'Claude Main',
        platform: 'anthropic',
        type: 'oauth',
        credentials: { access_token: 'at-real', refresh_token: 'rt-real' },
      }],
    },
  }))).json();
  assert.deepEqual(imported.created, ['claude-main']);
  await mounted.flush();

  // Before the mode is on: a plain OAuth call. Bearer, and no CLI identity at all.
  await drain(registeredAdapter(state).stream({ sessionId: 's1', model: 'claude-opus-4' }));
  assert.equal(requests[0].headers.authorization, 'Bearer at-real');
  assert.equal(requests[0].headers['user-agent'], undefined, 'nothing is disguised while the mode is off');

  const enabled = await (await route.fetch(actionRequest({
    id: 'claude-main', action: 'set-mimicry', mimicry: 'claude-code',
  }))).json();
  assert.equal(enabled.ok, true);
  assert.equal(enabled.account.mimicry, 'claude-code');
  await mounted.flush();
  assert.equal(
    state.medium.tableFor('account_pool', 'accounts').get('claude-main').mimicry,
    'claude-code',
    'and the mode is persisted, so a restart keeps it',
  );

  await drain(registeredAdapter(state).stream({ sessionId: 's1', model: 'claude-opus-4' }));
  const disguised = requests[1];
  assert.equal(disguised.headers['user-agent'], 'claude-cli/2.1.258 (external, cli)');
  assert.equal(disguised.headers['x-app'], 'cli');
  assert.equal(disguised.headers.authorization, 'Bearer at-real', 'the disguise does not replace the credential');
  assert.equal('x-api-key' in disguised.headers, false, 'and does not add a second, wrong auth header');

  const sent = JSON.parse(disguised.body);
  assert.match(sent.system[0].text, /^x-anthropic-billing-header: cc_version=2\.1\.258\.[0-9a-f]{3}; cc_entrypoint=cli;$/);
  assert.equal(sent.system[1].text, "You are Claude Code, Anthropic's official CLI for Claude.");
  assert.equal(typeof sent.metadata.user_id, 'string');
  assert.equal(sent.metadata.user_id[0], '{', 'CLI 2.1.258 uses the JSON user_id framing');

  // A mode the group does not implement is refused, and the row is left alone.
  const bad = await route.fetch(actionRequest({ id: 'claude-main', action: 'set-mimicry', mimicry: 'claude' }));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'invalid-argument');
  await mounted.flush();
  assert.equal(state.medium.tableFor('account_pool', 'accounts').get('claude-main').mimicry, 'claude-code');

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
    [{ id: 'a1', action: 'set-mimicry', mimicry: 'claude' }, 400, 'invalid-argument'],
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
  assert.equal(state.routes.length, 5, 'and still register its routes');
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
  assert.deepEqual(status.capabilities, { storageDomain: true, llm: true, connection: true, timer: true, attachments: false });
  assert.deepEqual(status.registered, { adapter: true, providerDeclared: true, routes: 5 });
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
  assert.deepEqual(status.capabilities, { storageDomain: true, llm: false, connection: false, timer: true, attachments: false });
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

await check('route: CPA auth files import and issue protocol-specific requests', async () => {
  const { ctx, state } = makeCtx();
  const requests = [];
  const mounted = await mountPool(ctx, { accounts: [], clock: makeClock(), fetchImpl: async (url, init) => {
    requests.push({ url, init });
    if (url.includes('/codex/responses')) return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', id: 'fixture-message', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] }] } }) + '\n\n');
    if (url.includes('streamGenerateContent')) return new Response('data: ' + JSON.stringify({ response: { candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] } }) + '\n\n');
    return new Response('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\ndata: {"type":"message_stop"}\n\n');
  } });
  const route = state.routes.find((r) => r.path === ROUTES.account);
  const cpa = [
    { type: 'claude', access_token: 'cpa-at', refresh_token: 'cpa-rt', email: 'user@example.com' },
    { type: 'codex', access_token: 'fixture-codex-access', refresh_token: 'fixture-codex-refresh', account_id: 'fixture-workspace', email: 'codex@example.com' },
    { type: 'gemini', email: 'gemini@example.com', project_id: 'fixture-project', token: { access_token: 'fixture-gemini-access', refresh_token: 'fixture-gemini-refresh', expiry: '2027-01-15T08:00:00Z' } },
  ];
  const result = await (await route.fetch(actionRequest({ action: 'import', document: cpa }))).json();
  assert.equal(result.format, 'cpa');
  assert.deepEqual(result.created, ['user-example-com', 'codex-example-com', 'gemini-example-com']);
  assert.deepEqual(result.errors, []);
  assert.equal(state.secrets.get('ACCOUNT_POOL_USER_EXAMPLE_COM'), JSON.stringify({ access_token: 'cpa-at', refresh_token: 'cpa-rt' }));
  for (const [id, model] of [['user-example-com', 'claude-fixture'], ['codex-example-com', 'gpt-5'], ['gemini-example-com', 'gemini-2.5-flash']]) {
    const tested = await mounted.adapter.testAccount(id, { model });
    assert.equal(tested.ok, true, `${id}: ${tested.errorCode}`);
  }
  assert.equal(requests.length, 3);
  assert.equal(requests[0].init.headers.authorization, 'Bearer cpa-at');
  assert.equal(requests[1].init.headers.authorization, 'Bearer fixture-codex-access');
  assert.equal(requests[1].init.headers['chatgpt-account-id'], 'fixture-workspace');
  assert.equal(requests[2].init.headers.authorization, 'Bearer fixture-gemini-access');
  assert.equal(JSON.parse(requests[2].init.body).project, 'fixture-project');
  await mounted.flush();
  await mounted.dispose();
  const reopened = await mountPool(makeCtx({ medium: state.medium }).ctx, { clock: makeClock(), upstream: UP_OK() });
  assert.equal(reopened.adapter.getAccount('gemini-example-com').projectId, 'fixture-project');
  assert.equal(reopened.adapter.getAccount('codex-example-com').chatgptAccountId, 'fixture-workspace');
  await reopened.dispose();
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
    'data: {"type":"message_stop"}',
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
  assert.equal(state.providerDeclarations.length, 1, 'the configurable directory registration is ready for groups');
  assert.deepEqual(state.providerDeclarations[0].entries, [], 'an account without a group creates no default directory row');

  const route = state.routes.find((r) => r.path === ROUTES.account);
  const imported = await (await route.fetch(actionRequest({
    action: 'import',
    document: {
      accounts: [{
        name: 'Imported Claude',
        platform: 'anthropic',
        type: 'oauth',
        credentials: { access_token: 'at-real', refresh_token: 'rt-real', base_url: 'https://fixture-relay.invalid' },
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
  assert.equal(requests[0].url, 'https://fixture-relay.invalid/v1/messages?beta=true', 'the imported upstream address is used');
  assert.equal(
    requests[0].headers.authorization,
    'Bearer at-real',
    'the IMPORTED access token went upstream — as Bearer, because an OAuth credential is not an API key',
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

  // One name per route keeps group entries distinct in the provider picker;
  // the default route still answers with the pool label for compatibility.
  assert.deepEqual(mounted.adapter.providerInfo('pool'), { id: 'pool', name: '号池' }, 'the default route answers with the pool label');
  assert.deepEqual(mounted.adapter.providerInfo('pool-cheap'), { id: 'pool-cheap', name: 'Sub-便宜池' }, 'a group route answers with ITS group label');
  assert.deepEqual(mounted.adapter.providerInfo(), { id: 'pool', name: '号池' }, 'no argument still means the default route');

  // The configurable directory offers a row for each real group.
  // The callable default route has no corresponding group or settings row.
  assert.deepEqual(
    state.providerDeclarations[0].entries.map((declared) => declared.provider),
    ['pool-cheap'],
    'the new group is declared as its own provider row',
  );
  assert.equal(
    state.providerDeclarations[0].entries.find((declared) => declared.provider === 'pool-cheap').displayName,
    'Sub-便宜池',
    'and that row carries the group label',
  );
  assert.equal(state.providerDeclarations.length, 1, 'a group edit REPLACES the declaration instead of adding another');
  assert.equal(
    state.providerDeclarations[0].entries.every((declared) => declared.declared === true),
    true,
    'every row is flagged configuration-declared, which is what draws the 「自定义」 chip',
  );

  await mounted.flush();
  assert.equal(state.medium.tableFor('account_pool', 'groups').get('cheap').label, '便宜池', 'the group is persisted');

  const updated = await (await route.fetch(actionRequest({
    action: 'group-update', id: 'cheap', group: { label: '更便宜' },
  }))).json();
  assert.equal(updated.group.label, '更便宜');
  assert.deepEqual(updated.group.models, ['cheap-model'], 'an omitted field is left alone');
  assert.equal(mounted.adapter.providerInfo('pool-cheap').name, 'Sub-更便宜', 'and a renamed group renames its provider row with it');

  await mounted.dispose();
});

await check('groups: deleting one drops its route and leaves the accounts alive', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock() });
  const route = state.routes.find((r) => r.path === ROUTES.account);

  await route.fetch(actionRequest({ action: 'group-create', group: { id: 'vip' } }));
  assert.equal(mounted.adapter.providerInfo('pool-vip').name, 'Sub-vip', 'an unlabelled group is named by its id');
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
  assert.deepEqual(
    state.providerDeclarations[0].entries.map((declared) => declared.provider),
    [],
    'deleting the last group withdraws the last configurable provider row',
  );

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

await check('groups: legacy preference is ignored by edits and cannot narrow the pool', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock() });
  const route = state.routes.find((r) => r.path === ROUTES.account);
  await route.fetch(actionRequest({ action: 'group-create', group: { id: 'one' } }));
  await route.fetch(actionRequest({ action: 'group-create', group: { id: 'two' } }));
  assert.equal((await route.fetch(actionRequest({ action: 'group-update', id: 'one', group: { preferred: true } }))).status, 400);
  assert.equal((await route.fetch(actionRequest({ action: 'group-create', group: { id: 'bad', preferred: true } }))).status, 400);
  assert.equal(mounted.adapter.listGroups().some((group) => group.preferred), false);
  await mounted.flush();
  assert.equal(state.medium.tableFor('account_pool', 'groups').get('one').preferred, false);
  await mounted.dispose();
});

await check('priorities: an override is per (account, pool) and lands on disk', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock() });
  const route = state.routes.find((r) => r.path === ROUTES.account);
  await route.fetch(actionRequest({ action: 'group-create', group: { id: 'cheap' } }));

  const set = await (await route.fetch(actionRequest({
    action: 'priority-set', id: 'a1', group: 'cheap', priority: 7,
  }))).json();
  assert.equal(set.ok, true);
  assert.deepEqual(set.priority, { accountId: 'a1', groupId: 'cheap', priority: 7 });
  await mounted.flush();

  const entries = mounted.adapter.listPriorities();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].priority, 7);
  assert.equal(
    state.medium.tableFor('account_pool', 'priorities').get('a1|cheap').priority,
    7,
    'persisted under the composite key the medium expects',
  );

  const cleared = await (await route.fetch(actionRequest({
    action: 'priority-clear', id: 'a1', group: 'cheap',
  }))).json();
  assert.equal(cleared.cleared, true);
  await mounted.flush();
  assert.deepEqual(mounted.adapter.listPriorities(), []);
  assert.equal(state.medium.tableFor('account_pool', 'priorities').has('a1|cheap'), false, 'and removed from disk');
  assert.equal(
    (await (await route.fetch(actionRequest({ action: 'priority-clear', id: 'a1', group: 'cheap' }))).json()).cleared,
    false,
    'clearing twice reports that nothing was there',
  );

  await mounted.dispose();
});

await check('priorities: both ends are checked so no orphan override can be created', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock() });
  const route = state.routes.find((r) => r.path === ROUTES.account);
  await route.fetch(actionRequest({ action: 'group-create', group: { id: 'cheap' } }));

  const ghostAccount = await route.fetch(actionRequest({
    action: 'priority-set', id: 'nobody', group: 'cheap', priority: 1,
  }));
  assert.equal(ghostAccount.status, 404);
  assert.equal((await ghostAccount.json()).error.code, 'unknown-account');

  const ghostGroup = await route.fetch(actionRequest({
    action: 'priority-set', id: 'a1', group: 'ghost', priority: 1,
  }));
  assert.equal(ghostGroup.status, 404);
  assert.equal((await ghostGroup.json()).error.code, 'unknown-group');

  const badValue = await route.fetch(actionRequest({
    action: 'priority-set', id: 'a1', group: 'cheap', priority: 'high',
  }));
  assert.equal(badValue.status, 400);
  assert.equal((await badValue.json()).error.code, 'invalid-priority');

  const noGroup = await route.fetch(actionRequest({ action: 'priority-set', id: 'a1', priority: 1 }));
  assert.equal(noGroup.status, 400);
  assert.equal((await noGroup.json()).error.code, 'missing-group');

  assert.deepEqual(mounted.adapter.listPriorities(), [], 'and nothing was written by any of them');

  await mounted.dispose();
});

await check('batch: every account is reported on its own, and a no-op is not a success', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock() });
  const route = state.routes.find((r) => r.path === ROUTES.account);
  await route.fetch(actionRequest({ action: 'group-create', group: { id: 'cheap' } }));

  const added = await (await route.fetch(actionRequest({
    action: 'batch', verb: 'group-add', group: 'cheap', ids: ['a1', 'a2', 'nobody'],
  }))).json();
  assert.deepEqual(added.done, ['a1', 'a2']);
  assert.deepEqual(added.failed, [{ id: 'nobody', reason: 'unknown-account' }], 'the missing one is NAMED, not skipped');
  assert.equal(added.ok, false, 'a batch containing a failure must not report success');

  const again = await (await route.fetch(actionRequest({
    action: 'batch', verb: 'group-add', group: 'cheap', ids: ['a1'],
  }))).json();
  assert.deepEqual(
    again.failed,
    [{ id: 'a1', reason: 'already-in-group' }],
    'a no-op is reported rather than counted as work done',
  );

  // The state verbs run through the very same pure action the single-account route uses.
  const disabled = await (await route.fetch(actionRequest({
    action: 'batch', verb: 'disable', ids: ['a1', 'a2'],
  }))).json();
  assert.deepEqual(disabled.done, ['a1', 'a2']);
  await mounted.flush();
  assert.equal(mounted.adapter.getAccount('a1').schedulable, false, 'and the effect is real');
  assert.deepEqual(mounted.adapter.getAccount('a1').groups, ['cheap'], 'membership from the earlier batch survived');

  await mounted.dispose();
});

await check('batch: the verb and the group are validated BEFORE anything is written', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock() });
  const route = state.routes.find((r) => r.path === ROUTES.account);

  const badVerb = await route.fetch(actionRequest({ action: 'batch', verb: 'nonsense', ids: ['a1'] }));
  assert.equal(badVerb.status, 400);
  assert.equal((await badVerb.json()).error.code, 'unknown-verb');

  const noIds = await route.fetch(actionRequest({ action: 'batch', verb: 'disable', ids: [] }));
  assert.equal(noIds.status, 400);
  assert.equal((await noIds.json()).error.code, 'missing-ids');

  const noGroup = await route.fetch(actionRequest({ action: 'batch', verb: 'group-add', ids: ['a1'] }));
  assert.equal(noGroup.status, 400);
  assert.equal((await noGroup.json()).error.code, 'missing-group');

  const ghostGroup = await route.fetch(actionRequest({
    action: 'batch', verb: 'group-add', group: 'ghost', ids: ['a1'],
  }));
  assert.equal(ghostGroup.status, 404);
  assert.equal((await ghostGroup.json()).error.code, 'unknown-group');

  assert.equal(mounted.adapter.getAccount('a1').schedulable, true, 'nothing was changed by any rejected batch');

  await mounted.dispose();
});

// ------------------------------------------------- OAuth login

/** One vendor token response, as `fetch` would answer it. */
const TOKEN_OK = (body) => async () => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

await check('oauth: the provider directory lists every storable provider, with its UI hints', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: [], clock: makeClock(), upstream: UP_OK() });

  const route = state.routes.find((r) => r.path === ROUTES.oauth);
  const body = await (await route.fetch(new Request('http://127.0.0.1/api/accountPool.oauth'))).json();

  assert.deepEqual(body.providers.map((p) => p.id), ['openai', 'grok', 'gemini', 'anthropic']);
  // The picker needs to know which provider sends its code somewhere only the
  // operator can read, and which endpoints are not citable.
  assert.equal(body.providers.find((p) => p.id === 'gemini').manualOnly, true);
  assert.equal(body.providers.find((p) => p.id === 'openai').manualOnly, false);
  assert.equal(body.providers.find((p) => p.id === 'anthropic').unverified, true);
  assert.equal(body.flows.length, 0);
  assert.equal(body.callbackServer, null, 'no port is bound until a login actually starts');

  await mounted.dispose();
});

await check('oauth-start: binds the listener on the REGISTERED redirect, and the FLOW shares it', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: [], clock: makeClock(), upstream: UP_OK() });
  const route = state.routes.find((r) => r.path === ROUTES.account);

  const started = await (await route.fetch(actionRequest({ action: 'oauth-start', provider: 'openai' }))).json();
  assert.equal(started.ok, true);
  assert.equal(started.manualOnly, false);
  const redirect = new URL(started.flow.authUrl).searchParams.get('redirect_uri');
  // Measured against the live authorize endpoint: OpenAI accepts
  // `127.0.0.1:<any port>/auth/callback` and refuses `localhost:...` or any other
  // path with `invalid_authorize_request`, before the operator sees a consent
  // screen. So the registered halves are the HOST and the PATH; the port is the
  // Codex client's free-port loopback.
  assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  // The authorize URL and the flow must agree, or the token exchange that echoes
  // `redirect_uri` gets refused by the vendor.
  assert.equal(started.flow.redirectUri, redirect);
  assert.equal(started.flow.status, 'pending');
  assert.ok(state.logs.info.some((line) => line.includes('oauth callback listener on')));

  // The directory route now reports the bound listener.
  const directory = await (await state.routes.find((r) => r.path === ROUTES.oauth)
    .fetch(new Request('http://127.0.0.1/api/accountPool.oauth'))).json();
  assert.equal(directory.callbackServer.redirectUri, redirect);
  assert.equal(directory.flows.length, 1);

  await mounted.dispose();
  // Disposal really released the port.
  await assert.rejects(fetch(redirect));
});

await check('oauth-start: Gemini is manual-only and binds NO port', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: [], clock: makeClock(), upstream: UP_OK() });
  const route = state.routes.find((r) => r.path === ROUTES.account);

  const started = await (await route.fetch(actionRequest({ action: 'oauth-start', provider: 'gemini' }))).json();
  assert.equal(started.manualOnly, true);
  assert.equal(
    new URL(started.flow.authUrl).searchParams.get('redirect_uri'),
    'https://codeassist.google.com/authcode',
  );
  const directory = await (await state.routes.find((r) => r.path === ROUTES.oauth)
    .fetch(new Request('http://127.0.0.1/api/accountPool.oauth'))).json();
  assert.equal(directory.callbackServer, null, 'a fixed-redirect provider must not open a port');

  await mounted.dispose();
});

await check('oauth-start: an unknown provider and an unknown group are refused up front', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: [], clock: makeClock(), upstream: UP_OK() });
  const route = state.routes.find((r) => r.path === ROUTES.account);

  const unknown = await route.fetch(actionRequest({ action: 'oauth-start', provider: 'myspace' }));
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error.code, 'unknown-provider');

  // Checked BEFORE the operator is sent off to sign in: failing after a
  // successful login would waste the login.
  const badGroup = await route.fetch(actionRequest({ action: 'oauth-start', provider: 'openai', group: 'ghost' }));
  assert.equal(badGroup.status, 404);
  assert.equal((await badGroup.json()).error.code, 'unknown-group');

  await mounted.dispose();
});

await check('oauth-finish: stores the secret, creates an OAuth account, and never shows the secret', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, {
    accounts: [],
    clock: makeClock(),
    upstream: UP_OK(),
    fetchImpl: TOKEN_OK({
      access_token: 'at-openai',
      refresh_token: 'rt-openai',
      expires_in: 3600,
      id_token: `h.${Buffer.from(JSON.stringify({ email: 'me@example.com', sub: 'sub-1' })).toString('base64url')}.s`,
    }),
  });
  const route = state.routes.find((r) => r.path === ROUTES.account);

  const started = await (await route.fetch(actionRequest({ action: 'oauth-start', provider: 'openai' }))).json();
  const nonce = new URL(started.flow.authUrl).searchParams.get('state');
  const finished = await route.fetch(actionRequest({
    action: 'oauth-finish',
    flow: started.flow.id,
    input: `http://localhost:1/oauth/callback?code=the-code&state=${nonce}`,
  }));
  const body = await finished.json();

  assert.equal(finished.status, 200);
  assert.equal(body.flow.status, 'done');
  assert.equal(body.credential.configured, true, 'the credential store really got a value');
  assert.equal(body.account.credentialRef, defaultCredentialRef(body.account.id));

  // The account is a real pool row: right platform, bearer auth, usable.
  const stored = mounted.adapter.getAccount(body.account.id);
  assert.equal(stored.platform, 'openai');
  assert.equal(stored.authMode, 'oauth', 'a subscription token must travel as a bearer');
  assert.equal(stored.schedulable, true);

  // The bundle went to the credential store, NOT into the domain.
  const secret = state.secrets.get(defaultCredentialRef(body.account.id));
  assert.equal(JSON.parse(secret).access_token, 'at-openai');
  assert.equal(JSON.stringify([...mounted.adapter.listAccounts()]).includes('at-openai'), false, 'the secret is not in any account row');

  // And the transport resolves it through the refresher. The injected `fetch` is
  // passed here too: without it the resolver would fall back to the REAL global
  // fetch and quietly fail, which is the same trap the host avoids by injecting.
  // Note `ctx.get('credentials')`: the fake context exposes the service the way
  // Cordis does for an INJECTED name, not as a plain property.
  const resolved = await resolveAccountCredential(ctx.get('credentials'), stored, {
    fetchImpl: TOKEN_OK({ access_token: 'at-openai', expires_in: 3600 }),
    clock: makeClock(),
  });
  assert.equal(resolved, 'at-openai');

  await mounted.dispose();
});

await check('oauth-callback: the browser receives success after persistence, then the listener closes', async () => {
  const { ctx, state } = makeCtx();
  let exchanges = 0;
  const token = 'fixture-private-callback-token';
  const refresh = 'fixture-private-callback-refresh';
  const code = 'fixture-private-authorization-code';
  const mounted = await mountPool(ctx, {
    accounts: [], clock: makeClock(), upstream: UP_OK(),
    fetchImpl: async () => {
      exchanges += 1;
      return TOKEN_OK({ access_token: token, refresh_token: refresh, expires_in: 3600 })();
    },
  });
  try {
    const route = state.routes.find((r) => r.path === ROUTES.account);
    const started = await (await route.fetch(actionRequest({ action: 'oauth-start', provider: 'openai' }))).json();
    const nonce = new URL(started.flow.authUrl).searchParams.get('state');
    const callback = new URL(started.flow.redirectUri);
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', nonce);
    const response = await fetch(callback, { signal: AbortSignal.timeout(3000) });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('connection'), 'close');
    assert.match(html, /登录成功/);
    assert.match(html, /Sign-in complete/);
    assert.match(html, /Return to the DSH account pool/);
    assert.match(html, /<\/html>$/);
    const status = await (await route.fetch(actionRequest({ action: 'oauth-status', flow: started.flow.id }))).json();
    assert.equal(status.flow.status, 'done');
    assert.equal(mounted.adapter.listAccounts().length, 1);
    const account = mounted.adapter.getAccount(status.flow.accountId);
    assert.equal(account.authMode, 'oauth');
    assert.ok(state.medium.tableFor('account_pool', 'accounts').has(account.id), 'account is durable before browser success');
    assert.equal(JSON.parse(state.secrets.get(account.credentialRef)).access_token, token);
    assert.match(html, new RegExp(account.id));
    const directory = await (await state.routes.find((r) => r.path === ROUTES.oauth)
      .fetch(new Request('http://127.0.0.1/api/accountPool.oauth'))).json();
    assert.equal(directory.callbackServer, null);
    await assert.rejects(fetch(started.flow.redirectUri, { signal: AbortSignal.timeout(1000) }), 'successful callback releases its listener');
    const duplicate = await (await route.fetch(actionRequest({ action: 'oauth-finish', flow: started.flow.id, input: callback.href }))).json();
    assert.equal(duplicate.flow.accountId, account.id);
    assert.equal(exchanges, 1, 'a duplicate finish does not redeem or persist twice');
    assert.equal(mounted.adapter.listAccounts().length, 1);
    const logged = JSON.stringify(state.logs);
    for (const secret of [token, refresh, code, nonce]) {
      assert.equal(logged.includes(secret), false, 'callback logs contain no OAuth secrets');
      assert.equal(html.includes(secret), false, 'success page contains no OAuth secrets');
    }
  } finally {
    await mounted.dispose();
  }
});

await check('oauth-callback: an in-flight duplicate is refused without interrupting the successful response', async () => {
  const { ctx, state } = makeCtx();
  let entered;
  let release;
  let exchanges = 0;
  const exchanging = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const mounted = await mountPool(ctx, {
    accounts: [], clock: makeClock(), upstream: UP_OK(),
    fetchImpl: async () => {
      exchanges += 1;
      entered();
      await gate;
      return TOKEN_OK({ access_token: 'fixture-duplicate-token', expires_in: 3600 })();
    },
  });
  try {
    const route = state.routes.find((r) => r.path === ROUTES.account);
    const started = await (await route.fetch(actionRequest({ action: 'oauth-start', provider: 'openai' }))).json();
    const callback = new URL(started.flow.redirectUri);
    callback.searchParams.set('code', 'fixture-duplicate-code');
    callback.searchParams.set('state', new URL(started.flow.authUrl).searchParams.get('state'));
    const first = fetch(callback, { signal: AbortSignal.timeout(3000) });
    await exchanging;
    const duplicate = await fetch(callback, { signal: AbortSignal.timeout(3000) });
    assert.equal(duplicate.status, 400);
    assert.match(await duplicate.text(), /already exchanged/);
    release();
    const success = await first;
    assert.equal(success.status, 200);
    assert.match(await success.text(), /Sign-in complete/);
    assert.equal(exchanges, 1);
    assert.equal(mounted.adapter.listAccounts().length, 1);
    await assert.rejects(fetch(started.flow.redirectUri));
  } finally {
    release();
    await mounted.dispose();
  }
});

await check('oauth-callback: expiry still releases an abandoned listener', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: [], clock: makeClock(), upstream: UP_OK(), oauthFlowTtlMs: 40 });
  try {
    const route = state.routes.find((r) => r.path === ROUTES.account);
    let expired;
    const closing = new Promise((resolve) => { expired = resolve; });
    const logger = ctx.logger;
    const originalInfo = logger.info;
    logger.info = (...args) => {
      originalInfo(...args);
      if (String(args[0]).includes('closing the oauth callback listener')) expired();
    };
    const started = await (await route.fetch(actionRequest({ action: 'oauth-start', provider: 'openai' }))).json();
    await closing;
    await assert.rejects(fetch(started.flow.redirectUri, { signal: AbortSignal.timeout(1000) }));
    assert.equal(mounted.adapter.listAccounts().length, 0);
  } finally {
    await mounted.dispose();
  }
});

await check('oauth-finish: a state mismatch is refused, and NO account is created', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, {
    accounts: [],
    clock: makeClock(),
    upstream: UP_OK(),
    fetchImpl: TOKEN_OK({ access_token: 'at', expires_in: 3600 }),
  });
  const route = state.routes.find((r) => r.path === ROUTES.account);

  const started = await (await route.fetch(actionRequest({ action: 'oauth-start', provider: 'openai' }))).json();
  const refused = await route.fetch(actionRequest({
    action: 'oauth-finish', flow: started.flow.id, input: 'http://x/oauth/callback?code=c&state=hostile',
  }));
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error.code, 'oauth-finish-failed');
  assert.equal(mounted.adapter.listAccounts().length, 0);

  await mounted.dispose();
});

await check('oauth-finish: an unknown flow and an empty paste are both refused', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: [], clock: makeClock(), upstream: UP_OK() });
  const route = state.routes.find((r) => r.path === ROUTES.account);

  const noFlow = await route.fetch(actionRequest({ action: 'oauth-finish', flow: 'ghost', input: 'c' }));
  assert.equal(noFlow.status, 400);

  const noInput = await route.fetch(actionRequest({ action: 'oauth-finish', flow: 'ghost' }));
  assert.equal(noInput.status, 400);
  assert.equal((await noInput.json()).error.code, 'missing-code');

  await mounted.dispose();
});

await check('oauth-cancel: drops a pending login and closes the port it opened', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: [], clock: makeClock(), upstream: UP_OK() });
  const route = state.routes.find((r) => r.path === ROUTES.account);

  const started = await (await route.fetch(actionRequest({ action: 'oauth-start', provider: 'grok' }))).json();
  const redirect = started.flow.redirectUri;
  const cancelled = await (await route.fetch(actionRequest({ action: 'oauth-cancel', flow: started.flow.id }))).json();
  assert.equal(cancelled.dropped, true);

  const status = await (await route.fetch(actionRequest({ action: 'oauth-status', flow: started.flow.id }))).json();
  assert.equal(status.flow, null);
  assert.equal(status.flows.length, 0);
  await assert.rejects(fetch(redirect), 'the listener must be released with the login');

  await mounted.dispose();
});

await check('oauth-status: reports every live flow so a half-finished login is visible', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: [], clock: makeClock(), upstream: UP_OK() });
  const route = state.routes.find((r) => r.path === ROUTES.account);

  await route.fetch(actionRequest({ action: 'oauth-start', provider: 'openai' }));
  await route.fetch(actionRequest({ action: 'oauth-start', provider: 'gemini' }));
  const status = await (await route.fetch(actionRequest({ action: 'oauth-status' }))).json();
  assert.equal(status.flows.length, 2);
  assert.deepEqual(status.flows.map((f) => f.provider).sort(), ['gemini', 'openai']);

  await mounted.dispose();
});

await check('oauth-finish: Gemini\'s exchange carries a project-id caveat into the flow', async () => {
  const { ctx, state } = makeCtx();
  process.env.GEMINI_CLI_OAUTH_CLIENT_SECRET = 'test-secret';
  const mounted = await mountPool(ctx, {
    accounts: [],
    clock: makeClock(),
    upstream: UP_OK(),
    fetchImpl: TOKEN_OK({ access_token: 'at-gemini', refresh_token: 'rt-gemini', expires_in: 3599 }),
  });
  const route = state.routes.find((r) => r.path === ROUTES.account);

  const started = await (await route.fetch(actionRequest({ action: 'oauth-start', provider: 'gemini' }))).json();
  const nonce = new URL(started.flow.authUrl).searchParams.get('state');
  const body = await (await route.fetch(actionRequest({
    action: 'oauth-finish',
    flow: started.flow.id,
    input: `https://codeassist.google.com/authcode?code=c&state=${nonce}`,
  }))).json();

  assert.equal(body.flow.status, 'done');
  assert.match(body.flow.caveat, /project_id/, 'the UI has to be able to warn about this');
  assert.equal(mounted.adapter.getAccount(body.account.id).platform, 'gemini');

  delete process.env.GEMINI_CLI_OAUTH_CLIENT_SECRET;
  await mounted.dispose();
});

await check('oauth: an account created by a login is schedulable through the pool route', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, {
    accounts: [],
    clock: makeClock(),
    upstream: UP_OK(),
    fetchImpl: TOKEN_OK({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }),
  });
  const route = state.routes.find((r) => r.path === ROUTES.account);
  const started = await (await route.fetch(actionRequest({ action: 'oauth-start', provider: 'openai' }))).json();
  const nonce = new URL(started.flow.authUrl).searchParams.get('state');
  const body = await (await route.fetch(actionRequest({
    action: 'oauth-finish', flow: started.flow.id, input: `http://x?code=c&state=${nonce}`,
  }))).json();

  const adapter = registeredAdapter(state);
  const chunks = await drain(adapter.stream({ model: 'gpt-5', messages: [], sessionId: 's1', accountId: body.account.id }));
  assert.equal(chunks.some((chunk) => chunk.type === 'text-delta'), true, 'the freshly logged-in account really served a request');

  await mounted.dispose();
});

await check('oauth-start: two concurrent starts for the SAME provider share ONE listener', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, {
    accounts: [],
    clock: makeClock(),
    upstream: UP_OK(),
    fetchImpl: TOKEN_OK({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
  });
  const route = state.routes.find((r) => r.path === ROUTES.account);

  // Same provider on purpose: two DIFFERENT providers cannot share a 1455 binding
  // (the second needs its own path), which the dedicated rebind test covers.
  const [first, second] = await Promise.all([
    route.fetch(actionRequest({ action: 'oauth-start', provider: 'openai' })).then((r) => r.json()),
    route.fetch(actionRequest({ action: 'oauth-start', provider: 'openai' })).then((r) => r.json()),
  ]);

  assert.equal(
    first.flow.redirectUri,
    second.flow.redirectUri,
    'both logins must advertise the same redirect, or one of them leaks a bound port',
  );
  assert.match(first.flow.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  const listenerLines = state.logs.info.filter((line) => line.includes('oauth callback listener on'));
  assert.equal(listenerLines.length, 1, 'the listener is bound once, not once per start');

  // The SECOND flow owns the listener (it started last), so completing it closes the port.
  const nonce = new URL(second.flow.authUrl).searchParams.get('state');
  await route.fetch(actionRequest({ action: 'oauth-finish', flow: second.flow.id, input: `http://x?code=c&state=${nonce}` }));
  await assert.rejects(fetch(first.flow.redirectUri), 'the port is released when the owning flow finishes');

  await mounted.dispose();
});

await check('oauth-start: switching providers REBINDS, so a live login never points at a dead path', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, {
    accounts: [],
    clock: makeClock(),
    upstream: UP_OK(),
    fetchImpl: TOKEN_OK({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
  });
  const route = state.routes.find((r) => r.path === ROUTES.account);

  // OpenAI first: the listener is bound on 1455 + `/auth/callback`.
  const openai = await (await route.fetch(actionRequest({ action: 'oauth-start', provider: 'openai' }))).json();
  assert.match(openai.flow.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);

  // Then a provider with no registered redirect. Reusing the OpenAI binding would
  // hand this login a URL on a path the listener does not serve, so the callback
  // would 404 in the browser with nothing reporting an error — the reason the
  // reuse check compares the PATH and not just the port.
  const grok = await (await route.fetch(actionRequest({ action: 'oauth-start', provider: 'grok' }))).json();
  assert.notEqual(grok.flow.redirectUri, openai.flow.redirectUri);
  assert.match(grok.flow.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);

  // The newly rebound listener answers on its own path…
  const served = await fetch(grok.flow.redirectUri);
  assert.equal(served.status, 400, 'an unauthenticated callback is answered, not 404');
  // …and the stale one is gone.
  await assert.rejects(fetch(openai.flow.redirectUri));

  await mounted.dispose();
});

await check('oauth-check: reports the redirect mismatch it can prove locally, and never calls the vendor', async () => {
  const { ctx, state } = makeCtx();
  let networkCalls = 0;
  const mounted = await mountPool(ctx, {
    accounts: [],
    clock: makeClock(),
    upstream: UP_OK(),
    // Any outbound request from this test is a bug: the check is local by design,
    // because the vendor sits behind a bot challenge that would report a 403
    // "Just a moment..." as if it were an OAuth parameter problem.
    fetchImpl: async () => { networkCalls += 1; throw new Error('the check must not call the network'); },
  });
  const route = state.routes.find((r) => r.path === ROUTES.account);

  const started = await (await route.fetch(actionRequest({ action: 'oauth-start', provider: 'openai' }))).json();
  const checked = await (await route.fetch(actionRequest({ action: 'oauth-check', flow: started.flow.id }))).json();

  assert.equal(checked.ok, true);
  assert.deepEqual(checked.problems, [], 'a healthy flow reports no problems');
  assert.match(checked.flow.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  assert.match(checked.flow.authUrl, /^https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
  assert.equal(networkCalls, 0);

  const unknown = await route.fetch(actionRequest({ action: 'oauth-check', flow: 'ghost' }));
  assert.equal(unknown.status, 404);

  await mounted.dispose();
});

// ------------------------------------------------- management v2

await check('management: editable notes expiry and scheduling fields preserve runtime state', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock(), upstream: UP_OK() });
  const route = state.routes.find((r) => r.path === ROUTES.account);
  mounted.adapter.upsertAccount({ ...mounted.adapter.getAccount('a1'), rateLimitResetAt: iso(T0 + 60000), consecutiveFailures: 2 });
  const result = await (await route.fetch(actionRequest({ action: 'update', id: 'a1', account: {
    notes: 'renew soon', expiresAt: iso(T0 - 1), autoPauseOnExpired: true, loadFactor: 8, schedulable: false,
    status: 'disabled', consecutiveFailures: 99, lastTestMessage: 'forged',
  } }))).json();
  assert.equal(result.account.notes, 'renew soon');
  assert.equal(result.account.expiresAt, iso(T0 - 1));
  assert.equal(result.account.loadFactor, 8);
  assert.equal(result.account.status, 'active');
  assert.equal(result.account.consecutiveFailures, 2);
  assert.equal(result.account.rateLimitResetAt, iso(T0 + 60000));
  assert.equal(result.account.lastTestMessage, '');
  for (const account of [{ expiresAt: 'tomorrow' }, { loadFactor: 0 }, { notes: 'x'.repeat(10001) }]) {
    const bad = await route.fetch(actionRequest({ action: 'update', id: 'a1', account }));
    assert.equal(bad.status, 400);
  }
  const listed = await (await state.routes.find((r) => r.path === ROUTES.accounts)
    .fetch(new Request('http://localhost/api/accountPool.accounts'))).json();
  assert.equal(listed.managementVersion, 2);
  assert.equal(listed.accounts[0].notes, 'renew soon');
  await mounted.dispose();
});

await check('management: pause resume and error reset keep independent state', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock(), upstream: UP_OK() });
  const route = state.routes.find((r) => r.path === ROUTES.account);
  mounted.adapter.upsertAccount({ ...mounted.adapter.getAccount('a1'), status: 'error', errorMessage: 'failed', consecutiveFailures: 3, overloadUntil: iso(T0 + 60000) });
  const call = async (action) => (await (await route.fetch(actionRequest({ action, id: 'a1' }))).json()).account;
  assert.equal((await call('pause-scheduling')).schedulable, false);
  const resumed = await call('resume-scheduling');
  assert.equal(resumed.status, 'error');
  assert.equal(resumed.errorMessage, 'failed');
  assert.equal(resumed.schedulable, true);
  await call('pause-scheduling');
  const reset = await call('reset-error');
  assert.equal(reset.status, 'active');
  assert.equal(reset.errorMessage, '');
  assert.equal(reset.consecutiveFailures, 0);
  assert.equal(reset.schedulable, false);
  assert.equal(reset.overloadUntil, iso(T0 + 60000));
  await mounted.dispose();
});

await check('management: bulk edits deduplicate ids protect credentials and report missing accounts', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock(), upstream: UP_OK() });
  const route = state.routes.find((r) => r.path === ROUTES.account);
  const batch = async (body) => route.fetch(actionRequest({ action: 'batch', ids: ['a1', 'a1', 'a2', 'ghost'], ...body }));
  const updated = await (await batch({ verb: 'update', account: { notes: 'bulk', priority: 5, schedulable: false } })).json();
  assert.deepEqual(updated.done, ['a1', 'a2']);
  assert.deepEqual(updated.failed, [{ id: 'ghost', reason: 'unknown-account' }]);
  assert.equal(mounted.adapter.getAccount('a2').notes, 'bulk');
  assert.equal(mounted.adapter.getAccount('a2').schedulable, false);
  assert.equal((await batch({ verb: 'update', account: { credentialRef: 'OTHER' } })).status, 400);
  assert.equal((await batch({ verb: 'update', account: {} })).status, 400);
  assert.equal((await batch({ verb: 'update', account: { groups: ['unknown'] } })).status, 400);
  const invalid = await (await batch({ verb: 'update', account: { concurrency: -1 } })).json();
  assert.deepEqual(invalid.done, []);
  assert.equal(invalid.failed[0].reason, 'invalid-account');
  const resumed = await (await batch({ verb: 'resume-scheduling' })).json();
  assert.deepEqual(resumed.done, ['a1', 'a2']);
  assert.equal(mounted.adapter.getAccount('a1').schedulable, true);
  await mounted.dispose();
});

await check('test: real HTTP transport resolves credentials sends a bounded request and stores safe results', async () => {
  const { ctx, state } = makeCtx();
  let calls = 0;
  const mounted = await mountPool(ctx, {
    accounts: [{ id: 'a1', platform: 'anthropic', credentialRef: 'POOL_KEY', models: ['test-model'] }], clock: makeClock(),
    fetchImpl: async (_url, init) => {
      calls += 1;
      assert.equal(init.headers['x-api-key'], 'fixture-key');
      const request = JSON.parse(init.body);
      assert.equal(request.max_tokens, 64);
      assert.equal(request.messages.length, 1);
      return new Response('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"private-upstream-output"}}\n\ndata: {"type":"message_stop"}\n\n');
    },
  });
  await ctx.get('credentials').set('POOL_KEY', 'fixture-key');
  const route = state.routes.find((r) => r.path === ROUTES.account);
  await route.fetch(actionRequest({ action: 'disable', id: 'a1' }));
  const result = await (await route.fetch(actionRequest({ action: 'test', id: 'a1' }))).json();
  assert.equal(calls, 1);
  assert.equal(result.test.ok, true);
  assert.equal(result.test.model, 'test-model');
  assert.equal(result.account.status, 'disabled');
  assert.equal(result.account.schedulable, false);
  assert.equal(result.account.lastUsedAt, null);
  assert.equal(result.account.lastTestOk, true);
  assert.equal(JSON.stringify(result).includes('fixture-key'), false);
  assert.equal(JSON.stringify(result).includes('private-upstream-output'), false);
  assert.equal(state.medium.tableFor('account_pool', 'accounts').get('a1').lastTestOk, true);
  assert.equal(state.medium.tableFor('account_pool', 'usage').size, 1);
  await mounted.dispose();
});

await check('test: upstream failures are recorded without raw messages or credential leakage', async () => {
  const { ctx, state } = makeCtx();
  const calls = [];
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, models: ['m'], clock: makeClock(), upstream: {
    stream(account) { calls.push(account.id); return failing(Object.assign(new Error('Authorization Bearer fixture-secret'), { status: 401, code: 'fixture-secret' })); },
  } });
  const route = state.routes.find((r) => r.path === ROUTES.account);
  const result = await (await route.fetch(actionRequest({ action: 'test', id: 'a1' }))).json();
  assert.equal(result.ok, true);
  assert.equal(result.test.ok, false);
  assert.equal(result.test.errorCode, 'http-401');
  assert.equal(result.test.status, 401);
  assert.deepEqual(calls, ['a1'], 'no failover to a2');
  assert.equal(result.account.tempUnschedulableUntil, iso(T0 + DURATIONS.authFailMs));
  assert.equal(result.account.lastTestErrorCode, 'http-401');
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
  assert.equal(JSON.stringify(state.logs).includes('fixture-secret'), false);
  const usage = [...state.medium.tableFor('account_pool', 'usage').values()][0];
  assert.equal(usage.errorCode, 'http-401');
  assert.equal(usage.ok, false);
  await mounted.dispose();
});

await check('test: missing model is rejected before the upstream and missing credentials do not cool', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock() });
  const route = state.routes.find((r) => r.path === ROUTES.account);
  const noModel = await route.fetch(actionRequest({ action: 'test', id: 'a1' }));
  assert.equal(noModel.status, 400);
  assert.equal((await noModel.json()).error.code, 'missing-model');
  const noCredential = await (await route.fetch(actionRequest({ action: 'test', id: 'a1', model: 'm' }))).json();
  assert.equal(noCredential.test.errorCode, 'POOL_NO_CREDENTIAL');
  assert.equal(noCredential.account.tempUnschedulableUntil, null);
  assert.equal(noCredential.account.consecutiveFailures, 0);
  await mounted.dispose();
});

await check('detection: saved settings apply immediately to the management probe HTTP path',async()=>{
  const {ctx,state}=makeCtx();let calls=0;
  const mounted=await mountPool(ctx,{accounts:[{id:'a1',platform:'anthropic',credentialRef:'DETECTION_FIXTURE',models:['fixture-model']}],clock:makeClock(),fetchImpl:async()=>{
    calls++;return calls===1?new Response(JSON.stringify({error:{message:'号池不可用'}}),{status:503}):new Response('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"private-fixture-answer"}}\n\ndata: {"type":"message_stop"}\n\n');
  }});await ctx.get('credentials').set('DETECTION_FIXTURE','fixture-secret');const route=state.routes.find(r=>r.path===ROUTES.account);
  assert.equal((await route.fetch(actionRequest({action:'update',id:'a1',account:{poolDetectionRetry:true,poolDetectionRetries:1,poolDetectionRetryDelayMs:100,poolDetectionKeywords:['号池不可用']}}))).status,200);
  const result=await(await route.fetch(actionRequest({action:'test',id:'a1',model:'fixture-model'}))).json();
  assert.equal(result.test.ok,true);assert.equal(calls,2);assert.equal(result.account.poolDetectionRetry,true);assert.equal(result.account.consecutiveFailures,0);
  for(const field of ['overloadUntil','rateLimitResetAt','tempUnschedulableUntil'])assert.equal(result.account[field],null);
  assert.equal(JSON.stringify(result).includes('fixture-secret'),false);assert.equal(JSON.stringify(result).includes('private-fixture-answer'),false);
  await mounted.dispose();
});

await check('detection: account settings save, export, reload and preserve unrelated cooldown state', async()=>{
  const {ctx,state}=makeCtx();const mounted=await mountPool(ctx,{accounts:CONFIG_ACCOUNTS,clock:makeClock(),upstream:UP_OK()});
  const route=state.routes.find(r=>r.path===ROUTES.account);const read=state.routes.find(r=>r.path===ROUTES.accounts);
  const body=await(await read.fetch(new Request('http://test'+ROUTES.accounts))).json();assert.equal(body.detectionVersion,1);assert.equal(body.accounts[0].poolDetectionRetry,false);
  const until=iso(T0+60000);mounted.adapter.upsertAccount({...mounted.adapter.getAccount('a1'),overloadUntil:until,consecutiveFailures:2});
  const settings={poolDetectionRetry:true,poolDetectionRetries:3,poolDetectionRetryDelayMs:100,poolDetectionKeywords:['号池不可用','custom transient marker']};
  const result=await(await route.fetch(actionRequest({action:'update',id:'a1',account:settings}))).json();assert.equal(result.ok,true);
  for(const [key,value]of Object.entries(settings))assert.deepEqual(result.account[key],value);
  assert.equal(result.account.overloadUntil,until);assert.equal(result.account.consecutiveFailures,2,'Saving retry settings cannot erase existing cooldowns');
  for(const patch of [{poolDetectionRetries:6},{poolDetectionRetryDelayMs:0},{poolDetectionKeywords:['']},{poolDetectionRetry:'yes'}])assert.equal((await route.fetch(actionRequest({action:'update',id:'a1',account:patch}))).status,400);
  for(const [key,value]of Object.entries(settings))assert.deepEqual(mounted.adapter.getAccount('a1')[key],value,'Invalid edits must be atomic');
  const exported=await(await route.fetch(actionRequest({action:'export',ids:['a1']}))).json();
  for(const [key,value]of Object.entries(settings))assert.deepEqual(exported.document.accounts[0][key],value);
  const fresh=makeCtx();const restored=await mountPool(fresh.ctx,{clock:makeClock(),upstream:UP_OK()});const restore=fresh.state.routes.find(r=>r.path===ROUTES.account);
  assert.equal((await restore.fetch(actionRequest({action:'import',document:exported.document}))).status,200);
  for(const [key,value]of Object.entries(settings))assert.deepEqual(restored.adapter.getAccount('a1')[key],value);
  await restored.dispose();await mounted.dispose();const reopenedCtx=makeCtx({medium:state.medium});const reopened=await mountPool(reopenedCtx.ctx,{clock:makeClock(),upstream:UP_OK()});
  for(const [key,value]of Object.entries(settings))assert.deepEqual(reopened.adapter.getAccount('a1')[key],value);await reopened.dispose();
});

await check('metadata: selected export omits credentials endpoints identities and health errors', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock(), upstream: UP_OK() });
  const route = state.routes.find((r) => r.path === ROUTES.account);
  await route.fetch(actionRequest({ action: 'group-create', group: { id: 'vip', enabled: false, selectionMode: 'weighted-random' } }));
  await route.fetch(actionRequest({ action: 'update', id: 'a1', account: { notes: 'backup', groups: ['vip'], credentialRef: 'PRIVATE_REF', baseUrl: 'https://u:p@example.com?token=x', mimicryAccountUuid: 'private-id' }, credential: 'fixture-secret' }));
  await route.fetch(actionRequest({ action: 'priority-set', id: 'a1', group: 'vip', priority: 7 }));
  const exported = await (await route.fetch(actionRequest({ action: 'export', ids: ['a1'] }))).json();
  assert.equal(exported.document.accounts.length, 1);
  assert.equal(exported.document.accounts[0].notes, 'backup');
  for (const forbidden of ['credentialRef', 'credential', 'baseUrl', 'mimicryAccountUuid', 'errorMessage', 'lastTestMessage']) {
    assert.equal(forbidden in exported.document.accounts[0], false);
  }
  assert.equal(JSON.stringify(exported).includes('fixture-secret'), false);
  assert.equal(JSON.stringify(exported).includes('PRIVATE_REF'), false);
  assert.equal(exported.document.groups[0].selectionMode, 'weighted-random');
  assert.equal(exported.document.groups[0].enabled, false);
  assert.equal(exported.document.priorities[0].priority, 7);
  assert.equal((await route.fetch(actionRequest({ action: 'export', ids: ['ghost'] }))).status, 404);
  const fresh = makeCtx();
  const restored = await mountPool(fresh.ctx, { clock: makeClock(), upstream: UP_OK() });
  const restoreRoute = fresh.state.routes.find((r) => r.path === ROUTES.account);
  const imported = await (await restoreRoute.fetch(actionRequest({ action: 'import', document: exported.document }))).json();
  assert.deepEqual(imported.created, ['a1']);
  assert.deepEqual(imported.groups, ['vip']);
  assert.equal(imported.priorities, 1);
  assert.equal(restored.adapter.getAccount('a1').schedulable, false);
  assert.equal(restored.adapter.getAccount('a1').notes, 'backup');
  assert.equal(restored.adapter.getGroup('vip').selectionMode, 'weighted-random');
  assert.equal(restored.adapter.getGroup('vip').enabled, false);
  assert.equal(restored.adapter.listPriorities()[0].priority, 7);
  assert.equal(fresh.state.secrets.size, 0);
  assert.deepEqual(fresh.state.registrations[0].providers, ['pool']);
  assert.deepEqual(fresh.state.providerDeclarations[0].entries.map((row) => row.provider), ['pool-vip']);
  await mounted.dispose();
  await restored.dispose();
});

await check('metadata: invalid restore is rejected before any account or group write', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { clock: makeClock(), upstream: UP_OK() });
  const route = state.routes.find((r) => r.path === ROUTES.account);
  const rejected = await route.fetch(actionRequest({ action: 'import', document: {
    format: 'dsh-account-pool-metadata', version: 1, groups: [{ id: 'valid' }],
    accounts: [{ id: 'a1', groups: ['missing'] }], priorities: [],
  } }));
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error.code, 'invalid-metadata');
  assert.deepEqual(mounted.adapter.listAccounts(), []);
  assert.deepEqual(mounted.adapter.listGroups(), []);
  assert.equal(state.secrets.size, 0);
  await mounted.dispose();
});

await check('groups: disabled state survives restart while the directory keeps an editable row', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { clock: makeClock(), upstream: UP_OK() });
  const route = state.routes.find((r) => r.path === ROUTES.account);
  const created = await (await route.fetch(actionRequest({ action: 'group-create', group: { id: 'disabled', enabled: false } }))).json();
  assert.equal(created.group.enabled, false);
  assert.deepEqual(state.registrations[0].providers, ['pool']);
  assert.deepEqual(state.providerDeclarations[0].entries.map((row) => row.provider), ['pool-disabled']);
  assert.equal(state.medium.tableFor('account_pool', 'groups').get('disabled').enabled, false);
  assert.equal((await route.fetch(actionRequest({ action: 'group-update', id: 'disabled', group: { enabled: 'false' } }))).status, 400);
  await mounted.dispose();
  const fresh = makeCtx({ medium: state.medium });
  const reopened = await mountPool(fresh.ctx, { clock: makeClock(), upstream: UP_OK() });
  assert.equal(reopened.adapter.getGroup('disabled').enabled, false);
  assert.deepEqual(fresh.state.registrations[0].providers, ['pool']);
  assert.deepEqual(fresh.state.providerDeclarations[0].entries.map((row) => row.provider), ['pool-disabled']);
  const update = fresh.state.routes.find((r) => r.path === ROUTES.account);
  const response = await update.fetch(actionRequest({ action: 'group-update', id: 'disabled', group: { enabled: true } }));
  assert.equal(response.status, 200);
  assert.deepEqual(fresh.state.registrations[0].providers, ['pool', 'pool-disabled']);
  assert.deepEqual(reopened.adapter.listAccounts(), [], 'enabling a group does not manufacture accounts');
  await reopened.dispose();
});

await check('groups: route validates and persists its routing selectionMode', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { clock: makeClock(), upstream: UP_OK() });
  const route = state.routes.find((r) => r.path === ROUTES.account);
  const created = await (await route.fetch(actionRequest({ action: 'group-create', group: { id: 'modes' } }))).json();
  assert.equal(created.group.selectionMode, 'sticky');
  for (const selectionMode of ['load-aware', 'prefer_soonest_reset', 'weighted-random']) {
    const updated = await (await route.fetch(actionRequest({ action: 'group-update', id: 'modes', group: { selectionMode } }))).json();
    assert.equal(updated.group.selectionMode, selectionMode);
    assert.equal(state.medium.tableFor('account_pool', 'groups').get('modes').selectionMode, selectionMode);
  }
  assert.equal((await route.fetch(actionRequest({ action: 'group-update', id: 'modes', group: { selectionMode: 'bogus' } }))).status, 400);
  await mounted.dispose();
});

await check('reconcile: omitted config fields preserve durable management edits', async () => {
  const medium = makeMedium();
  const table = makeKvTable(medium.tableFor('account_pool', 'accounts'));
  reconcileConfiguredAccounts(table, [{ id: 'a1', platform: 'anthropic' }], iso(T0));
  await table.put('a1', { ...table.get('a1'), notes: 'keep edited notes', schedulable: false, expiresAt: iso(T0 + 60000), loadFactor: 8 });
  const unchanged = table.get('a1');
  assert.deepEqual(reconcileConfiguredAccounts(table, [{ id: 'a1', platform: 'anthropic' }], iso(T0 + 1000)), { inserted: 0, refreshed: 0 });
  assert.deepEqual(table.get('a1'), unchanged);
  reconcileConfiguredAccounts(table, [{ id: 'a1', notes: '', schedulable: true, expiresAt: null }], iso(T0 + 2000));
  assert.equal(table.get('a1').notes, 'keep edited notes');
  assert.equal(table.get('a1').schedulable, false);
  assert.equal(table.get('a1').expiresAt, iso(T0 + 60000));
  assert.equal(table.get('a1').loadFactor, 8);
});

await check('restart: group selectionMode description and priorities survive unchanged', async () => {
  const medium = makeMedium();
  const first = makeCtx({ medium });
  const mounted = await mountPool(first.ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock(), upstream: UP_OK() });
  const route = first.state.routes.find((record) => record.path === ROUTES.account);
  await route.fetch(actionRequest({ action: 'group-create', group: { id: 'durable', label: 'durable group', description: 'keep this description', selectionMode: 'weighted-random' } }));
  await route.fetch(actionRequest({ action: 'update', id: 'a1', account: { groups: ['durable'] } }));
  await route.fetch(actionRequest({ action: 'priority-set', id: 'a1', group: 'durable', priority: 7 }));
  const before = { ...mounted.adapter.getGroup('durable') };
  await mounted.dispose();
  const second = makeCtx({ medium });
  const reopened = await mountPool(second.ctx, { accounts: CONFIG_ACCOUNTS, clock: makeClock(T0 + 1000), upstream: UP_OK() });
  assert.deepEqual(reopened.adapter.getGroup('durable'), before);
  assert.deepEqual(reopened.adapter.getAccount('a1').groups, ['durable']);
  assert.equal(reopened.adapter.listPriorities()[0].priority, 7);
  assert.deepEqual(second.state.registrations[0].providers, ['pool', 'pool-durable']);
  await reopened.dispose();
});

await check('quota: HTTP action and GET cache preserve paused account state and never return secrets', async () => {
  const { ctx, state } = makeCtx();
  const clock = makeClock();
  let calls = 0;
  const mounted = await mountPool(ctx, { clock, upstream: UP_OK(), accounts: [{ id: 'q', platform: 'openai', authMode: 'oauth', credentialRef: 'Q', chatgptAccountId: 'manual-workspace', status: 'disabled', schedulable: false, rateLimitResetAt: iso(T0 + 60000) }], fetchImpl: async (url, init) => {
    if (url === 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits') return new Response(JSON.stringify({ available_count: 0 }));
    calls++;
    assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
    assert.equal(init.method, 'GET');
    assert.equal(init.headers['chatgpt-account-id'], 'manual-workspace');
    return new Response(JSON.stringify({ plan_type: 'pro', rate_limit: { primary_window: { used_percent: 10, reset_at: (T0 + 3600000) / 1000 } }, private: 'fixture-secret' }));
  } });
  await ctx.get('credentials').set('Q', JSON.stringify({ access_token: 'fixture-secret', refresh_token: 'fixture-refresh', chatgpt_account_id: 'bundle-workspace' }));
  const before = { ...mounted.adapter.getAccount('q') };
  const server = createServer(async (req, res) => {
    try {
      const parts = [];
      for await (const part of req) parts.push(part);
      const url = `http://127.0.0.1${req.url}`;
      const request = new Request(url, { method: req.method, ...(req.method === 'POST' ? { body: Buffer.concat(parts) } : {}) });
      const route = state.routes.find((entry) => entry.path === new URL(url).pathname);
      const response = await route.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    } catch { res.writeHead(500); res.end('local fixture failed'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async () => (await fetch(`${base}${ROUTES.accounts}`)).json();
  const post = async (body) => fetch(`${base}${ROUTES.account}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const initial = await get();
    assert.equal(initial.managementVersion, 2);
    assert.equal(initial.quotaVersion, 1);
    assert.equal(initial.nativeVersion, 1);
    assert.equal(initial.accounts[0].quota, null);
    const result = await (await post({ action: 'quota', id: 'q' })).json();
    assert.equal(result.ok, true);
    assert.equal(result.action, 'quota');
    assert.equal(result.quota.ok, true);
    assert.equal(result.quota.windows[0].remainingPercent, 90);
    assert.deepEqual(mounted.adapter.getAccount('q'), before);
    assert.deepEqual((await get()).accounts[0].quota, result.quota);
    await post({ action: 'quota', id: 'q' });
    assert.equal(calls, 1);
    await post({ action: 'quota', id: 'q', force: true });
    assert.equal(calls, 2);
    clock.advance(60001);
    const expired = (await get()).accounts[0].quota;
    assert.equal(expired.stale, true);
    assert.equal(expired.expired, true);
    assert.equal(expired.ok, true);
    assert.equal((await post({ action: 'quota', id: 'q', force: 'yes' })).status, 400);
    assert.equal((await post({ action: 'quota', id: 'ghost' })).status, 404);
    for (const value of [result, await get(), state.logs]) assert.equal(JSON.stringify(value).includes('fixture-secret'), false);
    assert.equal(state.medium.tableFor('account_pool', 'usage').size, 0);
  } finally { await new Promise((resolve) => server.close(resolve)); await mounted.dispose(); }
});

await check('quota: public connection edits and credential replacement invalidate cached/in-flight identity', async () => {
  const { ctx, state } = makeCtx();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const mounted = await mountPool(ctx, { clock: makeClock(), upstream: UP_OK(), accounts: [
    { id: 'q', platform: 'openai', authMode: 'oauth', credentialRef: 'Q', chatgptAccountId: 'workspace' },
    { id: 'shared', platform: 'openai', authMode: 'oauth', credentialRef: 'Q', chatgptAccountId: 'workspace' },
  ], fetchImpl: async (url, init) => {
    if (url === 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits') return new Response(JSON.stringify({ available_count: 0 }));
    calls++;
    if (calls === 1) await gate;
    else assert.equal(init.headers.authorization, 'Bearer fresh-secret');
    return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 25 } } }));
  } });
  await ctx.get('credentials').set('Q', 'old-secret');
  const route = state.routes.find((r) => r.path === ROUTES.account);
  const query = (id) => route.fetch(actionRequest({ action: 'quota', id })).then((response) => response.json());
  const pending = query('q');
  await new Promise((resolve) => setImmediate(resolve));
  const updated = await (await route.fetch(actionRequest({ action: 'update', id: 'q', account: { chatgptAccountId: 'new-workspace', projectId: 'manual-project' }, credential: 'fresh-secret' }))).json();
  assert.equal(updated.account.chatgptAccountId, 'new-workspace');
  assert.equal(updated.account.projectId, 'manual-project');
  assert.equal((await pending).quota.errorCode, 'canceled');
  release();
  assert.equal(mounted.quotaService.peek(mounted.adapter.getAccount('q')), null);
  await query('q');
  await query('shared');
  assert.ok(mounted.quotaService.peek(mounted.adapter.getAccount('shared')));
  await route.fetch(actionRequest({ action: 'update', id: 'q', credential: 'fresh-secret' }));
  assert.equal(mounted.quotaService.peek(mounted.adapter.getAccount('shared')), null);
  await query('q');
  const exported = await (await route.fetch(actionRequest({ action: 'export', ids: ['q'] }))).json();
  assert.equal(exported.document.accounts[0].projectId, 'manual-project');
  assert.equal('chatgptAccountId' in exported.document.accounts[0], false);
  await route.fetch(actionRequest({ action: 'delete', id: 'q' }));
  assert.equal(mounted.quotaService.peek(updated.account), null);
  await mounted.dispose();
});

await check('quota: old dependencies degrade safely, unsupported results are cached and dispose clears cache', async () => {
  const { ctx, state } = makeCtx({ withCredentials: false });
  const mounted = await mountPool(ctx, { clock: makeClock(), accounts: [{ id: 'api', platform: 'openai' }, { id: 'oauth', platform: 'anthropic', authMode: 'oauth', credentialRef: 'MISSING' }] });
  const route = state.routes.find((r) => r.path === ROUTES.account);
  const unsupported = await (await route.fetch(actionRequest({ action: 'quota', id: 'api' }))).json();
  assert.equal(unsupported.quota.supported, false);
  assert.equal(unsupported.quota.ok, false);
  assert.equal(unsupported.quota.errorCode, 'unsupported');
  const missing = await (await route.fetch(actionRequest({ action: 'quota', id: 'oauth' }))).json();
  assert.equal(missing.quota.errorCode, 'missing-credential');
  const record = mounted.adapter.getAccount('api');
  assert.ok(mounted.quotaService.peek(record));
  await mounted.dispose();
  assert.equal(mounted.quotaService.peek(record), null);
});

await check('resolver: returnBundle preserves metadata with refresh disabled and default string remains compatible', async () => {
  const credentials = { resolve: async () => ({ value: JSON.stringify({ access_token: 'fixture-token', project_id: 'project', chatgpt_account_id: 'workspace' }) }) };
  const account = { platform: 'gemini', credentialRef: 'R' };
  assert.equal(await resolveAccountCredential(credentials, account, { refreshEnabled: false }), 'fixture-token');
  const bundle = await resolveAccountCredential(credentials, account, { refreshEnabled: false, returnBundle: true });
  assert.equal(bundle.access_token, 'fixture-token');
  assert.equal(bundle.project_id, 'project');
  assert.equal(bundle.chatgpt_account_id, 'workspace');
});

await check('native pipeline: host refresh preserves Codex workspace metadata before Responses generation', async () => {
  const { ctx, state } = makeCtx();
  let refreshes = 0;
  let generations = 0;
  const mounted = await mountPool(ctx, { clock: makeClock(), accounts: [{ id: 'codex', platform: 'openai', authMode: 'oauth', credentialRef: 'CODEX', models: ['gpt-5'] }], fetchImpl: async (url, init) => {
    if (url === 'https://auth.openai.com/oauth/token') {
      refreshes++;
      return new Response(JSON.stringify({ access_token: 'fresh-codex-token', expires_in: 3600 }));
    }
    generations++;
    assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(init.headers.authorization, 'Bearer fresh-codex-token');
    assert.equal(init.headers['chatgpt-account-id'], 'bundle-workspace');
    const request = JSON.parse(init.body);
    assert.equal(request.stream, true);
    assert.equal(request.model, 'gpt-5');
    return new Response('data: {"type":"response.output_text.delta","output_index":0,"delta":"native-ok"}\n\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":2},"output":[]}}\n\n');
  } });
  await ctx.get('credentials').set('CODEX', JSON.stringify({ access_token: 'stale-codex-token', refresh_token: 'refresh-codex', expires_at: iso(T0 - 1), chatgpt_account_id: 'bundle-workspace' }));
  try {
    const chunks = await drain(registeredAdapter(state).stream({ accountId: 'codex', model: 'gpt-5', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }));
    assert.equal(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'native-ok'), true);
    assert.equal(refreshes, 1);
    assert.equal(generations, 1);
    const stored = JSON.parse(state.secrets.get('CODEX'));
    assert.equal(stored.chatgpt_account_id, 'bundle-workspace');
    assert.equal(stored.access_token, 'fresh-codex-token');
  } finally { await mounted.dispose(); }
});

await check('native pipeline: host refresh preserves Gemini Code Assist project and OAuth client metadata', async () => {
  const { ctx, state } = makeCtx();
  let refreshes = 0;
  let generations = 0;
  const mounted = await mountPool(ctx, { clock: makeClock(), accounts: [{ id: 'gemini', platform: 'gemini', authMode: 'oauth', credentialRef: 'GEMINI', models: ['gemini-2.5-pro'] }], fetchImpl: async (url, init) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      refreshes++;
      const fields = new URLSearchParams(init.body);
      assert.equal(fields.get('client_id'), 'operator-client');
      assert.equal(fields.get('client_secret'), 'operator-client-secret');
      return new Response(JSON.stringify({ access_token: 'fresh-gemini-token', expires_in: 3600 }));
    }
    generations++;
    assert.equal(url, 'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse');
    assert.equal(init.headers.authorization, 'Bearer fresh-gemini-token');
    const request = JSON.parse(init.body);
    assert.equal(request.project, 'bundle-project');
    assert.equal(request.model, 'gemini-2.5-pro');
    return new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"gemini-ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}}\n\n');
  } });
  await ctx.get('credentials').set('GEMINI', JSON.stringify({ access_token: 'stale-gemini-token', refresh_token: 'refresh-gemini', expires_at: iso(T0 - 1), project_id: 'bundle-project', client_id: 'operator-client', client_secret: 'operator-client-secret' }));
  try {
    const chunks = await drain(registeredAdapter(state).stream({ accountId: 'gemini', model: 'gemini-2.5-pro', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }));
    assert.equal(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'gemini-ok'), true);
    assert.equal(refreshes, 1);
    assert.equal(generations, 1);
    const stored = JSON.parse(state.secrets.get('GEMINI'));
    assert.equal(stored.project_id, 'bundle-project');
    assert.equal(stored.access_token, 'fresh-gemini-token');
  } finally { await mounted.dispose(); }
});

// ------------------------------------------------- supplier connection flow
const supplierBody = { action: 'supplier-connect', supplier: { name: 'Relay A', platform: 'custom', baseUrl: 'https://relay.invalid/v1', models: ['relay-model'] }, credential: 'fixture-supplier-key' };
await check('supplier: one action persists credential/member/group and publishes exact provider catalog', async () => {
  const medium=makeMedium();const {ctx,state}=makeCtx({medium});let network=0;
  const mounted=await mountPool(ctx,{clock:makeClock(),models:['unrelated-global-model'],fetchImpl:async()=>{network++;throw new Error('save must not issue network');}});
  const route=state.routes.find(r=>r.path===ROUTES.account);
  const response=await route.fetch(actionRequest(supplierBody));assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.ok,true);assert.equal(network,0);
  assert.equal(result.provider.name,'Sub-Relay A');assert.equal(result.provider.id,`pool-${result.group.id}`);assert.deepEqual(result.provider.models,['relay-model']);
  assert.deepEqual(result.account.groups,[result.group.id]);assert.equal(result.account.baseUrl,'https://relay.invalid');assert.equal(state.secrets.get(result.account.credentialRef),'fixture-supplier-key');
  assert.ok(!JSON.stringify(result).includes('fixture-supplier-key'));assert.ok(state.registrations[0].providers.includes(result.provider.id));assert.ok(state.providerDeclarations[0].entries.some(e=>e.provider===result.provider.id&&e.displayName==='Sub-Relay A'));
  const prepared=await mounted.adapter.prepareCall(result.provider.id,'relay-model');assert.equal(prepared.model.provider,result.provider.id);
  const second=await (await route.fetch(actionRequest({...supplierBody,supplier:{...supplierBody.supplier,groupId:result.group.id}}))).json();assert.equal(second.group.id,result.group.id);assert.notEqual(second.account.id,result.account.id);assert.equal(mounted.adapter.listGroups().length,1);
  await mounted.dispose();const fresh=makeCtx({medium});const reopened=await mountPool(fresh.ctx,{clock:makeClock(),upstream:UP_OK()});assert.equal(reopened.adapter.getGroup(result.group.id).label,'Relay A');assert.deepEqual((await reopened.adapter.listModels(result.provider.id)).map(x=>x.id),['relay-model']);await reopened.dispose();
});
await check('supplier: Responses transport persists, can be edited, and invalid combinations do not write', async () => {
  const medium=makeMedium();const {ctx,state}=makeCtx({medium});const mounted=await mountPool(ctx,{clock:makeClock(),upstream:UP_OK()});const route=state.routes.find(r=>r.path===ROUTES.account);
  const result=await (await route.fetch(actionRequest({...supplierBody,supplier:{...supplierBody.supplier,platform:'openai',openaiApi:'responses',openaiTransport:'websocket'}}))).json();assert.equal(result.ok,true);const id=result.account.id;
  assert.equal(mounted.adapter.getAccount(id).openaiTransport,'websocket');
  assert.equal((await route.fetch(actionRequest({action:'update',id,account:{openaiApi:'chat-completions'}}))).status,400);assert.equal(mounted.adapter.getAccount(id).openaiApi,'responses');
  assert.equal((await route.fetch(actionRequest({action:'update',id,account:{openaiTransport:'http'}}))).status,200);
  const listed=await (await state.routes.find(r=>r.path===ROUTES.accounts).fetch(new Request('http://dsh.invalid'+ROUTES.accounts))).json();assert.equal(listed.openaiProtocolVersion,1);
  await mounted.dispose();const fresh=makeCtx({medium});const reopened=await mountPool(fresh.ctx,{clock:makeClock(),upstream:UP_OK()});assert.equal(reopened.adapter.getAccount(id).openaiApi,'responses');assert.equal(reopened.adapter.getAccount(id).openaiTransport,'http');await reopened.dispose();
});
await check('supplier: invalid input and credential failure leave no phantom provider/member/group',async()=>{
  const {ctx,state}=makeCtx();const mounted=await mountPool(ctx,{clock:makeClock(),upstream:UP_OK()});const route=state.routes.find(r=>r.path===ROUTES.account);
  for(const patch of [{name:''},{models:[]},{groupId:'missing'},{baseUrl:'invalid'}])assert.equal((await route.fetch(actionRequest({...supplierBody,supplier:{...supplierBody.supplier,...patch}}))).status,400);
  ctx.get('credentials').set=async()=>{throw new Error('fixture-supplier-key');};const response=await route.fetch(actionRequest(supplierBody));assert.equal(response.status,400);assert.ok(!(await response.text()).includes('fixture-supplier-key'));assert.equal(mounted.adapter.listAccounts().length,0);assert.equal(mounted.adapter.listGroups().length,0);assert.equal(state.secrets.size,0);await mounted.dispose();
});
await check('supplier: model discovery is GET only and never saves account or credentials',async()=>{
  const {ctx,state}=makeCtx();let calls=0;const mounted=await mountPool(ctx,{clock:makeClock(),fetchImpl:async(url,init)=>{calls++;assert.equal(url,'https://relay.invalid/v1/models');assert.equal(init.method,'GET');return Response.json({data:[{id:'remote-model'}]});}});const route=state.routes.find(r=>r.path===ROUTES.account);
  const result=await (await route.fetch(actionRequest({...supplierBody,action:'supplier-models'}))).json();assert.deepEqual(result.models,['remote-model']);assert.equal(calls,1);assert.equal(mounted.adapter.listAccounts().length,0);assert.equal(mounted.adapter.listGroups().length,0);assert.equal(state.secrets.size,0);assert.equal(mounted.adapter.listUsage?.()?.length??0,0);await mounted.dispose();
});
await check('supplier: legacy account edits refresh advertised models and supplier capability is discoverable',async()=>{
  const {ctx,state}=makeCtx();const mounted=await mountPool(ctx,{clock:makeClock(),upstream:UP_OK()});const route=state.routes.find(r=>r.path===ROUTES.account);
  const before=state.registrations[0].replaces.length;await route.fetch(actionRequest({action:'create',id:'legacy',account:{models:['first']}}));assert.ok(state.registrations[0].replaces.length>before);
  const after=state.registrations[0].replaces.length;await route.fetch(actionRequest({action:'update',id:'legacy',account:{models:['changed']}}));assert.ok(state.registrations[0].replaces.length>after);assert.deepEqual((await mounted.adapter.listModels('pool')).map(x=>x.id),['changed']);
  const listed=await (await state.routes.find(r=>r.path===ROUTES.accounts).fetch(new Request('http://dsh.invalid'+ROUTES.accounts))).json();assert.equal(listed.supplierVersion,1);await mounted.dispose();
});

await check('supplier: failed durable account save rolls back group and new credential',async()=>{
  const medium=makeMedium();const {ctx,state}=makeCtx({medium});const mounted=await mountPool(ctx,{clock:makeClock(),upstream:UP_OK()});
  const accounts=medium.tableFor('account_pool','accounts');accounts.set=()=>{throw new Error('disk failure');};
  const response=await state.routes.find(r=>r.path===ROUTES.account).fetch(actionRequest(supplierBody));assert.equal(response.status,500);assert.equal((await response.json()).error.code,'supplier-save');assert.equal(medium.tableFor('account_pool','groups').size,0);assert.equal(accounts.size,0);assert.equal(state.secrets.size,0);assert.equal(mounted.adapter.listGroups().length,0);assert.equal(state.registrations[0].providers.length,1);await mounted.dispose();
});
await check('supplier: missing chat service refuses connection without changing account store',async()=>{
  const {ctx,state}=makeCtx({withLlm:false});const mounted=await mountPool(ctx,{clock:makeClock(),upstream:UP_OK()});
  const result=await (await state.routes.find(r=>r.path===ROUTES.account).fetch(actionRequest(supplierBody))).json();assert.equal(result.error.code,'supplier-chat-unavailable');assert.equal(mounted.adapter.listAccounts().length,0);assert.equal(state.secrets.size,0);await mounted.dispose();
});

// ------------------------------------------------- group upstream model catalogs

await check('group-models: protocol auth and upstream shapes ignore whitelist, persist union and become callable after save', async () => {
  const { ctx, state } = makeCtx();
  const calls = [];
  const clock = makeClock();
  const accounts = ['anthropic', 'openai', 'gemini', 'custom', 'grok'].map(platform => ({
    id: platform, label: `${platform} label`, platform, credentialRef: `KEY_${platform}`,
    baseUrl: platform === 'custom' || platform === 'grok' ? `https://${platform}.invalid/v1/chat/completions` : null,
    models: ['declared-legacy'], groups: ['catalog'],
  }));
  for (const account of accounts) state.secrets.set(account.credentialRef,
    account.platform === 'openai' ? JSON.stringify({ api_key: 'secret-openai' }) : `secret-${account.platform}`);
  const mounted = await mountPool(ctx, { accounts, clock, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (init.method === 'GET') {
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal, 'discovery has the helper timeout signal');
      if (url.startsWith('https://api.anthropic.com')) {
        assert.equal(url, 'https://api.anthropic.com/v1/models');
        assert.equal(init.headers['x-api-key'], 'secret-anthropic');
        assert.equal(init.headers['anthropic-version'], '2023-06-01');
        assert.equal(init.headers.authorization, 'Bearer secret-anthropic');
        return Response.json({ data: [{ id: 'claude-new' }, { id: 'shared-model' }, { id: ' shared-model ' }] });
      }
      if (url.startsWith('https://generativelanguage.googleapis.com')) {
        assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000');
        assert.equal(init.headers['x-goog-api-key'], 'secret-gemini');
        assert.equal(init.headers.authorization, undefined);
        return Response.json({ models: [
          { name: 'models/gemini-new', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/embedding-only', supportedGenerationMethods: ['embedContent'] },
        ] });
      }
      const platform = url.includes('custom.invalid') ? 'custom' : url.includes('grok.invalid') ? 'grok' : 'openai';
      assert.equal(url, platform === 'openai' ? 'https://api.openai.com/v1/models' : `https://${platform}.invalid/v1/models`);
      assert.equal(init.headers.authorization, `Bearer secret-${platform}`);
      return Response.json({ data: [{ id: `${platform}-new` }, { id: 'shared-model' }] });
    }
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(JSON.parse(init.body).model, 'openai-new');
    assert.equal(init.headers.authorization, 'Bearer secret-openai');
    return new Response('data: {"choices":[{"delta":{"content":"new model works"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  } });
  try {
    const route = state.routes.find(r => r.path === ROUTES.account);
    await route.fetch(actionRequest({ action: 'group-create', group: { id: 'catalog', models: ['declared-legacy'] } }));
    const before = state.registrations[0].replaces.length;
    const beforeDirectory = state.providerDeclarations[0].replaces.length;
    const groupBefore = mounted.adapter.getGroup('catalog');
    clock.advance(1000);
    const response = await route.fetch(actionRequest({ action: 'group-models', id: 'catalog', credential: 'browser-must-not-be-used' }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.catalogRefreshed, true);
    assert.equal(result.whitelistChanged, false);
    assert.deepEqual(result.refreshedAccountIds, accounts.map(account => account.id));
    assert.deepEqual(result.models, ['claude-new', 'shared-model', 'openai-new', 'gemini-new', 'custom-new', 'grok-new']);
    assert.equal(calls.length, 5, 'one actual GET for every compatible group member');
    assert.equal(JSON.stringify(result).includes('secret-'), false);
    assert.equal(JSON.stringify(result).includes('KEY_'), false);
    assert.deepEqual(mounted.adapter.getGroup('catalog'), groupBefore, 'fetch never edits the whitelist');
    assert.deepEqual((await mounted.adapter.listModels('pool-catalog')).map(model => model.id), ['declared-legacy']);
    for (const source of result.sources) {
      assert.deepEqual(Object.keys(source), ['id', 'label', 'models']);
      assert.equal(source.label, `${source.id} label`);
      const stored = state.medium.tableFor('account_pool', 'accounts').get(source.id);
      assert.deepEqual(stored.models, ['declared-legacy', ...source.models]);
      assert.equal(stored.updatedAt, iso(T0 + 1000));
      assert.deepEqual(mounted.adapter.getAccount(source.id).models, stored.models);
    }
    assert.ok(state.registrations[0].replaces.length > before);
    assert.ok(state.providerDeclarations[0].replaces.length > beforeDirectory);
    assert.ok(state.registrations[0].providers.includes('pool'), 'native default callable route survives');
    assert.deepEqual(state.providerDeclarations[0].entries.map(entry => entry.provider), ['pool-catalog']);
    await route.fetch(actionRequest({ action: 'group-update', id: 'catalog', group: { models: ['openai-new'] } }));
    assert.deepEqual((await mounted.adapter.listModels('pool-catalog')).map(model => model.id), ['openai-new']);
    const prepared = await mounted.adapter.prepareCall('pool-catalog', 'openai-new');
    assert.equal(prepared.model.id, 'openai-new');
    const chunks = await drain(mounted.adapter.stream({ provider: 'pool-catalog', model: 'openai-new', messages: [] }));
    assert.equal(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'new model works'), true);
  } finally { await mounted.dispose(); }
  const fresh = makeCtx({ medium: state.medium });
  const reopened = await mountPool(fresh.ctx, { clock: makeClock(), upstream: UP_OK() });
  try {
    assert.deepEqual(reopened.adapter.getAccount('openai').models, ['declared-legacy', 'openai-new', 'shared-model']);
    assert.deepEqual((await reopened.adapter.listModels('pool-catalog')).map(model => model.id), ['openai-new']);
  } finally { await reopened.dispose(); }
});

await check('group-models: partial failures hide raw errors and credentials and leave failed accounts unchanged', async () => {
  const { ctx, state } = makeCtx();
  const secret = 'super-private-api-key';
  const ids = ['good', 'http', 'network', 'shape', 'resolver', 'missing', 'oauth'];
  const accounts = ids.map(id => ({ id, platform: 'custom', baseUrl: `https://${id}.invalid`,
    credentialRef: `PRIVATE_REF_${id}`, groups: ['partial'], models: [`old-${id}`], authMode: id === 'oauth' ? 'oauth' : 'api-key' }));
  for (const id of ids.filter(id => id !== 'missing')) state.secrets.set(`PRIVATE_REF_${id}`, secret);
  const credentials = ctx.get('credentials');
  const resolve = credentials.resolve;
  const resolves = [];
  credentials.resolve = async ref => {
    resolves.push(ref);
    if (ref.endsWith('_resolver')) throw new Error(`raw credential-store error ${secret}`);
    return resolve(ref);
  };
  let calls = 0;
  const mounted = await mountPool(ctx, { accounts, clock: makeClock(), upstream: UP_OK(), fetchImpl: async url => {
    calls += 1;
    if (url.includes('good.invalid')) return Response.json({ data: [{ id: 'remote-good' }, { id: secret }, { id: `echo-${secret}` }] });
    if (url.includes('http.invalid')) return new Response(`raw upstream error ${secret}`, { status: 401 });
    if (url.includes('network.invalid')) throw new Error(`raw transport error ${secret}`);
    return new Response(`invalid JSON ${secret}`);
  } });
  try {
    const route = state.routes.find(r => r.path === ROUTES.account);
    await route.fetch(actionRequest({ action: 'group-create', group: { id: 'partial', models: ['unrelated-whitelist'] } }));
    const before = new Map(ids.map(id => [id, mounted.adapter.getAccount(id)]));
    const result = await (await route.fetch(actionRequest({ action: 'group-models', id: 'partial' }))).json();
    assert.equal(result.ok, true);
    assert.deepEqual(result.models, ['remote-good']);
    assert.deepEqual(result.refreshedAccountIds, ['good']);
    assert.equal(calls, 4);
    assert.equal(resolves.includes('PRIVATE_REF_oauth'), false, 'unsupported OAuth never resolves or refreshes its token');
    const encoded = JSON.stringify(result);
    for (const forbidden of [secret, 'PRIVATE_REF_', 'raw upstream', 'raw transport', 'raw credential-store']) assert.equal(encoded.includes(forbidden), false);
    assert.match(result.sources.find(source => source.id === 'http').error, /HTTP 401/);
    assert.match(result.sources.find(source => source.id === 'oauth').error, /OAuth.*不支持/);
    assert.match(result.sources.find(source => source.id === 'missing').error, /未配置 API Key/);
    for (const id of ids.filter(id => id !== 'good')) {
      assert.deepEqual(result.sources.find(source => source.id === id).models, []);
      assert.ok(result.sources.find(source => source.id === id).error);
      assert.deepEqual(mounted.adapter.getAccount(id), before.get(id));
      assert.deepEqual(state.medium.tableFor('account_pool', 'accounts').get(id), before.get(id));
    }
    assert.deepEqual(mounted.adapter.getAccount('good').models, ['old-good', 'remote-good']);
  } finally { await mounted.dispose(); }
});

await check('group-models: missing id, unknown group and empty group are clear errors without upstream calls', async () => {
  const { ctx, state } = makeCtx();
  let calls = 0;
  const mounted = await mountPool(ctx, { clock: makeClock(), upstream: UP_OK(), fetchImpl: async () => { calls++; throw new Error('must not fetch'); } });
  try {
    const route = state.routes.find(r => r.path === ROUTES.account);
    await route.fetch(actionRequest({ action: 'group-create', group: { id: 'empty' } }));
    for (const [id, status, code] of [[undefined, 400, 'missing-id'], ['ghost', 404, 'unknown-group'], ['empty', 400, 'group-empty']]) {
      const response = await route.fetch(actionRequest({ action: 'group-models', id }));
      assert.equal(response.status, status);
      const result = await response.json();
      assert.equal(result.error.code, code);
      assert.ok(result.error.message);
    }
    assert.equal(calls, 0);
  } finally { await mounted.dispose(); }
});

await check('group-models: all unsupported OAuth accounts return individual errors and no catalog refresh', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: [{ id: 'subscription', platform: 'openai', authMode: 'oauth', groups: ['subscriptions'], models: ['old'] }], clock: makeClock(), upstream: UP_OK(), fetchImpl: async () => { throw new Error('OAuth must not fetch'); } });
  try {
    const route = state.routes.find(r => r.path === ROUTES.account);
    await route.fetch(actionRequest({ action: 'group-create', group: { id: 'subscriptions' } }));
    const before = state.registrations[0].replaces.length;
    const result = await (await route.fetch(actionRequest({ action: 'group-models', id: 'subscriptions' }))).json();
    assert.equal(result.ok, true);
    assert.deepEqual(result.models, []);
    assert.equal(result.catalogRefreshed, false);
    assert.deepEqual(result.refreshedAccountIds, []);
    assert.match(result.sources[0].error, /OAuth.*不支持/);
    assert.equal(state.registrations[0].replaces.length, before);
    assert.deepEqual(mounted.adapter.getAccount('subscription').models, ['old']);
  } finally { await mounted.dispose(); }
});

await check('group-models: bounded concurrency queries every member and re-resolves rotated stored credentials', async () => {
  const { ctx, state } = makeCtx();
  const accounts = Array.from({ length: 9 }, (_, index) => ({ id: `a${index}`, platform: 'custom',
    baseUrl: `https://a${index}.invalid`, credentialRef: `C${index}`, groups: ['bounded'] }));
  for (let index = 0; index < 9; index++) state.secrets.set(`C${index}`, `rotatable-${index}`);
  let active = 0, maximum = 0, calls = 0;
  let announceFirstWave;
  const firstWave = new Promise(resolve => { announceFirstWave = resolve; });
  const releases = [];
  let gated = true;
  const mounted = await mountPool(ctx, { accounts, clock: makeClock(), upstream: UP_OK(), fetchImpl: async (url, init) => {
    const index = Number(new URL(url).hostname.match(/^a(\d+)/)[1]);
    assert.equal(init.headers.authorization, `Bearer ${state.secrets.get(`C${index}`)}`);
    calls++; active++; maximum = Math.max(maximum, active);
    if (gated) {
      if (calls === 4) announceFirstWave();
      await new Promise(resolve => { releases.push(resolve); });
    }
    active--;
    return Response.json({ data: [{ id: `model-${index}` }] });
  } });
  try {
    const route = state.routes.find(r => r.path === ROUTES.account);
    await route.fetch(actionRequest({ action: 'group-create', group: { id: 'bounded' } }));
    const pending = route.fetch(actionRequest({ action: 'group-models', id: 'bounded' }));
    await firstWave;
    assert.equal(calls, 4, 'the fifth account waits for a worker');
    assert.equal(active, 4);
    gated = false;
    for (const release of releases) release();
    const result = await (await pending).json();
    assert.equal(maximum, 4);
    assert.equal(calls, 9);
    assert.deepEqual(result.models, accounts.map((_, index) => `model-${index}`));
    state.secrets.set('C0', 'rotated-secret');
    const again = await (await route.fetch(actionRequest({ action: 'group-models', id: 'bounded' }))).json();
    assert.equal(again.ok, true);
    assert.equal(calls, 18, 'fetch really queries upstream again after catalogs were saved');
  } finally { for (const release of releases) release(); await mounted.dispose(); }
});

await check('group-models: catalog save failure is safe and leaves durable and adapter account unchanged', async () => {
  const { ctx, state } = makeCtx();
  state.secrets.set('SECRET_REF', 'secret-for-save-test');
  const mounted = await mountPool(ctx, { accounts: [{ id: 'save', platform: 'custom', credentialRef: 'SECRET_REF', groups: ['saving'], models: ['old'] }], clock: makeClock(), upstream: UP_OK(), fetchImpl: async () => Response.json({ data: [{ id: 'new' }] }) });
  try {
    const route = state.routes.find(r => r.path === ROUTES.account);
    await route.fetch(actionRequest({ action: 'group-create', group: { id: 'saving' } }));
    const before = mounted.adapter.getAccount('save');
    const beforeRefresh = state.registrations[0].replaces.length;
    const rows = state.medium.tableFor('account_pool', 'accounts');
    rows.set = () => { throw new Error('disk failure with secret-for-save-test'); };
    const result = await (await route.fetch(actionRequest({ action: 'group-models', id: 'saving' }))).json();
    assert.equal(result.ok, true);
    assert.deepEqual(result.models, []);
    assert.match(result.sources[0].error, /无法保存/);
    assert.equal(JSON.stringify(result).includes('secret-for-save-test'), false);
    assert.equal(result.catalogRefreshed, false);
    assert.deepEqual(rows.get('save'), before);
    assert.deepEqual(mounted.adapter.getAccount('save'), before);
    assert.equal(state.registrations[0].replaces.length, beforeRefresh);
  } finally { await mounted.dispose(); }
});

await check('group-models: concurrent edits and deletion do not publish catalogs from obsolete connections', async () => {
  const { ctx, state } = makeCtx();
  for (const id of ['changed', 'deleted']) state.secrets.set(id, `private-${id}`);
  let announceStarted;
  const started = new Promise(resolve => { announceStarted = resolve; });
  const releases = [];
  const mounted = await mountPool(ctx, { accounts: ['changed', 'deleted'].map(id => ({ id, credentialRef: id,
    platform: 'custom', baseUrl: 'https://old.invalid', models: ['old'], groups: ['race'] })), clock: makeClock(), upstream: UP_OK(), fetchImpl: async () => {
      await new Promise(resolve => { releases.push(resolve); if (releases.length === 2) announceStarted(); });
      return Response.json({ data: [{ id: 'obsolete-catalog' }] });
    } });
  try {
    const route = state.routes.find(r => r.path === ROUTES.account);
    await route.fetch(actionRequest({ action: 'group-create', group: { id: 'race' } }));
    const pending = route.fetch(actionRequest({ action: 'group-models', id: 'race' }));
    await started;
    await route.fetch(actionRequest({ action: 'update', id: 'changed', account: { baseUrl: 'https://new.invalid', models: ['edited'] } }));
    await route.fetch(actionRequest({ action: 'delete', id: 'deleted' }));
    for (const release of releases) release();
    const result = await (await pending).json();
    assert.deepEqual(result.models, []);
    assert.equal(result.catalogRefreshed, false);
    assert.ok(result.sources.every(source => source.error && !source.models.length));
    assert.deepEqual(mounted.adapter.getAccount('changed').models, ['edited']);
    assert.equal(mounted.adapter.getAccount('deleted'), undefined);
  } finally { for (const release of releases) release(); await mounted.dispose(); }
});

await check('group-models: unrestricted accounts stay unrestricted and fetched models become callable after whitelist save', async () => {
  const { ctx, state } = makeCtx();
  state.secrets.set('UNRESTRICTED_KEY', 'unrestricted-private');
  const mounted = await mountPool(ctx, { accounts: [{ id: 'any', platform: 'custom', credentialRef: 'UNRESTRICTED_KEY',
    groups: ['unrestricted'], models: [] }], models: ['global-existing'], clock: makeClock(), upstream: UP_OK(),
    fetchImpl: async () => Response.json({ data: [{ id: 'fetched-new' }] }) });
  try {
    const route = state.routes.find(r => r.path === ROUTES.account);
    await route.fetch(actionRequest({ action: 'group-create', group: { id: 'unrestricted', models: ['group-existing'] } }));
    const result = await (await route.fetch(actionRequest({ action: 'group-models', id: 'unrestricted' }))).json();
    assert.deepEqual(result.models, ['fetched-new']);
    assert.equal(result.catalogRefreshed, true);
    assert.deepEqual(mounted.adapter.getAccount('any').models, [], 'fetch cannot narrow unrestricted access');
    assert.deepEqual(state.medium.tableFor('account_pool', 'accounts').get('any').models, []);
    assert.deepEqual((await mounted.adapter.listModels('pool-unrestricted')).map(model => model.id), ['group-existing']);
    assert.ok((await mounted.adapter.listModels('pool')).some(model => model.id === 'global-existing'));
    await route.fetch(actionRequest({ action: 'group-update', id: 'unrestricted', group: { models: result.models } }));
    assert.deepEqual((await mounted.adapter.listModels('pool-unrestricted')).map(model => model.id), ['fetched-new']);
    const chunks = await drain(mounted.adapter.stream({ provider: 'pool-unrestricted', model: 'fetched-new' }));
    assert.ok(chunks.some(chunk => chunk.type === 'text-delta'));
  } finally { await mounted.dispose(); }
});

await check('group-models: concurrent group deletion returns 404 without restoring account membership or catalogs', async () => {
  const { ctx, state } = makeCtx();
  state.secrets.set('RACE_KEY', 'race-private');
  let announceStarted, release;
  const started = new Promise(resolve => { announceStarted = resolve; });
  const mounted = await mountPool(ctx, { accounts: [{ id: 'member', platform: 'custom', credentialRef: 'RACE_KEY',
    groups: ['gone'], models: ['old'] }], clock: makeClock(), upstream: UP_OK(), fetchImpl: async () => {
      await new Promise(resolve => { release = resolve; announceStarted(); });
      return Response.json({ data: [{ id: 'new' }] });
    } });
  try {
    const route = state.routes.find(r => r.path === ROUTES.account);
    await route.fetch(actionRequest({ action: 'group-create', group: { id: 'gone' } }));
    const pending = route.fetch(actionRequest({ action: 'group-models', id: 'gone' }));
    await started;
    await route.fetch(actionRequest({ action: 'group-delete', id: 'gone' }));
    release();
    const response = await pending;
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'unknown-group');
    assert.equal(mounted.adapter.getGroup('gone'), undefined);
    assert.deepEqual(mounted.adapter.getAccount('member').models, ['old']);
    assert.deepEqual(mounted.adapter.getAccount('member').groups, []);
    assert.deepEqual(state.medium.tableFor('account_pool', 'accounts').get('member').groups, []);
  } finally { release?.(); await mounted.dispose(); }
});

await check('group-models: Anthropic relay uses stored key as Bearer without losing native headers or exposing credentials', async () => {
  const { ctx, state } = makeCtx();
  state.secrets.set('RELAY_PRIVATE_REF', 'private-anthropic-relay-key');
  let calls = 0;
  const mounted = await mountPool(ctx, { accounts: [{ id: 'relay', label: 'Anthropic relay', platform: 'anthropic',
    authMode: 'api-key', baseUrl: 'https://relay.invalid', credentialRef: 'RELAY_PRIVATE_REF',
    groups: ['relay'], models: ['old-model'] }], clock: makeClock(), upstream: UP_OK(), fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url, 'https://relay.invalid/v1/models');
      assert.equal(init.method, 'GET');
      assert.equal(init.headers['x-api-key'], 'private-anthropic-relay-key');
      assert.equal(init.headers['anthropic-version'], '2023-06-01');
      if (init.headers.authorization !== 'Bearer private-anthropic-relay-key') return new Response('raw private-anthropic-relay-key auth error', { status: 401 });
      return Response.json({ data: [{ id: 'claude-relay-new' }] });
    } });
  try {
    const route = state.routes.find(r => r.path === ROUTES.account);
    await route.fetch(actionRequest({ action: 'group-create', group: { id: 'relay', models: ['old-model'] } }));
    const result = await (await route.fetch(actionRequest({ action: 'group-models', id: 'relay', credential: 'ignored-browser-key' }))).json();
    assert.equal(result.ok, true);
    assert.deepEqual(result.models, ['claude-relay-new']);
    assert.equal(result.sources[0].error, undefined);
    assert.equal(calls, 1, 'native and relay auth use the same GET');
    assert.equal(result.catalogRefreshed, true);
    assert.deepEqual(mounted.adapter.getAccount('relay').models, ['old-model', 'claude-relay-new']);
    assert.deepEqual(mounted.adapter.getGroup('relay').models, ['old-model']);
    for (const forbidden of ['private-anthropic-relay-key', 'RELAY_PRIVATE_REF', 'ignored-browser-key']) assert.equal(JSON.stringify(result).includes(forbidden), false);
  } finally { await mounted.dispose(); }
});

await check('capability config: volatile native schema stays sparse and accepts off null', async () => {
  const config = Config({ providers: { 'pool-g': { modelOverrides: { m: { name: 'Only a name' } } } } });
  assert.equal(Config.dict.providers.meta.volatile, true);
  assert.equal(Config.dict.defaultContextWindow.meta.volatile, true);
  assert.equal(config.defaultContextWindow.get(), 200_000);
  const profile = config.providers.get()['pool-g'];
  assert.equal(typeof profile.modelOverrides, 'object');
  assert.deepEqual(profile.modelOverrides.m, { name: 'Only a name' }, 'unrelated overrides do not pin input/context/efforts');
  const enabled = Config({ providers: { 'pool-g': { modelOverrides: { m: { reasoningEfforts: { off: null, high: 'medium' }, input: ['text', 'image'], contextWindow: 1_000_000 } } } } });
  assert.deepEqual(enabled.providers.get()['pool-g'].modelOverrides.m.reasoningEfforts, { off: null, high: 'medium' });
  assert.throws(() => Config({ providers: { 'pool-g': { modelOverrides: { m: { contextWindow: 0 } } } } }));
  assert.throws(() => Config({ providers: { 'pool-g': { modelOverrides: { m: { input: ['video'] } } } } }));
  assert.throws(() => Config({ providers: { 'pool-g': { modelOverrides: { m: { reasoningEfforts: { secretLevel: 'high' } } } } } }));
});

await check('capability config: live volatile edits invalidate routes and restore inherited metadata', async () => {
  const { ctx, state } = makeCtx();
  const config = Config({ accounts: [{ id: 'a', platform: 'custom', groups: ['g'], models: ['m'] }] });
  const forwarded = [];
  const mounted = await mountPool(ctx, { ...config, clock: makeClock(), upstream: { stream: (_account, request) => { forwarded.push({ ...request }); return okStream(); } } });
  try {
    mounted.adapter.upsertGroup({ id: 'g', label: 'G', models: ['m'], enabled: true });
    const baseline = await mounted.adapter.resolveModel('pool-g', 'm');
    assert.equal(baseline.context.contextWindow, 200_000);
    assert.deepEqual(baseline.inputModalities, ['text']);
    const before = state.registrations[0].replaces.length;
    const write = Symbol.for('cosmokit.volatile.write');
    const next = Config({ providers: { 'pool-g': { modelOverrides: { m: { name: 'Renamed', contextWindow: 1_000_000, input: ['text', 'image'], reasoningEfforts: { off: null, high: 'medium' } } } } } });
    config.providers[write](next.providers.get());
    await state.emit('loader/volatile-update', [['providers', 'pool-g', 'modelOverrides', 'm']]);
    const prepared = await mounted.adapter.prepareCall('pool-g', 'm');
    assert.equal(prepared.model.name, 'Renamed');
    assert.equal(prepared.model.context.contextWindow, 1_000_000);
    assert.deepEqual(prepared.model.inputModalities, ['text'], 'a generic transport cannot claim image support');
    assert.deepEqual(prepared.model.reasoning.efforts.map(x => x.id), ['off', 'high']);
    assert.deepEqual(await mounted.adapter.listModels('pool-g'), [{ provider: 'pool-g', id: 'm', name: 'Renamed' }]);
    assert.equal((await mounted.adapter.resolveModel('pool', 'm')).name, 'm', 'route override does not leak into entire pool');
    assert.equal(state.registrations[0].replaces.length, before + 1);
    assert.deepEqual(mounted.adapter.getGroup('g').models, ['m']);
    config.providers[write]({});
    config.defaultContextWindow[write](300_000);
    await state.emit('loader/volatile-update', [['providers'], ['defaultContextWindow']]);
    const restored = await mounted.adapter.resolveModel('pool-g', 'm');
    assert.equal(restored.name, 'm');
    assert.equal(restored.context.contextWindow, 300_000);
    assert.deepEqual(restored.reasoning.efforts.map(x => x.id), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    await drain(prepared.stream({ reasoningEffort: 'high', messages: [{ role: 'user', content: 'fixture' }], sessionId: 'old-snapshot' }));
    assert.equal(forwarded[0].reasoningEffort, 'medium', 'prepared dispatch retains the matching previous capability mapping');
    await drain(prepared.stream({ reasoningEffort: 'off', sessionId: 'off-snapshot' }));
    assert.equal(Object.hasOwn(forwarded[1], 'reasoningEffort'), false);
    config.providers[write]({ 'pool-g': { modelOverrides: { m: { reasoningEfforts: false } } } });
    await state.emit('loader/volatile-update', [['providers', 'pool-g', 'modelOverrides', 'm', 'reasoningEfforts']]);
    assert.equal((await mounted.adapter.resolveModel('pool-g', 'm')).reasoning, undefined);
  } finally { await mounted.dispose(); }
});

await check('mount: Codex durable image attachment service reaches the HTTP transport', async () => {
  const { ctx } = makeCtx();
  const oldGet = ctx.get;
  const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFhQAAAAASUVORK5CYII=', 'base64');
  let reads = 0, fetches = 0;
  ctx.get = service => service === 'attachments' ? { async readImageRequest(ref) {
    reads++; assert.equal(ref.attachmentId, 'sha256:offline-image'); return { data, mediaType: 'image/png', width: 1, height: 1 };
  } } : oldGet(service);
  await ctx.get('credentials').set('IMAGE_FIXTURE', JSON.stringify({ access_token: 'fixture-token', chatgpt_account_id: 'fixture-account' }));
  const mounted = await mountPool(ctx, { refreshEnabled: false, accounts: [{ id: 'image', platform: 'openai', authMode: 'oauth', credentialRef: 'IMAGE_FIXTURE', models: ['gpt-5.3-codex'] }],
    fetchImpl: async (url, init) => { fetches++; const input = JSON.parse(init.body).input; assert.equal(input[0].content.at(-1).image_url, `data:image/png;base64,${data.toString('base64')}`);
      return new Response('data: '+JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [], usage: {} } })+'\n\n'); },
  });
  try {
    await drain(mounted.adapter.stream({ model: 'gpt-5.3-codex', messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'sha256:offline-image', width: 1, height: 1, bytes: data.length, mediaType: 'image/png' } }] }] }));
    assert.equal(reads, 1); assert.equal(fetches, 1);
  } finally { await mounted.dispose(); }
});

await check('mount: Codex attribution reads actual session origins and open turn projection', async () => {
  const { ctx, state } = makeCtx(); const oldGet = ctx.get;
  const sessions = new Map([
    ['root', { header: { id: 'root' } }],
    ['child', { header: { id: 'child', origin: 'subagent', parentSession: 'root' } }],
    ['grandchild', { header: { id: 'grandchild', origin: 'subagent', parentSession: 'child' } }],
    ['fork', { header: { id: 'fork', parentSession: 'root' } }],
    ['detached', { header: { id: 'detached', origin: 'subagent', parentSession: 'missing' } }],
    ['cycle', { header: { id: 'cycle', origin: 'subagent', parentSession: 'cycle' } }],
  ]);
  let turn = 1; const calls = [];
  ctx.get = service => service === 'sessions' ? { get: id => sessions.get(id) }
    : service === 'sessionProjections' ? { stateOf: (session, key) => { assert.equal(key, 'turnBoundary'); return { openTurnStartSeq: turn * 10, lastTurn: turn }; } } : oldGet(service);
  await ctx.get('credentials').set('ATTRIBUTION_FIXTURE', JSON.stringify({ access_token: 'fixture-token', chatgpt_account_id: 'fixture-account' }));
  const mounted = await mountPool(ctx, { refreshEnabled: false,
    accounts: [{ id: 'attribution', platform: 'openai', authMode: 'oauth', credentialRef: 'ATTRIBUTION_FIXTURE', models: ['gpt-5.3-codex'] }],
    fetchImpl: async (url, init) => { const body = JSON.parse(init.body); calls.push({ body, headers: init.headers, meta: body.client_metadata && JSON.parse(body.client_metadata['x-codex-turn-metadata']) });
      return new Response('data: '+JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [], usage: {} } })+'\n\n'); },
  });
  try {
    const call = opts => drain(mounted.adapter.stream({ model: 'gpt-5.3-codex', messages: [{ role: 'user', content: 'offline attribution' }], ...opts }));
    for (const sessionId of ['root','child','grandchild','fork','detached','cycle','missing']) await call({ sessionId });
    const [root,child,grandchild,fork,detached,cycle,missing] = calls.map(c => c.meta);
    assert.equal(root.thread_source, 'user'); assert.equal(child.thread_source, 'subagent');
    assert.equal(child.parent_thread_id, root.thread_id); assert.equal(grandchild.parent_thread_id, child.thread_id);
    assert.equal(grandchild.session_id, root.session_id);
    assert.notEqual(child.thread_id, root.thread_id); assert.notEqual(grandchild.thread_id, child.thread_id);
    assert.equal(fork.thread_source, 'user'); assert.equal(fork.parent_thread_id, undefined);
    assert.equal(detached.thread_source, 'subagent'); assert.ok(detached.parent_thread_id);
    assert.equal(cycle.parent_thread_id, undefined); assert.equal(missing.thread_source, undefined);
    await call({ sessionId: 'root' }); assert.equal(calls.at(-1).meta.turn_id, root.turn_id);
    turn++; await call({ sessionId: 'root' }); assert.notEqual(calls.at(-1).meta.turn_id, root.turn_id);
    await call({ sessionId: 'child', purpose: 'session-title' }); assert.equal(calls.at(-1).meta.thread_source, 'thread_title');
    assert.equal(calls.at(-1).meta.parent_thread_id, undefined);
    assert.equal(calls.at(-1).headers['x-openai-subagent'], undefined);
    await call({ sessionId: 'child', purpose: 'compaction' }); assert.equal(calls.at(-1).meta.request_kind, 'compaction');
    await call({}); assert.ok(calls.at(-1).meta.turn_id); assert.equal(calls.at(-1).meta.thread_source, undefined);
    assert.equal(calls.at(-1).body.prompt_cache_key, undefined);
    assert.equal(calls.at(-1).headers['session-id'], calls.at(-1).meta.session_id);
    const bindings = mounted.adapter.listBindings().map(binding => ({ ...binding }));
    await call({ codexRequestProvenance: Object.freeze({ version: 1, kind: 'auto-review', ownerSessionId: 'child', requestId: 'fixture-review' }) });
    const review = calls.at(-1);
    assert.equal(review.meta.thread_source, 'guardian_review');
    assert.equal(review.headers['x-openai-subagent'], 'guardian');
    assert.equal(review.headers['x-codex-guardian'], undefined);
    assert.equal(review.meta.parent_thread_id, child.thread_id);
    assert.equal(review.meta.session_id, root.session_id);
    assert.equal(review.meta.subagent_kind, undefined);
    assert.notEqual(review.meta.thread_id, child.thread_id);
    assert.equal(review.headers['thread-id'], review.meta.thread_id);
    assert.equal(review.body.prompt_cache_key, undefined);
    assert.deepEqual(mounted.adapter.listBindings(), bindings, 'review provenance does not enter ordinary session routing');
    const route = state.routes.find(row => row.path === ROUTES.accounts);
    const diagnostics = (await (await route.fetch(new Request('http://127.0.0.1' + ROUTES.accounts))).json()).codexAttributionDispatch;
    assert.equal(diagnostics.enabled, true); assert.equal(diagnostics.totalAttempts, calls.length);
    assert.deepEqual(diagnostics.bySource, { user: 4, subagent: 5, thread_title: 1, guardian_review: 1, unknown: 2 });
    assert.deepEqual(diagnostics.byRequestKind, { turn: 12, compaction: 1 });
    assert.equal(diagnostics.missingSourceReasons['session-not-found'], 1);
    assert.equal(diagnostics.missingSourceReasons['missing-session-id'], 1);
    assert.equal(diagnostics.officialAnalyticsVerified, false);
    const warnings = () => state.logs.warn.filter(line => line.includes('no verified thread_source'));
    assert.equal(warnings().length, 2);
    assert.doesNotMatch(warnings().join('\n'), /fixture-token|fixture-account|offline attribution|ATTRIBUTION_FIXTURE/);
    await call({ sessionId: 'missing' });
    assert.equal(warnings().length, 2, 'same missing-source reason warns at most once per mount');
  } finally { await mounted.dispose(); }
});

await check('mount: Codex WebSocket configuration dispatch, diagnostics and disposal are wired', async () => {
  const { ctx, state } = makeCtx();
  const sockets = [], sent = [];
  class FixtureSocket extends EventEmitter {
    constructor(url, init) { super(); this.readyState = 0; sockets.push(this);
      assert.equal(url, 'wss://chatgpt.com/backend-api/codex/responses');
      assert.equal(init.headers.authorization, 'Bearer HOST_PRIVATE_FIXTURE');
      queueMicrotask(() => { this.readyState = 1; this.emit('open'); }); }
    send(raw, callback) { sent.push(JSON.parse(raw)); callback?.();
      queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed', response: {
        id: `resp_host_${sent.length}`, status: 'completed', output: [{ type: 'message', id: 'msg_host', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: 'ok' }] }], usage: {},
      } })), false)); }
    terminate() { this.readyState = 3; queueMicrotask(() => this.emit('close')); }
  }
  await ctx.get('credentials').set('WS_FIXTURE', JSON.stringify({ access_token: 'HOST_PRIVATE_FIXTURE', chatgpt_account_id: 'HOST_WORKSPACE_FIXTURE' }));
  const mounted = await mountPool(ctx, { refreshEnabled: false, requestRetries: 0, webSocketImpl: FixtureSocket,
    accounts: [{ id: 'codex-ws', platform: 'openai', authMode: 'oauth', openaiTransport: 'websocket', credentialRef: 'WS_FIXTURE', models: ['fixture-model'] }],
    fetchImpl: async () => { assert.fail('Host WS path must not dispatch HTTP'); },
  });
  try {
    const first = await drain(mounted.adapter.stream({ model: 'fixture-model', sessionId: 'host-session', messages: [{ role: 'user', content: 'fixture' }] }));
    const history = [{ role: 'user', content: 'fixture' }, { role: 'assistant', content: first.filter(c => c.type === 'block-end').map(c => c.block), source: { replayState: first.at(-1).replayState } }, { role: 'user', content: 'again' }];
    await drain(mounted.adapter.stream({ model: 'fixture-model', sessionId: 'host-session', messages: history }));
    assert.equal(sockets.length, 1); assert.equal(sent[1].previous_response_id, 'resp_host_1'); assert.equal(sent[1].input.length, 1);
    const route = state.routes.find(row => row.path === ROUTES.accounts);
    const body = await (await route.fetch(new Request('http://127.0.0.1' + ROUTES.accounts))).json();
    assert.equal(body.codexWebSocketVersion, 1); assert.equal(typeof body.codexWebSocket, 'object');
    assert.equal(body.codexAttributionDispatch.totalAttempts, 2);
    assert.doesNotMatch(JSON.stringify(body.codexWebSocket), /PRIVATE_FIXTURE|WORKSPACE_FIXTURE|host-session|resp_host/);
  } finally { await mounted.dispose(); }
  assert.ok(sockets.every(socket => socket.readyState === 3), 'unload closes resident connections');
});

await check('mount: Codex diagnostics do not require the optional review companion', async () => {
  const { ctx, state } = makeCtx();
  assert.equal(plugin.inject.includes('codexReviewAttribution'), false);
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, upstream: UP_OK() });
  try {
    const route = state.routes.find(row => row.path === ROUTES.accounts);
    const body = await (await route.fetch(new Request('http://127.0.0.1' + ROUTES.accounts))).json();
    assert.match(body.runtimeRevision, /^\d+\.\d+\.\d+-[a-z0-9-]+$/, 'reports a versioned runtime independent of the optional companion');
    assert.equal(body.codexWebSocketVersion, 1);
    assert.deepEqual(body.codexWebSocket, { available: false }, 'injected transport does not claim native WS state');
    assert.deepEqual(body.codexContinuity, { mode: 'session-aead-v1', keyState: 'not-loaded', stickyIdleTtlMs: 7 * 24 * 60 * 60 * 1000 });
    assert.equal(state.secrets.size, 0, 'no replay key is created before Codex is used');
    assert.equal(body.codexAttributionVersion, 2);
    assert.equal(body.codexAttributionCapabilities.officialSessionHeaders, true);
    assert.equal(body.codexAttributionCapabilities.requestLocalMetadata, true);
    assert.equal(body.codexAttributionCapabilities.reviewBridge, false);
    assert.equal(body.codexAttributionCapabilities.reviewBridgeStatus, 'not-installed');
    assert.equal(body.codexAttributionCapabilities.officialAnalyticsVerified, false);
    assert.equal(body.codexAttributionCapabilities.review, null);
    assert.equal(body.codexAttributionDispatch.version, 1);
    assert.equal(body.codexAttributionDispatch.enabled, false, 'custom transport cannot be observed by HTTP dispatch hook');
    assert.equal(body.codexAttributionDispatch.totalAttempts, 0);
  } finally { await mounted.dispose(); }
});

await check('mount: optional review diagnostics attach, sanitize and detach independently', async () => {
  const { ctx, state } = makeCtx(); const detach = []; let status = {
    version: 1, compatible: true, augmentationEnabled: true, augmentedRequests: 2, missingProvenance: 0,
    originalModulePath: 'private-runtime-path', moduleSha256: 'internal-digest', status: 'private-failure-detail',
  };
  const bridge = { snapshot: () => status };
  ctx.inject = (names, callback) => {
    if (names[0] === 'compaction' || names[0] === 'agents') return;
    assert.deepEqual(names, ['codexReviewAttribution']);
    callback({ get: name => { assert.equal(name, names[0]); return bridge; }, effect: fn => { detach.push(fn()); } });
  };
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, upstream: UP_OK() });
  try {
    const route = state.routes.find(row => row.path === ROUTES.accounts);
    const readState = async () => (await (await route.fetch(new Request('http://127.0.0.1' + ROUTES.accounts))).json()).codexAttributionCapabilities;
    let info = await readState();
    assert.equal(info.reviewBridge, true); assert.equal(info.reviewBridgeStatus, 'enabled');
    assert.deepEqual(info.review, { version: 1, compatible: true, augmentationEnabled: true, augmentedRequests: 2, missingProvenance: 0 });
    assert.equal(JSON.stringify(info).includes('private-'), false); assert.equal(JSON.stringify(info).includes('internal-digest'), false);
    status = { ...status, compatible: false, augmentationEnabled: false, augmentedRequests: -1, missingProvenance: 'invalid' };
    info = await readState(); assert.equal(info.reviewBridge, false); assert.equal(info.reviewBridgeStatus, 'disabled-incompatible');
    assert.equal(info.review.augmentedRequests, 0); assert.equal(info.review.missingProvenance, 0);
    detach.forEach(fn => fn()); info = await readState();
    assert.equal(info.reviewBridgeStatus, 'not-installed'); assert.equal(info.review, null);
  } finally { await mounted.dispose(); }
});

await check('mount: Codex optional review bridge supports late loading, replacement and unloading without remount', async () => {
  const { ctx, state } = makeCtx();
  let attach;
  ctx.inject = (names, callback) => { if (names[0] === 'compaction' || names[0] === 'agents') return; assert.deepEqual(names, ['codexReviewAttribution']); attach = callback; };
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, upstream: UP_OK() });
  const connect = bridge => {
    const disposers = [];
    attach({ get: () => bridge, effect: fn => { disposers.push(fn()); } });
    return () => disposers.forEach(dispose => dispose());
  };
  const service = count => ({ snapshot: () => ({ version: 1, compatible: true, augmentationEnabled: true, augmentedRequests: count, missingProvenance: 0 }) });
  try {
    const route = state.routes.find(row => row.path === ROUTES.accounts);
    const readState = async () => (await (await route.fetch(new Request('http://127.0.0.1' + ROUTES.accounts))).json()).codexAttributionCapabilities;
    assert.equal((await readState()).reviewBridgeStatus, 'not-installed');
    const detachFirst = connect(service(1));
    assert.equal((await readState()).review.augmentedRequests, 1);
    const detachSecond = connect(service(2));
    detachFirst();
    assert.equal((await readState()).review.augmentedRequests, 2, 'stale cleanup must not detach a new provider');
    detachSecond();
    assert.equal((await readState()).reviewBridgeStatus, 'not-installed');
    const detachThird = connect(service(3));
    assert.equal((await readState()).review.augmentedRequests, 3);
    detachThird();
    assert.equal(state.opened.length, 1, 'optional service changes never reopen the account domain');
    assert.equal(state.registrations.length, 1, 'the pool adapter stays registered');
    assert.equal((await readState()).review, null);
    assert.deepEqual((await drain(mounted.adapter.stream({ provider: 'pool', model: 'anthropic/test', sessionId: 'still-independent', messages: [] }))).filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['ok']);
  } finally { await mounted.dispose(); }
});

await check('mount: Codex optional review API failures stay isolated from management and status dump', async () => {
  const { ctx, state } = makeCtx();
  const secret = 'PRIVATE_REVIEW_BRIDGE_ERROR';
  let bridge = { snapshot() { throw Error(secret); } };
  ctx.inject = (names, callback) => callback({ get: () => ({ get snapshot() { return bridge.snapshot; } }), effect: fn => fn() });
  const dumpPath = join(tmpdir(), `account-pool-review-bridge-${process.pid}.json`);
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, upstream: UP_OK(), statusDumpPath: dumpPath });
  try {
    const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
    assert.equal(dump.codexAttributionCapabilities.reviewBridgeStatus, 'disabled-unavailable');
    const route = state.routes.find(row => row.path === ROUTES.accounts);
    const cases = [
      ['missing method', {}, 'disabled-unavailable'],
      ['wrong method type', { snapshot: true }, 'disabled-unavailable'],
      ['throwing method', { snapshot() { throw Error(secret); } }, 'disabled-unavailable'],
      ['throwing method getter', { get snapshot() { throw Error(secret); } }, 'disabled-unavailable'],
      ...[null, undefined, 'invalid', [], { version: 1, compatible: 'yes', augmentationEnabled: true }].map(value => ['invalid snapshot', { snapshot: () => value }, 'disabled-unavailable']),
      ['unknown version', { snapshot: () => ({ version: 2, compatible: true, augmentationEnabled: true }) }, 'disabled-incompatible'],
      ['throwing snapshot getter', { snapshot: () => ({ version: 1, compatible: true, augmentationEnabled: true, get augmentedRequests() { throw Error(secret); } }) }, 'disabled-unavailable'],
      ['async rejection', { snapshot: async () => { throw Error(secret); } }, 'disabled-unavailable'],
      ['async success is not a synchronous snapshot', { snapshot: async () => ({ version: 1, compatible: true, augmentationEnabled: true }) }, 'disabled-unavailable'],
      ['throwing then getter', { snapshot: () => ({ get then() { throw Error(secret); } }) }, 'disabled-unavailable'],
      ['missing flags', { snapshot: () => ({ version: 1 }) }, 'disabled-unavailable'],
    ];
    for (const [label, value, status] of cases) {
      bridge = value;
      const response = await route.fetch(new Request('http://127.0.0.1' + ROUTES.accounts));
      assert.equal(response.status, 200, label);
      const body = await response.json();
      assert.equal(body.accounts.length, CONFIG_ACCOUNTS.length, label);
      assert.equal(body.codexAttributionCapabilities.reviewBridge, false, label);
      assert.equal(body.codexAttributionCapabilities.reviewBridgeStatus, status, label);
      assert.equal(body.codexAttributionCapabilities.review, null, label);
      assert.equal(JSON.stringify(body).includes(secret), false, label);
    }
    bridge = { snapshot: () => ({ version: 1, compatible: true, augmentationEnabled: true, augmentedRequests: 0, missingProvenance: 0 }) };
    assert.equal((await (await route.fetch(new Request('http://127.0.0.1' + ROUTES.accounts))).json()).codexAttributionCapabilities.reviewBridge, true, 'a repaired provider recovers without a remount');
    const reads = { method: 0, compatible: 0, enabled: 0, count: 0 };
    bridge = { get snapshot() {
      reads.method++;
      return () => ({ version: 1,
        get compatible() { return ++reads.compatible === 1 ? true : secret; },
        get augmentationEnabled() { return ++reads.enabled === 1 ? true : secret; },
        get augmentedRequests() { return ++reads.count === 1 ? 7 : secret; },
        missingProvenance: Number.POSITIVE_INFINITY,
      });
    } };
    const sanitized = (await (await route.fetch(new Request('http://127.0.0.1' + ROUTES.accounts))).json()).codexAttributionCapabilities;
    assert.deepEqual(sanitized.review, { version: 1, compatible: true, augmentationEnabled: true, augmentedRequests: 7, missingProvenance: 0 });
    assert.deepEqual(reads, { method: 1, compatible: 1, enabled: 1, count: 1 }, 'validation must not re-read changing provider getters');
    assert.equal(sanitized.reviewBridgeStatus, 'enabled');
    assert.equal(JSON.stringify(sanitized).includes(secret), false);
  } finally { await mounted.dispose(); rmSync(dumpPath, { force: true }); }
});

await check('mount: model attribution exposes only pinned host probes and aborts on unload', async () => {
  const { ctx, state } = makeCtx(); const services = new Map(); const oldGet = ctx.get;
  ctx.get = name => services.get(name) ?? oldGet(name);
  ctx.provide = (name, service) => { services.set(name, service); return () => services.delete(name); };
  await ctx.get('credentials').set('MODEL_PROBE_PRIVATE_REF', 'PRIVATE_TOKEN_SENTINEL');
  let requests = 0;
  const mounted = await mountPool(ctx, { accounts: [{ id: 'probe-row', platform: 'openai', authMode: 'api-key', credentialRef: 'MODEL_PROBE_PRIVATE_REF', baseUrl: 'https://private-host.test', models: ['fixture-model'], schedulable: false }],
    upstream: { async *stream(account, options) { requests++; assert.equal(account.id, 'probe-row'); assert.equal(options.purpose, 'model-attribution');
      yield { type: 'text-delta', index: 0, text: '1 2 3' }; yield { type: 'finish', reason: { kind: 'stop' } }; } },
  });
  try {
    const service = ctx.get('accountPoolModelProbe'); assert.equal(service.version, 1);
    const targets = await service.targets(); assert.equal(targets[0].configured, true); assert.equal(requests, 0);
    assert.doesNotMatch(JSON.stringify(targets), /PRIVATE_TOKEN|PRIVATE_REF|private-host/);
    const prepared = service.prepare('probe-row', { model: 'fixture-model', maxTokens: 8192 });
    const iterator = prepared.stream('fixed probe', new AbortController().signal); await iterator.next();
    state.effects.find(effect => effect.label === 'account-pool: modelProbeAbort').disposer();
    await assert.rejects(iterator.next(), { name: 'AbortError' });
    assert.equal(mounted.adapter.inflightSnapshot().size, 0);
    assert.throws(() => service.prepare('probe-row', { model: 'fixture-model' }), { name: 'AbortError' });
  } finally { await mounted.dispose(); }
});

// ------------------------------------------------- pinned scheduling capability
function modelProbeCtx(options) {
  const fixture = makeCtx(options); const services = new Map(); const oldGet = fixture.ctx.get;
  fixture.ctx.get = name => services.get(name) ?? oldGet(name);
  fixture.ctx.provide = (name, service) => { services.set(name, service); return () => services.delete(name); };
  return fixture;
}
const PAUSE_PROBE_ACCOUNT = { id: 'pause-probe', platform: 'openai', authMode: 'api-key',
  credentialRef: 'FIXTURE_PAUSE_REF', baseUrl: 'https://offline-pause.test', models: ['fixture-model'] };
const preparePause = ctx => ctx.get('accountPoolModelProbe').prepare('pause-probe', { model: 'fixture-model' });

await check('model probe pause: preserves every other field, is idempotent and never auto resumes', async () => {
  const { ctx, state } = modelProbeCtx(); const medium = state.medium;
  const mounted = await mountPool(ctx, { accounts: [PAUSE_PROBE_ACCOUNT], clock: makeClock(), upstream: UP_OK() });
  try {
    assert.equal(ctx.get('accountPoolModelProbe').pauseSchedulingVersion, 1);
    const prepared = preparePause(ctx);
    // Operator/health edits after preparation must survive the scheduling action.
    mounted.adapter.upsertAccount({ ...mounted.adapter.getAccount('pause-probe'), label: 'Edited label',
      status: 'disabled', consecutiveFailures: 7, errorMessage: 'fixture-health', cooldownUntil: iso(T0 + 10000),
      lastUsedAt: iso(T0 - 1000), priority: 42, concurrency: 9, groups: ['fixture-group'], totalInputTokens: 123 });
    await mounted.flush();
    const before = structuredClone(mounted.adapter.getAccount('pause-probe'));
    const accounts = medium.tableFor('account_pool', 'accounts'); const set = accounts.set.bind(accounts); let writes = 0;
    accounts.set = (key, value) => { writes++; return set(key, value); };
    try {
      assert.deepEqual(await prepared.pauseScheduling(), { alreadyPaused: false });
      assert.deepEqual(mounted.adapter.getAccount('pause-probe'), { ...before, schedulable: false });
      assert.deepEqual(accounts.get('pause-probe'), { ...before, schedulable: false });
      assert.deepEqual(await preparePause(ctx).pauseScheduling(), { alreadyPaused: true });
      assert.equal(writes, 1, 'already-paused calls do not rewrite storage');
      await drain(prepared.stream('fixed diagnostic', new AbortController().signal));
      assert.deepEqual(mounted.adapter.getAccount('pause-probe'), { ...before, schedulable: false }, 'successful diagnostics do not resume scheduling');
    } finally { accounts.set = set; }
  } finally { await mounted.dispose(); }
  const reopened = modelProbeCtx({ medium });
  const restart = await mountPool(reopened.ctx, { accounts: [PAUSE_PROBE_ACCOUNT], upstream: UP_OK() });
  try { assert.equal(restart.adapter.getAccount('pause-probe').schedulable, false, 'restart does not resume a persisted pause'); }
  finally { await restart.dispose(); }
});

await check('model probe pause: exact connection key guards all fields and deleted/recreated rows', async () => {
  const changes = { createdAt: iso(T0 + 1), platform: 'grok', authMode: 'oauth', credentialRef: 'OTHER_REF',
    baseUrl: 'https://other-offline.test', chatgptAccountId: 'other-owner', projectId: 'other-project',
    openaiApi: 'responses', openaiTransport: 'websocket', mimicry: false, betas: ['other-beta'], models: ['other-model'] };
  for (const [field, value] of Object.entries(changes)) {
    const { ctx, state } = modelProbeCtx(); const mounted = await mountPool(ctx, { accounts: [PAUSE_PROBE_ACCOUNT], upstream: UP_OK() });
    try {
      const prepared = preparePause(ctx); mounted.adapter.upsertAccount({ ...mounted.adapter.getAccount('pause-probe'), [field]: value });
      await mounted.flush(); const before = structuredClone(mounted.adapter.getAccount('pause-probe'));
      await assert.rejects(prepared.pauseScheduling(), { code: 'POOL_TEST_TARGET_CHANGED' });
      assert.deepEqual(mounted.adapter.getAccount('pause-probe'), before, field);
      assert.equal(state.medium.tableFor('account_pool', 'accounts').get('pause-probe').schedulable, true, field);
    } finally { await mounted.dispose(); }
  }
  const { ctx, state } = modelProbeCtx(); const mounted = await mountPool(ctx, { accounts: [PAUSE_PROBE_ACCOUNT], upstream: UP_OK() });
  try {
    const prepared = preparePause(ctx); const before = mounted.adapter.getAccount('pause-probe');
    mounted.adapter.removeAccount('pause-probe'); await mounted.flush();
    await assert.rejects(prepared.pauseScheduling(), { code: 'POOL_TEST_TARGET_CHANGED' });
    assert.equal(mounted.adapter.getAccount('pause-probe'), undefined);
    assert.equal(state.medium.tableFor('account_pool', 'accounts').has('pause-probe'), false, 'deleted accounts are never recreated');
    mounted.adapter.upsertAccount({ ...before, createdAt: iso(T0 + 2) }); await mounted.flush();
    await assert.rejects(prepared.pauseScheduling(), { code: 'POOL_TEST_TARGET_CHANGED' });
    assert.equal(mounted.adapter.getAccount('pause-probe').schedulable, true);
  } finally { await mounted.dispose(); }
});

await check('model probe pause: lifecycle rejects both scheduling and acknowledgement after unload', async () => {
  const { ctx, state } = modelProbeCtx(); const mounted = await mountPool(ctx, { accounts: [PAUSE_PROBE_ACCOUNT], upstream: UP_OK() });
  try {
    const prepared = preparePause(ctx); const before = structuredClone(mounted.adapter.getAccount('pause-probe'));
    state.effects.find(effect => effect.label === 'account-pool: modelProbeAbort').disposer();
    await assert.rejects(prepared.pauseScheduling(), { name: 'AbortError' });
    assert.deepEqual(mounted.adapter.getAccount('pause-probe'), before);
  } finally { await mounted.dispose(); }
});

await check('model probe pause: concurrent handles await the exact durable write and unload suppresses success', async () => {
  for (const unload of [false, true]) {
    const { ctx, state } = modelProbeCtx(); const open = ctx.storageDomain.open.bind(ctx.storageDomain);
    let release; let writes = 0;
    const gate = new Promise(resolve => { release = resolve; });
    ctx.storageDomain.open = async spec => {
      const domain = await open(spec); const table = domain.table.bind(domain);
      domain.table = name => {
        const original = table(name);
        if (name !== 'accounts') return original;
        return { ...original, put: async (key, value) => {
          if (key === 'pause-probe' && value.schedulable === false) { writes++; await gate; }
          return original.put(key, value);
        } };
      };
      return domain;
    };
    const mounted = await mountPool(ctx, { accounts: [PAUSE_PROBE_ACCOUNT], upstream: UP_OK() });
    try {
      let returned = false; const prepared = preparePause(ctx);
      const first = prepared.pauseScheduling().then(result => { returned = true; return result; });
      const second = preparePause(ctx).pauseScheduling(); const both = Promise.all([first, second]);
      const outcome = unload ? assert.rejects(both, { name: 'AbortError' }) : both;
      for (let i = 0; i < 12; i++) await Promise.resolve();
      assert.equal(returned, false); assert.equal(writes, 1);
      assert.equal(state.medium.tableFor('account_pool', 'accounts').get('pause-probe').schedulable, true);
      if (unload) state.effects.find(effect => effect.label === 'account-pool: modelProbeAbort').disposer();
      release(); const result = await outcome;
      if (!unload) assert.deepEqual(result, [{ alreadyPaused: false }, { alreadyPaused: false }]);
      assert.equal(state.medium.tableFor('account_pool', 'accounts').get('pause-probe').schedulable, false);
    } finally { release(); await mounted.dispose(); }
  }
});

await check('model probe pause: synchronous/immediate/delayed persistence errors reject and clean retry persists', async () => {
  for (const mode of ['synchronous', 'immediate', 'delayed']) {
    const { ctx, state } = modelProbeCtx(); const open = ctx.storageDomain.open.bind(ctx.storageDomain);
    let fail = true; let rejectWrite; let writes = 0;
    const rejected = new Promise((_, reject) => { rejectWrite = reject; }); rejected.catch(() => {});
    ctx.storageDomain.open = async spec => {
      const domain = await open(spec); const table = domain.table.bind(domain);
      domain.table = name => {
        const original = table(name);
        if (name !== 'accounts') return original;
        return { ...original, put: (key, value) => {
          if (key === 'pause-probe' && value.schedulable === false) {
            writes++;
            if (fail) {
              if (mode === 'synchronous') throw Error('private-sync-persist');
              return mode === 'immediate' ? Promise.reject(Error('private-immediate-persist')) : rejected;
            }
          }
          return original.put(key, value);
        } };
      };
      return domain;
    };
    const mounted = await mountPool(ctx, { accounts: [PAUSE_PROBE_ACCOUNT], upstream: UP_OK() });
    try {
      const prepared = preparePause(ctx); let returned = false;
      const first = prepared.pauseScheduling().finally(() => { returned = true; });
      const rejectedPause = assert.rejects(first, error => error.code === 'persist-failed' && !error.message.includes('private-'));
      if (mode === 'delayed') {
        for (let i = 0; i < 12; i++) await Promise.resolve();
        assert.equal(returned, false); rejectWrite(Error('private-delayed-persist'));
      }
      await rejectedPause;
      assert.equal(mounted.adapter.getAccount('pause-probe').schedulable, false, 'runtime may change even when persistence fails');
      assert.equal(state.medium.tableFor('account_pool', 'accounts').get('pause-probe').schedulable, true);
      fail = false;
      assert.deepEqual(await preparePause(ctx).pauseScheduling(), { alreadyPaused: true });
      assert.equal(state.medium.tableFor('account_pool', 'accounts').get('pause-probe').schedulable, false);
      assert.equal(writes, 2, 'dirty pause retries storage rather than falsely acknowledging the memory snapshot');
      assert.deepEqual(await prepared.pauseScheduling(), { alreadyPaused: true }); assert.equal(writes, 2);
    } finally { fail = false; rejectWrite(Error('cleanup')); await mounted.dispose(); }
  }
});

// ------------------------------------------------- durable management outcomes
await check('management persistence: immediate rejected writes cannot report successful save', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, upstream: UP_OK(), oauthCallbackPort: 0 });
  const table = state.medium.tableFor('account_pool', 'accounts');
  const originalSet = table.set.bind(table);
  table.set = () => { throw Error('private-storage-diagnostic'); };
  try {
    const route = state.routes.find(row => row.path === ROUTES.account);
    const response = await route.fetch(actionRequest({ action: 'disable', id: 'a1' }));
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.ok, false); assert.equal(body.persisted, false);
    assert.equal(body.error.code, 'persist-failed');
    assert.equal(body.runtimeMayHaveChanged, true);
    assert.ok(!JSON.stringify(body).includes('private-storage-diagnostic'));
    assert.notEqual(table.get('a1').status, 'disabled', 'durable data did not change');
  } finally { table.set = originalSet; await mounted.dispose(); }
});
await check('management persistence: concurrent request failure is isolated from a successful save', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, upstream: UP_OK(), oauthCallbackPort: 0 });
  const table = state.medium.tableFor('account_pool', 'accounts');
  const originalSet = table.set.bind(table);
  table.set = (key, value) => { if (key === 'a1') throw Error('storage-a1'); return originalSet(key, value); };
  try {
    const route = state.routes.find(row => row.path === ROUTES.account);
    const [failed, saved] = await Promise.all(['a1', 'a2'].map(id => route.fetch(actionRequest({ action: 'disable', id }))));
    assert.equal(failed.status, 503); assert.equal(saved.status, 200);
    assert.equal((await saved.json()).ok, true);
    assert.equal(table.get('a2').status, 'disabled');
  } finally { table.set = originalSet; await mounted.dispose(); }
});
await check('management persistence: group failures are visible and clean retries succeed', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, upstream: UP_OK(), oauthCallbackPort: 0 });
  const table = state.medium.tableFor('account_pool', 'groups');
  const originalSet = table.set.bind(table);
  table.set = () => { throw Error('storage-groups'); };
  try {
    const route = state.routes.find(row => row.path === ROUTES.account);
    const failed = await route.fetch(actionRequest({ action: 'group-create', group: { id: 'ux-save', label: 'Test group' } }));
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).error.code, 'persist-failed');
    table.set = originalSet;
    const saved = await route.fetch(actionRequest({ action: 'group-update', id: 'ux-save', group: { label: 'Saved on retry' } }));
    assert.equal(saved.status, 200); assert.equal(table.get('ux-save').label, 'Saved on retry');
  } finally { table.set = originalSet; await mounted.dispose(); }
});

await check('management persistence: delayed rejection is awaited and a clean retry can save', async () => {
  const { ctx, state } = makeCtx();
  const open = ctx.storageDomain.open.bind(ctx.storageDomain);
  let rejectWrite; let fail = true;
  const deferredWrite = new Promise((_, reject) => { rejectWrite = reject; });
  ctx.storageDomain.open = async spec => {
    const domain = await open(spec); const table = domain.table.bind(domain);
    domain.table = name => {
      const original = table(name);
      if (name !== 'accounts') return original;
      return { ...original, put: (key, value) => fail && key === 'a1' && value.status === 'disabled' ? deferredWrite : original.put(key, value) };
    };
    return domain;
  };
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, upstream: UP_OK(), oauthCallbackPort: 0 });
  try {
    const route = state.routes.find(row => row.path === ROUTES.account);
    let returned = false;
    const pendingSave = route.fetch(actionRequest({ action: 'disable', id: 'a1' })).then(response => { returned = true; return response; });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.equal(returned, false, 'success cannot be reported before durable write settles');
    rejectWrite(Error('delayed-private-diagnostic'));
    const response = await pendingSave;
    assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'persist-failed');
    fail = false;
    const retry = await route.fetch(actionRequest({ action: 'disable', id: 'a1' }));
    assert.equal(retry.status, 200); assert.equal((await retry.json()).ok, true);
    assert.equal(state.medium.tableFor('account_pool', 'accounts').get('a1').status, 'disabled');
  } finally { fail = false; rejectWrite(Error('test-cleanup')); await mounted.dispose(); }
});
await check('management persistence: unrelated background usage rejection does not fail an operator save', async () => {
  const { ctx, state } = makeCtx();
  const mounted = await mountPool(ctx, { accounts: CONFIG_ACCOUNTS, upstream: UP_OK(), oauthCallbackPort: 0 });
  const usage = state.medium.tableFor('account_pool', 'usage'); const set = usage.set.bind(usage);
  usage.set = () => { throw Error('advisory-usage-write'); };
  try {
    await drain(mounted.adapter.stream({ model: 'claude-fixture', messages: [{ role: 'user', content: 'offline' }] }));
    const route = state.routes.find(row => row.path === ROUTES.account);
    const response = await route.fetch(actionRequest({ action: 'disable', id: 'a2' }));
    assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
    assert.equal(state.medium.tableFor('account_pool', 'accounts').get('a2').status, 'disabled');
  } finally { usage.set = set; await mounted.dispose(); }
});

await check('mount: sealed Codex replay survives credential-service and Host remount with refreshed token', async () => {
  const token = tick => `fixture.${Buffer.from(JSON.stringify({ iss: 'https://auth.fixture', sub: 'fixture-user', iat: tick,
    'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-workspace' } })).toString('base64url')}.signature`;
  const configured = [{ id: 'continuity', platform: 'openai', authMode: 'oauth', credentialRef: 'FIXTURE_CODEX_TOKEN', models: ['gpt-6.1-sol'] }];
  const privateFixture = 'HOST-PRIVATE-REASONING-FIXTURE';
  const reply = () => new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [
    { type: 'reasoning', id: 'rs_private', encrypted_content: privateFixture },
    { type: 'message', id: 'msg_fixture', phase: 'final_answer', content: [{ type: 'output_text', text: 'offline answer' }] },
  ] } }) + '\n\n');
  const first = makeCtx();
  first.state.secrets.set('FIXTURE_CODEX_TOKEN', JSON.stringify({ access_token: token(1), chatgpt_account_id: 'fixture-workspace' }));
  const initial = await mountPool(first.ctx, { accounts: configured, refreshEnabled: false, fetchImpl: async () => reply() });
  let history, keyValue;
  try {
    assert.equal(first.state.secrets.size, 1, 'no eager replay key');
    const chunks = await drain(initial.adapter.stream({ model: 'gpt-6.1-sol', sessionId: 'host-continuity', messages: [{ role: 'user', content: 'offline' }] }));
    assert.ok(chunks.at(-1).replayState);
    assert.equal(JSON.stringify(chunks).includes(privateFixture), false);
    history = JSON.parse(JSON.stringify([{ role: 'assistant', content: chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block), source: { replayState: chunks.at(-1).replayState } }]));
    keyValue = first.state.secrets.get('DSH_ACCOUNT_POOL_CODEX_REPLAY_KEY_V1');
    assert.equal(Buffer.from(keyValue, 'base64url').length, 32);
    const status = await (await first.state.routes.find(row => row.path === ROUTES.accounts).fetch(new Request('http://127.0.0.1' + ROUTES.accounts))).json();
    assert.equal(status.codexContinuity.keyState, 'ready');
    assert.equal(JSON.stringify(status).includes(keyValue), false);
  } finally { await initial.dispose(); }
  const fresh = makeCtx({ medium: first.state.medium });
  for (const [ref, value] of first.state.secrets) fresh.state.secrets.set(ref, value);
  fresh.state.secrets.set('FIXTURE_CODEX_TOKEN', JSON.stringify({ access_token: token(2), chatgpt_account_id: 'fixture-workspace' }));
  let requested = false;
  const reopened = await mountPool(fresh.ctx, { accounts: configured, refreshEnabled: false, fetchImpl: async (url, init) => {
    const input = JSON.parse(init.body).input;
    assert.equal(input[0].encrypted_content, privateFixture); assert.equal(input[1].phase, 'final_answer'); requested = true;
    return reply();
  } });
  try {
    await drain(reopened.adapter.stream({ model: 'gpt-6.1-sol', sessionId: 'host-continuity', messages: history }));
    assert.equal(requested, true); assert.equal(fresh.state.secrets.get('DSH_ACCOUNT_POOL_CODEX_REPLAY_KEY_V1'), keyValue);
    assert.equal(fresh.state.secrets.size, 2, 'remount does not rotate/duplicate keys');
  } finally { await reopened.dispose(); }
});

await check('mount: corrupt replay key never rotates silently and diagnostics are redacted', async () => {
  const { ctx, state } = makeCtx();
  const ref = 'DSH_ACCOUNT_POOL_CODEX_REPLAY_KEY_V1';
  state.secrets.set(ref, 'INVALID-PRIVATE-KEY-FIXTURE');
  state.secrets.set('FIXTURE_CODEX', JSON.stringify({ access_token: 'opaque-offline', chatgpt_account_id: 'offline-workspace' }));
  const mounted = await mountPool(ctx, { refreshEnabled: false, accounts: [{ id: 'continuity', platform: 'openai', authMode: 'oauth', credentialRef: 'FIXTURE_CODEX', models: ['gpt-6.1-sol'] }],
    fetchImpl: async () => new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [
      { type: 'message', id: 'msg_fixture', content: [{ type: 'output_text', text: 'offline answer' }] },
    ] } }) + '\n\n'),
  });
  const readStatus = async () => (await (await state.routes.find(row => row.path === ROUTES.accounts).fetch(new Request('http://127.0.0.1' + ROUTES.accounts))).json()).codexContinuity;
  try {
    const opts = { model: 'gpt-6.1-sol', sessionId: 'key-failure', messages: [{ role: 'user', content: 'offline' }] };
    const failedKey = await drain(mounted.adapter.stream(opts));
    assert.equal(failedKey.at(-1).replayState, undefined); assert.equal((await readStatus()).keyState, 'unavailable');
    assert.equal(state.secrets.get(ref), 'INVALID-PRIVATE-KEY-FIXTURE');
    assert.equal(state.logs.warn.join('\n').includes('INVALID-PRIVATE-KEY-FIXTURE'), false);
    state.secrets.set(ref, Buffer.alloc(32, 4).toString('base64url')); // Explicit operator repair, not automatic overwrite.
    const retried = await drain(mounted.adapter.stream({ ...opts }));
    assert.ok(retried.at(-1).replayState); assert.equal((await readStatus()).keyState, 'ready');
  } finally { await mounted.dispose(); }
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
