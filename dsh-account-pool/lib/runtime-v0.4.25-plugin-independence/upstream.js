/**
 * Upstream transport: turn one account + one request into a chunk stream.
 *
 * This is the seam the adapter injects (`upstream.stream(account, options)`).
 * It owns Anthropic Messages, OpenAI Chat Completions, API-key Responses over
 * HTTP or authenticated WebSocket, Codex Responses and native Gemini / Code Assist
 * streams — no selection, cooldown or accounting. Failures are
 * thrown with `status` (and `providerRetryAfterMs` when the upstream says so),
 * which is exactly what `classifyFailure` reads.
 *
 * `fetch` is injected so the whole thing is testable against a fake Response
 * with a hand-written SSE body; no network and no DSH runtime are required.
 */
import { createHash, randomUUID } from 'node:crypto';
import { rememberDetectionText } from './detection.js';
import { OAUTH_ONLY_BETA, accountExtraBetas, applyClaudeCodeMode, isClaudeCodeModeEnabled } from './claude-code/index.js';
import { buildCodexRequest, mapCodex, getCodexContinuationOutput, getCodexContinuationCallIds, prepareCodexImages, snapshotCodexRequestProvenance, snapshotCodexSessionContext } from './native/codex.js';
import { createCodexWebSocketTransport } from './native/codex-websocket.js';
import { buildOpenAIResponsesRequest, mapOpenAIResponses } from './native/openai-responses.js';
import { openAIResponsesWebSocket } from './native/openai-responses-websocket.js';
export { buildOpenAIResponsesRequest, mapOpenAIResponses } from './native/openai-responses.js';
import { buildGeminiRequest, ensureGeminiProject, mapGemini } from './native/gemini.js';

/** Raised when an account has no usable secret. Not an account fault — never cooled. */
export class PoolCredentialError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PoolCredentialError';
    this.code = 'POOL_NO_CREDENTIAL';
  }
}

/** Raised for request content this transport cannot express on the wire yet. */
export class PoolUnsupportedContentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PoolUnsupportedContentError';
    this.code = 'POOL_UNSUPPORTED_CONTENT';
  }
}

const RETRY_AFTER_MAX_MS = 6 * 60 * 60 * 1000;

/**
 * Read `retry-after` (seconds or HTTP-date) into milliseconds.
 * Clamped: an upstream returning a nonsensical window must not park an account
 * for a week.
 */
export function retryAfterMs(headers) {
  const raw = headers?.get?.('retry-after');
  if (raw === null || raw === undefined || raw === '') return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_AFTER_MAX_MS);

  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.min(Math.max(0, date - Date.now()), RETRY_AFTER_MAX_MS);
  return undefined;
}

/** Build the error `classifyFailure` expects from a non-2xx upstream response. */
export function upstreamError(response, bodyText) {
  const status = response.status;
  const providerRetryAfterMs = retryAfterMs(response.headers);
  let detail = bodyText;
  try {
    const parsed = JSON.parse(bodyText);
    detail = parsed?.error?.message ?? parsed?.message ?? bodyText;
  } catch { /* not JSON: keep the raw text */ }

  const error = new Error(`upstream ${String(status)}: ${String(detail).slice(0, 500)}`);
  error.code = `http-${String(status)}`;
  error.status = status;
  if (providerRetryAfterMs !== undefined) error.providerRetryAfterMs = providerRetryAfterMs;
  return rememberDetectionText(error, typeof bodyText === 'string' ? bodyText : '');
}

/** Explicit SSE errors must not silently become a successful empty response. */
function sseUpstreamError(event, data) {
  const payload = event?.error;
  const detail = typeof payload === 'string' ? payload : payload?.message ?? event?.message ?? 'Upstream stream error';
  const error = new Error(`upstream stream: ${String(detail).slice(0, 500)}`);
  const type = payload?.type ?? payload?.code ?? event?.type;
  error.code = typeof type === 'string' ? type.slice(0, 100) : 'POOL_SSE_ERROR';
  const status = payload?.status ?? payload?.status_code ?? event?.status;
  const knownStatus = { rate_limit_error: 429, overloaded_error: 529, authentication_error: 401,
    permission_error: 403, invalid_request_error: 400 };
  if (Number.isInteger(status) && status >= 100 && status <= 599) error.status = status;
  else if (Object.hasOwn(knownStatus, type ?? '')) error.status = knownStatus[type];
  return rememberDetectionText(error, data);
}

