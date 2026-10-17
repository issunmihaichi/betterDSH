// Pure local analytics regression. No runtime, providers, network, or user logs.
// usage: node tools/analytics-test.mjs
import assert from 'node:assert/strict';
import {
  aggregateSnapshots, createAggregationState, accumulateAnalyticsSnapshot,
  buildAnalyticsReport, dayKeys, localDayKey,
} from '../lib/report.js';

let checks = 0;
const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks += 1; };
const ok = (condition, label) => { assert.ok(condition, label); checks += 1; };
const now = new Date('2026-03-10T12:00:00').getTime();
const at = (day, hour = 12) => new Date(2026, 2, day, hour).getTime();
const event = (type, time, data = {}) => ({ type, time, seq: 1, data });
const source = (model, provider = 'provider') => ({ kind: 'model', provider, model });
const assistant = (time, usage, modelSource) => event('assistant/message', time, {
  turn: 1, step: 1, usage,
  message: { role: 'assistant', source: modelSource, content: [{ type: 'text', text: 'PRIVATE ASSISTANT CONTENT' }] },
});
const user = (time) => event('user/message', time, {
  role: 'user', content: [{ type: 'text', text: 'PRIVATE USER CONTENT MUST NOT BE A TITLE' }],
});
const header = (time, model, provider = 'provider') => event('request/header', time, {
  reason: 'change', header: { config: { provider, model } },
});
const title = (time, text) => event('session/title', time, { title: text });
const call = (time, callId, name = 'skill', args = '{"name":"read-report"}') => event('tool/call', time, {
  turn: 1, step: 1, callId, name, arguments: args,
});
const result = (time, toolCallId, isError, error) => event('tool/result', time, {
  message: { role: 'tool', toolCallId, isError, content: [{ type: 'text', text: 'PRIVATE TOOL RESULT' }] }, error,
});
const snapshot = (id, events, inheritedEventCount = 0) => ({ session: { id }, events, inheritedEventCount });
const rows = (series) => new Map(series.map(row => [row.id, row]));
const modelId = (model, provider = 'provider') => JSON.stringify([provider, model]);

