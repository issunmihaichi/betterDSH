/** Codex remote_compaction_v2. Provider ciphertext never travels unsealed to DSH.
 * A checkpoint is an official compact-checkpoint user message with one sealed
 * text-block sidecar. Other routes recover its cited original session records.
 */
import { Buffer } from 'node:buffer';
import { isDeepStrictEqual } from 'node:util';
import { MAX_CODEX_REPLAY_BYTES, MAX_CODEX_REQUEST_REPLAY_BYTES } from './codex-replay.js';

export const CODEX_COMPACTION_KIND = 'dsh-account-pool/codex-compaction';
export const CODEX_COMPACTION_VERSION = 2;
export const CODEX_COMPACTION_TEXT = '[Codex v2 encrypted context checkpoint]';
const FRAME_OPEN = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.\n\n<compacted-summary>';
const FRAME_CLOSE = '</compacted-summary>';
const nonblank = value => typeof value === 'string' && value.trim() !== '';
const own = (record, key) => {
  try { return record && typeof record === 'object' ? Object.getOwnPropertyDescriptor(record, key)?.value : undefined; } catch { return undefined; }
};
export function compactionError(code = 'POOL_CODEX_COMPACTION_INVALID_OUTPUT') {
  return Object.assign(new Error('Codex encrypted compaction could not be completed or restored safely'), { code, status: 400 });
}

export function hasCodexCompaction(message) {
  const content = own(message, 'content');
  return Array.isArray(content) && content.some(block => own(block, 'codexCompaction') !== undefined
    || own(own(message, 'source'), 'kind') === 'compact-checkpoint' && own(block, 'text') === CODEX_COMPACTION_TEXT);
}

function markerOf(message) {
  if (own(message, 'role') !== 'user' || own(own(message, 'source'), 'kind') !== 'compact-checkpoint') return undefined;
  const parts = own(message, 'content');
  if (!Array.isArray(parts) || parts.length !== 3 || parts.some(block => own(block, 'type') !== 'text')
    || own(parts[0], 'text') !== FRAME_OPEN || own(parts[1], 'text') !== CODEX_COMPACTION_TEXT || own(parts[2], 'text') !== FRAME_CLOSE
    || own(parts[0], 'codexCompaction') !== undefined || own(parts[2], 'codexCompaction') !== undefined) return undefined;
  return own(parts[1], 'codexCompaction');
}

function nativeItem(value) {
  if (!value || !['compaction', 'compaction_summary'].includes(own(value, 'type')) || !nonblank(own(value, 'encrypted_content'))) return undefined;
  const encrypted = own(value, 'encrypted_content');
  if (Buffer.byteLength(encrypted) > MAX_CODEX_REPLAY_BYTES - 4096) return undefined;
  const id = own(value, 'id');
  if (id !== undefined && (!nonblank(id) || id.length > 512)) return undefined;
  const item = { type: 'compaction', ...(id === undefined ? {} : { id }), encrypted_content: encrypted };
  const metadata = own(value, 'internal_chat_message_metadata_passthrough');
  if (metadata !== undefined) {
    // It is opaque provider data, sealed together with the compaction item.
    try {
      const text = JSON.stringify(metadata);
      if (typeof text !== 'string' || Buffer.byteLength(text) > 2048) return undefined;
      item.internal_chat_message_metadata_passthrough = JSON.parse(text);
    } catch { return undefined; }
  }
  return item;
}

export function openCodexCompaction(context, message) {
  const response = markerOf(message);
  if (!context?.scope || !context.replayCodec || own(response, 'kind') !== CODEX_COMPACTION_KIND
    || own(response, 'version') !== CODEX_COMPACTION_VERSION || own(response, 'scope') !== context.scope) return undefined;
  try {
    const payload = context.replayCodec.open(context.scope, own(response, 'sealed'));
    if (payload?.kind !== CODEX_COMPACTION_KIND || payload?.text !== CODEX_COMPACTION_TEXT) return undefined;
    const item = nativeItem(payload.item), retained = payload.retainedInput ?? [];
    if (!item || !Array.isArray(retained) || retained.length > 100000 || retained.some(entry =>
      entry?.type !== 'message' || entry.role !== 'user' || !Array.isArray(entry.content) || entry.content.some(part =>
        part?.type === 'input_text' ? typeof part.text !== 'string' : part?.type !== 'input_image' || typeof part.image_url !== 'string'
          || !part.image_url.startsWith('data:image/')))) return undefined;
    return [...retained, item];
  } catch { return undefined; }
}

/** Pure bounded expansion. A missing/edited/unverifiable checkpoint fails closed;
 * no arbitrary placeholder or ciphertext can silently replace real context.
 */
