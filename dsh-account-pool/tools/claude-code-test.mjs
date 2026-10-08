/**
 * Claude Code mode tests.
 *
 * The mode is a MODULE GROUP, so these tests come in two layers and the split is
 * deliberate:
 *
 *   1. group mechanics — the controller's contract: registry order, what "off"
 *      means, the double-application guard, and targeted module disabling.
 *   2. one block per small module — each module's own fact, asserted against a
 *      literal recovered from the real CLI rather than against another one of our
 *      own functions, so a change in the algorithm cannot pass by agreeing with
 *      itself.
 *
 * The last layer drives the real transport, which is where a disguise that is
 * internally consistent but never actually sent would be caught.
 *
 *   node tools/claude-code-test.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  API_KEY_MIMICRY_BETAS,
  CLAUDE_CODE_MODULES,
  CLAUDE_CODE_PROMPT_PREFIXES,
  CLICurrentVersion,
  CONTEXT_1M_BETA,
  CONTEXT_MANAGEMENT_BETA,
  EXPANSION_PROMPT,
  FULL_MIMICRY_BETAS,
  IDENTITY_BANNER,
  MODULE_NAMES,
  OAUTH_ONLY_BETA,
  accountExtraBetas,
  accountUuidFor,
  applyClaudeCodeMode,
  betaHeaderFor,
  billingAttributionText,
  claudeCodeFingerprint,
  claudeCliUserAgent,
  compareVersions,
  createPlan,
  deviceIdFor,
  extractSystemText,
  firstUserText,
  formatMetadataUserId,
  isAlreadyDisguised,
  isClaudeCodeModeEnabled,
  isNewMetadataFormatVersion,
  isOpus55,
  parseMetadataUserId,
  runClaudeCodeModules,
  sessionIdFor,
  shouldMigrateSystem,
} from '../lib/claude-code/index.js';
import { anthropicMessagesUrl, buildAnthropicRequest, createHttpUpstream } from '../lib/upstream.js';
import { accountSchema, makeAccount } from '../lib/domain.js';
import { applyAccountAction } from '../lib/kernel.js';
import { toDraft } from '../lib/importer.js';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');

let checks = 0;
let passed = 0;
const failures = [];

async function check(label, fn) {
  checks += 1;
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failures.push({ label, error });
  }
}

// --------------------------------------------------------------- fixtures

const VERSION = CLICurrentVersion;
const FIRST_TEXT = 'Hello, please summarise the attached file for me.';

/** The canonical probe body: one user turn, no system, no tools. */
function probeBody() {
  return { model: 'claude-sonnet-4-5', max_tokens: 1024, stream: true, messages: [{ role: 'user', content: [{ type: 'text', text: FIRST_TEXT }] }] };
}

/** A pool account in Claude Code mode, as the domain would store it. */
function codeAccount(overrides = {}) {
  return makeAccount({ id: 'a1', platform: 'anthropic', authMode: 'oauth', mimicry: 'claude-code', ...overrides });
}

/** Apply the group and hand back the mutated body + headers. */
function disguise(account, body = probeBody(), request = { sessionId: 's1', requestId: 'req-1' }) {
  const headers = {};
  const result = applyClaudeCodeMode({ account, request, body, headers });
  return { body, headers, result };
}

// ======================================================= group mechanics

await check('group: the registry runs in the documented order', async () => {
  assert.deepEqual(MODULE_NAMES, ['betas', 'identity', 'billing', 'system', 'metadata', 'defaults', 'headers']);
  assert.equal(CLAUDE_CODE_MODULES.length, MODULE_NAMES.length);
});

await check('group: every module declares a name and a purpose', async () => {
  for (const module of CLAUDE_CODE_MODULES) {
    assert.equal(typeof module.name, 'string', 'a module needs a name');
    assert.equal(typeof module.purpose, 'string', `${module.name} needs a stated purpose`);
    assert.equal(typeof module.apply, 'function', `${module.name} needs apply()`);
  }
});

await check('group: mode off leaves the body object untouched, not merely equal', async () => {
  const account = makeAccount({ id: 'a1', platform: 'anthropic', mimicry: 'off' });
  const body = probeBody();
  const before = JSON.stringify(body);
  const { result } = disguise(account, body);
  assert.deepEqual(result.executed, [], 'no module runs when the mode is off');
  assert.equal(result.plan, undefined);
  assert.equal(JSON.stringify(body), before);
});

await check('group: a non-anthropic platform never enters the mode', async () => {
  const account = makeAccount({ id: 'a1', platform: 'openai', mimicry: 'claude-code' });
  assert.equal(isClaudeCodeModeEnabled(account), false, 'the disguise is Anthropic-only');
  const { result } = disguise(account);
  assert.deepEqual(result.executed, []);
});

