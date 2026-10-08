// Host-half tests: the MCP row payload (tool counts, context cost, ownership),
// the config route's secret redaction/restore, and the parity between this
// plugin's token arithmetic and the context-window panel's.
//
// The parity block is the reason `lib/estimate.js` exists as a copy: two pages
// report "this server costs ~X", and a drift between them must fail a test
// rather than quietly disagree in the UI.
//
// usage: node tools/host-test.mjs
import assert from 'node:assert/strict';

import {
  REDACTED,
  ROUTES,
  ROW_OWNERS,
  createMcpSkills,
  isMcpConfig,
  redactSecrets,
  restoreSecrets,
  toolTokensFor,
} from '../lib/host.js';
import * as mine from '../lib/estimate.js';
import * as panel from '../../dsh-context-window/lib/estimate.js';

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

// ------------------------------------------------------------ pricing parity ---

await check('both estimator copies carry the same constants', () => {
  assert.equal(mine.CHARS_PER_TOKEN, 4);
  assert.equal(mine.BLOCK_OVERHEAD, 4);
  assert.equal(mine.ROLE_OVERHEAD, 4);
  assert.equal(mine.CHARS_PER_TOKEN, panel.CHARS_PER_TOKEN);
  assert.equal(mine.BLOCK_OVERHEAD, panel.BLOCK_OVERHEAD);
  assert.equal(mine.ROLE_OVERHEAD, panel.ROLE_OVERHEAD);
});

const SAMPLES = {
  texts: ['', 'a', 'abcd', 'abcde', '你好世界', 'x'.repeat(101)],
  blocks: [
    [],
    [{ type: 'text', text: 'hello' }],
    [{ type: 'reasoning', text: 'why' }],
    [{ type: 'tool-call', name: 'read', arguments: '{"path":"a"}' }],
    [{ type: 'unknown-extensible', weird: true }],
  ],
  tools: [
    [],
    [{ name: 'x', description: 'y' }],
    [{ name: 'mcp__github__issue_write', description: 'w', parameters: { type: 'object', properties: {} } }],
    [{ name: 'a' }, { name: 'b', description: 'z' }],
  ],
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'prompt' }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'tool', content: [{ type: 'tool-result', text: 'ok' }] },
    { role: 'assistant', content: [] },
  ],
};

await check('every formula agrees with the context panel on the same inputs', () => {
  for (const text of SAMPLES.texts) assert.equal(mine.estimateText(text), panel.estimateText(text), `estimateText(${JSON.stringify(text)})`);
  for (const blocks of SAMPLES.blocks) assert.equal(mine.estimateContent(blocks), panel.estimateContent(blocks), `estimateContent(${JSON.stringify(blocks)})`);
  for (const tools of SAMPLES.tools) assert.equal(mine.estimateToolsTokens(tools), panel.estimateToolsTokens(tools), `estimateToolsTokens(${JSON.stringify(tools)})`);
  for (const message of SAMPLES.messages) assert.equal(mine.estimateMessage(message), panel.estimateMessage(message), `estimateMessage(${JSON.stringify(message)})`);
});

await check('the golden tool-schema price is the documented number', () => {
  // `[{"name":"x","description":"y"}]` is 32 characters → 32/4 = 8, plus one
  // BLOCK_OVERHEAD. Pinned so a change to BOTH copies is still caught.
  assert.equal(mine.estimateToolsTokens([{ name: 'x', description: 'y' }]), 12);
});

await check('toolTokensFor prices one tool exactly as the panel prices it', () => {
  const schema = { name: 'mcp__github__issue_write', description: 'write an issue', parameters: { type: 'object' } };
  assert.equal(toolTokensFor(schema), panel.estimateToolsTokens([schema]));
});

await check('an unserializable schema prices as zero instead of throwing', () => {
  const cyclic = { name: 'loop' };
  cyclic.self = cyclic;
  assert.equal(toolTokensFor(cyclic), 0);
});

// ---------------------------------------------------------------- fake world ---

const SCHEMAS = [
  { name: 'mcp__github__issue_write', description: 'write an issue', parameters: { type: 'object' } },
  { name: 'mcp__github__pull_request_read', description: 'read a PR', parameters: { type: 'object' } },
  { name: 'mcp__local__echo', description: 'echo', parameters: { type: 'object' } },
  { name: 'read', description: 'builtin', parameters: { type: 'object' } },
];

const PLUGINS = [
  { patchId: 'github-mcp', entryId: 'github-mcp', enabled: true, fiberPhase: 'active' },
  {
    patchId: 'local-echo',
    entryId: 'local-echo',
    enabled: false,
    fiberPhase: 'pending',
    config: { serverName: 'local', transport: 'stdio', command: 'npx', args: ['-y', 'echo'] },
  },
];

