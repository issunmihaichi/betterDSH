/**
 * System-payload module — the part that is NOT "prepend a banner".
 *
 * It is tempting to make a request look official by pushing the identity banner in
 * front of the caller's system prompt. sub2api's own comment says why that fails:
 * detection reads the `system` parameter as a whole, so leaving the caller's
 * non-CLI text behind the banner still reads as a third-party client.
 *
 * So the caller's text is MOVED rather than prefixed: it is migrated into the
 * message history as a user turn plus an assistant acknowledgement, and `system`
 * is rebuilt to contain exactly the three blocks the CLI sends. The instructions
 * still reach the model — from the first user turn instead of the system
 * parameter.
 */
import {
  CLAUDE_CODE_PROMPT_PREFIXES,
  DEFAULT_CACHE_TTL,
  EXPANSION_PROMPT,
  IDENTITY_BANNER,
  SYSTEM_MIGRATION_ACK,
  SYSTEM_MIGRATION_PREFIX,
} from './constants.js';

/**
 * The three `system` blocks, in the CLI's order:
 *
 *   [0] billing attribution — no `cache_control`, exactly as the CLI sends it;
 *   [1] identity banner     — no `cache_control` either: it is the identity
 *                             prefix, not a cache boundary;
 *   [2] generic expansion   — carries the cache breakpoint, because the prompt
 *                             cache prefix must stay stable across turns.
 *
 * @param billingText - the block produced by the billing module.
 */
export function buildSystemBlocks(billingText) {
  return [
    { type: 'text', text: billingText },
    { type: 'text', text: IDENTITY_BANNER },
    { type: 'text', text: EXPANSION_PROMPT, cache_control: { type: 'ephemeral', ttl: DEFAULT_CACHE_TTL } },
  ];
}

/** The caller's system text, whether it arrived as a bare string or as blocks. */
export function extractSystemText(system) {
  if (typeof system === 'string') return system.trim();
  if (!Array.isArray(system)) return '';
  return system
    .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter((text) => text !== '')
    .join('\n\n')
    .trim();
}

/**
 * The caller's own cache breakpoint, if it set one on its system text.
 *
 * `cache_control` is a BILLING-relevant field: dropping it turns the caller's
 * cached prefix into a full-price prefix on every turn. sub2api keeps the LAST
 * breakpoint found, because the system blocks are collapsed into one message
 * text and the last breakpoint is then the closest equivalent boundary.
 */
export function extractSystemCacheControl(system) {
  if (!Array.isArray(system)) return undefined;
  let found;
  for (const block of system) {
    if (block?.type !== 'text') continue;
    if (block.cache_control === undefined || block.cache_control === null) continue;
    found = block.cache_control;
  }
  return found;
}

/**
 * Whether a text already opens with a first-party Claude Code banner.
 *
 * The CLI does not ship one banner but four variants (standard CLI, Agent SDK,
 * Explore Agent, compact/summarise agent), so this is a PREFIX test rather than
 * an equality test. Treating an Agent SDK request as "foreign" would inject a
 * `[System Instructions]` turn that the real CLI never sends — the exact kind of
 * self-contradiction this group exists to avoid.
 */
export function hasClaudeCodePrefix(text) {
  if (typeof text !== 'string' || text === '') return false;
  return CLAUDE_CODE_PROMPT_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/**
 * Whether the caller's text needs migrating at all.
 *
 * Empty text needs nothing, and a system that ALREADY is first-party Claude Code
 * must not gain a bogus user turn — that happens when a caller is itself a
 * Claude Code client (or the Agent SDK) pointed at this pool, which is a
 * legitimate setup rather than an error.
 */
export function shouldMigrateSystem(text) {
  return text !== '' && !hasClaudeCodePrefix(text);
}

/**
 * The user/assistant pair that carries the migrated instructions.
 *
 * `cacheControl` travels with the text: the instructions still occupy the same
 * position in the prompt, so the caller's breakpoint keeps working instead of
 * being silently dropped (and re-billed at full price every turn).
 */
export function systemMigrationMessages(text, cacheControl) {
  const block = { type: 'text', text: `${SYSTEM_MIGRATION_PREFIX}${text}` };
  if (cacheControl !== undefined && cacheControl !== null) block.cache_control = cacheControl;
  return [
    { role: 'user', content: [block] },
    { role: 'assistant', content: [{ type: 'text', text: SYSTEM_MIGRATION_ACK }] },
  ];
}

/** The system stage. */
export const systemModule = {
  name: 'system',
  purpose: 'rebuild system as the CLI three-block array and migrate the caller text into the history',
  apply(plan) {
    const body = plan.body;
    const original = extractSystemText(body.system);
    const cacheControl = extractSystemCacheControl(body.system);

    body.system = buildSystemBlocks(plan.billingText);

    if (shouldMigrateSystem(original)) {
      body.messages = [...systemMigrationMessages(original, cacheControl), ...(Array.isArray(body.messages) ? body.messages : [])];
    }
    plan.migratedSystem = shouldMigrateSystem(original);
  },
};