await check('group: a second pass is refused rather than re-migrating the CLI blocks', async () => {
  const account = codeAccount();
  const body = probeBody();
  const headers = {};

  const first = applyClaudeCodeMode({ account, request: { sessionId: 's1' }, body, headers });
  assert.deepEqual(first.executed, MODULE_NAMES, 'the first pass runs every module');
  assert.equal(isAlreadyDisguised(body), true);

  const messagesAfterFirst = JSON.parse(JSON.stringify(body.messages));
  const second = applyClaudeCodeMode({ account, request: { sessionId: 's1' }, body, headers });

  assert.deepEqual(second.executed, [], 'the second pass runs nothing');
  assert.equal(second.skipped, 'already-applied');
  assert.deepEqual(
    body.messages,
    messagesAfterFirst,
    'a second pass would read the CLI system blocks as "the caller prompt" and duplicate them into the history',
  );
});

await check('group: disabling a module skips exactly that module', async () => {
  const plan = createPlan({ account: codeAccount(), request: { sessionId: 's1' }, body: probeBody(), headers: {} });
  const executed = runClaudeCodeModules(plan, { disabled: ['billing', 'defaults'] });
  assert.deepEqual(executed, ['betas', 'identity', 'system', 'metadata', 'headers']);
  assert.equal(plan.billingText, undefined, 'the disabled billing module produced nothing');
  assert.equal(plan.betas, betaHeaderFor('oauth'), 'the enabled betas module still ran');
});

await check('group: a plan resolves the version once, so the request cannot contradict itself', async () => {
  const plan = createPlan({ account: codeAccount(), body: probeBody(), headers: {} });
  assert.equal(plan.version, VERSION);
  const pinned = createPlan({ account: codeAccount({ mimicryCliVersion: '2.1.300' }), body: probeBody(), headers: {} });
  assert.equal(pinned.version, '2.1.300');
});

// ======================================================= module: betas

await check('betas: oauth claims the full official set, api-key must not claim oauth', async () => {
  const oauth = betaHeaderFor('oauth').split(',');
  assert.deepEqual(oauth, FULL_MIMICRY_BETAS);
  assert.ok(oauth.includes(OAUTH_ONLY_BETA), 'an OAuth request is rejected without oauth-2025-04-20');

  const key = betaHeaderFor('api-key').split(',');
  assert.deepEqual(key, API_KEY_MIMICRY_BETAS);
  assert.ok(!key.includes(OAUTH_ONLY_BETA), 'oauth-* is only valid for OAuth credentials');
  assert.ok(key.includes('claude-code-20250219'), 'the claude-code beta is what keeps the request first-party');
});

await check('betas: an account\'s own tokens are appended without disturbing the base set', async () => {
  // The measured case: Anyrouter answers 400 「1m 上下文已经全量可用，请启用 1m
  // 上下文后重试」 to every request that does not claim 1M context, and that 400
  // lands BEFORE the first SSE event, so the turn produced nothing at all.
  const tokens = betaHeaderFor('api-key', [CONTEXT_1M_BETA]).split(',');
  assert.deepEqual(tokens.slice(0, API_KEY_MIMICRY_BETAS.length), API_KEY_MIMICRY_BETAS, 'the base set stays intact AND first');
  assert.equal(tokens.at(-1), CONTEXT_1M_BETA, 'the account token is appended after it');
  assert.equal(tokens.filter((token) => token === CONTEXT_1M_BETA).length, 1, 'the same beta is never repeated');

  assert.deepEqual(betaHeaderFor('api-key', [CONTEXT_1M_BETA, CONTEXT_1M_BETA]), betaHeaderFor('api-key', [CONTEXT_1M_BETA]));
  assert.equal(betaHeaderFor('api-key'), API_KEY_MIMICRY_BETAS.join(','), 'declaring nothing keeps the byte-for-byte old header');
  assert.equal(betaHeaderFor('oauth', [CONTEXT_1M_BETA]).split(',').at(-1), CONTEXT_1M_BETA, 'and an OAuth account may add one too');
});

await check('betas: the account list is filtered, so a blank entry cannot empty the header', async () => {
  assert.deepEqual(accountExtraBetas({ betas: [' a ', '', '  ', 7, null, CONTEXT_1M_BETA, 'a'] }), ['a', CONTEXT_1M_BETA]);
  assert.deepEqual(accountExtraBetas({}), [], 'a missing list is empty');
  assert.deepEqual(accountExtraBetas({ betas: 'not-a-list' }), [], 'a wrong type is not trusted');
});

