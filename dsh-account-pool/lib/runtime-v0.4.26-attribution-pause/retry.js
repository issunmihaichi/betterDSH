import { setTimeout as delay } from 'node:timers/promises';
import { classifyFailure } from './kernel.js';
import { isPoolDetectionRetryError, matchesPoolDetection } from './detection.js';

export const DEFAULT_REQUEST_RETRIES = 3;
export const DEFAULT_REQUEST_RETRY_DELAY_MS = 1000;
export const DEFAULT_REQUEST_RETRY_MAX_DELAY_MS = 8000;
export const waitForRequestRetry = (milliseconds, signal) => delay(milliseconds, undefined, { signal });

const bounded = (value, fallback, min, max) => Number.isInteger(value)
  ? Math.max(min, Math.min(max, value)) : fallback;
export function requestRetryConfig(options = {}) {
  const delayMs = bounded(options.requestRetryDelayMs, DEFAULT_REQUEST_RETRY_DELAY_MS, 100, 10000);
  return {
    retries: bounded(options.requestRetries, DEFAULT_REQUEST_RETRIES, 0, 5),
    delayMs,
    maxDelayMs: Math.max(delayMs, bounded(options.requestRetryMaxDelayMs, DEFAULT_REQUEST_RETRY_MAX_DELAY_MS, 100, 30000)),
  };
}

/** Carry the DSH failure snapshot without depending on a DSH Error class. */
export function carryPoolFailure(value, { code, source = value } = {}) {
  const error = value instanceof Error ? value : new Error(String(value ?? 'Account pool request failed.'));
  const failureCode = code ?? (typeof error.code === 'string' && error.code !== '' ? error.code : 'TRANSPORT');
  const snapshot = { message: error.message || 'Account pool request failed.', code: failureCode };
  if (Number.isInteger(source?.status) && source.status >= 100 && source.status <= 599) snapshot.status = source.status;
  if (Number.isFinite(source?.providerRetryAfterMs) && source.providerRetryAfterMs > 0) snapshot.providerRetryAfterMs = source.providerRetryAfterMs;
  if (typeof source?.requestId === 'string' && source.requestId !== '') snapshot.requestId = source.requestId;
  Object.defineProperty(error, 'code', { value: failureCode, configurable: true, writable: true, enumerable: true });
  Object.defineProperty(error, 'failure', { value: Object.freeze(snapshot), configurable: true, enumerable: false });
  return error;
}

/** Retry transient failures on the selected account, only before forwarding any chunk. */
export async function* streamWithRequestRetry(upstream, account, options, {
  getAccount = () => account, canRetry = () => true, wait = waitForRequestRetry,
  config = requestRetryConfig(), failurePolicy, canRetryRateLimit = () => false, onRetry = () => {}, onAttempt = () => {},
} = {}) {
  let current = account;
  let retries = 0;
  let committed = false;
  for (;;) {
    options.signal?.throwIfAborted();
    onAttempt();
    try {
      for await (const chunk of upstream.stream(current, options)) {
        options.signal?.throwIfAborted();
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
      if (committed || retries >= config.retries || isPoolDetectionRetryError(failure) || matchesPoolDetection(failure, current)) throw failure;
      const decision = classifyFailure(failure, current, Date.now(), failurePolicy);
      const retryAfter = failure?.providerRetryAfterMs;
      const shortRateLimit = decision.kind === 'rate-limit' && Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 30000 && canRetryRateLimit();
      if (Number.isInteger(failure?.status) && failure.status >= 400 && failure.status < 500 && !shortRateLimit) throw failure;
      if (!['transport', 'overload'].includes(decision.kind) && !shortRateLimit) throw failure;
      const latest = getAccount();
      if (latest === undefined || !canRetry(latest)) throw failure;
      const milliseconds = Math.max(Math.min(config.delayMs * 2 ** retries, config.maxDelayMs), shortRateLimit ? retryAfter : 0);
      retries += 1;
      onRetry({ account: latest, retry: retries, maxRetries: config.retries, delayMs: milliseconds, failure });
      await wait(milliseconds, options.signal);
      options.signal?.throwIfAborted();
      current = getAccount();
      if (current === undefined || !canRetry(current)) throw failure;
    }
  }
}
