/**
 * Allow-listed pool StreamChunk -> OpenAI Responses JSON/events projection.
 * Wire types: https://github.com/openai/openai-node/blob/master/src/resources/responses/responses.ts
 * Stable baseline: https://github.com/openai/openai-node/blob/v4.104.0/src/resources/responses/responses.ts
 * No transport, SSE framing, persistence, native replay or account identity lives here.
 */
import { randomUUID } from 'node:crypto';
import { LocalApiError } from './local-api-protocol.js';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_BLOCKS = 4096;
const BLOCK_TYPES = new Set(['text', 'reasoning', 'tool-call']);
const FINISH_REASONS = new Map([
  ['stop', null], ['tool-calls', null],
  ['max-tokens', 'max_output_tokens'], ['content-filter', 'content_filter'],
]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uid = prefix => `${prefix}${randomUUID().replaceAll('-', '')}`;
const protocolError = () => { throw new LocalApiError(502, 'upstream_protocol_error', 'The upstream returned an incomplete or unsupported response.'); };
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x20\x7f]/.test(value);
const functionName = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const counter = value => Number.isSafeInteger(value) && value >= 0;
const outputText = text => ({ type: 'output_text', text, annotations: [] });
const summaryText = text => ({ type: 'summary_text', text });

/** Only public request metadata may be echoed; never spread caller options. */
function publicOptions(options) {
  const out = {};
  if (!object(options)) return out;
  if (Number.isSafeInteger(options.max_output_tokens) && options.max_output_tokens > 0) out.max_output_tokens = options.max_output_tokens;
  if (Number.isFinite(options.temperature) && options.temperature >= 0 && options.temperature <= 2) out.temperature = options.temperature;
  if (['auto', 'none'].includes(options.tool_choice)) out.tool_choice = options.tool_choice;
  if (options.parallel_tool_calls === true) out.parallel_tool_calls = true;
  if (object(options.text) && object(options.text.format) && options.text.format.type === 'text') out.text = { format: { type: 'text' } };
  if (object(options.reasoning)) {
    const reasoning = {};
    if (['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(options.reasoning.effort)) reasoning.effort = options.reasoning.effort === 'off' ? 'none' : options.reasoning.effort;
    if (['auto', 'concise', 'detailed'].includes(options.reasoning.summary)) reasoning.summary = options.reasoning.summary;
    if (Object.keys(reasoning).length) out.reasoning = reasoning;
  }
  if (Array.isArray(options.tools) && options.tools.length <= 128) {
    out.tools = options.tools.map(tool => {
      if (!object(tool) || tool.type !== 'function' || !functionName(tool.name)) protocolError();
      const projected = { type: 'function', name: tool.name };
      if (typeof tool.description === 'string') projected.description = tool.description;
      if (tool.parameters === null || object(tool.parameters)) projected.parameters = structuredClone(tool.parameters);
      if (tool.strict === false || tool.strict === null) projected.strict = tool.strict;
      return projected;
    });
  }
  return out;
}

/**
 * start() is optional for JSON, and must precede consume() when streaming. Its
 * first call returns created/in_progress; subsequent calls return []. consume()
 * never implicitly starts or completes a response. Call complete() ONLY after
 * the upstream iterator is exhausted, even if finish was already consumed.
 *
 * Text/reasoning blocks publish immediately. Tools publish only at block-end,
 * once name/id/full JSON-object arguments are available. output_index follows
 * first publication (not a buffered tool's start); one item per native block,
 * content_index/summary_index always 0. Every mapping is stable after publication.
 *
 * failure() accepts publicError(error).body, NOT a raw Error or upstream body.
 * It returns one response.failed event and keeps only already-published content.
 */
export function createResponsesOutput(model, responseOptions = {}) {
  if (!identifier(model)) protocolError();
  const metadata = publicOptions(responseOptions);
  const base = { id: uid('resp_'), object: 'response', created_at: Math.floor(Date.now() / 1000), model, ...metadata, store: false };
  const blocks = new Map(), published = [], callIds = new Set();
  const counts = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  let bytes = 0, sequence = 0, started = false, touched = false;
  let finish, inputReported = false, outputReported = false, broken = false, terminal;

  function addBytes(text) {
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_BYTES) throw new LocalApiError(502, 'response_too_large', 'The upstream response exceeded the local safety limit.');
  }
  // Bound echoed schema/metadata as well as retained public output.
  addBytes(JSON.stringify(base));
  function event(type, fields) { return structuredClone({ type, sequence_number: sequence++, ...fields }); }
  function usage() {
    if (!inputReported || !outputReported) return null;
    // Pool usage buckets are disjoint; optional buckets are 0 by StreamUsage
    // convention (kernel.accumulateUsage), not estimates inferred from text.
    const input = counts.inputTokens + counts.cacheReadTokens + counts.cacheWriteTokens;
    const total = input + counts.outputTokens;
    if (!counter(input) || !counter(total) || counts.reasoningTokens > counts.outputTokens) protocolError();
    return { input_tokens: input, input_tokens_details: { cached_tokens: counts.cacheReadTokens },
      output_tokens: counts.outputTokens, output_tokens_details: { reasoning_tokens: counts.reasoningTokens }, total_tokens: total };
  }
  function snapshot(status, { error = null, incomplete = null } = {}) {
    return structuredClone({ ...base, status, output: published.map(state => state.item), error,
      incomplete_details: incomplete === null ? null : { reason: incomplete }, usage: usage() });
  }
  function active() { if (terminal !== undefined || broken) protocolError(); }
  function guarded(operation) {
    try { return operation(); } catch (error) { broken = true; throw error; }
  }
  function blockAt(index, type) {
    if (!Number.isSafeInteger(index) || index < 0 || !BLOCK_TYPES.has(type)) protocolError();
    let state = blocks.get(index);
    if (state === undefined) {
      if (blocks.size >= MAX_BLOCKS) protocolError();
      state = { type, text: '', arguments: '', ended: false, explicitStart: false, item: null };
      blocks.set(index, state);
    }
    if (state.type !== type || state.ended) protocolError();
    return state;
  }
  function publish(state, events) {
    if (state.item !== null) return;
    state.outputIndex = published.length;
    state.item = state.type === 'text'
      ? { id: uid('msg_'), type: 'message', status: 'in_progress', role: 'assistant', content: [] }
      : state.type === 'reasoning'
        ? { id: uid('rs_'), type: 'reasoning', status: 'in_progress', summary: [] }
        : { id: uid('fc_'), type: 'function_call', status: 'in_progress', call_id: state.callId, name: state.name, arguments: '' };
    published.push(state);
    events.push(event('response.output_item.added', { output_index: state.outputIndex, item: state.item }));
    if (state.type !== 'tool-call') {
      const reasoning = state.type === 'reasoning';
      const part = reasoning ? summaryText('') : outputText('');
      (reasoning ? state.item.summary : state.item.content).push(part);
      events.push(event(reasoning ? 'response.reasoning_summary_part.added' : 'response.content_part.added', {
        ...location(state), [reasoning ? 'summary_index' : 'content_index']: 0, part,
      }));
    }
  }
  function location(state) { return { item_id: state.item.id, output_index: state.outputIndex }; }
  function append(state, text, events) {
    if (typeof text !== 'string') protocolError();
    addBytes(text);
    publish(state, events);
    state.text += text;
    const reasoning = state.type === 'reasoning';
    (reasoning ? state.item.summary : state.item.content)[0].text = state.text;
    if (text !== '') events.push(event(reasoning ? 'response.reasoning_summary_text.delta' : 'response.output_text.delta', {
      ...location(state), [reasoning ? 'summary_index' : 'content_index']: 0, delta: text, ...(reasoning ? {} : { logprobs: [] }),
    }));
  }
  function closeText(state, events, status = 'completed') {
    publish(state, events);
    const reasoning = state.type === 'reasoning';
    const where = { ...location(state), [reasoning ? 'summary_index' : 'content_index']: 0 };
    events.push(event(reasoning ? 'response.reasoning_summary_text.done' : 'response.output_text.done', { ...where, text: state.text, ...(reasoning ? {} : { logprobs: [] }) }));
    events.push(event(reasoning ? 'response.reasoning_summary_part.done' : 'response.content_part.done', {
      ...where, part: reasoning ? summaryText(state.text) : outputText(state.text),
    }));
    state.item.status = status;
    state.ended = true;
    events.push(event('response.output_item.done', { output_index: state.outputIndex, item: state.item }));
  }
  function toolId(state, id) {
    if (!identifier(id) || state.callId !== undefined && state.callId !== id) protocolError();
    if (state.callId === undefined) { addBytes(id); state.callId = id; }
  }
  function consumeChunk(chunk) {
    active(); touched = true;
    if (!object(chunk)) protocolError();
    if (chunk.type === 'usage') {
      if (chunk.usage === null) return [];
      if (!object(chunk.usage)) protocolError();
      for (const key of Object.keys(counts)) {
        if (chunk.usage[key] === undefined) continue;
        if (!counter(chunk.usage[key]) || !counter(counts[key] + chunk.usage[key])) protocolError();
        counts[key] += chunk.usage[key];
        if (key === 'inputTokens') inputReported = true;
        if (key === 'outputTokens') outputReported = true;
      }
      return [];
    }
    if (finish !== undefined) protocolError();
    const events = [];
    switch (chunk.type) {
      case 'block-start': {
        const state = blockAt(chunk.index, chunk.blockType);
        if (state.explicitStart) protocolError();
        state.explicitStart = true;
        if (state.type !== 'tool-call') publish(state, events);
        break;
      }
      case 'text-delta': case 'reasoning-delta':
        append(blockAt(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning'), chunk.text, events);
        break;
      case 'tool-call-delta': {
        const state = blockAt(chunk.index, 'tool-call');
        if (chunk.id !== undefined) toolId(state, chunk.id);
        if (chunk.argumentsDelta !== undefined) {
          if (typeof chunk.argumentsDelta !== 'string') protocolError();
          addBytes(chunk.argumentsDelta); state.arguments += chunk.argumentsDelta;
        }
        break;
      }
      case 'block-end': {
        if (!object(chunk.block)) protocolError();
        const block = chunk.block, state = blockAt(chunk.index, block.type);
        if (state.type === 'tool-call') {
          toolId(state, block.id);
          if (!functionName(block.name) || typeof block.arguments !== 'string' || !block.arguments.startsWith(state.arguments) || callIds.has(state.callId)) protocolError();
          addBytes(block.name); addBytes(block.arguments.slice(state.arguments.length));
          let args;
          try { args = JSON.parse(block.arguments); } catch { protocolError(); }
          if (!object(args)) protocolError();
          state.name = block.name; state.arguments = block.arguments; callIds.add(state.callId);
          publish(state, events);
          state.item.arguments = state.arguments;
          if (state.arguments !== '') events.push(event('response.function_call_arguments.delta', { ...location(state), delta: state.arguments }));
          events.push(event('response.function_call_arguments.done', { ...location(state), arguments: state.arguments }));
          state.item.status = 'completed'; state.ended = true;
          events.push(event('response.output_item.done', { output_index: state.outputIndex, item: state.item }));
        } else {
          if (typeof block.text !== 'string' || !block.text.startsWith(state.text)) protocolError();
          append(state, block.text.slice(state.text.length), events);
          closeText(state, events);
        }
        break;
      }
      case 'finish':
        if (!object(chunk.reason) || !FINISH_REASONS.has(chunk.reason.kind)) protocolError();
        finish = chunk.reason.kind;
        break;
      default: protocolError();
    }
    return events;
  }
  return {
    start() {
      if (started) return [];
      return guarded(() => {
        active();
        if (touched) protocolError();
        started = true;
        return [event('response.created', { response: snapshot('in_progress') }), event('response.in_progress', { response: snapshot('in_progress') })];
      });
    },
    consume(chunk) { return guarded(() => consumeChunk(chunk)); },
    complete() {
      return guarded(() => {
        if (terminal?.kind === 'success') return { response: structuredClone(terminal.response), events: [] };
        active();
        if (finish === undefined || [...blocks.values()].some(state => state.type === 'tool-call' && !state.ended)
          || finish === 'tool-calls' && !callIds.size) protocolError();
        const incomplete = FINISH_REASONS.get(finish), status = incomplete === null ? 'completed' : 'incomplete';
        // Validate counters before emitting any final item/response events.
        usage();
        const events = [];
        for (const state of blocks.values()) if (!state.ended) closeText(state, events, status);
        const response = snapshot(status, { incomplete });
        events.push(event(incomplete === null ? 'response.completed' : 'response.incomplete', { response }));
        terminal = { kind: 'success', response: structuredClone(response) };
        return { response, events };
      });
    },
    failure(safeErrorBody) {
      if (terminal !== undefined) protocolError();
      // These are publicError's already-sanitized strings, never Error.message.
      const safe = object(safeErrorBody) && object(safeErrorBody.error) ? safeErrorBody.error : null;
      const error = { code: safe?.code === 'rate_limit_exceeded' ? 'rate_limit_exceeded' : safe?.type === 'invalid_request_error' ? 'invalid_prompt' : 'server_error',
        message: typeof safe?.message === 'string' && safe.message.length <= 2048 ? safe.message : 'The upstream request failed.' };
      for (const state of published) if (state.item.status === 'in_progress') state.item.status = 'incomplete';
      // A malformed usage report must not prevent sending the sanitized failure.
      let response;
      try { response = snapshot('failed', { error }); }
      catch { inputReported = false; response = snapshot('failed', { error }); }
      terminal = { kind: 'failure' };
      return event('response.failed', { response });
    },
  };
}
