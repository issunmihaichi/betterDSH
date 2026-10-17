// Host-half tests: the real createGithub() over fake DSH services.
// No disk, no network, no git binary, no Harness process.
// usage: node tools/host-test.mjs
import assert from 'node:assert/strict';

import { COMMAND_NAME, ROUTES, createGithub } from '../lib/host.js';

let passed = 0;
const failures = [];

async function check(label, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** In-memory stand-in for lib/settings.js createStore. */
function fakeStore(initialSettings = {}, initialToken = undefined) {
  const state = { settings: { ...initialSettings }, token: initialToken, saves: 0 };
  return {
    state,
    dir: 'C:\\fake\\github-mcp',
    settingsPath: 'C:\\fake\\github-mcp\\settings.json',
    async load() { return { ...state.settings }; },
    async save(next) { state.saves += 1; state.settings = { ...next }; return next; },
    async readToken() { return state.token; },
    async writeToken(token) { state.token = String(token).trim() === '' ? undefined : String(token).trim(); return state.token; },
    async clearToken() { state.token = undefined; },
  };
}

const GITHUB_TOOLS = [
  {
    name: 'mcp__github__search_repositories',
    description: 'Find repositories',
    parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string', description: 'search text' } } },
  },
  {
    name: 'mcp__github__get_file_contents',
    description: 'Read a file',
    parameters: { type: 'object', properties: {} },
  },
  { name: 'read', description: 'built-in file reader', parameters: {} },
];

/** One Response-shaped object: `ok`/`status`/`headers.get`/`json` is all the API client reads. */
function apiResponse(body, status = 200, headers = {}) {
  const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (map.has(name.toLowerCase()) ? map.get(name.toLowerCase()) : null) },
    json: async () => body,
  };
}

/** The two GitHub endpoints the plugin calls, faked. */
function fakeGitHub(options, calls) {
  return async (url, init) => {
    const href = String(url);
    calls.http.push({ href, authorization: init?.headers?.authorization ?? '' });
    if (options.apiStatus !== undefined && options.apiStatus !== 200) {
      return apiResponse({ message: 'Bad credentials' }, options.apiStatus);
    }
    if (href.endsWith('/user')) {
      return apiResponse({ login: 'octocat', name: 'The Octocat', avatar_url: 'https://example/avatar.png' });
    }
    if (href.includes('/user/repos')) {
      const page = Number(new URL(href).searchParams.get('page') ?? '1');
      if (page > 1) return apiResponse([]);
      return apiResponse([
        {
          id: 1,
          name: 'Hello-World',
          full_name: 'octocat/Hello-World',
          owner: { login: 'octocat' },
          private: true,
          language: 'Go',
          default_branch: 'main',
          description: 'demo repo',
          clone_url: 'https://github.com/octocat/Hello-World.git',
          html_url: 'https://github.com/octocat/Hello-World',
        },
        {
          id: 2,
          name: 'Spoon-Knife',
          full_name: 'octocat/Spoon-Knife',
          owner: { login: 'octocat' },
          private: false,
          language: 'HTML',
          default_branch: 'gh-pages',
          description: 'fork me',
          clone_url: 'https://github.com/octocat/Spoon-Knife.git',
          html_url: 'https://github.com/octocat/Spoon-Knife',
        },
      ]);
    }
    return apiResponse({ message: 'Not Found' }, 404);
  };
}

/** One assembled fake world; every test gets a fresh one. */
function world(options = {}) {
  const store = fakeStore(options.settings ?? {}, options.token);
  const calls = { execute: [], clone: [], workspace: [], edits: [], http: [], setRemote: [] };
  const mcpState = {
    rows: [{ patchId: 'github-mcp', entryId: 'entry-1', enabled: options.rowEnabled === true, phase: options.rowEnabled === true ? 'active' : null }],
    setEnabledCalls: [],
    entry: { options: { id: 'github-mcp' } },
  };
  const mcp = {
    listRows: async () => mcpState.rows,
    entryFor: (id) => (id === 'github-mcp' ? mcpState.entry : undefined),
    setEnabled: async (entryId, enabled) => {
      mcpState.setEnabledCalls.push([entryId, enabled]);
      mcpState.rows = [{ ...mcpState.rows[0], enabled, phase: enabled ? 'active' : null }];
    },
    edit: async (entry, config) => {
      calls.edits.push({ entryId: entry.options.id, config });
    },
  };
  const repos = [];
  const github = createGithub({
    store,
    mcp,
    mcpRowId: 'github-mcp',
    defaultCloneRoot: 'C:\\fake\\repos',
    env: options.env ?? {},
    logger: { info: () => {}, warn: () => {} },
    sleep: async () => {},
    git: async () => ({
      binary: 'git',
      version: async () => ({ ok: true, version: 'git version 2.44.0' }),
      setRemoteUrl: async (directory, url) => {
        calls.setRemote.push({ directory, url });
        return { code: 0, log: '' };
      },
      clone: async (spec, onLine) => {
        calls.clone.push(spec);
        onLine('Cloning into \'repo\'...');
        onLine('Receiving objects: 100% (10/10)');
        if (options.cloneCode !== undefined && options.cloneCode !== 0) return { code: options.cloneCode, log: 'fatal: repository not found' };
        repos.push({ name: 'Hello-World', path: spec.dest, remote: spec.url, branch: 'main', updatedAt: 1 });
        return { code: 0, log: 'done' };
      },
    }),
    fetchImpl: fakeGitHub(options, calls),
    tools: {
      schemas: () => GITHUB_TOOLS,
      execute: async (input) => {
        calls.execute.push(input);
        if (input.name === 'mcp__github__get_file_contents') {
          return { isError: false, value: { text: 'file body' }, content: [{ type: 'text', text: 'file body' }] };
        }
        return { isError: false, value: {}, content: [{ type: 'text', text: 'search ok' }] };
      },
    },
    commands: {
      list: async () => [
        { name: COMMAND_NAME, description: 'GitHub MCP', input: { hint: '[list|tools|call|clone|repos|status|help]' } },
        { name: 'plan', description: 'plan mode', input: { hint: '' } },
      ],
    },
    workspaceRegistry: {
      create: async (path, title) => {
        calls.workspace.push({ path, title });
        return { id: 'ws-1' };
      },
      // The read-only half the page's "open workspace" needs: it answers for a
      // directory this world has already registered, and stays silent otherwise.
      resolveByPath: async (path) => (calls.workspace.some((entry) => entry.path === path) ? { id: 'ws-1' } : undefined),
    },
    listClones: async () => repos,
  });
  return { github, store, mcpState, calls, repos };
}

