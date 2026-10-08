// Client-bundle tests: evaluate the REAL lib/client.js through a fake module
// loader and a minimal React stub, then assert what each piece renders and what
// the two-click save gate decides. No DOM, no browser, no build step.
//
// usage: node tools/client-test.mjs
import assert from 'node:assert/strict';

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

// ------------------------------------------------------------- module loader ---

let captured;
globalThis.window = { __ModuleLoader__: { load: (definition) => { captured = definition; } } };
await import(new URL('../lib/client.js', import.meta.url).href);

/** Minimal React: createElement builds a tree, hooks return their initial value. */
const React = {
  createElement: (type, props, ...children) => {
    const flat = children.flat(Infinity);
    const next = { ...(props ?? {}) };
    if (flat.length > 0) next.children = flat.length === 1 ? flat[0] : flat;
    const effective = Array.isArray(next.children)
      ? next.children.flat(Infinity)
      : next.children === undefined ? [] : [next.children];
    if (typeof type === 'function') return type(next);
    return { type, props: next, children: effective };
  },
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
};

const client = captured.factory((id) => {
  if (id === 'react') return React;
  throw new Error(`unexpected require(${id})`);
});

/** Every word a user can read. */
function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node === 'object' && node.props !== undefined) {
    const visible = [node.props.placeholder, node.props.title, node.props['aria-label']]
      .filter((value) => typeof value === 'string')
      .join(' ');
    return `${visible} ${textOf(node.children)}`.trim();
  }
  return textOf(node.children);
}

/** Every element in a rendered tree. */
function elementsOf(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child, out);
    return out;
  }
  if (node.type === undefined) return out;
  out.push(node);
  elementsOf(node.children, out);
  return out;
}

/**
 * Translator backed by the real dictionary entries this test cares about, so an
 * interpolated number is asserted as rendered copy rather than as a raw value.
 */
const COPY = {
  toolCount: '{count} 个',
  toolTokens: '约 {tokens} tok',
  ownerBadge: '由 {owner} 写入',
  enabled: '已启用',
  disabled: '已停用',
  phaseActive: '运行中',
};
const t = (key) => COPY[key] ?? `t:${key}`;

// ------------------------------------------------------------------ manifest ---

check('the bundle registers itself under its own id', () => {
  assert.equal(captured.id, 'dsh-mcp-skills');
  assert.equal(typeof captured.factory, 'function');
});

check('the plugin exports the shape the client loader expects', () => {
  assert.equal(client.name, 'dsh-mcp-skills');
  assert.deepEqual(client.inject, ['slots', 'locale']);
  assert.equal(typeof client.apply, 'function');
});

check('apply registers one settings section on the shared ladder', () => {
  const registrations = [];
  const injected = [];
  const context = {
    get: (key) => (key === 'slots' ? {
      inject: (slot, callback) => { injected.push(slot); callback(); },
      register: (options) => { registrations.push(options); },
    } : key === 'locale' ? { bind: () => t, register: () => () => {} } : undefined),
    effect: (fn) => { fn(); return () => {}; },
  };
  client.apply(context);
  assert.deepEqual(injected, ['settings.section']);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, 'mcp-skills');
  // 12 thinking-effort · 13 usage · 14 account-pool · 15 MCP & skills · 16 GitHub
  assert.equal(registrations[0].order, 15);
  assert.equal(registrations[0].locale, 'settings.mcpSkills');
});

// ------------------------------------------------------------------ helpers ---

check('formatTokens keeps small numbers exact and compacts thousands', () => {
  assert.equal(client.formatTokens(0), '0');
  assert.equal(client.formatTokens(undefined), '0');
  assert.equal(client.formatTokens(999), '999');
  assert.equal(client.formatTokens(1000), '1.0k');
  assert.equal(client.formatTokens(12513), '12.5k');
});

check('isOwnedRow only claims a row with a non-empty owner', () => {
  assert.equal(client.isOwnedRow({ owner: 'dsh-github' }), true);
  assert.equal(client.isOwnedRow({ owner: '' }), false);
  assert.equal(client.isOwnedRow({ owner: null }), false);
  assert.equal(client.isOwnedRow({}), false);
  assert.equal(client.isOwnedRow(null), false);
});

check('the save gate demands one confirming click for an owned row', () => {
  const owned = { owner: 'dsh-github' };
  const own = { owner: null };
  assert.equal(client.saveGate(own, false), 'save');
  assert.equal(client.saveGate(owned, false), 'confirm');
  assert.equal(client.saveGate(owned, undefined), 'confirm');
  assert.equal(client.saveGate(owned, true), 'save');
});

// --------------------------------------------------------------- MCP row UI ---

/** One status row as the Host half sends it. */
function mcpRow(overrides = {}) {
  return {
    patchId: 'github-mcp',
    entryId: 'github-mcp',
    enabled: true,
    phase: 'active',
    error: null,
    serverName: 'github',
    transport: 'streamable-http',
    endpoint: 'https://api.githubcopilot.com/mcp/',
    toolCount: 46,
    toolTokens: 12513,
    tools: [{ name: 'issue_write', fullName: 'mcp__github__issue_write', description: '' }],
    owner: null,
    editable: true,
    ...overrides,
  };
}

check('a server row shows its tool count and what those tools cost', () => {
  const text = textOf(client.McpRow({ row: mcpRow(), t, busy: false, onToggle: () => {}, onEdit: () => {} }));
  assert.ok(text.includes('46 个'), `expected the tool count in: ${text}`);
  assert.ok(text.includes('约 12.5k tok'), `expected the token estimate in: ${text}`);
});

check('a server with no tools shows no token estimate', () => {
  const text = textOf(client.McpRow({ row: mcpRow({ toolCount: 0, toolTokens: 0 }), t, busy: false, onToggle: () => {}, onEdit: () => {} }));
  assert.ok(!text.includes('tok'), `expected no estimate in: ${text}`);
});

check('a row another bundle owns is labelled with its owner', () => {
  const text = textOf(client.McpRow({ row: mcpRow({ owner: 'dsh-github' }), t, busy: false, onToggle: () => {}, onEdit: () => {} }));
  assert.ok(text.includes('由 dsh-github 写入'), `expected the owner badge in: ${text}`);
});

check('an unowned row carries no owner badge', () => {
  const text = textOf(client.McpRow({ row: mcpRow(), t, busy: false, onToggle: () => {}, onEdit: () => {} }));
  assert.ok(!text.includes('写入'), `expected no owner badge in: ${text}`);
});

check('the toggle hands the entry id and the wanted state to the page', () => {
  const calls = [];
  const tree = client.McpRow({
    row: mcpRow({ owner: 'dsh-github' }),
    t,
    busy: false,
    onToggle: (row, next) => { calls.push({ entryId: row.entryId, next }); },
    onEdit: () => {},
  });
  const toggle = elementsOf(tree).find((node) => node.type === 'button' && node.props?.onClick !== undefined
    && !String(textOf(node)).includes('t:'));
  assert.ok(toggle !== undefined, 'expected a control with an onClick');
  toggle.props.onClick();
  assert.deepEqual(calls, [{ entryId: 'github-mcp', next: false }]);
});

// ------------------------------------------------------------------ summary ---

if (failures.length > 0) {
  console.error(`client-test: ${String(failures.length)} failed, ${String(passed)} passed`);
  for (const failure of failures) console.error(`  x ${failure}`);
  process.exit(1);
}
console.log(`client-test: ${String(passed)}/${String(passed)} passed`);
