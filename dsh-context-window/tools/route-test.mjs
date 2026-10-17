// Offline tests of the REAL Host entry's route, cache, and disposal lifecycle.
// All HTTP inputs are Fetch Request objects; sessionQuery is a fake service.
// No live Harness, disk writes, network, timers, or third-party dependencies.
// usage: node tools/route-test.mjs
import assert from 'node:assert/strict';
import { apply, createDetailCache, inject, name, ROUTE_PATH } from '../lib/host.v5.js';

let passed = 0;
const failures = [];
async function check(label, fn) {
  try { await fn(); passed += 1; }
  catch (error) { failures.push(`${label}: ${error instanceof Error ? error.stack : String(error)}`); }
}
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const drain = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };
const events = (toolName = 'mcp__github__issue_read') => [{
  type: 'request/header', seq: 1,
  data: { header: { config: {}, tools: [{ name: toolName }, { name: 'read' }] } },
}];
const requestFor = (session, signal) => new Request(`http://localhost${ROUTE_PATH}?session=${encodeURIComponent(session)}`, { signal });
const bodyOf = async (response, status = 200) => {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response.json();
};

function world(options = {}, config = {}) {
  const calls = { observed: [], released: 0, unregistered: 0, warnings: [] };
  let service = 'service' in options ? options.service : {
    observeSession: async (sessionId, init) => {
      calls.observed.push({ sessionId, ...init });
      return options.observe === undefined
        ? { events: events(), dispose: () => { calls.released += 1; } }
        : options.observe(sessionId, init, calls);
    },
  };
  const effects = [];
  const state = { route: undefined };
  const ctx = {
    get: (key) => key === 'sessionQuery' ? service : undefined,
    connection: { fetch: { register: (route) => {
      assert.equal(state.route, undefined, 'only one exact route registers');
      state.route = route;
      return () => { calls.unregistered += 1; state.route = undefined; };
    } } },
    effect: (fn, label) => { const cleanup = fn(); effects.push({ label, cleanup }); return cleanup; },
    logger: { info: () => {}, warn: (...args) => { calls.warnings.push(args); } },
  };
  apply(ctx, config);
  const route = state.route;
  return {
    route, calls, state,
    setService: (next) => { service = next; },
    dispose: () => { for (const effect of effects.splice(0)) effect.cleanup?.(); },
  };
}