/** Exercise real Fetch Request parsing on every route, without a server. */
function get(url) {
  return new Request(url);
}
function post(url, body) {
  return new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

/** A browser first sees a plan, then sends exactly that displayed descriptor. */
async function confirmedPost(github, body) {
  const planned = await bodyOf(await github.handleRoute(ROUTES.clone, post(`http://x${ROUTES.clone}`, { ...body, confirm: false })));
  return post(`http://x${ROUTES.clone}`, { ...body, dir: planned.plan.dir, expected: planned.plan, confirm: true });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function bodyOf(response, expectedStatus = 200) {
  assert.equal(response.status, expectedStatus);
  return response.json();
}

// ------------------------------------------------------------------ status ---

await check('status reports the connection, tools and the registered command', async () => {
  const { github } = world({ rowEnabled: true, token: 'ghp_x' });
  const body = await bodyOf(await github.handleRoute(ROUTES.status, get(`http://x${ROUTES.status}`)));
  assert.equal(body.mcp.rowId, 'github-mcp');
  assert.equal(body.mcp.enabled, true);
  assert.equal(body.mcp.transport, 'streamable-http');
  assert.equal(body.mcp.toolCount, 2);
  assert.deepEqual(body.tools.map((tool) => tool.shortName), ['search_repositories', 'get_file_contents']);
  assert.equal(body.command.name, 'github');
  assert.equal(body.command.listed, true);
  assert.equal(body.command.hint, '[list|tools|call|clone|repos|status|help]');
  assert.equal(body.cloneRoot, 'C:\\fake\\repos');
  assert.equal(body.git.ok, true);
});

await check('status never leaks the token', async () => {
  const { github } = world({ token: 'ghp_supersecretvalue' });
  const body = await bodyOf(await github.handleRoute(ROUTES.status, get(`http://x${ROUTES.status}`)));
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes('supersecretvalue'));
  assert.equal(body.token.present, true);
});

await check('status survives a missing MCP row', async () => {
  const { github, mcpState } = world();
  mcpState.rows = [];
  const body = await bodyOf(await github.handleRoute(ROUTES.status, get(`http://x${ROUTES.status}`)));
  assert.equal(body.mcp.found, false);
  assert.equal(body.mcp.toolCount, 2);
});

// --------------------------------------------------------------- token flow ---

await check('a token saved while the row is disabled is deferred, not an error', async () => {
  const { github, calls, store } = world();
  const body = await bodyOf(await github.handleRoute(ROUTES.token, post(`http://x${ROUTES.token}`, { token: 'ghp_saved' })));
  assert.equal(body.ok, true);
  assert.equal(body.applied.deferred, 'row-disabled');
  assert.equal(store.state.token, 'ghp_saved');
  assert.equal(calls.edits.length, 0);
});

await check('connect applies the deferred config in the same action', async () => {
  const { github, calls, store } = world();
  await github.handleRoute(ROUTES.token, post(`http://x${ROUTES.token}`, { token: 'ghp_saved' }));
  await github.handleRoute(ROUTES.connection, post(`http://x${ROUTES.connection}`, { action: 'connect' }));
  assert.equal(calls.edits.length, 1);
  assert.equal(calls.edits[0].config.headers.Authorization, 'Bearer ghp_saved');
  assert.equal(store.state.token, 'ghp_saved');
});

await check('the wizard verifies a token against GitHub before storing it', async () => {
  const { github, store, calls } = world();
  const body = await bodyOf(await github.handleRoute(ROUTES.token, post(`http://x${ROUTES.token}`, { token: 'ghp_verified', verify: true })));
  assert.equal(body.ok, true);
  assert.equal(body.verified, true);
  assert.equal(body.account.login, 'octocat');
  assert.equal(store.state.token, 'ghp_verified');
  assert.equal(calls.http.some((entry) => entry.authorization === 'Bearer ghp_verified'), true);
});

await check('a rejected token is reported and never stored', async () => {
  const { github, store, calls } = world({ apiStatus: 401 });
  const body = await bodyOf(await github.handleRoute(ROUTES.token, post(`http://x${ROUTES.token}`, { token: 'ghp_bad', verify: true })), 400);
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'bad-token');
  assert.equal(store.state.token, undefined);
  assert.equal(store.state.saves, 0);
  assert.equal(calls.edits.length, 0);
});

