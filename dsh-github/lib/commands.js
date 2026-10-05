/**
 * Pure parsing and text shaping for the `/github` human command.
 *
 * A human command's whole output is the text the chat shows, so this module
 * owns two things and nothing else: turning the typed line into an action, and
 * turning Host data into text a person can read. Keeping it dependency-free is
 * what lets the offline tests assert the exact strings the user will see.
 */
import { describeTransport, parseRepoSpec, redactToken, splitArgs, toolNamespace } from './mcpconfig.js';

/** Every action `/github` understands, with the one-line help of each. */
export const ACTIONS = [
  { name: 'list', usage: '/github', help: '列出当前可用的 GitHub MCP 工具（默认动作）' },
  { name: 'tools', usage: '/github tools [关键词]', help: '按关键词列出工具及其参数' },
  { name: 'call', usage: '/github call <工具名> [JSON 参数]', help: '调用一个 GitHub MCP 工具并回显结果' },
  { name: 'remote', usage: '/github remote [关键词]', help: '列出你 GitHub 账号下的仓库（含组织与协作仓库）' },
  { name: 'clone', usage: '/github clone <owner/repo> [--branch b] [--dir 目录] [--yes]', help: '下载远程仓库并注册为工作区' },
  { name: 'repos', usage: '/github repos', help: '列出已下载的仓库' },
  { name: 'status', usage: '/github status', help: '查看 MCP 连接与令牌状态' },
  { name: 'help', usage: '/github help', help: '显示本帮助' },
];

const ACTION_NAMES = new Set(ACTIONS.map((action) => action.name));

/**
 * Parse the text that follows the command name.
 *
 * Only the head word is tokenized: everything after it is kept verbatim,
 * because `/github call` arguments are JSON and must survive with their quotes
 * intact. Unknown first words are treated as a tool name when the MCP
 * namespace has such a tool, so `/github get_file_contents owner=me` reads
 * naturally; anything else becomes an explicit error instead of a silent
 * no-op.
 */
export function parseCommandInput(rawInput, toolNames = []) {
  const text = String(rawInput ?? '').trim();
  if (text === '') return { action: 'list', args: [], rest: '', target: '', argumentText: '' };
  const head = /^(\S+)\s*([\s\S]*)$/.exec(text);
  const word = head[1];
  const rest = head[2].trim();
  if (ACTION_NAMES.has(word)) {
    const call = word === 'call' ? splitCall(rest) : { target: '', argumentText: '' };
    return { action: word, args: splitArgs(rest), rest, ...call };
  }
  if (toolNames.includes(word)) {
    return {
      action: 'call',
      args: [word, ...splitArgs(rest)],
      rest: text,
      ...splitCall(rest, word),
    };
  }
  return {
    action: 'unknown',
    args: splitArgs(text),
    rest: text,
    target: '',
    argumentText: '',
    error: `未知的 /github 子命令：${word}。可用：${[...ACTION_NAMES].join(', ')}`,
  };
}

/** Split `<tool> <arguments>` without touching the argument text. */
function splitCall(rest, explicitTarget) {
  if (explicitTarget !== undefined) return { target: explicitTarget, argumentText: rest };
  const match = /^(\S+)\s*([\s\S]*)$/.exec(rest);
  if (match === null) return { target: '', argumentText: '' };
  return { target: match[1], argumentText: match[2].trim() };
}

