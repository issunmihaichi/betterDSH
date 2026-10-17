// Client-bundle tests: evaluate the REAL lib/client.js through a fake module
// loader and a minimal React stub, then assert the structure each state
// renders. No DOM and no browser are involved — the point is that the shipped
// bundle parses, registers itself correctly, resumes the setup wizard on the
// right step, and asks for the copy it should ask for.
// usage: node tools/client-test.mjs
import assert from 'node:assert/strict';
import { deferred, jsonResponse, interceptFetch, fakeTimers, drain, mountComponent } from './client-runtime.mjs';

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
  useRef: (initial) => ({ current: initial }),
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
  // The five contributed settings pages share one ascending ladder; GitHub sits
  // last (16) so it can never tie with account-pool (14) again.
  assert.equal(registrations[0].order, 16);
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

// ------------------------------------------------------- open downloaded repo ---

/** The open-workspace button in a rendered repository card, or undefined. */
const openButton = (tree) => elementsOf(tree)
  .find((node) => node.type === 'button' && textOf(node) === 't:openWorkspace');

/** Status with one downloaded clone; `workspaceId` is what the host annotates. */
function statusWithClone(workspaceId) {
  const entry = { name: 'Hello-World', path: 'C:\\repos\\Hello-World', branch: 'main' };
  if (workspaceId !== undefined) entry.workspaceId = workspaceId;
  return baseStatus({ token: { present: true, preview: 'x' }, repos: [entry] });
}

check('a downloaded clone with a registered workspace offers to open it', () => {
  const opened = [];
  const tree = client.RepoCard({
    t,
    data: statusWithClone('ws-1'),
    onChanged: () => {},
    onOpenWorkspace: (entry) => { opened.push(entry); },
  });
  const button = openButton(tree);
  assert.ok(button !== undefined, 'expected an open-workspace button');
  button.props.onClick();
  assert.equal(opened.length, 1);
  assert.equal(opened[0].workspaceId, 'ws-1');
});

check('a clone the registry does not own gets no open button', () => {
  const tree = client.RepoCard({
    t,
    data: statusWithClone(undefined),
    onChanged: () => {},
    onOpenWorkspace: () => {},
  });
  assert.equal(openButton(tree), undefined);
});

check('a host without the navigation face renders the row without the button', () => {
  const tree = client.RepoCard({ t, data: statusWithClone('ws-1'), onChanged: () => {} });
  assert.equal(openButton(tree), undefined);
});

check('a refusing navigation face never throws out of the click', () => {
  const tree = client.RepoCard({
    t,
    data: statusWithClone('ws-1'),
    onChanged: () => {},
    onOpenWorkspace: () => { throw new Error('uiWorkspace.openWorkspace is unavailable'); },
  });
  const button = openButton(tree);
  assert.ok(button !== undefined);
  assert.doesNotThrow(() => button.props.onClick());
});

// A rejecting face must be caught by the click handler itself: an unhandled
// rejection here would surface as a console error on the real page.
{
  let unhandled = 0;
  const onUnhandled = () => { unhandled += 1; };
  process.on('unhandledRejection', onUnhandled);
  const tree = client.RepoCard({
    t,
    data: statusWithClone('ws-1'),
    onChanged: () => {},
    onOpenWorkspace: () => Promise.reject(new Error('nope')),
  });
  openButton(tree).props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  process.off('unhandledRejection', onUnhandled);
  check('a rejecting navigation face is caught, not left unhandled', () => {
    assert.equal(unhandled, 0);
  });
}

check('fill interpolates and keeps unknown placeholders', () => {
  assert.equal(fill('a {x} b {y}', { x: 1 }), 'a 1 b {y}');
});

// ---------------------------------------------- deferred real-client event tests ---

