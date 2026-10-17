/**
 * dsh-mcp-skills — Host half.
 *
 * One Settings page's worth of data and actions, split in two:
 *
 *   MCP 服务器   read from the shipped plugin manager (`pluginManager`) and the
 *                config editor (`configEditor`), so rows are exactly the ones
 *                the Loader is running — never a second, hand-parsed copy of
 *                cordis.patch.yml. Enabling/disabling goes through
 *                `pluginManager.setPluginEnabled`, and config edits through
 *                `configEditor.edit`.
 *
 *   技能库        read from the shipped skills registry (`skills`). Summaries
 *                come from `skills.list`, bodies from `skills.get`. The
 *                model-invocation toggle rewrites the skill's own frontmatter
 *                flag, because the registry is invocation-neutral by design.
 *
 *   Token cost    every MCP row also carries what its tool schemas cost in the
 *                model's context (`toolTokens`), priced with the same formulas
 *                the context-window panel uses (`./estimate.js`, kept equal by
 *                `tools/host-test.mjs`). The number is a heuristic —
 *                it is the panel's `~` arithmetic, not a provider's billing
 *                token count.
 *
 *   Ownership     `ROW_OWNERS` names the rows another bundle owns. A row written
 *                by a sibling plugin (today: `github-mcp`, owned by dsh-github)
 *                is labelled in the page and needs an explicit second click
 *                before its config is saved, because that row's config is the
 *                other plugin's write target. This is a static map on purpose:
 *                the point of this plugin is that it never parses
 *                cordis.patch.yml by hand.
 *
 * Everything is served as exact Fetch routes on the authenticated `/api`
 * channel (`ctx.connection.fetch.register`). That is deliberate: a private RPC
 * channel registered with `connection.rpc.handle()` mounts its route through the
 * *calling plugin's* `ctx.webServer`, which throws "cannot get property
 * \"webServer\" without inject" from a plugin that does not inject it — leaving
 * the page polling a channel that was never registered.
 *
 * Secrets never cross to the browser: header/credential values are replaced with
 * a `"***"` placeholder, and a save restores any placeholder from the stored
 * config, so a token can be edited around but never read back.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { estimateToolsTokens } from './estimate.js';

/** Cordis plugin name; must equal the package name the profile loads. */
export const name = 'dsh-mcp-skills';

/** `connection` owns the authenticated `/api` channel these routes hang on. */
export const inject = ['connection'];

/**
 * Rows another bundle owns and writes.
 *
 * The page still lists them (they are real, running rows) but labels them and
 * asks for a second confirmation before saving, so a config this plugin did not
 * author is never overwritten by one stray click.
 */
export const ROW_OWNERS = {
  'github-mcp': 'dsh-github',
};

/** Exact Fetch routes behind the Settings page. */
export const ROUTES = {
  status: '/api/mcpskills.status',
  mcpToggle: '/api/mcpskills.mcp.toggle',
  mcpConfig: '/api/mcpskills.mcp.config',
  skillGet: '/api/mcpskills.skill',
  skillToggle: '/api/mcpskills.skill.toggle',
};

/** Placeholder that stands in for a stored secret in browser-bound payloads. */
export const REDACTED = '***';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });

/** Credential fields include namespaced env variables and custom HTTP headers. */
const SECRET_KEY = /(?:^|-)(authorization|cookie|set-cookie|api-?key|key|token|secret|password|passwd|bearer|credential|credentials|pat)$/i;

function isSecretKey(key) {
  const normalized = String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase();
  return SECRET_KEY.test(normalized);
}

/** A display-only URL: neither userinfo nor credential query values survive. */
function redactUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  let changed = false;
  if (url.username !== '' || url.password !== '') {
    if (url.username !== '') url.username = REDACTED;
    if (url.password !== '') url.password = REDACTED;
    changed = true;
  }
  for (const key of new Set(url.searchParams.keys())) {
    if (!isSecretKey(key)) continue;
    url.searchParams.set(key, REDACTED);
    changed = true;
  }
  return changed ? url.toString() : value;
}

