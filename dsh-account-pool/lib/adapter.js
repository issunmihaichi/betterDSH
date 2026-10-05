/**
 * Account-pool adapter — the failover loop that turns the kernel into an
 * `LlmAdapter`-shaped provider.
 *
 * Like the kernel, this module imports NOTHING from DSH. The upstream call is
 * injected (`upstream.stream(account, options)`), so the entire selection +
 * cooldown + failover path runs offline against a fake upstream.
 *
 * Concurrency bookkeeping and the sticky-binding table are held in memory as the
 * authoritative snapshot, with write-through persistence to the domain tables.
 * This mirrors sub2api's design (Redis scheduler snapshot + durable outbox)
 * without the cluster machinery: reads must be synchronous to keep the kernel
 * pure, so writes are fire-and-forget.
 */

import {
  DURATIONS,
  accumulateUsage,
  activeBinding,
  applyCooldown,
  applySuccess,
  classifyFailure,
  formatTs,
  makeBinding,
  selectCandidate,
} from './kernel.js';

/** Error raised when no account can serve the request. */
export class PoolExhaustedError extends Error {
  constructor(message, { attempts = [], switches = 0, lastFailure } = {}) {
    super(message);
    this.name = 'PoolExhaustedError';
    this.code = 'POOL_EXHAUSTED';
    this.attempts = attempts;
    this.switches = switches;
    if (lastFailure !== undefined) this.cause = lastFailure;
  }
}

/** A terminal `finish` chunk carrying an error is still a failure. */
function failureOfFinish(reason) {
  if (reason === undefined || reason === null) return undefined;
  if (reason.kind !== 'error' && reason.kind !== 'aborted') return undefined;
  if (reason.failure !== undefined) return reason.failure;
  const error = new Error(`upstream stream ended with a terminal ${reason.kind} finish`);
  error.code = reason.kind;
  return error;
}

/**
 * Build the adapter.
 *
 * @param options.initialAccounts - account records to seed the snapshot with.
 * @param options.initialBindings - sticky bindings to seed the snapshot with.
 * @param options.persist - `{ putAccount, putBinding, deleteBinding }`; all optional, all may be async.
 * @param options.upstream - `{ stream(account, options) }` returning an async iterable of StreamChunk.
 * @param options.clock - `{ now() }`; injectable so tests drive time deterministically.
 * @param options.maxSwitches - account switches allowed per request.
 * @param options.onUsage - called once per request with the folded usage record.
 * @param options.onCooldown - called after a cooldown is written (diagnostics/tests).
 */
/** The provider route that means "every account". */
export const DEFAULT_PROVIDER = 'pool';

/**
 * Each group gets its OWN provider route.
 *
 * That is what makes a group switchable rather than merely a data field: the
 * route shows up in the model provider list, so choosing a group is the same
 * gesture as choosing any other provider. new-api binds a group to a token and
 * sub2api binds it to an API key; DSH's equivalent binding point is the route.
 */
export function providerRouteForGroup(groupId) {
  return `${DEFAULT_PROVIDER}-${String(groupId)}`;
}

/** Reverse {@link providerRouteForGroup}; `undefined` means the default pool. */
export function groupOfProvider(provider) {
  if (typeof provider !== 'string' || provider === '' || provider === DEFAULT_PROVIDER) return undefined;
  const prefix = `${DEFAULT_PROVIDER}-`;
  if (!provider.startsWith(prefix)) return undefined;
  const id = provider.slice(prefix.length);
  return id === '' ? undefined : id;
}

/** Whether a group's own allow-list admits a model. An empty list admits everything. */
export function groupSupportsModel(group, model) {
  const list = group?.models;
  if (!Array.isArray(list) || list.length === 0) return true;
  if (typeof model !== 'string' || model === '') return true;
  return list.includes(model);
}

