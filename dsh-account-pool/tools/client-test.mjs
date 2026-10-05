/**
 * Offline verification of the browser half.
 *
 * Proves the bundle parses in DSH's `__ModuleLoader__.load` format, registers
 * its settings page, and renders its loading / ready / error states on a
 * minimal hook runtime. No browser, no DSH, no network.
 *
 *   node tools/client-test.mjs
 */
import fs from 'node:fs';

let checks = 0;
let passed = 0;
const failures = [];

function ok(condition, label, detail) {
  checks += 1;
  if (condition) { passed += 1; return; }
  failures.push({ label, error: new Error(detail ?? 'assertion failed') });
}

function eq(actual, expected, label) {
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

// ------------------------------------------------- minimal DOM + hook runtime

const styleElements = [];
const document = {
  createElement: () => ({ setAttribute() {}, textContent: '', parentNode: null }),
  head: { appendChild: (element) => styleElements.push(element) },
};

let hookStates = {};
let hookEffects = {};
let cursor = 0;

const React = {
  createElement: (type, props, ...children) => {
    // Real React folds children into props; components like Pill read props.children.
    const merged = { ...(props ?? {}) };
    if (children.length === 1) merged.children = children[0];
    else if (children.length > 1) merged.children = children;
    return { type, props: merged, children };
  },
  useState: (initial) => {
    const key = `state:${String(cursor)}`;
    cursor += 1;
    if (!(key in hookStates)) hookStates[key] = typeof initial === 'function' ? initial() : initial;
    return [hookStates[key], (next) => {
      hookStates[key] = typeof next === 'function' ? next(hookStates[key]) : next;
    }];
  },
  useEffect: (effect) => {
    const key = `effect:${String(cursor)}`;
    cursor += 1;
    if (!(key in hookEffects)) hookEffects[key] = effect();
  },
};

const render = (component, props) => { cursor = 0; return component(props); };
const remount = () => { hookStates = {}; hookEffects = {}; cursor = 0; };

// Timers are stubbed so the page's countdown interval cannot keep Node alive.
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

// ------------------------------------------------- load the shipped bundle

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
let registration;
const window = { __ModuleLoader__: { load: (value) => { registration = value; } } };
const require = (specifier) => {
  if (specifier === 'react') return React;
  throw new Error(`unexpected require(${JSON.stringify(specifier)})`);
};
new Function('window', 'require', 'document', source)(window, require, document);

// ------------------------------------------------- tree helpers

/**
 * Resolve the element tree the way a renderer would.
 *
 * `createElement` is lazy: `h(Card, {...})` is DATA until something invokes it.
 * Every child component in this page is hook-free (only PoolSection uses hooks,
 * and it is invoked explicitly), so expanding them here is safe and leaves the
 * hook cursor untouched.
 */
const expandedRoots = new WeakMap();

function expandNode(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null;
  if (typeof node === 'string' || typeof node === 'number') return node;
  if (Array.isArray(node)) return node.map(expandNode).filter((child) => child !== null);
  if (typeof node.type === 'function') return expandNode(node.type(node.props));
  return { type: node.type, props: node.props, children: (node.children ?? []).map(expandNode).filter((child) => child !== null) };
}

/**
 * Expand a rendered tree exactly ONCE.
 *
 * Expanding is not free of side effects: invoking a hook-using component (the
 * form) ADVANCES the cursor, so calling expand twice on one render mints a
 * second set of hook slots. The state a test mutates then lands in slots the
 * next read does not look at. Caching per root makes the helpers idempotent.
 */
function expand(tree) {
  const cached = expandedRoots.get(tree);
  if (cached !== undefined) return cached;
  const result = expandNode(tree);
  expandedRoots.set(tree, result);
  return result;
}

function rawText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(rawText).join('');
  return (node.children ?? []).map(rawText).join('');
}

