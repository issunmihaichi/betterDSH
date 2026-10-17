/** Native Gemini / Gemini CLI Code Assist protocol. No credential persistence or onboarding. */
import { createHash, randomUUID } from 'node:crypto';

const CODE_ASSIST_BASE = 'https://cloudcode-pa.googleapis.com';
const API_BASE = 'https://generativelanguage.googleapis.com';
const CACHE_LIMIT = 512;
const CACHE_BYTES_LIMIT = 2 * 1024 * 1024;
const CACHE_TTL_MS = 60 * 60 * 1000;
// Call ids are opaque and globally unique; every lookup also checks account + model.
const continuations = new Map();
const projectCaches = new WeakMap();
const PROJECT_CACHE_LIMIT = 128;
const PROJECT_TTL_MS = 5 * 60 * 1000;
let cacheBytes = 0;

function failure(message, code, status) {
  const error = new Error(message);
  error.code = code;
  if (status !== undefined) error.status = status;
  return error;
}
function unsupported(message) { return failure(message, 'POOL_UNSUPPORTED_CONTENT'); }
function nonempty(value) { return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined; }
function hash(value) { return createHash('sha256').update(String(value)).digest('hex'); }
function geminiBase(value, oauth) {
  let url;
  try { url = new URL(value ?? (oauth ? CODE_ASSIST_BASE : API_BASE)); } catch { throw unsupported('Gemini baseUrl must be a valid HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw unsupported('Gemini baseUrl cannot contain credentials, query parameters or fragments');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw unsupported('Gemini requires HTTPS except for a local relay');
  let path = url.pathname.replace(/\/+$/, '');
  const version = path.match(/\/(v1beta|v1internal|v1)$/)?.[1];
  if (version) {
    if (version !== (oauth ? 'v1internal' : 'v1beta')) throw unsupported('Gemini baseUrl uses the wrong native API version');
    path = path.slice(0, -(version.length + 1));
  }
  return `${url.origin}${path}`;
}
// Documented escape hatch for imported/resumed Gemini 3 tool histories. It carries no
// account signature. Reference: gemini_messages_compat_service.go:53-56 and
// https://ai.google.dev/gemini-api/docs/thought-signatures (manual function-call history).
function allowUnsignedHistory(parts, model) {
  if (!/^gemini-3(?:[.-]|$)/.test(model)) return parts;
  for (const part of parts) if (part.functionCall && !nonempty(part.thoughtSignature)) part.thoughtSignature = 'skip_thought_signature_validator';
  return parts;
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function bundleOf(value) {
  if (typeof value !== 'string') return value ?? {};
  if (value.trim().startsWith('{')) {
    try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed; } catch { /* bare secret */ }
  }
  return { access_token: value, api_key: value };
}
function secretOf(bundle, oauth = true) {
  const keys = oauth ? ['access_token', 'accessToken', 'token', 'api_key', 'apiKey', 'key'] : ['api_key', 'apiKey', 'key', 'access_token', 'accessToken', 'token'];
  for (const key of keys) {
    const value = nonempty(bundle?.[key]);
    if (value) return value;
  }
  throw failure('Gemini account has no usable credential', 'POOL_NO_CREDENTIAL');
}
function projectOf(bundle) {
  const value = bundle?.project_id ?? bundle?.projectId ?? bundle?.cloudaicompanionProject;
  return nonempty(typeof value === 'object' ? value?.id ?? value?.projectId : value);
}
function cacheGet(id, context) {
  const entry = continuations.get(id);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    continuations.delete(id); cacheBytes -= entry.bytes; return undefined;
  }
  if (!context?.scope || entry.scope !== context.scope) return undefined;
  continuations.delete(id); continuations.set(id, entry);
  return entry;
}
function cachePut(id, value, scope) {
  if (!scope) return;
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > CACHE_BYTES_LIMIT / 4) return;
  const prior = continuations.get(id);
  if (prior) { continuations.delete(id); cacheBytes -= prior.bytes; }
  continuations.set(id, { ...value, scope, bytes, expiresAt: Date.now() + CACHE_TTL_MS });
  cacheBytes += bytes;
  for (const [key, entry] of continuations) {
    if (entry.expiresAt > Date.now() && continuations.size <= CACHE_LIMIT && cacheBytes <= CACHE_BYTES_LIMIT) break;
    continuations.delete(key); cacheBytes -= entry.bytes;
  }
}

