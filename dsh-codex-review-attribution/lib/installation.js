import { assertOriginalShape } from './original.js';
import { createAttributionFacade, createDiagnostics } from './attribution.js';

/** Internal install boundary, separated for fail-closed branch tests with the real original. */
export function installOriginal(ctx, loaded, { reviewerModel } = {}) {
  assertOriginalShape(loaded.original, loaded.moduleSha256);
  for (const method of ['effect', 'on', 'provide']) if (typeof ctx[method] !== 'function') throw new TypeError(`Host context is missing ${method}`);
  for (const serviceName of loaded.original.inject) if (ctx[serviceName] == null) throw new TypeError(`Host context is missing ${serviceName}`);
  if (loaded.original.inject.includes('workingDirectory') && typeof ctx.workingDirectory.ensure !== 'function') throw new TypeError('Host workingDirectory is missing ensure');
  const requiresFixedReviewer = reviewerModel?.().mode === 'fixed';
  if (requiresFixedReviewer && !loaded.compatible) throw new TypeError('Fixed reviewer requires an audited compatible official module');
  const { state, service } = createDiagnostics(loaded);
  let facade = ctx;
  let disable = () => {};
  if (loaded.compatible) {
    try { ({ facade, disable } = createAttributionFacade(ctx, state, { reviewerModel, services: loaded.original.inject })); }
    catch {
      // Explicit fixed selection is a security choice, not observational data.
      if (requiresFixedReviewer) throw new TypeError('Fixed reviewer facade could not be installed; refusing to register Auto');
      // Session mode can still retain the untouched official review gate.
      state.augmentationEnabled = false;
      state.missingProvenance += 1;
      state.status = 'disabled-missing';
    }
  }
  // No active-call collection or await here. The original lifecycle owns abort/drain.
  ctx.effect(function* () {
    yield ctx.provide('codexReviewAttribution', service);
    yield () => { state.augmentationEnabled = false; state.status = 'disposed'; disable(); };
  }, 'codex-review-attribution diagnostics');
  // Source mismatch disables attribution, not the official authorization gate.
  return loaded.original.apply(loaded.compatible ? facade : ctx);
}
