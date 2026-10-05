/**
 * Local usage report — Host half.
 *
 * Reads this machine's own session logs through `ctx.sessionQuery` and folds
 * their settled `assistant/message` usage into per-local-day input/output
 * token buckets. Nothing leaves the device: there is no network call, no
 * provider API, and no billing or cost data anywhere in this plugin.
 *
 * The browser half reads the result from one authenticated exact Fetch route
 * (`/api/usage.report`) on the shared `/api` channel; see lib/client.js.
 */
import { writeFileSync } from 'node:fs';

import {
  DEFAULT_RANGE,
  RANGE_CHOICES,
  aggregateSnapshots,
  accumulateSnapshot,
  buildReport,
  dayKeys,
} from './report.js';

/** Cordis plugin name; must equal the package name the profile loads. */
export const name = 'dsh-usage-report';

/**
 * `connection` owns the authenticated `/api` channel this half hangs a route
 * on. `sessionQuery` is read softly instead, so a deployment without it still
 * loads the plugin and reports a readable error in the panel.
 */
export const inject = ['connection'];

/** Exact Fetch route the browser half reads (must live under `/api`). */
export const ROUTE_PATH = '/api/usage.report';

/** Defaults for the two cost knobs. */
const DEFAULTS = {
  cacheTtlMs: 60_000,
  maxSessions: 500,
  readConcurrency: 4,
};

const clampInt = (value, fallback, min, max) => {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
};

/** Accept only the ranges the panel offers, so a stray query cannot widen the fold. */
const normalizeRange = (value) => {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return RANGE_CHOICES.includes(parsed) ? parsed : DEFAULT_RANGE;
};

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: JSON_HEADERS,
});

/**
 * Mount the usage-report Host half.
 *
 * @param ctx - the plugin's Cordis context.
 * @param config - optional `{ cacheTtlMs, maxSessions, readConcurrency, debugDumpPath }`.
 */
export function apply(ctx, config = {}) {
  const ttlMs = clampInt(config.cacheTtlMs, DEFAULTS.cacheTtlMs, 0, 3_600_000);
  const maxSessions = clampInt(config.maxSessions, DEFAULTS.maxSessions, 1, 10_000);
  const readConcurrency = clampInt(config.readConcurrency, DEFAULTS.readConcurrency, 1, 16);
  const debugDumpPath = typeof config.debugDumpPath === 'string' && config.debugDumpPath !== ''
    ? config.debugDumpPath
    : undefined;

  /** rangeDays -> `{ at, report }`; the panel polls rarely, sessions grow slowly. */
  const cache = new Map();
  /** rangeDays -> in-flight promise, so two callers never race the same fold. */
  const inflight = new Map();

  const sessionQueryOf = () => {
    const service = ctx.get('sessionQuery');
    return service && typeof service.listSessions === 'function' && typeof service.readSession === 'function'
      ? service
      : undefined;
  };

  /** Read a bounded number of sessions at a time and fold each one as it lands. */
  async function foldSessions(service, records, signal) {
    const byDay = new Map();
    const skippedReasons = [];
    let scanned = 0;
    let skipped = 0;
    let inheritedEventsSkipped = 0;
    let cursor = 0;

    const worker = async () => {
      for (;;) {
        if (signal?.aborted === true) throw new Error('usage report aborted');
        const record = records[cursor];
        cursor += 1;
        if (record === undefined) return;
        try {
          const snapshot = await service.readSession(record.header.id);
          accumulateSnapshot(byDay, snapshot);
          inheritedEventsSkipped += snapshot?.inheritedEventCount ?? 0;
          scanned += 1;
        } catch (error) {
          skipped += 1;
          if (skippedReasons.length < 5) {
            const reason = error instanceof Error ? error.message : String(error);
            skippedReasons.push(`${String(record.header.id)}: ${reason}`);
          }
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(readConcurrency, records.length) }, worker));
    return { byDay, scanned, skipped, skippedReasons, inheritedEventsSkipped };
  }

  /** Fold every visible session into one report for `rangeDays`. */
  async function collect(rangeDays, signal) {
    const service = sessionQueryOf();
    if (service === undefined) {
      throw Object.assign(new Error('会话查询服务 sessionQuery 未加载，无法统计本机用量'), { code: 'unavailable' });
    }
    const all = await service.listSessions(signal);
    const records = Array.isArray(all) ? all : [];
    // Live sessions first: they are the ones still accumulating today's tokens.
    const ordered = [
      ...records.filter((record) => record.live === true),
      ...records.filter((record) => record.live !== true),
    ].slice(0, maxSessions);

    const folded = await foldSessions(service, ordered, signal);
    return buildReport(folded.byDay, rangeDays, Date.now(), {
      sessionCount: records.length,
      scannedSessions: folded.scanned,
      skippedSessions: folded.skipped,
      skippedReasons: folded.skippedReasons,
      truncatedSessions: Math.max(0, records.length - ordered.length),
      liveSessions: records.filter((record) => record.live === true).length,
      inheritedEventsSkipped: folded.inheritedEventsSkipped,
    });
  }

  /** Cached `collect`, with single-flight per range. */
  async function report(rangeDays, signal) {
    const cached = cache.get(rangeDays);
    if (cached !== undefined && Date.now() - cached.at < ttlMs) return cached.report;
    const pending = inflight.get(rangeDays);
    if (pending !== undefined) return pending;
    const run = collect(rangeDays, signal)
      .then((built) => {
        cache.set(rangeDays, { at: Date.now(), report: built });
        return built;
      })
      .finally(() => {
        inflight.delete(rangeDays);
      });
    inflight.set(rangeDays, run);
    return run;
  }

  ctx.connection.fetch.register({
    path: ROUTE_PATH,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers: JSON_HEADERS });
      try {
        const rangeDays = normalizeRange(new URL(request.url).searchParams.get('range'));
        return jsonResponse(await report(rangeDays, request.signal));
      } catch (error) {
        const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'internal';
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger?.warn?.('usage-report: %s', message);
        return jsonResponse({ error: { code, message } }, code === 'unavailable' ? 503 : 500);
      }
    },
  });

  /**
   * Optional local diagnostic: with `debugDumpPath` configured, the first
   * report is written to that file together with this process's authenticated
   * loopback URL. It is what makes headless screenshot verification possible
   * on the machine that runs the Host; it is off unless configured.
   */
  if (debugDumpPath !== undefined) {
    ctx.effect(() => {
      let dumped = false;
      const run = async () => {
        if (dumped) return;
        dumped = true;
        try {
          const built = await report(DEFAULT_RANGE);
          const port = ctx.get('webServer')?.port;
          const url = typeof port === 'number'
            ? ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(port)}/`)
            : null;
          writeFileSync(debugDumpPath, JSON.stringify({ url, report: built }, null, 2), 'utf8');
        } catch (error) {
          try {
            writeFileSync(debugDumpPath, JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }, null, 2), 'utf8');
          } catch { /* the dump is best-effort */ }
        }
      };
      void run();
      return () => {};
    }, 'usage-report: debug dump');
  }

  ctx.logger?.info?.('usage-report host ready: route %s (local-only aggregation)', ROUTE_PATH);
}

/** Exposed for the offline tests: the same fold the Host half performs. */
export { aggregateSnapshots, accumulateSnapshot, buildReport, dayKeys };

export default { name, inject, apply };