console.log('== additive protocol, messages, chats, privacy ==');
const fixtures = [
  snapshot('primary', [
    header(at(1), 'model-a'),
    user(at(4)),
    assistant(at(4), { inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 5 }, source('model-a')),
    assistant(at(6), undefined, undefined), // header fallback, even without usage
    header(at(7), 'model-b'),
    assistant(at(7), { inputTokens: 50, outputTokens: 10 }, { kind: 'model', provider: 'other' }),
    assistant(at(8), [], undefined), // malformed usage still counts a message
    call(at(9), 'proto', '__proto__', '{"secret":"PRIVATE TOOL ARGUMENTS"}'),
    call(at(10), 'missing-tool', undefined, '{}'),
    // Explicitly remove the helper's default, simulating a malformed tool name.
    event('tool/call', NaN, { name: 'invalid-time' }),
    title(at(11), '最新会话标题'), // latest title is metadata, not window-limited
  ]),
  snapshot('secondary', [assistant(at(5), { inputTokens: 10, outputTokens: 10 }, source('model-a'))]),
  snapshot('unknown', [assistant(at(6), { inputTokens: 1, outputTokens: 1 }, undefined)]),
  snapshot('only-user', [user(at(4))]),
  snapshot('only-tools', [call(at(9), 'grep', 'grep', '{}')]),
  snapshot('old-only', [assistant(at(3), { inputTokens: 500, outputTokens: 500 }), assistant(at(11), { inputTokens: 500, outputTokens: 500 }), title(at(5), 'old title')]),
  snapshot('metadata-only', [header(at(5), 'model-x'), title(at(5), 'only metadata')]),
];
fixtures[0].events.find(item => item.data?.callId === 'missing-tool').data.name = undefined;
const report = aggregateSnapshots(fixtures, 7, now, { sessionCount: fixtures.length });
eq(report.totals, { input: 96, output: 26, uncachedInput: 71, cacheRead: 20, cacheWrite: 5, requests: 4 }, 'legacy token totals retain their exact fields');
eq(report.days.length, 7, 'token axis remains padded');
eq(report.analytics.days, report.days.map(({ day, label }) => ({ day, label })), 'analytics and tokens share one local calendar axis');
eq(report.analytics.messages.total, 6, 'all settled messages count, including missing/malformed usage');
eq(report.analytics.messages.unit, 'assistant-message', 'explicit message unit');
eq(report.analytics.messages.clientSourceAvailable, false, 'no fabricated client telemetry');
eq(report.analytics.messages.byClient, [{ id: 'unknown', label: '未记录', total: 6, values: [1, 1, 2, 1, 1, 0, 0] }], 'all clients are explicitly unknown, zero padded');
const models = rows(report.analytics.messages.byModel);
eq(models.get(modelId('model-a')).total, 3, 'source and header fallback share the same model');
eq(models.get(modelId('model-a')).values, [1, 1, 1, 0, 0, 0, 0], 'model messages bucketed by event day');
eq(models.get(modelId('model-b')).total, 2, 'missing source model uses header as a whole identity');
eq(models.get('unknown'), { id: 'unknown', label: '未记录', total: 1, values: [0, 0, 1, 0, 0, 0, 0] }, 'model is unknown without any source or header');
const tools = rows(report.analytics.tools.series);
eq(report.analytics.tools.total, 3, 'one count per tool/call event');
eq(report.analytics.tools.unit, 'tool-call', 'explicit tool unit');
eq(tools.get('__proto__'), { id: '__proto__', label: '__proto__', total: 1, values: [0, 0, 0, 0, 0, 1, 0] }, 'prototype-shaped names are safe Map keys');
eq(tools.get('unknown').label, '未记录', 'missing tool name has an explicit unknown label');
eq(report.analytics.skills, { total: 0, series: [], unit: 'successful-skill-load' }, 'skill-like tool call alone is not a successful load');
eq(report.analytics.quota, { available: false, fiveHourLimit: null, weeklyLimit: null }, 'no API means no invented quota');
eq(report.analytics.chats.map(chat => chat.id), ['primary', 'secondary', 'unknown', 'only-tools', 'only-user'], 'only active chats, token ranking then stable id tie break');
const primary = report.analytics.chats[0];
eq(primary.title, '最新会话标题', 'title is the latest title event, even beyond the token window');
eq(primary.input, 85, 'chat input includes all cache tokens');
eq(primary.output, 15, 'chat output');
eq(primary.totalTokens, 100, 'chat total is input plus output');
eq(primary.requests, 2, 'chat requests still require usage');
eq(primary.messages, 4, 'chat messages include usage-free replies');
eq(primary.toolCalls, 2, 'chat tool calls');
eq(primary.models, [
  { id: modelId('model-b'), label: 'provider/model-b', input: 50, output: 10, totalTokens: 60, requests: 1 },
  { id: modelId('model-a'), label: 'provider/model-a', input: 35, output: 5, totalTokens: 40, requests: 1 },
], 'chat model breakdown ranked by token sum');
ok(Math.abs(primary.tokenSharePercent - 100 / 122 * 100) < 1e-10, 'share denominator is only selected-window tokens');
ok(Math.abs(report.analytics.chats.reduce((sum, chat) => sum + chat.tokenSharePercent, 0) - 100) < 1e-10, 'nonzero chat shares total 100 percent');
eq(report.analytics.chats.find(chat => chat.id === 'only-user').title, 'only-user', 'untitled chat uses id, never user content');
ok(report.analytics.chats.filter(chat => chat.totalTokens === 0).every(chat => chat.tokenSharePercent === 0), 'zero-token active chats have zero share');
const serialized = JSON.stringify(report);
ok(!serialized.includes('PRIVATE'), 'report never emits user/assistant/tool content or arguments');
ok(!serialized.includes('Desktop') && !serialized.includes('Web'), 'client attribution is not guessed');
for (const group of [report.analytics.messages.byModel, report.analytics.messages.byClient, report.analytics.tools.series, report.analytics.skills.series]) {
  ok(group.every(row => row.values.length === 7 && row.values.every(value => Number.isFinite(value) && value >= 0)), 'every daily series is finite and zero padded');
  eq(group.reduce((sum, row) => sum + row.total, 0), group.reduce((sum, row) => sum + row.values.reduce((a, b) => a + b, 0), 0), 'series totals equal their daily vectors');
}