await check('the wizard can verify the environment token without storing anything', async () => {
  const { github, store } = world({
    settings: { tokenSource: 'env' },
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'env-token' },
  });
  const body = await bodyOf(await github.handleRoute(ROUTES.token, post(`http://x${ROUTES.token}`, { verify: true })));
  assert.equal(body.ok, true);
  assert.equal(body.account.login, 'octocat');
  assert.equal(store.state.token, undefined);
});

await check('verify without a pasted token checks the stored one', async () => {
  const { github } = world({ token: 'ghp_stored' });
  const body = await bodyOf(await github.handleRoute(ROUTES.token, post(`http://x${ROUTES.token}`, { verify: true })));
  assert.equal(body.ok, true);
  assert.equal(body.account.login, 'octocat');
});

await check('verifying with nothing to verify is a readable 400', async () => {
  const { github } = world();
  const body = await bodyOf(await github.handleRoute(ROUTES.token, post(`http://x${ROUTES.token}`, { verify: true })), 400);
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'no-token');
});

await check('the wizard flag round-trips through the settings route', async () => {
  const { github, store } = world();
  await github.handleRoute(ROUTES.settings, post(`http://x${ROUTES.settings}`, { settings: { wizardDone: true } }));
  assert.equal(store.state.settings.wizardDone, true);
  const status = await bodyOf(await github.handleRoute(ROUTES.status, get(`http://x${ROUTES.status}`)));
  assert.equal(status.settings.wizardDone, true);
});

await check('saving a token applies it to the MCP row immediately', async () => {
  const { github, calls, store } = world({ rowEnabled: true });
  const body = await bodyOf(await github.handleRoute(ROUTES.token, post(`http://x${ROUTES.token}`, { token: 'ghp_new' })));
  assert.equal(body.ok, true);
  assert.equal(store.state.token, 'ghp_new');
  assert.equal(calls.edits.length, 1);
  assert.equal(calls.edits[0].config.headers.Authorization, 'Bearer ghp_new');
  assert.equal(body.status.token.present, true);
});

await check('clearing the token removes it from the MCP row config', async () => {
  const { github, calls } = world({ rowEnabled: true, token: 'ghp_old' });
  await github.handleRoute(ROUTES.token, post(`http://x${ROUTES.token}`, { clear: true }));
  assert.equal(calls.edits.at(-1).config.headers, undefined);
});

await check('an env-sourced token is read from the environment without storing it', async () => {
  const { github, store, calls } = world({ settings: { tokenSource: 'env', envVar: 'MY_GH_TOKEN' }, env: { MY_GH_TOKEN: 'env-secret' }, rowEnabled: true });
  const info = await github.tokenInfo();
  assert.deepEqual([info.present, info.source, info.envVar], [true, 'env', 'MY_GH_TOKEN']);
  assert.equal(await github.resolveToken(), 'env-secret');
  assert.equal(store.state.token, undefined);
  await github.applyMcpConfig();
  assert.equal(calls.edits.at(-1).config.headers.Authorization, 'Bearer env-secret');
});

// ---------------------------------------------------------------- connection ---

await check('connect without a token refuses with a readable reason', async () => {
  const { github, mcpState } = world();
  const body = await bodyOf(await github.handleRoute(ROUTES.connection, post(`http://x${ROUTES.connection}`, { action: 'connect' })));
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'no-token');
  assert.ok(body.message.includes('令牌'));
  assert.equal(mcpState.setEnabledCalls.length, 0);
});

await check('connect enables a disabled row before writing its config', async () => {
  const { github, mcpState, calls } = world({ token: 'ghp_x' });
  const body = await bodyOf(await github.handleRoute(ROUTES.connection, post(`http://x${ROUTES.connection}`, { action: 'connect' })));
  assert.equal(body.ok, true);
  assert.deepEqual(mcpState.setEnabledCalls, [['entry-1', true]]);
  assert.equal(calls.edits.length, 1);
  assert.equal(body.status.mcp.enabled, true);
});

await check('connect on an already enabled row does not re-enable it', async () => {
  const { github, mcpState } = world({ token: 'ghp_x', rowEnabled: true });
  await github.handleRoute(ROUTES.connection, post(`http://x${ROUTES.connection}`, { action: 'connect' }));
  assert.deepEqual(mcpState.setEnabledCalls, []);
});

await check('disconnect stops the row', async () => {
  const { github, mcpState } = world({ token: 'ghp_x', rowEnabled: true });
  const body = await bodyOf(await github.handleRoute(ROUTES.connection, post(`http://x${ROUTES.connection}`, { action: 'disconnect' })));
  assert.equal(body.ok, true);
  assert.deepEqual(mcpState.setEnabledCalls, [['entry-1', false]]);
  assert.equal(body.status.mcp.enabled, false);
});

await check('connect reports a missing row instead of pretending to work', async () => {
  const { github, mcpState } = world({ token: 'ghp_x' });
  mcpState.rows = [];
  const body = await bodyOf(await github.handleRoute(ROUTES.connection, post(`http://x${ROUTES.connection}`, { action: 'connect' })));
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'row-missing');
});

// ------------------------------------------------------------------ settings ---

