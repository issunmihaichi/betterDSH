/** Remote quota reads. Only normalized, public quota fields cross the management boundary. */
import { bearerOf, parseBundle, refreshAccountCredential } from './oauth/refresh.js';
import { createResetCreditsService } from './reset-credits.js';

export const QUOTA_TTL_MS = 60_000;
export const QUOTA_TIMEOUT_MS = 20_000;
export const QUOTA_URLS = {
  openai: 'https://chatgpt.com/backend-api/wham/usage',
  anthropic: 'https://api.anthropic.com/api/oauth/usage',
  gemini: 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
};
const SOURCES = { openai: 'codex', anthropic: 'claude', gemini: 'gemini-code-assist' };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => value === null ? null : JSON.parse(JSON.stringify(value));
const number = (value) => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim()))) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const percent = (value) => {
  const n = number(value);
  return n === null || n < 0 ? null : Math.min(100, n);
};
const amount = (value) => {
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) return value.trim().slice(0, 120);
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
};
const identifier = (value) => typeof value === 'string' && /^[a-zA-Z0-9_.:/ -]{1,120}$/.test(value) ? value : null;
const publicId = (...values) => values.find((value) => typeof value === 'string' && value.trim() !== '')?.trim() ?? null;
const seconds = (value) => { const n = number(value); return n !== null && n > 0 ? n : null; };

export function quotaResetAt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = number(value);
  const ms = n === null ? (typeof value === 'string' ? Date.parse(value) : NaN) : n * (n < 1e11 ? 1000 : 1);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function chatgptIdFromToken(value) {
  if (typeof value !== 'string') return null;
  try {
    const claims = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString('utf8'));
    return publicId(claims?.['https://api.openai.com/auth']?.chatgpt_account_id);
  } catch { return null; }
}

function windowOf(id, label, raw = {}, windowSeconds = null) {
  const used = percent(raw.used_percent ?? raw.utilization);
  return {
    id, label, usedPercent: used, remainingPercent: used === null ? null : 100 - used,
    remainingAmount: null, resetAt: quotaResetAt(raw.reset_at ?? raw.resets_at),
    windowSeconds: seconds(raw.limit_window_seconds) ?? windowSeconds,
  };
}

export function normalizeCodexQuota(payload, nowMs = Date.now()) {
  const windows = [];
  function add(raw, prefix = '', label = 'Codex') {
    for (const [key, name] of [['primary_window', 'primary'], ['secondary_window', 'secondary']]) {
      if (!object(raw?.[key])) continue;
      const w = windowOf(`${prefix}${name}`, `${label} ${name}`, raw[key]);
      const resetAfter = number(raw[key].reset_after_seconds);
      if (w.resetAt === null && resetAfter !== null && resetAfter >= 0) w.resetAt = quotaResetAt(nowMs + resetAfter * 1000);
      windows.push(w);
    }
  }
  add(payload?.rate_limit);
  if (Array.isArray(payload?.additional_rate_limits)) {
    payload.additional_rate_limits.slice(0, 30).forEach((entry, index) => {
      add(entry?.rate_limit, `additional-${index}-`, identifier(entry?.limit_name) ?? identifier(entry?.metered_feature) ?? 'Additional limit');
    });
  }
  const result = { plan: identifier(payload?.plan_type), windows };
  if (typeof payload?.rate_limit?.allowed === 'boolean') result.rateLimitAllowed = payload.rate_limit.allowed;
  if (typeof payload?.rate_limit?.limit_reached === 'boolean') result.rateLimitReached = payload.rate_limit.limit_reached;
  if (object(payload?.credits)) {
    result.credits = { balance: amount(payload.credits.balance), unlimited: payload.credits.unlimited === true };
  }
  return result;
}

