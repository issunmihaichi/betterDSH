/**
 * `metadata.user_id` module.
 *
 * The upstream parses this field, and its shape changed at CLI 2.1.78: older CLIs
 * concatenated the parts into a string, newer ones embed a JSON document. Emitting
 * the wrong shape for the version being claimed is a self-contradiction inside a
 * single request, so the framing is chosen from the same resolved version the
 * `User-Agent` and the billing block use.
 */
import { isNewMetadataFormatVersion } from './version.js';

/**
 * Build `metadata.user_id`.
 *
 * Legacy (CLI < 2.1.78): `user_<device>_account_<uuid>_session_<uuid>`.
 * Current: `{"device_id":…,"account_uuid":…,"session_id":…}`.
 */
export function formatMetadataUserId({ deviceId, accountUuid, sessionId, version }) {
  if (isNewMetadataFormatVersion(version)) {
    return JSON.stringify({ device_id: deviceId, account_uuid: accountUuid, session_id: sessionId });
  }
  return `user_${deviceId}_account_${accountUuid}_session_${sessionId}`;
}

const LEGACY_USER_ID_RE = /^user_([a-fA-F0-9]{64})_account_([a-fA-F0-9-]*)_session_([a-fA-F0-9-]{36})$/;

/**
 * Parse either `metadata.user_id` form (sub2api `ParseMetadataUserID`).
 *
 * Kept because the tests assert the emitted value against the upstream's OWN
 * parsing rule rather than against a hand-written expected string: a format is a
 * contract, and an expectation copied by hand would happily accept a shape that
 * merely looks right.
 *
 * @returns `{ deviceId, accountUuid, sessionId, isNewFormat }`, or `null`.
 */
export function parseMetadataUserId(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  if (trimmed[0] === '{') {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
    if (typeof parsed?.device_id !== 'string' || parsed.device_id === '') return null;
    if (typeof parsed?.session_id !== 'string' || parsed.session_id === '') return null;
    return {
      deviceId: parsed.device_id,
      accountUuid: typeof parsed.account_uuid === 'string' ? parsed.account_uuid : '',
      sessionId: parsed.session_id,
      isNewFormat: true,
    };
  }

  const match = LEGACY_USER_ID_RE.exec(trimmed);
  if (match === null) return null;
  return { deviceId: match[1], accountUuid: match[2], sessionId: match[3], isNewFormat: false };
}

/** The metadata stage: attach the identity triple computed by the identity module. */
export const metadataModule = {
  name: 'metadata',
  purpose: 'attach metadata.user_id in the framing the claimed CLI version uses',
  apply(plan) {
    const existing = plan.body.metadata;
    plan.body.metadata = {
      ...(existing !== null && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}),
      user_id: formatMetadataUserId({
        deviceId: plan.deviceId,
        accountUuid: plan.accountUuid,
        sessionId: plan.sessionId,
        version: plan.version,
      }),
    };
  },
};
