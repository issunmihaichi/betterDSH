/**
 * Import sub2api backups and CPA auth files into pool account definitions.
 *
 * Pure: no DSH imports, no I/O, no clock reads (every entry point takes `now`).
 * It turns a foreign document into account DRAFTS plus a credential bundle; the
 * host half is what writes them and stores the secret.
 *
 * Field shapes come from the real sources, not from guesswork:
 *   - sub2api  `DataAccount`  — backend/internal/handler/admin/account_data.go
 *     `{name, notes, platform, type, credentials{}, extra{}, concurrency,
 *       priority, expires_at(unix seconds), auto_pause_on_expired}`
 *     wrapped as `{data: {accounts: [...]}}` (a bare `{accounts: [...]}`, a bare
 *     array, and a single account are all accepted).
 *   - CPA      docs/src/converter.mjs of gtxx3600/CPA2sub2API
 *     `{type: "codex"|"claude"|"antigravity", access_token,
 *       refresh_token, id_token, account_id, email, plan_type, project_id, ...}`
 *     or `{type: "gemini", token: {access_token, refresh_token, expiry}, project_id}`.
 */

import { accountSchema, groupSchema, prioritySchema } from './domain.js';

export const METADATA_FORMAT = 'dsh-account-pool-metadata';
export const METADATA_ACCOUNT_FIELDS = [
  'id', 'label', 'notes', 'platform', 'status', 'schedulable', 'groups', 'priority',
  'weight', 'loadFactor', 'concurrency', 'models', 'expiresAt', 'autoPauseOnExpired',
  'authMode', 'openaiApi', 'openaiTransport', 'mimicry', 'betas', 'projectId', 'createdAt', 'updatedAt',
  'poolDetectionRetry', 'poolDetectionRetries', 'poolDetectionRetryDelayMs', 'poolDetectionKeywords',
];

/** Validate the entire restore before writing; no credential material is planned. */
export function planMetadataImport(document, { accounts = [], groups = [], now } = {}) {
  if (document?.format !== METADATA_FORMAT || document.version !== 1
    || !Array.isArray(document.accounts) || !Array.isArray(document.groups) || !Array.isArray(document.priorities)) {
    throw new RangeError('invalid metadata document or unsupported version');
  }
  const pick = (record, fields) => Object.fromEntries(fields
    .filter((field) => Object.hasOwn(record, field)).map((field) => [field, record[field]]));
  const currentAccounts = new Map(accounts.map((record) => [record.id, record]));
  const currentGroups = new Map(groups.map((record) => [record.id, record]));
  const unique = (records, key) => {
    const seen = new Set();
    for (const record of records) {
      if (record === null || typeof record !== 'object' || Array.isArray(record)) throw new RangeError('metadata records must be objects');
      const id = key(record);
      if (seen.has(id)) throw new RangeError('metadata contains duplicate records');
      seen.add(id);
    }
  };
  unique(document.groups, (record) => record.id);
  unique(document.accounts, (record) => record.id);
  unique(document.priorities, (record) => `${record.accountId}|${record.groupId}`);
  const groupRecords = document.groups.map((record) => groupSchema.parse({
    ...pick(record, ['id', 'label', 'description', 'enabled', 'models', 'selectionMode']),
    createdAt: currentGroups.get(record.id)?.createdAt ?? now, updatedAt: now,
  }));
  const knownGroups = new Set([...currentGroups.keys(), ...groupRecords.map((record) => record.id)]);
  const accountRecords = document.accounts.map((record) => {
    const existing = currentAccounts.get(record.id);
    const fields = pick(record, METADATA_ACCOUNT_FIELDS.filter((field) => !['createdAt', 'updatedAt'].includes(field)));
    if (existing !== undefined && ['platform', 'authMode', 'mimicry'].some((field) => field in fields && fields[field] !== existing[field])) {
      throw new RangeError('metadata cannot change an existing account platform or authentication mode');
    }
    const parsed = accountSchema.parse({
      ...existing, ...fields,
      ...(existing === undefined ? { schedulable: false } : { status: existing.status }),
      credentialRef: existing?.credentialRef ?? null,
      createdAt: existing?.createdAt ?? now, updatedAt: now,
    });
    if (parsed.groups.some((groupId) => !knownGroups.has(groupId))) throw new RangeError('metadata account references an unknown group');
    return parsed;
  });
  const knownAccounts = new Set([...currentAccounts.keys(), ...accountRecords.map((record) => record.id)]);
  const priorityRecords = document.priorities.map((record) => {
    const parsed = prioritySchema.parse({ ...pick(record, ['accountId', 'groupId', 'priority']), updatedAt: now });
    if (!knownAccounts.has(parsed.accountId) || !knownGroups.has(parsed.groupId)) throw new RangeError('metadata priority references an unknown account or group');
    return parsed;
  });
  return { format: METADATA_FORMAT, accounts: accountRecords, groups: groupRecords, priorities: priorityRecords,
    created: accountRecords.filter((record) => !currentAccounts.has(record.id)).map((record) => record.id),
    updated: accountRecords.filter((record) => currentAccounts.has(record.id)).map((record) => record.id) };
}

