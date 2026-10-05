// What client code is the RUNNING Harness serving for this plugin?
//
//   node tools/bundle-check.mjs [marker]
//
// Fetches the boot payload from the app, finds this plugin's client bundle
// entry, downloads the bundle the page would execute, and reports whether it
// contains `marker` (default: a string only the newest revision has). This is
// how "the page still shows the old UI" is told apart from "the page is stale
// in the browser": the answer comes from the bytes the server hands out.
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const baseUrl = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387';
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const marker = process.argv[2] ?? '搜索你的仓库';
const pluginId = process.argv[3] ?? 'dsh-github';

const b64url = (value) => Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');

function cookie() {
  const text = readFileSync(join(dshHome, '.credentials.yaml'), 'utf8');
  const marker2 = text.indexOf('client-connection/browser-session:');
  const secret = Buffer.from(/secret:\s*["']?([A-Za-z0-9_\-+/=]+)["']?/u.exec(text.slice(marker2, marker2 + 600))[1], 'base64url');
  const authority = new URL(baseUrl).host;
  const name = `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}`;
  const now = Date.now();
  const body = b64url(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 3_600_000 }));
  return `${name}=v1.${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`;
}

const headers = { cookie: cookie() };
const index = await (await fetch(baseUrl, { headers })).text();

// The boot payload lists every client module with the rev the page will load.
const entries = [...index.matchAll(/\{[^{}]*"id"\s*:\s*"([^"]+)"[^{}]*\}/gu)]
  .map((match) => match[0])
  .filter((text) => text.includes(pluginId));
console.log(`boot payload mentions ${pluginId}: ${String(entries.length)} entry/entries`);
for (const entry of entries.slice(0, 4)) console.log(`  ${entry.slice(0, 400)}`);

const paths = [...index.matchAll(/["'(]([^"'()\s]*client[^"'()\s]*\.js[^"'()\s]*)["')]/gu)].map((match) => match[1]);
const candidates = [...new Set(paths)].filter((path) => path.includes(pluginId) || path.includes('client-modules'));
console.log(`bundle-ish paths found: ${candidates.length === 0 ? '(none)' : candidates.slice(0, 6).join(', ')}`);

// The module table route serves one plugin's bundle by id.
for (const path of [`/dsh/client/${pluginId}.js`, `/client/${pluginId}.js`, ...candidates.slice(0, 4)]) {
  const url = new URL(path, baseUrl).href;
  let response;
  try {
    response = await fetch(url, { headers });
  } catch (error) {
    console.log(`  ${path}: fetch failed (${error instanceof Error ? error.message : String(error)})`);
    continue;
  }
  const text = await response.text();
  if (response.status !== 200) {
    console.log(`  ${path}: HTTP ${String(response.status)}`);
    continue;
  }
  const present = text.includes(marker);
  console.log(`  ${path}: HTTP 200, ${String(text.length)} bytes, contains ${JSON.stringify(marker)}: ${present ? 'YES' : 'no'}`);
  if (present) {
    console.log('the server is already handing out the newest revision');
    process.exit(0);
  }
}
console.log('the server is NOT handing out the newest revision for this plugin');
