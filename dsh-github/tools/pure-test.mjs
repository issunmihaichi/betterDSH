// Pure-model tests: zero dependencies, no disk, no network.
// usage: node tools/pure-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ROUTES } from '../lib/host.js';

import {
  DEFAULT_HTTP_URL,
  DEFAULT_SETTINGS,
  buildMcpRowConfig,
  cloneTarget,
  describeTransport,
  httpHeaders,
  joinArgs,
  normalizeSettings,
  parseRepoSpec,
  redactToken,
  splitArgs,
  stdioArgs,
  toolNamespace,
} from '../lib/mcpconfig.js';
import {
  contentToText,
  describeParameters,
  formatCallResult,
  formatCatalog,
  formatClonePlan,
  formatCloneResult,
  formatHelp,
  formatRemoteRepos,
  formatStatus,
  formatToolDetail,
  formatToolList,
  parseCloneOptions,
  parseCommandInput,
  parseToolArguments,
  selectTools,
  shortToolName,
} from '../lib/commands.js';
import {
  authenticatedCloneUrl,
  mapRepo,
  repoMatches,
  scrubToken,
} from '../lib/remote.js';

let passed = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------- settings ---

check('the setup-wizard flag defaults to false and normalizes to a boolean', () => {
  assert.equal(normalizeSettings({}).wizardDone, false);
  assert.equal(normalizeSettings({ wizardDone: true }).wizardDone, true);
  assert.equal(normalizeSettings({ wizardDone: 'yes' }).wizardDone, false);
});

check('defaults fill every field', () => {
  const settings = normalizeSettings(undefined);
  assert.equal(settings.transport, 'streamable-http');
  assert.equal(settings.url, DEFAULT_HTTP_URL);
  assert.equal(settings.serverName, 'github');
  assert.equal(settings.cloneDepth, 0);
  assert.equal(settings.readOnly, false);
});

check('unknown transport falls back to the hosted endpoint', () => {
  assert.equal(normalizeSettings({ transport: 'websocket' }).transport, 'streamable-http');
});

check('invalid server name falls back to github', () => {
  assert.equal(normalizeSettings({ serverName: 'bad name!' }).serverName, 'github');
  assert.equal(normalizeSettings({ serverName: 'gh_2' }).serverName, 'gh_2');
});

check('cloneDepth is clamped to a sane range', () => {
  assert.equal(normalizeSettings({ cloneDepth: -3 }).cloneDepth, 0);
  assert.equal(normalizeSettings({ cloneDepth: 99999 }).cloneDepth, 1000);
  assert.equal(normalizeSettings({ cloneDepth: 1.9 }).cloneDepth, 1);
});

check('empty strings fall back to defaults', () => {
  const settings = normalizeSettings({ url: '   ', command: '', argsText: '' });
  assert.equal(settings.url, DEFAULT_HTTP_URL);
  assert.equal(settings.command, DEFAULT_SETTINGS.command);
  assert.equal(settings.argsText, 'stdio');
});

check('argument line round-trips through quoting', () => {
  const args = ['stdio', '--toolsets', 'repos,issues', '--path', 'C:\\Program Files\\x'];
  assert.deepEqual(splitArgs(joinArgs(args)), args);
});

// -------------------------------------------------------------- mcp config ---

check('http config carries server name, transport and url', () => {
  const config = buildMcpRowConfig(normalizeSettings({}), 'ghp_secret');
  assert.equal(config.serverName, 'github');
  assert.equal(config.transport, 'streamable-http');
  assert.equal(config.url, DEFAULT_HTTP_URL);
  assert.equal(config.headers.Authorization, 'Bearer ghp_secret');
  assert.equal(config.failOnStartupError, false);
});

check('http config without a token has no Authorization header', () => {
  const config = buildMcpRowConfig(normalizeSettings({}), undefined);
  assert.equal(config.headers, undefined);
});

check('an unset toolset selection is not sent at all', () => {
  assert.equal(normalizeSettings({}).toolsets, '');
  assert.deepEqual(httpHeaders(normalizeSettings({}), 't'), { Authorization: 'Bearer t' });
});

check('toolsets and read-only reach the http headers', () => {
  const settings = normalizeSettings({ toolsets: 'repos', readOnly: true });
  assert.deepEqual(httpHeaders(settings, 't'), {
    Authorization: 'Bearer t',
    'X-MCP-Toolsets': 'repos',
    'X-MCP-Readonly': 'true',
  });
});

