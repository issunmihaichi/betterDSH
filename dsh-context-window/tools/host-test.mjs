// Offline tests for the Host half's classification: no DSH process, no network.
// The module under test is pure, so the estimator DSH injects at runtime is
// replaced with a deterministic stand-in (token price = name/text length).
// usage: node tools/host-test.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { MCP_PREFIX, classifySession, mcpCoordinates, skillCatalog, splitTools } from '../lib/classify.js';
import { CHARS_PER_TOKEN, estimateContent, estimateMessage, estimateText, estimateToolsTokens } from '../lib/estimate.js';

let passed = 0;
const failures = [];
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
};

const here = dirname(fileURLToPath(import.meta.url));
void here;
void join;

/** Deterministic stand-in for DSH's own estimator. */
const priceTools = (tools) => tools.reduce((sum, tool) => sum + String(tool.name).length, 0);
const priceContent = (blocks) => blocks.reduce((sum, block) => sum + String(block.text ?? '').length, 0);
const options = { maxItems: 2, priceTools, priceContent, roleOverhead: 4 };

console.log('pricing copy');

check('keeps the shipped density and framing constants', () => {
  assert.equal(CHARS_PER_TOKEN, 4);
  assert.equal(estimateText(''), 0);
  assert.equal(estimateText('abcd'), 1);
  assert.equal(estimateText('abcde'), 2);
});
check('prices a tool array as JSON plus framing, and nothing when empty', () => {
  assert.equal(estimateToolsTokens([]), 0);
  assert.equal(estimateToolsTokens(undefined), 0);
  assert.equal(estimateToolsTokens([{ a: 1 }]), Math.ceil('[{"a":1}]'.length / 4) + 4);
});
check('prices content blocks with per-block overhead', () => {
  assert.equal(estimateContent([{ type: 'text', text: 'abcd' }]), 1 + 4);
  assert.equal(estimateContent([{ type: 'tool-call', name: 'read', arguments: '{}' }]), 1 + 1 + 4);
  assert.equal(estimateContent([]), 0);
});
check('prices a message by role', () => {
  const text = [{ type: 'text', text: 'abcd' }];
  assert.equal(estimateMessage({ role: 'system', content: text }), 1 + 4);
  assert.equal(estimateMessage({ role: 'user', content: text }), 1 + 4 + 4);
  assert.equal(estimateMessage({ role: 'system', content: [] }), 0);
});

console.log('mcp naming');

check('the MCP namespace is the documented prefix', () => assert.equal(MCP_PREFIX, 'mcp__'));
check('splits a public MCP name into server and raw tool', () => {
  assert.deepEqual(mcpCoordinates('mcp__github__issue_write'), { server: 'github', rawName: 'issue_write' });
});
check('leaves a built-in tool unclassified', () => {
  assert.equal(mcpCoordinates('read'), undefined);
  assert.equal(mcpCoordinates(undefined), undefined);
});
check('keeps a raw name that itself contains the separator', () => {
  assert.deepEqual(mcpCoordinates('mcp__github__a__b'), { server: 'github', rawName: 'a__b' });
});
check('degrades gracefully on a name with no server part', () => {
  assert.deepEqual(mcpCoordinates('mcp__solo'), { server: '', rawName: 'solo' });
});

console.log('tool split');

const tools = [
  { name: 'mcp__github__issue_write' },
  { name: 'mcp__github__list_issues' },
  { name: 'mcp__fs__read' },
  { name: 'read' },
  { name: 'pwsh' },
];
const split = splitTools(tools, options);

check('counts both sides', () => {
  assert.equal(split.mcp.count, 3);
  assert.equal(split.system.count, 2);
});
check('prices each side and the whole array', () => {
  assert.equal(split.mcp.tokens, 24 + 24 + 13);
  assert.equal(split.system.tokens, 4 + 4);
  assert.equal(split.total, 24 + 24 + 13 + 4 + 4);
});
check('groups MCP tools by server, each with its own tool list', () => {
  assert.deepEqual(split.mcp.servers.map((row) => ({ server: row.server, count: row.count, tokens: row.tokens })), [
    { server: 'github', count: 2, tokens: 48 },
    { server: 'fs', count: 1, tokens: 13 },
  ]);
  assert.deepEqual(split.mcp.servers[0].items.map((item) => item.rawName), ['issue_write', 'list_issues']);
  assert.deepEqual(split.mcp.servers[1].items.map((item) => item.rawName), ['read']);
});
check('lists the heaviest tools first and caps the list without losing the count', () => {
  assert.deepEqual(split.mcp.items.map((item) => item.rawName), ['issue_write', 'list_issues']);
  assert.equal(split.mcp.items[0].server, 'github');
  assert.equal(split.mcp.items[0].tokens, 24);
  assert.equal(split.mcp.count, 3);
});
check('breaks price ties by name and omits MCP fields on built-ins', () => {
  assert.deepEqual(split.system.items.map((item) => item.name), ['pwsh', 'read']);
  assert.equal('server' in split.system.items[0], false);
});
check('an empty envelope classifies as empty', () => {
  const empty = splitTools(undefined, options);
  assert.equal(empty.total, 0);
  assert.equal(empty.mcp.count, 0);
  assert.equal(empty.system.count, 0);
});

