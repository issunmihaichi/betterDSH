export const MODEL_ROUTE = '/api/autoReview.model';
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
const live = value => typeof value?.get === 'function' ? value.get() : value;

export function validateSelection(value = { mode: 'session' }) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Reviewer selection must be an object');
  const keys = Object.keys(value);
  if (value.mode === 'session' && keys.length === 1) return Object.freeze({ mode: 'session' });
  if (value.mode === 'fixed' && keys.length === 3 && ['provider', 'model'].every(key => typeof value[key] === 'string' && value[key].trim().length > 0 && value[key] === value[key].trim())) {
    return Object.freeze({ mode: 'fixed', provider: value.provider, model: value.model });
  }
  throw new TypeError('Select session mode or an exact fixed provider/model route');
}

export const currentSelection = config => validateSelection(live(config.reviewerModel));

function abortable(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Reviewer aborted'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Pool choices come from the registered route directory, not credentials or a copied catalog. */
export function poolNamespacesFor(ctx) {
  const loader = ctx.get?.('loader') ?? ctx.root?.loader ?? ctx.loader;
  return new Set([...loader.entries()].filter(entry => entry.options.name === 'dsh-account-pool' && entry.fiber !== undefined).map(entry => entry.options.id));
}

export async function reviewerChoices(llm, signal, poolNamespaces) {
  const active = new Set(llm.listProviders().map(row => row.id));
  const directory = llm.listConfigurableProviders().filter(row => row.provider.startsWith('pool-') && active.has(row.provider) && (poolNamespaces === undefined || poolNamespaces.has(row.settingsNs)));
  const choices = [];
  for (const row of directory) {
    for (const model of await abortable(llm.listModels(row.provider), signal)) choices.push({ provider: row.provider, providerName: row.displayName, model: model.id, modelName: model.name });
  }
  return choices;
}

export async function assertAvailableSelection(llm, selection, signal, poolNamespaces) {
  if (selection.mode === 'session') return;
  const choices = await reviewerChoices(llm, signal, poolNamespaces);
  if (!choices.some(row => row.provider === selection.provider && row.model === selection.model)) throw new TypeError('The selected reviewer provider/model is not an available pool model');
}

/** Selection is captured synchronously, then verified before dispatch; failure never falls back. */
export function streamFixedReviewer(llm, options, selection, poolNamespaces) {
  const forwarded = { ...options, provider: selection.provider, model: selection.model };
  if (Object.isFrozen(options)) Object.freeze(forwarded);
  return (async function* () {
    options.signal?.throwIfAborted();
    await assertAvailableSelection(llm, selection, options.signal, poolNamespaces);
    options.signal?.throwIfAborted();
    yield* llm.stream.call(llm, forwarded);
  })();
}

/** Register only on the host's authenticated connection fetch channel. */
export function installReviewerManagement(ctx, config, loaded, { settingsNs = ctx.fiber?.entry?.options?.id } = {}) {
  if (typeof ctx.inject !== 'function') return;
  ctx.inject(['connection', 'settings'], child => {
    // A workingDirectory dependency child has no loader entry of its own.
    // The namespace belongs to the owning configured companion entry.
    if (typeof settingsNs !== 'string' || settingsNs.length === 0) return;
    const settings = child.settings;
    const describe = () => settings.describe({ redactSecrets: true }).find(row => row.ns === settingsNs);
    const snapshot = async () => {
      const descriptor = describe();
      if (!descriptor) throw new Error('Reviewer live settings are unavailable');
      return { version: 1, available: loaded.compatible, compatible: loaded.compatible, settingsNs, revision: descriptor.revision,
        selection: currentSelection(config), choices: await reviewerChoices(ctx.llm, undefined, poolNamespacesFor(ctx)), applies: 'next-review' };
    };
    child.effect(() => child.connection.fetch.register({
      path: MODEL_ROUTE, methods: ['GET', 'POST'], requestBody: 'buffered',
      fetch: async request => {
        if (!loaded.compatible || ctx.get?.('codexReviewAttribution')?.snapshot().augmentationEnabled === false) return json({ error: { code: 'reviewer-unavailable', message: 'Installed Auto review is not compatible with reviewer model selection' } }, 503);
        try {
          if (request.method === 'POST') {
            let body, selection;
            try {
              body = await request.json();
              if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['selection', 'expectedRevision'].includes(key)) || !Object.hasOwn(body, 'selection')) throw new TypeError('Invalid reviewer settings request');
              selection = validateSelection(body.selection);
              if (body.expectedRevision !== undefined && (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0)) throw new TypeError('Invalid settings revision');
              await assertAvailableSelection(ctx.llm, selection, undefined, poolNamespacesFor(ctx));
            } catch { return json({ error: { code: 'invalid-reviewer-selection', message: 'Select session mode or an available exact pool provider/model' } }, 400); }
            const descriptor = describe();
            if (!descriptor) return json({ error: { code: 'reviewer-unavailable', message: 'Reviewer live settings are unavailable' } }, 503);
            // Replace the whole volatile union; recursive update would retain fixed-route keys in session mode.
            await settings.mutate(settingsNs, [{ op: 'set', path: ['reviewerModel'], value: selection }], body.expectedRevision ?? descriptor.revision);
          }
          return json(await snapshot());
        } catch (error) {
          if (error?.name === 'SettingsConflictError' || error?.constructor?.name === 'SettingsConflictError') return json({ error: { code: 'settings-conflict', message: 'Reviewer settings changed; reload before saving' } }, 409);
          // Never publish loader errors, configuration paths, or original-module details.
          return json({ error: { code: 'reviewer-unavailable', message: 'Reviewer settings could not be read or saved' } }, 503);
        }
      },
    }), 'auto-review model management');
  });
}
