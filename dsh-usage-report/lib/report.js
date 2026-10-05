/**
 * Daily token aggregation for the local usage report.
 *
 * Pure functions only: the Host half feeds them Session events, the offline
 * tests feed them decoded session logs, and neither needs a Cordis context.
 *
 * Accounting rules (deliberately identical to DSH's own lifetime fold, so the
 * numbers match the per-session `tokenUsage` projection):
 *   - only settled `assistant/message` events count, and only when they carry
 *     `data.usage`; aborted attempts without a settled message contribute
 *     nothing to double-count;
 *   - a forked session's inherited prefix is skipped, because those events are
 *     the parent's spend, not the child's;
 *   - a day bucket is a LOCAL calendar day of the machine running the Host.
 *
 * Series shape: `input` is every input-side token (uncached + cache read +
 * cache write) and `output` is every output-side token, which is what the
 * panel's two series and two stat cards report.
 */

/** Selectable ranges, in days. */
export const RANGE_CHOICES = [7, 30, 90];
/** Range selected when the panel first opens. */
export const DEFAULT_RANGE = 30;
/** Milliseconds in one nominal day (calendar walking uses Date arithmetic). */
const DAY_MS = 86_400_000;

const pad2 = (value) => String(value).padStart(2, '0');

/** Local calendar day key (`YYYY-MM-DD`) for one epoch-millisecond timestamp. */
export function localDayKey(timeMs) {
  const date = new Date(timeMs);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * The `rangeDays` local day keys ending today, oldest first.
 * Calendar arithmetic (`setDate`) keeps DST transitions from duplicating or
 * skipping a bucket.
 */
export function dayKeys(rangeDays, nowMs) {
  const keys = [];
  const cursor = new Date(nowMs);
  cursor.setHours(0, 0, 0, 0);
  for (let back = rangeDays - 1; back >= 0; back -= 1) {
    const day = new Date(cursor.getTime());
    day.setDate(day.getDate() - back);
    keys.push(localDayKey(day.getTime()));
  }
  return keys;
}

/** Axis label for a day key: `M/D`, matching the compact x-axis of the mock. */
export function dayLabel(dayKey) {
  const [, month, day] = dayKey.split('-');
  return `${String(Number(month))}/${String(Number(day))}`;
}

/** One empty day bucket. */
export function emptyBuckets() {
  return { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0 };
}

const count = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/** Input-side total: every token the model read, cached or not. */
export function inputOf(bucket) {
  return bucket.uncachedInput + bucket.cacheRead + bucket.cacheWrite;
}

/**
 * Fold one session's events into `byDay`.
 *
 * @param byDay - day key to bucket map, mutated in place.
 * @param events - Session events in ascending seq order.
 * @param skipEvents - leading inherited events to ignore (fork prefix).
 * @returns how many events contributed.
 */
export function accumulateEvents(byDay, events, skipEvents = 0) {
  const list = Array.isArray(events) ? events : [];
  const start = Number.isInteger(skipEvents) && skipEvents > 0 ? skipEvents : 0;
  let counted = 0;
  for (let index = start; index < list.length; index += 1) {
    const event = list[index];
    if (event?.type !== 'assistant/message') continue;
    const usage = event.data?.usage;
    if (!usage || typeof usage !== 'object') continue;
    const time = typeof event.time === 'number' ? event.time : undefined;
    if (time === undefined) continue;
    const key = localDayKey(time);
    const bucket = byDay.get(key) ?? emptyBuckets();
    byDay.set(key, bucket);
    bucket.uncachedInput += count(usage.inputTokens);
    bucket.cacheRead += count(usage.cacheReadTokens);
    bucket.cacheWrite += count(usage.cacheWriteTokens);
    bucket.output += count(usage.outputTokens);
    bucket.requests += 1;
    counted += 1;
  }
  return counted;
}

/** Fold a whole `{ events, inheritedEventCount }` snapshot. */
export function accumulateSnapshot(byDay, snapshot) {
  return accumulateEvents(byDay, snapshot?.events, snapshot?.inheritedEventCount ?? 0);
}

const sum = (bucket, keys) => keys.reduce((total, key) => total + bucket[key], 0);

/**
 * Build the wire report the panel renders.
 *
 * @param byDay - accumulated day buckets.
 * @param rangeDays - window length in days.
 * @param nowMs - generation timestamp.
 * @param meta - session coverage facts (counts, skips, truncation).
 * @returns a plain JSON value.
 */
export function buildReport(byDay, rangeDays, nowMs, meta = {}) {
  const keys = dayKeys(rangeDays, nowMs);
  const days = keys.map((day) => {
    const bucket = byDay.get(day) ?? emptyBuckets();
    return {
      day,
      label: dayLabel(day),
      input: inputOf(bucket),
      output: bucket.output,
      uncachedInput: bucket.uncachedInput,
      cacheRead: bucket.cacheRead,
      cacheWrite: bucket.cacheWrite,
      requests: bucket.requests,
    };
  });
  const totals = days.reduce((acc, day) => ({
    input: acc.input + day.input,
    output: acc.output + day.output,
    uncachedInput: acc.uncachedInput + day.uncachedInput,
    cacheRead: acc.cacheRead + day.cacheRead,
    cacheWrite: acc.cacheWrite + day.cacheWrite,
    requests: acc.requests + day.requests,
  }), { input: 0, output: 0, uncachedInput: 0, cacheRead: 0, cacheWrite: 0, requests: 0 });
  const activeDays = days.filter((day) => day.requests > 0);
  return {
    generatedAt: nowMs,
    rangeDays,
    days,
    totals,
    meta: {
      localOnly: true,
      timezoneOffsetMinutes: -new Date(nowMs).getTimezoneOffset(),
      sessionCount: meta.sessionCount ?? 0,
      scannedSessions: meta.scannedSessions ?? 0,
      skippedSessions: meta.skippedSessions ?? 0,
      skippedReasons: Array.isArray(meta.skippedReasons) ? meta.skippedReasons.slice(0, 5) : [],
      truncatedSessions: meta.truncatedSessions ?? 0,
      liveSessions: meta.liveSessions ?? 0,
      inheritedEventsSkipped: meta.inheritedEventsSkipped ?? 0,
      activeDays: activeDays.length,
      firstActiveDay: activeDays[0]?.day ?? null,
      lastActiveDay: activeDays[activeDays.length - 1]?.day ?? null,
    },
  };
}

/** Whole-report fold used by both halves and by the tests. */
export function aggregateSnapshots(snapshots, rangeDays, nowMs, meta = {}) {
  const byDay = new Map();
  let counted = 0;
  let inherited = 0;
  for (const snapshot of snapshots ?? []) {
    counted += accumulateSnapshot(byDay, snapshot);
    inherited += snapshot?.inheritedEventCount ?? 0;
  }
  const report = buildReport(byDay, rangeDays, nowMs, { ...meta, inheritedEventsSkipped: inherited });
  report.meta.eventsCounted = counted;
  return report;
}

/** All-time fold over every bucket, for callers that want a grand total. */
export function totalOf(byDay) {
  const totals = emptyBuckets();
  for (const bucket of byDay.values()) {
    totals.uncachedInput += bucket.uncachedInput;
    totals.cacheRead += bucket.cacheRead;
    totals.cacheWrite += bucket.cacheWrite;
    totals.output += bucket.output;
    totals.requests += bucket.requests;
  }
  return { ...totals, input: sum(totals, ['uncachedInput', 'cacheRead', 'cacheWrite']) };
}

export { DAY_MS };
