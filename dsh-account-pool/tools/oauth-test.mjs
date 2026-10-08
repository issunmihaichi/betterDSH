/**
 * OAuth login tests: PKCE material, the flow state machine, every provider's URL
 * and token exchange, token refresh, and the loopback receiver.
 *
 * The whole path is offline. `fetch` is injected everywhere, so a "vendor" here is
 * a function returning a hand-written Response — no network, no DSH runtime, no
 * browser. The only real I/O is the loopback test, which binds 127.0.0.1 on an
 * OS-chosen port and talks to itself over HTTP.
 *
 * Where a literal could be checked, it is checked against a fact read out of the
 * reference implementation rather than against another function in this repo:
 * the RFC 7636 Appendix B PKCE vector, OpenAI's hex-verifier quirk, xAI's
 * `referrer=sub2api`, Google's fixed redirect. A test that only asserts "the code
 * agrees with itself" passes just as happily when the algorithm is wrong.
 *
 *   node tools/oauth-test.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { get } from 'node:http';

import {
  PROVIDERS, base64url, callbackRedirectUri, createCallbackServer, createFlowStore,
  createOAuthEngine, describeProviders, formEncode, identityFrom, newFlowId,
  parseAuthInput, pkce, postToken, readCallbackParams, state, withQuery,
} from '../lib/oauth.js';import {
  REFRESH_MARGIN_MS, encodeBundleObject, needsRefresh, parseBundle, refreshAccountCredential, refreshBundle,
} from '../lib/oauth/refresh.js';

const T0 = Date.parse('2026-06-01T00:00:00.000Z');
const clock = { now: () => T0 };

let checks = 0;
let passed = 0;
const failures = [];

async function check(label, fn) {
  checks += 1;
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failures.push({ label, error });
  }
}

/** A fake `fetch` that answers with one JSON body and records every request. */
function jsonFetch(body, options = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const status = options.status ?? 200;
    const payload = typeof body === 'function' ? body(calls.length) : body;
    return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { impl, calls };
}

/** A `fetch` that never settles until `release()` is called — for race tests. */
function deferredFetch(body) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let count = 0;
  const impl = async () => {
    count += 1;
    await gate;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { impl, release: () => release(), count: () => count };
}

/** Parse a URL's query into a plain object. */
function query(url) {
  return Object.fromEntries(new URL(url).searchParams);
}

// ------------------------------------------------- PKCE