await check('switching to stdio rewrites the whole MCP config', async () => {
  const { github, calls } = world({ rowEnabled: true, token: 'ghp_x' });
  const body = await bodyOf(await github.handleRoute(ROUTES.settings, post(`http://x${ROUTES.settings}`, {
    settings: { transport: 'stdio', command: 'github-mcp-server', argsText: 'stdio', toolsets: 'repos', readOnly: true },
  })));
  assert.equal(body.ok, true);
  const config = calls.edits.at(-1).config;
  assert.equal(config.transport, 'stdio');
  assert.deepEqual(config.args, ['stdio', '--toolsets', 'repos', '--read-only']);
  assert.deepEqual(config.env, { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_x' });
  assert.equal(config.url, undefined);
  assert.equal(config.headers, undefined);
});

await check('settings POST persists and the GET returns them', async () => {
  const { github, store } = world();
  await github.handleRoute(ROUTES.settings, post(`http://x${ROUTES.settings}`, { settings: { cloneRoot: 'D:\\code', serverName: 'gh' } }));
  assert.equal(store.state.settings.cloneRoot, 'D:\\code');
  assert.equal(store.state.settings.serverName, 'gh');
  const body = await bodyOf(await github.handleRoute(ROUTES.settings, get(`http://x${ROUTES.settings}`)));
  assert.equal(body.settings.cloneRoot, 'D:\\code');
  const status = await bodyOf(await github.handleRoute(ROUTES.status, get(`http://x${ROUTES.status}`)));
  assert.equal(status.mcp.serverName, 'gh');
});

await check('an invalid setting is normalized rather than stored raw', async () => {
  const { github, store } = world();
  await github.handleRoute(ROUTES.settings, post(`http://x${ROUTES.settings}`, { settings: { transport: 'carrier-pigeon', serverName: '!!' } }));
  assert.equal(store.state.settings.transport, 'streamable-http');
  assert.equal(store.state.settings.serverName, 'github');
});

// --------------------------------------------------------------- tool calls ---

await check('the call route executes a GitHub tool through the tool pipeline', async () => {
  const { github, calls } = world({ rowEnabled: true, token: 'ghp_x' });
  const body = await bodyOf(await github.handleRoute(ROUTES.call, post(`http://x${ROUTES.call}`, {
    name: 'get_file_contents',
    arguments: { owner: 'octocat' },
  })));
  assert.equal(body.ok, true);
  assert.equal(body.text, 'file body');
  assert.equal(calls.execute.length, 1);
  assert.equal(calls.execute[0].name, 'mcp__github__get_file_contents');
  assert.deepEqual(calls.execute[0].arguments, { owner: 'octocat' });
  assert.ok(typeof calls.execute[0].callId === 'string');
});

await check('an already qualified tool name is not double-prefixed', async () => {
  const { github, calls } = world({ rowEnabled: true });
  await github.handleRoute(ROUTES.call, post(`http://x${ROUTES.call}`, { name: 'mcp__github__search_repositories', arguments: { query: 'x' } }));
  assert.equal(calls.execute[0].name, 'mcp__github__search_repositories');
});

await check('an unavailable tool is refused with 409', async () => {
  const { github } = world();
  const body = await bodyOf(await github.handleRoute(ROUTES.call, post(`http://x${ROUTES.call}`, { name: 'delete_repo', arguments: {} })), 409);
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'unknown-tool');
});

await check('a call without a name is a 400', async () => {
  const { github } = world();
  await bodyOf(await github.handleRoute(ROUTES.call, post(`http://x${ROUTES.call}`, {})), 400);
});

await check('text arguments are accepted for the call route', async () => {
  const { github, calls } = world({ rowEnabled: true });
  const body = await bodyOf(await github.handleRoute(ROUTES.call, post(`http://x${ROUTES.call}`, {
    name: 'search_repositories',
    argumentsText: 'query=hello',
  })));
  assert.equal(body.ok, true);
  assert.deepEqual(calls.execute[0].arguments, { query: 'hello' });
});

// ------------------------------------------------------------------- clones ---

await check('a clone request without confirmation only returns the plan', async () => {
  const { github, calls } = world({ rowEnabled: true });
  const body = await bodyOf(await github.handleRoute(ROUTES.clone, post(`http://x${ROUTES.clone}`, { repo: 'octocat/Hello-World' })));
  assert.equal(body.needsConfirm, true);
  assert.equal(body.plan.dest, 'C:\\fake\\repos\\Hello-World');
  assert.equal(calls.clone.length, 0);
  assert.ok(body.text.includes('即将开始下载'));
});

await check('a confirmed clone downloads and registers a workspace', async () => {
  const { github, calls, repos } = world({ rowEnabled: true });
  const started = await bodyOf(await github.handleRoute(ROUTES.clone, await confirmedPost(github, {
    repo: 'octocat/Hello-World',
    confirm: true,
  })));
  assert.equal(started.ok, true);
  assert.ok(typeof started.job.id === 'string');

  // The clone resolves asynchronously; poll until it settles.
  let job = started.job;
  for (let attempt = 0; attempt < 50 && job.state === 'running'; attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    const polled = await bodyOf(await github.handleRoute(ROUTES.clone, get(`http://x${ROUTES.clone}?id=${encodeURIComponent(job.id)}`)));
    job = polled.job;
  }
  assert.equal(job.state, 'done');
  assert.equal(calls.clone.length, 1);
  assert.equal(calls.clone[0].url, 'https://github.com/octocat/Hello-World.git');
  assert.deepEqual(calls.workspace, [{ path: 'C:\\fake\\repos\\Hello-World', title: 'Hello-World' }]);
  assert.equal(job.workspace.created, true);
  assert.ok(job.log.some((line) => line.includes('Receiving objects')));
  assert.equal((await bodyOf(await github.handleRoute(ROUTES.clone, get(`http://x${ROUTES.clone}`)))).repos.length, 1);
  assert.equal(repos.length, 1);
});

await check('a downloaded clone is annotated with the workspace that owns it', async () => {
  const { github, repos, calls } = world();
  repos.push({
    name: 'Hello-World',
    path: 'C:\\fake\\repos\\Hello-World',
    remote: 'https://github.com/octocat/Hello-World.git',
    branch: 'main',
  });

  // No registration yet: the row carries the path and nothing to open.
  const before = await bodyOf(await github.handleRoute(ROUTES.status, get(`http://x${ROUTES.status}`)));
  assert.equal(before.repos.length, 1);
  assert.equal('workspaceId' in before.repos[0], false);

  // The registry now owns that directory, as it does after a real clone.
  calls.workspace.push({ path: 'C:\\fake\\repos\\Hello-World', title: 'Hello-World' });
  const after = await bodyOf(await github.handleRoute(ROUTES.status, get(`http://x${ROUTES.status}`)));
  assert.equal(after.repos[0].workspaceId, 'ws-1');
  assert.equal(after.repos[0].path, 'C:\\fake\\repos\\Hello-World');
  assert.equal(after.repos[0].branch, 'main');
});

await check('a failing clone is reported, not registered', async () => {
  const { github, calls } = world({ rowEnabled: true, cloneCode: 128 });
  const started = await bodyOf(await github.handleRoute(ROUTES.clone, await confirmedPost(github, { repo: 'octocat/missing', confirm: true })));
  let job = started.job;
  for (let attempt = 0; attempt < 50 && job.state === 'running'; attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    job = (await bodyOf(await github.handleRoute(ROUTES.clone, get(`http://x${ROUTES.clone}?id=${encodeURIComponent(job.id)}`)))).job;
  }
  assert.equal(job.state, 'failed');
  assert.equal(job.workspace, null);
  assert.equal(calls.workspace.length, 0);
});

await check('an unusable repository name is refused before any git runs', async () => {
  const { github, calls } = world();
  const body = await bodyOf(await github.handleRoute(ROUTES.clone, post(`http://x${ROUTES.clone}`, { repo: 'not-a-repo' })), 400);
  assert.equal(body.ok, false);
  assert.equal(calls.clone.length, 0);
});

await check('polling an unknown job id is a 404, not a crash', async () => {
  const { github } = world();
  await bodyOf(await github.handleRoute(ROUTES.clone, get(`http://x${ROUTES.clone}?id=nope`)), 404);
});

// -------------------------------------------------------------- remote repos ---

await check('the remote listing refuses without a token', async () => {
  const { github, calls } = world();
  const body = await bodyOf(await github.handleRoute(ROUTES.remote, get(`http://x${ROUTES.remote}`)), 409);
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'no-token');
  assert.equal(calls.http.length, 0);
});

