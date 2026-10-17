/** Stateless, allow-listed Responses ingress. No remote files, opaque state or raw errors. */
import { LocalApiError, parseChatRequest } from './local-api-protocol.js';

const invalid = message => { throw new LocalApiError(400, 'invalid_request', message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value, allowed, label) {
  if (!object(value)) invalid(`${label} must be an object.`);
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid(`${label} contains an unsupported field.`);
}
function identifier(value, label) {
  if (typeof value !== 'string' || !value.length || value.length > 256 || /[\x00-\x20\x7f]/.test(value)) invalid(`${label} must be a nonempty identifier.`);
  return value;
}
function functionName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) invalid('Function names must contain 1–64 letters, numbers, underscores or hyphens.');
  return value;
}
function itemMetadata(item) {
  if (item.id !== undefined) identifier(item.id, 'Item id');
  if (item.status !== undefined && !['in_progress', 'completed', 'incomplete'].includes(item.status)) invalid('Unsupported input item status.');
}

/** Translate only public content; canonical image data validation is shared with Chat. */
function content(value, role) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || !value.length) invalid('Content must be text or a nonempty array of supported content parts.');
  return value.map(part => {
    if (part?.type === 'input_text' || part?.type === 'output_text' && role === 'assistant') {
      const output = part.type === 'output_text';
      keys(part, output ? ['type', 'text', 'annotations', 'logprobs'] : ['type', 'text'], 'Text content');
      if (typeof part.text !== 'string') invalid('Text content requires a string.');
      // Empty display metadata is common when replaying response.output verbatim.
      if (part.annotations !== undefined && (!Array.isArray(part.annotations) || part.annotations.length)) invalid('Nonempty output text annotations cannot be replayed.');
      if (part.logprobs !== undefined && part.logprobs !== null && (!Array.isArray(part.logprobs) || part.logprobs.length)) invalid('Output text logprobs cannot be replayed.');
      return { type: 'text', text: part.text };
    }
    if (part?.type === 'input_image' && ['user', 'tool'].includes(role)) {
      keys(part, ['type', 'image_url', 'detail'], 'Image content');
      if (typeof part.image_url !== 'string') invalid('Images require inline image data URLs; file ids and remote images are unsupported.');
      if (part.detail !== undefined && part.detail !== 'auto') invalid('Only image detail auto is supported.');
      return { type: 'image_url', image_url: { url: part.image_url, ...(part.detail === undefined ? {} : { detail: part.detail }) } };
    }
    invalid('Unsupported Responses content type or image role.');
  });
}

function history(input, instructions) {
  const messages = [], calls = new Map(), results = new Set();
  let conversationStarted = false;
  if (instructions !== undefined) {
    if (typeof instructions !== 'string') invalid('instructions must be text.');
    messages.push({ role: 'system', content: instructions });
  }
  if (typeof input === 'string') return [...messages, { role: 'user', content: input }];
  if (!Array.isArray(input) || !input.length) invalid('input must be text or a nonempty array of supported items.');
  for (const item of input) {
    if (!object(item)) invalid('Input items must be objects.');
    if (item.type === undefined || item.type === 'message') {
      keys(item, ['type', 'role', 'content', 'id', 'status'], 'Message item');
      itemMetadata(item);
      if (!['system', 'developer', 'user', 'assistant'].includes(item.role)) invalid('Supported message roles are system, developer, user and assistant.');
      const system = item.role === 'system' || item.role === 'developer';
      if (system && conversationStarted) invalid('System and developer instructions must precede conversation items.');
      messages.push({ role: system ? 'system' : item.role, content: content(item.content, item.role) });
      if (!system) conversationStarted = true;
      continue;
    }
    conversationStarted = true;
    if (item.type === 'function_call') {
      keys(item, ['type', 'id', 'status', 'name', 'arguments', 'call_id'], 'Function call item');
      itemMetadata(item);
      const id = identifier(item.call_id, 'Function call id'), name = functionName(item.name);
      if (calls.has(id)) invalid('Function call ids must be unique.');
      calls.set(id, name);
      const call = { id, type: 'function', function: { name, arguments: item.arguments } };
      // Adjacent calls belong to the same assistant turn, including parallel calls.
      if (messages.at(-1)?.role === 'assistant') (messages.at(-1).tool_calls ??= []).push(call);
      else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
      continue;
    }
    if (item.type === 'function_call_output') {
      keys(item, ['type', 'id', 'status', 'call_id', 'output', 'name'], 'Function output item');
      itemMetadata(item);
      const id = identifier(item.call_id, 'Function output call id');
      if (!calls.has(id) || results.has(id)) invalid('Each function output must reference a preceding, unanswered function call.');
      if (item.name !== undefined && functionName(item.name) !== calls.get(id)) invalid('Function output name must match its function call.');
      results.add(id);
      messages.push({ role: 'tool', tool_call_id: id, content: content(item.output, 'tool') });
      continue;
    }
    if (item.type === 'reasoning') {
      keys(item, ['type', 'id', 'status', 'summary', 'encrypted_content'], 'Reasoning item');
      itemMetadata(item);
      if (item.encrypted_content !== undefined && item.encrypted_content !== null && item.encrypted_content !== '') invalid('Encrypted reasoning cannot be replayed by this stateless API.');
      if (!Array.isArray(item.summary)) invalid('Reasoning history requires an array of public summary parts.');
      const text = item.summary.map(part => {
        keys(part, ['type', 'text'], 'Reasoning summary');
        if (part.type !== 'summary_text' || typeof part.text !== 'string') invalid('Only public summary_text reasoning history is supported.');
        return part.text;
      }).join('\n');
      // This is visible client-supplied summary text, not private reasoning or state.
      if (text) messages.push({ role: 'assistant', content: `[Prior assistant reasoning summary]\n${text}` });
      continue;
    }
    invalid('Unsupported Responses input item type; item references and built-in tools are not supported.');
  }
  return messages;
}

