/**
 * Per-vendor OAuth facts: one object per provider, nothing shared but the shape.
 *
 * EVERY endpoint, client id, scope and token field name below was read out of a
 * working implementation, not recalled — the file each fact came from is cited
 * at the constant. That is the whole reason this is a table instead of code: an
 * OAuth client id or a token field that is off by one character produces a 400
 * from the vendor with no local symptom, so the table is where the citations
 * belong, right next to the values they justify.
 *
 * Sources (this workspace):
 *   - OpenAI    `_sub2api/repo/backend/internal/pkg/openai/oauth.go`
 *               `_sub2api/repo/backend/internal/service/openai_oauth_service.go`
 *   - xAI       `_sub2api/repo/backend/internal/pkg/xai/oauth.go`
 *               `_sub2api/repo/backend/internal/service/grok_oauth_service.go`
 *   - Gemini    `_sub2api/repo/backend/internal/pkg/geminicli/constants.go`
 *               `_sub2api/repo/backend/internal/pkg/geminicli/oauth.go`
 *               `_sub2api/repo/backend/internal/service/gemini_oauth_service.go`
 *   - Anthropic `_sub2api/repo/backend/internal/service/oauth_service.go` shows the
 *               shape (PKCE + code exchange + `organization`/`account` in the token
 *               response) but its HTTP client, `internal/pkg/oauth`, is NOT part of
 *               this checkout — so the three endpoint strings are the CLI's
 *               published pair and are marked UNVERIFIED below.
 *
 * What is deliberately NOT here: redirect URIs. They depend on the loopback port
 * the host half actually binds, so the engine passes them in per flow, and each
 * provider only supplies the vendor-specific extras (a nonce, a plan hint, a
 * client secret).
 */
import { expiresAtFrom, formEncode, identityFrom, postToken } from './pkce.js';

const JSON_HEADERS = { 'content-type': 'application/json' };
const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' };

/** Required, never defaulted: a missing one is a wiring bug, not a runtime state. */
function required(value, what) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error(`oauth: ${what} is required`);
  }
  return String(value).trim();
}

/**
 * The shared "authorization_code → tokens" request.
 *
 * Every vendor in this table wants the same nine fields with the same names and
 * differs only in the body encoding and in whether a client secret travels along.
 * Writing it once is what keeps the three providers from drifting apart.
 */
async function exchangeCode(options) {
  const {
    fetchImpl, tokenUrl, encoding, fields, clientSecret, extraHeaders = {}, nowMs,
  } = options;

  const all = { ...fields };
  if (clientSecret !== undefined) all.client_secret = clientSecret;

  const isForm = encoding === 'form';
  const payload = await postToken(fetchImpl, tokenUrl, {
    headers: isForm ? { ...FORM_HEADERS, ...extraHeaders } : { ...JSON_HEADERS, ...extraHeaders },
    body: isForm ? formEncode(all).toString() : JSON.stringify(all),
  });

  // `expires_at` is computed HERE, once, from the vendor's own `expires_in`. An
  // absolute instant is what the refresh layer compares against; letting each
  // provider format its own would be three chances to disagree.
  return { payload, expiresAt: expiresAtFrom(payload, nowMs) };
}

/** Refresh with the same dialect rules as the exchange. */
async function postRefresh(options) {
  const {
    fetchImpl, tokenUrl, encoding, fields, clientSecret, extraHeaders = {}, nowMs,
  } = options;
  const all = { ...fields };
  if (clientSecret !== undefined) all.client_secret = clientSecret;

  const isForm = encoding === 'form';
  const payload = await postToken(fetchImpl, tokenUrl, {
    headers: isForm ? { ...FORM_HEADERS, ...extraHeaders } : { ...JSON_HEADERS, ...extraHeaders },
    body: isForm ? formEncode(all).toString() : JSON.stringify(all),
  });
  return { payload, expiresAt: expiresAtFrom(payload, nowMs) };
}