await check('the remote listing returns the account and its repositories', async () => {
  const { github, calls } = world({ token: 'ghp_test' });
  const body = await bodyOf(await github.handleRoute(ROUTES.remote, get(`http://x${ROUTES.remote}?page=1`)));
  assert.equal(body.ok, true);
  assert.equal(body.account.login, 'octocat');
  assert.deepEqual(body.items.map((repo) => repo.fullName), ['octocat/Hello-World', 'octocat/Spoon-Knife']);
  assert.equal(body.items[0].private, true);
  assert.equal(body.items[1].defaultBranch, 'gh-pages');
  assert.equal(body.scanned, 2);
  assert.equal(calls.http[0].href.endsWith('/user'), true);
  assert.equal(calls.http.some((entry) => entry.authorization === 'Bearer ghp_test'), true);
  assert.ok(calls.http.some((entry) => entry.href.includes('affiliation=owner%2Ccollaborator%2Corganization_member')));
});

await check('the remote listing searches across scanned pages', async () => {
  const { github } = world({ token: 'ghp_test' });
  const body = await bodyOf(await github.handleRoute(ROUTES.remote, get(`http://x${ROUTES.remote}?q=spoon`)));
  assert.equal(body.ok, true);
  assert.deepEqual(body.items.map((repo) => repo.fullName), ['octocat/Spoon-Knife']);
  assert.equal(body.scanned, 2);
  assert.equal(body.query, 'spoon');
});

await check('a rejected token is reported as bad-token', async () => {
  const { github } = world({ token: 'ghp_bad', apiStatus: 401 });
  const body = await bodyOf(await github.handleRoute(ROUTES.remote, get(`http://x${ROUTES.remote}`)), 502);
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'bad-token');
  assert.ok(body.message.includes('401'));
});

await check('the plan handed to the browser never carries the token', async () => {
  const { github } = world({ token: 'ghp_supersecretvalue' });
  const body = await bodyOf(await github.handleRoute(ROUTES.clone, post(`http://x${ROUTES.clone}`, { repo: 'octocat/Hello-World' })));
  assert.equal(body.plan.usesToken, true);
  assert.equal(body.plan.cloneUrl, 'https://github.com/octocat/Hello-World.git');
  assert.ok(!JSON.stringify(body).includes('supersecretvalue'));
});

