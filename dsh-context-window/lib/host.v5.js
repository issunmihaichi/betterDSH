/**
 * Context window panel — Host half.
 *
 * The panel itself is Browser-side: the ring, the popover and the official
 * `contextPressure` / `contextBreakdown` numbers all come from the session
 * render tree. This half answers the one question the Browser cannot — *which
 * part of the prompt is MCP (and which server), which is built-in, and which is
 * the skill catalog* — and serves it on one authenticated loopback route.
 *
 * The classification lives in `./classify.js` as pure functions and the pricing
 * in `./estimate.js` as a copy of DSH's own formulas (a Host plugin cannot import
 * a DSH package by bare specifier). Both are imported DYNAMICALLY with this
 * file's `REVISION` as a query: the Loader memoizes a Host module per specifier,
 * and Node's ESM cache is keyed by URL, so a static import would keep serving the
 * previous revision of a dependency even after this entry is renamed. Bumping
 * `REVISION` together with the filename therefore reloads the whole Host half,
 * while the offline tests keep importing the plain files.
 *
 * Reloading this half: the Loader memoizes a Host module per specifier, and
 * neither a file change nor a bundle disable/enable re-imports an
 * already-imported module. A Host change therefore needs either a process
 * restart or a NEW entry filename. This portable release keeps `host.v5.js`
 * and requires a process restart after Host updates. Browser artifacts use
 * revisioned resources; refresh the GUI after updating them. Automatic HMR is
 * not promised unless the matching development watcher has been verified.
 */
import { readFileSync, writeFileSync } from 'node:fs';

/** Bump together with the filename; it is what re-imports the modules below. */
const REVISION = '5';

const { classifySession } = await import(`./classify.js?rev=${REVISION}`);
const { ROLE_OVERHEAD, estimateContent, estimateToolsTokens } = await import(`./estimate.js?rev=${REVISION}`);

/** Cordis plugin name; must equal the package name the profile loads. */
export const name = 'dsh-context-window';

/** Core host prerequisites; none is supplied by another betterDSH bundle.
 * Cordis waits for these services; defensive route checks also handle shutdown.
 */
export const inject = ['connection', 'sessionQuery', 'webServer'];

/** Exact Fetch route the Browser half reads (must live under `/api`). */
export const ROUTE_PATH = '/api/context-window.detail';

/** Re-read window for one session; the panel polls while it is open. */
const DEFAULTS = { cacheTtlMs: 5_000, cacheMaxEntries: 128, maxItems: 60 };

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: JSON_HEADERS,
});

const clampInt = (value, fallback, min, max) => {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
};

/** A subscriber cancellation is not a failure of the shared session read. */
function cancellation(code = 'aborted') {
  return Object.assign(new Error(code === 'disposed' ? 'context window route disposed' : 'context window request aborted'), {
    name: 'AbortError', code,
  });
}

/**
 * Bounded, lazily expired LRU cache with one read per session.
 *
 * HTTP signals belong to subscribers, not the shared read. Only the last
 * subscriber leaving (or plugin disposal) cancels that read; a late result from
 * an ignored abort cannot refill the cache or replace a newer flight.
 *
 * The injectable clock/read pair lets offline tests verify lifecycle behavior
 * without a Harness, timers, network, or session files.
 */
export function createDetailCache({ read, ttlMs = DEFAULTS.cacheTtlMs, maxEntries = DEFAULTS.cacheMaxEntries, clock = Date.now }) {
  const ttl = clampInt(ttlMs, DEFAULTS.cacheTtlMs, 0, 600_000);
  const capacity = clampInt(maxEntries, DEFAULTS.cacheMaxEntries, 1, 512);
  const cache = new Map();
  const inflight = new Map();
  let disposed = false;

  const expire = () => {
    const now = clock();
    for (const [sessionId, cached] of cache) {
      if (now - cached.at >= ttl) cache.delete(sessionId);
    }
  };

  const abandon = (sessionId, flight) => {
    if (inflight.get(sessionId) === flight) inflight.delete(sessionId);
    flight.controller.abort();
  };

  const get = (sessionId, signal) => {
    if (disposed) return Promise.reject(cancellation('disposed'));
    if (signal?.aborted === true) return Promise.reject(cancellation());
    expire();
    const cached = cache.get(sessionId);
    if (cached !== undefined) {
      cache.delete(sessionId);
      cache.set(sessionId, cached);
      return Promise.resolve(cached.payload);
    }

    let flight = inflight.get(sessionId);
    if (flight === undefined) {
      flight = { controller: new AbortController(), waiters: new Set(), promise: undefined };
      inflight.set(sessionId, flight);
      const own = flight;
      own.promise = Promise.resolve().then(() => {
        if (own.controller.signal.aborted) throw cancellation();
        return read(sessionId, own.controller.signal);
      }).then((payload) => {
        if (!disposed && !own.controller.signal.aborted && inflight.get(sessionId) === own && ttl > 0) {
          expire();
          cache.delete(sessionId);
          cache.set(sessionId, { at: clock(), payload });
          while (cache.size > capacity) cache.delete(cache.keys().next().value);
        }
        return payload;
      }).finally(() => {
        if (inflight.get(sessionId) === own) inflight.delete(sessionId);
      });
    }

    const own = flight;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (failed, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        own.waiters.delete(cancel);
        if (own.waiters.size === 0 && inflight.get(sessionId) === own) abandon(sessionId, own);
        if (failed) reject(value);
        else resolve(value);
      };
      const cancel = (code) => finish(true, cancellation(code));
      const onAbort = () => cancel('aborted');
      own.waiters.add(cancel);
      signal?.addEventListener('abort', onAbort, { once: true });
      own.promise.then((payload) => finish(false, payload), (error) => finish(true, error));
      // Also covers a signal aborted between the initial check and subscription.
      if (signal?.aborted === true) onAbort();
    });
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cache.clear();
    for (const flight of [...inflight.values()]) {
      flight.controller.abort();
      for (const cancel of [...flight.waiters]) cancel('disposed');
    }
    inflight.clear();
  };

  return {
    get,
    dispose,
    stats: () => {
      expire();
      return { cached: cache.size, inflight: inflight.size, disposed };
    },
  };
}

