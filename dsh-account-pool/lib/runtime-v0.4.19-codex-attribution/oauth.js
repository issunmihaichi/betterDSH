/**
 * Upstream OAuth login — the public surface.
 *
 * Pure by construction: no DSH imports, no I/O, no clock reads (`now` is a
 * parameter), and `fetch` is INJECTED into every network call. That is what lets
 * the whole login path be tested against a fake fetch with hand-written token
 * responses, exactly like `upstream.js`.
 *
 * Three things are deliberately separated, because they fail differently:
 *
 *   - `oauth/pkce.js`     — the leaf: PKCE material, encodings, the token POST,
 *     the pasted-input parsers, and the flow id. A wrong verifier is an
 *     `invalid_grant` at the far end with no local symptom, so it is tested
 *     against the RFC 7636 Appendix B vector rather than against itself.
 *   - `createFlowStore()` — the TRANSIT state of a login in progress. Nothing here
 *     is durable: a flow that is never completed must evaporate, or the pool
 *     accumulates half-finished logins holding live verifiers.
 *   - `oauth/providers.js` — the per-vendor facts (endpoints, client id, scope,
 *     token field names), each with cited provenance.
 *
 * The secret never touches the domain: `finish()` hands the credential BUNDLE
 * back to the caller, and the host half writes it through `ctx.credentials` and
 * keeps only a `credentialRef` on the account row (same rule as `importer.js`).
 */

export {
  base64url, decodeJwtPayload, expiresAtFrom, formEncode, identityFrom,
  newFlowId, OAuthError, parseAuthInput, pkce, postToken, readCallbackParams,
  state, withQuery,
} from './oauth/pkce.js';

/** Default lifetime of a started-but-unfinished login. */
export const DEFAULT_FLOW_TTL_MS = 15 * 60 * 1000;

/**
 * The flow store: one entry per login in progress, addressed by an opaque id.
 *
 * Bounded on purpose. An abandoned login holds a live PKCE verifier, and a page
 * that is closed mid-login never sends a cancel — so the store evicts on TTL and
 * caps how many unfinished flows it will hold at once.
 */
export function createFlowStore(options = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_FLOW_TTL_MS;
  const maxFlows = options.maxFlows ?? 8;
  const flows = new Map();

  /** Drop expired flows. */
  function evictExpired(nowMs) {
    for (const [id, flow] of flows) {
      if (flow.expiresAtMs <= nowMs) flows.delete(id);
    }
  }

  /**
   * Drop expired flows, then make room for one more.
   *
   * Oldest-first, and it stops one short of the cap: that free slot is what the
   * flow being created is about to occupy (`create` runs this BEFORE inserting).
   * Draining to `size < maxFlows` unconditionally would evict one flow too many.
   */
  function evict(nowMs) {
    evictExpired(nowMs);
    while (flows.size >= maxFlows) {
      const oldest = flows.keys().next().value;
      if (oldest === undefined) break;
      flows.delete(oldest);
    }
  }

  return {
    /** Register a flow; returns it with its expiry resolved. */
    create(flow, nowMs) {
      evict(nowMs);
      const record = { ...flow, startedAtMs: nowMs, expiresAtMs: nowMs + ttlMs };
      flows.set(record.id, record);
      return record;
    },
    get(id, nowMs) {
      const flow = flows.get(id);
      if (flow === undefined) return undefined;
      if (flow.expiresAtMs <= nowMs) {
        flows.delete(id);
        return undefined;
      }
      return flow;
    },
    /** Look a flow up by its anti-CSRF nonce — that is what a callback carries. */
    findByState(value, nowMs) {
      for (const flow of flows.values()) {
        if (flow.expiresAtMs <= nowMs) continue;
        if (flow.state === value) return flow;
      }
      return undefined;
    },
    /** Drop one flow. Idempotent: cancelling twice is not an error. */
    drop(id) {
      return flows.delete(id);
    },
    /**
     * Live flow count.
     *
     * `evictExpired`, NOT `evict`: asking how many logins are in progress must
     * never destroy one. (It did: `size` applied the cap, so merely counting two
     * flows under `maxFlows: 2` evicted them both down to one — a self-inflicted
     * disappearance that only a test calling `size` between `create`s could see.)
     */
    size(nowMs) {
      if (nowMs !== undefined) evictExpired(nowMs);
      return flows.size;
    },
    /**
     * Live flows only. Evicts expired ones first, so a flow whose TTL ran out
     * while nobody was asking is not reported as `pending` forever — `create` and
     * `get` evict, and a route that only ever calls `list` would otherwise never
     * do so. The CAP is deliberately not applied here: listing must not silently
     * drop a flow the operator can still complete.
     */
    list(nowMs) {
      if (nowMs !== undefined) evictExpired(nowMs);
      return [...flows.values()];
    },
  };
}

export { PROVIDERS, PROVIDER_IDS, describeProviders, getProvider } from './oauth/providers.js';
export { CALLBACK_PATH, createCallbackServer, callbackRedirectUri } from './oauth/callback.js';
export { createOAuthEngine, FLOW_STATUS } from './oauth/engine.js';
export { REFRESH_PROVIDERS, refreshAccountCredential } from './oauth/refresh.js';