function functionTools(value) {
  if (!Array.isArray(value) || value.length > 128) invalid('tools must be an array with at most 128 entries.');
  return value.map(tool => {
    keys(tool, ['type', 'name', 'description', 'parameters', 'strict'], 'Tool');
    if (tool.type !== 'function') invalid('Only flat Responses function tools are supported; built-in tools are unavailable.');
    const { type, ...fn } = tool;
    return { type, function: fn };
  });
}

function reasoning(value) {
  keys(value, ['effort', 'summary'], 'reasoning');
  if (value.effort === undefined || !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value.effort)) invalid('reasoning requires a supported explicit effort.');
  if (value.summary !== undefined && (value.summary !== 'auto' || value.effort === 'none')) invalid('Only reasoning summary auto with an enabled effort is supported.');
  return { effort: value.effort, ...(value.summary === undefined ? {} : { summary: value.summary }) };
}

/** Caller still injects routing, private session identity and AbortSignal separately. */
export function parseResponsesRequest(body) {
  keys(body, ['model', 'input', 'instructions', 'stream', 'tools', 'tool_choice', 'temperature', 'max_output_tokens', 'reasoning', 'store', 'previous_response_id', 'background', 'include', 'text'], 'Request');
  if (body.store !== undefined && body.store !== false) invalid('This stateless API only supports store=false.');
  if (body.previous_response_id !== undefined && body.previous_response_id !== null) invalid('previous_response_id is unavailable; replay the complete input history.');
  if (body.background !== undefined && body.background !== false) invalid('Only background=false is supported.');
  if (body.include !== undefined && (!Array.isArray(body.include) || body.include.length)) invalid('Nonempty include is unsupported; encrypted reasoning and other opaque state cannot be returned.');
  if (body.tool_choice !== undefined && !['auto', 'none'].includes(body.tool_choice)) invalid('Only tool_choice auto or none is supported.');
  if (body.text !== undefined) {
    keys(body.text, ['format'], 'text');
    keys(body.text.format, ['type'], 'text.format');
    if (body.text.format.type !== 'text') invalid('Only plain text output format is supported; structured output is unavailable.');
  }
  const requestedReasoning = body.reasoning === undefined ? undefined : reasoning(body.reasoning);
  const parsed = parseChatRequest({
    model: body.model,
    messages: history(body.input, body.instructions),
    ...(body.stream === undefined ? {} : { stream: body.stream }),
    ...(body.tools === undefined ? {} : { tools: functionTools(body.tools) }),
    ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
    ...(body.max_output_tokens === undefined ? {} : { max_completion_tokens: body.max_output_tokens }),
    ...(requestedReasoning === undefined ? {} : { reasoning_effort: requestedReasoning.effort }),
  });
  // Validate tools even with tool_choice=none, but never erase prior calls/results.
  if (body.tool_choice === 'none') delete parsed.options.tools;
  const responseOptions = {
    store: false,
    ...(body.max_output_tokens === undefined ? {} : { max_output_tokens: parsed.options.maxTokens }),
    ...(body.temperature === undefined ? {} : { temperature: parsed.options.temperature }),
    ...(requestedReasoning === undefined ? {} : { reasoning: requestedReasoning }),
    ...(body.text === undefined ? {} : { text: { format: { type: 'text' } } }),
    ...(body.tool_choice === undefined ? {} : { tool_choice: body.tool_choice }),
    ...(body.tools === undefined ? {} : { tools: (parsed.options.tools ?? []).map(tool => ({ type: 'function', ...tool, strict: false })) }),
  };
  return { stream: parsed.stream, hasImages: parsed.hasImages, options: parsed.options, responseOptions };
}
