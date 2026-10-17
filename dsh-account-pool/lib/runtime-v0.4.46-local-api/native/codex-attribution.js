/** Local-only attribution diagnostics; never billing data or a wire-field source. */
const SOURCES = ['user', 'subagent', 'thread_title', 'guardian_review', 'unknown'];
const KINDS = ['turn', 'compaction'];
const MISSING_REASONS = ['missing-session-id', 'session-service-unavailable', 'session-not-found', 'source-unavailable'];
const nonblank = value => typeof value === 'string' && value.trim() !== '';

/** Reduce the exact emitted canonical metadata to bounded non-identifying labels. */
export function summarizeCodexAttribution(metadata, provenance, sessionId) {
  const threadSource = SOURCES.includes(metadata.thread_source) ? metadata.thread_source : 'unknown';
  const missingSourceReason = threadSource !== 'unknown' ? null
    : !nonblank(sessionId) ? 'missing-session-id'
    : MISSING_REASONS.includes(provenance?.missingSourceReason) ? provenance.missingSourceReason : 'source-unavailable';
  return Object.freeze({
    requestKind: KINDS.includes(metadata.request_kind) ? metadata.request_kind : 'turn',
    threadSource,
    missingSourceReason,
  });
}

/** Fixed-size, mount-local counters. Snapshot mutation and observer failures are isolated. */
export function createCodexAttributionDiagnostics({ now = Date.now, onUnknown = () => {}, enabled = true } = {}) {
  const bySource = Object.fromEntries(SOURCES.map(key => [key, 0]));
  const byRequestKind = Object.fromEntries(KINDS.map(key => [key, 0]));
  const missingSourceReasons = Object.fromEntries(MISSING_REASONS.map(key => [key, 0]));
  const startedAt = now();
  let totalAttempts = 0, lastAttemptAt = null, lastMissingSourceAt = null;
  const increment = value => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
  return Object.freeze({
    record(summary) {
      if (!enabled) return;
      const source = SOURCES.includes(summary?.threadSource) ? summary.threadSource : 'unknown';
      const kind = KINDS.includes(summary?.requestKind) ? summary.requestKind : 'turn';
      totalAttempts = increment(totalAttempts);
      bySource[source] = increment(bySource[source]);
      byRequestKind[kind] = increment(byRequestKind[kind]);
      lastAttemptAt = now();
      if (source === 'unknown') {
        const reason = MISSING_REASONS.includes(summary?.missingSourceReason) ? summary.missingSourceReason : 'source-unavailable';
        missingSourceReasons[reason] = increment(missingSourceReasons[reason]);
        lastMissingSourceAt = lastAttemptAt;
        // At most one warning for each bounded reason during this mount.
        if (missingSourceReasons[reason] === 1) { try { onUnknown(reason); } catch {} }
      }
    },
    snapshot() {
      return {
        version: 1, enabled, scope: 'host-mount', semantics: 'dispatch-attempts-not-billed-usage',
        startedAt, totalAttempts, bySource: { ...bySource }, byRequestKind: { ...byRequestKind },
        missingSourceAttempts: bySource.unknown, missingSourceReasons: { ...missingSourceReasons },
        lastAttemptAt, lastMissingSourceAt, officialAnalyticsVerified: false,
      };
    },
  });
}