// ======================================================= module: identity

await check('identity: the device id is 64 hex and constant for one account', async () => {
  const account = codeAccount();
  const once = deviceIdFor(account);
  assert.match(once, /^[0-9a-f]{64}$/);
  assert.equal(deviceIdFor(account), once, 'a device id that drifted per call would look like a new client every request');
  assert.notEqual(deviceIdFor(codeAccount({ id: 'a2' })), once, 'two accounts must not share an identity');
});

await check('identity: the account uuid is UUID-shaped and stable', async () => {
  const value = accountUuidFor(codeAccount());
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(value, '6a57bc67-3a21-4704-b516-32510733ba25', 'derived from the account id, so it must not move');
});

await check('identity: the session uuid follows the caller session and the account', async () => {
  const account = codeAccount();
  const a = sessionIdFor(account, 's1');
  assert.equal(sessionIdFor(account, 's1'), a, 'the same session must keep the same uuid across turns');
  assert.notEqual(sessionIdFor(account, 's2'), a, 'a different session is a different conversation');
  assert.notEqual(sessionIdFor(codeAccount({ id: 'a2' }), 's1'), a, 'and the same session on another account is another identity');
});

await check('identity: pinned values win over derivation', async () => {
  const account = codeAccount({
    mimicryClientId: 'f'.repeat(64),
    mimicryAccountUuid: '11111111-2222-4333-8444-555555555555',
  });
  const { body } = disguise(account);
  const parsed = parseMetadataUserId(body.metadata.user_id);
  assert.equal(parsed.deviceId, 'f'.repeat(64));
  assert.equal(parsed.accountUuid, '11111111-2222-4333-8444-555555555555');
});

// ======================================================= module: billing

await check('billing: the fingerprint matches the value recovered from the real algorithm', async () => {
  // Independently recomputed here from the documented rule, with the literals that
  // make it a real check: the salt, the three byte indices, and a 3-hex truncation.
  const chars = [4, 7, 20].map((i) => FIRST_TEXT[i]).join('');
  assert.equal(chars, 'opi', 'the probe text must still expose characters at 4/7/20');
  const expected = createHash('sha256').update(`59cf53e54c78${chars}${VERSION}`, 'utf8').digest('hex').slice(0, 3);
  assert.equal(expected, '635');
  assert.equal(claudeCodeFingerprint(probeBody(), VERSION), '635');
});

await check('billing: the attribution line is byte-exact', async () => {
  assert.equal(
    billingAttributionText(probeBody(), VERSION),
    'x-anthropic-billing-header: cc_version=2.1.258.635; cc_entrypoint=cli;',
  );
  assert.ok(
    !billingAttributionText(probeBody(), VERSION).includes('cch='),
    'the official client stopped sending cch=, so injecting it would be LESS like the CLI',
  );
});

await check('billing: the fingerprint indexes BYTES, not UTF-16 code units', async () => {
  // Regression guard for the byte/code-unit decision. A first message containing
  // non-ASCII text is the only input where the two disagree, so this is the one
  // case that proves the implementation indexes bytes.
  const text = '中文测试文本用于验证字节偏移是否一致';
  const body = { messages: [{ role: 'user', content: [{ type: 'text', text }] }] };

  const bytes = Buffer.from(text, 'utf8');
  const byteChars = [4, 7, 20].map((i) => (i < bytes.length ? String.fromCharCode(bytes[i]) : '0')).join('');
  const naiveChars = [4, 7, 20].map((i) => (i < text.length ? text[i] : '0')).join('');
  assert.notEqual(byteChars, naiveChars, 'the fixture must actually distinguish the two indexings');

  const expected = createHash('sha256').update(`59cf53e54c78${byteChars}${VERSION}`, 'utf8').digest('hex').slice(0, 3);
  const naive = createHash('sha256').update(`59cf53e54c78${naiveChars}${VERSION}`, 'utf8').digest('hex').slice(0, 3);
  const actual = claudeCodeFingerprint(body, VERSION);

  assert.equal(actual, expected, 'the fingerprint must use byte offsets, as the original does');
  assert.notEqual(actual, naive, 'and must NOT be the UTF-16 reading');
});

await check('billing: the first user text is read through both content shapes', async () => {
  assert.equal(firstUserText({ messages: [{ role: 'user', content: 'plain' }] }), 'plain');
  assert.equal(firstUserText({ messages: [{ role: 'user', content: [{ type: 'text', text: 'blocky' }] }] }), 'blocky');
  assert.equal(
    firstUserText({ messages: [{ role: 'assistant', content: 'skip me' }, { role: 'user', content: 'second' }] }),
    'second',
    'the first USER turn, not the first turn',
  );
  assert.equal(firstUserText({ messages: [] }), '');
  assert.equal(firstUserText({}), '');
});