console.log('== inherited prefix and model context ==');
const fork = aggregateSnapshots([snapshot('fork', [
  header(at(1), 'inherited-model'), title(at(1), '继承标题'),
  assistant(at(4), { inputTokens: 999, outputTokens: 999 }, source('parent-model')),
  call(at(4), 'parent-call'), result(at(4), 'parent-call'), user(at(4)),
  assistant(at(5), { inputTokens: 2, outputTokens: 3 }, undefined),
  result(at(6), 'parent-call'), // must not associate inherited invocation
  call(at(9), 'child-call'), result(at(10), 'child-call'), result(at(10), 'child-call'),
  header(at(10), undefined), // new unknown header must not retain old fallback
  assistant(at(10), undefined),
], 6)], 7, now);
eq(fork.totals.input, 2, 'fork never double-counts inherited tokens');
eq(fork.totals.output, 3, 'fork output excludes prefix');
eq(fork.meta.inheritedEventsSkipped, 6, 'actual prefix length disclosed');
eq(fork.analytics.messages.total, 2, 'fork message count excludes prefix');
eq(fork.analytics.messages.byModel.find(row => row.id === modelId('inherited-model')).total, 1, 'inherited header remains fallback context');
eq(fork.analytics.messages.byModel.find(row => row.id === 'unknown').total, 1, 'a header without model resets fallback to unknown');
eq(fork.analytics.tools.total, 1, 'fork tools exclude prefix');
eq(fork.analytics.skills.total, 1, 'fork cannot count inherited skill loads or duplicate results');
eq(fork.analytics.skills.series[0].values, [0, 0, 0, 0, 0, 0, 1], 'successful skill uses result day, not call day');
eq(fork.analytics.chats[0].title, '继承标题', 'title context includes inherited prefix');
const sourceModels = aggregateSnapshots([snapshot('model-sources', [
  header(at(4), 'header-model', 'header-provider'),
  assistant(at(4), undefined, source('source-model', 'source-provider')),
  assistant(at(4), undefined, { kind: 'model', model: 'provider-less' }),
  assistant(at(4), undefined, { kind: 'user', model: 'not-an-assistant-source' }),
])], 7, now).analytics.messages.byModel;
ok(sourceModels.some(row => row.id === modelId('source-model', 'source-provider')), 'settled model source overrides the header');
ok(sourceModels.some(row => row.id === modelId('provider-less', null)), 'source model without provider does not invent a provider');
ok(sourceModels.some(row => row.id === modelId('header-model', 'header-provider')), 'invalid source kind falls back to header');