const CONFIGURATION = [
  {
    entry: { options: { id: 'github-mcp' } },
    inherited: {
      serverName: 'github',
      transport: 'streamable-http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: 'Bearer super-secret-token' },
    },
    override: {},
  },
];

function world(overrides = {}) {
  const calls = { edits: [], enabled: [] };
  // Mutable, like the real loader: a toggle must show up in the next status.
  let plugins = (overrides.plugins ?? PLUGINS).map((plugin) => ({ ...plugin }));
  const ctx = {
    get: (name) => {
      if (name === 'pluginManager') {
        return {
          listPlugins: async () => plugins,
          setPluginEnabled: async (entryId, enabled) => {
            calls.enabled.push({ entryId, enabled });
            plugins = plugins.map((plugin) => (plugin.patchId === entryId ? { ...plugin, enabled } : plugin));
          },
        };
      }
      if (name === 'configEditor') {
        return {
          configuration: () => overrides.configuration ?? CONFIGURATION,
          entries: () => [],
          edit: async (entry, next) => { calls.edits.push({ entryId: entry.options.id, config: next() }); },
        };
      }
      if (name === 'tools') {
        return { schemas: (agent) => (overrides.noAgents === true ? [] : (overrides.schemas ?? SCHEMAS)) };
      }
      if (name === 'agents') return { list: () => (overrides.noAgents === true ? [] : [{ id: 'a1' }]) };
      if (name === 'skills') {
        return 'skills' in overrides
          ? overrides.skills
          : { list: async () => [], get: async () => undefined };
      }
      return undefined;
    },
    logger: { warn: () => {}, info: () => {} },
  };
  const host = createMcpSkills({ ctx, logger: ctx.logger, cwd: overrides.cwd });
  return { host, calls };
}

/** Minimal Request stand-in: what the routes actually read. */
function get(url) {
  return { method: 'GET', url, json: async () => { throw new Error('no body'); } };
}
function post(url, body) {
  return { method: 'POST', url, json: async () => body };
}

async function bodyOf(response, expectedStatus = 200) {
  assert.equal(response.status, expectedStatus);
  return response.json();
}

// ------------------------------------------------------------------ MCP rows ---

await check('rows list the running servers, sorted, with their tool counts', async () => {
  const { host } = world();
  const body = await bodyOf(await host.route(ROUTES.status, get(`http://x${ROUTES.status}`)));
  assert.deepEqual(body.mcp.rows.map((row) => row.serverName), ['github', 'local']);
  const [github, local] = body.mcp.rows;
  assert.equal(github.toolCount, 2);
  assert.equal(github.transport, 'streamable-http');
  assert.equal(github.endpoint, 'https://api.githubcopilot.com/mcp/');
  assert.deepEqual(github.tools.map((tool) => tool.name), ['issue_write', 'pull_request_read']);
  assert.equal(local.toolCount, 1);
  assert.equal(local.endpoint, 'npx -y echo');
  assert.equal(local.editable, false);
});

await check('a row carries what its tools cost in context', async () => {
  const { host } = world();
  const body = await bodyOf(await host.route(ROUTES.status, get(`http://x${ROUTES.status}`)));
  const [github, local] = body.mcp.rows;
  const expected = toolTokensFor(SCHEMAS[0]) + toolTokensFor(SCHEMAS[1]);
  assert.equal(github.toolTokens, expected);
  assert.ok(github.toolTokens > 0);
  assert.equal(local.toolTokens, toolTokensFor(SCHEMAS[2]));
  assert.equal(body.mcp.toolTokens, expected + toolTokensFor(SCHEMAS[2]));
  assert.equal(body.mcp.toolTotal, 3);
  // The built-in tool belongs to no MCP server.
  assert.equal(github.tools.some((tool) => tool.name === 'read'), false);
});

await check('the summary cost is the sum of the rows and nothing else', async () => {
  const { host } = world({ schemas: [] });
  const body = await bodyOf(await host.route(ROUTES.status, get(`http://x${ROUTES.status}`)));
  assert.equal(body.mcp.toolTotal, 0);
  assert.equal(body.mcp.toolTokens, 0);
  assert.deepEqual(body.mcp.rows.map((row) => row.toolTokens), [0, 0]);
});

await check('a host with no live agent reports rows without tools', async () => {
  const { host } = world({ noAgents: true });
  const body = await bodyOf(await host.route(ROUTES.status, get(`http://x${ROUTES.status}`)));
  assert.deepEqual(body.mcp.rows.map((row) => row.toolCount), [0, 0]);
  assert.deepEqual(body.mcp.rows.map((row) => row.toolTokens), [0, 0]);
});

// ----------------------------------------------------------------- ownership ---

await check('the ownership map names github-mcp', () => {
  assert.equal(ROW_OWNERS['github-mcp'], 'dsh-github');
});