function rawClasses(node, found) {
  if (node === null || node === undefined || typeof node !== 'object') return found;
  if (Array.isArray(node)) { for (const child of node) rawClasses(child, found); return found; }
  const className = node.props?.className;
  // Push individual tokens, not the whole attribute: a check like
  // `includes('dap-pill-ready')` must not depend on whether that class happens
  // to be the only one on the element.
  if (typeof className === 'string') found.push(...className.split(/\s+/).filter((token) => token !== ''));
  for (const child of node.children ?? []) rawClasses(child, found);
  return found;
}

function textOf(tree) { return rawText(expand(tree)); }
function classesIn(tree) { return rawClasses(expand(tree), []); }

/** Every button in the rendered tree, in document order. */
function buttonsIn(tree) {
  const found = [];
  (function visit(node) {
    if (node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) visit(child); return; }
    if (node.type === 'button') found.push(node);
    for (const child of node.children ?? []) visit(child);
  })(expand(tree));
  return found;
}

/** The buttons whose label matches, in document order. */
function buttonsLabelled(tree, label) {
  return buttonsIn(tree).filter((button) => rawText(button) === label);
}

// ------------------------------------------------- fixtures

const NOW = Date.now();
const ACCOUNTS_BODY = {
  totalRequests: 42,
  counts: { active: 2 },
  accounts: [
    { id: 'a1', label: '主号', platform: 'anthropic', status: 'active', schedulable: true, priority: 100, loadFactor: null, concurrency: 4, consecutiveFailures: 0, rateLimitResetAt: null, overloadUntil: null, tempUnschedulableUntil: null, tempUnschedulableReason: '', groups: ['cheap'], credential: { configured: true, writable: true, source: 'store' } },
    { id: 'a2', label: '', platform: 'openai', status: 'active', schedulable: true, priority: 200, loadFactor: 2, concurrency: 1, consecutiveFailures: 2, rateLimitResetAt: new Date(NOW + 120_000).toISOString(), overloadUntil: null, tempUnschedulableUntil: null, tempUnschedulableReason: 'rate-limit' },
    { id: 'a3', label: '', platform: 'gemini', status: 'error', schedulable: true, priority: 300, loadFactor: null, concurrency: 8, consecutiveFailures: 3, rateLimitResetAt: null, overloadUntil: null, tempUnschedulableUntil: null, tempUnschedulableReason: '' },
    { id: 'a4', label: '', platform: 'grok', status: 'active', schedulable: true, priority: 400, loadFactor: null, concurrency: 0, consecutiveFailures: 0, rateLimitResetAt: null, overloadUntil: null, tempUnschedulableUntil: null, tempUnschedulableReason: '' },
    { id: 'a5', label: '', platform: 'custom', status: 'disabled', schedulable: false, priority: 500, loadFactor: null, concurrency: 2, consecutiveFailures: 0, rateLimitResetAt: null, overloadUntil: null, tempUnschedulableUntil: null, tempUnschedulableReason: '' },
  ],
  bindings: [{ sessionHash: 's1', accountId: 'a1' }],
  groups: [{ id: 'cheap', label: '便宜池', description: '', models: ['cheap-model'], createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() }],
  routes: ['pool', 'pool-cheap'],
};
const USAGE_BODY = {
  limit: 50,
  rows: [
    { at: '2026-01-01T00:00:05.000Z', accountId: 'a1', sessionId: 's1', platform: 'anthropic', model: 'claude-opus-4', inputTokens: 1234, outputTokens: 56, cacheReadTokens: 7890, cacheWriteTokens: 0, reasoningTokens: 0, accountSwitches: 1, ok: true, errorCode: '' },
    { at: '2026-01-01T00:00:04.000Z', accountId: 'a2', sessionId: 's1', platform: 'openai', model: 'gpt-5', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, accountSwitches: 0, ok: false, errorCode: 'http-400' },
  ],
};

