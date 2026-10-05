// Probe one persisted session log: record shapes, usage presence, and a
// cross-check of the raw-log sum against the projection cache's tokenUsage.
// usage: node probe-session.mjs [sessionIdFragment]
import fs from 'node:fs';
import { decompressSessionLog, parseSessionLog } from './zstd-jsonl.mjs';

const HOME = process.env.DSH_HOME || 'C:/Users/Administrator/.dsh';
const root = `${HOME}/sessions`;
const slug = fs.readdirSync(root).find((n) => fs.statSync(`${root}/${n}`).isDirectory());
const ids = fs.readdirSync(`${root}/${slug}`).filter((n) => fs.statSync(`${root}/${slug}/${n}`).isDirectory());
const want = process.argv[2];
const id = want ? ids.find((i) => i.includes(want)) : ids[0];
const file = `${root}/${slug}/${id}/session.v4.jsonl.zstd`;

const raw = fs.readFileSync(file);
const records = parseSessionLog(decompressSessionLog(raw));
console.log('session:', id);
console.log('file bytes:', raw.length, 'records:', records.length);

const kinds = new Map();
let usageEvents = 0;
const dayTotals = new Map();
const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
let first = null;
for (const rec of records) {
  const ev = rec?.event ?? rec;
  const type = rec?.type ?? '?';
  kinds.set(type, (kinds.get(type) ?? 0) + 1);
  if (type !== 'assistant/message') continue;
  const usage = ev?.data?.usage;
  if (!usage) continue;
  usageEvents += 1;
  if (!first) first = { seq: ev.seq, time: ev.time, turn: ev.data?.turn, usage };
  const day = new Date(ev.time).toLocaleDateString('sv-SE');
  const row = dayTotals.get(day) ?? { input: 0, output: 0 };
  row.input += usage.inputTokens ?? 0;
  row.output += usage.outputTokens ?? 0;
  dayTotals.set(day, row);
  totals.input += usage.inputTokens ?? 0;
  totals.output += usage.outputTokens ?? 0;
  totals.cacheRead += usage.cacheReadTokens ?? 0;
  totals.cacheWrite += usage.cacheWriteTokens ?? 0;
}
console.log('record types:', [...kinds.entries()].sort((a, b) => b[1] - a[1]));
const sample = records.find((r) => (r?.type ?? '') === 'assistant/message');
console.log('assistant/message envelope keys:', Object.keys(sample));
console.log('sample (trimmed):', JSON.stringify(sample).slice(0, 500));
console.log('assistant/message events with usage:', usageEvents);
console.log('first usage event:', JSON.stringify(first));
console.log('raw-log totals:', JSON.stringify(totals));
console.log('days:', [...dayTotals.entries()].sort());

const cachePath = `${HOME}/storages/session_projcache/sessions/${id}.json`;
if (fs.existsSync(cachePath)) {
  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  console.log('projection tokenUsage:', JSON.stringify(cache.record?.rows?.tokenUsage?.val?.totals));
  console.log('projection createdAt:', cache.record?.identity?.createdAt);
} else {
  console.log('no projection cache for this session');
}
