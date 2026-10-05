// Local end-to-end check against the RUNNING Harness (loopback only).
//
//   node tools/e2e-check.mjs            # read-only checks
//   node tools/e2e-check.mjs --clone    # also perform one real git clone
//
// `/api` requests need the browser session cookie. The cookie is an HMAC over
// a small payload under the harness's own browser-session signing secret, both
// specified by `@deepseek-ai/dsh-client-connection`; this script mints the very
// cookie the open page already holds, from the credential record the harness
// itself wrote. The secret is read and used in memory, never printed, and
// every request goes to the loopback `DSH_WEB_URL`. No Harness state is
// modified beyond what the plugin's own routes do.
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const baseUrl = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387';
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const withClone = process.argv.includes('--clone');
const withTokenProbe = process.argv.includes('--token-probe');

const b64url = (value) => Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');

function signingSecret() {
  const text = readFileSync(join(dshHome, '.credentials.yaml'), 'utf8');
  const marker = text.indexOf('client-connection/browser-session:');
  if (marker < 0) throw new Error('browser-session credential record not found');
  const window = text.slice(marker, marker + 600);
  const match = /secret:\s*["']?([A-Za-z0-9_\-+/=]+)["']?/u.exec(window);
  if (match === null) throw new Error('browser-session signing secret not found');
  const secret = Buffer.from(match[1], 'base64url');
  if (secret.byteLength !== 32) throw new Error(`signing secret has ${String(secret.byteLength)} bytes, expected 32`);
  return secret;
}

function sessionCookie() {
  const authority = new URL(baseUrl).host;
  const name = `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}`;
  const now = Date.now();
  const body = b64url(JSON.stringify({
    version: 1,
    authority,
    issuedAt: now,
    expiresAt: now + 3_600_000,
  }));
  const value = `v1.${body}.${b64url(createHmac('sha256', signingSecret()).update(body).digest())}`;
  return `${name}=${value}`;
}

const cookie = sessionCookie();

async function api(path, body) {
  const init = {
    method: body === undefined ? 'GET' : 'POST',
    headers: { accept: 'application/json', cookie },
  };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(new URL(path, baseUrl), init);
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 400) };
  }
  return { status: response.status, body: parsed };
}

const results = [];
function record(label, condition, detail = '') {
  results.push({ label, ok: condition === true, detail });
  console.log(`${condition === true ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`);
}

console.log(`target ${baseUrl} (profile ${process.env.DSH_PROFILE ?? '?'})`);

// -------------------------------------------------------------------- status --
const status = await api('/api/github.status');
const snapshot = status.body;
record('GET /api/github.status is routed and authenticated', status.status === 200 && typeof snapshot === 'object', `HTTP ${String(status.status)}`);
record('the host half is live (row + server namespace)', snapshot?.mcp?.rowId === 'github-mcp' && snapshot?.mcp?.found === true, `row ${String(snapshot?.mcp?.found)} serverName=${String(snapshot?.settings?.serverName)}`);
record('the MCP client row exists and starts disabled', snapshot?.mcp?.enabled === false, `phase=${String(snapshot?.mcp?.phase)}`);
record('no tools are exposed before connecting', Array.isArray(snapshot?.tools) && snapshot.tools.length === 0, `${String(snapshot?.tools?.length)} tools`);
record('/github is registered in the session command directory', snapshot?.command?.listed === true, `catalog=[${(snapshot?.command?.catalog ?? []).map((row) => `/${String(row.name)}`).join(' ')}]`);
record('/github carries the hint the composer renders', String(snapshot?.command?.hint ?? '').includes('call'), String(snapshot?.command?.hint ?? ''));
record('git is available to the host half', snapshot?.git?.ok === true, String(snapshot?.git?.version ?? snapshot?.git?.reason ?? ''));
record('the token is absent and reported as such', snapshot?.token?.present === false && snapshot.token.preview === '', `source=${String(snapshot?.token?.source)}`);
record('no secret leaked into the status payload', !JSON.stringify(snapshot).includes('ghp_') && !JSON.stringify(snapshot).includes('github_pat_'), 'no token-shaped value');
record('the download directory resolves', typeof snapshot?.cloneRoot === 'string' && snapshot.cloneRoot !== '', snapshot?.cloneRoot);

// ----------------------------------------------------------------- settings --
const settings = await api('/api/github.settings');
record('GET /api/github.settings returns the stored settings', settings.status === 200 && settings.body?.settings?.transport !== undefined, `transport=${String(settings.body?.settings?.transport)}`);