// Preserve valid names and deterministically encode names outside Gemini's grammar.
// The request-local reverse map avoids collisions even with a tool named like an encoded name.
function registerNames(names) {
  const originalToWire = new Map();
  const wireToOriginal = new Map();
  const unique = [...new Set(names)];
  for (const name of unique) {
    if (!nonempty(name)) throw unsupported('Gemini tool names must be nonempty strings');
    if (/^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/.test(name)) {
      originalToWire.set(name, name); wireToOriginal.set(name, name);
    }
  }
  for (const name of unique) {
    if (originalToWire.has(name)) continue;
    let salt = 0;
    let wire;
    do { wire = `dsh_${hash(`${name}:${salt++}`).slice(0, 56)}`; } while (wireToOriginal.has(wire));
    originalToWire.set(name, wire); wireToOriginal.set(wire, name);
  }
  return { originalToWire, wireToOriginal };
}
function argsOf(raw) {
  let parsed = raw;
  if (raw === undefined || raw === '') return {};
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { throw unsupported('Gemini tool arguments must be valid JSON objects'); }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw unsupported('Gemini tool arguments must be JSON objects');
  return clone(parsed);
}
function textOf(content) {
  if (typeof content === 'string') return content;
  const text = [];
  for (const block of content ?? []) {
    if (block?.type !== 'text') throw unsupported(`Gemini tool results cannot express '${String(block?.type)}' blocks`);
    text.push(block.text ?? '');
  }
  return text.join('');
}
function visibleKey(blocks) {
  return JSON.stringify(blocks.filter((b) => b?.type === 'text' || b?.type === 'tool-call').map((b) =>
    b.type === 'text' ? { type: 'text', text: b.text ?? '' } : { type: 'tool-call', id: b.id, name: b.name, args: argsOf(b.arguments) }));
}
function inputBlocks(message) {
  return typeof message?.content === 'string' ? [{ type: 'text', text: message.content }] : message?.content ?? [];
}
function thinkingConfig(options, model) {
  if (options.thinkingBudget !== undefined) {
    if (!Number.isInteger(options.thinkingBudget) || options.thinkingBudget < -1) throw unsupported('Invalid Gemini thinking budget');
    return { thinkingBudget: options.thinkingBudget, includeThoughts: options.thinkingBudget !== 0 };
  }
  const effort = options.reasoningEffort;
  if (effort === undefined || effort === '') return undefined;
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort)) throw unsupported('Unsupported Gemini reasoning effort');
  if (/^gemini-3(?:[.-]|$)/.test(model)) {
    const flash = model.includes('flash');
    const mediumAllowed = flash || /^gemini-3\.1(?:[.-]|$)/.test(model);
    const level = effort === 'off' || effort === 'minimal' ? (flash ? 'minimal' : 'low') : effort === 'xhigh' ? 'high' : effort === 'medium' && !mediumAllowed ? 'high' : effort;
    return { thinkingLevel: level, includeThoughts: effort !== 'off' };
  }
  // Gemini 2.5 Pro cannot disable thinking; use its minimum budget and hide thoughts.
  const budget = effort === 'off' && /^gemini-2\.5-pro(?:[.-]|$)/.test(model) ? 128 : { off: 0, minimal: 512, low: 1024, medium: 8192, high: 24576, xhigh: 24576 }[effort];
  return { thinkingBudget: budget, includeThoughts: effort !== 'off' };
}

/**
 * Build a native request. Pass returned context as mapGemini's optional third argument.
 * The builder performs no network calls; discover/persist a missing project via ensureGeminiProject.
 */
