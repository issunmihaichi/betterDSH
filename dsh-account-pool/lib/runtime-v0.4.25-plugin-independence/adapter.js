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

import { createHash } from 'node:crypto';
import { carryPoolFailure, requestRetryConfig, streamWithRequestRetry, waitForRequestRetry } from './retry.js';
import { isPoolDetectionRetryError, matchesPoolDetection, streamWithPoolDetection, waitForPoolDetection } from './detection.js';
import {
  DURATIONS,
  accumulateUsage,
  activeBinding,
  applyCooldown,
  applySuccess,
  classifyFailure,
  formatTs,
  hasCapacity,
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
    carryPoolFailure(this, { source: lastFailure });
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

/** The flat key for one (account, group) priority entry. */
export function priorityKey(accountId, groupId) {
  return `${String(accountId)}|${String(groupId)}`;
}

/**
 * The legacy superset of thinking-effort ids understood by this pool.
 * resolveModel narrows it to the intersection supported by the route's model owners.
 *
 * DSH validates a REQUESTED effort against the adapter's own metadata and rejects
 * the call BEFORE any provider I/O when the model declares none
 * (`UNSUPPORTED_REASONING_EFFORT`). That is not a rare path: a profile's
 * `agent-default-model` carries an effort (`reasoningEffort: max` in this one), the
 * agent loop passes it down for the whole session, and switching that session to a
 * pool model then failed EVERY turn with zero tokens and zero session events —
 * which reads as "the session cannot start" rather than as a capability error.
 * Declaring the levels is what makes the pool callable at all.
 *
 * The ids and the `name` spelling (`off` → `Off`) are DSH's own vocabulary
 * (`dsh-llm-pi-ai`'s `THINKING_LEVELS`, in escalation order), so the pool's effort
 * control looks like every other provider's instead of inventing a private scale.
 *
 * What it does NOT claim: that every upstream encodes the level. The Anthropic
 * Messages dialect has no effort field at all, so there the model keeps its own
 * thinking policy and the level is advisory; an OpenAI-compatible account does get
 * it as `reasoning_effort`. No `defaultEffort` is declared on purpose — with one,
 * DSH would inject it into calls that named no effort and persist it as an adapter
 * default, changing requests the operator never asked to change.
 */
export const POOL_REASONING_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  .map((level) => ({ id: level, name: `${level.charAt(0).toUpperCase()}${level.slice(1)}` }));

/**
 * The output budget the pool asks for when a call does not name one.
 *
 * 4096 — the transport's own fallback — truncates ordinary agent turns: one tool
 * call plus the model's thinking can spend the whole budget before any visible text
 * appears. Declared on the MODEL rather than only as the transport fallback because
 * that is the field DSH reads: `resolveCallWithInfo` materializes
 * `info.defaultMaxTokens` into the call config and marks it an adapter default, so
 * the value is re-derived on every request instead of being persisted as a choice
 * the operator never made.
 *
 * 64000 is what DSH's own model catalog uses for 1M-context Claude models, and this
 * upstream accepted every ceiling tried up to 100000. A budget is a ceiling, not a
 * spend: tokens are billed only when generated. `host.js` hands the same number to
 * the transport, so a direct `stream()` call and a DSH turn agree.
 */
export const POOL_DEFAULT_MAX_TOKENS = 64000;

export function createPoolAdapter({
  initialAccounts = [],
  initialBindings = [],
  initialGroups = [],
  initialPriorities = [],
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
  modelOverridesFor = () => ({}),
  contextWindowFor = () => defaultContextWindow,
  /** Selection mode forwarded to the kernel; see `selectCandidate`. */
  selectionMode = 'load-aware',
  /** Failure policy forwarded to the kernel; see `classifyFailure`. */
  failurePolicy,
  /** Injectable randomness, so weight distribution is testable. */
  random = Math.random,
  /** Injectable abort-aware retry wait; owns no account state. */
  detectionWait = waitForPoolDetection,
  requestRetries,
  requestRetryDelayMs,
  requestRetryMaxDelayMs,
  retryWait = waitForRequestRetry,
  onRetry = () => {},
} = {}) {
  const retryConfig = requestRetryConfig({ requestRetries, requestRetryDelayMs, requestRetryMaxDelayMs });
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

  /** (account × group) priority overrides, keyed `accountId|groupId`. */
  const priorities = new Map();
  for (const entry of initialPriorities) priorities.set(priorityKey(entry.accountId, entry.groupId), entry);

  /**
   * Project accounts onto the pool they are being selected FOR.
   *
   * A per-(account, group) priority replaces the account's own `priority` on the
   * COPY handed to the kernel, so `kernel.js` still knows nothing about groups: it
   * simply reads a number that means "how this account ranks in this pool". That is
   * the whole trick — the relation is resolved before selection, not inside it.
   */
  function projectForPool(list, groupId) {
    if (groupId === undefined) return list;
    return list.map((account) => {
      const override = priorities.get(priorityKey(account.id, groupId));
      return override === undefined ? account : { ...account, priority: override.priority };
    });
  }

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
    // The default `pool` route IS the whole pool. It used to be narrowed to a group
    // flagged "preferred"; that concept is gone (DESIGN.md §27), so the default
    // route covers every account and a group is reached only by naming it
    // (`pool-<id>`).
    if (groupId === undefined) return all;
    const group = groups.get(groupId);
    if (group === undefined || group.enabled === false) return [];
    return projectForPool(
      all.filter((account) => accountInGroup(account, groupId) && groupSupportsModel(group, model)),
      groupId,
    );
  }

  /** One detached capability snapshot shared by metadata and its prepared call. */
  function modelCapability(provider, model, candidateOverrides, exactOwners) {
    const route = provider ?? providerName;
    const overrides = candidateOverrides ?? modelOverridesFor(route);
    const source = overrides && typeof overrides === 'object' && Object.hasOwn(overrides, model) ? overrides[model] : undefined;
    const override = source && typeof source === 'object' ? source : {};
    const owners = (exactOwners ?? candidatesFor(route, model)).filter((account) => !(account.models?.length) || account.models.includes(model));
    const nativeOwner = (account) => account.platform === 'gemini' || (account.platform === 'openai' && account.authMode === 'oauth');
    const supportsImage = owners.length > 0 && owners.every(nativeOwner);
    const nativeEfforts = (account) => nativeOwner(account) || account.openaiApi === 'responses';
    // Codex has a concrete image transport; advertise it without requiring a manual override.
    const codexImages = owners.length > 0 && owners.every((account) => account.platform === 'openai' && account.authMode === 'oauth');
    const input = Array.isArray(override.input) ? [...new Set(override.input.filter((value) => value === 'text' || value === 'image' && supportsImage))] : codexImages ? ['text', 'image'] : ['text'];
    const contextWindow = Number.isSafeInteger(override.contextWindow) && override.contextWindow > 0 ? override.contextWindow : contextWindowFor();
    const configured = override.reasoningEfforts;
    let effortMap;
    let efforts = POOL_REASONING_EFFORTS.filter((effort) => owners.every((account) => !nativeEfforts(account) || effort.id !== 'max'));
    if (configured === false) {
      efforts = [];
      effortMap = {};
    } else if (configured && typeof configured === 'object' && !Array.isArray(configured)) {
      effortMap = {};
      efforts = POOL_REASONING_EFFORTS.filter(({ id }) => {
        if (!Object.hasOwn(configured, id)) return false;
        const mapped = configured[id];
        if (mapped === null || mapped === '') {
          if (id !== 'off') return false;
          effortMap[id] = null;
          return true;
        }
        if (typeof mapped !== 'string' || !mapped.trim()) return false;
        const value = mapped.trim();
        if (!owners.every((account) => !nativeEfforts(account) || POOL_REASONING_EFFORTS.some((effort) => effort.id === value && effort.id !== 'max'))) return false;
        effortMap[id] = value;
        return true;
      });
    }
    const info = {
      provider: route, id: model,
      name: typeof override.name === 'string' && override.name.trim() ? override.name : model,
      context: { contextWindow: Number.isSafeInteger(contextWindow) && contextWindow > 0 ? contextWindow : 200_000 },
      inputModalities: input.length ? input : ['text'],
      defaultMaxTokens: POOL_DEFAULT_MAX_TOKENS,
      ...(owners.length && efforts.length ? { reasoning: { efforts: efforts.map((effort) => ({ ...effort })) } } : {}),
    };
    return { info, effortMap };
  }

  function mappedCallOptions(request, effortMap) {
    if (effortMap === undefined || request.reasoningEffort === undefined) return request;
    const next = { ...request };
    const mapped = effortMap[request.reasoningEffort];
    if (mapped === undefined || mapped === null || mapped === '') delete next.reasoningEffort;
    else next.reasoningEffort = mapped;
    return next;
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
  async function* stream(options = {}, capability = modelCapability(options.provider, options.model)) {
    options = mappedCallOptions(options, capability.effortMap);
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
      options.signal?.throwIfAborted();
      const now = clock.now();
      const groupMode = groups.get(groupOfProvider(options?.provider))?.selectionMode ?? 'sticky';
      const useSticky = groupMode === 'sticky';
      const selection = selectCandidate({
        accounts: candidatesFor(options?.provider, options?.model),
        bindings,
        sessionHash,
        requestedModel,
        excluded,
        now,
        inflight,
        mode: useSticky ? selectionMode : groupMode,
        useSticky,
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
        const getAccount = () => accounts.get(account.id);
        const canRetry = (latest) => {
          // This request retains one concurrency slot throughout its retries.
          const occupied = new Map(inflight);
          occupied.set(account.id, Math.max(0, (occupied.get(account.id) ?? 0) - 1));
          return selectCandidate({
            accounts: candidatesFor(options.provider, requestedModel).filter(row => row.id === latest.id),
            bindings: new Map(), sessionHash: '', requestedModel, excluded: new Set(),
            now: clock.now(), inflight: occupied, useSticky: false,
          }).account !== undefined;
        };
        const detectingUpstream = {
          stream: (row, request) => streamWithPoolDetection(upstream, row, request, {
            getAccount, canRetry, wait: detectionWait,
          }),
        };
        for await (const chunk of streamWithRequestRetry(detectingUpstream, account, options, {
          getAccount, canRetry, config: retryConfig, failurePolicy, wait: retryWait, onRetry,
          canRetryRateLimit: () => selectCandidate({
            accounts: candidatesFor(options.provider, requestedModel), bindings, sessionHash, requestedModel,
            excluded: new Set([...excluded, account.id]), now: clock.now(), inflight, useSticky: false,
          }).account === undefined,
        })) {
          options.signal?.throwIfAborted();
          if (chunk?.type === 'usage') attemptUsage = accumulateUsage(attemptUsage, chunk.usage);
          if (chunk?.type === 'finish') {
            const terminal = failureOfFinish(chunk.reason);
            // Checked BEFORE forwarding: an error finish is a failure, not a result.
            if (terminal !== undefined) throw terminal;
          }
          committed = true;
          yield chunk;
        }
        options.signal?.throwIfAborted();
      } catch (failure) {
        const failedAt = clock.now();
        const detection = isPoolDetectionRetryError(failure) || matchesPoolDetection(failure, account);
        const decision = options.signal?.aborted || failure?.name === 'AbortError' || detection
          ? { kind: 'none', reason: detection ? 'pool-detection' : 'abort' }
          : classifyFailure(failure, accounts.get(account.id) ?? account, failedAt, failurePolicy);

        if (decision.kind !== 'none') {
          const latest = accounts.get(account.id);
          const cooled = latest === undefined ? undefined : applyCooldown(latest, decision, failedAt);
          if (cooled !== undefined) writeAccount(cooled);
          // A cooled account is no longer schedulable, so a sticky binding that
          // points at it must go — otherwise sessions would keep retrying it.
          // (A capacity-only skip does NOT drop the binding; see selectCandidate.)
          const bound = activeBinding(bindings, sessionHash, failedAt);
          if (bound !== undefined && bound.accountId === account.id) dropBinding(sessionHash);
          if (cooled !== undefined) onCooldown({ account: cooled, decision, attempt: attempts.length + 1 });
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
          if (options.signal?.aborted || failure?.name === 'AbortError') throw failure;
          throw carryPoolFailure(failure, committed && !isPoolDetectionRetryError(failure) ? { code: 'POOL_PARTIAL_RESPONSE' } : {});
        }

        switches += 1;
        continue;
      } finally {
        release(account.id);
      }

      // Success path.
      const doneAt = clock.now();
      const current = accounts.get(account.id);
      if (current !== undefined) writeAccount(applySuccess(current, doneAt));
      const codexSticky = current?.platform === 'openai' && current.authMode === 'oauth';
      if (current !== undefined && useSticky && sessionHash !== '' && (codexSticky || selection.bindingState !== 'hit')) {
        // A hit is activity, not an old fixed creation deadline. Only Codex gets
        // the longer idle window; explicit non-sticky group policies and all
        // cooldown/capacity/failover rules remain authoritative.
        writeBinding(makeBinding(sessionHash, current, doneAt, codexSticky ? DURATIONS.codexStickyTtlMs : DURATIONS.stickyTtlMs));
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

  // A probe bypasses scheduling state so disabled/error accounts can be diagnosed,
  // but still reserves a concurrency slot and never routes to a different account.
  const probing = new Set();
  async function testAccount(id, { model, timeoutMs = 30_000 } = {}) {
    const account = accounts.get(id);
    if (account === undefined) throw new RangeError('unknown account');
    if (typeof model !== 'string' || model.trim() === '') throw new RangeError('a test needs a model');
    if (probing.has(id) || !hasCapacity(account, inflight)) {
      throw Object.assign(new Error('account is already testing or at capacity'), { code: 'POOL_TEST_BUSY' });
    }
    const startedAt = clock.now();
    const controller = new AbortController();
    probing.add(id);
    acquire(id);
    let timer;
    let attemptUsage = null;
    let failure;
    let received = false;
    let completed = false;
    try {
      await Promise.race([
        (async () => {
          if (upstream === undefined) throw Object.assign(new Error('no upstream'), { code: 'POOL_NO_UPSTREAM' });
          const getAccount = () => accounts.get(id);
          // Probes may start disabled/error accounts for diagnosis, but stop if the
          // operator changes their scheduling state while a retry is waiting.
          const canRetry = latest => latest.status === account.status && latest.schedulable === account.schedulable;
          const detectingUpstream = { stream: (row, request) => streamWithPoolDetection(upstream, row, request, {
            getAccount, canRetry, wait: detectionWait,
          }) };
          for await (const chunk of streamWithRequestRetry(detectingUpstream, account, {
            model, maxTokens: 64, reasoningEffort: 'off',
            messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply OK.' }] }],
            sessionId: `account-pool-test-${id}`, signal: controller.signal,
          }, { getAccount, canRetry, config: retryConfig, failurePolicy, wait: retryWait, onRetry })) {
            if (completed) break;
            if ((chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta') && chunk.text) received = true;
            if (chunk?.type === 'usage') {
              attemptUsage = accumulateUsage(attemptUsage, chunk.usage);
              if (Object.values(attemptUsage).some((value) => value > 0)) received = true;
            }
            if (chunk?.type === 'finish') {
              const terminal = failureOfFinish(chunk.reason);
              if (terminal !== undefined) throw terminal;
            }
          }
          if (!received) throw Object.assign(new Error('empty response'), { code: 'POOL_EMPTY_RESPONSE' });
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            completed = true;
            reject(Object.assign(new Error('test timed out'), { code: 'POOL_TEST_TIMEOUT' }));
            controller.abort();
          }, Math.max(1, Math.min(30_000, timeoutMs)));
        }),
      ]);
    } catch (error) {
      failure = error;
    } finally {
      completed = true;
      clearTimeout(timer);
      controller.abort();
      release(id);
      probing.delete(id);
    }

    const at = clock.now();
    // Never return the raw upstream error, its arbitrary code, or response text.
    const status = Number.isInteger(failure?.status) && failure.status >= 100 && failure.status <= 599
      ? failure.status : undefined;
    const safeCodes = {
      POOL_NO_CREDENTIAL: 'Credential is not configured.',
      POOL_CODEX_ACCOUNT_REQUIRED: 'Set the ChatGPT account ID or use an OAuth credential bundle containing it.',
      POOL_GEMINI_PROJECT_REQUIRED: 'Set the Google project ID or complete Code Assist setup in Gemini CLI.',
      POOL_NO_UPSTREAM: 'Upstream transport is unavailable.',
      POOL_UNSUPPORTED_CONTENT: 'The upstream transport does not support this request.',
      POOL_TEST_TIMEOUT: 'The upstream test timed out.',
      POOL_EMPTY_RESPONSE: 'The upstream returned an empty response.',
      POOL_DETECTION_RETRY_EXHAUSTED: 'Pool detection retry limit reached or the account is no longer available.',
      POOL_DETECTION_PARTIAL_RESPONSE: 'Pool detection interrupted an already started response.',
      aborted: 'The upstream test was aborted.', abort: 'The upstream test was aborted.', ABORTED: 'The upstream test was aborted.',
    };
    const errorCode = failure === undefined ? '' : status !== undefined ? `http-${status}`
      : Object.hasOwn(safeCodes, failure?.code ?? '') ? failure.code : 'POOL_TEST_FAILED';
    const message = failure === undefined ? 'Upstream test succeeded.' : status !== undefined ? `Upstream returned HTTP ${status}.`
      : safeCodes[errorCode] ?? 'The upstream test failed; check connectivity and account configuration.';
    const result = { ok: failure === undefined, at: formatTs(at), model,
      latencyMs: Math.max(0, Math.round(at - startedAt)), errorCode, message,
      ...(status === undefined ? {} : { status }) };
    // Merge onto the latest row: edits made while the request ran must survive,
    // and a deleted account must never be recreated by a finishing probe.
    const current = accounts.get(id);
    if (current !== undefined) {
      let next;
      if (failure === undefined) {
        next = { ...applySuccess(current, at), lastUsedAt: current.lastUsedAt };
      } else {
        const decision = isPoolDetectionRetryError(failure) || matchesPoolDetection(failure, account)
          || failure?.name === 'AbortError'
          ? { kind: 'none', reason: 'pool-detection-or-abort' }
          : classifyFailure(failure, current, at, failurePolicy);
        next = applyCooldown(current, decision, at);
        if (current.status !== 'active') next = { ...next, status: current.status, errorMessage: current.errorMessage };
        if (decision.kind !== 'none') onCooldown({ account: next, decision, attempt: 1 });
      }
      writeAccount({ ...next, lastTestAt: result.at, lastTestOk: result.ok,
        lastTestModel: model, lastTestLatencyMs: result.latencyMs,
        lastTestErrorCode: errorCode, lastTestMessage: message, updatedAt: result.at });
    }
    onUsage({ accountId: id, sessionId: `account-pool-test-${id}`, platform: account.platform,
      model, usage: attemptUsage, switches: 0, ok: result.ok, errorCode });
    return result;
  }

  // Host-only, fixed-account diagnostic capability. Never expose a credential,
  // connection URL, arbitrary request options, or ordinary scheduling/failover.
  function accountProbeKey(account) {
    const keys = ['id', 'createdAt', 'platform', 'authMode', 'credentialRef', 'baseUrl',
      'chatgptAccountId', 'projectId', 'openaiApi', 'openaiTransport', 'mimicry', 'betas', 'models'];
    return createHash('sha256').update(JSON.stringify(keys.map(key => [key, account[key] ?? null]))).digest('hex');
  }
  function describeAccountProbe(id) {
    const account = accounts.get(id);
    if (!account) throw Object.assign(new Error('Account no longer exists.'), { code: 'POOL_TEST_TARGET_CHANGED' });
    return { id, label: account.label || id, platform: account.platform,
      key: accountProbeKey(account), models: [...(account.models ?? [])] };
  }
  function prepareAccountProbe(id, { model, reasoningEffort, maxTokens = 8192 } = {}) {
    const account = accounts.get(id);
    if (!account) throw Object.assign(new Error('Account no longer exists.'), { code: 'POOL_TEST_TARGET_CHANGED' });
    if (typeof model !== 'string' || !model.trim() || model.length > 256) throw new RangeError('A probe needs an exact model.');
    if (account.models?.length && !account.models.includes(model)) throw new RangeError('This account does not allow the selected model.');
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1024 || maxTokens > 32768) throw new RangeError('Invalid probe output budget.');
    const capability = modelCapability(providerName, model, undefined, [account]);
    if (reasoningEffort !== undefined && !capability.info.reasoning?.efforts.some(row => row.id === reasoningEffort)) throw new RangeError('The selected effort is unsupported by this account/model.');
    const target = Object.freeze(describeAccountProbe(id));
    const options = Object.freeze(mappedCallOptions({ model, maxTokens,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }, capability.effortMap));
    function assertTarget() {
      const latest = accounts.get(id);
      if (!latest || accountProbeKey(latest) !== target.key) throw Object.assign(new Error('Account connection changed; start a new test.'), { code: 'POOL_TEST_TARGET_CHANGED' });
      return latest;
    }
    return Object.freeze({ target, selection: Object.freeze({ provider: providerName, model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }),
      async *stream(prompt, signal) {
        signal?.throwIfAborted();
        const latest = assertTarget();
        if (typeof prompt !== 'string' || !prompt || prompt.length > 16384) throw new RangeError('Invalid fixed probe prompt.');
        if (probing.has(id) || !hasCapacity(latest, inflight)) throw Object.assign(new Error('Account is testing or at capacity.'), { code: 'POOL_TEST_BUSY' });
        if (!upstream) throw Object.assign(new Error('Upstream unavailable.'), { code: 'POOL_NO_UPSTREAM' });
        probing.add(id); acquire(id);
        let usage = null, stopped = false, failure;
        try {
          // No retries, sticky session, tools, history, cooldown, or fallback account.
          for await (const chunk of upstream.stream(latest, { ...options, system: '', purpose: 'model-attribution',
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], signal })) {
            signal?.throwIfAborted(); assertTarget();
            if (chunk.type === 'usage') usage = accumulateUsage(usage, chunk.usage);
            if (chunk.type === 'finish') { stopped = chunk.reason?.kind === 'stop'; failure = failureOfFinish(chunk.reason); }
            yield chunk;
          }
        } catch (error) { failure = error; throw error; }
        finally {
          probing.delete(id); release(id);
          onUsage({ accountId: id, sessionId: '', platform: account.platform, model, usage, switches: 0,
            ok: stopped && !failure, errorCode: stopped && !failure ? '' : 'POOL_MODEL_PROBE_FAILED' });
        }
      },
    });
  }

  return {
    testAccount,
    describeAccountProbe,
    prepareAccountProbe,
    /** Apply the host's current live setting without rebuilding the adapter. */
    setProviderDisplayName(value) {
      providerDisplayName = value;
    },
    // --- LlmAdapter surface -------------------------------------------------
    providerInfo(provider) {
      const route = typeof provider === 'string' && provider !== '' ? provider : providerName;
      // A group route is named after ITS group. Reporting one name for every route
      // put N identical rows in the Models list (and in the composer's provider
      // picker), which is indistinguishable from having no group routes at all.
      const groupId = groupOfProvider(route);
      if (groupId === undefined) return { id: route, name: providerDisplayName };
      const group = groups.get(groupId);
      const label = String(group?.label ?? '').trim() || groupId;
      return { id: route, name: label.startsWith('Sub-') ? label : `Sub-${label}` };
    },
    imageRequestPricing() { return undefined; },
    providerRetryPolicy() {
      // The pool owns failover; the agent loop must not also retry, or one lost
      // request would consume several accounts.
      return { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 };
    },
    /**
     * The models one route can actually serve.
     *
     * A provider picker can only offer what the adapter advertises, so answering
     * with a fixed list (or with nothing) decides whether the route is selectable
     * at all. A route's models come from the accounts BEHIND it: each account's
     * `models` is an allow-list ("empty = anything") and the group's own list
     * narrows it further, so an id is offered only when some account in scope
     * allows it under both lists. The adapter-level `models` option is added on
     * top — that is the config's `models:` knob. An unrestricted member also
     * contributes its groups' concrete model ids to the main pool catalog.
     *
     * An unknown group advertises nothing, matching `candidatesFor`.
     */
    async listModels(provider) {
      const route = provider ?? providerName;
      const groupId = groupOfProvider(route);
      const pool = groupId === undefined ? undefined : groups.get(groupId);
      if (groupId !== undefined && (pool === undefined || pool.enabled === false)) return [];
      const declared = [];
      const add = (id) => { if (!declared.includes(id)) declared.push(id); };
      for (const account of accounts.values()) {
        const inScope = groupId === undefined
          ? (pool === undefined || accountInGroup(account, pool.id))
          : accountInGroup(account, groupId);
        if (!inScope) continue;
        const own = Array.isArray(account.models) ? account.models : [];
        const narrowed = pool === undefined ? [] : (Array.isArray(pool.models) ? pool.models : []);
        // An unrestricted member can advertise its groups' concrete models in
        // the main pool too. Otherwise clearing account.models makes the main
        // provider disappear even though its group provider remains callable.
        if (own.length === 0 && narrowed.length === 0) {
          if (groupId === undefined) {
            for (const group of groups.values()) {
              if (accountInGroup(account, group.id)) {
                for (const id of group.models ?? []) add(id);
              }
            }
          }
          continue;
        }
        if (own.length === 0) { for (const id of narrowed) add(id); continue; }
        if (narrowed.length === 0) { for (const id of own) add(id); continue; }
        for (const id of own) if (narrowed.includes(id)) add(id);
      }
      for (const id of models) {
        if (groupId === undefined) { add(id); continue; }
        if (!groupSupportsModel(pool, id)) continue;
        if ([...accounts.values()].some(account => accountInGroup(account, groupId)
          && (!(account.models?.length) || account.models.includes(id)))) add(id);
      }
      return declared.map((id) => ({ provider: route, id, name: modelCapability(route, id).info.name }));
    },
    validateModelOverrides(providers, previous = {}) {
      for (const [route, profile] of Object.entries(providers ?? {})) {
        const overrides = profile?.modelOverrides ?? {};
        for (const [model, override] of Object.entries(overrides)) {
          if (JSON.stringify(override) === JSON.stringify(previous[route]?.modelOverrides?.[model])) continue;
          const capability = modelCapability(route, model, overrides);
          if (Array.isArray(override.input) && (!override.input.length || override.input.some(input => !capability.info.inputModalities.includes(input)))) {
            throw new Error(`账号池 ${route}/${model} 的可用账号不支持所选输入类型；此连接请使用文字输入`);
          }
          if (override.reasoningEfforts && typeof override.reasoningEfforts === 'object') {
            const offered = new Set(capability.info.reasoning?.efforts.map(effort => effort.id));
            if (Object.keys(override.reasoningEfforts).some(id => !offered.has(id))) throw new Error(`账号池 ${route}/${model} 的思考档位映射不受当前账号协议支持；仅 off 可留空`);
          }
        }
      }
    },
    async resolveModel(provider, model) {
      return modelCapability(provider, model).info;
    },
    /** Bind capability lookup and dispatch to one live-settings generation. */
    async prepareCall(provider, model, signal) {
      signal?.throwIfAborted();
      const route = provider ?? providerName;
      const capability = modelCapability(route, model);
      signal?.throwIfAborted();
      return { model: capability.info, stream: (options) => stream({ ...options, provider: route, model }, capability) };
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
      // Overrides for a group that no longer exists could never apply again, so they
      // are removed with it rather than left as orphan rows.
      for (const [key, entry] of [...priorities.entries()]) {
        if (entry.groupId !== id) continue;
        priorities.delete(key);
        persistCall('deletePriority', key);
      }
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
    /** Disabled groups remain in the directory but have no registered call route. */
    callableRoutesFor() {
      return [DEFAULT_PROVIDER, ...[...groups.values()]
        .filter((group) => group.enabled !== false).map((group) => providerRouteForGroup(group.id))];
    },
    // --- per (account, group) priorities -------------------------------------
    listPriorities() {
      return [...priorities.values()];
    },
    /** Seed/replace the override table (host: when the domain opens). */
    setPriorities(next) {
      priorities.clear();
      for (const entry of next) priorities.set(priorityKey(entry.accountId, entry.groupId), entry);
    },
    setPriority(entry) {
      priorities.set(priorityKey(entry.accountId, entry.groupId), entry);
      persistCall('putPriority', entry);
    },
    clearPriority(accountId, groupId) {
      const key = priorityKey(accountId, groupId);
      if (!priorities.has(key)) return false;
      priorities.delete(key);
      persistCall('deletePriority', key);
      return true;
    },
    removeAccount(id) {
      if (!accounts.has(id)) return false;
      accounts.delete(id);
      persistCall('deleteAccount', id);
      // Same reasoning as removeGroup: an override for a deleted account can never
      // apply again, so it goes WITH the account instead of lingering as an orphan.
      // (removeGroup had this and removeAccount did not — the asymmetry was the bug.)
      for (const [key, entry] of [...priorities.entries()]) {
        if (entry.accountId !== id) continue;
        priorities.delete(key);
        persistCall('deletePriority', key);
      }
      // `pruneBindings` is a METHOD of this returned object, not a free function, so
      // calling it bare here threw a ReferenceError — deleting an account could never
      // succeed. Prune inline instead, through the same closure helpers it uses.
      const stamp = clock.now();
      for (const binding of [...bindings.values()]) {
        const stillLive = accounts.has(binding.accountId)
          && activeBinding(bindings, binding.sessionHash, stamp) !== undefined;
        if (!stillLive) dropBinding(binding.sessionHash);
      }
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