check('stdio config maps the token onto the configured env var', () => {
  const settings = normalizeSettings({ transport: 'stdio', command: 'github-mcp-server', argsText: 'stdio', toolsets: 'repos', readOnly: true, envVar: 'GITHUB_TOKEN' });
  const config = buildMcpRowConfig(settings, 'tok');
  assert.equal(config.transport, 'stdio');
  assert.deepEqual(config.args, ['stdio', '--toolsets', 'repos', '--read-only']);
  assert.deepEqual(config.env, { GITHUB_TOKEN: 'tok' });
  assert.equal(config.url, undefined);
  assert.equal(config.headers, undefined);
});

check('stdio config is stable across repeated builds (idempotent write)', () => {
  const settings = normalizeSettings({ transport: 'stdio' });
  assert.deepEqual(buildMcpRowConfig(settings, 'tok'), buildMcpRowConfig(settings, 'tok'));
});

check('switching transport never leaves the other transport behind', () => {
  const http = buildMcpRowConfig(normalizeSettings({ transport: 'streamable-http' }), 'tok');
  assert.equal(http.command, undefined);
  assert.equal(http.args, undefined);
  const stdio = buildMcpRowConfig(normalizeSettings({ transport: 'stdio' }), 'tok');
  assert.equal(stdio.url, undefined);
  assert.equal(stdio.headers, undefined);
});

check('stdio args always start with a subcommand', () => {
  assert.deepEqual(stdioArgs(normalizeSettings({ argsText: '' })), ['stdio']);
});

check('token redaction never reveals the body', () => {
  const masked = redactToken('ghp_abcdefghijklmnop');
  assert.ok(!masked.includes('defghij'));
  assert.ok(masked.startsWith('ghp_'));
  assert.equal(redactToken(''), '');
});

check('transport description names the endpoint or the argv', () => {
  assert.equal(describeTransport(normalizeSettings({})), DEFAULT_HTTP_URL);
  assert.equal(describeTransport(normalizeSettings({ transport: 'stdio', argsText: 'stdio' })), 'github-mcp-server stdio');
});

check('tool namespace is the documented mcp__ prefix', () => {
  assert.equal(toolNamespace('github'), 'mcp__github__');
});

// --------------------------------------------------------------- repo specs ---

check('owner/repo parses', () => {
  const spec = parseRepoSpec('octocat/Hello-World');
  assert.equal(spec.ok, true);
  assert.equal(spec.fullName, 'octocat/Hello-World');
  assert.equal(spec.cloneUrl, 'https://github.com/octocat/Hello-World.git');
});

check('https URL and .git suffix parse', () => {
  assert.equal(parseRepoSpec('https://github.com/octocat/Hello-World.git').repo, 'Hello-World');
  assert.equal(parseRepoSpec('https://github.com/octocat/Hello-World/').owner, 'octocat');
});

check('ssh URL parses', () => {
  assert.equal(parseRepoSpec('git@github.com:octocat/Hello-World.git').fullName, 'octocat/Hello-World');
});

check('garbage is refused with a reason', () => {
  assert.equal(parseRepoSpec('').ok, false);
  assert.equal(parseRepoSpec('just-a-name').ok, false);
  assert.equal(parseRepoSpec('a/b/c').ok, false);
  assert.equal(typeof parseRepoSpec('a/b/c').reason, 'string');
});

check('clone targets cannot escape the root', () => {
  assert.equal(cloneTarget('C:\\repos', '..').ok, false);
  assert.equal(cloneTarget('C:\\repos', 'a/b').ok, false);
  assert.equal(cloneTarget('C:\\repos', 'ok').path, 'C:\\repos\\ok');
  assert.equal(cloneTarget('/tmp/repos/', 'ok').path, '/tmp/repos/ok');
});

// ------------------------------------------------------------------ parsing ---

check('bare input asks for the catalog', () => {
  assert.equal(parseCommandInput('').action, 'list');
  assert.equal(parseCommandInput('   ').action, 'list');
});

check('known subcommands are recognized', () => {
  for (const name of ['list', 'tools', 'call', 'clone', 'repos', 'status', 'help']) {
    assert.equal(parseCommandInput(name).action, name);
  }
});

check('a tool name in first position becomes a call', () => {
  const parsed = parseCommandInput('search_repositories owner=me', ['search_repositories']);
  assert.equal(parsed.action, 'call');
  assert.equal(parsed.target, 'search_repositories');
  assert.equal(parsed.argumentText, 'owner=me');
  assert.deepEqual(parsed.args, ['search_repositories', 'owner=me']);
});