/**
 * Decode an SSE body into its `data:` payloads.
 *
 * Handles CRLF, multi-line data fields, and a final event with no trailing blank
 * line (which some proxies emit on close).
 */
export async function* parseSse(body) {
  if (body === null || body === undefined) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let pendingCR = false;
  function normalize(text, final = false) {
    // CRLF may straddle reads. Preserve a trailing CR until its next byte,
    // then normalize both CRLF and lone CR according to the SSE line rules.
    const value = (pendingCR ? '\r' : '') + text;
    pendingCR = !final && value.endsWith('\r');
    return (pendingCR ? value.slice(0, -1) : value).replace(/\r\n|\r/g, '\n');
  }

  const drainComplete = function* drainComplete() {
    let at;
    while ((at = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const data = raw
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (data !== '') yield data;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done === true) break;
      buffer += normalize(decoder.decode(value, { stream: true }));
      yield* drainComplete();
    }
    buffer += normalize(decoder.decode(), true);
    yield* drainComplete();
    if (buffer.trim() !== '') {
      const data = buffer
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (data !== '') yield data;
    }
  } finally {
    // Cancel BEFORE releasing: `message_stop` is terminal (see `mapAnthropic`), so
    // a consumer may walk away while the upstream still holds the socket open —
    // measured on Anyrouter, which sends `message_stop` and then keeps the
    // connection for another ~35s. Releasing the lock alone would leave that
    // socket to the garbage collector, so every turn would leak one until then.
    try { await reader.cancel(); } catch { /* already closed, or a fake reader without cancel */ }
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

// --------------------------------------------------------------- content

const SKIPPED_BLOCK_TYPES = new Set(['tool-addition', 'tool-removal', 'reasoning']);

/** Flatten one message's content blocks into `{ text, toolCalls, toolResults }`. */
function dissect(content) {
  const text = [];
  const toolCalls = [];
  const toolResults = [];
  for (const block of Array.isArray(content) ? content : []) {
    const type = block?.type;
    if (type === 'text') { text.push(block.text ?? ''); continue; }
    if (type === 'tool-call') { toolCalls.push(block); continue; }
    if (SKIPPED_BLOCK_TYPES.has(type)) continue;
    throw new PoolUnsupportedContentError(`the pool transport cannot send a '${String(type)}' content block yet`);
  }
  return { text: text.join(''), toolCalls, toolResults };
}

function toolResultText(message) {
  const parts = [];
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    if (block?.type === 'text') parts.push(block.text ?? '');
    else if (block?.type === 'image' || block?.type === 'file') {
      throw new PoolUnsupportedContentError(`a '${block.type}' inside a tool result is not supported yet`);
    }
  }
  return parts.join('');
}

function parseToolArguments(raw) {
  if (typeof raw !== 'string' || raw === '') return {};
  try { return JSON.parse(raw); } catch { return { __raw: raw }; }
}

// --------------------------------------------------------------- request bodies

/**
 * The Messages endpoint as the official CLI calls it.
 *
 * The CLI always appends `?beta=true` — it is part of `claudeAPIURL` in the
 * reference implementation, and the relay path appends exactly the same query.
 * Leaving it off leaves the URL as the one thing on the wire that no Claude Code
 * client ever sends, which is a cheap and unnecessary difference.
 *
 * A base that already carries a query keeps working: the parameter is appended to
 * that query rather than starting a second one.
 */
export function anthropicMessagesUrl(baseUrl) {
  const raw = String(baseUrl ?? '');
  const queryAt = raw.indexOf('?');
  const path = (queryAt === -1 ? raw : raw.slice(0, queryAt)).replace(/\/+$/, '');
  const query = queryAt === -1 ? '' : raw.slice(queryAt + 1);
  return `${path}/v1/messages?${query === '' ? '' : `${query}&`}beta=true`;
}

/** Build an Anthropic Messages request. */
export function buildAnthropicRequest(account, options, credential, defaultMaxTokens) {
  const base = String(account.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  const messages = [];

  for (const message of options.messages ?? []) {
    if (message?.role === 'tool') {
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: [{ type: 'text', text: toolResultText(message) }],
          ...(message.isError === true ? { is_error: true } : {}),
        }],
      });
      continue;
    }
    if (message?.role === 'assistant') {
      const { text, toolCalls } = dissect(message.content);
      const content = [];
      if (text !== '') content.push({ type: 'text', text });
      for (const call of toolCalls) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: parseToolArguments(call.arguments) });
      }
      if (content.length > 0) messages.push({ role: 'assistant', content });
      continue;
    }
    const { text } = dissect(message?.content);
    if (text !== '') messages.push({ role: 'user', content: [{ type: 'text', text }] });
  }

  const body = {
    model: options.model,
    max_tokens: options.maxTokens ?? defaultMaxTokens,
    stream: true,
    messages,
  };
  if (options.system !== undefined && options.system !== '') body.system = options.system;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (Array.isArray(options.stop) && options.stop.length > 0) body.stop_sequences = options.stop;
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    body.tools = options.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }

  // The secret goes out in the header its OWN auth mode requires. These are two
  // different credential types, not two spellings of one: an Anthropic OAuth
  // (subscription) token is only valid as `Authorization: Bearer` and is the
  // reason `oauth-2025-04-20` exists as a beta, while an API key travels as
  // `x-api-key`. Sending an OAuth token as `x-api-key` is rejected — and was
  // exactly what this function did for every account before `authMode` existed.
  const oauth = account?.authMode === 'oauth';
  const headers = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'anthropic-version': '2023-06-01',
    ...(oauth
      ? { authorization: `Bearer ${credential}`, 'anthropic-beta': OAUTH_ONLY_BETA }
      : { 'x-api-key': credential }),
  };

  // Claude Code mode. ONE call: the mode is a module group that orchestrates its
  // own small modules (betas → identity → billing → system → metadata → defaults →
  // headers), so the transport does not need to know what the disguise consists of
  // or in what order it must be assembled. It is a no-op for every account that is
  // not in the mode, and it refuses a body it has already processed.
  applyClaudeCodeMode({ account, request: options, body, headers });

  // Without the disguise, `anthropic-beta` has no other owner, so an account's
  // declared tokens must be applied here or the field would silently work only
  // for accounts in Claude Code mode. In that mode the betas module already
  // merged exactly this list, and applying it twice would be a no-op at best and
  // a duplicate-token header at worst — so the branch is explicit.
  if (!isClaudeCodeModeEnabled(account)) {
    const extraBetas = accountExtraBetas(account);
    if (extraBetas.length > 0) headers['anthropic-beta'] = extraBetas.join(',');
  }

  return {
    url: anthropicMessagesUrl(base),
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
  };
}

