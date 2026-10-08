import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  createQuotaService, normalizeCodexQuota, normalizeClaudeQuota, normalizeGeminiQuota,
  quotaConnectionKey, quotaResetAt, QUOTA_URLS,
} from '../lib/quota.js';

const T0 = Date.parse('2026-06-01T00:00:00.000Z');
const account = (platform = 'openai', extra = {}) => ({ id: 'a1', platform, authMode: 'oauth', credentialRef: 'R', chatgptAccountId: 'workspace', projectId: null, ...extra });
const clock = () => ({ t: T0, now() { return this.t; } });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const bundle = { access_token: 'fixture-access-secret', refresh_token: 'fixture-refresh-secret', chatgpt_account_id: 'bundle-workspace', project_id: 'bundle-project' };
const codex = { plan_type: 'pro', rate_limit: { primary_window: { used_percent: 25, reset_at: T0 / 1000 + 3600, limit_window_seconds: 18000 } } };
const credentials = (value = bundle) => ({ resolve: async () => ({ value: typeof value === 'string' ? value : JSON.stringify(value) }) });
let checks = 0;
let passed = 0;
const failures = [];
async function check(label, fn) {
  checks++;
  try { await fn(); passed++; } catch (error) { failures.push({ label, error }); }
}
function deferred() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}
function safe(value) {
  const text = JSON.stringify(value);
  for (const secret of ['fixture-access-secret', 'fixture-refresh-secret', 'private-email', 'raw-error-secret', 'id-token-secret']) assert.equal(text.includes(secret), false, text);
}

await check('Codex: numeric fields, missing windows, decimal credits and additional limits are normalized', () => {
  const result = normalizeCodexQuota({ ...codex, email: 'private-email', access_token: bundle.access_token,
    rate_limit: { ...codex.rate_limit, secondary_window: null },
    additional_rate_limits: [{ limit_name: 'Spark', rate_limit: { primary_window: { used_percent: '80', reset_after_seconds: '120', limit_window_seconds: '3600' } } }],
    credits: { balance: '12345678901234567890.123', unlimited: false, token: bundle.refresh_token },
  }, T0);
  assert.equal(result.plan, 'pro');
  assert.equal(result.windows.length, 2);
  assert.equal(result.windows[0].remainingPercent, 75);
  assert.equal(result.windows[0].resetAt, new Date(T0 + 3600000).toISOString());
  assert.equal(result.windows[1].resetAt, new Date(T0 + 120000).toISOString());
  assert.deepEqual(result.credits, { balance: '12345678901234567890.123', unlimited: false });
  safe(result);
});

await check('Partial responses never fabricate zero usage; invalid numeric/reset values become null', () => {
  const result = normalizeCodexQuota({ rate_limit: { primary_window: { used_percent: '', reset_at: 'invalid' }, secondary_window: { used_percent: 'NaN', limit_window_seconds: -1 } } });
  assert.equal(result.windows[0].usedPercent, null);
  assert.equal(result.windows[0].remainingPercent, null);
  assert.equal(result.windows[0].resetAt, null);
  assert.equal(result.windows[1].windowSeconds, null);
  const partial = normalizeClaudeQuota({ five_hour: { resets_at: '2026-06-02T00:00:00Z' } });
  assert.equal(partial.windows[0].usedPercent, null);
  assert.equal(partial.windows[0].resetAt, '2026-06-02T00:00:00.000Z');
  for (const invalid of [null, undefined, '', NaN, {}, 'x']) assert.equal(quotaResetAt(invalid), null);
  assert.equal(quotaResetAt(String(T0 / 1000)), new Date(T0).toISOString());
});

await check('Claude: known utilization windows only, includes fractional and zero values', () => {
  const result = normalizeClaudeQuota({ five_hour: { utilization: 12.5, resets_at: '2026-06-02T00:00:00Z' },
    seven_day: { utilization: 0 }, seven_day_sonnet: null, invented: { utilization: 99 }, access_token: bundle.access_token });
  assert.equal(result.windows.length, 2);
  assert.equal(result.windows[0].remainingPercent, 87.5);
  assert.equal(result.windows[1].usedPercent, 0);
  assert.equal(result.windows[1].resetAt, null);
  assert.equal(result.windows[1].windowSeconds, 604800);
  safe(result);
});

await check('Gemini: exact decimal remaining amount, fraction and missing fields are independent', () => {
  const result = normalizeGeminiQuota({ buckets: [
    { remainingFraction: 0.2, remainingAmount: '12345678901234567890', modelId: 'gemini-2.5-pro', tokenType: 'REQUESTS', resetTime: '2026-06-02T00:00:00Z' },
    { remainingAmount: '7' }, { remainingFraction: null }, { remainingFraction: '0', remainingAmount: 'secret-value' },
  ], private: bundle });
  assert.equal(result.windows[0].remainingPercent, 20);
  assert.equal(result.windows[0].usedPercent, 80);
  assert.equal(result.windows[0].remainingAmount, '12345678901234567890');
  assert.equal(result.windows[1].usedPercent, null);
  assert.equal(result.windows[2].remainingPercent, null);
  assert.equal(result.windows[3].remainingPercent, 0);
  assert.equal(result.windows[3].remainingAmount, null);
  safe(result);
});

