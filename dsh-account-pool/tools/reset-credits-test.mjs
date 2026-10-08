import assert from 'node:assert/strict';
import { createQuotaService, QUOTA_URLS } from '../lib/quota.js';
import { RESET_CREDITS_URL, RESET_CREDITS_RESULT_TTL_MS, normalizeResetCredits } from '../lib/reset-credits.js';
import { mountPool, ROUTES } from '../lib/host.js';

const T0 = Date.parse('2026-06-01T00:00:00Z');
const ID = '27b4af92-6c7a-4d99-ae88-d871e4b12211';
const OTHER_ID = '27b4af92-6c7a-4d99-ae88-d871e4b12212';
const account = (extra = {}) => ({ id: 'codex', platform: 'openai', authMode: 'oauth', credentialRef: 'R', chatgptAccountId: 'fixture-workspace', ...extra });
const bundle = { access_token: 'fixture-access-secret', refresh_token: 'fixture-refresh-secret', chatgpt_account_id: 'fixture-bundle-workspace' };
const usage = { rate_limit: { primary_window: { used_percent: 10 } } };
const clock = () => ({ t: T0, now() { return this.t; } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const turn = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let release; const promise = new Promise((resolve) => { release = resolve; }); return { promise, release }; }
function safe(value) {
  for (const secret of ['fixture-access-secret', 'fixture-refresh-secret', 'fixture-card-id', 'raw-error-secret']) assert.equal(JSON.stringify(value).includes(secret), false);
}
const serviceOf = (fetchImpl, options = {}) => createQuotaService({ clock: clock(), resolveCredential: async () => bundle, fetchImpl, ...options });
let checks = 0;
let passed = 0;
const failures = [];
async function check(label, fn) { checks++; try { await fn(); passed++; } catch (error) { failures.push({ label, error }); } }

// All host state and credentials below are fixtures held in memory.
async function hostOf(fetchImpl, extra = {}) {
  const { beforeAccountPut, ...mountOptions } = extra;
  const routes = new Map();
  const tables = new Map();
  let global = { totalRequests: 0 };
  const domain = { global: { get: () => global, set: async (value) => { global = value; } }, close: async () => {}, table(name) {
    if (!tables.has(name)) tables.set(name, new Map());
    const map = tables.get(name);
    return { get: (key) => map.get(key), entries: () => map.entries(), put: async (key, value) => {
      if (name === 'accounts') beforeAccountPut?.(key, value);
      map.set(key, value);
    }, delete: async (key) => map.delete(key) };
  } };
  const credentials = { resolve: async () => ({ value: JSON.stringify(bundle) }), describe: async () => ({ configured: true, writable: true }), set: async () => {} };
  const services = { credentials, storageDomain: { open: async () => domain }, connection: { fetch: { register(route) { routes.set(route.path, route); return () => {}; } } } };
  const ctx = { storageDomain: services.storageDomain, get: (name) => services[name], effect: (fn) => fn() };
  const mounted = await mountPool(ctx, { clock: clock(), refreshEnabled: false, accounts: [
    account({ status: 'disabled', schedulable: false, rateLimitResetAt: new Date(T0 + 60_000).toISOString() }),
    account({ id: 'api', authMode: 'api-key' }), account({ id: 'claude', platform: 'anthropic' }),
  ], fetchImpl, ...mountOptions });
  const post = (body) => routes.get(ROUTES.account).fetch(new Request(`http://fixture.invalid${ROUTES.account}`, { method: 'POST', body: JSON.stringify(body) }));
  const get = () => routes.get(ROUTES.accounts).fetch(new Request(`http://fixture.invalid${ROUTES.accounts}`)).then((response) => response.json());
  return { mounted, post, get };
}

await check('1. Count/list envelopes normalize only available Codex grants and public ISO expiry', () => {
  const cards = [
    { id: 'fixture-card-id', status: 'available', reset_type: 'codex_rate_limits', expires_at: '2026-07-01T00:00:00Z', token: bundle.access_token },
    { creditId: 'fixture-card-id', status: 'available', resetType: 'codex_rate_limits', expiresAt: 'invalid' },
    { status: 'used', reset_type: 'codex_rate_limits' }, { status: 'available', reset_type: 'other' }, null,
  ];
  const expected = { availableCount: 2, credits: [{ expiresAt: '2026-07-01T00:00:00.000Z' }, { expiresAt: null }] };
  for (const payload of [cards, ...['credits', 'rate_limit_reset_credits', 'items', 'data'].map((key) => ({ [key]: cards }))]) {
    assert.deepEqual(normalizeResetCredits(payload), expected);
    safe(normalizeResetCredits(payload));
  }
  assert.deepEqual(normalizeResetCredits({ availableCount: '3' }), { availableCount: 3, credits: [] });
  assert.equal(normalizeResetCredits({ available_count: 0, credits: cards }).availableCount, 0);
  for (const payload of [{}, null, { available_count: -1 }, { credits: {} }]) assert.throws(() => normalizeResetCredits(payload));
});

await check('2. Reset-credit reads share refresh/TTL/single flight and keep safe stale failures', async () => {
  const c = clock();
  const gate = deferred();
  let refreshes = 0;
  let reads = 0;
  let reject = false;
  const service = createQuotaService({ clock: c, credentials: { resolve: async () => ({ value: JSON.stringify({ ...bundle, expires_at: new Date(T0).toISOString() }) }), set: async () => {} }, fetchImpl: async (url, init) => {
    if (url === 'https://auth.openai.com/oauth/token') { refreshes++; await gate.promise; return json({ access_token: 'fresh-fixture-secret', expires_in: 3600 }); }
    assert.equal(init.headers.authorization, 'Bearer fresh-fixture-secret');
    assert.equal(init.headers['chatgpt-account-id'], 'fixture-bundle-workspace');
    assert.equal(init.headers.originator, 'codex_cli_rs');
    assert.equal(init.redirect, 'error');
    if (url === QUOTA_URLS.openai) return json(usage);
    assert.equal(url, RESET_CREDITS_URL);
    assert.equal(init.method, 'GET');
    reads++;
    return reject ? json({ private: 'raw-error-secret' }, 401) : json({ available_count: 2 });
  } });
  const row = account({ chatgptAccountId: null });
  try {
    assert.equal(service.peekResetCredits(row), null);
    const tasks = [service.get(row), service.getResetCredits(row), service.getResetCredits(row, { force: true })];
    await turn(); gate.release();
    const values = await Promise.all(tasks);
    assert.equal(values.every((value) => value.ok), true);
    assert.equal(refreshes, 1); assert.equal(reads, 1);
    await service.getResetCredits({ ...row, updatedAt: 'activity-only' });
    assert.equal(reads, 1);
    c.t += 60_001;
    assert.equal(service.peekResetCredits(row).stale, true);
    reject = true;
    const failed = await service.getResetCredits(row, { force: true });
    assert.equal(failed.ok, false); assert.equal(failed.availableCount, null); assert.deepEqual(failed.credits, []);
    assert.equal(failed.stale, true); assert.equal(failed.lastSuccessAt, values[1].at);
    assert.equal(failed.error.status, 401); safe(failed);
    values[1].credits.push({ expiresAt: 'mutated' });
    assert.deepEqual(service.peekResetCredits(row).credits, []);
  } finally { gate.release(); service.dispose(); }
});

await check('3. Host validates before network, publishes capability and consumes only an explicit UUID', async () => {
  const calls = [];
  let consumed = false;
  let failCards = false;
  const { mounted, post, get } = await hostOf(async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    assert.equal(init.headers['chatgpt-account-id'], 'fixture-workspace');
    if (url === QUOTA_URLS.openai) return json(usage);
    if (url === RESET_CREDITS_URL) return failCards ? json({ private: 'raw-error-secret' }, 503) : json({ available_count: consumed ? 0 : 1 });
    assert.equal(url, `${RESET_CREDITS_URL}/consume`);
    assert.deepEqual(JSON.parse(init.body), { redeem_request_id: ID });
    consumed = true;
    return json({ code: 'success', windows_reset: 2, private: 'fixture-card-id' });
  });
  try {
    const initial = await get();
    assert.equal(initial.resetCreditsVersion, 1); assert.equal(initial.accounts.every((row) => row.resetCredits === null), true);
    const input = { action: 'quota-reset', id: 'codex', confirm: true, requestId: ID };
    for (const patch of [{ id: 'api' }, { id: 'claude' }, { confirm: false }, { confirm: 'true' }, { requestId: 'not-uuid' }, { requestId: ` ${ID}` }]) assert.equal((await post({ ...input, ...patch })).status, 400);
    assert.equal(calls.length, 0);
    failCards = true;
    const read = await (await post({ action: 'quota', id: 'codex', force: true })).json();
    assert.equal(read.quota.ok, true); assert.equal(read.resetCredits.ok, false);
    failCards = false;
    const before = mounted.adapter.getAccount('codex');
    const result = await (await post(input)).json();
    assert.deepEqual(result.reset, { code: 'success', windowsReset: 2 });
    assert.equal(result.ok, true); assert.equal(result.quota.ok, true); assert.equal(result.resetCredits.availableCount, 0);
    assert.deepEqual(mounted.adapter.getAccount('codex'), before);
    assert.deepEqual((await get()).accounts.find((row) => row.id === 'codex').resetCredits, result.resetCredits);
    const replay = await (await post(input)).json();
    assert.equal(replay.ok, true); assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
    safe(result); safe(await get());
  } finally { await mounted.dispose(); }
});