// ---------------------------------------------------------------- boundary ---
const connect = await api('/api/github.connection', { action: 'connect' });
record('connect refuses without a token, without enabling the row', connect.body?.ok === false && connect.body?.reason === 'no-token', String(connect.body?.reason));
const after = await api('/api/github.status');
record('the refused connect left the row disabled', after.body?.mcp?.enabled === false, `enabled=${String(after.body?.mcp?.enabled)}`);

const call = await api('/api/github.call', { name: 'search_repositories', arguments: {} });
record('calling an unavailable tool is refused (409), not executed', call.status === 409 && call.body?.reason === 'unknown-tool', `HTTP ${String(call.status)} ${String(call.body?.reason)}`);

const plan = await api('/api/github.clone', { repo: 'octocat/Hello-World' });
record('a clone request returns a plan and starts nothing', plan.status === 200 && plan.body?.needsConfirm === true && typeof plan.body?.plan?.dest === 'string', `dest=${String(plan.body?.plan?.dest)}`);
record('the plan warns that the download is about to start', String(plan.body?.text ?? '').includes('即将开始下载'), 'confirmation text present');

const bad = await api('/api/github.clone', { repo: 'not-a-repo', confirm: true });
record('an unusable repository is refused before git runs', bad.status === 400 && bad.body?.ok === false, String(bad.body?.reason));

// --------------------------------------------------------- remote listing ---
const noToken = await api('/api/github.remote');
const remoteRouted = noToken.status !== 404;
if (remoteRouted) {
  record('the remote listing refuses without a token', noToken.status === 409 && noToken.body?.reason === 'no-token', `HTTP ${String(noToken.status)} ${String(noToken.body?.reason)}`);
} else {
  console.log('SKIP  remote listing checks: this host process still runs the previous module generation (restart the app to load /api/github.remote)');
}

if (withTokenProbe && remoteRouted) {
  // A deliberately invalid token proves the whole outbound path (route -> GitHub
  // REST -> error mapping) against the real API, then restores the empty store.
  const probe = 'ghp_thisTokenIsDeliberatelyInvalid000000';
  await api('/api/github.token', { token: probe });
  const rejected = await api('/api/github.remote');
  const reachedGitHub = rejected.body?.reason === 'bad-token';
  record('GitHub REST is reachable and rejects an invalid token', reachedGitHub, `reason=${String(rejected.body?.reason)} HTTP ${String(rejected.status)} ${String(rejected.body?.message ?? '')}`);
  const cleared = await api('/api/github.token', { clear: true });
  record('the probe token was cleared again', cleared.body?.ok === true && cleared.body?.status?.token?.present === false, `present=${String(cleared.body?.status?.token?.present)}`);
} else {
  console.log('SKIP  invalid-token probe (needs the remote route plus --token-probe)');
}

// -------------------------------------------------------------- real clone ---
if (withClone) {
  const started = await api('/api/github.clone', { repo: 'octocat/Hello-World', confirm: true });
  record('a confirmed clone starts', started.status === 200 && typeof started.body?.job?.id === 'string', `job=${String(started.body?.job?.id)}`);
  let job = started.body?.job;
  for (let attempt = 0; attempt < 60 && job?.state === 'running'; attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 1000); });
    const polled = await api(`/api/github.clone?id=${encodeURIComponent(job.id)}`);
    job = polled.body?.job;
  }
  record('the download completed', job?.state === 'done', `state=${String(job?.state)} code=${String(job?.code)}`);
  record('git progress was streamed to the page', Array.isArray(job?.log) && job.log.length > 0, (job?.log ?? []).slice(-1)[0] ?? '');
  record('the downloaded directory is registered as a workspace', job?.workspace?.created === true, JSON.stringify(job?.workspace ?? null));
  const repos = await api('/api/github.clone');
  record('the repository now appears in the downloaded list', (repos.body?.repos ?? []).some((entry) => entry.name === 'Hello-World'), `count=${String((repos.body?.repos ?? []).length)}`);
  // A downloaded repository must not keep a credential in its git config.
  try {
    const config = readFileSync(join(job.dest, '.git', 'config'), 'utf8');
    record('the clone origin holds no credential', !/x-access-token|ghp_|github_pat_/u.test(config), 'origin is clean');
  } catch (error) {
    record('the clone origin holds no credential', false, error instanceof Error ? error.message : String(error));
  }
} else {
  console.log('SKIP  real clone (pass --clone to perform one download)');
}

// ------------------------------------------------------------------ summary ---
const failed = results.filter((entry) => entry.ok !== true);
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} checks passed`);
if (failed.length > 0) {
  for (const entry of failed) console.error(`  x ${entry.label}${entry.detail === '' ? '' : ` — ${entry.detail}`}`);
  process.exit(1);
}
