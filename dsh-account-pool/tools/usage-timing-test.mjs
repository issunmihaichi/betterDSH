import assert from 'node:assert/strict';
import test from 'node:test';
import { createPoolAdapter } from '../lib/adapter.js';
import { usageSchema } from '../lib/domain.js';
import { createUsageTiming, normalizeUsageTiming } from '../lib/usage-timing.js';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const clockAt = () => ({ t: T0, now() { return this.t; }, advance(ms) { this.t += ms; } });
const row = (id = 'one', extra = {}) => ({ id, platform: 'anthropic', status: 'active', schedulable: true,
  concurrency: 1, priority: 1, models: [], groups: [], consecutiveFailures: 0, ...extra });
const request = { model: 'fixture', sessionId: 'timing-fixture' };
const stop = { type: 'finish', reason: { kind: 'stop' } };
const transient = () => Object.assign(new Error('fixture overload'), { status: 503, code: 'http-503' });
const metrics = value => normalizeUsageTiming(value);
const unknown = { firstTokenMs: null, outputDurationMs: null, outputTps: null };
const drain = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };
function fixture(stream, extra = {}) {
  const clock = clockAt(), records = [];
  const pool = createPoolAdapter({ initialAccounts: [row()], clock, requestRetries: 0,
    upstream: { stream: (account, options) => stream(clock, account, options) }, onUsage: value => records.push(value), ...extra });
  return { pool, clock, records };
}

test('metadata, usage and empty chunks do not start timing; finish excludes consumer and upstream cleanup', async () => {
  const { pool, clock, records } = fixture(async function* (clock) {
    clock.advance(10); yield { type: 'block-start', blockType: 'text', index: 0 };
    clock.advance(10); yield { type: 'text-delta', text: '' };
    clock.advance(10); yield { type: 'reasoning-delta', text: '' };
    clock.advance(10); yield { type: 'tool-call-delta', argumentsDelta: '' };
    clock.advance(10); yield { type: 'tool-call-start', id: 'call', name: 'tool', arguments: '' };
    clock.advance(10); yield { type: 'usage', usage: { inputTokens: 20 } };
    clock.advance(40); yield { type: 'text-delta', text: 'answer' };
    clock.advance(100); yield { type: 'usage', usage: { outputTokens: 10 } };
    clock.advance(100); yield stop;
    clock.advance(20000);
  }, { persist: { putAccount() { clock.advance(30000); } } });
  for await (const chunk of pool.stream(request)) if (chunk.type === 'finish') clock.advance(10000);
  assert.deepEqual(metrics(records[0]), { firstTokenMs: 100, outputDurationMs: 200, outputTps: 50 });
  assert.equal(records.length, 1);
});

test('reasoning and tool-only actual chunk shapes start timing, not names or empty starts', async () => {
  for (const content of [
    { type: 'reasoning-delta', text: 'thought' },
    { type: 'tool-call-delta', index: 0, id: 'call', argumentsDelta: '{}' },
    { type: 'block-end', block: { type: 'tool-call', id: 'call', name: 'tool', arguments: '{}' } },
    { type: 'block-start', blockType: 'tool-call', block: { type: 'tool-call', arguments: '{"query":"fixture"}' } },
    { type: 'tool-call-start', id: 'call', name: 'tool', arguments: '{}' },
    { type: 'tool-call-start', toolCall: { id: 'call', name: 'tool', arguments: {} } },
    { type: 'block-end', block: { type: 'reasoning', text: 'completed thought' } },
  ]) {
    const { pool, records } = fixture(async function* (clock) {
      clock.advance(25); yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      clock.advance(25); yield content;
      clock.advance(200); yield { type: 'usage', usage: { outputTokens: 6 } };
      yield stop;
    });
    await drain(pool.stream(request));
    assert.deepEqual(metrics(records[0]), { firstTokenMs: 50, outputDurationMs: 200, outputTps: 30 }, JSON.stringify(content));
  }
});

