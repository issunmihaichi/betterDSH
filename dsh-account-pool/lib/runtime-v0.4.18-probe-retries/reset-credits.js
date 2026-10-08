/** ChatGPT/Codex rate-limit reset grants. Only counts and expiry metadata are public. */
export const RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
export const RESET_CREDITS_RESULT_TTL_MS = 10 * 60_000;
const RESULT_LIMIT = 128;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => value === null ? null : JSON.parse(JSON.stringify(value));
export const supportsResetCredits = (account) => account?.platform === 'openai' && account?.authMode === 'oauth';
export const isResetRequestId = (value) => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const MESSAGES = {
  unsupported: 'Rate-limit reset credits are only supported for ChatGPT/Codex OAuth accounts.',
  'missing-credential': 'Configure an OAuth credential before querying reset credits.',
  'missing-account-id': 'Set the ChatGPT account ID before querying reset credits.',
  'invalid-response': 'The reset-credit endpoint returned no valid credit count or list.',
  'reset-credits-http-error': 'The reset-credit endpoint rejected the request.',
  'reset-credits-fetch-failed': 'The reset-credit query failed.',
  'invalid-request-id': 'A valid UUID requestId is required to consume a reset credit.',
  'reset-busy': 'This account already has a reset in progress. Wait for that request to finish.',
  'reset-pending': 'An earlier reset result is uncertain. Recover it using the same requestId before starting another reset.',
  'reset-credits-unavailable': 'A fresh reset-credit query failed; no credit was consumed.',
  'no-reset-credits': 'No available Codex rate-limit reset credit was found.',
  'reset-http-error': 'The reset endpoint rejected the request; no reset was confirmed.',
  'reset-fetch-failed': 'The reset request could not be prepared; no consume request was sent.',
  'reset-result-uncertain': 'The reset result is uncertain. Keep this requestId and reuse it for an explicit recovery attempt.',
  timeout: 'The reset-credit request timed out before any consume request was sent.',
  canceled: 'The reset-credit request was canceled because the account changed or the pool stopped.',
};
const failure = (code, status) => Object.assign(new Error(code), { resetCode: code, resetStatus: status });
const publicError = (code, status) => ({ code, message: MESSAGES[code], ...(status === undefined ? {} : { status }) });
const consumeFailure = (code, httpStatus = 502, extra = {}, status) => ({ ok: false, error: publicError(code, status), httpStatus, ...extra });
const countOf = (value) => {
  const number = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};