await check('4. One account shares the same UUID, rejects another and aborts pre-reset read races', async () => {
  const postGate = deferred();
  const quotaGate = deferred();
  const cardsGate = deferred();
  let posts = 0;
  let cardReads = 0;
  let quotaReads = 0;
  let cardSignal;
  const c = clock();
  const service = serviceOf(async (url, init) => {
    if (url === QUOTA_URLS.openai) { quotaReads++; if (quotaReads === 1) await quotaGate.promise; return json(usage); }
    if (url === RESET_CREDITS_URL) { cardReads++; if (cardReads === 2) { cardSignal = init.signal; await cardsGate.promise; } return json({ available_count: 1 }); }
    posts++; await postGate.promise; return json({ code: 'ok', windows_reset: 1 });
  }, { clock: c });
  try {
    const oldQuota = service.get(account());
    const first = service.consumeResetCredit(account(), { requestId: ID });
    await turn();
    const same = service.consumeResetCredit(account(), { requestId: ID });
    const oldCards = service.getResetCredits(account(), { force: true });
    await turn();
    assert.equal((await service.consumeResetCredit(account(), { requestId: OTHER_ID })).error.code, 'reset-busy');
    postGate.release();
    assert.equal((await first).ok, true); assert.deepEqual(await same, await first); assert.equal(posts, 1);
    assert.equal((await oldQuota).errorCode, 'canceled'); assert.equal((await oldCards).error.code, 'canceled');
    assert.equal(cardSignal.aborted, true);
    quotaGate.release(); cardsGate.release(); await turn();
    assert.equal(service.peek(account()), null); assert.equal(service.peekResetCredits(account()), null);
    assert.equal((await service.get(account(), { force: true })).ok, true);
    assert.equal((await service.getResetCredits(account(), { force: true })).ok, true);
    await service.consumeResetCredit(account(), { requestId: ID }); assert.equal(posts, 1);
    c.t += RESET_CREDITS_RESULT_TTL_MS + 1;
    await service.consumeResetCredit(account(), { requestId: ID }); assert.equal(posts, 2);
  } finally { postGate.release(); quotaGate.release(); cardsGate.release(); service.dispose(); }
});