test('same-account retry and account failover waits are included only in first delay', async () => {
  const clock = clockAt(), records = [], calls = [], waits = [];
  const pool = createPoolAdapter({ clock, initialAccounts: [row('a'), row('b')], requestRetries: 1,
    retryWait: async ms => { waits.push(ms); clock.advance(ms); }, onUsage: value => records.push(value),
    upstream: { async *stream(account) {
      calls.push(account.id); clock.advance(20);
      if (account.id === 'a') throw transient();
      clock.advance(30); yield { type: 'text-delta', text: 'answer' };
      clock.advance(100); yield { type: 'usage', usage: { outputTokens: 8 } }; yield stop;
    } } });
  await drain(pool.stream(request));
  assert.deepEqual(calls, ['a', 'a', 'b']); assert.deepEqual(waits, [1000]);
  assert.deepEqual(metrics(records[0]), { firstTokenMs: 1090, outputDurationMs: 100, outputTps: 80 });
  assert.equal(records[0].switches, 1); assert.equal(pool.inflightSnapshot().size, 0);
});

test('detection-keyword error finishes do not become first content and retry delay stays included', async () => {
  let calls = 0; const clock = clockAt(), records = [];
  const pool = createPoolAdapter({ clock, initialAccounts: [row('one', { poolDetectionRetry: true })],
    detectionWait: async ms => clock.advance(ms), onUsage: value => records.push(value), upstream: { async *stream() {
      clock.advance(20);
      if (++calls === 1) {
        yield { type: 'finish', reason: { kind: 'error', failure: Object.assign(new Error('号池检测 fixture'), { status: 503 }) } };
        return;
      }
      clock.advance(60); yield { type: 'reasoning-delta', text: 'accepted thought' };
      clock.advance(200); yield { type: 'usage', usage: { outputTokens: 4 } }; yield stop;
    } } });
  await drain(pool.stream(request));
  assert.equal(calls, 2);
  assert.deepEqual(metrics(records[0]), { firstTokenMs: 1100, outputDurationMs: 200, outputTps: 20 });
  assert.equal(pool.getAccount('one').consecutiveFailures, 0);
});

test('partial thrown and terminal stream errors preserve output timing without replay', async () => {
  for (const terminalFinish of [false, true]) {
    let calls = 0;
    const { pool, records } = fixture(async function* (clock) {
      calls++; clock.advance(40); yield { type: 'text-delta', text: 'partial' };
      clock.advance(100); yield { type: 'usage', usage: { outputTokens: 5 } };
      if (terminalFinish) yield { type: 'finish', reason: { kind: 'error', failure: transient() } };
      else throw transient();
    }, { requestRetries: 3, retryWait: async () => assert.fail('partial output must not retry') });
    await assert.rejects(drain(pool.stream(request)), { code: 'POOL_PARTIAL_RESPONSE' });
    assert.equal(calls, 1); assert.equal(records[0].ok, false);
    assert.deepEqual(metrics(records[0]), { firstTokenMs: 40, outputDurationMs: 100, outputTps: 50 });
  }
});

test('abort after partial output retains available usage and observed duration', async () => {
  const controller = new AbortController();
  const { pool, clock, records } = fixture(async function* (clock) {
    clock.advance(80); yield { type: 'text-delta', text: 'partial' };
    yield { type: 'usage', usage: { outputTokens: 3 } };
    clock.advance(100); controller.abort(); yield stop;
  });
  await assert.rejects(drain(pool.stream({ ...request, signal: controller.signal })), { name: 'AbortError' });
  assert.deepEqual(metrics(records[0]), { firstTokenMs: 80, outputDurationMs: 100, outputTps: 30 });
  assert.equal(records[0].ok, false); assert.equal(pool.inflightSnapshot().size, 0);
  assert.equal(clock.t, T0 + 180);
});

