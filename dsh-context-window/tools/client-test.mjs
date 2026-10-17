// Offline tests for the context-window client bundle: no browser, no React, no
// network. The bundle is loaded through a stubbed module loader; every panel
// component is a plain function returning createElement trees, so a tiny shim is
// enough to render one and assert on the resulting tree.
// usage: node tools/client-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, '..', 'lib', 'client.js');

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

// --- a minimal React stand-in: createElement plus the hooks the panel uses.
const flatten = (children) => children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false);
const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children: flatten(children) });
const reactShim = {
  createElement,
  useState: (initial) => [initial, () => {}],
  useRef: () => ({ current: null }),
  useEffect: () => {},
};
const reactDomShim = {
  createPortal: (node) => ({ type: 'portal', props: {}, children: [node] }),
};

// --- a minimal document stand-in, to observe the stylesheet injection.
const injected = [];
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: (tag) => injected.push(tag) },
  addEventListener: () => {},
  removeEventListener: () => {},
  body: {},
};

// --- load the bundle through the real DSH entry point.
let entry;
globalThis.window = { __ModuleLoader__: { load: (loaded) => { entry = loaded; } } };
await import(`${pathToFileURL(clientPath).href}?test=${String(Date.now())}`);
const mod = entry.factory((name) => {
  if (name === 'react') return reactShim;
  if (name === 'react-dom') return reactDomShim;
  throw new Error(`unexpected module: ${name}`);
});
const zhT = (key) => mod.dicts.zh[key];

/** Expand a tree, resolving function components, into one flat element list. */
const flat = (node) => {
  if (node === null || typeof node !== 'object') return [];
  const resolved = typeof node.type === 'function' ? node.type(node.props) : node;
  if (resolved === null || typeof resolved !== 'object') return [];
  return [resolved, ...resolved.children.flatMap(flat)];
};

/** Every string under one element, in tree order. */
const texts = (node) => flat(node).flatMap((element) => element.children.filter((child) => typeof child === 'string'));
const textOf = (node) => texts(node).join('|');
/** Elements carrying `className`, in tree order. */
const allByClass = (node, className) => flat(node).filter((element) => element.props.className === className);
const byClass = (node, className) => allByClass(node, className)[0];
/** Elements whose className contains `part` (rows carry a base plus a modifier). */
const byClassPart = (node, part) => flat(node).filter((element) => (element.props.className ?? '').includes(part));

console.log('context-window client bundle');

check('bundle registers its id', () => assert.equal(entry.id, 'dsh-context-window'));
check('exports the cordis plugin face', () => {
  assert.equal(mod.name, 'dsh-context-window');
  assert.deepEqual(mod.inject, ['slots', 'locale']);
  assert.equal(typeof mod.apply, 'function');
});
check('reads its classification from one loopback route', () => {
  assert.equal(mod.DETAIL_ROUTE, 'api/context-window.detail');
});
check('injects its own stylesheet once', () => {
  assert.equal(injected.length, 1);
  assert.equal(injected[0].dataset.plugin, 'dsh-context-window');
  for (const rule of ['.dcw-root{', '.dcw-trigger{', '.dcw-track{', '.dcw-fill{', '.dcw-panel{', '.dcw-bar{', '.dcw-section{', '.dcw-list{', '.dcw-entry{']) {
    assert.ok(injected[0].textContent.includes(rule), `stylesheet is missing ${rule}`);
  }
});
check('the section chevron matches the header chevron', () => {
  const css = injected[0].textContent;
  assert.ok(css.includes('.dcw-section .dcw-chevron svg{width:12px;height:12px}'), 'section chevrons must be 12px');
  assert.ok(!css.includes('.dcw-section .dcw-chevron{'), 'section chevrons must not carry their own offset');
});
check('the section list has a bounded, scrollable body', () => {
  const css = injected[0].textContent;
  assert.ok(css.includes('.dcw-list{') && css.includes('max-height:150px') && css.includes('overflow-y:auto'), 'a long entry list must scroll inside the panel');
  assert.ok(css.includes('margin:2px 0 4px 10px'), 'the list indent must stay tight');
});
check('rewrites its stylesheet on every module load', () => {
  const source = readFileSync(clientPath, 'utf8');
  assert.match(source, /tag\.textContent !== CSS/, 'CSS must be refreshed so an HMR reload cannot keep stale styles');
});
check('the popover keeps the shipped panel width', () => {
  assert.ok(injected[0].textContent.includes('width:min(264px,100vw - 24px)'), 'the popover should stay at the shipped 264px width');
});

