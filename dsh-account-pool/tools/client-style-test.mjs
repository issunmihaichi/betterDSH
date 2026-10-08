/** Independent DOM/lifecycle regression tests against the shipped client bundle.
 * node tools/client-style-test.mjs [path/to/lib/client.js]
 * No DOM package, network, timers, or source exports added for testing.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const bundlePath = process.argv[2] ?? new URL('../lib/client.js', import.meta.url);
const source = readFileSync(bundlePath, 'utf8');
const marker = 'style-regression-generation';

function environment({ observer = true } = {}) {
  let writes = 0;
  const observers = [];
  function notify(target, type) {
    for (const item of observers) {
      if (item.targets.some(({ node, options }) => (node === target || options.subtree && node.contains(target)) && options[type])) item.pending = true;
    }
  }
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.parentNode = null; this.children = []; this.attrs = new Map(); this.text = ''; }
    get textContent() { return this.text; }
    set textContent(value) {
      writes += 1;
      this.text = String(value);
      for (const child of this.children) child.parentNode = null;
      this.children = [];
      notify(this, 'childList');
      notify(this, 'characterData');
    }
    get isConnected() { return this === document.documentElement || !!this.parentNode?.isConnected; }
    contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
    setAttribute(key, value) { writes += 1; this.attrs.set(key, String(value)); }
    getAttribute(key) { return this.attrs.get(key) ?? null; }
    appendChild(child) { return this.insertBefore(child, null); }
    insertBefore(child, before) {
      if (before !== null && before.parentNode !== this) throw Error('insertBefore anchor is not a child');
      if (child === before) return child;
      if (child.parentNode) child.parentNode.removeChild(child);
      const at = before === null ? this.children.length : this.children.indexOf(before);
      this.children.splice(at, 0, child); child.parentNode = this;
      writes += 1; notify(this, 'childList'); return child;
    }
    removeChild(child) {
      const at = this.children.indexOf(child);
      if (at === -1) throw Error('removeChild target is not a child');
      this.children.splice(at, 1); child.parentNode = null;
      writes += 1; notify(this, 'childList'); return child;
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    querySelectorAll(selector) {
      assert.equal(selector, 'style[data-dsh-plugin="dsh-account-pool"]');
      const found = [];
      const visit = (parent) => {
        for (const child of parent.children) {
          if (child.tagName === 'STYLE' && child.getAttribute('data-dsh-plugin') === 'dsh-account-pool') found.push(child);
          visit(child);
        }
      };
      visit(this); return found;
    }
  }
  const document = {
    documentElement: new Element('html'),
    createElement: (tag) => new Element(tag),
    get head() { return this.documentElement.children.find((node) => node.tagName === 'HEAD') ?? null; },
  };
  document.documentElement.appendChild(new Element('head'));
  document.documentElement.appendChild(new Element('body'));
  class Observer {
    constructor(callback) { this.callback = callback; this.targets = []; this.pending = false; observers.push(this); }
    observe(node, options) { this.targets.push({ node, options }); }
    disconnect() { this.targets = []; this.pending = false; }
  }
  function flush() {
    let rounds = 0;
    while (observers.some((item) => item.pending)) {
      if (++rounds > 20) throw Error('MutationObserver repair did not converge');
      for (const item of [...observers]) {
        if (!item.pending) continue;
        item.pending = false;
        if (item.targets.length) item.callback([], item);
      }
    }
  }
  const stopped = Symbol('captured first effect');
  let capturedEffect;
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useEffect(factory, deps) { capturedEffect = { factory, deps }; throw stopped; },
  };
  let exported;
  const window = { __ModuleLoader__: { load(definition) { exported = definition.factory((name) => { assert.equal(name, 'react'); return React; }); } } };
  const sandbox = { window, document, console, AbortController, fetch: async () => ({ ok: true, json: async () => ({ settingsNs: 'style-test' }) }) };
  if (observer) sandbox.MutationObserver = Observer;
  const context = vm.createContext(sandbox);
  async function load(generation = 'A') {
    // Use visibly different CSS to test cascade order across independent factories.
    const changed = source.replace('const CSS = `', `const CSS = ` + '`' + `\n/* ${marker}:${generation} */`);
    assert.notEqual(changed, source, 'CSS declaration fixture must exist');
    vm.runInContext(changed, context, { filename: String(bundlePath) });
    const effects = new Map();
    const injections = new Map();
    const entries = [];
    const slots = {
      inject(name, contribute) { injections.set(name, contribute); },
      register(meta, render) { entries.push({ meta, render }); return () => {}; },
    };
    const locale = { bind: () => (key) => key, register: () => () => {} };
    const ctx = {
      get: (name) => ({ slots, locale }[name]),
      effect(factory, label) { const release = factory(); effects.set(label, release); return release; },
    };
    exported.apply(ctx);
    injections.get('settings.section')();
    const releaseProviderSlot = injections.get('settings.models.provider-card')();
    // Let the provider registration's asynchronous fetch/json chain complete.
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    const page = entries.find((entry) => entry.meta.name === 'settings.section').render({ close() {} });
    const providerEntry = entries.find((entry) => entry.meta.name === 'settings.models.provider-card');
    assert.ok(providerEntry, 'real provider slot registered');
    const provider = providerEntry.render({ provider: { provider: 'pool-test' } });
    function mount(root) {
      capturedEffect = null;
      assert.throws(() => root.type(root.props), (error) => error === stopped);
      assert.ok(capturedEffect, 'root requests a style effect before any data hooks');
      assert.equal(capturedEffect.deps.length, 0, 'style lease is a mount effect');
      return capturedEffect.factory();
    }
    return { page, provider, mount, pluginRelease: effects.get('account-pool: stylesheet'), releaseProviderSlot };
  }
  return {
    document, observers, flush, load,
    styles: () => document.head?.querySelectorAll('style[data-dsh-plugin="dsh-account-pool"]') ?? [],
    activeObservers: () => observers.filter((item) => item.targets.length),
    get writes() { return writes; },
  };
}

function generationOf(element) { return element.textContent.match(new RegExp(`${marker}:([^ ]+)`))?.[1]; }
function assertGenerations(env, expected) { assert.deepEqual(env.styles().map(generationOf), expected); }

// Fixtures use real module registration and real acquire/release effect bodies;
// all page networking and timers are excluded by stopping at the first hook.
test('plugin/root leases survive independent cleanup and release exactly once', async () => {
  const env = environment();
  const module = await env.load();
  const releasePage = module.mount(module.page);
  const releaseProvider = module.mount(module.provider);
  assert.equal(env.styles().length, 1);
  assert.equal(env.activeObservers().length, 1);
  module.pluginRelease(); module.pluginRelease();
  assert.equal(env.styles().length, 1, 'mounted roots retain CSS after plugin unload');
  releasePage(); releasePage();
  assert.equal(env.styles().length, 1, 'second component retains CSS');
  const callback = env.activeObservers()[0].callback;
  releaseProvider(); releaseProvider();
  assert.equal(env.styles().length, 0);
  assert.equal(env.activeObservers().length, 0);
  const writes = env.writes;
  callback([], env.observers[0]);
  env.flush();
  assert.equal(env.writes, writes, 'stale queued callbacks cannot revive released styles');
  // A completely cleaned manager can mount again (StrictMode-style remount).
  const again = module.mount(module.page);
  assert.equal(env.styles().length, 1);
  assert.equal(env.activeObservers().length, 1);
  again();
  assert.equal(env.styles().length, 0);
  assert.equal(env.activeObservers().length, 0);
  module.releaseProviderSlot();
});

test('style removal and text clearing recover, then converge without writes', async () => {
  const env = environment();
  const module = await env.load();
  env.flush();
  const original = env.styles()[0];
  const css = original.textContent;
  original.remove();
  assert.equal(env.styles().length, 0);
  env.flush();
  assert.equal(env.styles()[0], original, 'repair preserves private node identity');
  original.textContent = '';
  env.flush();
  assert.equal(original.textContent, css);
  const stable = env.writes;
  env.flush();
  for (const item of env.activeObservers()) item.callback([], item);
  env.flush();
  assert.equal(env.writes, stable, 'intact stylesheet produces no self-triggered writes');
  const targets = env.activeObservers()[0].targets;
  assert.equal(targets.length, 2);
  assert.equal(targets[0].node, env.document.documentElement);
  assert.equal(targets[0].options.subtree, undefined, 'body descendants are not observed');
  assert.equal(targets[1].node, env.document.head);
  assert.equal(targets[1].options.subtree, true);
  assert.equal(targets[1].options.characterData, true);
  module.pluginRelease(); module.releaseProviderSlot();
});

test('head replacement, clearing, and temporarily absent head recover', async () => {
  const env = environment();
  const module = await env.load();
  const style = env.styles()[0];
  const oldHead = env.document.head;
  const newHead = env.document.createElement('head');
  env.document.documentElement.insertBefore(newHead, oldHead);
  oldHead.remove(); env.flush();
  assert.equal(env.styles()[0], style);
  assert.ok(env.activeObservers()[0].targets.some(({ node }) => node === newHead));
  assert.ok(!env.activeObservers()[0].targets.some(({ node }) => node === oldHead));
  newHead.textContent = ''; env.flush();
  assert.equal(env.styles()[0], style, 'empty head is repaired');
  newHead.remove(); env.flush();
  assert.equal(env.document.head, null);
  assert.equal(env.activeObservers()[0].targets.length, 1, 'HTML observer remains during head absence');
  const replacement = env.document.createElement('head');
  env.document.documentElement.insertBefore(replacement, env.document.documentElement.children[0]);
  env.flush();
  assert.equal(env.styles()[0], style);
  assert.equal(style.parentNode, replacement);
  module.pluginRelease(); module.releaseProviderSlot();
});

test('StrictMode effect replay does not leak leases or observers', async () => {
  const env = environment();
  const module = await env.load();
  const first = module.mount(module.page);
  first();
  const second = module.mount(module.page);
  assert.equal(env.styles().length, 1);
  assert.equal(env.activeObservers().length, 1);
  module.pluginRelease();
  assert.equal(env.styles().length, 1);
  second();
  assert.equal(env.styles().length, 0);
  assert.equal(env.activeObservers().length, 0);
  module.releaseProviderSlot();
});

test('independent generations retain cascade order and never delete another owner', async () => {
  const env = environment();
  const older = await env.load('old');
  const releaseOlderRoot = older.mount(older.page);
  const newer = await env.load('new');
  const releaseNewerRoot = newer.mount(newer.provider);
  assertGenerations(env, ['old', 'new']);
  const [oldStyle, newStyle] = env.styles();
  oldStyle.remove(); env.flush();
  assertGenerations(env, ['old', 'new']);
  newStyle.remove(); env.flush();
  assertGenerations(env, ['old', 'new']);
  env.document.head.textContent = ''; env.flush();
  assertGenerations(env, ['old', 'new']);
  // Deliver in reverse generation order, as may occur with queued repair work.
  oldStyle.remove(); newStyle.remove();
  for (const item of [...env.activeObservers()].reverse()) item.callback([], item);
  env.flush();
  assertGenerations(env, ['old', 'new']);
  older.pluginRelease(); releaseOlderRoot();
  assertGenerations(env, ['new']);
  assert.equal(env.styles()[0], newStyle);
  const oldCallback = env.observers[0].callback;
  oldCallback([], env.observers[0]); env.flush();
  assertGenerations(env, ['new']);
  newer.pluginRelease(); releaseNewerRoot();
  assert.equal(env.styles().length, 0);
  assert.equal(env.activeObservers().length, 0);
  older.releaseProviderSlot(); newer.releaseProviderSlot();
});

test('missing MutationObserver still permits mount, explicit reacquisition, and cleanup', async () => {
  const env = environment({ observer: false });
  const module = await env.load();
  const first = module.mount(module.page);
  assert.equal(env.styles().length, 1);
  assert.equal(env.activeObservers().length, 0);
  env.styles()[0].remove();
  const second = module.mount(module.provider);
  assert.equal(env.styles().length, 1, 'new root lease repairs missing style without observer');
  module.pluginRelease(); first(); first(); second(); second();
  assert.equal(env.styles().length, 0);
  const again = module.mount(module.page);
  assert.equal(env.styles().length, 1);
  again();
  assert.equal(env.styles().length, 0);
  module.releaseProviderSlot();
});