await check('apply registers the exact authenticated GET/HEAD route and disposal removes it', async () => {
  assert.equal(name, 'dsh-context-window');
  assert.deepEqual(inject, ['connection', 'sessionQuery', 'webServer']);
  assert.equal(ROUTE_PATH, '/api/context-window.detail');
  const test = world();
  assert.equal(test.route.path, ROUTE_PATH);
  assert.deepEqual(test.route.methods, ['GET', 'HEAD']);
  assert.equal(test.route.requestBody, 'buffered');
  const head = await test.route.fetch(new Request(`http://localhost${ROUTE_PATH}`, { method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(test.calls.observed.length, 0);
  for (const suffix of ['', '?session=']) {
    const body = await bodyOf(await test.route.fetch(new Request(`http://localhost${ROUTE_PATH}${suffix}`)), 400);
    assert.equal(body.error.code, 'bad-request');
  }
  test.dispose();
  assert.equal(test.calls.unregistered, 1);
  assert.equal(test.state.route, undefined);
  test.dispose();
  assert.equal(test.calls.unregistered, 1);
});

await check('route reads an observation with internal signal, disposes it, and returns classification', async () => {
  const test = world();
  const request = requestFor('session-one');
  const body = await bodyOf(await test.route.fetch(request));
  assert.equal(body.sessionId, 'session-one');
  assert.equal(body.tools.mcp.count, 1);
  assert.equal(body.tools.system.count, 1);
  assert.equal(test.calls.released, 1);
  assert.equal(test.calls.observed[0].projectionMode, 'none');
  assert.notEqual(test.calls.observed[0].signal, request.signal);
  test.dispose();
});

await check('readSession fallback works without opening an observation', async () => {
  const readIds = [];
  const test = world({ service: { readSession: async (id) => { readIds.push(id); return { events: events() }; } } });
  const body = await bodyOf(await test.route.fetch(requestFor('fallback')));
  assert.equal(body.sessionId, 'fallback');
  assert.deepEqual(readIds, ['fallback']);
  test.dispose();
});

await check('absent/incompatible session service is a readable 503 and can recover', async () => {
  for (const service of [undefined, {}]) {
    const test = world({ service });
    const failed = await bodyOf(await test.route.fetch(requestFor('recover')), 503);
    assert.equal(failed.error.code, 'unavailable');
    assert.match(failed.error.message, /sessionQuery/);
    test.setService({ readSession: async () => ({ events: events() }) });
    assert.equal((await bodyOf(await test.route.fetch(requestFor('recover')))).tools.mcp.count, 1);
    test.dispose();
  }
});

await check('service errors become JSON 500, are not cached, and retry succeeds', async () => {
  let count = 0;
  const test = world({ observe: async () => {
    count += 1;
    if (count === 1) throw new Error('session replay failed');
    return { events: events() };
  } });
  const failed = await bodyOf(await test.route.fetch(requestFor('retry')), 500);
  assert.equal(failed.error.code, 'internal');
  assert.equal(failed.error.message, 'session replay failed');
  assert.equal(test.calls.warnings.length, 1);
  await bodyOf(await test.route.fetch(requestFor('retry')));
  assert.equal(count, 2);
  test.dispose();
});

await check('apply TTL is measured from completion; expiry refolds instead of returning stale data', async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  const test = world({}, { cacheTtlMs: 10 });
  try {
    const first = await bodyOf(await test.route.fetch(requestFor('ttl')));
    now = 1_009;
    assert.equal((await bodyOf(await test.route.fetch(requestFor('ttl')))).generatedAt, first.generatedAt);
    assert.equal(test.calls.observed.length, 1);
    now = 1_010;
    const fresh = await bodyOf(await test.route.fetch(requestFor('ttl')));
    assert.equal(test.calls.observed.length, 2);
    assert.notEqual(fresh.generatedAt, first.generatedAt);
  } finally { test.dispose(); Date.now = originalNow; }
});

await check('apply capacity is bounded and recent cache hits preserve LRU entries', async () => {
  const test = world({}, { cacheMaxEntries: 2 });
  await bodyOf(await test.route.fetch(requestFor('a')));
  await bodyOf(await test.route.fetch(requestFor('b')));
  await bodyOf(await test.route.fetch(requestFor('a')));
  await bodyOf(await test.route.fetch(requestFor('c')));
  await bodyOf(await test.route.fetch(requestFor('a')));
  assert.equal(test.calls.observed.length, 3);
  await bodyOf(await test.route.fetch(requestFor('b')));
  assert.equal(test.calls.observed.length, 4);
  assert.deepEqual(test.calls.observed.map((item) => item.sessionId), ['a', 'b', 'c', 'b']);
  test.dispose();
});

await check('TTL zero disables settled caching while retaining same-session singleflight', async () => {
  const observation = deferred();
  const test = world({ observe: () => observation.promise }, { cacheTtlMs: 0 });
  const first = test.route.fetch(requestFor('zero'));
  const second = test.route.fetch(requestFor('zero'));
  await drain();
  assert.equal(test.calls.observed.length, 1);
  observation.resolve({ events: events() });
  const [left, right] = await Promise.all([first, second]);
  assert.deepEqual(await bodyOf(left), await bodyOf(right));
  await bodyOf(await test.route.fetch(requestFor('zero')));
  assert.equal(test.calls.observed.length, 2);
  test.dispose();
});

await check('concurrent different sessions read independently rather than sharing payloads', async () => {
  const reads = new Map();
  const test = world({ observe: (id) => {
    const read = deferred(); reads.set(id, read); return read.promise;
  } });
  const first = test.route.fetch(requestFor('left'));
  const second = test.route.fetch(requestFor('right'));
  await drain();
  assert.equal(test.calls.observed.length, 2);
  reads.get('right').resolve({ events: events('mcp__right__read') });
  assert.equal((await bodyOf(await second)).sessionId, 'right');
  reads.get('left').resolve({ events: events('mcp__left__read') });
  assert.equal((await bodyOf(await first)).sessionId, 'left');
  test.dispose();
});

await check('cancelling the first real Request does not abort the other subscriber or its observation', async () => {
  const observation = deferred();
  const test = world({ observe: () => observation.promise });
  const controller = new AbortController();
  const first = test.route.fetch(requestFor('shared', controller.signal));
  const second = test.route.fetch(requestFor('shared'));
  await drain();
  controller.abort();
  const canceled = await bodyOf(await first, 499);
  assert.equal(canceled.error.code, 'aborted');
  assert.equal(test.calls.observed.length, 1);
  assert.equal(test.calls.observed[0].signal.aborted, false);
  observation.resolve({ events: events(), dispose: () => { test.calls.released += 1; } });
  const completed = await bodyOf(await second);
  assert.equal(completed.sessionId, 'shared');
  await bodyOf(await test.route.fetch(requestFor('shared')));
  assert.equal(test.calls.observed.length, 1);
  assert.equal(test.calls.released, 1);
  assert.equal(test.calls.warnings.length, 0);
  test.dispose();
});

await check('pre-aborted request refuses without reading or caching', async () => {
  const controller = new AbortController(); controller.abort();
  const test = world();
  assert.equal((await bodyOf(await test.route.fetch(requestFor('aborted', controller.signal)), 499)).error.code, 'aborted');
  assert.equal(test.calls.observed.length, 0);
  await bodyOf(await test.route.fetch(requestFor('aborted')));
  assert.equal(test.calls.observed.length, 1);
  test.dispose();
});

await check('last subscriber abort abandons its flight and an ignored late result cannot replace a newer read', async () => {
  const reads = [];
  const cache = createDetailCache({ read: (_id, signal) => {
    const pending = deferred(); reads.push({ ...pending, signal }); return pending.promise;
  } });
  const controller = new AbortController();
  const old = cache.get('session', controller.signal);
  const canceled = assert.rejects(old, { code: 'aborted' });
  await drain(); controller.abort(); await canceled;
  assert.equal(reads[0].signal.aborted, true);
  assert.deepEqual(cache.stats(), { cached: 0, inflight: 0, disposed: false });
  const replacement = cache.get('session'); await drain();
  reads[1].resolve('new'); assert.equal(await replacement, 'new');
  reads[0].resolve('old'); await drain();
  assert.equal(await cache.get('session'), 'new');
  assert.equal(reads.length, 2);
  cache.dispose();
});

await check('route disposal immediately rejects subscribers, aborts shared read, and releases late observations', async () => {
  const observation = deferred();
  const test = world({ observe: () => observation.promise });
  const first = test.route.fetch(requestFor('dispose'));
  const second = test.route.fetch(requestFor('dispose'));
  await drain();
  test.dispose();
  assert.equal(test.calls.unregistered, 1);
  assert.equal(test.calls.observed[0].signal.aborted, true);
  for (const response of await Promise.all([first, second])) {
    assert.equal((await bodyOf(response, 503)).error.code, 'disposed');
  }
  observation.resolve({ events: events(), dispose: () => { test.calls.released += 1; } });
  await drain();
  assert.equal(test.calls.released, 1);
  assert.equal((await bodyOf(await test.route.fetch(requestFor('dispose')), 503)).error.code, 'disposed');
  assert.equal(test.calls.observed.length, 1);
});

await check('cache disposal clears settled data and late completions cannot refill it', async () => {
  const late = deferred();
  const cache = createDetailCache({ read: async (id) => id === 'late' ? late.promise : 'ready' });
  await cache.get('cached');
  const pending = cache.get('late');
  const disposed = assert.rejects(pending, { code: 'disposed' });
  await drain();
  assert.deepEqual(cache.stats(), { cached: 1, inflight: 1, disposed: false });
  cache.dispose(); await disposed;
  assert.deepEqual(cache.stats(), { cached: 0, inflight: 0, disposed: true });
  late.resolve('late-payload'); await drain();
  assert.deepEqual(cache.stats(), { cached: 0, inflight: 0, disposed: true });
  await assert.rejects(cache.get('cached'), { code: 'disposed' });
  cache.dispose();
});

await check('helper eagerly prunes expired entries on the next read and caps defaults at 128', async () => {
  let now = 0;
  const cache = createDetailCache({ read: async (id) => id, clock: () => now, ttlMs: 10 });
  for (let index = 0; index < 140; index += 1) await cache.get(`s${index}`);
  assert.equal(cache.stats().cached, 128);
  now = 10;
  await cache.get('fresh');
  assert.equal(cache.stats().cached, 1);
  cache.dispose();
});

await check('helper measures TTL after a slow read finishes, not when it began', async () => {
  let now = 0;
  let reads = 0;
  const pending = deferred();
  const cache = createDetailCache({ read: async () => { reads += 1; return pending.promise; }, ttlMs: 10, clock: () => now });
  const first = cache.get('slow'); await drain();
  now = 100; pending.resolve('result'); await first;
  now = 109; assert.equal(await cache.get('slow'), 'result'); assert.equal(reads, 1);
  now = 110; assert.equal(await cache.get('slow'), 'result'); assert.equal(reads, 2);
  cache.dispose();
});

await check('a shared failed read rejects all subscribers once and leaves a clean retry slot', async () => {
  const broken = deferred();
  let reads = 0;
  const cache = createDetailCache({ read: () => { reads += 1; return reads === 1 ? broken.promise : Promise.resolve('recovered'); } });
  const first = assert.rejects(cache.get('failed'), /broken/);
  const second = assert.rejects(cache.get('failed'), /broken/);
  await drain(); broken.reject(new Error('broken')); await Promise.all([first, second]);
  assert.deepEqual(cache.stats(), { cached: 0, inflight: 0, disposed: false });
  assert.equal(await cache.get('failed'), 'recovered');
  assert.equal(reads, 2);
  cache.dispose();
});

if (failures.length > 0) {
  console.error(`route-test: ${failures.length} failed, ${passed} passed`);
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log(`route-test: ${passed}/${passed} passed`);
}