/** Build an OpenAI Chat Completions request (also used for OpenAI-compatible `custom`). */
export function buildOpenAIRequest(account, options, credential, defaultMaxTokens) {
  const base = String(account.baseUrl ?? 'https://api.openai.com').replace(/\/+$/, '');
  const messages = [];

  if (options.system !== undefined && options.system !== '') {
    messages.push({ role: 'system', content: options.system });
  }

  for (const message of options.messages ?? []) {
    if (message?.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: message.toolCallId, content: toolResultText(message) });
      continue;
    }
    if (message?.role === 'assistant') {
      const { text, toolCalls } = dissect(message.content);
      const entry = { role: 'assistant', content: text === '' ? null : text };
      if (toolCalls.length > 0) {
        entry.tool_calls = toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments ?? '{}' },
        }));
      }
      messages.push(entry);
      continue;
    }
    const { text } = dissect(message?.content);
    if (text !== '') messages.push({ role: 'user', content: text });
  }

  const body = {
    model: options.model,
    messages,
    stream: true,
    // Without this OpenAI omits the trailing usage chunk entirely.
    stream_options: { include_usage: true },
  };
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
  else body.max_tokens = defaultMaxTokens;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  // The one dialect where a thinking level IS a wire field. `off` is omitted rather
  // than sent, matching how the pi-ai provider reads it (naming no effort and asking
  // for `off` are the same request), so a relay that accepts the field never
  // receives a level it would have to invent semantics for.
  if (typeof options.reasoningEffort === 'string' && options.reasoningEffort !== '' && options.reasoningEffort !== 'off') {
    body.reasoning_effort = options.reasoningEffort;
  }
  if (Array.isArray(options.stop) && options.stop.length > 0) body.stop = options.stop;
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    body.tools = options.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }

  return {
    url: `${base}/v1/chat/completions`,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${credential}`,
      },
      body: JSON.stringify(body),
    },
  };
}

// --------------------------------------------------------------- response mappers

const ANTHROPIC_STOP = { end_turn: 'stop', stop_sequence: 'stop', tool_use: 'tool-calls', max_tokens: 'max-tokens' };
const OPENAI_STOP = { stop: 'stop', tool_calls: 'tool-calls', function_call: 'tool-calls', length: 'max-tokens' };

/**
 * Map Anthropic Messages SSE events onto StreamChunks.
 *
 * Blocks are accumulated so `block-end` carries a REAL block rather than a
 * placeholder — a consumer that trusts `block-end` must not receive `{}`.
 */
export async function* mapAnthropic(events) {
  const blocks = new Map();
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let stopReason;
  let stopped = false;

  for await (const data of events) {
    if (data === '[DONE]') break;
    let event;
    try { event = JSON.parse(data); } catch { continue; }
    if (event?.type === 'error' || (event?.error !== undefined && event?.error !== null)) {
      throw sseUpstreamError(event, data);
    }

    switch (event.type) {
      case 'message_start': {
        const reported = event.message?.usage ?? {};
        usage.inputTokens += reported.input_tokens ?? 0;
        usage.cacheReadTokens += reported.cache_read_input_tokens ?? 0;
        usage.cacheWriteTokens += reported.cache_creation_input_tokens ?? 0;
        break;
      }
      case 'content_block_start': {
        const index = event.index ?? blocks.size;
        const block = event.content_block ?? {};
        if (block.type === 'tool_use') {
          blocks.set(index, { type: 'tool-call', id: block.id, name: block.name, arguments: '' });
          yield { type: 'block-start', index, blockType: 'tool-call' };
        } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          blocks.set(index, { type: 'reasoning', text: '' });
          yield { type: 'block-start', index, blockType: 'reasoning' };
        } else {
          blocks.set(index, { type: 'text', text: block.text ?? '' });
          yield { type: 'block-start', index, blockType: 'text' };
        }
        break;
      }
      case 'content_block_delta': {
        const index = event.index ?? 0;
        const delta = event.delta ?? {};
        const block = blocks.get(index);
        if (delta.type === 'text_delta') {
          if (block?.type === 'text') block.text += delta.text ?? '';
          yield { type: 'text-delta', index, text: delta.text ?? '' };
        } else if (delta.type === 'thinking_delta') {
          if (block?.type === 'reasoning') block.text += delta.thinking ?? '';
          yield { type: 'reasoning-delta', index, text: delta.thinking ?? '' };
        } else if (delta.type === 'input_json_delta') {
          if (block?.type === 'tool-call') block.arguments += delta.partial_json ?? '';
          yield { type: 'tool-call-delta', index, id: block?.id, argumentsDelta: delta.partial_json ?? '' };
        }
        break;
      }
      case 'content_block_stop': {
        const index = event.index ?? 0;
        const block = blocks.get(index);
        if (block !== undefined) yield { type: 'block-end', index, block };
        break;
      }
      case 'message_delta': {
        usage.outputTokens += event.usage?.output_tokens ?? 0;
        if (event.delta?.stop_reason !== undefined && event.delta.stop_reason !== null) stopReason = event.delta.stop_reason;
        break;
      }
      case 'message_stop': {
        // Terminal per the Messages spec, and the ONLY reliable one: the socket
        // close is not. Anyrouter sends `message_stop` and then holds the
        // connection open for another ~35s, so waiting for that close would add
        // that delay to every single turn — the text would already be on screen
        // while the agent loop still waited for permission to continue.
        // `usage` and `stop_reason` arrive in the `message_delta` BEFORE this
        // event, so nothing is lost by stopping here.
        stopped = true;
        break;
      }
      default:
        break;
    }

    if (stopped) break;
  }

  if (!stopped) {
    if (Object.values(usage).some(value => value > 0)) yield { type: 'usage', usage };
    throw Object.assign(new Error('Anthropic stream ended before message_stop.'), { code: 'TRANSPORT' });
  }
  yield { type: 'usage', usage };
  yield { type: 'finish', reason: { kind: ANTHROPIC_STOP[stopReason] ?? 'stop' } };
}

/** Map OpenAI Chat Completions SSE events onto StreamChunks. */
export async function* mapOpenAI(events) {
  const toolCalls = new Map();
  let text = '';
  let textStarted = false;
  let reportedUsage;
  let finishReason;

  for await (const data of events) {
    if (data === '[DONE]') break;
    let event;
    try { event = JSON.parse(data); } catch { continue; }
    if (event?.type === 'error' || (event?.error !== undefined && event?.error !== null)) {
      throw sseUpstreamError(event, data);
    }

    if (event.usage !== undefined && event.usage !== null) reportedUsage = event.usage;
    const choice = event.choices?.[0];
    if (choice === undefined) continue;
    const delta = choice.delta ?? {};

    if (typeof delta.content === 'string' && delta.content !== '') {
      if (!textStarted) {
        textStarted = true;
        yield { type: 'block-start', index: 0, blockType: 'text' };
      }
      text += delta.content;
      yield { type: 'text-delta', index: 0, text: delta.content };
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        // Offset past the text block so indices never collide.
        const index = (call.index ?? 0) + 1;
        let entry = toolCalls.get(index);
        if (entry === undefined) {
          entry = { id: call.id, name: call.function?.name ?? '', arguments: '' };
          toolCalls.set(index, entry);
          yield { type: 'block-start', index, blockType: 'tool-call' };
        }
        if (call.id !== undefined) entry.id = call.id;
        if (call.function?.name !== undefined) entry.name = call.function.name;
        if (call.function?.arguments !== undefined) {
          entry.arguments += call.function.arguments;
          yield { type: 'tool-call-delta', index, id: entry.id, argumentsDelta: call.function.arguments };
        }
      }
    }

    if (choice.finish_reason !== undefined && choice.finish_reason !== null) finishReason = choice.finish_reason;
  }

  if (textStarted) yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  for (const [index, entry] of toolCalls) {
    yield { type: 'block-end', index, block: { type: 'tool-call', id: entry.id, name: entry.name, arguments: entry.arguments } };
  }

  if (reportedUsage !== undefined) {
    // OpenAI's prompt total includes cache hits; DSH expects disjoint input buckets.
    const cacheReadTokens = reportedUsage.prompt_tokens_details?.cached_tokens ?? 0;
    yield {
      type: 'usage',
      usage: {
        inputTokens: Math.max(0, (reportedUsage.prompt_tokens ?? 0) - cacheReadTokens),
        outputTokens: reportedUsage.completion_tokens ?? 0,
        cacheReadTokens,
      },
    };
  }

  yield { type: 'finish', reason: { kind: OPENAI_STOP[finishReason] ?? (toolCalls.size > 0 ? 'tool-calls' : 'stop') } };
}

// --------------------------------------------------------------- transport

/**
 * Build the transport the adapter injects.
 *
 * @param options.fetchImpl - `fetch`-compatible implementation (injected; global fetch is the default).
 * @param options.resolveCredential - `(account) => string | bundle | undefined`; refreshed secret and OAuth metadata.
 * @param options.defaultMaxTokens - used when the request omits `maxTokens`.
 * @param options.signal - optional extra abort signal.
 * @returns `{ stream(account, options) }`.
 */
export function createHttpUpstream({
  fetchImpl = globalThis.fetch,
  resolveCredential = (account) => (typeof account?.credentialRef === 'string' ? account.credentialRef : undefined),
  defaultMaxTokens = 4096,
  signal,
  resolveAttachments,
  resolveCodexSession,
  // Trusted Host dependencies, never accepted from per-call/model options.
  codexReplayCodec,
  resolveCodexReplayCodec,
  // Synchronous, trusted local observer; receives bounded labels, never request/credentials.
  onCodexRequest,
  webSocketImpl,
  webSocketConnectTimeoutMs = 10_000,
  webSocketIdleTimeoutMs = 120_000,
  codexWebSocketSessionIdleMs = 300_000,
  codexWebSocketMaxSessions = 32,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('createHttpUpstream: `fetchImpl` is required');
  const codexWebSocket = createCodexWebSocketTransport({
    webSocketImpl, connectTimeoutMs: webSocketConnectTimeoutMs, idleTimeoutMs: webSocketIdleTimeoutMs,
    sessionIdleMs: codexWebSocketSessionIdleMs, maxSessions: codexWebSocketMaxSessions, upstreamError,
  });
  const identityHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

  // Retry/detection/failover reuse options. Snapshot provenance before async
  // credential/image I/O and retain one fallback turn identity for all attempts.
  // Weak keys do not retain finished sessions or their prompts.
  const codexContexts = new WeakMap();
  async function* stream(account, options = {}) {
    const requestSignal = options.signal ?? signal;
    let codexContext;
    if (account.platform === 'openai' && account.authMode === 'oauth') {
      codexContext = codexContexts.get(options);
      if (!codexContext) {
        const purpose = options.purpose;
        const sessionId = options.sessionId;
        const review = snapshotCodexRequestProvenance(options.codexRequestProvenance, { purpose, sessionId });
        const turnId = options.codexTurnId;
        codexContext = Object.freeze({
          // Only overlay the existing session, never the sidecar owner. The
          // adapter's original options/sessionId still owns sticky selection.
          sessionId: typeof sessionId === 'string' ? sessionId : undefined,
          purpose: typeof purpose === 'string' ? purpose : undefined,
          codexTurnId: typeof turnId === 'string' && turnId.trim() !== '' ? turnId : randomUUID(),
          codexRequestProvenance: review,
          codexSessionContext: snapshotCodexSessionContext(resolveCodexSession
            ? resolveCodexSession(sessionId ?? review?.ownerSessionId) : options.codexSessionContext),
        });
        codexContexts.set(options, codexContext);
      }
    }
    requestSignal?.throwIfAborted();
    // MUST be awaited: the host resolves through the credentials service, which is
    // async. Treating that promise as a value made `typeof credential !== 'string'`
    // always true, so a fully configured account was reported as having no
    // credential and the pool could never authenticate a single request.
    const resolved = await resolveCredential(account);
    requestSignal?.throwIfAborted();
    const bundle = resolved !== null && typeof resolved === 'object' ? resolved : undefined;
    const credential = typeof resolved === 'string' ? resolved
      : bundle?.access_token ?? bundle?.accessToken ?? bundle?.api_key ?? bundle?.apiKey ?? bundle?.key ?? bundle?.token;
    if (typeof credential !== 'string' || credential.trim() === '') {
      throw new PoolCredentialError(`account '${String(account?.id)}' has no usable credential`);
    }

    const anthropic = account.platform === 'anthropic';
    const codex = account.platform === 'openai' && account.authMode === 'oauth';
    const gemini = account.platform === 'gemini';
    const responses = !anthropic && !codex && !gemini && account.openaiApi === 'responses';
    const websocket = account.openaiTransport === 'websocket';
    if (websocket && !responses && !codex) {
      throw new PoolUnsupportedContentError('WebSocket transport requires OpenAI Responses or Codex OAuth');
    }
    let request;
    const nativeCredential = bundle ? { ...bundle, access_token: credential } : credential;
    if (codex) {
      const replayCodec = codexReplayCodec ?? await resolveCodexReplayCodec?.();
      requestSignal?.throwIfAborted();
      request = buildCodexRequest(account, await prepareCodexImages({ ...options, ...codexContext, signal: requestSignal }, resolveAttachments), nativeCredential, { replayCodec });
    } else if (gemini) {
      let contextBundle = bundle ? { ...bundle, access_token: credential } : (account.authMode === 'oauth' ? { access_token: credential } : { api_key: credential });
      if (account.authMode === 'oauth' && !account.projectId && !contextBundle.project_id && !contextBundle.projectId) {
        const project = await ensureGeminiProject(contextBundle, { fetchImpl, signal: options.signal ?? signal, accountId: account.id });
        if (!project.projectId) {
          const error = new Error('Gemini Code Assist requires a project. Configure its project ID or complete setup in Gemini CLI.');
          error.code = 'POOL_GEMINI_PROJECT_REQUIRED';
          throw error;
        }
        contextBundle = { ...contextBundle, project_id: project.projectId };
      }
      request = buildGeminiRequest(account, { ...options, maxTokens: options.maxTokens ?? defaultMaxTokens }, contextBundle);
    } else if (responses) request = buildOpenAIResponsesRequest(account, options, credential, defaultMaxTokens);
    else request = anthropic
      ? buildAnthropicRequest(account, options, credential, defaultMaxTokens)
      : buildOpenAIRequest(account, options, credential, defaultMaxTokens);

    if (websocket && !codex) {
      yield* mapOpenAIResponses(openAIResponsesWebSocket(request, {
        signal: requestSignal,
        webSocketImpl,
        connectTimeoutMs: webSocketConnectTimeoutMs,
        idleTimeoutMs: webSocketIdleTimeoutMs,
        upstreamError,
      }), request.context);
      return;
    }

    requestSignal?.throwIfAborted();
    const onDispatch = () => {
      if (codex && typeof onCodexRequest === 'function') {
        // Fixed-label diagnostics cannot change wire identity or cause a retry.
        try { onCodexRequest(request.context.attribution); } catch {}
      }
    };
    async function* http({ signal: httpSignal = requestSignal } = {}) {
      httpSignal?.throwIfAborted();
      onDispatch();
      const response = await fetchImpl(request.url, { ...request.init, signal: httpSignal });
      if (!response.ok) {
        const text = typeof response.text === 'function' ? await response.text().catch(() => '') : '';
        throw upstreamError(response, text);
      }
      if (response.body === null || response.body === undefined) {
        const error = new Error('upstream returned no response body for a streaming request');
        error.code = 'POOL_EMPTY_BODY';
        throw error;
      }
      if (codex) yield* mapCodex(response.body, parseSse, request.context);
      else if (responses) yield* mapOpenAIResponses(parseSse(response.body), request.context);
      else if (gemini) yield* mapGemini(response.body, parseSse, request.context);
      else yield* (anthropic ? mapAnthropic(parseSse(response.body)) : mapOpenAI(parseSse(response.body)));
    }
    if (codex && websocket) {
      // Session key deliberately excludes account: changing credentials/account in
      // this logical session must invalidate the old resident WS, not park it for reuse.
      const sessionKey = request.context.scope && codexContext.sessionId
        ? identityHash(['codex-ws-session-v1', codexContext.sessionId]) : undefined;
      // Refresh must reconnect even when durable replay can survive JWT rotation.
      const identityKey = identityHash(['codex-ws-identity-v1', request.context.scope ?? null,
        account.id, account.createdAt, account.credentialRef, request.url, options.model,
        request.init.headers.authorization, request.init.headers['chatgpt-account-id']]);
      yield* codexWebSocket.stream(request, {
        signal: requestSignal, sessionKey, identityKey, onDispatch,
        mapResponse: frames => mapCodex(frames, value => value, request.context),
        getContinuationOutput: () => getCodexContinuationOutput(request.context),
        getContinuationCallIds: () => getCodexContinuationCallIds(request.context),
        httpFallback: http,
      });
    } else {
      if (codex && request.context.scope && codexContext.sessionId) {
        codexWebSocket.invalidate(identityHash(['codex-ws-session-v1', codexContext.sessionId]));
      }
      yield* http();
    }
  }

  return { stream, dispose: () => codexWebSocket.dispose(), codexWebSocketSnapshot: () => codexWebSocket.snapshot() };
}