const expiryOf = (value) => {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
const textOf = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';

/** The upstream has used both count-only responses and several list envelopes. */
export function normalizeResetCredits(payload) {
  let rawList;
  let explicitCount = null;
  if (Array.isArray(payload)) rawList = payload;
  else if (object(payload)) {
    explicitCount = countOf(payload.available_count) ?? countOf(payload.availableCount);
    for (const key of ['credits', 'rate_limit_reset_credits', 'items', 'data']) {
      if (payload[key] === undefined || payload[key] === null) continue;
      if (!Array.isArray(payload[key])) throw failure('invalid-response');
      rawList = payload[key];
      break;
    }
  } else throw failure('invalid-response');
  if (explicitCount === null && rawList === undefined) throw failure('invalid-response');
  const available = (rawList ?? []).filter((credit) => {
    if (!object(credit)) return false;
    const status = textOf(credit.status);
    const type = textOf(credit.reset_type) || textOf(credit.resetType);
    return (status === '' || status === 'available') && (type === '' || type === 'codex_rate_limits');
  });
  return { availableCount: explicitCount ?? available.length,
    credits: available.map((credit) => ({ expiresAt: expiryOf(credit.expires_at) ?? expiryOf(credit.expiresAt) })) };
}

/** resolveHeaders shares the quota service's refresh, bearer and workspace resolver. */
export function createResetCreditsService(options) {
  const { fetchImpl, clock, resolveHeaders, connectionKey, onConsumeSuccess } = options;
  const ttlMs = options.ttlMs ?? 60_000;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const reads = new Map();
  const readFlights = new Map();
  const consumeFlights = new Map();
  const results = new Map();
  // One unresolved UUID per account blocks another card until explicit recovery.
  // These entries hold no credentials and are cleared on connection invalidation.
  const uncertain = new Map();
  let disposed = false;
  const at = () => new Date(clock.now()).toISOString();
  const snapshotFailure = (account, code, status) => ({ supported: supportsResetCredits(account), ok: false,
    availableCount: null, credits: [], at: at(), error: publicError(code, status) });
  const resultKey = (account, key, requestId) => JSON.stringify([account.id, key, requestId]);

  function invalidateReads(id) {
    reads.delete(id);
    const flight = readFlights.get(id);
    readFlights.delete(id);
    flight?.controller.abort(failure('canceled'));
  }
  function invalidate(id) {
    invalidateReads(id);
    const flight = consumeFlights.get(id);
    consumeFlights.delete(id);
    flight?.controller.abort(failure('canceled'));
    uncertain.delete(id);
    for (const [key, entry] of results) if (entry.accountId === id) results.delete(key);
  }
  function invalidateCredential(ref) {
    if (!ref) return;
    const ids = new Set();
    for (const collection of [reads, readFlights, consumeFlights, uncertain]) {
      for (const [id, entry] of collection) if (entry.credentialRef === ref) ids.add(id);
    }
    for (const entry of results.values()) if (entry.credentialRef === ref) ids.add(entry.accountId);
    for (const id of ids) invalidate(id);
  }
  function checkConnection(account, key) {
    if ([reads, readFlights, consumeFlights, uncertain].some((map) => map.has(account.id) && map.get(account.id).key !== key)) invalidate(account.id);
    for (const entry of results.values()) {
      if (entry.accountId === account.id && entry.key !== key) { invalidate(account.id); break; }
    }
  }
  function pruneResults() {
    for (const [key, entry] of results) if (clock.now() - entry.fetchedAt >= RESET_CREDITS_RESULT_TTL_MS) results.delete(key);
    while (results.size > RESULT_LIMIT) results.delete(results.keys().next().value);
  }
  function bounded(flight, work) {
    const { signal } = flight.controller;
    const aborted = new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason ?? failure('canceled')), { once: true }));
    const timer = setTimeout(() => flight.controller.abort(failure('timeout')), timeoutMs);
    return Promise.race([work(signal), aborted]).finally(() => clearTimeout(timer));
  }
  function codeOf(error, fallback) {
    const code = error?.resetCode ?? error?.quotaCode;
    return Object.hasOwn(MESSAGES, code) ? code : fallback;
  }
  async function query(account, signal) {
    const headers = await resolveHeaders(account, signal);
    signal.throwIfAborted();
    const response = await fetchImpl(RESET_CREDITS_URL, { method: 'GET', headers, signal, redirect: 'error' });
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* never retain upstream errors */ }
      throw failure('reset-credits-http-error', response.status);
    }
    let payload;
    try { payload = await response.json(); } catch { throw failure('invalid-response'); }
    signal.throwIfAborted();
    return { supported: true, ok: true, ...normalizeResetCredits(payload), at: at() };
  }
  function peek(account) {
    if (!supportsResetCredits(account)) return null;
    const entry = reads.get(account.id);
    if (entry?.key !== connectionKey(account)) return null;
    const snapshot = clone(entry.snapshot);
    if (snapshot.ok && clock.now() - entry.fetchedAt >= ttlMs) {
      snapshot.stale = true;
      snapshot.lastSuccessAt = snapshot.at;
    }
    return snapshot;
  }
  async function get(account, { force = false } = {}) {
    if (disposed) return snapshotFailure(account, 'canceled');
    if (!supportsResetCredits(account)) return snapshotFailure(account, 'unsupported');
    const key = connectionKey(account);
    checkConnection(account, key);
    const current = reads.get(account.id);
    const running = readFlights.get(account.id);
    if (running) return clone(await running.promise);
    if (!force && current && clock.now() - current.fetchedAt < ttlMs) return clone(current.snapshot);
    const flight = { key, credentialRef: account.credentialRef, controller: new AbortController() };
    flight.promise = (async () => {
      let snapshot;
      try { snapshot = await bounded(flight, (signal) => query(account, signal)); }
      catch (error) {
        const code = codeOf(error, 'reset-credits-fetch-failed');
        snapshot = snapshotFailure(account, code, code === 'reset-credits-http-error' ? error.resetStatus : undefined);
        const lastSuccessAt = current?.lastSuccessAt ?? (current?.snapshot.ok ? current.snapshot.at : undefined);
        if (lastSuccessAt) snapshot = { ...snapshot, stale: true, lastSuccessAt };
      }
      if (!disposed && readFlights.get(account.id) === flight) reads.set(account.id, {
        key, credentialRef: account.credentialRef, fetchedAt: clock.now(), snapshot,
        lastSuccessAt: snapshot.ok ? snapshot.at : current?.lastSuccessAt,
      });
      return snapshot;
    })();
    readFlights.set(account.id, flight);
    try { return clone(await flight.promise); }
    finally { if (readFlights.get(account.id) === flight) readFlights.delete(account.id); }
  }

  async function consume(account, { requestId } = {}) {
    if (!supportsResetCredits(account)) return consumeFailure('unsupported', 400);
    if (!isResetRequestId(requestId)) return consumeFailure('invalid-request-id', 400);
    if (disposed) return consumeFailure('canceled', 503);
    const key = connectionKey(account);
    checkConnection(account, key);
    pruneResults();
    const running = consumeFlights.get(account.id);
    if (running) return running.requestId === requestId ? clone(await running.promise)
      : consumeFailure('reset-busy', 409, { requestId: running.requestId });
    const cached = results.get(resultKey(account, key, requestId));
    if (cached) return clone(cached.result);
    const pending = uncertain.get(account.id);
    if (pending && pending.requestId !== requestId) return consumeFailure('reset-pending', 409, { uncertain: true, requestId: pending.requestId });
    const flight = { key, requestId, credentialRef: account.credentialRef, controller: new AbortController(), dispatched: false };
    flight.promise = (async () => {
      let result;
      try {
        result = await bounded(flight, async (signal) => {
          // After an uncertain dispatch, another count (possibly zero) cannot tell
          // whether that UUID already consumed the last card. Recover its upstream
          // idempotent result directly, only when the caller explicitly retries it.
          if (!pending) {
            const resetCredits = await get(account, { force: true });
            signal.throwIfAborted();
            if (!resetCredits.ok) return consumeFailure('reset-credits-unavailable', 502, { resetCredits });
            if (resetCredits.availableCount === 0) return consumeFailure('no-reset-credits', 409, { resetCredits });
          }
          const headers = await resolveHeaders(account, signal);
          signal.throwIfAborted();
          flight.dispatched = true;
          const response = await fetchImpl(`${RESET_CREDITS_URL}/consume`, { method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' }, signal, redirect: 'error',
            body: JSON.stringify({ redeem_request_id: requestId }) });
          if (!response.ok) {
            try { await response.body?.cancel(); } catch { /* discard raw upstream errors */ }
            if (response.status === 408 || response.status === 409 || response.status >= 500) {
              return consumeFailure('reset-result-uncertain', 502, { uncertain: true }, response.status);
            }
            return consumeFailure('reset-http-error', 502, {}, response.status);
          }
          let payload;
          try { payload = await response.json(); } catch { return consumeFailure('reset-result-uncertain', 502, { uncertain: true }); }
          signal.throwIfAborted();
          if (object(payload) && payload.code === 'no_credit') return consumeFailure('no-reset-credits', 409);
          if (!object(payload) || !['success', 'ok'].includes(payload.code)
            || !Number.isSafeInteger(payload.windows_reset) || payload.windows_reset <= 0) {
            return consumeFailure('reset-result-uncertain', 502, { uncertain: true });
          }
          // Invalidate earlier read flights before the host's forced post-reset reads.
          invalidateReads(account.id);
          onConsumeSuccess?.(account);
          return { ok: true, reset: { code: payload.code, windowsReset: payload.windows_reset } };
        });
      } catch (error) {
        if (flight.dispatched) result = consumeFailure('reset-result-uncertain', 502, { uncertain: true });
        else result = consumeFailure(codeOf(error, 'reset-fetch-failed'), 502);
      }
      // A rejected recovery attempt cannot retroactively disprove the original
      // dispatch. Keep its UUID locked until an idempotent business result arrives.
      if (pending && !result.ok && result.error.code !== 'no-reset-credits') {
        result = consumeFailure('reset-result-uncertain', 502, { uncertain: true }, result.error.status);
      }
      if (result.uncertain) result = { ...result, requestId };
      if (!disposed && consumeFlights.get(account.id) === flight) {
        if (result.uncertain) uncertain.set(account.id, { key, requestId, credentialRef: account.credentialRef, result });
        else {
          uncertain.delete(account.id);
          // Only dispatched outcomes need replay caching; preflight errors may be retried.
          if (flight.dispatched) {
            results.set(resultKey(account, key, requestId), { accountId: account.id, key,
              credentialRef: account.credentialRef, fetchedAt: clock.now(), result });
            pruneResults();
          }
        }
      }
      return result;
    })();
    consumeFlights.set(account.id, flight);
    try { return clone(await flight.promise); }
    finally { if (consumeFlights.get(account.id) === flight) consumeFlights.delete(account.id); }
  }
  function dispose() {
    disposed = true;
    const ids = new Set([...reads.keys(), ...readFlights.keys(), ...consumeFlights.keys(), ...uncertain.keys()]);
    for (const id of ids) invalidate(id);
    results.clear();
  }
  return { get, peek, consume, invalidate, invalidateCredential, dispose };
}
