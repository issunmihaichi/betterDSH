/**
 * Importer tests: sub2api backups and CPA auth files → account drafts.
 *
 * The fixtures mirror the REAL field names from the two sources
 * (`account_data.go` for sub2api, `converter.mjs` for CPA) so a renamed field
 * upstream shows up here as a failure rather than as a silently empty import.
 *
 *   node tools/importer-test.mjs
 */
import assert from 'node:assert/strict';
import { buildGeminiRequest } from '../lib/native/gemini.js';

import {
  decodeBundle,
  detectFormat,
  encodeBundle,
  extractAccounts,
  normalizePlatform,
  planImport,
  planMetadataImport,
  METADATA_FORMAT,
  slugifyId,
  toDraft,
  toInstant,
} from '../lib/importer.js';

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

// ------------------------------------------------- fixtures (real field names)

/** One record from a sub2api admin backup export. */
const SUB2API = {
  data: {
    accounts: [
      {
        name: 'Claude Main',
        notes: 'primary',
        platform: 'anthropic',
        type: 'oauth',
        credentials: { access_token: 'at-1', refresh_token: 'rt-1', expires_at: 1_800_000_000 },
        extra: { email: 'a@example.com' },
        concurrency: 8,
        priority: 10,
        expires_at: 1_800_000_000,
        auto_pause_on_expired: true,
      },
      {
        name: 'Codex Backup',
        platform: 'openai',
        type: 'apikey',
        credentials: { api_key: 'sk-plain' },
        concurrency: 2,
        priority: 50,
      },
      {
        name: 'Antigravity Thing',
        platform: 'antigravity',
        type: 'oauth',
        credentials: { access_token: 'at-3' },
        concurrency: 4,
        priority: 70,
      },
      {
        name: 'No Secrets',
        platform: 'gemini',
        type: 'oauth',
        credentials: {},
        concurrency: 1,
        priority: 90,
      },
    ],
  },
};

/** One CPA auth file (Codex flavour). */
const CPA_CODEX = {
  type: 'codex',
  access_token: 'cpa-at',
  refresh_token: 'cpa-rt',
  id_token: 'cpa-id',
  account_id: 'acc-1',
  email: 'cpa@example.com',
  expired: 1_800_000_000_000,
  plan_type: 'plus',
};

// ------------------------------------------------- platform mapping

await check('normalizePlatform: foreign names fold onto this pool’s enum', () => {
  assert.equal(normalizePlatform('claude'), 'anthropic');
  assert.equal(normalizePlatform('codex'), 'openai');
  assert.equal(normalizePlatform('antigravity'), 'gemini');
  assert.equal(normalizePlatform('xai'), 'grok');
  assert.equal(normalizePlatform('Anthropic'), 'anthropic', 'case-insensitive');
  assert.equal(normalizePlatform('bedrock'), 'custom', 'an unmapped platform degrades instead of throwing');
  assert.equal(normalizePlatform(undefined), 'custom');
});

await check('slugifyId: schema-safe, stable, and never empty', () => {
  assert.equal(slugifyId('Claude Main'), 'claude-main');
  assert.equal(slugifyId('  Codex   Backup  '), 'codex-backup');
  assert.equal(slugifyId('账号一'), 'account', 'a name with no ASCII yields the fallback');
  assert.equal(slugifyId('9lives'), 'a-9lives', 'a leading digit is prefixed');
  assert.equal(slugifyId('', 'account-3'), 'account-3');
  assert.equal(slugifyId('---'), 'account');
});

await check('toInstant: seconds, milliseconds, ISO, and junk', () => {
  assert.equal(toInstant(1_800_000_000), new Date(1_800_000_000_000).toISOString(), 'ten digits are seconds');
  assert.equal(toInstant(1_800_000_000_000), new Date(1_800_000_000_000).toISOString(), 'longer is milliseconds');
  assert.equal(toInstant('2026-01-01T00:00:00.000Z'), '2026-01-01T00:00:00.000Z');
  assert.equal(toInstant(null), null);
  assert.equal(toInstant(''), null);
  assert.equal(toInstant('not a date'), null);
});

// ------------------------------------------------- credential bundles

await check('encodeBundle/decodeBundle round-trip both shapes', () => {
  assert.equal(encodeBundle('sk-bare'), 'sk-bare', 'a bare string is already the stored form');
  assert.equal(decodeBundle('sk-bare'), 'sk-bare');

  assert.equal(encodeBundle({ api_key: 'sk-only' }), 'sk-only', 'a single identifiable token collapses to itself');
  assert.equal(decodeBundle('sk-only'), 'sk-only');

  const bundle = encodeBundle({ access_token: 'at', refresh_token: 'rt' });
  assert.equal(typeof bundle, 'string');
  assert.ok(bundle.startsWith('{'), 'a multi-field bundle is stored as JSON');
  assert.equal(decodeBundle(bundle), 'at', 'and decodes back to the bearer');
  assert.equal(decodeBundle(JSON.stringify({ refresh_token: 'rt' })), JSON.stringify({ refresh_token: 'rt' }), 'with no bearer, the raw string survives');

  assert.equal(encodeBundle({}), undefined);
  assert.equal(encodeBundle(null), undefined);
  assert.equal(encodeBundle({ refresh_token: 'rt' }), JSON.stringify({ refresh_token: 'rt' }));
  assert.equal(decodeBundle(undefined), undefined);
});

