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
import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { writeFileSync } from 'node:fs';

import z from '@deepseek-ai/schemastery';

import { DEFAULT_PROVIDER, POOL_DEFAULT_MAX_TOKENS, createPoolAdapter, priorityKey } from './adapter.js';
import { PLATFORMS, accountSchema, groupSchema, poolDomainSpec, usageSchema } from './domain.js';
import { normalizeUsageTiming } from './usage-timing.js';
import { ACCOUNT_ACTIONS, DURATIONS, applyAccountAction } from './kernel.js';
import { METADATA_ACCOUNT_FIELDS, METADATA_FORMAT, decodeBundle, planImport, planMetadataImport, slugifyId } from './importer.js';
import { base64url } from './oauth/pkce.js';
import {
  CALLBACK_PATH, PROVIDERS, callbackRedirectUri, createCallbackServer, createFlowStore,
  createOAuthEngine, describeProviders, readCallbackParams, refreshAccountCredential,
} from './oauth.js';
import { createHttpUpstream } from './upstream.js';
import { loadCodexReplayCodec } from './native/codex-replay.js';
import { createCodexAttributionDiagnostics } from './native/codex-attribution.js';
import { createCompactionHistoryResolver, installCodexCompactionBridge, isCodexCompactionTarget } from './codex-compaction-bridge.js';
import { expandCodexCompactionMessages, hasCodexCompaction } from './native/codex-compaction.js';
import { createQuotaService, quotaConnectionKey } from './quota.js';
import { isResetRequestId, supportsResetCredits } from './reset-credits.js';
import { parseBundle } from './oauth/refresh.js';
import { planSupplier, discoverSupplierModels, SupplierError } from './supplier.js';
import { discoverGroupModels, GroupModelsError } from './group-models.js';

export const name = 'dsh-account-pool';

/** Shared default label for the Models directory and provider picker. */
export const PROVIDER_LABEL = '号池';

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
export const inject = ['storageDomain', 'llm', 'connection', 'timer', 'credentials', 'attachments', 'sessions', 'sessionProjections'];

/**
 * The plugin's own settings document — and the reason the pool can appear in the
 * Models page's provider list at all.
 *
 * A configurable-provider row is drawn only when its `settingsNs` resolves to a
 * settings NAMESPACE, and a namespace exists only when the Loader entry exports
 * `Config`: the store marks such a row unconfigured (`refs/ui-settings-models.client.js:1035`)
 * and the list then drops it (`:2127-2129`, `if (namespace === void 0) return null`).
 * Without this export the `pool` route was registered, selectable in the
 * composer, declared in the directory — and invisible in the list, which is
 * exactly "the pool is registered but cannot be bound there".
 *
 * Only the YAML-expressible keys are declared. Schemastery KEEPS keys a schema
 * does not mention (measured against 3.18.4, the version DSH ships), so an
 * existing config survives resolution untouched; `accounts` is deliberately
 * `z.array(z.any())` — its shape is owned by the domain schema in lib/domain.js,
 * and re-declaring it here would be a second source of truth.
 */
export const Config = z.object({
  statusDumpPath: z.string()
    .description('挂载时把实际解析结果写成 JSON 的路径（页面报 404 时用它排查）'),
  providerDisplayName: z.string().default(PROVIDER_LABEL).volatile()
    .description('「模型」页里这条 provider 显示的名字，默认「号池」'),
  pruneIntervalMs: z.natural()
    .description('过期粘性绑定的清扫周期（毫秒，默认 60000）'),
  oauthFlowTtlMs: z.natural()
    .description('一次已开始未完成的登录可以保留多久（毫秒，默认 15 分钟）'),
  oauthMaxFlows: z.natural()
    .description('同时保留的登录流程上限（默认 8）'),
  oauthCallbackPort: z.natural()
    .description('本地回调监听端口；留空用提供商自己的端口'),
  oauthCallbackPath: z.string()
    .description('本地回调路径，必须以 / 开头'),
  oauthCallbackHost: z.string()
    .description('回调 URL 里的主机名写法：localhost 或 127.0.0.1'),
  refreshEnabled: z.boolean()
    .description('关掉后不再向上游刷新凭据'),
  requestRetries: z.natural().max(5)
    .description('临时断流/5xx 在同账号上的重试次数，默认 3，0 为关闭；只在尚未输出时重试'),
  requestRetryDelayMs: z.natural().min(100).max(10000)
    .description('临时请求重试的初始等待毫秒数，默认 1000，后续指数退避'),
  requestRetryMaxDelayMs: z.natural().min(100).max(30000)
    .description('临时请求重试等待上限毫秒数，默认 8000'),
  accounts: z.array(z.any())
    .description('账号定义；字段形状由 lib/domain.js 的 schema 决定，这里不重复声明'),
  defaultContextWindow: z.natural().min(1).default(200_000).volatile()
    .description('账号池模型的默认上下文窗口，模型独立覆盖优先'),
  providers: z.dict(z.object({
    modelOverrides: z.dict(z.object({
      name: z.string(),
      contextWindow: z.natural().min(1),
      input: z.array(z.union(['text', 'image'])).default(undefined),
      reasoningEfforts: z.union([
        z.const(false),
        z.dict(z.union([z.string(), z.const(null)]), z.union(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])),
      ]),
    })).default({}),
  })).default({}).volatile()
    .description('按分组提供商和模型 ID 保存的能力覆盖，不改变账号或分组模型白名单'),
  models: z.array(z.string())
    .description('号池对外提供的模型 id；留空则用账号与分组自己声明的清单（都为「全部」时这里必须有值，否则选择器里选不到模型）'),
});

/** Account fields an operator may set from the management surface. */
export const EDITABLE_ACCOUNT_FIELDS = [
  'label', 'notes', 'platform', 'baseUrl', 'openaiApi', 'openaiTransport', 'credentialRef', 'projectId', 'chatgptAccountId', 'groups',
  'priority', 'weight', 'loadFactor', 'concurrency', 'models', 'schedulable',
  'expiresAt', 'autoPauseOnExpired',
  'poolDetectionRetry', 'poolDetectionRetries', 'poolDetectionRetryDelayMs', 'poolDetectionKeywords',
  // Claude Code mode. `authMode` is a FACT about the credential (bearer vs key) and
  // `mimicry` is the opt-in disguise; the three `mimicry*` fields pin values that
  // are otherwise derived. All operator-owned, so `update` may set them.
  'authMode', 'mimicry', 'mimicryClientId', 'mimicryAccountUuid', 'mimicryCliVersion',
  // Extra `anthropic-beta` tokens this account's upstream demands (see
  // `CONTEXT_1M_BETA` in lib/claude-code/constants.js). Operator-owned like the
  // mimicry pins above, so the management surface may set it too.
  'betas',
];

/** Group fields an operator may set. `id` is fixed once created — it is a route name. */
export const EDITABLE_GROUP_FIELDS = ['label', 'description', 'enabled', 'models', 'selectionMode'];

/** CRUD verbs the write route accepts, alongside the state actions. */
export const CRUD_ACTIONS = ['create', 'update', 'delete', 'import'];

/** Group verbs. Separate from account CRUD because they address a different table. */
export const GROUP_ACTIONS = ['group-create', 'group-update', 'group-delete'];

/** Per (account, group) priority verbs — the relation sub2api keeps in `account_groups`. */
export const PRIORITY_ACTIONS = ['priority-set', 'priority-clear'];

/** One action that addresses MANY accounts. The verb decides what happens to each. */
export const BATCH_ACTIONS = ['batch'];
export const MANAGEMENT_ACTIONS = ['test', 'quota', 'quota-reset', 'export'];

/** Bulk edits exclude identity, credentials and upstream connection settings. */
export const BATCH_EDITABLE_ACCOUNT_FIELDS = [
  'label', 'notes', 'groups', 'priority', 'weight', 'loadFactor', 'concurrency',
  'models', 'schedulable', 'expiresAt', 'autoPauseOnExpired',
];

/** Explicit allow-list: never export credential handles, endpoint URLs or errors. */
export const EXPORT_ACCOUNT_FIELDS = METADATA_ACCOUNT_FIELDS;

export function exportAccountMetadata({ accounts, groups, priorities, exportedAt }) {
  const pick = (record, fields) => Object.fromEntries(fields
    .filter((field) => field in record).map((field) => [field, record[field]]));
  const selected = new Set(accounts.map((record) => record.id));
  return {
    format: 'dsh-account-pool-metadata', version: 1, exportedAt,
    accounts: accounts.map((record) => pick(record, EXPORT_ACCOUNT_FIELDS)),
    groups: groups.map((record) => pick(record, ['id', 'label', 'description', 'enabled', 'models', 'selectionMode', 'createdAt', 'updatedAt'])),
    priorities: priorities.filter((record) => selected.has(record.accountId))
      .map((record) => pick(record, ['accountId', 'groupId', 'priority', 'updatedAt'])),
  };
}

/**
 * OAuth login verbs — the interactive sign-in flow, not CRUD.
 *
 * They are separate from `CRUD_ACTIONS` because they address a FLOW rather than
 * an account: `oauth-start` hands back an authorization URL, `oauth-finish`
 * redeems the code the operator pasted, and `oauth-status` is what the page polls
 * while the browser is away at the vendor.
 */
export const OAUTH_ACTIONS = ['oauth-start', 'oauth-finish', 'oauth-status', 'oauth-cancel', 'oauth-check'];

/**
 * The OAuth providers this pool can log into, as the page's picker sees them.
 *
 * Only providers whose platform is an account platform the domain accepts: a
 * provider for a platform this pool cannot store would produce an account row
 * that fails validation at the last step of a successful login.
 */
export function oauthProvidersFor(platforms) {
  const allowed = new Set(platforms);
  return describeProviders().filter((provider) => allowed.has(provider.platform));
}

/**
 * Resolve one account's secret through the credentials service.
 *
 * A `CredentialRef` is an environment-variable-shaped name, so this also lets an
 * operator supply the key from the process environment instead of the UI. The
 * service contract requires re-resolution per call (never cached across
 * operations), which is what makes a rotated key take effect immediately.
 *
 * OAuth accounts go through `refreshAccountCredential`: an access token from a
 * login expires in hours, so a resolver that only reads would hand the transport
 * a dead bearer by the same evening. That function refreshes when the stored
 * `expires_at` says it is due, persists the rotated token, and falls back to the
 * stale one on failure — because the upstream's own 401 is a better diagnostic
 * than anything this layer could invent.
 *
 * @returns the secret, or `undefined` while the reference is unconfigured.
 */