/** A fetch stub routing the pool routes; `mode` picks the outcome. Records method and body. */
function makeFetch(mode) {
  const calls = [];
  const impl = async (url, init) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(url), method, body: init?.body });
    if (mode === 'pending') return new Promise(() => {});
    if (mode === 'error') {
      return { ok: false, status: 500, json: async () => ({ error: { message: 'domain exploded' } }) };
    }
    if (method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true, action: 'prefer' }) };
    const body = String(url).startsWith('api/accountPool.usage') ? USAGE_BODY : ACCOUNTS_BODY;
    return { ok: true, status: 200, json: async () => body };
  };
  return { impl, calls };
}

/** Render the page, let its fetch settle, then render again with the new state. */
async function renderState(page, mode) {
  const fetchStub = makeFetch(mode);
  remount();
  globalThis.fetch = fetchStub.impl;
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  render(page.type, page.props);
  await new Promise((resolve) => setImmediate(resolve));
  const tree = render(page.type, page.props);
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  return { tree, calls: fetchStub.calls };
}

// ------------------------------------------------- bundle shape

ok(registration !== undefined, 'bundle called window.__ModuleLoader__.load');
eq(registration?.id, 'dsh-account-pool', 'bundle id is the package name');

const exported = registration.factory(require);
eq(exported.name, 'dsh-account-pool', 'exports.name');
eq(exported.inject, ['slots', 'locale'], 'exports.inject');
eq(typeof exported.apply, 'function', 'exports.apply is a function');
eq(exported.SECTION_ID, 'accountPool', 'settings section id');
eq(exported.SECTION_ORDER, 14, 'settings section order');
eq(exported.NS, 'settings.accountPool', 'locale namespace');

// ------------------------------------------------- pure helpers

const { coolingOf, statusOf, formatRemaining, compact } = exported;

eq(compact(0), '0', 'compact: zero');
eq(compact(999), '999', 'compact: sub-thousand');
eq(compact(1234), '1.2k', 'compact: thousands with one decimal');
eq(compact(12_345), '12k', 'compact: five digits drops the decimal');
eq(compact(2_500_000), '2.5M', 'compact: millions');

const t0 = Date.parse('2026-01-01T00:00:00.000Z');
const tFn = (key, vars) => {
  const dict = { secondsShort: '{n} 秒', minutesShort: '{n} 分', hoursShort: '{n} 小时' };
  let text = dict[key] ?? key;
  for (const [name, value] of Object.entries(vars ?? {})) text = text.replaceAll(`{${name}}`, String(value));
  return text;
};
eq(formatRemaining(30_000, tFn), '30 秒', 'remaining: seconds');
eq(formatRemaining(120_000, tFn), '2 分', 'remaining: minutes');
eq(formatRemaining(7_200_000, tFn), '2 小时', 'remaining: hours');

const active = { status: 'active', rateLimitResetAt: null, overloadUntil: null, tempUnschedulableUntil: null, tempUnschedulableReason: '' };
eq(coolingOf(active, t0), null, 'cooling: a healthy account has no window');
eq(statusOf(active, t0).key, 'statusActive', 'status: healthy');
eq(statusOf({ ...active, status: 'error' }, t0).key, 'statusError', 'status: error wins');
eq(statusOf({ ...active, status: 'disabled' }, t0).key, 'statusDisabled', 'status: disabled');
eq(statusOf({ ...active, rateLimitResetAt: new Date(t0 + 60_000).toISOString() }, t0).key, 'statusCooling', 'status: a live window means cooling');
eq(coolingOf({ ...active, rateLimitResetAt: new Date(t0 - 1000).toISOString() }, t0), null, 'cooling: an elapsed window is not cooling');

// The furthest-future window wins, so the page never under-reports a wait.
const bothWindows = coolingOf({
  ...active,
  overloadUntil: new Date(t0 + 30_000).toISOString(),
  tempUnschedulableUntil: new Date(t0 + 300_000).toISOString(),
}, t0);
eq(bothWindows.until, t0 + 300_000, 'cooling: the longest window is reported');
eq(bothWindows.reasonKey, 'reasonTransport', 'cooling: transport reason');

const authWindow = coolingOf({
  ...active,
  tempUnschedulableUntil: new Date(t0 + 60_000).toISOString(),
  tempUnschedulableReason: 'auth-fail',
}, t0);
eq(authWindow.reasonKey, 'reasonAuthFail', 'cooling: an auth failure is labelled as such');

