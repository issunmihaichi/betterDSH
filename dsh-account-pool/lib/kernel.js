/**
 * Account-pool kernel — pure functions only.
 *
 * NO DSH imports, NO network, NO clock reads: every function takes `now` (epoch
 * ms) explicitly. This is what makes the whole selection/cooldown state machine
 * testable under a bare `node tools/kernel-test.mjs`.
 *
 * Semantics are ported from sub2api's account scheduler; see DESIGN.md §4–§6 and
 * the referenced source lines for each rule.
 */
// The Claude Code mode vocabulary, imported from the module group's LEAF constants
// file rather than from its index: that file imports nothing, so the kernel stays
// dependency-free (no `node:crypto`, no group wiring) while the mode names still
// have exactly one definition.
import { MIMICRY_MODES } from './claude-code/constants.js';

/** Tunables. Kept here so tests can assert against the same constants. */
export const DURATIONS = {
  /** 429 without a retry-after hint (sub2api: cooldown to the window reset). */
  rateLimitDefaultMs: 60_000,
  /** 401/403 — credential is likely dead; park briefly before blaming permanently. */
  authFailMs: 15 * 60_000,
  /** Transport-level failure with no HTTP status at all. */
  transportMs: 5 * 60_000,
  /** 5xx/529 progressive penalty ladder, indexed by consecutiveFailures. */
  overloadLadderMs: [30_000, 10 * 60_000, 60 * 60_000],
  /** Consecutive auth failures that flip the account to `error`. */
  authFailuresToDisable: 3,
  /** Sticky binding lifetime (sub2api: stickySessionTTL = time.Hour). */
  stickyTtlMs: 60 * 60_000,
  /** Codex long tasks: idle expiry, refreshed on each successful sticky request. */
  codexStickyTtlMs: 7 * 24 * 60 * 60_000,
  /** How many account switches one request may spend before giving up. */
  maxAccountSwitches: 3,
};

