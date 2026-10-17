/**
 * Account-pool durable shapes.
 *
 * The spec object is hand-built rather than produced by
 * `@deepseek-ai/dsh-storage-domain`'s `defineDomain`: that helper is a pure
 * identity + validation function (`domainTable(s) === { valueSchema: s }`,
 * `defineDomain(spec)` validates then returns the SAME object), so building the
 * object literally removes a dependency on a DSH-internal package while
 * producing a byte-identical spec. `assertDomainSpec` below re-implements the
 * eager checks that `defineDomain` performed, so misconfiguration still fails
 * loud at module load instead of at `open()`.
 *
 * `zod` is the one real dependency: it is what the domain facility calls to
 * validate every stored record at the durability boundary.
 */
import { z } from 'zod';

import { AUTH_MODES, MIMICRY_MODES } from './claude-code/index.js';

/** Canonical ISO instant, matching `Date.prototype.toISOString()`. */
const instant = z.iso.datetime({ precision: 3 });

/** A nullable timestamp that defaults to null — the "no window set" value. */
const optionalInstant = instant.nullable().default(null);

export const PLATFORMS = ['anthropic', 'openai', 'gemini', 'grok', 'custom'];

/**
 * One upstream account. Field-for-field the trimmed sub2api account model:
 * management state, scheduling weight, expiry, and the three independent
 * cooling windows the kernel's `isSchedulable` inspects.
 */
