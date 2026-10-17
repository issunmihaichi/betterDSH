/**
 * Version arithmetic for the group.
 *
 * The version decides three separate things — the `User-Agent` string, the
 * billing block's `cc_version`, and WHICH `metadata.user_id` framing is legal —
 * so every one of those reads the version through here rather than formatting it
 * itself.
 */
import { CLICurrentVersion, NEW_METADATA_FORMAT_MIN_VERSION } from './constants.js';

/**
 * Parse a three-part numeric version into `[major, minor, patch]`.
 *
 * Missing or non-numeric parts become 0, so a malformed pin degrades to `0.0.0`
 * instead of throwing in the middle of a request.
 */
export function parseVersion(version) {
  const parts = String(version ?? '').replace(/^v/, '').split('.');
  const out = [0, 0, 0];
  for (let i = 0; i < 3 && i < parts.length; i += 1) {
    const n = Number.parseInt(parts[i], 10);
    out[i] = Number.isFinite(n) ? n : 0;
  }
  return out;
}

/** `-1` when `a < b`, `0` when equal, `1` when `a > b` (sub2api `CompareVersions`). */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

/** Whether a CLI version uses the embedded-JSON `metadata.user_id` shape. */
export function isNewMetadataFormatVersion(version) {
  if (typeof version !== 'string' || version === '') return false;
  return compareVersions(version, NEW_METADATA_FORMAT_MIN_VERSION) >= 0;
}

/** The `User-Agent` the official CLI presents (sub2api `DefaultUserAgent`). */
export function claudeCliUserAgent(version = CLICurrentVersion) {
  return `claude-cli/${version} (external, cli)`;
}

/**
 * The version this account should claim: an explicit pin when present, else the
 * built-in baseline. Read ONCE per request by the controller.
 */
export function cliVersionFor(account) {
  const pinned = account?.mimicryCliVersion;
  if (typeof pinned !== 'string' || pinned === '') return CLICurrentVersion;
  return pinned;
}
