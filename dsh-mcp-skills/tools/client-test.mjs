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
  useRef: (initial) => ({ current: initial }),
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
  mcpToggleLabel: '{name}：启用 MCP 服务器',
  skillToggleLabel: '{name}：模型可调用',
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
  const toggle = elementsOf(tree).find((node) => node.props?.role === 'switch');
  assert.ok(toggle !== undefined, 'expected a control with an onClick');
  toggle.props.onClick();
  assert.deepEqual(calls, [{ entryId: 'github-mcp', next: false }]);
});

check('MCP switches expose an explicit name and current state', () => {
  const tree = client.McpRow({ row: mcpRow(), t, busy: false, onToggle: () => {}, onEdit: () => {} });
  const toggle = elementsOf(tree).find((node) => node.props?.role === 'switch');
  assert.equal(toggle.props.type, 'button');
  assert.equal(toggle.props['aria-label'], 'github：启用 MCP 服务器');
  assert.equal(toggle.props['aria-checked'], true);
});

check('skill switches are named and disabled controls do not dispatch', () => {
  const calls = [];
  const tree = client.SkillRow({
    item: { name: 'test-skill', description: 'desc', path: 'C:\\skills\\test-skill\\SKILL.md', modelInvocable: false, userInvocable: true, source: 'user-dsh', provider: '' },
    t, busy: true, onToggle: (...args) => calls.push(args), onView: () => {},
  });
  const toggle = elementsOf(tree).find((node) => node.props?.role === 'switch');
  assert.equal(toggle.props['aria-label'], 'test-skill：模型可调用');
  assert.equal(toggle.props['aria-checked'], false);
  assert.equal(toggle.props.disabled, true);
  toggle.props.onClick();
  assert.equal(calls.length, 0);
  const view = elementsOf(tree).find((node) => node.type === 'button' && textOf(node) === 't:skillView');
  assert.equal(view.props.disabled, true);
});

check('dialogs are titled, modal, and Escape closes without bubbling to settings', () => {
  let closed = 0;
  const tree = client.Modal({ id: 'test-dialog', title: 'A config', t, onClose: () => { closed += 1; }, children: 'body' });
  const dialog = elementsOf(tree).find((node) => node.props?.role === 'dialog');
  assert.equal(dialog.props['aria-modal'], true);
  assert.equal(dialog.props['aria-labelledby'], 'test-dialog-title');
  assert.ok(elementsOf(tree).some((node) => node.props.id === 'test-dialog-title' && textOf(node) === 'A config'));
  assert.equal(dialog.props.tabIndex, -1);
  let prevented = 0;
  let stopped = 0;
  const event = { key: 'Escape', preventDefault: () => { prevented += 1; }, stopPropagation: () => { stopped += 1; } };
  dialog.props.onKeyDown({ ...event, key: 'Enter' });
  assert.equal(closed, 0);
  dialog.props.onKeyDown(event);
  assert.deepEqual([closed, prevented, stopped], [1, 1, 1]);
});

check('dialog Tab boundaries contain focus and skip disabled or hidden controls', () => {
  const previousDocument = globalThis.document;
  const focused = [];
  const first = { tabIndex: 0, getClientRects: () => [1], focus: () => focused.push('first') };
  const last = { tabIndex: 0, getClientRects: () => [1], focus: () => focused.push('last') };
  const disabled = { ...first, disabled: true, focus: () => focused.push('disabled') };
  const hidden = { ...first, getClientRects: () => [], focus: () => focused.push('hidden') };
  const tree = client.Modal({ id: 'keyboard-dialog', title: 'title', t, onClose: () => {}, children: 'body' });
  const dialog = elementsOf(tree).find((node) => node.props?.role === 'dialog');
  const root = { querySelectorAll: () => [first, disabled, hidden, last], focus: () => focused.push('root') };
  dialog.props.ref.current = root;
  let prevented = 0;
  const tab = (active, shiftKey = false) => {
    globalThis.document = { activeElement: active };
    dialog.props.onKeyDown({ key: 'Tab', shiftKey, preventDefault: () => { prevented += 1; } });
  };
  try {
    tab(root); tab(last); tab(first, true); tab(root, true);
    assert.deepEqual(focused, ['first', 'first', 'last', 'last']);
    assert.equal(prevented, 4);
    tab(first);
    assert.equal(prevented, 4, 'normal interior navigation remains native');
    root.querySelectorAll = () => [];
    tab(root);
    assert.equal(focused.at(-1), 'root');
  } finally {
    globalThis.document = previousDocument;
  }
});