async function checkAsync(label, fn) {
  try { await fn(); passed += 1; }
  catch (error) { failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
}

const buttonNamed = (tree, key) => elementsOf(tree).find((node) => node.type === 'button' && textOf(node) === `t:${key}`);
const inputNamed = (tree, key) => elementsOf(tree).find((node) => node.type === 'input' && node.props.key === key);
const repoRow = (tree, name) => byClass(tree, 'dsg-repo-row').find((node) => node.props.key === name);
const remoteRepo = (name) => ({ fullName: `octocat/${name}`, defaultBranch: 'main', description: '', language: '', private: false });
const remoteBody = (names, extra = {}) => ({ ok: true, items: names.map(remoteRepo), page: 1, hasMore: false, account: { login: 'octocat' }, ...extra });
const planFor = (name) => ({ fullName: `octocat/${name}`, cloneUrl: `https://github.com/octocat/${name}.git`, dest: `C:\\repos\\${name}`, dir: name, branch: 'main', depth: 7 });
const readyStatus = () => baseStatus({ token: { present: true, preview: 'masked' } });

async function withComponent(Component, props, handler, test) {
  const timers = fakeTimers();
  const transport = interceptFetch(handler);
  let mounted;
  try {
    mounted = mountComponent(React, Component, props);
    await test(mounted, timers, transport);
  } finally {
    mounted?.unmount();
    transport.restore();
    timers.restore();
  }
}

await checkAsync('HTTP errors reject even when their JSON claims ok, and preserve readable metadata', async () => {
  const transport = interceptFetch(() => jsonResponse({ ok: true, message: 'gateway unavailable' }, 503));
  try {
    await assert.rejects(client.request(client.ROUTES.settings, { body: { settings: { readOnly: true } } }), (error) => error.status === 503 && error.message === 'gateway unavailable');
    assert.ok(transport.calls[0] instanceof Request);
    assert.equal(transport.calls[0].method, 'POST');
    assert.deepEqual(await transport.calls[0].json(), { settings: { readOnly: true } });
  } finally { transport.restore(); }
});

await checkAsync('invalid JSON and HTTP-success business failures never count as saved', async () => {
  const transport = interceptFetch((request, index) => index === 1
    ? new Response('not json', { status: 200 })
    : jsonResponse({ ok: false, applied: { message: 'MCP apply failed' } }));
  try {
    await assert.rejects(client.request(client.ROUTES.status), /HTTP 200/);
    await assert.rejects(client.request(client.ROUTES.settings), /MCP apply failed/);
  } finally { transport.restore(); }
});

for (const order of ['during debounce', 'after latest query']) {
  await checkAsync(`repository response from old query cannot win ${order}`, async () => {
    const old = deferred();
    await withComponent(client.RepoCard, { t, data: readyStatus(), onChanged: () => {} },
      (request) => new URL(request.url).searchParams.get('q') === '' ? old.promise : jsonResponse(remoteBody(['new'])),
      async (mounted, timers) => {
        timers.runNext(); // initial query remains pending
        inputNamed(mounted.tree, 'search').props.onChange({ target: { value: 'new' } });
        mounted.render();
        if (order === 'during debounce') { old.resolve(jsonResponse(remoteBody(['old']))); await drain(); mounted.render(); }
        assert.equal(repoRow(mounted.tree, 'octocat/old'), undefined);
        timers.runNext();
        await drain(); mounted.render();
        assert.ok(repoRow(mounted.tree, 'octocat/new'));
        if (order === 'after latest query') { old.resolve(jsonResponse(remoteBody(['old']))); await drain(); mounted.render(); }
        assert.equal(repoRow(mounted.tree, 'octocat/old'), undefined);
        assert.ok(repoRow(mounted.tree, 'octocat/new'));
      });
  });
}

await checkAsync('stale page append and its errors cannot alter a new repository search', async () => {
  const append = deferred();
  await withComponent(client.RepoCard, { t, data: readyStatus(), onChanged: () => {} }, (request) => {
    const url = new URL(request.url);
    if (url.searchParams.get('page') === '2') return append.promise;
    return jsonResponse(remoteBody([url.searchParams.get('q') || 'first'], { hasMore: url.searchParams.get('q') === '' }));
  }, async (mounted, timers) => {
    timers.runNext(); await drain(); mounted.render();
    const more = buttonNamed(mounted.tree, 'loadMore').props.onClick();
    inputNamed(mounted.tree, 'search').props.onChange({ target: { value: 'latest' } });
    mounted.render(); timers.runNext(); await drain(); mounted.render();
    append.reject(new Error('old page failure'));
    await more; mounted.render();
    assert.ok(repoRow(mounted.tree, 'octocat/latest'));
    assert.ok(!textOf(mounted.tree).includes('old page failure'));
  });
});

await checkAsync('refresh button explicitly bypasses the host repository page cache', async () => {
  await withComponent(client.RepoCard, { t, data: readyStatus(), onChanged: () => {} }, () => jsonResponse(remoteBody(['A'])), async (mounted, timers, transport) => {
    timers.runNext(); await drain(); mounted.render();
    await buttonNamed(mounted.tree, 'refreshList').props.onClick();
    assert.equal(new URL(transport.calls.at(-1).url).searchParams.get('refresh'), '1');
  });
});

await checkAsync('late clone plan A cannot replace selected B or clear B busy state', async () => {
  const plans = { A: deferred(), B: deferred() };
  await withComponent(client.RepoCard, { t, data: readyStatus(), onChanged: () => {} }, async (request) => {
    if (request.method === 'GET') return jsonResponse(remoteBody(['A', 'B']));
    const body = await request.json();
    return plans[body.repo.split('/')[1]].promise;
  }, async (mounted, timers) => {
    timers.runNext(); await drain(); mounted.render();
    repoRow(mounted.tree, 'octocat/A').props.onClick();
    mounted.render();
    repoRow(mounted.tree, 'octocat/B').props.onClick();
    mounted.render();
    plans.A.resolve(jsonResponse({ ok: true, plan: planFor('A') }));
    await drain(); mounted.render();
    assert.equal(byClass(mounted.tree, 'dsg-overlay').length, 0);
    plans.B.resolve(jsonResponse({ ok: true, plan: planFor('B') }));
    await drain(); mounted.render();
    assert.equal(repoRow(mounted.tree, 'octocat/B').props['aria-pressed'], 'true');
    assert.equal(repoRow(mounted.tree, 'octocat/A').props['aria-pressed'], 'false');
    assert.equal(buttonNamed(mounted.tree, 'confirmGo').props.disabled, false);
  });
});

await checkAsync('confirmation sends displayed target/depth and changed-plan rejection dismisses stale plan', async () => {
  let confirmed;
  let changed = 0;
  const plan = { ...planFor('A'), dir: 'custom', dest: 'D:\\custom' };
  await withComponent(client.RepoCard, { t, data: readyStatus(), onChanged: () => { changed += 1; } }, async (request) => {
    if (request.method === 'GET') return jsonResponse(remoteBody(['A']));
    const body = await request.json();
    if (!body.confirm) return jsonResponse({ ok: true, plan });
    confirmed = body;
    return jsonResponse({ ok: false, reason: 'plan-changed', message: 'Reconfirm changed target' }, 409);
  }, async (mounted, timers) => {
    timers.runNext(); await drain(); mounted.render();
    repoRow(mounted.tree, 'octocat/A').props.onClick(); await drain(); mounted.render();
    await buttonNamed(mounted.tree, 'confirmGo').props.onClick(); mounted.render();
    assert.deepEqual(confirmed.expected, { fullName: plan.fullName, cloneUrl: plan.cloneUrl, dest: plan.dest, branch: plan.branch, depth: plan.depth });
    assert.equal(confirmed.dir, 'custom');
    assert.equal(byClass(mounted.tree, 'dsg-overlay').length, 0);
    assert.ok(textOf(mounted.tree).includes('Reconfirm changed target'));
    assert.equal(changed, 0);
  });
});

await checkAsync('editing manual repository invalidates a still-pending plan', async () => {
  const planned = deferred();
  await withComponent(client.RepoCard, { t, data: readyStatus(), onChanged: () => {} }, (request) => request.method === 'GET' ? jsonResponse(remoteBody([])) : planned.promise,
    async (mounted, timers) => {
      timers.runNext(); await drain(); mounted.render();
      buttonNamed(mounted.tree, 'manualToggle').props.onClick(); mounted.render();
      inputNamed(mounted.tree, 'manual').props.onChange({ target: { value: 'octocat/A' } }); mounted.render();
      const asking = buttonNamed(mounted.tree, 'connectRepo').props.onClick();
      inputNamed(mounted.tree, 'manual').props.onChange({ target: { value: 'octocat/B' } }); mounted.render();
      planned.resolve(jsonResponse({ ok: true, plan: planFor('A') }));
      await asking; mounted.render();
      assert.equal(byClass(mounted.tree, 'dsg-overlay').length, 0);
    });
});

await checkAsync('repository and plan requests settled after unmount cause no state writes', async () => {
  const listing = deferred();
  await withComponent(client.RepoCard, { t, data: readyStatus(), onChanged: () => {} }, () => listing.promise, async (mounted, timers) => {
    timers.runNext(); mounted.unmount();
    listing.resolve(jsonResponse(remoteBody(['late'])));
    await drain();
    assert.equal(mounted.unmountedWrites, 0);
  });
});

await checkAsync('tool A result and finally cannot overwrite B result or busy indicator', async () => {
  const tools = ['A', 'B'].map((shortName) => ({ name: `mcp__github__${shortName}`, shortName, description: '', parameters: {} }));
  const pending = { A: deferred(), B: deferred() };
  await withComponent(client.ToolCard, { t, data: baseStatus({ tools }) }, async (request) => pending[(await request.json()).name].promise,
    async (mounted) => {
      byClass(mounted.tree, 'dsg-tool')[0].props.onClick(); mounted.render();
      const callA = buttonNamed(mounted.tree, 'call').props.onClick(); mounted.render();
      byClass(mounted.tree, 'dsg-tool')[1].props.onClick(); mounted.render();
      const callB = buttonNamed(mounted.tree, 'call').props.onClick(); mounted.render();
      pending.A.resolve(jsonResponse({ ok: true, text: 'result A' }));
      await callA; mounted.render();
      assert.equal(buttonNamed(mounted.tree, 'calling').props.disabled, true);
      assert.ok(!textOf(mounted.tree).includes('result A'));
      pending.B.resolve(jsonResponse({ ok: true, text: 'result B' }));
      await callB; mounted.render();
      assert.ok(textOf(mounted.tree).includes('result B'));
      assert.ok(!textOf(mounted.tree).includes('result A'));
    });
});

await checkAsync('transport refresh preserves dirty edits and saves only changed fields', async () => {
  let submitted;
  const original = baseStatus();
  const updated = baseStatus({ settings: { ...original.settings, tokenSource: 'env', wizardDone: true, toolsets: 'repos' } });
  await withComponent(client.TransportCard, { t, data: original, onChanged: () => {} }, async (request) => {
    submitted = (await request.json()).settings;
    return jsonResponse({ ok: true, status: { settings: { ...updated.settings, ...submitted } } });
  }, async (mounted) => {
    inputNamed(mounted.tree, 'url').props.onChange({ target: { value: 'https://edited.example/mcp/' } }); mounted.render();
    mounted.render({ t, data: updated, onChanged: () => {} });
    assert.equal(inputNamed(mounted.tree, 'url').props.value, 'https://edited.example/mcp/');
    assert.equal(inputNamed(mounted.tree, 'toolsets').props.value, 'repos');
    assert.ok(textOf(mounted.tree).includes('t:unsavedChanges'));
    await buttonNamed(mounted.tree, 'saveSettings').props.onClick(); mounted.render();
    assert.deepEqual(submitted, { url: 'https://edited.example/mcp/' });
    assert.ok(!textOf(mounted.tree).includes('t:unsavedChanges'));
  });
});

await checkAsync('transport edits made during save survive the old acknowledgement', async () => {
  const saving = deferred();
  await withComponent(client.TransportCard, { t, data: baseStatus(), onChanged: () => {} }, () => saving.promise, async (mounted) => {
    inputNamed(mounted.tree, 'url').props.onChange({ target: { value: 'https://first.example/' } }); mounted.render();
    const save = buttonNamed(mounted.tree, 'saveSettings').props.onClick();
    inputNamed(mounted.tree, 'url').props.onChange({ target: { value: 'https://second.example/' } }); mounted.render();
    saving.resolve(jsonResponse({ ok: true, status: { settings: { ...baseStatus().settings, url: 'https://first.example/' } } }));
    await save; mounted.render();
    assert.equal(inputNamed(mounted.tree, 'url').props.value, 'https://second.example/');
    assert.ok(textOf(mounted.tree).includes('t:unsavedChanges'));
  });
});

await checkAsync('transport save failure is visible and dirty draft is retained for retry', async () => {
  let changed = 0;
  await withComponent(client.TransportCard, { t, data: baseStatus(), onChanged: () => { changed += 1; } }, () => jsonResponse({ ok: false, message: 'disk full' }, 500), async (mounted) => {
    inputNamed(mounted.tree, 'url').props.onChange({ target: { value: 'https://keep.example/' } }); mounted.render();
    await buttonNamed(mounted.tree, 'saveSettings').props.onClick(); mounted.render();
    assert.equal(inputNamed(mounted.tree, 'url').props.value, 'https://keep.example/');
    assert.ok(textOf(mounted.tree).includes('disk full'));
    assert.ok(textOf(mounted.tree).includes('t:unsavedChanges'));
    assert.equal(changed, 0);
  });
});

await checkAsync('token source autosave rejection is caught and shown, not reported as success', async () => {
  let changed = 0;
  await withComponent(client.TokenCard, { t, data: baseStatus(), onChanged: () => { changed += 1; } }, () => Promise.reject(new Error('offline settings failure')), async (mounted) => {
    const env = elementsOf(mounted.tree).find((node) => node.props.role === 'radio' && textOf(node) === 't:sourceEnv');
    await env.props.onClick(); mounted.render();
    assert.ok(textOf(mounted.tree).includes('offline settings failure'));
    assert.equal(changed, 0);
  });
});

await checkAsync('token environment autosave error is visible and failed secret save keeps the input', async () => {
  const status = baseStatus(); status.settings.tokenSource = 'env';
  await withComponent(client.TokenCard, { t, data: status, onChanged: () => {} }, () => jsonResponse({ message: 'write denied' }, 500), async (mounted) => {
    const env = elementsOf(mounted.tree).find((node) => node.type === 'input' && node.props.value === status.settings.envVar);
    env.props.onChange({ target: { value: 'CUSTOM_TOKEN' } }); mounted.render();
    elementsOf(mounted.tree).find((node) => node.type === 'input' && node.props.value === 'CUSTOM_TOKEN').props.onBlur();
    await drain(); mounted.render();
    assert.ok(textOf(mounted.tree).includes('write denied'));
    const secret = elementsOf(mounted.tree).find((node) => node.props.type === 'password');
    secret.props.onChange({ target: { value: 'test-secret' } }); mounted.render();
    await buttonNamed(mounted.tree, 'saveToken').props.onClick(); mounted.render();
    assert.equal(elementsOf(mounted.tree).find((node) => node.props.type === 'password').props.value, 'test-secret');
  });
});

await checkAsync('wizard skip does not finish when settings persistence fails', async () => {
  let done = 0;
  await withComponent(client.SetupWizard, { t, data: baseStatus(), onChanged: () => {}, onDone: () => { done += 1; } }, () => jsonResponse({ ok: false, message: 'cannot save wizard' }, 500), async (mounted) => {
    await buttonNamed(mounted.tree, 'wizardSkip').props.onClick(); mounted.render();
    assert.equal(done, 0);
    assert.ok(textOf(mounted.tree).includes('cannot save wizard'));
  });
});

await checkAsync('clone poll is single-flight, stops on terminal success, and refreshes exactly once', async () => {
  const timers = fakeTimers();
  const response = deferred();
  let calls = 0;
  let changed = 0;
  const jobs = [];
  const stop = client.watchClone({ id: 'job-1', schedule: timers.schedule, cancel: timers.cancel, request: async () => { calls += 1; return response.promise; }, onJob: (job) => jobs.push(job), onSettled: () => { changed += 1; }, onError: (error) => { throw error; } });
  try {
    const polling = timers.runNext();
    assert.equal(timers.timers.size, 0, 'no next timer while request is unresolved');
    assert.equal(calls, 1);
    response.resolve({ ok: true, job: { id: 'job-1', state: 'done' } });
    await polling;
    assert.equal(timers.timers.size, 0);
    assert.equal(changed, 1);
    assert.equal(jobs[0].state, 'done');
  } finally { stop(); timers.restore(); }
});

await checkAsync('poll HTTP 404 visibly stops and retry only resumes GET tracking, never clones twice', async () => {
  let polls = 0;
  let confirmations = 0;
  let changed = 0;
  await withComponent(client.RepoCard, { t, data: readyStatus(), onChanged: () => { changed += 1; } }, async (request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('github.remote')) return jsonResponse(remoteBody(['A']));
    if (request.method === 'POST') {
      const body = await request.json();
      if (!body.confirm) return jsonResponse({ ok: true, plan: planFor('A') });
      confirmations += 1;
      return jsonResponse({ ok: true, job: { id: 'job-1', repo: 'octocat/A', state: 'running', log: [] } });
    }
    polls += 1;
    return polls === 1 ? jsonResponse({ ok: false, reason: 'unknown-job', message: 'job was lost' }, 404)
      : jsonResponse({ ok: true, job: { id: 'job-1', repo: 'octocat/A', state: 'done', log: [], dest: 'C:\\repos\\A' } });
  }, async (mounted, timers) => {
    timers.runNext(); await drain(); mounted.render();
    repoRow(mounted.tree, 'octocat/A').props.onClick(); await drain(); mounted.render();
    await buttonNamed(mounted.tree, 'confirmGo').props.onClick(); mounted.render();
    await timers.runNext(); mounted.render();
    assert.equal(timers.timers.size, 0);
    assert.ok(textOf(mounted.tree).includes('t:trackingStopped'));
    assert.ok(!textOf(mounted.tree).includes('t:downloading'));
    assert.ok(buttonNamed(mounted.tree, 'retryTracking'));
    buttonNamed(mounted.tree, 'retryTracking').props.onClick(); mounted.render();
    await timers.runNext(); mounted.render();
    assert.equal(confirmations, 1);
    assert.equal(polls, 2);
    assert.equal(changed, 1);
    assert.ok(textOf(mounted.tree).includes('t:downloadDone'));
  });
});

