/**
 * Pure settings/MCP-config model for dsh-github.
 *
 * Everything here is dependency-free and side-effect-free so the same code can
 * run in the Host half, in offline tests, and (for shapes only) be mirrored by
 * the browser half. It answers two questions:
 *
 *   1. what does the user's stored GitHub configuration mean, and
 *   2. what exact `config` must the `@deepseek-ai/dsh-mcp-client` row carry for
 *      that configuration to reach github/github-mcp-server?
 */

/** Official hosted GitHub MCP endpoint (Streamable HTTP, PAT or OAuth). */
export const DEFAULT_HTTP_URL = 'https://api.githubcopilot.com/mcp/';

/** Default MCP namespace: tools become `mcp__github__<tool>`. */
export const DEFAULT_SERVER_NAME = 'github';

/** Default executable of the local stdio server from github/github-mcp-server. */
export const DEFAULT_COMMAND = 'github-mcp-server';

/** Environment variable consulted first when `tokenSource` is `env`. */
export const DEFAULT_ENV_VAR = 'GITHUB_PERSONAL_ACCESS_TOKEN';

/**
 * Toolset names accepted by github/github-mcp-server. Offered as hints in the
 * UI; the server itself validates the value, so this list may lag a release.
 */
export const KNOWN_TOOLSETS = [
  'context',
  'repos',
  'git',
  'issues',
  'pull_requests',
  'actions',
  'code_security',
  'dependabot',
  'discussions',
  'gists',
  'labels',
  'notifications',
  'orgs',
  'projects',
  'secret_protection',
  'security_advisories',
  'stargazers',
  'users',
];

/** Server name grammar imposed by the MCP client bridge. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  serverName: DEFAULT_SERVER_NAME,
  transport: 'streamable-http',
  url: DEFAULT_HTTP_URL,
  command: DEFAULT_COMMAND,
  argsText: 'stdio',
  cwd: '',
  // Empty means "do not send a toolset selection": the server's own default
  // applies, which is what a first-run user expects.
  toolsets: '',
  readOnly: false,
  tokenSource: 'store',
  envVar: DEFAULT_ENV_VAR,
  failOnStartupError: false,
  cloneRoot: '',
  cloneDepth: 0,
  cloneBranch: '',
  // The in-page setup wizard owns the first run; `wizardDone` is the user
  // saying "I am configured, show me the full page".
  wizardDone: false,
});

const asString = (value) => (typeof value === 'string' ? value : '');

const asBool = (value) => value === true;

/** Split a whitespace-separated argument line, honouring double quotes. */
export function splitArgs(text) {
  const out = [];
  let current = '';
  let quoted = false;
  for (const char of asString(text)) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (current !== '') {
        out.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current !== '') out.push(current);
  return out;
}

/** Join arguments back into an editable line, quoting tokens with spaces. */
export function joinArgs(args) {
  return (Array.isArray(args) ? args : [])
    .map((arg) => (String(arg) === '' || /\s/.test(String(arg)) ? `"${String(arg)}"` : String(arg)))
    .join(' ');
}

/** Normalize an arbitrary persisted blob into complete, validated settings. */
export function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const transport = source.transport === 'stdio' ? 'stdio' : 'streamable-http';
  const serverName = SERVER_NAME_PATTERN.test(asString(source.serverName))
    ? asString(source.serverName)
    : DEFAULT_SERVER_NAME;
  const tokenSource = source.tokenSource === 'env' ? 'env' : 'store';
  const cloneDepthRaw = Number(source.cloneDepth);
  return {
    version: 1,
    serverName,
    transport,
    url: asString(source.url).trim() === '' ? DEFAULT_HTTP_URL : asString(source.url).trim(),
    command: asString(source.command).trim() === '' ? DEFAULT_COMMAND : asString(source.command).trim(),
    argsText: asString(source.argsText).trim() === '' ? DEFAULT_SETTINGS.argsText : asString(source.argsText).trim(),
    cwd: asString(source.cwd).trim(),
    toolsets: asString(source.toolsets).trim(),
    readOnly: asBool(source.readOnly),
    tokenSource,
    envVar: asString(source.envVar).trim() === '' ? DEFAULT_ENV_VAR : asString(source.envVar).trim(),
    failOnStartupError: asBool(source.failOnStartupError),
    cloneRoot: asString(source.cloneRoot).trim(),
    cloneDepth: Number.isFinite(cloneDepthRaw) && cloneDepthRaw > 0 ? Math.min(1000, Math.trunc(cloneDepthRaw)) : 0,
    cloneBranch: asString(source.cloneBranch).trim(),
    wizardDone: asBool(source.wizardDone),
  };
}

