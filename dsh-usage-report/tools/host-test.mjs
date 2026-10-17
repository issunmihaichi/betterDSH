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
      return { session: { id: session.id }, events: session.events, inheritedEventCount: session.inheritedEventCount ?? 0 };
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
eq(report.analytics.messages.total, 3, 'Host integrates assistant-message aggregation');
eq(report.analytics.messages.byClient[0].id, 'unknown', 'Host never guesses client provenance');
eq(report.analytics.messages.byClient[0].label, '未记录', 'unknown clients have the agreed label');
eq(report.analytics.messages.byModel[0].id, 'unknown', 'messages without source/header have unknown model');
eq(report.analytics.days, report.days.map(({ day, label }) => ({ day, label })), 'Host analytics axis agrees with legacy tokens');
eq(report.analytics.chats.map(chat => chat.id), ['session-today', 'session-forked'], 'Host ranks only selected-window active chats');
eq(report.analytics.chats[0].title, 'session-today', 'Host falls back to id, not message content');
eq(report.analytics.quota, { available: false, fiveHourLimit: null, weeklyLimit: null }, 'Host does not call or invent a quota API');

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

console.log('== explicit refresh and shared cancellation ==');
const refreshedQuery = fakeSessionQuery(sessions);
const refreshedCtx = makeCtx(refreshedQuery);
apply(refreshedCtx.ctx);
const refreshedGet = (suffix = '') => refreshedCtx.state.route.fetch(new Request('http://127.0.0.1/api/usage.report?range=7' + suffix));
await refreshedGet();
await refreshedGet();
eq(refreshedQuery.calls.list, 1, 'ordinary reads use TTL cache');
await refreshedGet('&refresh=1');
eq(refreshedQuery.calls.list, 2, 'explicit refresh bypasses TTL cache');
let releaseRead;
const readBarrier = new Promise(resolve => { releaseRead = resolve; });
let sharedLists = 0;
const sharedCtx = makeCtx({ listSessions: async signal => { sharedLists++; await readBarrier; if (signal?.aborted) throw Error('aborted caller'); return []; }, readSession: async () => ({ events: [] }) });
apply(sharedCtx.ctx, { cacheTtlMs: 0 });
const firstAbort = new AbortController();
const firstCall = sharedCtx.state.route.fetch(new Request('http://127.0.0.1/api/usage.report?range=7&refresh=1', { signal: firstAbort.signal }));
const secondCall = sharedCtx.state.route.fetch(new Request('http://127.0.0.1/api/usage.report?range=7&refresh=1'));
firstAbort.abort();
releaseRead();
await firstCall;
eq((await secondCall).status, 200, 'one caller abort does not cancel another subscriber');
eq(sharedLists, 1, 'simultaneous explicit refreshes are single flight');
const boundedCtx = makeCtx(fakeSessionQuery(sessions));
apply(boundedCtx.ctx, { maxSessions: 1 });
const bounded = await (await boundedCtx.state.route.fetch(new Request('http://127.0.0.1/api/usage.report?range=7'))).json();
eq(bounded.meta.truncatedSessions, 3, 'bounded scans disclose unscanned sessions');

console.log('== analytics integration / local log privacy ==');
const todayMs = Date.now();
const localEvent = (type, data, time = todayMs) => ({ type, seq: 1, time, data });
const analyticsSessions = [
  { id: 'analytics-live', live: true, inheritedEventCount: 4, events: [
    localEvent('request/header', { header: { config: { provider: 'local-provider', model: 'inherited-model' } } }),
    localEvent('session/title', { title: '继承标题' }),
    usageEvent(todayMs, 999, 999),
    localEvent('tool/call', { callId: 'parent-skill', name: 'skill', arguments: '{"name":"parent-skill"}' }),
    localEvent('assistant/message', { message: { role: 'assistant', content: 'PRIVATE ASSISTANT' } }),
    localEvent('assistant/message', { usage: { inputTokens: 1, outputTokens: 2 }, message: { role: 'assistant', source: { kind: 'model', provider: 'local-provider', model: 'settled-model' } } }),
    localEvent('tool/call', { callId: 'safe-name', name: '__proto__', arguments: 'PRIVATE TOOL ARGUMENTS' }),
    localEvent('tool/call', { callId: 'child-skill', name: 'skill', arguments: '{"name":"analytics-test"}' }),
    localEvent('tool/result', { message: { toolCallId: 'child-skill', isError: true } }),
    localEvent('tool/result', { message: { toolCallId: 'child-skill' } }),
    localEvent('tool/result', { message: { toolCallId: 'child-skill' } }),
    localEvent('tool/result', { message: { toolCallId: 'parent-skill' } }),
    localEvent('user/message', { role: 'user', content: 'PRIVATE USER MUST NOT BE TITLE' }),
    localEvent('session/title', { title: '最新标题' }),
  ] },
  { id: 'analytics-old', events: [usageEvent(new Date(todayMs).setDate(new Date(todayMs).getDate() - 91), 100, 100)] },
  { id: 'analytics-failed', fail: true, events: [] },
];
const analyticsCtx = makeCtx(fakeSessionQuery(analyticsSessions));
apply(analyticsCtx.ctx);
const analyticsReport = await (await analyticsCtx.state.route.fetch(new Request('http://127.0.0.1/api/usage.report?range=7'))).json();
eq(analyticsReport.totals.input, 1, 'Host tokens exclude inherited prefix and old sessions');
eq(analyticsReport.analytics.messages.total, 2, 'Host counts usage-free settled messages');
eq(analyticsReport.analytics.tools.total, 2, 'Host counts safe tool names from call events');
eq(analyticsReport.analytics.skills.total, 1, 'Host counts only a successful non-inherited skill once');
eq(analyticsReport.analytics.skills.series[0].id, 'analytics-test', 'Host reads skill name only from valid call JSON');
eq(analyticsReport.analytics.messages.byModel.map(row => row.id), ['["local-provider","inherited-model"]', '["local-provider","settled-model"]'], 'Host carries inherited model fallback, preferring settled source');
eq(analyticsReport.analytics.chats.length, 1, 'Host emits only active selected-window chats');
eq(analyticsReport.analytics.chats[0].title, '最新标题', 'Host folds latest log-backed title');
eq(analyticsReport.analytics.chats[0].messages, 2, 'Host chat message count includes usage-free replies');
eq(analyticsReport.analytics.chats[0].toolCalls, 2, 'Host chat tools exclude prefix');
eq(analyticsReport.analytics.chats[0].tokenSharePercent, 100, 'single active token-bearing chat owns 100 percent');
eq(analyticsReport.meta.skippedSessions, 1, 'analytics preserve unreadable-session isolation');
ok(!JSON.stringify(analyticsReport).includes('PRIVATE'), 'Host response never contains user content or arguments');