// ------------------------------------------------- detection + wrappers

await check('detectFormat: tells the two sources apart', () => {
  assert.equal(detectFormat(SUB2API), 'sub2api');
  assert.equal(detectFormat(CPA_CODEX), 'cpa');
  assert.equal(detectFormat({ accounts: [] }), 'sub2api');
  assert.equal(detectFormat({ hello: 'world' }), 'unknown');
  assert.equal(detectFormat(null), 'unknown');
});

await check('extractAccounts: every wrapper a user might paste', () => {
  assert.equal(extractAccounts(SUB2API).length, 4, '{data:{accounts}}');
  assert.equal(extractAccounts({ accounts: [{ platform: 'openai' }] }).length, 1, '{accounts}');
  assert.equal(extractAccounts([{ platform: 'openai' }, null, 'x']).length, 1, 'a bare array drops non-objects');
  assert.equal(extractAccounts(SUB2API.data.accounts[1]).length, 1, 'a single account');
  assert.equal(extractAccounts({ nothing: true }).length, 0);
  assert.equal(extractAccounts('nope').length, 0);
});

// ------------------------------------------------- draft conversion

await check('toDraft: a sub2api account keeps its scheduling fields', () => {
  const result = toDraft(SUB2API.data.accounts[0], { index: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.draft.platform, 'anthropic');
  assert.equal(result.draft.label, 'Claude Main');
  assert.equal(result.draft.concurrency, 8);
  assert.equal(result.draft.priority, 10);
  assert.equal(result.draft.autoPauseOnExpired, true);
  assert.equal(result.draft.expiresAt, new Date(1_800_000_000_000).toISOString());
  assert.equal(decodeBundle(result.credential), 'at-1', 'the OAuth bearer is recoverable');
});

await check('toDraft: a sub2api api-key account stores just the key', () => {
  const result = toDraft(SUB2API.data.accounts[1], { index: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.draft.platform, 'openai');
  assert.equal(result.credential, 'sk-plain');
  assert.equal(result.draft.autoPauseOnExpired, true, 'an absent flag defaults to true, matching the pool default');
});

await check('toDraft: antigravity folds to gemini', () => {
  const result = toDraft(SUB2API.data.accounts[2], { index: 2 });
  assert.equal(result.draft.platform, 'gemini');
});

await check('toDraft: an account with no secret is REJECTED, not created empty', () => {
  // A row pointing at no secret can only fail at request time, so it must not be
  // written at all.
  const result = toDraft(SUB2API.data.accounts[3], { index: 3 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no usable credentials/);
});

await check('toDraft: a CPA auth file becomes an account', () => {
  const result = toDraft(CPA_CODEX, { index: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.draft.platform, 'openai', 'type codex maps to openai');
  assert.equal(result.draft.label, 'cpa@example.com', 'the email is the best label available');
  assert.equal(decodeBundle(result.credential), 'cpa-at');
  const bundle = JSON.parse(result.credential);
  assert.equal(bundle.refresh_token, 'cpa-rt', 'the refresh token is preserved for later use');
  assert.equal(bundle.plan_type, undefined, 'CPA plan_type is metadata, not secret material');
});

await check('CPA Gemini token object imports into usable OAuth credentials', () => {
  const fixture = { type: 'gemini', email: 'gemini@example.com', project_id: 'fixture-project',
    token: { access_token: 'fixture-gemini-access', refresh_token: 'fixture-gemini-refresh', expiry: '2027-01-15T08:00:00Z', token_type: 'Bearer' } };
  const plan = planImport(fixture);
  assert.equal(plan.format, 'cpa');
  assert.equal(plan.errors.length, 0);
  assert.equal(plan.created.length, 1);
  const { draft, credential } = plan.created[0];
  assert.equal(draft.expiresAt, '2027-01-15T08:00:00.000Z');
  assert.equal(JSON.parse(credential).refresh_token, 'fixture-gemini-refresh');
  const request = buildGeminiRequest(draft, { model: 'gemini-2.5-flash', messages: [] }, credential);
  assert.equal(request.init.headers.authorization, 'Bearer fixture-gemini-access');
  assert.equal(JSON.parse(request.init.body).project, 'fixture-project');
  assert.equal(planImport([fixture]).created.length, 1);
  assert.equal(planImport({ ...fixture, token: { refresh_token: 'fixture-refresh-only' } }).created.length, 0);
});

await check('toDraft: rejected shapes explain themselves', () => {
  assert.match(toDraft({ type: 'unknown-vendor', access_token: 'x' }, {}).reason, /unsupported CPA type/);
  assert.match(toDraft({ type: 'codex', access_token: '   ' }, {}).reason, /empty access_token/);
  assert.match(toDraft({ foo: 1 }, {}).reason, /unrecognized record/);
});

// ------------------------------------------------- whole-document planning

await check('planImport: creates the importable accounts and reports the rest', () => {
  const plan = planImport(SUB2API, { now: T0 });
  assert.equal(plan.format, 'sub2api');
  assert.deepEqual(plan.created.map((entry) => entry.id), ['claude-main', 'codex-backup', 'antigravity-thing']);
  assert.equal(plan.errors.length, 1, 'the secret-less record is reported, not silently dropped');
  assert.equal(plan.errors[0].index, 3, 'and it points at the offending position');
  assert.equal(plan.created[0].credential !== undefined, true, 'every created entry carries its credential');
});

await check('planImport: re-importing the same backup does not duplicate', () => {
  const first = planImport(SUB2API, { now: T0 });
  const again = planImport(SUB2API, { now: T0, existingIds: first.created.map((entry) => entry.id) });
  assert.deepEqual(
    again.created.map((entry) => entry.id),
    ['claude-main-2', 'codex-backup-2', 'antigravity-thing-2'],
    'collisions are suffixed so a second import adds distinct accounts',
  );
});

await check('planImport: collisions inside one batch are also resolved', () => {
  const duplicated = { accounts: [
    { name: 'Same', platform: 'openai', credentials: { api_key: 'k1' } },
    { name: 'Same', platform: 'openai', credentials: { api_key: 'k2' } },
  ] };
  const plan = planImport(duplicated, { now: T0 });
  assert.deepEqual(plan.created.map((entry) => entry.id), ['same', 'same-2']);
  assert.notEqual(plan.created[0].credential, plan.created[1].credential, 'and each keeps its own secret');
});

await check('planImport: a CPA file imports as a CPA file', () => {
  const plan = planImport([CPA_CODEX], { now: T0 });
  assert.equal(plan.format, 'cpa');
  assert.equal(plan.created.length, 1);
  assert.equal(plan.created[0].id, 'cpa-example-com', 'the email slugifies into an id');
});

await check('planImport: an empty or foreign document says so', () => {
  assert.equal(planImport({ nothing: 1 }, { now: T0 }).errors[0].reason, 'no accounts found in the document');
  assert.equal(planImport([], { now: T0 }).created.length, 0);
  assert.equal(planImport(null, { now: T0 }).errors.length, 1);
});

await check('planImport: every created draft is schema-shaped (no host-only fields)', () => {
  const plan = planImport(SUB2API, { now: T0 });
  for (const entry of plan.created) {
    assert.equal(typeof entry.id, 'string');
    assert.equal('nameHint' in entry.draft, false, 'the name hint is consumed, not written to the domain');
    assert.equal('createdAt' in entry.draft, false, 'the host stamps timestamps');
    assert.equal('status' in entry.draft, false);
    assert.equal('credentialRef' in entry.draft, false, 'the host derives the ref from the id');
  }
});

await check('sub2api: notes and load factor survive draft conversion', () => {
  const converted = toDraft({ ...SUB2API.data.accounts[0], notes: 'operator note', load_factor: 9, schedulable: false });
  assert.equal(converted.draft.notes, 'operator note');
  assert.equal(converted.draft.loadFactor, 9);
  assert.equal(converted.draft.schedulable, false);
});

const metadataFixture = () => ({
  format: METADATA_FORMAT, version: 1,
  accounts: [{ id: 'a1', platform: 'anthropic', notes: 'restore', groups: ['vip'], schedulable: true, credentialRef: 'PRIVATE_REF', credentials: { api_key: 'fixture-secret' }, baseUrl: 'https://private.invalid' }],
  groups: [{ id: 'vip', label: 'VIP', selectionMode: 'weighted-random' }],
  priorities: [{ accountId: 'a1', groupId: 'vip', priority: 8 }],
});

await check('metadata: plans paused accounts and related groups with no secret material', () => {
  const plan = planMetadataImport(metadataFixture(), { now: new Date(T0).toISOString() });
  assert.equal(detectFormat(metadataFixture()), METADATA_FORMAT);
  assert.deepEqual(plan.created, ['a1']);
  assert.deepEqual(plan.updated, []);
  assert.equal(plan.accounts[0].schedulable, false);
  assert.equal(plan.accounts[0].credentialRef, null);
  assert.equal(plan.accounts[0].baseUrl, null);
  assert.equal(plan.accounts[0].notes, 'restore');
  assert.equal(plan.groups[0].selectionMode, 'weighted-random');
  assert.equal(plan.priorities[0].priority, 8);
  assert.equal(JSON.stringify(plan).includes('fixture-secret'), false);
  assert.equal(JSON.stringify(plan).includes('PRIVATE_REF'), false);
});

await check('metadata: groups preserve disabled state and default old documents to enabled', () => {
  const fixture = metadataFixture();
  assert.equal(planMetadataImport(fixture, { now: new Date(T0).toISOString() }).groups[0].enabled, true);
  fixture.groups[0].enabled = false;
  assert.equal(planMetadataImport(fixture, { now: new Date(T0).toISOString() }).groups[0].enabled, false);
  fixture.groups[0].enabled = 'false';
  assert.throws(() => planMetadataImport(fixture, { now: new Date(T0).toISOString() }));
});

await check('metadata: existing accounts retain credentials connections health and error status', () => {
  const initial = planMetadataImport(metadataFixture(), { now: new Date(T0).toISOString() }).accounts[0];
  const current = { ...initial, credentialRef: 'KEEP_REF', baseUrl: 'https://keep.invalid', status: 'error', errorMessage: 'keep error', consecutiveFailures: 2, overloadUntil: new Date(T0 + 60000).toISOString() };
  const plan = planMetadataImport(metadataFixture(), { accounts: [current], now: new Date(T0 + 1000).toISOString() });
  assert.deepEqual(plan.created, []);
  assert.deepEqual(plan.updated, ['a1']);
  assert.equal(plan.accounts[0].credentialRef, 'KEEP_REF');
  assert.equal(plan.accounts[0].baseUrl, 'https://keep.invalid');
  assert.equal(plan.accounts[0].status, 'error');
  assert.equal(plan.accounts[0].errorMessage, 'keep error');
  assert.equal(plan.accounts[0].overloadUntil, current.overloadUntil);
  assert.equal(plan.accounts[0].createdAt, initial.createdAt);
});

await check('metadata: invalid versions duplicates and dangling relations fail before writes', () => {
  const cases = [
    { ...metadataFixture(), version: 2 },
    { ...metadataFixture(), accounts: [...metadataFixture().accounts, ...metadataFixture().accounts] },
    { ...metadataFixture(), groups: [{ id: 'Bad Group' }] },
    { ...metadataFixture(), groups: [] },
    { ...metadataFixture(), priorities: [{ accountId: 'missing', groupId: 'vip', priority: 1 }] },
    { ...metadataFixture(), priorities: [{ accountId: 'a1', groupId: 'missing', priority: 1 }] },
  ];
  for (const document of cases) assert.throws(() => planMetadataImport(document, { now: new Date(T0).toISOString() }));
});

await check('imports: sub2api and CPA migrate public project/account ids without secret fields in drafts', () => {
  for (const raw of [
    { platform: 'gemini', type: 'oauth', credentials: { access_token: 'fixture-secret', project_id: 'gcp-project' } },
    { type: 'gemini', access_token: 'fixture-secret', project_id: 'gcp-project' },
  ]) {
    const result = toDraft(raw);
    assert.equal(result.draft.projectId, 'gcp-project');
    assert.equal(result.draft.chatgptAccountId, null);
    assert.equal(JSON.stringify(result.draft).includes('fixture-secret'), false);
  }
  for (const raw of [
    { platform: 'openai', type: 'oauth', credentials: { access_token: 'fixture-secret', chatgpt_account_id: 'workspace-id' } },
    { type: 'codex', access_token: 'fixture-secret', account_id: 'workspace-id' },
  ]) {
    const result = toDraft(raw);
    assert.equal(result.draft.chatgptAccountId, 'workspace-id');
    assert.equal(result.draft.projectId, null);
    assert.equal(JSON.stringify(result.draft).includes('fixture-secret'), false);
  }
});

await check('metadata: restore accepts public project id but excludes ChatGPT workspace identity', () => {
  const fixture = metadataFixture();
  fixture.accounts[0] = { ...fixture.accounts[0], platform: 'gemini', projectId: 'gcp-project', chatgptAccountId: 'private-workspace' };
  const plan = planMetadataImport(fixture, { now: new Date(T0).toISOString() });
  assert.equal(plan.accounts[0].projectId, 'gcp-project');
  assert.equal(plan.accounts[0].chatgptAccountId, null);
});

// ------------------------------------------------- report

if (failures.length > 0) {
  for (const { label, error } of failures) {
    console.error(`✗ ${label}\n    ${error.message.split('\n').join('\n    ')}`);
  }
  console.error(`\n${passed}/${checks} 通过，${failures.length} 失败`);
  process.exitCode = 1;
} else {
  console.log(`✓ ${passed}/${checks} 通过`);
}
