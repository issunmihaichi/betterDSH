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
 * restart or a NEW entry filename — hence `host.v5.js`, bumped on every Host
 * change with the previous file deleted. The Browser half has no such
 * constraint and hot-reloads on save.
 */
import { readFileSync, writeFileSync } from 'node:fs';

/** Bump together with the filename; it is what re-imports the modules below. */
const REVISION = '5';

const { classifySession } = await import(`./classify.js?rev=${REVISION}`);
const { ROLE_OVERHEAD, estimateContent, estimateToolsTokens } = await import(`./estimate.js?rev=${REVISION}`);

/** Cordis plugin name; must equal the package name the profile loads. */
export const name = 'dsh-context-window';

/** `connection` owns the authenticated `/api` channel; `sessionQuery` is read softly. */
export const inject = ['connection', 'sessionQuery', 'webServer'];

/** Exact Fetch route the Browser half reads (must live under `/api`). */
export const ROUTE_PATH = '/api/context-window.detail';

/** Re-read window for one session; the panel polls while it is open. */
const DEFAULTS = { cacheTtlMs: 5_000, maxItems: 60 };

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

/**
 * Mount the Host half: the classification route plus the optional loopback URL
 * dump used by the screenshot verification.
 * @param ctx - the plugin's Cordis context.
 * @param config - optional `{ cacheTtlMs, maxItems, debugDumpPath }`.
 */
export function apply(ctx, config = {}) {
  const ttlMs = clampInt(config.cacheTtlMs, DEFAULTS.cacheTtlMs, 0, 600_000);
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

  /** sessionId -> `{ at, payload }`. */
  const cache = new Map();

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

  const detailFor = async (sessionId, signal) => {
    const cached = cache.get(sessionId);
    if (cached !== undefined && Date.now() - cached.at < ttlMs) return cached.payload;
    const payload = classifySession(await readEvents(sessionId, signal), sessionId, pricing);
    cache.set(sessionId, { at: Date.now(), payload });
    return payload;
  };

  ctx.connection.fetch.register({
    path: ROUTE_PATH,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers: JSON_HEADERS });
      const sessionId = new URL(request.url).searchParams.get('session');
      if (sessionId === null || sessionId === '') {
        return jsonResponse({ error: { code: 'bad-request', message: 'session is required' } }, 400);
      }
      try {
        return jsonResponse(await detailFor(sessionId, request.signal));
      } catch (error) {
        const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'internal';
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger?.warn?.('context-window: %s', message);
        return jsonResponse({ error: { code, message } }, code === 'unavailable' ? 503 : 500);
      }
    },
  });

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