console.log('== successful skill correlation and strict JSON ==');
const skillEvents = [
  call(at(3), 'before-window'), result(at(4), 'before-window'), result(at(5), 'before-window'),
  call(at(9), 'cross-day'), result(at(10), 'cross-day'), result(at(10), 'cross-day'),
  call(at(4), 'is-error'), result(at(4), 'is-error', true),
  call(at(4), 'data-error'), result(at(4), 'data-error', false, { name: 'Error' }),
  call(at(4), 'broken-json', 'skill', '{name:"read-report"}'), result(at(4), 'broken-json'),
  call(at(4), 'json-array', 'skill', '[{"name":"read-report"}]'), result(at(4), 'json-array'),
  call(at(4), 'json-number', 'skill', '{"name":123}'), result(at(4), 'json-number'),
  call(at(4), 'json-empty', 'skill', '{"name":" "}'), result(at(4), 'json-empty'),
  call(at(4), 'json-null', 'skill', 'null'), result(at(4), 'json-null'),
  call(at(4), 'json-proto-only', 'skill', '{"__proto__":{"name":"read-report"}}'), result(at(4), 'json-proto-only'),
  call(at(4), 'not-skill', 'other-tool'), result(at(4), 'not-skill'),
  call(at(4), 'recovered', 'skill', '{"name":"__proto__"}'), result(at(4), 'recovered', true), result(at(5), 'recovered'), result(at(6), 'recovered'),
  call(at(2), 'already-loaded'), result(at(3), 'already-loaded'), result(at(4), 'already-loaded'),
  call(at(4), 'duplicate-id', 'skill', '{bad'), call(at(5), 'duplicate-id'), result(at(6), 'duplicate-id'),
  result(at(4), 'orphan'),
];
const skillReport = aggregateSnapshots([snapshot('skills', skillEvents)], 7, now);
eq(skillReport.analytics.skills.total, 3, 'only successful correlated calls with valid object JSON count once');
eq(rows(skillReport.analytics.skills.series).get('read-report'), { id: 'read-report', label: 'read-report', total: 2, values: [1, 0, 0, 0, 0, 0, 1] }, 'cross-window call and cross-day success attributed to result day');
eq(rows(skillReport.analytics.skills.series).get('__proto__'), { id: '__proto__', label: '__proto__', total: 1, values: [0, 1, 0, 0, 0, 0, 0] }, 'failed load is not counted, later success once, safe skill name');
eq(skillReport.analytics.tools.total, skillEvents.filter(item => item.type === 'tool/call' && item.time >= at(4, 0)).length, 'tool counts include failed, malformed, and duplicate-id call events');
eq(skillReport.totals.requests, 0, 'tool results are not token requests');
const twoSessions = aggregateSnapshots([
  snapshot('one', [call(at(4), 'same-id'), result(at(4), 'same-id')]),
  snapshot('two', [call(at(4), 'same-id'), result(at(4), 'same-id')]),
], 7, now);
eq(twoSessions.analytics.skills.total, 2, 'callId deduplication is session-local, not global');

console.log('== malformed time, usage, snapshot, empty values ==');
const invalidTimes = [NaN, Infinity, -Infinity, 1e20, '2026-03-04', undefined, null];
const invalidEvents = invalidTimes.flatMap(time => [assistant(time, { inputTokens: 123 }), call(time, 'invalid'), user(time)]);
const invalidReport = aggregateSnapshots([snapshot('invalid', invalidEvents)], 7, now);
eq(invalidReport.analytics.messages.total, 0, 'invalid/non-numeric/unrepresentable timestamps are ignored');
eq(invalidReport.analytics.tools.total, 0, 'invalid tool timestamp cannot form a day');
eq(invalidReport.analytics.chats, [], 'invalid-time events cannot make an active chat');
eq(invalidReport.meta.eventsCounted, 0, 'invalid times are excluded from legacy event count too');
const usageReport = aggregateSnapshots([snapshot('usage', [
  assistant(at(4), { inputTokens: 4, outputTokens: 2, cacheReadTokens: -5, cacheWriteTokens: Infinity }),
  assistant(at(4), { inputTokens: NaN, outputTokens: '9', cacheReadTokens: undefined, cacheWriteTokens: -1 }),
  ...[undefined, null, [], 'usage', 9].map(usage => assistant(at(4), usage)),
])], 7, now);
eq(usageReport.analytics.messages.total, 7, 'all valid-time assistant/message events count independently of usage');
eq(usageReport.totals.input, 4, 'non-finite and negative usage fields normalize to zero');
eq(usageReport.totals.output, 2, 'numeric strings are not coerced into usage');
eq(usageReport.totals.requests, 2, 'only usage objects count requests, arrays and primitives do not');
eq(usageReport.analytics.chats[0].models[0].requests, 2, 'chat model requests match token request rules');
const empty = aggregateSnapshots([null, {}, snapshot('empty', []), { session: { id: 'invalid-events' }, events: {} }], 7, now);
eq(empty.analytics.days.length, 7, 'empty analytics still carries the whole axis');
eq(empty.analytics.messages, { total: 0, byModel: [], byClient: [], unit: 'assistant-message', clientSourceAvailable: false }, 'empty message protocol is explicit');
eq(empty.analytics.tools, { total: 0, series: [], unit: 'tool-call' }, 'empty tools');
eq(empty.analytics.chats, [], 'empty logs have no active chats');
eq(empty.analytics.quota.fiveHourLimit, null, 'empty report does not infer a quota');
const zeroShares = aggregateSnapshots([snapshot('zero', [user(at(4)), assistant(at(4), {})])], 7, now);
eq(zeroShares.analytics.chats[0].tokenSharePercent, 0, 'zero denominator is finite zero, never NaN');
for (const inherited of [NaN, -1, '1', 1.5]) {
  eq(aggregateSnapshots([snapshot('bad-prefix', [assistant(at(4), {})], inherited)], 7, now).analytics.messages.total, 1, 'invalid inherited offset does not hide events');
}
const oversized = aggregateSnapshots([snapshot('large-prefix', [assistant(at(4), {})], 99)], 7, now);
eq(oversized.analytics.messages.total, 0, 'oversized inherited offset skips the available prefix');
eq(oversized.meta.inheritedEventsSkipped, 1, 'inherited count is bounded by actual log length');

