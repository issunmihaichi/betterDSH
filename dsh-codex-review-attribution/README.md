# dsh-codex-review-attribution 0.1.2

Host-only ESM companion. Adds request provenance and an optional fixed reviewer model to the **canonical official Auto review module**, without replacing its authorization implementation or mutating global LLM services.

## Compatibility boundary

`engines.dsh` is exactly `0.2.0-rc.2 || 0.2.1-rc.2`. Whole-module audits bind each SHA256 to its exact ordered inject contract:

| DSH | Official module SHA256 | Required services |
| --- | --- | --- |
| 0.2.0-rc.2 | `697b168133d5d9a3c2b33380cc407b8e94d9c454791b66d2173049af5e8d0033` | `approval,llm,permissionPresets,sessions,tools` |
| 0.2.1-rc.2 | `14b0fec944f734a888468b75ee9d7ae121383f018ce5bf76c4506393a910787f` | previous five + `workingDirectory` |

Both official modules were read in full (508 / 507 lines) and compared. The only changes are the extra service, passing resolved cwd into the snapshot, and awaiting `ctx.workingDirectory.ensure(agent, signal)` instead of trusting the old session-header cwd. The policy, history/source roles, native/PTC action validation, risk/decision parser, downstream checks, deny/ask behavior and abort/drain lifecycle are unchanged. They remain owned by the official module.

`originalModulePath` must identify the canonical installed ASAR entry, using an absolute path with this suffix:

```text
<host-install>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-experimental-auto-review/lib/index.js
```

The loader preserves realpath/canonical-suffix checks, source hashing before and after loading, official name/apply/export shape validation, and exact hash-to-service-contract matching. There is no configurable digest allowlist. A new digest requires another full audit.

- Missing/unloadable module, unknown shape, or known digest paired with the wrong shape: refuse before Auto registration.
- Unknown digest with an otherwise recognized official shape, **session mode**: call the untouched official gate on the real context; disable attribution/model management (`disabled-incompatible`). This does not authorize disabling the official entry during deployment.
- Unknown digest or facade-construction failure with an **explicit fixed reviewer**: refuse before Auto registration. Never silently substitute the session model.
- Per-request provenance/UUID augmentation failure: retain the selected reviewer and official gate. Provider, catalog, stream and snapshot errors never become allow.

## Service injection and lifecycle

The outer plugin retains the original five required services, so old hosts do not wait for a nonexistent `workingDirectory`. For a six-service official module, `ctx.inject(['workingDirectory'], ...)` creates a dependency-owned child containing the complete official gate, diagnostics and model management. It advertises no Auto until the service exists. Service loss/replacement invokes official close/abort/drain and cleanup; arrival/replacement creates a fresh gate. There is **no** fake cwd service or old-header fallback on the new host.

The ordinary, non-Proxy attribution facade explicitly exposes the original module's audited services, including dynamically reflected `workingDirectory`. Getters and methods use the real scoped receiver. The actual `ensure` receives the original agent and the official combined execution/lifecycle signal. The fixed-model directory is obtained through public `ctx.get('loader')`, including sibling loader services. The configured companion entry's settings namespace is explicitly carried across the dependency child (which has no loader entry of its own).

Official disposal still owns Auto-session reset to `danger-full-access`, cancellation and drain. This companion introduces no competing active-call wait. Do not unload a live gate merely to refresh its code.

## Reviewer selection and provenance

```yaml
reviewerModel: { mode: session } # default: session request-header route
# or
reviewerModel: { mode: fixed, provider: pool-my-group, model: exact-model-id }
```

Only `reviewerModel` is volatile. Selection is captured at each review-stream invocation and checked against active advertised pool models before dispatch. A selected model/loader/catalog failure denies the review; no retry/fallback to the session route. Cancellation interrupts model discovery before dispatch. Saving selection does not remount the gate or modify chat/session request headers.

The synchronous facade stream wrapper retains official policy, prompt, temperature and signal references, preserves frozen options, and adds only:

```js
codexRequestProvenance: Object.freeze({
  version: 1, kind: 'auto-review', ownerSessionId, requestId,
})
```

`next` exits the AsyncLocalStorage review context. Unrelated streams, non-Auto sessions, no-agent calls and outer `run_code` transport remain untouched. The official gate still reviews each native call and each started PTC inner call.

