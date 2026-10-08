// Offline verification of the Host half: the Fetch-route contract, the report
// the handler serves, caching/single-flight, and failure isolation.
// usage: node host-test.mjs
import { apply, inject, name, ROUTE_PATH } from '../lib/host.js';

let checks = 0;
let failures = 0;
const ok = (condition, label, detail) => {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.log(`FAIL ${label}${detail === undefined ? '' : ` :: ${detail}`}`);
};
const eq = (actual, expected, label) => ok(
  JSON.stringify(actual) === JSON.stringify(expected),
  label,
  `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
);

const ms = (iso) => new Date(iso).getTime();
const usageEvent = (time, input, output, cacheRead = 0) => ({
  type: 'assistant/message',
  seq: 1,
  time,
  data: { turn: 1, step: 1, usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead } },
});

/** One fake session: `{ id, live, events, inheritedEventCount?, fail? }`. */
function fakeSessionQuery(sessions) {
  const calls = { list: 0, read: [] };
  return {
    calls,
    listSessions: async () => {
      calls.list += 1;
      return sessions.map((session) => ({
        header: { id: session.id },
        live: session.live === true,
        persisted: true,
      }));
    },
    readSession: async (id) => {
      calls.read.push(String(id));
      const session = sessions.find((candidate) => candidate.id === id);
      if (session === undefined) throw new Error('unknown session');
      if (session.fail === true) throw new Error('replay validation failed');
      return { events: session.events, inheritedEventCount: session.inheritedEventCount ?? 0 };
    },
  };
}

/** Minimal Cordis context: only what apply() touches. */
function makeCtx(sessionQuery) {
  const state = { route: undefined, effects: [] };
  const ctx = {
    get: (service) => {
      if (service === 'sessionQuery') return sessionQuery;
      if (service === 'webServer') return { port: 19387 };
      return undefined;
    },
    connection: { fetch: { register: (route) => { state.route = route; return () => {}; } } },
    effect: (callback, label) => { state.effects.push(label); const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {}; },
    logger: { info: () => {}, warn: () => {} },
  };
  return { ctx, state };
}

// Anchor fixture events to the current local day so this regression stays valid
// after the original development date. Keep the old out-of-window event old.
const at = (iso) => {
  if (!iso.startsWith('2026-10-05')) return ms(iso);
  const today = new Date();
  const fixture = new Date(iso);
  today.setHours(fixture.getHours(), fixture.getMinutes(), fixture.getSeconds(), 0);
  return today.getTime();
};
const sessions = [
  {
    id: 'session-today',
    live: true,
    events: [
      usageEvent(at('2026-10-05T01:00:00'), 100, 10, 1_000),
      usageEvent(at('2026-10-05T05:00:00'), 1, 2, 0),
      { type: 'user/message', seq: 2, time: at('2026-10-05T05:01:00'), data: {} },
    ],
  },
  {
    id: 'session-forked',
    inheritedEventCount: 1,
    events: [
      usageEvent(at('2026-10-05T02:00:00'), 9_999, 9_999, 0),
      usageEvent(at('2026-10-05T03:00:00'), 5, 6, 0),
    ],
  },
  { id: 'session-broken', fail: true, events: [] },
  { id: 'session-old', events: [usageEvent(at('2026-01-01T00:00:00'), 777, 777, 0)] },
];

console.log('== plugin shape ==');
eq(name, 'dsh-usage-report', 'plugin name');
eq(inject, ['connection'], 'injects the connection service');
eq(ROUTE_PATH, '/api/usage.report', 'route lives under /api');

console.log('== route contract ==');
const query = fakeSessionQuery(sessions);
const { ctx, state } = makeCtx(query);
apply(ctx);
ok(state.route !== undefined, 'apply registered a Fetch route');
eq(state.route.path, '/api/usage.report', 'exact route path');
eq(state.route.methods, ['GET', 'HEAD'], 'methods');
eq(state.route.requestBody, 'buffered', 'request body mode');
eq(typeof state.route.fetch, 'function', 'route has a Fetch handler');

const get = (range) => state.route.fetch(new Request(`http://127.0.0.1:19387/api/usage.report?range=${String(range)}`));

console.log('== report over the route ==');
const response = await get(7);
eq(response.status, 200, 'range=7 serves 200');
ok(String(response.headers.get('content-type')).startsWith('application/json'), 'serves JSON');
eq(response.headers.get('cache-control'), 'no-store', 'not cached by the browser');
const report = await response.json();
eq(report.rangeDays, 7, 'range echoed');
eq(report.days.length, 7, 'one row per day');
// Today: 100 uncached + 1_000 cache read + 1 = 1_101 input, 12 output.
// Fork: the inherited first event is skipped, leaving 5/6.
eq(report.totals.input, 1_106, 'input totals (cache read folded in, fork prefix skipped)');
eq(report.totals.output, 18, 'output totals');
eq(report.totals.requests, 3, 'usage-bearing replies counted');
eq(report.totals.cacheRead, 1_000, 'cache read reported separately');
eq(report.meta.sessionCount, 4, 'every visible session counted');
eq(report.meta.scannedSessions, 3, 'readable sessions scanned');
eq(report.meta.skippedSessions, 1, 'the unreadable session is skipped, not fatal');
eq(report.meta.skippedReasons.length, 1, 'skip reason recorded');
eq(report.meta.liveSessions, 1, 'live sessions counted');
eq(report.meta.inheritedEventsSkipped, 1, 'fork prefix reported');
eq(report.meta.localOnly, true, 'flagged local-only');
eq(report.days.at(-1).day.startsWith('2026-'), true, 'day keys are dates');
eq(report.days.at(-1).input, 1_106, 'today bucket holds input from both sessions');
eq(report.days.at(-1).requests, 3, 'today bucket counts every reply that day');
eq(report.totals.input, 1_106, 'the out-of-window 777-token reply is excluded from totals');

console.log('== query handling ==');
const head = await state.route.fetch(new Request('http://127.0.0.1:19387/api/usage.report?range=7', { method: 'HEAD' }));
eq(head.status, 200, 'HEAD answers 200');
eq(await head.text(), '', 'HEAD carries no body');
eq((await (await get(999)).json()).rangeDays, 30, 'an unsupported range falls back to 30');
eq((await (await get('abc')).json()).rangeDays, 30, 'a non-numeric range falls back to 30');
eq((await (await get(90)).json()).rangeDays, 90, 'range=90 supported');

console.log('== caching / single flight ==');
const before = query.calls.list;
await get(7);
await get(7);
eq(query.calls.list, before, 'a second read inside the TTL is served from cache');

const freshQuery = fakeSessionQuery(sessions);
const freshCtx = makeCtx(freshQuery);
apply(freshCtx.ctx, { cacheTtlMs: 0 });
await freshCtx.state.route.fetch(new Request('http://127.0.0.1:19387/api/usage.report?range=7'));
await freshCtx.state.route.fetch(new Request('http://127.0.0.1:19387/api/usage.report?range=7'));
eq(freshQuery.calls.list, 2, 'TTL=0 refolds every request');

const racing = fakeSessionQuery(sessions);
const racingCtx = makeCtx(racing);
apply(racingCtx.ctx, { cacheTtlMs: 0 });
await Promise.all([
  racingCtx.state.route.fetch(new Request('http://127.0.0.1:19387/api/usage.report?range=30')),
  racingCtx.state.route.fetch(new Request('http://127.0.0.1:19387/api/usage.report?range=30')),
]);
eq(racing.calls.list, 1, 'two concurrent requests share one fold');

console.log('== failure isolation ==');
const missing = makeCtx(undefined);
apply(missing.ctx);
const unavailable = await missing.state.route.fetch(new Request('http://127.0.0.1:19387/api/usage.report?range=30'));
eq(unavailable.status, 503, 'a deployment without sessionQuery answers 503');
const unavailableBody = await unavailable.json();
eq(unavailableBody.error.code, 'unavailable', 'with a machine-readable code');
ok(String(unavailableBody.error.message).includes('sessionQuery'), 'and a readable message');

const empty = makeCtx(fakeSessionQuery([]));
apply(empty.ctx);
const emptyReport = await (await empty.state.route.fetch(new Request('http://127.0.0.1:19387/api/usage.report?range=7'))).json();
eq(emptyReport.totals, { input: 0, output: 0, uncachedInput: 0, cacheRead: 0, cacheWrite: 0, requests: 0 }, 'no sessions yields zeros');
eq(emptyReport.meta.activeDays, 0, 'no active days');

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log('host-test: OK');
