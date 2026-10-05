// Offline verification of the browser half: the bundle parses in DSH's
// __ModuleLoader__ format, registers its settings page, and renders its
// loading / ready / error states — chart math included — on a minimal hook
// runtime. No browser required.
// usage: node client-test.mjs
import fs from 'node:fs';

let checks = 0;
let failures = 0;
const ok = (condition, label, detail) => {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.log(`FAIL ${label}${detail === undefined ? '' : ` :: ${detail}`}`);
};
const eq = (actual, expected, label) => ok(
  JSON.stringify(actual) === JSON.stringify(expected),
  label,
  `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
);

// ---- minimal DOM + React runtime -------------------------------------------------
const styleElements = [];
const document = {
  createElement: () => ({ setAttribute() {}, textContent: '', parentNode: null }),
  head: { appendChild: (element) => styleElements.push(element) },
};

let hookStates = [];
let hookEffects = [];
let cursor = 0;
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => {
    const index = cursor;
    cursor += 1;
    const key = `state:${String(index)}`;
    if (!(key in hookStates)) hookStates[key] = typeof initial === 'function' ? initial() : initial;
    return [hookStates[key], (next) => {
      hookStates[key] = typeof next === 'function' ? next(hookStates[key]) : next;
    }];
  },
  useEffect: (effect) => {
    const index = cursor;
    cursor += 1;
    const key = `effect:${String(index)}`;
    if (!(key in hookEffects)) hookEffects[key] = effect();
  },
};

const render = (component, props) => {
  cursor = 0;
  return component(props);
};
const remount = () => { hookStates = []; hookEffects = []; };

// ---- load the shipped bundle -----------------------------------------------------
const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
let registration;
const window = { __ModuleLoader__: { load: (value) => { registration = value; } } };
const require = (specifier) => {
  if (specifier === 'react') return React;
  throw new Error(`unexpected require(${JSON.stringify(specifier)})`);
};
new Function('window', 'require', 'document', source)(window, require, document);

console.log('== bundle shape ==');
ok(registration !== undefined, 'bundle called window.__ModuleLoader__.load');
eq(registration?.id, 'dsh-usage-report', 'bundle id is the package name');
const exported = registration.factory(require);
eq(exported.name, 'dsh-usage-report', 'exports.name');
eq(exported.inject, ['slots', 'locale'], 'exports.inject');
eq(typeof exported.apply, 'function', 'exports.apply is a function');
eq(exported.ROUTE, 'api/usage.report', 'route matches the Host half');
eq(exported.NS, 'settings.usageReport', 'locale namespace');

console.log('== formatting ==');
const f = exported.formatTokens;
eq(f(0), '0', 'zero');
eq(f(999), '999', 'sub-thousand');
eq(f(1234), '1.2K', 'thousands');
eq(f(5_900_000), '5.9M', 'millions (design value)');
eq(f(15_700_000), '15.7M', 'millions (design value 2)');
eq(f(167_218_591), '167.2M', 'real folded input');
eq(f(1_234_000_000), '1.23B', 'billions');
eq(f(undefined), '0', 'undefined is zero');
eq(exported.niceMax(167_218_591), 200_000_000, 'axis max rounds up to 2e8');
eq(exported.niceMax(0), 1, 'empty axis max is 1');
eq(exported.niceMax(9), 10, 'small axis max');
eq(exported.niceMax(11), 12, 'axis max uses the 1.2 step');
const axis = exported.formatAxis;
eq(axis(120_000_000), '120M', 'axis label drops a trailing .0');
eq(axis(30_000_000), '30M', 'axis label keeps whole millions short');
eq(axis(1_500_000), '1.5M', 'axis label keeps a real fraction');
eq(axis(0), '0', 'axis label zero');

// ---- registration ---------------------------------------------------------------
/** A fake ctx whose locale resolves the plugin's own dictionaries. */
function makeCtx() {
  const state = { registered: [], injected: [], dictionaries: undefined, effects: [] };
  const fakeLocale = {
    bind: (ns) => (key, values) => {
      const dict = (state.dictionaries ?? {})[ns.includes('usage') ? 'zh' : 'en'] ?? {};
      const template = dict[key] ?? `missing:${key}`;
      if (values === undefined) return template;
      return String(template).replace(/\{(\w+)\}/g, (whole, name) => (
        values[name] === undefined ? whole : String(values[name])
      ));
    },
    register: (ns, dicts) => { state.dictionaries = dicts; state.ns = ns; return () => {}; },
  };
  const fakeSlots = {
    inject: (key, callback) => { state.injected.push(key); callback(); return () => {}; },
    register: (options, component) => { state.registered.push({ options, component }); return () => {}; },
  };
  const ctx = {
    get: (name) => ({ slots: fakeSlots, locale: fakeLocale })[name],
    effect: (callback, label) => {
      state.effects.push(label);
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    },
  };
  return { ctx, state };
}

/** Installed as globalThis.fetch for the render phases. */
const fetchedUrls = [];
const goodFetch = async (url) => {
  fetchedUrls.push(String(url));
  return { ok: true, status: 200, json: async () => fakeReport() };
};
const failingFetch = async () => { throw new Error('transport exploded'); };

console.log('== settings registration ==');
const good = makeCtx();
exported.apply(good.ctx);
ok(good.state.injected.includes('settings.section'), 'injects the settings.section slot');
eq(good.state.registered.length, 1, 'registers exactly one section');
const section = good.state.registered[0];
eq(section.options.name, 'settings.section', 'slot name');
eq(section.options.id, 'usage', 'section id');
eq(section.options.order, 13, 'section order places it after reasoning effort');
eq(section.options.label(), '用量', 'nav label is localized');
eq(typeof section.component, 'function', 'section component');
eq(good.state.ns, 'settings.usageReport', 'registers its dictionary namespace');
eq(Object.keys(good.state.dictionaries).sort(), ['en', 'zh'], 'ships zh and en dictionaries');
eq(
  Object.keys(good.state.dictionaries.zh).sort(),
  Object.keys(good.state.dictionaries.en).sort(),
  'zh and en dictionaries carry identical keys',
);

/** The registered component is a factory element; render the page it points at. */
const mountSection = (component) => {
  const element = component({});
  return render(element.type, element.props);
};

// ---- loading state --------------------------------------------------------------
console.log('== render: loading ==');
remount();
globalThis.fetch = goodFetch;
const warmup = mountSection(section.component);
ok(styleElements.length >= 1, 'injects its stylesheet on first render');
const loadingStatus = flatten(warmup).find((node) => String(node?.props?.className ?? '').includes('dsu-status'));
ok(loadingStatus !== undefined, 'first paint shows a status line');
eq(loadingStatus.children[0], good.state.dictionaries.zh.loading, 'loading copy is localized');

// ---- ready state ----------------------------------------------------------------
await new Promise((resolve) => { setTimeout(resolve, 0); });
const ready = mountSection(section.component);
const nodes = flatten(ready);
eq(ready.props.className, 'dsu-root', 'root class');
ok(
	fetchedUrls.some((url) => url === 'api/usage.report?range=30'),
	'page reads the Host route with the selected range',
	fetchedUrls.join('|'),
);
const cards = nodes.filter((node) => typeof node?.type === 'function'
	&& node.props !== undefined && 'value' in node.props && 'hint' in node.props);
eq(cards.length, 2, 'two stat cards');
const cardsRendered = cards.map((card) => render(card.type, card.props));
const inputText = flatten(cardsRendered[0]).map((node) => node.children?.[0]).filter((x) => typeof x === 'string');
ok(inputText.some((text) => text.includes('15.7M')), 'input card shows the folded input total', inputText.join('|'));
ok(inputText.some((text) => text.includes('15.7M') && text.includes('2.0K')), 'input card breaks out uncached and cache read');
const outputText = flatten(cardsRendered[1]).map((node) => node.children?.[0]).filter((x) => typeof x === 'string');
ok(outputText.some((text) => text.includes('5.9M')), 'output card shows the folded output total');
ok(outputText.some((text) => text.includes('304')), 'output card counts model replies');
ok(flatten(ready).some((node) => node?.type === 'h3' && node.children?.[0] === '用量'), 'page title renders');

console.log('== render: chart ==');
const chartElement = nodes.find((node) => typeof node?.type === 'function'
	&& Array.isArray(node.props?.days));
ok(chartElement !== undefined, 'chart element present');
const svg = render(chartElement.type, chartElement.props);
eq(svg.type, 'svg', 'chart renders an svg');
eq(svg.props.viewBox, '0 0 540 200', 'chart viewBox is fixed so it scales with the panel');
const bars = flatten(svg).filter((node) => node?.type === 'rect' && node.props?.fill !== 'transparent');
eq(bars.length, 4, 'two days with both series render four bars');
eq(
  bars.map((bar) => bar.props.fill),
  ['var(--dsw-alias-state-warn-primary)', 'var(--dsw-alias-state-success-primary)',
    'var(--dsw-alias-state-warn-primary)', 'var(--dsw-alias-state-success-primary)'],
  'bars alternate input and output colors',
);
const zeroDays = flatten(svg).filter((node) => node?.type === 'rect' && node.props?.fill === 'transparent');
eq(zeroDays.length, 3, 'one hover target per day, empty days included');
const titles = flatten(svg).filter((node) => node?.type === 'title').map((node) => node.children?.[0]);
eq(titles.length, 3, 'one hover title per day');
eq(titles[0], '2026-10-03：输入 15.7M，输出 5.9M', 'hover title is localized with formatted tokens');
const axisLabels = flatten(svg).filter((node) => node?.props?.className === 'dsu-axis').map((node) => node.children?.[0]);
ok(axisLabels.includes('10/3'), 'x axis labels the day', axisLabels.join('|'));
ok(axisLabels.includes('20M'), 'y axis labels the rounded max', axisLabels.join('|'));
// A 30-day axis used to print nine labels with the last two adjacent; the even
// tick spread keeps eight, both ends included.
const thirtyDays = Array.from({ length: 30 }, (_, index) => ({
	day: `2026-09-${String(index + 1).padStart(2, '0')}`,
	label: `9/${String(index + 1)}`,
	input: index * 1_000,
	output: index * 10,
	uncachedInput: 0,
	cacheRead: 0,
	cacheWrite: 0,
	requests: 1,
}));
const svg30 = render(chartElement.type, { days: thirtyDays, t: chartElement.props.t });
const xLabels30 = flatten(svg30).filter((node) => node?.props?.className === 'dsu-axis' && node.props.textAnchor === 'middle');
eq(xLabels30.length, 8, 'thirty-day axis prints eight evenly spaced labels');
eq(xLabels30[xLabels30.length - 1].children[0], '9/30', 'thirty-day axis still ends on the last day');
ok(bars.every((bar) => bar.props.y >= 8 && bar.props.height > 0), 'every bar stays inside the plot');

const legend = flatten(ready).filter((node) => node?.props?.className === 'dsu-legend-item');
eq(legend.length, 2, 'legend has both series');
const ranges = flatten(ready).filter((node) => node?.props?.className === 'dsu-range');
eq(ranges.map((node) => node.children?.[0]), ['7 天', '30 天', '90 天'], 'range tabs render localized labels');
eq(ranges.filter((node) => node.props['aria-pressed'] === 'true').length, 1, 'exactly one range is selected');
const footer = flatten(ready).find((node) => node?.props?.className === 'dsu-footer');
ok(String(flatten(footer)[flatten(footer).length - 1]?.children?.[0] ?? '').includes('13'), 'footer reports the scanned session count');

// ---- error state ----------------------------------------------------------------
console.log('== render: error ==');
const bad = makeCtx();
globalThis.fetch = failingFetch;
exported.apply(bad.ctx);
const badSection = bad.state.registered[0];
remount();
mountSection(badSection.component);
await new Promise((resolve) => { setTimeout(resolve, 0); });
const errored = mountSection(badSection.component);
const errorNode = flatten(errored).find((node) => String(node?.props?.className ?? '').includes('dsu-status-error'));
ok(errorNode !== undefined, 'transport failure renders the error state');
ok(String(errorNode.children?.[0] ?? '').includes('transport exploded'), 'error state surfaces the failure message');

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log('client-test: OK');

// ---- helpers --------------------------------------------------------------------
/** Walk a createElement tree into a flat node list. */
function flatten(node, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  if (node === null || typeof node !== 'object') return out;
  if (node.type !== undefined) out.push(node);
  if (node.children !== undefined) flatten(node.children, out);
  return out;
}

function fakeReport() {
  return {
    generatedAt: Date.UTC(2026, 9, 5, 12, 0, 0),
    rangeDays: 30,
    days: [
      { day: '2026-10-03', label: '10/3', input: 15_700_000, output: 5_900_000, uncachedInput: 10, cacheRead: 15_699_990, cacheWrite: 0, requests: 300 },
      { day: '2026-10-04', label: '10/4', input: 0, output: 0, uncachedInput: 0, cacheRead: 0, cacheWrite: 0, requests: 0 },
      { day: '2026-10-05', label: '10/5', input: 2_000, output: 500, uncachedInput: 2_000, cacheRead: 0, cacheWrite: 0, requests: 4 },
    ],
    totals: { input: 15_702_000, output: 5_900_500, uncachedInput: 2_010, cacheRead: 15_699_990, cacheWrite: 0, requests: 304 },
    meta: {
      localOnly: true,
      sessionCount: 13,
      scannedSessions: 13,
      skippedSessions: 0,
      skippedReasons: [],
      truncatedSessions: 0,
      liveSessions: 1,
      inheritedEventsSkipped: 0,
      activeDays: 2,
      firstActiveDay: '2026-10-03',
      lastActiveDay: '2026-10-05',
    },
  };
}
