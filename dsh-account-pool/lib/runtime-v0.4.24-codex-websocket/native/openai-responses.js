/** General API-key OpenAI Responses mapping; Codex identity is never used here. */
import { createHash } from 'node:crypto';
import { mapCodex } from './codex.js';
import { rememberDetectionText } from '../detection.js';

const SKIPPED = new Set(['tool-addition', 'tool-removal', 'reasoning']);
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const continuations = new Map();
const CACHE_BYTES = 2 * 1024 * 1024;
let cacheBytes = 0;
const fingerprint = (value) => createHash('sha256').update(value).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
function localError(message) {
  return Object.assign(new Error(message), { name: 'PoolUnsupportedContentError', code: 'POOL_UNSUPPORTED_CONTENT' });
}
function parts(content, calls = false) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (content == null) return [];
  if (!Array.isArray(content)) throw localError('Responses content must be text or content blocks');
  return content.filter((part) => {
    if (part?.type === 'text' && typeof part.text === 'string') return true;
    if (calls && part?.type === 'tool-call') return true;
    if (SKIPPED.has(part?.type)) return false;
    throw localError('Responses supports text and assistant function calls');
  });
}
function required(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw localError(`Responses requires ${field}`);
  return value;
}
function argumentsText(value) { return typeof value === 'string' ? value : JSON.stringify(value ?? {}); }
function cached(id, scope) {
  const entry = continuations.get(`${scope}:${id}`);
  return entry?.expiresAt > Date.now() ? entry : undefined;
}
function put(id, scope, value) {
  const key = `${scope}:${id}`;
  const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value));
  if (bytes > CACHE_BYTES / 4) return;
  const previous = continuations.get(key);
  if (previous) { cacheBytes -= previous.bytes; continuations.delete(key); }
  continuations.set(key, { ...clone(value), bytes, expiresAt: Date.now() + 60 * 60 * 1000 });
  cacheBytes += bytes;
  for (const [oldKey, entry] of continuations) {
    if (entry.expiresAt > Date.now() && continuations.size <= 512 && cacheBytes <= CACHE_BYTES) continue;
    continuations.delete(oldKey); cacheBytes -= entry.bytes;
  }
}

/** Accept root, /v1 and copied Responses endpoints, including a relay path prefix. */
export function openAIResponsesUrl(baseUrl = 'https://api.openai.com', websocket = false) {
  let url;
  try { url = new URL(baseUrl ?? 'https://api.openai.com'); } catch { throw localError('Responses base URL must be an absolute HTTP(S) URL'); }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw localError('Responses base URL requires HTTP(S) without userinfo, query or fragment');
  }
  let path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/v1/responses')) path = path.slice(0, -13);
  else if (path.endsWith('/responses')) path = path.slice(0, -10);
  if (path.endsWith('/v1')) path = path.slice(0, -3);
  url.pathname = `${path}/v1/responses`;
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  url.protocol = websocket ? (secure ? 'wss:' : 'ws:') : (secure ? 'https:' : 'http:');
  return url.href;
}