export const accountSchema = z.strictObject({
  id: z.string().min(1),
  label: z.string().default(''),
  notes: z.string().max(10000).default(''),
  platform: z.enum(PLATFORMS).default('custom'),
  baseUrl: z.string().nullable().default(null),
  openaiApi: z.enum(['chat-completions', 'responses']).default('chat-completions'),
  openaiTransport: z.enum(['http', 'websocket']).default('http'),
  /**
   * Opaque handle for this account's secret, resolved by the host half. The
   * secret itself is NEVER stored in the domain: the row is validated, logged
   * and served over the management route, so a token here would leak onto every
   * one of those surfaces. Phase 3 resolves this through `ctx.credentials`.
   */
  credentialRef: z.string().nullable().default(null),
  /** Public connection identifiers, kept outside the secret bundle for manual repair. */
  projectId: z.string().nullable().default(null),
  chatgptAccountId: z.string().nullable().default(null),
  /**
   * How the secret is presented upstream. NOT the same axis as `mimicry`: an
   * Anthropic OAuth token must travel as `Authorization: Bearer`, an API key as
   * `x-api-key`, and sending one as the other is rejected. Defaults to
   * `'api-key'` because that is what a bare key is; the importer flips imported
   * OAuth accounts (sub2api `type: 'oauth'`) to `'oauth'`.
   */
  authMode: z.enum(AUTH_MODES).default('api-key'),

  // --- Claude Code mode (the lib/claude-code/ module group) ------------------
  /**
   * `'claude-code'` disguises this account's Anthropic traffic as the official
   * CLI: CLI headers and beta set, the 3-block `system` array with a billing
   * attribution block, and a `metadata.user_id` identity triple. Opt-in per
   * account, because it is only needed for subscription (OAuth) credentials and
   * because it rewrites the system prompt (the caller's own text is preserved by
   * migrating it into the message history).
   */
  mimicry: z.enum(MIMICRY_MODES).default('off'),
  /**
   * Pin the persistent device id carried in `metadata.user_id` (64 hex chars).
   * `null` derives one from the account id instead — derivation gives the same
   * "constant for the life of this account" property sub2api gets from freezing a
   * random value, without needing a write path.
   */
  mimicryClientId: z.string().nullable().default(null),
  /** Pin the `account_uuid` component; `null` derives a stable stand-in. */
  mimicryAccountUuid: z.string().nullable().default(null),
  /**
   * Pin the impersonated CLI version (e.g. when the upstream introduces a minimum
   * version for a new model). `null` uses the built-in baseline; it must agree
   * with the version in the `User-Agent` and the billing block, which is
   * guaranteed by resolving it once per request.
   */
  mimicryCliVersion: z.string().nullable().default(null),
  /**
   * Extra `anthropic-beta` tokens THIS account's upstream requires.
   *
   * A separate axis from `mimicry`, and empty by default, because the token is a
   * fact about the RELAY rather than about the client: relays that gate their
   * Claude models behind 1M context (Anyrouter is the measured one) answer a
   * request without the token with `400 请启用 1m 上下文后重试` before emitting a
   * single event, which the operator sees as a turn that produces nothing.
   *
   * Opt-in per account rather than added to every request: a beta the upstream
   * model does not support is itself a 400, so a token that fixes one account
   * must not be forced onto another (see `CONTEXT_1M_BETA`).
   */
  betas: z.array(z.string()).default([]),

  // Account-local transient pool detection retry. Defaults preserve legacy errors.
  poolDetectionRetry: z.boolean().default(false),
  poolDetectionRetries: z.number().int().min(0).max(5).default(2),
  poolDetectionRetryDelayMs: z.number().int().min(100).max(10000).default(1000),
  poolDetectionKeywords: z.array(z.string().trim().min(1).max(200)).max(20)
    .default(['号池检测', '池检测', '号池不可用']),

  // management state
  status: z.enum(['active', 'error', 'disabled']).default('active'),
  schedulable: z.boolean().default(true),
  errorMessage: z.string().default(''),

  // scheduling weight: loadFactor ranks, concurrency caps
  priority: z.number().int().default(100),
  /**
   * Relative share used by the `weighted-random` selection mode. 0 is a valid
   * value and still receives a share (see `weightedPick`), matching new-api's
   * `weight` column, where a zero-weight row is never starved out entirely.
   */
  weight: z.number().min(0).default(0),
  loadFactor: z.number().int().positive().nullable().default(null),
  concurrency: z.number().int().min(0).default(4),
  models: z.array(z.string()).default([]),
  /**
   * Group ids this account belongs to.
   *
   * An EMPTY list deliberately means "the default pool only" — it does NOT mean
   * "every group". Otherwise creating a group would silently sweep in every
   * existing account, and a group could never be a deliberate subset.
   */
  groups: z.array(z.string()).default([]),

  // expiry
  expiresAt: optionalInstant,
  autoPauseOnExpired: z.boolean().default(true),

  // the three cooling windows
  rateLimitResetAt: optionalInstant,
  overloadUntil: optionalInstant,
  tempUnschedulableUntil: optionalInstant,
  tempUnschedulableReason: z.string().default(''),

  // observation: management probes never store response text or raw errors.
  lastTestAt: optionalInstant,
  lastTestOk: z.boolean().nullable().default(null),
  lastTestModel: z.string().default(''),
  lastTestLatencyMs: z.number().int().min(0).nullable().default(null),
  lastTestErrorCode: z.string().default(''),
  lastTestMessage: z.string().default(''),
  lastUsedAt: optionalInstant,
  consecutiveFailures: z.number().int().min(0).default(0),
  createdAt: instant,
  updatedAt: instant,
}).superRefine((account, ctx) => {
  // Codex OAuth uses a fixed native Responses endpoint, not openaiApi. Keep
  // legacy rows on HTTP by default; opting into WS does not require migrating
  // their historical chat-completions value to the generic API-key protocol.
  if (account.platform === 'openai' && account.authMode === 'oauth' && account.openaiTransport === 'websocket') return;
  if (account.openaiApi === 'chat-completions' && account.openaiTransport === 'http') return;
  if (!['openai', 'grok', 'custom'].includes(account.platform) || account.authMode !== 'api-key') {
    ctx.addIssue({ code: 'custom', path: ['openaiApi'], message: 'OpenAI 请求格式和传输选项仅用于 OpenAI 兼容 API Key 账号' });
  }
  if (account.openaiTransport === 'websocket' && account.openaiApi !== 'responses') {
    ctx.addIssue({ code: 'custom', path: ['openaiTransport'], message: 'WebSocket 传输需要选择 Responses API' });
  }
});

/** Group ids become provider route suffixes, so they share the slug rule. */
export const GROUP_ID_RE = /^[a-z][a-z0-9-]*$/;