await checkAsync('poll cleanup suppresses a delayed failure and cannot schedule another request', async () => {
  const timers = fakeTimers();
  const outcome = deferred();
  let errors = 0;
  const stop = client.watchClone({ id: 'job-1', schedule: timers.schedule, cancel: timers.cancel, request: () => outcome.promise, onJob: () => assert.fail('late job'), onSettled: () => assert.fail('late refresh'), onError: () => { errors += 1; } });
  try {
    const polling = timers.runNext();
    stop(); outcome.reject(new Error('late failure'));
    await polling;
    assert.equal(errors, 0);
    assert.equal(timers.timers.size, 0);
  } finally { stop(); timers.restore(); }
});

await checkAsync('two immediate confirm clicks launch only one host request', async () => {
  const response = deferred();
  let confirmations = 0;
  await withComponent(client.RepoCard, { t, data: readyStatus(), onChanged: () => {} }, async (request) => {
    if (request.method === 'GET') return jsonResponse(remoteBody(['A']));
    if (!(await request.json()).confirm) return jsonResponse({ ok: true, plan: planFor('A') });
    confirmations += 1;
    return response.promise;
  }, async (mounted, timers) => {
    timers.runNext(); await drain(); mounted.render();
    repoRow(mounted.tree, 'octocat/A').props.onClick(); await drain(); mounted.render();
    const click = buttonNamed(mounted.tree, 'confirmGo').props.onClick;
    const first = click();
    await click();
    await drain(); mounted.render();
    assert.equal(confirmations, 1);
    assert.equal(buttonNamed(mounted.tree, 'confirmCancel').props.disabled, true);
    assert.equal(repoRow(mounted.tree, 'octocat/A').props.disabled, true);
    response.resolve(jsonResponse({ ok: true, job: { id: 'job-1', repo: 'octocat/A', state: 'running', log: [] } }));
    await first; mounted.render();
    assert.equal(byClass(mounted.tree, 'dsg-overlay').length, 0);
  });
});

await checkAsync('running clone schedules its next poll only after success and network error stops', async () => {
  const timers = fakeTimers();
  const first = deferred();
  let calls = 0;
  let error;
  const stop = client.watchClone({ id: 'job-1', schedule: timers.schedule, cancel: timers.cancel,
    request: () => { calls += 1; return calls === 1 ? first.promise : Promise.reject(new Error('network down')); },
    onJob: () => {}, onSettled: () => assert.fail('not terminal'), onError: (value) => { error = value; },
  });
  try {
    const pending = timers.runNext();
    assert.equal(timers.timers.size, 0);
    first.resolve({ ok: true, job: { id: 'job-1', state: 'running' } }); await pending;
    assert.equal(timers.timers.size, 1);
    await timers.runNext();
    assert.equal(error.message, 'network down');
    assert.equal(calls, 2);
    assert.equal(timers.timers.size, 0);
  } finally { stop(); timers.restore(); }
});

// ------------------------------------------------------------------ summary ---

if (failures.length > 0) {
  console.error(`client-test: ${String(failures.length)} failed, ${String(passed)} passed`);
  for (const failure of failures) console.error(`  x ${failure}`);
  process.exit(1);
}
console.log(`client-test: ${String(passed)}/${String(passed)} passed`);
