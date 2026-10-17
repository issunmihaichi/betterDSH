/**
 * Loopback-only OpenAI-compatible ingress; the Host owns the key and lifecycle.
 * No DSH imports, credential lookup, account selection or independent upstream.
 * See LOCAL-API.md for the deliberately limited compatibility contract.
 */
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { LocalApiError, parseChatRequest, createCompletion, publicError } from './local-api-protocol.js';
import { parseResponsesRequest } from './local-api-responses-request.js';
import { createResponsesOutput } from './local-api-responses-output.js';

const digest = value => createHash('sha256').update(value).digest();
function keyDigest(value) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 4096 || !/^[\x21-\x7e]+$/.test(value)) throw new TypeError('Local API key must contain 32–4096 printable non-space ASCII characters.');
  return digest(value);
}
function countHeader(req, name) { let count = 0; for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === name) count++; return count; }
// Tauri's native HTTP plugin adds the WebView origin even though reqwest is
// outside browser CORS. Project Graph uses this path. These exact standard
// origins are transport compatibility, NOT an application identity or permission:
// loopback peer, exact Host and the independent Bearer key remain mandatory.
const TAURI_ORIGINS = new Set(['http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost']);
function supportedOrigin(req) {
  const count = countHeader(req, 'origin');
  return count === 0 || (count === 1 && TAURI_ORIGINS.has(req.headers.origin));
}
const fail = (status, code, message) => { throw new LocalApiError(status, code, message); };
const commonHeaders = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
function json(res, status, body, beforeWrite = () => {}) {
  const serialized = JSON.stringify(body);
  beforeWrite(); // Synchronous JSON work can run past a timer's due time.
  res.writeHead(status, { ...commonHeaders, 'content-type': 'application/json; charset=utf-8', ...(status >= 400 ? { connection: 'close' } : {}) });
  res.end(serialized);
}
function abortable(work, signal) {
  if (signal.aborted) { Promise.resolve(work).catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(work).then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
function readBody(req, signal, limit) {
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limit)) fail(413, 'body_too_large', 'Request body exceeds the local size limit.');
  if (req.headers['content-encoding'] !== undefined && req.headers['content-encoding'] !== 'identity') fail(415, 'unsupported_encoding', 'Compressed request bodies are not supported.');
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) fail(415, 'unsupported_media_type', 'Content-Type must be application/json with optional charset=utf-8.');
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => { req.removeListener('data', data); req.removeListener('end', end); req.removeListener('error', error); signal.removeEventListener('abort', abort); };
    const error = reason => { cleanup(); req.pause(); reject(reason); };
    const abort = () => error(signal.reason);
    const data = chunk => {
      size += chunk.length;
      if (size > limit) return error(new LocalApiError(413, 'body_too_large', 'Request body exceeds the local size limit.'));
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
      catch { reject(new LocalApiError(400, 'invalid_json', 'Request body must be valid UTF-8 JSON.')); }
    };
    req.on('data', data); req.once('end', end); req.once('error', error); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