/**
 * One account GROUP — the (group, model) dimension new-api keys its routing
 * table on, and the subset sub2api expresses through `groups`/`account_groups`.
 *
 * A group is a named subset of accounts plus an OPTIONAL model allow-list, so a
 * group can be "the cheap accounts" or "the accounts allowed to serve Opus".
 * Ordering inside a group still comes from the accounts' own scheduling fields;
 * per-group priority would need a join table (`account_groups`) and is a
 * deliberate later step, not an oversight.
 */
export const groupSchema = z.strictObject({
  id: z.string().regex(GROUP_ID_RE),
  label: z.string().default(''),
  description: z.string().default(''),
  /** Disabled groups stay editable in Models settings but expose no callable route. */
  enabled: z.boolean().default(true),
  /** Extra allow-list on top of each account's own `models`; empty = no extra limit. */
  models: z.array(z.string()).default([]),
  selectionMode: z.enum(['sticky', 'load-aware', 'prefer_soonest_reset', 'weighted-random']).default('sticky'),
  /**
   * LEGACY — nothing reads it any more. The "preferred pool" idea (one group the
   * default `pool` route resolved to) has been removed: the default route is the
   * whole pool again and a group is reached only by naming it (`pool-<id>`), see
   * DESIGN.md §27.
   *
   * The field stays in the schema on purpose instead of being deleted: these
   * tables are strict, so group rows already on disk still carry
   * `preferred: false` and would stop parsing if the key disappeared. It is
   * frozen — no longer editable through the host (`EDITABLE_GROUP_FIELDS`) and
   * never consulted when routing.
   */
  preferred: z.boolean().default(false),
  createdAt: instant,
  updatedAt: instant,
});

/**
 * One (account × group) priority — sub2api's `account_groups.priority`.
 *
 * This is what makes priority a RELATION rather than a number on the account: the
 * same account can rank first in one pool and fifth in another. An account with no
 * entry for a pool falls back to its own `priority`, so nothing changes until an
 * operator sets one.
 *
 * Keyed by `accountId|groupId` because the medium is a flat key→value store.
 */
export const prioritySchema = z.strictObject({
  accountId: z.string().min(1),
  groupId: z.string().regex(GROUP_ID_RE),
  priority: z.number().int(),
  updatedAt: instant,
});

/** The flat key for one (account, group) pair. */
export function priorityKey(accountId, groupId) {
  return `${String(accountId)}|${String(groupId)}`;
}

/** One sticky session → account binding. TTL is carried per record. */
export const bindingSchema = z.strictObject({
  sessionHash: z.string().min(1),
  accountId: z.string().min(1),
  platform: z.string().min(1),
  boundAt: instant,
  expiresAt: instant,
});

/** One folded usage record. Keys are supplied by the host half. */
export const usageSchema = z.strictObject({
  id: z.string().min(1),
  at: instant,
  accountId: z.string().default(''),
  sessionId: z.string().default(''),
  platform: z.string().default(''),
  model: z.string().default(''),
  // Request-local selection and mapping; null on historical rows means unknown.
  reasoningEffort: z.string().nullable().default(null),
  mappedReasoningEffort: z.string().nullable().default(null),
  inputTokens: z.number().min(0).default(0),
  outputTokens: z.number().min(0).default(0),
  cacheReadTokens: z.number().min(0).default(0),
  cacheWriteTokens: z.number().min(0).default(0),
  reasoningTokens: z.number().min(0).default(0),
  // Advisory request timing; historical records have no measurement, not zero.
  firstTokenMs: z.number().finite().min(0).nullable().default(null),
  outputDurationMs: z.number().finite().min(0).nullable().default(null),
  outputTps: z.number().finite().min(0).nullable().default(null),
  accountSwitches: z.number().int().min(0).default(0),
  ok: z.boolean(),
  errorCode: z.string().default(''),
});

/**
 * Domain singleton. The schema must NOT accept `null`: the medium uses `null`
 * as its "never written" sentinel, so a nullable global could not round-trip.
 */