// ======================================================= module: system

await check('system: the three blocks match the CLI shape, and only the last carries a breakpoint', async () => {
  const { body } = disguise(codeAccount());
  assert.equal(body.system.length, 3);
  assert.equal(body.system[0].type, 'text');
  assert.match(body.system[0].text, /^x-anthropic-billing-header: cc_version=2\.1\.258\.[0-9a-f]{3}; cc_entrypoint=cli;$/);
  assert.equal(body.system[0].cache_control, undefined, 'the CLI puts no breakpoint on the billing block');
  assert.equal(body.system[1].text, IDENTITY_BANNER);
  assert.equal(body.system[1].cache_control, undefined, 'the identity prefix is not a cache boundary either');
  assert.equal(body.system[2].text, EXPANSION_PROMPT);
  assert.deepEqual(body.system[2].cache_control, { type: 'ephemeral', ttl: '5m' });
});

await check('system: the caller system text is migrated into the history, not prefixed', async () => {
  const body = probeBody();
  body.system = 'You are a helpful assistant for invoices.';
  disguise(codeAccount(), body);

  assert.equal(body.messages.length, 3, 'the migrated pair is prepended to the original turn');
  assert.equal(body.messages[0].role, 'user');
  assert.equal(body.messages[0].content[0].text, '[System Instructions]\nYou are a helpful assistant for invoices.');
  assert.equal(body.messages[1].role, 'assistant');
  assert.equal(body.messages[1].content[0].text, 'Understood. I will follow these instructions.');
  assert.equal(body.messages[2].content[0].text, FIRST_TEXT, 'the caller turn survives, in order');

  const joined = JSON.stringify(body.system);
  assert.ok(!joined.includes('invoices'), 'and the caller text is no longer in `system` at all');
});

await check('system: no migration when there was no system, or it already IS the banner', async () => {
  const none = probeBody();
  disguise(codeAccount(), none);
  assert.equal(none.messages.length, 1, 'a request without a system prompt gains no bogus user turn');

  const already = probeBody();
  already.system = IDENTITY_BANNER;
  disguise(codeAccount(), already);
  assert.equal(already.messages.length, 1, 'a Claude Code client pointed at the pool must not double its banner');

  assert.equal(shouldMigrateSystem(''), false);
  assert.equal(shouldMigrateSystem(IDENTITY_BANNER), false);
  assert.equal(shouldMigrateSystem('anything else'), true);
});

