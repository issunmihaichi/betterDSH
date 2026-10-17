/**
 * Durable Codex replay primitives. Replay metadata travels to the browser and
 * session exports, so upstream encrypted reasoning is sealed a second time with
 * an installation-local key. Neither tokens nor duplicate text/arguments enter
 * the envelope. The caller supplies the credentials service; no file/network I/O.
 */
import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const CODEX_REPLAY_KIND = 'dsh-account-pool/codex';
export const CODEX_REPLAY_VERSION = 1;
export const CODEX_REPLAY_KEY_REF = 'DSH_ACCOUNT_POOL_CODEX_REPLAY_KEY_V1';
export const MAX_CODEX_REPLAY_BYTES = 4 * 1024 * 1024;
export const MAX_CODEX_REQUEST_REPLAY_BYTES = 16 * 1024 * 1024;
const sha = value => createHash('sha256').update(value).digest('hex');
const nonblank = value => typeof value === 'string' && value.trim() !== '';
const own = (value, key) => {
  if (value === null || typeof value !== 'object') return undefined;
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
};
function decode(value, length, max = length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)
    || value.length > Math.ceil(max * 4 / 3)) return undefined;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length >= length && bytes.length <= max && bytes.toString('base64url') === value ? bytes : undefined;
}
function aad(scope) { return `${CODEX_REPLAY_KIND}:${CODEX_REPLAY_VERSION}:${scope}`; }
function validScope(scope) { return typeof scope === 'string' && /^[a-f0-9]{64}$/.test(scope); }

export function createCodexReplayCodec(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Invalid Codex replay key');
  const secret = Buffer.from(key);
  return Object.freeze({
    seal(scope, payload) {
      if (!validScope(scope)) return undefined;
      try {
        const text = JSON.stringify(payload);
        if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_CODEX_REPLAY_BYTES) return undefined;
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', secret, iv);
        cipher.setAAD(Buffer.from(aad(scope)));
        const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
        return { iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: data.toString('base64url') };
      } catch { return undefined; }
    },
    open(scope, value) {
      if (!validScope(scope)) return undefined;
      try {
        const iv = decode(own(value, 'iv'), 12);
        const tag = decode(own(value, 'tag'), 16);
        const data = decode(own(value, 'data'), 1, MAX_CODEX_REPLAY_BYTES);
        if (!iv || !tag || !data) return undefined;
        const decipher = createDecipheriv('aes-256-gcm', secret, iv);
        decipher.setAAD(Buffer.from(aad(scope)));
        decipher.setAuthTag(tag);
        return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
      } catch { return undefined; }
    },
  });
}

/** Called once per Host mount, before any successful reply can reference a key. */
export async function loadCodexReplayCodec(credentials) {
  try {
    if (typeof credentials?.resolve !== 'function') throw new Error();
    const existing = await credentials.resolve(CODEX_REPLAY_KEY_REF);
    if (existing !== undefined && existing !== null) {
      const key = decode(existing.value, 32);
      if (!key) throw new Error(); // Never overwrite a malformed/shadowed key.
      return createCodexReplayCodec(key);
    }
    if (typeof credentials.set !== 'function') throw new Error();
    const key = randomBytes(32);
    await credentials.set(CODEX_REPLAY_KEY_REF, key.toString('base64url'));
    const persisted = await credentials.resolve(CODEX_REPLAY_KEY_REF);
    if (persisted?.value !== key.toString('base64url')) throw new Error();
    return createCodexReplayCodec(key);
  } catch {
    const error = new Error('Codex durable replay key is unavailable');
    error.code = 'POOL_CODEX_REPLAY_KEY_UNAVAILABLE';
    throw error;
  }
}

function claimsOf(token) {
  if (typeof token !== 'string' || token.length > 65536) return undefined;
  const segments = token.split('.');
  if (segments.length !== 3 || !segments[1]) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : undefined;
  } catch { return undefined; }
}

/**
 * JWT claims bind state to the identity of an already trusted credential; they
 * are NOT signature verification/authorization. Access-token identity wins over
 * a potentially stale id_token. Opaque tokens conservatively remain token-bound.
 */