// ------------------------------------------------- registration

function makeCtx() {
  const state = { dictionaries: [], injections: [], effects: [], registered: [] };
  let dict = {};
  const slots = {
    inject: (slotName, contribute) => { state.injections.push({ slotName, contribute }); },
    register: (meta, render_) => {
      const entry = { meta, render: render_ };
      state.registered.push(entry);
      return entry;
    },
  };
  const locale = {
    register: (ns, dicts) => { state.dictionaries.push({ ns, dicts }); dict = dicts.zh; return () => {}; },
    bind: (ns) => (key, vars) => {
      let text = dict[key] ?? key;
      for (const [name, value] of Object.entries(vars ?? {})) text = text.replaceAll(`{${name}}`, String(value));
      return text;
    },
  };
  const ctx = {
    get: (serviceName) => ({ slots, locale }[serviceName]),
    effect: (fn) => { const disposer = fn(); state.effects.push(disposer); return disposer; },
  };
  return { ctx, state };
}

const { ctx, state } = makeCtx();
exported.apply(ctx);

eq(state.dictionaries.length, 1, 'apply registers one dictionary set');
eq(state.dictionaries[0].ns, 'settings.accountPool', 'dictionary namespace');
const zhKeys = Object.keys(state.dictionaries[0].dicts.zh).sort();
const enKeys = Object.keys(state.dictionaries[0].dicts.en).sort();
eq(enKeys, zhKeys, 'zh and en must declare exactly the same keys');

eq(state.injections.length, 3, 'apply occupies three slots');
const bySlot = {};
for (const injection of state.injections) bySlot[injection.slotName] = injection;
eq(
  Object.keys(bySlot).sort(),
  ['settings.models.footer', 'settings.models.provider-card', 'settings.section'],
  'the page, the Models footer card, and the pool provider card',
);

const entry = bySlot['settings.section'].contribute();
eq(entry.meta.name, 'settings.section', 'registration names its slot');
eq(entry.meta.id, 'accountPool', 'registration id');
eq(entry.meta.order, 14, 'registration order');
eq(entry.meta.locale, 'settings.accountPool', 'registration locale');
eq(entry.meta.label(), '账号池', 'the nav label comes from the locale');
eq(typeof entry.render, 'function', 'the registration renders');

const footer = bySlot['settings.models.footer'].contribute();
eq(footer.meta.name, 'settings.models.footer', 'the footer card names its slot');
eq(footer.meta.id, 'accountPool', 'the footer card id is fresh on that slot');
eq(footer.meta.order, 20, 'the footer card order');

const providerCard = bySlot['settings.models.provider-card'].contribute();
eq(providerCard.meta.name, 'settings.models.provider-card', 'the provider card names its slot');
eq(providerCard.meta.key, 'account-pool', 'the provider card is keyed by the Loader ENTRY ID');

// Styles are inserted once by apply, not per render.
eq(styleElements.length, 1, 'apply inserts exactly one stylesheet');
ok(styleElements[0].textContent.includes('.dap-root'), 'the stylesheet carries the page styles');

const page = entry.render({ close: () => {} });

// ------------------------------------------------- three states

const loading = await renderState(page, 'pending');
ok(textOf(loading.tree).includes('账号池'), 'loading state still shows the heading');
ok(textOf(loading.tree).includes('正在读取账号池'), 'loading state shows its message');
eq(styleElements.length, 1, 'rendering does not insert a second stylesheet');

const errored = await renderState(page, 'error');
ok(textOf(errored.tree).includes('domain exploded'), 'error state surfaces the Host message');

const ready = await renderState(page, 'ready');
const readyText = textOf(ready.tree);

ok(ready.calls.some((call) => call.url === 'api/accountPool.accounts'), 'the page reads the accounts route');
ok(ready.calls.some((call) => call.url === 'api/accountPool.usage?limit=50'), 'the page reads the usage route with the limit');