console.log('pure helpers');

check('fill interpolates placeholders', () => {
  assert.equal(mod.fill('上下文已用 {percent}', { percent: '31%' }), '上下文已用 31%');
  assert.equal(mod.fill('{a} and {missing}', { a: 'x' }), 'x and {missing}');
});

check('formatCompact matches the design spelling', () => {
  assert.equal(mod.formatCompact(49), '49');
  assert.equal(mod.formatCompact(21500), '21.5k');
  assert.equal(mod.formatCompact(224700), '224.7k');
  assert.equal(mod.formatCompact(1000000), '1M');
  assert.equal(mod.formatCompact(0), '0');
  assert.equal(mod.formatCompact(Number.NaN), '0');
});

check('formatPercent keeps one decimal and rounds halves away from zero', () => {
  assert.equal(mod.formatPercent(0.226), '22.6%');
  assert.equal(mod.formatPercent(0.0215), '2.2%');
  assert.equal(mod.formatPercent(0), '0.0%');
});

check('occupancyOf needs numerator and capacity', () => {
  assert.equal(mod.occupancyOf(undefined), null);
  assert.equal(mod.occupancyOf({ pressureTokens: 10 }), null);
  assert.deepEqual(mod.occupancyOf({ projectedTokens: 306100, contextWindow: 1000000 }), {
    used: 306100,
    estimated: false,
    window: 1000000,
    percent: 31,
    share: 0.3061,
  });
});

check('zero upstream input uses the full composition instead of only the new messages', () => {
  const buckets = { messageTokens: 44022, toolsTokens: 18414, systemTokens: 2000 };
  const estimate = mod.occupancyOf({ pressureTokens: 0, projectedTokens: 1417, contextWindow: 200000 }, buckets);
  assert.equal(estimate.used, 64436);
  assert.equal(estimate.percent, 32);
  assert.equal(estimate.estimated, true);
  const composition = mod.compositionOf(buckets, estimate.window, null);
  assert.equal(composition.rows.reduce((sum, row) => sum + row.value, 0), estimate.used);
  assert.equal(composition.free + estimate.used, estimate.window);
  const panel = mod.ContextPanel({ occupancy: estimate, ...composition, expanded: false, t: zhT });
  assert.equal(byClass(panel, 'dcw-figures').children[0], '~64.4k / 200k (32%)');
});
check('missing input sampling falls back, while valid provider pressure stays authoritative', () => {
  const buckets = { messageTokens: 10000, toolsTokens: 5000, systemTokens: 2000 };
  assert.equal(mod.occupancyOf({ contextWindow: 200000 }, buckets).used, 17000);
  const measured = mod.occupancyOf({ pressureTokens: 12000, projectedTokens: 13500, contextWindow: 200000 }, buckets);
  assert.equal(measured.used, 13500);
  assert.equal(measured.estimated, true);
});

check('distribute never invents or loses a token', () => {
  assert.deepEqual(mod.distribute(100, [1, 1]), [50, 50]);
  assert.deepEqual(mod.distribute(10, [1, 1, 1]), [4, 3, 3]);
  assert.equal(mod.distribute(19414, [12513, 6906]).reduce((a, b) => a + b, 0), 19414);
  assert.deepEqual(mod.distribute(0, [5, 5]), [0, 0]);
  assert.deepEqual(mod.distribute(100, [0, 0]), [0, 0]);
});

check('allocate never invents or loses a token', () => {
  assert.deepEqual(mod.allocate(100, [1, 1]), [50, 50]);
  assert.equal(mod.allocate(19414, [12513, 6906]).reduce((a, b) => a + b, 0), 19414);
  assert.deepEqual(mod.allocate(0, [5, 5]), [0, 0]);
  assert.deepEqual(mod.allocate(100, [0, 0]), [0, 0]);
});

