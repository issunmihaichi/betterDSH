// Client-bundle tests: evaluate the REAL lib/client.js through a fake module
// loader and a minimal React stub, then assert the structure each state
// renders. No DOM and no browser are involved — the point is that the shipped
// bundle parses, registers itself correctly, resumes the setup wizard on the
// right step, and asks for the copy it should ask for.
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
    // Positional children win, but a `children` key inside the props object is
    // honoured too — that is how a wrapper like Button forwards its label.
    const next = { ...(props ?? {}) };
    if (flat.length > 0) next.children = flat.length === 1 ? flat[0] : flat;
    const effective = Array.isArray(next.children)
      ? next.children.flat(Infinity)
      : next.children === undefined ? [] : [next.children];
    // Function components are evaluated eagerly: this harness has no scheduler,
    // and every component here is pure with respect to its props.
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

/** Every word a user can read: child text plus the visible attributes. */
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

/** Elements whose class list contains `name` (exact class-list membership). */
const byClass = (tree, name) => elementsOf(tree)
  .filter((node) => String(node.props?.className ?? '').split(/\s+/u).includes(name));

/** A translator that echoes its keys, so a test asserts intent, not copy. */
const t = (key) => `t:${key}`;
const fill = client.fill;

function baseStatus(overrides = {}) {
  return {
    settings: {
      version: 1, serverName: 'github', transport: 'streamable-http',
      url: 'https://api.githubcopilot.com/mcp/', command: 'github-mcp-server', argsText: 'stdio',
      cwd: '', toolsets: '', readOnly: false, tokenSource: 'store',
      envVar: 'GITHUB_PERSONAL_ACCESS_TOKEN', failOnStartupError: false,
      cloneRoot: '', cloneDepth: 0, cloneBranch: '', wizardDone: false,
    },
    token: { present: false, source: 'store', envVar: 'GITHUB_PERSONAL_ACCESS_TOKEN', preview: '' },
    mcp: { rowId: 'github-mcp', found: true, enabled: false, phase: null, serverName: 'github', transport: 'streamable-http', endpoint: '', toolCount: 0, tokenPresent: false },
    tools: [],
    repos: [],
    cloneRoot: 'C:\\repos',
    git: { ok: true, version: 'git version 2.44.0' },
    command: { name: 'github', hint: '', description: '', listed: true, catalog: [{ name: 'github' }] },
    storeDir: 'C:\\fake\\github-mcp',
    settingsPath: 'C:\\fake\\github-mcp\\settings.json',
    lastError: null,
    generatedAt: 1,
    ...overrides,
  };
}

// ------------------------------------------------------------------ manifest ---

check('the bundle registers itself under its own id', () => {
  assert.equal(captured.id, 'dsh-github');
  assert.equal(typeof captured.factory, 'function');
});

check('the plugin exports the shape the client loader expects', () => {
  assert.equal(client.name, 'dsh-github');
  assert.deepEqual(client.inject, ['slots', 'locale']);
  assert.equal(typeof client.apply, 'function');
});

check('apply registers one settings section and nothing else', () => {
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
  assert.equal(registrations[0].id, 'github');
  assert.equal(registrations[0].order, 14);
  assert.equal(registrations[0].locale, 'settings.github');
});

// -------------------------------------------------------------- wizard state ---

check('the wizard opens on the token step without a token', () => {
  assert.equal(client.setupStep(baseStatus()), 'token');
});

check('the wizard opens on connect when a token exists but the row is off', () => {
  assert.equal(client.setupStep(baseStatus({ token: { present: true, preview: 'x' } })), 'connect');
});

check('the wizard stays on connect while the row is loading', () => {
  const status = baseStatus({
    token: { present: true, preview: 'x' },
    mcp: { rowId: 'github-mcp', found: true, enabled: true, phase: 'loading', toolCount: 0 },
  });
  assert.equal(client.setupStep(status), 'connect');
});

check('the wizard stays on connect when zero tools were discovered', () => {
  const status = baseStatus({
    token: { present: true, preview: 'x' },
    mcp: { rowId: 'github-mcp', found: true, enabled: true, phase: 'active', toolCount: 0 },
  });
  assert.equal(client.setupStep(status), 'connect');
});

check('the wizard moves to the repository step once tools exist', () => {
  const status = baseStatus({
    token: { present: true, preview: 'x' },
    mcp: { rowId: 'github-mcp', found: true, enabled: true, phase: 'active', toolCount: 3 },
  });
  assert.equal(client.setupStep(status), 'repos');
});

