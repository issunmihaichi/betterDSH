/** Pure, allow-listed OpenAI ingress/egress translation. Never serialize raw errors or chunks. */
import { randomUUID } from 'node:crypto';
import { accumulateUsage } from './kernel.js';

export class LocalApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const invalid = message => { throw new LocalApiError(400, 'invalid_request', message); };
const protocolError = () => { throw new LocalApiError(502, 'upstream_protocol_error', 'The upstream returned an incomplete or unsupported response.'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value, allowed, label) {
  if (!object(value)) invalid(`${label} must be an object.`);
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid(`${label} contains an unsupported field.`);
}
function identifier(value, label, max = 256) {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\x00-\x20\x7f]/.test(value)) invalid(`${label} must be a nonempty identifier.`);
  return value;
}
function functionName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) invalid('Function names must contain 1–64 letters, numbers, underscores or hyphens.');
  return value;
}
function contentParts(value, role) {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (role === 'assistant' && value == null) return [];
  if (!Array.isArray(value) || !value.length) invalid('Message content must be text or a nonempty array of supported content parts.');
  return value.map(part => {
    if (part?.type === 'text') {
      keys(part, ['type', 'text'], 'Text content');
      if (typeof part.text !== 'string') invalid('Text content requires a string.');
      return { type: 'text', text: part.text };
    }
    if (part?.type === 'image_url' && ['user', 'tool'].includes(role)) {
      keys(part, ['type', 'image_url'], 'Image content');
      keys(part.image_url, ['url', 'detail'], 'image_url');
      if (part.image_url.detail !== undefined && part.image_url.detail !== 'auto') invalid('Only image detail auto is supported.');
      const match = typeof part.image_url.url === 'string' && /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(part.image_url.url);
      if (!match || match[2].length % 4 || Buffer.from(match[2], 'base64').toString('base64') !== match[2]) invalid('Images require canonical base64 PNG, JPEG, WebP or GIF data URLs; remote URLs are not fetched.');
      return { type: 'image', mediaType: match[1], data: match[2] };
    }
    invalid('Unsupported message content type or image role.');
  });
}

