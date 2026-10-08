/**
 * ChatGPT Codex OAuth Responses transport (text, user images and function tools).
 * No upstream import: the caller supplies its SSE parser to mapCodex.
 * Wire facts follow sub2api's openai_codex_transform.go,
 * openai_gateway_forward.go and openai_chatgpt_headers.go.
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { uuidFromSeed } from '../claude-code/hash.js';

const ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
// Keep the outbound Codex identity above the model catalog's minimum versions.
// gpt-6.1-sol requires at least 0.153.0; the official stable release is 0.160.1.
const CLIENT_VERSION = '0.160.1';
const SKIPPED = new Set(['tool-addition', 'tool-removal', 'reasoning']);
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const CONTINUATION_LIMIT = 512;
const CONTINUATION_BYTES = 2 * 1024 * 1024;
const CONTINUATION_TTL_MS = 60 * 60 * 1000;
const continuations = new Map();
let continuationBytes = 0;

function fingerprint(value) { return createHash('sha256').update(value).digest('hex'); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function argumentText(value) { return typeof value === 'string' ? value : JSON.stringify(value ?? {}); }
function toolNames(names) {
  const originalToWire = new Map();
  const wireToOriginal = new Map();
  const unique = [...new Set(names)];
  for (const name of unique) {
    if (typeof name !== 'string' || name.trim() === '') throw localError('Codex function tools and calls require a name');
    if (name.trim().toLowerCase() !== 'python') {
      originalToWire.set(name, name);
      wireToOriginal.set(name, name);
    }
  }
  // Codex owns python case-insensitively. Reserve all caller names before
  // allocating aliases so a caller's python__pool still denotes its own tool.
  for (const name of unique.filter((value) => value.trim().toLowerCase() === 'python').sort()) {
    let alias = 'python__pool';
    let suffix = 0;
    while (wireToOriginal.has(alias)) alias = `python__pool_${++suffix}`;
    originalToWire.set(name, alias);
    wireToOriginal.set(alias, name);
  }
  return { originalToWire, wireToOriginal };
}
function continuationGet(id, scope) {
  if (!scope) return undefined;
  const key = `${scope}:${id}`;
  const prior = continuations.get(key);
  if (!prior) return undefined;
  if (prior.expiresAt <= Date.now()) {
    continuations.delete(key); continuationBytes -= prior.bytes; return undefined;
  }
  continuations.delete(key); continuations.set(key, prior);
  return prior;
}
function continuationPut(id, scope, value) {
  if (!scope) return;
  const key = `${scope}:${id}`;
  const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value));
  const previous = continuations.get(key);
  if (previous) { continuations.delete(key); continuationBytes -= previous.bytes; }
  if (bytes > CONTINUATION_BYTES / 4) return;
  const now = Date.now();
  continuations.set(key, { ...clone(value), bytes, expiresAt: now + CONTINUATION_TTL_MS });
  continuationBytes += bytes;
  for (const [oldKey, entry] of continuations) {
    if (entry.expiresAt > now && continuations.size <= CONTINUATION_LIMIT && continuationBytes <= CONTINUATION_BYTES) continue;
    continuations.delete(oldKey); continuationBytes -= entry.bytes;
  }
}

function localError(message, code = 'POOL_UNSUPPORTED_CONTENT') {
  const error = new Error(message);
  error.name = ['POOL_NO_CREDENTIAL', 'POOL_CODEX_ACCOUNT_REQUIRED'].includes(code) ? 'PoolCredentialError' : 'PoolUnsupportedContentError';
  error.code = code;
  return error;
}

function jwtAccountId(token) {
  if (typeof token !== 'string') return undefined;
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return claims?.['https://api.openai.com/auth']?.chatgpt_account_id;
  } catch { return undefined; }
}

function headerValue(value) {
  return typeof value === 'string' && value.trim() !== '' && !/[\x00-\x20\x7f]/.test(value);
}

function codexUrl(account) {
  if (account?.baseUrl == null || account.baseUrl === '') return ENDPOINT;
  // A nonempty baseUrl is administrator configuration, never a request option.
  // Reject ambiguous API dialects and redirects rather than send OAuth elsewhere.
  let url;
  try { url = new URL(account.baseUrl); } catch { throw localError('Codex baseUrl must be an absolute HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw localError('Codex baseUrl requires HTTPS without userinfo, query or fragment');
  }
  const path = url.pathname.replace(/\/+$/, '');
  const suffix = {
    '': '/backend-api/codex/responses',
    '/backend-api': '/backend-api/codex/responses',
    '/backend-api/codex': '/backend-api/codex/responses',
    '/backend-api/codex/responses': '/backend-api/codex/responses',
  }[path];
  if (suffix === undefined) throw localError('Codex baseUrl has an unsupported endpoint suffix');
  url.pathname = suffix;
  return url.href;
}

function callId(id) {
  if (typeof id !== 'string' || id.trim() === '') throw localError('Codex function calls and results require a call id');
  // The same deterministic rewrite applies to calls AND results in history.
  const candidate = id.startsWith('fc_') ? id : `fc_${id.replace(/^call_/, '')}`;
  return candidate.length <= 64 ? candidate : `fc_${createHash('sha256').update(candidate).digest('hex').slice(0, 61)}`;
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function imagePart(block) {
  if (!IMAGE_TYPES.has(block.mediaType) || typeof block.data !== 'string'
    || block.data.length === 0 || block.data.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(block.data)) {
    throw localError('Codex images require PNG, JPEG, WebP or GIF mediaType and base64 data');
  }
  return { type: 'input_image', image_url: `data:${block.mediaType};base64,${block.data}`, detail: 'auto' };
}

/** Resolve DSH durable image references per request; never read caller-supplied paths. */
export async function prepareCodexImages(options, resolveAttachments) {
  const versions = new Map();
  const messages = [];
  for (const message of options.messages ?? []) {
    if (!Array.isArray(message?.content)) { messages.push(message); continue; }
    const content = [];
    for (const block of message.content) {
      options.signal?.throwIfAborted();
      if (block?.type !== 'image') { content.push(block); continue; }
      if (message.role !== 'user') throw localError('Codex images are supported only in user messages');
      if (!block.attachment) { imagePart(block); content.push(block); continue; }
      const ref = block.attachment;
      if (block.offloaded === true) {
        content.push({ type: 'text', text: `[image omitted to fit request image limits; ${String(ref.attachmentId)}. Ask the user to attach it again if needed.]` });
        continue;
      }
      if (typeof ref.attachmentId !== 'string' || !Number.isSafeInteger(ref.width) || ref.width <= 0
        || !Number.isSafeInteger(ref.height) || ref.height <= 0) throw localError('Codex image attachment reference is invalid');
      let version = versions.get(ref.attachmentId);
      if (!version) {
        const attachments = resolveAttachments?.();
        if (typeof attachments?.readImageRequest !== 'function') throw localError('Codex image input requires the durable attachment service');
        const scale = Math.min(1, Math.sqrt(4_194_304 / (ref.width * ref.height)));
        version = await attachments.readImageRequest(ref, {
          width: Math.max(1, Math.floor(ref.width * scale)), height: Math.max(1, Math.floor(ref.height * scale)), maxBytes: 1_048_576,
        }, options.signal);
        options.signal?.throwIfAborted();
        if (!(version?.data instanceof Uint8Array) || version.data.byteLength === 0) throw localError('Codex attachment service returned an invalid image');
        versions.set(ref.attachmentId, version);
      }
      const image = { type: 'image', mediaType: version.mediaType, data: Buffer.from(version.data).toString('base64') };
      imagePart(image);
      content.push({ type: 'text', text: `Image ${ref.name === undefined ? '' : `${JSON.stringify(ref.name)} `}${ref.attachmentId}; request preview ${version.width}x${version.height}px. It may be resized or re-encoded.` }, image);
    }
    messages.push({ ...message, content });
  }
  return { ...options, messages };
}