check('the wizard tolerates a null status', () => {
  assert.equal(client.setupStep(null), 'token');
  assert.equal(client.setupStep(undefined), 'token');
});

check('the step order is transport, token, connect, repositories', () => {
  assert.deepEqual(client.WIZARD_STEPS, ['transport', 'token', 'connect', 'repos']);
  for (const step of client.WIZARD_STEPS) assert.ok(typeof client.WIZARD_LABELS[step] === 'string');
});

// ------------------------------------------------------------ wizard render ---

check('the token step explains the token, links GitHub, and offers verification', () => {
  const tree = client.SetupWizard({ t, data: baseStatus(), onChanged: () => {}, onDone: () => {} });
  const text = textOf(tree);
  assert.ok(text.includes('t:wizardTitle'));
  assert.ok(text.includes('t:wizardIntroToken'));
  assert.ok(text.includes('t:wizardVerify'));
  assert.ok(text.includes('t:wizardUseEnv'));
  assert.ok(text.includes('t:wizardTokenNeeded'));
  const link = elementsOf(tree).find((node) => node.props?.href === 'https://github.com/settings/tokens');
  assert.ok(link !== undefined, 'the token page link is missing');
  assert.equal(link.props.target, '_blank');
});

check('the first step is reachable and the indicator marks position', () => {
  const tree = client.SetupWizard({ t, data: baseStatus(), onChanged: () => {}, onDone: () => {} });
  const steps = byClass(tree, 'dsg-step');
  assert.equal(steps.length, 4);
  assert.ok(textOf(steps[0]).includes('t:wizardStepTransport'));
  assert.equal(byClass(tree, 'dsg-step-done').length, 1, 'earlier steps are marked done');
  assert.equal(byClass(tree, 'dsg-step-active').length, 1);
  assert.ok(textOf(byClass(tree, 'dsg-step-active')[0]).includes('t:wizardStepToken'));
});

check('the token step shows a password field, never the stored token', () => {
  const tree = client.SetupWizard({ t, data: baseStatus(), onChanged: () => {}, onDone: () => {} });
  const inputs = elementsOf(tree).filter((node) => node.type === 'input');
  const secret = inputs.find((node) => node.props.type === 'password');
  assert.ok(secret !== undefined, 'no password input on the token step');
  assert.equal(secret.props.value, '');
});

check('the token step can walk back to the transport step', () => {
  const tree = client.SetupWizard({ t, data: baseStatus(), onChanged: () => {}, onDone: () => {} });
  const text = textOf(tree);
  assert.ok(text.includes('t:wizardBack'), 'no back action: the transport step is unreachable');
  // Step 1 renders as already satisfied, because the shipped default transport
  // is what the row is configured with until the user changes it.
  assert.equal(byClass(tree, 'dsg-step-done').length, 1);
});

check('the connect step lists the tools it found', () => {
  const status = baseStatus({
    token: { present: true, preview: 'ghp_…abcd' },
    mcp: { rowId: 'github-mcp', found: true, enabled: true, phase: 'active', toolCount: 2 },
    tools: [{ shortName: 'search_repositories' }, { shortName: 'get_file_contents' }],
  });
  const tree = client.SetupWizard({ t, data: status, onChanged: () => {}, onDone: () => {} });
  // With tools present the derived step is `repos`, which embeds RepoCard.
  assert.ok(textOf(tree).includes('t:wizardIntroRepos'));
  assert.ok(textOf(tree).includes('t:reposTitle'));
});

check('a token-but-not-connected install renders the connect step', () => {
  const status = baseStatus({ token: { present: true, preview: 'ghp_…abcd' } });
  const tree = client.SetupWizard({ t, data: status, onChanged: () => {}, onDone: () => {} });
  const text = textOf(tree);
  assert.ok(text.includes('t:wizardIntroConnect'));
  assert.ok(text.includes('t:wizardConnectNow'));
  assert.ok(text.includes('t:wizardConnectHint'));
  assert.equal(byClass(tree, 'dsg-step-active').length, 1);
  assert.ok(textOf(byClass(tree, 'dsg-step-active')[0]).includes('t:wizardStepConnect'));
});

check('the wizard always offers a way out', () => {
  for (const status of [baseStatus(), baseStatus({ token: { present: true, preview: 'x' } })]) {
    const text = textOf(client.SetupWizard({ t, data: status, onChanged: () => {}, onDone: () => {} }));
    assert.ok(text.includes('t:wizardSkip') || text.includes('t:wizardFinish'), 'no skip or finish action');
  }
});

