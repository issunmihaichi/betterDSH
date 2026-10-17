/**
 * dsh-github — Host half.
 *
 * Three capabilities, one plugin:
 *
 *   1. A GitHub management surface for the Settings page. The Host owns the
 *      GitHub personal access token, the transport choice, and the bridge to
 *      the shipped MCP client (`@deepseek-ai/dsh-mcp-client`): pressing 连接
 *      writes a complete raw config into the MCP row through the Host
 *      `configEditor` service, which is what makes the server's tools appear as
 *      `mcp__<server>__<tool>` for the model.
 *   2. The `/github` human command. It lists the GitHub MCP tools, calls one on
 *      demand, and shows connection status — the palette entry a person uses
 *      instead of hand-writing a tool call.
 *   3. 远程连接仓库: plan, confirm, download with live progress, then register
 *      the downloaded directory as a DSH workspace.
 *
 * Nothing here reaches the network on its own except `git clone`, which only
 * runs after an explicit confirmation. The MCP connection itself is opened by
 * the MCP client row, never by this file.
 */
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  buildMcpRowConfig,
  cloneTarget,
  describeTransport,
  normalizeSettings,
  parseRepoSpec,
  redactToken,
  toolNamespace,
} from './mcpconfig.js';
import {
  contentToText,
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
} from './commands.js';
import { createGitRunner, listClones } from './git.js';
import { authenticatedCloneUrl, createGitHubApi, repoMatches, scrubToken } from './remote.js';
import { createStore, defaultStoreDir } from './settings.js';

/** Cordis plugin name; must equal the package name the profile loads. */
export const name = 'dsh-github';

/** `connection` owns the authenticated `/api` channel every route hangs on. */
export const inject = ['connection'];

/** Exact Fetch routes behind the Settings page (all under the `/api` channel). */
export const ROUTES = {
  status: '/api/github.status',
  settings: '/api/github.settings',
  token: '/api/github.token',
  connection: '/api/github.connection',
  call: '/api/github.call',
  remote: '/api/github.remote',
  clone: '/api/github.clone',
};

/** Name of the human command registered for `/github`. */
export const COMMAND_NAME = 'github';

const COMMAND_HINT = '[list|tools|call|clone|repos|status|help]';
const COMMAND_DESCRIPTION = 'GitHub MCP：列出/调用 GitHub 工具，或下载远程仓库并注册为工作区';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });

/** Keep at most `max` lines in a clone log without copying the whole array. */
function pushCapped(lines, line, max = 200) {
  lines.push(line);
  if (lines.length > max) lines.splice(0, lines.length - max);
}

/**
 * Build the Host behaviour over injectable dependencies.
 *
 * `apply` supplies the real DSH services; the offline host tests supply fakes,
 * so every route and the whole command surface can be exercised without a
 * running Harness, a network, or a git binary.
 */