function contentParts(content, allowCalls = false, allowImages = false) {
  const parts = [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (content == null) return parts;
  if (!Array.isArray(content)) throw localError('Codex message content must be text or content blocks');
  for (const block of content) {
    if (block?.type === 'text') {
      if (typeof block.text !== 'string') throw localError('Codex text blocks require a string');
      parts.push(block);
    } else if (allowCalls && block?.type === 'tool-call') {
      parts.push(block);
    } else if (allowImages && block?.type === 'image') {
      imagePart(block);
      parts.push(block);
    } else if (!SKIPPED.has(block?.type)) {
      throw localError('Codex supports text, user images and assistant function calls');
    }
  }
  return parts;
}

/**
 * Build a request using the existing upstream request options; no network I/O.
 * Returns {url, init, context}; pass context as mapCodex's optional third argument
 * to reverse reserved tool aliases and preserve private encrypted reasoning
 * during stateless tool continuations. Name maps belong to this request only.
 * credentialBundle: { access_token, chatgpt_account_id?, id_token? } OR a plain
 * access-token string. An explicit account.chatgptAccountId overrides the bundle,
 * then id/access JWT claims and account.oauth.accountId provide fallbacks. Opaque
 * string tokens require one of those explicit account-id fields. No token is logged.
 * account.baseUrl: optional administrator-configured HTTPS origin or one of
 * /backend-api, /backend-api/codex, /backend-api/codex/responses. Request options
 * cannot change the destination. Redirects are disabled to retain token control.
 * maxTokens/temperature/stop are omitted: this OAuth endpoint rejects them.
 */
export function buildCodexRequest(account, options = {}, credentialBundle) {
  const bundle = typeof credentialBundle === 'string' ? { access_token: credentialBundle } : credentialBundle;
  const token = bundle?.access_token;
  const accountId = account?.chatgptAccountId
    ?? bundle?.chatgpt_account_id
    ?? bundle?.chatgptAccountId
    ?? bundle?.account_id
    ?? bundle?.accountId
    ?? jwtAccountId(bundle?.id_token)
    ?? jwtAccountId(token)
    ?? account?.oauth?.accountId;
  if (!headerValue(token)) throw localError('Codex requires a usable OAuth access token', 'POOL_NO_CREDENTIAL');
  if (!headerValue(accountId)) throw localError('Codex requires a ChatGPT account id in the OAuth bundle or token claims', 'POOL_CODEX_ACCOUNT_REQUIRED');
  const url = codexUrl(account);
  // Keep cache affinity stable across turns and OAuth access-token refreshes.
  const cacheKey = typeof options.sessionId === 'string' && options.sessionId.trim() !== ''
    ? uuidFromSeed(JSON.stringify(['dsh-account-pool:codex-cache:v1', account?.id ?? null, accountId, url, options.sessionId]))
    : undefined;
  if (typeof options.model !== 'string' || options.model.trim() === '') throw localError('Codex requires a model');
  if (options.system !== undefined && typeof options.system !== 'string') throw localError('Codex system instructions must be text');
  if (options.messages !== undefined && !Array.isArray(options.messages)) throw localError('Codex messages must be an array');
  if (options.tools !== undefined && !Array.isArray(options.tools)) throw localError('Codex tools must be an array');
  const names = (options.tools ?? []).map((tool) => tool?.name);
  for (const message of options.messages ?? []) {
    if (message?.role !== 'assistant') continue;
    for (const part of contentParts(message.content, true)) if (part.type === 'tool-call') names.push(part.name);
  }
  const instructions = options.system ? [options.system] : [];
  const context = { scope: fingerprint(JSON.stringify([account?.id ?? null, accountId, fingerprint(token), url, options.model.trim()])), ...toolNames(names) };
  const input = [];
  const restoredReasoning = new Set();
  for (const message of options.messages ?? []) {
    const role = message?.role;
    if (role === 'tool') {
      input.push({ type: 'function_call_output', call_id: callId(message.toolCallId), output: contentParts(message.content).map((part) => part.text).join('') });
      continue;
    }
    if (!['user', 'assistant', 'system', 'developer'].includes(role)) throw localError('Codex received an unsupported message role');
    const parts = contentParts(message.content, role === 'assistant', role === 'user');
    if (role === 'system' || role === 'developer') {
      const text = parts.map((part) => part.text).join('');
      if (text !== '') instructions.push(text);
      continue;
    }
    // Keep user text/images in one ordered message, and split at assistant calls.
    let content = [];
    const flushText = () => {
      if (content.length) input.push({ type: 'message', role, content });
      content = [];
    };
    for (const part of parts) {
      if (part.type === 'text') {
        if (part.text !== '') {
          const previous = content.at(-1);
          if (previous?.type === 'input_text' || previous?.type === 'output_text') previous.text += part.text;
          else content.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text });
        }
        continue;
      }
      if (part.type === 'image') { content.push(imagePart(part)); continue; }
      flushText();
      if (typeof part.name !== 'string' || part.name.trim() === '') throw localError('Codex function calls require a name');
      const args = argumentText(part.arguments);
      const cached = continuationGet(part.id, context.scope);
      if (cached?.name === part.name && cached.arguments === args) {
        for (const reasoning of cached.reasoning) {
          const key = fingerprint(JSON.stringify(reasoning));
          if (restoredReasoning.has(key)) continue;
          restoredReasoning.add(key);
          input.push(clone(reasoning));
        }
      }
      input.push({ type: 'function_call', call_id: callId(part.id), name: context.originalToWire.get(part.name), arguments: args });
    }
    flushText();
  }
  const body = {
    model: options.model.trim(),
    store: false,
    stream: true,
    instructions: instructions.join('\n\n') || 'You are a helpful coding assistant.',
    input,
    include: ['reasoning.encrypted_content'],
    ...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
  };
  const effort = options.reasoningEffort;
  if (effort !== undefined && effort !== '' && effort !== 'off') {
    if (!EFFORTS.has(effort)) throw localError('Codex received an unsupported reasoning effort');
    body.reasoning = { effort };
  }
  if (options.tools?.length) {
    body.tools = options.tools.map((tool) => ({
      type: 'function', name: context.originalToWire.get(tool.name), description: tool.description,
      parameters: tool.parameters ?? { type: 'object', properties: {} }, strict: false,
    }));
    body.tool_choice = 'auto';
    body.parallel_tool_calls = true;
  }
  return {
    url,
    init: {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${token}`,
        'chatgpt-account-id': accountId,
        'openai-beta': 'responses=experimental',
        originator: 'codex_cli_rs',
        'user-agent': `codex_cli_rs/${CLIENT_VERSION}`,
        version: CLIENT_VERSION,
        ...(cacheKey ? { session_id: cacheKey } : {}),
      },
      body: JSON.stringify(body),
    },
    context,
  };
}

function streamError(kind, event = {}) {
  const response = event.response;
  const detail = response?.error ?? event.error ?? {};
  const reason = response?.incomplete_details?.reason;
  const rawCode = detail.code ?? event.code ?? reason ?? detail.type;
  // Preserve machine-readable code/status, never copy an upstream message: it
  // may echo Authorization, account ids, or request content into management logs.
  const code = typeof rawCode === 'string' && /^[a-zA-Z][a-zA-Z0-9_.:-]{0,79}$/.test(rawCode) ? rawCode : kind;
  const error = new Error(`Codex stream failed (${kind})`);
  error.name = 'CodexStreamError';
  error.code = code;
  const explicit = [detail.status, detail.status_code, response?.status_code, event.status, event.status_code]
    .map(Number).find((status) => Number.isInteger(status) && status >= 400 && status <= 599);
  const inferred = /rate_limit|usage_limit|quota_exceeded|insufficient_quota/.test(code) ? 429
    : /invalid_api_key|invalid_token|authentication|token_expired|unauthorized/.test(code) ? 401
      : /forbidden|permission|workspace.*(?:suspend|deactivat)|deactivated_workspace/.test(code) ? 403
        : /context_length|invalid_request|unknown_parameter|max_output_tokens|content_filter/.test(code) ? 400
          : /overload|server_error/.test(code) ? 503 : 502;
  error.status = explicit ?? inferred;
  return error;
}

function count(value) { return Number.isFinite(value) && value >= 0 ? value : 0; }

/**
 * Async StreamChunk mapper. `body` is a ReadableStream<Uint8Array> and
 * `parseSse(body)` must yield data-field strings and cancel/release on return.
 * Success is ONLY response.completed (or response.done with status:completed).
 * It emits usage + finish, matching upstream.js; failure/incomplete/[DONE]/EOF
 * without a successful terminal event throws with status and code for failover.
 * Reasoning content is intentionally omitted from public chunks; reasoning token
 * usage is retained. Optional builder context enables a private bounded cache
 * scoped to account, token fingerprint, model and endpoint for tool replay.
 */
export async function* mapCodex(body, parseSse, context) {
  if (typeof parseSse !== 'function') throw new TypeError('mapCodex requires an SSE parser');
  const blocks = new Map();
  const aliases = new Map();
  const nativeOutput = new Map();
  let nextIndex = 0;
  let hasTools = false;

  const itemKey = (event) => {
    if (event.output_index !== undefined && (!Number.isInteger(event.output_index) || event.output_index < 0)) throw streamError('CODEX_INVALID_STREAM');
    const id = event.item?.id ?? event.item_id;
    let key = id ? aliases.get(id) : undefined;
    if (key === undefined) {
      if (Number.isInteger(event.output_index) && event.output_index >= 0) key = `output:${event.output_index}`;
      else if (typeof id === 'string' && id !== '') key = `item:${id}`;
      else throw streamError('CODEX_INVALID_STREAM');
    }
    if (id) aliases.set(id, key);
    return key;
  };
  const textState = (event) => {
    if (event.content_index !== undefined && (!Number.isInteger(event.content_index) || event.content_index < 0)) throw streamError('CODEX_INVALID_STREAM');
    const key = `${itemKey(event)}:text:${event.content_index ?? 0}`;
    let state = blocks.get(key);
    if (!state) {
      state = { index: nextIndex++, block: { type: 'text', text: '' }, started: false, ended: false };
      blocks.set(key, state);
    }
    return state;
  };
  const toolState = (event) => {
    const key = `${itemKey(event)}:tool`;
    let state = blocks.get(key);
    if (!state) {
      state = { index: nextIndex++, block: { type: 'tool-call', id: undefined, name: '', arguments: '' }, started: false, ended: false, pending: [] };
      blocks.set(key, state);
      hasTools = true;
    }
    const item = event.item ?? event;
    if (item.call_id !== undefined) {
      if (typeof item.call_id !== 'string' || item.call_id === '' || (state.block.id && state.block.id !== item.call_id)) throw streamError('CODEX_INVALID_TOOL_ID');
      state.block.id = item.call_id;
    }
    if (item.name !== undefined) {
      const name = context?.wireToOriginal?.get(item.name) ?? item.name;
      if (typeof name !== 'string' || (state.block.name && state.block.name !== name)) throw streamError('CODEX_INVALID_STREAM');
      state.block.name = name;
    }
    return state;
  };
  function* start(state) {
    if (state.started) return;
    if (state.block.type === 'tool-call' && (!state.block.id || !state.block.name)) return;
    state.started = true;
    yield { type: 'block-start', index: state.index, blockType: state.block.type };
    if (state.pending) {
      for (const delta of state.pending) yield { type: 'tool-call-delta', index: state.index, id: state.block.id, argumentsDelta: delta };
      state.pending = [];
    }
  }
  function* append(state, delta) {
    if (typeof delta !== 'string') throw streamError('CODEX_INVALID_STREAM');
    if (state.ended && delta !== '') throw streamError('CODEX_INVALID_STREAM');
    const tool = state.block.type === 'tool-call';
    yield* start(state);
    state.block[tool ? 'arguments' : 'text'] += delta;
    if (delta === '') return;
    if (tool) {
      if (state.started) yield { type: 'tool-call-delta', index: state.index, id: state.block.id, argumentsDelta: delta };
      else state.pending.push(delta);
    } else yield { type: 'text-delta', index: state.index, text: delta };
  }
  function* full(state, value) {
    if (value === undefined) return;
    if (typeof value !== 'string') throw streamError('CODEX_INVALID_STREAM');
    const previous = state.block[state.block.type === 'tool-call' ? 'arguments' : 'text'];
    if (!value.startsWith(previous)) throw streamError('CODEX_INCONSISTENT_OUTPUT');
    yield* append(state, value.slice(previous.length));
  }
  function* close(state) {
    if (state.ended) return;
    yield* start(state);
    if (!state.started) throw streamError('CODEX_INVALID_TOOL_ID');
    state.ended = true;
    yield { type: 'block-end', index: state.index, block: { ...state.block } };
  }
  function* outputItem(event, done) {
    const item = event.item;
    if (!item || typeof item !== 'object') throw streamError('CODEX_INVALID_STREAM');
    const key = itemKey(event);
    if (done && item.status !== undefined && item.status !== 'completed') throw streamError('CODEX_INCOMPLETE_OUTPUT');
    if (done && context?.scope && (item.type === 'reasoning' || item.type === 'function_call')) {
      const previous = nativeOutput.get(key);
      nativeOutput.set(key, { item, order: event.output_index ?? previous?.order ?? nativeOutput.size });
    }
    if (item.type === 'function_call') {
      const state = toolState(event);
      yield* start(state);
      if (done || item.arguments) yield* full(state, item.arguments);
      if (done) yield* close(state);
    } else if (item.type === 'message') {
      if (item.content !== undefined && !Array.isArray(item.content)) throw streamError('CODEX_INVALID_STREAM');
      for (const [content_index, part] of (item.content ?? []).entries()) {
        if (!part || typeof part !== 'object') throw streamError('CODEX_INVALID_STREAM');
        if (part.type !== 'output_text' && part.type !== 'refusal') continue;
        const state = textState({ ...event, content_index });
        yield* full(state, part.type === 'refusal' ? part.refusal : part.text);
        if (done) yield* close(state);
      }
    }
  }

  for await (const data of parseSse(body)) {
    if (data === '[DONE]') break;
    let event;
    try { event = JSON.parse(data); } catch { throw streamError('CODEX_INVALID_SSE'); }
    if (!event || typeof event.type !== 'string') throw streamError('CODEX_INVALID_SSE');
    if (['error', 'response.failed', 'response.incomplete', 'response.cancelled', 'response.canceled'].includes(event.type)) throw streamError(event.type, event);
    switch (event.type) {
      case 'response.output_item.added': yield* outputItem(event, false); break;
      case 'response.output_item.done': yield* outputItem(event, true); break;
      case 'response.content_part.added': {
        if (event.part?.type === 'output_text' || event.part?.type === 'refusal') {
          const state = textState(event);
          yield* start(state);
          yield* full(state, event.part.type === 'refusal' ? event.part.refusal : event.part.text);
        }
        break;
      }
      case 'response.output_text.delta':
      case 'response.refusal.delta': yield* append(textState(event), event.delta); break;
      case 'response.output_text.done':
      case 'response.refusal.done': {
        const state = textState(event);
        yield* full(state, event.type === 'response.refusal.done' ? event.refusal : event.text);
        yield* close(state);
        break;
      }
      case 'response.function_call_arguments.delta': yield* append(toolState(event), event.delta); break;
      case 'response.function_call_arguments.done': {
        const state = toolState(event);
        yield* full(state, event.arguments);
        // output_item.done supplies final call_id/name if metadata was delayed.
        break;
      }
      case 'response.content_part.done': {
        if (event.part?.type === 'output_text' || event.part?.type === 'refusal') {
          const state = textState(event);
          yield* full(state, event.part.type === 'refusal' ? event.part.refusal : event.part.text);
          yield* close(state);
        }
        break;
      }
      case 'response.completed':
      case 'response.done': {
        const response = event.response;
        if (!response || typeof response !== 'object' || response.error || response.incomplete_details
          || (response.status !== undefined && response.status !== 'completed')
          || (event.type === 'response.done' && response.status !== 'completed')) throw streamError('CODEX_INVALID_TERMINAL', event);
        if (response.output !== undefined && !Array.isArray(response.output)) throw streamError('CODEX_INVALID_TERMINAL');
        for (const [output_index, item] of (response.output ?? []).entries()) yield* outputItem({ output_index, item }, true);
        for (const state of blocks.values()) yield* close(state);
        if (context?.scope) {
          const reasoning = [];
          for (const { item } of [...nativeOutput.values()].sort((a, b) => a.order - b.order)) {
            if (item.type === 'reasoning' && typeof item.encrypted_content === 'string' && item.encrypted_content !== '') {
              // store:false cannot resolve rs_* ids. The reference strips both
              // id/call_id and backfills required summary before replay.
              const { id, call_id, ...replay } = item;
              replay.summary = Array.isArray(replay.summary) ? replay.summary : [];
              reasoning.push(replay);
            } else if (item.type === 'function_call' && reasoning.length > 0) {
              continuationPut(item.call_id, context.scope, { name: context.wireToOriginal?.get(item.name) ?? item.name, arguments: item.arguments ?? '', reasoning });
            }
          }
        }
        const usage = response.usage ?? {};
        // Responses input_tokens includes cache hits; DSH adds cacheReadTokens separately.
        const cacheReadTokens = count(usage.input_tokens_details?.cached_tokens);
        yield { type: 'usage', usage: {
          inputTokens: Math.max(0, count(usage.input_tokens) - cacheReadTokens),
          outputTokens: count(usage.output_tokens),
          cacheReadTokens,
          cacheWriteTokens: 0,
          reasoningTokens: count(usage.output_tokens_details?.reasoning_tokens),
        } };
        yield { type: 'finish', reason: { kind: hasTools ? 'tool-calls' : 'stop' } };
        return;
      }
      default: break; // created/in_progress, reasoning, annotations and metadata
    }
  }
  throw streamError('CODEX_STREAM_TRUNCATED');
}