/**
 * Whether an account belongs to a group.
 *
 * An EMPTY `groups` list means "the default pool only". If it meant every group,
 * creating a group would silently adopt every existing account and a group could
 * never be a deliberate subset.
 */
export function accountInGroup(account, groupId) {
  return Array.isArray(account?.groups) && account.groups.includes(groupId);
}

export function createPoolAdapter({
  initialAccounts = [],
  initialBindings = [],
  initialGroups = [],
  persist = {},
  upstream,
  clock = { now: () => Date.now() },
  maxSwitches = DURATIONS.maxAccountSwitches,
  onUsage = () => {},
  onCooldown = () => {},
  providerName = 'pool',
  providerDisplayName = 'Account Pool',
  models = [],
  defaultContextWindow = 200_000,
  /** Selection mode forwarded to the kernel; see `selectCandidate`. */
  selectionMode = 'load-aware',
  /** Failure policy forwarded to the kernel; see `classifyFailure`. */
  failurePolicy,
  /** Injectable randomness, so weight distribution is testable. */
  random = Math.random,
} = {}) {
  // The transport is optional at construction: without it the adapter is still a
  // useful management projection (list accounts, sweep bindings, apply edits),
  // and only an actual model call is impossible. Validated when provided.
  if (upstream !== undefined && typeof upstream.stream !== 'function') {
    throw new TypeError('createPoolAdapter: `upstream.stream` must be a function when `upstream` is provided');
  }

  const accounts = new Map();
  for (const account of initialAccounts) accounts.set(account.id, account);

  const bindings = new Map();
  for (const binding of initialBindings) bindings.set(binding.sessionHash, binding);

  const groups = new Map();
  for (const group of initialGroups) groups.set(group.id, group);

  /**
   * The candidate set for one request.
   *
   * Group filtering happens HERE, on the candidate list, instead of inside the
   * kernel: selection, cooling, stickiness, weighting and failover then apply to
   * a group for free, and `kernel.js` needs no knowledge of groups at all.
   *
   * A request for an unknown group yields NO candidates rather than falling back
   * to the whole pool — silently serving a group that does not exist would hide a
   * misconfiguration behind plausible-looking traffic.
   */
  function candidatesFor(provider, model) {
    const all = [...accounts.values()];
    const groupId = groupOfProvider(provider);
    if (groupId === undefined) return all;
    const group = groups.get(groupId);
    if (group === undefined) return [];
    return all.filter((account) => accountInGroup(account, groupId) && groupSupportsModel(group, model));
  }

  const inflight = new Map();

  /** Fire-and-forget write-through; a persistence failure must not break a request. */
  function persistCall(method, ...args) {
    const fn = persist[method];
    if (typeof fn !== 'function') return;
    try {
      Promise.resolve(fn(...args)).catch(() => { /* reported by the host half */ });
    } catch { /* a synchronous throw from a bad store must not kill the request */ }
  }

  function writeAccount(account) {
    accounts.set(account.id, account);
    persistCall('putAccount', account);
  }

  function writeBinding(binding) {
    bindings.set(binding.sessionHash, binding);
    persistCall('putBinding', binding);
  }

  function dropBinding(sessionHash) {
    if (!bindings.has(sessionHash)) return;
    bindings.delete(sessionHash);
    persistCall('deleteBinding', sessionHash);
  }

  function acquire(accountId) {
    inflight.set(accountId, (inflight.get(accountId) ?? 0) + 1);
  }

  function release(accountId) {
    const next = (inflight.get(accountId) ?? 0) - 1;
    if (next <= 0) inflight.delete(accountId);
    else inflight.set(accountId, next);
  }

  /**
   * Stream one model call through the pool.
   *
   * Loop shape: select → acquire slot → proxy chunks → on success bind and stop.
   * A failure the account owns cools it, drops its sticky binding, excludes it,
   * and tries again. A failure the account must NOT own is rethrown without
   * touching pool state.
   *
   * COMMITMENT RULE: failover is only possible while nothing has been yielded to
   * the consumer. Once a chunk has been forwarded, a second attempt would
   * duplicate output, so the failure propagates (after the cooldown is still
   * recorded — the account did fail, the request just cannot be rescued).
   */
  async function* stream(options = {}) {
    if (upstream === undefined) {
      const error = new Error('account pool has no upstream transport configured (management-only mode)');
      error.code = 'POOL_NO_UPSTREAM';
      throw error;
    }
    const sessionHash = typeof options?.sessionId === 'string' ? options.sessionId : '';
    const requestedModel = options?.model;
    const excluded = new Set();
    const attempts = [];
    let switches = 0;
    let lastFailure;

    for (;;) {
      const now = clock.now();
      const selection = selectCandidate({
        accounts: candidatesFor(options?.provider, options?.model),
        bindings,
        sessionHash,
        requestedModel,
        excluded,
        now,
        inflight,
        mode: selectionMode,
        random,
      });
      const account = selection.account;

      if (account === undefined) {
        onUsage({
          accountId: attempts.at(-1)?.accountId ?? '',
          sessionId: sessionHash,
          platform: attempts.at(-1)?.platform ?? '',
          model: requestedModel ?? '',
          usage: null,
          switches,
          ok: false,
          errorCode: 'POOL_EXHAUSTED',
        });
        throw new PoolExhaustedError(
          attempts.length === 0
            ? 'account pool has no schedulable account'
            : `account pool exhausted after ${attempts.length} attempt(s)`,
          { attempts, switches, lastFailure },
        );
      }

      acquire(account.id);
      let attemptUsage = null;
      let committed = false;
      try {
        for await (const chunk of upstream.stream(account, options)) {
          if (chunk?.type === 'usage') attemptUsage = accumulateUsage(attemptUsage, chunk.usage);
          if (chunk?.type === 'finish') {
            const terminal = failureOfFinish(chunk.reason);
            // Checked BEFORE forwarding: an error finish is a failure, not a result.
            if (terminal !== undefined) throw terminal;
          }
          committed = true;
          yield chunk;
        }
      } catch (failure) {
        const failedAt = clock.now();
        const decision = classifyFailure(failure, account, failedAt, failurePolicy);

        if (decision.kind !== 'none') {
          const cooled = applyCooldown(account, decision, failedAt);
          writeAccount(cooled);
          // A cooled account is no longer schedulable, so a sticky binding that
          // points at it must go — otherwise sessions would keep retrying it.
          // (A capacity-only skip does NOT drop the binding; see selectCandidate.)
          const bound = activeBinding(bindings, sessionHash, failedAt);
          if (bound !== undefined && bound.accountId === account.id) dropBinding(sessionHash);
          onCooldown({ account: cooled, decision, attempt: attempts.length + 1 });
          excluded.add(account.id);
        }

        attempts.push({
          accountId: account.id,
          platform: account.platform,
          outcome: decision.kind === 'none' ? 'passthrough' : decision.kind,
          errorCode: String(failure?.code ?? ''),
        });
        lastFailure = failure;

        const retryable = decision.kind !== 'none' && committed === false && switches < maxSwitches;
        if (!retryable) {
          onUsage({
            accountId: account.id,
            sessionId: sessionHash,
            platform: account.platform,
            model: requestedModel ?? '',
            usage: attemptUsage,
            switches,
            ok: false,
            errorCode: String(failure?.code ?? ''),
          });
          throw failure;
        }

        switches += 1;
        continue;
      } finally {
        release(account.id);
      }

      // Success path.
      const doneAt = clock.now();
      writeAccount(applySuccess(accounts.get(account.id) ?? account, doneAt));
      if (sessionHash !== '' && selection.bindingState !== 'hit') {
        writeBinding(makeBinding(sessionHash, account, doneAt));
      }
      attempts.push({ accountId: account.id, platform: account.platform, outcome: 'ok' });
      onUsage({
        accountId: account.id,
        sessionId: sessionHash,
        platform: account.platform,
        model: requestedModel ?? '',
        usage: attemptUsage,
        switches,
        ok: true,
        errorCode: '',
      });
      return;
    }
  }

  return {
    // --- LlmAdapter surface -------------------------------------------------
    providerInfo(provider) {
      return { id: provider ?? providerName, name: providerDisplayName };
    },
    providerRetryPolicy() {
      // The pool owns failover; the agent loop must not also retry, or one lost
      // request would consume several accounts.
      return { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 };
    },
    async listModels() {
      return models.map((id) => ({ provider: providerName, id, name: id }));
    },
    async resolveModel(provider, model) {
      return {
        provider: provider ?? providerName,
        id: model,
        name: model,
        context: { contextWindow: defaultContextWindow },
      };
    },
    stream,

    // --- projection for the host half and tests -----------------------------
    /** Seed/replace the snapshot (host uses this when the domain opens). */
    setAccounts(next) {
      accounts.clear();
      for (const account of next) accounts.set(account.id, account);
    },
    setBindings(next) {
      bindings.clear();
      for (const binding of next) bindings.set(binding.sessionHash, binding);
    },
    /** Replace one account in the snapshot (host: manual admin edit). */
    upsertAccount(account) {
      writeAccount({ ...account, updatedAt: formatTs(clock.now()) });
    },
    /**
     * Remove one account (operator delete).
     *
     * Bindings pointing at it are swept: leaving them would let a session keep
     * sticking to an account that no longer exists — exactly what `pruneBindings`
     * already implements.
     *
     * @returns true when an account was removed.
     */
    // --- groups -------------------------------------------------------------
    listGroups() {
      return [...groups.values()];
    },
    getGroup(id) {
      return groups.get(id);
    },
    /** Seed/replace the group registry (host: when the domain opens). */
    setGroups(next) {
      groups.clear();
      for (const group of next) groups.set(group.id, group);
    },
    upsertGroup(group) {
      groups.set(group.id, group);
      persistCall('putGroup', group);
    },
    /**
     * Remove a group and detach it from every account.
     *
     * Accounts survive — a group is a VIEW over accounts, never their owner. The
     * id is stripped from each account because a dangling id can only mislead,
     * and would silently re-attach if the same id were created again later.
     *
     * @returns the ids of the accounts that were edited.
     */
    removeGroup(id) {
      if (!groups.has(id)) return [];
      groups.delete(id);
      persistCall('deleteGroup', id);
      const touched = [];
      for (const account of [...accounts.values()]) {
        if (!accountInGroup(account, id)) continue;
        writeAccount({
          ...account,
          groups: account.groups.filter((entry) => entry !== id),
          updatedAt: formatTs(clock.now()),
        });
        touched.push(account.id);
      }
      return touched;
    },
    /** The provider routes this registry implies: the default pool, plus one per group. */
    routesFor() {
      return [DEFAULT_PROVIDER, ...[...groups.keys()].map(providerRouteForGroup)];
    },
    removeAccount(id) {
      if (!accounts.has(id)) return false;
      accounts.delete(id);
      persistCall('deleteAccount', id);
      pruneBindings();
      return true;
    },
    getAccount(id) {
      return accounts.get(id);
    },
    listAccounts() {
      return [...accounts.values()];
    },
    getBinding(sessionHash) {
      return bindings.get(sessionHash);
    },
    listBindings() {
      return [...bindings.values()];
    },
    inflightSnapshot() {
      return new Map(inflight);
    },
    /** Drop every binding whose account is missing or whose stamp has expired. */
    pruneBindings() {
      const now = clock.now();
      for (const binding of [...bindings.values()]) {
        const account = accounts.get(binding.accountId);
        if (account === undefined || activeBinding(bindings, binding.sessionHash, now) === undefined) {
          dropBinding(binding.sessionHash);
        }
      }
    },
  };
}