await check('a row another bundle owns is labelled, a profile row is not', async () => {
  const { host } = world();
  const body = await bodyOf(await host.route(ROUTES.status, get(`http://x${ROUTES.status}`)));
  assert.equal(body.mcp.rows[0].owner, 'dsh-github');
  assert.equal(body.mcp.rows[1].owner, null);
});

await check('reading an owned row says who owns it and hides the secret', async () => {
  const { host } = world();
  const body = await bodyOf(await host.route(ROUTES.mcpConfig, get(`http://x${ROUTES.mcpConfig}?patchId=github-mcp`)));
  assert.equal(body.ownedBy, 'dsh-github');
  assert.equal(body.config.headers.Authorization, REDACTED);
  assert.ok(!body.text.includes('super-secret-token'));
});

await check('saving an owned row keeps the stored secret it never received', async () => {
  const { host, calls } = world();
  const read = await bodyOf(await host.route(ROUTES.mcpConfig, get(`http://x${ROUTES.mcpConfig}?patchId=github-mcp`)));
  const saved = await bodyOf(await host.route(ROUTES.mcpConfig, post(`http://x${ROUTES.mcpConfig}`, {
    patchId: 'github-mcp',
    config: { ...read.config, readOnly: true },
  })));
  assert.equal(saved.ok, true);
  assert.equal(calls.edits.length, 1);
  assert.equal(calls.edits[0].entryId, 'github-mcp');
  assert.equal(calls.edits[0].config.headers.Authorization, 'Bearer super-secret-token');
  assert.equal(calls.edits[0].config.readOnly, true);
});

await check('a row this profile owns reads back without an owner', async () => {
  const { host } = world();
  const body = await bodyOf(await host.route(ROUTES.mcpConfig, get(`http://x${ROUTES.mcpConfig}?patchId=local-echo`)), 404);
  assert.equal(body.reason, 'not-found');
});

// -------------------------------------------------------------------- actions ---

await check('toggling a row calls the plugin manager with the entry id', async () => {
  const { host, calls } = world();
  const body = await bodyOf(await host.route(ROUTES.mcpToggle, post(`http://x${ROUTES.mcpToggle}`, {
    entryId: 'github-mcp',
    enabled: false,
  })));
  assert.equal(body.ok, true);
  assert.deepEqual(calls.enabled, [{ entryId: 'github-mcp', enabled: false }]);
  assert.equal(body.status.mcp.enabled, 0);
  assert.equal(body.status.mcp.disabled, 2);
});

await check('a toggle without an entry id is refused before touching anything', async () => {
  const { host, calls } = world();
  const body = await bodyOf(await host.route(ROUTES.mcpToggle, post(`http://x${ROUTES.mcpToggle}`, { enabled: true })), 400);
  assert.equal(body.reason, 'bad-request');
  assert.equal(calls.enabled.length, 0);
});

// --------------------------------------------------------------------- pure ---

await check('isMcpConfig accepts the MCP client shape only', () => {
  assert.equal(isMcpConfig({ serverName: 'github', url: 'https://x' }), true);
  assert.equal(isMcpConfig({ serverName: 'local', transport: 'stdio', command: 'npx' }), true);
  assert.equal(isMcpConfig({ serverName: '', url: 'https://x' }), false);
  assert.equal(isMcpConfig({ url: 'https://x' }), false);
  assert.equal(isMcpConfig(null), false);
});

await check('redaction and restore are inverses around a placeholder', () => {
  const stored = { headers: { Authorization: 'Bearer t', 'x-trace': 'keep' }, nested: [{ token: 'abc' }] };
  const masked = redactSecrets(stored);
  assert.equal(masked.headers.Authorization, REDACTED);
  assert.equal(masked.headers['x-trace'], 'keep');
  assert.equal(masked.nested[0].token, REDACTED);
  const incoming = { headers: { Authorization: REDACTED, 'x-trace': 'changed' }, nested: [{ token: REDACTED }] };
  const restored = restoreSecrets(stored, incoming);
  assert.equal(restored.headers.Authorization, 'Bearer t');
  assert.equal(restored.headers['x-trace'], 'changed');
  assert.equal(restored.nested[0].token, 'abc');
});

await check('the skills page reports an empty registry without failing', async () => {
  const { host } = world();
  const payload = await host.skillsPayload();
  assert.deepEqual(payload.items, []);
  assert.equal(payload.error, null);
});

await check('the skills page surfaces an unavailable registry in words', async () => {
  const { host } = world({ skills: undefined });
  const payload = await host.skillsPayload();
  assert.deepEqual(payload.items, []);
  assert.ok(typeof payload.error === 'string' && payload.error.includes('技能'));
});

// ------------------------------------------------------------------ summary ---

if (failures.length > 0) {
  console.error(`host-test: ${String(failures.length)} failed, ${String(passed)} passed`);
  for (const failure of failures) console.error(`  x ${failure}`);
  process.exit(1);
}
console.log(`host-test: ${String(passed)}/${String(passed)} passed`);