export function codexReplayScope(account, bundle, accountId, url, model, sessionId) {
  if (!nonblank(account?.id) || !nonblank(sessionId) || !nonblank(model)) return undefined;
  const claims = claimsOf(bundle?.access_token);
  const auth = claims?.['https://api.openai.com/auth'];
  const subject = nonblank(claims?.sub) ? claims.sub : auth?.chatgpt_user_id;
  const principal = nonblank(subject) && nonblank(claims?.iss)
    ? ['jwt', claims.iss, subject] : ['opaque', sha(bundle?.access_token ?? '')];
  // Include authoritative credential workspace as well as the selected header,
  // so an explicit row override cannot conceal a changed token/workspace.
  const authoritativeWorkspace = auth?.chatgpt_account_id
    ?? claimsOf(bundle?.id_token)?.['https://api.openai.com/auth']?.chatgpt_account_id
    ?? bundle?.chatgpt_account_id ?? bundle?.chatgptAccountId ?? bundle?.account_id ?? bundle?.accountId ?? null;
  return sha(JSON.stringify([CODEX_REPLAY_KIND, CODEX_REPLAY_VERSION,
    account.id, account.createdAt ?? null, account.credentialRef ?? null,
    principal, authoritativeWorkspace, accountId, url, model.trim(), sessionId]));
}

function canonical(value, depth = 0) {
  if (depth > 64) throw new Error();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
  if (typeof value !== 'object' || !value || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error();
  const result = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error();
    result[key] = canonical(descriptor.value, depth + 1);
  }
  return result;
}

/** Match replay to authoritative content, tolerating only JSON argument formatting. */
export function codexBlockDigest(block) {
  try {
    const type = own(block, 'type');
    if (type === 'text') {
      const text = own(block, 'text');
      return typeof text === 'string' ? sha(JSON.stringify({ type, text })) : undefined;
    }
    if (type !== 'tool-call') return undefined;
    const id = own(block, 'id'), name = own(block, 'name');
    if (!nonblank(id) || !nonblank(name)) return undefined;
    let args = own(block, 'arguments') ?? {};
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { return sha(JSON.stringify({ type, id, name, rawArguments: args })); }
    }
    return sha(JSON.stringify({ type, id, name, arguments: canonical(args) }));
  } catch { return undefined; }
}

/** Only sealed payload is public. Do not duplicate provider reasoning in blocks. */
export function sealCodexReplay(context, blocks, plan) {
  if (!context?.scope || !context.replayCodec || !plan.length) return undefined;
  const digests = blocks.map(codexBlockDigest);
  if (digests.some(digest => !digest)) return undefined;
  const sealed = context.replayCodec.seal(context.scope, { digests, plan });
  return sealed ? { response: { kind: CODEX_REPLAY_KIND, version: CODEX_REPLAY_VERSION, scope: context.scope, sealed } } : undefined;
}

/** Shape, content and scope must all match. Unknown/malformed metadata degrades. */
export function openCodexReplay(context, message, parts) {
  if (!context?.scope || !context.replayCodec) return undefined;
  try {
    const response = own(own(own(message, 'source'), 'replayState'), 'response');
    if (own(response, 'kind') !== CODEX_REPLAY_KIND || own(response, 'version') !== CODEX_REPLAY_VERSION
      || own(response, 'scope') !== context.scope) return undefined;
    const payload = context.replayCodec.open(context.scope, own(response, 'sealed'));
    if (!Array.isArray(payload?.digests) || payload.digests.length !== parts.length || !Array.isArray(payload.plan)
      || payload.plan.length > 100000 || payload.plan.length === 0) return undefined;
    if (!parts.every((block, index) => codexBlockDigest(block) === payload.digests[index])) return undefined;
    const covered = new Set();
    let bytes = 0;
    for (const entry of payload.plan) {
      if (!entry || typeof entry !== 'object') return undefined;
      if (entry.type === 'reasoning') {
        if (!nonblank(entry.encrypted_content)) return undefined;
        bytes += Buffer.byteLength(entry.encrypted_content);
      } else if (entry.type === 'message') {
        if (!Array.isArray(entry.blocks) || entry.blocks.length === 0
          || entry.phase !== undefined && !['commentary', 'final_answer'].includes(entry.phase)) return undefined;
        for (const index of entry.blocks) {
          if (!Number.isInteger(index) || covered.has(index) || parts[index]?.type !== 'text') return undefined;
          covered.add(index);
        }
      } else if (entry.type === 'function_call') {
        if (!Number.isInteger(entry.block) || covered.has(entry.block) || parts[entry.block]?.type !== 'tool-call') return undefined;
        covered.add(entry.block);
      } else return undefined;
    }
    if (covered.size !== parts.length || bytes > MAX_CODEX_REPLAY_BYTES) return undefined;
    return { plan: payload.plan, bytes };
  } catch { return undefined; }
}
