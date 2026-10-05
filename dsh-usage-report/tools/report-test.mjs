// Offline verification of the Host-side aggregation: synthetic edge cases plus
// a real-data cross-check against DSH's own per-session `tokenUsage` projection.
// usage: node report-test.mjs
import fs from 'node:fs';

import {
  DEFAULT_RANGE,
  RANGE_CHOICES,
  accumulateEvents,
  accumulateSnapshot,
  aggregateSnapshots,
  buildReport,
  dayKeys,
  dayLabel,
  emptyBuckets,
  localDayKey,
  totalOf,
} from '../lib/report.js';
import { decompressSessionLog, parseSessionLog } from './zstd-jsonl.mjs';

let failures = 0;
let checks = 0;
const ok = (condition, label, detail) => {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.log(`FAIL ${label}${detail === undefined ? '' : ` :: ${detail}`}`);
};
const eq = (actual, expected, label) => ok(actual === expected, label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const ms = (iso) => new Date(iso).getTime();
const assistantMessage = (time, usage, extra = {}) => ({
  type: 'assistant/message',
  seq: 1,
  time,
  data: { turn: 1, step: 1, usage, ...extra },
});

console.log('== synthetic cases ==');

// Day keys: length, order, ends today, calendar-safe.
const now = ms('2026-03-05T12:00:00');
const keys = dayKeys(7, now);
eq(keys.length, 7, '7 range yields 7 day keys');
eq(keys[6], localDayKey(now), 'last key is today');
eq(keys[0], '2026-02-27', 'first key is 6 days back');
eq(dayLabel('2026-03-05'), '3/5', 'day label is M/D');

// Range choices stay in sync with the panel.
eq(RANGE_CHOICES.join(','), '7,30,90', 'range choices');
eq(DEFAULT_RANGE, 30, 'default range');

// Bucket fold: input side sums three buckets, output one, requests counted.
const byDay = new Map();
const counted = accumulateEvents(byDay, [
  assistantMessage(ms('2026-03-05T09:00:00'), {
    inputTokens: 100, outputTokens: 10, cacheReadTokens: 1_000, cacheWriteTokens: 5,
  }),
  assistantMessage(ms('2026-03-05T10:00:00'), { inputTokens: 1, outputTokens: 2 }),
  { type: 'user/message', seq: 2, time: ms('2026-03-05T10:30:00'), data: {} },
  assistantMessage(ms('2026-03-04T23:59:59'), { inputTokens: 7, outputTokens: 3 }),
  assistantMessage(ms('2026-03-03T00:00:01'), undefined),
], 0);
eq(counted, 3, 'three usage-bearing assistant messages counted');
const day5 = byDay.get('2026-03-05');
eq(day5.uncachedInput, 101, 'uncached input summed');
eq(day5.cacheRead, 1_000, 'cache read summed');
eq(day5.cacheWrite, 5, 'cache write summed');
eq(day5.output, 12, 'output summed');
eq(day5.requests, 2, 'requests counted');
eq(byDay.get('2026-03-04').output, 3, 'previous local day bucketed separately');

// Inherited prefix (fork) is skipped.
const forkTotals = totalOf((() => {
  const map = new Map();
  accumulateEvents(map, [
    assistantMessage(ms('2026-03-05T08:00:00'), { inputTokens: 999, outputTokens: 999 }),
    assistantMessage(ms('2026-03-05T09:00:00'), { inputTokens: 3, outputTokens: 4 }),
  ], 1);
  return map;
})());
eq(forkTotals.input, 3, 'inherited prefix excluded from input');
eq(forkTotals.output, 4, 'inherited prefix excluded from output');

// Snapshot form + report window trimming + meta.
const report = aggregateSnapshots([
  { events: [assistantMessage(ms('2026-03-05T01:00:00'), { inputTokens: 10, outputTokens: 1 })], inheritedEventCount: 0 },
  { events: [assistantMessage(ms('2026-01-01T01:00:00'), { inputTokens: 500, outputTokens: 500 })], inheritedEventCount: 0 },
], 7, now, { sessionCount: 9, scannedSessions: 2, liveSessions: 1 });
eq(report.days.length, 7, 'report has one row per day');
eq(report.totals.input, 10, 'out-of-range day excluded from totals');
eq(report.totals.output, 1, 'out-of-range output excluded');
eq(report.meta.sessionCount, 9, 'meta carries the session census');
eq(report.meta.scannedSessions, 2, 'meta carries the scanned count');
eq(report.meta.eventsCounted, 2, 'meta counts events');
eq(report.meta.activeDays, 1, 'only one active day inside the window');
eq(report.meta.firstActiveDay, report.days[6].day, 'active day resolves to today');
eq(report.meta.localOnly, true, 'report is flagged local-only');
ok(report.days.every((day) => typeof day.label === 'string' && day.input >= 0), 'every day row is renderable');

// Empty input still produces a renderable zero report.
const empty = buildReport(new Map(), 7, now, {});
eq(empty.totals.input, 0, 'empty report totals zero');
eq(empty.totals.requests, 0, 'empty report counts no requests');
eq(empty.days.length, 7, 'empty report still has its axis');
eq(emptyBuckets().requests, 0, 'empty bucket factory');

console.log('== real session logs ==');

const HOME = process.env.DSH_HOME || 'C:/Users/Administrator/.dsh';
const sessionsRoot = `${HOME}/sessions`;
const cacheRoot = `${HOME}/storages/session_projcache/sessions`;

if (!fs.existsSync(sessionsRoot)) {
  console.log(`SKIP no local sessions at ${sessionsRoot}`);
} else {
  const slug = fs.readdirSync(sessionsRoot).find((name) => fs.statSync(`${sessionsRoot}/${name}`).isDirectory());
  const ids = fs.readdirSync(`${sessionsRoot}/${slug}`)
    .filter((name) => fs.existsSync(`${sessionsRoot}/${slug}/${name}/session.v4.jsonl.zstd`));
  // The session running this very test keeps appending after its projection
  // snapshot was written, so its log is legitimately ahead of the cache.
  const liveSessionId = process.env.DSH_SESSION_ID;
  const snapshots = [];
  let matched = 0;
  let compared = 0;
  let liveCompared = 0;
  const allDays = new Map();

  for (const id of ids) {
    const records = parseSessionLog(decompressSessionLog(fs.readFileSync(`${sessionsRoot}/${slug}/${id}/session.v4.jsonl.zstd`)));
    const header = records.find((record) => record.type === 'session');
    const events = records.filter((record) => record.type !== 'session');
    const cachePath = `${cacheRoot}/${id}.json`;
    const inherited = fs.existsSync(cachePath)
      ? (JSON.parse(fs.readFileSync(cachePath, 'utf8')).record?.identity?.inheritedEventCount ?? 0)
      : 0;
    snapshots.push({ events, inheritedEventCount: inherited });
    accumulateEvents(allDays, events, inherited);

    const expected = fs.existsSync(cachePath)
      ? JSON.parse(fs.readFileSync(cachePath, 'utf8')).record?.rows?.tokenUsage?.val?.totals
      : undefined;
    if (expected === undefined) continue;
    const solo = totalOf((() => {
      const map = new Map();
      accumulateEvents(map, events, inherited);
      return map;
    })());
    const same = solo.uncachedInput === expected.uncachedInputTokens
      && solo.output === expected.outputTokens
      && solo.cacheRead === (expected.cacheReadTokens ?? 0)
      && solo.cacheWrite === (expected.cacheWriteTokens ?? 0);
    if (id === liveSessionId) {
      const notBehind = solo.uncachedInput >= expected.uncachedInputTokens
        && solo.output >= expected.outputTokens
        && solo.cacheRead >= (expected.cacheReadTokens ?? 0);
      ok(notBehind, `live session log is never behind its projection (${id})`,
        `log=${JSON.stringify(solo)} projection=${JSON.stringify(expected)}`);
      liveCompared += 1;
    } else {
      compared += 1;
      ok(same, `raw-log fold equals the tokenUsage projection for ${id}`,
        `log=${JSON.stringify(solo)} projection=${JSON.stringify(expected)}`);
      if (same) matched += 1;
    }
    ok(header !== undefined, `session header present for ${id}`);
  }

  const widest = aggregateSnapshots(snapshots, 3650, Date.now(), { sessionCount: snapshots.length });
  console.log(`sessions: ${ids.length}, compared with projection: ${compared} (exact matches: ${matched}), live session checked separately: ${liveCompared}`);
  console.log(`all-time fold: input=${widest.totals.input} output=${widest.totals.output} cacheRead=${widest.totals.cacheRead} requests=${widest.totals.requests}`);
  console.log(`active days: ${widest.meta.activeDays} (${widest.meta.firstActiveDay} .. ${widest.meta.lastActiveDay})`);
  ok(compared > 0, 'at least one session cross-checked against the projection');
  ok(widest.totals.input > 0 && widest.totals.output > 0, 'real logs produce non-zero tokens');
  ok(widest.meta.activeDays > 0, 'real logs produce active days');

  const last30 = aggregateSnapshots(snapshots, 30, Date.now(), {});
  ok(last30.totals.input <= widest.totals.input, '30-day window never exceeds all-time');
  console.log(`last 30 days: input=${last30.totals.input} output=${last30.totals.output} activeDays=${last30.meta.activeDays}`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log('report-test: OK');