await check('a clone with a token authenticates git and then scrubs origin', async () => {
  const { github, calls } = world({ token: 'ghp_supersecretvalue' });
  const started = await bodyOf(await github.handleRoute(ROUTES.clone, await confirmedPost(github, {
    repo: 'octocat/Hello-World',
    private: true,
    confirm: true,
  })));
  let job = started.job;
  for (let attempt = 0; attempt < 50 && job.state === 'running'; attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    job = (await bodyOf(await github.handleRoute(ROUTES.clone, get(`http://x${ROUTES.clone}?id=${encodeURIComponent(job.id)}`)))).job;
  }
  assert.equal(job.state, 'done');
  assert.equal(job.authenticated, true);
  assert.equal(calls.clone[0].url, 'https://x-access-token:ghp_supersecretvalue@github.com/octocat/Hello-World.git');
  assert.deepEqual(calls.setRemote, [{
    directory: 'C:\\fake\\repos\\Hello-World',
    url: 'https://github.com/octocat/Hello-World.git',
  }]);
  assert.ok(!job.log.join('\n').includes('supersecretvalue'));
  assert.ok(job.log.join('\n').includes('使用访问令牌下载'));
});

await check('a clone with no token never injects a credential', async () => {
  const { github, calls } = world();
  const started = await bodyOf(await github.handleRoute(ROUTES.clone, await confirmedPost(github, { repo: 'octocat/Hello-World', confirm: true })));
  let job = started.job;
  for (let attempt = 0; attempt < 50 && job.state === 'running'; attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    job = (await bodyOf(await github.handleRoute(ROUTES.clone, get(`http://x${ROUTES.clone}?id=${encodeURIComponent(job.id)}`)))).job;
  }
  assert.equal(job.authenticated, false);
  assert.equal(calls.clone[0].url, 'https://github.com/octocat/Hello-World.git');
  assert.equal(calls.setRemote.length, 0);
});

await check('a repository chosen from the list clones its default branch', async () => {
  const { github, calls } = world({ token: 'ghp_test' });
  await github.handleRoute(ROUTES.clone, await confirmedPost(github, {
    repo: 'octocat/Spoon-Knife',
    branch: 'gh-pages',
    confirm: true,
  }));
  assert.equal(calls.clone[0].branch, 'gh-pages');
});

await check('/github remote lists the account repositories', async () => {
  const { github } = world({ token: 'ghp_test' });
  const result = await github.handleCommand({ rawInput: 'remote', agent: { id: 's1' } });
  assert.equal(result.kind, 'success');
  assert.ok(result.text.includes('octocat/Hello-World'));
  assert.ok(result.text.includes('/github clone octocat/Hello-World --yes'));
});

await check('/github remote filters and reports an empty result', async () => {
  const { github } = world({ token: 'ghp_test' });
  const filtered = await github.handleCommand({ rawInput: 'remote spoon', agent: { id: 's1' } });
  assert.ok(filtered.text.includes('Spoon-Knife'));
  assert.ok(!filtered.text.includes('Hello-World'));
  const none = await github.handleCommand({ rawInput: 'remote zzz', agent: { id: 's1' } });
  assert.ok(none.text.includes('zzz'));
});

await check('/github remote without a token is an error result', async () => {
  const { github } = world();
  const result = await github.handleCommand({ rawInput: 'remote', agent: { id: 's1' } });
  assert.equal(result.kind, 'error');
  assert.ok(result.text.includes('令牌'));
});

// ------------------------------------------------------------------ command ---

const R = { kind: 'success' };

await check('a bare /github lists the tools and the call form', async () => {
  const { github } = world({ rowEnabled: true, token: 'ghp_x' });
  const result = await github.handleCommand({ rawInput: '', agent: { id: 's1' } });
  assert.equal(result.kind, R.kind);
  assert.ok(result.text.includes('search_repositories'));
  assert.ok(result.text.includes('/github call'));
});

await check('a bare /github explains how to connect when unavailable', async () => {
  const { github } = world();
  const result = await github.handleCommand({ rawInput: '   ', agent: { id: 's1' } });
  assert.equal(result.kind, R.kind);
  assert.ok(result.text.includes('设置 → GitHub'));
});

await check('/github status reports the connection without the secret', async () => {
  const { github } = world({ rowEnabled: true, token: 'ghp_supersecretvalue' });
  const result = await github.handleCommand({ rawInput: 'status', agent: { id: 's1' } });
  assert.equal(result.kind, R.kind);
  assert.ok(result.text.includes('active'));
  assert.ok(result.text.includes('2'));
  assert.ok(!result.text.includes('supersecretvalue'));
});

await check('/github tools lists and filters', async () => {
  const { github } = world({ rowEnabled: true });
  const all = await github.handleCommand({ rawInput: 'tools', agent: { id: 's1' } });
  assert.ok(all.text.includes('2'));
  const filtered = await github.handleCommand({ rawInput: 'tools file', agent: { id: 's1' } });
  assert.ok(filtered.text.includes('get_file_contents'));
  const none = await github.handleCommand({ rawInput: 'tools zzz', agent: { id: 's1' } });
  assert.ok(none.text.includes('zzz'));
});