Authenticated host connection endpoint: `GET /api/autoReview.model`, and `POST` with `{selection,expectedRevision?}`. Writes use official whole-union `settings.mutate`; active pool namespaces and advertised model routes are intersected. No credentials, absolute source paths or raw loader errors are exposed. Invalid selection: 400; revision conflict: 409; unavailable/incompatible: 503. The endpoint is removed with its dependency-owned gate.

Diagnostics use the fiber-owned `codexReviewAttribution` service. `snapshot()` returns frozen primitive-only state: `{version,compatible,augmentationEnabled,moduleSha256,augmentedRequests,missingProvenance,status}`. Status is `enabled`, `disabled-incompatible`, `disabled-missing`, or `disposed`.

## Offline validation

This repair was performed only in the isolated `review` work copy. No installed plugin, profile/configuration, old backup, ASAR or extracted core was modified. No DSH update/restart, profile invocation, deployment preflight, real model request or paid call was performed.

Tests run unmodified official current/target modules and each version's actual Cordis, stream assembler and value utilities. Only external service implementations/constants/branding are isolated. Schemastery 3.18.4 and cosmokit 1.8.5 were copied read-only from the old source into local test dependencies; no installation/download was needed. Test-only loader hooks cannot enter the published package. Fixtures live inside fake `app.asar` folders **only for offline loading**; they are not deployable original-module paths.

This repository **does not redistribute** the host-extracted fixtures. The mock and reviewer-model suites run anywhere; the compatibility suites (`update-compat`, `authorization-update`, `cordis-update`) require you to extract the audited official modules from your own installed DSH into `tools/fixtures/{current,target}/app.asar/dsh/node_modules/@deepseek-ai/dsh-experimental-auto-review/lib/index.js` first.

Run from this package directory using Node 24.21.0:

```powershell
# default: no host files required
node --test ./tools/mock-test.mjs ./tools/reviewer-model-test.mjs

# compatibility: after placing local fixtures
node --import ./tools/offline-hooks.mjs --test ./tools/update-compat-test.mjs ./tools/authorization-update-test.mjs ./tools/cordis-update-test.mjs
```

The first target regression actually failed on original 0.1.1 with `Official auto-review module shape is incompatible; refusing to register Auto` (1 test, 0 pass). Additional retained RED runs exposed Cordis invalid-effect return, dynamic-child settings namespace loss, and unsafe fixed-reviewer fallback. In the private work copy with locally generated fixtures the full run was **140/140 tests passing, zero failed/skipped**, plus **6/6 runtime syntax checks**. Offline test hooks require a Node version with `module.registerHooks` (Node 24 does); this does not expand the runtime dependency surface of the plugin.

Coverage: both versions; native/PTC allow/deny and ask/never; exact literal outcomes plus direct-official/augmented differential checks; malformed/duplicate JSON and forbidden risk combinations; stream/provider/snapshot errors; canonical/hash/shape refusal/degradation; true `ensure` receiver/agent/signal/cwd forwarding; fixed route/volatile snapshots; unavailable catalogs; sibling-loader visibility; authenticated management; real Cordis service arrival/loss/replacement; abort-before-drain in directory resolution, provider stream, model discovery and downstream waiting; Auto/handler/diagnostic/endpoint cleanup.

Not verified: actual tool bodies/PTC executor/agent loop, complete durable production histories, live providers, Web UI, actual ASAR loading via Electron, actual profile replacement/restart. Offline success is not live deployment authorization.

## Deployment is a separate authorized operation

The bundle patch remains disabled-by-default and **does not disable the official entry**. Runtime publication remains restricted to `lib`, patch, README and LICENSE; tests, copied official sources, dependencies and artifacts are not part of the package files whitelist. Historical installed/preflight CLI scripts are not included in this isolated repair copy; the read-only exported loader/preflight API is retained unchanged and was not invoked for deployment here.

A parent/operator must separately verify the real installed module path, digest, service readiness, companion activation and fixed pool route under an explicit deployment authorization. Never enable both official and companion gates; never leave the official entry disabled after any compatibility/activation error. Keep a rollback plan and clear module caches only in a separately authorized maintenance/restart window. This repair does not package or deploy anything.