// Summary cards.
ok(readyText.includes('可用 2 · 冷却 1 · 异常 1'), `card hint counts the states, got: ${readyText.slice(0, 200)}`);
ok(readyText.includes('42'), 'card shows the total request count');
ok(readyText.includes('主号'), 'a labelled account shows its label');
ok(readyText.includes('a2'), 'an unlabelled account falls back to its id');
ok(readyText.includes('anthropic') && readyText.includes('gemini'), 'platforms are listed');
ok(readyText.includes('∞'), 'concurrency 0 renders as unlimited');
ok(readyText.includes('2 分'), 'a live window shows the remaining time');
ok(readyText.includes('限流'), 'the cooling reason is labelled');
ok(readyText.includes('claude-opus-4'), 'the usage table lists the model');
ok(readyText.includes('1.2k') && readyText.includes('7.9k'), 'usage tokens are compacted');
ok(readyText.includes('http-400') === false, 'the raw error code is not shown as a column value');

const readyClasses = classesIn(ready.tree);
const classDump = [...new Set(readyClasses)].join(' ');
ok(readyClasses.includes('dap-pill-ready'), 'a ready account renders a ready pill', classDump);
ok(readyClasses.includes('dap-pill-cooling'), 'a cooling account renders a cooling pill', classDump);
ok(readyClasses.includes('dap-pill-failed'), 'a failed account renders a failed pill', classDump);
ok(readyClasses.includes('dap-table'), 'tables are rendered');
eq(readyClasses.filter((name) => name === 'dap-panel').length, 3, 'three panels: accounts, groups and usage');

// ------------------------------------------------- switching: account actions

const actions = await renderState(page, 'ready');
const actionText = textOf(actions.tree);
ok(actionText.includes('操作'), 'the account table gained an actions column');
ok(actionText.includes('停用'), 'an enabled account offers disable');
ok(actionText.includes('启用'), 'a disabled account offers enable');
ok(actionText.includes('清冷却'), 'a cooling account offers clear-cooldown');
ok(actionText.includes('当前优先'), 'the preferred account is marked instead of offering a no-op switch');

const preferButtons = buttonsLabelled(actions.tree, '设为优先');
eq(preferButtons.length, 4, 'every NON-preferred account offers the switch (5 accounts, 1 preferred)');

await preferButtons[0].props.onClick();
await new Promise((resolve) => setImmediate(resolve));
const post = actions.calls.find((call) => call.method === 'POST');
ok(post !== undefined, 'clicking a switch button issues a POST');
eq(post?.url, 'api/accountPool.account', 'the POST targets the single write route');
eq(JSON.parse(post?.body), { id: 'a2', action: 'prefer' }, 'the body names the account and the action');

// ------------------------------------------------- the Models-page card

const footerState = await renderState(footer.render({ close: () => {} }), 'ready');
const footerText = textOf(footerState.tree);
ok(footerText.includes('号池管理'), 'the Models footer card is titled');
ok(footerText.includes('设为优先'), 'it offers the switch inline');
ok(footerText.includes('当前优先'), 'and marks the current preference');
ok(classesIn(footerState.tree).includes('dap-models'), 'the footer card uses its own dashed container');

// The footer keeps a button per row (disabled for the current preference) so the
// rows stay visually uniform; the wide table swaps it for plain text instead.
const footerButtons = buttonsLabelled(footerState.tree, '设为优先');
eq(footerButtons.length, 5, 'the footer card lists every account');
const footerSwitchable = footerButtons.filter((button) => button.props.disabled !== true);
eq(footerSwitchable.length, 4, 'all but the current preference are switchable');

await footerSwitchable[0].props.onClick();
await new Promise((resolve) => setImmediate(resolve));
eq(
  JSON.parse(footerState.calls.find((call) => call.method === 'POST')?.body),
  { id: 'a2', action: 'prefer' },
  'switching from the Models page hits the same route',
);

// ------------------------------------------------- the pool provider card

