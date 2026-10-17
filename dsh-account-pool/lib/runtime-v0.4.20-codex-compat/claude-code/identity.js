/**
 * Identity module — the three values that make up `metadata.user_id`.
 *
 * sub2api stores a random `client_id` in a cache and freezes it; this group
 * DERIVES the equivalent values from the account id instead. The property that
 * matters is identical — constant for the life of the account, across restarts —
 * and derivation additionally cannot drift or be lost, needs no write path, and
 * keeps the whole group a pure function. An operator who needs a specific value
 * pins it on the account (`mimicryClientId` / `mimicryAccountUuid`).
 */
import { sha256Hex, uuidFromSeed } from './hash.js';

/**
 * The persistent device id — what the upstream uses to recognise a returning
 * client. 64 hex characters, matching sub2api's `generateClientID` width.
 */
export function deviceIdFor(account) {
  const pinned = account?.mimicryClientId;
  if (typeof pinned === 'string' && pinned !== '') return pinned;
  return sha256Hex(`account-pool:device:${String(account?.id ?? '')}`);
}

/**
 * The `account_uuid` component.
 *
 * sub2api reads the REAL upstream account uuid off the OAuth account; a pool row
 * usually has none (the importer fills it when an imported record carries a
 * well-formed one). Otherwise this derives a stable stand-in, because the field
 * must parse as a UUID for `user_id` to be accepted at all.
 */
export function accountUuidFor(account) {
  const pinned = account?.mimicryAccountUuid;
  if (typeof pinned === 'string' && pinned !== '') return pinned;
  return uuidFromSeed(`account-pool:account:${String(account?.id ?? '')}`);
}

/**
 * The session UUID for one conversation.
 *
 * sub2api approximates this from `(accountId, client discriminator, first user
 * message)` because its proxy is stateless. This pool is not: the caller already
 * supplies a `sessionId` that is stable for the session (it is what sticky
 * routing keys on), so scoping it by account yields a value that stays fixed
 * across turns without hashing message content.
 */
export function sessionIdFor(account, sessionId) {
  return uuidFromSeed(`account-pool:session:${String(account?.id ?? '')}::${String(sessionId ?? '')}`);
}

/**
 * The identity stage.
 *
 * Runs before `billing` and `metadata` because both consume what it produces — the
 * metadata triple directly, and the header stage indirectly through `sessionId`.
 */
export const identityModule = {
  name: 'identity',
  purpose: 'resolve the persistent device id, account uuid and session uuid',
  apply(plan) {
    plan.deviceId = deviceIdFor(plan.account);
    plan.accountUuid = accountUuidFor(plan.account);
    plan.sessionId = sessionIdFor(plan.account, plan.request?.sessionId);
  },
};