export function normalizeClaudeQuota(payload) {
  const windows = [];
  for (const [id, label, duration] of [
    ['five_hour', '5 hours', 18_000], ['seven_day', '7 days', 604_800],
    ['seven_day_sonnet', 'Sonnet 7 days', 604_800], ['seven_day_opus', 'Opus 7 days', 604_800],
    ['seven_day_oauth_apps', 'OAuth apps 7 days', 604_800],
    ['seven_day_overage_included', 'Included overage 7 days', 604_800],
    ['extra_usage', 'Extra usage', null],
  ]) {
    if (object(payload?.[id])) windows.push(windowOf(id, label, payload[id], duration));
  }
  return { plan: null, windows };
}

export function normalizeGeminiQuota(payload) {
  const windows = Array.isArray(payload?.buckets) ? payload.buckets.slice(0, 100).filter(object).map((bucket, index) => {
    const fraction = number(bucket.remainingFraction);
    const remaining = fraction === null || fraction < 0 ? null : Math.min(1, fraction) * 100;
    const model = identifier(bucket.modelId);
    const tokenType = identifier(bucket.tokenType);
    return {
      id: `bucket-${index}`, label: [model, tokenType].filter(Boolean).join(' / ') || 'Quota bucket',
      usedPercent: remaining === null ? null : 100 - remaining, remainingPercent: remaining,
      remainingAmount: amount(bucket.remainingAmount), resetAt: quotaResetAt(bucket.resetTime), windowSeconds: null,
    };
  }) : [];
  return { plan: null, windows };
}

/** Runtime activity changes updatedAt; only connection identity determines cache ownership. */
export function quotaConnectionKey(account) {
  return JSON.stringify(['platform', 'authMode', 'credentialRef', 'baseUrl', 'projectId', 'chatgptAccountId'].map((key) => account?.[key] ?? null));
}
const supported = (account) => account?.authMode === 'oauth' && Object.hasOwn(QUOTA_URLS, account?.platform);
const hasData = (data) => data.windows.some((w) => w.usedPercent !== null || w.remainingPercent !== null || w.remainingAmount !== null || w.resetAt !== null)
  || data.credits?.balance !== null && data.credits?.balance !== undefined || data.credits?.unlimited === true;
const MESSAGES = {
  unsupported: 'This account has no supported public quota API.',
  'missing-credential': 'Configure an OAuth credential before querying quota.',
  'missing-account-id': 'Set the ChatGPT account ID before querying quota.',
  'missing-project': 'Set a Gemini Code Assist project ID before querying quota.',
  'project-discovery-failed': 'Gemini Code Assist project discovery failed; set the project ID manually.',
  'quota-unknown': 'The provider returned no known quota measurements.',
  'invalid-response': 'The quota endpoint returned an invalid response.',
  'quota-http-error': 'The quota endpoint rejected the request.',
  'quota-fetch-failed': 'The quota request failed.',
  timeout: 'The quota request timed out.',
  canceled: 'The quota request was canceled because the account changed or the pool stopped.',
};
function failure(code, status) { return Object.assign(new Error(code), { quotaCode: code, quotaStatus: status }); }
function openaiQuotaHeaders(account, credential) {
  const bundle = object(credential) ? credential : { access_token: credential };
  const token = bearerOf(bundle);
  if (typeof token !== 'string' || token.trim() === '') throw failure('missing-credential');
  const id = publicId(account.chatgptAccountId, bundle.chatgpt_account_id, bundle.chatgptAccountId, bundle.account_id, bundle.accountId,
    chatgptIdFromToken(bundle.id_token), chatgptIdFromToken(token));
  if (id === null) throw failure('missing-account-id');
  return { authorization: `Bearer ${token}`, accept: 'application/json',
    'chatgpt-account-id': id, originator: 'codex_cli_rs', 'openai-beta': 'codex-1' };
}
function baseSnapshot(account, at) {
  return { supported: supported(account), ok: false, at, source: SOURCES[account?.platform] ?? null, plan: null, windows: [] };
}
function failSnapshot(account, at, code, status) {
  return { ...baseSnapshot(account, at), errorCode: code, message: MESSAGES[code], ...(status === undefined ? {} : { status }) };
}