await check('No public quota API: api-key/custom/Grok snapshots are unsupported and cached without resolving', async () => {
  let calls = 0;
  const service = createQuotaService({ clock: clock(), fetchImpl: () => { calls++; throw Error('unexpected'); }, resolveCredential: () => { calls++; throw Error('unexpected'); } });
  for (const row of [account('openai', { authMode: 'api-key' }), account('custom'), account('grok'), account('gemini', { authMode: 'api-key' })]) {
    const result = await service.get(row);
    assert.equal(result.supported, false);
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'unsupported');
    assert.deepEqual(result.windows, []);
    assert.deepEqual(service.peek(row), result);
  }
  assert.equal(calls, 0);
  service.dispose();
});

await check('Codex quota uses GET usage headers with explicit workspace override and no inference request', async () => {
  let calls = 0;
  const service = createQuotaService({ credentials: credentials(), clock: clock(), fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, QUOTA_URLS.openai);
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    assert.equal(init.headers.authorization, `Bearer ${bundle.access_token}`);
    assert.equal(init.headers['chatgpt-account-id'], 'manual-workspace');
    assert.equal(init.headers.originator, 'codex_cli_rs');
    assert.equal(init.headers['openai-beta'], 'codex-1');
    assert.equal(init.redirect, 'error');
    return json({ ...codex, email: 'private-email', account_id: 'private-account', secret: bundle });
  } });
  const result = await service.get(account('openai', { chatgptAccountId: 'manual-workspace' }));
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  safe(result);
  service.dispose();
});

await check('Claude quota uses GET oauth usage and required beta', async () => {
  const service = createQuotaService({ credentials: credentials(), clock: clock(), fetchImpl: async (url, init) => {
    assert.equal(url, QUOTA_URLS.anthropic);
    assert.equal(init.method, 'GET');
    assert.equal(init.headers['anthropic-beta'], 'oauth-2025-04-20');
    return json({ five_hour: { utilization: 100 } });
  } });
  assert.equal((await service.get(account('anthropic'))).windows[0].remainingPercent, 0);
  service.dispose();
});

await check('Gemini quota posts retrieveUserQuota with explicit project override', async () => {
  const service = createQuotaService({ credentials: credentials(), clock: clock(), ensureGeminiProject: () => { throw Error('must not discover existing project'); }, fetchImpl: async (url, init) => {
    assert.equal(url, QUOTA_URLS.gemini);
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), { project: 'manual-project' });
    return json({ buckets: [{ remainingAmount: '4' }] });
  } });
  assert.equal((await service.get(account('gemini', { projectId: 'manual-project' }))).ok, true);
  service.dispose();
});

await check('Gemini project discovery uses a fresh bundle and never onboards', async () => {
  let discovered = 0;
  const service = createQuotaService({ credentials: credentials({ access_token: bundle.access_token }), clock: clock(),
    ensureGeminiProject: async (value, options) => {
      discovered++;
      assert.equal(value.access_token, bundle.access_token);
      assert.ok(options.signal instanceof AbortSignal);
      return { projectId: 'discovered-project', tierId: 'free-tier', currentTier: { id: 'free-tier', secret: bundle } };
    }, fetchImpl: async (url, init) => {
      assert.equal(url, QUOTA_URLS.gemini);
      assert.deepEqual(JSON.parse(init.body), { project: 'discovered-project' });
      return json({ buckets: [{ remainingFraction: 0.8 }] });
    },
  });
  const result = await service.get(account('gemini'));
  assert.equal(discovered, 1);
  assert.equal(result.plan, 'free-tier');
  assert.equal(result.windows[0].remainingPercent, 80);
  safe(result);
  service.dispose();
});

await check('Missing project/discovery exception is a fixed safe error with no raw payload', async () => {
  for (const [ensureGeminiProject, code] of [
    [async () => ({ requiresOnboarding: true }), 'missing-project'],
    [async () => { throw Error('raw-error-secret'); }, 'project-discovery-failed'],
  ]) {
    const service = createQuotaService({ credentials: credentials({ access_token: bundle.access_token }), ensureGeminiProject, fetchImpl: () => { throw Error('no quota fetch'); }, clock: clock() });
    const result = await service.get(account('gemini'));
    assert.equal(result.errorCode, code);
    safe(result);
    service.dispose();
  }
});