await check('system: extraction handles a string, blocks, and junk', async () => {
  assert.equal(extractSystemText('  hi  '), 'hi');
  assert.equal(extractSystemText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\n\nb');
  assert.equal(extractSystemText([{ type: 'image' }]), '');
  assert.equal(extractSystemText(undefined), '');
});

await check('system: the expansion block keeps the captured `# Tone and style` stretch', async () => {
  // The block's job is SHAPE: it must be the text recovered from the CLI, not a
  // shortened paraphrase. Dropping the trailing section is exactly the drift this
  // pins down — the earlier version claimed to be verbatim while ending early.
  assert.ok(EXPANSION_PROMPT.includes('\n\n# Tone and style\n'), 'the captured section header must survive');
  assert.ok(
    EXPANSION_PROMPT.endsWith('should just be "Let me read the file." with a period.'),
    'and the block must run to the end of the captured section',
  );
  assert.ok(
    !EXPANSION_PROMPT.includes('# Doing tasks'),
    'tool-specific sections stay out: injecting them would hijack the proxied caller',
  );
});

await check('system: the caller cache breakpoint survives the migration', async () => {
  // cache_control is billing-relevant: dropping it silently re-bills the caller's
  // prefix at full price on every turn.
  const body = probeBody();
  body.system = [
    { type: 'text', text: 'You are a helpful assistant for invoices.' },
    { type: 'text', text: 'Second block.', cache_control: { type: 'ephemeral', ttl: '1h' } },
  ];
  disguise(codeAccount(), body);

  assert.equal(
    body.messages[0].content[0].text,
    '[System Instructions]\nYou are a helpful assistant for invoices.\n\nSecond block.',
  );
  assert.deepEqual(
    body.messages[0].content[0].cache_control,
    { type: 'ephemeral', ttl: '1h' },
    'the last original breakpoint moves with the text',
  );
});

await check('system: every first-party banner variant is recognised by PREFIX', async () => {
  for (const prefix of CLAUDE_CODE_PROMPT_PREFIXES) {
    assert.equal(shouldMigrateSystem(`${prefix}\n\nrest of the prompt`), false, `${prefix} is first-party, not foreign text`);
  }
  assert.equal(shouldMigrateSystem('You are a helpful assistant.'), true);
  assert.equal(shouldMigrateSystem(IDENTITY_BANNER), false, 'and the plain banner is covered by the first prefix');

  // An Agent SDK client pointed at the pool is a legitimate caller, not something
  // to "fix" by adding a turn the real CLI would never send.
  const sdk = probeBody();
  sdk.system = `${CLAUDE_CODE_PROMPT_PREFIXES[1]}.`;
  disguise(codeAccount(), sdk);
  assert.equal(sdk.messages.length, 1, 'no bogus [System Instructions] turn for a first-party caller');
});

// ======================================================= module: metadata

await check('metadata: a current CLI version gets the JSON framing and round-trips', async () => {
  const { body } = disguise(codeAccount());
  const raw = body.metadata.user_id;
  assert.equal(raw[0], '{', 'CLI >= 2.1.78 embeds a JSON document');

  const parsed = parseMetadataUserId(raw);
  assert.notEqual(parsed, null, 'the value must satisfy the upstream parser');
  assert.equal(parsed.isNewFormat, true);
  assert.equal(parsed.deviceId, '71aaf48998151d8d5a9b178e3da36a62b48861ef5ae67a9faad14444f49d7f24');
  assert.equal(parsed.sessionId, '0021af4b-e4f2-4182-b7b1-2b601a2ad8b3');
});

await check('metadata: an older pinned CLI version gets the legacy framing', async () => {
  const account = codeAccount({ mimicryCliVersion: '2.1.77' });
  const { body } = disguise(account);
  const raw = body.metadata.user_id;
  assert.match(raw, /^user_[0-9a-f]{64}_account_[0-9a-f-]{36}_session_[0-9a-f-]{36}$/);
  const parsed = parseMetadataUserId(raw);
  assert.equal(parsed.isNewFormat, false);
  assert.equal(parsed.sessionId, sessionIdFor(account, 's1'));
  assert.equal(isNewMetadataFormatVersion('2.1.77'), false);
  assert.equal(isNewMetadataFormatVersion('2.1.78'), true);
});

await check('metadata: unrelated metadata keys survive', async () => {
  const body = probeBody();
  body.metadata = { trace: 'keep-me' };
  disguise(codeAccount(), body);
  assert.equal(body.metadata.trace, 'keep-me');
  assert.equal(typeof body.metadata.user_id, 'string');
});

await check('metadata: the upstream parser rejects malformed values', async () => {
  assert.equal(parseMetadataUserId(''), null);
  assert.equal(parseMetadataUserId('user_short_account_x_session_y'), null);
  assert.equal(parseMetadataUserId('{"device_id":"d"}'), null, 'a session_id is required');
  assert.equal(parseMetadataUserId('{not json'), null);
});

await check('version: comparison is three-part numeric', async () => {
  assert.equal(compareVersions('2.1.9', '2.1.10'), -1);
  assert.equal(compareVersions('2.2.0', '2.1.99'), 1);
  assert.equal(compareVersions('2.1.78', '2.1.78'), 0);
  assert.equal(claudeCliUserAgent('2.1.258'), 'claude-cli/2.1.258 (external, cli)');
});

// ======================================================= module: defaults

await check('defaults: temperature and tools are filled, caller values respected', async () => {
  const filled = probeBody();
  disguise(codeAccount(), filled);
  assert.equal(filled.temperature, 1, 'the CLI always sends a temperature');
  assert.deepEqual(filled.tools, [], 'and always sends tools, empty when there are none');

  const kept = probeBody();
  kept.temperature = 0.2;
  kept.tools = [{ name: 'read', description: 'd', input_schema: { type: 'object' } }];
  disguise(codeAccount(), kept);
  assert.equal(kept.temperature, 0.2);
  assert.equal(kept.tools.length, 1);
});

await check('defaults: Opus 5.5 gets no temperature, because the real CLI omits it there', async () => {
  for (const model of ['claude-opus-5-5', 'claude-opus-5-5-thinking', 'anthropic/claude-opus-5.5']) {
    const body = probeBody();
    body.model = model;
    disguise(codeAccount(), body);
    assert.equal('temperature' in body, false, `${model} rejects temperature, so filling it is a 400`);
  }

  assert.equal(isOpus55('claude-opus-5'), false, 'plain Opus 5 is a different model and does accept it');
  assert.equal(isOpus55('claude-opus-5-50'), false, 'a same-prefix id must not be folded into the family');
  assert.equal(isOpus55('claude-sonnet-4-5'), false);

  const other = probeBody();
  other.model = 'claude-sonnet-4-5';
  disguise(codeAccount(), other);
  assert.equal(other.temperature, 1);
});

await check('defaults: thinking gets the CLI context_management block the claimed beta requires', async () => {
  // The betas module claims context-management-2025-06-27; sending that beta with
  // no context_management field is an internal contradiction, and the real CLI
  // never does it.
  for (const type of ['enabled', 'adaptive']) {
    const body = probeBody();
    body.thinking = { type };
    disguise(codeAccount(), body);
    assert.deepEqual(body.context_management, { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] }, `${type} thinking carries the block`);
  }

  const off = probeBody();
  off.thinking = { type: 'disabled' };
  disguise(codeAccount(), off);
  assert.equal('context_management' in off, false, 'thinking off means no block');

  const explicit = probeBody();
  explicit.thinking = { type: 'enabled' };
  explicit.context_management = { edits: [{ type: 'keep_none' }] };
  disguise(codeAccount(), explicit);
  assert.deepEqual(explicit.context_management, { edits: [{ type: 'keep_none' }] }, 'an explicit value is never overwritten');

  // Header/body symmetry: the gating beta is OAuth-only, so an api-key account
  // must NOT be handed a field no beta it declared allows.
  assert.ok(FULL_MIMICRY_BETAS.includes(CONTEXT_MANAGEMENT_BETA), 'the OAuth set gates the field');
  assert.ok(!API_KEY_MIMICRY_BETAS.includes(CONTEXT_MANAGEMENT_BETA), 'the api-key set does not');

  const apiKey = probeBody();
  apiKey.thinking = { type: 'enabled' };
  disguise(codeAccount({ authMode: 'api-key' }), apiKey);
  assert.equal('context_management' in apiKey, false, 'no beta claimed it, so no field is added');

  const apiKeyExplicit = probeBody();
  apiKeyExplicit.thinking = { type: 'enabled' };
  apiKeyExplicit.context_management = { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] };
  const removedRun = disguise(codeAccount({ authMode: 'api-key' }), apiKeyExplicit);
  assert.equal('context_management' in apiKeyExplicit, false, 'and a stale field is stripped, not pushed upstream to be rejected');
  assert.deepEqual(removedRun.result.plan.removedDefaults, ['context_management'], 'the removal is reported, not silent');
});