await check('5. Fresh zero/unknown cards never consume and HTTP/business bodies cannot fake success', async () => {
  let mode = 'available';
  let posts = 0;
  const service = serviceOf(async (url) => {
    if (url === RESET_CREDITS_URL) return mode === 'error' ? json({ private: 'raw-error-secret' }, 503) : json({ available_count: mode === 'zero' ? 0 : 1 });
    posts++; return json({ code: 'success', windows_reset: 1 });
  });
  try {
    await service.getResetCredits(account());
    mode = 'error';
    const unknown = await service.consumeResetCredit(account(), { requestId: ID });
    assert.equal(unknown.error.code, 'reset-credits-unavailable'); assert.equal(unknown.resetCredits.availableCount, null);
    mode = 'zero';
    assert.equal((await service.consumeResetCredit(account(), { requestId: ID })).error.code, 'no-reset-credits');
    assert.equal(posts, 0); safe(unknown);
  } finally { service.dispose(); }
  for (const response of [() => json({ code: 'success', windows_reset: 0 }), () => json({ code: 'ok', windows_reset: 1.5 }), () => json({ code: 'fixture-access-secret', windows_reset: 2 }), () => new Response('raw-error-secret'), () => json({ private: 'raw-error-secret' }, 401), () => json({ code: 'no_credit', windows_reset: 0 })]) {
    const candidate = serviceOf(async (url) => url === RESET_CREDITS_URL ? json({ availableCount: 1 }) : response());
    try { const result = await candidate.consumeResetCredit(account(), { requestId: ID }); assert.equal(result.ok, false); safe(result); }
    finally { candidate.dispose(); }
  }
});

