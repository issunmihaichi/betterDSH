/**
 * Token renewal — the half of OAuth that decides whether a login is still worth
 * anything tomorrow.
 *
 * A login alone is a dead end: every vendor here issues an access token that
 * expires in hours. Without a refresh, an account that logged in successfully
 * stops working the same afternoon, and the failure looks like an upstream 401
 * rather than like a missing feature. So this module is part of the feature, not
 * a follow-up.
 *
 * The design follows from one constraint: the credential store is WRITE-ONCE per
 * login from the UI's point of view, but a refresh has to rewrite it. So:
 *
 *   - The refresh happens at RESOLVE time, in the one place that already reads
 *     the secret for every request (`resolveAccountCredential`). No timer, no
 *     background job, no "refresh now" button to forget to press.
 *   - It only fires when the stored bundle actually says it is near expiry
 *     (`expires_at`), and only when a `refresh_token` exists. A bundle with
 *     neither an expiry nor a refresh token is returned unchanged — guessing
 *     would turn a working API key into a rejected bearer.
 *   - Concurrent requests share ONE refresh (the in-flight map). Ten parallel
 *     calls hitting an expired token must not open ten token requests against a
 *     vendor that counts them; and the second writer would overwrite the first
 *     one's rotated refresh token.
 *   - A failed refresh returns the STALE token instead of throwing. The upstream
 *     is the authority on whether the credential is dead, its 401 carries the
 *     real reason, and `classifyFailure` already knows what to do with it.
 */
import { expiresAtFrom, formEncode, postToken } from './pkce.js';
import { PROVIDERS } from './providers.js';

/** Refresh this long before the vendor's own expiry, to cover clock skew and latency. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Which provider refreshes which platform, and how.
 *
 * The refresh endpoint is NOT always the exchange endpoint's twin, and the field
 * set differs, so each entry states its own. `platform` is what the account row
 * carries; a platform with no entry (or an `api-key` account) is simply never
 * refreshed.
 */
export const REFRESH_PROVIDERS = {
  openai: { providerId: 'openai' },
  grok: { providerId: 'grok' },
  gemini: { providerId: 'gemini' },
  anthropic: { providerId: 'anthropic' },
};

/**
 * Is this bundle due for a refresh?
 *
 * An unparseable or absent `expires_at` answers "no": the credential might be
 * long-lived (many API keys are), and refreshing something that never needed it
 * is a write and a network call with no upside.
 */
export function needsRefresh(bundle, nowMs, marginMs = REFRESH_MARGIN_MS) {
  if (bundle === null || typeof bundle !== 'object') return false;
  if (typeof bundle.refresh_token !== 'string' || bundle.refresh_token === '') return false;
  const at = Date.parse(String(bundle.expires_at ?? ''));
  if (Number.isNaN(at)) return false;
  return at - marginMs <= nowMs;
}

