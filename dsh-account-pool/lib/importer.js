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
 *     `{type: "codex"|"claude"|"antigravity"|"gemini", access_token,
 *       refresh_token, id_token, account_id, email, plan_type, project_id, ...}`
 */

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

/** Which upstream format a parsed document looks like. */
export function detectFormat(document) {
  if (document === null || document === undefined) return 'unknown';
  const list = Array.isArray(document) ? document : [document];
  if (list.some((entry) => entry !== null && typeof entry === 'object' && typeof entry.access_token === 'string')) {
    return 'cpa';
  }
  if (document?.data?.accounts !== undefined || document?.accounts !== undefined || document?.platform !== undefined) {
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
  if (typeof document.platform === 'string' || typeof document.access_token === 'string') return [document];
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

  // --- CPA ------------------------------------------------------------------
  if (typeof raw?.access_token === 'string') {
    if (raw.access_token.trim() === '') return { ok: false, reason: 'cpa record has an empty access_token' };
    const platform = CPA_TYPE_MAP[String(raw.type ?? '').toLowerCase()] ?? 'custom';
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
        nameHint: label,
        platform,
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
