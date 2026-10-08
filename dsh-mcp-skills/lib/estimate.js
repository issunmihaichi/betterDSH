/**
 * Token pricing — the same three formulas `dsh-context-window` prices with.
 *
 * Provenance: `@deepseek-ai/dsh-token-meter/estimate` (as shipped in this DSH
 * build), copied verbatim — constants included — by way of
 * `dsh-context-window/lib/estimate.js`, which copied it first. A Host plugin
 * cannot import a DSH package by bare specifier (the Loader resolves plugin
 * imports from the profile, not from inside `app.asar`), and this plugin does
 * not import a sibling plugin's module either: a copy plus an assertion is the
 * cheaper coupling. `tools/estimate-parity-test.mjs` imports BOTH copies and
 * fails if any formula, constant or golden value drifts apart, which is what
 * keeps "MCP server costs ~X here" equal to the same server's cost on the
 * context-window panel.
 *
 * Only the tool-schema path is used here (`estimateToolsTokens`), priced over a
 * one-element array exactly the way the context panel prices a single tool, so
 * the two per-server numbers are the same arithmetic.
 */

/** Fixed text-density estimate used until exact tokenization is needed. */
export const CHARS_PER_TOKEN = 4;
/** Per-block structural overhead for JSON framing and type tags. */
export const BLOCK_OVERHEAD = 4;
/** Role-field framing overhead added to every priced message. */
export const ROLE_OVERHEAD = 4;

/**
 * Price plain text at the fixed density.
 * @param text - text to price.
 * @returns heuristic tokens (0 for empty text).
 */
export function estimateText(text) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  return value.length === 0 ? 0 : Math.ceil(value.length / CHARS_PER_TOKEN);
}

/**
 * Price content blocks recursively, including per-block structural overhead.
 * @param blocks - content blocks to price.
 * @returns heuristic tokens.
 */
export function estimateContent(blocks) {
  let tokens = 0;
  for (const block of Array.isArray(blocks) ? blocks : []) {
    switch (block?.type) {
      case 'text':
      case 'reasoning':
        tokens += estimateText(block.text) + BLOCK_OVERHEAD;
        break;
      case 'tool-call':
        tokens += estimateText(block.name) + estimateText(block.arguments) + BLOCK_OVERHEAD;
        break;
      default:
        // Unknown (merge-extensible) blocks keep a conservative structural price.
        tokens += BLOCK_OVERHEAD + estimateText(JSON.stringify(block ?? null));
    }
  }
  return tokens;
}

/**
 * Price the tool-schema part of a canonical request envelope — the envelope's
 * only priced field, since the system prompt is a surface node.
 * @param tools - tool schemas.
 * @returns heuristic tool-schema tokens; 0 when absent or empty.
 */
export function estimateToolsTokens(tools) {
  const list = Array.isArray(tools) ? tools : [];
  if (list.length === 0) return 0;
  return estimateText(JSON.stringify(list)) + BLOCK_OVERHEAD;
}

/**
 * Price one model-visible message the way DSH does: a system-role message prices
 * its text as prose, every other role prices its blocks plus role framing.
 * @param message - message to price.
 * @returns heuristic tokens.
 */
export function estimateMessage(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  if (message?.role === 'system') {
    if (content.length === 0) return 0;
    let characters = 0;
    for (const block of content) {
      characters += block?.type === 'text' ? String(block.text ?? '').length : JSON.stringify(block ?? null).length;
    }
    return Math.ceil(characters / CHARS_PER_TOKEN) + ROLE_OVERHEAD;
  }
  return estimateContent(content) + ROLE_OVERHEAD;
}