/** Parse a stored ISO timestamp; `null`/`undefined`/garbage → undefined. */
export function parseTs(value) {
  if (value === null || value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Format epoch ms as the canonical ISO instant used at the durability boundary. */
export function formatTs(ms) {
  return new Date(ms).toISOString();
}

/**
 * Whether an account may serve a request right now.
 *
 * Direct port of sub2api `Account.IsSchedulable()` (account.go:182-203):
 * management state, the manual switch, expiry, then the three independent
 * cooling windows. Model-level filtering is NOT here — it belongs to candidate
 * filtering, because it is per-request rather than per-account.
 *
 * @param account - stored account record.
 * @param now - epoch ms.
 * @returns true when the account is eligible.
 */
export function isSchedulable(account, now) {
  if (account === undefined || account === null) return false;
  if (account.status !== 'active') return false;
  if (account.schedulable !== true) return false;

  if (account.autoPauseOnExpired !== false) {
    const expiresAt = parseTs(account.expiresAt);
    if (expiresAt !== undefined && now >= expiresAt) return false;
  }

  const overloadUntil = parseTs(account.overloadUntil);
  if (overloadUntil !== undefined && now < overloadUntil) return false;

  const rateLimitResetAt = parseTs(account.rateLimitResetAt);
  if (rateLimitResetAt !== undefined && now < rateLimitResetAt) return false;

  const tempUntil = parseTs(account.tempUnschedulableUntil);
  if (tempUntil !== undefined && now < tempUntil) return false;

  return true;
}

/**
 * The account's ranking weight (sub2api `EffectiveLoadFactor`): an explicit
 * loadFactor wins, else the hard concurrency cap, else 1. Keeping the ranking
 * weight separable from the hard cap is deliberate — an account can be allowed
 * 16 in flight while still ranking as if it were small.
 */
export function effectiveLoadFactor(account) {
  if (account === null || account === undefined) return 1;
  if (Number.isFinite(account.loadFactor) && account.loadFactor > 0) return account.loadFactor;
  if (Number.isFinite(account.concurrency) && account.concurrency > 0) return account.concurrency;
  return 1;
}

/** In-flight pressure. `loadFactor` 0 or absent falls back to the effective weight. */
export function loadRatio(account, inflight) {
  const used = inflight?.get?.(account.id) ?? 0;
  return used / Math.max(1, effectiveLoadFactor(account));
}

/** Whether the account advertises support for a model. An empty list means "any". */
export function supportsModel(account, model) {
  const models = account?.models;
  if (!Array.isArray(models) || models.length === 0) return true;
  if (typeof model !== 'string' || model === '') return true;
  return models.includes(model);
}

/** Whether the account still has a free concurrency slot. 0 means unlimited. */
export function hasCapacity(account, inflight) {
  const limit = Number.isFinite(account?.concurrency) ? account.concurrency : 0;
  if (limit <= 0) return true;
  return (inflight?.get?.(account.id) ?? 0) < limit;
}

/** Sticky binding lookup honouring expiry. Returns `undefined` when absent/expired. */
export function activeBinding(bindings, sessionHash, now) {
  if (typeof sessionHash !== 'string' || sessionHash === '') return undefined;
  const binding = bindings?.get?.(sessionHash);
  if (binding === undefined || binding === null) return undefined;
  const expiresAt = parseTs(binding.expiresAt);
  if (expiresAt !== undefined && now >= expiresAt) return undefined;
  return binding;
}

/** Build a fresh binding for a successful route. */
export function makeBinding(sessionHash, account, now, ttlMs = DURATIONS.stickyTtlMs) {
  return {
    sessionHash,
    accountId: account.id,
    platform: account.platform,
    boundAt: formatTs(now),
    expiresAt: formatTs(now + ttlMs),
  };
}

/**
 * Pick one candidate by weight, using new-api's smoothing rules.
 *
 * Straight from `GetRandomSatisfiedChannel`:
 *   - every weight 0 → each candidate gets an effective 100, so a pool where
 *     nobody set weights still spreads evenly instead of collapsing onto one row;
 *   - average weight below 10 → scale everything by 100, so a pool of tiny
 *     weights does not produce a lumpy distribution out of integer rounding;
 *   - otherwise a plain cumulative walk over weighted shares.
 *
 * `random` is injectable so the distribution is testable without stubbing
 * globals. The final fallback matters: when candidates exist, this must always
 * return one — new-api returns an error there, which surfaces as a spurious
 * "no channel" failure.
 */
export function weightedPick(candidates, random = Math.random) {
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  const weightOf = (account) => {
    const value = Number(account?.weight);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };

  let sumWeight = 0;
  for (const account of candidates) sumWeight += weightOf(account);

  let factor = 1;
  let adjustment = 0;
  if (sumWeight === 0) {
    sumWeight = candidates.length * 100;
    adjustment = 100;
  } else if (sumWeight / candidates.length < 10) {
    factor = 100;
  }

  const total = sumWeight * factor;
  const draw = Math.min(Math.max(random(), 0), 0.999999);
  let point = Math.floor(draw * total);

  for (const account of candidates) {
    point -= weightOf(account) * factor + adjustment;
    if (point < 0) return account;
  }
  return candidates[candidates.length - 1];
}

/**
 * Two-layer selection (DESIGN.md §6).
 *
 * Layer 1 — sticky: a live binding whose account is still a candidate wins
 * outright. Crucially, a binding whose account is merely *not currently a
 * candidate* (cooling, at capacity, excluded) is left INTACT and reported as
 * `skipped`, so the session returns to it once it recovers. Deleting it there
 * would silently destroy stickiness every time an account hit a 429 — this is
 * the sub2api rule, and the reason the field exists.
 *
 * Layer 2 — one of three modes:
 *   - `load-aware` (default): priority, then load ratio, then LRU, then id;
 *   - `prefer_soonest_reset`: burn the window that expires first;
 *   - `weighted-random`: the best remaining priority TIER, then {@link weightedPick}.
 *
 * ⚠ Priority convention: this pool treats a LOWER number as better (so `prefer`
 * can set `min - 1`). new-api is the opposite — its `priority` is sorted DESC and
 * a higher number is tried first. Do not copy a rule across without flipping it.
 *
 * @returns `{ account, layer, bindingState }`; `account` is undefined when the
 *   candidate set is empty. `bindingState` is one of
 *   `absent | expired | hit | skipped | none`.
 */
export function selectCandidate({
  accounts,
  bindings,
  sessionHash,
  requestedModel,
  excluded,
  now,
  inflight,
  mode = 'load-aware',
  useSticky = true,
  random = Math.random,
} = {}) {
  const candidates = [];
  for (const account of accounts ?? []) {
    if (!isSchedulable(account, now)) continue;
    if (!supportsModel(account, requestedModel)) continue;
    if (excluded?.has?.(account.id)) continue;
    if (!hasCapacity(account, inflight)) continue;
    candidates.push(account);
  }

  const binding = useSticky ? bindings?.get?.(sessionHash) : undefined;
  let bindingState = 'absent';
  if (binding !== undefined && binding !== null) {
    const live = activeBinding(bindings, sessionHash, now) !== undefined;
    if (!live) {
      bindingState = 'expired';
    } else {
      const hit = candidates.find((a) => a.id === binding.accountId);
      if (hit !== undefined) return { account: hit, layer: 'sticky', bindingState: 'hit' };
      // Deliberately NOT removed: a cooled account must be reachable again.
      bindingState = 'skipped';
    }
  } else {
    bindingState = 'none';
  }

  if (candidates.length === 0) {
    return { account: undefined, layer: 'none', bindingState };
  }

  if (mode === 'weighted-random') {
    // Restrict to the best remaining priority tier, then spread within it by
    // weight. Because the adapter EXCLUDES a failed account and re-selects, this
    // walks down the tiers exactly like new-api's `retry` index does.
    let best = Number.POSITIVE_INFINITY;
    for (const account of candidates) best = Math.min(best, account.priority);
    const tier = candidates.filter((account) => account.priority === best);
    return { account: weightedPick(tier, random), layer: 'weighted', bindingState };
  }

  const sorted = [...candidates].sort((x, y) => {
    if (mode === 'prefer_soonest_reset') {
      const rx = parseTs(x.rateLimitResetAt) ?? 0;
      const ry = parseTs(y.rateLimitResetAt) ?? 0;
      if (rx !== ry) return rx - ry;
    }
    if (x.priority !== y.priority) return x.priority - y.priority;
    const ratio = loadRatio(x, inflight) - loadRatio(y, inflight);
    if (ratio !== 0) return ratio;
    const lx = parseTs(x.lastUsedAt) ?? 0;
    const ly = parseTs(y.lastUsedAt) ?? 0;
    if (lx !== ly) return lx - ly;
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  });

  return { account: sorted[0], layer: 'load', bindingState };
}

/**
 * Errors that are about OUR configuration or capability, not the account's
 * behaviour. They carry no HTTP status, so without this list they would fall
 * through to the `transport` class and park a perfectly healthy account — and
 * because they fail identically on every account, doing so burns the whole pool
 * for a problem no cooldown can fix.
 */
export const CONFIG_ERROR_CODES = new Set([
  'POOL_NO_CREDENTIAL',
  'POOL_UNSUPPORTED_CONTENT',
  'POOL_NO_UPSTREAM',
  'POOL_GEMINI_PROJECT_REQUIRED',
  'POOL_CODEX_ACCOUNT_REQUIRED',
]);

/**
 * The failure policy as DATA, not as branches.
 *
 * Borrowed from new-api, which makes this table operator-configurable
 * (`ShouldDisableByStatusCode` / `ShouldRetryByStatusCode` /
 * `AutomaticDisableKeywords`, plus global on/off switches) instead of hardcoding
 * it. The defaults below reproduce this plugin's original hardcoded behaviour
 * exactly, so adopting the shape changes nothing until someone edits it.
 *
 * `match` entries are either an exact status or a class pattern like `'5xx'`.
 * `keywordRules` defaults to EMPTY on purpose: matching on error text is how
 * pools get walked into cooldown by an unrelated upstream wording change, so it
 * is opt-in rather than a default.
 */
export const DEFAULT_FAILURE_POLICY = {
  /** Checked before anything else: our own faults never touch account state. */
  configErrorCodes: [...CONFIG_ERROR_CODES],
  /** 429 with a hint cooldowns to the hint; without one, to the default window. */
  statusRules: [
    { match: [429], kind: 'rate-limit' },
    { match: [401, 403], kind: 'auth-fail' },
    { match: ['5xx'], kind: 'overload' },
    { match: [400, 413, 422], kind: 'none', reason: 'client-error' },
  ],
  /** Opt-in substring rules, lowercased and matched against the message. */
  keywordRules: [],
};

/** Whether `status` satisfies one policy matcher (an exact number or `'5xx'`). */
export function matchesStatus(status, matcher) {
  if (typeof matcher === 'number') return status === matcher;
  if (typeof matcher === 'string' && /^[1-5]xx$/i.test(matcher)) {
    return Math.floor(status / 100) === Number(matcher[0]);
  }
  return false;
}

/**
 * Map one upstream failure to a cooldown decision.
 *
 * The load-bearing rule here is the `none` class. sub2api carries explicit
 * comments about preventing pool-wide cascade cooling: a malformed request
 * (400/413/422) is the CLIENT's fault and must never be charged to the account,
 * or one oversized prompt walks the whole pool into cooldown. Aborts and our own
 * configuration errors are likewise not the account's fault.
 *
 * @param policy - override the table; defaults to {@link DEFAULT_FAILURE_POLICY}.
 * @returns a decision descriptor; `kind: 'none'` means "change nothing".
 */
export function classifyFailure(failure, account, now, policy = DEFAULT_FAILURE_POLICY) {
  const status = failure?.status;
  const code = typeof failure?.code === 'string' ? failure.code : '';

  if ((policy.configErrorCodes ?? []).includes(code)) return { kind: 'none', reason: 'configuration' };
  if (code === 'aborted' || code === 'abort' || code === 'ABORTED') return { kind: 'none', reason: 'aborted' };

  if (typeof status === 'number') {
    for (const rule of policy.statusRules ?? []) {
      if (!(rule.match ?? []).some((matcher) => matchesStatus(status, matcher))) continue;
      if (rule.kind === 'none') return { kind: 'none', reason: rule.reason ?? 'policy' };
      if (rule.kind === 'rate-limit') {
        const hint = Number.isFinite(failure?.providerRetryAfterMs) && failure.providerRetryAfterMs > 0
          ? failure.providerRetryAfterMs
          : DURATIONS.rateLimitDefaultMs;
        return { kind: 'rate-limit', field: 'rateLimitResetAt', untilMs: now + hint, escalates: false, reason: 'status' };
      }
      if (rule.kind === 'auth-fail') {
        return { kind: 'auth-fail', field: 'tempUnschedulableUntil', untilMs: now + DURATIONS.authFailMs, escalates: true, reason: 'status' };
      }
      if (rule.kind === 'overload') {
        const tier = Math.min(account?.consecutiveFailures ?? 0, DURATIONS.overloadLadderMs.length - 1);
        return { kind: 'overload', field: 'overloadUntil', untilMs: now + DURATIONS.overloadLadderMs[tier], escalates: true, reason: 'status' };
      }
    }
  }

  // Text matching is opt-in and runs only after the status table declines.
  const message = typeof failure?.message === 'string' ? failure.message.toLowerCase() : '';
  for (const rule of policy.keywordRules ?? []) {
    if (message === '') break;
    if (!(rule.keywords ?? []).some((keyword) => message.includes(String(keyword).toLowerCase()))) continue;
    if (rule.kind === 'none') return { kind: 'none', reason: rule.reason ?? 'keyword' };
    if (rule.kind === 'rate-limit') {
      return { kind: 'rate-limit', field: 'rateLimitResetAt', untilMs: now + DURATIONS.rateLimitDefaultMs, escalates: false, reason: 'keyword' };
    }
    if (rule.kind === 'auth-fail') {
      return { kind: 'auth-fail', field: 'tempUnschedulableUntil', untilMs: now + DURATIONS.authFailMs, escalates: true, reason: 'keyword' };
    }
    if (rule.kind === 'overload') {
      const tier = Math.min(account?.consecutiveFailures ?? 0, DURATIONS.overloadLadderMs.length - 1);
      return { kind: 'overload', field: 'overloadUntil', untilMs: now + DURATIONS.overloadLadderMs[tier], escalates: true, reason: 'keyword' };
    }
  }

  if (status === undefined || status === null) {
    return { kind: 'transport', field: 'tempUnschedulableUntil', untilMs: now + DURATIONS.transportMs, escalates: true, reason: 'no-status' };
  }

  // Remaining 4xx (404, 405, 409, …): recorded in usage, never charged to the account.
  return { kind: 'none', reason: 'other-client-error' };
}

/**
 * Apply a cooldown decision, returning a NEW account record.
 *
 * For `kind: 'none'` the SAME object reference is returned — the caller (and
 * the test suite) can use identity to assert that nothing was written.
 */
export function applyCooldown(account, decision, now) {
  if (decision === undefined || decision.kind === 'none') return account;

  const next = { ...account };
  next[decision.field] = formatTs(decision.untilMs);
  next.updatedAt = formatTs(now);

  if (decision.escalates === true) {
    next.consecutiveFailures = (account.consecutiveFailures ?? 0) + 1;
  }

  if (decision.kind === 'auth-fail') {
    next.tempUnschedulableReason = 'auth-fail';
    if (next.consecutiveFailures >= DURATIONS.authFailuresToDisable) {
      next.status = 'error';
      next.errorMessage = `authentication failed ${next.consecutiveFailures} times consecutively`;
    }
  } else if (decision.kind === 'transport') {
    next.tempUnschedulableReason = 'transport';
  } else if (decision.kind === 'overload') {
    next.tempUnschedulableReason = 'overload';
  } else if (decision.kind === 'rate-limit') {
    next.tempUnschedulableReason = 'rate-limit';
  }

  return next;
}

/**
 * Apply a success: clear the transient windows and the failure streak.
 *
 * `rateLimitResetAt` is deliberately NOT cleared — that timestamp belongs to the
 * upstream's own quota window, and a single success does not refill it.
 */
export function applySuccess(account, now) {
  return {
    ...account,
    consecutiveFailures: 0,
    overloadUntil: null,
    tempUnschedulableUntil: null,
    tempUnschedulableReason: '',
    lastUsedAt: formatTs(now),
    updatedAt: formatTs(now),
  };
}

/** Fold a `StreamChunk.usage` into a usage accumulator. Missing fields stay 0. */
export function accumulateUsage(totals, usage) {
  const out = totals ?? {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
  };
  if (usage === undefined || usage === null) return out;
  const add = (key) => {
    const value = usage[key];
    if (Number.isFinite(value) && value > 0) out[key] = (out[key] ?? 0) + value;
  };
  add('inputTokens');
  add('outputTokens');
  add('cacheReadTokens');
  add('cacheWriteTokens');
  add('reasoningTokens');
  return out;
}

// --------------------------------------------------------------- operator actions

/** Actions the management surface may apply to one account. */
export const ACCOUNT_ACTIONS = ['enable', 'disable', 'pause-scheduling', 'resume-scheduling', 'reset-error', 'prefer', 'clear-cooldown', 'set-priority', 'set-mimicry'];

/**
 * Apply one operator action, returning a NEW account record.
 *
 * The actions are deliberately orthogonal — `enable` does NOT also clear a
 * cooling window, because a window is the upstream's statement about its own
 * quota and only time (or an explicit `clear-cooldown`) should lift it. Merging
 * the two would make "re-enable this account" silently override a real rate
 * limit, which is exactly the kind of quiet overreach that gets accounts banned.
 *
 * @param account - the current record.
 * @param action - one of {@link ACCOUNT_ACTIONS}.
 * @param options.now - epoch ms for the stamp.
 * @param options.allAccounts - sibling records; `prefer` needs them to win the ranking.
 * @param options.priority - required by `set-priority`.
 * @throws {RangeError} on an unknown action or a non-integer priority.
 */
export function applyAccountAction(account, action, options = {}) {
  const now = options.now ?? Date.now();
  const stamp = formatTs(now);

  switch (action) {
    case 'enable':
      return { ...account, status: 'active', schedulable: true, errorMessage: '', updatedAt: stamp };

    case 'disable':
      return { ...account, status: 'disabled', schedulable: false, updatedAt: stamp };

    case 'pause-scheduling':
      return { ...account, schedulable: false, updatedAt: stamp };

    case 'resume-scheduling':
      return { ...account, schedulable: true, updatedAt: stamp };

    case 'reset-error':
      return {
        ...account,
        status: account.status === 'error' ? 'active' : account.status,
        errorMessage: '',
        consecutiveFailures: 0,
        updatedAt: stamp,
      };

    case 'prefer': {
      // Strictly below every sibling, so `prefer` always wins the priority key
      // outright rather than tying and falling through to the load ratio.
      const siblings = (options.allAccounts ?? []).filter((other) => other.id !== account.id);
      const lowest = siblings.reduce(
        (best, other) => (Number.isFinite(other.priority) ? Math.min(best, other.priority) : best),
        Number.POSITIVE_INFINITY,
      );
      return { ...account, priority: Number.isFinite(lowest) ? lowest - 1 : 0, updatedAt: stamp };
    }

    case 'clear-cooldown':
      return {
        ...account,
        rateLimitResetAt: null,
        overloadUntil: null,
        tempUnschedulableUntil: null,
        tempUnschedulableReason: '',
        consecutiveFailures: 0,
        // A previously hard-failed account is only resurrectable by an explicit act.
        status: account.status === 'error' ? 'active' : account.status,
        errorMessage: account.status === 'error' ? '' : account.errorMessage,
        updatedAt: stamp,
      };

    case 'set-priority':
      if (!Number.isInteger(options.priority)) {
        throw new RangeError(`set-priority needs an integer priority, got ${String(options.priority)}`);
      }
      return { ...account, priority: options.priority, updatedAt: stamp };

    /**
     * Turn the Claude Code disguise on or off for one account.
     *
     * Orthogonal like the rest: it changes the disguise and NOTHING else. It does
     * not flip `authMode` (which credential type this account holds is a fact, not
     * a preference) and it does not touch cooling windows.
     */
    case 'set-mimicry':
      if (!MIMICRY_MODES.includes(options.mimicry)) {
        throw new RangeError(`set-mimicry needs one of ${MIMICRY_MODES.join(', ')}, got ${String(options.mimicry)}`);
      }
      return { ...account, mimicry: options.mimicry, updatedAt: stamp };

    default:
      throw new RangeError(`unknown account action '${String(action)}'`);
  }
}