/** Foreign platform names mapped onto this pool's enum. */
export const PLATFORM_MAP = {
  anthropic: 'anthropic',
  claude: 'anthropic',
  openai: 'openai',
  codex: 'openai',
  chatgpt: 'openai',
  gemini: 'gemini',
  google: 'gemini',
  antigravity: 'gemini',
  grok: 'grok',
  xai: 'grok',
};

/** CPA `type` values mapped the same way. */
const CPA_TYPE_MAP = {
  codex: 'openai',
  claude: 'anthropic',
  antigravity: 'gemini',
  gemini: 'gemini',
};

/** Fields of a CPA record that are metadata, not secret material. */
const CPA_METADATA_KEYS = new Set(['type', 'email', 'expired', 'expires_at', 'expires_in', 'plan_type']);

/** Keys that may carry the bearer this pool sends upstream, in priority order. */
const TOKEN_KEYS = ['access_token', 'accessToken', 'api_key', 'apiKey', 'key', 'token'];

/**
 * A UUID-shaped identifier.
 *
 * Used to recognise an account uuid in an imported record so the disguise can
 * carry the REAL upstream account uuid in `metadata.user_id` instead of a derived
 * stand-in. Only matched when it genuinely looks like one — a CPA `account_id` is
 * sometimes an email or a bare id, and pinning a non-UUID there would produce a
 * `user_id` that the upstream's own parser rejects.
 */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The account uuid an imported record carries, when it has a well-formed one. */
function importedAccountUuid(raw) {
  for (const key of ['account_uuid', 'account_id', 'accountId']) {
    const value = raw?.[key];
    if (typeof value === 'string' && UUID_RE.test(value.trim())) return value.trim();
  }
  return null;
}

