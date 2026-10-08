/**
 * Claude Code mode — the module GROUP.
 *
 * "Claude Code mode" is not one function. It is a group of small, single-purpose
 * modules, executed in a fixed order by the controller in this file. Each module
 * owns exactly one fact about what the official CLI looks like, which is what makes
 * the disguise testable piece by piece: a wrong beta set, a wrong fingerprint and a
 * wrong `user_id` framing are three separate bugs with three separate fixes, and
 * collapsing them into one function would make any of them invisible.
 *
 *   betas     → which `anthropic-beta` tokens this auth mode may claim
 *   identity  → the persistent device id / account uuid / session uuid
 *   billing   → the `x-anthropic-billing-header` attribution block
 *   system    → the three-block `system` array + migrating the caller's text
 *   metadata  → `metadata.user_id` in the framing the claimed version uses
 *   defaults  → the fields the CLI always sends (`temperature`, `tools`, and the
 *               `context_management` block that comes with enabled thinking)
 *   headers   → the CLI header set, merged over the request's own
 *
 * The order is a contract, not a preference:
 *   - `identity` must precede `metadata` (it produces the triple) and `headers`
 *     (the session id must agree with `user_id`);
 *   - `billing` must precede `system`, which embeds the billing text as block 0;
 *   - `betas` must precede `headers`, which publishes the beta header;
 *   - `headers` runs last so it can see everything the other modules resolved.
 *
 * The controller also refuses to run twice on one body. That guard is not
 * defensive padding: a second pass would read the already-rebuilt `system` array as
 * "the caller's system prompt" and migrate the CLI's own blocks into the message
 * history, producing a request that is obviously not the CLI.
 *
 * Scope note. DESIGN.md §1 originally declared upstream impersonation out of scope,
 * because it is the bulk of sub2api's work and a permanent maintenance fight. This
 * group is that decision deliberately reversed for ONE opt-in account at a time
 * (`account.mimicry === 'claude-code'`), and it exists for a concrete reason rather
 * than for completeness: Anthropic scopes subscription (OAuth) credentials to
 * Claude Code, so a pool holding subscription accounts cannot use them at all
 * without looking like the CLI.
 */
import { BILLING_HEADER_PREFIX, MIMICRY_CLAUDE_CODE, MIMICRY_OFF, MIMICRY_MODES, AUTH_MODES } from './constants.js';
import { betaHeaderFor, betasModule } from './betas.js';
import { billingModule } from './billing.js';
import { defaultsModule } from './defaults.js';
import { headersModule } from './headers.js';
import { identityModule } from './identity.js';
import { metadataModule } from './metadata.js';
import { systemModule } from './system.js';
import { cliVersionFor } from './version.js';

export { AUTH_MODES, MIMICRY_CLAUDE_CODE, MIMICRY_MODES, MIMICRY_OFF };

/**
 * The registry. Adding a module means adding a row here, and nothing else — the
 * controller iterates this list rather than calling modules by name.
 */
export const CLAUDE_CODE_MODULES = [
  betasModule,
  identityModule,
  billingModule,
  systemModule,
  metadataModule,
  defaultsModule,
  headersModule,
];

/** Module names, in execution order — for reporting and for targeted disabling. */
export const MODULE_NAMES = CLAUDE_CODE_MODULES.map((module) => module.name);

/** Whether this account should have its traffic disguised at all. */
export function isClaudeCodeModeEnabled(account) {
  return account?.platform === 'anthropic' && account?.mimicry === MIMICRY_CLAUDE_CODE;
}

/**
 * Whether a body has already been through the group.
 *
 * Detected from the billing block being `system[0]`, which is the one thing only
 * this group produces.
 */
export function isAlreadyDisguised(body) {
  const first = Array.isArray(body?.system) ? body.system[0] : undefined;
  return typeof first?.text === 'string' && first.text.startsWith(BILLING_HEADER_PREFIX);
}

/**
 * Build the plan the modules read and extend.
 *
 * The version is resolved ONCE here and placed on the plan, so the `User-Agent`, the
 * billing block and the `user_id` framing cannot disagree within one request.
 */
export function createPlan({ account, request = {}, body, headers = {} }) {
  return {
    account,
    request,
    body,
    headers,
    version: cliVersionFor(account),
  };
}

/**
 * Execute the group.
 *
 * @param plan - from {@link createPlan}.
 * @param options.modules - overrides the registry (tests use this to isolate one stage).
 * @param options.disabled - module names to skip, so the group can run partially.
 * @returns the module names that actually ran, in order.
 */
export function runClaudeCodeModules(plan, { modules = CLAUDE_CODE_MODULES, disabled = [] } = {}) {
  const skip = new Set(disabled);
  const executed = [];
  for (const module of modules) {
    if (skip.has(module.name)) continue;
    module.apply(plan);
    executed.push(module.name);
  }
  plan.executed = executed;
  return executed;
}

/**
 * The group's single entry point: disguise one Anthropic request in place.
 *
 * Mutates `body` and `headers` because both were built by the caller for this one
 * request, so copying them would only cost allocation.
 *
 * @returns `{ executed, plan }`; `executed` is empty (and `plan` undefined) when the
 *   account is not in Claude Code mode, the body is unusable, or the body was
 *   already disguised.
 */
export function applyClaudeCodeMode({ account, request = {}, body, headers = {}, modules, disabled } = {}) {
  if (!isClaudeCodeModeEnabled(account)) return { executed: [], plan: undefined };
  if (body === null || typeof body !== 'object') return { executed: [], plan: undefined };
  if (isAlreadyDisguised(body)) return { executed: [], plan: undefined, skipped: 'already-applied' };

  const plan = createPlan({ account, request, body, headers });
  const executed = runClaudeCodeModules(plan, { modules, disabled });
  return { executed, plan };
}

// -------------------------------------------------------------- re-exports
// Everything below is a small module's own export, surfaced through the group so
// callers (and the tests) have one import site instead of reaching into the group's
// internals.
export { accountExtraBetas, betaHeaderFor, FULL_MIMICRY_BETAS, API_KEY_MIMICRY_BETAS, OAUTH_ONLY_BETA } from './betas.js';
export { billingAttributionText, claudeCodeFingerprint, firstUserText } from './billing.js';
export { DEFAULT_TEMPERATURE, defaultContextManagement } from './defaults.js';
export { isOpus55 } from './model.js';
export { accountUuidFor, deviceIdFor, sessionIdFor } from './identity.js';
export { formatMetadataUserId, parseMetadataUserId } from './metadata.js';
export { buildSystemBlocks, extractSystemCacheControl, extractSystemText, hasClaudeCodePrefix, shouldMigrateSystem, systemMigrationMessages } from './system.js';
export { CLI_HEADER_DEFAULTS, mimicryHeaders } from './headers.js';
export { claudeCliUserAgent, cliVersionFor, compareVersions, isNewMetadataFormatVersion, parseVersion } from './version.js';
export {
  CLAUDE_CODE_PROMPT_PREFIXES,
  CLICurrentVersion,
  CONTEXT_1M_BETA,
  CONTEXT_MANAGEMENT_BETA,
  EXPANSION_PROMPT,
  FINGERPRINT_SALT,
  IDENTITY_BANNER,
  NEW_METADATA_FORMAT_MIN_VERSION,
} from './constants.js';