test('empty successes and exhausted pre-output failures have null metrics', async () => {
  const { pool, records } = fixture(async function* (clock) {
    clock.advance(100); yield { type: 'usage', usage: { outputTokens: 12 } };
    yield { type: 'block-end', block: { type: 'text', text: '' } }; yield stop;
  });
  await drain(pool.stream(request)); assert.deepEqual(metrics(records[0]), unknown);
  const empty = createPoolAdapter({ initialAccounts: [], upstream: { async *stream() { assert.fail('no account'); } }, onUsage: value => records.push(value) });
  await assert.rejects(drain(empty.stream(request)), { code: 'POOL_EXHAUSTED' });
  assert.deepEqual(metrics(records[1]), unknown);
  const exhausted = fixture(async function* (clock) { clock.advance(100); throw transient(); });
  await assert.rejects(drain(exhausted.pool.stream(request)), { code: 'POOL_EXHAUSTED' });
  assert.deepEqual(metrics(exhausted.records[0]), unknown);
});

test('missing output usage is not zero; explicit zero is valid; zero duration and overflow TPS are null', async () => {
  for (const [usage, duration, expected] of [
    [undefined, 100, null], [{}, 100, null], [{ inputTokens: 3 }, 100, null],
    [{ outputTokens: null }, 100, null], [{ outputTokens: '4' }, 100, null],
    [{ outputTokens: 0 }, 100, 0], [{ outputTokens: 4 }, 100, 40],
    [{ outputTokens: 4 }, 0, null], [{ outputTokens: Number.MAX_VALUE }, 100, null],
  ]) {
    const { pool, records } = fixture(async function* (clock) {
      clock.advance(20); yield { type: 'text-delta', text: 'content' };
      if (usage !== undefined) yield { type: 'usage', usage };
      clock.advance(duration); yield stop;
    });
    await drain(pool.stream(request));
    assert.deepEqual(metrics(records[0]), { firstTokenMs: 20, outputDurationMs: duration, outputTps: expected });
  }
});

test('management testAccount includes retry delay, and fixed prepared probe keeps its no-retry behavior', async () => {
  let calls = 0; const clock = clockAt(), records = [];
  const pool = createPoolAdapter({ clock, initialAccounts: [row()], requestRetries: 1, retryWait: async ms => clock.advance(ms),
    onUsage: value => records.push(value), upstream: { async *stream() {
      clock.advance(25); if (++calls === 1) throw transient();
      clock.advance(25); yield { type: 'reasoning-delta', text: 'thought' };
      clock.advance(100); yield { type: 'usage', usage: { outputTokens: 3 } }; yield stop;
    } } });
  assert.equal((await pool.testAccount('one', { model: 'fixture' })).ok, true);
  assert.deepEqual(metrics(records[0]), { firstTokenMs: 1075, outputDurationMs: 100, outputTps: 30 });
  const before = structuredClone(pool.getAccount('one'));
  await drain(pool.prepareAccountProbe('one', { model: 'fixture' }).stream('fixed prompt'));
  assert.deepEqual(metrics(records[1]), { firstTokenMs: 50, outputDurationMs: 100, outputTps: 30 });
  assert.deepEqual(pool.getAccount('one'), before); assert.equal(calls, 3);
});

test('management and prepared probes record partial failures and pre-output failures', async () => {
  for (const prepared of [false, true]) for (const partial of [false, true]) {
    const { pool, records } = fixture(async function* (clock) {
      clock.advance(40);
      if (partial) {
        yield { type: 'reasoning-delta', text: 'partial thought' };
        yield { type: 'usage', usage: { outputTokens: 5 } }; clock.advance(100);
      }
      throw transient();
    });
    if (prepared) await assert.rejects(drain(pool.prepareAccountProbe('one', { model: 'fixture' }).stream('fixed')));
    else assert.equal((await pool.testAccount('one', { model: 'fixture' })).ok, false);
    assert.equal(records[0].ok, false);
    assert.deepEqual(metrics(records[0]), partial ? { firstTokenMs: 40, outputDurationMs: 100, outputTps: 50 } : unknown);
    assert.equal(pool.inflightSnapshot().size, 0);
  }
});

