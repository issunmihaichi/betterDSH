/**
 * Model recognition for the group.
 *
 * Only the facts the disguise needs: which model ids REJECT a field that the CLI
 * would otherwise always send. This is a property of the upstream model, not of
 * the caller or the account, so it lives in its own leaf module with no imports
 * — the same reason `constants.js` and `hash.js` are leaves.
 */

/**
 * Matches the Opus 5.5 family in every id shape the upstream sees:
 * `claude-opus-5-5`, `claude-opus-5-5-thinking`, `anthropic/claude-opus-5.5`.
 *
 * The trailing guard is what keeps it honest: a model that merely starts with
 * the same digits (`claude-opus-5-50`) must not match, because guessing here
 * would silently drop a field for a model that accepts it.
 */
const OPUS_55_RE = /(?:^|[^a-z0-9])opus[-_.]?5[-_.]?5(?:$|[^0-9])/;

/**
 * Whether this model is an Opus 5.5 class model.
 *
 * Those models reject `temperature`, so the real CLI omits the field for them —
 * which means a disguise that fills `temperature: 1` unconditionally turns a
 * faithful request into a 400. The defaults module consults this before filling.
 */
export function isOpus55(model) {
  if (typeof model !== 'string' || model === '') return false;
  return OPUS_55_RE.test(model.toLowerCase());
}
