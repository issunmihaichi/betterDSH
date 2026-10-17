import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { poolNamespacesFor, streamFixedReviewer } from './reviewer-model.js';

/** An independent ordinary object. Never proxy the context or mutate global services. */
function boundFacade(real, overrides = {}, services = []) {
  const facade = Object.create(null);
  const keys = new Set();
  for (let current = real; current !== null; current = Object.getPrototypeOf(current)) {
    for (const key of Reflect.ownKeys(current)) if (key !== 'constructor') keys.add(key);
  }
  // Cordis reflects some public methods dynamically, outside own/prototype keys.
  for (const key of ['on', 'effect', 'get', 'provide', 'approval', 'llm', 'permissionPresets', 'sessions', 'tools', ...services]) if (key in real) keys.add(key);
  for (const key of keys) {
    if (Object.hasOwn(overrides, key)) continue;
    Object.defineProperty(facade, key, { configurable: true, enumerable: true, get() {
      // The real context/service is the receiver, preserving scoped service access.
      const value = Reflect.get(real, key, real);
      return typeof value === 'function' ? value.bind(real) : value;
    } });
  }
  Object.defineProperties(facade, Object.getOwnPropertyDescriptors(overrides));
  return facade;
}

export function createAttributionFacade(ctx, state, { requestId = randomUUID, reviewerModel, services = [] } = {}) {
  const als = new AsyncLocalStorage();
  const realLlm = ctx.llm;
  // Ordinary synchronous method: stream return type and eager snapshot are unchanged.
  const llm = boundFacade(realLlm, { stream: function stream(options) {
    const store = als.getStore();
    let forwarded = options;
    // Selection validation is deliberately outside observational augmentation fallback.
    const selection = state.augmentationEnabled && store !== undefined ? reviewerModel?.() : undefined;
    if (state.augmentationEnabled && store !== undefined) {
      try {
        const ownerSessionId = store.exec.agent?.session.id;
        if (typeof ownerSessionId !== 'string' || ownerSessionId.length === 0) throw new TypeError('Missing owner session');
        if (options === null || typeof options !== 'object' || Object.hasOwn(options, 'codexRequestProvenance')) throw new TypeError('Review options cannot be augmented');
        const id = requestId();
        if (typeof id !== 'string' || id.length === 0) throw new TypeError('Missing request identity');
        const provenance = Object.freeze({ version: 1, kind: 'auto-review', ownerSessionId, requestId: id });
        forwarded = { ...options, codexRequestProvenance: provenance };
        if (Object.isFrozen(options)) Object.freeze(forwarded);
        state.augmentedRequests += 1;
      } catch {
        // Augmentation is observational only. The official reviewer still runs.
        state.missingProvenance += 1;
        forwarded = options;
      }
    }
    // Do not catch provider errors, retry streams, or convert a failure to allow.
    return selection?.mode === 'fixed' ? streamFixedReviewer(realLlm, forwarded, selection, poolNamespacesFor(ctx)) : realLlm.stream.call(realLlm, forwarded);
  } });
  const facade = boundFacade(ctx, {
    llm,
    on: function on(event, handler, options) {
      if (event !== 'tools/pre-execute' || typeof handler !== 'function') return ctx.on(event, handler, options);
      return ctx.on(event, (exec, next) => als.run({ exec }, () =>
        handler(exec, (...args) => als.exit(() => next(...args)))), options);
    },
  }, services);
  return { facade, disable: () => als.disable() };
}

export function createDiagnostics({ compatible, moduleSha256 }) {
  const state = { version: 1, compatible, augmentationEnabled: compatible, moduleSha256,
    augmentedRequests: 0, missingProvenance: 0, status: compatible ? 'enabled' : 'disabled-incompatible' };
  const service = Object.freeze({ snapshot: () => Object.freeze({ ...state }) });
  return { state, service };
}
