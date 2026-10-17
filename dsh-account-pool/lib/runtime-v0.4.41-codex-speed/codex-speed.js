/** Codex speed is a durable choice, not a plan-name guess or a request hint.
 * Catalog evidence is private, short-lived and scoped to the actual OAuth identity.
 * No response text, tokens, arbitrary errors or catalog metadata enter the UI.
 */
import { createHash } from 'node:crypto';
import { buildCodexModelsRequest } from './native/codex.js';

export const CODEX_SPEED_MODES = Object.freeze(['standard', 'fast', 'ultrafast']);
export const MAX_CODEX_SPEED_SELECTIONS = 512;
export const isCodexSpeedAccount = account => account?.platform === 'openai' && account.authMode === 'oauth';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const codexSpeedConnectionKey = account => digest([account?.id, account?.platform, account?.authMode,
  account?.baseUrl ?? null, account?.credentialRef ?? null, account?.chatgptAccountId ?? null]);
export function codexSpeedError(code = 'POOL_CODEX_SPEED_UNAVAILABLE') {
  return Object.assign(new Error(code === 'POOL_CODEX_SPEED_INVALID' ? 'Invalid Codex speed selection.'
    : 'Selected Codex speed is unavailable for this session, route or model; choose Standard or refresh capabilities.'), { code });
}
export function validCodexSpeedTarget(value) {
  return value !== null && typeof value === 'object' && ['sessionId', 'provider', 'model'].every(key =>
    typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 256
    && value[key] === value[key].trim() && !/[\x00-\x1f\x7f]/.test(value[key]));
}
export function parseCodexSpeedBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 4 || Object.keys(value).some(key => !['sessionId', 'provider', 'model', 'mode'].includes(key))
    || !validCodexSpeedTarget(value) || !CODEX_SPEED_MODES.includes(value.mode)) throw codexSpeedError('POOL_CODEX_SPEED_INVALID');
  return { sessionId: value.sessionId, provider: value.provider, model: value.model, mode: value.mode };
}
const selectionKey = target => JSON.stringify([target.sessionId, target.provider, target.model]);
const abortError = () => Object.assign(new Error('Codex capability request cancelled.'), { name: 'AbortError' });
function abortable(promise, signal) {
  signal?.throwIfAborted();
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? abortError());
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function catalogJson(response, signal) {
  if (!response.ok || !response.body) { await response.body?.cancel(); return undefined; }
  const reader = response.body.getReader();
  const chunks = []; let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) return undefined;
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Each caller owns its abort. A cancelled waiter cannot cancel a different caller's
 * shared catalog fetch; unload cancels everything. Only HTTP GET /models is issued.
 */
export function createCodexCatalogProbe({ resolveCredential, fetchImpl = globalThis.fetch,
  clock = { now: Date.now }, ttlMs = 60_000, timeoutMs = 8_000, concurrency = 2 } = {}) {
  ttlMs = Math.max(1, Math.min(60_000, Number(ttlMs) || 60_000));
  timeoutMs = Math.max(1, Math.min(15_000, Number(timeoutMs) || 8_000));
  concurrency = Math.max(1, Math.min(4, Math.floor(Number(concurrency) || 2)));
  const cache = new Map(), jobs = new Map(), queue = [], controllers = new Set();
  let active = 0, disposed = false;
  function pump() {
    while (!disposed && active < concurrency && queue.length) {
      const job = queue.shift(); active++;
      Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => { active--; pump(); });
    }
  }
  function schedule(run) {
    if (disposed || queue.length >= 128) return Promise.reject(abortError());
    const promise = new Promise((resolve, reject) => queue.push({ run, resolve, reject }));
    pump(); return promise;
  }
  async function fetchCatalog(built) {
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => controller.abort(abortError()), timeoutMs); timer.unref?.();
    try {
      const response = await abortable(fetchImpl(built.url, { ...built.init, signal: controller.signal }), controller.signal);
      const body = await catalogJson(response, controller.signal);
      if (!body || !Array.isArray(body.models)) return undefined;
      // Retain ids only. Duplicate model slugs make the evidence ambiguous.
      const tiers = new Map();
      for (const model of body.models) {
        if (typeof model?.slug !== 'string' || tiers.has(model.slug)) return undefined;
        tiers.set(model.slug, Array.isArray(model.service_tiers) && model.service_tiers.some(tier => tier?.id === 'ultrafast'));
      }
      return tiers;
    } catch { return undefined; }
    finally { clearTimeout(timer); controllers.delete(controller); }
  }
  return {
    async probe(account, model, signal) {
      signal?.throwIfAborted();
      if (disposed || !isCodexSpeedAccount(account)) return undefined;
      // Resolve on every operation: a replaced bundle under the same ref is a new
      // identity, not an entitlement inherited from the preceding account.
      let built;
      try {
        const credential = await abortable(schedule(() => {
          signal?.throwIfAborted();
          return resolveCredential(account, { signal });
        }), signal);
        signal?.throwIfAborted();
        built = buildCodexModelsRequest(account, credential);
      } catch (error) { if (signal?.aborted) throw signal.reason ?? error; return undefined; }
      const key = built.identity;
      let entry = cache.get(key);
      if (!entry || entry.expiresAt <= clock.now()) {
        let work = jobs.get(key);
        if (!work) {
          work = schedule(() => fetchCatalog(built)).then(tiers => {
            if (disposed) return undefined;
            const result = { tiers, expiresAt: clock.now() + (tiers ? ttlMs : Math.min(ttlMs, 5_000)) };
            cache.delete(key); cache.set(key, result);
            while (cache.size > 128) cache.delete(cache.keys().next().value);
            return result;
          }).catch(() => undefined).finally(() => jobs.delete(key));
          jobs.set(key, work);
        }
        entry = await abortable(work, signal);
      }
      signal?.throwIfAborted();
      return entry?.tiers?.get(model) === true ? Object.freeze({ identity: key }) : undefined;
    },
    dispose() {
      disposed = true; cache.clear();
      for (const controller of controllers) controller.abort(abortError());
      for (const job of queue.splice(0)) job.reject(abortError());
    },
  };
}

