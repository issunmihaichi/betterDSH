/**
 * Hashing primitives shared by the group's identity and billing modules.
 *
 * Split out so the two consumers cannot drift apart: both need the exact same
 * SHA-256-to-hex and seed-to-UUID behaviour, and a second implementation is how
 * a fingerprint ends up disagreeing with the value it is derived from.
 */
import { createHash } from 'node:crypto';

/** Lower-case hex SHA-256 of a UTF-8 string. */
export function sha256Hex(input) {
  return createHash('sha256').update(String(input), 'utf8').digest('hex');
}

/**
 * Shape the first 16 bytes of a digest into a v4-shaped UUID.
 *
 * The version/variant bits are set because the field must PARSE as a UUID
 * upstream; a bare 32-hex string would not.
 */
export function uuidFromDigest(digest) {
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** A deterministic v4-shaped UUID derived from a seed string. */
export function uuidFromSeed(seed) {
  return uuidFromDigest(createHash('sha256').update(String(seed), 'utf8').digest());
}
