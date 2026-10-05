// Decode a DSH JSONL session log: a stream of independent zstd frames
// (Node's zstd stream stops at the first frame, so split on the magic).
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Offsets of every zstd frame magic in the buffer. */
export function frameOffsets(buf) {
  const offsets = [];
  let at = buf.indexOf(MAGIC, 0);
  while (at !== -1) {
    offsets.push(at);
    at = buf.indexOf(MAGIC, at + 4);
  }
  if (offsets.length === 0 || offsets[0] !== 0) offsets.unshift(0);
  return offsets;
}

/**
 * Decompress every frame and return the concatenated plain text.
 * A frame that fails to decompress is merged into the next one, so a payload
 * that merely contains the magic bytes cannot truncate the log.
 */
export function decompressSessionLog(buf) {
  const offsets = frameOffsets(buf);
  const parts = [];
  let start = offsets[0];
  for (let i = 1; i <= offsets.length; i += 1) {
    const end = i === offsets.length ? buf.length : offsets[i];
    const segment = buf.subarray(start, end);
    try {
      parts.push(zlib.zstdDecompressSync(segment));
      start = end;
    } catch {
      // Keep scanning: this "frame" was payload bytes that looked like a magic.
      if (i === offsets.length) throw new Error('unreadable zstd tail');
    }
  }
  return Buffer.concat(parts).toString('utf8');
}

/** Parse the decoded log into records (JSONL, trailing newline tolerated). */
export function parseSessionLog(text) {
  const records = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    records.push(JSON.parse(trimmed));
  }
  return records;
}