await check('6. Timeout/network uncertainty never retries automatically; explicit same UUID recovers at zero cards', async () => {
  for (const fail of ['timeout', 'network']) {
    let posts = 0;
    let reads = 0;
    let signal;
    const ids = [];
    const service = serviceOf(async (url, init) => {
      if (url === RESET_CREDITS_URL) { reads++; return json({ available_count: posts ? 0 : 1 }); }
      posts++; ids.push(JSON.parse(init.body).redeem_request_id); signal = init.signal;
      if (posts === 1) { if (fail === 'network') throw Error('raw-error-secret'); return new Promise(() => {}); }
      if (posts === 2) return json({ private: 'raw-error-secret' }, 401);
      return json({ code: 'success', windows_reset: 1 });
    }, { timeoutMs: 25 });
    try {
      const first = await service.consumeResetCredit(account(), { requestId: ID });
      assert.equal(first.uncertain, true); assert.equal(first.error.code, 'reset-result-uncertain'); assert.equal(first.requestId, ID);
      if (fail === 'timeout') assert.equal(signal.aborted, true);
      assert.equal(posts, 1);
      const blocked = await service.consumeResetCredit(account(), { requestId: OTHER_ID });
      assert.equal(blocked.httpStatus, 409); assert.equal(blocked.requestId, ID); assert.equal(posts, 1);
      assert.equal((await service.getResetCredits(account(), { force: true })).availableCount, 0);
      const deniedRecovery = await service.consumeResetCredit(account(), { requestId: ID });
      assert.equal(deniedRecovery.uncertain, true); assert.equal(deniedRecovery.error.status, 401);
      assert.equal((await service.consumeResetCredit(account(), { requestId: OTHER_ID })).requestId, ID);
      const recovered = await service.consumeResetCredit(account(), { requestId: ID });
      assert.equal(recovered.ok, true); assert.deepEqual(ids, [ID, ID, ID]); assert.equal(reads, 2);
      await service.consumeResetCredit(account(), { requestId: ID }); assert.equal(posts, 3);
      safe(first); safe(blocked); safe(deniedRecovery); safe(recovered);
    } finally { service.dispose(); }
  }
});