check('call keeps JSON argument text verbatim (quotes included)', () => {
  const parsed = parseCommandInput('call get_file_contents {"owner":"octocat","path":"a b.txt"}');
  assert.equal(parsed.action, 'call');
  assert.equal(parsed.target, 'get_file_contents');
  assert.equal(parsed.argumentText, '{"owner":"octocat","path":"a b.txt"}');
  assert.deepEqual(parseToolArguments(parsed.argumentText).value, { owner: 'octocat', path: 'a b.txt' });
});

check('call without arguments has an empty argument text', () => {
  const parsed = parseCommandInput('call get_file_contents');
  assert.equal(parsed.target, 'get_file_contents');
  assert.equal(parsed.argumentText, '');
  assert.deepEqual(parseToolArguments(parsed.argumentText).value, {});
});

check('an unknown subcommand is an explicit error', () => {
  const parsed = parseCommandInput('frobnicate');
  assert.equal(parsed.action, 'unknown');
  assert.ok(parsed.error.includes('frobnicate'));
});

check('json arguments parse', () => {
  const parsed = parseToolArguments('{"owner":"octocat","perPage":5}');
  assert.deepEqual(parsed.value, { owner: 'octocat', perPage: 5 });
});

check('key=value arguments parse with booleans', () => {
  const parsed = parseToolArguments('owner=octocat readOnly=true');
  assert.deepEqual(parsed.value, { owner: 'octocat', readOnly: true });
});

check('bad arguments are reported, not thrown', () => {
  assert.equal(parseToolArguments('{oops').ok, false);
  assert.equal(parseToolArguments('[1,2]').ok, false);
  assert.equal(parseToolArguments('nope').ok, false);
});

check('clone options read --branch/--dir and ignore their values as the repo', () => {
  const parsed = parseCloneOptions(['octocat/Hello-World', '--branch', 'dev', '--dir', 'hello']);
  assert.equal(parsed.repoToken, 'octocat/Hello-World');
  assert.equal(parsed.branch, 'dev');
  assert.equal(parsed.dir, 'hello');
});

// ------------------------------------------------------------------ shaping ---

