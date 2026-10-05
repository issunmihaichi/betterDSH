/**
 * Token pricing — a faithful local copy of DSH's own estimator.
 *
 * Provenance: `@deepseek-ai/dsh-token-meter/estimate` (as shipped in this DSH
 * build). A Host plugin cannot import a DSH package by bare specifier — the
 * Loader resolves plugin imports from the profile, not from inside `app.asar` —
 * so the three formulas are copied here verbatim, constants included. They are
 * the same numbers the official `contextBreakdown` projection uses, which is why
 * `tools.total` can be compared directly with the bucket it splits.
 *
 * Fidelity is self-checking at runtime: the Browser half normalizes every split
 * onto the live official totals, so even a future change to DSH's constants can
 * only shift the *proportions* of a split, never the totals the panel reports.
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