export async function resolveAccountCredential(credentials, account, options = {}) {
  const ref = account?.credentialRef;
  if (typeof ref !== 'string' || ref === '') return undefined;
  if (typeof credentials?.resolve !== 'function') return undefined;

  // OAuth bundles carry the expiry and the refresh token, so they take the
  // refresh path. It returns a BARE BEARER for a bundle it owns (refreshing it
  // first when due) and `undefined` for anything it does not own — a platform it
  // has no refresher for, or an unconfigured reference — in which case the plain
  // read below is the only thing that can still produce an answer.
  if (options.refreshEnabled !== false) {
    const refreshed = await refreshAccountCredential({
      credentials,
      credentialRef: ref,
      platform: account?.platform,
      fetchImpl: options.fetchImpl ?? globalThis.fetch,
      clock: options.clock ?? { now: () => Date.now() },
      inFlight: options.inFlight,
      returnBundle: options.returnBundle === true,
      onWarn: options.onWarn,
    }).catch(() => undefined);
    if (typeof refreshed === 'string' && refreshed !== '') return refreshed;
    if (options.returnBundle === true && refreshed !== null && typeof refreshed === 'object') return refreshed;
  }

  const resolved = await credentials.resolve(ref);
  if (typeof resolved?.value !== 'string' || resolved.value === '') return undefined;
  // An imported account stores a BUNDLE (an OAuth object, or a lone key); the
  // transport needs a bearer either way.
  if (options.returnBundle === true) {
    const bundle = parseBundle(resolved.value);
    if (bundle !== undefined) return { ...bundle, access_token: decodeBundle(resolved.value) };
  }
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
  oauth: '/api/accountPool.oauth',
};

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

/** Fields a configured account may override on an existing row without losing runtime state. */
/**
 * Config is a seed for missing accounts, not a second management database.
 * Once persisted, every field (including credentials and management metadata)
 * is owned by the management API and survives restarts. Keep the refreshed
 * count for compatibility with status dumps; it is always zero.
 */
export function reconcileConfiguredAccounts(table, configured, now) {
  let inserted = 0;
  for (const entry of configured ?? []) {
    // Do not even parse defaults for an existing row: an edited management
    // account wins over stale configuration, including connection settings.
    if (table.get(entry?.id) !== undefined) continue;
    const parsed = accountSchema.parse({ createdAt: now, updatedAt: now, ...entry });
    table.put(parsed.id, parsed);
    inserted += 1;
  }
  return { inserted, refreshed: 0 };
}

