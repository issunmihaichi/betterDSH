/**
 * Account-pool — Host half.
 *
 * Wiring only: this module owns no scheduling logic. It opens the durable
 * domain, hands the adapter a persist + usage sink, registers the `pool`
 * provider with the `llm` service, and exposes a read-only management surface
 * on the authenticated `/api` channel (the convention proven by the sibling
 * `dsh-usage-report` plugin in this profile).
 *
 * Two independent capabilities, each degrading honestly:
 *   - provider registration needs `llm` AND a configured upstream transport;
 *     without an upstream the pool mounts in MANAGEMENT-ONLY mode, because
 *     registering a provider that cannot reach anything would be worse than
 *     not registering one;
 *   - the management routes need `connection`.
 *
 * `apply` is async and returns the disposer — supported, see DESIGN.md §11.
 */
import { writeFileSync } from 'node:fs';

import { DEFAULT_PROVIDER, createPoolAdapter } from './adapter.js';
import { accountSchema, groupSchema, poolDomainSpec, usageSchema } from './domain.js';
import { ACCOUNT_ACTIONS, applyAccountAction } from './kernel.js';
import { decodeBundle, planImport } from './importer.js';
import { createHttpUpstream } from './upstream.js';

export const name = 'dsh-account-pool';

/**
 * Services this plugin needs. ALL THREE must be declared, and that is not
 * ceremony:
 *
 * Cordis resolves `ctx.get(name)` through an isolate map populated ONLY from a
 * plugin's own `inject` list (`fiber.ts` walks `inject` into `Context.intercept`,
 * and `_getImpl` then does `store[isolate[name]]`). This plugin is a SIBLING of
 * the rows that provide `connection` and `llm` under the profile's `include`,
 * and a sibling's service is invisible without a declaration. So an undeclared
 * `ctx.get('connection')` returns `undefined`: the fiber still activates, the
 * routes never register, and the page reports a bare HTTP 404 with nothing
 * anywhere saying why.
 *
 * That is exactly what happened in the live profile, and it is why the earlier
 * "read them softly and degrade gracefully" plan was wrong — a soft read still
 * requires the service to be REACHABLE. The runtime checks further down stay
 * (a service can exist yet lack a method); reachability is declared here.
 */
export const inject = ['storageDomain', 'llm', 'connection', 'timer', 'credentials'];

/** Account fields an operator may set from the management surface. */
export const EDITABLE_ACCOUNT_FIELDS = [
  'label', 'platform', 'baseUrl', 'credentialRef', 'groups',
  'priority', 'weight', 'loadFactor', 'concurrency', 'models', 'schedulable',
];

/** Group fields an operator may set. `id` is fixed once created — it is a route name. */
export const EDITABLE_GROUP_FIELDS = ['label', 'description', 'models'];

/** CRUD verbs the write route accepts, alongside the state actions. */
export const CRUD_ACTIONS = ['create', 'update', 'delete', 'import'];

/** Group verbs. Separate from account CRUD because they address a different table. */
export const GROUP_ACTIONS = ['group-create', 'group-update', 'group-delete'];

/**
 * Resolve one account's secret through the credentials service.
 *
 * A `CredentialRef` is an environment-variable-shaped name, so this also lets an
 * operator supply the key from the process environment instead of the UI. The
 * service contract requires re-resolution per call (never cached across
 * operations), which is what makes a rotated key take effect immediately.
 *
 * @returns the secret, or `undefined` while the reference is unconfigured.
 */
export async function resolveAccountCredential(credentials, account) {
  const ref = account?.credentialRef;
  if (typeof ref !== 'string' || ref === '') return undefined;
  if (typeof credentials?.resolve !== 'function') return undefined;
  const resolved = await credentials.resolve(ref);
  if (typeof resolved?.value !== 'string' || resolved.value === '') return undefined;
  // An imported account stores a BUNDLE (an OAuth object, or a lone key); the
  // transport needs a bearer either way.
  return decodeBundle(resolved.value);
}

/** The ref a UI-created account gets when the operator does not name one. */
export function defaultCredentialRef(accountId) {
  return `ACCOUNT_POOL_${String(accountId).toUpperCase().replaceAll(/[^A-Z0-9]+/g, '_')}`;
}