await check('7. Host keeps confirmed consumption success when both refreshes fail and replay never consumes twice', async () => {
  let posts = 0;
  const refreshGate = deferred();
  const { mounted, post } = await hostOf(async (url, init) => {
    if (init.method === 'POST') { posts++; return json({ code: 'ok', windows_reset: 3 }); }
    if (posts) { await refreshGate.promise; return json({ private: 'raw-error-secret', token: bundle.access_token }, 503); }
    return json(url === RESET_CREDITS_URL ? { available_count: 1 } : usage);
  });
  try {
    const body = { action: 'quota-reset', id: 'codex', confirm: true, requestId: ID };
    const pending = post(body); await turn();
    const same = post(body);
    const busy = await post({ ...body, requestId: OTHER_ID });
    assert.equal(busy.status, 409); assert.equal((await busy.json()).requestId, ID); assert.equal(posts, 1);
    refreshGate.release();
    const response = await pending; const result = await response.json();
    assert.deepEqual(await (await same).json(), result);
    assert.equal(response.status, 200); assert.equal(result.ok, true); assert.deepEqual(result.reset, { code: 'ok', windowsReset: 3 });
    assert.equal(result.quota.ok, false); assert.equal(result.resetCredits.ok, false); assert.equal(result.refreshError.code, 'quota-reset-refresh-failed');
    const replay = await (await post(body)).json(); assert.equal(replay.ok, true); assert.equal(posts, 1); safe(result); safe(replay);
  } finally { refreshGate.release(); await mounted.dispose(); }
});

await check('8. Credential/connection invalidation and disposal cancel reads/dispatches without cache resurrection', async () => {
  const gate = deferred();
  let signal;
  const service = serviceOf(async (_url, init) => {
    signal = init.signal;
    await gate.promise;
    return json(init.method === 'POST' ? { code: 'success', windows_reset: 1 } : { available_count: 1 });
  });
  const pending = service.getResetCredits(account()); await turn();
  service.invalidateCredential('R');
  assert.equal((await pending).error.code, 'canceled'); assert.equal(signal.aborted, true);
  gate.release(); await turn(); assert.equal(service.peekResetCredits(account()), null);
  assert.equal((await service.getResetCredits(account())).ok, true);
  assert.equal(service.peekResetCredits(account({ chatgptAccountId: 'other-workspace' })), null);
  service.dispose(); assert.equal(service.peekResetCredits(account()), null);
  assert.equal((await service.getResetCredits(account())).error.code, 'canceled');

  const dispatchGate = deferred();
  const active = serviceOf(async (url, init) => {
    if (url === RESET_CREDITS_URL) return json({ available_count: 1 });
    signal = init.signal; await dispatchGate.promise; return json({ code: 'success', windows_reset: 1 });
  });
  const dispatched = active.consumeResetCredit(account(), { requestId: ID }); await turn();
  active.invalidateCredential('R');
  const canceled = await dispatched;
  assert.equal(canceled.uncertain, true); assert.equal(signal.aborted, true);
  dispatchGate.release(); await turn(); assert.equal(active.peekResetCredits(account()), null); active.dispose(); safe(canceled);
  const resolving = serviceOf(() => { throw Error('must not fetch'); }, { resolveCredential: () => new Promise(() => {}), timeoutMs: 20 });
  try { const result = await resolving.consumeResetCredit(account(), { requestId: ID }); assert.equal(result.ok, false); assert.equal(result.uncertain, undefined); }
  finally { resolving.dispose(); }
});

