/**
 * The login engine: one place that knows the SHAPE of a login, and nothing about
 * any particular vendor.
 *
 * Lifecycle of one interactive login:
 *
 *   start()   → allocate flow id + PKCE + state, build the authorize URL, store
 *               the flow (transit only), hand back the URL
 *   (browser) → operator signs in at the vendor; the vendor redirects to the
 *               loopback listener with `code` & `state`, or the operator pastes
 *               the redirect URL / code by hand
 *   finish()  → validate `state` against the live flow, exchange the code for
 *               tokens, and hand the credential BUNDLE back to the caller
 *   cancel()  → drop the flow; nothing was persisted, so nothing to undo
 *
 * Why the engine does NOT write anything: the durable write is the caller's job
 * (`ctx.credentials` for the secret, a domain row for the account), and both must
 * happen in one order — secret first, row second — or a failed secret write
 * leaves a row pointing at nothing. Keeping that ordering at the seam that owns
 * both halves is why `finish()` returns data instead of storing it.
 *
 * A flow is single-use. `finish()` marks it consumed before returning, so a
 * replayed callback (the browser's "resend", or a double-clicked button) cannot
 * exchange the same code twice — the second attempt gets `flow-consumed`, which
 * is a *correct* answer rather than a bug to retry around.
 */
import { newFlowId, parseAuthInput, pkce, state as newState, withQuery } from './pkce.js';

/** Flow status values the management route reports. */
export const FLOW_STATUS = ['pending', 'done', 'error'];

/**
 * Fold a per-flow client override into the bundle that is about to be stored.
 *
 * `client_id` is what a later refresh sends (`refresh.js` reads it off the bundle
 * and falls back to the provider default), so an operator who registered their own
 * OAuth client would otherwise get an account whose first refresh fails with
 * `invalid_client` — hours after a login that looked completely successful.
 *
 * A client SECRET is only kept for providers that declare it as a client
 * property (`clientSecretEnv`): elsewhere the field means nothing, and a bundle is
 * exactly the wrong place to accumulate fields nothing reads.
 */
function withClientOverride(bundle, overrides = {}, provider = {}) {
  const next = { ...bundle };
  if (typeof overrides.clientId === 'string' && overrides.clientId !== '') {
    next.client_id = overrides.clientId;
  }
  if (provider.clientSecretEnv !== undefined
    && typeof overrides.clientSecret === 'string' && overrides.clientSecret !== '') {
    next.client_secret = overrides.clientSecret;
  }
  return next;
}

/**
 * @param options.providers - provider implementations, keyed by id.
 * @param options.fetchImpl - injected `fetch`.
 * @param options.store - {@link createFlowStore} instance.
 * @param options.clock - `{ now() }` in epoch ms.
 * @param options.onFinish - `async ({ flow, credentials, identity }) => ({ accountId, label })`;
 *   performs the durable write. Throwing here turns the flow into an `error`
 *   flow rather than losing the vendor's message.
 */
