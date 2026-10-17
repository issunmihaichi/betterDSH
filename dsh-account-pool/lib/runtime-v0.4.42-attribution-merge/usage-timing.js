/** Usage performance is advisory telemetry, never a transport/retry decision. */
export function nullableUsageMetric(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Defaults also make historical rows explicit and JSON-safe at the API boundary. */
export function normalizeUsageTiming(value) {
  return {
    firstTokenMs: nullableUsageMetric(value?.firstTokenMs),
    outputDurationMs: nullableUsageMetric(value?.outputDurationMs),
    outputTps: nullableUsageMetric(value?.outputTps),
  };
}

const nonempty = value => typeof value === 'string' && value.length > 0;
// A complete zero-argument tool payload ("{}", or an already parsed object) is
// content; a tool id/name or a block-start without arguments is only metadata.
const argumentsPresent = value => nonempty(value) || value !== null && typeof value === 'object';
function hasModelContent(chunk) {
  if (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta') return nonempty(chunk.text);
  if (chunk?.type === 'tool-call-delta') return nonempty(chunk.argumentsDelta);
  if (chunk?.type === 'tool-call-start') return argumentsPresent(chunk.arguments ?? chunk.toolCall?.arguments ?? chunk.block?.arguments);
  if (chunk?.type !== 'block-start' && chunk?.type !== 'block-end') return false;
  const block = chunk.block;
  if (block?.type === 'text' || block?.type === 'reasoning') return nonempty(block.text);
  if (block?.type === 'tool-call') return argumentsPresent(block.arguments);
  return chunk.type === 'block-start' && chunk.blockType === 'tool-call' && argumentsPresent(chunk.arguments);
}

/**
 * One request, across every same-account/detection retry and account failover.
 * firstTokenMs: request start -> first nonempty text, reasoning or tool arguments.
 * outputDurationMs: first content -> observed terminal finish (success/error/abort),
 * or upstream EOF/throw when no finish exists. Observe BEFORE yielding finish, so
 * persistence and consumer time AFTER finish are excluded. Async-iterator
 * backpressure before that boundary cannot be separated from provider latency.
 * outputTps: actual reported outputTokens * 1000 / outputDurationMs. Missing token
 * usage is not zero: only an explicitly reported finite zero may produce 0 TPS.
 * No content means all three are null; zero duration or unreliable clocks/counts
 * mean null TPS. Invalid/throwing/backwards clocks invalidate timing, not requests.
 */
export function createUsageTiming(clock, startedAt) {
  let reliable = true, previous, first, terminal, ended = false;
  let hasOutputTokens = false, reliableOutputTokens = true;
  function stamp(value) {
    try {
      const time = value === undefined ? clock.now() : value;
      if (typeof time !== 'number' || !Number.isFinite(time) || previous !== undefined && time < previous) {
        reliable = false;
        return undefined;
      }
      previous = time;
      return time;
    } catch {
      reliable = false;
      return undefined;
    }
  }
  const begin = stamp(startedAt);
  function finish() {
    if (ended) return;
    ended = true;
    terminal = stamp();
  }
  function observe(chunk) {
    try {
      if (chunk?.type === 'usage') {
        const count = chunk.usage?.outputTokens;
        if (count !== undefined && count !== null) {
          if (nullableUsageMetric(count) !== null) hasOutputTokens = true;
          else reliableOutputTokens = false;
        }
      }
      if (first === undefined && hasModelContent(chunk)) first = stamp();
      if (chunk?.type === 'finish') finish();
    } catch { reliable = false; }
  }
  return {
    /** The raw boundary sees error finish chunks even when retry wrappers hide them. */
    wrap(upstream) {
      return { async *stream(account, options) {
        // Only pre-commit failures can be retried. Preserve request start, but
        // discarded attempts must not supply the final attempt's content/terminal.
        first = undefined;
        ended = false;
        terminal = undefined;
        hasOutputTokens = false;
        reliableOutputTokens = true;
        try {
          for await (const chunk of upstream.stream(account, options)) {
            observe(chunk);
            yield chunk;
          }
        } finally { finish(); }
      } };
    },
    finish,
    metrics(usage) {
      try {
        const firstTokenMs = reliable && first !== undefined ? nullableUsageMetric(first - begin) : null;
        const outputDurationMs = reliable && first !== undefined && terminal !== undefined ? nullableUsageMetric(terminal - first) : null;
        const count = hasOutputTokens && reliableOutputTokens ? nullableUsageMetric(usage?.outputTokens) : null;
        const outputTps = count !== null && outputDurationMs > 0 ? nullableUsageMetric(count * 1000 / outputDurationMs) : null;
        return { firstTokenMs, outputDurationMs, outputTps };
      } catch { return normalizeUsageTiming(); }
    },
  };
}
