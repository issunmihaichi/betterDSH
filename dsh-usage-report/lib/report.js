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
const validTime = (value) => typeof value === 'number'
  && Number.isFinite(value) && Number.isFinite(new Date(value).getTime());
const usageOf = (event) => {
  const usage = event?.data?.usage;
  return usage !== null && typeof usage === 'object' && !Array.isArray(usage) ? usage : undefined;
};
const inheritedCount = (value, length) => Number.isSafeInteger(value) && value > 0
  ? Math.min(value, length)
  : 0;
const nonemptyString = (value) => typeof value === 'string' && value.trim() !== '';

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
  const start = inheritedCount(skipEvents, list.length);
  let counted = 0;
  for (let index = start; index < list.length; index += 1) {
    const event = list[index];
    if (event?.type !== 'assistant/message') continue;
    const usage = usageOf(event);
    if (usage === undefined || !validTime(event.time)) continue;
    const time = event.time;
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

/**
 * A window-bounded accumulator, retaining counters only, never snapshots,
 * message content, tool arguments, or user content. A Host can fold and release
 * each readSession result before its worker starts the next read.
 */
export function createAggregationState(rangeDays, nowMs) {
  const keys = dayKeys(rangeDays, nowMs);
  return {
    rangeDays,
    nowMs,
    keys,
    dayIndex: new Map(keys.map((key, index) => [key, index])),
    byDay: new Map(),
    messagesByModel: new Map(),
    tools: new Map(),
    skills: new Map(),
    chats: new Map(),
    messages: 0,
    toolCalls: 0,
    skillLoads: 0,
    eventsCounted: 0,
    inheritedEventsSkipped: 0,
    snapshotsFolded: 0,
  };
}

const UNKNOWN = { id: 'unknown', label: '未记录' };

/** Prefer the settled source; a missing model falls back to the last header. */
function modelIdentity(source, fallback) {
  const identity = source?.kind === 'model' && nonemptyString(source.model) ? source : fallback;
  if (!nonemptyString(identity?.model)) return UNKNOWN;
  const provider = nonemptyString(identity.provider) ? identity.provider : null;
  return {
    id: JSON.stringify([provider, identity.model]),
    label: provider === null ? identity.model : `${provider}/${identity.model}`,
  };
}

function addSeries(series, identity, index, length) {
  let row = series.get(identity.id);
  if (row === undefined) {
    row = { ...identity, total: 0, values: Array(length).fill(0) };
    series.set(identity.id, row);
  }
  row.total += 1;
  row.values[index] += 1;
}

function addUsage(bucket, usage) {
  bucket.uncachedInput += count(usage.inputTokens);
  bucket.cacheRead += count(usage.cacheReadTokens);
  bucket.cacheWrite += count(usage.cacheWriteTokens);
  bucket.output += count(usage.outputTokens);
  bucket.requests += 1;
}

/** Only an actual skill Tool and valid object JSON can identify a skill load. */
function skillNameOf(data) {
  if (data?.name !== 'skill' || typeof data.arguments !== 'string') return undefined;
  try {
    const args = JSON.parse(data.arguments);
    return args !== null && typeof args === 'object' && !Array.isArray(args)
      && Object.hasOwn(args, 'name') && nonemptyString(args.name) ? args.name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fold one { session, inheritedEventCount, events } snapshot in seq order.
 * Headers/titles are context even in a fork prefix. Every other inherited
 * event is excluded, including inherited skill calls/results. Calls outside
 * the window may identify a new successful result inside it; the result's day
 * is the successful-load day. Deduplication is per session and callId.
 */
export function accumulateAnalyticsSnapshot(state, snapshot, fallbackId) {
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  const start = inheritedCount(snapshot?.inheritedEventCount, events.length);
  state.inheritedEventsSkipped += start;
  state.snapshotsFolded += 1;
  const id = nonemptyString(snapshot?.session?.id) ? snapshot.session.id
    : nonemptyString(fallbackId) ? fallbackId : `unknown-session-${state.snapshotsFolded}`;
  let title = id;
  let headerModel;
  let chat;
  // These correlation structures live only until this snapshot has been folded.
  const skillCalls = new Map();
  const successfulSkills = new Set();
  let counted = 0;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.type === 'request/header') {
      headerModel = event.data?.header?.config;
      continue;
    }
    if (event?.type === 'session/title') {
      title = nonemptyString(event.data?.title) ? event.data.title : id;
      continue;
    }
    if (index < start || !validTime(event?.time)) continue;
    const day = localDayKey(event.time);
    const dayIndex = state.dayIndex.get(day);
    const inWindow = dayIndex !== undefined;
    const usage = event.type === 'assistant/message' ? usageOf(event) : undefined;
    if (usage !== undefined) {
      // Preserve the old all-log eventsCounted meaning, but retain only the
      // selected window's token buckets and analytics counters in the state.
      counted += 1;
      state.eventsCounted += 1;
    }

    if (inWindow && ['user/message', 'assistant/message', 'tool/call', 'tool/result'].includes(event.type)) {
      chat ??= state.chats.get(id);
      if (chat === undefined) {
        chat = { id, title, input: 0, output: 0, requests: 0, messages: 0, toolCalls: 0, models: new Map() };
        state.chats.set(id, chat);
      }
    }

    if (event.type === 'assistant/message' && inWindow) {
      const model = modelIdentity(event.data?.message?.source, headerModel);
      state.messages += 1;
      chat.messages += 1;
      addSeries(state.messagesByModel, model, dayIndex, state.keys.length);
      let chatModel = chat.models.get(model.id);
      if (chatModel === undefined) {
        chatModel = { ...model, input: 0, output: 0, totalTokens: 0, requests: 0 };
        chat.models.set(model.id, chatModel);
      }
      if (usage !== undefined) {
        const bucket = state.byDay.get(day) ?? emptyBuckets();
        state.byDay.set(day, bucket);
        addUsage(bucket, usage);
        const input = count(usage.inputTokens) + count(usage.cacheReadTokens) + count(usage.cacheWriteTokens);
        const output = count(usage.outputTokens);
        chat.input += input;
        chat.output += output;
        chat.requests += 1;
        chatModel.input += input;
        chatModel.output += output;
        chatModel.totalTokens += input + output;
        chatModel.requests += 1;
      }
    } else if (event.type === 'tool/call') {
      if (inWindow) {
        const tool = nonemptyString(event.data?.name) ? { id: event.data.name, label: event.data.name } : UNKNOWN;
        state.toolCalls += 1;
        chat.toolCalls += 1;
        addSeries(state.tools, tool, dayIndex, state.keys.length);
      }
      const callId = event.data?.callId;
      const name = skillNameOf(event.data);
      if (nonemptyString(callId) && !skillCalls.has(callId)) {
        // Track non-skill/invalid calls too, so a duplicate callId cannot later
        // replace the original invocation with fabricated valid arguments.
        skillCalls.set(callId, name);
      }
    } else if (event.type === 'tool/result') {
      const callId = event.data?.message?.toolCallId;
      const name = skillCalls.get(callId);
      const success = event.data?.message != null && event.data.message.isError !== true
        && event.data?.error == null;
      if (name !== undefined && success && !successfulSkills.has(callId)) {
        successfulSkills.add(callId);
        if (inWindow) {
          state.skillLoads += 1;
          addSeries(state.skills, { id: name, label: name }, dayIndex, state.keys.length);
        }
      }
    }
  }
  if (chat !== undefined) chat.title = title;
  return counted;
}

const compareId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const sortedSeries = (series) => Array.from(series.values(), (row) => ({ ...row, values: [...row.values] }))
  .sort((a, b) => b.total - a.total || compareId(a, b));

/** Build the additive analytics wire shape without changing the token fields. */
export function buildAnalyticsReport(state, meta = {}) {
  const report = buildReport(state.byDay, state.rangeDays, state.nowMs, {
    ...meta,
    inheritedEventsSkipped: state.inheritedEventsSkipped,
  });
  report.meta.eventsCounted = state.eventsCounted;
  const totalTokens = report.totals.input + report.totals.output;
  const chats = Array.from(state.chats.values(), (chat) => ({
    id: chat.id,
    title: chat.title,
    input: chat.input,
    output: chat.output,
    totalTokens: chat.input + chat.output,
    requests: chat.requests,
    messages: chat.messages,
    toolCalls: chat.toolCalls,
    tokenSharePercent: totalTokens > 0 ? (chat.input + chat.output) / totalTokens * 100 : 0,
    models: Array.from(chat.models.values(), (model) => ({ ...model }))
      .sort((a, b) => b.totalTokens - a.totalTokens || compareId(a, b)),
  })).sort((a, b) => b.totalTokens - a.totalTokens || compareId(a, b));
  const byModel = sortedSeries(state.messagesByModel);
  report.analytics = {
    days: state.keys.map((day) => ({ day, label: dayLabel(day) })),
    messages: {
      total: state.messages,
      byModel,
      byClient: state.messages > 0 ? [{ ...UNKNOWN, total: state.messages,
        values: state.keys.map((_, index) => byModel.reduce((total, row) => total + row.values[index], 0)) }] : [],
      unit: 'assistant-message',
      clientSourceAvailable: false,
    },
    tools: { total: state.toolCalls, series: sortedSeries(state.tools), unit: 'tool-call' },
    skills: { total: state.skillLoads, series: sortedSeries(state.skills), unit: 'successful-skill-load' },
    chats,
    quota: { available: false, fiveHourLimit: null, weeklyLimit: null },
    meta: {
      localOnly: true,
      modelSource: 'assistant-message-or-request-header',
      toolSource: 'tool-call-name',
      skillSource: 'successful-tool-result',
      skillDateSource: 'tool-result',
      chatActivitySource: 'user-message-assistant-message-tool-call-tool-result',
    },
  };
  return report;
}

/** Whole-report fold used by the Host and by tests, including legacy callers. */
export function aggregateSnapshots(snapshots, rangeDays, nowMs, meta = {}) {
  const state = createAggregationState(rangeDays, nowMs);
  for (const snapshot of snapshots ?? []) accumulateAnalyticsSnapshot(state, snapshot);
  return buildAnalyticsReport(state, meta);
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
