import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { decompressSessionLog, parseSessionLog } from '../../dsh-usage-report/tools/zstd-jsonl.mjs';

// An explicit forensic allowlist, not a platform-wide migration. These exact
// samples were emitted by the pre-fix inclusive OpenAI Chat mapper. Matching
// ledger/event counts alone cannot establish whether a sample is inclusive.
// Keep the allowlist fixed: rerunning this script cannot add newer samples.
const knownInclusive = {
  'session-c7ff26db-9897-4486-a6ba-ff2bacfd5f75': {
    sampleSeq: 984,
    inputTokens: 286557,
    outputTokens: 70,
    cacheReadTokens: 285184,
    cacheWriteTokens: 0,
    provider: 'pool-ripao',
    model: 'gpt-6-luna',
    at: '2026-10-07T10:36:14.890Z',
  },
};
const dshRoot = process.env.DSH_HOME ?? 'C:/Users/Administrator/.dsh';
const output = process.argv[2] ?? path.join(dshRoot, 'context-window/legacy-input-usage.json');
const ledger = JSON.parse(fs.readFileSync(path.join(dshRoot, 'storages/account_pool.json'), 'utf8'));
const rows = Object.values(ledger.tables.usage ?? {});
const sessionsRoot = path.join(dshRoot, 'sessions');
const slugs = fs.readdirSync(sessionsRoot);
const verified = {};
for (const [sessionId, expected] of Object.entries(knownInclusive)) {
  const row = rows.find(row => row.sessionId === sessionId && row.at === expected.at);
  assert.ok(row?.ok && row.platform === 'openai', `Known legacy ledger sample missing: ${sessionId}`);
  const file = slugs.map(slug => path.join(sessionsRoot, slug, sessionId, 'session.v4.jsonl.zstd')).find(fs.existsSync);
  assert.ok(file, `Known legacy log missing: ${sessionId}`);
  const events = parseSessionLog(decompressSessionLog(fs.readFileSync(file))).map(record => record.event ?? record);
  const sample = events.find(e => e.seq === expected.sampleSeq && ['assistant/message', 'assistant/attempt'].includes(e.type));
  const usage = sample?.data?.usage ?? sample?.data?.stream?.findLast(c => c.type === 'usage')?.usage;
  assert.ok(usage, 'Known legacy usage is unavailable');
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    assert.equal(usage[key] ?? 0, expected[key], `Legacy event mismatch: ${key}`);
    assert.equal(row[key] ?? 0, expected[key], `Legacy ledger mismatch: ${key}`);
  }
  assert.ok(Math.abs(sample.time - Date.parse(expected.at)) <= 1000, 'Legacy event time mismatch');
  const route = events.slice(0, events.indexOf(sample)).findLast(e => e.type === 'request/context');
  assert.equal(route?.data?.provider, expected.provider);
  assert.equal(route?.data?.model, expected.model);
  verified[sessionId] = {
    sampleSeq: sample.seq,
    inputTokens: usage.inputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: 0,
  };
}
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(verified, null, 2) + '\n');
console.log(JSON.stringify({ verifiedSessions: Object.keys(verified).length, output }, null, 2));