/**
 * Describe one account's credential for a configuration surface.
 *
 * Never returns the value — only whether something is configured, where it came
 * from, and whether this plugin may write it. `set`/`unset` reject while a
 * read-only source shadows the reference, and this is how the UI finds out
 * before offering an editor that would appear to succeed and then not take.
 */
export async function describeCredential(credentials, ref) {
  if (typeof ref !== 'string' || ref === '' || typeof credentials?.describe !== 'function') {
    return { configured: false, writable: false };
  }
  try {
    const info = await credentials.describe(ref);
    return {
      configured: info?.configured === true,
      source: typeof info?.source === 'string' ? info.source : undefined,
      writable: info?.writable === true,
    };
  } catch {
    return { configured: false, writable: false };
  }
}

/**
 * Store or clear one secret, then report the resulting state.
 *
 * @param value - the new secret, `undefined` to leave it alone, or `null`/`''` to clear it.
 * @throws when the store rejects — the caller writes the account row only after
 *   this succeeds, so a rejected secret never leaves a row pointing at nothing.
 */
export async function applyCredential(credentials, ref, value) {
  if (typeof ref !== 'string' || ref === '') return { configured: false, writable: false };
  if (value !== undefined && typeof credentials?.set === 'function') {
    if (value === null || value === '') await credentials.unset(ref);
    else await credentials.set(ref, String(value));
  }
  return describeCredential(credentials, ref);
}

/** Exact Fetch routes the management surface hangs (each must live under `/api`). */
export const ROUTES = {
  accounts: '/api/accountPool.accounts',
  usage: '/api/accountPool.usage',
  account: '/api/accountPool.account',
};

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

/** Fields a configured account may override on an existing row without losing runtime state. */
const STATIC_ACCOUNT_FIELDS = ['label', 'platform', 'baseUrl', 'priority', 'loadFactor', 'concurrency', 'models', 'schedulable'];

/**
 * Bring the domain in line with the plugin Config.
 *
 * Existing rows keep their runtime state (cooling windows, counters, lastUsedAt):
 * a restart must not clear a cooldown and send the pool straight back into a
 * rate-limited account. Only the operator-owned static fields are refreshed.
 *
 * @returns `{ inserted, refreshed }` counts.
 */
export function reconcileConfiguredAccounts(table, configured, now) {
  let inserted = 0;
  let refreshed = 0;

  for (const entry of configured ?? []) {
    const parsed = accountSchema.parse({ createdAt: now, updatedAt: now, ...entry });
    const existing = table.get(parsed.id);

    if (existing === undefined) {
      table.put(parsed.id, parsed);
      inserted += 1;
      continue;
    }

    const next = { ...existing };
    let changed = false;
    for (const field of STATIC_ACCOUNT_FIELDS) {
      if (!(field in parsed)) continue;
      if (JSON.stringify(next[field]) === JSON.stringify(parsed[field])) continue;
      next[field] = parsed[field];
      changed = true;
    }
    if (changed) {
      next.updatedAt = now;
      table.put(next.id, next);
      refreshed += 1;
    }
  }

  return { inserted, refreshed };
}

/**
 * Mount the pool against a Cordis context.
 *
 * Factored out of `apply` so tests can drive it with a fake context: the only
 * services touched are `storageDomain`, `llm`, `connection`, `logger` and the
 * optional `interval` timer helper.
 *
 * @param ctx - the plugin context.
 * @param options.accounts - account definitions from Config (reconciled at mount).
 * @param options.upstream - `{ stream(account, options) }`; omit for management-only.
 * @param options.clock - `{ now() }`; injectable for tests.
 * @param options.pruneIntervalMs - expired-binding sweep period.
 * @returns handles for inspection, test flushing, and disposal.
 */
/**
 * Open the pool domain, reclaiming the name if a previous fiber leaked it.
 *
 * The facility enforces one open handle per domain name, so a fiber that opened
 * the domain and then failed BEFORE its disposer was collected keeps the name
 * reserved for the life of the process — every subsequent mount then dies with
 * `domain 'account_pool' is already open`, which is what happened twice here.
 * `mountPool` now registers the release with `ctx.effect` immediately after
 * acquiring, so new leaks should not occur; this reclaim is what recovers a
 * process that already has one.
 */
