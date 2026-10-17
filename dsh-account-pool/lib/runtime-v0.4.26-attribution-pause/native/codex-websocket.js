/** Reusable OAuth Codex Responses WebSocket transport; no account selection or logs. */
import WebSocket from 'ws';
import { createHash } from 'node:crypto';

const BETA = 'responses_websockets=2026-02-06';
const MB = 1024 * 1024;
const RETRY_CODES = new Set(['previous_response_not_found', 'websocket_connection_limit_reached']);
const INCOMPATIBLE_STATUSES = new Set([404, 405, 426, 501, 502, 503, 504]);
const ERROR_EVENTS = new Set(['error', 'response.failed', 'response.incomplete', 'response.cancelled', 'response.canceled']);
const HEADERS = new Set(['authorization', 'chatgpt-account-id', 'chatgpt-project-id', 'chatgpt-organization-id',
  'openai-organization', 'openai-project', 'originator', 'user-agent', 'version', 'session_id', 'session-id',
  'thread-id', 'x-openai-subagent', 'traceparent', 'tracestate']);

function error(code, status = 502, fallback = false) {
  return Object.assign(new Error(`Codex WebSocket failed (${code})`), {
    name: 'CodexWebSocketError', code, status, ...(fallback ? { codexWebSocketFallback: true } : {}),
  });
}
function abortReason(signal) {
  return signal.reason ?? Object.assign(new Error('Codex request cancelled'), { name: 'AbortError' });
}
function check(signal) { if (signal.aborted) throw abortReason(signal); }
function bounded(value, fallback, max) {
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), max) || 1 : fallback;
}
function opaque(value) { return typeof value === 'string' && value.length > 0 && value.length <= 1024; }
function digest(text) { return createHash('sha256').update(text).digest('hex'); }
function canonical(value, depth = 0) {
  if (depth > 128) throw error('CODEX_WS_JSON_DEPTH', 400);
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(',')}}`;
}

// JSON.parse alone aliases duplicate keys and lossy numbers. Semantic tool argument
// comparison is deliberately restricted to unique keys and exact safe integers;
// all other argument strings require byte equality (including floats/invalid JSON).
function safeArgumentJson(text) {
  try {
    const value = JSON.parse(text);
    const containers = [];
    const token = /\s*("(?:[^"\\]|\\.)*"|[{}\[\],:]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/gy;
    let match;
    while ((match = token.exec(text))) {
      const part = match[1];
      if (part === '{' || part === '[') {
        containers.push(part === '{' ? new Set() : null);
        if (containers.length > 128) return undefined;
      } else if (part === '}' || part === ']') containers.pop();
      else if (part[0] === '"' && /^\s*:/.test(text.slice(token.lastIndex))) {
        const key = JSON.parse(part), keys = containers.at(-1);
        if (!keys || keys.has(key)) return undefined;
        keys.add(key);
      } else if (/^-?\d/.test(part) && (!/^-?(0|[1-9]\d*)$/.test(part) || !Number.isSafeInteger(Number(part)))) return undefined;
    }
    return canonical(value);
  } catch { return undefined; }
}
function itemDigest(item) {
  if (item?.type === 'function_call' && typeof item.arguments === 'string') {
    const { arguments: args, ...rest } = item;
    const semantic = safeArgumentJson(args);
    return digest(canonical([rest, semantic === undefined ? ['raw', args] : ['json', semantic]]));
  }
  return digest(canonical(item));
}
function websocketUrl(input, allowInsecureLocalhost) {
  let url;
  try { url = new URL(input); } catch { throw error('CODEX_WS_INVALID_URL', 400); }
  const local = allowInsecureLocalhost && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash
    || !url.pathname.endsWith('/backend-api/codex/responses')) throw error('CODEX_WS_INVALID_URL', 400);
  url.protocol = local ? 'ws:' : 'wss:';
  return url.href;
}
function handshakeHeaders(input) {
  const headers = {};
  try {
    for (const [name, value] of new Headers(input)) {
      if (HEADERS.has(name) || name.startsWith('x-codex-')) headers[name] = value;
    }
  } catch { throw error('CODEX_WS_INVALID_HEADERS', 400); }
  headers['openai-beta'] = BETA;
  return headers;
}
function statusOf(event, code) {
  const detail = event.response?.error ?? event.error ?? {};
  const status = [detail.status, detail.status_code, event.response?.status_code, event.status, event.status_code]
    .map(Number).find(value => Number.isInteger(value) && value >= 400 && value <= 599);
  return status ?? (/rate_limit|usage_limit|quota/.test(code) ? 429
    : /invalid_api_key|invalid_token|authentication|token_expired|unauthorized/.test(code) ? 401
      : /forbidden|permission|workspace.*(?:suspend|deactivat)|deactivated_workspace/.test(code) ? 403
        : /context_length|invalid_request|unknown_parameter|unsupported|content_filter/.test(code) ? 400 : 502);
}
function safeCode(value, fallback) {
  return typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_.:-]{0,79}$/.test(value) ? value : fallback;
}

/**
 * stream(request, { signal, sessionKey, identityKey, mapResponse,
 *   getContinuationOutput, getContinuationCallIds?, httpFallback, onDispatch? })
 *
 * Both keys are opaque trusted parent hashes. Missing either disables reuse.
 * mapResponse receives an async iterable of JSON frame strings, once per attempt.
 * Its sidecars MUST remain unset until validated completion. Output is an array
 * of normalized request-input items. Optional call IDs are a Map or plain record
 * of normalized -> original wire IDs; aliases must be collision-free. Without
 * this sidecar, function-call output is conservatively ineligible for continuation.
 * Fully consume the iterator to commit; return()/throw()/abort invalidates reuse.
 * httpFallback({signal}) should use this combined signal to support dispose().
 * onDispatch() is best-effort and called once before each actual WS attempt.
 *
 * Additional factory limits: maxPendingRequests=128 (active plus waiting),
 * maxBufferBytes=16MiB, maxBufferedFrames=10000, maxStateBytes=16MiB,
 * maxRequestBytes=16MiB. maxSessions bounds ALL resident/ephemeral sessions.
 * allowInsecureLocalhost=false is ONLY for synthetic loopback tests.
 * snapshot() exposes counts only. invalidate(sessionKey) cancels this session's
 * active/waiting work and removes its socket, fallback preference and history.
 */
export function createCodexWebSocketTransport({
  webSocketImpl = WebSocket, connectTimeoutMs = 10_000, idleTimeoutMs = 120_000,
  sessionIdleMs = 300_000, maxSessions = 32, upstreamError, now = Date.now,
  maxPendingRequests = 128, maxBufferBytes = 16 * MB, maxBufferedFrames = 10_000,
  maxStateBytes = 16 * MB, maxRequestBytes = 16 * MB, allowInsecureLocalhost = false,
} = {}) {
  connectTimeoutMs = bounded(connectTimeoutMs, 10_000, 600_000);
  idleTimeoutMs = bounded(idleTimeoutMs, 120_000, 600_000);
  sessionIdleMs = bounded(sessionIdleMs, 300_000, 3_600_000);
  maxSessions = bounded(maxSessions, 32, 256);
  maxPendingRequests = bounded(maxPendingRequests, 128, 1024);
  maxBufferBytes = bounded(maxBufferBytes, 16 * MB, 64 * MB);
  maxBufferedFrames = bounded(maxBufferedFrames, 10_000, 100_000);
  maxStateBytes = bounded(maxStateBytes, 16 * MB, 64 * MB);
  maxRequestBytes = bounded(maxRequestBytes, 16 * MB, 64 * MB);
  const sessions = new Map(), entries = new Set(), operations = new Set();
  let disposed = false, pruneTimer;
  const counts = { connectionsOpened: 0, connectionReuses: 0, fullRequests: 0, incrementalRequests: 0,
    reconnectRetries: 0, httpFallbacks: 0, completedRequests: 0 };
  const increment = name => { counts[name] = Math.min(Number.MAX_SAFE_INTEGER, counts[name] + 1); };

  function upstreamFailure(status, code, sourceHeaders, fallback = false) {
    const result = error(code, status, fallback);
    if (typeof upstreamError === 'function') {
      // Never send server messages, response bodies, account headers or tokens to
      // the upstream classifier/logger. Retry-After is the only retained header.
      const headers = new Headers();
      try {
        const retry = new Headers(sourceHeaders).get('retry-after');
        if (retry && retry.length <= 128 && /^[\w\s,:.+-]+$/.test(retry)) headers.set('retry-after', retry);
        const classified = upstreamError({ status, headers }, JSON.stringify({ error: { code, message: 'Codex WebSocket request failed' } }));
        if (Number.isFinite(classified?.providerRetryAfterMs) && classified.providerRetryAfterMs >= 0) {
          result.providerRetryAfterMs = Math.min(classified.providerRetryAfterMs, 21_600_000);
        }
      } catch { /* Classification is advisory, never replace the safe failure. */ }
    }
    return result;
  }
  function reset(entry) {
    entry.last = undefined;
    const connection = entry.connection;
    entry.connection = undefined;
    connection?.destroy();
  }
  function remove(entry, reason) {
    entries.delete(entry);
    if (sessions.get(entry.key) === entry) sessions.delete(entry.key);
    entry.removed = true;
    if (reason) for (const operation of operations) if (operation.entry === entry) operation.controller.abort(reason);
    reset(entry);
  }
  function prune() {
    const timestamp = now();
    for (const entry of entries) {
      if (!entry.locked && entry.waiters.length === 0 && timestamp - entry.lastUsed >= sessionIdleMs) remove(entry);
    }
  }
  function schedulePrune() {
    clearTimeout(pruneTimer); pruneTimer = undefined;
    if (disposed) return;
    let delay = Infinity;
    for (const entry of entries) if (!entry.locked && entry.waiters.length === 0) {
      delay = Math.min(delay, Math.max(1, sessionIdleMs - (now() - entry.lastUsed)));
    }
    if (Number.isFinite(delay)) {
      pruneTimer = setTimeout(() => { pruneTimer = undefined; prune(); schedulePrune(); }, delay);
      pruneTimer.unref?.();
    }
  }
  function findEntry(sessionKey, identityKey) {
    prune();
    const key = opaque(sessionKey) && opaque(identityKey) ? sessionKey : undefined;
    let entry = key === undefined ? undefined : sessions.get(key);
    if (entry) return entry;
    if (entries.size >= maxSessions) {
      const oldest = [...entries].filter(candidate => !candidate.locked && !candidate.waiters.length)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (oldest) remove(oldest);
      else throw error('CODEX_WS_CAPACITY', 503);
    }
    entry = { key, identityKey, lastUsed: now(), waiters: [], locked: false, removed: false, http: false };
    entries.add(entry);
    if (key !== undefined) sessions.set(key, entry);
    return entry;
  }
  async function lock(entry, signal) {
    check(signal);
    if (!entry.locked) { entry.locked = true; return; }
    await new Promise((resolve, reject) => {
      const waiter = { resolve: () => { signal.removeEventListener('abort', cancel); resolve(); } };
      const cancel = () => {
        const index = entry.waiters.indexOf(waiter);
        if (index !== -1) entry.waiters.splice(index, 1);
        signal.removeEventListener('abort', cancel);
        reject(abortReason(signal));
      };
      signal.addEventListener('abort', cancel, { once: true });
      entry.waiters.push(waiter);
      if (signal.aborted) cancel();
    });
  }
  function unlock(entry) {
    entry.lastUsed = now();
    const waiter = entry.waiters.shift();
    if (waiter) waiter.resolve();
    else {
      entry.locked = false;
      if (entry.key === undefined || entry.removed) remove(entry);
    }
    schedulePrune();
  }

  function connect(entry, url, headers) {
    let socket;
    try {
      socket = new webSocketImpl(url, { headers, followRedirects: false,
        handshakeTimeout: connectTimeoutMs, maxPayload: maxBufferBytes });
    } catch { throw error('CODEX_WS_CONNECTION_FAILED', 502, true); }
    const queue = [];
    let bytes = 0, wake, timer, opened = false, closed = false, destroyed = false;
    let failure, active = false, terminal = false, rejectedResponse, cleanupTimer, sends = 0;
    const notify = () => { const resolve = wake; wake = undefined; resolve?.(); };
    const clearDeadline = () => { clearTimeout(timer); timer = undefined; };
    const fail = reason => { failure ??= reason; clearDeadline(); notify(); destroy(); };
    const deadline = (ms, code) => {
      clearDeadline();
      timer = setTimeout(() => fail(error(code, 504, true)), ms);
    };
    const onOpen = () => { opened = true; increment('connectionsOpened'); clearDeadline(); notify(); };
    const onMessage = (raw, binary) => {
      if (destroyed || failure) return;
      if (!active || terminal) { fail(error('CODEX_WS_UNEXPECTED_FRAME')); destroy(); return; }
      if (binary) { fail(error('CODEX_WS_INVALID_FRAME', 502, true)); return; }
      let text, size;
      try {
        size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.byteLength;
        if (!Number.isSafeInteger(size) || size > maxBufferBytes) { fail(error('CODEX_WS_BUFFER_LIMIT')); return; }
        text = typeof raw === 'string' ? raw : raw.toString('utf8');
      } catch { fail(error('CODEX_WS_INVALID_FRAME', 502, true)); return; }
      if (bytes + size > maxBufferBytes || queue.length >= maxBufferedFrames) { fail(error('CODEX_WS_BUFFER_LIMIT')); return; }
      queue.push({ text, size }); bytes += size;
      deadline(idleTimeoutMs, 'CODEX_WS_IDLE_TIMEOUT'); notify();
    };
    const onError = () => {
      fail(error(opened ? 'CODEX_WS_CONNECTION_FAILED' : 'CODEX_WS_CONNECT_FAILED', 502, true));
      if (!active) destroy();
    };
    const onClose = () => {
      closed = true; clearDeadline(); notify();
      if (!active) destroy();
    };
    const onUnexpected = (_request, response) => {
      rejectedResponse = response;
      const status = Number.isInteger(response.statusCode) && response.statusCode >= 300 && response.statusCode <= 599 ? response.statusCode : 502;
      // No unbounded error-body accumulation and no redirects, ever. Attach
      // before fail() destroys the socket/response; cleanup owns this sink too.
      response.on?.('error', ignoreError);
      fail(upstreamFailure(status, `http-${status}`, response.headers, INCOMPATIBLE_STATUSES.has(status)));
    };
    function ignoreError() {}
    function finishCleanup() {
      clearTimeout(cleanupTimer); cleanupTimer = undefined;
      socket.off('error', ignoreError); socket.off('close', finishCleanup);
      rejectedResponse?.off?.('error', ignoreError);
    }
    function destroy() {
      if (destroyed) return;
      destroyed = true; closed = true; clearDeadline(); notify();
      socket.off('open', onOpen); socket.off('message', onMessage); socket.off('error', onError);
      socket.off('close', onClose); socket.off('unexpected-response', onUnexpected);
      rejectedResponse?.destroy?.();
      queue.length = 0; bytes = 0;
      // ws emits an asynchronous error when terminate() aborts CONNECTING. Own
      // the temporary sink through close, with a bounded guard for broken mocks.
      if (socket.readyState !== 3) {
        socket.on('error', ignoreError); socket.once('close', finishCleanup);
        cleanupTimer = setTimeout(finishCleanup, 1000); cleanupTimer.unref?.();
        try { socket.terminate(); } catch { finishCleanup(); }
      } else finishCleanup();
      if (entry.connection === connection) { entry.connection = undefined; entry.last = undefined; }
    }
    const connection = {
      destroy, get alive() { return opened && !closed && !destroyed && !failure; },
      get queueBytes() { return bytes; },
      async *frames(payload, signal, state) {
        active = true; terminal = false;
        const onAbort = () => { fail(abortReason(signal)); destroy(); };
        signal.addEventListener('abort', onAbort, { once: true });
        try {
          if (signal.aborted) onAbort();
          while (!opened) {
            check(signal);
            if (failure) throw failure;
            if (closed) throw error('CODEX_WS_STREAM_TRUNCATED', 502, true);
            await new Promise(resolve => { wake = resolve; });
          }
          check(signal);
          if (failure) throw failure;
          deadline(idleTimeoutMs, 'CODEX_WS_IDLE_TIMEOUT');
          try {
            if (sends++ > 0) increment('connectionReuses');
            increment(payload.previous_response_id ? 'incrementalRequests' : 'fullRequests');
            socket.send(JSON.stringify(payload), sendError => { if (sendError) fail(error('CODEX_WS_SEND_FAILED', 502, true)); });
          }
          catch { fail(error('CODEX_WS_SEND_FAILED', 502, true)); }
          for (;;) {
            check(signal);
            if (failure) throw failure;
            if (queue.length) {
              const frame = queue.shift(); bytes -= frame.size;
              let event;
              try { event = JSON.parse(frame.text); } catch { throw error('CODEX_WS_INVALID_FRAME', 502, true); }
              if (!event || typeof event.type !== 'string') throw error('CODEX_WS_INVALID_FRAME', 502, true);
              if (ERROR_EVENTS.has(event.type)) {
                if (event.type === 'response.cancelled' || event.type === 'response.canceled') throw error('CODEX_WS_CANCELLED', 499);
                const detail = event.response?.error ?? event.error;
                const code = safeCode(detail?.code ?? event.code ?? detail?.type, 'CODEX_WS_UPSTREAM_ERROR');
                throw upstreamFailure(statusOf(event, code), code, event.headers);
              }
              if (event.type === 'response.completed' || event.type === 'response.done') {
                const response = event.response;
                if (!response || response.error || response.incomplete_details
                  || (response.status !== undefined && response.status !== 'completed')
                  || (event.type === 'response.done' && response.status !== 'completed')) throw error('CODEX_WS_INVALID_TERMINAL');
                state.completed = true;
                state.terminal = typeof response.id === 'string' && /^[\x21-\x7e]{1,512}$/.test(response.id) ? response.id : undefined;
                terminal = true; clearDeadline();
                yield frame.text;
                return;
              }
              yield frame.text;
              continue;
            }
            if (closed) throw error('CODEX_WS_STREAM_TRUNCATED', 502, true);
            await new Promise(resolve => { wake = resolve; });
          }
        } finally {
          active = false; clearDeadline(); signal.removeEventListener('abort', onAbort);
          if (!terminal || failure || closed || queue.length) destroy();
        }
      },
    };
    socket.on('open', onOpen); socket.on('message', onMessage); socket.on('error', onError);
    socket.on('close', onClose); socket.on('unexpected-response', onUnexpected);
    deadline(connectTimeoutMs, 'CODEX_WS_CONNECT_TIMEOUT');
    return connection;
  }

  function requestSnapshot(request) {
    const text = request?.init?.body;
    if (typeof text !== 'string' || Buffer.byteLength(text) > maxRequestBytes) throw error('CODEX_WS_REQUEST_LIMIT', 400);
    let body;
    try { body = JSON.parse(text); } catch { throw error('CODEX_WS_INVALID_REQUEST', 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.input) || body.input.length > 100_000) throw error('CODEX_WS_INVALID_REQUEST', 400);
    // Official v0.160.1 common.rs ResponseCreateWsRequest retains stream:true
    // (unlike generic API-key Responses WS). Keep the ordinary Codex body intact.
    body.stream = true; delete body.previous_response_id; delete body.type;
    body.client_metadata ??= {};
    const { input, client_metadata, ...properties } = body;
    const url = websocketUrl(request.url, allowInsecureLocalhost);
    const scope = request.context?.scope ?? null;
    const propertyKey = digest(canonical([url, scope, properties]));
    return { body, url, propertyKey, headers: handshakeHeaders(request.init.headers), bytes: Buffer.byteLength(text) };
  }
  function continuation(entry, snapshot) {
    const previous = entry.last;
    if (!previous || previous.propertyKey !== snapshot.propertyKey || snapshot.body.input.length < previous.baseline.length) return undefined;
    for (let index = 0; index < previous.baseline.length; index++) {
      if (previous.baseline[index] !== itemDigest(snapshot.body.input[index])) return undefined;
    }
    const delta = snapshot.body.input.slice(previous.baseline.length).map(item => {
      if (item?.type !== 'function_call_output' || !previous.callIds.has(item.call_id)) return item;
      return { ...item, call_id: previous.callIds.get(item.call_id) };
    });
    return { ...snapshot.body, input: delta, previous_response_id: previous.responseId };
  }
  function commit(entry, snapshot, responseId, getOutput, getCallIds, previousCallIds) {
    if (typeof getOutput !== 'function' || !responseId || !entry.connection?.alive || entry.key === undefined) return false;
    try {
      const output = getOutput();
      if (!Array.isArray(output) || output.length + snapshot.body.input.length > 100_000) return false;
      const text = JSON.stringify(output);
      if (snapshot.bytes + Buffer.byteLength(text) > maxStateBytes) return false;
      const copy = JSON.parse(text);
      const callIds = new Map(previousCallIds);
      const supplied = getCallIds?.();
      const pairs = supplied instanceof Map ? [...supplied] : supplied && typeof supplied === 'object' ? Object.entries(supplied) : [];
      const ownIds = new Map();
      for (const [normalized, raw] of pairs) {
        if (typeof normalized !== 'string' || !normalized || normalized.length > 512 || typeof raw !== 'string' || !raw || raw.length > 512) return false;
        if ((ownIds.has(normalized) && ownIds.get(normalized) !== raw) || (callIds.has(normalized) && callIds.get(normalized) !== raw)) return false;
        ownIds.set(normalized, raw); callIds.set(normalized, raw);
      }
      // The normalized builder may rewrite call_* to fc_*. Never use a server
      // response reference unless the mapper supplies the original wire IDs.
      for (const item of copy) if (item?.type === 'function_call' && !ownIds.has(item.call_id)) return false;
      if (callIds.size > 100_000 || new Set(callIds.values()).size !== callIds.size
        || snapshot.bytes + Buffer.byteLength(text) + Buffer.byteLength(JSON.stringify([...callIds])) > maxStateBytes) return false;
      entry.last = { responseId, propertyKey: snapshot.propertyKey, callIds,
        baseline: [...snapshot.body.input, ...copy].map(itemDigest) };
      return true;
    } catch { return false; } // Missing/unsafe sidecars disable reuse, not a valid answer.
  }

  async function* run(request, options, controller) {
    const { sessionKey, identityKey, mapResponse, getContinuationOutput, getContinuationCallIds, httpFallback, onDispatch } = options;
    const signal = controller.signal;
    const forwardAbort = () => controller.abort(abortReason(options.signal));
    options.signal?.addEventListener('abort', forwardAbort, { once: true });
    if (options.signal?.aborted) forwardAbort();
    let operation, entry, acquired = false, successful = false;
    try {
      check(signal);
      if (disposed) throw error('CODEX_WS_DISPOSED', 503);
      if (operations.size >= maxPendingRequests) throw error('CODEX_WS_CAPACITY', 503);
      if (typeof mapResponse !== 'function') throw error('CODEX_WS_MAPPER_REQUIRED', 400);
      const snapshot = requestSnapshot(request);
      entry = findEntry(sessionKey, identityKey);
      operation = { entry, controller }; operations.add(operation);
      await lock(entry, signal); acquired = true;
      check(signal);
      if (disposed || entry.removed) throw error('CODEX_WS_DISPOSED', 503);
      if (entry.identityKey !== identityKey) { reset(entry); entry.identityKey = identityKey; entry.http = false; }
      let publicOutput = false;
      if (!entry.http) {
        for (let attempt = 0; attempt < 2; attempt++) {
          check(signal);
          let frames;
          try {
            if (!entry.connection?.alive) reset(entry);
            const payload = attempt === 0 ? continuation(entry, snapshot) ?? snapshot.body : snapshot.body;
            const previousCallIds = payload.previous_response_id ? entry.last?.callIds : undefined;
            try { onDispatch?.(); } catch { /* Observer cannot affect inference. */ }
            check(signal);
            entry.connection ??= connect(entry, snapshot.url, snapshot.headers);
            const state = {};
            frames = entry.connection.frames({ ...payload, type: 'response.create' }, signal, state);
            let finish = false;
            for await (const chunk of mapResponse(frames)) {
              check(signal);
              if (finish) throw error('CODEX_WS_INVALID_MAPPED_FINISH');
              finish = chunk?.type === 'finish';
              publicOutput = true;
              yield chunk;
            }
            check(signal);
            if (!finish || !state.completed) throw error('CODEX_WS_MAPPED_STREAM_TRUNCATED');
            if (!state.terminal) {
              // A valid mapped completion with no response ID is usable by the
              // caller, but cannot become a continuation or a reusable socket.
              reset(entry); successful = true; increment('completedRequests'); return;
            }
            if (!commit(entry, snapshot, state.terminal, getContinuationOutput, getContinuationCallIds, previousCallIds)) reset(entry);
            successful = true; increment('completedRequests');
            return;
          } catch (failure) {
            reset(entry);
            check(signal);
            if (publicOutput || failure?.name === 'AbortError' || [400, 401, 403, 429, 499].includes(failure?.status) && !RETRY_CODES.has(failure?.code)) throw failure;
            if (attempt === 0 && RETRY_CODES.has(failure?.code) && ![401, 403, 429, 499].includes(failure?.status)) { increment('reconnectRetries'); continue; }
            if (failure?.codexWebSocketFallback === true && typeof httpFallback === 'function') { entry.http = true; increment('httpFallbacks'); break; }
            throw failure;
          } finally { await frames?.return?.(); }
        }
      }
      check(signal);
      if (typeof httpFallback !== 'function') throw error('CODEX_WS_HTTP_FALLBACK_UNAVAILABLE');
      for await (const chunk of httpFallback({ signal })) { check(signal); yield chunk; }
      check(signal); successful = true; increment('completedRequests');
    } finally {
      options.signal?.removeEventListener('abort', forwardAbort);
      if (entry && acquired) {
        if (!successful) reset(entry);
        unlock(entry);
      }
      if (operation) operations.delete(operation);
    }
  }
  function stream(request, options = {}) {
    const controller = new AbortController();
    const iterator = run(request, options, controller);
    // Async-generator return() normally waits behind an outstanding next().
    // Abort first so cancellation immediately wakes WS/queue/fallback waits.
    return {
      next: value => iterator.next(value),
      return: value => { controller.abort(error('CODEX_WS_CANCELLED', 499)); return iterator.return(value); },
      throw: reason => { controller.abort(reason ?? error('CODEX_WS_CANCELLED', 499)); return iterator.throw(reason); },
      [Symbol.asyncIterator]() { return this; },
    };
  }
  function invalidate(sessionKey) {
    const entry = sessions.get(sessionKey);
    if (entry) remove(entry, error('CODEX_WS_INVALIDATED', 499));
    schedulePrune();
  }
  function dispose() {
    if (disposed) return;
    disposed = true; clearTimeout(pruneTimer); pruneTimer = undefined;
    const reason = error('CODEX_WS_DISPOSED', 499);
    for (const operation of operations) operation.controller.abort(reason);
    for (const entry of [...entries]) remove(entry);
  }
  function snapshot() {
    prune(); schedulePrune();
    return Object.freeze({ ...counts, disposed, sessions: sessions.size, activeRequests: operations.size,
      queuedRequests: [...entries].reduce((total, entry) => total + entry.waiters.length, 0),
      openSockets: [...entries].filter(entry => entry.connection?.alive).length,
      continuationSessions: [...entries].filter(entry => entry.last).length,
      httpFallbackSessions: [...entries].filter(entry => entry.http).length,
      bufferedBytes: [...entries].reduce((total, entry) => total + (entry.connection?.queueBytes ?? 0), 0) });
  }
  return { stream, dispose, snapshot, invalidate };
}