const providerState = await renderState(providerCard.render({ close: () => {} }), 'ready');
const providerText = textOf(providerState.tree);
ok(providerText.includes('5 个账号'), `the provider card summarises the pool, got: ${providerText}`);
ok(providerText.includes('可用 2'), 'and counts the ready accounts');
ok(providerText.includes('冷却 1'), 'and the cooling ones');

// ------------------------------------------------- account CRUD from the UI

/** Every `input` in the rendered tree, in document order. */
function inputsIn(tree) {
  const found = [];
  (function visit(node) {
    if (node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) visit(child); return; }
    if (node.type === 'input') found.push(node);
    for (const child of node.children ?? []) visit(child);
  })(expand(tree));
  return found;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const posts = (calls) => calls.filter((call) => call.method === 'POST');

const crud = await renderState(page, 'ready');
const crudText = textOf(crud.tree);
ok(crudText.includes('新增账号'), 'the page offers an add-account action');
ok(crudText.includes('凭据'), 'the table gained a credential column');
ok(crudText.includes('已配置') && crudText.includes('未配置'), 'credential state is reported per account, not the secret');
ok(crudText.includes('编辑') && crudText.includes('删除'), 'each row offers edit and delete');
eq(buttonsLabelled(crud.tree, '删除').length, 6, 'five account rows plus the one group row');

// Opening the create form must reveal a WRITE-ONLY key field.
buttonsLabelled(crud.tree, '新增账号')[0].props.onClick();
await settle();
const opened = render(page.type, page.props);
ok(textOf(opened).includes('ID（唯一，创建后不可改）'), 'the create form asks for an id');
const keyFields = inputsIn(opened).filter((input) => input.props.type === 'password');
eq(keyFields.length, 1, 'exactly one key field');
eq(keyFields[0].props.value, '', 'and the secret is never pre-filled');

// Fill the id and save. An untouched key field must send NO credential at all,
// which is what tells the host to leave the stored secret alone.
const textFields = inputsIn(opened).filter((input) => (input.props.type ?? 'text') === 'text');
ok(textFields.length >= 6, 'the form exposes the expected text fields');
// A real DOM input hands onChange an event, not a value — match that.
textFields[0].props.onChange({ target: { value: 'gamma' } });
await settle();
const filled = render(page.type, page.props);
const saveButton = buttonsLabelled(filled, '保存')[0];
ok(saveButton !== undefined, 'the form offers save');
await saveButton.props.onClick();
await settle();

const createBody = JSON.parse(posts(crud.calls).at(-1).body);
eq(createBody.action, 'create', 'saving a new account uses the create verb');
eq(createBody.id, 'gamma', 'the id comes from the form');
eq('credential' in createBody, false, 'an untouched key field sends no credential');
eq(createBody.account.platform, 'anthropic', 'the platform comes from the select');
eq(createBody.account.models, [], 'a blank model list means "all models"');

// Delete is armed by the first click and only fires on the second.
const beforeDelete = posts(crud.calls).length;
buttonsLabelled(crud.tree, '删除')[0].props.onClick();
await settle();
const armed = render(page.type, page.props);
ok(textOf(armed).includes('确认删除'), 'the first click arms the delete');
eq(posts(crud.calls).length, beforeDelete, 'and nothing is deleted yet');

buttonsLabelled(armed, '确认删除')[0].props.onClick();
await settle();
eq(JSON.parse(posts(crud.calls).at(-1).body).action, 'delete', 'the second click deletes');

// ------------------------------------------------- groups from the UI

const groupState = await renderState(page, 'ready');
const groupText = textOf(groupState.tree);
ok(groupText.includes('便宜池'), 'the groups panel lists the group');
ok(groupText.includes('pool-cheap'), 'and shows the provider route it produced');
ok(groupText.includes('cheap'), 'the account table shows which group a member belongs to');
ok(groupText.includes('未分组'), 'and marks the ones that belong to none');

