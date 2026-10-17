/** Offline local-API UI contract tests. Run: node tools/local-api-client-test.mjs
 * Loads the shipped bundle and navigates its actual settings tab. No dependencies,
 * browser, DSH, server, credentials, or network; effects commit after rendering.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
let checks = 0;
function check(value, message) { checks += 1; assert.ok(value, message); }
function equal(value, expected, message) { checks += 1; assert.deepEqual(value, expected, message); }
const pause = () => new Promise(resolve => setImmediate(resolve));
const status = (overrides = {}) => ({ enabled: false, port: 19389, running: false, baseUrl: 'http://127.0.0.1:19389/v1', keyConfigured: false, error: null, ...overrides });
const response = (body, ok = true, code = ok ? 200 : 500) => ({ ok, status: code, json: async () => body });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function nodes(tree, type) {
  const result = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (type === undefined || node.type === type) result.push(node);
    node.children?.forEach(walk);
  }
  walk(tree); return result;
}
function text(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(text).join('');
  if (typeof node !== 'object') return String(node);
  return node.children.map(text).join('');
}

function harness({ settings = status(), version = 1, locale = 'zh' } = {}) {
  const fixture = { settings, version, read: null, post: null, posts: [], reads: [], clipboard: [], clipboardWrite: null, logs: [], storage: [] };
  const scopes = new Map(), ids = new WeakMap(), intervals = new Map(), timeouts = new Map();
  let nextId = 0, timerId = 0, scope, dirty, effects, visited, tree, page;
  const componentId = fn => { if (!ids.has(fn)) ids.set(fn, ++nextId); return ids.get(fn); };
  const React = {
    Fragment: 'fragment',
    createElement(type, props, ...children) { return { type, props: { ...props, children: children.length === 1 ? children[0] : children }, children }; },
    useState(initial) {
      const owner = scope, slot = `state:${owner.cursor++}`;
      if (!(slot in owner.values)) owner.values[slot] = typeof initial === 'function' ? initial() : initial;
      return [owner.values[slot], next => {
        const value = typeof next === 'function' ? next(owner.values[slot]) : next;
        if (!Object.is(value, owner.values[slot])) { owner.values[slot] = value; dirty = true; }
      }];
    },
    useRef(initial) {
      const slot = `ref:${scope.cursor++}`;
      if (!(slot in scope.values)) scope.values[slot] = { current: initial };
      return scope.values[slot];
    },
    useEffect(effect, deps) {
      const owner = scope, slot = `effect:${owner.cursor++}`, old = owner.effects[slot];
      if (old && deps && old.deps && deps.length === old.deps.length && deps.every((item, i) => Object.is(item, old.deps[i]))) return;
      owner.effects[slot] = { deps };
      effects.push(() => { old?.cleanup?.(); owner.effects[slot].cleanup = effect(); });
    },
  };
  function expand(node, path) {
    if (node == null || typeof node === 'boolean') return null;
    if (typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((child, i) => expand(child, `${path}/${child?.props?.key ?? i}`));
    if (typeof node.type === 'function') {
      const id = `${path}/component:${componentId(node.type)}`;
      if (!scopes.has(id)) scopes.set(id, { values: {}, effects: {}, cursor: 0 });
      const previous = scope; scope = scopes.get(id); scope.cursor = 0; visited.add(id);
      let result;
      try { result = node.type(node.props); } finally { scope = previous; }
      return expand(result, `${id}/render`);
    }
    return { ...node, children: node.children.map((child, i) => expand(child, `${path}/${child?.props?.key ?? i}`)) };
  }
  function view() {
    for (let round = 0; round < 40; round++) {
      dirty = false; visited = new Set(); effects = [];
      tree = expand(page, 'root');
      for (const [id, old] of scopes) if (!visited.has(id)) {
        Object.values(old.effects).forEach(value => value.cleanup?.()); scopes.delete(id);
      }
      effects.forEach(effect => effect());
      if (!dirty) return tree;
    }
    throw new Error('Render failed to converge');
  }
  const makeElement = () => ({ parentNode: null, textContent: '', setAttribute() {}, querySelectorAll() { return []; }, appendChild(child) { child.parentNode = this; }, removeChild(child) { child.parentNode = null; } });
  const document = { head: makeElement(), documentElement: makeElement(), createElement: makeElement, addEventListener() {}, removeEventListener() {} };
  let registration, dictionaries, language = locale;
  const injections = new Map();
  const ctx = {
    get(name) {
      if (name === 'slots') return { inject(slot, callback) { injections.set(slot, callback); }, register(meta, render) { return { meta, render }; } };
      if (name === 'locale') return {
        register(ns, dict) { dictionaries = dict; return () => {}; },
        bind() { return (key, vars) => { let value = dictionaries[language][key] ?? key; for (const [name, replacement] of Object.entries(vars ?? {})) value = value.replaceAll(`{${name}}`, String(replacement)); return value; }; },
      };
    },
    effect(fn) { return fn(); },
  };
  async function fetch(url, init = {}) {
    equal(init.credentials, 'same-origin', `authenticated request: ${url}`);
    if (init.method === 'POST') {
      const payload = JSON.parse(init.body); fixture.posts.push({ url, payload, init });
      if (fixture.post) return fixture.post(payload, init);
      if (payload.action === 'local-api-rotate-key') {
        fixture.settings = { ...fixture.settings, keyConfigured: true };
        return response({ ok: true, localApi: fixture.settings, apiKey: 'fixture-local-key-once' });
      }
      if (payload.action === 'local-api-update') {
        fixture.settings = { ...fixture.settings, enabled: payload.enabled, port: payload.port, running: payload.enabled, baseUrl: `http://127.0.0.1:${payload.port}/v1` };
        return response({ ok: true, localApi: fixture.settings });
      }
      throw new Error(`Unexpected POST: ${payload.action}`);
    }
    fixture.reads.push({ url, init });
    if (url === 'api/accountPool.accounts') {
      if (fixture.read) return fixture.read(init);
      return response({ accounts: [], groups: [], bindings: [], counts: {}, totalRequests: 0, managementVersion: 2,
        localApiVersion: fixture.version, localApi: fixture.settings,
        codexCompatibilityVersion: 1, codexCompatibility: { encryptedCompactionV2: false, available: true } });
    }
    if (url.startsWith('api/accountPool.usage')) return response({ rows: [] });
    if (url === 'api/accountPool.oauth') return response({ providers: [], flows: [] });
    return response({ error: { message: 'Optional companion unavailable' } }, false, 404);
  }
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { registration = value; } }, addEventListener() {}, removeEventListener() {} },
    document, fetch, AbortController, URL, console: { error: (...args) => fixture.logs.push(args), log: (...args) => fixture.logs.push(args) },
    navigator: { clipboard: { async writeText(value) { if (fixture.clipboardWrite) await fixture.clipboardWrite(value); fixture.clipboard.push(value); } } },
    localStorage: { setItem: (...args) => fixture.storage.push(args), getItem: () => null },
    sessionStorage: { setItem: (...args) => fixture.storage.push(args), getItem: () => null },
    setInterval(fn, ms) { const id = ++timerId; intervals.set(id, { fn, ms }); return id; }, clearInterval(id) { intervals.delete(id); },
    setTimeout(fn, ms) { const id = ++timerId; timeouts.set(id, { fn, ms }); return id; }, clearTimeout(id) { timeouts.delete(id); },
  };
  vm.runInNewContext(source, sandbox, { filename: 'client.js' });
  const exported = registration.factory(name => { if (name === 'react') return React; throw new Error(`Unexpected require: ${name}`); });
  exported.apply(ctx);
  page = injections.get('settings.section')().render({});
  const local = () => nodes(view(), 'section').find(node => node.props.className?.includes('dap-local-api'));
  const button = (key, root = local()) => nodes(root, 'button').find(node => text(node) === dictionaries[language][key]);
  const input = key => nodes(local(), 'input').find(node => node.props['aria-label'] === dictionaries[language][key]);
  async function settle() { for (let i = 0; i < 3; i++) { await pause(); view(); } }
  function tab(id) { nodes(view(), 'button').find(node => node.props.id === `dap-tab-${id}`).props.onClick(); view(); }
  return {
    fixture, view, local, button, input, settle, tab, dictionaries: () => dictionaries,
    async open() { view(); await settle(); tab('settings'); await settle(); },
    change(key, value) { const field = input(key); field.props.onChange({ target: key === 'localApiEnable' ? { checked: value } : { value } }); view(); },
    save() { return nodes(local(), 'form')[0].props.onSubmit({ preventDefault() {} }); },
    poll() { for (const timer of [...intervals.values()]) if (timer.ms === 15000) timer.fn(); view(); },
    timeout() { for (const timer of [...timeouts.values()]) if (timer.ms === 30000) timer.fn(); },
    locale(value) { language = value; view(); },
    inMemory() { return JSON.stringify([...scopes.values()].map(value => value.values)); },
    unmount() { for (const old of scopes.values()) Object.values(old.effects).forEach(value => value.cleanup?.()); scopes.clear(); },
  };
}

// Actual settings-tab placement, localization, setup order, payloads and one-shot key.
{
  const ui = harness(); ui.view(); await ui.settle();
  check(!ui.local(), 'Local API is mounted lazily under Settings');
  ui.tab('settings'); await ui.settle();
  const dicts = ui.dictionaries();
  equal(Object.keys(dicts.zh).sort(), Object.keys(dicts.en).sort(), 'Locale keys remain balanced');
  check(text(ui.local()).includes('127.0.0.1') && text(ui.local()).includes('/v1/chat/completions') && text(ui.local()).includes('原始池内密钥'), 'Card describes loopback, protocol and credential isolation');
  equal(ui.input('localApiPort').props.value, '19389', 'Default port is 19389');
  equal([ui.input('localApiPort').props.min, ui.input('localApiPort').props.max, ui.input('localApiPort').props.step], [1024, 65535, 1], 'Port constraints reach input');
  check(ui.input('localApiEnable').props.disabled, 'Enable is gated until a key is configured');
  check(text(ui.local()).includes('keyConfigured') && text(ui.local()).includes('running') && text(ui.local()).includes('error'), 'All required runtime fields are displayed');
  ui.change('localApiEnable', true); equal(ui.input('localApiEnable').props.checked, false, 'Disabled handler cannot enable without a key');
  await ui.button('localApiGenerate').props.onClick(); await ui.settle();
  equal(ui.fixture.posts[0].payload, { action: 'local-api-rotate-key' }, 'Generation has no id or settings side effects');
  equal(ui.input('localApiKeyLabel').props.value, 'fixture-local-key-once', 'Successful rotation displays its key once');
  check(!ui.input('localApiEnable').props.disabled, 'Key generation unlocks enable');
  await ui.button('localApiCopyKey').props.onClick(); await ui.settle();
  equal(ui.fixture.clipboard.at(-1), 'fixture-local-key-once', 'Explicit key copy writes clipboard');
  check(text(ui.local()).includes(dicts.zh.localApiKeyCopied), 'Clipboard success is reported only after completion');
  await ui.button('localApiCopyBaseUrl').props.onClick(); await ui.settle();
  equal(ui.fixture.clipboard.at(-1), 'http://127.0.0.1:19389/v1', 'Copies actual Host base URL');
  ui.change('localApiPort', '19400'); ui.change('localApiEnable', true);
  await ui.save(); await ui.settle();
  equal(ui.fixture.posts[1].payload, { action: 'local-api-update', enabled: true, port: 19400 }, 'Save sends typed settings without id');
  check(text(ui.local()).includes('运行中') && text(ui.local()).includes('http://127.0.0.1:19400/v1'), 'Save adopts runtime snapshot, not a guessed URL');
  ui.button('localApiCloseKey').props.onClick(); ui.view();
  check(!ui.input('localApiKeyLabel') && !ui.inMemory().includes('fixture-local-key-once'), 'Close clears the key from current component state');
  const posts = ui.fixture.posts.length;
  ui.button('localApiRotate').props.onClick(); ui.view();
  equal(ui.fixture.posts.length, posts, 'Existing key requires explicit second-step confirmation');
  check(text(ui.local()).includes('旧 API Key 将立即失效') && text(ui.local()).includes('后续调用会失败'), 'Rotation warns of client interruption');
  ui.button('cancel').props.onClick(); ui.view(); equal(ui.fixture.posts.length, posts, 'Cancelling does not rotate');
  ui.button('localApiRotate').props.onClick(); ui.view(); await ui.button('localApiConfirmRotate').props.onClick(); await ui.settle();
  ui.change('localApiPort', '19401');
  const oldKeyCopy = ui.button('localApiCopyKey').props.onClick;
  ui.tab('accounts');
  check(!nodes(ui.view(), 'input').some(node => node.props.value === 'fixture-local-key-once'), 'Leaving Settings removes key from hidden DOM too');
  check(!ui.inMemory().includes('fixture-local-key-once'), 'Leaving Settings clears component key memory');
  await oldKeyCopy(); equal(ui.fixture.clipboard.length, 2, 'Stale key-copy callback is revoked after leaving');
  ui.tab('settings'); await ui.settle();
  equal(ui.input('localApiPort').props.value, '19401', 'Ordinary draft survives tab switch');
  check(!ui.input('localApiKeyLabel'), 'Returning never recovers a cleared key from GET');
  ui.locale('en'); check(text(ui.local()).includes('Local API') && text(ui.local()).includes('Unsaved changes'), 'English locale renders card and draft state');
  equal(ui.fixture.storage, [], 'Local key never enters browser storage'); equal(ui.fixture.logs, [], 'Local key never enters logs');
  ui.unmount();
}

// Unsupported/malformed Host capability cannot save, even through stale callbacks.
for (const version of [undefined, 0, 2, '1']) {
  const ui = harness({ version: 0 }); ui.fixture.version = version;
  await ui.open();
  check(text(ui.local()).includes('请更新并重启 DSH'), `Unsupported version ${String(version)} explains upgrade`);
  check(ui.button('save').props.disabled && ui.button('localApiGenerate').props.disabled, 'Unsupported Host disables writes');
  await ui.save(); await ui.button('localApiGenerate').props.onClick(); equal(ui.fixture.posts.length, 0, 'Unsupported callbacks never POST'); ui.unmount();
}
for (const malformed of [{ port: '19389' }, { running: 1 }, { keyConfigured: null }, { error: {} }, { baseUrl: null }, { port: 65536 }]) {
  const ui = harness({ settings: status(malformed) }); await ui.open();
  check(ui.button('save').props.disabled && text(ui.local()).includes('请更新并重启 DSH'), 'Malformed capability fails closed'); ui.unmount();
}

// Validation, independent drafts, polling and external state changes.
{
  const ui = harness({ settings: status({ keyConfigured: true }) }); await ui.open();
  for (const port of ['', '1023', '65536', '19389.1', '-1', '1e4', 'Infinity', ' 19389 ']) {
    ui.change('localApiPort', port); check(ui.button('save').props.disabled, `Reject invalid port ${port}`);
    await ui.save(); equal(ui.fixture.posts.length, 0, 'Invalid port emits no POST');
  }
  for (const port of ['1024', '65535']) {
    ui.change('localApiPort', port); await ui.save(); await ui.settle(); equal(ui.fixture.posts.at(-1).payload.port, Number(port), 'Boundary port is accepted as number');
  }
  ui.change('localApiPort', '19500'); ui.change('localApiEnable', true);
  ui.fixture.settings = status({ keyConfigured: true, port: 19444, baseUrl: 'http://127.0.0.1:19444/v1', error: 'EADDRINUSE' });
  ui.poll(); await ui.settle();
  equal(ui.input('localApiPort').props.value, '19500', 'Polling does not overwrite port draft');
  equal(ui.input('localApiEnable').props.checked, true, 'Polling does not overwrite enabled draft');
  check(text(ui.local()).includes('EADDRINUSE') && text(ui.local()).includes(':19444/v1'), 'Polling still updates live runtime status');
  ui.button('localApiRotate').props.onClick(); ui.view(); await ui.button('localApiConfirmRotate').props.onClick(); await ui.settle();
  equal(ui.input('localApiPort').props.value, '19500', 'Rotation does not overwrite independent unsaved port');
  ui.button('localApiDiscard').props.onClick(); ui.view(); equal(ui.input('localApiPort').props.value, '19444', 'Discard explicitly adopts latest Host state');
  const savedHandler = nodes(ui.local(), 'form')[0].props.onSubmit;
  ui.fixture.version = 0; ui.poll();
  await savedHandler({ preventDefault() {} });
  await ui.settle(); const count = ui.fixture.posts.length;
  await savedHandler({ preventDefault() {} }); equal(ui.fixture.posts.length, count, 'Capability loss revokes old callbacks');
  ui.unmount();
}

// HTTP and logical failures, malformed/missing rotation keys, reconciliation, no false success.
for (const reply of [
  () => response({ ok: true, localApi: status({ keyConfigured: true }), apiKey: 'never-show-http-failed' }, false, 500),
  () => response({ ok: false, error: { message: 'fixture denied' }, apiKey: 'never-show-logical-failed' }),
  () => response({ localApi: status({ keyConfigured: true }), apiKey: 'never-show-missing-ok' }),
  () => response({ ok: true, localApi: { port: 19389 }, apiKey: 'never-show-bad-shape' }),
  () => response({ ok: true, localApi: status({ keyConfigured: true }) }),
  () => ({ ok: true, status: 200, json: async () => { throw new Error('bad JSON'); } }),
  () => { throw new Error('fixture network failure'); },
]) {
  const ui = harness(); await ui.open(); ui.fixture.post = reply;
  await ui.button('localApiGenerate').props.onClick(); await ui.settle();
  check(!ui.input('localApiKeyLabel'), 'Failed rotation never reveals a key');
  check(!text(ui.local()).includes(ui.dictionaries().zh.localApiKeyCreated), 'Failed rotation never claims success');
  check(nodes(ui.local()).some(node => node.props.role === 'alert'), 'Failure is announced');
  equal(ui.fixture.posts.length, 1, 'Failure never retries POST'); ui.unmount();
}
{
  const ui = harness({ settings: status({ keyConfigured: true }) }); await ui.open();
  ui.change('localApiPort', '19555'); ui.fixture.post = () => response({ ok: false, error: { message: 'save denied' } });
  await ui.save(); await ui.settle();
  equal(ui.input('localApiPort').props.value, '19555', 'Failed save retains draft');
  check(!text(ui.local()).includes(ui.dictionaries().zh.localApiSaved) && text(ui.local()).includes('save denied'), 'Failed save shows error, never saved');
  ui.fixture.read = () => response({ error: { message: 'read denied' } }, false, 503);
  await ui.button('refresh').props.onClick(); await ui.settle();
  check(ui.button('save').props.disabled && text(ui.local()).includes('草稿已保留'), 'Read failure pauses writes and explains retained draft');
  equal(ui.input('localApiPort').props.value, '19555', 'Read failure preserves draft too'); ui.unmount();
}

// Same-turn duplicate protection, busy inputs and late key responses after navigation.
{
  const ui = harness(); await ui.open(); const pending = deferred(); ui.fixture.post = () => pending.promise;
  const generate = ui.button('localApiGenerate').props.onClick;
  const first = generate(); await generate(); ui.view();
  equal(ui.fixture.posts.length, 1, 'Same-turn double generation sends one POST');
  check(ui.input('localApiPort').props.disabled && ui.button('save').props.disabled && ui.button('refresh').props.disabled, 'Busy disables edit/save/refresh');
  ui.tab('accounts'); ui.tab('settings');
  ui.fixture.settings = status({ keyConfigured: true });
  pending.resolve(response({ ok: true, localApi: ui.fixture.settings, apiKey: 'late-secret-never-revealed' }));
  await first; await ui.settle();
  check(!ui.input('localApiKeyLabel') && !ui.inMemory().includes('late-secret-never-revealed'), 'Late response from a prior visit cannot restore a secret');
  check(!text(ui.local()).includes(ui.dictionaries().zh.localApiKeyCreated), 'Late response cannot restore prior-visit notice'); ui.unmount();
}
{
  const ui = harness({ settings: status({ keyConfigured: true }) }); await ui.open();
  ui.change('localApiPort', '19600'); const pending = deferred(); ui.fixture.post = () => pending.promise;
  const first = ui.save(); const duplicate = await ui.save();
  equal(duplicate, false, 'Same-turn duplicate save is rejected'); equal(ui.fixture.posts.length, 1, 'Only one settings POST');
  ui.change('localApiPort', '19700'); equal(ui.input('localApiPort').props.value, '19600', 'Busy handler cannot mutate submitted draft');
  pending.resolve(response({ ok: true, localApi: status({ port: 19600, keyConfigured: true, error: 'EADDRINUSE', baseUrl: 'http://127.0.0.1:19600/v1' }) }));
  await first; await ui.settle();
  check(text(ui.local()).includes('未运行') && text(ui.local()).includes('EADDRINUSE'), 'Saved configuration never implies running when bind failed'); ui.unmount();
}

// Clipboard promises and failure notices cannot claim success early or leak thrown secrets.
{
  const ui = harness(); await ui.open(); await ui.button('localApiGenerate').props.onClick(); await ui.settle();
  const copy = deferred(); ui.fixture.clipboardWrite = () => copy.promise;
  const work = ui.button('localApiCopyKey').props.onClick(); ui.view();
  check(!text(ui.local()).includes(ui.dictionaries().zh.localApiKeyCopied), 'Pending copy does not claim success');
  copy.reject(new Error('fixture-local-key-once must not appear in error'));
  await work; await ui.settle();
  check(text(ui.local()).includes(ui.dictionaries().zh.localApiCopyFailed) && !text(ui.local()).includes('must not appear'), 'Copy errors are generic, not secret-bearing exception text');
  ui.button('localApiCloseKey').props.onClick(); ui.view(); check(!ui.inMemory().includes('fixture-local-key-once'), 'Closing after copy failure clears all component references');
  equal(ui.fixture.logs, [], 'No clipboard failure logged'); ui.unmount();
}
{
  const ui = harness(); await ui.open(); await ui.button('localApiGenerate').props.onClick(); await ui.settle();
  const copy = deferred(); ui.fixture.clipboardWrite = () => copy.promise;
  const work = ui.button('localApiCopyKey').props.onClick(); ui.tab('accounts'); copy.resolve();
  await work; await ui.settle(); ui.tab('settings'); await ui.settle();
  check(!text(ui.local()).includes(ui.dictionaries().zh.localApiKeyCopied), 'Late clipboard completion cannot restore notice after leaving'); ui.unmount();
}

// Host may optionally return the first key with successful update; keep it equally private.
{
  const ui = harness({ settings: status({ keyConfigured: true }) }); await ui.open();
  ui.change('localApiEnable', true);
  ui.fixture.post = () => response({ ok: true, localApi: status({ enabled: true, running: true, keyConfigured: true }), apiKey: 'optional-update-key' });
  await ui.save(); await ui.settle(); equal(ui.input('localApiKeyLabel').props.value, 'optional-update-key', 'Optional update-response key uses one-shot display');
  ui.tab('accounts'); check(!ui.inMemory().includes('optional-update-key'), 'Optional update key is cleared on leaving too'); ui.unmount();
}
// Lost mutation replies reconcile by GET before another generation can proceed.
{
  const ui = harness(); await ui.open();
  const staleGenerate = ui.button('localApiGenerate').props.onClick;
  ui.fixture.post = () => {
    ui.fixture.settings = status({ keyConfigured: true });
    throw new Error('reply lost after key was created');
  };
  await staleGenerate(); await ui.settle();
  check(!ui.input('localApiKeyLabel'), 'An ambiguous rotation does not fabricate a recoverable key');
  check(ui.button('localApiRotate'), 'Reconciliation discovers configured key after lost reply');
  await staleGenerate(); ui.view();
  equal(ui.fixture.posts.length, 1, 'Even a stale Generate handler requires confirmation after reconciliation');
  check(ui.button('localApiConfirmRotate'), 'Existing key confirmation appears after ambiguous generation'); ui.unmount();
}

// Refresh revokes old callbacks immediately; timed-out/cancelled reads cannot restore capability.
{
  const ui = harness({ settings: status({ keyConfigured: true }) }); await ui.open();
  const read = deferred(); ui.fixture.read = () => read.promise;
  const oldSubmit = nodes(ui.local(), 'form')[0].props.onSubmit;
  const refresh = ui.button('refresh').props.onClick();
  await oldSubmit({ preventDefault() {} });
  equal(ui.fixture.posts.length, 0, 'Starting a refresh revokes stale save callbacks synchronously');
  ui.view(); check(ui.button('save').props.disabled && text(ui.local()).includes('正在读取本机 API'), 'Loading state disables writes');
  ui.timeout();
  read.resolve(response({ localApiVersion: 1, localApi: status({ keyConfigured: true }) }));
  await refresh; await ui.settle();
  check(ui.button('save').props.disabled && text(ui.local()).includes('读取超时'), 'Late successful fetch after timeout remains an error');
  ui.fixture.read = null;
  await ui.button('refresh').props.onClick(); await ui.settle();
  check(!ui.button('save').props.disabled, 'Explicit refresh recovers timed-out capability');
  const stale = deferred(); ui.fixture.read = () => stale.promise;
  const work = ui.button('refresh').props.onClick();
  ui.tab('accounts'); ui.fixture.read = null; ui.tab('settings'); await ui.settle();
  stale.resolve(response({ localApiVersion: 1, localApi: status({ keyConfigured: true, port: 19999, baseUrl: 'http://127.0.0.1:19999/v1' }) }));
  await work; await ui.settle();
  equal(ui.input('localApiPort').props.value, '19389', 'Cancelled prior-visit GET cannot overwrite a newer snapshot'); ui.unmount();
}
{
  const ui = harness(); await ui.open(); const work = deferred();
  ui.fixture.post = () => work.promise;
  const rotation = ui.button('localApiGenerate').props.onClick();
  ui.timeout();
  work.resolve(response({ ok: true, localApi: status({ keyConfigured: true }), apiKey: 'timed-out-key-never-shown' }));
  await rotation; await ui.settle();
  check(!ui.input('localApiKeyLabel') && !ui.inMemory().includes('timed-out-key-never-shown'), 'Timed-out POST response cannot expose key or claim success');
  equal(ui.fixture.posts.length, 1, 'Timed-out rotation is never replayed automatically'); ui.unmount();
}
{
  const ui = harness(); await ui.open(); const work = deferred();
  ui.fixture.post = () => work.promise;
  const rotate = ui.button('localApiGenerate').props.onClick(); ui.unmount();
  work.resolve(response({ ok: true, localApi: status({ keyConfigured: true }), apiKey: 'unmounted-key-never-shown' }));
  await rotate;
  equal(ui.inMemory(), '[]', 'Unmounted card retains no late secret state'); equal(ui.fixture.logs, [], 'Unmounting pending mutation produces no secret logs');
}
console.log(`Local API client: ${checks}/${checks} checks passed (offline, no deployment).`);