export function createOAuthEngine(options) {
  const { providers, fetchImpl, store, onFinish } = options;
  const clock = options.clock ?? { now: () => Date.now() };
  const now = () => clock.now();

  function providerFor(id) {
    const provider = providers?.[id];
    if (provider === undefined) throw new Error(`unknown oauth provider '${String(id)}'`);
    return provider;
  }

  /** The status payload the page polls. Never contains the verifier or any token. */
  function snapshot(flow) {
    return {
      id: flow.id,
      provider: flow.providerId,
      platform: flow.platform,
      status: flow.status,
      authUrl: flow.authUrl,
      redirectUri: flow.redirectUri,
      userCode: flow.userCode ?? null,
      verificationUrl: flow.verificationUrl ?? null,
      accountId: flow.accountId ?? null,
      label: flow.label ?? null,
      // A provider-specific "here is what this login still needs" note (Gemini's
      // project id, Anthropic's Claude Code mode). `null` when there is none.
      caveat: flow.caveat ?? null,
      error: flow.error ?? null,
      startedAt: new Date(flow.startedAtMs).toISOString(),
      expiresAt: new Date(flow.expiresAtMs).toISOString(),
    };
  }

  /**
   * Start one login.
   *
   * @param options.providerId - a key of `providers`.
   * @param options.redirectUri - the loopback URI resolved by the caller (it is
   *   the caller that owns the listener, so it owns the port).
   * @param options.label - optional operator-chosen name for the new account.
   * @param options.groupId - optional target group, recorded for `onFinish`.
   */
  function start(options = {}) {
    const provider = providerFor(options.providerId);
    // Two provider facts decide the shape of the material: the verifier alphabet
    // and whether the flow needs an OIDC nonce. Both come off the table rather
    // than from a branch here, so adding a vendor never edits the engine.
    const pair = pkce({ encoding: provider.pkceEncoding ?? 'base64url' });
    const antiCsrf = newState(undefined, provider.stateEncoding ?? 'base64url');
    const flowNonce = provider.needsNonce === true
      ? newState(undefined, provider.nonceEncoding ?? provider.stateEncoding ?? 'base64url')
      : undefined;
    const flowId = newFlowId(provider.id);
    /**
     * Which redirect URI this flow advertises, in priority order:
     *
     *   1. the caller's explicit value — an operator with THEIR OWN registered
     *      client passes its redirect here, which is why the field exists;
     *   2. `provider.fixedRedirectUri` — the vendor hosts the callback itself
     *      (Google's built-in client), so no local listener can receive it;
     *   3. the URI the caller RESOLVED from its bound listener. This is what makes
     *      the advertise/exchange pair consistent: the same string goes into the
     *      authorize URL and onto the flow, so the token exchange (which echoes it)
     *      cannot disagree with the URL the operator approved. Getting this wrong
     *      once produced a flow whose authorize URL and stored redirect differed —
     *      a guaranteed `redirect_uri` mismatch at exchange time;
     *   4. the provider's registered URI, reached only when there is no listener at
     *      all. For OpenAI that value is the ONLY acceptable one (see
     *      `callbackPort` in providers.js), so the host binds that port instead of
     *      this branch having to invent it.
     */
    const redirectUri = (typeof options.redirectUri === 'string' && options.redirectUri !== ''
      ? options.redirectUri
      : null)
      ?? provider.fixedRedirectUri
      ?? provider.defaultRedirectUri;
    if (redirectUri === undefined || redirectUri === null) {
      throw new Error(`oauth: provider '${provider.id}' declares no redirect URI and none was supplied`);
    }
    // The two endpoints and the client id are per FLOW, not per provider: the
    // Anthropic entries are unverified defaults, and an operator must be able to
    // correct them (or point at a relay's client) without editing this file.
    const overrides = {
      clientId: typeof options.clientId === 'string' && options.clientId.trim() !== '' ? options.clientId.trim() : provider.clientId,
      clientSecret: typeof options.clientSecret === 'string' && options.clientSecret !== '' ? options.clientSecret : provider.clientSecret,
      authorizeUrl: typeof options.authorizeUrl === 'string' && options.authorizeUrl.trim() !== '' ? options.authorizeUrl.trim() : provider.authorizeUrl,
      tokenUrl: typeof options.tokenUrl === 'string' && options.tokenUrl.trim() !== '' ? options.tokenUrl.trim() : provider.tokenUrl,
    };

    const authUrl = withQuery(overrides.authorizeUrl, provider.authorizeParams({
      redirectUri,
      pkce: pair,
      state: antiCsrf,
      nonce: flowNonce,
      ...overrides,
    }));

    const flow = store.create({
      id: flowId,
      providerId: provider.id,
      platform: provider.platform,
      status: 'pending',
      state: antiCsrf,
      nonce: flowNonce,
      verifier: pair.verifier,
      redirectUri,
      authUrl,
      overrides,
      label: typeof options.label === 'string' && options.label.trim() !== '' ? options.label.trim() : null,
      groupId: typeof options.groupId === 'string' && options.groupId !== '' ? options.groupId : null,
    }, now());

    return snapshot(flow);
  }

  /** Current state of one flow, or `undefined` once it has expired or been dropped. */
  function status(flowId) {
    const flow = store.get(flowId, now());
    return flow === undefined ? undefined : snapshot(flow);
  }

  /** Every live flow — what the page renders so a half-finished login is visible. */
  function list() {
    return store.list(now()).map((flow) => snapshot(flow));
  }

  function cancel(flowId) {
    const dropped = store.drop(flowId);
    return { ok: true, id: flowId, dropped };
  }

  /**
   * Complete a login from an authorization code (or a pasted redirect URL).
   *
   * @param options.flowId - the flow to complete. Required: a callback that
   *   cannot name its flow has no verifier to prove the exchange with.
   * @param options.input - the code, or `code#state`, or the whole redirect URL.
   * @param options.params - alternatively, already-parsed callback parameters
   *   (used by the loopback listener).
   * @param options.label - override the account label.
   */
  async function finish(options = {}) {
    const flow = store.get(options.flowId, now());
    if (flow === undefined) {
      throw new Error('this login has expired or was already cancelled — start a new one');
    }
    if (flow.status === 'done') {
      // Idempotent for the operator's benefit: re-reporting a finished login is
      // friendlier than an error, and it cannot exchange anything a second time.
      return { ...snapshot(flow), reused: true };
    }

    const provider = providerFor(flow.providerId);
    const parsed = options.params !== undefined
      ? { code: String(options.params.code ?? ''), state: options.params.state }
      : parseAuthInput(options.input);

    // `state` is checked BEFORE the flow is consumed, and a mismatch does NOT
    // poison it: a genuine CSRF attempt (or a stray paste) must not be able to
    // kill the operator's live login by sending a bad nonce.
    if (typeof parsed.state === 'string' && parsed.state !== '' && parsed.state !== flow.state) {
      flow.status = 'error';
      flow.error = 'state mismatch: this callback does not belong to this login';
      throw new Error(flow.error);
    }
    if (parsed.code === '') {
      flow.status = 'error';
      flow.error = 'no authorization code was supplied';
      throw new Error(flow.error);
    }
    // A vendor authorization code is SINGLE USE, and the flow holds the only
    // verifier that can redeem it. So the flow is consumed the moment a code that
    // passed the state gate is about to be exchanged: a second attempt (the
    // callback page reloaded, the button double-clicked, the same code pasted
    // twice) gets a clear refusal instead of a vendor `invalid_grant` that reads
    // like the login itself was broken.
    if (flow.consumed === true) {
      throw new Error('this authorization code was already exchanged — start a new login');
    }
    flow.consumed = true;

    flow.status = 'pending';
    flow.error = null;
    try {
      const exchanged = await provider.exchange({
        code: parsed.code,
        verifier: flow.verifier,
        redirectUri: flow.redirectUri,
        fetchImpl,
        nowMs: now(),
        ...flow.overrides,
      });
      // A per-flow client (the operator's own Google OAuth client, or a corrected
      // Anthropic one) has to survive into the stored bundle: the refresh that runs
      // hours later has no access to this flow, and a refresh re-sends `client_id`.
      // The reference stores `client_id` for exactly this reason
      // (openai_oauth_service.go:426-428, gemini_oauth_service.go:906-908).
      const bundle = withClientOverride(exchanged.bundle, flow.overrides, provider);
      const finished = await onFinish({
        flow,
        bundle,
        identity: exchanged.identity,
        caveat: exchanged.caveat,
        label: options.label ?? flow.label,
      });
      flow.status = 'done';
      flow.accountId = finished?.accountId ?? null;
      flow.label = finished?.label ?? flow.label;
      flow.caveat = finished?.caveat ?? exchanged.caveat ?? null;
      // The verifier has served its purpose; keeping it would leave the only
      // replayable half of the pair in memory for the rest of the TTL.
      flow.verifier = null;
      return snapshot(flow);
    } catch (error) {
      flow.status = 'error';
      flow.error = String(error?.message ?? error);
      throw error;
    }
  }

  return { start, status, list, cancel, finish, snapshot };
}