/**
 * Mount the Host half: the classification route plus the optional loopback URL
 * dump used by the screenshot verification.
 * @param ctx - the plugin's Cordis context.
 * @param config - optional `{ cacheTtlMs, cacheMaxEntries, maxItems, debugDumpPath }`.
 */
export function apply(ctx, config = {}) {
  const ttlMs = clampInt(config.cacheTtlMs, DEFAULTS.cacheTtlMs, 0, 600_000);
  const cacheMaxEntries = clampInt(config.cacheMaxEntries, DEFAULTS.cacheMaxEntries, 1, 512);
  const maxItems = clampInt(config.maxItems, DEFAULTS.maxItems, 1, 500);
  const debugDumpPath = typeof config.debugDumpPath === 'string' && config.debugDumpPath !== ''
    ? config.debugDumpPath
    : undefined;

  let legacyInputUsage = {};
  if (typeof config.legacyInputUsagePath === 'string' && config.legacyInputUsagePath !== '') {
    try {
      const value = JSON.parse(readFileSync(config.legacyInputUsagePath, 'utf8'));
      if (value && typeof value === 'object' && !Array.isArray(value)) legacyInputUsage = value;
    } catch {
      ctx.logger?.warn?.('context-window: legacy usage snapshot unavailable');
    }
  }

  /** DSH's own pricing, injected so classify.js stays pure and testable. */
  const pricing = {
    legacyInputUsage,
    maxItems,
    priceTools: (tools) => estimateToolsTokens(tools),
    priceContent: (blocks) => estimateContent(blocks),
    roleOverhead: ROLE_OVERHEAD,
  };

  const readEvents = async (sessionId, signal) => {
    const service = ctx.get('sessionQuery');
    if (service === undefined) {
      throw Object.assign(new Error('会话查询服务 sessionQuery 未加载，无法读取上下文构成'), { code: 'unavailable' });
    }
    if (typeof service.observeSession === 'function') {
      const observation = await service.observeSession(sessionId, { signal, projectionMode: 'none' });
      try {
        return observation?.events ?? [];
      } finally {
        observation?.dispose?.();
      }
    }
    if (typeof service.readSession === 'function') {
      const snapshot = await service.readSession(sessionId);
      return snapshot?.events ?? [];
    }
    throw Object.assign(new Error('sessionQuery 不支持读取会话事件'), { code: 'unavailable' });
  };

  const details = createDetailCache({
    ttlMs,
    maxEntries: cacheMaxEntries,
    read: async (sessionId, signal) => classifySession(await readEvents(sessionId, signal), sessionId, pricing),
  });

  ctx.effect(() => {
    const unregister = ctx.connection.fetch.register({
      path: ROUTE_PATH,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method === 'HEAD') return new Response(null, { status: 200, headers: JSON_HEADERS });
        try {
          const sessionId = new URL(request.url).searchParams.get('session');
          if (sessionId === null || sessionId === '') {
            return jsonResponse({ error: { code: 'bad-request', message: 'session is required' } }, 400);
          }
          return jsonResponse(await details.get(sessionId, request.signal));
        } catch (error) {
          const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'internal';
          const message = error instanceof Error ? error.message : String(error);
          if (code !== 'aborted' && code !== 'disposed') ctx.logger?.warn?.('context-window: %s', message);
          const status = code === 'aborted' ? 499 : code === 'unavailable' || code === 'disposed' ? 503 : 500;
          return jsonResponse({ error: { code, message } }, status);
        }
      },
    });
    return () => {
      details.dispose();
      unregister?.();
    };
  }, 'context-window: detail route');

  if (debugDumpPath !== undefined) {
    ctx.effect(() => {
      const port = ctx.get('webServer')?.port;
      const connection = ctx.get('connection');
      let url = null;
      try {
        if (typeof port === 'number' && connection !== undefined) {
          url = connection.authenticatedUrl(`http://127.0.0.1:${String(port)}/`);
        }
      } catch { /* the dump is best-effort */ }
      try {
        writeFileSync(debugDumpPath, JSON.stringify({ url, at: Date.now() }, null, 2), 'utf8');
      } catch { /* the dump is best-effort */ }
      return () => {};
    }, 'context-window: debug dump');
  }

  ctx.logger?.info?.('context-window host ready: route %s (rev %s)', ROUTE_PATH, REVISION);
}

export default { name, inject, apply };
