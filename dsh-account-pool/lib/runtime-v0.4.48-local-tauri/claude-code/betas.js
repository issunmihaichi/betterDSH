/**
 * Beta-token module.
 *
 * The `anthropic-beta` set is a load-bearing signal, not a feature list: the
 * upstream decides whether a request came from the official client partly from
 * the complete set of betas only that client sends. sub2api's comment records the
 * consequence of getting it wrong — omit one and the request is billed against
 * "extra usage" instead of the plan's limits.
 */
import { CONTEXT_MANAGEMENT_BETA } from './constants.js';

/**
 * Every beta the official CLI sends, in capture order (sub2api
 * `FullClaudeCodeMimicryBetas`). Used for OAuth accounts, where the whole
 * official set is what keeps the request on plan limits.
 */
export const FULL_MIMICRY_BETAS = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'prompt-caching-scope-2026-01-05',
  'effort-2025-11-24',
  CONTEXT_MANAGEMENT_BETA,
  'thinking-binding-controls-2026-08-01',
  'mid-conversation-output-config-2026-07-01',
  'extended-cache-ttl-2025-04-11',
];

/**
 * What an API-key account should send when mimicking (sub2api
 * `APIKeyBetaHeader`): the Claude Code set WITHOUT `oauth-*`, which is only valid
 * for OAuth credentials.
 */
export const API_KEY_MIMICRY_BETAS = [
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
  'fine-grained-tool-streaming-2025-05-14',
];

/** The single beta an OAuth account needs even when it is NOT mimicking. */
export const OAUTH_ONLY_BETA = 'oauth-2025-04-20';

/**
 * The extra tokens one account declares, normalized.
 *
 * `account.betas` is an operator-owned list, so it is filtered rather than
 * trusted: an empty or non-string entry would otherwise reach the header as
 * `,,` and make the whole set meaningless to the upstream.
 *
 * @returns a fresh array of non-empty, trimmed tokens (possibly empty).
 */
export function accountExtraBetas(account) {
  const list = Array.isArray(account?.betas) ? account.betas : [];
  const out = [];
  for (const token of list) {
    if (typeof token !== 'string') continue;
    const trimmed = token.trim();
    if (trimmed === '' || out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
}

/**
 * The comma-joined `anthropic-beta` value for one auth mode.
 *
 * @param authMode - `'oauth'` or `'api-key'`.
 * @param extraBetas - per-account additions (see {@link accountExtraBetas});
 *   appended AFTER the auth mode's own set, and only when not already present.
 *   The base set stays intact and first, so an account that declares nothing
 *   sends byte-for-byte what it sent before this parameter existed.
 */
export function betaHeaderFor(authMode, extraBetas = []) {
  const tokens = [...(authMode === 'oauth' ? FULL_MIMICRY_BETAS : API_KEY_MIMICRY_BETAS)];
  for (const token of extraBetas) {
    if (!tokens.includes(token)) tokens.push(token);
  }
  return tokens.join(',');
}

/** The beta stage: pick the set this account's auth mode is entitled to claim. */
export const betasModule = {
  name: 'betas',
  purpose: 'select the anthropic-beta set for this account auth mode',
  apply(plan) {
    plan.betas = betaHeaderFor(plan.account?.authMode, accountExtraBetas(plan.account));
  },
};