/** Drop undefined/empty keys so a stored bundle has no blanks in it. */
function compact(object) {
  return Object.fromEntries(Object.entries(object)
    .filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

// ---------------------------------------------------------------------------
// OpenAI (Codex CLI client)
// ---------------------------------------------------------------------------

/**
 * `openai/oauth.go:19` — the Codex CLI's public client id.
 * PKCE here uses a HEX verifier (`openai/oauth.go:155-163` says so explicitly:
 * "OpenAI uses hex encoding instead of base64url") while the challenge is
 * base64url of its SHA-256 (`:167-177`). That asymmetry is the vendor's, and
 * getting it wrong is a plain `invalid_grant`.
 */
const OPENAI = {
  id: 'openai',
  label: 'OpenAI (Codex)',
  platform: 'openai',
  authorizeUrl: 'https://auth.openai.com/oauth/authorize', // openai/oauth.go:22, codex.exe
  tokenUrl: 'https://auth.openai.com/oauth/token', // openai/oauth.go:23, codex.exe
  /**
   * The Codex CLI's public client id, read out of the real `codex.exe` as the
   * value of `CODEX_APP_SERVER_LOGIN_CLIENT_ID` — not from the (older) reference
   * implementation, which happens to agree.
   */
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  pkceEncoding: 'hex', // openai/oauth.go:155-163
  /**
   * The scope string Codex actually requests, read out of `codex.exe`:
   *   `openid profile email offline_access api.connectors.read api.connectors.invoke`
   * The two `api.connectors.*` entries are what the CLI needs for its connector
   * surface. They are NOT required to be accepted (measured: the shorter string is
   * accepted too), but sending what the real client sends is the whole point of
   * this table.
   */
  scope: 'openid profile email offline_access api.connectors.read api.connectors.invoke',
  refreshScope: 'openid profile email', // openai/oauth.go:31
  /**
   * ⚠ THE REDIRECT URI IS REGISTERED, SO IT IS NOT OURS TO CHOOSE.
   *
   * Read out of the real `codex.exe`: it runs a loopback server on
   * `http://127.0.0.1:<PORT>/auth/callback`.
   *
   * Measured against the live authorize endpoint (see the matrix in
   * `tools/oauth-test.mjs`'s notes and DESIGN.md §22.11):
   *
   *   http://127.0.0.1:<any port>/auth/callback   -> 302 (accepted)
   *   http://localhost:<any port>/auth/callback   -> 400 invalid_authorize_request
   *   http://127.0.0.1:<any port>/oauth/callback  -> 400 invalid_authorize_request
   *
   * So: the HOST must be the literal `127.0.0.1` (NOT `localhost` — a different
   * string to the authorization server, not normalised), the PATH must be
   * `/auth/callback`, and the PORT is free. An earlier revision pinned
   * `localhost:1455`, taken from a stale reference constant; the hostname was
   * wrong, so the login still could not start.
   */
  callbackHost: '127.0.0.1',
  callbackPath: '/auth/callback',
  encoding: 'form',

  authorizeParams({ redirectUri, pkce: pair, state }) {
    return {
      response_type: 'code',
      client_id: OPENAI.clientId,
      redirect_uri: redirectUri,
      scope: OPENAI.scope,
      state,
      code_challenge: pair.challenge,
      code_challenge_method: pair.method,
      // Two OpenAI-only flags (openai/oauth.go:200-204): ask for organizations
      // inside the id_token, and use the Codex CLI's simplified consent flow.
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
    };
  },

  async exchange({ code, verifier, redirectUri, fetchImpl, nowMs }) {
    const { payload, expiresAt } = await exchangeCode({
      fetchImpl,
      tokenUrl: OPENAI.tokenUrl,
      encoding: OPENAI.encoding,
      fields: {
        grant_type: 'authorization_code',
        client_id: OPENAI.clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      },
      nowMs,
    });
    const identity = openaiIdentity(payload);
    return {
      identity,
      bundle: compact({
        access_token: required(payload.access_token, 'openai access_token'),
        refresh_token: payload.refresh_token,
        id_token: payload.id_token,
        expires_at: expiresAt,
        scope: payload.scope,
        token_type: payload.token_type,
        client_id: OPENAI.clientId,
        email: identity.email,
        chatgpt_account_id: identity.accountId,
        chatgpt_user_id: identity.chatgptUserId,
        organization_id: identity.organizationId,
        plan_type: identity.plan,
      }),
    };
  },

  async refresh({ refreshToken: token, fetchImpl, nowMs }) {
    const { payload, expiresAt } = await postRefresh({
      fetchImpl,
      tokenUrl: OPENAI.tokenUrl,
      encoding: OPENAI.encoding,
      fields: {
        grant_type: 'refresh_token',
        client_id: OPENAI.clientId,
        refresh_token: token,
        scope: OPENAI.refreshScope,
      },
      nowMs,
    });
    const identity = openaiIdentity(payload);
    return {
      accessToken: required(payload.access_token, 'openai access_token'),
      expiresAt,
      patch: compact({
        refresh_token: payload.refresh_token,
        id_token: payload.id_token,
        scope: payload.scope,
        token_type: payload.token_type,
        email: identity.email,
        chatgpt_account_id: identity.accountId,
        chatgpt_user_id: identity.chatgptUserId,
        organization_id: identity.organizationId,
        plan_type: identity.plan,
      }),
    };
  },

  /** A label for the account row when the operator did not type one. */
  labelFrom(identity) {
    return identity.email ?? identity.accountId ?? null;
  },
};

/**
 * OpenAI's identity lives under `https://api.openai.com/auth` in the id_token
 * (openai/oauth.go:252-264), alongside the standard `email`/`sub` claims.
 */
function openaiIdentity(payload) {
  const identity = identityFrom(payload);
  const auth = identity.claims?.['https://api.openai.com/auth'] ?? {};
  return {
    email: identity.email,
    accountId: auth.chatgpt_account_id ?? identity.accountId,
    plan: auth.chatgpt_plan_type ?? identity.plan,
    chatgptUserId: auth.chatgpt_user_id,
    organizationId: auth.poid ?? null,
  };
}

// ---------------------------------------------------------------------------
// xAI (Grok CLI client)
// ---------------------------------------------------------------------------

const XAI = {
  id: 'grok',
  label: 'xAI (Grok)',
  platform: 'grok',
  authorizeUrl: 'https://auth.x.ai/oauth2/authorize', // xai/oauth.go:27
  tokenUrl: 'https://auth.x.ai/oauth2/token', // xai/oauth.go:28
  clientId: 'b1a00492-073a-47ea-816f-4c329264a828', // xai/oauth.go:34
  scope: 'openid profile email offline_access grok-cli:access api:access', // xai/oauth.go:35
  /**
   * xAI's default is `127.0.0.1:56121/callback`, but the reference treats it as a
   * COPY/PASTE placeholder rather than a live listener — xAI is the one vendor
   * there whose callback parser accepts a whole pasted URL
   * (`xai/oauth.go:593-631`), which only makes sense if nothing is listening.
   *
   * The value is also env-overridable on the vendor's side (`XAI_OAUTH_REDIRECT_URI`),
   * so nothing guarantees 56121 is what it wants. This pool therefore binds a free
   * port and shows the URL, and pasting works either way. That is deliberately
   * DIFFERENT from OpenAI, whose registered URI is not negotiable.
   */
  defaultRedirectUri: 'http://127.0.0.1:56121/callback', // xai/oauth.go:36
  encoding: 'form',

  /**
   * `plan=generic` and `referrer` are the CLI's own hints (`xai/oauth.go:586-587`),
   * and `nonce` is part of the request rather than optional: xAI's authorize
   * endpoint is OIDC, and the nonce is what binds the id_token to this flow.
   */
  authorizeParams({ redirectUri, pkce: pair, state, nonce }) {
    return {
      response_type: 'code',
      client_id: XAI.clientId,
      redirect_uri: redirectUri,
      scope: XAI.scope,
      // `state` is NOT optional here and must survive into the URL: xAI has no
      // fixed redirect, so the loopback listener identifies the flow by matching
      // this value (`flowStore.findByState`). Dropping it — which an earlier
      // destructuring form of this function did — made every Grok login
      // unfinishable AND removed the anti-CSRF gate.
      state,
      nonce,
      code_challenge: pair.challenge,
      code_challenge_method: pair.method,
      plan: 'generic',
      // The vendor's own query param, and the reference does not invent a value
      // for it: `xai/oauth.go:587` sends the literal `sub2api`. Sending something
      // else risks the authorize endpoint rejecting an unknown referrer, so the
      // working value is the one kept.
      referrer: 'sub2api',
    };
  },

  needsNonce: true,
  /** xAI mints state as 32 hex bytes (`xai/oauth.go:529-535`), not base64url. */
  stateEncoding: 'hex',

  async exchange({ code, verifier, redirectUri, fetchImpl, nowMs }) {
    const { payload, expiresAt } = await exchangeCode({
      fetchImpl,
      tokenUrl: XAI.tokenUrl,
      encoding: XAI.encoding,
      fields: {
        grant_type: 'authorization_code',
        client_id: XAI.clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      },
      nowMs,
    });
    const identity = identityFrom(payload);
    return {
      identity,
      bundle: compact({
        access_token: required(payload.access_token, 'xai access_token'),
        refresh_token: payload.refresh_token,
        id_token: payload.id_token,
        expires_at: expiresAt,
        token_type: payload.token_type,
        scope: payload.scope,
        client_id: XAI.clientId,
        email: identity.email,
        sub: identity.accountId,
        // The Grok CLI talks to its own proxy, and the credential records it
        // (grok_oauth_service.go:383 stores exactly this default).
        base_url: 'https://cli-chat-proxy.grok.com/v1',
      }),
    };
  },

  async refresh({ refreshToken: token, fetchImpl, nowMs }) {
    const { payload, expiresAt } = await postRefresh({
      fetchImpl,
      tokenUrl: XAI.tokenUrl,
      encoding: XAI.encoding,
      fields: {
        grant_type: 'refresh_token',
        client_id: XAI.clientId,
        refresh_token: token,
      },
      nowMs,
    });
    const identity = identityFrom(payload);
    return {
      accessToken: required(payload.access_token, 'xai access_token'),
      expiresAt,
      patch: compact({
        refresh_token: payload.refresh_token,
        id_token: payload.id_token,
        token_type: payload.token_type,
        scope: payload.scope,
        email: identity.email,
      }),
    };
  },

  labelFrom(identity) {
    return identity.email ?? identity.accountId ?? null;
  },
};

// ---------------------------------------------------------------------------
// Google / Gemini (Gemini CLI client)
// ---------------------------------------------------------------------------

/**
 * Google's own installed-app client, published in the Gemini CLI and used here
 * as the default (`geminicli/constants.go:41-42`). Google requires a
 * `client_secret` on the token endpoint even for PKCE public clients, which is
 * why this is the one provider whose exchange carries one.
 *
 * ⚠ It is overridable per flow: an operator who registers their own Google OAuth
 * client passes `clientId`/`clientSecret` and the built-in pair is not used.
 */
const GEMINI = {
  id: 'gemini',
  label: 'Google (Gemini CLI)',
  platform: 'gemini',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth', // geminicli/constants.go:10
  tokenUrl: 'https://oauth2.googleapis.com/token', // geminicli/constants.go:11
  clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com', // constants.go:41
  /**
   * The Gemini CLI's own client secret, read from the environment rather than
   * embedded: Google requires a secret on the token endpoint even for a PKCE
   * public client, so the built-in client cannot complete an exchange without
   * one, but shipping a copied credential in this repository is a different act
   * from reading the one the operator already installed.
   *
   * `geminicli/constants.go:42-45` is the reference and it does exactly this —
   * hardcodes it AND honours `GEMINI_CLI_OAUTH_CLIENT_SECRET`. Here the env var is
   * the only path, and a missing value produces a token-endpoint rejection rather
   * than a silent fallback.
   */
  clientSecretEnv: 'GEMINI_CLI_OAUTH_CLIENT_SECRET',
  /**
   * ⚠ FIXED redirect, and that is the vendor's rule, not a choice:
   * `geminicli/constants.go:36` + `gemini_oauth_service.go:166-172` — the built-in
   * client may ONLY use `https://codeassist.google.com/authcode`. Google hands the
   * code to that page and the operator copies it back, so a loopback listener can
   * never receive it. Declared here so the host does not open a port for nothing.
   */
  fixedRedirectUri: 'https://codeassist.google.com/authcode',
  scope: 'https://www.googleapis.com/auth/cloud-platform '
    + 'https://www.googleapis.com/auth/userinfo.email '
    + 'https://www.googleapis.com/auth/userinfo.profile', // constants.go:21
  encoding: 'form',

  authorizeParams({ redirectUri, pkce: pair, state, clientId }) {
    return {
      response_type: 'code',
      client_id: clientId ?? GEMINI.clientId,
      redirect_uri: redirectUri,
      scope: GEMINI.scope,
      state,
      code_challenge: pair.challenge,
      code_challenge_method: pair.method,
      // Google-only: an offline grant (a refresh token at all) and a forced
      // consent screen, which is the only reliable way to get one back on a
      // repeat login (geminicli/oauth.go:262-264).
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    };
  },

  async exchange({ code, verifier, redirectUri, fetchImpl, nowMs, clientId, clientSecret }) {
    const { payload, expiresAt } = await exchangeCode({
      fetchImpl,
      tokenUrl: GEMINI.tokenUrl,
      encoding: GEMINI.encoding,
      clientSecret: clientSecret ?? geminiClientSecret(),
      fields: {
        grant_type: 'authorization_code',
        client_id: clientId ?? GEMINI.clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      },
      nowMs,
    });
    const identity = identityFrom(payload);
    return {
      identity,
      bundle: compact({
        access_token: required(payload.access_token, 'gemini access_token'),
        refresh_token: payload.refresh_token,
        expires_at: expiresAt,
        token_type: payload.token_type,
        scope: payload.scope,
        client_id: clientId ?? GEMINI.clientId,
        client_secret: clientSecret ?? geminiClientSecret(),
        project_id: payload.project_id ?? payload.projectId,
        email: identity.email,
        // `oauth_type` is what the gateway later uses to pick the API surface
        // (gemini_oauth_service.go:906-908): the Code Assist path, not AI Studio.
        oauth_type: 'code_assist',
      }),
      // Reported so the UI can say what the login still needs. Two things, both
      // from the reference: a Code Assist account is unusable without a
      // `project_id` (gemini_oauth_service.go:531-562), and the Gemini token
      // response carries NO id_token (geminicli/token_types.go:3-9), so there is
      // no email to name the account with.
      caveat: 'Code Assist account: the credential needs a `project_id` field (the reference fetches it from loadCodeAssist) and this vendor returns no email, so name the account by hand',
    };
  },

  async refresh({ refreshToken: token, fetchImpl, nowMs, clientId, clientSecret }) {
    const { payload, expiresAt } = await postRefresh({
      fetchImpl,
      tokenUrl: GEMINI.tokenUrl,
      encoding: GEMINI.encoding,
      clientSecret: clientSecret ?? geminiClientSecret(),
      fields: {
        grant_type: 'refresh_token',
        client_id: clientId ?? GEMINI.clientId,
        refresh_token: token,
      },
      nowMs,
    });
    return {
      accessToken: required(payload.access_token, 'gemini access_token'),
      expiresAt,
      patch: compact({
        refresh_token: payload.refresh_token,
        token_type: payload.token_type,
        scope: payload.scope,
      }),
    };
  },

  labelFrom(identity) {
    return identity.email ?? null;
  },
};

/** The Gemini CLI client secret, from the environment. Never a literal here. */
function geminiClientSecret() {
  const value = typeof process !== 'undefined' ? process.env?.[GEMINI.clientSecretEnv] : undefined;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

// ---------------------------------------------------------------------------
// Anthropic (Claude Code client)
// ---------------------------------------------------------------------------

/**
 * ⚠ UNVERIFIED ENDPOINTS.
 *
 * The Claude OAuth client is not in the reference checkout, so unlike the three
 * providers above these three strings are the Codex-era CLI's published pair
 * rather than a line I read. They are therefore:
 *   - overridable per flow (`authorizeUrl`/`tokenUrl`/`clientId` in the request
 *     body), so a drifted value is a configuration change, not a code change;
 *   - reported as `unverified: true` so the page can say so out loud;
 *   - NOT guessed further than this — no invented scope, no invented beta header.
 *
 * The response SHAPE is verified: `oauth_service.go:254-286` reads
 * `organization.uuid`, `account.uuid` and `account.email_address` off the token
 * response, and that is exactly what `anthropicIdentity` below does.
 */
const ANTHROPIC = {
  id: 'anthropic',
  label: 'Anthropic (Claude Code)',
  platform: 'anthropic',
  unverified: true,
  authorizeUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  /** Claude's PKCE verifier is base64url, like every other RFC 7636 client. */
  pkceEncoding: 'base64url',
  scope: 'org:create_api_key user:profile user:inference',
  encoding: 'json',

  authorizeParams({ redirectUri, pkce: pair, state }) {
    return {
      response_type: 'code',
      client_id: ANTHROPIC.clientId,
      redirect_uri: redirectUri,
      scope: ANTHROPIC.scope,
      state,
      code_challenge: pair.challenge,
      code_challenge_method: pair.method,
    };
  },

  async exchange({ code, verifier, redirectUri, fetchImpl, nowMs, clientId, authorizeUrl, tokenUrl }) {
    const { payload, expiresAt } = await exchangeCode({
      fetchImpl,
      tokenUrl: tokenUrl ?? ANTHROPIC.tokenUrl,
      encoding: ANTHROPIC.encoding,
      fields: {
        grant_type: 'authorization_code',
        client_id: clientId ?? ANTHROPIC.clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      },
      nowMs,
    });
    const identity = anthropicIdentity(payload);
    return {
      identity,
      bundle: compact({
        access_token: required(payload.access_token, 'anthropic access_token'),
        refresh_token: payload.refresh_token,
        expires_at: expiresAt ?? expiresAtFrom(payload, nowMs),
        token_type: payload.token_type,
        scope: payload.scope,
        org_uuid: identity.organizationId,
        account_uuid: identity.accountId,
        email_address: identity.email,
        client_id: clientId ?? ANTHROPIC.clientId,
      }),
      caveat: 'an anthropic subscription credential only works as the official CLI — enable Claude Code mode on this account',
    };
  },

  async refresh({ refreshToken: token, fetchImpl, nowMs, clientId, tokenUrl }) {
    const { payload, expiresAt } = await postRefresh({
      fetchImpl,
      tokenUrl: tokenUrl ?? ANTHROPIC.tokenUrl,
      encoding: ANTHROPIC.encoding,
      fields: {
        grant_type: 'refresh_token',
        client_id: clientId ?? ANTHROPIC.clientId,
        refresh_token: token,
      },
      nowMs,
    });
    const identity = anthropicIdentity(payload);
    return {
      accessToken: required(payload.access_token, 'anthropic access_token'),
      expiresAt,
      patch: compact({
        refresh_token: payload.refresh_token,
        token_type: payload.token_type,
        scope: payload.scope,
        org_uuid: identity.organizationId,
        email_address: identity.email,
      }),
    };
  },

  labelFrom(identity) {
    return identity.email ?? null;
  },
};

/** `oauth_service.go:270-283` — the token response carries the org and the account. */
function anthropicIdentity(payload) {
  const identity = identityFrom(payload);
  return {
    email: payload?.account?.email_address ?? identity.email,
    accountId: payload?.account?.uuid ?? identity.accountId,
    organizationId: payload?.organization?.uuid ?? null,
    plan: payload?.organization?.organization_type ?? identity.plan,
  };
}

/** The registry. Keys are the ids the management route accepts. */
export const PROVIDERS = {
  [OPENAI.id]: OPENAI,
  [XAI.id]: XAI,
  [GEMINI.id]: GEMINI,
  [ANTHROPIC.id]: ANTHROPIC,
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

export function getProvider(id) {
  return PROVIDERS[String(id ?? '')];
}

/** `{ id, label, platform, unverified }` per provider, for the page's picker. */
export function describeProviders() {
  return PROVIDER_IDS.map((id) => ({
    id,
    label: PROVIDERS[id].label,
    platform: PROVIDERS[id].platform,
    unverified: PROVIDERS[id].unverified === true,
    // `true` means the vendor owns the redirect URI, so the operator MUST copy the
    // code back by hand and a loopback listener can never receive it.
    manualOnly: typeof PROVIDERS[id].fixedRedirectUri === 'string',
  }));
}