await check('TTL and force skip; ordinary runtime updatedAt leaves the cache owned by the same connection', async () => {
  const c = clock();
  let calls = 0;
  const service = createQuotaService({ credentials: credentials(), clock: c, fetchImpl: async () => { calls++; return json(codex); } });
  const row = account();
  const first = await service.get(row);
  first.windows[0].usedPercent = 999;
  assert.equal(service.peek(row).windows[0].usedPercent, 25, 'callers cannot mutate cache');
  await service.get({ ...row, updatedAt: 'changed', lastUsedAt: 'changed' });
  assert.equal(calls, 1);
  assert.equal(quotaConnectionKey(row), quotaConnectionKey({ ...row, updatedAt: 'changed' }));
  await service.get(row, { force: true });
  assert.equal(calls, 2);
  c.t += 60001;
  await service.get(row);
  assert.equal(calls, 3);
  service.dispose();
});

await check('Concurrent ordinary/force quota calls share one request', async () => {
  const gate = deferred();
  let calls = 0;
  const service = createQuotaService({ credentials: credentials(), clock: clock(), fetchImpl: async () => { calls++; await gate.promise; return json(codex); } });
  const tasks = Array.from({ length: 8 }, (_, index) => service.get(account(), { force: index % 2 === 0 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  gate.release();
  const values = await Promise.all(tasks);
  assert.equal(values.every((value) => value.ok), true);
  service.dispose();
});

await check('Failure retains previous successful quota with stale flags and safe error timestamp', async () => {
  const c = clock();
  let status = 200;
  const service = createQuotaService({ credentials: credentials(), clock: c, fetchImpl: async () => json(status === 200 ? codex : { error: 'raw-error-secret', credential: bundle }, status) });
  const first = await service.get(account());
  status = 401; c.t += 1000;
  const next = await service.get(account(), { force: true });
  assert.equal(next.supported, true);
  assert.equal(next.ok, false);
  assert.equal(next.stale, true);
  assert.equal(next.status, 401);
  assert.equal(next.errorAt, new Date(c.t).toISOString());
  assert.equal(next.lastSuccessAt, first.at);
  assert.deepEqual(next.windows, first.windows);
  safe(next);
  const third = await service.get(account(), { force: true });
  assert.equal(third.lastSuccessAt, first.at);
  service.dispose();
});

await check('Unknown, invalid JSON, empty quota and network error never mean zero or available quota', async () => {
  for (const [fetchImpl, code] of [
    [async () => json({ arbitrary: bundle }), 'quota-unknown'],
    [async () => json({ rate_limit: { primary_window: {} } }), 'quota-unknown'],
    [async () => new Response('raw-error-secret'), 'invalid-response'],
    [async () => json(null), 'invalid-response'],
    [async () => { throw Object.assign(Error('raw-error-secret'), { code: 'fixture-access-secret', status: 401 }); }, 'quota-fetch-failed'],
  ]) {
    const service = createQuotaService({ credentials: credentials(), clock: clock(), fetchImpl });
    const result = await service.get(account());
    assert.equal(result.ok, false);
    assert.equal(result.supported, true);
    assert.equal(result.errorCode, code);
    assert.deepEqual(result.windows, []);
    assert.equal(result.status, undefined, 'untrusted thrown status is not exposed');
    safe(result);
    service.dispose();
  }
});

await check('Timeout aborts fetch even when injected fetch never settles', async () => {
  let signal;
  const service = createQuotaService({ credentials: credentials(), clock: clock(), timeoutMs: 20, fetchImpl: async (_url, init) => { signal = init.signal; return new Promise(() => {}); } });
  const result = await service.get(account());
  assert.equal(result.errorCode, 'timeout');
  assert.equal(signal.aborted, true);
  assert.deepEqual(service.peek(account()), result);
  service.dispose();
});

await check('Credential resolution and refresh share the same 20s timeout envelope', async () => {
  const service = createQuotaService({ resolveCredential: () => new Promise(() => {}), timeoutMs: 20, clock: clock() });
  assert.equal((await service.get(account())).errorCode, 'timeout');
  service.dispose();
});

await check('Invalidating credentials during flight prevents old query from caching on the new connection', async () => {
  const gate = deferred();
  let calls = 0;
  const service = createQuotaService({ credentials: credentials(), clock: clock(), fetchImpl: async () => { calls++; if (calls === 1) await gate.promise; return json(codex); } });
  const row = account();
  const pending = service.get(row);
  await new Promise((resolve) => setImmediate(resolve));
  service.invalidateCredential('R');
  assert.equal((await pending).errorCode, 'canceled');
  gate.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.peek(row), null);
  assert.equal((await service.get(row)).ok, true);
  assert.equal(calls, 2);
  const changed = { ...row, chatgptAccountId: 'new-workspace' };
  assert.equal(service.peek(changed), null);
  await service.get(changed);
  assert.equal(calls, 3);
  service.dispose();
});

await check('Dispose aborts and clears cached/active queries without resurrection', async () => {
  const gate = deferred();
  const service = createQuotaService({ credentials: credentials(), clock: clock(), fetchImpl: async () => { await gate.promise; return json(codex); } });
  const pending = service.get(account());
  await new Promise((resolve) => setImmediate(resolve));
  service.dispose();
  assert.equal((await pending).errorCode, 'canceled');
  gate.release();
  assert.equal(service.peek(account()), null);
  assert.equal((await service.get(account())).errorCode, 'canceled');
});

await check('Quota getter refreshes OAuth and retains metadata even when credential persistence rejects', async () => {
  const expired = { ...bundle, expires_at: new Date(T0).toISOString(), id_token: 'id-token-secret' };
  let tokenCalls = 0;
  let quotaCalls = 0;
  const service = createQuotaService({ clock: clock(), credentials: { ...credentials(expired), set: async () => { throw Error('raw-error-secret'); } }, fetchImpl: async (url, init) => {
    if (url === 'https://auth.openai.com/oauth/token') { tokenCalls++; return json({ access_token: 'fresh-access-secret', expires_in: 3600 }); }
    quotaCalls++;
    assert.equal(url, QUOTA_URLS.openai);
    assert.equal(init.headers.authorization, 'Bearer fresh-access-secret');
    assert.equal(init.headers['chatgpt-account-id'], 'bundle-workspace');
    return json(codex);
  } });
  const result = await service.get(account('openai', { chatgptAccountId: null }));
  assert.equal(result.ok, true);
  assert.equal(tokenCalls, 1);
  assert.equal(quotaCalls, 1);
  safe(result);
  assert.equal(JSON.stringify(result).includes('fresh-access-secret'), false);
  service.dispose();
});

await check('Real local HTTP verifies Fetch transport and response normalization', async () => {
  const server = createServer((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/quota');
    assert.equal(req.headers.authorization, `Bearer ${bundle.access_token}`);
    assert.equal(req.headers['chatgpt-account-id'], 'workspace');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ...codex, private: bundle }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${server.address().port}/quota`;
  const service = createQuotaService({ credentials: credentials(), clock: clock(), fetchImpl: (url, init) => {
    assert.equal(url, QUOTA_URLS.openai);
    return fetch(local, init);
  } });
  try {
    const result = await service.get(account());
    assert.equal(result.ok, true);
    assert.equal(result.windows[0].usedPercent, 25);
    safe(result);
  } finally { service.dispose(); await new Promise((resolve) => server.close(resolve)); }
});

await check('Bare Codex JWT quota resolves workspace claims while missing ids fail locally', async () => {
  const token = `h.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'jwt-workspace' } })).toString('base64url')}.s`;
  let calls = 0;
  const service = createQuotaService({ credentials: credentials(token), clock: clock(), fetchImpl: async (_url, init) => {
    calls++;
    assert.equal(init.headers['chatgpt-account-id'], 'jwt-workspace');
    return json(codex);
  } });
  assert.equal((await service.get(account('openai', { chatgptAccountId: null }))).ok, true);
  assert.equal(calls, 1);
  service.dispose();
  const missing = createQuotaService({ credentials: credentials('plain-token'), clock: clock(), fetchImpl: () => { throw Error('must fail locally'); } });
  assert.equal((await missing.get(account('openai', { chatgptAccountId: null }))).errorCode, 'missing-account-id');
  missing.dispose();
});

await check('Default Gemini project discovery dynamically loads native module and calls only loadCodeAssist then quota', async () => {
  const calls = [];
  const service = createQuotaService({ credentials: credentials({ access_token: bundle.access_token }), clock: clock(), fetchImpl: async (url, init) => {
    calls.push(url);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.authorization, `Bearer ${bundle.access_token}`);
    if (url === 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist') return json({ cloudaicompanionProject: 'native-project', currentTier: { id: 'standard-tier' }, private: bundle });
    assert.equal(url, QUOTA_URLS.gemini);
    assert.deepEqual(JSON.parse(init.body), { project: 'native-project' });
    return json({ buckets: [{ remainingFraction: 0.4 }] });
  } });
  const result = await service.get(account('gemini'));
  assert.equal(result.ok, true);
  assert.equal(result.plan, 'standard-tier');
  assert.equal(calls.length, 2);
  assert.equal(calls.some((url) => url.includes('onboard') || url.includes('GenerateContent')), false);
  safe(result);
  service.dispose();
});

if (failures.length) {
  for (const { label, error } of failures) console.error(`✗ ${label}\n${error.stack}`);
  process.exitCode = 1;
}
console.log(`${passed}/${checks} quota checks passed`);