check('dialog mount focuses its surface and cleanup restores the connected opener', () => {
  const effects = [];
  const previousDocument = globalThis.document;
  let entered = 0;
  let restored = 0;
  const opener = { isConnected: true, focus: () => { restored += 1; } };
  const modalClient = captured.factory((id) => {
    if (id !== 'react') throw new Error(`unexpected require(${id})`);
    return { ...React, useEffect: (fn) => effects.push(fn) };
  });
  const tree = modalClient.Modal({ id: 'focus-dialog', title: 'title', t, onClose: () => {}, children: 'body' });
  const dialog = elementsOf(tree).find((node) => node.props?.role === 'dialog');
  dialog.props.ref.current = { focus: () => { entered += 1; } };
  try {
    globalThis.document = { activeElement: opener };
    const cleanup = effects[0]();
    assert.equal(entered, 1);
    cleanup();
    assert.equal(restored, 1);
    opener.isConnected = false;
    cleanup();
    assert.equal(restored, 1);
  } finally {
    globalThis.document = previousDocument;
  }
});

// Small stateful hook runner: shallow children keep the Panel hook order stable.
// This exercises the shipped handlers and deferred responses, not a duplicate model.
function panelRuntime() {
  const values = [];
  const dependencies = [];
  const cleanups = [];
  let effects = [];
  let cursor = 0;
  let writes = 0;
  const equalDeps = (left, right) => Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => value === right[index]);
  const hooks = {
    createElement: (type, props, ...children) => {
      const flat = children.flat(Infinity);
      const next = { ...(props ?? {}) };
      if (flat.length > 0) next.children = flat.length === 1 ? flat[0] : flat;
      return { type, props: next, children: next.children === undefined ? [] : [next.children].flat(Infinity) };
    },
    useState: (initial) => {
      const index = cursor++;
      if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial;
      return [values[index], (next) => { writes += 1; values[index] = typeof next === 'function' ? next(values[index]) : next; }];
    },
    useRef: (initial) => {
      const index = cursor++;
      if (!(index in values)) values[index] = { current: initial };
      return values[index];
    },
    useCallback: (fn, deps) => {
      const index = cursor++;
      if (!equalDeps(dependencies[index], deps)) { values[index] = fn; dependencies[index] = deps; }
      return values[index];
    },
    useEffect: (fn, deps) => {
      const index = cursor++;
      if (!equalDeps(dependencies[index], deps)) {
        dependencies[index] = deps;
        effects.push(() => { cleanups[index]?.(); cleanups[index] = fn(); });
      }
    },
  };
  const exports = captured.factory((id) => {
    if (id === 'react') return hooks;
    throw new Error(`unexpected require(${id})`);
  });
  return {
    client: exports,
    render: () => { cursor = 0; return exports.Panel({ ctx: {}, t }); },
    flushEffects: () => { const pending = effects; effects = []; for (const effect of pending) effect(); },
    unmount: () => { for (const cleanup of cleanups) cleanup?.(); },
    writes: () => writes,
  };
}