// ======================================================= module: headers

await check('headers: the CLI header set is present and self-consistent', async () => {
  const { body, headers } = disguise(codeAccount());
  assert.equal(headers['user-agent'], 'claude-cli/2.1.258 (external, cli)');
  assert.equal(headers['x-app'], 'cli');
  assert.equal(headers['x-stainless-os'], 'Linux');
  assert.equal(headers['x-stainless-runtime-version'], 'v24.3.0');
  assert.equal(headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(headers['anthropic-beta'], FULL_MIMICRY_BETAS.join(','));

  const session = parseMetadataUserId(body.metadata.user_id).sessionId;
  assert.equal(headers['x-claude-code-session-id'], session, 'the header and the user_id must agree on the session');
  assert.equal(headers['x-client-request-id'], 'req-1', 'the per-request id is injectable');
});

await check('headers: an api-key account claims the api-key beta set', async () => {
  const { headers } = disguise(codeAccount({ authMode: 'api-key' }));
  assert.equal(headers['anthropic-beta'], API_KEY_MIMICRY_BETAS.join(','));
});

await check('headers: accept is application/json, and the helper marker only rides streaming requests', async () => {
  const { headers } = disguise(codeAccount());
  assert.equal(headers.accept, 'application/json', 'the real CLI sends application/json even while streaming');
  assert.equal(headers['x-stainless-helper-method'], 'stream', 'a streaming SDK call marks the transport helper');

  const nonStream = probeBody();
  nonStream.stream = false;
  const { headers: plain } = disguise(codeAccount(), nonStream);
  assert.equal('x-stainless-helper-method' in plain, false, 'a non-streaming request carries no helper marker');
});

await check('url: the Messages endpoint carries the CLI query, on any base shape', async () => {
  assert.equal(anthropicMessagesUrl('https://api.anthropic.com'), 'https://api.anthropic.com/v1/messages?beta=true');
  assert.equal(anthropicMessagesUrl('https://relay.example.com/anthropic/'), 'https://relay.example.com/anthropic/v1/messages?beta=true');
  assert.equal(
    anthropicMessagesUrl('https://relay.example.com/anthropic?key=k'),
    'https://relay.example.com/anthropic/v1/messages?key=k&beta=true',
    'a base that already has a query is joined with &, not a second ?',
  );
});

await check('headers: the version is the same in the UA, the billing block and the user_id framing', async () => {
  // The whole point of resolving the version once: a request that disagrees with
  // itself about which client it is, is worse than no disguise at all.
  const account = codeAccount({ mimicryCliVersion: '2.1.300' });
  const { body, headers } = disguise(account);
  assert.match(headers['user-agent'], /^claude-cli\/2\.1\.300 /);
  assert.match(body.system[0].text, /cc_version=2\.1\.300\./);
  assert.equal(parseMetadataUserId(body.metadata.user_id).isNewFormat, true, '2.1.300 is past the JSON-format threshold');
});

// ======================================================= transport integration

await check('transport: a "claude-code" account is disguised on the wire', async () => {
  const account = codeAccount();
  const request = buildAnthropicRequest(account, { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: [{ type: 'text', text: FIRST_TEXT }] }], system: 'Be terse.', sessionId: 's1', requestId: 'req-9' }, 'sk-abc', 4096);

  assert.equal(request.init.headers['user-agent'], 'claude-cli/2.1.258 (external, cli)');
  assert.equal(request.init.headers['x-app'], 'cli');
  assert.equal(request.init.headers.accept, 'application/json', 'the transport default is overridden by the disguise, not merged with it');
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages?beta=true', 'the CLI calls the beta endpoint');
  assert.equal(request.init.headers.authorization, 'Bearer sk-abc', 'the OAuth token must still travel as a bearer');
  assert.equal('x-api-key' in request.init.headers, false, 'and must not ALSO be sent as an api key');

  const sent = JSON.parse(request.init.body);
  assert.equal(sent.system.length, 3);
  assert.equal(sent.messages[0].content[0].text, '[System Instructions]\nBe terse.');
  assert.equal(parseMetadataUserId(sent.metadata.user_id).isNewFormat, true);
});