/** Parse a stored credential value into its bundle, or `undefined` when it is a bare key. */
export function parseBundle(stored) {
  if (typeof stored !== 'string') return undefined;
  const trimmed = stored.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The stored form of a bundle: JSON, because a bundle is always more than a token. */
export function encodeBundleObject(bundle) {
  return JSON.stringify(bundle);
}

/**
 * Refresh one bundle with its provider.
 *
 * @returns `{ bundle, accessToken, refreshed, expiresAt }`. `refreshed: false`
 *   means the bundle was used as-is (not due, no refresh token, or the refresh
 *   failed and the stale token is the honest answer).
 */
export async function refreshBundle(options) {
  const {
    bundle, providerId, fetchImpl, nowMs, marginMs = REFRESH_MARGIN_MS, onWarn,
  } = options;

  if (!needsRefresh(bundle, nowMs, marginMs)) {
    return { bundle, accessToken: bundle?.access_token ?? null, refreshed: false, expiresAt: bundle?.expires_at ?? null };
  }

  const provider = PROVIDERS[providerId];
  if (provider === undefined || typeof provider.refresh !== 'function') {
    return { bundle, accessToken: bundle?.access_token ?? null, refreshed: false, expiresAt: bundle?.expires_at ?? null };
  }

  try {
    const result = await provider.refresh({
      refreshToken: bundle.refresh_token,
      fetchImpl,
      nowMs,
      // Per-bundle first, provider default second: a credential minted with the
      // operator's own OAuth client must be refreshed with that same client.
      clientId: bundle.client_id ?? provider.clientId,
      clientSecret: bundle.client_secret ?? provider.clientSecret,
    });
    // The rotated refresh token is kept ONLY when the vendor sent a new one: an
    // empty value would otherwise erase the one credential that still works.
    const next = {
      ...bundle,
      ...result.patch,
      access_token: result.accessToken,
      expires_at: result.expiresAt ?? expiresAtFrom(result.patch, nowMs) ?? bundle.expires_at,
    };
    if (result.patch?.refresh_token === undefined) next.refresh_token = bundle.refresh_token;
    return { bundle: next, accessToken: result.accessToken, refreshed: true, expiresAt: next.expires_at };
  } catch {
    onWarn?.(`account-pool: token refresh failed for ${providerId}`);
    return { bundle, accessToken: bundle?.access_token ?? null, refreshed: false, expiresAt: bundle?.expires_at ?? null };
  }
}

/**
 * Resolve a credential to a live bearer, refreshing it when it is due and
 * persisting the result.
 *
 * @param options.credentials - the DSH credential service (`resolve`/`set`).
 * @param options.credentialRef - the account's reference.
 * @param options.platform - the account's platform, to pick the refresher.
 * @param options.fetchImpl - injected fetch.
 * @param options.clock - `{ now() }`.
 * @param options.inFlight - a shared `Map` so concurrent calls share one refresh;
 *   the caller owns it so it lives as long as the plugin does.
 * @param options.returnBundle - return the full bundle with a fresh access_token.
 * @returns a bearer string by default, a bundle when requested and stored as one,
 *   or undefined when no usable credential is configured.
 */
export async function refreshAccountCredential(options) {
  const {
    credentials, credentialRef, platform, fetchImpl = globalThis.fetch,
    clock = { now: () => Date.now() }, inFlight, onWarn, returnBundle = false,
  } = options;
  if (typeof credentialRef !== 'string' || credentialRef === '') return undefined;
  if (typeof credentials?.resolve !== 'function') return undefined;
  const mapping = REFRESH_PROVIDERS[platform];
  if (mapping === undefined) return undefined;

  // The promise always produces a bundle (or a bare string). Return mode belongs
  // to each waiter, never to the shared refresh, so mixed callers cannot refresh twice.
  const present = (value) => returnBundle && value !== null && typeof value === 'object'
    ? { ...value, access_token: bearerOf(value) }
    : typeof value === 'string' ? value : bearerOf(value);
  const key = `${credentialRef}|${platform}`;
  const existing = inFlight?.get(key);
  if (existing !== undefined) return present(await existing);

  const resolved = await credentials.resolve(credentialRef);
  const stored = typeof resolved?.value === 'string' ? resolved.value : '';
  if (stored.trim() === '') return undefined;
  const bundle = parseBundle(stored);
  if (bundle === undefined) return stored.trim();
  const nowMs = clock.now();
  if (!needsRefresh(bundle, nowMs)) return present(bundle);
  const concurrent = inFlight?.get(key);
  if (concurrent !== undefined) return present(await concurrent);

  const work = (async () => {
    const result = await refreshBundle({
      bundle, providerId: mapping.providerId, fetchImpl, nowMs, onWarn,
    });
    if (result.refreshed === true && typeof credentials.set === 'function') {
      try {
        await credentials.set(credentialRef, encodeBundleObject(result.bundle));
      } catch {
        // Keep both public metadata and the valid new token for this request.
        onWarn?.('account-pool: refreshed token could not be persisted');
      }
    }
    return result.bundle;
  })();
  inFlight?.set(key, work);
  try {
    return present(await work);
  } finally {
    if (inFlight?.get(key) === work) inFlight.delete(key);
  }
}

/** The bearer inside a bundle, tolerating the field names the importers accept. */
export function bearerOf(bundle) {
  for (const key of ['access_token', 'accessToken', 'api_key', 'apiKey', 'key', 'token']) {
    const value = bundle?.[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

export { formEncode, postToken };