export function buildGeminiRequest(account = {}, options = {}, credentialBundle) {
  const bundle = bundleOf(credentialBundle);
  const oauth = account.authMode === 'oauth';
  const secret = secretOf(bundle, oauth);
  const project = nonempty(account.projectId) ?? projectOf(bundle);
  if (oauth && !project) throw failure('Gemini Code Assist requires project_id or account.projectId; run loadCodeAssist project discovery', 'POOL_GEMINI_PROJECT_REQUIRED');
  const model = String(options.model ?? '').replace(/^models\//, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model)) throw unsupported('Gemini model must be a safe, nonempty model name');
  const base = geminiBase(account.baseUrl, oauth);
  const scope = hash(JSON.stringify([account.id ?? null, account.credentialRef ?? null, base, account.authMode ?? 'api-key', project ?? null, model, hash(bundle.refresh_token ?? secret)]));
  const names = (options.tools ?? []).map((tool) => tool.name);
  for (const message of options.messages ?? []) {
    for (const block of inputBlocks(message)) if (block?.type === 'tool-call') names.push(block.name);
    if (nonempty(message?.toolName ?? message?.name)) names.push(message.toolName ?? message.name);
    const cached = cacheGet(message?.toolCallId, { scope });
    if (cached) names.push(cached.name);
  }
  const context = { scope, model, ...registerNames(names) };
  const calls = new Map();
  for (const message of options.messages ?? []) {
    for (const block of inputBlocks(message)) {
      if (block?.type !== 'tool-call') continue;
      if (!nonempty(block.id)) throw unsupported('Gemini historical tool calls require ids');
      const cached = cacheGet(block.id, context);
      calls.set(block.id, { name: block.name, nativeId: cached?.nativeId, order: calls.size });
    }
  }
  const contents = [];
  const responseOrder = new WeakMap();
  for (const message of options.messages ?? []) {
    const role = message?.role;
    if (role === 'tool') {
      const call = calls.get(message.toolCallId) ?? cacheGet(message.toolCallId, context);
      const name = call?.name ?? message.toolName ?? message.name;
      const wireName = context.originalToWire.get(name);
      if (!wireName) throw unsupported('Gemini tool result cannot resolve its tool call name');
      const functionResponse = { name: wireName, response: { [message.isError === true ? 'error' : 'output']: textOf(message.content) } };
      if (call?.nativeId) functionResponse.id = call.nativeId;
      const part = { functionResponse };
      responseOrder.set(part, calls.get(message.toolCallId)?.order ?? call?.nativeOrder ?? Number.MAX_SAFE_INTEGER);
      const last = contents.at(-1);
      if (last?.role === 'user' && last.parts.every((item) => item.functionResponse)) {
        last.parts.push(part);
        last.parts.sort((a, b) => responseOrder.get(a) - responseOrder.get(b));
      } else contents.push({ role: 'user', parts: [part] });
      continue;
    }
    if (role !== 'assistant' && role !== 'user' && role !== undefined) throw unsupported(`Gemini cannot express message role '${String(role)}'`);
    const blocks = inputBlocks(message);
    const firstCall = blocks.find((block) => block?.type === 'tool-call');
    const cached = firstCall && cacheGet(firstCall.id, context);
    if (role === 'assistant' && cached?.visibleKey === visibleKey(blocks)) {
      const parts = clone(cached.nativeParts);
      // A tools list may differ between turns; rebind the names to this request.
      for (const part of parts) if (part.functionCall) {
        const original = cached.wireNames[part.functionCall.name] ?? part.functionCall.name;
        part.functionCall.name = context.originalToWire.get(original) ?? part.functionCall.name;
      }
      contents.push({ role: 'model', parts: allowUnsignedHistory(parts, model) });
      continue;
    }
    const parts = [];
    for (const block of blocks) {
      if (block?.type === 'text') { if (block.text !== '') parts.push({ text: block.text ?? '' }); }
      else if (block?.type === 'tool-call' && role === 'assistant') {
        const part = { functionCall: { name: context.originalToWire.get(block.name), args: argsOf(block.arguments) } };
        const prior = cacheGet(block.id, context);
        if (prior?.nativeId) part.functionCall.id = prior.nativeId;
        if (prior?.signature && prior.name === block.name && JSON.stringify(prior.args) === JSON.stringify(part.functionCall.args)) part.thoughtSignature = prior.signature;
        parts.push(part);
      } else if (['reasoning', 'tool-addition', 'tool-removal'].includes(block?.type)) {
        // Private native reasoning is restored only from an account-checked cache.
      } else throw unsupported(`Gemini cannot express '${String(block?.type)}' content blocks`);
    }
    if (parts.length) contents.push({ role: role === 'assistant' ? 'model' : 'user', parts: role === 'assistant' ? allowUnsignedHistory(parts, model) : parts });
  }
  const request = { contents };
  if (options.system !== undefined && options.system !== '') request.systemInstruction = { parts: [{ text: String(options.system) }] };
  const generationConfig = {};
  if (options.maxTokens !== undefined) generationConfig.maxOutputTokens = options.maxTokens;
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
  if (Array.isArray(options.stop) && options.stop.length) generationConfig.stopSequences = options.stop;
  const thinking = thinkingConfig(options, model);
  if (thinking) generationConfig.thinkingConfig = thinking;
  if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;
  if (Array.isArray(options.tools) && options.tools.length) {
    request.tools = [{ functionDeclarations: options.tools.map((tool) => ({
      name: context.originalToWire.get(tool.name),
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      parametersJsonSchema: clone(tool.parameters ?? { type: 'object', properties: {} }),
    })) }];
  }
  return {
    url: oauth ? `${base}/v1internal:streamGenerateContent?alt=sse` : `${base}/v1beta/models/${model}:streamGenerateContent?alt=sse`,
    init: {
      method: 'POST', redirect: 'error',
      headers: {
        'content-type': 'application/json', accept: 'text/event-stream',
        ...(oauth ? { authorization: `Bearer ${secret}`, 'user-agent': 'GeminiCLI/0.1.5 (Windows; AMD64)' } : { 'x-goog-api-key': secret }),
      },
      body: JSON.stringify(oauth ? { project, model, request } : request),
    },
    context,
  };
}

/** Read-only Code Assist discovery; a missing project requires explicit setup, never paid onboarding. */
export async function ensureGeminiProject(credentialBundle, { fetchImpl = globalThis.fetch, signal, accountId } = {}) {
  const bundle = bundleOf(credentialBundle);
  secretOf(bundle);
  if (typeof fetchImpl !== 'function') throw new TypeError('ensureGeminiProject requires fetchImpl');
  signal?.throwIfAborted();
  let cache = projectCaches.get(fetchImpl);
  if (!cache) { cache = new Map(); projectCaches.set(fetchImpl, cache); }
  const key = hash(JSON.stringify([accountId ?? null, bundle.client_id ?? null, projectOf(bundle) ?? null, bundle.refresh_token ?? secretOf(bundle)]));
  const prior = cache.get(key);
  if (prior?.expiresAt > Date.now()) return clone(prior.value);
  if (prior?.inFlight && !prior.controller.signal.aborted) return awaitProject(prior, signal);
  cache.delete(key);
  for (const [oldKey, entry] of cache) {
    if (cache.size < PROJECT_CACHE_LIMIT) break;
    if (!entry.inFlight) cache.delete(oldKey);
  }
  // If all slots are active, discover without retaining an extra cache entry.
  if (cache.size >= PROJECT_CACHE_LIMIT) return discoverGeminiProject(bundle, { fetchImpl, signal });
  const entry = { controller: new AbortController(), waiters: 0, settled: false };
  entry.inFlight = discoverGeminiProject(bundle, { fetchImpl, signal: entry.controller.signal }).then((value) => {
    entry.settled = true;
    if (cache.get(key) === entry) cache.set(key, { value, expiresAt: Date.now() + (value.projectId ? PROJECT_TTL_MS : 30000) });
    return value;
  }, (error) => {
    entry.settled = true;
    if (cache.get(key) === entry) cache.delete(key);
    throw error;
  });
  cache.set(key, entry);
  return awaitProject(entry, signal);
}

function awaitProject(entry, signal) {
  entry.waiters++;
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', aborted);
      entry.waiters--;
      if (entry.waiters === 0 && !entry.settled) entry.controller.abort();
      if (error) reject(error);
      else resolve(clone(value));
    };
    const aborted = () => finish(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (signal?.aborted) aborted();
    else signal?.addEventListener('abort', aborted, { once: true });
    entry.inFlight.then((value) => finish(undefined, value), (error) => finish(error));
  });
}