/**
 * Mount the pool against a Cordis context.
 *
 * Factored out of `apply` so tests can drive it with a fake context: the only
 * services touched are `storageDomain`, `llm`, `connection`, `logger` and the
 * optional `interval` timer helper.
 *
 * @param ctx - the plugin context.
 * @param options.accounts - account definitions from Config (seed missing ids at mount).
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
  const prioritiesTable = domain.table('priorities');
  const bindingsTable = domain.table('bindings');
  const usageTable = domain.table('usage');

  /** Background adapter writes remain best-effort, while each management request
   * owns an exact promise ledger. Keep rejected promises in that ledger even if
   * they settled before flush; unrelated stream telemetry must not fail a save.
   */
  const operationWrites = new AsyncLocalStorage();
  const pending = new Set();
  function track(promise) {
    const p = Promise.resolve(promise);
    pending.add(p);
    operationWrites.getStore()?.push(p);
    p.catch((error) => log?.warn?.('account-pool: persist failed: %s', String(error?.message ?? error)))
      .finally(() => pending.delete(p));
    return p;
  }
  async function flush() {
    const writes = operationWrites.getStore();
    if (writes) {
      while (writes.length > 0) {
        const results = await Promise.allSettled(writes.splice(0));
        if (results.some(result => result.status === 'rejected')) {
          throw Object.assign(new Error('持久化失败；运行时状态可能已改变，请重试，未保存内容重启后可能丢失。'), { code: 'persist-failed' });
        }
      }
      return;
    }
    while (pending.size > 0) await Promise.allSettled([...pending]);
  }

  // --- config reconciliation -------------------------------------------------
  const { inserted, refreshed } = reconcileConfiguredAccounts(accountsTable, options.accounts, now());

  // Serialize singleton updates so background usage cannot overwrite a setting
  // saved while its telemetry write was awaiting persistence.
  let globalWrites = Promise.resolve();
  function updateGlobal(update) {
    const write = globalWrites.then(() => domain.global.set(update(domain.global.get())));
    globalWrites = write.catch(() => {});
    return write;
  }
  const encryptedCompactionEnabled = () => domain.global.get()?.codexEncryptedCompactionV2 === true;
  const resolveCompactionHistory = createCompactionHistoryResolver(id => ctx.get('sessions')?.get?.(id));
  const compactionBridgeDisposers = new Set();
  let compactionBridgeAvailable = false;

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
      reasoningEffort: payload.reasoningEffort ?? null,
      mappedReasoningEffort: payload.mappedReasoningEffort ?? null,
      accountSwitches: payload.switches ?? 0,
      ok: payload.ok === true,
      errorCode: payload.errorCode ?? '',
      inputTokens: payload.usage?.inputTokens ?? 0,
      outputTokens: payload.usage?.outputTokens ?? 0,
      cacheReadTokens: payload.usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: payload.usage?.cacheWriteTokens ?? 0,
      reasoningTokens: payload.usage?.reasoningTokens ?? 0,
      ...normalizeUsageTiming(payload),
    });
    // The whole chain is tracked, so flush() also awaits the counter bump.
    return track((async () => {
      await usageTable.put(record.id, record);
      try {
        await updateGlobal(global => ({ ...global, totalRequests: (global?.totalRequests ?? 0) + 1 }));
      } catch { /* the counter is advisory; a failed bump must not fail a request */ }
    })());
  }

  // --- upstream transport ---------------------------------------------------
  // Built HERE rather than from Config, because `cordis.patch.yml` cannot express
  // a transport object. This is what makes an account created from the management
  // surface actually usable: the account row carries only a `credentialRef`, and
  // the secret is resolved through the credentials service on every call.
  const credentials = ctx.get('credentials');
  /**
   * One in-flight refresh per (credential, platform). Shared for the life of the
   * plugin, because its whole job is to stop N concurrent requests from opening N
   * token requests and from overwriting each other's rotated refresh token.
   */
  const refreshInFlight = new Map();
  // The optional review companion must never become a mount dependency for the
  // account pool. A child injection makes a sibling's service reachable without
  // blocking ordinary Codex traffic when the companion is absent/default-off.
  let reviewAttributionBridge;
  ctx.inject?.(['codexReviewAttribution'], (child) => {
    const bridge = child.get('codexReviewAttribution');
    reviewAttributionBridge = bridge;
    child.effect(() => () => {
      if (reviewAttributionBridge === bridge) reviewAttributionBridge = undefined;
    }, 'account-pool: reviewAttributionDetach');
  });
  // Observe actual HTTP/WS dispatch attempts, not estimated billing or inferred prompt purposes.
  // No account/session/model identifiers or request text enter these fixed-size counters.
  const codexDispatchDiagnostics = createCodexAttributionDiagnostics({
    now: () => clock.now(),
    enabled: options.upstream === undefined && credentials !== undefined,
    onUnknown: (reason) => log?.warn?.(`account-pool: Codex request has no verified thread_source (${reason}); check codexAttributionDispatch, not prompt text`),
  });
  function codexAttributionDiagnostics() {
    let review = null;
    let reviewBridgeStatus = 'not-installed';
    if (reviewAttributionBridge != null) {
      reviewBridgeStatus = 'disabled-unavailable';
      // Diagnostics from an optional sibling must not break account management or
      // mount-time status dumps. Treat its API, version and getters as fallible.
      try {
        const snapshot = reviewAttributionBridge.snapshot;
        if (typeof snapshot === 'function') {
          const bridge = snapshot.call(reviewAttributionBridge);
          if (bridge && typeof bridge.then === 'function') {
            // The contract is synchronous; also observe an accidental async rejection.
            Promise.resolve(bridge).catch(() => {});
          } else if (bridge && typeof bridge === 'object' && !Array.isArray(bridge)) {
            if (bridge.version !== 1) reviewBridgeStatus = 'disabled-incompatible';
            else {
              // Capture getters once: validation and publication must use the same values.
              const { compatible, augmentationEnabled, augmentedRequests, missingProvenance } = bridge;
              if (typeof compatible === 'boolean' && typeof augmentationEnabled === 'boolean') {
                const active = compatible && augmentationEnabled;
                review = {
                  version: 1,
                  compatible,
                  augmentationEnabled: active,
                  augmentedRequests: Number.isSafeInteger(augmentedRequests) && augmentedRequests >= 0 ? augmentedRequests : 0,
                  missingProvenance: Number.isSafeInteger(missingProvenance) && missingProvenance >= 0 ? missingProvenance : 0,
                };
                reviewBridgeStatus = active ? 'enabled' : compatible ? 'disabled' : 'disabled-incompatible';
              }
            }
          }
        }
      } catch { /* Only fixed, non-sensitive capability states cross the API. */ }
    }
    return {
      sessions: typeof ctx.get('sessions')?.get === 'function',
      turns: typeof ctx.get('sessionProjections')?.stateOf === 'function',
      officialSessionHeaders: true,
      requestLocalMetadata: true,
      reviewBridge: review?.augmentationEnabled === true,
      reviewBridgeStatus,
      review,
      // Client capabilities are not evidence of OpenAI's final analytics bucket.
      officialAnalyticsVerified: false,
    };
  }
  // Session replay is durable, but the sync API is not a secret channel. Keep an
  // independent AEAD key in the existing credential service, created lazily only
  // when the Codex transport is actually used. Never derive it from OAuth tokens.
  let replayCodecPromise;
  const codexReplayStatus = { mode: 'session-aead-v1', keyState: credentials ? 'not-loaded' : 'unavailable' };
  function resolveCodexReplayCodec() {
    if (!replayCodecPromise) {
      replayCodecPromise = loadCodexReplayCodec(credentials).then(codec => {
        codexReplayStatus.keyState = 'ready';
        return codec;
      }).catch(() => {
        codexReplayStatus.keyState = 'unavailable';
        replayCodecPromise = undefined;
        log?.warn?.('account-pool: Codex durable replay is unavailable; credential key could not be loaded');
        // Do not make unrelated accounts unavailable. This request keeps neutral
        // history; the explicit capability state reports the degraded feature.
        return undefined;
      });
    }
    return replayCodecPromise;
  }
  const upstream = options.upstream ?? (credentials === undefined ? undefined : createHttpUpstream({
    resolveCodexReplayCodec,
    resolveCodexEncryptedCompaction: encryptedCompactionEnabled,
    resolveCompactionHistory,
    onCodexRequest: summary => codexDispatchDiagnostics.record(summary),
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    webSocketImpl: options.webSocketImpl,
    webSocketConnectTimeoutMs: options.webSocketConnectTimeoutMs,
    webSocketIdleTimeoutMs: options.webSocketIdleTimeoutMs,
    codexWebSocketSessionIdleMs: options.codexWebSocketSessionIdleMs,
    codexWebSocketMaxSessions: options.codexWebSocketMaxSessions,
    // The same ceiling the models declare, so a direct `stream()` call (management
    // tooling, probes) budgets like a real DSH turn instead of at the transport's
    // much smaller 4096 fallback.
    defaultMaxTokens: POOL_DEFAULT_MAX_TOKENS,
    resolveAttachments: () => ctx.get('attachments'),
    resolveCodexSession: (sessionId) => {
      const sessions = ctx.get('sessions');
      if (typeof sessions?.get !== 'function') return { known: false, missingSourceReason: 'session-service-unavailable' };
      const session = sessions.get(sessionId);
      if (!session) return { known: false, missingSourceReason: 'session-not-found' };
      const header = session.header;
      const boundary = ctx.get('sessionProjections')?.stateOf?.(session, 'turnBoundary');
      const origin = header?.origin;
      let rootSessionId = sessionId;
      let current = session;
      const seen = new Set([sessionId]);
      // Ordinary forks are independent tasks, not collaboration parents. Missing
      // ancestors and cycles terminate without inventing parent turn identities.
      for (let depth = 0; depth < 64 && current?.header?.origin === 'subagent'; depth++) {
        const parent = current.header.parentSession;
        if (typeof parent !== 'string' || !parent || seen.has(parent)) break;
        seen.add(parent);
        rootSessionId = parent;
        current = sessions.get(parent);
      }
      return {
        known: true, origin, rootSessionId,
        ...(origin === 'subagent' && typeof header.parentSession === 'string' && header.parentSession !== sessionId ? { parentSessionId: header.parentSession } : {}),
        ...(boundary?.openTurnStartSeq != null && Number.isSafeInteger(boundary.lastTurn) && boundary.lastTurn > 0
          ? { turnId: `${sessionId}:turn:${boundary.lastTurn}:${boundary.openTurnStartSeq}` } : {}),
      };
    },
    resolveCredential: (account) => resolveAccountCredential(credentials, account, {
      fetchImpl: options.fetchImpl ?? globalThis.fetch,
      clock,
      inFlight: refreshInFlight,
      refreshEnabled: options.refreshEnabled,
      returnBundle: true,
      onWarn: (message) => log?.warn?.(message),
    }),
  }));

  const quotaService = createQuotaService({
    fetchImpl: options.fetchImpl ?? globalThis.fetch, clock,
    ttlMs: options.quotaTtlMs, timeoutMs: options.quotaTimeoutMs,
    ensureGeminiProject: options.ensureGeminiProject,
    resolveCredential: (account, quotaOptions) => resolveAccountCredential(credentials, account, {
      ...quotaOptions, clock, inFlight: refreshInFlight, returnBundle: true,
      refreshEnabled: options.refreshEnabled,
      onWarn: (message) => log?.warn?.(message),
    }),
  });
  ctx.effect(() => () => quotaService.dispose(), 'account-pool: quotaClose');
  const resetActions = new Map();
  function writeCredential(ref, value) {
    if (value !== undefined) quotaService.invalidateCredential(ref);
    return applyCredential(credentials, ref, value);
  }

  // --- adapter --------------------------------------------------------------
  // Config resolution wraps volatile keys; direct test/tool mounts may pass a plain string.
  const providerLabel = () => {
    const value = options.providerDisplayName;
    return (typeof value?.get === 'function' ? value.get() : value) ?? PROVIDER_LABEL;
  };
  const liveValue = (value) => typeof value?.get === 'function' ? value.get() : value;
  const liveModelOverrides = (route) => {
    const providers = liveValue(options.providers);
    const profile = providers && typeof providers === 'object' && Object.hasOwn(providers, route) ? providers[route] : undefined;
    return liveValue(profile?.modelOverrides) ?? {};
  };
  let resetSyncCapture = null;
  const adapter = createPoolAdapter({
    initialAccounts: [...accountsTable.entries()].map(([, value]) => value),
    initialBindings: [...bindingsTable.entries()].map(([, value]) => value),
    initialGroups: [...groupsTable.entries()].map(([, value]) => value),
    // Keyed by `accountId|groupId`, exactly as the table is keyed.
    initialPriorities: [...prioritiesTable.entries()].map(([, value]) => value),
    persist: {
      putAccount: (record) => {
        const previous = accountsTable.get(record.id);
        if (previous !== undefined && quotaConnectionKey(previous) !== quotaConnectionKey(record)) quotaService.invalidate(record.id);
        let write;
        try { write = track(accountsTable.put(record.id, record)); }
        catch (error) { write = track(Promise.reject(error)); }
        if (resetSyncCapture?.accountId === record.id) resetSyncCapture.promise = write;
        return write;
      },
      deleteAccount: (id) => { quotaService.invalidate(id); return track(accountsTable.delete(id)); },
      putBinding: (record) => track(bindingsTable.put(record.sessionHash, record)),
      deleteBinding: (sessionHash) => track(bindingsTable.delete(sessionHash)),
      putGroup: (group) => track(groupsTable.put(group.id, group)),
      deleteGroup: (id) => track(groupsTable.delete(id)),
      putPriority: (entry) => track(prioritiesTable.put(priorityKey(entry.accountId, entry.groupId), entry)),
      deletePriority: (key) => track(prioritiesTable.delete(key)),
    },
    upstream,
    clock,
    requestRetries: options.requestRetries,
    requestRetryDelayMs: options.requestRetryDelayMs,
    requestRetryMaxDelayMs: options.requestRetryMaxDelayMs,
    onRetry: (event) => log?.info?.('account-pool: %s request retry %s/%s after %sms', event.account.id, event.retry, event.maxRetries, event.delayMs),
    providerName: DEFAULT_PROVIDER,
    providerDisplayName: providerLabel(),
    // The picker lists what the adapter advertises, so a pool whose accounts all
    // say "any model" needs this list to be selectable at all.
    models: Array.isArray(options.models) ? [...options.models] : [],
    modelOverridesFor: liveModelOverrides,
    contextWindowFor: () => liveValue(options.defaultContextWindow) ?? 200_000,
    onUsage: (payload) => { void recordUsage(payload); },
    onCooldown: (event) => log?.info?.('account-pool: %s -> %s on %s', event.account.id, event.decision.kind, event.account.platform),
  });

  // Optional Host-only integration for fixed-account behavioral attribution.
  // The detector owns prompts/configuration/scoring; this service owns account
  // credentials and transport. Unloading this pool aborts every pinned probe.
  if (typeof ctx.provide === 'function') {
    const probeLifecycle = new AbortController();
    ctx.effect(() => () => probeLifecycle.abort(), 'account-pool: modelProbeAbort');
    // Share in-flight durable pauses across prepared handles for the same exact
    // connection. A failed write stays dirty so a retry cannot mistake the
    // adapter's already-paused memory snapshot for a persisted scheduling pause.
    const probePauses = new Map();
    function pauseProbeScheduling(prepared) {
      probeLifecycle.signal.throwIfAborted();
      const { id, key } = prepared.target;
      const current = adapter.getAccount(id);
      if (!current || adapter.describeAccountProbe(id).key !== key) {
        throw Object.assign(new Error('Account connection changed; start a new test.'), { code: 'POOL_TEST_TARGET_CHANGED' });
      }
      const previous = probePauses.get(key);
      if (previous?.promise) return previous.promise;
      const alreadyPaused = current.schedulable === false;
      const entry = {};
      probePauses.set(key, entry);
      entry.promise = operationWrites.run([], async () => {
        // No await between the connection check and mutation: merge only the
        // scheduling flag onto the current row, without health/metadata resets.
        if (!alreadyPaused || previous?.failed) adapter.pauseAccountProbeScheduling(id, key);
        await flush();
        probeLifecycle.signal.throwIfAborted();
        return { alreadyPaused };
      }).then(result => { probePauses.delete(key); return result; }, error => {
        entry.promise = undefined;
        entry.failed = true;
        throw error;
      });
      return entry.promise;
    }
    const modelProbeService = Object.freeze({
      version: 1,
      pauseSchedulingVersion: 1,
      async targets() {
        probeLifecycle.signal.throwIfAborted();
        return Promise.all(adapter.listAccounts().map(async account => ({ ...adapter.describeAccountProbe(account.id),
          configured: (await describeCredential(credentials, account.credentialRef)).configured === true })));
      },
      prepare(id, selection) {
        probeLifecycle.signal.throwIfAborted();
        const prepared = adapter.prepareAccountProbe(id, selection);
        return Object.freeze({ ...prepared,
          async pauseScheduling() { return pauseProbeScheduling(prepared); },
          stream: (prompt, signal) => prepared.stream(prompt,
            signal ? AbortSignal.any([signal, probeLifecycle.signal]) : probeLifecycle.signal) });
      },
    });
    ctx.effect(() => ctx.provide('accountPoolModelProbe', modelProbeService), 'account-pool: modelProbeService');
  }

  // --- OAuth login ----------------------------------------------------------
  // The engine is pure (see lib/oauth/engine.js); everything that touches DSH —
  // the credential store, the account table, the loopback listener — lives in the
  // `onFinish` callback and in the route below. Keeping that split means the whole
  // login path is testable against a fake fetch, and it means the secret is
  // written in exactly ONE place.
  /** How long a started-but-unfinished login stays redeemable. */
  const oauthFlowTtlMs = options.oauthFlowTtlMs ?? 15 * 60 * 1000;
  const flowStore = createFlowStore({
    ttlMs: oauthFlowTtlMs,
    maxFlows: options.oauthMaxFlows ?? 8,
  });
  /** The loopback listener, while one is bound. */
  let callbackServer = null;
  /** The binding in progress, so concurrent starts share one listen(). */
  let callbackStarting = null;
  /** The flow the listener's `/oauth/callback` belongs to. */
  let callbackFlowFor = null;
  /** The listener's idle-close timer, so an abandoned login cannot hold the port. */
  let callbackIdleTimer = null;
  /** One finish per flow: a callback page reload must not exchange twice. */
  const oauthFinishes = new Map();

  /**
   * Default account id for a freshly logged-in account.
   *
   * Derived from the FLOW id, not from the email: an email slug can collide with
   * an existing account (and emails differ only in a suffix more often than one
   * expects), while the flow id is unique by construction and still readable
   * (`openai-a1b2c3d4e5f6`). The operator-facing name goes in `label`.
   */
  function accountIdForFlow(flow) {
    return slugifyId(`${flow.providerId}-${String(flow.id).split('-').pop()}`, `oauth-${base64url(randomBytes(6))}`);
  }

  /** The `onFinish` half: store the secret, then the row. That order is load-bearing. */
  async function oauthFinish({ flow, bundle, identity, caveat, label }) {
    if (typeof credentials?.set !== 'function') {
      throw new Error('the `credentials` service is unavailable, so a logged-in token cannot be stored');
    }
    const provider = PROVIDERS[flow.providerId];
    // The provider knows which claim names its label (`email`, `sub`, …); the
    // engine only knows the generic shape. Falling back to the provider id keeps
    // an account anonymous rather than nameless.
    const derivedLabel = typeof provider?.labelFrom === 'function' ? provider.labelFrom(identity ?? {}) : null;
    const base = accountIdForFlow(flow);
    let accountId = base;
    let suffix = 2;
    while (adapter.getAccount(accountId) !== undefined) {
      accountId = `${base}-${String(suffix)}`;
      suffix += 1;
      if (suffix > 50) throw new Error(`could not find a free account id based on '${base}'`);
    }

    const record = accountSchema.parse({
      id: accountId,
      label: label ?? derivedLabel ?? `${flow.providerId} oauth`,
      platform: flow.platform,
      // `authMode: 'oauth'` is a FACT about this credential: the transport must
      // send it as a bearer. Leaving it at the default would put a subscription
      // token in `x-api-key` and the upstream would answer 401.
      authMode: 'oauth',
      groups: flow.groupId === null || flow.groupId === undefined ? [] : [flow.groupId],
      mimicryAccountUuid: flow.platform === 'anthropic' ? (identity?.accountId ?? null) : null,
      projectId: flow.platform === 'gemini' ? (bundle?.project_id ?? bundle?.projectId ?? identity?.projectId ?? null) : null,
      chatgptAccountId: flow.platform === 'openai' ? (bundle?.chatgpt_account_id ?? identity?.accountId ?? null) : null,
      createdAt: now(),
      updatedAt: now(),
      credentialRef: defaultCredentialRef(accountId),
    });

    const unknownGroups = (record.groups ?? []).filter((groupId) => adapter.getGroup(groupId) === undefined);
    if (unknownGroups.length > 0) {
      throw new Error(`the target group does not exist: ${unknownGroups.join(', ')}`);
    }

    // Secret first. A rejected `credentials.set` (a read-only source shadows the
    // reference) must leave no account row behind pointing at nothing.
    await writeCredential(record.credentialRef, JSON.stringify(bundle));
    adapter.upsertAccount(record);
    await flush();
    refreshRoutes();

    log?.info?.('account-pool: oauth login for %s created account %s', flow.providerId, accountId);
    return { accountId, label: record.label, caveat: caveat ?? null };
  }

  const oauthEngine = createOAuthEngine({
    providers: PROVIDERS,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    store: flowStore,
    clock,
    onFinish: oauthFinish,
  });

  /**
   * Start the loopback listener on first use, and only when the provider can
   * actually use it. A pool whose operator never logs in this way must not hold a
   * TCP port open, and one whose provider pins the redirect (Gemini) can never
   * use it at all.
   *
   * It is also on a DEAD MAN'S SWITCH. A login the operator starts and then
   * abandons (closes the tab, walks away) sends nothing — no cancel, no callback —
   * so without an idle close the process would sit on the port for its whole life.
   * The timer resets on every inbound callback and is torn down with the listener.
   *
   * Concurrent starts SHARE one binding (`callbackStarting`): two `oauth-start`
   * requests arriving together would otherwise both see `null`, both bind, and
   * leak whichever port lost the race.
   */
  async function ensureCallbackServer(provider) {
    // A provider may dictate the host and path (it registered them), so a listener
    // bound for a different one is dropped and rebound rather than silently
    // returning a URI the vendor will reject.
    if (callbackServer !== null) {
      if (callbackServerServes(callbackServer, provider)) return callbackServer;
      log?.info?.(
        'account-pool: rebinding the oauth callback listener for %s (needs %s, had %s)',
        provider.id, providerRedirectUri(provider), callbackServer.redirectUri,
      );
      await closeCallbackServer();
    }
    if (callbackStarting !== null) return callbackStarting;
    callbackStarting = bindCallbackServer(provider);
    try {
      return await callbackStarting;
    } finally {
      callbackStarting = null;
    }
  }

  /** The URI one provider requires the listener to expose. */
  function providerRedirectUri(provider) {
    // A BOUND listener is the authority: its port is the one the authorize URL
    // actually advertised, and `callbackPort ?? 0` would report `:0`. The
    // configured value is only a fallback for when nothing is listening yet.
    if (callbackServer !== null && callbackServerServes(callbackServer, provider)) {
      return callbackServer.redirectUri;
    }
    return callbackRedirectUri(
      provider.callbackPort ?? 0,
      provider.callbackPath ?? CALLBACK_PATH,
      provider.callbackHost ?? providerHost(provider),
    );
  }

  /**
   * Which address to bind and advertise for a provider.
   *
   * Defaults to `127.0.0.1`, NOT `localhost`: a browser treats them the same, but
   * an authorization server does not — it compares strings, and a registration for
   * one is not a registration for the other. Measured against OpenAI: the
   * `127.0.0.1` form is accepted and the `localhost` form is refused.
   */
  function providerHost(provider) {
    return provider.callbackHost ?? '127.0.0.1';
  }

  /**
   * Can this bound listener serve that provider?
   *
   * Three things are part of the registered URI, and two of them have bitten here:
   *
   *   - the HOST, because `localhost` and `127.0.0.1` are different strings to the
   *     authorization server (the bug that survived a first fix);
   *   - the PATH, because the listener only answers the path it was bound with. A
   *     listener bound on one path can leave a live login redirecting to a path
   *     nothing serves — no error anywhere;
   *   - the PORT, except that an unspecified port means "any free one", which is
   *     what the real Codex client does and the vendor accepts.
   */
  function callbackServerServes(server, provider) {
    if (provider.callbackPort !== undefined && server.port !== provider.callbackPort) return false;
    if (providerHost(provider) !== (server.host ?? providerHost(provider))) return false;
    const wantedPath = provider.callbackPath ?? CALLBACK_PATH;
    if (server.path !== undefined && server.path !== wantedPath) return false;
    return true;
  }

  async function bindCallbackServer(provider) {
    // The provider's own option wins, so an operator whose environment cannot free
    // the default port can point at their own registered client's redirect.
    const wantsPort = Number.isInteger(options.oauthCallbackPort) ? options.oauthCallbackPort : provider.callbackPort;
    const wantsPath = typeof options.oauthCallbackPath === 'string' && options.oauthCallbackPath.startsWith('/')
      ? options.oauthCallbackPath
      : (provider.callbackPath ?? CALLBACK_PATH);
    const wantsHost = typeof options.oauthCallbackHost === 'string' && options.oauthCallbackHost !== ''
      ? options.oauthCallbackHost
      : providerHost(provider);
    const server = await createCallbackServer({
      host: wantsHost,
      port: wantsPort,
      path: wantsPath,
      handler: async ({ params, afterResponse }) => {
        const parsed = readCallbackParams(params);
        // The vendor's refusal comes FIRST, before the state is even looked at.
        // Checking state first would collapse every "you clicked Deny" and every
        // "invalid_scope" into "this callback does not belong to a login", which
        // is both wrong and the only diagnostic the operator would have had.
        if (!parsed.ok) {
          return {
            ok: false,
            title: 'Sign-in was refused',
            message: `The provider returned: ${parsed.error}${parsed.errorDescription === '' ? '' : ` (${parsed.errorDescription})`}`,
          };
        }
        const flow = parsed.state === undefined ? undefined : flowStore.findByState(parsed.state, clock.now());
        if (flow === undefined) {
          return { ok: false, title: 'Sign-in callback', message: 'This callback does not belong to a live login. Start the login again from the account pool page.' };
        }
        try {
          // `params` — NOT `{ code, state }`. The engine's `finish` reads either a
          // raw `input` string to parse or already-split `params`; passing the two
          // at the top level matched neither branch and every loopback callback
          // died on "no authorization code was supplied".
          const snap = await runFinish(flow.id, { params: { code: parsed.code, state: parsed.state } }, afterResponse);
          return { ok: true, title: 'Sign-in complete', message: `Account ${String(snap.accountId ?? '')} was added to the pool.` };
        } catch (error) {
          return { ok: false, title: 'Sign-in failed', message: String(error?.message ?? error) };
        }
      },
    });
    callbackServer = server;
    callbackFlowFor = null;
    // The same window a flow lives for: once every flow could only have expired,
    // the listener has nothing left to receive.
    callbackIdleTimer = setTimeout(() => {
      log?.info?.('account-pool: closing the oauth callback listener after %d ms idle', oauthFlowTtlMs);
      void closeCallbackServer();
    }, oauthFlowTtlMs);
    // A pending timer must not hold the process open on its own.
    callbackIdleTimer?.unref?.();
    log?.info?.('account-pool: oauth callback listener on %s', server.redirectUri);
    return server;
  }

  /** Close the listener and stop its idle timer. Idempotent, and never throws. */
  async function closeCallbackServer({ drain = false } = {}) {
    if (callbackIdleTimer !== null) {
      clearTimeout(callbackIdleTimer);
      callbackIdleTimer = null;
    }
    if (callbackServer === null) return;
    const closing = callbackServer;
    callbackServer = null;
    callbackFlowFor = null;
    try { await closing.close({ drain }); } catch { /* the port is gone either way */ }
  }
  /** `finish` with a per-flow cache, so a duplicate callback cannot exchange twice. */
  async function runFinish(flowId, input, afterResponse) {
    const cached = oauthFinishes.get(flowId);
    if (cached !== undefined && cached.status === 'done') return cached;
    const snap = await oauthEngine.finish({ flowId, ...input });
    oauthFinishes.set(flowId, snap);
    if (callbackFlowFor === flowId) {
      if (typeof afterResponse === 'function') {
        const completingServer = callbackServer;
        afterResponse(() => {
          // A new login/rebind while this answer flushes must keep its listener.
          if (callbackServer === completingServer && callbackFlowFor === flowId) {
            void closeCallbackServer({ drain: true });
          }
        });
      } else {
        // A manually pasted callback has no loopback response to preserve.
        await closeCallbackServer();
      }
    }
    return snap;
  }

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
   * needs, since the adapter instance is unchanged. The provider DIRECTORY has to
   * follow the same list: a route that is not declared has no row, and a row is
   * the only place DSH lets an operator pick or bind that route.
   */
  function refreshRoutes() {
    try {
      unregisterAdapter?.replace?.(adapter.callableRoutesFor());
    } catch (error) {
      log?.warn?.('account-pool: could not update the provider routes: %s', String(error?.message ?? error));
    }
    try {
      unregisterProviders?.replace?.(directoryEntries());
    } catch (error) {
      log?.warn?.('account-pool: could not update the provider directory: %s', String(error?.message ?? error));
    }
  }

  if (upstream === undefined) {
    log?.warn?.('account-pool: no upstream transport available (the `credentials` service is missing); mounting in management-only mode (the `%s` provider is NOT registered)', providerRoute);
  } else if (llm === undefined || typeof llm.registerAdapter !== 'function') {
    log?.warn?.('account-pool: the `llm` service is unavailable; the `%s` provider is NOT registered', providerRoute);
  } else {
    // One route for the whole pool, plus one per group: a group becomes switchable
    // in the model provider list instead of being only a data field.
    unregisterAdapter = llm.registerAdapter(adapter.callableRoutesFor(), adapter);
    adapterRegistered = true;
    log?.info?.('account-pool: registered provider routes %s', adapter.callableRoutesFor().join(', '));
  }

  // Declare EVERY route this plugin owns in the configurable-provider directory:
  // the pool itself, plus one row per group. A group route is a provider an
  // operator can select and call, so it belongs in that list next to the pool.
  //
  // `settingsNs` is the Loader ENTRY ID (what the shipped DeepSeek providers use
  // too) because that is the settings document the Models card edits, and
  // `settingsPath: []` means the whole document is the provider configuration.
  // A row is drawn ONLY when that namespace resolves, which is why this module
  // must export `Config` — see DESIGN.md §24.
  //
  // Gated on `adapterRegistered`: offering a selectable provider that cannot
  // reach anything is the same mistake as registering a broken adapter, just one
  // layer up in the UI.
  let unregisterProviders;
  const entryId = ctx.fiber?.entry?.options?.id;
  const settingsNs = typeof entryId === 'string' && entryId !== '' ? entryId : 'account-pool';
  /** One directory row per route, named by the adapter: the same name the composer's picker shows. */
  const directoryEntries = () => adapter.routesFor().filter((route) => route !== DEFAULT_PROVIDER).map((route) => ({
    provider: route,
    displayName: adapter.providerInfo(route).name,
    settingsNs,
    settingsPath: [],
    // `declared: true` reads as "declared through configuration, not shipped in
    // the catalog" — which is exactly what a pool and its groups are. It is what
    // puts the same 「自定义」 chip on these rows that LocalHost / Anyrouter carry
    // (`refs/ui-settings-models.client.js:2172`); the flag's other two readers sit
    // inside the pi-ai / deepseek family editors (`:1657`, `:1789`), and a
    // namespace like ours never reaches those branches.
    declared: true,
  }));
  if (typeof llm?.registerConfigurableProviders === 'function') {
    if (adapterRegistered) {
      unregisterProviders = llm.registerConfigurableProviders(directoryEntries());
      log?.info?.(
        'account-pool: declared %s in the configurable-provider directory',
        directoryEntries().map((entry) => `${entry.provider} (${entry.displayName})`).join(', '),
      );
    } else {
      log?.info?.('account-pool: `%s` is NOT declared in the provider directory while no upstream transport is configured', providerRoute);
    }
  }

  const stopCapabilityValidation = ctx.on?.('internal/config', function (_raw, next) {
    const raw = next();
    if (this !== ctx.fiber) return raw;
    const candidate = Config(raw);
    adapter.validateModelOverrides(liveValue(candidate.providers), liveValue(options.providers));
    return raw;
  });
  const stopVolatileUpdate = ctx.on?.('loader/volatile-update', () => {
    adapter.setProviderDisplayName(providerLabel());
    refreshRoutes();
  });

  // Optional: keep the installed engine's policies and commit/flush path intact.
  // A sibling compaction service is discovered without becoming a pool mount dependency.
  ctx.inject?.(['compaction'], (child) => {
    const restore = installCodexCompactionBridge({ engine: child.get('compaction'), llm,
      enabled: encryptedCompactionEnabled, canCompact: target => isCodexCompactionTarget(adapter, target),
      resolveCompactionHistory, onFallback: () => log?.warn?.('account-pool: native Codex compaction unavailable; using the configured text summarizer') });
    if (!restore) return;
    compactionBridgeDisposers.add(restore);
    compactionBridgeAvailable = true;
    child.effect(() => () => {
      restore();
      compactionBridgeDisposers.delete(restore);
      compactionBridgeAvailable = compactionBridgeDisposers.size > 0;
    }, 'account-pool: codexCompactionDetach');
  });
  // An external provider cannot consume a Codex-only checkpoint. Restore the
  // original messages before redispatch; the new input has no checkpoint and
  // therefore cannot recurse through this listener. Pool routes do it after
  // selecting the exact account, so scopes and failover stay authoritative.
  const stopExternalCompactionReplay = ctx.on?.('llm/stream', (request, next) => {
    if (adapter.routesFor().includes(request.provider) || !request.messages?.some(hasCodexCompaction)) return next();
    const messages = expandCodexCompactionMessages(request.messages, { enabled: false, resolveCompactionHistory, options: request });
    return llm.stream({ ...request, messages });
  });

  // --- management surface ---------------------------------------------------
  const routeDisposers = [];
  const connection = ctx.get('connection');  if (connection?.fetch?.register !== undefined) {
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
          quota: quotaService.peek(record),
          resetCredits: quotaService.peekResetCredits(record),
        })));
        return json({
          managementVersion: 2,
          usageTimingVersion: 1,
          runtimeRevision: '0.4.28-usage-timing',
          codexContinuity: { ...codexReplayStatus, stickyIdleTtlMs: DURATIONS.codexStickyTtlMs },
          codexCompatibilityVersion: 1,
          codexCompatibility: { encryptedCompactionV2: encryptedCompactionEnabled(),
            available: compactionBridgeAvailable && adapterRegistered && options.upstream === undefined },
          codexWebSocketVersion: 1,
          codexWebSocket: upstream?.codexWebSocketSnapshot?.() ?? { available: false },
          codexAttributionVersion: 2,
          codexAttributionCapabilities: codexAttributionDiagnostics(),
          codexAttributionDispatch: codexDispatchDiagnostics.snapshot(),
          settingsNs,
          quotaVersion: 1,
          resetCreditsVersion: 1,
          nativeVersion: 1,
          detectionVersion: 1,
          supplierVersion: 1,
          openaiProtocolVersion: 1,
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
          // The overrides come back with everything else so the form can show the
          // per-pool ranking without a second round trip.
          priorities: adapter.listPriorities(),
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
        const rows = [...usageTable.entries()].map(([, value]) => ({ ...value, ...normalizeUsageTiming(value) }))
          .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
          .slice(0, limit);
        return json({ limit, rows, usageTimingVersion: 1 });
      },
    }));

    // The one WRITE route: operator actions on a single account. Deliberately
    // narrow — one account, one named action — so it cannot become a generic
    // "patch anything" surface reachable from a browser page.
    routeDisposers.push(connection.fetch.register({
      path: ROUTES.account,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => operationWrites.run([], async () => {
        let body;
        try {
          body = await request.json();
        } catch {
          return json({ error: { code: 'invalid-json', message: 'expected a JSON body' } }, 400);
        }

        const action = typeof body?.action === 'string' ? body.action : '';
        const id = typeof body?.id === 'string' ? body.id.trim() : '';
        const allowed = [
          'codex-compatibility-update', 'supplier-connect', 'supplier-models', 'group-models',
          ...ACCOUNT_ACTIONS, ...CRUD_ACTIONS, ...GROUP_ACTIONS, ...PRIORITY_ACTIONS, ...BATCH_ACTIONS, ...OAUTH_ACTIONS, ...MANAGEMENT_ACTIONS,
        ];
        if (!allowed.includes(action)) {
          return json({ error: { code: 'unknown-action', message: `'${action}' is not one of ${allowed.join(', ')}` } }, 400);
        }
        // `import` addresses a whole document, `group-create` carries its id in the
        // group body, `batch` addresses many accounts at once, and the `oauth-*`
        // verbs address a login FLOW — none of them is addressed by a top-level id.
        if (id === '' && !['codex-compatibility-update', 'supplier-connect', 'supplier-models'].includes(action) && action !== 'create' && action !== 'import' && action !== 'group-create' && action !== 'batch' && action !== 'export' && !OAUTH_ACTIONS.includes(action)) {
          return json({ error: { code: 'missing-id', message: '`id` is required' } }, 400);
        }

        try {
          /** Group ids an account names that do not exist. */
          function unknownGroupsFor(record) {
            return (record.groups ?? []).filter((groupId) => adapter.getGroup(groupId) === undefined);
          }

          if (action === 'codex-compatibility-update') {
            if (typeof body.encryptedCompactionV2 !== 'boolean' || Object.keys(body).some(key => !['action', 'encryptedCompactionV2'].includes(key))) {
              return json({ error: { code: 'invalid-argument', message: 'encryptedCompactionV2 must be a boolean; unrelated settings are not accepted' } }, 400);
            }
            if (body.encryptedCompactionV2 && (!compactionBridgeAvailable || !adapterRegistered || options.upstream !== undefined)) {
              return json({ error: { code: 'codex-compaction-unavailable', message: 'The compatible native compaction bridge is unavailable; restart DSH after updating the account pool' } }, 409);
            }
            await track(updateGlobal(global => ({ ...global, codexEncryptedCompactionV2: body.encryptedCompactionV2 })));
            await flush();
            return json({ ok: true, action, encryptedCompactionV2: encryptedCompactionEnabled() });
          }

          if (action === 'group-models') {
            try {
              const members = adapter.listAccounts();
              const result = await discoverGroupModels(adapter.getGroup(id), members, {
                fetchImpl: options.fetchImpl ?? globalThis.fetch,
                signal: request.signal,
                // API-key catalogs need no OAuth refresh or subscription endpoint calls.
                resolveCredential: (account) => resolveAccountCredential(credentials, account, { refreshEnabled: false }),
              });
              if (!adapter.getGroup(id)) throw new GroupModelsError('unknown-group', '分组已删除，请刷新后重试', 404);
              const original = new Map(members.map(account => [account.id, account]));
              const refreshedAccountIds = [];
              for (const source of result.sources) {
                if (source.error) continue;
                const latest = adapter.getAccount(source.id);
                // Do not resurrect deleted accounts or attach a catalog fetched for
                // a connection the operator changed while discovery was running.
                if (!adapter.getGroup(id) || !latest?.groups?.includes(id)
                  || quotaConnectionKey(latest) !== quotaConnectionKey(original.get(source.id))) {
                  source.models = [];
                  source.error = '账号或分组配置已变化，请重新获取模型';
                  continue;
                }
                const record = accountSchema.parse({
                  ...latest,
                  // Empty explicitly means unrestricted; a fetch must not narrow it.
                  models: latest.models.length ? [...new Set([...latest.models, ...source.models])] : [],
                  updatedAt: now(),
                });
                try {
                  // Await the durable write before publishing this catalog. A failed
                  // write leaves both the adapter and the account catalog unchanged.
                  await accountsTable.put(record.id, record);
                  adapter.upsertAccount(record);
                  refreshedAccountIds.push(record.id);
                } catch {
                  source.models = [];
                  source.error = '无法保存账号模型目录，请重试';
                }
              }
              await flush();
              if (refreshedAccountIds.length) refreshRoutes();
              return json({
                ok: true, action, id,
                models: [...new Set(result.sources.flatMap(source => source.models))],
                sources: result.sources,
                catalogRefreshed: refreshedAccountIds.length > 0,
                refreshedAccountIds,
                whitelistChanged: false,
              });
            } catch (error) {
              return json({ error: {
                code: error instanceof GroupModelsError ? error.code : 'group-discovery-failed',
                message: error instanceof GroupModelsError ? error.message : '无法获取分组模型目录，请重试',
              } }, error instanceof GroupModelsError ? error.status : 500);
            }
          }

          if (action === 'supplier-models') {
            try {
              const models = await discoverSupplierModels(body, { fetchImpl: options.fetchImpl ?? globalThis.fetch, signal: request.signal });
              return json({ ok: true, models });
            } catch (error) {
              return json({ error: { code: error.code ?? 'supplier-discovery-failed', message: error.message } }, error.status ?? 400);
            }
          }
          if (action === 'supplier-connect') {
            let plan;
            try {
              if (typeof credentials?.set !== 'function') throw new SupplierError('supplier-credentials', '凭据服务不可用，无法保存供应商');
              if (!adapterRegistered) throw new SupplierError('supplier-chat-unavailable', '聊天服务暂不可用，请恢复服务后再接入供应商');
              plan = planSupplier(body, { accounts: adapter.listAccounts(), groups: adapter.listGroups(), at: now() });
              const credential = await writeCredential(plan.account.credentialRef, plan.credential);
              if (!credential.configured) throw new SupplierError('supplier-credentials', 'API Key 未保存，请重试');
              // Commit durable rows before exposing a chat route; a failed store leaves no phantom provider.
              try {
                if (plan.createGroup) await groupsTable.put(plan.group.id, plan.group);
                await accountsTable.put(plan.account.id, plan.account);
              } catch (error) {
                await accountsTable.delete(plan.account.id).catch(() => {});
                if (plan.createGroup) await groupsTable.delete(plan.group.id).catch(() => {});
                await writeCredential(plan.account.credentialRef, null).catch(() => {});
                throw new SupplierError('supplier-save', '保存供应商失败，请重试', 500);
              }
              if (plan.createGroup) adapter.upsertGroup(plan.group);
              adapter.upsertAccount(plan.account);
              await flush();
              refreshRoutes();
              return json({ ok: true, action, account: adapter.getAccount(plan.account.id), credential, group: plan.group,
                provider: { id: `pool-${plan.group.id}`, name: adapter.providerInfo(`pool-${plan.group.id}`).name,
                  models: (await adapter.listModels(`pool-${plan.group.id}`)).map(model => model.id) } });
            } catch (error) {
              return json({ error: { code: error instanceof SupplierError ? error.code : 'supplier-invalid', message: error instanceof SupplierError ? error.message : '供应商配置无效或凭据无法保存，请检查后重试' } }, error.status ?? 400);
            }
          }

          // ---- portable metadata export -------------------------------------
          if (action === 'export') {
            if (body.ids !== undefined && (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.some((value) => typeof value !== 'string' || value.trim() === ''))) {
              return json({ error: { code: 'invalid-ids', message: '`ids` must be a non-empty array of account ids' } }, 400);
            }
            const ids = body.ids === undefined ? undefined : new Set(body.ids.map((value) => value.trim()));
            if (ids !== undefined && [...ids].some((accountId) => adapter.getAccount(accountId) === undefined)) {
              return json({ error: { code: 'unknown-account', message: 'the selection contains an unknown account' } }, 404);
            }
            await flush();
            const document = exportAccountMetadata({
              accounts: adapter.listAccounts().filter((record) => ids === undefined || ids.has(record.id)),
              groups: adapter.listGroups(), priorities: adapter.listPriorities(), exportedAt: now(),
            });
            return json({ ok: true, action, document });
          }

          // ---- groups -------------------------------------------------------
          if (action === 'group-create' || action === 'group-update') {
            const edits = body.group ?? {};
            if (edits === null || typeof edits !== 'object' || Array.isArray(edits)
              || Object.keys(edits).some((field) => !EDITABLE_GROUP_FIELDS.includes(field) && !(action === 'group-create' && field === 'id'))) {
              return json({ error: { code: 'unsupported-group-field', message: 'group edits accept label, description, models and selectionMode; id is allowed only when creating a group' } }, 400);
            }
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

          // ---- per (account, group) priorities -------------------------------
          if (action === 'priority-set' || action === 'priority-clear') {
            const groupId = typeof body.group === 'string' ? body.group : '';
            if (groupId === '') return json({ error: { code: 'missing-group', message: '`group` is required' } }, 400);
            // Both ends are checked: an override pointing at a deleted account or group
            // would be an orphan row that silently never applies.
            if (adapter.getAccount(id) === undefined) {
              return json({ error: { code: 'unknown-account', message: `no account '${id}'` } }, 404);
            }
            if (adapter.getGroup(groupId) === undefined) {
              return json({ error: { code: 'unknown-group', message: `no group '${groupId}'` } }, 404);
            }

            if (action === 'priority-clear') {
              const cleared = adapter.clearPriority(id, groupId);
              await flush();
              return json({ ok: true, action, id, group: groupId, cleared });
            }

            const priority = body.priority;
            if (!Number.isInteger(priority)) {
              return json({ error: { code: 'invalid-priority', message: '`priority` must be an integer' } }, 400);
            }
            adapter.setPriority({ accountId: id, groupId, priority, updatedAt: now() });
            await flush();
            return json({ ok: true, action, priority: { accountId: id, groupId, priority } });
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
            if (document?.format === METADATA_FORMAT) {
              let plan;
              try {
                plan = planMetadataImport(document, {
                  accounts: adapter.listAccounts(), groups: adapter.listGroups(), now: now(),
                });
              } catch {
                return json({ error: { code: 'invalid-metadata', message: 'invalid metadata document, version, fields or account/group references; no records were changed' } }, 400);
              }
              for (const record of plan.groups) adapter.upsertGroup(record);
              for (const record of plan.accounts) adapter.upsertAccount({
                ...record, credentialRef: record.credentialRef ?? defaultCredentialRef(record.id),
              });
              for (const record of plan.priorities) adapter.setPriority(record);
              await flush();
              refreshRoutes();
              return json({ ok: true, action, format: METADATA_FORMAT,
                created: plan.created, updated: plan.updated, groups: plan.groups.map((record) => record.id),
                priorities: plan.priorities.length, errors: [] });
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
                await writeCredential(record.credentialRef, entry.credential);
                adapter.upsertAccount(record);
                created.push(entry.id);
              } catch (error) {
                errors.push({ index: -1, reason: `${entry.id}: ${String(error?.message ?? error)}` });
              }
            }
            await flush();
            refreshRoutes();
            log?.info?.('account-pool: imported %d account(s) from a %s document', created.length, plan.format);
            return json({ ok: true, action, format: plan.format, created, errors, group: targetGroup ?? null });
          }

          // ---- oauth login --------------------------------------------------
          // Placed before the `current = adapter.getAccount(id)` guard below,
          // because an `oauth-*` action is addressed by a FLOW id (or not at all)
          // and would otherwise be rejected there as "no account ''".
          if (OAUTH_ACTIONS.includes(action)) {
            if (credentials === undefined) {
              return json({ error: { code: 'no-credential-service', message: 'the `credentials` service is unavailable, so a login could not be stored' } }, 400);
            }

            if (action === 'oauth-status') {
              const flowId = String(body?.flow ?? body?.id ?? '');
              const one = flowId === '' ? undefined : oauthEngine.status(flowId);
              return json({
                ok: true,
                action,
                flow: one ?? null,
                flows: oauthEngine.list(),
              });
            }

            if (action === 'oauth-cancel') {
              const flowId = String(body?.flow ?? body?.id ?? '');
              if (flowId === '') return json({ error: { code: 'missing-flow', message: '`flow` is required' } }, 400);
              oauthFinishes.delete(flowId);
              const dropped = oauthEngine.cancel(flowId);
              if (callbackFlowFor === flowId) await closeCallbackServer();
              log?.info?.('account-pool: oauth flow %s cancelled', flowId);
              return json({ ok: true, action, ...dropped });
            }

            if (action === 'oauth-start') {
              const providerId = typeof body?.provider === 'string' ? body.provider.trim() : '';
              const provider = PROVIDERS[providerId];
              if (provider === undefined) {
                return json({ error: { code: 'unknown-provider', message: `unknown oauth provider '${providerId}' (known: ${Object.keys(PROVIDERS).join(', ')})` } }, 400);
              }
              if (!PLATFORMS.includes(provider.platform)) {
                return json({ error: { code: 'unsupported-platform', message: `provider '${providerId}' maps to platform '${provider.platform}', which this pool cannot store` } }, 400);
              }
              // An explicit group is checked HERE rather than after the operator
              // has finished signing in: failing at the last step wastes the login.
              const targetGroup = typeof body?.group === 'string' && body.group !== '' ? body.group : '';
              if (targetGroup !== '' && adapter.getGroup(targetGroup) === undefined) {
                return json({ error: { code: 'unknown-group', message: `no group '${targetGroup}'` } }, 404);
              }

              // The loopback listener is per login and lazily bound. A provider
              // with a FIXED redirect cannot use it at all, so no port is opened.
              let redirectUri;
              /**
               * Optional loopback-host override: `localhost` vs `127.0.0.1`.
               *
               * These are DIFFERENT strings to an authorization server, and nothing
               * on its side normalises. The provider default is now the measured
               * value out of the real Codex binary (`127.0.0.1`), so this is only
               * for an operator with their own registered client that used the
               * other spelling.
               */
              const redirectHost = typeof body?.redirectHost === 'string' && body.redirectHost.trim() !== ''
                ? body.redirectHost.trim()
                : null;
              if (provider.fixedRedirectUri) {
                redirectUri = provider.fixedRedirectUri;
              } else {
                try {
                  const requested = redirectHost === null ? provider : { ...provider, callbackHost: redirectHost };
                  const server = await ensureCallbackServer(requested);
                  redirectUri = server.redirectUri;
                } catch (error) {
                  // Binding failed, so no listener exists. The authorize URL still
                  // advertises the provider's registered URI — the operator can
                  // paste the callback URL back by hand — and the failure is
                  // reported rather than hidden, because the alternative (inventing
                  // a different URI) is one the vendor answers with a 400.
                  log?.warn?.('account-pool: could not bind the oauth callback listener (%s)', String(error?.message ?? error));
                  redirectUri = provider.defaultRedirectUri ?? providerRedirectUri(
                    redirectHost === null ? provider : { ...provider, callbackHost: redirectHost },
                  );
                }
              }
              const started = oauthEngine.start({
                providerId,
                // The FLOW must carry the same redirect URI that the authorize URL
                // advertised: the token exchange echoes it back, and a vendor that
                // sees a different one rejects the code. Passing the resolved value
                // (not letting the engine fall back to the provider default) is
                // what keeps a loopback login's exchange consistent with its URL.
                redirectUri,
                label: typeof body?.label === 'string' ? body.label : undefined,
                groupId: targetGroup === '' ? undefined : targetGroup,
                clientId: typeof body?.clientId === 'string' ? body.clientId : undefined,
                clientSecret: typeof body?.clientSecret === 'string' ? body.clientSecret : undefined,
                authorizeUrl: typeof body?.authorizeUrl === 'string' ? body.authorizeUrl : undefined,
                tokenUrl: typeof body?.tokenUrl === 'string' ? body.tokenUrl : undefined,
              });
              if (callbackServer !== null && started.redirectUri === callbackServer.redirectUri) {
                callbackFlowFor = started.id;
              }
              log?.info?.('account-pool: oauth login started for %s (flow %s)', providerId, started.id);
              return json({
                ok: true,
                action,
                flow: started,
                // `true` when the redirect is the vendor's own page, so the page
                // must ask for the pasted URL instead of waiting on a listener.
                manualOnly: typeof provider.fixedRedirectUri === 'string' || callbackServer === null,
                // Echoed so the page can show which spelling of the loopback host
                // this login advertises — the operator may need to flip it.
                redirectHost,
              });
            }

            /**
             * `oauth-check` — report what this login will actually send, and flag
             * the mismatches we can prove locally.
             *
             * It deliberately does NOT call the vendor. An earlier version fetched
             * the authorize URL and reported the HTTP status; that fails for a
             * reason nobody can fix — `auth.openai.com` sits behind Cloudflare and
             * answers every non-browser request with `403 Just a moment...`, so the
             * check reported a bot challenge as if it were an OAuth parameter
             * problem. A diagnostic that lies is worse than no diagnostic.
             *
             * What IS provable without a network call: whether the redirect URI is
             * the one the provider registered, and which client/endpoints the flow
             * is using. Those are exactly the fields that produce
             * `invalid_authorize_request` when they are wrong.
             */
            if (action === 'oauth-check') {
              const flowId = String(body?.flow ?? body?.id ?? '');
              if (flowId === '') return json({ error: { code: 'missing-flow', message: '`flow` is required' } }, 400);
              const flow = oauthEngine.status(flowId);
              if (flow === null || flow === undefined) {
                return json({ error: { code: 'unknown-flow', message: `no live oauth flow '${flowId}'` } }, 404);
              }
              const provider = PROVIDERS[flow.provider];
              const wantsRedirect = providerRedirectUri(provider);
              const params = Object.fromEntries(new URL(flow.authUrl).searchParams);
              const problems = [];
              // The single most likely cause of a vendor refusal: the redirect URI
              // is not the one registered against the client id. `localhost` vs
              // `127.0.0.1` and a differing port are DIFFERENT strings to the
              // vendor — no normalisation happens on their side.
              if (params.redirect_uri !== wantsRedirect) {
                problems.push(`redirect_uri is ${params.redirect_uri}, but this provider's registered callback is ${wantsRedirect}`);
              }
              return json({
                ok: true,
                action,
                problems,
                hint: problems.length === 0
                  ? 'the parameters this pool controls look right; if the browser still shows an error page, paste the URL you see into the address bar so the vendor\'s own message can be read'
                  : 'fix the listed problem, or pass clientId/authorizeUrl/tokenUrl (and your own registered redirect) for your own OAuth client',
                flow: {
                  id: flow.id,
                  provider: flow.provider,
                  redirectUri: flow.redirectUri,
                  // The whole URL, because the operator's next step is to open it.
                  // It contains no secret: the verifier never leaves the server, and
                  // the challenge is a one-way hash of it.
                  authUrl: flow.authUrl,
                },
              });
            }

            // `oauth-finish`
            const flowId = String(body?.flow ?? body?.id ?? '');
            if (flowId === '') return json({ error: { code: 'missing-flow', message: '`flow` is required' } }, 400);
            const input = typeof body?.input === 'string' && body.input.trim() !== ''
              ? body.input
              : (typeof body?.code === 'string' && body.code.trim() !== '' ? body.code : '');
            if (input === '') return json({ error: { code: 'missing-code', message: '`input` (the code or the whole redirect URL) is required' } }, 400);

            try {
              const snap = await runFinish(flowId, { input, label: typeof body?.label === 'string' ? body.label : undefined });
              // Also refresh what we just created, so a successful login shows a
              // configured credential rather than a stale "unconfigured" summary.
              const created = snap.accountId === null ? undefined : adapter.getAccount(snap.accountId);
              return json({
                ok: true,
                action,
                flow: snap,
                account: created ?? null,
                credential: created === undefined ? undefined : await describeCredential(credentials, created.credentialRef),
              });
            } catch (error) {
              const snap = oauthEngine.status(flowId);
              log?.warn?.('account-pool: oauth finish for flow %s failed: %s', flowId, String(error?.message ?? error));
              return json({ error: { code: 'oauth-finish-failed', message: String(error?.message ?? error) }, flow: snap ?? null }, 400);
            }
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
            const credential = await writeCredential(record.credentialRef, body.credential);
            adapter.upsertAccount(record);
            await flush();
            refreshRoutes();
            log?.info?.('account-pool: created account %s', newId);
            return json({ ok: true, action, account: adapter.getAccount(newId), credential });
          }

          const current = adapter.getAccount(id);
          // `batch` is not addressed by a single `id`: it carries its own id list and
          // checks every entry itself, so it must pass this guard. Without the
          // exemption a batch request was rejected here as "unknown account ''" and
          // its block below was never reached at all.
          if (current === undefined && action !== 'batch') {
            return json({ error: { code: 'unknown-account', message: `no account '${id}'` } }, 404);
          }

          // ---- remote quota read (no scheduling effects) ---------------------
          if (action === 'quota') {
            if (body.force !== undefined && typeof body.force !== 'boolean') {
              return json({ error: { code: 'invalid-force', message: '`force` must be a boolean' } }, 400);
            }
            const [quota, resetCredits] = await Promise.all([
              quotaService.get(current, { force: body.force === true }),
              supportsResetCredits(current) ? quotaService.getResetCredits(current, { force: body.force === true }) : null,
            ]);
            return json({ ok: true, action, quota, resetCredits });
          }

          if (action === 'quota-reset') {
            if (!supportsResetCredits(current)) {
              return json({ ok: false, action, error: { code: 'unsupported', message: 'Rate-limit reset credits are only supported for ChatGPT/Codex OAuth accounts.' } }, 400);
            }
            if (body.confirm !== true) {
              return json({ ok: false, action, error: { code: 'confirmation-required', message: '`confirm` must be true to consume a reset credit.' } }, 400);
            }
            if (!isResetRequestId(body.requestId)) {
              return json({ ok: false, action, error: { code: 'invalid-request-id', message: 'A valid UUID requestId is required to consume a reset credit.' } }, 400);
            }
            const running = resetActions.get(id);
            if (running) {
              if (running.requestId !== body.requestId || running.key !== quotaConnectionKey(current)) {
                return json({ ok: false, action, requestId: running.requestId,
                  error: { code: 'reset-busy', message: 'This account already has a reset in progress. Wait for that request to finish.' } }, 409);
              }
              const result = await running.promise;
              return json(result.body, result.status);
            }
            const flight = { requestId: body.requestId, key: quotaConnectionKey(current) };
            flight.promise = (async () => {
              const reset = await quotaService.consumeResetCredit(current, { requestId: body.requestId });
              if (!reset.ok) return { status: reset.httpStatus ?? 502, body: { ok: false, action, error: reset.error,
                ...(reset.uncertain ? { uncertain: true } : {}), ...(reset.requestId ? { requestId: reset.requestId } : {}),
                ...(reset.resetCredits ? { resetCredits: reset.resetCredits } : {}) } };
              const [quota, resetCredits] = await Promise.all([
                quotaService.get(current, { force: true }), quotaService.getResetCredits(current, { force: true }),
              ]);
              let syncError;
              if (quota.ok === true && quota.stale !== true && quota.rateLimitAllowed === true && quota.rateLimitReached === false) {
                try {
                  // Use the latest row so concurrent management edits survive; this
                  // evidence only permits clearing the account's 429 reset window.
                  const latest = adapter.getAccount(id);
                  if (latest !== undefined && quotaConnectionKey(latest) === flight.key && latest.rateLimitResetAt !== null) {
                    const capture = { accountId: id };
                    resetSyncCapture = capture;
                    try { adapter.upsertAccount({ ...latest, rateLimitResetAt: null }); }
                    finally { resetSyncCapture = null; }
                    // Adapter persistence is fire-and-forget and flush uses allSettled;
                    // observe this exact write separately to report its failure safely.
                    if (!capture.promise) throw new Error('reset-sync-write-unavailable');
                    await capture.promise;
                    await flush();
                  }
                } catch {
                  syncError = { code: 'quota-reset-sync-failed',
                    message: 'The reset succeeded, but saving the local cooldown change failed. Local cooldown synchronization is incomplete.' };
                }
              }
              return { status: 200, body: { ok: true, action, reset: reset.reset, quota, resetCredits,
                ...(syncError ? { syncError } : {}),
                ...(!quota.ok || !resetCredits.ok ? { refreshError: { code: 'quota-reset-refresh-failed',
                  message: 'The reset succeeded, but refreshing quota or reset credits failed. Query quota again to refresh the display.' } } : {}) } };
            })();
            resetActions.set(id, flight);
            try {
              const result = await flight.promise;
              return json(result.body, result.status);
            } finally { if (resetActions.get(id) === flight) resetActions.delete(id); }
          }

          // ---- real upstream health test ------------------------------------
          if (action === 'test') {
            if (body.model !== undefined && (typeof body.model !== 'string' || body.model.trim() === '')) {
              return json({ error: { code: 'invalid-model', message: '`model` must be a non-empty string' } }, 400);
            }
            const model = body.model?.trim() ?? current.models?.find((value) => value.trim() !== '')
              ?? options.models?.find((value) => value.trim() !== '');
            if (model === undefined) {
              return json({ error: { code: 'missing-model', message: 'choose a model or configure an account model before testing' } }, 400);
            }
            if (current.models.length > 0 && !current.models.includes(model)) {
              return json({ error: { code: 'unsupported-model', message: 'the account model allow-list does not include this model' } }, 400);
            }
            try {
              const test = await adapter.testAccount(id, { model, timeoutMs: options.testTimeoutMs ?? 30_000 });
              await flush();
              return json({ ok: true, action, account: adapter.getAccount(id) ?? null, test });
            } catch (error) {
              if (error?.code === 'POOL_TEST_BUSY') {
                return json({ error: { code: 'test-busy', message: 'this account is already testing or at its concurrency limit' } }, 409);
              }
              throw error;
            }
          }

          // ---- delete ------------------------------------------------------
          if (action === 'delete') {
            quotaService.invalidateCredential(current.credentialRef);
            adapter.removeAccount(id);
            await writeCredential(current.credentialRef, null);
            await flush();
            refreshRoutes();
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
            const credential = await writeCredential(record.credentialRef, body.credential);
            adapter.upsertAccount(record);
            await flush();
            refreshRoutes();
            log?.info?.('account-pool: updated account %s', id);
            return json({ ok: true, action, account: adapter.getAccount(id), credential });
          }

          // ---- batch ---------------------------------------------------------
          // Deliberately NOT atomic: every account is attempted and reported on its
          // own, because "the third one failed" must never look like "all five
          // worked". Nothing is silently skipped, including no-ops.
          if (action === 'batch') {
            const ids = Array.isArray(body.ids) && body.ids.every((value) => typeof value === 'string')
              ? [...new Set(body.ids.map((value) => value.trim()).filter((value) => value !== ''))]
              : [];
            if (ids.length === 0) {
              return json({ error: { code: 'missing-ids', message: '`ids` must be a non-empty array' } }, 400);
            }

            const verb = typeof body.verb === 'string' ? body.verb : '';
            const groupVerb = verb === 'group-add' || verb === 'group-remove';
            if (!ACCOUNT_ACTIONS.includes(verb) && verb !== 'delete' && verb !== 'update' && !groupVerb) {
              return json({ error: { code: 'unknown-verb', message: `unsupported verb '${verb}'` } }, 400);
            }
            const patch = body.account;
            if (verb === 'update') {
              if (patch === null || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length === 0
                || Object.keys(patch).some((field) => !BATCH_EDITABLE_ACCOUNT_FIELDS.includes(field)) || body.credential !== undefined) {
                return json({ error: { code: 'invalid-patch', message: 'batch update needs a non-empty patch of editable management fields' } }, 400);
              }
              if ('groups' in patch && (!Array.isArray(patch.groups) || patch.groups.some((groupId) => adapter.getGroup(groupId) === undefined))) {
                return json({ error: { code: 'unknown-group', message: 'the patch must name existing groups' } }, 400);
              }
            }

            const groupId = typeof body.group === 'string' && body.group !== '' ? body.group : undefined;
            if (groupVerb) {
              if (groupId === undefined) {
                return json({ error: { code: 'missing-group', message: `'${verb}' needs a group` } }, 400);
              }
              if (adapter.getGroup(groupId) === undefined) {
                return json({ error: { code: 'unknown-group', message: `no group '${groupId}'` } }, 404);
              }
            }

            const done = [];
            const failed = [];
            for (const accountId of ids) {
              const account = adapter.getAccount(accountId);
              if (account === undefined) {
                failed.push({ id: accountId, reason: 'unknown-account' });
                continue;
              }
              try {
                if (verb === 'delete') {
                  adapter.removeAccount(accountId);
                } else if (verb === 'update') {
                  adapter.upsertAccount(accountSchema.parse({ ...account, ...patch, updatedAt: now() }));
                } else if (groupVerb) {
                  const currentGroups = account.groups ?? [];
                  const already = currentGroups.includes(groupId);
                  if (verb === 'group-add' && already) {
                    failed.push({ id: accountId, reason: 'already-in-group' });
                    continue;
                  }
                  if (verb === 'group-remove' && !already) {
                    failed.push({ id: accountId, reason: 'not-in-group' });
                    continue;
                  }
                  adapter.upsertAccount({
                    ...account,
                    groups: verb === 'group-add'
                      ? [...currentGroups, groupId]
                      : currentGroups.filter((entry) => entry !== groupId),
                    updatedAt: now(),
                  });
                } else {
                  adapter.upsertAccount(applyAccountAction(account, verb, {
                    now: clock.now(),
                    allAccounts: adapter.listAccounts(),
                    priority: body.priority,
                    mimicry: body.mimicry,
                  }));
                }
                done.push(accountId);
              } catch (error) {
                failed.push({ id: accountId, reason: error?.name === 'ZodError' ? 'invalid-account' : error instanceof RangeError ? 'invalid-argument' : 'action-failed' });
              }
            }

            await flush();
            refreshRoutes();
            log?.info?.('account-pool: batch %s → %d done, %d failed', verb, done.length, failed.length);
            return json({ ok: failed.length === 0, action, verb, group: groupId ?? null, done, failed });
          }

          // ---- state actions ------------------------------------------------
          const next = applyAccountAction(current, action, {
            now: clock.now(),
            allAccounts: adapter.listAccounts(),
            priority: body?.priority,
            // `set-mimicry` reads this. Passed through rather than validated here so
            // the kernel stays the single place that knows the legal mode names.
            mimicry: body?.mimicry,
          });
          adapter.upsertAccount(next);
          await flush();
          log?.info?.('account-pool: %s applied to %s', action, id);
          return json({ ok: true, action, account: adapter.getAccount(id) });
        } catch (error) {
          if (error?.code === 'persist-failed') {
            log?.warn?.('account-pool: management persistence failed for %s', action);
            return json({ ok: false, persisted: false, runtimeMayHaveChanged: true, error: { code: 'persist-failed', message: error.message } }, 503);
          }
          const code = error instanceof RangeError ? 'invalid-argument'
            : error?.name === 'ZodError' ? 'invalid-account'
              : 'action-failed';
          log?.warn?.('account-pool: %s on %s failed: %s', action, id === '' ? '(new)' : id, String(error?.message ?? error));
          return json({ error: { code, message: String(error?.message ?? error) } }, 400);
        }
      }),
    }));

    // The provider picker's data source. A GET because it is pure description —
    // the reference data the page needs before it can offer a login button — and
    // because the write route is deliberately restricted to one named mutation.
    routeDisposers.push(connection.fetch.register({
      path: ROUTES.oauth,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method === 'HEAD') return new Response(null, { status: 200, headers: JSON_HEADERS });
        return json({
          providers: oauthProvidersFor(PLATFORMS),
          flows: oauthEngine.list(),
          // Whether a login can complete without the operator pasting anything.
          // `false` also means the loopback listener could not be bound.
          callbackServer: callbackServer === null ? null : { redirectUri: callbackServer.redirectUri },
          credentialsAvailable: typeof credentials?.set === 'function',
        });
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
      runtimeRevision: '0.4.28-usage-timing',
      codexContinuity: { ...codexReplayStatus, stickyIdleTtlMs: DURATIONS.codexStickyTtlMs },
      codexWebSocketVersion: 1,
      codexWebSocket: upstream?.codexWebSocketSnapshot?.() ?? { available: false },
      codexAttributionVersion: 2,
      codexAttributionCapabilities: codexAttributionDiagnostics(),
      codexAttributionDispatch: codexDispatchDiagnostics.snapshot(),
      requestRetries: options.requestRetries ?? 3,
      entryId: typeof entryId === 'string' && entryId !== '' ? entryId : null,
      providerRoute,
      upstreamConfigured: upstream !== undefined,
      capabilities: {
        storageDomain: true,
        llm: llm !== undefined,
        connection: connection !== undefined,
        timer: typeof ctx.interval === 'function',
        attachments: typeof ctx.get('attachments')?.readImageRequest === 'function',
      },
      registered: {
        adapter: adapterRegistered,
        providerDeclared: unregisterProviders !== undefined,
        routes: routeDisposers.length,
      },
      accounts: { inserted, refreshed, total: adapter.listAccounts().length },
      // How many accounts are actually disguised, split by the reason it can be
      // surprising: `claudeCode` counts accounts in the mode, `claudeCodeWithoutOauth`
      // counts accounts in the mode that are NOT sending a bearer — a combination
      // that is legal but almost always a mistake, and one the upstream answers with
      // a 401 rather than a diagnostic.
      claudeCode: {
        accounts: adapter.listAccounts().filter((account) => account.mimicry === 'claude-code').length,
        withoutOauth: adapter.listAccounts().filter((account) => account.mimicry === 'claude-code' && account.authMode !== 'oauth').length,
      },
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
    for (const restore of compactionBridgeDisposers) restore();
    compactionBridgeDisposers.clear();
    compactionBridgeAvailable = false;
    try { stopExternalCompactionReplay?.(); } catch { /* already unwound */ }
    // Only close transport state owned by this mount, not caller-injected dependencies.
    if (options.upstream === undefined) upstream?.dispose?.();
    quotaService.dispose();
    resetActions.clear();
    try { stopPrune?.(); } catch { /* already stopped */ }
    try { stopCapabilityValidation?.(); } catch { /* the fiber also unwinds this */ }
    try { stopVolatileUpdate?.(); } catch { /* the fiber also unwinds this */ }
    // A login listener is a real socket: releasing it is part of unloading, not an
    // afterthought. Closing it here also stops a flow that completes during
    // teardown from resurrecting it.
    await closeCallbackServer();
    oauthFinishes.clear();
    for (const disposeRoute of [...routeDisposers].reverse()) {
      try { await disposeRoute(); } catch { /* the fiber also unwinds these */ }
    }
    try { unregisterAdapter?.(); } catch { /* the fiber also unwinds this */ }
    try { unregisterProviders?.(); } catch { /* the fiber also unwinds this */ }
    await flush().catch(() => {});
    await domain.close();
  }

  return { domain, adapter, quotaService, adapterRegistered, providerRoute, inserted, refreshed, flush, dispose };
}

/**
 * Cordis entry point. Returning the disposer is the supported async-apply shape
 * (DESIGN.md §11): the resolved value is collected as this fiber's teardown.
 */
export async function apply(ctx, config = {}) {
  ctx.inject?.(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
  });
  const mounted = await mountPool(ctx, config);
  return () => mounted.dispose();
}

export default { name, inject, Config, apply };