const capacity = 1000000;
const breakdown = { messageTokens: 225600, toolsTokens: 19414, systemTokens: 17700 };

console.log('composition without a classification');

const plain = mod.compositionOf(breakdown, capacity, null);
check('falls back to the official three buckets plus free space', () => {
  assert.deepEqual(plain.rows.map((row) => row.key), ['messages', 'tools', 'system']);
  assert.equal(plain.classified, false);
  assert.equal(plain.free, capacity - 225600 - 19414 - 17700);
});
check('tolerates a missing breakdown', () => {
  const empty = mod.compositionOf(undefined, capacity, null);
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.free, capacity);
});

console.log('composition with a classification');

const detail = {
  tools: {
    total: 19414,
    mcp: {
      count: 46,
      tokens: 12513,
      servers: [
        {
          server: 'github',
          count: 44,
          tokens: 12000,
          items: [
            { name: 'mcp__github__issue_write', rawName: 'issue_write', server: 'github', tokens: 917 },
            { name: 'mcp__github__list_issues', rawName: 'list_issues', server: 'github', tokens: 593 },
          ],
        },
        {
          server: 'fs',
          count: 1,
          tokens: 513,
          items: [{ name: 'mcp__fs__read', rawName: 'read', server: 'fs', tokens: 300 }],
        },
      ],
      items: [
        { name: 'mcp__github__issue_write', rawName: 'issue_write', server: 'github', tokens: 917 },
        { name: 'mcp__github__list_issues', rawName: 'list_issues', server: 'github', tokens: 593 },
      ],
    },
    system: {
      count: 33,
      tokens: 6906,
      items: [{ name: 'pwsh', tokens: 864 }, { name: 'workflow', tokens: 852 }],
    },
  },
  skills: {
    count: 3,
    tokens: 900,
    tool: { name: 'skill', tokens: 88 },
    items: [{ name: 'pelican', tokens: 300 }, { name: 'svg', tokens: 250 }],
  },
};

const classified = mod.compositionOf(breakdown, capacity, detail);
const valueOf = (key) => classified.rows.find((row) => row.key === key)?.value;

check('rows follow the design order', () => {
  assert.deepEqual(classified.rows.map((row) => row.key), ['messages', 'mcp', 'systemTools', 'system', 'skills']);
  assert.equal(classified.classified, true);
});
check('the tool split adds up to the official tools bucket', () => {
  assert.equal(valueOf('mcp') + valueOf('systemTools'), breakdown.toolsTokens);
  assert.ok(valueOf('mcp') > valueOf('systemTools'));
});
check('the skill catalog moves out of the message bucket', () => {
  assert.equal(valueOf('messages') + valueOf('skills'), breakdown.messageTokens);
  assert.equal(valueOf('skills'), 900);
});
check('counts come from the classification', () => {
  assert.equal(classified.rows.find((row) => row.key === 'mcp').count, 46);
  assert.equal(classified.rows.find((row) => row.key === 'systemTools').count, 33);
  assert.equal(classified.rows.find((row) => row.key === 'skills').count, 3);
});
check('server rows carry the MCP total', () => {
  const mcp = classified.rows.find((row) => row.key === 'mcp');
  assert.deepEqual(mcp.servers.map((row) => row.server), ['github', 'fs']);
  assert.equal(mcp.servers.reduce((sum, row) => sum + row.tokens, 0), mcp.value);
  assert.deepEqual(mcp.servers[0].items.map((item) => item.rawName), ['issue_write', 'list_issues']);
});
check('a complete tool list is normalized onto its server; a capped one keeps its own prices', () => {
  const [github, fs] = classified.rows.find((row) => row.key === 'mcp').servers;
  assert.equal(github.items.reduce((sum, item) => sum + item.tokens, 0), 917 + 593);
  assert.equal(fs.items.length, 1);
  assert.equal(fs.items[0].tokens, fs.tokens);
});
check('the skills row points at the skill tool it does not count', () => {
  assert.equal(classified.rows.find((row) => row.key === 'skills').noteTokens, 88);
});
check('rows plus free space cover the whole window', () => {
  const known = classified.rows.reduce((total, row) => total + row.value, 0);
  assert.equal(known + classified.free, capacity);
  assert.equal(known, breakdown.messageTokens + breakdown.toolsTokens + breakdown.systemTokens);
});
check('a session without skills keeps the message bucket whole', () => {
  const withoutSkills = mod.compositionOf(breakdown, capacity, { tools: detail.tools, skills: null });
  assert.equal(withoutSkills.rows.find((row) => row.key === 'messages').value, breakdown.messageTokens);
  assert.equal(withoutSkills.rows.some((row) => row.key === 'skills'), false);
});