// The account form draws membership from the groups that EXIST, and reflects the
// account's current membership — so a bad group id cannot be typed in.
buttonsLabelled(groupState.tree, '编辑')[0].props.onClick();
await settle();
const editingAccount = render(page.type, page.props);
const boxes = inputsIn(editingAccount).filter((input) => input.props.type === 'checkbox');
eq(boxes.length, 1, 'one checkbox per existing group');
eq(boxes[0].props.checked, true, 'a1 is already in it');

await boxes[0].props.onChange();
await settle();
const toggled = render(page.type, page.props);
eq(inputsIn(toggled).filter((input) => input.props.type === 'checkbox')[0].props.checked, false, 'clicking clears it');

await buttonsLabelled(toggled, '保存')[0].props.onClick();
await settle();
const membership = JSON.parse(posts(groupState.calls).at(-1).body);
eq(membership.action, 'update', 'membership is edited through the account CRUD');
eq(membership.account.groups, [], 'and the cleared set is what gets sent');

// Creating a group goes through the same single write route.
buttonsLabelled(groupState.tree, '新建分组')[0].props.onClick();
await settle();
const groupFormOpen = render(page.type, page.props);
ok(textOf(groupFormOpen).includes('会成为路由后缀'), 'the group form explains that the id becomes a route');

const groupFields = inputsIn(groupFormOpen).filter((input) => (input.props.type ?? 'text') === 'text');
groupFields[0].props.onChange({ target: { value: 'vip' } });
await settle();
await buttonsLabelled(render(page.type, page.props), '保存')[0].props.onClick();
await settle();
const madeGroup = JSON.parse(posts(groupState.calls).at(-1).body);
eq(madeGroup.action, 'group-create');
eq(madeGroup.id, 'vip', 'the group id travels as the TOP-LEVEL id, exactly like an account id');
eq(madeGroup.group.models, [], 'a blank allow-list means no extra restriction');

// ------------------------------------------------- import into a group

/** Every element of one host tag in the rendered tree. */
function nodesIn(tree, type) {
  const found = [];
  (function visit(node) {
    if (node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) visit(child); return; }
    if (node.type === type) found.push(node);
    for (const child of node.children ?? []) visit(child);
  })(expand(tree));
  return found;
}

/** Open the import box (it closes itself after a successful run) and fill it. */
async function fillImport(groupId, text) {
  const current = render(page.type, page.props);
  const openButton = buttonsLabelled(current, '导入')[0];
  if (openButton !== undefined) {
    openButton.props.onClick();
    await settle();
  }
  const opened = render(page.type, page.props);
  nodesIn(opened, 'select')[0].props.onChange({ target: { value: groupId } });
  await settle();
  const typed = render(page.type, page.props);
  nodesIn(typed, 'textarea')[0].props.onChange({ target: { value: text } });
  await settle();
}

const importState = await renderState(page, 'ready');
await fillImport('cheap', '{"accounts":[]}');
const importOpen = render(page.type, page.props);
ok(textOf(importOpen).includes('导入到分组'), 'the import panel offers a target group');
eq(nodesIn(importOpen, 'select').length, 1, 'exactly one target-group select');

await buttonsLabelled(importOpen, '开始导入')[0].props.onClick();
await settle();
const intoGroup = JSON.parse(posts(importState.calls).at(-1).body);
eq(intoGroup.action, 'import');
eq(intoGroup.group, 'cheap', 'the chosen group travels with the import');

// "No group" must OMIT the field: an empty id would be looked up and rejected.
await fillImport('', '{"accounts":[]}');
await buttonsLabelled(render(page.type, page.props), '开始导入')[0].props.onClick();
await settle();
const ungrouped = JSON.parse(posts(importState.calls).at(-1).body);
eq('group' in ungrouped, false, 'choosing no group omits the field entirely');

// ------------------------------------------------- report

if (failures.length > 0) {
  for (const { label, error } of failures) console.error(`✗ ${label}\n    ${error.message}`);
  console.error(`\n${passed}/${checks} 通过，${failures.length} 失败`);
  process.exitCode = 1;
} else {
  console.log(`✓ ${passed}/${checks} 通过`);
}