export const poolGlobalSchema = z.strictObject({
  installedAt: instant,
  totalRequests: z.number().int().min(0).default(0),
  codexEncryptedCompactionV2: z.boolean().default(false),
  /** Only acknowledged session/provider/model speed choices; standard needs no row. */
  codexSpeedSelections: z.array(z.strictObject({
    sessionId: z.string().min(1).max(256),
    provider: z.string().min(1).max(256),
    model: z.string().min(1).max(256),
    mode: z.enum(['fast', 'ultrafast']),
  })).max(512).default([]),
});

export const DOMAIN_NAME = 'account_pool';
export const DOMAIN_VERSION = 1;

/**
 * The durable-format unit/table name rule.
 *
 * Copied from `@deepseek-ai/dsh-storage`'s `UNIT_NAME_RE` after the real backend
 * rejected `account-pool`: it is `^[a-z][a-z0-9_]*$` — UNDERSCORES, no hyphens.
 * A hand-rolled approximation got this wrong, and only a live `open()` caught
 * it, which is the standing argument for keeping this constant tied to its
 * source rather than to intuition.
 */
export const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * The domain declaration handed to `ctx.storageDomain.open()`.
 *
 * `invalidRecords: 'backup-and-skip'` means one corrupt record is moved aside
 * and skipped instead of blocking the whole domain from opening — a pool that
 * refuses to start because a single row drifted is worse than a pool missing
 * one account.
 */
export const poolDomainSpec = {
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  invalidRecords: 'backup-and-skip',
  global: {
    schema: poolGlobalSchema,
    initial: { installedAt: new Date(0).toISOString(), totalRequests: 0 },
  },
  tables: {
    accounts: { valueSchema: accountSchema },
    groups: { valueSchema: groupSchema },
    priorities: { valueSchema: prioritySchema },
    bindings: { valueSchema: bindingSchema },
    usage: { valueSchema: usageSchema },
    // Additive table: keeps listener settings separate from existing pool globals.
    // No secret values live in this domain; the API key uses the credential store.
    local_api: { valueSchema: z.strictObject({ enabled: z.boolean(), port: z.number().int().min(1024).max(65535) }) },
  },
};

/**
 * Eager fail-loud parity with the vendor `defineDomain` helper, for the checks
 * that do not require importing the vendor package.
 *
 * @throws {Error} on a non-integer version, a bad table name, an unsupported
 *   `invalidRecords` policy, or a global schema that accepts `null`.
 */
export function assertDomainSpec(spec = poolDomainSpec) {
  if (!Number.isInteger(spec.version) || spec.version < 0) {
    throw new Error(`domain '${spec.name}' version must be a non-negative integer, got ${spec.version}`);
  }
  if (spec.invalidRecords !== undefined && spec.invalidRecords !== 'backup-and-skip') {
    throw new Error(`domain '${spec.name}' invalidRecords must be 'backup-and-skip' when present, got ${spec.invalidRecords}`);
  }
  if (!UNIT_NAME_RE.test(spec.name)) {
    throw new Error(`domain name '${spec.name}' must match ${String(UNIT_NAME_RE)}`);
  }
  for (const table of Object.keys(spec.tables)) {
    if (!UNIT_NAME_RE.test(table)) {
      throw new Error(`domain '${spec.name}' table name '${table}' must match ${String(UNIT_NAME_RE)}`);
    }
    const tableSpec = spec.tables[table];
    if (tableSpec === null || typeof tableSpec !== 'object' || typeof tableSpec.valueSchema?.parse !== 'function') {
      throw new Error(`domain '${spec.name}' table '${table}' must declare a valueSchema with parse()`);
    }
  }
  if (spec.global !== undefined && spec.global.schema.safeParse(null).success) {
    throw new Error(`domain '${spec.name}' global schema must not accept null: null is the medium's "never written" sentinel`);
  }
  return spec;
}

assertDomainSpec(poolDomainSpec);

/**
 * Build a fully-defaulted account record, so callers never have to spell out
 * every field and the persisted shape is always complete.
 */
export function makeAccount(overrides = {}) {
  const now = typeof overrides.now === 'string' ? overrides.now : new Date().toISOString();
  const { now: _ignored, ...rest } = overrides;
  return accountSchema.parse({
    id: rest.id,
    createdAt: now,
    updatedAt: now,
    ...rest,
  });
}