await check('/github tools <name> prints the parameter surface', async () => {
  const { github } = world({ rowEnabled: true });
  const result = await github.handleCommand({ rawInput: 'tools search_repositories', agent: { id: 's1' } });
  assert.ok(result.text.includes('query'));
  assert.ok(result.text.includes('/github call search_repositories'));
});

await check('/github call executes a tool', async () => {
  const { github, calls } = world({ rowEnabled: true });
  const result = await github.handleCommand({ rawInput: 'call get_file_contents {"owner":"octocat"}', agent: { id: 's1' } });
  assert.equal(result.kind, R.kind);
  assert.equal(result.text, 'file body');
  assert.deepEqual(calls.execute[0].arguments, { owner: 'octocat' });
});

await check('/github call with bad JSON is an error result', async () => {
  const { github } = world({ rowEnabled: true });
  const result = await github.handleCommand({ rawInput: 'call get_file_contents {oops', agent: { id: 's1' } });
  assert.equal(result.kind, 'error');
});

await check('/github call without a tool name explains the usage', async () => {
  const { github } = world();
  const result = await github.handleCommand({ rawInput: 'call', agent: { id: 's1' } });
  assert.equal(result.kind, 'error');
  assert.ok(result.text.includes('/github tools'));
});

await check('a tool name in first position is accepted as a call', async () => {
  const { github, calls } = world({ rowEnabled: true });
  const result = await github.handleCommand({ rawInput: 'get_file_contents owner=octocat', agent: { id: 's1' } });
  assert.equal(result.kind, R.kind);
  assert.deepEqual(calls.execute[0].arguments, { owner: 'octocat' });
});

await check('/github clone warns first and only downloads with --yes', async () => {
  const { github, calls } = world({ rowEnabled: true });
  const plan = await github.handleCommand({ rawInput: 'clone octocat/Hello-World', agent: { id: 's1' } });
  assert.equal(plan.kind, R.kind);
  assert.ok(plan.text.includes('即将开始下载'));
  assert.ok(plan.text.includes('--yes'));
  assert.equal(calls.clone.length, 0);

  const done = await github.handleCommand({ rawInput: 'clone octocat/Hello-World --yes', agent: { id: 's1' } });
  assert.equal(done.kind, R.kind);
  assert.ok(done.text.includes('已下载'));
  assert.ok(done.text.includes('工作区'));
  assert.equal(calls.clone.length, 1);
});

await check('/github clone rejects a bad repository', async () => {
  const { github } = world();
  const result = await github.handleCommand({ rawInput: 'clone nonsense', agent: { id: 's1' } });
  assert.equal(result.kind, 'error');
});

await check('/github repos lists what was downloaded', async () => {
  const { github, repos } = world();
  repos.push({ name: 'Hello-World', path: 'C:\\fake\\repos\\Hello-World', remote: 'https://github.com/octocat/Hello-World.git', branch: 'main' });
  const result = await github.handleCommand({ rawInput: 'repos', agent: { id: 's1' } });
  assert.ok(result.text.includes('Hello-World'));
  assert.ok(result.text.includes('@main'));
  const empty = await github.handleCommand({ rawInput: 'repos', agent: { id: 's1' } });
  assert.equal(empty.kind, R.kind);
});

await check('/github help lists every action', async () => {
  const { github } = world();
  const result = await github.handleCommand({ rawInput: 'help', agent: { id: 's1' } });
  assert.ok(result.text.includes('/github clone'));
  assert.ok(result.text.includes('/github status'));
});

await check('an unknown subcommand is an error result', async () => {
  const { github } = world();
  const result = await github.handleCommand({ rawInput: 'frobnicate', agent: { id: 's1' } });
  assert.equal(result.kind, 'error');
  assert.ok(result.text.includes('frobnicate'));
});

await check('the command definition carries the hint the composer shows', () => {
  const { github } = world();
  const definition = github.commandDefinition();
  assert.equal(definition.name, 'github');
  assert.ok(definition.input.hint.includes('call'));
  assert.equal(typeof definition.handler, 'function');
  assert.ok(definition.description.includes('GitHub'));
});

await check('the command never throws, whatever the input', async () => {
  const { github } = world({ rowEnabled: true, token: 'ghp_x' });
  for (const rawInput of ['', ' ', 'call', 'call x', 'clone', 'clone a/b --branch', 'tools ', 'status', 'help', 'repos', '--yes', '""']) {
    const result = await github.handleCommand({ rawInput, agent: { id: 's1' } });
    assert.ok(result.kind === 'success' || result.kind === 'error');
    assert.equal(typeof result.text, 'string');
  }
});

await check('a real store failure inside a route becomes a JSON 500', async () => {
  const { github, store } = world({ rowEnabled: true });
  store.load = async () => { throw new Error('settings unavailable'); };
  const outcome = await bodyOf(await github.handleRoute(ROUTES.status, get(`http://x${ROUTES.status}`)), 500);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'internal');
  assert.equal(outcome.message, 'settings unavailable');
});

// -------------------------------------------------- concurrency / confirmation ---