console.log('trigger: the ring stays the ring');

const pressure = { projectedTokens: 306100, contextWindow: capacity };
const projection = (key) => ({ contextPressure: pressure, contextBreakdown: breakdown })[key];
const seat = mod.ContextMeter({ t: zhT, useProjection: projection, sessionId: 'session-1' });

check('renders the occupancy ring with the shipped geometry', () => {
  const ring = flat(seat).find((element) => element.type === 'svg');
  assert.equal(ring.props.viewBox, '0 0 14 14');
  assert.equal(ring.props.width, '14');
  const circles = ring.children;
  assert.equal(circles.length, 2);
  assert.equal(circles[0].props.className, 'dcw-track');
  assert.equal(circles[1].props.className, 'dcw-fill');
  assert.equal(circles[1].props.transform, 'rotate(-90 7 7)');
  assert.equal(circles[1].props.strokeDasharray, `${String((mod.CIRCUMFERENCE * 31) / 100)} ${String(mod.CIRCUMFERENCE)}`);
});
check('keeps the percentage reading and the hover tooltip', () => {
  const trigger = byClass(seat, 'dcw-trigger');
  assert.equal(trigger.props['aria-haspopup'], 'dialog');
  assert.equal(trigger.props['aria-expanded'], false);
  assert.equal(trigger.props['aria-label'], '上下文已用 31%');
  assert.deepEqual(texts(trigger), ['31%']);
  assert.equal(byClass(seat, 'dcw-tip').children[0], '上下文已用 31%');
});
check('opens no popover until it is clicked', () => {
  assert.equal(byClass(seat, 'dcw-panel'), undefined);
  assert.equal(flat(seat).find((element) => element.type === 'portal'), undefined);
});
check('renders nothing without occupancy', () => {
  assert.equal(mod.ContextMeter({ t: zhT, useProjection: () => undefined }), null);
  assert.equal(mod.ContextMeter({ t: zhT }), null);
});

console.log('popover');

const panelProps = {
  occupancy: mod.occupancyOf(pressure),
  rows: classified.rows,
  free: classified.free,
  freeShare: classified.freeShare,
  onToggle: () => {},
  onToggleRow: () => {},
  openItem: null,
  onToggleItem: () => {},
  t: zhT,
  panelRef: { current: null },
  style: { left: 10, top: 20 },
};

const compact = mod.ContextPanel({ ...panelProps, expanded: false, openRow: null });
check('compact popover: header figures and the whole-window bar', () => {
  assert.equal(byClass(compact, 'dcw-title').children[0], '上下文窗口');
  assert.equal(byClass(compact, 'dcw-figures').children[0], '306.1k / 1M (31%)');
  assert.equal(byClass(compact, 'dcw-header').props['aria-expanded'], false);
  assert.equal(byClass(compact, 'dcw-rows'), undefined);
});
check('bar segments are window shares plus the empty remainder', () => {
  const bar = byClass(compact, 'dcw-bar');
  assert.equal(bar.children.length, classified.rows.length + 1);
  const coloured = bar.children.slice(0, -1).reduce((sum, segment) => sum + Number.parseFloat(segment.props.style.width), 0);
  assert.ok(Math.abs(coloured - (1 - classified.freeShare) * 100) < 0.001);
  assert.equal(bar.children[bar.children.length - 1].props.className, 'dcw-rest');
});

