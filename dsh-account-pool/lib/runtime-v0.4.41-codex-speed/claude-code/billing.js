/**
 * Billing-attribution module.
 *
 * This is the single most copy-sensitive piece of the disguise. Every request the
 * official CLI sends carries an `x-anthropic-billing-header` block in its system
 * payload, and its absence is one of the signals the upstream uses to classify a
 * caller as third-party (sub2api: "缺失 billing block 的系统 payload 是 Anthropic
 * 判定第三方的关键信号之一"). The block is therefore reproduced byte-for-byte,
 * including the fingerprint suffix, which is computed from the request's own first
 * user message.
 */
import { BILLING_HEADER_PREFIX, FINGERPRINT_SALT } from './constants.js';
import { sha256Hex } from './hash.js';

/**
 * The first `text` of the first `role: 'user'` message.
 *
 * Accepts both content shapes the Messages API allows (a bare string, or an array
 * of blocks): the fingerprint reads this text, so which shape the caller happened
 * to use must not change the answer.
 */
export function firstUserText(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return '';
  for (const message of messages) {
    if (message?.role !== 'user') continue;
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') return block.text;
      }
      return '';
    }
    return '';
  }
  return '';
}

/**
 * sub2api's `computeClaudeCodeFingerprint`, reproduced exactly: take the first
 * user text's 4th, 7th and 20th character (missing ones become `'0'`), then keep
 * three hex digits of `sha256(SALT + chars + version)`.
 *
 * The indices are BYTE offsets, because that is what the original does (`firstText[i]`
 * on a Go `string`). Indexing UTF-16 code units instead would agree for ASCII and
 * silently diverge the first time a message contains any non-ASCII character — a
 * bug that would only appear under real multilingual traffic.
 */
export function claudeCodeFingerprint(body, version) {
  const bytes = Buffer.from(firstUserText(body), 'utf8');
  const chars = [4, 7, 20]
    .map((index) => (index < bytes.length ? String.fromCharCode(bytes[index]) : '0'))
    .join('');
  return sha256Hex(`${FINGERPRINT_SALT}${chars}${version}`).slice(0, 3);
}

/**
 * The complete attribution text as the CLI writes it.
 *
 * Note the absent `cch=` segment: sub2api removed it once the official client
 * stopped sending it, on the grounds that injecting a field the real CLI no longer
 * sends makes the request LESS like the CLI. `cc_version` and `cc_entrypoint`
 * remain, because those are the parts identification actually reads.
 */
export function billingAttributionText(body, version) {
  const fp = claudeCodeFingerprint(body, version);
  return `${BILLING_HEADER_PREFIX}: cc_version=${version}.${fp}; cc_entrypoint=cli;`;
}

/** The billing stage: compute the attribution block for this body. */
export const billingModule = {
  name: 'billing',
  purpose: 'compute the x-anthropic-billing-header attribution block (cc_version + fingerprint)',
  apply(plan) {
    plan.billingText = billingAttributionText(plan.body, plan.version);
  },
};