await check('transport: auth mode alone fixes the header, with no disguise', async () => {
  const oauth = buildAnthropicRequest(makeAccount({ id: 'o1', platform: 'anthropic', authMode: 'oauth' }), { model: 'm', messages: [], sessionId: 's1' }, 'tok', 4096);
  assert.equal(oauth.init.headers.authorization, 'Bearer tok');
  assert.equal(oauth.init.headers['anthropic-beta'], OAUTH_ONLY_BETA);
  assert.equal('x-api-key' in oauth.init.headers, false);
  assert.equal(JSON.parse(oauth.init.body).system, undefined, 'nothing is disguised when the mode is off');

  const key = buildAnthropicRequest(makeAccount({ id: 'k1', platform: 'anthropic' }), { model: 'm', messages: [], sessionId: 's1' }, 'sk-1', 4096);
  assert.equal(key.init.headers['x-api-key'], 'sk-1');
  assert.equal('authorization' in key.init.headers, false);
  assert.equal('anthropic-beta' in key.init.headers, false, 'a plain api-key request claims no betas');
});

await check('transport: an account\'s required beta reaches the wire in BOTH modes', async () => {
  const options = { model: 'claude-fable-5-1-reversed', messages: [], sessionId: 's1' };

  const disguised = buildAnthropicRequest(codeAccount({ betas: [CONTEXT_1M_BETA] }), options, 'sk-1', 4096);
  assert.deepEqual(
    disguised.init.headers['anthropic-beta'].split(',').filter((token) => token === CONTEXT_1M_BETA),
    [CONTEXT_1M_BETA],
    'in Claude Code mode the betas module carries it, exactly once',
  );

  const plain = buildAnthropicRequest(makeAccount({ id: 'k2', platform: 'anthropic', betas: [CONTEXT_1M_BETA] }), options, 'sk-1', 4096);
  assert.equal(plain.init.headers['anthropic-beta'], CONTEXT_1M_BETA, 'with no disguise the transport sets the header itself');

  const undeclared = buildAnthropicRequest(makeAccount({ id: 'k3', platform: 'anthropic' }), options, 'sk-1', 4096);
  assert.equal('anthropic-beta' in undeclared.init.headers, false, 'and an account that declares nothing is untouched');
});