export async function openDomain(ctx, log) {
  const facility = ctx.storageDomain;
  try {
    return await facility.open(poolDomainSpec);
  } catch (error) {
    const alreadyOpen = error?.code === 'already-open' || /is already open/.test(String(error?.message ?? ''));
    const stale = alreadyOpen ? facility.get?.(poolDomainSpec.name) : undefined;
    if (stale === undefined) throw error;
    log?.warn?.('account-pool: reclaiming the `%s` domain from a previous fiber that leaked it', poolDomainSpec.name);
    await stale.close();
    return await facility.open(poolDomainSpec);
  }
}

export async function mountPool(ctx, options = {}) {
  const log = ctx.logger;
  const clock = options.clock ?? { now: () => Date.now() };
  const now = () => new Date(clock.now()).toISOString();

  const domain = await openDomain(ctx, log);
  // Release the domain through the FIBER, registered before any other work.
  // Relying only on the value `apply` resolves with loses the handle whenever a
  // later step throws: the disposer is never collected, the name stays reserved,
  // and every reload after that fails with "already open". Closing is idempotent,
  // so this and `dispose()` may both run.
  ctx.effect(() => () => domain.close(), 'account-pool: domainClose');
  const accountsTable = domain.table('accounts');
  const groupsTable = domain.table('groups');
  const bindingsTable = domain.table('bindings');
  const usageTable = domain.table('usage');

  /** Writes started by the adapter are fire-and-forget; tests await them via flush(). */
  const pending = new Set();
  function track(promise) {
    const p = Promise.resolve(promise);
    pending.add(p);
    p.catch((error) => log?.warn?.('account-pool: persist failed: %s', String(error?.message ?? error)))
      .finally(() => pending.delete(p));
    return p;
  }
  async function flush() {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  }

  // --- config reconciliation -------------------------------------------------
  const { inserted, refreshed } = reconcileConfiguredAccounts(accountsTable, options.accounts, now());

  // --- usage sink -----------------------------------------------------------
  let usageSeq = 0;
  function recordUsage(payload) {
    const at = now();
    usageSeq += 1;
    const record = usageSchema.parse({
      id: `${at}-${String(usageSeq)}`,
      at,
      accountId: payload.accountId ?? '',
      sessionId: payload.sessionId ?? '',
      platform: payload.platform ?? '',
      model: payload.model ?? '',
      accountSwitches: payload.switches ?? 0,
      ok: payload.ok === true,
      errorCode: payload.errorCode ?? '',
      inputTokens: payload.usage?.inputTokens ?? 0,
      outputTokens: payload.usage?.outputTokens ?? 0,
      cacheReadTokens: payload.usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: payload.usage?.cacheWriteTokens ?? 0,
      reasoningTokens: payload.usage?.reasoningTokens ?? 0,
    });
    // The whole chain is tracked, so flush() also awaits the counter bump.
    return track((async () => {
      await usageTable.put(record.id, record);
      try {
        const global = domain.global.get();
        await domain.global.set({ ...global, totalRequests: (global?.totalRequests ?? 0) + 1 });
      } catch { /* the counter is advisory; a failed bump must not fail a request */ }
    })());
  }

  // --- upstream transport ---------------------------------------------------
  // Built HERE rather than from Config, because `cordis.patch.yml` cannot express
  // a transport object. This is what makes an account created from the management
  // surface actually usable: the account row carries only a `credentialRef`, and
  // the secret is resolved through the credentials service on every call.
  const credentials = ctx.get('credentials');
  const upstream = options.upstream ?? (credentials === undefined ? undefined : createHttpUpstream({
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    resolveCredential: (account) => resolveAccountCredential(credentials, account),
  }));

  // --- adapter --------------------------------------------------------------
  const adapter = createPoolAdapter({
    initialAccounts: [...accountsTable.entries()].map(([, value]) => value),
    initialBindings: [...bindingsTable.entries()].map(([, value]) => value),
    initialGroups: [...groupsTable.entries()].map(([, value]) => value),
    persist: {
      putAccount: (record) => track(accountsTable.put(record.id, record)),
      deleteAccount: (id) => track(accountsTable.delete(id)),
      putBinding: (record) => track(bindingsTable.put(record.sessionHash, record)),
      deleteBinding: (sessionHash) => track(bindingsTable.delete(sessionHash)),
      putGroup: (group) => track(groupsTable.put(group.id, group)),
      deleteGroup: (id) => track(groupsTable.delete(id)),
    },
    upstream,
    clock,
    onUsage: (payload) => { void recordUsage(payload); },
    onCooldown: (event) => log?.info?.('account-pool: %s -> %s on %s', event.account.id, event.decision.kind, event.account.platform),
  });

  // --- provider registration ------------------------------------------------
  // The default route is fixed: group routes are derived from it
  // (`pool-<groupId>`), so renaming it would have to rename them too.
  const providerRoute = DEFAULT_PROVIDER;
  const llm = ctx.get('llm');
  let unregisterAdapter;
  let adapterRegistered = false;

  /**
   * Re-declare the route table after a group change.
   *
   * `registerAdapter` returns a handle whose `replace(providers)` swaps the route
   * set WITHOUT re-registering the adapter — which is exactly what a group edit
   * needs, since the adapter instance is unchanged.
   */
  function refreshRoutes() {
    try {
      unregisterAdapter?.replace?.(adapter.routesFor());
    } catch (error) {
      log?.warn?.('account-pool: could not update the provider routes: %s', String(error?.message ?? error));
    }
  }

  if (upstream === undefined) {
    log?.warn?.('account-pool: no upstream transport available (the `credentials` service is missing); mounting in management-only mode (the `%s` provider is NOT registered)', providerRoute);
  } else if (llm === undefined || typeof llm.registerAdapter !== 'function') {
    log?.warn?.('account-pool: the `llm` service is unavailable; the `%s` provider is NOT registered', providerRoute);
  } else {
    // One route for the whole pool, plus one per group: a group becomes switchable
    // in the model provider list instead of being only a data field.
    unregisterAdapter = llm.registerAdapter(adapter.routesFor(), adapter);
    adapterRegistered = true;
    log?.info?.('account-pool: registered provider routes %s', adapter.routesFor().join(', '));
  }

  // Declare the route in the configurable-provider directory so it appears on the
  // Models page and can be selected like any other provider. `settingsNs` is the
  // Loader ENTRY ID (what the shipped DeepSeek providers use too) because that is
  // the settings document the Models card edits; `settingsPath: []` means the
  // whole document is the provider configuration.
  //
  // Gated on `adapterRegistered`: offering a selectable provider that cannot
  // reach anything is the same mistake as registering a broken adapter, just one
  // layer up in the UI.
  let unregisterProviders;
  const entryId = ctx.fiber?.entry?.options?.id;
  if (typeof llm?.registerConfigurableProviders === 'function') {
    if (adapterRegistered) {
      unregisterProviders = llm.registerConfigurableProviders([{
        provider: providerRoute,
        displayName: options.providerDisplayName ?? '号池',
        settingsNs: typeof entryId === 'string' && entryId !== '' ? entryId : 'account-pool',
        settingsPath: [],
      }]);
      log?.info?.('account-pool: declared `%s` in the configurable-provider directory', providerRoute);
    } else {
      log?.info?.('account-pool: `%s` is NOT declared in the provider directory while no upstream transport is configured', providerRoute);
    }
  }

  // --- management surface ---------------------------------------------------
  const routeDisposers = [];
  const connection = ctx.get('connection');
  if (connection?.fetch?.register !== undefined) {
    routeDisposers.push(connection.fetch.register({
      path: ROUTES.accounts,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method === 'HEAD') return new Response(null, { status: 200, headers: JSON_HEADERS });
        await flush();
        const records = adapter.listAccounts();
        // Each row gains a credential SUMMARY (configured / source / writable) and
        // never the secret: this response is what the page renders, so a value here
        // would be a value on screen and in the browser's memory.
        const withCredential = await Promise.all(records.map(async (record) => ({
          ...record,
          credential: await describeCredential(credentials, record.credentialRef),
        })));
        return json({
          totalRequests: domain.global.get()?.totalRequests ?? 0,
          counts: records.reduce((acc, record) => {
            acc[record.status] = (acc[record.status] ?? 0) + 1;
            return acc;
          }, {}),
          accounts: withCredential,
          bindings: adapter.listBindings(),
          // Groups come back with the accounts so one request paints the whole page,
          // and `routes` shows exactly which provider routes a group edit produced.
          groups: adapter.listGroups(),
          routes: adapter.routesFor(),
        });
      },
    }));

    routeDisposers.push(connection.fetch.register({
      path: ROUTES.usage,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method === 'HEAD') return new Response(null, { status: 200, headers: JSON_HEADERS });
        await flush();
        const requested = Number(new URL(request.url).searchParams.get('limit'));
        const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 500) : 100;
        const rows = [...usageTable.entries()].map(([, value]) => value)
          .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
          .slice(0, limit);
        return json({ limit, rows });
      },
    }));

    // The one WRITE route: operator actions on a single account. Deliberately
    // narrow — one account, one named action — so it cannot become a generic
    // "patch anything" surface reachable from a browser page.
    routeDisposers.push(connection.fetch.register({
      path: ROUTES.account,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body;
        try {
          body = await request.json();
        } catch {
          return json({ error: { code: 'invalid-json', message: 'expected a JSON body' } }, 400);
        }

        const action = typeof body?.action === 'string' ? body.action : '';
        const id = typeof body?.id === 'string' ? body.id.trim() : '';
        const allowed = [...ACCOUNT_ACTIONS, ...CRUD_ACTIONS, ...GROUP_ACTIONS];
        if (!allowed.includes(action)) {
          return json({ error: { code: 'unknown-action', message: `'${action}' is not one of ${allowed.join(', ')}` } }, 400);
        }
        // `import` addresses a whole document, and `group-create` carries its id in
        // the group body; neither is addressed by a top-level id.
        if (id === '' && action !== 'create' && action !== 'import' && action !== 'group-create') {
          return json({ error: { code: 'missing-id', message: '`id` is required' } }, 400);
        }

        try {
          /** Group ids an account names that do not exist. */
          function unknownGroupsFor(record) {
            return (record.groups ?? []).filter((groupId) => adapter.getGroup(groupId) === undefined);
          }

          // ---- groups -------------------------------------------------------
          if (action === 'group-create' || action === 'group-update') {
            const edits = body.group ?? {};
            const groupId = action === 'group-create' ? String(id !== '' ? id : edits.id ?? '').trim() : id;
            if (groupId === '') return json({ error: { code: 'missing-id', message: 'a group needs an id' } }, 400);

            const existing = adapter.getGroup(groupId);
            if (action === 'group-create' && existing !== undefined) {
              return json({ error: { code: 'group-exists', message: `group '${groupId}' already exists` } }, 409);
            }
            if (action === 'group-update' && existing === undefined) {
              return json({ error: { code: 'unknown-group', message: `no group '${groupId}'` } }, 404);
            }

            const merged = { ...(existing ?? {}), id: groupId };
            for (const field of EDITABLE_GROUP_FIELDS) {
              if (field in edits) merged[field] = edits[field];
            }
            merged.createdAt = existing?.createdAt ?? now();
            merged.updatedAt = now();

            const record = groupSchema.parse(merged);
            adapter.upsertGroup(record);
            await flush();
            // The route table is derived from the registry, so a new group has to
            // become selectable immediately rather than after a restart.
            refreshRoutes();
            log?.info?.('account-pool: %s %s', action, groupId);
            return json({ ok: true, action, group: adapter.getGroup(groupId), routes: adapter.routesFor() });
          }

          if (action === 'group-delete') {
            if (adapter.getGroup(id) === undefined) {
              return json({ error: { code: 'unknown-group', message: `no group '${id}'` } }, 404);
            }
            const detached = adapter.removeGroup(id);
            await flush();
            refreshRoutes();
            log?.info?.('account-pool: deleted group %s (detached from %d account(s))', id, detached.length);
            return json({ ok: true, action, id, detached, routes: adapter.routesFor() });
          }

          // ---- import (sub2api backup / CPA auth files) ---------------------
          if (action === 'import') {
            let document = body.document;
            if (typeof document === 'string') {
              try {
                document = JSON.parse(document);
              } catch {
                return json({ error: { code: 'invalid-json', message: 'the pasted text is not valid JSON' } }, 400);
              }
            }
            const plan = planImport(document, { existingIds: adapter.listAccounts().map((account) => account.id) });

            // An optional target group. A sub2api backup carries no grouping concept,
            // so membership is a choice made AT IMPORT TIME rather than a field parsed
            // out of the document.
            const targetGroup = typeof body.group === 'string' && body.group !== '' ? body.group : undefined;
            if (targetGroup !== undefined && adapter.getGroup(targetGroup) === undefined) {
              return json({ error: { code: 'unknown-group', message: `no group '${targetGroup}'` } }, 400);
            }

            const created = [];
            const errors = [...plan.errors];
            for (const entry of plan.created) {
              try {
                const record = accountSchema.parse({
                  createdAt: now(),
                  updatedAt: now(),
                  credentialRef: defaultCredentialRef(entry.id),
                  ...entry.draft,
                  ...(targetGroup === undefined ? {} : { groups: [targetGroup] }),
                  id: entry.id,
                });
                // Secret first, for the same reason as `create`: a rejected write
                // must not leave a row pointing at nothing.
                await applyCredential(credentials, record.credentialRef, entry.credential);
                adapter.upsertAccount(record);
                created.push(entry.id);
              } catch (error) {
                errors.push({ index: -1, reason: `${entry.id}: ${String(error?.message ?? error)}` });
              }
            }
            await flush();
            log?.info?.('account-pool: imported %d account(s) from a %s document', created.length, plan.format);
            return json({ ok: true, action, format: plan.format, created, errors, group: targetGroup ?? null });
          }

          // ---- create ------------------------------------------------------
          if (action === 'create') {
            const edits = body.account ?? {};
            const newId = id !== '' ? id : String(edits.id ?? '').trim();
            if (newId === '') return json({ error: { code: 'missing-id', message: 'a new account needs an id' } }, 400);
            if (adapter.getAccount(newId) !== undefined) {
              return json({ error: { code: 'account-exists', message: `account '${newId}' already exists` } }, 409);
            }
            const record = accountSchema.parse({
              createdAt: now(),
              updatedAt: now(),
              credentialRef: defaultCredentialRef(newId),
              ...edits,
              id: newId,
            });

            // A group id that does not exist would silently leave the account in NO
            // group — the same quiet fallback the adapter refuses at request time, so
            // it is refused at write time too.
            const unknownGroups = unknownGroupsFor(record);
            if (unknownGroups.length > 0) {
              return json({ error: { code: 'unknown-group', message: `account names unknown group(s): ${unknownGroups.join(', ')}` } }, 400);
            }
            // Secret first: if the store rejects it (a read-only source shadows the
            // reference), the account row is never written and nothing dangles.
            const credential = await applyCredential(credentials, record.credentialRef, body.credential);
            adapter.upsertAccount(record);
            await flush();
            log?.info?.('account-pool: created account %s', newId);
            return json({ ok: true, action, account: adapter.getAccount(newId), credential });
          }

          const current = adapter.getAccount(id);
          if (current === undefined) return json({ error: { code: 'unknown-account', message: `no account '${id}'` } }, 404);

          // ---- delete ------------------------------------------------------
          if (action === 'delete') {
            adapter.removeAccount(id);
            await applyCredential(credentials, current.credentialRef, null);
            await flush();
            log?.info?.('account-pool: deleted account %s', id);
            return json({ ok: true, action, id });
          }

          // ---- update (operator-owned fields only) --------------------------
          if (action === 'update') {
            const edits = body.account ?? {};
            const merged = { ...current };
            for (const field of EDITABLE_ACCOUNT_FIELDS) {
              if (field in edits) merged[field] = edits[field];
            }
            merged.updatedAt = now();
            const record = accountSchema.parse(merged);

            const unknownGroups = unknownGroupsFor(record);
            if (unknownGroups.length > 0) {
              return json({ error: { code: 'unknown-group', message: `account names unknown group(s): ${unknownGroups.join(', ')}` } }, 400);
            }
            const credential = await applyCredential(credentials, record.credentialRef, body.credential);
            adapter.upsertAccount(record);
            await flush();
            log?.info?.('account-pool: updated account %s', id);
            return json({ ok: true, action, account: adapter.getAccount(id), credential });
          }

          // ---- state actions ------------------------------------------------
          const next = applyAccountAction(current, action, {
            now: clock.now(),
            allAccounts: adapter.listAccounts(),
            priority: body?.priority,
          });
          adapter.upsertAccount(next);
          await flush();
          log?.info?.('account-pool: %s applied to %s', action, id);
          return json({ ok: true, action, account: adapter.getAccount(id) });
        } catch (error) {
          const code = error instanceof RangeError ? 'invalid-argument'
            : error?.name === 'ZodError' ? 'invalid-account'
              : 'action-failed';
          log?.warn?.('account-pool: %s on %s failed: %s', action, id === '' ? '(new)' : id, String(error?.message ?? error));
          return json({ error: { code, message: String(error?.message ?? error) } }, 400);
        }
      },
    }));
  } else {
    log?.warn?.('account-pool: the `connection` service is unavailable; the management routes are NOT registered');
  }

  // --- expiry sweep ---------------------------------------------------------
  // `ctx.interval` is a SERVICE ACCESSOR, not a plain property. Reading it
  // without `timer` in `inject` THROWS ("cannot get property \"timer\" without
  // inject") instead of returning undefined — which aborted the whole mount
  // AFTER the domain had been opened, leaking it and registering no routes. That
  // one line is what produced a bare HTTP 404 on an otherwise healthy page.
  // `timer` is therefore declared, and the access is wrapped anyway so a missing
  // timer costs the sweep rather than the entire plugin.
  let stopPrune;
  try {
    if (typeof ctx.interval === 'function') {
      stopPrune = ctx.interval(() => adapter.pruneBindings(), options.pruneIntervalMs ?? 60_000);
    }
  } catch (error) {
    log?.warn?.('account-pool: the timer service is unavailable; the expiry sweep is disabled: %s', String(error?.message ?? error));
  }

  // --- self-diagnosis -------------------------------------------------------
  // An undeclared service is simply invisible (see the `inject` note at the top),
  // and the only symptom is a bare HTTP 404 on a page that otherwise renders
  // fine. Dumping what actually resolved turns that into a readable cause.
  if (typeof options.statusDumpPath === 'string' && options.statusDumpPath !== '') {
    const status = {
      at: now(),
      entryId: typeof entryId === 'string' && entryId !== '' ? entryId : null,
      providerRoute,
      upstreamConfigured: upstream !== undefined,
      capabilities: {
        storageDomain: true,
        llm: llm !== undefined,
        connection: connection !== undefined,
        timer: typeof ctx.interval === 'function',
      },
      registered: {
        adapter: adapterRegistered,
        providerDeclared: unregisterProviders !== undefined,
        routes: routeDisposers.length,
      },
      accounts: { inserted, refreshed, total: adapter.listAccounts().length },
    };
    try {
      writeFileSync(options.statusDumpPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('account-pool: could not write the status dump: %s', String(error?.message ?? error));
    }
  }

  let disposed = false;
  async function dispose() {
    if (disposed) return;
    disposed = true;
    try { stopPrune?.(); } catch { /* already stopped */ }
    for (const disposeRoute of [...routeDisposers].reverse()) {
      try { await disposeRoute(); } catch { /* the fiber also unwinds these */ }
    }
    try { unregisterAdapter?.(); } catch { /* the fiber also unwinds this */ }
    try { unregisterProviders?.(); } catch { /* the fiber also unwinds this */ }
    await flush().catch(() => {});
    await domain.close();
  }

  return { domain, adapter, adapterRegistered, providerRoute, inserted, refreshed, flush, dispose };
}

/**
 * Cordis entry point. Returning the disposer is the supported async-apply shape
 * (DESIGN.md §11): the resolved value is collected as this fiber's teardown.
 */
export async function apply(ctx, config = {}) {
  const mounted = await mountPool(ctx, config);
  return () => mounted.dispose();
}

export default { name, inject, apply };