await check('concurrent real settings Requests serialize deferred writes and merge both patches', async () => {
  const { github, store } = world();
  const firstWrite = deferred();
  const entered = deferred();
  const save = store.save;
  let active = 0;
  let maxActive = 0;
  let writes = 0;
  store.save = async (next) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    writes += 1;
    if (writes === 1) { entered.resolve(); await firstWrite.promise; }
    try { return await save(next); } finally { active -= 1; }
  };
  const first = github.handleRoute(ROUTES.settings, post(`http://x${ROUTES.settings}`, { settings: { cloneRoot: 'D:\\chosen' } }));
  await entered.promise;
  const second = github.handleRoute(ROUTES.settings, post(`http://x${ROUTES.settings}`, { settings: { readOnly: true } }));
  // Let native Request.json() finish while the first save remains blocked.
  // A non-serialized implementation would enter the second save right now.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 1);
  firstWrite.resolve();
  for (const response of await Promise.all([first, second])) assert.equal((await bodyOf(response)).ok, true);
  assert.equal(maxActive, 1);
  assert.equal(store.state.settings.cloneRoot, 'D:\\chosen');
  assert.equal(store.state.settings.readOnly, true);
  assert.equal((await github.settings()).readOnly, true);
});

await check('a failed deferred settings write does not publish or poison later patches', async () => {
  const { github, store } = world({ settings: { cloneRoot: 'C:\\original' } });
  const gate = deferred();
  const entered = deferred();
  const save = store.save;
  let first = true;
  store.save = async (next) => {
    if (first) { first = false; entered.resolve(); await gate.promise; throw new Error('disk full'); }
    return save(next);
  };
  const failing = github.handleRoute(ROUTES.settings, post(`http://x${ROUTES.settings}`, { settings: { cloneRoot: 'D:\\lost' } }));
  await entered.promise;
  const later = github.handleRoute(ROUTES.settings, post(`http://x${ROUTES.settings}`, { settings: { readOnly: true } }));
  gate.resolve();
  assert.equal((await bodyOf(await failing, 500)).message, 'disk full');
  assert.equal((await bodyOf(await later)).ok, true);
  assert.equal(store.state.settings.cloneRoot, 'C:\\original');
  assert.equal(store.state.settings.readOnly, true);
});

await check('initial concurrent loads share one read and never overwrite a committed patch', async () => {
  const { github, store } = world();
  const gate = deferred();
  const entered = deferred();
  let loads = 0;
  store.load = async () => { loads += 1; entered.resolve(); await gate.promise; return {}; };
  const reading = github.settings();
  await entered.promise;
  const writing = github.saveSettings({ readOnly: true });
  gate.resolve();
  await Promise.all([reading, writing]);
  assert.equal(loads, 1);
  assert.equal((await github.settings()).readOnly, true);
});

await check('HTTP confirmation without a displayed descriptor refuses before git', async () => {
  const { github, calls } = world();
  const body = await bodyOf(await github.handleRoute(ROUTES.clone, post(`http://x${ROUTES.clone}`, { repo: 'octocat/Hello-World', confirm: true })), 409);
  assert.equal(body.reason, 'confirmation-required');
  assert.equal(calls.clone.length, 0);
});

for (const changed of [{ cloneRoot: 'D:\\changed' }, { cloneDepth: 1 }, { cloneBranch: 'other' }]) {
  await check(`changed clone settings ${JSON.stringify(changed)} require reconfirmation`, async () => {
    const { github, calls } = world();
    const planned = await bodyOf(await github.handleRoute(ROUTES.clone, post(`http://x${ROUTES.clone}`, { repo: 'octocat/Hello-World' })));
    await github.saveSettings(changed);
    const rejected = await bodyOf(await github.handleRoute(ROUTES.clone, post(`http://x${ROUTES.clone}`, {
      repo: planned.plan.fullName, expected: planned.plan, confirm: true,
    })), 409);
    assert.equal(rejected.reason, 'plan-changed');
    assert.equal(calls.clone.length, 0);
    assert.equal(calls.workspace.length, 0);
  });
}

await check('matching displayed custom directory and depth are what git actually receives', async () => {
  const { github, calls } = world({ settings: { cloneDepth: 7 } });
  const req = await confirmedPost(github, { repo: 'octocat/Hello-World', dir: 'my-copy', branch: 'main' });
  const started = await bodyOf(await github.handleRoute(ROUTES.clone, req));
  assert.equal(started.ok, true);
  assert.equal(calls.clone[0].dest, 'C:\\fake\\repos\\my-copy');
  assert.equal(calls.clone[0].depth, 7);
  assert.equal(calls.clone[0].branch, 'main');
});

await check('a changed repository or incomplete expected descriptor is not confirmation', async () => {
  const { github, calls } = world();
  const planned = await github.planClone({ repo: 'octocat/Hello-World' });
  for (const [repo, expected] of [['octocat/other', planned], [planned.fullName, { dest: planned.dest, depth: planned.depth }]]) {
    const rejected = await bodyOf(await github.handleRoute(ROUTES.clone, post(`http://x${ROUTES.clone}`, {
      repo, expected, confirm: true,
    })), 409);
    assert.equal(rejected.reason, 'plan-changed');
  }
  assert.equal(calls.clone.length, 0);
});

// ------------------------------------------------------------------ summary ---

if (failures.length > 0) {
  console.error(`host-test: ${String(failures.length)} failed, ${String(passed)} passed`);
  for (const failure of failures) console.error(`  x ${failure}`);
  process.exit(1);
}
console.log(`host-test: ${String(passed)}/${String(passed)} passed`);