console.log('skill catalog');

const catalogEvents = [
  { type: 'user/message', seq: 1, data: { role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } },
  {
    type: 'user/message',
    seq: 10,
    data: {
      role: 'user',
      content: [{ type: 'text', text: '<system-reminder>old</system-reminder>' }],
      source: { kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'old', description: 'gone' }] },
    },
  },
  {
    type: 'user/message',
    seq: 20,
    data: {
      role: 'user',
      content: [{ type: 'text', text: '<system-reminder>catalog</system-reminder>' }],
      source: {
        kind: 'skill-catalog',
        form: 'catalog',
        entries: [
          { name: 'pelican', description: 'draw a pelican' },
          { name: 'svg-tools', description: 'compose svg' },
          { name: 'zstd-log', description: 'decode logs' },
        ],
      },
    },
  },
];

check('takes the newest catalog, not the first', () => {
  const catalog = skillCatalog(catalogEvents, options);
  assert.equal(catalog.seq, 20);
  assert.equal(catalog.count, 3);
  assert.equal(catalog.update, false);
});
check('prices the catalog as DSH prices a user message', () => {
  const catalog = skillCatalog(catalogEvents, options);
  assert.equal(catalog.tokens, '<system-reminder>catalog</system-reminder>'.length + 4);
  assert.equal(catalog.chars, '<system-reminder>catalog</system-reminder>'.length);
});
check('prices each skill from its own catalog line, capped but counted', () => {
  const catalog = skillCatalog(catalogEvents, options);
  assert.equal(catalog.count, 3);
  assert.equal(catalog.items.length, 2);
  assert.deepEqual(catalog.items.map((item) => item.name), ['pelican', 'svg-tools']);
});
check('an update catalog is flagged', () => {
  const update = skillCatalog([{
    type: 'user/message',
    seq: 5,
    data: { content: [{ type: 'text', text: 'x' }], source: { kind: 'skill-catalog', update: true, entries: [] } },
  }], options);
  assert.equal(update.update, true);
  assert.equal(update.count, 0);
});
check('a session without a catalog reads null', () => {
  assert.equal(skillCatalog(catalogEvents.slice(0, 1), options), null);
  assert.equal(skillCatalog([], options), null);
});

console.log('session fold');

const sessionEvents = [
  { type: 'request/header', seq: 3, data: { header: { config: {}, tools: tools.slice(0, 2) } } },
  { type: 'request/context', seq: 4, data: { provider: 'localhost', model: 'm', contextWindow: 1000000 } },
  { type: 'request/header', seq: 9, data: { header: { config: {}, tools } } },
  ...catalogEvents.slice(2),
];
const payload = classifySession(sessionEvents, 'session-abc', { ...options, now: 1791 });

check('uses the newest request envelope', () => {
  assert.equal(payload.headerSeq, 9);
  assert.equal(payload.tools.total, 69);
});
check('carries the route capacity through', () => assert.equal(payload.contextWindow, 1000000));
check('is JSON-safe and stamped', () => {
  assert.equal(payload.sessionId, 'session-abc');
  assert.equal(payload.generatedAt, 1791);
  assert.equal(JSON.parse(JSON.stringify(payload)).tools.mcp.count, 3);
});
check('reports the `skill` tool itself next to the catalog', () => {
  const withSkillTool = classifySession([
    { type: 'request/header', seq: 1, data: { header: { config: {}, tools: [{ name: 'skill' }, { name: 'read' }] } } },
    ...catalogEvents.slice(2),
  ], 'session-skill', options);
  assert.equal(withSkillTool.skills.count, 3);
  assert.deepEqual(withSkillTool.skills.tool, { name: 'skill', tokens: 5 });
});
check('an empty log classifies without inventing anything', () => {
  const empty = classifySession([], 'session-empty', options);
  assert.equal(empty.tools.total, 0);
  assert.equal(empty.tools.mcp.count, 0);
  assert.equal(empty.skills, null);
  assert.equal(empty.contextWindow, undefined);
});

console.log(`\n${String(passed)} passed, ${String(failures.length)} failed`);
if (failures.length > 0) {
  console.log(failures.join('\n'));
  process.exit(1);
}