export function buildOpenAIResponsesRequest(account, options = {}, credential, defaultMaxTokens = 4096) {
  const url = openAIResponsesUrl(account?.baseUrl);
  required(options.model, 'a model');
  if (typeof credential !== 'string' || !credential.trim() || /[\x00-\x20\x7f]/.test(credential)) {
    throw Object.assign(new Error('Responses requires a usable API key'), { name: 'PoolCredentialError', code: 'POOL_NO_CREDENTIAL' });
  }
  if (options.system !== undefined && typeof options.system !== 'string') throw localError('Responses instructions must be text');
  if (options.messages !== undefined && !Array.isArray(options.messages)) throw localError('Responses messages must be an array');
  if (options.tools !== undefined && !Array.isArray(options.tools)) throw localError('Responses tools must be an array');
  if (options.stop?.length) throw localError('Responses does not support stop sequences');
  const scope = fingerprint(JSON.stringify(['openai-responses', account?.id, fingerprint(credential), url, options.model]));
  const input = [];
  const restored = new Set();
  for (const message of options.messages ?? []) {
    const role = message?.role;
    if (role === 'tool') {
      input.push({ type: 'function_call_output', call_id: required(message.toolCallId, 'a function result call id'), output: parts(message.content).map((part) => part.text).join('') });
      continue;
    }
    if (!['system', 'developer', 'user', 'assistant'].includes(role)) throw localError('Responses received an unsupported message role');
    let text = '';
    const flush = () => {
      if (text) input.push({ type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] });
      text = '';
    };
    for (const part of parts(message.content, role === 'assistant')) {
      if (part.type === 'text') { text += part.text; continue; }
      flush();
      const id = required(part.id, 'a function call id');
      const name = required(part.name, 'a function name');
      const args = argumentsText(part.arguments);
      const entry = cached(id, scope);
      if (entry?.name === name && entry.arguments === args) {
        for (const reasoning of entry.reasoning) {
          const key = fingerprint(JSON.stringify(reasoning));
          if (!restored.has(key)) { restored.add(key); input.push(clone(reasoning)); }
        }
      }
      input.push({ type: 'function_call', call_id: id, name, arguments: args });
    }
    flush();
  }
  const body = { model: options.model, input, stream: true, store: false, max_output_tokens: Math.max(16, options.maxTokens ?? defaultMaxTokens) };
  if (typeof options.sessionId === 'string' && options.sessionId.trim()) body.prompt_cache_key = fingerprint(JSON.stringify(['pool-responses-cache', account?.id, url, options.sessionId]));
  if (options.system) body.instructions = options.system;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.reasoningEffort !== undefined && options.reasoningEffort !== '' && options.reasoningEffort !== 'off') {
    if (!EFFORTS.has(options.reasoningEffort)) throw localError('Responses received an unsupported reasoning effort');
    body.reasoning = { effort: options.reasoningEffort, summary: 'auto' };
    body.include = ['reasoning.encrypted_content'];
  }
  if (options.tools?.length) {
    body.tools = options.tools.map((tool) => ({ type: 'function', name: required(tool.name, 'a function name'), description: tool.description, parameters: tool.parameters ?? { type: 'object', properties: {} }, strict: false }));
    body.tool_choice = 'auto';
    body.parallel_tool_calls = true;
  }
  return { url, init: { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${credential}` }, body: JSON.stringify(body) }, context: { scope } };
}

/**
 * Reuse the existing strict Responses state machine for text, tools and usage.
 * Reasoning summaries are adapted to its text-block events and then marked as
 * reasoning chunks. Original encrypted output is retained privately for tool
 * continuations, bounded and scoped to the account/key/endpoint/model.
 */
export async function* mapOpenAIResponses(events, context) {
  let reasoningEvent = false;
  const reasoningBlocks = new Set();
  const nativeOutput = new Map();
  let terminal;
  let lastData;
  async function* adapted() {
    for await (const data of events) {
      lastData = data;
      let event;
      try { event = JSON.parse(data); } catch { reasoningEvent = false; yield data; continue; }
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
        reasoningEvent = false; yield data; continue;
      }
      reasoningEvent = false;
      if (event.type === 'response.output_item.done' && ['reasoning', 'function_call'].includes(event.item?.type)) {
        nativeOutput.set(event.item.id ?? `output:${event.output_index}`, { item: event.item, order: event.output_index ?? nativeOutput.size });
      }
      // Both public reasoning text and reasoning summaries use indexed text parts.
      if (/^response\.reasoning_(?:summary_)?text\.(delta|done)$/.test(event.type)) {
        reasoningEvent = true;
        yield JSON.stringify({ ...event, content_index: event.summary_index ?? event.content_index ?? 0, type: event.type.endsWith('.delta') ? 'response.output_text.delta' : 'response.output_text.done' });
        continue;
      }
      const emitReasoning = (item, output_index) => {
        if (item.summary !== undefined && !Array.isArray(item.summary)) {
          throw Object.assign(new Error('OpenAI Responses stream failed (RESPONSES_INVALID_STREAM)'), { name: 'OpenAIResponsesStreamError', code: 'RESPONSES_INVALID_STREAM', status: 502 });
        }
        const summary = (item.summary ?? []).filter((part) => part?.type === 'summary_text' || part?.type === 'reasoning_text');
        if (!summary.length) return undefined;
        return JSON.stringify({ type: 'response.output_item.done', output_index, item: { ...item, type: 'message', content: summary.map((part) => ({ type: 'output_text', text: part.text })) } });
      };
      if (event.type === 'response.output_item.done' && event.item?.type === 'reasoning') {
        const adaptedItem = emitReasoning(event.item, event.output_index);
        if (adaptedItem) { reasoningEvent = true; yield adaptedItem; }
        continue;
      }
      if (event.type === 'response.completed' || event.type === 'response.done') {
        terminal = event.response;
        for (const [output_index, item] of (Array.isArray(terminal?.output) ? terminal.output : []).entries()) {
          if (['reasoning', 'function_call'].includes(item?.type)) nativeOutput.set(item.id ?? `output:${output_index}`, { item, order: output_index });
          if (item?.type === 'reasoning') {
            const adaptedItem = emitReasoning(item, output_index);
            if (adaptedItem) { reasoningEvent = true; yield adaptedItem; }
          }
        }
        reasoningEvent = false;
      }
      yield data;
    }
  }
  try {
    for await (const chunk of mapCodex(undefined, () => adapted())) {
      if (chunk.type === 'block-start' && chunk.blockType === 'text' && reasoningEvent) reasoningBlocks.add(chunk.index);
      if (reasoningBlocks.has(chunk.index)) {
        if (chunk.type === 'block-start') yield { ...chunk, blockType: 'reasoning' };
        else if (chunk.type === 'text-delta') yield { ...chunk, type: 'reasoning-delta' };
        else if (chunk.type === 'block-end') yield { ...chunk, block: { ...chunk.block, type: 'reasoning' } };
        else yield chunk;
      } else {
        if (chunk.type === 'finish' && context?.scope && terminal?.status !== 'failed') {
          const reasoning = [];
          for (const { item } of [...nativeOutput.values()].sort((a, b) => a.order - b.order)) {
            if (item.type === 'reasoning' && item.encrypted_content) {
              const { id, call_id, ...replay } = item;
              replay.summary = Array.isArray(replay.summary) ? replay.summary : [];
              reasoning.push(replay);
            } else if (item.type === 'function_call' && reasoning.length) put(item.call_id, context.scope, { name: item.name, arguments: item.arguments ?? '', reasoning });
          }
        }
        yield chunk;
      }
    }
  } catch (error) {
    if (error.name === 'CodexStreamError') {
      error.name = 'OpenAIResponsesStreamError';
      error.message = error.message.replace('Codex', 'OpenAI Responses').replaceAll('CODEX_', 'RESPONSES_');
      if (error.code?.startsWith('CODEX_')) error.code = error.code.replace('CODEX_', 'RESPONSES_');
      rememberDetectionText(error, lastData);
    }
    throw error;
  }
}