async function discoverGeminiProject(bundle, { fetchImpl, signal }) {
  const secret = secretOf(bundle);
  const response = await fetchImpl(`${CODE_ASSIST_BASE}/v1internal:loadCodeAssist`, {
    method: 'POST', redirect: 'error', signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}`, 'user-agent': 'GeminiCLI/0.1.5 (Windows; AMD64)' },
    body: JSON.stringify({
      ...(projectOf(bundle) ? { cloudaicompanionProject: projectOf(bundle) } : {}),
      metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI', ...(projectOf(bundle) ? { duetProject: projectOf(bundle) } : {}) },
    }),
  });
  if (!response.ok) {
    // Do not propagate request secrets or arbitrary HTML from a discovery failure.
    const error = failure(`Gemini loadCodeAssist failed (HTTP ${response.status})`, `http-${response.status}`, response.status);
    const retry = response.headers?.get?.('retry-after');
    if (retry !== null && retry !== undefined && Number.isFinite(Number(retry))) error.providerRetryAfterMs = Math.max(0, Math.min(Number(retry) * 1000, 21600000));
    throw error;
  }
  let payload;
  try { payload = await response.json(); } catch { throw failure('Gemini loadCodeAssist returned invalid JSON', 'POOL_GEMINI_INVALID_RESPONSE'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.error) throw failure('Gemini loadCodeAssist returned an invalid response', 'POOL_GEMINI_INVALID_RESPONSE');
  const projectId = projectOf(payload) ?? projectOf(bundle);
  const tierId = nonempty(typeof payload.paidTier === 'string' ? payload.paidTier : payload.paidTier?.id)
    ?? nonempty(typeof payload.currentTier === 'string' ? payload.currentTier : payload.currentTier?.id);
  return {
    projectId, project_id: projectId, tierId,
    currentTier: payload.currentTier ?? null, paidTier: payload.paidTier ?? null,
    allowedTiers: Array.isArray(payload.allowedTiers) ? payload.allowedTiers : [],
    requiresOnboarding: !projectId,
  };
}

const GRPC_HTTP = {
  CANCELLED: 499, UNKNOWN: 500, INVALID_ARGUMENT: 400, DEADLINE_EXCEEDED: 504,
  NOT_FOUND: 404, ALREADY_EXISTS: 409, PERMISSION_DENIED: 403, RESOURCE_EXHAUSTED: 429,
  FAILED_PRECONDITION: 400, ABORTED: 409, OUT_OF_RANGE: 400, UNIMPLEMENTED: 501,
  INTERNAL: 500, UNAVAILABLE: 503, DATA_LOSS: 500, UNAUTHENTICATED: 401,
};
const GRPC_NUMERIC = { 1: 499, 2: 500, 3: 400, 4: 504, 5: 404, 6: 409, 7: 403, 8: 429, 9: 400, 10: 409, 11: 400, 12: 501, 13: 500, 14: 503, 15: 500, 16: 401 };
function streamError(error) {
  const numeric = Number(error?.code);
  const symbol = [error?.status, error?.code].find((value) => typeof value === 'string' && Object.hasOwn(GRPC_HTTP, value));
  const status = Number.isInteger(numeric) && numeric >= 400 && numeric <= 599 ? numeric : GRPC_HTTP[symbol] ?? GRPC_NUMERIC[numeric];
  const result = failure(`Gemini upstream stream error${symbol ? ` (${symbol})` : ''}`, status !== undefined ? `http-${status}` : 'POOL_GEMINI_STREAM_ERROR', status);
  for (const detail of Array.isArray(error?.details) ? error.details : []) {
    if (detail?.['@type'] !== 'type.googleapis.com/google.rpc.RetryInfo') continue;
    const delay = detail.retryDelay;
    const match = typeof delay === 'string' ? delay.match(/^(\d+(?:\.\d+)?)s$/) : undefined;
    const seconds = match ? Number(match[1]) : delay && typeof delay === 'object' ? Number(delay.seconds ?? 0) + Number(delay.nanos ?? 0) / 1e9 : NaN;
    if (Number.isFinite(seconds) && seconds >= 0) result.providerRetryAfterMs = Math.min(seconds * 1000, 21600000);
  }
  return result;
}
function tokenCount(value) { return Number.isFinite(value) && value >= 0 ? value : 0; }

/** Map raw SSE response body, or a supplied iterable when parseSse is omitted, to DSH StreamChunks. */
export async function* mapGemini(body, parseSse, context) {
  const events = typeof parseSse === 'function' ? parseSse(body) : body;
  if (!events || typeof events[Symbol.asyncIterator] !== 'function' && typeof events[Symbol.iterator] !== 'function') throw failure('Gemini returned an empty stream', 'POOL_EMPTY_BODY');
  const blocks = [];
  const nativeParts = [];
  const callMetadata = new Map();
  let activeIndex;
  let finishReason;
  let hasContent = false;
  let reportedUsage = {};
  for await (const data of events) {
    if (data === '[DONE]') break;
    let envelope;
    try { envelope = typeof data === 'string' ? JSON.parse(data) : data; } catch { throw failure('Gemini returned malformed SSE JSON', 'POOL_GEMINI_INVALID_RESPONSE'); }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw failure('Gemini returned an invalid SSE response', 'POOL_GEMINI_INVALID_RESPONSE');
    if (envelope.error) throw streamError(envelope.error);
    const response = envelope.response ?? envelope;
    if (response.error) throw streamError(response.error);
    if (response.usageMetadata) reportedUsage = { ...reportedUsage, ...response.usageMetadata };
    if (response.promptFeedback?.blockReason) throw failure(`Gemini prompt blocked (${String(response.promptFeedback.blockReason)})`, 'POOL_GEMINI_BLOCKED');
    const candidate = response.candidates?.find((entry) => entry.index === 0) ?? response.candidates?.[0];
    if (!candidate) continue;
    const terminal = candidate.finishReason;
    if (terminal !== undefined && terminal !== null && terminal !== '' && terminal !== 'FINISH_REASON_UNSPECIFIED') {
      if (!['STOP', 'MAX_TOKENS'].includes(terminal)) throw failure(`Gemini generation failed (${String(terminal)})`, 'POOL_GEMINI_TERMINAL_ERROR');
      finishReason = terminal;
    }
    for (const part of candidate.content?.parts ?? []) {
      if (!part || typeof part !== 'object') throw failure('Gemini returned an invalid content part', 'POOL_GEMINI_INVALID_RESPONSE');
      if (part.functionCall) {
        const call = part.functionCall;
        if (!nonempty(call.name)) throw failure('Gemini returned a function call without a name', 'POOL_GEMINI_INVALID_RESPONSE');
        const id = `gemini_${randomUUID()}`;
        const name = context?.wireToOriginal?.get(call.name) ?? call.name;
        const args = argsOf(call.args);
        const block = { type: 'tool-call', id, name, arguments: JSON.stringify(args) };
        const index = blocks.length;
        blocks.push(block); activeIndex = undefined;
        const native = clone(part);
        nativeParts.push(native);
        callMetadata.set(id, { name, nativeId: nonempty(call.id), nativeOrder: callMetadata.size, native });
        hasContent = true;
        yield { type: 'block-start', index, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index, id, argumentsDelta: block.arguments };
      } else if (typeof part.text === 'string' && part.text !== '') {
        const type = part.thought === true ? 'reasoning' : 'text';
        let block = activeIndex === undefined ? undefined : blocks[activeIndex];
        if (block?.type !== type) {
          activeIndex = blocks.length;
          block = { type, text: '' }; blocks.push(block);
          yield { type: 'block-start', index: activeIndex, blockType: type };
        }
        block.text += part.text;
        // Keep each provider-native part, including signatures, in its original order.
        nativeParts.push(clone(part));
        if (type === 'text') hasContent = true;
        yield { type: type === 'reasoning' ? 'reasoning-delta' : 'text-delta', index: activeIndex, text: part.text };
      } else if (nonempty(part.thoughtSignature)) {
        // Signature-only deltas belong to the preceding native part, not a fake text block.
        const prior = nativeParts.at(-1);
        if (prior) prior.thoughtSignature = part.thoughtSignature;
        else nativeParts.push(clone(part));
      } else if (part.text === '') {
        // Empty text chunks may carry final usage; they are not content.
      } else throw unsupported('Gemini returned an unsupported native response content part');
    }
  }
  if (!hasContent) throw failure('Gemini returned no text or tool calls', 'POOL_EMPTY_RESPONSE');
  if (!finishReason) throw failure('Gemini stream closed before finishReason', 'POOL_GEMINI_TRUNCATED_STREAM');
  const key = visibleKey(blocks);
  for (const [id, metadata] of callMetadata) cachePut(id, {
    name: metadata.name, args: metadata.native.functionCall.args ?? {}, nativeId: metadata.nativeId, nativeOrder: metadata.nativeOrder, signature: metadata.native.thoughtSignature,
    nativeParts, visibleKey: key, wireNames: Object.fromEntries(context?.wireToOriginal ?? []),
  }, context?.scope);
  for (const [index, block] of blocks.entries()) yield { type: 'block-end', index, block };
  const cached = tokenCount(reportedUsage.cachedContentTokenCount);
  const thoughts = tokenCount(reportedUsage.thoughtsTokenCount);
  yield { type: 'usage', usage: {
    // Gemini's prompt count includes cached content; retain it only in the cache bucket.
    inputTokens: Math.max(0, tokenCount(reportedUsage.promptTokenCount) - cached),
    outputTokens: tokenCount(reportedUsage.candidatesTokenCount) + thoughts,
    cacheReadTokens: cached, cacheWriteTokens: 0, reasoningTokens: thoughts,
  } };
  yield { type: 'finish', reason: { kind: finishReason === 'MAX_TOKENS' ? 'max-tokens' : callMetadata.size ? 'tool-calls' : 'stop' } };
}
