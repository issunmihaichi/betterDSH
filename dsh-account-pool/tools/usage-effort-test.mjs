// Offline request-local reasoning selection/mapping tests. No provider I/O.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const lib = process.env.POOL_TEST_LIB ? pathToFileURL(resolve(process.env.POOL_TEST_LIB) + '/').href : new URL('../lib/', import.meta.url).href;
const { createPoolAdapter } = await import(new URL('adapter.js', lib));
const { accountSchema, usageSchema } = await import(new URL('domain.js', lib));
const at = '2026-01-01T00:00:00.000Z';
const account = accountSchema.parse({ id: 'fixture', platform: 'custom', models: ['m'], createdAt: at, updatedAt: at });
const messages = [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }];
async function drain(stream) { for await (const chunk of stream) {} }
function setup({ accounts = [account], overrides, failure } = {}) {
  const usages = [], calls = [];
  const pool = createPoolAdapter({ initialAccounts: accounts, requestRetries: 0,
    modelOverridesFor: () => overrides,
    onUsage: usage => usages.push(usage),
    upstream: { async *stream(row, options) {
      calls.push(options);
      if (failure) throw failure;
      yield { type: 'text-delta', index: 0, text: 'OK' };
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } },
  });
  return { pool, usages, calls };
}
const effort = value => [value.reasoningEffort, value.mappedReasoningEffort];
const request = reasoningEffort => ({ model: 'm', messages, reasoningEffort });
const legacy = usageSchema.parse({ id: 'old', at, ok: true });
assert.deepEqual(effort(legacy), [null, null], 'historical defaults stay unknown');
assert.deepEqual(effort(usageSchema.parse({ id: 'off', at, ok: true, reasoningEffort: 'off', mappedReasoningEffort: null })), ['off', null]);
for (const [selected, mapped] of [['high', 'xhigh'], ['medium', 'medium'], ['off', null], ['max', 'vendor-ultra']]) {
  const state = setup({ overrides: { m: { reasoningEfforts: { [selected]: mapped } } } });
  await drain(state.pool.stream(request(selected)));
  assert.deepEqual(effort(state.usages[0]), [selected, mapped]);
  assert.equal(state.calls[0].reasoningEffort ?? null, mapped);
}
{
  const state = setup();
  await drain(state.pool.stream(request('high')));
  await drain(state.pool.stream({ model: 'm', messages }));
  assert.deepEqual(state.usages.map(effort), [['high', 'high'], [null, null]]);
}
{
  const state = setup({ overrides: { m: { reasoningEfforts: false } } });
  await drain(state.pool.stream(request('high')));
  assert.deepEqual(effort(state.usages[0]), ['high', null]);
}
{
  const mapping = { high: 'xhigh', off: null };
  const state = setup({ overrides: { m: { reasoningEfforts: mapping } } });
  const prepared = await state.pool.prepareCall('pool', 'm');
  const probe = state.pool.prepareAccountProbe('fixture', { model: 'm', reasoningEffort: 'high' });
  mapping.high = 'low';
  await drain(prepared.stream(request('high')));
  await drain(probe.stream('fixture'));
  assert.deepEqual(state.usages.map(effort), [['high', 'xhigh'], ['high', 'xhigh']], 'prepared call and fixed probe retain original snapshots');
  await drain(state.pool.stream(request('high')));
  assert.deepEqual(effort(state.usages.at(-1)), ['high', 'low']);
}
for (const options of [{ failure: Object.assign(new Error('fixture failure'), { status: 400, code: 'http-400' }) }, { accounts: [] }]) {
  const state = setup({ ...options, overrides: { m: { reasoningEfforts: { high: 'xhigh' } } } });
  await assert.rejects(() => drain(state.pool.stream(request('high'))));
  assert.deepEqual(effort(state.usages[0]), ['high', 'xhigh'], 'failure and pool exhaustion preserve the mapping');
}
{
  const state = setup({ failure: Object.assign(new Error('fixture failure'), { status: 400, code: 'http-400' }), overrides: { m: { reasoningEfforts: { high: 'low' } } } });
  const probe = state.pool.prepareAccountProbe('fixture', { model: 'm', reasoningEffort: 'high' });
  await assert.rejects(() => drain(probe.stream('fixture')));
  assert.deepEqual(effort(state.usages[0]), ['high', 'low']);
}
{
  const state = setup();
  await state.pool.testAccount('fixture', { model: 'm' });
  assert.deepEqual(effort(state.usages[0]), ['off', 'off'], 'management probe records its existing explicit off options');
}
console.log('Usage effort tests passed: historical defaults, identity/custom/omitted mappings, prepared snapshots, probes, failures and exhaustion.');