/** Strip the `mcp__<server>__` prefix the bridge put on a tool name. */
export function shortToolName(name, serverName) {
  const prefix = toolNamespace(serverName);
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** GitHub MCP tools visible to one scope, optionally filtered by keyword. */
export function selectTools(schemas, serverName, query = '') {
  const prefix = toolNamespace(serverName);
  const needle = String(query).trim().toLowerCase();
  return (Array.isArray(schemas) ? schemas : [])
    .filter((schema) => typeof schema?.name === 'string' && schema.name.startsWith(prefix))
    .filter((schema) => needle === ''
      || schema.name.toLowerCase().includes(needle)
      || String(schema.description ?? '').toLowerCase().includes(needle))
    .map((schema) => ({ ...schema, shortName: shortToolName(schema.name, serverName) }));
}

/** Flatten one tool's JSON schema into readable parameter lines. */
export function describeParameters(parameters, limit = 6) {
  const properties = parameters !== null && typeof parameters === 'object' ? parameters.properties : undefined;
  if (properties === null || typeof properties !== 'object') return [];
  const required = new Set(Array.isArray(parameters.required) ? parameters.required : []);
  const names = Object.keys(properties);
  names.sort((left, right) => Number(required.has(right)) - Number(required.has(left)));
  return names.slice(0, limit).map((name) => {
    const node = properties[name] ?? {};
    const type = typeof node.type === 'string' ? node.type : Array.isArray(node.enum) ? 'enum' : 'any';
    const flag = required.has(name) ? '必填' : '可选';
    const description = String(node.description ?? '').split('\n')[0].slice(0, 90);
    return { name, type, required: required.has(name), text: `${flag} ${name}: ${type}${description === '' ? '' : ` — ${description}`}` };
  });
}

const bullet = (text) => `• ${text}`;

/** Text formatting helpers shared by the command and the Settings page. */
export function formatCatalog(options) {
  const { tools, settings, mcp, cloneRoot } = options;
  const lines = [];
  const connected = mcp?.phase === 'active' && mcp?.enabled === true && Array.isArray(tools) && tools.length > 0;
  if (connected) {
    lines.push(`GitHub MCP 已连接：${describeTransport(settings)}（命名空间 ${toolNamespace(settings.serverName)}）`);
    lines.push(`可用工具 ${String(tools.length)} 个（完整参数见 /github tools 或设置 → GitHub）：`);
    for (const tool of tools.slice(0, 40)) {
      lines.push(bullet(`${tool.shortName} — ${String(tool.description ?? '').split('\n')[0].slice(0, 100)}`));
    }
    if (tools.length > 40) lines.push(`… 另有 ${String(tools.length - 40)} 个工具，用 /github tools <关键词> 过滤`);
    lines.push('');
    lines.push('调用：/github call <工具名> {"参数": "值"}');
    lines.push('列出你账号下的仓库：/github remote [关键词]');
    lines.push(`下载仓库：/github clone <owner/repo>（落地目录 ${cloneRoot}）`);
    return lines.join('\n');
  }
  lines.push('GitHub MCP 当前不可用，因此没有可调用的工具。');
  lines.push(`连接方式：${describeTransport(settings)}`);
  if (mcp?.enabled !== true) {
    lines.push('原因：MCP 连接行处于停用状态。到「设置 → GitHub」填入 Personal Access Token 并点击「连接」。');
  } else if (mcp?.tokenPresent !== true) {
    lines.push('原因：还没有保存 GitHub 令牌。到「设置 → GitHub」填入 Personal Access Token 并点击「连接」。');
  } else {
    lines.push('原因：MCP 客户端行尚未连接成功，可在设置页查看最近一次错误。');
  }
  lines.push('');
  // Listing your own repositories and cloning them need the token but not the
  // MCP connection, so both are offered either way.
  lines.push('列出你账号下的全部仓库：/github remote [关键词]');
  lines.push(`下载仓库：/github clone <owner/repo>（落地目录 ${cloneRoot}）`);
  lines.push('其它可用动作：/github tools、/github call、/github repos、/github status');
  return lines.join('\n');
}

/** Detailed, one-tool-per-block listing. */
export function formatToolList(tools, query = '') {
  if (!Array.isArray(tools) || tools.length === 0) {
    return query === ''
      ? '当前没有可用的 GitHub MCP 工具。'
      : `没有匹配「${query}」的 GitHub MCP 工具。`;
  }
  if (query === '') return `${String(tools.length)} 个 GitHub MCP 工具。用 /github tools <关键词> 过滤，或用 /github tools <工具名> 看参数。`;
  const blocks = [];
  for (const tool of tools.slice(0, 12)) {
    const params = describeParameters(tool.parameters);
    blocks.push(`${tool.shortName}\n  ${String(tool.description ?? '').split('\n')[0]}`);
    for (const param of params) blocks.push(`  ${param.text}`);
    if (params.length === 0) blocks.push('  （无参数）');
  }
  if (tools.length > 12) blocks.push(`… 另有 ${String(tools.length - 12)} 个匹配结果`);
  return blocks.join('\n');
}

/** One tool's full parameter surface. */
export function formatToolDetail(tool) {
  const params = describeParameters(tool.parameters, 40);
  const lines = [`${tool.shortName} — ${String(tool.description ?? '')}`];
  if (params.length === 0) lines.push('无参数。');
  for (const param of params) lines.push(`  ${param.text}`);
  lines.push('');
  lines.push(`用法：/github call ${tool.shortName} {${params.filter((param) => param.required).map((param) => `"${param.name}": …`).join(', ')}}`);
  return lines.join('\n');
}

/** Plain text of a ContentBlock list, tolerating shapes this plugin has not seen. */
export function contentToText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block === null || block === undefined) continue;
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
      continue;
    }
    if (block.type === 'image') {
      parts.push('[图片结果]');
      continue;
    }
    try {
      parts.push(JSON.stringify(block));
    } catch {
      parts.push(String(block));
    }
  }
  return parts.join('\n');
}