/** A whole masked scalar is restorable without exposing part of a credential. */
function redactArgument(value) {
  if (typeof value !== 'string') return value;
  const assignment = /^--?([^=]+)=(.*)$/s.exec(value) ?? /^([^=\s]+)=(.*)$/s.exec(value);
  if (assignment !== null && isSecretKey(assignment[1])) return REDACTED;
  const content = assignment === null ? value : assignment[2];
  const header = /^\s*([^:\s]+)\s*:/.exec(content);
  if (header !== null && isSecretKey(header[1])) return REDACTED;
  return redactUrl(content) !== content ? REDACTED : value;
}

/** Mask both `--token=value` and `--token value`, including docker env/header args. */
function redactArguments(values) {
  return values.map((value, index) => {
    const previous = index === 0 ? undefined : values[index - 1];
    if (typeof previous === 'string' && /^--?[^=]+$/.test(previous) && isSecretKey(previous.replace(/^-+/, ''))) {
      return REDACTED;
    }
    return redactArgument(value);
  });
}

/** Call a possibly-absent service method, treating any throw as "no value". */
function attempt(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** Await a possibly-absent service method, treating any throw as "no value". */
async function attemptAsync(fn) {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

/** Array-or-empty, for service results that may be undefined or malformed. */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** A row is an MCP server when its config carries the MCP client's shape. */
export function isMcpConfig(config) {
  return (
    config !== null
    && typeof config === 'object'
    && typeof config.serverName === 'string'
    && config.serverName !== ''
    && (typeof config.transport === 'string' || typeof config.url === 'string' || typeof config.command === 'string')
  );
}

/** Deep copy with credential fields, credential URLs, and secret argv masked. */
export function redactSecrets(value, keyHint = '') {
  if (typeof value === 'string') {
    return isSecretKey(keyHint) || redactUrl(value) !== value ? REDACTED : value;
  }
  if (Array.isArray(value)) {
    const items = keyHint === 'args' ? redactArguments(value) : value;
    return items.map((item) => redactSecrets(item, keyHint));
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = redactSecrets(child, key);
    return out;
  }
  return value;
}

/**
 * Put the stored secret values back under every `"***"` placeholder.
 *
 * The browser only ever sees placeholders, so a saved config keeps working
 * without the page having to hold the credential.
 */
export function restoreSecrets(stored, incoming) {
  const masked = redactSecrets(stored);
  const restore = (current, next, placeholder) => {
    // Only a value the read route actually masked is a keep-secret sentinel.
    // Ordinary fields can still be deliberately edited to the literal "***".
    if (next === REDACTED && placeholder === REDACTED) return current;
    if (Array.isArray(next)) {
      const values = Array.isArray(current) ? current : [];
      const placeholders = Array.isArray(placeholder) ? placeholder : [];
      return next.map((item, index) => restore(values[index], item, placeholders[index]));
    }
    if (next !== null && typeof next === 'object') {
      const values = current !== null && typeof current === 'object' && !Array.isArray(current) ? current : {};
      const placeholders = placeholder !== null && typeof placeholder === 'object' ? placeholder : {};
      const out = {};
      for (const [key, child] of Object.entries(next)) out[key] = restore(values[key], child, placeholders[key]);
      return out;
    }
    return next;
  };
  return restore(stored, incoming, masked);
}

/** A one-line description of where an MCP server lives. */
export function describeEndpoint(config) {
  if (config.transport === 'stdio') {
    const args = redactArguments(asArray(config.args)).map((arg) => String(arg)).join(' ');
    const command = typeof config.command === 'string' ? redactArgument(config.command) : config.command;
    return [command, args].filter((part) => part !== undefined && part !== '').join(' ') || '(未设置 command)';
  }
  return typeof config.url === 'string' && config.url !== '' ? redactUrl(config.url) : '(未设置 url)';
}

/**
 * What one tool schema costs in context, in the context panel's own arithmetic.
 *
 * Priced as a one-element list (`estimateToolsTokens([schema])`) rather than as
 * a bare object, because that is the call the panel makes per tool — the array
 * brackets are part of the estimate, so this is what makes the two numbers
 * comparable instead of merely close.
 *
 * @param schema - one tool schema from the tools service.
 * @returns heuristic tokens; 0 for a schema that cannot be serialized.
 */
export function toolTokensFor(schema) {
  try {
    return estimateToolsTokens([schema]);
  } catch {
    return 0;
  }
}

/**
 * The project directory a workspace-sensitive skill lookup should use.
 *
 * Only an explicit source counts: the profile row's `cwd` config, then
 * `DSH_WORKSPACE`. Guessing from the registered-workspace list is deliberately
 * avoided — it can point at an unrelated clone directory, and a wrong project
 * root silently hides or invents project skills.
 */
export function resolveCwd(_ctx, configured) {
  if (typeof configured === 'string' && configured !== '') return configured;
  const fromEnv = process.env.DSH_WORKSPACE ?? process.env.DSH_PROJECT_DIR;
  return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : undefined;
}

/** The agent a request should be attributed to (tool schemas are per-agent). */
export function resolveAgent(ctx) {
  return attempt(() => {
    const list = asArray(ctx.get('agents')?.list?.());
    return list[0];
  });
}

/**
 * Build the behaviour over injectable dependencies, so the whole surface can be
 * exercised in tests without a running Harness.
 */
export function createMcpSkills(deps) {
  const ctx = deps.ctx;
  const logger = deps.logger ?? { warn: () => {} };
  const configuredCwd = deps.cwd;
  let lastError;

  /** `listPlugins` is a remote (async) read; a sync call would yield a Promise. */
  const listPlugins = async () => asArray(await attemptAsync(() => ctx.get('pluginManager')?.listPlugins?.()));
  const configEntries = () => asArray(attempt(() => ctx.get('configEditor')?.entries?.()));
  const toolSchemas = (agent) => asArray(attempt(() => ctx.get('tools')?.schemas?.(agent)));

  /**
   * Effective config for every addressable profile row, keyed by patch id.
   *
   * `configEditor.configuration()` is the authoritative view — it carries the
   * Loader entry together with its inherited layer and the profile override,
   * which `entry.options.config` alone does not. Falling back to `entries()`
   * keeps rows visible on hosts that only expose the older accessor.
   */
  function rowConfigs() {
    const map = new Map();
    for (const row of asArray(attempt(() => ctx.get('configEditor')?.configuration?.()))) {
      const entry = row?.entry;
      const id = entry?.options?.id ?? entry?.id;
      if (typeof id !== 'string') continue;
      map.set(id, { entry, config: { ...(row?.inherited ?? {}), ...(row?.override ?? {}) } });
    }
    for (const entry of configEntries()) {
      const id = entry?.options?.id ?? entry?.id;
      if (typeof id !== 'string' || map.has(id)) continue;
      map.set(id, { entry, config: entry?.options?.config ?? {} });
    }
    return map;
  }

  /** Every MCP server row the Loader currently knows about. */
  async function mcpRows(agent) {
    const configs = rowConfigs();
    const rows = [];
    const schemas = toolSchemas(agent);
    for (const plugin of await listPlugins()) {
      const patchId = plugin?.patchId ?? plugin?.id;
      if (typeof patchId !== 'string') continue;
      const found = configs.get(patchId);
      const config = found?.config ?? plugin?.config;
      if (!isMcpConfig(config)) continue;
      const prefix = 'mcp__' + config.serverName + '__';
      const matched = schemas
        .filter((schema) => typeof schema?.name === 'string' && schema.name.startsWith(prefix));
      const tools = matched.map((schema) => ({
        name: schema.name.slice(prefix.length),
        fullName: schema.name,
        description: typeof schema.description === 'string' ? schema.description : '',
      }));
      rows.push({
        patchId,
        entryId: plugin?.entryId ?? found?.entry?.options?.id ?? null,
        enabled: plugin?.enabled === true,
        phase: plugin?.fiberPhase ?? plugin?.phase ?? null,
        error: attempt(() => plugin?.fiberError?.message) ?? null,
        serverName: config.serverName,
        transport: typeof config.transport === 'string' ? config.transport : '(默认)',
        endpoint: describeEndpoint(config),
        toolCount: tools.length,
        // One-element list per tool, exactly how the context panel prices one:
        // `estimateToolsTokens([tool])`. Summing these reproduces that panel's
        // per-server number without importing its module.
        toolTokens: matched.reduce((sum, schema) => sum + toolTokensFor(schema), 0),
        tools,
        // Another bundle's write target, or null for a row this profile owns.
        owner: typeof ROW_OWNERS[patchId] === 'string' ? ROW_OWNERS[patchId] : null,
        editable: found?.entry !== undefined,
      });
    }
    rows.sort((left, right) => left.serverName.localeCompare(right.serverName));
    return rows;
  }

  /** Every skill the registry currently serves, newest policy included. */
  async function skillsPayload() {
    const registry = ctx.get('skills');
    if (registry === undefined || typeof registry.list !== 'function') {
      return { items: [], error: 'skills 服务不可用：当前 DSH 未挂载技能注册表' };
    }
    const cwd = resolveCwd(ctx, configuredCwd);
    const options = cwd === undefined ? {} : { cwd };
    try {
      const summaries = asArray(await registry.list(options));
      const items = summaries.map((entry) => ({
        name: String(entry?.name ?? ''),
        description: String(entry?.description ?? ''),
        whenToUse: typeof entry?.whenToUse === 'string' ? entry.whenToUse : '',
        source: String(entry?.source ?? '未知'),
        provider: String(entry?.provider ?? ''),
        modelInvocable: entry?.invocation?.modelInvocable === true,
        userInvocable: entry?.invocation?.userInvocable === true,
        path: typeof entry?.path === 'string' ? entry.path : null,
        resourceKind: typeof entry?.resourceBase?.kind === 'string' ? entry.resourceBase.kind : null,
      })).filter((item) => item.name !== '');
      items.sort((left, right) => left.name.localeCompare(right.name));
      return { items, cwd: cwd ?? null, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = `读取技能库失败：${message}`;
      return { items: [], cwd: cwd ?? null, error: message };
    }
  }

  /** One skill's full body. */
  async function skillBody(skillName) {
    const registry = ctx.get('skills');
    if (registry === undefined || typeof registry.get !== 'function') {
      return { ok: false, reason: 'unavailable', message: 'skills 服务不可用' };
    }
    const cwd = resolveCwd(ctx, configuredCwd);
    const options = cwd === undefined ? {} : { cwd };
    try {
      const definition = await registry.get(skillName, options);
      if (definition === undefined || definition === null) {
        return { ok: false, reason: 'not-found', message: `找不到技能 ${skillName}` };
      }
      return {
        ok: true,
        skill: {
          name: String(definition.name ?? skillName),
          description: String(definition.description ?? ''),
          whenToUse: typeof definition.whenToUse === 'string' ? definition.whenToUse : '',
          source: String(definition.source ?? ''),
          provider: String(definition.provider ?? ''),
          content: typeof definition.content === 'string' ? definition.content : '',
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = `读取技能 ${skillName} 失败：${message}`;
      return { ok: false, reason: 'failed', message };
    }
  }

  /**
   * Flip a file-backed skill's model-invocation flag.
   *
   * The skills registry is invocation-neutral, so the only durable switch is the
   * skill's own frontmatter. The edit is line-based to stay dependency-free: an
   * existing `disable-model-invocation` line is rewritten, otherwise one is
   * appended to the frontmatter block.
   */
  function setModelInvocable(path, modelInvocable) {
    if (typeof path !== 'string' || path === '') throw new Error('该技能没有本地文件，无法修改');
    if (!/SKILL\.md$/i.test(path)) throw new Error('只支持修改 SKILL.md');
    const text = readFileSync(path, 'utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (match === null) throw new Error('SKILL.md 没有 frontmatter，无法修改');
    const key = 'disable-model-invocation';
    const wanted = modelInvocable ? 'false' : 'true';
    const linePattern = new RegExp('^' + key + '\\s*:.*$', 'm');
    let block = match[1];
    block = linePattern.test(block)
      ? block.replace(linePattern, key + ': ' + wanted)
      : block + '\n' + key + ': ' + wanted;
    writeFileSync(path, '---\n' + block + '\n---' + text.slice(match.index + match[0].length), 'utf8');
    return { path, modelInvocable };
  }

  async function status() {
    const agent = resolveAgent(ctx);
    const rows = await mcpRows(agent);
    const skills = await skillsPayload();
    return {
      mcp: {
        rows,
        total: rows.length,
        enabled: rows.filter((row) => row.enabled).length,
        disabled: rows.filter((row) => !row.enabled).length,
        toolTotal: rows.reduce((sum, row) => sum + row.toolCount, 0),
        // What every enabled MCP server's tool schemas cost together, in the
        // same heuristic the context panel uses.
        toolTokens: rows.reduce((sum, row) => sum + row.toolTokens, 0),
      },
      skills: {
        items: skills.items,
        total: skills.items.length,
        modelInvocable: skills.items.filter((item) => item.modelInvocable).length,
        cwd: skills.cwd,
        error: skills.error,
      },
      lastError: lastError ?? null,
      generatedAt: Date.now(),
    };
  }

  async function readJson(request) {
    let body;
    try {
      body = await request.json();
    } catch (error) {
      throw Object.assign(new Error('请求体不是合法 JSON：' + (error instanceof Error ? error.message : String(error))), {
        reason: 'bad-json', status: 400,
      });
    }
    return body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {};
  }

  async function route(routeName, request) {
    try {
      const url = new URL(request.url);

      if (routeName === ROUTES.status) return json(await status());

      if (routeName === ROUTES.mcpToggle) {
        const body = await readJson(request);
        const entryId = typeof body.entryId === 'string' && body.entryId !== '' ? body.entryId : body.patchId;
        if (typeof entryId !== 'string' || entryId === '') {
          return json({ ok: false, reason: 'bad-request', message: '缺少 entryId' }, 400);
        }
        if (typeof body.enabled !== 'boolean') {
          return json({ ok: false, reason: 'bad-request', message: 'enabled 必须是布尔值' }, 400);
        }
        const manager = ctx.get('pluginManager');
        if (manager === undefined || typeof manager.setPluginEnabled !== 'function') {
          return json({ ok: false, reason: 'unavailable', message: 'pluginManager 服务不可用，无法启停' }, 503);
        }
        await manager.setPluginEnabled(entryId, body.enabled);
        lastError = null;
        return json({ ok: true, status: await status() });
      }

      if (routeName === ROUTES.mcpConfig) {
        const editor = ctx.get('configEditor');
        if (editor === undefined || typeof editor.edit !== 'function') {
          return json({ ok: false, reason: 'unavailable', message: 'configEditor 服务不可用，无法改配置' }, 503);
        }
        // Fetch Request bodies are single-use: parse this POST exactly once.
        const body = request.method === 'POST' ? await readJson(request) : undefined;
        const patchId = body === undefined ? url.searchParams.get('patchId') : body.patchId;
        if (typeof patchId !== 'string' || patchId === '') {
          return json({ ok: false, reason: 'bad-request', message: '缺少 patchId' }, 400);
        }
        const found = rowConfigs().get(patchId);
        if (found === undefined) {
          return json({ ok: false, reason: 'not-found', message: `找不到插件行 ${patchId} 的配置入口` }, 404);
        }
        const entry = found.entry;
        const current = found.config ?? {};
        const ownedBy = typeof ROW_OWNERS[patchId] === 'string' ? ROW_OWNERS[patchId] : null;
        if (request.method !== 'POST') {
          return json({ ok: true, patchId, ownedBy, redacted: true, config: redactSecrets(current), text: JSON.stringify(redactSecrets(current), null, 2) });
        }
        let next;
        try {
          next = typeof body.text === 'string' ? JSON.parse(body.text) : body.config;
        } catch (error) {
          return json({ ok: false, reason: 'bad-json', message: '配置不是合法 JSON：' + (error instanceof Error ? error.message : String(error)) }, 400);
        }
        if (next === null || typeof next !== 'object' || Array.isArray(next)) {
          return json({ ok: false, reason: 'bad-config', message: '配置必须是一个 JSON 对象' }, 400);
        }
        const merged = restoreSecrets(current, next);
        await editor.edit(entry, () => merged);
        lastError = null;
        return json({ ok: true, status: await status() });
      }

      if (routeName === ROUTES.skillGet) {
        const skillName = url.searchParams.get('name') ?? '';
        if (skillName === '') return json({ ok: false, reason: 'bad-request', message: '缺少 name' }, 400);
        const outcome = await skillBody(skillName);
        return json(outcome, outcome.ok === true ? 200 : outcome.reason === 'not-found' ? 404 : 500);
      }

      if (routeName === ROUTES.skillToggle) {
        const body = await readJson(request);
        if (typeof body.path !== 'string' || body.path === '') {
          return json({ ok: false, reason: 'bad-request', message: '该技能没有本地文件，无法修改' }, 400);
        }
        if (typeof body.modelInvocable !== 'boolean') {
          return json({ ok: false, reason: 'bad-request', message: 'modelInvocable 必须是布尔值' }, 400);
        }
        try {
          const updated = setModelInvocable(body.path, body.modelInvocable);
          return json({ ok: true, ...updated, status: await status() });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          lastError = message;
          return json({ ok: false, reason: 'failed', message }, 400);
        }
      }

      return json({ ok: false, reason: 'unknown-route', message: routeName }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = message;
      const badJson = error?.reason === 'bad-json' && error?.status === 400;
      if (!badJson) logger.warn?.(`dsh-mcp-skills: route ${routeName} failed: ${message}`);
      return json({ ok: false, reason: badJson ? 'bad-json' : 'internal', message }, badJson ? 400 : 500);
    }
  }

  return { status, route, mcpRows, skillsPayload, skillBody, setModelInvocable };
}

/**
 * Mount the plugin: register one exact Fetch route per action on `/api`.
 *
 * @param ctx - the plugin's Cordis context.
 * @param config - optional `{ cwd }`: the project directory for workspace-sensitive skill lookups.
 */
export function apply(ctx, config = {}) {
  const host = createMcpSkills({
    ctx,
    logger: ctx.logger,
    cwd: typeof config.cwd === 'string' && config.cwd !== '' ? config.cwd : undefined,
  });

  for (const route of Object.values(ROUTES)) {
    ctx.effect(() => {
      const dispose = ctx.connection.fetch.register({
        path: route,
        methods: ['GET', 'HEAD', 'POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          if (request.method === 'HEAD') return new Response(null, { status: 200, headers: JSON_HEADERS });
          return host.route(route, request);
        },
      });
      return () => dispose();
    }, `dsh-mcp-skills: route ${route}`);
  }

  ctx.logger?.info?.('dsh-mcp-skills host ready: %s', Object.values(ROUTES).join(', '));
}

export default { name, inject, apply };