const TOOLS = selectTools([
  { name: 'mcp__github__search_repositories', description: 'Search repositories', parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string', description: 'search text' }, page: { type: 'integer' } } } },
  { name: 'mcp__github__get_file_contents', description: 'Read a file', parameters: { type: 'object', properties: {} } },
  { name: 'mcp__other__noise', description: 'not github', parameters: {} },
  { name: 'read', description: 'built-in', parameters: {} },
], 'github');

check('only this server namespace is selected', () => {
  assert.deepEqual(TOOLS.map((tool) => tool.shortName), ['search_repositories', 'get_file_contents']);
});

check('filtering matches name and description', () => {
  assert.equal(selectTools([{ name: 'mcp__github__a', description: 'zzz', parameters: {} }], 'github', 'zzz').length, 1);
  assert.equal(selectTools([{ name: 'mcp__github__a', description: 'zzz', parameters: {} }], 'github', 'nope').length, 0);
});

check('short names strip exactly one prefix', () => {
  assert.equal(shortToolName('mcp__github__x', 'github'), 'x');
  assert.equal(shortToolName('other', 'github'), 'other');
});

check('parameters list required first', () => {
  const rows = describeParameters(TOOLS[0].parameters);
  assert.equal(rows[0].name, 'query');
  assert.equal(rows[0].required, true);
  assert.equal(rows[1].name, 'page');
});

check('content blocks flatten to text', () => {
  assert.equal(contentToText([{ type: 'text', text: 'hi' }, { type: 'image' }, 'raw']), 'hi\n[图片结果]\nraw');
  assert.equal(contentToText(undefined), '');
});

check('a successful call renders its text', () => {
  const text = formatCallResult('get_file_contents', { isError: false, isErrorFlag: false, content: [{ type: 'text', text: 'file body' }] });
  assert.equal(text, 'file body');
});

check('a failed call renders its error', () => {
  const text = formatCallResult('x', { isError: true, error: { message: 'boom' }, content: [] });
  assert.ok(text.includes('boom'));
});

check('long call output is truncated with a note', () => {
  const text = formatCallResult('x', { isError: false, content: [{ type: 'text', text: 'a'.repeat(9000) }] });
  assert.ok(text.includes('输出已截断'));
});

check('the disconnected catalog explains how to connect', () => {
  const text = formatCatalog({
    tools: [],
    settings: normalizeSettings({}),
    mcp: { enabled: false, phase: null, tokenPresent: false },
    cloneRoot: 'C:\\repos',
  });
  assert.ok(text.includes('设置 → GitHub'));
  assert.ok(text.includes('C:\\repos'));
});

check('the connected catalog lists short names and the call form', () => {
  const text = formatCatalog({
    tools: TOOLS,
    settings: normalizeSettings({}),
    mcp: { enabled: true, phase: 'active' },
    cloneRoot: 'C:\\repos',
  });
  assert.ok(text.includes('search_repositories'));
  assert.ok(text.includes('/github call'));
});

check('tool list distinguishes empty results from no query', () => {
  assert.ok(formatToolList([], 'zzz').includes('zzz'));
  assert.ok(formatToolList(TOOLS, 'search').includes('search_repositories'));
  assert.ok(formatToolList(TOOLS, '').includes('2'));
});

check('tool detail prints the usage line', () => {
  const text = formatToolDetail(TOOLS[0]);
  assert.ok(text.includes('query'));
  assert.ok(text.includes('/github call search_repositories'));
});

check('clone plan warns about the download before it starts', () => {
  const text = formatClonePlan({ fullName: 'o/r', cloneUrl: 'https://github.com/o/r.git', dest: 'C:\\repos\\r', branch: '', depth: 0 });
  assert.ok(text.includes('即将开始下载'));
  assert.ok(text.includes('注册为工作区'));
});

check('a finished clone reports the workspace outcome', () => {
  assert.ok(formatCloneResult({ state: 'done', repo: 'o/r', dest: 'C:\\repos\\r', workspace: { created: true } }).includes('工作区'));
  assert.ok(formatCloneResult({ state: 'done', repo: 'o/r', dest: 'd', workspace: { created: false, reason: 'nope' } }).includes('nope'));
  assert.ok(formatCloneResult({ state: 'failed', repo: 'o/r', code: 128, log: 'fatal: x' }).includes('128'));
});

check('status text reports token presence without the secret', () => {
  const text = formatStatus({
    settings: normalizeSettings({}),
    token: { present: true, preview: 'ghp_…abcd (20 字符)', source: 'store' },
    mcp: { enabled: true, phase: 'active', toolCount: 3 },
    cloneRoot: 'C:\\repos',
    repos: [{ name: 'r' }],
  });
  assert.ok(text.includes('active'));
  assert.ok(text.includes('3'));
  assert.ok(!text.includes('abcdefghij'));
});

check('help lists every action', () => {
  const text = formatHelp(normalizeSettings({}));
  assert.ok(text.includes('/github clone'));
  assert.ok(text.includes('/github call'));
  assert.ok(text.includes('/github remote'));
});

// ------------------------------------------------------------------- remote ---

check('a GitHub repository maps to the picker shape', () => {
  const repo = mapRepo({
    id: 1296269,
    name: 'Hello-World',
    full_name: 'octocat/Hello-World',
    owner: { login: 'octocat' },
    private: true,
    fork: false,
    archived: true,
    description: 'demo',
    language: 'TypeScript',
    default_branch: 'main',
    updated_at: '2026-01-02T03:04:05Z',
    clone_url: 'https://github.com/octocat/Hello-World.git',
    html_url: 'https://github.com/octocat/Hello-World',
    size: 42,
  });
  assert.equal(repo.fullName, 'octocat/Hello-World');
  assert.equal(repo.owner, 'octocat');
  assert.equal(repo.private, true);
  assert.equal(repo.archived, true);
  assert.equal(repo.defaultBranch, 'main');
  assert.equal(repo.sizeKb, 42);
});

check('a malformed repository entry still maps to a usable shape', () => {
  const repo = mapRepo(null);
  assert.equal(repo.fullName, '');
  assert.equal(repo.private, false);
  assert.deepEqual(mapRepo(undefined).fullName, '');
});

check('the token is injected into an https clone url only where it belongs', () => {
  assert.equal(
    authenticatedCloneUrl('https://github.com/octocat/Hello-World.git', 'ghp_abc'),
    'https://x-access-token:ghp_abc@github.com/octocat/Hello-World.git',
  );
  assert.equal(authenticatedCloneUrl('https://github.com/o/r.git', ''), 'https://github.com/o/r.git');
  assert.equal(authenticatedCloneUrl('git@github.com:o/r.git', 'ghp_abc'), 'git@github.com:o/r.git');
});

check('a token is scrubbed from any text git echoes back', () => {
  const text = "fatal: unable to access 'https://x-access-token:ghp_abc@github.com/o/r.git/': 403";
  const scrubbed = scrubToken(text, 'ghp_abc');
  assert.ok(!scrubbed.includes('ghp_abc'));
  assert.ok(scrubbed.includes('***'));
  assert.equal(scrubToken('nothing to hide', ''), 'nothing to hide');
});

check('repository matching looks at name, description and language', () => {
  const repo = mapRepo({ full_name: 'octocat/Hello-World', description: 'My first repo', language: 'Go' });
  assert.equal(repoMatches(repo, ''), true);
  assert.equal(repoMatches(repo, 'hello'), true);
  assert.equal(repoMatches(repo, 'FIRST'), true);
  assert.equal(repoMatches(repo, 'go'), true);
  assert.equal(repoMatches(repo, 'zzz'), false);
});

check('the remote listing names the account and each repository default branch', () => {
  const text = formatRemoteRepos({
    account: { login: 'octocat' },
    scanned: 100,
    items: [
      mapRepo({ full_name: 'octocat/Hello-World', private: true, language: 'Go', default_branch: 'main', description: 'demo' }),
      mapRepo({ full_name: 'octocat/Spoon-Knife', default_branch: 'dev' }),
    ],
  });
  assert.ok(text.includes('octocat'));
  assert.ok(text.includes('octocat/Hello-World'));
  assert.ok(text.includes('私有'));
  assert.ok(text.includes('/github clone octocat/Hello-World --yes'));
  assert.ok(text.includes('dev'));
});

check('an empty remote listing explains what was scanned', () => {
  const text = formatRemoteRepos({ account: { login: 'octocat' }, items: [], scanned: 30, query: 'zzz' });
  assert.ok(text.includes('zzz'));
  assert.ok(text.includes('30'));
  assert.ok(formatRemoteRepos({ account: null, items: [] }).includes('未知账号'));
});

// ------------------------------------------------------------------ client ---
// The browser half cannot be unit-tested without a DOM, but its route table can
// be checked statically: a `ROUTES.x` that the table does not define becomes the
// literal URL "undefined" at runtime, which is exactly the bug this catches.

check('every ROUTES key the client uses is defined in its own table', () => {
  const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const table = /const ROUTES = \{([\s\S]*?)\};/u.exec(clientSource);
  assert.ok(table !== null, 'the client ROUTES table was not found');
  const defined = new Set([...table[1].matchAll(/^\s*(\w+):/gmu)].map((match) => match[1]));
  const used = new Set([...clientSource.matchAll(/ROUTES\.(\w+)/gu)].map((match) => match[1]));
  assert.ok(used.size > 0, 'no ROUTES usage found');
  for (const key of used) {
    assert.ok(defined.has(key), `client uses ROUTES.${key}, which the table does not define`);
  }
});

check('every client route matches a host route', () => {
  const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const clientRoutes = [.../const ROUTES = \{([\s\S]*?)\};/u.exec(clientSource)[1].matchAll(/(\w+):\s*'([^']+)'/gu)]
    .map((match) => match[2]);
  // The browser half addresses routes document-relative; the host registers
  // them under the `/api` channel with a leading slash.
  const hostRoutes = new Set(Object.values(ROUTES).map((route) => route.replace(/^\//u, '')));
  assert.ok(clientRoutes.length > 0, 'no client routes found');
  for (const route of clientRoutes) {
    assert.ok(hostRoutes.has(route.replace(/^\//u, '')), `client route ${route} has no host counterpart`);
  }
});

check('the client never imports a Harness package', () => {
  const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const requires = [...clientSource.matchAll(/require\(['"]([^'"]+)['"]\)/gu)].map((match) => match[1]);
  for (const specifier of requires) {
    assert.ok(!specifier.startsWith('@deepseek-ai/'), `client must not require ${specifier}`);
  }
});

// ------------------------------------------------------------------ summary ---

if (failures.length > 0) {
  console.error(`pure-test: ${String(failures.length)} failed, ${String(passed)} passed`);
  for (const failure of failures) console.error(`  x ${failure}`);
  process.exit(1);
}
console.log(`pure-test: ${String(passed)}/${String(passed)} passed`);