await check('pkce: reproduces the RFC 7636 Appendix B vector from the verifier itself', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  // The RFC's own expected value, spelled out rather than recomputed.
  assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

await check('pkce: default verifier is base64url and its challenge is S256 of it', () => {
  const pair = pkce();
  assert.equal(pair.method, 'S256');
  assert.match(pair.verifier, /^[A-Za-z0-9_-]+$/, 'base64url alphabet, no padding');
  assert.equal(pair.verifier.includes('='), false);
  assert.equal(pair.challenge, base64url(createHash('sha256').update(pair.verifier).digest()));
});

await check('pkce: the hex variant hashes the HEX STRING (OpenAI\'s quirk)', () => {
  const pair = pkce({ encoding: 'hex' });
  assert.match(pair.verifier, /^[0-9a-f]+$/);
  assert.equal(pair.verifier.length, 128, '64 bytes → 128 hex chars');
  // The trap: hashing the bytes instead of the hex string produces a different
  // challenge, and only a test against the string catches it.
  const fromString = base64url(createHash('sha256').update(pair.verifier).digest());
  assert.equal(pair.challenge, fromString);
  const fromBytes = base64url(createHash('sha256').update(Buffer.from(pair.verifier, 'hex')).digest());
  assert.notEqual(pair.challenge, fromBytes, 'the challenge must be over the string the vendor receives');
});

await check('pkce: random bytes are injectable, so the pair is reproducible', () => {
  const bytes = Buffer.alloc(32, 7);
  const first = pkce({ random: bytes });
  const second = pkce({ random: Buffer.alloc(32, 7) });
  assert.deepEqual(first, second);
});

await check('state: base64url by default, hex on request', () => {
  assert.match(state(Buffer.alloc(16, 1)), /^[A-Za-z0-9_-]{22}$/);
  assert.match(state(Buffer.alloc(16, 1), 'hex'), /^[0-9a-f]{32}$/);
});

// ------------------------------------------------- small helpers

await check('formEncode: skips undefined/null and URL-encodes', () => {
  const encoded = formEncode({ a: '1', b: undefined, c: null, d: 'x y', e: 2 }).toString();
  assert.equal(encoded, 'a=1&d=x+y&e=2');
});

await check('withQuery: appends to a URL that already has a query', () => {
  const url = withQuery('https://example.com/auth?x=1', { y: '2', skip: undefined });
  assert.equal(url, 'https://example.com/auth?x=1&y=2');
});

await check('postToken: a non-2xx error carries the vendor\'s own words', async () => {
  const fetchImpl = jsonFetch({ error: 'invalid_grant', error_description: 'code expired' }, { status: 400 }).impl;
  await assert.rejects(
    postToken(fetchImpl, 'https://vendor/token', { body: 'x=1', headers: {} }),
    (error) => {
      assert.equal(error.code, 'invalid_grant');
      assert.equal(error.status, 400);
      assert.match(error.message, /code expired/);
      return true;
    },
  );
});

await check('postToken: a non-JSON body is an explicit failure, not a silent {}', async () => {
  const fetchImpl = jsonFetch('<html>nope</html>').impl;
  await assert.rejects(postToken(fetchImpl, 'https://vendor/token', { body: '', headers: {} }), /did not return JSON/);
});

await check('identityFrom: reads the id_token payload (email + sub)', () => {
  const claims = { email: 'a@example.com', sub: 'sub-1' };
  const payload = { id_token: `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y` };
  const identity = identityFrom(payload);
  assert.equal(identity.email, 'a@example.com');
  assert.equal(identity.accountId, 'sub-1');
});

await check('identityFrom: a malformed JWT does not throw', () => {
  const identity = identityFrom({ id_token: 'not-a-jwt', email: 'b@example.com' });
  assert.equal(identity.email, 'b@example.com');
  assert.equal(identity.accountId, null);
});

// ------------------------------------------------- input parsing

await check('parseAuthInput: bare code', () => {
  assert.deepEqual(parseAuthInput('abc123'), { code: 'abc123', state: undefined });
});

await check('parseAuthInput: `code#state` (the native-apps form)', () => {
  assert.deepEqual(parseAuthInput('abc#xyz'), { code: 'abc', state: 'xyz' });
});

await check('parseAuthInput: the whole redirect URL, which is what the address bar shows', () => {
  const parsed = parseAuthInput('http://localhost:1455/auth/callback?code=c1&state=s1&extra=2');
  assert.equal(parsed.code, 'c1');
  assert.equal(parsed.state, 's1');
});

await check('parseAuthInput: a bare query string still yields the code', () => {
  assert.equal(parseAuthInput('?code=c2&state=s2').code, 'c2');
  assert.equal(parseAuthInput('code=c3&state=s3').code, 'c3');
});

await check('readCallbackParams: a vendor error is surfaced verbatim, and keeps the state', () => {
  const refused = readCallbackParams({ error: 'access_denied', error_description: 'user said no', state: 's1' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'access_denied');
  assert.equal(refused.errorDescription, 'user said no');
  assert.equal(readCallbackParams({}).error, 'missing_code');
  const ok = readCallbackParams({ code: 'c', state: 's' });
  assert.deepEqual(ok, { ok: true, code: 'c', state: 's' });
});

// ------------------------------------------------- the flow store

await check('flowStore: create/get/drop, and an unknown id is undefined', () => {
  const store = createFlowStore();
  store.create({ id: 'f1', state: 's1' }, T0);
  assert.equal(store.get('f1', T0).id, 'f1');
  assert.equal(store.get('nope', T0), undefined);
  assert.equal(store.drop('f1'), true);
  assert.equal(store.get('f1', T0), undefined);
  assert.equal(store.drop('f1'), false, 'dropping twice is not an error');
});

await check('flowStore: a flow expires exactly at its TTL and is then unreachable', () => {
  const store = createFlowStore({ ttlMs: 1000 });
  store.create({ id: 'f1', state: 's1' }, T0);
  assert.ok(store.get('f1', T0 + 999));
  assert.equal(store.get('f1', T0 + 1000), undefined);
});

await check('flowStore: findByState only matches live flows', () => {
  const store = createFlowStore({ ttlMs: 1000 });
  store.create({ id: 'f1', state: 's1' }, T0);
  assert.equal(store.findByState('s1', T0).id, 'f1');
  assert.equal(store.findByState('other', T0), undefined);
  assert.equal(store.findByState('s1', T0 + 1000), undefined);
});

await check('flowStore: the cap evicts the OLDEST flow, and never the newest', () => {
  const store = createFlowStore({ maxFlows: 2 });
  store.create({ id: 'a', state: 'sa' }, T0);
  store.create({ id: 'b', state: 'sb' }, T0 + 1);
  store.create({ id: 'c', state: 'sc' }, T0 + 2);
  assert.equal(store.get('a', T0 + 3), undefined, 'a is the one dropped');
  assert.ok(store.get('b', T0 + 3));
  assert.ok(store.get('c', T0 + 3), 'the login just started survives');
  assert.equal(store.size(T0 + 3), 2, 'the cap is a cap, not a target one short of it');
});

await check('flowStore: list() evicts expired flows so they cannot report as pending', () => {
  const store = createFlowStore({ ttlMs: 10 });
  store.create({ id: 'old', state: 's' }, T0);
  assert.equal(store.list(T0 + 11).length, 0);
});

await check('newFlowId: prefixed with the provider and unique', () => {
  const a = newFlowId('openai');
  const b = newFlowId('openai');
  assert.match(a, /^openai-[A-Za-z0-9_-]+$/);
  assert.notEqual(a, b);
});

// ------------------------------------------------- engine: start

/** A provider stub that records the exchange input and returns a fixed bundle. */
function stubProvider(overrides = {}) {
  const seen = {};
  return {
    id: 'stub',
    platform: 'custom',
    authorizeUrl: 'https://vendor.example/auth',
    tokenUrl: 'https://vendor.example/token',
    clientId: 'client-1',
    scope: 's',
    defaultRedirectUri: 'http://localhost:9/cb',
    authorizeParams({ redirectUri, pkce: pair, state: antiCsrf, nonce, clientId }) {
      return { response_type: 'code', client_id: clientId ?? 'client-1', redirect_uri: redirectUri, state: antiCsrf, nonce, code_challenge: pair.challenge, code_challenge_method: pair.method };
    },
    async exchange(input) {
      Object.assign(seen, input);
      return { identity: { email: 'x@example.com', accountId: 'acct' }, bundle: { access_token: 'at', refresh_token: 'rt' } };
    },
    ...overrides,
    seen,
  };
}

function makeEngine(provider, onFinish) {
  return createOAuthEngine({
    providers: { [provider.id]: provider },
    fetchImpl: jsonFetch({}).impl,
    store: createFlowStore(),
    clock,
    onFinish,
  });
}

await check('engine.start: builds an authorize URL carrying state, PKCE and the redirect', () => {
  const provider = stubProvider();
  const engine = makeEngine(provider, async () => ({ accountId: 'a1' }));
  const flow = engine.start({ providerId: 'stub' });
  const q = query(flow.authUrl);
  assert.equal(q.client_id, 'client-1');
  assert.equal(q.code_challenge_method, 'S256');
  assert.equal(q.redirect_uri, 'http://localhost:9/cb');
  // The nonce in the URL is the one the flow will check a callback against — that
  // pairing is the entire anti-CSRF mechanism.
  assert.ok(typeof q.state === 'string' && q.state.length > 0, 'the URL must carry the nonce');
  assert.equal(flow.status, 'pending');
});

await check('engine.start: the verifier is NEVER in the flow snapshot', () => {
  const provider = stubProvider();
  const engine = makeEngine(provider, async () => ({ accountId: 'a1' }));
  const flow = engine.start({ providerId: 'stub' });
  assert.equal('verifier' in flow, false, 'the snapshot is what the page sees');
  assert.equal(Object.values(flow).includes(undefined), false, 'no undefined holes in the payload');
});

await check('engine.start: a per-flow client and endpoints override the provider defaults', () => {
  const provider = stubProvider();
  const engine = makeEngine(provider, async () => ({ accountId: 'a1' }));
  const flow = engine.start({ providerId: 'stub', authorizeUrl: 'https://relay.example/auth', clientId: 'mine' });
  assert.match(flow.authUrl, /^https:\/\/relay\.example\/auth\?/);
  assert.equal(query(flow.authUrl).client_id, 'mine');
});

await check('engine.start: an unknown provider is refused by name', () => {
  const engine = makeEngine(stubProvider(), async () => ({ accountId: 'a1' }));
  assert.throws(() => engine.start({ providerId: 'nope' }), /unknown oauth provider 'nope'/);
});

await check('engine: status/list report the flow, and cancel drops it', () => {
  const engine = makeEngine(stubProvider(), async () => ({ accountId: 'a1' }));
  const flow = engine.start({ providerId: 'stub' });
  assert.equal(engine.status(flow.id).id, flow.id);
  assert.equal(engine.list().length, 1);
  engine.cancel(flow.id);
  assert.equal(engine.status(flow.id), undefined);
  assert.equal(engine.list().length, 0);
});

// ------------------------------------------------- engine: finish

await check('engine.finish: exchanges the code and reports the created account', async () => {
  const provider = stubProvider();
  const created = [];
  const engine = makeEngine(provider, async (payload) => {
    created.push(payload);
    return { accountId: 'acct-1', label: 'x@example.com' };
  });
  const flow = engine.start({ providerId: 'stub' });
  const done = await engine.finish({ flowId: flow.id, input: 'the-code' });

  assert.equal(provider.seen.code, 'the-code');
  assert.equal(provider.seen.verifier.length > 0, true, 'the flow\'s verifier was handed to the exchange');
  assert.equal(provider.seen.redirectUri, 'http://localhost:9/cb');
  assert.equal(created.length, 1);
  assert.equal(created[0].bundle.access_token, 'at');
  assert.equal(done.status, 'done');
  assert.equal(done.accountId, 'acct-1');
  assert.equal(done.label, 'x@example.com');
});

await check('engine.finish: a pasted redirect URL works when it carries the right nonce', async () => {
  const provider = stubProvider();
  const engine = makeEngine(provider, async () => ({ accountId: 'acct-1' }));
  const flow = engine.start({ providerId: 'stub' });
  const url = new URL(flow.authUrl);
  const nonce = url.searchParams.get('state');
  const done = await engine.finish({
    flowId: flow.id,
    input: `http://localhost:9/cb?code=c9&state=${nonce}`,
  });
  assert.equal(provider.seen.code, 'c9');
  assert.equal(done.status, 'done');
});

await check('engine.finish: a pasted URL with a FOREIGN nonce is refused before any exchange', async () => {
  const provider = stubProvider();
  const engine = makeEngine(provider, async () => ({ accountId: 'acct-1' }));
  const flow = engine.start({ providerId: 'stub' });
  await assert.rejects(
    engine.finish({ flowId: flow.id, input: 'http://localhost:9/cb?code=c9&state=someone-elses' }),
    /state mismatch/,
  );
  assert.equal(provider.seen.code, undefined, 'a hostile callback must not reach the token endpoint');
});

await check('engine.finish: a state mismatch is refused and the flow is NOT consumed', async () => {
  const provider = stubProvider();
  const engine = makeEngine(provider, async () => ({ accountId: 'acct-1' }));
  const flow = engine.start({ providerId: 'stub' });
  await assert.rejects(
    engine.finish({ flowId: flow.id, params: { code: 'c', state: 'not-the-nonce' } }),
    /state mismatch/,
  );
  // A CSRF attempt (or a stray paste) must not be able to kill the live login.
  assert.equal(provider.seen.code, undefined, 'nothing was exchanged');
  const done = await engine.finish({ flowId: flow.id, params: { code: 'right', state: flow.state } });
  assert.equal(done.status, 'done');
});

await check('engine.finish: a code with NO state is accepted (the vendor may not echo it)', async () => {
  const provider = stubProvider();
  const engine = makeEngine(provider, async () => ({ accountId: 'acct-1' }));
  const flow = engine.start({ providerId: 'stub' });
  const done = await engine.finish({ flowId: flow.id, input: 'bare-code' });
  assert.equal(provider.seen.code, 'bare-code');
  assert.equal(done.status, 'done');
});

await check('engine.finish: a finished flow is reported back, never re-exchanged', async () => {
  let exchanges = 0;
  const provider = stubProvider({
    async exchange() {
      exchanges += 1;
      return { identity: {}, bundle: { access_token: 'at' } };
    },
  });
  const engine = makeEngine(provider, async () => ({ accountId: 'acct-1' }));
  const flow = engine.start({ providerId: 'stub' });
  const first = await engine.finish({ flowId: flow.id, params: { code: 'c', state: flow.state } });
  const second = await engine.finish({ flowId: flow.id, params: { code: 'c', state: flow.state } });

  assert.equal(exchanges, 1, 'exactly one exchange happened');
  assert.equal(second.reused, true, 'the second call is answered from the finished flow');
  assert.equal(second.accountId, first.accountId);
});

await check('engine.finish: a FAILED exchange burns the code — retrying says so instead of re-posting', async () => {
  // The vendor's code is single-use and the verifier is in this flow, so a retry
  // could not succeed even if it were sent. Being explicit about that is better
  // than a second `invalid_grant` that reads like a different bug.
  let exchanges = 0;
  const provider = stubProvider({
    async exchange() {
      exchanges += 1;
      throw new Error('token endpoint 400: code already redeemed');
    },
  });
  const engine = makeEngine(provider, async () => ({ accountId: 'acct-1' }));
  const flow = engine.start({ providerId: 'stub' });
  await assert.rejects(engine.finish({ flowId: flow.id, params: { code: 'c', state: flow.state } }), /already redeemed/);
  await assert.rejects(
    engine.finish({ flowId: flow.id, params: { code: 'c', state: flow.state } }),
    /already exchanged/,
  );
  assert.equal(exchanges, 1, 'the dead code was not posted twice');
});

await check('engine.finish: a vendor rejection marks the flow failed with the vendor message', async () => {
  const provider = stubProvider({
    async exchange() { throw new Error('token endpoint 400: code expired'); },
  });
  const engine = makeEngine(provider, async () => ({ accountId: 'acct-1' }));
  const flow = engine.start({ providerId: 'stub' });
  await assert.rejects(engine.finish({ flowId: flow.id, input: 'c' }), /code expired/);
  const after = engine.status(flow.id);
  assert.equal(after.status, 'error');
  assert.match(after.error, /code expired/);
});

await check('engine.finish: an unknown or expired flow says so instead of exchanging', async () => {
  const engine = makeEngine(stubProvider(), async () => ({ accountId: 'acct-1' }));
  await assert.rejects(engine.finish({ flowId: 'nope', input: 'c' }), /expired or was already cancelled/);
});

await check('engine.finish: an empty paste is refused', async () => {
  const engine = makeEngine(stubProvider(), async () => ({ accountId: 'acct-1' }));
  const flow = engine.start({ providerId: 'stub' });
  await assert.rejects(engine.finish({ flowId: flow.id, input: '   ' }), /no authorization code/);
});

await check('engine.finish: a CAVEAT travels to the snapshot (what the UI must warn about)', async () => {
  const provider = stubProvider({
    async exchange() {
      return { identity: {}, bundle: { access_token: 'at' }, caveat: 'needs a project id' };
    },
  });
  const engine = makeEngine(provider, async () => ({ accountId: 'a1' }));
  const flow = engine.start({ providerId: 'stub' });
  const done = await engine.finish({ flowId: flow.id, input: 'c' });
  assert.equal(done.caveat, 'needs a project id');
});

// ------------------------------------------------- provider registry

await check('providers: the four expected ids are registered', () => {
  assert.deepEqual(Object.keys(PROVIDERS).sort(), ['anthropic', 'gemini', 'grok', 'openai']);
  assert.deepEqual(describeProviders().map((p) => p.id), ['openai', 'grok', 'gemini', 'anthropic']);
});

await check('providers: only Anthropic is marked with unverified endpoints', () => {
  // The Claude OAuth client is not in the reference checkout, so its three
  // endpoint strings are the one thing in this feature that is NOT citable. The
  // mark is what makes that visible in the UI instead of hidden in a comment.
  assert.equal(PROVIDERS.anthropic.unverified, true);
  for (const id of ['openai', 'grok', 'gemini']) {
    assert.equal(PROVIDERS[id].unverified, undefined, `${id} must not claim to be unverified`);
  }
});

await check('providers: every authorize URL carries state, PKCE and a client id', () => {
  const pair = pkce();
  for (const id of Object.keys(PROVIDERS)) {
    const provider = PROVIDERS[id];
    const params = provider.authorizeParams({
      redirectUri: 'http://localhost:1/cb', pkce: pair, state: 'CSRF', nonce: 'N',
    });
    assert.equal(params.state, 'CSRF', `${id} must send the anti-CSRF state`);
    assert.equal(params.code_challenge, pair.challenge, `${id} must send the challenge`);
    assert.equal(params.code_challenge_method, 'S256', `${id} must use S256`);
    assert.ok(
      typeof params.client_id === 'string' && params.client_id !== '',
      `${id} must identify its client`,
    );
    assert.equal(params.redirect_uri, 'http://localhost:1/cb');
  }
});

await check('providers: OpenAI uses a HEX verifier and the two Codex flags', () => {
  const provider = PROVIDERS.openai;
  assert.equal(provider.pkceEncoding, 'hex');
  const params = provider.authorizeParams({ redirectUri: 'r', pkce: pkce({ encoding: 'hex' }), state: 's' });
  assert.equal(params.id_token_add_organizations, 'true');
  assert.equal(params.codex_cli_simplified_flow, 'true');
  assert.equal(params.client_id, 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.equal(provider.refreshScope, 'openid profile email');
});

await check('providers: xAI sends a nonce and the vendor\'s own referrer', () => {
  const provider = PROVIDERS.grok;
  assert.equal(provider.needsNonce, true);
  assert.equal(provider.stateEncoding, 'hex');
  const params = provider.authorizeParams({ redirectUri: 'r', pkce: pkce(), state: 's', nonce: 'n1' });
  assert.equal(params.nonce, 'n1');
  assert.equal(params.plan, 'generic');
  assert.equal(params.referrer, 'sub2api', 'the value the reference actually sends');
});

await check('providers: Google\'s built-in client has a FIXED redirect and says so', () => {
  const provider = PROVIDERS.gemini;
  assert.equal(provider.fixedRedirectUri, 'https://codeassist.google.com/authcode');
  assert.equal(provider.clientSecretEnv, 'GEMINI_CLI_OAUTH_CLIENT_SECRET');
  assert.match(provider.scope, /cloud-platform/);
  const described = describeProviders().find((entry) => entry.id === 'gemini');
  assert.equal(described.manualOnly, true, 'the UI must know the code has to be pasted');
  const others = describeProviders().filter((entry) => entry.id !== 'gemini');
  assert.equal(others.every((entry) => entry.manualOnly === false), true);
});

await check('providers: OpenAI pins the HOST and PATH of its registered redirect, but not the port', () => {
  // Read out of the real `codex.exe` (`CODEX_APP_SERVER_LOGIN_CLIENT_ID` sits next
  // to these): it serves `http://127.0.0.1:<port>/auth/callback`, and a live probe
  // of the authorize endpoint agrees —
  //
  //   127.0.0.1:<any port>/auth/callback   -> 302 accepted
  //   localhost:<any port>/auth/callback   -> 400 invalid_authorize_request
  //   127.0.0.1:<any port>/oauth/callback  -> 400 invalid_authorize_request
  //
  // So the two halves that must match the registration are the HOST and the PATH.
  // The port is free, which is why no port is pinned: a fixed port would only add
  // a way for the login to fail (something else holding it).
  const provider = PROVIDERS.openai;
  assert.equal(provider.callbackHost, '127.0.0.1', 'NOT `localhost` — a different string to the vendor');
  assert.equal(provider.callbackPath, '/auth/callback');
  assert.equal(provider.callbackPort, undefined, 'the port is the Codex client\'s free-port loopback');
  assert.equal(
    callbackRedirectUri(provider.callbackPort ?? 0, provider.callbackPath, provider.callbackHost),
    'http://127.0.0.1:0/auth/callback',
  );
  assert.match(provider.scope, /api\.connectors\.read/, 'the scope string the real CLI sends');
  assert.match(provider.scope, /api\.connectors\.invoke/);
});

await check('providers: a provider without a registered redirect keeps the free port', () => {
  // xAI publishes a default URI but treats it as a paste placeholder, and it is
  // env-overridable on the vendor's side — so pinning it would demand a port that
  // nothing guarantees is the right one.
  for (const id of ['grok', 'anthropic']) {
    assert.equal(PROVIDERS[id].callbackPort, undefined, `${id} must not pin a port`);
    assert.equal(PROVIDERS[id].callbackPath, undefined, `${id} must not pin a path`);
    assert.equal(describeProviders().find((entry) => entry.id === id).manualOnly, false);
  }
});

await check('engine.start: an operator-supplied redirect beats the provider default', () => {
  // Someone with their OWN registered OAuth client must be able to point the flow
  // at its redirect. Otherwise the field would be decorative and their client
  // would be unusable.
  const engine = createOAuthEngine({
    providers: { gemini: PROVIDERS.gemini, openai: PROVIDERS.openai },
    fetchImpl: jsonFetch({}).impl,
    store: createFlowStore(),
    clock,
    onFinish: async () => ({ accountId: 'g1' }),
  });

  const mine = engine.start({ providerId: 'openai', redirectUri: 'http://localhost:1455/auth/callback' });
  assert.equal(query(mine.authUrl).redirect_uri, 'http://localhost:1455/auth/callback');

  const custom = engine.start({ providerId: 'gemini', redirectUri: 'http://127.0.0.1:8080/cb' });
  assert.equal(query(custom.authUrl).redirect_uri, 'http://127.0.0.1:8080/cb');
});

await check('engine.start: with no redirect supplied, Google falls back to its fixed page', () => {
  const engine = createOAuthEngine({
    providers: { gemini: PROVIDERS.gemini },
    fetchImpl: jsonFetch({}).impl,
    store: createFlowStore(),
    clock,
    onFinish: async () => ({ accountId: 'g1' }),
  });
  const flow = engine.start({ providerId: 'gemini' });
  assert.equal(query(flow.authUrl).redirect_uri, 'https://codeassist.google.com/authcode');
  assert.equal(flow.redirectUri, 'https://codeassist.google.com/authcode');
});

await check('engine.start: a provider with no redirect at all fails loudly, not silently', () => {
  const engine = createOAuthEngine({
    providers: { bare: { id: 'bare', platform: 'custom', authorizeUrl: 'https://x/auth', tokenUrl: 'https://x/token', authorizeParams: () => ({}) } },
    fetchImpl: jsonFetch({}).impl,
    store: createFlowStore(),
    clock,
    onFinish: async () => ({ accountId: 'b1' }),
  });
  assert.throws(() => engine.start({ providerId: 'bare' }), /declares no redirect URI/);
});

// ------------------------------------------------- provider exchanges

await check('openai.exchange: form body with PKCE, and the bundle carries the Codex claims', async () => {
  const claims = { email: 'codex@example.com', sub: 'sub-9', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-9', chatgpt_plan_type: 'plus' } };
  const idToken = `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
  const fake = jsonFetch({ access_token: 'at-1', refresh_token: 'rt-1', id_token: idToken, expires_in: 3600, token_type: 'Bearer' });

  const result = await PROVIDERS.openai.exchange({
    code: 'c1', verifier: 'v1', redirectUri: 'http://localhost:1455/auth/callback', fetchImpl: fake.impl, nowMs: T0,
  });

  assert.equal(fake.calls[0].url, 'https://auth.openai.com/oauth/token');
  assert.equal(fake.calls[0].init.headers['content-type'], 'application/x-www-form-urlencoded');
  const body = new URLSearchParams(fake.calls[0].init.body);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code_verifier'), 'v1');
  assert.equal(body.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.equal(body.get('redirect_uri'), 'http://localhost:1455/auth/callback');

  assert.equal(result.bundle.access_token, 'at-1');
  assert.equal(result.bundle.email, 'codex@example.com');
  assert.equal(result.bundle.chatgpt_account_id, 'acct-9');
  assert.equal(result.bundle.plan_type, 'plus');
  assert.equal(result.bundle.expires_at, new Date(T0 + 3_600_000).toISOString());
  assert.equal(result.identity.email, 'codex@example.com');
});

await check('grok.exchange: form body, and the bundle records the CLI proxy base URL', async () => {
  const fake = jsonFetch({ access_token: 'at-g', refresh_token: 'rt-g', expires_in: 600, token_type: 'Bearer' });
  const result = await PROVIDERS.grok.exchange({
    code: 'c', verifier: 'v', redirectUri: 'http://127.0.0.1:56121/callback', fetchImpl: fake.impl, nowMs: T0,
  });
  assert.equal(fake.calls[0].url, 'https://auth.x.ai/oauth2/token');
  const body = new URLSearchParams(fake.calls[0].init.body);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('client_id'), 'b1a00492-073a-47ea-816f-4c329264a828');
  assert.equal(result.bundle.base_url, 'https://cli-chat-proxy.grok.com/v1');
});

await check('gemini.exchange: form body WITH a client secret, and a project-id caveat', async () => {
  process.env.GEMINI_CLI_OAUTH_CLIENT_SECRET = 'from-env';
  const fake = jsonFetch({ access_token: 'at-gm', refresh_token: 'rt-gm', expires_in: 3599, token_type: 'Bearer' });
  const result = await PROVIDERS.gemini.exchange({
    code: 'c', verifier: 'v', redirectUri: 'https://codeassist.google.com/authcode', fetchImpl: fake.impl, nowMs: T0,
  });
  const body = new URLSearchParams(fake.calls[0].init.body);
  assert.equal(body.get('client_secret'), 'from-env', 'Google requires the secret even for a PKCE client');
  assert.equal(body.get('client_id'), '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com');
  assert.equal(result.bundle.oauth_type, 'code_assist');
  assert.match(result.caveat, /project_id/);
  delete process.env.GEMINI_CLI_OAUTH_CLIENT_SECRET;
});

await check('anthropic.exchange: JSON body (the vendor\'s dialect) and org/account from the response', async () => {
  const fake = jsonFetch({
    access_token: 'at-a',
    refresh_token: 'rt-a',
    expires_in: 28800,
    organization: { uuid: 'org-1' },
    account: { uuid: 'acct-1', email_address: 'claude@example.com' },
  });
  const result = await PROVIDERS.anthropic.exchange({
    code: 'c', verifier: 'v', redirectUri: 'http://localhost:1/cb', fetchImpl: fake.impl, nowMs: T0,
  });
  assert.equal(fake.calls[0].init.headers['content-type'], 'application/json');
  assert.equal(JSON.parse(fake.calls[0].init.body).code_verifier, 'v');
  assert.equal(result.bundle.org_uuid, 'org-1');
  assert.equal(result.bundle.account_uuid, 'acct-1');
  assert.equal(result.bundle.email_address, 'claude@example.com');
  assert.match(result.caveat, /Claude Code mode/);
});

await check('every provider: a token response without access_token is an explicit failure', async () => {
  for (const id of Object.keys(PROVIDERS)) {
    const provider = PROVIDERS[id];
    const fake = jsonFetch({ token_type: 'Bearer' });
    await assert.rejects(
      provider.exchange({ code: 'c', verifier: 'v', redirectUri: 'r', fetchImpl: fake.impl, nowMs: T0 }),
      new RegExp(`${id === 'grok' ? 'xai' : id} access_token`),
      `${id} must not store a bundle with no bearer`,
    );
  }
});

// ------------------------------------------------- provider refresh

await check('every provider: refresh posts grant_type=refresh_token and rotates the token', async () => {
  for (const id of Object.keys(PROVIDERS)) {
    process.env.GEMINI_CLI_OAUTH_CLIENT_SECRET = 'from-env';
    const provider = PROVIDERS[id];
    const fake = jsonFetch({ access_token: `new-${id}`, expires_in: 3600 });
    const result = await provider.refresh({
      refreshToken: 'old-refresh', fetchImpl: fake.impl, nowMs: T0, clientId: 'cid',
    });
    assert.equal(fake.calls[0].url, provider.tokenUrl, `${id} must hit its own token endpoint`);
    const raw = fake.calls[0].init.body;
    const body = fake.calls[0].init.headers['content-type'].includes('json') ? JSON.parse(raw) : new URLSearchParams(raw);
    assert.equal(body.get?.('grant_type') ?? body.grant_type, 'refresh_token', `${id} grant type`);
    assert.equal(body.get?.('refresh_token') ?? body.refresh_token, 'old-refresh', `${id} refresh token`);
    assert.equal(result.accessToken, `new-${id}`);
    assert.equal(result.expiresAt, new Date(T0 + 3_600_000).toISOString());
    delete process.env.GEMINI_CLI_OAUTH_CLIENT_SECRET;
  }
});

// ------------------------------------------------- refresh policy

await check('needsRefresh: only when expiring inside the margin AND a refresh token exists', () => {
  const soon = new Date(T0 + REFRESH_MARGIN_MS - 1).toISOString();
  const far = new Date(T0 + REFRESH_MARGIN_MS + 60_000).toISOString();
  assert.equal(needsRefresh({ expires_at: soon, refresh_token: 'rt' }, T0), true);
  assert.equal(needsRefresh({ expires_at: far, refresh_token: 'rt' }, T0), false);
  assert.equal(needsRefresh({ expires_at: soon }, T0), false, 'no refresh token → nothing to do');
  assert.equal(needsRefresh({ refresh_token: 'rt' }, T0), false, 'no expiry → do not guess');
  assert.equal(needsRefresh({ expires_at: 'garbage', refresh_token: 'rt' }, T0), false);
  assert.equal(needsRefresh(null, T0), false);
});

await check('parseBundle: JSON → object, a bare key → undefined', () => {
  assert.deepEqual(parseBundle('{"access_token":"a"}'), { access_token: 'a' });
  assert.equal(parseBundle('sk-ant-abc'), undefined);
  assert.equal(parseBundle('{not json'), undefined);
  assert.equal(parseBundle(undefined), undefined);
});

await check('refreshBundle: not due → returns the same bundle and makes NO request', async () => {
  const fake = jsonFetch({ access_token: 'never' });
  const bundle = { access_token: 'at', refresh_token: 'rt', expires_at: new Date(T0 + 3_600_000).toISOString() };
  const result = await refreshBundle({ bundle, providerId: 'openai', fetchImpl: fake.impl, nowMs: T0 });
  assert.equal(result.refreshed, false);
  assert.equal(result.accessToken, 'at');
  assert.equal(fake.calls.length, 0);
});

await check('refreshBundle: due → rotates, keeps the new refresh token, keeps unrelated fields', async () => {
  const fake = jsonFetch({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 });
  const bundle = {
    access_token: 'at-old',
    refresh_token: 'rt-old',
    expires_at: new Date(T0).toISOString(),
    base_url: 'https://cli-chat-proxy.grok.com/v1',
    email: 'me@example.com',
  };
  const result = await refreshBundle({ bundle, providerId: 'grok', fetchImpl: fake.impl, nowMs: T0 });
  assert.equal(result.refreshed, true);
  assert.equal(result.bundle.access_token, 'at-new');
  assert.equal(result.bundle.refresh_token, 'rt-new');
  assert.equal(result.bundle.base_url, 'https://cli-chat-proxy.grok.com/v1', 'unrelated fields survive a refresh');
  assert.equal(result.bundle.email, 'me@example.com');
  assert.equal(result.bundle.expires_at, new Date(T0 + 3_600_000).toISOString());
});

await check('refreshBundle: a vendor that does NOT rotate keeps the old refresh token', async () => {
  const fake = jsonFetch({ access_token: 'at-new', expires_in: 60 });
  const bundle = { access_token: 'at-old', refresh_token: 'rt-old', expires_at: new Date(T0).toISOString() };
  const result = await refreshBundle({ bundle, providerId: 'grok', fetchImpl: fake.impl, nowMs: T0 });
  assert.equal(result.refreshed, true);
  assert.equal(result.bundle.refresh_token, 'rt-old', 'an absent field must not erase the working token');
});

await check('refreshBundle: a FAILED refresh returns the stale token instead of throwing', async () => {
  const warned = [];
  const fake = jsonFetch({ error: 'invalid_grant' }, { status: 400 });
  const bundle = { access_token: 'at-stale', refresh_token: 'rt-dead', expires_at: new Date(T0).toISOString() };
  const result = await refreshBundle({
    bundle, providerId: 'openai', fetchImpl: fake.impl, nowMs: T0, onWarn: (line) => warned.push(line),
  });
  assert.equal(result.refreshed, false);
  assert.equal(result.accessToken, 'at-stale', 'the upstream 401 is a better diagnostic than a thrown error here');
  assert.equal(warned.length, 1);
});

// ------------------------------------------------- credential resolution

/** A minimal `credentials` service stand-in, with optional write rejection. */
function fakeCredentials(initial) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return {
    values,
    writes,
    async resolve(ref) {
      return values.has(ref) ? { value: values.get(ref) } : undefined;
    },
    async set(ref, value) {
      writes.push({ ref, value });
      values.set(ref, value);
    },
  };
}

const OAUTH_PLATFORMS = ['openai', 'grok', 'gemini', 'anthropic'];

await check('refreshAccountCredential: an API-key account is not a refresh candidate', async () => {
  const credentials = fakeCredentials({ 'ACCOUNT_POOL_X': '{"access_token":"a","refresh_token":"r","expires_at":"1999-01-01T00:00:00.000Z"}' });
  const result = await refreshAccountCredential({
    credentials, credentialRef: 'ACCOUNT_POOL_X', platform: 'custom', fetchImpl: jsonFetch({}).impl, clock,
  });
  assert.equal(result, undefined, 'no refresher for this platform → the caller falls back to a plain read');
});

await check('refreshAccountCredential: a bare key is returned as-is', async () => {
  const credentials = fakeCredentials({ 'ACCOUNT_POOL_X': 'sk-plain-key' });
  for (const platform of OAUTH_PLATFORMS) {
    const result = await refreshAccountCredential({
      credentials, credentialRef: 'ACCOUNT_POOL_X', platform, fetchImpl: jsonFetch({}).impl, clock,
    });
    assert.equal(result, 'sk-plain-key');
  }
});

await check('refreshAccountCredential: a fresh bundle is returned without a write', async () => {
  const bundle = { access_token: 'at', refresh_token: 'rt', expires_at: new Date(T0 + 3_600_000).toISOString() };
  const credentials = fakeCredentials({ R: encodeBundleObject(bundle) });
  const result = await refreshAccountCredential({
    credentials, credentialRef: 'R', platform: 'openai', fetchImpl: jsonFetch({}).impl, clock,
  });
  assert.equal(result, 'at', 'the transport gets a BARE bearer, never the JSON bundle');
  assert.equal(credentials.writes.length, 0);
});

await check('refreshAccountCredential: a due bundle is refreshed and PERSISTED', async () => {
  const bundle = { access_token: 'at-old', refresh_token: 'rt-old', expires_at: new Date(T0 - 1000).toISOString() };
  const credentials = fakeCredentials({ R: encodeBundleObject(bundle) });
  const fake = jsonFetch({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 });
  const result = await refreshAccountCredential({
    credentials, credentialRef: 'R', platform: 'openai', fetchImpl: fake.impl, clock,
  });
  assert.equal(result, 'at-new');
  assert.equal(credentials.writes.length, 1);
  const stored = JSON.parse(credentials.values.get('R'));
  assert.equal(stored.access_token, 'at-new');
  assert.equal(stored.refresh_token, 'rt-new');
});

await check('refreshAccountCredential: N concurrent calls share ONE token request', async () => {
  const bundle = { access_token: 'at-old', refresh_token: 'rt-old', expires_at: new Date(T0 - 1000).toISOString() };
  const credentials = fakeCredentials({ R: encodeBundleObject(bundle) });
  const deferred = deferredFetch({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 });
  const inFlight = new Map();

  const pending = Array.from({ length: 5 }, () => refreshAccountCredential({
    credentials, credentialRef: 'R', platform: 'openai', fetchImpl: deferred.impl, clock, inFlight,
  }));
  // Let every caller reach the gate before releasing it.
  await new Promise((resolve) => setImmediate(resolve));
  deferred.release();
  const results = await Promise.all(pending);

  assert.deepEqual(results, ['at-new', 'at-new', 'at-new', 'at-new', 'at-new']);
  assert.equal(deferred.count(), 1, 'ten parallel requests must not open ten token requests');
  assert.equal(credentials.writes.length, 1, 'and must not overwrite each other\'s rotated refresh token');
  assert.equal(inFlight.size, 0, 'the in-flight entry is released');
});

await check('refreshAccountCredential: a rejected write still yields the refreshed bearer', async () => {
  // A read-only source shadows the reference: the token is valid for THIS request
  // and only the persistence is lost — so the request must still go out.
  const bundle = { access_token: 'at-old', refresh_token: 'rt-old', expires_at: new Date(T0 - 1000).toISOString() };
  const values = new Map([['R', encodeBundleObject(bundle)]]);
  const warned = [];
  const credentials = {
    async resolve(ref) { return values.has(ref) ? { value: values.get(ref) } : undefined; },
    async set() { throw new Error('read-only'); },
  };
  const fake = jsonFetch({ access_token: 'at-new', expires_in: 3600 });
  const result = await refreshAccountCredential({
    credentials, credentialRef: 'R', platform: 'grok', fetchImpl: fake.impl, clock, onWarn: (line) => warned.push(line),
  });
  assert.equal(result, 'at-new');
  assert.equal(warned.length, 1);
  assert.match(warned[0], /could not be persisted/);
});

await check('refreshAccountCredential: an unconfigured reference is undefined', async () => {
  const credentials = fakeCredentials({});
  for (const ref of ['', 'MISSING']) {
    const result = await refreshAccountCredential({
      credentials, credentialRef: ref, platform: 'openai', fetchImpl: jsonFetch({}).impl, clock,
    });
    assert.equal(result, undefined);
  }
});

await check('refreshAccountCredential: mixed return modes share a full refresh even when persistence rejects', async () => {
  const stored = { access_token: 'at-old', refresh_token: 'rt-old', expires_at: new Date(T0).toISOString(), project_id: 'keep-project', chatgpt_account_id: 'keep-account', client_id: 'custom-client', client_secret: 'custom-secret', arbitrary_metadata: { tier: 'paid' } };
  const credentials = fakeCredentials({ R: JSON.stringify(stored) });
  credentials.set = async () => { throw Error('raw-secret-error'); };
  const deferred = deferredFetch({ access_token: 'at-new', expires_in: 3600 });
  const inFlight = new Map();
  const options = { credentials, credentialRef: 'R', platform: 'gemini', fetchImpl: deferred.impl, clock, inFlight };
  const stringResult = refreshAccountCredential(options);
  const bundleResult = refreshAccountCredential({ ...options, returnBundle: true });
  await new Promise((resolve) => setImmediate(resolve));
  deferred.release();
  const [token, bundle] = await Promise.all([stringResult, bundleResult]);
  assert.equal(token, 'at-new');
  assert.equal(bundle.access_token, 'at-new');
  for (const field of ['project_id', 'chatgpt_account_id', 'client_id', 'client_secret', 'arbitrary_metadata']) assert.deepEqual(bundle[field], stored[field]);
  assert.equal(deferred.count(), 1);
  assert.equal(inFlight.size, 0);
  assert.equal(JSON.parse(credentials.values.get('R')).access_token, 'at-old');
});

await check('refreshAccountCredential: returnBundle preserves fresh/stale metadata without a refresh', async () => {
  const bundle = { accessToken: 'at-alias', project_id: 'project', refresh_token: 'r', expires_at: new Date(T0 + 3600000).toISOString() };
  const credentials = fakeCredentials({ R: JSON.stringify(bundle) });
  const fake = jsonFetch({});
  const result = await refreshAccountCredential({ credentials, credentialRef: 'R', platform: 'gemini', fetchImpl: fake.impl, clock, returnBundle: true });
  assert.equal(result.access_token, 'at-alias');
  assert.equal(result.project_id, 'project');
  assert.equal(fake.calls.length, 0);
  const failed = await refreshAccountCredential({ credentials: fakeCredentials({ R: JSON.stringify({ ...bundle, expires_at: new Date(T0).toISOString() }) }), credentialRef: 'R', platform: 'gemini', clock, returnBundle: true, fetchImpl: jsonFetch({ error: 'fixture-secret' }, { status: 400 }).impl });
  assert.equal(failed.project_id, 'project');
  assert.equal(failed.access_token, 'at-alias');
});

await check('OpenAI refresh: the new id token updates public account identity without erasing unrelated metadata', async () => {
  const claims = { email: 'renewed@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'new-workspace', chatgpt_user_id: 'new-user', chatgpt_plan_type: 'pro' } };
  const fake = jsonFetch({ access_token: 'at-new', id_token: `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`, expires_in: 3600 });
  const result = await refreshBundle({ bundle: { access_token: 'at-old', refresh_token: 'rt', expires_at: new Date(T0).toISOString(), chatgpt_account_id: 'old-workspace', project_id: 'keep' }, providerId: 'openai', fetchImpl: fake.impl, nowMs: T0 });
  assert.equal(result.bundle.chatgpt_account_id, 'new-workspace');
  assert.equal(result.bundle.chatgpt_user_id, 'new-user');
  assert.equal(result.bundle.plan_type, 'pro');
  assert.equal(result.bundle.project_id, 'keep');
});

await check('Gemini login: stores an explicit OAuth client secret and public project for later refresh', async () => {
  const fake = jsonFetch({ access_token: 'a', refresh_token: 'r', expires_in: 3600, project_id: 'login-project' });
  const result = await PROVIDERS.gemini.exchange({ code: 'c', verifier: 'v', redirectUri: PROVIDERS.gemini.fixedRedirectUri, fetchImpl: fake.impl, nowMs: T0, clientId: 'operator-client', clientSecret: 'operator-secret' });
  assert.equal(result.bundle.client_id, 'operator-client');
  assert.equal(result.bundle.client_secret, 'operator-secret');
  assert.equal(result.bundle.project_id, 'login-project');
});

// ------------------------------------------------- the loopback receiver

await check('callback: serves the OAuth path, hands the params over, answers with HTML', async () => {
  const seen = [];
  const server = await createCallbackServer({
    handler: async ({ params }) => {
      seen.push(params);
      return { ok: true, title: 'Sign-in complete', message: `Account ${params.code}` };
    },
  });
  try {
    assert.equal(server.redirectUri, callbackRedirectUri(server.port));
    // The DEFAULT host is `127.0.0.1`, not `localhost`: measured against OpenAI,
    // the authorization server accepts the first and refuses the second, and they
    // are different strings to it.
    assert.match(server.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);

    const response = await fetch(`${server.redirectUri}?code=C1&state=S1`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Sign-in complete/);
    assert.deepEqual(seen, [{ code: 'C1', state: 'S1' }], 'state must reach the handler — it is the CSRF gate');
  } finally {
    await server.close();
  }
});

await check('callback: a handler refusal is a 400 with the reason on the page', async () => {
  const server = await createCallbackServer({
    handler: async () => ({ ok: false, title: 'Nope', message: 'denied by the provider' }),
  });
  try {
    const response = await fetch(`${server.redirectUri}?error=access_denied`);
    assert.equal(response.status, 400);
    assert.match(await response.text(), /denied by the provider/);
  } finally {
    await server.close();
  }
});

await check('callback: a thrown handler is reported, never left as a hung socket', async () => {
  const server = await createCallbackServer({
    handler: async () => { throw new Error('boom'); },
  });
  try {
    const response = await fetch(server.redirectUri);
    assert.equal(response.status, 400);
    assert.match(await response.text(), /boom/);
  } finally {
    await server.close();
  }
});

await check('callback: any other path is a 404', async () => {
  const server = await createCallbackServer({ handler: async () => ({ ok: true, title: 'x', message: 'y' }) });
  try {
    const response = await fetch(`http://127.0.0.1:${String(server.port)}/somewhere-else`);
    assert.equal(response.status, 404);
  } finally {
    await server.close();
  }
});

await check('callback: finish cleanup delivers the complete response and releases the port', async () => {
  let closed;
  let cleanups = 0;
  const message = 'response-drain-marker '.repeat(32_768);
  const server = await createCallbackServer({
    handler: async ({ afterResponse }) => {
      afterResponse(() => {
        cleanups += 1;
        closed = server.close({ drain: true });
      });
      return { ok: true, title: 'Done', message };
    },
  });
  try {
    const response = await fetch(server.redirectUri, { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('connection'), 'close');
    const html = await response.text();
    assert.ok(html.includes(message), 'even a large answer must arrive before socket cleanup');
    assert.match(html, /<\/html>$/);
    await closed;
    assert.equal(cleanups, 1, 'finish and close must not both run cleanup');
    await assert.rejects(fetch(server.redirectUri));
  } finally {
    await server.close();
  }
});

await check('callback: a disconnected browser still runs completion cleanup exactly once', async () => {
  let started;
  let release;
  let cleaned;
  let cleanups = 0;
  const entered = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const cleanupDone = new Promise((resolve) => { cleaned = resolve; });
  const server = await createCallbackServer({ handler: async ({ afterResponse }) => {
    started();
    await gate;
    afterResponse(() => {
      cleanups += 1;
      void server.close({ drain: true }).then(cleaned);
    });
    return { ok: true, message: 'saved' };
  } });
  const request = get(server.redirectUri, { signal: AbortSignal.timeout(3000) });
  const disconnected = new Promise((resolve) => request.once('error', resolve));
  try {
    await entered;
    request.destroy();
    await disconnected;
    release();
    await cleanupDone;
    assert.equal(cleanups, 1);
    await assert.rejects(fetch(server.redirectUri));
  } finally {
    release();
    request.destroy();
    await server.close();
  }
});

await check('callback: forced shutdown interrupts a drain with an active handler', async () => {
  let started;
  let release;
  const entered = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const server = await createCallbackServer({ handler: async () => {
    started();
    await gate;
    return { ok: true, message: 'saved' };
  } });
  const request = get(server.redirectUri, { signal: AbortSignal.timeout(3000) });
  const disconnected = new Promise((resolve) => request.once('error', resolve));
  try {
    await entered;
    const draining = server.close({ drain: true });
    const forced = server.close();
    assert.equal(draining, forced, 'close calls share one completion promise');
    await forced;
    await disconnected;
    await assert.rejects(fetch(server.redirectUri));
  } finally {
    release();
    request.destroy();
    await server.close();
  }
});

await check('callback: graceful shutdown has a bounded drain for a stalled handler', async () => {
  let started;
  let release;
  const entered = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const server = await createCallbackServer({ handler: async () => {
    started();
    await gate;
    return { ok: true, message: 'saved' };
  } });
  const request = get(server.redirectUri, { signal: AbortSignal.timeout(3000) });
  const disconnected = new Promise((resolve) => request.once('error', resolve));
  try {
    await entered;
    await server.close({ drain: true });
    await disconnected;
    await assert.rejects(fetch(server.redirectUri));
  } finally {
    release();
    request.destroy();
    await server.close();
  }
});

await check('callback: handler titles, messages and thrown errors are HTML escaped', async () => {
  const unsafe = '<script>alert("x")</script> & \'text\'';
  for (const throws of [false, true]) {
    const server = await createCallbackServer({ handler: async () => {
      if (throws) throw new Error(unsafe);
      return { ok: false, title: unsafe, message: unsafe };
    } });
    try {
      const response = await fetch(server.redirectUri);
      assert.equal(response.status, 400);
      const html = await response.text();
      assert.equal(html.includes(unsafe), false);
      assert.equal(html.includes('<script>'), false);
      assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; &#39;text&#39;/);
    } finally {
      await server.close();
    }
  }
});

await check('callback: close() is idempotent and the port is really released', async () => {
  const server = await createCallbackServer({ handler: async () => ({ ok: true, title: 'x', message: 'y' }) });
  const { port } = server;
  await server.close();
  await server.close();
  await assert.rejects(fetch(`http://127.0.0.1:${String(port)}/oauth/callback`));
});

// ------------------------------------------------- report

if (failures.length > 0) {
  for (const { label, error } of failures) {
    console.error(`✗ ${label}\n    ${String(error.message).split('\n').join('\n    ')}`);
  }
  console.error(`\n${passed}/${checks} 通过，${failures.length} 失败`);
  process.exitCode = 1;
} else {
  console.log(`✓ ${passed}/${checks} 通过`);
}