export function createGithub(deps) {
  const store = deps.store;
  const logger = deps.logger ?? { warn: () => {}, info: () => {} };
  const clock = deps.clock ?? (() => Date.now());
  const defaultCloneRoot = deps.defaultCloneRoot;
  const gitOf = deps.git;
  const mcp = deps.mcp ?? {};

  /** job id -> clone job; bounded because a page only ever watches the newest. */
  const jobs = new Map();
  let jobCounter = 0;
  let callCounter = 0;
  let lastError;

  const settingsCache = { value: undefined };
  let settingsLoad;
  let settingsWrite = Promise.resolve();

  /** Share the initial read so a late load cannot overwrite a committed patch. */
  async function settings() {
    if (settingsCache.value === undefined) {
      settingsLoad ??= Promise.resolve().then(() => store.load()).then((value) => {
        settingsCache.value = normalizeSettings(value);
      }).catch((error) => {
        settingsLoad = undefined;
        throw error;
      });
      await settingsLoad;
    }
    return settingsCache.value;
  }

  /** Serialize the entire read/merge/save/publish transaction, not just writes. */
  function saveSettings(patch) {
    const values = { ...(patch ?? {}) };
    const operation = settingsWrite.then(async () => {
      const next = normalizeSettings({ ...(await settings()), ...values });
      await store.save(next);
      settingsCache.value = next;
      return next;
    });
    // A rejected write is reported to its caller but must not poison the queue.
    settingsWrite = operation.catch(() => {});
    return operation;
  }

  /** Which token is in force, without ever returning the secret itself. */
  async function tokenInfo() {
    const current = await settings();
    const envValue = typeof deps.env?.[current.envVar] === 'string' ? deps.env[current.envVar] : undefined;
    const stored = await store.readToken();
    if (current.tokenSource === 'env') {
      return envValue !== undefined && envValue !== ''
        ? { present: true, source: 'env', envVar: current.envVar, preview: redactToken(envValue) }
        : { present: false, source: 'env', envVar: current.envVar, preview: '' };
    }
    return stored === undefined
      ? { present: false, source: 'store', envVar: current.envVar, preview: '' }
      : { present: true, source: 'store', envVar: current.envVar, preview: redactToken(stored) };
  }

  /** The token the MCP row should carry, or `undefined` when unauthenticated. */
  async function resolveToken() {
    const current = await settings();
    if (current.tokenSource === 'env') {
      const envValue = deps.env?.[current.envVar];
      return typeof envValue === 'string' && envValue !== '' ? envValue : undefined;
    }
    return store.readToken();
  }

  async function cloneRoot() {
    const current = await settings();
    return current.cloneRoot === '' ? defaultCloneRoot : current.cloneRoot;
  }

  // ---------------------------------------------------------- remote repos --
  // Cache keys are derived from the token, never the token itself, so a dump of
  // this map cannot leak a credential.

  /** page key -> `{ at, value }`; the account listing changes slowly. */
  const remotePageCache = new Map();
  /** `{ key, at, value }` for the `/user` answer. */
  let remoteAccountCache;
  const REMOTE_TTL_MS = 60_000;
  /** Search scans this many pages before reporting a truncated answer. */
  const REMOTE_SEARCH_MAX_PAGES = 5;

  const tokenKey = (token) => createHash('sha256').update(String(token)).digest('hex').slice(0, 16);

  /**
   * The repositories this token can see.
   *
   * Without a query it returns one page for an incremental list; with a query
   * it scans forward so the answer covers the whole account rather than only
   * what happened to be loaded.
   */
  async function remoteListing(request = {}) {
    const token = await resolveToken();
    if (token === undefined) {
      return { ok: false, reason: 'no-token', message: '还没有保存 GitHub 令牌，无法列出你账号下的仓库' };
    }
    const api = createGitHubApi({ token, fetchImpl: deps.fetchImpl });
    const key = tokenKey(token);
    const now = clock();

    let account;
    if (remoteAccountCache !== undefined && remoteAccountCache.key === key && now - remoteAccountCache.at < REMOTE_TTL_MS) {
      account = remoteAccountCache.value;
    } else {
      const outcome = await api.account();
      if (outcome.ok !== true) return outcome;
      account = outcome.account;
      remoteAccountCache = { key, at: now, value: account };
    }

    const query = typeof request.query === 'string' ? request.query.trim() : '';
    if (query === '') {
      const page = Number.isSafeInteger(request.page) && request.page > 0 ? request.page : 1;
      const cacheKey = `${key}:${String(page)}`;
      const cached = remotePageCache.get(cacheKey);
      if (request.refresh !== true && cached !== undefined && now - cached.at < REMOTE_TTL_MS) {
        return { ...cached.value, account, cached: true };
      }
      const outcome = await api.listRepos({ page });
      if (outcome.ok !== true) return outcome;
      const value = {
        ok: true,
        page: outcome.page,
        items: outcome.items,
        scanned: outcome.items.length,
        hasMore: outcome.hasMore,
        rateLimit: outcome.rateLimit,
      };
      remotePageCache.set(cacheKey, { at: now, value });
      return { ...value, account, cached: false };
    }

    const matched = [];
    let scanned = 0;
    let page = 1;
    let hasMore = false;
    let rateLimit = null;
    for (; page <= REMOTE_SEARCH_MAX_PAGES; page += 1) {
      const outcome = await api.listRepos({ page });
      if (outcome.ok !== true) return outcome;
      rateLimit = outcome.rateLimit ?? rateLimit;
      scanned += outcome.items.length;
      for (const repo of outcome.items) {
        if (repoMatches(repo, query)) matched.push(repo);
      }
      hasMore = outcome.hasMore;
      if (outcome.hasMore !== true || matched.length >= 50) break;
    }
    return {
      ok: true,
      account,
      query,
      page: 1,
      items: matched,
      scanned,
      hasMore,
      truncated: hasMore === true,
      rateLimit,
    };
  }

  /**
   * Check one candidate credential against GitHub, persisting nothing.
   *
   * The setup wizard's token step calls this before saving, so a mistyped or
   * expired token is reported in place instead of surfacing later as a silent
   * "no tools".
   */
  async function verifyToken(candidate) {
    const value = typeof candidate === 'string' ? candidate.trim() : '';
    if (value === '') return { ok: false, reason: 'empty-token', message: '令牌不能为空' };
    const outcome = await createGitHubApi({ token: value, fetchImpl: deps.fetchImpl }).account();
    if (outcome.ok !== true) return outcome;
    return { ok: true, account: outcome.account, rateLimit: outcome.rateLimit };
  }

  /** The MCP client row as the Loader and the plugin manager currently see it. */
  async function rowState() {
    const rowId = deps.mcpRowId;
    let rows = [];
    try {
      rows = (await mcp.listRows?.()) ?? [];
    } catch (error) {
      lastError = `读取插件行失败：${error instanceof Error ? error.message : String(error)}`;
    }
    const row = rows.find((candidate) => candidate.patchId === rowId);
    return {
      rowId,
      found: row !== undefined,
      entryId: row?.entryId,
      enabled: row?.enabled === true,
      phase: row?.phase ?? null,
    };
  }

  /** Wait until the row has settled into the requested enablement. */
  async function waitForRow(rowId, wantEnabled, timeoutMs = 12_000) {
    const deadline = clock() + timeoutMs;
    for (;;) {
      const rows = (await mcp.listRows?.()) ?? [];
      const row = rows.find((candidate) => candidate.patchId === rowId);
      if (row !== undefined && row.enabled === wantEnabled) {
        if (!wantEnabled) return true;
        if (row.phase === 'active' || row.phase === 'failed') return true;
      }
      if (clock() >= deadline) return false;
      await (deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(200);
    }
  }

  /**
   * Apply the current settings to the MCP row.
   *
   * The write is a total replacement: `configEditor.edit` persists the whole
   * config, so a stale header or a leftover stdio command can never survive a
   * transport switch.
   *
   * A disabled row has no active plugin fiber, and `configEditor.edit` refuses
   * to write to one. That is not an error the user should see: the config is
   * simply deferred until 连接 enables the row, which always writes it.
   */
  async function applyMcpConfig() {
    const current = await settings();
    const token = await resolveToken();
    const row = await rowState();
    if (row.found !== true) {
      return { ok: false, reason: 'row-missing', message: `找不到插件行 ${deps.mcpRowId}，请重新安装 dsh-github bundle` };
    }
    if (row.enabled !== true) return { ok: true, deferred: 'row-disabled' };
    const entry = mcp.entryFor?.(deps.mcpRowId);
    if (entry === undefined) {
      return { ok: false, reason: 'row-missing', message: `找不到插件行 ${deps.mcpRowId} 的配置入口` };
    }
    try {
      await mcp.edit(entry, buildMcpRowConfig(current, token));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = `写入 MCP 配置失败：${message}`;
      return { ok: false, reason: 'edit-failed', message };
    }
    return { ok: true };
  }

  /** 连接: make sure the row runs, then hand it the token. */
  async function connect() {
    const info = await tokenInfo();
    if (info.present !== true) {
      lastError = undefined;
      return {
        ok: false,
        reason: 'no-token',
        message: info.source === 'env'
          ? `环境变量 ${info.envVar} 为空，无法连接`
          : '还没有保存 GitHub 令牌，请先粘贴 Personal Access Token',
      };
    }
    const before = await rowState();
    if (before.found !== true) {
      return { ok: false, reason: 'row-missing', message: `找不到插件行 ${deps.mcpRowId}，请重新安装 dsh-github bundle` };
    }
    if (before.enabled !== true) {
      try {
        await mcp.setEnabled(before.entryId, true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastError = `启用 MCP 行失败：${message}`;
        return { ok: false, reason: 'enable-failed', message };
      }
      const settled = await waitForRow(deps.mcpRowId, true);
      if (!settled) {
        return { ok: false, reason: 'enable-timeout', message: 'MCP 连接行已启用但尚未完成加载，请稍后重试' };
      }
    }
    const applied = await applyMcpConfig();
    if (applied.ok !== true) return applied;
    lastError = undefined;
    return { ok: true };
  }

  /** 断开: stop the row. The config stays, so reconnecting is one click. */
  async function disconnect() {
    const row = await rowState();
    if (row.found !== true) {
      return { ok: false, reason: 'row-missing', message: `找不到插件行 ${deps.mcpRowId}` };
    }
    if (row.enabled === true) {
      try {
        await mcp.setEnabled(row.entryId, false);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastError = `停用 MCP 行失败：${message}`;
        return { ok: false, reason: 'disable-failed', message };
      }
      await waitForRow(deps.mcpRowId, false);
    }
    return { ok: true };
  }

  /** Every GitHub MCP tool visible to one agent scope, short-named. */
  function listTools(agent) {
    const schemas = deps.tools?.schemas?.(agent);
    const serverName = settingsCache.value?.serverName ?? 'github';
    return selectTools(Array.isArray(schemas) ? schemas : [], serverName);
  }

  function serverNameNow() {
    return settingsCache.value?.serverName ?? 'github';
  }

  /** Full wire name of a short tool name (tolerating an already-qualified one). */
  function qualifyToolName(shortOrFull) {
    const prefix = toolNamespace(serverNameNow());
    return String(shortOrFull).startsWith(prefix) ? String(shortOrFull) : `${prefix}${String(shortOrFull)}`;
  }

  /** Call one GitHub MCP tool through the ordinary tool pipeline. */
  async function callTool(options) {
    const full = qualifyToolName(options.name);
    const visible = listTools(options.agent);
    if (!visible.some((tool) => tool.name === full)) {
      return {
        ok: false,
        reason: 'unknown-tool',
        message: `工具 ${options.name} 当前不可用：请先连接，或用 /github tools 查看可用工具`,
      };
    }
    callCounter += 1;
    try {
      const result = await deps.tools.execute({
        callId: `github-call-${String(clock())}-${String(callCounter)}`,
        name: full,
        arguments: options.arguments ?? {},
        agent: options.agent,
        signal: options.signal ?? new AbortController().signal,
      });
      return { ok: true, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = `调用 ${full} 失败：${message}`;
      return { ok: false, reason: 'call-failed', message };
    }
  }

  /** Validate a clone request without touching the network. */
  async function planClone(request) {
    const parsed = parseRepoSpec(request.repo);
    if (parsed.ok !== true) return { ok: false, reason: 'bad-repo', message: parsed.reason };
    const current = await settings();
    const root = current.cloneRoot === '' ? defaultCloneRoot : current.cloneRoot;
    const requestedName = typeof request.dir === 'string' && request.dir.trim() !== ''
      ? request.dir.trim().replace(/[\\/]+$/, '')
      : parsed.repo;
    const target = cloneTarget(root, requestedName);
    if (target.ok !== true) return { ok: false, reason: 'bad-dir', message: target.reason };
    const asked = typeof request.branch === 'string' ? request.branch.trim() : '';
    const fallback = typeof request.defaultBranch === 'string' ? request.defaultBranch.trim() : '';
    const token = await resolveToken();
    // The plan is returned to the browser, so it never carries a token-bearing
    // URL: `startClone` injects the credential for the git process alone.
    return {
      ok: true,
      fullName: parsed.fullName,
      repo: parsed.repo,
      owner: parsed.owner,
      cloneUrl: parsed.cloneUrl,
      webUrl: parsed.webUrl,
      dest: target.path,
      dir: requestedName,
      root,
      branch: asked !== '' ? asked : fallback !== '' ? fallback : current.cloneBranch,
      depth: current.cloneDepth,
      private: request.private === true,
      usesToken: token !== undefined && token !== '',
    };
  }

  /** Start a confirmed clone; resolves as soon as the job is running. */
  async function startClone(request) {
    const plan = await planClone(request);
    if (plan.ok !== true) return plan;
    if (request.expected !== undefined) {
      const fields = ['fullName', 'cloneUrl', 'dest', 'branch', 'depth'];
      if (request.expected === null || typeof request.expected !== 'object'
        || fields.some((field) => request.expected[field] !== plan[field])) {
        return { ok: false, reason: 'plan-changed', message: '下载目标、分支或深度已改变，请重新生成计划并确认。' };
      }
    }
    jobCounter += 1;
    const job = {
      id: `clone-${String(clock())}-${String(jobCounter)}`,
      repo: plan.fullName,
      url: plan.cloneUrl,
      dest: plan.dest,
      branch: plan.branch,
      depth: plan.depth,
      state: 'running',
      code: null,
      log: [],
      startedAt: clock(),
      endedAt: null,
      workspace: null,
    };
    jobs.set(job.id, job);
    // Keep the job table small: a page only ever watches the newest few.
    if (jobs.size > 12) {
      const oldest = [...jobs.values()].sort((left, right) => left.startedAt - right.startedAt)[0];
      if (oldest !== undefined && oldest.state !== 'running') jobs.delete(oldest.id);
    }

    const runner = await gitOf();
    const token = await resolveToken();
    // A token in the clone URL is what makes a private repository work
    // non-interactively; it is scrubbed from every log line and from the
    // clone's `origin` as soon as the download succeeds.
    const gitUrl = token === undefined || token === '' ? plan.cloneUrl : authenticatedCloneUrl(plan.cloneUrl, token);
    const authenticated = gitUrl !== plan.cloneUrl;
    job.authenticated = authenticated;
    const scrub = (line) => scrubToken(line, token);
    const note = (line) => pushCapped(job.log, scrub(line));
    if (authenticated) note('使用访问令牌下载；完成后会把 origin 还原为不含令牌的地址。');

    void runner.clone({
      url: gitUrl,
      dest: plan.dest,
      branch: plan.branch,
      depth: plan.depth,
    }, note).then(async (outcome) => {
      job.code = outcome.code;
      job.endedAt = clock();
      if (outcome.code !== 0) {
        job.state = 'failed';
        lastError = `下载 ${plan.fullName} 失败：git 退出码 ${String(outcome.code)}`;
        return;
      }
      if (authenticated) {
        const scrubbed = await runner.setRemoteUrl?.(plan.dest, plan.cloneUrl, note);
        if (scrubbed !== undefined && scrubbed.code !== 0) {
          note(`警告：origin 还原失败（git 退出码 ${String(scrubbed.code)}），请手动执行 git remote set-url origin ${plan.cloneUrl}`);
        }
      }
      // Register the workspace BEFORE the job reads as done: a page that sees
      // `done` must already be able to show the workspace outcome.
      const registry = deps.workspaceRegistry;
      if (registry === undefined || typeof registry.create !== 'function') {
        job.workspace = { created: false, reason: 'workspaceRegistry 服务不可用' };
      } else {
        try {
          const created = await registry.create(plan.dest, plan.repo);
          job.workspace = { created: true, id: created?.id };
        } catch (error) {
          job.workspace = { created: false, reason: error instanceof Error ? error.message : String(error) };
        }
      }
      job.state = 'done';
    }).catch((error) => {
      job.state = 'failed';
      job.code = -1;
      job.endedAt = clock();
      pushCapped(job.log, error instanceof Error ? error.message : String(error));
    });

    return { ok: true, job: publicJob(job) };
  }

  /** Job view for the browser: the tail of the log, never the whole history. */
  function publicJob(job) {
    return {
      id: job.id,
      repo: job.repo,
      url: job.url,
      dest: job.dest,
      branch: job.branch,
      depth: job.depth,
      state: job.state,
      code: job.code,
      authenticated: job.authenticated === true,
      workspace: job.workspace,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      log: job.log.slice(-40),
    };
  }

  async function cloneJob(id) {
    const job = jobs.get(id);
    if (job === undefined) return { ok: false, reason: 'unknown-job', message: `没有编号为 ${String(id)} 的下载任务` };
    return { ok: true, job: publicJob(job) };
  }

  /**
   * Every git working copy under the clone root, each annotated with the DSH
   * workspace that owns its directory (when one does).
   *
   * `workspaceId` is what lets the page offer "打开" — the Browser half can only
   * navigate through `uiWorkspace.openWorkspace(id)`, and it has no service that
   * maps a path to a workspace id. The lookup is read-only (`resolveByPath` never
   * creates a registration) and best-effort: a path that the registry does not
   * know, or a host generation whose registry has no such method, simply yields
   * rows without the field, and the page falls back to showing the path alone.
   */
  async function listRepos() {
    let repos;
    try {
      repos = await (deps.listClones ?? listClones)(await cloneRoot());
    } catch (error) {
      lastError = `读取下载目录失败：${error instanceof Error ? error.message : String(error)}`;
      return [];
    }
    const registry = deps.workspaceRegistry;
    if (registry === undefined || typeof registry.resolveByPath !== 'function') return repos;
    return Promise.all(repos.map(async (repo) => {
      try {
        const entity = await registry.resolveByPath(repo.path);
        const id = entity?.id;
        return typeof id === 'string' && id !== '' ? { ...repo, workspaceId: id } : repo;
      } catch {
        return repo;
      }
    }));
  }

  /** What the composer's `/` menu will show, straight from the command registry. */
  async function commandInfo(agent) {
    let descriptors;
    try {
      descriptors = typeof deps.commands?.list === 'function' ? await deps.commands.list(agent) : undefined;
    } catch {
      descriptors = undefined;
    }
    const rows = Array.isArray(descriptors) ? descriptors : [];
    return {
      name: COMMAND_NAME,
      hint: COMMAND_HINT,
      description: COMMAND_DESCRIPTION,
      listed: rows.some((row) => row?.name === COMMAND_NAME),
      catalog: rows.map((row) => ({ name: row?.name, description: row?.description, hint: row?.input?.hint })),
    };
  }

  let gitVersionCache;
  async function gitInfo() {
    if (gitVersionCache === undefined) {
      try {
        gitVersionCache = await (await gitOf()).version();
      } catch (error) {
        gitVersionCache = { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    }
    return gitVersionCache;
  }

  /** The one payload the Settings page renders. */
  async function status(agent) {
    const current = await settings();
    const token = await tokenInfo();
    const row = await rowState();
    const tools = listTools(agent);
    const root = await cloneRoot();
    const repos = await listRepos();
    const git = await gitInfo();
    return {
      settings: current,
      token,
      mcp: {
        rowId: row.rowId,
        found: row.found,
        enabled: row.enabled,
        phase: row.phase,
        serverName: current.serverName,
        transport: current.transport,
        endpoint: describeTransport(current),
        toolCount: tools.length,
        tokenPresent: token.present,
      },
      tools: tools.map((tool) => ({
        name: tool.name,
        shortName: tool.shortName,
        description: tool.description,
        parameters: tool.parameters,
      })),
      repos,
      cloneRoot: root,
      git,
      command: await commandInfo(agent),
      storeDir: store.dir,
      settingsPath: store.settingsPath,
      lastError: lastError ?? null,
      generatedAt: clock(),
    };
  }

  /** Resolve the agent a request should be attributed to. */
  function anyAgent() {
    try {
      const list = deps.agents?.list?.();
      return Array.isArray(list) && list.length > 0 ? list[0] : undefined;
    } catch {
      return undefined;
    }
  }

  async function readJson(request) {
    try {
      const body = await request.json();
      return body !== null && typeof body === 'object' ? body : {};
    } catch {
      return {};
    }
  }

  /** Handle one route; every failure is a JSON body, never a thrown error. */
  async function handleRoute(route, request) {
    const agent = anyAgent();
    try {
      if (route === ROUTES.status) return json(await status(agent));

      if (route === ROUTES.settings) {
        if (request.method === 'POST') {
          const body = await readJson(request);
          await saveSettings(body.settings ?? body);
          const applied = await applyMcpConfig();
          return json({ ok: applied.ok === true, applied, status: await status(agent) });
        }
        return json({ ok: true, settings: await settings() });
      }

      if (route === ROUTES.token) {
        const body = await readJson(request);
        if (body.clear === true) {
          await store.clearToken();
          const applied = await applyMcpConfig();
          return json({ ok: applied.ok === true, applied, status: await status(agent) });
        }
        const candidate = typeof body.token === 'string' ? body.token.trim() : '';
        // `verify: true` checks the credential against GitHub FIRST and only
        // then persists it; a rejected token changes nothing.
        if (body.verify === true) {
          const checked = candidate === '' ? await resolveToken() : candidate;
          if (checked === undefined) {
            return json({ ok: false, reason: 'no-token', message: '还没有可校验的令牌：粘贴一个，或先把环境变量设好' }, 400);
          }
          const outcome = await verifyToken(checked);
          if (outcome.ok !== true) return json({ ...outcome, status: await status(agent) }, 400);
          if (candidate !== '') {
            await store.writeToken(candidate);
            // A stored token always wins over the environment: the user just typed it.
            await saveSettings({ tokenSource: 'store' });
          }
          const applied = await applyMcpConfig();
          return json({
            ok: applied.ok === true,
            verified: true,
            account: outcome.account,
            applied,
            status: await status(agent),
          });
        }
        if (candidate !== '') {
          await store.writeToken(candidate);
          await saveSettings({ tokenSource: 'store' });
        }
        const applied = await applyMcpConfig();
        return json({ ok: applied.ok === true, applied, status: await status(agent) });
      }

      if (route === ROUTES.connection) {
        const body = await readJson(request);
        const action = body.action === 'disconnect' ? 'disconnect' : 'connect';
        const outcome = action === 'disconnect' ? await disconnect() : await connect();
        return json({ ...outcome, action, status: await status(agent) });
      }

      if (route === ROUTES.remote) {
        const url = new URL(request.url);
        const pageText = url.searchParams.get('page');
        const outcome = await remoteListing({
          page: pageText === null ? 1 : Number.parseInt(pageText, 10),
          query: url.searchParams.get('q') ?? '',
          refresh: url.searchParams.get('refresh') === '1',
        });
        return json(outcome, outcome.ok === true ? 200 : outcome.reason === 'no-token' ? 409 : 502);
      }

      if (route === ROUTES.call) {
        const body = await readJson(request);
        if (typeof body.name !== 'string' || body.name === '') {
          return json({ ok: false, reason: 'bad-request', message: '缺少工具名 name' }, 400);
        }
        const args = body.arguments !== undefined
          ? { ok: true, value: body.arguments }
          : parseToolArguments(body.argumentsText ?? '');
        if (args.ok !== true) return json({ ok: false, reason: 'bad-arguments', message: args.reason }, 400);
        const outcome = await callTool({ name: body.name, arguments: args.value, agent });
        if (outcome.ok !== true) return json(outcome, outcome.reason === 'unknown-tool' ? 409 : 500);
        return json({
          ok: true,
          text: formatCallResult(body.name, outcome.result),
          isError: outcome.result?.isError === true,
          content: outcome.result?.content,
          value: outcome.result?.value,
        });
      }

      if (route === ROUTES.clone) {
        if (request.method === 'POST') {
          const body = await readJson(request);
          if (body.confirm !== true) {
            const plan = await planClone(body);
            if (plan.ok !== true) return json(plan, 400);
            return json({ ok: true, needsConfirm: true, plan, text: formatClonePlan(plan) });
          }
          if (body.expected === undefined) {
            return json({ ok: false, reason: 'confirmation-required', message: '请先生成下载计划，再确认其目标和深度。' }, 409);
          }
          const started = await startClone(body);
          if (started.ok !== true) return json(started, started.reason === 'plan-changed' ? 409 : 400);
          return json({ ok: true, needsConfirm: false, job: started.job, text: formatCloneResult({ ...started.job, state: 'running' }) });
        }
        const id = new URL(request.url).searchParams.get('id');
        if (id === null || id === '') {
          return json({ ok: true, repos: await listRepos(), cloneRoot: await cloneRoot() });
        }
        const outcome = await cloneJob(id);
        return json({ ...outcome, text: outcome.ok === true ? formatCloneResult(outcome.job) : outcome.message }, outcome.ok === true ? 200 : 404);
      }

      return json({ ok: false, reason: 'unknown-route', message: route }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = message;
      logger.warn?.('dsh-github: route %s failed: %s', route, message);
      return json({ ok: false, reason: 'internal', message }, 500);
    }
  }

  /** The `/github` command handler: a text answer for every branch. */
  async function handleCommand(invocation) {
    const agent = invocation?.agent;
    try {
      const current = await settings();
      const tools = listTools(agent);
      const parsed = parseCommandInput(invocation?.rawInput ?? '', tools.map((tool) => tool.shortName));

      if (parsed.action === 'unknown') return { kind: 'error', text: parsed.error };

      if (parsed.action === 'help') return { kind: 'success', text: formatHelp(current) };

      if (parsed.action === 'status') {
        const info = await tokenInfo();
        const row = await rowState();
        return {
          kind: 'success',
          text: formatStatus({
            settings: current,
            token: info,
            mcp: { ...row, toolCount: tools.length, lastError },
            cloneRoot: await cloneRoot(),
            repos: await listRepos(),
          }),
        };
      }

      if (parsed.action === 'repos') {
        const repos = await listRepos();
        if (repos.length === 0) return { kind: 'success', text: `还没有下载任何仓库。用 /github clone <owner/repo> 开始，目录：${await cloneRoot()}` };
        return {
          kind: 'success',
          text: repos.map((repo) => `• ${repo.name} — ${repo.remote ?? '(无 origin)'}${repo.branch === undefined ? '' : ` @${repo.branch}`}\n  ${repo.path}`).join('\n'),
        };
      }

      if (parsed.action === 'remote') {
        const query = parsed.args.join(' ').trim();
        const listing = await remoteListing({ query, page: 1 });
        if (listing.ok !== true) return { kind: 'error', text: listing.message };
        return { kind: 'success', text: formatRemoteRepos(listing) };
      }

      if (parsed.action === 'tools') {
        const query = parsed.args.join(' ').trim();
        const exact = query === '' ? undefined : tools.find((tool) => tool.shortName === query);
        if (exact !== undefined) return { kind: 'success', text: formatToolDetail(exact) };
        const matched = query === '' ? tools : selectTools(deps.tools?.schemas?.(agent) ?? [], current.serverName, query);
        return { kind: 'success', text: formatToolList(matched, query) };
      }

      if (parsed.action === 'call') {
        if (parsed.target === '') {
          return { kind: 'error', text: '用法：/github call <工具名> [JSON 参数]，用 /github tools 查看可用工具' };
        }
        const args = parseToolArguments(parsed.argumentText);
        if (args.ok !== true) return { kind: 'error', text: args.reason };
        const outcome = await callTool({ name: parsed.target, arguments: args.value, agent, signal: invocation?.signal });
        if (outcome.ok !== true) return { kind: 'error', text: outcome.message };
        return { kind: 'success', text: formatCallResult(parsed.target, outcome.result) };
      }

      if (parsed.action === 'clone') {
        const options = parseCloneOptions(parsed.args);
        if (options.repoToken === '') {
          return { kind: 'error', text: '用法：/github clone <owner/repo> [--branch b] [--dir 目录] [--yes]' };
        }
        const plan = await planClone({ repo: options.repoToken, branch: options.branch, dir: options.dir });
        if (plan.ok !== true) return { kind: 'error', text: plan.message };
        const confirmed = parsed.args.includes('--yes') || parsed.args.includes('-y');
        if (!confirmed) {
          return { kind: 'success', text: `${formatClonePlan(plan)}\n\n确认下载请执行：/github clone ${plan.fullName} --yes` };
        }
        const started = await startClone({ repo: options.repoToken, branch: options.branch, dir: options.dir, expected: plan });
        if (started.ok !== true) return { kind: 'error', text: started.message };
        const settled = await waitForJob(started.job.id, invocation?.signal);
        return { kind: settled.state === 'failed' ? 'error' : 'success', text: formatCloneResult(settled) };
      }

      // Default: the catalog, which is the answer to a bare `/github `.
      const info = await tokenInfo();
      const row = await rowState();
      return {
        kind: 'success',
        text: formatCatalog({
          tools,
          settings: current,
          mcp: { ...row, tokenPresent: info.present },
          cloneRoot: await cloneRoot(),
        }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = message;
      logger.warn?.('dsh-github: command failed: %s', message);
      return { kind: 'error', text: `/github 执行失败：${message}` };
    }
  }

  /** Block a command invocation until its clone settles (bounded). */
  async function waitForJob(id, signal, timeoutMs = 600_000) {
    const deadline = clock() + timeoutMs;
    for (;;) {
      const job = jobs.get(id);
      if (job === undefined) return { state: 'failed', repo: id, dest: '', log: '任务已丢失', code: -1 };
      if (job.state !== 'running') return publicJob(job);
      if (signal?.aborted === true) return { ...publicJob(job), state: 'failed', log: `${job.log.join('\n')}\n(已取消等待；下载可能仍在后台继续)` };
      if (clock() >= deadline) return { ...publicJob(job), state: 'failed', log: `${job.log.join('\n')}\n(等待超时)` };
      await (deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(400);
    }
  }

  return {
    settings,
    saveSettings,
    tokenInfo,
    resolveToken,
    cloneRoot,
    rowState,
    applyMcpConfig,
    connect,
    disconnect,
    listTools,
    callTool,
    planClone,
    startClone,
    cloneJob,
    listRepos,
    status,
    handleRoute,
    handleCommand,
    commandDefinition: () => ({
      name: COMMAND_NAME,
      description: COMMAND_DESCRIPTION,
      input: { hint: COMMAND_HINT },
      handler: handleCommand,
    }),
    contentToText,
  };
}

/**
 * Mount the plugin: wire the real DSH services into `createGithub`.
 *
 * @param ctx - the plugin's Cordis context.
 * @param config - optional `{ serverName, mcpRowId, workspaceRoot, gitBinary, debugDumpPath }`.
 */
export function apply(ctx, config = {}) {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const store = createStore({ dir: join(defaultStoreDir(dshHome)) });
  const mcpRowId = typeof config.mcpRowId === 'string' && config.mcpRowId !== '' ? config.mcpRowId : 'github-mcp';
  const serverName = typeof config.serverName === 'string' && config.serverName !== '' ? config.serverName : 'github';
  const defaultCloneRoot = typeof config.workspaceRoot === 'string' && config.workspaceRoot !== ''
    ? config.workspaceRoot
    : join(dshHome, 'github-repos');

  let runner;
  const gitOf = async () => {
    if (runner !== undefined) return runner;
    let binary = typeof config.gitBinary === 'string' && config.gitBinary !== '' ? config.gitBinary : undefined;
    if (binary === undefined) {
      try {
        const resolved = await ctx.get('subprocess')?.resolveExecutable?.('git');
        if (typeof resolved === 'string' && resolved !== '') binary = resolved;
      } catch { /* fall back to PATH */ }
    }
    runner = createGitRunner({ binary: binary ?? 'git' });
    return runner;
  };

  const mcp = {
    listRows: async () => {
      const plugins = await ctx.get('pluginManager')?.listPlugins?.();
      return (Array.isArray(plugins) ? plugins : []).map((plugin) => ({
        patchId: plugin.patchId,
        entryId: plugin.entryId,
        enabled: plugin.enabled === true,
        phase: plugin.fiberPhase ?? null,
      }));
    },
    entryFor: (rowId) => (ctx.get('configEditor')?.entries?.() ?? [])
      .find((entry) => entry?.options?.id === rowId),
    setEnabled: async (entryId, enabled) => ctx.get('pluginManager')?.setPluginEnabled?.(entryId, enabled),
    edit: async (entry, next) => ctx.get('configEditor')?.edit(entry, () => next),
  };

  // The server name is a stored setting; seed the cache so the very first
  // command and the first status poll already use the configured namespace.
  const github = createGithub({
    store,
    mcp,
    mcpRowId,
    defaultCloneRoot,
    git: gitOf,
    env: process.env,
    fetchImpl: config.fetchImpl ?? globalThis.fetch,
    logger: ctx.logger,
    agents: { list: () => ctx.get('agents')?.list?.() ?? [] },
    tools: {
      schemas: (agent) => ctx.get('tools')?.schemas?.(agent) ?? [],
      execute: (input) => ctx.get('tools')?.execute?.(input),
    },
    commands: { list: (agent) => ctx.get('commands')?.list?.(agent) ?? [] },
    // Read optional services at use time, not once at plugin mount: a service
    // may arrive later, be disabled, or be replaced without remounting this API.
    get workspaceRegistry() { return ctx.get('workspaceRegistry'); },
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  });

  // Seed the settings cache from disk so `serverName` is right immediately.
  void github.settings().then(async (current) => {
    if (current.serverName !== serverName) await github.saveSettings({ serverName });
  }).catch(() => {});

  for (const route of Object.values(ROUTES)) {
    ctx.effect(() => {
      const dispose = ctx.connection.fetch.register({
        path: route,
        methods: ['GET', 'HEAD', 'POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          if (request.method === 'HEAD') return new Response(null, { status: 200, headers: JSON_HEADERS });
          return github.handleRoute(route, request);
        },
      });
      return () => dispose();
    }, `dsh-github: route ${route}`);
  }

  const mountCommand = (scope) => scope.effect(() => {
    const commands = scope.get('commands');
    if (typeof commands?.register !== 'function') return () => {};
    const dispose = commands.register(github.commandDefinition());
    return () => dispose();
  }, 'dsh-github: /github command');
  // The command is optional. Its child fiber follows the registry's lifetime
  // without withdrawing the settings/HTTP API when commands is unavailable.
  if (typeof ctx.inject === 'function') ctx.inject(['commands'], mountCommand);
  else mountCommand(ctx); // Small embedders/offline contexts without child fibers.

  const debugDumpPath = typeof config.debugDumpPath === 'string' && config.debugDumpPath !== ''
    ? config.debugDumpPath
    : undefined;
  if (debugDumpPath !== undefined) {
    ctx.effect(() => {
      let dumped = false;
      void (async () => {
        if (dumped) return;
        dumped = true;
        try {
          const port = ctx.get('webServer')?.port;
          const url = typeof port === 'number'
            ? ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(port)}/`)
            : null;
          const snapshot = await github.status(undefined);
          writeFileSync(debugDumpPath, JSON.stringify({ url, storeDir: store.dir, snapshot }, null, 2), 'utf8');
        } catch (error) {
          try {
            writeFileSync(debugDumpPath, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2), 'utf8');
          } catch { /* the dump is best-effort */ }
        }
      })();
      return () => {};
    }, 'dsh-github: debug dump');
  }

  ctx.logger?.info?.('dsh-github host ready: routes %s, command /%s', Object.values(ROUTES).join(', '), COMMAND_NAME);
}

export default { name, inject, apply };