export function expandCodexCompactionMessages(messages, { context, enabled = false, resolveCompactionHistory, options = {} } = {}) {
  if (!Array.isArray(messages) || !messages.some(hasCodexCompaction)) return messages;
  let count = 0, bytes = 0;
  const result = [], active = new Set(), stack = [{ list: messages, index: 0 }];
  // Iterative DFS: a long legitimate re-compaction chain is not corruption.
  // Bound total work instead of imposing a small age/depth limit on a session.
  while (stack.length) {
    const frame = stack.at(-1);
    if (frame.index === frame.list.length) {
      stack.pop();
      if (frame.identity !== undefined) active.delete(frame.identity);
      continue;
    }
    const message = frame.list[frame.index++];
    if (++count > 100000) throw compactionError('POOL_CODEX_COMPACTION_HISTORY_UNAVAILABLE');
    if (!hasCodexCompaction(message)) { result.push(message); continue; }
    const item = enabled ? openCodexCompaction(context, message) : undefined;
    if (item) {
      bytes += Buffer.byteLength(JSON.stringify(item));
      if (bytes > MAX_CODEX_REQUEST_REPLAY_BYTES) throw compactionError('POOL_CODEX_COMPACTION_BUDGET_EXCEEDED');
      result.push(message);
      continue;
    }
    const identity = own(message, 'id') ?? message;
    if (active.has(identity) || typeof resolveCompactionHistory !== 'function') throw compactionError('POOL_CODEX_COMPACTION_HISTORY_UNAVAILABLE');
    const restored = resolveCompactionHistory(message, options);
    if (!Array.isArray(restored) || restored.length === 0) throw compactionError('POOL_CODEX_COMPACTION_HISTORY_UNAVAILABLE');
    active.add(identity);
    stack.push({ list: restored, index: 0, identity });
  }
  return result;
}

const count = value => Number.isFinite(value) && value >= 0 ? value : 0;
/** HTTP SSE and WS frames share the same successful-terminal contract. */
export async function* mapCodexCompaction(body, parseSse, context, streamError = () => compactionError()) {
  if (!context?.scope || !context.replayCodec) throw compactionError('POOL_CODEX_REPLAY_KEY_UNAVAILABLE');
  const outputs = new Map(), ids = new Map();
  const accept = (event) => {
    const raw = event.item;
    if (!['compaction', 'compaction_summary'].includes(raw?.type)) return;
    const item = nativeItem(raw);
    if (!item || raw.status !== undefined && raw.status !== 'completed') throw compactionError();
    if (event.output_index !== undefined && (!Number.isSafeInteger(event.output_index) || event.output_index < 0)) throw compactionError();
    const key = event.output_index !== undefined ? `output:${event.output_index}` : raw.id ? ids.get(raw.id) ?? `id:${raw.id}` : undefined;
    if (key === undefined) throw compactionError();
    const previous = outputs.get(key);
    if (previous && !isDeepStrictEqual(previous, item)) throw compactionError();
    outputs.set(key, item);
    if (raw.id) ids.set(raw.id, key);
    if (outputs.size > 1) throw compactionError('POOL_CODEX_COMPACTION_OUTPUT_COUNT');
  };
  for await (const data of parseSse(body)) {
    context.signal?.throwIfAborted();
    if (data === '[DONE]') break;
    let event;
    try { event = JSON.parse(data); } catch { throw compactionError(); }
    if (!event || typeof event.type !== 'string') throw compactionError();
    if (['error', 'response.failed', 'response.incomplete', 'response.cancelled', 'response.canceled'].includes(event.type)) throw streamError(event.type, event);
    if (event.type === 'response.output_item.done') accept(event);
    if (!['response.completed', 'response.done'].includes(event.type)) continue;
    const response = event.response;
    if (!response || response.error || response.incomplete_details || response.status !== undefined && response.status !== 'completed'
      || event.type === 'response.done' && response.status !== 'completed') throw streamError('CODEX_INVALID_TERMINAL', event);
    if (response.output !== undefined) {
      if (!Array.isArray(response.output)) throw compactionError();
      const compacted = response.output.filter(item => ['compaction', 'compaction_summary'].includes(item?.type));
      if (compacted.length !== 1) throw compactionError('POOL_CODEX_COMPACTION_OUTPUT_COUNT');
      const terminal = nativeItem(compacted[0]);
      if (!terminal || [...outputs.values()].some(item => !isDeepStrictEqual(item, terminal))) throw compactionError();
      outputs.clear();
      accept({ item: compacted[0], output_index: response.output.indexOf(compacted[0]) });
    }
    if (outputs.size !== 1) throw compactionError('POOL_CODEX_COMPACTION_OUTPUT_COUNT');
    context.signal?.throwIfAborted();
    const item = [...outputs.values()][0];
    const sealed = context.replayCodec.seal(context.scope, { kind: CODEX_COMPACTION_KIND, text: CODEX_COMPACTION_TEXT, item,
      retainedInput: context.compactionRetainedInput ?? [] });
    if (!sealed) throw compactionError('POOL_CODEX_COMPACTION_BUDGET_EXCEEDED');
    const usage = response.usage ?? {}, cacheReadTokens = count(usage.input_tokens_details?.cached_tokens);
    yield { type: 'usage', usage: { inputTokens: Math.max(0, count(usage.input_tokens) - cacheReadTokens),
      outputTokens: count(usage.output_tokens), cacheReadTokens, cacheWriteTokens: 0, reasoningTokens: count(usage.output_tokens_details?.reasoning_tokens) } };
    context.signal?.throwIfAborted();
    yield { type: 'finish', reason: { kind: 'stop' }, replayState: { response: {
      kind: CODEX_COMPACTION_KIND, version: CODEX_COMPACTION_VERSION, scope: context.scope, sealed,
    } } };
    return;
  }
  throw streamError('CODEX_STREAM_TRUNCATED');
}