await check('transport: the disguised request is what actually reaches fetch', async () => {
  const seen = [];
  const sse = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
    '',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
    '',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');

  const upstream = createHttpUpstream({
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return new Response(sse, { status: 200 });
    },
    resolveCredential: async () => 'oauth-token',
  });

  const account = codeAccount();
  for await (const _chunk of upstream.stream(account, { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: [{ type: 'text', text: FIRST_TEXT }] }], sessionId: 's1', requestId: 'fixed' })) {
    // drain
  }

  assert.equal(seen.length, 1);
  assert.equal(seen[0].init.headers['user-agent'], 'claude-cli/2.1.258 (external, cli)');
  assert.equal(seen[0].init.headers.authorization, 'Bearer oauth-token');
  assert.equal(seen[0].init.headers['x-claude-code-session-id'], sessionIdFor(account, 's1'));
  const sent = JSON.parse(seen[0].init.body);
  assert.match(sent.system[0].text, /^x-anthropic-billing-header:/);
  assert.equal(parseMetadataUserId(sent.metadata.user_id).accountUuid, '6a57bc67-3a21-4704-b516-32510733ba25');
});

await check('domain: the new fields default to "not disguised"', async () => {
  const account = accountSchema.parse({ id: 'x', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
  assert.equal(account.authMode, 'api-key');
  assert.equal(account.mimicry, 'off');
  assert.equal(account.mimicryClientId, null);
  assert.equal(account.mimicryAccountUuid, null);
  assert.equal(account.mimicryCliVersion, null);
  assert.equal(JSON.stringify(account).includes('mimicry'), true, 'and they are persisted, not re-derived from nothing');
});

// ======================================================= the operator action

await check('action: set-mimicry flips the mode and nothing else', async () => {
  const account = makeAccount({
    id: 'a1', platform: 'anthropic', authMode: 'oauth',
    priority: 7, consecutiveFailures: 2, tempUnschedulableUntil: '2026-01-01T00:05:00.000Z',
  });

  const on = applyAccountAction(account, 'set-mimicry', { now: T0, mimicry: 'claude-code' });
  assert.equal(on.mimicry, 'claude-code');
  assert.equal(on.authMode, 'oauth', 'the credential type is a FACT, not something this action may rewrite');
  assert.equal(on.priority, 7);
  assert.equal(on.consecutiveFailures, 2, 'and it is not a back door to clearing failure state');
  assert.equal(on.tempUnschedulableUntil, account.tempUnschedulableUntil, 'nor to lifting a cooling window');
  assert.equal(on.updatedAt, new Date(T0).toISOString());

  const off = applyAccountAction(on, 'set-mimicry', { now: T0, mimicry: 'off' });
  assert.equal(off.mimicry, 'off');
});

await check('action: set-mimicry rejects a mode the group does not implement', async () => {
  const account = makeAccount({ id: 'a1', platform: 'anthropic' });
  assert.throws(() => applyAccountAction(account, 'set-mimicry', { now: T0, mimicry: 'claude' }), RangeError);
  assert.throws(() => applyAccountAction(account, 'set-mimicry', { now: T0 }), RangeError);
});

// ======================================================= importers

await check('importer: an OAuth record is imported as bearer, an api key as x-api-key', async () => {
  const oauth = toDraft({ name: 'Sub', platform: 'anthropic', type: 'oauth', credentials: { access_token: 'at' } });
  assert.equal(oauth.ok, true);
  assert.equal(oauth.draft.authMode, 'oauth', 'sub2api says so explicitly');

  // No `type` field: inferred from the bundle, because a subscription token sent in
  // the api-key header is a silent 401 rather than a readable error.
  const inferred = toDraft({ name: 'Inferred', platform: 'anthropic', credentials: { access_token: 'at' } });
  assert.equal(inferred.draft.authMode, 'oauth');

  const key = toDraft({ name: 'Key', platform: 'anthropic', type: 'apikey', credentials: { api_key: 'sk' } });
  assert.equal(key.draft.authMode, 'api-key');

  const cpa = toDraft({ type: 'claude', access_token: 'cpa-at', account_id: '11111111-2222-4333-8444-555555555555' });
  assert.equal(cpa.draft.authMode, 'oauth', 'a CPA record carrying an access_token is an OAuth grant');
  assert.equal(
    cpa.draft.mimicryAccountUuid,
    '11111111-2222-4333-8444-555555555555',
    'and its real account uuid is carried into the identity, so the user_id is not a stand-in',
  );

  const emailish = toDraft({ type: 'claude', access_token: 'cpa-at', account_id: 'someone@example.com' });
  assert.equal(emailish.draft.mimicryAccountUuid, null, 'a non-UUID account_id must not be pinned into user_id');

  assert.equal(oauth.draft.mimicry, undefined, 'the importer never turns the disguise on by itself');
});

// --------------------------------------------------------------- report

for (const { label, error } of failures) {
  console.error(`✗ ${label}\n  ${error?.message ?? error}`);
}

console.log(`${failures.length === 0 ? '✓' : '✗'} ${passed}/${checks} 通过`);
if (failures.length > 0) process.exit(1);