/** Persistence is serialized by the Host's singleton updater. This detached choice
 * snapshot advances ONLY after durable ack, even if a store optimistically changes
 * global.get() before rejecting. Parallel saves are ordered, not last-resolver-wins.
 */
export function createCodexSpeedService({ initialSelections = [], persistSelections, resolveTarget,
  listAccounts, probeAccount } = {}) {
  let selections = initialSelections.filter(row => validCodexSpeedTarget(row) && ['fast', 'ultrafast'].includes(row.mode))
    .slice(-MAX_CODEX_SPEED_SELECTIONS).map(row => ({ sessionId: row.sessionId, provider: row.provider, model: row.model, mode: row.mode }));
  let writes = Promise.resolve();
  const neutral = () => ({ version: 1, available: false, mode: 'standard', modes: ['standard'], ultrafastAvailable: false });
  const chosen = target => selections.find(row => selectionKey(row) === selectionKey(target))?.mode ?? 'standard';
  async function targetExists(target) {
    return validCodexSpeedTarget(target) && await resolveTarget(target) === true;
  }
  function owners(target) {
    return listAccounts(target).filter(account => isCodexSpeedAccount(account) && account.status !== 'disabled'
      && account.status !== 'error' && account.schedulable !== false).map(account => ({ ...account }));
  }
  async function evidence(target, accounts, signal) {
    const proofs = await Promise.all(accounts.slice(0, 128).map(async account => {
      try {
        const proof = await probeAccount(account, target.model, signal);
        signal?.throwIfAborted();
        return typeof proof?.identity === 'string' && proof.identity ? Object.freeze({
          accountId: account.id, connectionKey: codexSpeedConnectionKey(account), identity: proof.identity,
        }) : undefined;
      } catch (error) { if (signal?.aborted) throw signal.reason ?? error; return undefined; }
    }));
    return proofs.filter(Boolean);
  }
  function shape(target, accounts, proofs) {
    const available = accounts.length > 0, ultrafastAvailable = proofs.length > 0;
    return { version: 1, available, mode: chosen(target),
      modes: available ? ['standard', 'fast', ...(ultrafastAvailable ? ['ultrafast'] : [])] : ['standard'], ultrafastAvailable };
  }
  async function get(target, signal) {
    signal?.throwIfAborted();
    if (!await targetExists(target)) return neutral();
    const accounts = owners(target);
    const proofs = await evidence(target, accounts, signal);
    if (!await targetExists(target)) return neutral();
    const live = owners(target);
    return shape(target, live, proofs.filter(proof => live.some(account => account.id === proof.accountId
      && codexSpeedConnectionKey(account) === proof.connectionKey)));
  }
  return {
    get,
    async set(body, signal) {
      const target = parseCodexSpeedBody(body);
      const operation = writes.then(async () => {
        signal?.throwIfAborted();
        if (!await targetExists(target)) return neutral();
        const state = await get(target, signal);
        if (target.mode !== 'standard' && (!state.available || target.mode === 'ultrafast' && !state.ultrafastAvailable)) throw codexSpeedError();
        signal?.throwIfAborted();
        if (!await targetExists(target)) return neutral();
        const next = selections.filter(row => selectionKey(row) !== selectionKey(target));
        if (target.mode !== 'standard') {
          if (next.length >= MAX_CODEX_SPEED_SELECTIONS) throw codexSpeedError('POOL_CODEX_SPEED_SELECTION_LIMIT');
          next.push({ sessionId: target.sessionId, provider: target.provider, model: target.model, mode: target.mode });
        }
        try { await persistSelections(next.map(row => ({ ...row }))); }
        catch { throw codexSpeedError('POOL_CODEX_SPEED_SAVE_FAILED'); }
        selections = next;
        return { ...state, mode: target.mode };
      });
      writes = operation.catch(() => {});
      return operation;
    },
    async resolveRequest(options) {
      options.signal?.throwIfAborted();
      // Freeze before even asynchronous route validation. A concurrent durable UI
      // save is for the NEXT call, never the latter half of this request.
      const mode = validCodexSpeedTarget(options) ? chosen(options) : 'standard';
      if (!await targetExists(options)) return Object.freeze({ mode: 'standard', accounts: Object.freeze([]) });
      if (mode === 'standard') return Object.freeze({ mode, accounts: Object.freeze([]) });
      const accounts = owners(options);
      if (!accounts.length) throw codexSpeedError();
      const proofs = mode === 'ultrafast' ? await evidence(options, accounts, options.signal)
        : accounts.map(account => Object.freeze({ accountId: account.id, connectionKey: codexSpeedConnectionKey(account) }));
      if (!proofs.length) throw codexSpeedError();
      return Object.freeze({ mode, serviceTier: mode === 'fast' ? 'priority' : 'ultrafast', accounts: Object.freeze(proofs) });
    },
  };
}