await check('9. Only explicit fresh permission clears the latest same-connection 429 cooldown', async () => {
  for (const mode of ['allowed', 'no-flags', 'invalid-flags', 'denied', 'failed', 'stale', 'changed-connection', 'unknown-consume', 'sync-failed']) {
    const refreshGate = deferred();
    const c = clock();
    let posts = 0;
    const permission = mode === 'no-flags' ? {} : mode === 'invalid-flags' ? { allowed: 'true', limit_reached: 'false' }
      : mode === 'denied' ? { allowed: false, limit_reached: true } : { allowed: true, limit_reached: false };
    const { mounted, post } = await hostOf(async (url, init) => {
      if (init.method === 'POST') {
        posts++;
        if (mode === 'unknown-consume') throw Error('raw-error-secret');
        return json({ code: 'success', windows_reset: 1 });
      }
      if (url === RESET_CREDITS_URL) {
        if (posts) await refreshGate.promise;
        return json({ available_count: posts ? 0 : 1 });
      }
      if (posts && mode === 'failed') return json({ rate_limit: permission, private: 'raw-error-secret' }, 503);
      return json({ rate_limit: { ...usage.rate_limit, ...permission } });
    }, { clock: c, accounts: [account({ status: 'disabled', schedulable: false, errorMessage: 'fixture-auth-error',
      rateLimitResetAt: new Date(T0 + 60_000).toISOString(), overloadUntil: new Date(T0 + 120_000).toISOString(),
      tempUnschedulableUntil: new Date(T0 + 180_000).toISOString(), tempUnschedulableReason: 'fixture-other-cooldown',
      consecutiveFailures: 7, lastTestErrorCode: 'auth', label: 'Before concurrent edit' })],
      beforeAccountPut: (_key, value) => {
        if (mode === 'sync-failed' && value.rateLimitResetAt === null) throw Error('raw-error-secret');
      } });
    try {
      const before = mounted.adapter.getAccount('codex');
      if (mode === 'unknown-consume') await mounted.quotaService.get(before, { force: true });
      if (mode === 'stale') {
        const getQuota = mounted.quotaService.get;
        mounted.quotaService.get = async (...args) => ({ ...await getQuota(...args), stale: true });
      }
      const pending = post({ action: 'quota-reset', id: 'codex', confirm: true, requestId: ID });
      await turn();
      let latest = before;
      if (mode !== 'unknown-consume') {
        c.t += 1000;
        const edited = await (await post({ action: 'update', id: 'codex', account: { label: 'Edited while refreshing', notes: 'Concurrent note', priority: 77,
          ...(mode === 'changed-connection' ? { chatgptAccountId: 'different-workspace' } : {}) } })).json();
        latest = edited.account;
      }
      refreshGate.release();
      const response = await pending;
      const result = await response.json();
      const after = mounted.adapter.getAccount('codex');
      assert.deepEqual(after, ['allowed', 'sync-failed'].includes(mode) ? { ...latest, rateLimitResetAt: null } : latest, mode);
      assert.deepEqual(mounted.domain.table('accounts').get('codex'), mode === 'sync-failed' ? latest : after, 'successful recovery must be flushed');
      if (mode === 'sync-failed') {
        assert.equal(response.status, 200); assert.equal(result.ok, true);
        assert.deepEqual(result.reset, { code: 'success', windowsReset: 1 });
        assert.equal(result.quota.ok, true); assert.equal(result.resetCredits.ok, true);
        assert.equal(result.syncError.code, 'quota-reset-sync-failed'); assert.equal(posts, 1);
      }
      if (mode === 'allowed' || mode === 'changed-connection') {
        assert.equal(result.quota.rateLimitAllowed, true); assert.equal(result.quota.rateLimitReached, false);
      } else if (mode === 'no-flags' || mode === 'invalid-flags') {
        assert.equal(result.quota.rateLimitAllowed, undefined); assert.equal(result.quota.rateLimitReached, undefined);
      } else if (mode === 'unknown-consume') assert.equal(result.uncertain, true);
      safe(result);
    } finally { refreshGate.release(); await mounted.dispose(); }
  }
});

for (const { label, error } of failures) console.error(`✗ ${label}\n${error.stack}`);
if (failures.length) process.exitCode = 1;
console.log(`${passed}/${checks} reset-credit scenarios passed`);