/**
 * Final stdio argv: the user's base arguments plus the flags derived from the
 * shared options, in a fixed order so repeated writes stay byte-identical and
 * the Loader sees no spurious change.
 */
export function stdioArgs(settings) {
  const args = splitArgs(settings.argsText);
  if (args.length === 0) args.push('stdio');
  if (settings.toolsets !== '') args.push('--toolsets', settings.toolsets);
  if (settings.readOnly) args.push('--read-only');
  return args;
}

/** `--toolsets`-equivalent extra headers of the hosted endpoint. */
export function httpHeaders(settings, token) {
  const headers = {};
  if (typeof token === 'string' && token !== '') headers.Authorization = `Bearer ${token}`;
  if (settings.toolsets !== '') headers['X-MCP-Toolsets'] = settings.toolsets;
  if (settings.readOnly) headers['X-MCP-Readonly'] = 'true';
  return headers;
}

/**
 * The complete `config` object for the `@deepseek-ai/dsh-mcp-client` row.
 *
 * `configEditor.edit` replaces the whole config, so this must be a total
 * function of (settings, token): every field the row needs is always present
 * and no field is carried over from a previous generation.
 */
export function buildMcpRowConfig(settings, token) {
  const base = {
    serverName: settings.serverName,
    transport: settings.transport,
    failOnStartupError: settings.failOnStartupError,
  };
  if (settings.transport === 'stdio') {
    base.command = settings.command;
    base.args = stdioArgs(settings);
    if (settings.cwd !== '') base.cwd = settings.cwd;
    base.env = token === undefined || token === '' ? {} : { [settings.envVar]: token };
    return base;
  }
  base.url = settings.url;
  const headers = httpHeaders(settings, token);
  if (Object.keys(headers).length > 0) base.headers = headers;
  return base;
}

/** Mask a token for display: prefix, length and a short suffix, never the body. */
export function redactToken(token) {
  const value = asString(token);
  if (value === '') return '';
  if (value.length <= 8) return `${value[0] ?? ''}…(${String(value.length)})`;
  return `${value.slice(0, 4)}…${value.slice(-4)} (${String(value.length)} 字符)`;
}

/** One-line human description of where this connection points. */
export function describeTransport(settings) {
  if (settings.transport === 'stdio') {
    return `${settings.command} ${joinArgs(stdioArgs(settings))}`.trim();
  }
  return settings.url;
}

/** How the MCP bridge will name this server's tools for the model. */
export function toolNamespace(serverName) {
  return `mcp__${serverName}__`;
}

/**
 * Parse the repository forms a user actually pastes.
 *
 * Accepts `owner/repo`, `https://github.com/owner/repo(.git)`, and
 * `git@github.com:owner/repo.git`. Anything else is refused with a reason so
 * the caller can show it instead of starting a clone that cannot work.
 */
export function parseRepoSpec(text, defaultHost = 'github.com') {
  const value = asString(text).trim();
  if (value === '') return { ok: false, reason: '请填写仓库，例如 octocat/Hello-World 或 https://github.com/octocat/Hello-World' };
  let host = defaultHost;
  let body = value.replace(/\.git$/i, '');
  const ssh = /^git@([^:]+):(.+)$/.exec(body);
  if (ssh !== null) {
    host = ssh[1];
    body = ssh[2];
  } else if (/^https?:\/\//i.test(body)) {
    try {
      const parsed = new URL(body);
      host = parsed.host;
      body = parsed.pathname.replace(/^\/+/, '');
    } catch {
      return { ok: false, reason: `无法解析仓库地址：${value}` };
    }
  }
  const segments = body.split('/').filter((segment) => segment !== '');
  if (segments.length !== 2) {
    return { ok: false, reason: `仓库必须是 owner/repo 两段，收到：${value}` };
  }
  const [owner, repo] = segments;
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) {
    return { ok: false, reason: `仓库名含非法字符：${value}` };
  }
  return {
    ok: true,
    owner,
    repo,
    host,
    fullName: `${owner}/${repo}`,
    cloneUrl: `https://${host}/${owner}/${repo}.git`,
    webUrl: `https://${host}/${owner}/${repo}`,
  };
}

/**
 * Where a clone of `repo` lands under `root`, and whether that path is inside
 * `root` — a repository name must never be able to escape the clone root.
 */
export function cloneTarget(root, repo) {
  const base = asString(root).replace(/[\\/]+$/, '');
  const name = asString(repo);
  if (base === '' || name === '') return { ok: false, reason: 'cloneRoot 与仓库名都不能为空' };
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    return { ok: false, reason: `非法的目录名：${name}` };
  }
  const separator = base.includes('\\') ? '\\' : '/';
  return { ok: true, path: `${base}${separator}${name}` };
}