const expanded = mod.ContextPanel({ ...panelProps, expanded: true, openRow: null });
check('the chevron ink is centred in its own viewBox', () => {
  const path = flat(expanded).find((element) => element.type === 'path' && String(element.props.d ?? '').startsWith('M'));
  const numbers = String(path.props.d).match(/-?\d+(?:\.\d+)?/g).map(Number);
  const half = Number(path.props.strokeWidth) / 2;
  const [x1, , x2] = numbers; // the triangle's two absolute x coordinates
  assert.equal((x1 - half + x2 + half) / 2, 8, 'the triangle ink must be centred on the 16-unit viewBox');
});
check('expanded popover lists every bucket in design order', () => {
  const rows = allByClass(expanded, 'dcw-row');
  assert.deepEqual(rows.map((row) => texts(row)[0]), ['对话消息', 'MCP 工具', '系统工具', '系统提示词', '技能', '剩余空间']);
});
check('the rows are plain: colour, label, value, percent', () => {
  const rows = allByClass(expanded, 'dcw-row');
  assert.deepEqual(rows.map((row) => texts(row).join('|')), [
    '对话消息|~224.7k|22.5%',
    'MCP 工具|~12.5k|1.3%',
    '系统工具|~6.9k|0.7%',
    '系统提示词|~17.7k|1.8%',
    '技能|~900|0.1%',
    '剩余空间|~737.3k|73.7%',
  ]);
  assert.equal(
    allByClass(expanded, 'dcw-row').some((row) => flat(row).some((element) => String(element.props.className ?? '').includes('dcw-chevron'))),
    false,
    'no legend row carries a disclosure any more',
  );
});
check('every classified bucket gets its own section below the legend', () => {
  const sections = allByClass(expanded, 'dcw-section');
  assert.deepEqual(sections.map((section) => texts(section).join('|')), [
    'MCP 工具|~12.5k|46',
    '系统工具|~6.9k|33',
    '技能|~900|3',
  ]);
  assert.deepEqual(sections.map((section) => section.props['aria-expanded']), [false, false, false]);
  assert.equal(allByClass(expanded, 'dcw-list').length, 0);
});
check('rows plus free space still cover the window', () => {
  const values = allByClass(expanded, 'dcw-row').map((row) => texts(row)[1]);
  assert.deepEqual(values, ['~224.7k', '~12.5k', '~6.9k', '~17.7k', '~900', '~737.3k']);
});

const withMcpOpen = mod.ContextPanel({ ...panelProps, expanded: true, openRow: 'mcp' });
check('an open section lists its entries with the server prefix, in a scroll box', () => {
  assert.equal(allByClass(withMcpOpen, 'dcw-list').length, 1);
  assert.deepEqual(allByClass(withMcpOpen, 'dcw-entry').map((entry) => texts(entry).join('|')), [
    'github · issue_write|~917',
    'github · list_issues|~593',
    'fs · read|~513',
  ]);
  const mcpSection = allByClass(withMcpOpen, 'dcw-section').find((section) => texts(section)[0] === 'MCP 工具');
  assert.equal(mcpSection.props['aria-expanded'], true);
  assert.equal(allByClass(withMcpOpen, 'dcw-more').length, 1);
});
check('only the opened section expands', () => {
  assert.equal(allByClass(withMcpOpen, 'dcw-list').length, 1);
  assert.equal(allByClass(withMcpOpen, 'dcw-entry').length, 3);
});
check('the skills section notes the skill tool it does not count', () => {
  const skillsOpen = mod.ContextPanel({ ...panelProps, expanded: true, openRow: 'skills' });
  assert.equal(allByClass(skillsOpen, 'dcw-more').at(-1).children[0], 'skill 工具本身 ~88 · 计入系统工具');
});
check('english dictionaries mirror the design labels', () => {
  const english = mod.ContextPanel({ ...panelProps, expanded: true, openRow: null, t: (key) => mod.dicts.en[key] });
  const labels = allByClass(english, 'dcw-row').map((row) => texts(row)[0]);
  assert.deepEqual(labels, ['Messages', 'MCP tools', 'System tools', 'System prompt', 'Skills', 'Free space']);
  assert.equal(byClass(english, 'dcw-title').children[0], 'Context window');
});