/** Caller injects provider, private session identity and AbortSignal separately. */
export function parseChatRequest(body) {
  keys(body, ['model', 'messages', 'stream', 'stream_options', 'tools', 'tool_choice', 'temperature', 'max_tokens', 'max_completion_tokens', 'reasoning_effort', 'n'], 'Request');
  const model = identifier(body.model, 'model');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') invalid('stream must be boolean.');
  if (body.n !== undefined && body.n !== 1) invalid('Only n=1 is supported.');
  if (body.stream_options !== undefined) {
    keys(body.stream_options, ['include_usage'], 'stream_options');
    if (body.stream !== true || typeof body.stream_options.include_usage !== 'boolean') invalid('stream_options requires stream=true and a boolean include_usage.');
  }
  if (body.tool_choice !== undefined && body.tool_choice !== 'auto') invalid('Only automatic tool choice is supported.');
  if (body.temperature !== undefined && (!Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) invalid('temperature must be between 0 and 2.');
  if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) invalid('Specify only one token budget.');
  const maxTokens = body.max_completion_tokens !== undefined ? body.max_completion_tokens : body.max_tokens;
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 2147483647)) invalid('Token budget must be a positive 32-bit integer.');
  const effort = body.reasoning_effort === 'none' ? 'off' : body.reasoning_effort;
  if (effort !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) invalid('Unsupported reasoning_effort.');
  if (!Array.isArray(body.messages) || !body.messages.length) invalid('messages must be a nonempty array.');
  const messages = [], systems = [], calls = new Map(), results = new Set();
  for (const message of body.messages) {
    if (!object(message) || !['system', 'user', 'assistant', 'tool'].includes(message.role)) invalid('Supported roles are system, user, assistant and tool; developer role is not supported.');
    const allowed = message.role === 'assistant' ? ['role', 'content', 'tool_calls'] : message.role === 'tool' ? ['role', 'content', 'tool_call_id'] : ['role', 'content'];
    keys(message, allowed, 'Message');
    const content = contentParts(message.content, message.role);
    if (message.role === 'system') {
      if (messages.length) invalid('System instructions must precede conversation messages.');
      systems.push(content.map(part => part.text).join(''));
      continue;
    }
    if (message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls) || !message.tool_calls.length) invalid('tool_calls must be a nonempty array.');
      for (const call of message.tool_calls) {
        keys(call, ['id', 'type', 'function'], 'Tool call');
        if (call.type !== 'function') invalid('Only function tools are supported.');
        const id = identifier(call.id, 'Tool call id');
        if (calls.has(id)) invalid('Tool call ids must be unique.');
        keys(call.function, ['name', 'arguments'], 'Tool call function');
        const name = functionName(call.function.name);
        let args;
        try { args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : null; } catch { /* invalid JSON below */ }
        if (!object(args)) invalid('Tool call arguments must be a JSON object encoded as a string.');
        calls.set(id, name);
        content.push({ type: 'tool-call', id, name, arguments: call.function.arguments });
      }
    }
    if (message.role === 'tool') {
      const toolCallId = identifier(message.tool_call_id, 'tool_call_id');
      if (!calls.has(toolCallId) || results.has(toolCallId)) invalid('Each tool result must reference a preceding, unanswered tool call.');
      results.add(toolCallId);
      messages.push({ role: 'tool', toolCallId, toolName: calls.get(toolCallId), content });
    } else messages.push({ role: message.role, content });
  }
  if (!messages.length) invalid('At least one conversation message is required.');
  let tools;
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > 128) invalid('tools must be an array with at most 128 entries.');
    const names = new Set();
    tools = body.tools.map(tool => {
      keys(tool, ['type', 'function'], 'Tool');
      if (tool.type !== 'function') invalid('Only function tools are supported.');
      keys(tool.function, ['name', 'description', 'parameters', 'strict'], 'Tool function');
      const fn = tool.function, name = functionName(fn.name);
      if (names.has(name)) invalid('Function names must be unique.');
      names.add(name);
      if (fn.description !== undefined && typeof fn.description !== 'string') invalid('Function description must be text.');
      if (fn.strict !== undefined && fn.strict !== false) invalid('Strict structured tool output is not supported.');
      if (fn.parameters !== undefined && (!object(fn.parameters) || fn.parameters.type !== 'object')) invalid('Function parameters must be an object JSON Schema.');
      return { name, ...(fn.description === undefined ? {} : { description: fn.description }), parameters: fn.parameters ?? { type: 'object', properties: {} } };
    });
  }
  return {
    stream: body.stream === true, includeUsage: body.stream_options?.include_usage === true,
    hasImages: messages.some(message => message.content.some(part => part.type === 'image')),
    options: { model, messages, ...(systems.length ? { system: systems.join('\n\n') } : {}),
      ...(tools === undefined ? {} : { tools }), ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(body.temperature === undefined ? {} : { temperature: body.temperature }), ...(effort === undefined ? {} : { reasoningEffort: effort }) },
  };
}

/** Error strings from outside this module never cross the wire. */
export function publicError(error) {
  if (error instanceof LocalApiError) return { status: error.status, body: { error: { message: error.message, type: error.status < 500 ? 'invalid_request_error' : 'server_error', param: null, code: error.code } } };
  const unsupported = ['POOL_UNSUPPORTED_CONTENT', 'POOL_GEMINI_CAPABILITY_UNSUPPORTED'].includes(error?.code);
  const unavailable = ['POOL_EXHAUSTED', 'POOL_NO_UPSTREAM', 'POOL_NO_CREDENTIAL', 'POOL_CODEX_SPEED_UNAVAILABLE'].includes(error?.code) || error?.status === 429;
  return { status: unsupported ? 400 : unavailable ? 503 : 502, body: { error: {
    message: unsupported ? 'The selected pool transport does not support this request.' : unavailable ? 'The account pool is temporarily unavailable.' : 'The upstream request failed.',
    type: unsupported ? 'invalid_request_error' : 'server_error', param: null, code: unsupported ? 'unsupported_request' : unavailable ? 'pool_unavailable' : 'upstream_error',
  } } };
}