/** Present one settled tool execution as chat text. */
export function formatCallResult(shortName, result, limit = 4000) {
  if (result === null || typeof result !== 'object') return `调用 ${shortName} 没有返回结果。`;
  if (result.isError === true) {
    const message = result.error?.message ?? contentToText(result.content) ?? '未知错误';
    return `调用 ${shortName} 失败：${message}`;
  }
  const body = contentToText(result.content);
  const text = body === '' ? JSON.stringify(result.value ?? null, null, 2) : body;
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…（输出已截断，共 ${String(text.length)} 字符）`;
}

/** Connection/configuration summary. */
export function formatStatus(options) {
  const { settings, token, mcp, cloneRoot, repos } = options;
  const lines = [];
  lines.push(`连接状态：${mcp?.phase ?? 'unknown'}${mcp?.enabled === true ? '' : '（行已停用）'}`);
  lines.push(`命名空间：${toolNamespace(settings.serverName)}`);
  lines.push(`传输方式：${settings.transport} · ${describeTransport(settings)}`);
  lines.push(`工具数量：${String(mcp?.toolCount ?? 0)}`);
  lines.push(`令牌：${token?.present === true ? `已配置（${token.preview}，来源 ${token.source}）` : '未配置'} `);
  lines.push(`下载目录：${cloneRoot}`);
  lines.push(`已下载仓库：${String(Array.isArray(repos) ? repos.length : 0)} 个`);
  if (typeof mcp?.lastError === 'string' && mcp.lastError !== '') lines.push(`最近错误：${mcp.lastError}`);
  return lines.join('\n');
}

/** The account's own repository listing, as `/github remote` prints it. */
export function formatRemoteRepos(options) {
  const { account, items, scanned, query, truncated } = options;
  const login = account?.login === undefined || account.login === '' ? '（未知账号）' : account.login;
  if (!Array.isArray(items) || items.length === 0) {
    return query === undefined || query === ''
      ? `账号 ${login} 下没有可见的仓库。`
      : `账号 ${login} 下没有匹配「${query}」的仓库（已扫描 ${String(scanned ?? 0)} 个）。`;
  }
  const lines = [
    query === undefined || query === ''
      ? `账号 ${login}：本页 ${String(items.length)} 个仓库（按最近更新排序）`
      : `账号 ${login}：匹配「${query}」${String(items.length)} 个（已扫描 ${String(scanned ?? 0)} 个）`,
  ];
  for (const repo of items.slice(0, 25)) {
    const tags = [
      repo.private === true ? '私有' : '公开',
      repo.language === '' ? '' : repo.language,
      repo.archived === true ? '已归档' : '',
      repo.fork === true ? 'Fork' : '',
    ].filter((tag) => tag !== '');
    lines.push(`• ${repo.fullName} · ${tags.join(' · ')}`);
    if (repo.description !== '') lines.push(`  ${repo.description.slice(0, 90)}`);
    lines.push(`  默认分支 ${repo.defaultBranch === '' ? '(未知)' : repo.defaultBranch} · 下载：/github clone ${repo.fullName} --yes`);
  }
  if (items.length > 25) lines.push(`… 另有 ${String(items.length - 25)} 个，用关键词缩小范围`);
  if (truncated === true) lines.push('（还有更多仓库未扫描；用关键词精确查找）');
  return lines.join('\n');
}

/** Clone plan preview, shown before any download starts. */
export function formatClonePlan(plan) {
  const lines = [
    `即将开始下载远程仓库 ${plan.fullName}`,
    `来源：${plan.cloneUrl}`,
    `落地：${plan.dest}`,
  ];
  if (plan.branch !== '') lines.push(`分支：${plan.branch}`);
  if (plan.depth > 0) lines.push(`浅克隆：depth=${String(plan.depth)}`);
  lines.push('确认后开始 git clone，并在 DSH 里把该目录注册为工作区。');
  return lines.join('\n');
}

/** Settled clone job as chat text. */
export function formatCloneResult(job) {
  if (job.state === 'done') {
    const lines = [`已下载 ${job.repo} → ${job.dest}`];
    if (job.workspace?.created === true) lines.push('已在 DSH 中注册为工作区。');
    else if (typeof job.workspace?.reason === 'string') lines.push(`注册工作区失败：${job.workspace.reason}`);
    return lines.join('\n');
  }
  if (job.state === 'failed') {
    return `下载 ${job.repo} 失败（git 退出码 ${String(job.code)}）：\n${String(job.log ?? '').split('\n').slice(-8).join('\n')}`;
  }
  return `正在下载 ${job.repo} → ${job.dest}…`;
}

/**
 * `/github call` argument: `{"x": 1}` or `key=value` pairs.
 * Returns `{ ok, value }` so the command can report a bad payload instead of
 * throwing out of the handler.
 */
export function parseToolArguments(text) {
  const raw = String(text ?? '').trim();
  if (raw === '') return { ok: true, value: {} };
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, reason: 'JSON 参数必须是一个对象，例如 {"owner":"octocat"}' };
      }
      return { ok: true, value: parsed };
    } catch (error) {
      return { ok: false, reason: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const value = {};
  for (const token of splitArgs(raw)) {
    const at = token.indexOf('=');
    if (at <= 0) return { ok: false, reason: `参数片段「${token}」不是 key=value 形式` };
    const key = token.slice(0, at);
    const text5 = token.slice(at + 1);
    value[key] = text5 === 'true' ? true : text5 === 'false' ? false : text5;
  }
  return { ok: true, value };
}

/** `/github clone` options: a repository plus optional `--branch` / `--dir`. */
export function parseCloneOptions(args) {
  const tokens = Array.isArray(args) ? args : [];
  const repoToken = tokens.find((token) => !token.startsWith('--') && !looksLikeOptionValue(tokens, token));
  let branch = '';
  let dir = '';
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--branch' || token === '-b') branch = tokens[index + 1] ?? '';
    else if (token === '--dir' || token === '-d') dir = tokens[index + 1] ?? '';
  }
  return { repoToken: repoToken ?? '', branch, dir };
}

function looksLikeOptionValue(tokens, token) {
  const index = tokens.indexOf(token);
  if (index <= 0) return false;
  const previous = tokens[index - 1];
  return previous === '--branch' || previous === '-b' || previous === '--dir' || previous === '-d';
}

/** `/github help` text, listing the action table plus the current namespace. */
export function formatHelp(settings) {
  const lines = ['/github — GitHub MCP 与远程仓库', ''];
  for (const action of ACTIONS) lines.push(`${action.usage}\n  ${action.help}`);
  lines.push('');
  lines.push(`当前命名空间 ${toolNamespace(settings.serverName)}；在设置 → GitHub 里管理连接与令牌。`);
  return lines.join('\n');
}

/** Re-exported so the Host half and the page agree on token masking. */
export { redactToken, parseRepoSpec };