console.log('slot registration');

check('registers one occupant in the composer dock and forwards the session id', () => {
  const registered = [];
  let injectedName;
  const ctx = {
    get: (name) => {
      if (name === 'slots') {
        return {
          inject: (name_, register) => { injectedName = name_; registered.push(register()); },
          register: (definition, render) => ({ definition, render }),
        };
      }
      if (name === 'locale') return { bind: () => zhT, register: () => () => {} };
      return undefined;
    },
    effect: (fn) => { fn(); },
  };
  mod.apply(ctx);
  assert.equal(injectedName, 'conversation.composer.dock');
  assert.equal(registered.length, 1);
  assert.equal(registered[0].definition.id, 'context-window');
  assert.equal(registered[0].definition.locale, mod.NS);
  const rendered = registered[0].render({ t: zhT, useProjection: projection, sessionId: 'session-9' });
  assert.equal(rendered.props.sessionId, 'session-9');
});

check('apply tolerates a missing slot service', () => {
  assert.doesNotThrow(() => { mod.apply({ get: () => undefined, effect: () => {} }); });
});

check('the bundle file stays plain JavaScript at the real entry point', () => {
  const source = readFileSync(clientPath, 'utf8');
  assert.match(source, /window\.__ModuleLoader__\.load\(\{/);
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /^\s*export\s/m);
});

check('the reported total controls free space and the whole-window bar', () => {
  const buckets = { messageTokens: 189018, toolsTokens: 18382, systemTokens: 2000 };
  const view = mod.compositionOf(buckets, 1000000, null, 516000);
  assert.equal(view.rows.find(row => row.key === 'adjustment').value, 306600);
  assert.equal(view.free, 484000);
  assert.equal(view.rows.reduce((sum, row) => sum + row.value, 0) + view.free, 1000000);
  assert.ok(Math.abs(view.barRows.reduce((sum, row) => sum + row.share, 0) - 0.516) < 1e-12);
  assert.equal(view.rows.find(row => row.key === 'messages').value, buckets.messageTokens);
});
check('a verified old cache sample corrects both occupancy and its remainder', () => {
  const pressure = { pressureTokens: 571741, projectedTokens: 571860, contextWindow: 1000000 };
  const buckets = { systemTokens: 2000, toolsTokens: 18382, messageTokens: 209142 };
  const detail = { usageCorrection: { pressureTokens: 571741, duplicateCacheTokens: 285184 } };
  const occupancy = mod.occupancyOf(pressure, buckets, detail);
  assert.equal(occupancy.used, 286676);
  assert.equal(occupancy.percent, 29);
  assert.equal(occupancy.estimated, true);
  const view = mod.compositionOf(buckets, occupancy.window, null, occupancy.used);
  assert.equal(view.free, 713324);
  assert.equal(view.rows.find(row => row.key === 'adjustment').value, 57152);
  assert.equal(mod.occupancyOf({ ...pressure, pressureTokens: 286557, projectedTokens: 286676 }, buckets, detail).used, 286676);
});
check('negative differences, unavailable breakdowns and overflow retain consistent occupancy', () => {
  const below = mod.compositionOf({ messageTokens: 8000 }, 10000, null, 5000);
  assert.equal(below.rows.find(row => row.key === 'adjustment').value, -3000);
  assert.equal(below.free, 5000);
  assert.equal(below.barRows.reduce((sum, row) => sum + row.share, 0), 0.5);
  const legend = mod.BreakdownRows({ ...below, t: zhT });
  assert.ok(textOf(legend).includes('~−3k'));
  assert.ok(textOf(legend).includes('−30.0%'));
  const empty = mod.compositionOf(undefined, 10000, null, 3000);
  assert.equal(empty.free, 7000);
  assert.equal(empty.rows[0].value, 3000);
  const over = mod.compositionOf({ messageTokens: 8000 }, 10000, null, 15000);
  assert.equal(over.free, 0);
  assert.equal(over.rows.reduce((sum, row) => sum + row.value, 0), 15000);
  assert.ok(Math.abs(over.barRows.reduce((sum, row) => sum + row.share, 0) - 1) < 1e-12);
});

check('missing classification weights retain the official tools bucket', () => {
  const view = mod.compositionOf({ messageTokens: 10, toolsTokens: 100, systemTokens: 5 }, 1000, { tools: { mcp: { tokens: 0 }, system: { tokens: 0 } } });
  assert.equal(view.classified, false);
  assert.equal(view.rows.find(row => row.key === 'tools').value, 100);
  assert.equal(view.free, 885);
});
check('classification state is visible without claiming an empty tool list', () => {
  const loading = mod.ContextPanel({ ...panelProps, detailStatus: 'loading' });
  assert.ok(textOf(loading).includes('正在读取工具与技能明细'));
  const failed = mod.ContextPanel({ ...panelProps, detailStatus: 'error', detailError: '503 unavailable', detailStale: false });
  assert.ok(textOf(failed).includes('暂显示官方估算桶'));
  assert.ok(textOf(failed).includes('503 unavailable'));
  assert.equal(byClass(failed, 'dcw-retry').props.disabled, false);
  const stale = mod.ContextPanel({ ...panelProps, detailStatus: 'error', detailError: 'timeout', detailStale: true });
  assert.ok(textOf(stale).includes('上次成功读取的数据'));
  assert.ok(textOf(stale).includes('读取超时'));
});
check('the whole dialog is bounded and keyboard focus is visible', () => {
  assert.ok(injected[0].textContent.includes('max-height:calc(100dvh - 24px);overflow-y:auto'));
  assert.ok(injected[0].textContent.includes('.dcw-trigger:focus-visible'));
});

// A small mounted-hook harness complements the pure element-tree checks above.
const originalHooks = { useState: reactShim.useState, useEffect: reactShim.useEffect, useRef: reactShim.useRef };
let states = [], effects = [], cursor = 0;
reactShim.useState = (initial) => {
  const index = cursor++;
  if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
  return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
};
reactShim.useRef = initial => {
  const index = cursor++;
  if (!(index in states)) states[index] = { current: initial };
  return states[index];
};
reactShim.useEffect = (fn, deps) => {
  const index = cursor++; const old = effects[index];
  if (old && deps.every((value, i) => Object.is(value, old.deps[i]))) return;
  old?.cleanup?.(); effects[index] = { deps, cleanup: fn() };
};
const hook = (fn, ...args) => { cursor = 0; return fn(...args); };
const cleanupHooks = () => { for (const entry of effects) entry?.cleanup?.(); states = []; effects = []; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function checkAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (error) { failures.push(`${name}: ${error.message}`); console.log(`FAIL  ${name}\n      ${error.message}`); }
  finally { cleanupHooks(); }
}
await checkAsync('detail reads are single-flight, stale on failure, retryable and cancelled on session change', async () => {
  const originalFetch = globalThis.fetch, originalSet = globalThis.setInterval, originalClear = globalThis.clearInterval;
  const requests = [], timers = new Map(); let nextId = 0;
  globalThis.fetch = (url, init) => new Promise(resolve => requests.push({ url, signal: init.signal, resolve }));
  globalThis.setInterval = fn => { const id = ++nextId; timers.set(id, fn); return id; };
  globalThis.clearInterval = id => timers.delete(id);
  const response = (sessionId, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => ok ? { sessionId, generatedAt: 10, tools: detail.tools } : { error: { message: 'offline' } } });
  try {
    let state = hook(mod.useDetail, 'one', true);
    assert.equal(state.status, 'loading'); assert.equal(requests.length, 1);
    const poll = [...timers.values()][0]; poll(); poll();
    assert.equal(requests.length, 1, 'slow reads must not overlap on timer ticks');
    requests[0].resolve(response('one')); await tick(); state = hook(mod.useDetail, 'one', true);
    assert.equal(state.detail.sessionId, 'one');
    poll(); requests[1].resolve(response('one', false)); await tick(); state = hook(mod.useDetail, 'one', true);
    assert.equal(state.stale, true); assert.equal(state.error, 'offline'); assert.equal(state.detail.sessionId, 'one');
    state.retry(); state = hook(mod.useDetail, 'one', true);
    assert.equal(requests.length, 3); requests[2].resolve(response('one')); await tick(); state = hook(mod.useDetail, 'one', true);
    assert.equal(state.error, null); assert.equal(state.stale, false);
    [...timers.values()][0]();
    state = hook(mod.useDetail, 'two', true);
    assert.equal(requests[3].signal.aborted, true); assert.equal(state.detail, null);
    requests[3].resolve(response('one')); await tick();
    assert.equal(hook(mod.useDetail, 'two', true).detail, null, 'old session response is ignored even if a mock resolves after abort');
    requests[4].resolve(response('two')); await tick(); assert.equal(hook(mod.useDetail, 'two', true).detail.sessionId, 'two');
    [...timers.values()][0](); state = hook(mod.useDetail, 'two', false);
    assert.equal(requests[5].signal.aborted, true); assert.equal(timers.size, 0);
    assert.equal(requests.length, 6, 'closing a loaded panel cancels without starting a replacement request');
    requests[5].resolve(response('two')); await tick();
    assert.equal(hook(mod.useDetail, 'two', false).detail.sessionId, 'two');
    hook(mod.useDetail, 'two', true); cleanupHooks();
    assert.equal(requests[6].signal.aborted, true, 'unmount also cancels the reopened panel read');
    requests[6].resolve(response('two')); await tick();
    hook(mod.useDetail, 'new', true); hook(mod.useDetail, 'new', false);
    assert.equal(requests[7].signal.aborted, true);
    assert.equal(requests.length, 8, 'closing before the first response also cancels without restarting');
    requests[7].resolve(response('new')); await tick();
  } finally { cleanupHooks(); globalThis.fetch = originalFetch; globalThis.setInterval = originalSet; globalThis.clearInterval = originalClear; }
});
await checkAsync('portal focus enters the dialog, restores on Escape and never steals outside focus', async () => {
  const header = { focus: () => { document.activeElement = header; } };
  let restores = 0;
  const trigger = { focus: () => { restores++; document.activeElement = trigger; } };
  const panel = { querySelector: () => header, contains: node => node === header };
  hook(mod.usePanelFocus, { current: trigger }, { current: panel }, true);
  assert.equal(document.activeElement, header);
  cleanupHooks(); assert.equal(document.activeElement, trigger); assert.equal(restores, 1);
  hook(mod.usePanelFocus, { current: trigger }, { current: panel }, true);
  const outside = {}; document.activeElement = outside; cleanupHooks();
  assert.equal(document.activeElement, outside); assert.equal(restores, 1);
  const listeners = new Map(); let closes = 0; let prevented = false; let stopped = false;
  const add = document.addEventListener, remove = document.removeEventListener;
  document.addEventListener = (name, fn) => listeners.set(name, fn);
  document.removeEventListener = name => listeners.delete(name);
  try {
    hook(mod.useDismiss, { current: { contains: node => node === trigger } }, { current: panel }, true, () => { closes++; });
    listeners.get('keydown')({ key: 'Escape', preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } });
    assert.equal(closes, 1); assert.equal(prevented, true); assert.equal(stopped, true);
    listeners.get('focusin')({ target: header }); assert.equal(closes, 1);
    listeners.get('focusin')({ target: outside }); assert.equal(closes, 2, 'Tab leaving the nonmodal panel closes it');
    cleanupHooks(); assert.equal(listeners.size, 0);
  } finally { cleanupHooks(); document.addEventListener = add; document.removeEventListener = remove; }
});
Object.assign(reactShim, originalHooks);

console.log(`\n${String(passed)} passed, ${String(failures.length)} failed`);
if (failures.length > 0) {
  console.log(failures.join('\n'));
  process.exit(1);
}