console.log('== calendar window, padding, stable serialization, bounded state ==');
for (const range of [7, 30, 90]) {
  const keys = dayKeys(range, now);
  const first = new Date(now); first.setHours(0, 0, 0, 0); first.setDate(first.getDate() - range + 1);
  const afterLast = new Date(now); afterLast.setHours(0, 0, 0, 0); afterLast.setDate(afterLast.getDate() + 1);
  const bounded = aggregateSnapshots([snapshot('window', [
    assistant(first.getTime() - 1, { inputTokens: 99 }),
    assistant(first.getTime(), { inputTokens: 1 }),
    assistant(afterLast.getTime() - 1, { inputTokens: 2 }),
    assistant(afterLast.getTime(), { inputTokens: 99 }),
  ])], range, now);
  eq(bounded.totals.input, 3, `${range}-day window includes exact calendar endpoints only`);
  eq(bounded.analytics.messages.total, 2, `${range}-day message window agrees with tokens`);
  eq(bounded.analytics.days.map(day => day.day), keys, `${range}-day axis oldest first`);
  eq(bounded.analytics.messages.byModel[0].values.length, range, `${range}-day series zero padding`);
  eq(bounded.analytics.messages.byModel[0].values.reduce((sum, value) => sum + value, 0), 2, `${range}-day vectors contain no off-window events`);
}
const dstKeys = dayKeys(7, new Date('2026-03-10T12:00:00').getTime());
eq(new Set(dstKeys).size, 7, 'calendar walk never duplicates days across DST');
eq(dstKeys.at(-1), localDayKey(now), 'axis ends on host-local today');
const state = createAggregationState(7, now);
for (const fixture of fixtures) accumulateAnalyticsSnapshot(state, fixture);
ok(state.byDay.size <= 7, 'incremental state retains at most the selected token-day buckets');
eq(state.chats.size, 5, 'state retains only selected-window chat aggregates');
ok(!Object.hasOwn(state, 'snapshots') && !Object.hasOwn(state, 'events'), 'state does not retain snapshot/event arrays');
const incremental = buildAnalyticsReport(state, { sessionCount: fixtures.length });
eq(incremental, report, 'streamed fold is identical to the convenience aggregation');
eq(aggregateSnapshots([...fixtures].reverse(), 7, now, { sessionCount: fixtures.length }), report, 'worker completion order cannot change sorted wire output');
incremental.analytics.messages.byModel[0].values.fill(999);
incremental.analytics.chats[0].models[0].input = 999;
eq(buildAnalyticsReport(state, { sessionCount: fixtures.length }), report, 'wire reports cannot mutate internal counters');
const referenceSet = new Set(fixtures.flatMap(item => [item, item.events, ...item.events]));
function containsSnapshot(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return false;
  if (referenceSet.has(value)) return true;
  seen.add(value);
  const children = value instanceof Map ? [...value.keys(), ...value.values()]
    : value instanceof Set ? [...value.values()] : Object.values(value);
  return children.some(child => containsSnapshot(child, seen));
}
ok(!containsSnapshot(state), 'no snapshot/event references survive the fold');
console.log(`analytics-test: OK (${checks} checks)`);