/** Only public connection ids are copied into account rows. */
function publicId(raw, keys) {
  for (const key of keys) {
    const value = raw?.[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

function connectionIds(raw, platform) {
  return {
    projectId: platform === 'gemini' ? publicId(raw, ['project_id', 'projectId', 'project']) : null,
    chatgptAccountId: platform === 'openai' ? publicId(raw, ['chatgpt_account_id', 'chatgptAccountId', 'account_id', 'accountId']) : null,
  };
}

/**
 * Which header an imported credential must travel in.
 *
 * A declared type wins. Otherwise it is inferred from the credential bundle: an
 * `access_token` with no API key is an OAuth grant. The inference matters because
 * sub2api backups do not always carry `type`, and defaulting those to `'api-key'`
 * would send a subscription token in the wrong header — a silent failure that
 * only shows up as an upstream 401.
 */
function importedAuthMode(raw) {
  const declared = String(raw?.type ?? raw?.authMode ?? '').trim().toLowerCase();
  if (declared === 'oauth') return 'oauth';
  if (declared === 'apikey' || declared === 'api-key' || declared === 'key') return 'api-key';
  const credentials = raw?.credentials;
  if (credentials !== null && typeof credentials === 'object') {
    const hasApiKey = typeof credentials.api_key === 'string' || typeof credentials.apiKey === 'string';
    const hasAccessToken = typeof credentials.access_token === 'string';
    if (hasAccessToken && !hasApiKey) return 'oauth';
  }
  return 'api-key';
}

/** Normalize one foreign platform name. */
export function normalizePlatform(value) {
  const key = String(value ?? '').trim().toLowerCase();
  return PLATFORM_MAP[key] ?? 'custom';
}

/** A stable, schema-safe account id derived from a human name. */
export function slugifyId(value, fallback = 'account') {
  const slug = String(value ?? '')
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug === '' ? fallback : (/^[a-z]/.test(slug) ? slug : `a-${slug}`);
}

/** Unix seconds, unix milliseconds, or an ISO/parseable string → ISO, else null. */
export function toInstant(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Ten digits is seconds; anything longer is already milliseconds.
    const ms = value < 1e11 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** The bearer inside a credential object, if one can be identified. */
export function tokenOf(credentials) {
  if (credentials === null || typeof credentials !== 'object') return undefined;
  for (const key of TOKEN_KEYS) {
    const value = credentials[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

/**
 * The string this pool stores for one account's credential.
 *
 * The credential service stores a STRING, while both upstream formats carry an
 * object (an OAuth bundle, or a plain key). So a bundle is stored as JSON and a
 * lone key as itself; `decodeBundle` reverses this at request time. A record
 * with no identifiable secret returns `undefined`, and the caller must NOT
 * create an account for it — a row pointing at no secret can only fail later.
 */
export function encodeBundle(credentials) {
  if (credentials === null || credentials === undefined) return undefined;
  if (typeof credentials === 'string') return credentials.trim() === '' ? undefined : credentials.trim();
  if (typeof credentials !== 'object') return undefined;
  const token = tokenOf(credentials);
  const entries = Object.entries(credentials).filter(([, value]) => value !== null && value !== undefined && value !== '');
  if (entries.length === 0) return undefined;
  if (entries.length === 1 && token !== undefined) return token;
  return JSON.stringify(credentials);
}

/**
 * Reverse {@link encodeBundle}: pull the bearer back out of a stored string.
 * Exported because the transport needs exactly this, and both halves should
 * agree by construction rather than by comment.
 */
export function decodeBundle(stored) {
  if (typeof stored !== 'string' || stored === '') return undefined;
  const trimmed = stored.trim();
  if (!trimmed.startsWith('{')) return trimmed;
  try {
    return tokenOf(JSON.parse(trimmed)) ?? trimmed;
  } catch {
    return trimmed;
  }
}

/** CPA Gemini stores its OAuth token under `token`; other providers use flat fields. */
function isCpaRecord(record) {
  return typeof record?.access_token === 'string'
    || (String(record?.type ?? '').trim().toLowerCase() === 'gemini'
      && record?.token !== null && typeof record?.token === 'object' && !Array.isArray(record.token));
}

/** Which upstream format a parsed document looks like. */
export function detectFormat(document) {
  if (document === null || document === undefined) return 'unknown';
  if (document?.format === METADATA_FORMAT) return METADATA_FORMAT;
  const list = extractAccounts(document);
  if (list.some(isCpaRecord)) return 'cpa';
  if (list.some((entry) => typeof entry.platform === 'string')
    || document?.data?.accounts !== undefined || document?.accounts !== undefined || document?.platform !== undefined) {
    return 'sub2api';
  }
  return 'unknown';
}

/**
 * Pull the raw account list out of whatever wrapper the caller pasted.
 * Accepts `{data:{accounts}}`, `{accounts}`, a bare array, or one account.
 */
export function extractAccounts(document) {
  if (Array.isArray(document)) return document.filter((entry) => entry !== null && typeof entry === 'object');
  if (document === null || typeof document !== 'object') return [];
  if (document.data !== undefined && typeof document.data === 'object') {
    return extractAccounts(document.data);
  }
  if (Array.isArray(document.accounts)) {
    return document.accounts.filter((entry) => entry !== null && typeof entry === 'object');
  }
  // A single account document.
  if (typeof document.platform === 'string' || isCpaRecord(document)) return [document];
  return [];
}

/** Drop CPA bookkeeping fields, keeping only the secret material. */
function cpaSecrets(record) {
  const secrets = {};
  for (const [key, value] of Object.entries(record)) {
    if (CPA_METADATA_KEYS.has(key)) continue;
    secrets[key] = value;
  }
  return secrets;
}

/**
 * Normalize one foreign account into the shape the host writes.
 *
 * @returns `{ ok: true, draft, credential }` or `{ ok: false, reason }`. A draft
 *   is a partial pool account (no id/cooling/created-at — the host fills those);
 *   `credential` is the string for the credential store.
 */
export function toDraft(raw, options = {}) {
  const index = options.index ?? 0;

  // CPA Gemini's token object is flattened for the existing credential readers.
  // Keep the top-level project id and normalize OAuth aliases without changing input.
  if (String(raw?.type ?? '').trim().toLowerCase() === 'gemini'
    && raw?.token !== null && typeof raw?.token === 'object' && !Array.isArray(raw.token)) {
    const { token, ...record } = raw;
    raw = {
      ...token, ...record,
      access_token: publicId(token, ['access_token', 'accessToken']) ?? '',
      refresh_token: publicId(token, ['refresh_token', 'refreshToken']),
      expired: record.expired ?? record.expires_at ?? token.expiry ?? token.expires_at ?? token.expiration ?? token.expires_in_abs,
    };
  }

  // --- CPA ------------------------------------------------------------------
  if (typeof raw?.access_token === 'string') {
    if (raw.access_token.trim() === '') return { ok: false, reason: 'cpa record has an empty access_token' };
    const platform = CPA_TYPE_MAP[String(raw.type ?? '').trim().toLowerCase()] ?? 'custom';
    if (platform === 'custom') return { ok: false, reason: `unsupported CPA type '${String(raw.type)}'` };
    const label = String(raw.email ?? raw.account_id ?? raw.name ?? `${raw.type}-${String(index + 1)}`);
    const credential = encodeBundle(cpaSecrets(raw));
    if (credential === undefined) return { ok: false, reason: 'cpa record carries no secret material' };
    return {
      ok: true,
      credential,
      draft: {
        label,
        nameHint: label,
        platform,
        // A CPA record with an `access_token` IS an OAuth credential, so the auth
        // mode is a FACT and is set here. `mimicry` is deliberately left at its
        // default: whether to impersonate the CLI is the operator's choice, and
        // silently rewriting someone's system prompt because of the file they
        // imported would be exactly the kind of quiet overreach this pool refuses
        // elsewhere (cf. `enable` not clearing a cooldown).
        authMode: 'oauth',
        ...connectionIds(raw, platform),
        mimicryAccountUuid: importedAccountUuid(raw),
        expiresAt: toInstant(raw.expired ?? raw.expires_at),
        priority: options.priority ?? 100,
        concurrency: options.concurrency ?? 4,
        autoPauseOnExpired: true,
      },
    };
  }

  // --- sub2api --------------------------------------------------------------
  if (typeof raw?.platform === 'string') {
    const platform = normalizePlatform(raw.platform);
    const label = String(raw.name ?? raw.notes ?? `${raw.platform}-${String(index + 1)}`);
    const credential = encodeBundle(raw.credentials);
    if (credential === undefined) {
      return { ok: false, reason: `'${label}' has no usable credentials (sub2api exports carry them in plain text)` };
    }
    return {
      ok: true,
      credential,
      draft: {
        label,
        notes: typeof raw.notes === 'string' ? raw.notes : '',
        nameHint: label,
        platform,
        authMode: importedAuthMode(raw),
        baseUrl: publicId(raw.credentials, ['base_url', 'baseUrl']) ?? publicId(raw, ['base_url', 'baseUrl']),
        ...connectionIds(raw.credentials, platform),
        loadFactor: Number.isInteger(raw.load_factor) && raw.load_factor > 0 ? raw.load_factor : null,
        schedulable: raw.schedulable !== false,
        mimicryAccountUuid: importedAccountUuid(raw) ?? importedAccountUuid(raw.extra ?? {}),
        concurrency: Number.isInteger(raw.concurrency) && raw.concurrency >= 0 ? raw.concurrency : 4,
        priority: Number.isInteger(raw.priority) ? raw.priority : 100,
        expiresAt: toInstant(raw.expires_at),
        autoPauseOnExpired: raw.auto_pause_on_expired === undefined ? true : raw.auto_pause_on_expired === true,
      },
    };
  }

  return { ok: false, reason: 'unrecognized record: neither a CPA auth file nor a sub2api account' };
}

/**
 * Plan a whole import: which accounts to create, which to skip, which failed.
 *
 * Pure — it resolves name collisions against `existingIds` and against earlier
 * entries in the SAME batch, so importing a backup twice creates one account per
 * record rather than a cascade of suffixed duplicates.
 *
 * @param options.existingIds - ids already present in the pool.
 * @param options.now - epoch ms, for nothing but determinism in tests.
 */
export function planImport(document, options = {}) {
  const taken = new Set(options.existingIds ?? []);
  const created = [];
  const errors = [];

  const accounts = extractAccounts(document);
  if (accounts.length === 0) {
    return { format: detectFormat(document), created, errors: [{ index: -1, reason: 'no accounts found in the document' }] };
  }

  accounts.forEach((raw, index) => {
    const result = toDraft(raw, { index, priority: options.priority, concurrency: options.concurrency });
    if (!result.ok) {
      errors.push({ index, reason: result.reason });
      return;
    }
    const base = slugifyId(result.draft.nameHint ?? result.draft.label, `account-${String(index + 1)}`);
    let id = base;
    let suffix = 2;
    while (taken.has(id)) {
      id = `${base}-${String(suffix)}`;
      suffix += 1;
    }
    taken.add(id);
    const { nameHint: _ignored, ...draft } = result.draft;
    created.push({ id, draft, credential: result.credential });
  });

  return { format: detectFormat(document), created, errors };
}
