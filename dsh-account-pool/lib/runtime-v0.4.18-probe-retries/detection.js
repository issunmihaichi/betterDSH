import { setTimeout as delay } from 'node:timers/promises';

export const DEFAULT_POOL_DETECTION_KEYWORDS = Object.freeze(['号池检测', '池检测', '号池不可用']);
const responseText = Symbol('poolDetectionText');
const TEXT_LIMIT = 8192;

/** Keep matching metadata bounded and absent from serialized/logged error fields. */
export function rememberDetectionText(error, text) {
  if (error !== null && typeof error === 'object' && typeof text === 'string') {
    Object.defineProperty(error, responseText, { value: text.slice(0, TEXT_LIMIT), enumerable: false });
  }
  return error;
}

const boundedInteger = (value, fallback, min, max) => Number.isInteger(value)
  ? Math.max(min, Math.min(max, value)) : fallback;
export function poolDetectionConfig(account) {
  return {
    enabled: account?.poolDetectionRetry === true,
    retries: boundedInteger(account?.poolDetectionRetries, 2, 0, 5),
    delayMs: boundedInteger(account?.poolDetectionRetryDelayMs, 1000, 100, 10000),
    keywords: (Array.isArray(account?.poolDetectionKeywords) ? account.poolDetectionKeywords : DEFAULT_POOL_DETECTION_KEYWORDS)
      .slice(0, 20).filter(value => typeof value === 'string')
      .map(value => value.trim().slice(0, 200).toLowerCase()).filter(Boolean),
  };
}

/** Status alone never identifies a pool-detection response; matching is literal. */
export function matchesPoolDetection(failure, account) {
  const config = poolDetectionConfig(account);
  if (!config.enabled || config.keywords.length === 0) return false;
  const message = typeof failure?.message === 'string' ? failure.message.slice(0, TEXT_LIMIT) : '';
  const metadata = typeof failure?.[responseText] === 'string' ? failure[responseText] : '';
  // Match separately, so the join cannot manufacture a keyword across boundaries.
  return [message, metadata].some(text => {
    const normalized = text.toLowerCase();
    return config.keywords.some(keyword => normalized.includes(keyword));
  });
}

export class PoolDetectionRetryError extends Error {
  constructor(partial = false) {
    super(partial ? 'Pool detection interrupted an already started response.'
      : 'Pool detection retry limit reached or the selected account is no longer available.');
    this.name = 'PoolDetectionRetryError';
    this.code = partial ? 'POOL_DETECTION_PARTIAL_RESPONSE' : 'POOL_DETECTION_RETRY_EXHAUSTED';
  }
}
export function isPoolDetectionRetryError(failure) {
  return failure instanceof PoolDetectionRetryError;
}
export const waitForPoolDetection = (milliseconds, signal) => delay(milliseconds, undefined, { signal });

/**
 * Retry one account, before any yielded chunk, without changing request identity.
 * The caller owns its concurrency slot for this whole operation, including waits.
 * getAccount/canRetry re-check current edits, deletion and routing before resending.
 * A request's retry budget only shrinks: editing a row cannot replenish it.
 */
export async function* streamWithPoolDetection(upstream, account, options, {
  getAccount = () => account, canRetry = () => true, wait = waitForPoolDetection,
} = {}) {
  let current = account;
  let retryLimit = poolDetectionConfig(account).retries;
  let retries = 0;
  let committed = false;
  for (;;) {
    options.signal?.throwIfAborted();
    try {
      for await (const chunk of upstream.stream(current, options)) {
        options.signal?.throwIfAborted();
        // A terminal failure is not content and must reach the retry policy first.
        if (chunk?.type === 'finish' && ['error', 'aborted'].includes(chunk.reason?.kind)) {
          throw chunk.reason.failure ?? Object.assign(new Error('Upstream stream failed.'), { code: chunk.reason.kind });
        }
        committed = true;
        yield chunk;
      }
      options.signal?.throwIfAborted();
      return;
    } catch (failure) {
      options.signal?.throwIfAborted();
      if (failure?.name === 'AbortError' || ['abort', 'aborted', 'ABORTED'].includes(failure?.code)) throw failure;
      if (!matchesPoolDetection(failure, current)) throw failure;
      if (committed) throw new PoolDetectionRetryError(true);
      const latest = getAccount();
      const config = poolDetectionConfig(latest);
      retryLimit = Math.min(retryLimit, config.retries);
      if (latest === undefined || !config.enabled || !matchesPoolDetection(failure, latest)
        || !canRetry(latest) || retries >= retryLimit) throw new PoolDetectionRetryError();
      retries += 1;
      await wait(config.delayMs, options.signal);
      options.signal?.throwIfAborted();
      current = getAccount();
      const afterWait = poolDetectionConfig(current);
      retryLimit = Math.min(retryLimit, afterWait.retries);
      if (current === undefined || !afterWait.enabled || retries > retryLimit
        || !matchesPoolDetection(failure, current) || !canRetry(current)) throw new PoolDetectionRetryError();
    }
  }
}
