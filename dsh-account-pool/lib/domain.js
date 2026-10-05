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
  platform: z.enum(PLATFORMS).default('custom'),
  baseUrl: z.string().nullable().default(null),
  /**
   * Opaque handle for this account's secret, resolved by the host half. The
   * secret itself is NEVER stored in the domain: the row is validated, logged
   * and served over the management route, so a token here would leak onto every
   * one of those surfaces. Phase 3 resolves this through `ctx.credentials`.
   */
  credentialRef: z.string().nullable().default(null),

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

  // observation
  lastUsedAt: optionalInstant,
  consecutiveFailures: z.number().int().min(0).default(0),
  createdAt: instant,
  updatedAt: instant,
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
  /** Extra allow-list on top of each account's own `models`; empty = no extra limit. */
  models: z.array(z.string()).default([]),
  createdAt: instant,
  updatedAt: instant,
});

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
  inputTokens: z.number().min(0).default(0),
  outputTokens: z.number().min(0).default(0),
  cacheReadTokens: z.number().min(0).default(0),
  cacheWriteTokens: z.number().min(0).default(0),
  reasoningTokens: z.number().min(0).default(0),
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
    bindings: { valueSchema: bindingSchema },
    usage: { valueSchema: usageSchema },
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