/** In-memory only: no quota request changes scheduling or durable account state. */
export function createQuotaService(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const clock = options.clock ?? { now: () => Date.now() };
  const ttlMs = options.ttlMs ?? QUOTA_TTL_MS;
  const timeoutMs = options.timeoutMs ?? QUOTA_TIMEOUT_MS;
  const cache = new Map();
  const flights = new Map();
  const refreshInFlight = options.refreshInFlight ?? new Map();
  let disposed = false;
  const at = () => new Date(clock.now()).toISOString();

  async function resolve(account, signal) {
    // A quota timeout covers refresh too, without altering the regular resolver API.
    const boundedFetch = (url, init = {}) => {
      signal.throwIfAborted();
      return fetchImpl(url, { ...init, signal });
    };
    if (typeof options.resolveCredential === 'function') return options.resolveCredential(account, { fetchImpl: boundedFetch, signal, returnBundle: true });
    const refreshed = await refreshAccountCredential({
      credentials: options.credentials, credentialRef: account.credentialRef, platform: account.platform,
      fetchImpl: boundedFetch, clock, inFlight: refreshInFlight, returnBundle: true,
    });
    if (refreshed !== undefined) return refreshed;
    const stored = (await options.credentials?.resolve?.(account.credentialRef))?.value;
    return parseBundle(stored) ?? stored;
  }

  const resetCredits = createResetCreditsService({
    fetchImpl, clock, ttlMs, timeoutMs, connectionKey: quotaConnectionKey,
    resolveHeaders: async (account, signal) => openaiQuotaHeaders(account, await resolve(account, signal)),
    onConsumeSuccess: (account) => invalidateQuota(account.id),
  });

  async function query(account, signal) {
    const credential = await resolve(account, signal);
    signal.throwIfAborted();
    const bundle = object(credential) ? credential : { access_token: credential };
    const token = bearerOf(bundle);
    if (typeof token !== 'string' || token.trim() === '') throw failure('missing-credential');
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
    let init = { method: 'GET', headers, signal, redirect: 'error' };
    let discovery;
    if (account.platform === 'openai') {
      Object.assign(headers, openaiQuotaHeaders(account, bundle));
    } else if (account.platform === 'anthropic') {
      Object.assign(headers, { 'anthropic-beta': 'oauth-2025-04-20', 'x-app': 'cli' });
    } else {
      let project = publicId(account.projectId, bundle.project_id, bundle.projectId, bundle.project);
      if (project === null) {
        try {
          const ensure = options.ensureGeminiProject ?? (await import('./native/gemini.js')).ensureGeminiProject;
          discovery = await ensure(bundle, { fetchImpl, signal, accountId: account.id });
          project = publicId(discovery?.projectId, discovery?.project_id);
        } catch {
          signal.throwIfAborted();
          throw failure('project-discovery-failed');
        }
      }
      if (project === null) throw failure('missing-project');
      headers['content-type'] = 'application/json';
      init = { ...init, method: 'POST', body: JSON.stringify({ project }) };
    }
    signal.throwIfAborted();
    const response = await fetchImpl(QUOTA_URLS[account.platform], init);
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* discard raw errors */ }
      throw failure('quota-http-error', response.status);
    }
    let payload;
    try { payload = await response.json(); } catch { throw failure('invalid-response'); }
    if (!object(payload)) throw failure('invalid-response');
    const normalized = account.platform === 'openai' ? normalizeCodexQuota(payload, clock.now())
      : account.platform === 'anthropic' ? normalizeClaudeQuota(payload) : normalizeGeminiQuota(payload);
    if (account.platform === 'gemini') normalized.plan = identifier(discovery?.tierId ?? discovery?.currentTier?.id ?? bundle.tier_id);
    if (!hasData(normalized)) throw failure('quota-unknown');
    return { ...baseSnapshot(account, at()), ...normalized, ok: true };
  }

  function peek(account) {
    const entry = cache.get(account?.id);
    if (entry?.key !== quotaConnectionKey(account)) return null;
    const snapshot = clone(entry.snapshot);
    if (snapshot.ok && clock.now() - entry.fetchedAt >= ttlMs) {
      snapshot.stale = true;
      snapshot.expired = true;
      snapshot.lastSuccessAt = snapshot.at;
    }
    return snapshot;
  }
  function invalidateQuota(id) {
    cache.delete(id);
    const active = flights.get(id);
    flights.delete(id);
    active?.controller.abort(failure('canceled'));
  }
  function invalidate(id) {
    invalidateQuota(id);
    resetCredits.invalidate(id);
  }
  function invalidateCredential(ref) {
    if (!ref) return;
    resetCredits.invalidateCredential(ref);
    for (const [id, entry] of cache) if (entry.credentialRef === ref) cache.delete(id);
    for (const [id, flight] of flights) if (flight.credentialRef === ref) invalidate(id);
  }
  async function get(account, { force = false } = {}) {
    if (disposed) return failSnapshot(account, at(), 'canceled');
    const key = quotaConnectionKey(account);
    const previous = cache.get(account.id);
    if (previous && previous.key !== key) invalidate(account.id);
    const current = cache.get(account.id);
    const running = flights.get(account.id);
    if (running?.key === key) return clone(await running.promise);
    if (running) invalidate(account.id);
    if (!force && current && clock.now() - current.fetchedAt < ttlMs) return clone(current.snapshot);
    if (!supported(account)) {
      const snapshot = failSnapshot(account, at(), 'unsupported');
      cache.set(account.id, { key, credentialRef: account.credentialRef, fetchedAt: clock.now(), snapshot });
      return clone(snapshot);
    }
    const controller = new AbortController();
    const flight = { key, credentialRef: account.credentialRef, controller };
    const aborted = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason ?? failure('canceled')), { once: true });
    });
    const timer = setTimeout(() => controller.abort(failure('timeout')), timeoutMs);
    flight.promise = (async () => {
      let snapshot;
      try {
        snapshot = await Promise.race([query(account, controller.signal), aborted]);
      } catch (error) {
        const code = Object.hasOwn(MESSAGES, error?.quotaCode) ? error.quotaCode : 'quota-fetch-failed';
        snapshot = failSnapshot(account, at(), code, error?.quotaCode === 'quota-http-error' ? error.quotaStatus : undefined);
        const last = current?.lastSuccess ?? (current?.snapshot.ok ? current.snapshot : undefined);
        if (last) snapshot = { ...snapshot, plan: last.plan, windows: last.windows,
          ...(last.credits ? { credits: last.credits } : {}), stale: true, lastSuccessAt: last.at, errorAt: snapshot.at };
      } finally {
        clearTimeout(timer);
      }
      // A deleted/replaced account must never receive the old request's cache.
      if (!disposed && flights.get(account.id) === flight) {
        cache.set(account.id, { key, credentialRef: account.credentialRef, fetchedAt: clock.now(), snapshot,
          lastSuccess: snapshot.ok ? snapshot : current?.lastSuccess ?? (current?.snapshot.ok ? current.snapshot : undefined) });
      }
      return snapshot;
    })();
    flights.set(account.id, flight);
    try { return clone(await flight.promise); }
    finally { if (flights.get(account.id) === flight) flights.delete(account.id); }
  }
  function dispose() {
    disposed = true;
    resetCredits.dispose();
    for (const id of flights.keys()) invalidate(id);
    cache.clear();
  }
  return { get, peek, invalidate, invalidateCredential, dispose,
    getResetCredits: resetCredits.get, peekResetCredits: resetCredits.peek, consumeResetCredit: resetCredits.consume };
}