/** Stateful fold; only public text, tool calls and counters survive projection. */
export function createCompletion(model) {
  const base = { id: `chatcmpl-${randomUUID().replaceAll('-', '')}`, created: Math.floor(Date.now() / 1000), model };
  const blocks = new Map();
  let finish, usage = null, bytes = 0, toolIndex = 0;
  function addBytes(value) { bytes += Buffer.byteLength(value); if (bytes > 16 * 1024 * 1024) throw new LocalApiError(502, 'response_too_large', 'The upstream response exceeded the local safety limit.'); }
  function blockAt(index, type) {
    if (!Number.isSafeInteger(index) || index < 0 || index > 100000) protocolError();
    let state = blocks.get(index);
    if (!state) { if (blocks.size >= 4096) protocolError(); state = { type, text: '', arguments: '', ended: false, ...(type === 'tool-call' ? { toolIndex: toolIndex++ } : {}) }; blocks.set(index, state); }
    if (state.type !== type || state.ended) protocolError();
    return state;
  }
  function appendText(state, value) {
    if (typeof value !== 'string') protocolError();
    addBytes(value); state.text += value;
    return value ? { [state.type === 'reasoning' ? 'reasoning_content' : 'content']: value } : null;
  }
  function chunk(delta, finishReason = null) {
    return { ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finishReason }] };
  }
  function usageJson() {
    if (usage === null) return undefined;
    const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    return { prompt_tokens: prompt, completion_tokens: usage.outputTokens, total_tokens: prompt + usage.outputTokens,
      prompt_tokens_details: { cached_tokens: usage.cacheReadTokens }, completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } };
  }
  return {
    chunk,
    consume(value) {
      if (!object(value)) protocolError();
      if (value.type === 'usage') { usage = accumulateUsage(usage, value.usage); return []; }
      if (finish !== undefined) protocolError();
      switch (value.type) {
        case 'block-start':
          if (!['text', 'reasoning', 'tool-call'].includes(value.blockType)) protocolError();
          blockAt(value.index, value.blockType); return [];
        case 'text-delta': case 'reasoning-delta': {
          const delta = appendText(blockAt(value.index, value.type === 'text-delta' ? 'text' : 'reasoning'), value.text);
          return delta ? [delta] : [];
        }
        case 'tool-call-delta': {
          const state = blockAt(value.index, 'tool-call');
          if (value.argumentsDelta !== undefined) { if (typeof value.argumentsDelta !== 'string') protocolError(); addBytes(value.argumentsDelta); state.arguments += value.argumentsDelta; }
          return []; // Most pool transports reveal function name only at block-end.
        }
        case 'block-end': {
          const block = value.block;
          if (!object(block) || !['text', 'reasoning', 'tool-call'].includes(block.type)) protocolError();
          const state = blockAt(value.index, block.type);
          if (block.type === 'tool-call') {
            if (typeof block.id !== 'string' || !block.id || block.id.length > 256 || typeof block.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(block.name) || typeof block.arguments !== 'string' || !block.arguments.startsWith(state.arguments)) protocolError();
            addBytes(block.arguments.slice(state.arguments.length));
            state.call = { id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } }; state.ended = true;
            return [{ tool_calls: [{ index: state.toolIndex, ...state.call }] }];
          }
          if (typeof block.text !== 'string' || !block.text.startsWith(state.text)) protocolError();
          const delta = appendText(state, block.text.slice(state.text.length)); state.ended = true;
          return delta ? [delta] : [];
        }
        case 'finish': {
          const reasons = { stop: 'stop', 'max-tokens': 'length', 'tool-calls': 'tool_calls', 'content-filter': 'content_filter' };
          if (!Object.hasOwn(reasons, value.reason?.kind ?? '')) protocolError();
          finish = reasons[value.reason.kind]; return [];
        }
        default: protocolError();
      }
    },
    complete() {
      if (finish === undefined || [...blocks.values()].some(state => state.type === 'tool-call' && !state.ended)) protocolError();
      const calls = [...blocks.values()].filter(state => state.call).sort((a, b) => a.toolIndex - b.toolIndex).map(state => state.call);
      if (new Set(calls.map(call => call.id)).size !== calls.length || finish === 'tool_calls' && !calls.length) protocolError();
      const text = [...blocks.values()].filter(state => state.type === 'text').map(state => state.text).join('');
      const reasoning = [...blocks.values()].filter(state => state.type === 'reasoning').map(state => state.text).join('');
      const message = { role: 'assistant', content: text || (calls.length ? null : ''), ...(reasoning ? { reasoning_content: reasoning } : {}), ...(calls.length ? { tool_calls: calls } : {}) };
      return { ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finish }], ...(usage === null ? {} : { usage: usageJson() }) };
    },
    usageChunk() { return { ...base, object: 'chat.completion.chunk', choices: [], usage: usageJson() ?? null }; },
  };
}
