/**
 * Field-defaults module.
 *
 * A missing field is itself a fingerprint difference: the official CLI always
 * sends `temperature`, always sends `max_tokens`, always sends `tools` (as an
 * empty array when there are none), and — whenever extended thinking is on —
 * always sends a `context_management` block alongside the
 * `context-management-2025-06-27` beta the betas module claims. A request that
 * omits them looks like hand-rolled API usage even when every header and prompt
 * matches, and claiming the beta without the field is an internal contradiction
 * (the reverse — the field without the beta — is one too, which is why the fill
 * is gated on the resolved beta set rather than on the thinking type alone).
 *
 * The one exception is model-driven, not preference-driven: Opus 5.5 class
 * models REJECT `temperature`, so the real CLI omits it for those and so does
 * this module.
 */
import { CONTEXT_MANAGEMENT_BETA } from './constants.js';
import { isOpus55 } from './model.js';

/** The CLI's default sampling temperature. */
export const DEFAULT_TEMPERATURE = 1;

/**
 * The `context_management` block the real CLI attaches when thinking is enabled.
 *
 * Returned as a fresh object per call: a shared literal would be handed to every
 * request body and would then be mutated by whoever touches it first.
 */
export function defaultContextManagement() {
  return { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] };
}

/** The thinking types that make the CLI attach `context_management`. */
const THINKING_TYPES_WITH_CONTEXT_MANAGEMENT = new Set(['enabled', 'adaptive']);

/**
 * The defaults stage.
 *
 * `max_tokens` is NOT defaulted here: the transport always computes one from the
 * caller's request or its own default, so a value set here would either be dead
 * code or silently override the caller's explicit choice.
 */
export const defaultsModule = {
  name: 'defaults',
  purpose: 'fill the fields the CLI always sends (temperature, tools, context_management)',
  apply(plan) {
    const body = plan.body;
    const tokens = betaTokens(plan.betas);
    const filled = [];
    const removed = [];
    if (body.temperature === undefined && !isOpus55(body.model)) {
      body.temperature = DEFAULT_TEMPERATURE;
      filled.push('temperature');
    }
    if (!Array.isArray(body.tools)) {
      body.tools = [];
      filled.push('tools');
    }
    const thinkingType = body.thinking?.type;
    if (
      body.context_management === undefined
      && typeof thinkingType === 'string'
      && THINKING_TYPES_WITH_CONTEXT_MANAGEMENT.has(thinkingType)
      && tokens.has(CONTEXT_MANAGEMENT_BETA)
    ) {
      body.context_management = defaultContextManagement();
      filled.push('context_management');
    }
    // The same symmetry in the other direction: a field the resolved beta set
    // does not allow is removed rather than pushed upstream to be rejected. This
    // is the body half of what the reference implementation's
    // `sanitizeAnthropicBodyForBetaTokens` does against the final beta header.
    if (body.context_management !== undefined && !tokens.has(CONTEXT_MANAGEMENT_BETA)) {
      delete body.context_management;
      removed.push('context_management');
    }
    plan.filledDefaults = filled;
    plan.removedDefaults = removed;
  },
};

/**
 * The beta tokens a request actually declares.
 *
 * The field is filled only when the header CLAIMED the gating token: the
 * API-key beta set does not contain `context-management-2025-06-27`, so an
 * api-key account would otherwise send a body field no declared beta allows —
 * an asymmetry the upstream answers with a 400.
 */
function betaTokens(betaHeader) {
  if (typeof betaHeader !== 'string' || betaHeader === '') return new Set();
  return new Set(betaHeader.split(',').map((token) => token.trim()).filter((token) => token !== ''));
}
