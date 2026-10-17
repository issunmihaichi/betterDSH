import { Config } from './config.js';
import { ORIGINAL_INJECT, loadOriginal, preflight } from './original.js';
import { installOriginal } from './installation.js';
import { currentSelection, installReviewerManagement } from './reviewer-model.js';

export const name = 'dsh-codex-review-attribution';
export const inject = [...ORIGINAL_INJECT];
export { Config, preflight };

/** Apply exactly the installed official gate; augment only an audited compatible module. */
export function apply(ctx, config) {
  const loaded = loadOriginal(config); // throws before Auto registration on load/shape failure
  const settingsNs = ctx.fiber?.entry?.options?.id;
  const install = host => {
    const result = installOriginal(host, loaded, { reviewerModel: () => currentSelection(config) });
    installReviewerManagement(host, config, loaded, { settingsNs });
    return result;
  };
  const additionalServices = loaded.original.inject.filter(service => !ORIGINAL_INJECT.includes(service));
  // Old hosts never wait for a service they do not have. On new hosts the child
  // fiber owns the *entire* gate so loss/replacement of workingDirectory invokes
  // official abort/drain before that dependency can be used again.
  if (additionalServices.length && typeof ctx.inject === 'function') {
    ctx.inject(additionalServices, install);
    // Cordis owns this fiber; returning it would be interpreted as an effect.
    return;
  }
  return install(ctx);
}

export default { name, inject, Config, apply };