test('prepared probe abort and management timeout retain partial-output timing', async () => {
  const controller = new AbortController();
  const prepared = fixture(async function* (clock) {
    clock.advance(30); yield { type: 'tool-call-delta', argumentsDelta: '{}' };
    yield { type: 'usage', usage: { outputTokens: 2 } };
    clock.advance(100); controller.abort(); yield stop;
  });
  await assert.rejects(drain(prepared.pool.prepareAccountProbe('one', { model: 'fixture' }).stream('fixed', controller.signal)), { name: 'AbortError' });
  assert.deepEqual(metrics(prepared.records[0]), { firstTokenMs: 30, outputDurationMs: 100, outputTps: 20 });
  const timed = fixture(async function* (clock, account, options) {
    clock.advance(30); yield { type: 'text-delta', text: 'partial' };
    yield { type: 'usage', usage: { outputTokens: 2 } }; clock.advance(100);
    await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('fixture abort'), { name: 'AbortError' })), { once: true }));
  });
  const result = await timed.pool.testAccount('one', { model: 'fixture', timeoutMs: 5 });
  assert.equal(result.errorCode, 'POOL_TEST_TIMEOUT');
  assert.deepEqual(metrics(timed.records[0]), { firstTokenMs: 30, outputDurationMs: 100, outputTps: 20 });
  assert.equal(timed.pool.inflightSnapshot().size, 0);
});

test('upstream EOF has an observed endpoint when no finish chunk exists', async () => {
  const { pool, records } = fixture(async function* (clock) {
    clock.advance(10); yield { type: 'text-delta', text: 'content' };
    yield { type: 'usage', usage: { outputTokens: 2 } }; clock.advance(100);
  });
  await drain(pool.stream(request));
  assert.deepEqual(metrics(records[0]), { firstTokenMs: 10, outputDurationMs: 100, outputTps: 20 });
});

test('invalid, throwing and backwards observer clocks cannot turn success into failure', async () => {
  for (const bad of [NaN, Infinity, 'invalid', Symbol('invalid'), T0 - 1, 'throw']) {
    const clock = clockAt(); let nextReadIsBad = false; const baseNow = clock.now;
    clock.now = function () {
      if (!nextReadIsBad) return baseNow.call(this);
      nextReadIsBad = false;
      if (bad === 'throw') throw new Error('fixture clock');
      return bad;
    };
    const records = [];
    const pool = createPoolAdapter({ clock, initialAccounts: [row()], onUsage: value => records.push(value), upstream: { async *stream() {
      nextReadIsBad = true; yield { type: 'text-delta', text: 'content' };
      clock.advance(100); yield { type: 'usage', usage: { outputTokens: 4 } }; yield stop;
    } } });
    await drain(pool.stream(request));
    assert.equal(records[0].ok, true); assert.deepEqual(metrics(records[0]), unknown);
  }
  const observer = createUsageTiming({ now() { throw Error('unavailable'); } });
  await drain(observer.wrap({ async *stream() { yield { type: 'text-delta', text: 'content' }; yield stop; } }).stream(row(), request));
  assert.deepEqual(observer.metrics({ outputTokens: 3 }), unknown);
});

test('throwing and rejecting onUsage observers do not break any request surface', async () => {
  for (const onUsage of [() => { throw Error('observer'); }, async () => { throw Error('async observer'); }]) {
    const { pool } = fixture(async function* (clock) { clock.advance(1); yield { type: 'text-delta', text: 'ok' }; clock.advance(1); yield stop; }, { onUsage });
    await drain(pool.stream(request)); assert.equal((await pool.testAccount('one', { model: 'fixture' })).ok, true);
    await drain(pool.prepareAccountProbe('one', { model: 'fixture' }).stream('fixed'));
  }
});

test('legacy usage rows default timing to null and schemas accept only nullable finite nonnegative values', () => {
  const legacy = { id: 'old', at: new Date(T0).toISOString(), ok: true };
  assert.deepEqual(metrics(usageSchema.parse(legacy)), unknown);
  for (const field of Object.keys(unknown)) {
    for (const value of [null, 0, 0.25, 1234]) assert.equal(usageSchema.safeParse({ ...legacy, [field]: value }).success, true);
    for (const value of [-1, NaN, Infinity, -Infinity, '3', {}, true]) assert.equal(usageSchema.safeParse({ ...legacy, [field]: value }).success, false);
  }
});