console.log('== bounded read concurrency / eager snapshot folding ==');
async function concurrencyProbe(configuredConcurrency, expectedConcurrency) {
  const count = expectedConcurrency + 3;
  const records = Array.from({ length: count }, (_, index) => ({ header: { id: `bounded-${index}` }, live: index === count - 1, persisted: true }));
  const started = [];
  const folded = new Set();
  const releases = [];
  let active = 0;
  let peak = 0;
  let gateOpened = false;
  let foldedBeforeNextRead = true;
  let ready;
  const initialReads = new Promise(resolve => { ready = resolve; });
  const service = {
    listSessions: async () => records,
    readSession: (id) => {
      started.push(id);
      if (started.length > expectedConcurrency && folded.size < started.length - expectedConcurrency) foldedBeforeNextRead = false;
      active += 1;
      peak = Math.max(peak, active);
      const snapshot = {
        session: { id }, inheritedEventCount: 0,
        get events() { folded.add(id); return [usageEvent(Date.now(), 1, 1)]; },
      };
      if (started.length === expectedConcurrency) ready();
      const read = gateOpened ? Promise.resolve(snapshot) : new Promise(resolve => releases.push(() => resolve(snapshot)));
      return read.finally(() => { active -= 1; });
    },
  };
  const tested = makeCtx(service);
  apply(tested.ctx, { readConcurrency: configuredConcurrency, cacheTtlMs: 0 });
  const pending = tested.state.route.fetch(new Request('http://127.0.0.1/api/usage.report?range=7'));
  await initialReads;
  eq(started.length, expectedConcurrency, `readConcurrency=${configuredConcurrency} initially starts only its bounded workers`);
  eq(active, expectedConcurrency, 'only bounded reads are simultaneously retained');
  eq(started[0], `bounded-${count - 1}`, 'live sessions are prioritized even if listed last');
  gateOpened = true;
  releases.forEach(release => release());
  const built = await (await pending).json();
  eq(peak, expectedConcurrency, 'peak read concurrency never exceeds configured clamp');
  eq(folded.size, count, 'every snapshot has been folded');
  ok(foldedBeforeNextRead, 'each worker folds its completed snapshot before reading the next, not after collecting all logs');
  eq(built.meta.scannedSessions, count, 'bounded workers complete the census');
  eq(built.analytics.messages.total, count, 'bounded workers preserve all message counters');
  eq(built.totals.input, count, 'bounded workers preserve all token counters');
}
await concurrencyProbe(2, 2);
await concurrencyProbe(0, 1);
await concurrencyProbe(100, 16);

console.log('== one captured calendar window across async reads ==');
const originalNow = Date.now;
const capturedNow = new Date('2026-03-10T23:59:59').getTime();
try {
  Date.now = () => capturedNow;
  const midnightCtx = makeCtx({
    listSessions: async () => { Date.now = () => capturedNow + 120_000; return [{ header: { id: 'midnight' }, live: false, persisted: true }]; },
    readSession: async () => ({ session: { id: 'midnight' }, inheritedEventCount: 0, events: [usageEvent(capturedNow, 2, 3)] }),
  });
  apply(midnightCtx.ctx, { cacheTtlMs: 0 });
  const midnight = await (await midnightCtx.state.route.fetch(new Request('http://127.0.0.1/api/usage.report?range=7'))).json();
  eq(midnight.generatedAt, capturedNow, 'generation timestamp is captured before session reads');
  eq(midnight.days.at(-1).day, '2026-03-10', 'calendar window does not drift when reads cross midnight');
  eq(midnight.analytics.days, midnight.days.map(({ day, label }) => ({ day, label })), 'all analytics and tokens retain that captured window');
} finally {
  Date.now = originalNow;
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log('host-test: OK');