async function writeChunk(res, value, signal, eventName) {
  signal.throwIfAborted();
  if (res.destroyed) throw new LocalApiError(503, 'client_disconnected', 'Client disconnected.');
  if (res.write(`${eventName ? `event: ${eventName}\n` : ''}data: ${JSON.stringify(value)}\n\n`)) return;
  // Never pull another adapter chunk while the downstream buffer is full.
  await new Promise((resolve, reject) => {
    const cleanup = () => { res.removeListener('drain', drain); res.removeListener('close', close); res.removeListener('error', error); signal.removeEventListener('abort', abort); };
    const drain = () => { cleanup(); resolve(); };
    const error = reason => { cleanup(); reject(reason); };
    const close = () => error(new LocalApiError(503, 'client_disconnected', 'Client disconnected.'));
    const abort = () => error(signal.reason);
    res.once('drain', drain); res.once('close', close); res.once('error', error); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
function responseFinished(res, signal) {
  if (res.writableFinished) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { res.removeListener('finish', finish); res.removeListener('close', close); res.removeListener('error', error); signal.removeEventListener('abort', abort); };
    const finish = () => { cleanup(); resolve(); };
    const error = reason => { cleanup(); reject(reason); };
    const close = () => error(new LocalApiError(503, 'client_disconnected', 'Client disconnected.'));
    const abort = () => error(signal.reason);
    res.once('finish', finish); res.once('close', close); res.once('error', error); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else if (res.destroyed) close();
  });
}
function boundErrorFlush(res) {
  if (res.writableFinished || res.destroyed) return;
  const timer = setTimeout(() => res.destroy(), 1000);
  timer.unref();
  const cleanup = () => { clearTimeout(timer); res.removeListener('finish', cleanup); res.removeListener('close', cleanup); };
  res.once('finish', cleanup); res.once('close', cleanup);
}
function requestRoute(req) {
  for (const header of ['x-account-pool-group', 'x-account-pool-session']) if (countHeader(req, header) > 1) fail(400, 'invalid_header', 'Duplicate pool routing headers are not supported.');
  const group = req.headers['x-account-pool-group'];
  if (group !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(group)) fail(400, 'invalid_group', 'Group must be a valid pool group identifier.');
  const provider = group === undefined ? 'pool' : `pool-${group}`;
  const session = req.headers['x-account-pool-session'];
  if (session !== undefined && (typeof session !== 'string' || !session.length || session.length > 256 || /[^\x21-\x7e]/.test(session))) fail(400, 'invalid_session', 'Session must contain 1–256 printable non-space ASCII characters.');
  // Client ids must never impersonate durable DSH sessions or cross group bindings.
  const sessionId = session === undefined ? undefined : `local-api:${digest(JSON.stringify([provider, session])).toString('hex')}`;
  return { provider, ...(sessionId === undefined ? {} : { sessionId }) };
}

/**
 * Returns { port, baseUrl, close(), setApiKey(key) }. baseUrl includes /v1.
 * port:0 is supported for tests. Keys must be random; length validation cannot
 * prove entropy. close() is idempotent and never closes the shared adapter.
 */
export async function createLocalApiServer({ adapter, apiKey, port = 19389, requestTimeoutMs = 120_000, maxBodyBytes = 8 * 1024 * 1024 } = {}) {
  let keyHash = keyDigest(apiKey);
  if (!adapter || typeof adapter.stream !== 'function' || typeof adapter.listModels !== 'function') throw new TypeError('Local API requires a pool adapter.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('Invalid local API port.');
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 3_600_000) throw new RangeError('Invalid local API request timeout.');
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 64 * 1024 * 1024) throw new RangeError('Invalid local API body limit.');
  let actualPort, closing;
  const sockets = new Set(), active = new Set(), tasks = new Set();
  async function handle(req, res) {
    const controller = new AbortController(), { signal } = controller;
    active.add(controller);
    const disconnect = () => controller.abort(new LocalApiError(503, 'client_disconnected', 'Client disconnected.'));
    const responseClose = () => { if (!res.writableFinished) disconnect(); };
    req.once('aborted', disconnect); res.once('close', responseClose); res.once('error', disconnect);
    const deadline = Date.now() + requestTimeoutMs;
    const timeout = () => controller.abort(new LocalApiError(503, 'request_timeout', 'The local API request timed out.'));
    const checkDeadline = () => { if (Date.now() >= deadline) timeout(); signal.throwIfAborted(); };
    const timer = setTimeout(timeout, requestTimeoutMs);
    timer.unref();
    let iterator, responsesOutput, exhausted = false;
    try {
      if (closing) fail(503, 'server_closing', 'The local API is shutting down.');
      if (req.socket.remoteAddress !== '127.0.0.1' || countHeader(req, 'host') !== 1 || req.headers.host !== `127.0.0.1:${actualPort}` || !supportedOrigin(req)) fail(403, 'forbidden', 'Only loopback clients with the exact local Host and a native or supported Tauri origin are permitted.');
      const match = /^Bearer ([\x21-\x7e]+)$/i.exec(req.headers.authorization ?? '');
      const authenticated = timingSafeEqual(keyHash, digest(match?.[1] ?? ''));
      if (countHeader(req, 'authorization') !== 1 || !match || !authenticated) {
        res.setHeader('www-authenticate', 'Bearer'); fail(401, 'invalid_api_key', 'Invalid API key.');
      }
      const route = requestRoute(req);
      const isResponses = req.url === '/v1/responses';
      const expectedMethod = req.url === '/v1/models' ? 'GET' : req.url === '/v1/chat/completions' || isResponses ? 'POST' : undefined;
      if (!expectedMethod) fail(404, 'not_found', 'Endpoint not found.');
      if (req.method !== expectedMethod) { res.setHeader('allow', expectedMethod); fail(405, 'method_not_allowed', 'Method not allowed.'); }
      if (req.headers.expect === '100-continue') res.writeContinue();
      if (expectedMethod === 'GET') {
        if (req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) !== 0) fail(400, 'unexpected_body', 'Model listing does not accept a request body.');
        const models = await abortable(adapter.listModels(route.provider), signal);
        if (!Array.isArray(models)) fail(502, 'upstream_protocol_error', 'The pool returned invalid model metadata.');
        const ids = [...new Set(models.filter(row => typeof row?.id === 'string' && row.id.length > 0 && row.id.length <= 256 && !/[\x00-\x1f\x7f]/.test(row.id)).map(row => row.id))];
        json(res, 200, { object: 'list', data: ids.map(id => ({ id, object: 'model', created: 0, owned_by: 'account-pool' })) }, checkDeadline);
        await responseFinished(res, signal);
        return;
      }
      const body = await readBody(req, signal, maxBodyBytes);
      const parsed = isResponses ? parseResponsesRequest(body) : parseChatRequest(body);
      const { options } = parsed;
      if (parsed.hasImages || options.reasoningEffort !== undefined) {
        const info = typeof adapter.resolveModel === 'function' ? await abortable(adapter.resolveModel(route.provider, options.model), signal) : undefined;
        if (parsed.hasImages && !info?.inputModalities?.includes('image')) fail(400, 'unsupported_images', 'This pool route does not advertise image support.');
        if (info && options.reasoningEffort !== undefined && !info.reasoning?.efforts?.some(effort => effort.id === options.reasoningEffort)) fail(400, 'unsupported_reasoning_effort', 'This pool route does not advertise the requested reasoning effort.');
      }
      checkDeadline();
      responsesOutput = isResponses ? createResponsesOutput(options.model, parsed.responseOptions) : undefined;
      const completion = responsesOutput ?? createCompletion(options.model);
      const pendingStart = responsesOutput?.start() ?? [];
      const source = adapter.stream({ ...options, ...route, signal });
      if (!source || typeof source[Symbol.asyncIterator] !== 'function') fail(502, 'upstream_protocol_error', 'The pool returned an invalid stream.');
      iterator = source[Symbol.asyncIterator]();
      async function emit(value) {
        if (!res.headersSent) {
          checkDeadline();
          res.writeHead(200, { ...commonHeaders, 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no' });
          if (responsesOutput) {
            for (const event of pendingStart) await writeChunk(res, event, signal, event.type);
          } else await writeChunk(res, completion.chunk({ role: 'assistant' }), signal);
        }
        if (responsesOutput) await writeChunk(res, value, signal, value.type);
        else await writeChunk(res, completion.chunk(value), signal);
      }
      for (;;) {
        checkDeadline();
        const next = await abortable(iterator.next(), signal);
        checkDeadline();
        if (next.done) { exhausted = true; break; }
        const deltas = completion.consume(next.value);
        if (parsed.stream) for (const delta of deltas) await emit(delta);
      }
      // Wait for iterator exhaustion, not merely finish: the shared adapter owns
      // success accounting after yielding its final chunk and may still fail.
      checkDeadline();
      const result = completion.complete();
      if (!parsed.stream) {
        json(res, 200, responsesOutput ? result.response : result, checkDeadline);
        await responseFinished(res, signal);
        return;
      }
      if (responsesOutput) {
        for (const event of result.events) await emit(event);
        res.end(); // Responses terminates with its lifecycle event, not [DONE].
      } else {
        if (!res.headersSent) await emit({});
        await writeChunk(res, completion.chunk({}, result.choices[0].finish_reason), signal);
        if (parsed.includeUsage) await writeChunk(res, completion.usageChunk(), signal);
        res.end('data: [DONE]\n\n');
      }
      await responseFinished(res, signal);
    } catch (error) {
      if (!res.destroyed && !res.writableEnded) {
        const safe = publicError(error);
        if (res.headersSent) {
          // A bounded terminal error, never a success finish or [DONE]. end() may
          // enqueue this single small frame even when an aborted client is slow.
          if (responsesOutput) {
            const event = responsesOutput.failure(safe.body);
            res.end(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          } else res.end(`event: error\ndata: ${JSON.stringify(safe.body)}\n\n`);
        } else json(res, safe.status, safe.body);
        boundErrorFlush(res);
      } else if (!res.destroyed && !res.writableFinished) {
        // A JSON body already ended cannot be replaced with an error body. Drop
        // the stalled connection so a client cannot mistake truncation for success.
        res.destroy();
      }
    } finally {
      clearTimeout(timer);
      if (!exhausted && iterator) {
        controller.abort(new LocalApiError(503, 'request_cancelled', 'Request cancelled.'));
        // Give cooperative transports time to release concurrency and record
        // failed usage before Host shutdown. A broken injected iterator must not
        // make close() wait forever; queued return() rejections are still observed.
        let cleanupTimer;
        try {
          await Promise.race([
            Promise.resolve(iterator.return?.()).catch(() => {}),
            new Promise(resolve => { cleanupTimer = setTimeout(resolve, 250); }),
          ]);
        } catch { /* best effort */ }
        finally { clearTimeout(cleanupTimer); }
      }
      active.delete(controller);
      req.removeListener('aborted', disconnect); res.removeListener('close', responseClose); res.removeListener('error', disconnect);
    }
  }
  const dispatch = (req, res) => {
    const task = handle(req, res).catch(() => { res.destroy(); });
    tasks.add(task); void task.finally(() => tasks.delete(task));
  };
  const server = http.createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 0, headersTimeout: Math.min(30_000, Math.max(1000, requestTimeoutMs)) }, dispatch);
  server.maxHeadersCount = 64;
  server.on('checkContinue', dispatch);
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); else socket.destroy(); });
  server.on('connect', (_req, socket) => socket.destroy());
  server.on('upgrade', (_req, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); actualPort = server.address().port; resolve(); });
  });
  // Errors after listen are not allowed to crash the Host; active requests retain
  // their own guarded failure path. Bind failures above still reject creation.
  server.on('error', () => {});
  return {
    port: actualPort, baseUrl: `http://127.0.0.1:${actualPort}/v1`,
    setApiKey(next) { if (closing) throw new Error('Local API is closed.'); keyHash = keyDigest(next); },
    close() {
      if (!closing) {
        closing = (async () => {
          const stopped = new Promise(resolve => server.close(resolve));
          for (const controller of active) controller.abort(new LocalApiError(503, 'server_closing', 'The local API is shutting down.'));
          for (const socket of sockets) socket.destroy();
          await Promise.all([...tasks]);
          await stopped;
        })();
      }
      return closing;
    },
  };
}
