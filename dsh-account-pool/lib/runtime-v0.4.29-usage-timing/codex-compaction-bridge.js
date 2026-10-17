/** Optional adapter for the installed BasicCompactionEngine's sole summarize hook.
 * The official engine still owns thresholds, safe boundaries, surface replacement,
 * locking and JSONL persistence. Only a sealed text-block sidecar is persisted.
 */
import { isDeepStrictEqual } from 'node:util';
import { CODEX_COMPACTION_KIND, CODEX_COMPACTION_TEXT, expandCodexCompactionMessages } from './native/codex-compaction.js';

const failure = () => Object.assign(new Error('Codex encrypted checkpoint history cannot be restored safely'), { code: 'POOL_CODEX_COMPACTION_HISTORY_UNAVAILABLE' });

/** Resolve ONLY an exact, authoritative checkpoint from this session's own log.
 * Forks can recover their inherited original records, never the parent's cipher.
 * No range, path or text supplied by a browser is treated as authoritative history.
 */
export function createCompactionHistoryResolver(resolveSession) {
  return (message, options = {}) => {
    const session = typeof options.sessionId === 'string' ? resolveSession?.(options.sessionId) : undefined;
    if (!session || !message?.id || message.source?.kind !== 'compact-checkpoint') throw failure();
    const events = session.snapshotEvents?.() ?? session.log;
    if (!Array.isArray(events)) throw failure();
    const checkpoint = events.find(event => event.type === 'user/message' && event.data?.id === message.id);
    if (!checkpoint || !isDeepStrictEqual(checkpoint.data.content, message.content)
      || !isDeepStrictEqual(checkpoint.data.source, message.source)) throw failure();
    const summary = (checkpoint.sourceEventSeqs ?? []).map(seq => session.eventAt(seq)).find(event =>
      event?.type === 'compaction/summary' && event.data?.compactionId === message.source.compactionId);
    const seqs = summary?.data?.shadowedSeqs;
    if (!Array.isArray(seqs) || seqs.length === 0 || seqs.length > 100000
      || new Set(seqs).size !== seqs.length
      || !seqs.every(seq => Number.isSafeInteger(seq) && seq >= 0 && seq < checkpoint.seq)) throw failure();
    const messages = [];
    for (const seq of seqs) {
      const event = session.eventAt(seq);
      if (!event || event.seq !== seq) throw failure();
      const restored = session.deriveEventMessage(event);
      if (restored !== null && restored !== undefined) messages.push(restored);
    }
    if (!messages.length) throw failure();
    return messages;
  };
}

/** Restore at the final adapter boundary, retaining a prepared call's captured
 * registration and dispatch. Re-entering llm.stream would select an adapter again
 * after an async preparation / route change. This audited instance seam is optional.
 */
export function installExternalCompactionReplay({ llm, isPool, resolveCompactionHistory }) {
  if (typeof llm?.adapterStream !== 'function') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(llm, 'adapterStream');
  if (descriptor && (!descriptor.configurable || descriptor.get || descriptor.set)) return undefined;
  const original = llm.adapterStream;
  async function* adapterStream(options, prepared) {
    const messages = isPool(options.provider) ? options.messages : expandCodexCompactionMessages(options.messages,
      { enabled: false, resolveCompactionHistory, options });
    yield* original.call(this, messages === options.messages ? options : { ...options, messages }, prepared);
  }
  Object.defineProperty(llm, 'adapterStream', { value: adapterStream, configurable: true, writable: true });
  return () => {
    if (llm.adapterStream !== adapterStream) return;
    if (descriptor) Object.defineProperty(llm, 'adapterStream', descriptor);
    else delete llm.adapterStream;
  };
}

export function isCodexCompactionTarget(adapter, target) {
  if (!target || !adapter.routesFor().includes(target.provider)) return false;
  const groupId = target.provider === 'pool' ? undefined : target.provider.slice('pool-'.length);
  const group = groupId === undefined ? undefined : adapter.getGroup(groupId);
  if (groupId !== undefined && (!group || group.enabled === false || group.models?.length && !group.models.includes(target.model))) return false;
  const accounts = adapter.listAccounts().filter(account =>
    (groupId === undefined || account.groups?.includes(groupId)) && (!account.models?.length || account.models.includes(target.model)));
  return accounts.length > 0 && accounts.every(account => account.platform === 'openai' && account.authMode === 'oauth');
}

function targetFor(engine, agent) {
  const latest = agent.session.requestHeader?.()?.config;
  const route = latest ?? agent.options;
  const override = engine.config.modelPolicies?.find(policy => policy.provider === route?.provider && policy.model === route?.model);
  const provider = override?.summarizationProvider ?? engine.config.summarizationProvider;
  const model = override?.summarizationModel ?? engine.config.summarizationModel;
  const target = provider ? { provider, model } : route;
  return { target, maxTokens: override?.maxTokens ?? engine.config.maxTokens };
}

/** Reversible, per-instance wrapping, never a replacement global compaction service. */
export function installCodexCompactionBridge({ engine, llm, enabled, canCompact, resolveCompactionHistory, onFallback }) {
  if (!engine || typeof engine.summarize !== 'function' || typeof engine.regionDependencies !== 'function'
    || typeof engine.compactRegion !== 'function' || !engine.config || typeof llm?.stream !== 'function') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(engine, 'summarize');
  if (descriptor && (!descriptor.configurable || descriptor.get || descriptor.set)) return undefined;
  const original = engine.summarize;
  async function summarize(input, agent, signal) {
    signal?.throwIfAborted();
    const { target, maxTokens } = targetFor(engine, agent);
    if (enabled() && canCompact(target)) {
      try {
        const options = { provider: target.provider, model: target.model, messages: input.messages,
          ...(input.tools === undefined ? {} : { tools: input.tools }), toolHistory: agent.session.toolHistory?.(),
          sessionId: agent.session.id, purpose: 'compaction', codexCompactionV2: true, maxTokens,
          ...(signal === undefined ? {} : { signal }) };
        let response, usage, finished = false;
        for await (const chunk of llm.stream(options)) {
          signal?.throwIfAborted();
          if (chunk.type === 'usage') usage = chunk.usage;
          if (chunk.type === 'finish') {
            if (finished || chunk.reason?.kind !== 'stop' || chunk.replayState?.response?.kind !== CODEX_COMPACTION_KIND) throw failure();
            response = chunk.replayState.response;
            finished = true;
          }
        }
        if (!finished || !response) throw failure();
        const summary = [{ type: 'text', text: CODEX_COMPACTION_TEXT, codexCompaction: response }];
        return { summary, rawOutput: summary, llmStreamCall: true, provider: target.provider, model: target.model,
          ...(usage === undefined ? {} : { usage }) };
      } catch {
        signal?.throwIfAborted();
        // Unsupported upstream, key failure or failed native compaction preserves
        // the original span. The official textual summarizer remains available.
        try { onFallback?.(); } catch { /* advisory, no response text */ }
      }
    }
    const messages = expandCodexCompactionMessages(input.messages, { enabled: false, resolveCompactionHistory,
      options: { sessionId: agent.session.id } });
    return original.call(this, { ...input, messages }, agent, signal);
  }
  Object.defineProperty(engine, 'summarize', { value: summarize, configurable: true, writable: true });
  return () => {
    if (engine.summarize !== summarize) return;
    if (descriptor) Object.defineProperty(engine, 'summarize', descriptor);
    else delete engine.summarize;
  };
}