const fixtureStatus = () => ({
  mcp: { rows: [mcpRow({ owner: 'dsh-github' })], total: 1, enabled: 1, disabled: 0, toolTotal: 46, toolTokens: 12513 },
  skills: { items: [], total: 0, modelInvocable: 0, cwd: null, error: null },
});
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const deferred = () => {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
};
const modalOf = (tree, runtime) => elementsOf(tree).find((node) => node.type === runtime.client.Modal);
const saveOf = (modal) => elementsOf(modal).find((node) => typeof node.type === 'function' && node.type.name === 'Button' && node.props.kind === 'primary');
async function asyncCheck(label, fn) {
  try { await fn(); passed += 1; }
  catch (error) { failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
}

const originalFetch = globalThis.fetch;
try {
  await asyncCheck('JSON validation stays inside the open dialog and changing the draft clears it', async () => {
    let posts = 0;
    globalThis.fetch = async (url, init) => {
      if (url === client.ROUTE_STATUS) return jsonResponse(fixtureStatus());
      if (init?.method === 'POST') { posts += 1; return jsonResponse({ ok: true, status: fixtureStatus() }); }
      return jsonResponse({ ownedBy: 'dsh-github', text: '{}' });
    };
    const runtime = panelRuntime();
    runtime.render(); runtime.flushEffects(); await settle();
    const row = elementsOf(runtime.render()).find((node) => node.type === runtime.client.McpRow);
    await row.props.onEdit(row.props.row);
    let modal = modalOf(runtime.render(), runtime);
    elementsOf(modal).find((node) => node.type === 'textarea').props.onChange({ target: { value: '{' } });
    modal = modalOf(runtime.render(), runtime);
    saveOf(modal).props.onClick(); await settle();
    modal = modalOf(runtime.render(), runtime);
    assert.equal(posts, 0);
    const error = elementsOf(modal).find((node) => node.props?.role === 'alert');
    assert.equal(textOf(error), 't:badJson');
    const textarea = elementsOf(modal).find((node) => node.type === 'textarea');
    assert.equal(textarea.props['aria-invalid'], true);
    assert.equal(textarea.props['aria-describedby'], error.props.id);
    assert.equal(textarea.props['aria-label'], 't:configTitle');
    textarea.props.onChange({ target: { value: '{}' } });
    modal = modalOf(runtime.render(), runtime);
    assert.equal(elementsOf(modal).some((node) => node.props?.role === 'alert'), false);
    assert.equal(elementsOf(modal).find((node) => node.type === 'textarea').props['aria-invalid'], undefined);
    runtime.unmount();
  });

  await asyncCheck('owned confirmation resets on edits and deferred save failure stays in the dialog', async () => {
    let posts = 0;
    const save = deferred();
    globalThis.fetch = async (url, init) => {
      if (url === client.ROUTE_STATUS) return jsonResponse(fixtureStatus());
      if (init?.method === 'POST') { posts += 1; return save.promise; }
      return jsonResponse({ ownedBy: 'dsh-github', text: '{}' });
    };
    const runtime = panelRuntime();
    runtime.render(); runtime.flushEffects(); await settle();
    const row = elementsOf(runtime.render()).find((node) => node.type === runtime.client.McpRow);
    await row.props.onEdit(row.props.row);
    let modal = modalOf(runtime.render(), runtime);
    assert.equal(textOf(saveOf(modal)), 't:save');
    saveOf(modal).props.onClick(); await settle();
    modal = modalOf(runtime.render(), runtime);
    assert.equal(textOf(saveOf(modal)), 't:ownerConfirm');
    assert.equal(posts, 0);
    elementsOf(modal).find((node) => node.type === 'textarea').props.onChange({ target: { value: '{"readOnly":true}' } });
    modal = modalOf(runtime.render(), runtime);
    assert.equal(textOf(saveOf(modal)), 't:save');
    saveOf(modal).props.onClick(); await settle();
    assert.equal(posts, 0, 'a changed draft needs its own confirming click');
    modal = modalOf(runtime.render(), runtime);
    saveOf(modal).props.onClick(); await settle();
    modal = modalOf(runtime.render(), runtime);
    assert.equal(posts, 1);
    assert.equal(saveOf(modal).props.disabled, true);
    assert.equal(textOf(saveOf(modal)), 't:saving');
    save.resolve(jsonResponse({ message: 'save denied' }, 500)); await settle();
    modal = modalOf(runtime.render(), runtime);
    assert.ok(modal !== undefined);
    assert.equal(textOf(elementsOf(modal).find((node) => node.props?.role === 'alert')), 'save denied');
    assert.equal(saveOf(modal).props.disabled, false);
    runtime.unmount();
  });

  await asyncCheck('failed initial load stops showing loading and keeps a retry action', async () => {
    globalThis.fetch = async () => { throw new Error('offline'); };
    const runtime = panelRuntime();
    runtime.render(); runtime.flushEffects(); await settle();
    const tree = runtime.render();
    assert.ok(elementsOf(tree).some((node) => node.props?.role === 'alert'));
    assert.equal(elementsOf(tree).some((node) => node.props?.text === 't:loading'), false);
    assert.ok(elementsOf(tree).some((node) => typeof node.type === 'function' && node.type.name === 'Button' && textOf(node) === 't:refresh'));
    runtime.unmount();
  });

  await asyncCheck('a late config response does not write state after the panel unmounts', async () => {
    const config = deferred();
    globalThis.fetch = async (url) => url === client.ROUTE_STATUS ? jsonResponse(fixtureStatus()) : config.promise;
    const runtime = panelRuntime();
    runtime.render(); runtime.flushEffects(); await settle();
    const row = elementsOf(runtime.render()).find((node) => node.type === runtime.client.McpRow);
    const opening = row.props.onEdit(row.props.row);
    runtime.unmount();
    const before = runtime.writes();
    config.resolve(jsonResponse({ ownedBy: 'dsh-github', text: '{}' }));
    await opening;
    assert.equal(runtime.writes(), before);
  });
} finally {
  globalThis.fetch = originalFetch;
}

// ------------------------------------------------------------------ summary ---

if (failures.length > 0) {
  console.error(`client-test: ${String(failures.length)} failed, ${String(passed)} passed`);
  for (const failure of failures) console.error(`  x ${failure}`);
  process.exit(1);
}
console.log(`client-test: ${String(passed)}/${String(passed)} passed`);
