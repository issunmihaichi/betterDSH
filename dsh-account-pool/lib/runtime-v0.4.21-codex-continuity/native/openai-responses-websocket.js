/** Authenticated API-key Responses WebSocket, one connection per invocation. */
import WebSocket from 'ws';
import { openAIResponsesUrl } from './openai-responses.js';

const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
function transportError(code, status = 502) {
  return Object.assign(new Error(`OpenAI Responses WebSocket failed (${code})`), { code, status });
}
function boundedTimeout(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.min(value, 10 * 60 * 1000) : fallback;
}

/** Yields JSON server frames for the same parser used by HTTP SSE. */
export async function* openAIResponsesWebSocket(request, {
  signal,
  webSocketImpl = WebSocket,
  connectTimeoutMs = 10_000,
  idleTimeoutMs = 120_000,
  upstreamError,
} = {}) {
  signal?.throwIfAborted();
  const { stream, ...body } = JSON.parse(request.init.body);
  const url = openAIResponsesUrl(request.url, true);
  // The generic SDK uses Authorization for its Responses WS handshake. Do not
  // copy the Codex originator, ChatGPT account id or experimental beta headers.
  const socket = new webSocketImpl(url, {
    headers: { authorization: request.init.headers.authorization },
    followRedirects: false,
    handshakeTimeout: boundedTimeout(connectTimeoutMs, 10_000),
    maxPayload: MAX_BUFFER_BYTES,
  });
  const queue = [];
  let queueBytes = 0;
  let failure;
  let closed = false;
  let wake;
  let timer;
  let rejectedResponse;
  const notify = () => { const pending = wake; wake = undefined; pending?.(); };
  const fail = (error) => { failure ??= error; notify(); };
  const deadline = (ms, code) => {
    clearTimeout(timer);
    timer = setTimeout(() => fail(transportError(code, 504)), ms);
  };
  const onAbort = () => fail(signal.reason ?? Object.assign(new Error('Request aborted'), { name: 'AbortError' }));
  const onOpen = () => {
    if (failure) return;
    deadline(boundedTimeout(idleTimeoutMs, 120_000), 'RESPONSES_WS_IDLE_TIMEOUT');
    try {
      socket.send(JSON.stringify({ type: 'response.create', ...body }), (error) => {
        if (error) fail(transportError('RESPONSES_WS_SEND_FAILED'));
      });
    } catch { fail(transportError('RESPONSES_WS_SEND_FAILED')); }
  };
  const onMessage = (raw, isBinary) => {
    if (failure) return;
    deadline(boundedTimeout(idleTimeoutMs, 120_000), 'RESPONSES_WS_IDLE_TIMEOUT');
    if (isBinary) { fail(transportError('RESPONSES_WS_INVALID_FRAME')); return; }
    const text = raw.toString('utf8');
    const bytes = Buffer.byteLength(text);
    if (queueBytes + bytes > MAX_BUFFER_BYTES || queue.length >= 10_000) {
      fail(transportError('RESPONSES_WS_BUFFER_LIMIT')); return;
    }
    queue.push({ text, bytes }); queueBytes += bytes; notify();
  };
  const onError = (error) => fail(error?.message === 'Opening handshake has timed out'
    ? transportError('RESPONSES_WS_CONNECT_TIMEOUT', 504)
    : transportError('RESPONSES_WS_CONNECTION_FAILED'));
  const onClose = () => { closed = true; notify(); };
  const onUnexpectedResponse = (_request, response) => {
    rejectedResponse = response;
    const headers = new Headers();
    for (const [name, value] of Object.entries(response.headers ?? {})) {
      for (const part of Array.isArray(value) ? value : [value]) if (part !== undefined) headers.append(name, String(part));
    }
    fail(typeof upstreamError === 'function'
      ? upstreamError({ status: response.statusCode, headers }, response.statusMessage ?? '')
      : transportError(`http-${response.statusCode}`, response.statusCode));
    response.resume();
  };
  socket.on('open', onOpen);
  socket.on('message', onMessage);
  socket.on('error', onError);
  socket.on('close', onClose);
  socket.on('unexpected-response', onUnexpectedResponse);
  signal?.addEventListener('abort', onAbort, { once: true });
  deadline(boundedTimeout(connectTimeoutMs, 10_000), 'RESPONSES_WS_CONNECT_TIMEOUT');
  if (signal?.aborted) onAbort();
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('Request aborted'), { name: 'AbortError' });
      if (failure) throw failure;
      if (queue.length) {
        const event = queue.shift(); queueBytes -= event.bytes;
        yield event.text;
        continue;
      }
      if (closed) throw transportError('RESPONSES_WS_STREAM_TRUNCATED');
      await new Promise((resolve) => { wake = resolve; });
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    socket.off('open', onOpen);
    socket.off('message', onMessage);
    socket.off('error', onError);
    socket.off('close', onClose);
    socket.off('unexpected-response', onUnexpectedResponse);
    rejectedResponse?.destroy();
    queue.length = 0; queueBytes = 0; notify();
    // terminate avoids waiting for a peer's close handshake. CONNECTING sockets
    // emit an asynchronous error on termination; keep an owned sink until close.
    if (socket.readyState !== WebSocket.CLOSED) {
      const ignoreError = () => {};
      const onTerminated = () => { socket.off('error', ignoreError); };
      socket.on('error', ignoreError);
      socket.once('close', onTerminated);
      try { socket.terminate(); } catch { socket.off('error', ignoreError); socket.off('close', onTerminated); }
    }
  }
}