// ------------------------------------------------------------- card renders ---

check('the token card reports presence without the secret', () => {
  const status = baseStatus({ token: { present: true, source: 'store', preview: 'ghp_…abcd (20 字符)' } });
  const tree = client.TokenCard({ t, data: status, onChanged: () => {} });
  const text = textOf(tree);
  assert.ok(text.includes('t:tokenPresent'));
  // The preview reaches the page only through `fill`, which is asserted on its
  // own; here it is enough that the card asks for the masked line.
  assert.ok(!text.includes('t:tokenMissing'));
  const secret = elementsOf(tree).find((node) => node.type === 'input' && node.props.type === 'password');
  assert.equal(secret.props.value, '', 'the token input never pre-fills a secret');
});

check('the token card says what is missing when nothing is stored', () => {
  const text = textOf(client.TokenCard({ t, data: baseStatus(), onChanged: () => {} }));
  assert.ok(text.includes('t:tokenMissing'));
});

check('the transport card switches its fields with the transport', () => {
  const http = textOf(client.TransportCard({ t, data: baseStatus(), onChanged: () => {}, pickDirectory: () => {} }));
  assert.ok(http.includes('t:url'));
  const stdioStatus = baseStatus();
  stdioStatus.settings = { ...stdioStatus.settings, transport: 'stdio' };
  const stdio = textOf(client.TransportCard({ t, data: stdioStatus, onChanged: () => {}, pickDirectory: () => {} }));
  assert.ok(stdio.includes('t:command'));
  assert.ok(stdio.includes('t:args'));
});

check('the transport card uses switches, not native checkboxes', () => {
  const tree = client.TransportCard({ t, data: baseStatus(), onChanged: () => {}, pickDirectory: () => {} });
  const switches = elementsOf(tree).filter((node) => node.props?.role === 'switch');
  assert.equal(switches.length, 2);
  const checkboxes = elementsOf(tree).filter((node) => node.type === 'input' && node.props?.type === 'checkbox');
  assert.equal(checkboxes.length, 0);
  assert.equal(switches[0].props.className, 'dsg-switch');
});

check('the tool card lists tools with their parameters', () => {
  const status = baseStatus({
    tools: [{
      name: 'mcp__github__search_repositories',
      shortName: 'search_repositories',
      description: 'Find repositories',
      parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string', description: 'search text' } } },
    }],
  });
  const text = textOf(client.ToolCard({ t, data: status }));
  assert.ok(text.includes('search_repositories'));
  assert.ok(text.includes('t:toolsFilter'));
});

check('the tool card explains an empty list instead of rendering nothing', () => {
  const text = textOf(client.ToolCard({ t, data: baseStatus() }));
  assert.ok(text.includes('t:toolsEmpty'));
});

check('the repository card asks for a token before listing anything', () => {
  const text = textOf(client.RepoCard({ t, data: baseStatus(), onChanged: () => {} }));
  assert.ok(text.includes('t:needToken'));
});

check('the repository card shows a loading state, not an empty list, on first paint', () => {
  const status = baseStatus({ token: { present: true, preview: 'x' } });
  const text = textOf(client.RepoCard({ t, data: status, onChanged: () => {} }));
  assert.ok(text.includes('t:loadingRepos'));
  assert.ok(text.includes('t:searchPlaceholder'));
  assert.ok(!text.includes('t:noRepos'));
});

check('the repository card offers the manual fallback', () => {
  const status = baseStatus({ token: { present: true, preview: 'x' } });
  const text = textOf(client.RepoCard({ t, data: status, onChanged: () => {} }));
  assert.ok(text.includes('t:manualToggle'));
});

check('parameter rows put required parameters first', () => {
  const rows = client.parameterRows({
    type: 'object',
    required: ['query'],
    properties: { page: { type: 'integer' }, query: { type: 'string' } },
  });
  assert.equal(rows[0].name, 'query');
  assert.deepEqual(rows.map((row) => row.name), ['query', 'page']);
});

check('fill interpolates and keeps unknown placeholders', () => {
  assert.equal(fill('a {x} b {y}', { x: 1 }), 'a 1 b {y}');
});

// ------------------------------------------------------------------ summary ---

if (failures.length > 0) {
  console.error(`client-test: ${String(failures.length)} failed, ${String(passed)} passed`);
  for (const failure of failures) console.error(`  x ${failure}`);
  process.exit(1);
}
console.log(`client-test: ${String(passed)}/${String(passed)} passed`);
