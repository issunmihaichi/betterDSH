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

/**
 * A crash mid-run must still report what already failed.
 *
 * Without this, an uncaught error (a mock gap, a null element) killed the process
 * before the summary printed, so a run that had ALREADY recorded failures looked
 * like it produced no output at all — which sent me looking at the wrong code.
 */
process.on('uncaughtException', (error) => {
  if (failures.length > 0) {
    for (const failure of failures) console.error(`✗ ${failure.label}\n    ${failure.error.message}`);
  }
  console.error(`\nuncaught after ${passed}/${checks} 通过: ${error.stack}`);
  process.exit(1);
});

// ------------------------------------------------- minimal DOM + hook runtime

/**
 * A DOM small enough to read in one screen, complete enough for the seat the
 * Models page needs: elements with attributes, a style map, children, a parent,
 * listeners, `cloneNode(true)`, `remove()`, `isConnected`, and document-level
 * `querySelector` / `getElementById` / `querySelectorAll` over the whole tree.
 *
 * Selector support is deliberately literal — a tag name plus attribute
 * predicates, with `=` and `$=` only. Those are exactly the two shapes the seat
 * looks for (`button[role="tab"][id$="-catalog"]`, `[id$="-catalog-panel"]`), and
 * a matcher that pretended to be CSS would be a lie the tests cannot see through.
 *
 * `writes` counts every attribute/style/hidden assignment, which is how the
 * "a batch that changes nothing converges" property is asserted rather than
 * assumed.
 */
function createDom() {
  const documentElement = createElement('html');
  const head = createElement('head');
  const body = createElement('body');
  documentElement.appendChild(head);
  documentElement.appendChild(body);

  const state = { writes: 0, activeElement: null };

  function createElement(tagName) {
    let hidden = false;
    const element = {
      tagName: String(tagName).toUpperCase(),
      children: [],
      parentNode: null,
      parentElement: null,
      attrs: new Map(),
      listeners: new Map(),
      className: '',
      id: '',
      textContent: '',
      title: '',
      tabIndex: 0,
      style: {
        values: new Map(),
        setProperty(name, value) { state.writes += 1; this.values.set(name, String(value)); },
        getPropertyValue(name) { return this.values.get(name) ?? ''; },
      },
      setAttribute(name, value) {
        state.writes += 1;
        const text = String(value);
        this.attrs.set(name, text);
        if (name === 'id') this.id = text;
      },
      getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; },
      appendChild(child) { adopt(this, child); this.children.push(child); return child; },
      insertBefore(child, before) {
        adopt(this, child);
        const at = this.children.indexOf(before);
        this.children.splice(at < 0 ? this.children.length : at, 0, child);
        return child;
      },
      removeChild(child) {
        const at = this.children.indexOf(child);
        if (at >= 0) this.children.splice(at, 1);
        child.parentNode = null;
        child.parentElement = null;
        return child;
      },
      remove() { if (this.parentNode !== null) this.parentNode.removeChild(this); },
      cloneNode() {
        const copy = createElement(this.tagName);
        for (const [name, value] of this.attrs) copy.attrs.set(name, value);
        copy.id = this.id;
        copy.className = this.className;
        copy.tabIndex = this.tabIndex;
        copy.textContent = this.textContent;
        copy.title = this.title;
        copy.hidden = hidden;
        for (const child of this.children) copy.appendChild(child.cloneNode(true));
        return copy;
      },
      addEventListener(type, listener) {
        const list = this.listeners.get(type) ?? [];
        list.push(listener);
        this.listeners.set(type, list);
      },
      /** Dispatch to this element, then bubble; `stopPropagation` is honoured. */
      dispatchEvent(event) {
        for (const listener of this.listeners.get(event.type) ?? []) listener(event);
        if (event.__stopped !== true && this.parentNode !== null) this.parentNode.dispatchEvent(event);
      },
      focus() { state.activeElement = this; },
      /**
       * Element-level selectors, scoped to THIS subtree.
       *
       * Only `document` had them, which was invisible until an assertion called
       * `card.tablist.querySelectorAll(...)` — the real DOM has both, so the mock
       * must too or the test fails on the mock rather than on the bundle. `matches`
       * is the same predicate `document.querySelectorAll` uses, so a selector
       * cannot mean two different things depending on where it is called from.
       */
      querySelectorAll(selector) {
        const found = [];
        (function walk(node) {
          for (const child of node.children) {
            if (matches(child, selector)) found.push(child);
            walk(child);
          }
        })(this);
        return found;
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
    };
    Object.defineProperty(element, 'hidden', {
      get() { return hidden; },
      set(value) { state.writes += 1; hidden = value === true; },
    });
    Object.defineProperty(element, 'isConnected', {
      get() {
        let node = element;
        while (node.parentNode !== null) node = node.parentNode;
        return node === documentElement;
      },
    });
    return element;
  }

  function adopt(parent, child) {
    if (child.parentNode !== null) child.parentNode.removeChild(child);
    child.parentNode = parent;
    child.parentElement = parent;
  }

  const every = () => {
    const found = [];
    (function walk(node) {
      for (const child of node.children) { found.push(child); walk(child); }
    })(documentElement);
    return found;
  };

  function matches(node, selector) {
    const tag = /^[a-zA-Z]+/.exec(selector)?.[0];
    if (tag !== undefined && node.tagName !== tag.toUpperCase()) return false;
    for (const predicate of selector.matchAll(/\[([a-zA-Z-]+)(?:([$^*]?=)"([^"]*)")?\]/g)) {
      const [, name, operator, value] = predicate;
      const actual = node.getAttribute(name);
      if (actual === null) return false;
      if (operator === '=' && actual !== value) return false;
      if (operator === '$=' && !actual.endsWith(value)) return false;
      if (operator === '^=' && !actual.startsWith(value)) return false;
    }
    return true;
  }

  /**
   * Document- and window-level listeners, kept so the test can drive them.
   *
   * A real `Document` and `Window` are EventTargets, so `addEventListener` is
   * part of the API surface the bundle is entitled to use: the page installs one
   * document-level listener that closes an open row menu on an outside
   * pointerdown, on Escape, or on any scroll. A double without those methods
   * throws on the FIRST render of the page and reports a bundle failure where
   * the gap is really the double's — which is exactly how this was found.
   *
   * Listeners are stored per type and removed by identity, so a test can assert
   * the effect's cleanup actually unsubscribes (a listener left behind fires on
   * a page that has already unmounted).
   */
  const documentListeners = new Map();
  const windowListeners = new Map();

  function makeEventTarget(store) {
    return {
      addEventListener(type, listener) {
        const list = store.get(type) ?? [];
        if (!list.includes(listener)) list.push(listener);
        store.set(type, list);
      },
      removeEventListener(type, listener) {
        const list = store.get(type) ?? [];
        const at = list.indexOf(listener);
        if (at >= 0) list.splice(at, 1);
      },
    };
  }

  const documentTarget = makeEventTarget(documentListeners);
  const windowTarget = makeEventTarget(windowListeners);

  const document = {
    ...documentTarget,
    documentElement,
    head,
    body,
    createElement,
    get activeElement() { return state.activeElement; },
    getElementById: (id) => every().find((node) => node.id === id) ?? null,
    querySelector: (selector) => every().find((node) => matches(node, selector)) ?? null,
    querySelectorAll: (selector) => every().filter((node) => matches(node, selector)),
  };

  return { document, createElement, every, matches, state, documentListeners, windowListeners, windowTarget };
}

const dom = createDom();
const document = dom.document;
/** Document/window listener stores, so a test can dispatch and inspect them. */
const documentListeners = dom.documentListeners;
const windowListeners = dom.windowListeners;

/** Stylesheet tags the plugin appends, in insertion order. */
const styleElements = [];
const appendToHead = document.head.appendChild.bind(document.head);
document.head.appendChild = (element) => { styleElements.push(element); return appendToHead(element); };

/**
 * A MutationObserver whose callbacks the test drives. The bundle never reads
 * records — it re-reads the DOM — so `flush()` is faithful enough, and being
 * able to say "now React re-rendered" is worth more than record fidelity.
 */
const observers = [];
class FakeObserver {
  constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
  observe(target, options) { this.targets.push({ target, options }); }
  disconnect() { this.targets = []; }
  takeRecords() { return []; }
}
// The seat feature-detects the ambient API, exactly as it must in a browser.
globalThis.MutationObserver = FakeObserver;

const flush = () => {
  for (const observer of observers) {
    if (observer.targets.length > 0) observer.callback([], observer);
  }
};

/** Card detection is coalesced behind an 80ms timer, so a flush alone is not enough. */
const sweep = () => new Promise((resolve) => { setTimeout(resolve, 120); });
const flushAndSettle = async () => { flush(); await sweep(); flush(); };

const fire = (element, type, extra) => {
  const event = { type, target: element, defaultPrevented: false, __stopped: false, ...extra };
  event.preventDefault = () => { event.defaultPrevented = true; };
  event.stopPropagation = () => { event.__stopped = true; };
  element.dispatchEvent(event);
  return event;
};

// Hook slots belong to a mounted component, not to the order helpers happen to
// inspect its tree. In particular, AccountForm and GroupForm can occupy the same
// page position without sharing state, and keyed forms reset on a new edit.
let componentScopes = new Map();
let currentScope = null;
let visitedScopes = null;
const componentIds = new WeakMap();
let nextComponentId = 0;
const componentId = (component) => {
  if (!componentIds.has(component)) componentIds.set(component, nextComponentId++);
  return componentIds.get(component);
};

function invokeComponent(component, props, path) {
  const identity = `${path}/component:${componentId(component)}`;
  let scope = componentScopes.get(identity);
  if (!scope) {
    scope = { states: {}, effects: {}, cursor: 0 };
    componentScopes.set(identity, scope);
  }
  visitedScopes?.add(identity);
  const previous = currentScope;
  currentScope = scope;
  scope.cursor = 0;
  try { return component(props); }
  finally { currentScope = previous; }
}

const React = {
  createElement: (type, props, ...children) => {
    // Real React folds children into props; components like Pill read props.children.
    const merged = { ...(props ?? {}) };
    if (children.length === 1) merged.children = children[0];
    else if (children.length > 1) merged.children = children;
    return { type, props: merged, children };
  },
  useState: (initial) => {
    const scope = currentScope;
    const key = `state:${scope.cursor++}`;
    if (!(key in scope.states)) scope.states[key] = typeof initial === 'function' ? initial() : initial;
    return [scope.states[key], (next) => {
      scope.states[key] = typeof next === 'function' ? next(scope.states[key]) : next;
    }];
  },
  useRef: (initial) => {
    const scope = currentScope;
    const key = `ref:${scope.cursor++}`;
    if (!(key in scope.states)) scope.states[key] = { current: initial };
    return scope.states[key];
  },
  useEffect: (effect, deps) => {
    const scope = currentScope;
    const key = `effect:${scope.cursor++}`;
    const previous = scope.effects[key];
    if (previous && deps && previous.deps && deps.length === previous.deps.length && deps.every((value, index) => Object.is(value, previous.deps[index]))) return;
    previous?.cleanup?.();
    scope.effects[key] = { deps, cleanup: effect() };
  },
};

const cleanupScope = (scope) => {
  for (const effect of Object.values(scope.effects)) if (typeof effect.cleanup === 'function') effect.cleanup();
};
const render = (component, props) => {
  visitedScopes = new Set();
  const rootPath = `root:${componentId(component)}`;
  const tree = invokeComponent(component, props, rootPath);
  // Commit every child even when the next helper only inspects part of the tree.
  // This also observes unmounts before an editor is opened again at the same key.
  expandedRoots.set(tree, expandNode(tree, rootPath));
  for (const [identity, scope] of componentScopes) {
    if (!visitedScopes.has(identity)) {
      cleanupScope(scope);
      componentScopes.delete(identity);
    }
  }
  visitedScopes = null;
  return tree;
};
const remount = () => {
  for (const scope of componentScopes.values()) cleanupScope(scope);
  componentScopes = new Map();
  currentScope = null;
};

// Timers are stubbed so the page's countdown interval cannot keep Node alive.
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const testIntervals = new Map();let testTimerId=0;

// ------------------------------------------------- load the shipped bundle

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
let registration;
/**
 * The browser globals handed to the bundle. `window` is an EventTarget too, so
 * it carries the same listener methods as `document`: the page subscribes to
 * `resize` and unsubscribes in the effect's cleanup.
 */
const window = {
  __ModuleLoader__: { load: (value) => { registration = value; } },
  addEventListener: dom.windowTarget.addEventListener,
  removeEventListener: dom.windowTarget.removeEventListener,
};

/** React roots the seat creates, in creation order. */
const roots = [];
const require = (specifier) => {
  if (specifier === 'react') return React;
  if (specifier === 'react-dom/client') {
    return {
      createRoot: (container) => {
        const root = {
          container,
          rendered: [],
          unmounts: 0,
          /**
           * Record what was rendered.
           *
           * The seat calls `root.render(node)` immediately on install, so a root
           * without `render` throws on the first sweep and the tab never appears —
           * which the test then reports as "the seat installs a third tab" failing,
           * pointing at the bundle instead of at this double.
           */
          render(node) { root.rendered.push(node); },
          unmount() { root.unmounts += 1; },
        };
        roots.push(root);
        return root;
      },
    };
  }
  throw new Error(`unexpected require(${JSON.stringify(specifier)})`);
};
new Function('window', 'require', 'document', source)(window, require, document);

// ------------------------------------------------- tree helpers

/** Resolve child components under stable parent paths and React-style keys. */
const expandedRoots = new WeakMap();
const childPath = (parent, node, index) => `${parent}/${node?.props?.key !== undefined ? `key:${JSON.stringify(node.props.key)}` : `slot:${index}`}`;

function expandNode(node, path = 'inspection') {
  if (node === null || node === undefined || typeof node === 'boolean') return null;
  if (typeof node === 'string' || typeof node === 'number') return node;
  if (Array.isArray(node)) return node.map((child, index) => expandNode(child, childPath(path, child, index))).filter((child) => child !== null);
  if (typeof node.type === 'function') return expandNode(invokeComponent(node.type, node.props, path), `${path}/component:${componentId(node.type)}/rendered`);
  return { type: node.type, props: node.props, children: (node.children ?? []).map((child, index) => expandNode(child, childPath(path, child, index))).filter((child) => child !== null) };
}

/** Helpers inspect the same committed tree without invoking hooks again. */
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
  managementVersion: 2,
  accounts: [
    { id: 'a1', label: '主号', platform: 'anthropic', authMode: 'oauth', mimicry: 'claude-code', status: 'active', schedulable: true, priority: 100, loadFactor: null, concurrency: 4, consecutiveFailures: 0, rateLimitResetAt: null, overloadUntil: null, tempUnschedulableUntil: null, tempUnschedulableReason: '', groups: ['cheap'], credential: { configured: true, writable: true, source: 'store' } },
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

/** The provider directory + live flows the OAuth panel reads on open. */
const OAUTH_BODY = {
  providers: [
    { id: 'openai', label: 'OpenAI (Codex)', platform: 'openai', unverified: false, manualOnly: false },
    { id: 'grok', label: 'xAI (Grok)', platform: 'grok', unverified: false, manualOnly: false },
    { id: 'gemini', label: 'Google (Gemini CLI)', platform: 'gemini', unverified: false, manualOnly: true },
    { id: 'anthropic', label: 'Anthropic (Claude Code)', platform: 'anthropic', unverified: true, manualOnly: false },
  ],
  flows: [],
  callbackServer: null,
  credentialsAvailable: true,
};

/**
 * What `oauth-start` hands back. `manualOnly` mirrors what the host decides from
 * the provider: a fixed redirect cannot reach the loopback listener.
 */
function oauthStarted(providerId) {
  const manual = providerId === 'gemini';
  const nonce = 'nonce-1';
  return {
    ok: true,
    action: 'oauth-start',
    manualOnly: manual,
    flow: {
      id: `${providerId}-flow1`,
      provider: providerId,
      platform: providerId,
      status: 'pending',
      authUrl: `https://vendor.example/auth?state=${nonce}&code_challenge=x&code_challenge_method=S256`,
      redirectUri: manual ? 'https://codeassist.google.com/authcode' : 'http://localhost:14518/oauth/callback',
      userCode: null,
      verificationUrl: null,
      accountId: null,
      label: null,
      caveat: null,
      error: null,
      startedAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + 600_000).toISOString(),
    },
  };
}

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
    if (method === 'POST') {
      const action = JSON.parse(String(init?.body ?? '{}')).action;
      if (action === 'oauth-start') {
        const providerId = JSON.parse(String(init.body)).provider;
        return { ok: true, status: 200, json: async () => oauthStarted(providerId) };
      }
      if (action === 'oauth-finish') {
        const started = oauthStarted('openai');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ...started,
            flow: { ...started.flow, status: 'done', accountId: 'openai-abc123', label: 'me@example.com' },
            account: { id: 'openai-abc123' },
            credential: { configured: true, writable: true, source: 'store' },
          }),
        };
      }
      if (action === 'oauth-cancel') return { ok: true, status: 200, json: async () => ({ ok: true, dropped: true }) };
      if (action === 'quota') {
        const id = JSON.parse(String(init.body)).id;
        return { ok: true, status: 200, json: async () => ({ ok: true, action, quota: ACCOUNTS_BODY.accounts.find((account) => account.id === id)?.quota }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, action: 'prefer' }) };
    }
    let body = ACCOUNTS_BODY;
    if (String(url).startsWith('api/accountPool.usage')) body = USAGE_BODY;
    if (String(url).startsWith('api/accountPool.oauth')) body = OAUTH_BODY;
    return { ok: true, status: 200, json: async () => body };
  };
  return { impl, calls };
}

/** Render the page, let its fetch settle, then render again with the new state. */
async function renderState(page, mode) {
  const fetchStub = makeFetch(mode);
  remount();testIntervals.clear();
  globalThis.fetch = fetchStub.impl;
  globalThis.setInterval = (fn, ms) => { const id=++testTimerId;testIntervals.set(id,{fn,ms});return id; };
  globalThis.clearInterval = (id) => { testIntervals.delete(id); };
  render(page.type, page.props);
  await new Promise((resolve) => setImmediate(resolve));
  const tree = render(page.type, page.props);
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  return { tree, calls: fetchStub.calls };
}

// ------------------------------------------------- hook runtime regression

{
  let mounts = 0;
  let cleanups = 0;
  function Counter({ name }) {
    const [value, setValue] = React.useState(name);
    const stable = React.useRef(name);
    React.useEffect(() => { mounts += 1; return () => { cleanups += 1; }; }, []);
    return React.createElement('button', { onClick: () => setValue(`${value}!`), 'data-ref': stable.current }, value);
  }
  function OtherForm() {
    const [discovery] = React.useState({ models: [] });
    return React.createElement('span', null, `models:${discovery.models.length}`);
  }
  function Probe({ order = ['a', 'b'], other = false }) {
    return React.createElement('div', null, other ? React.createElement(OtherForm, { key: 'a' }) : order.map((name) => React.createElement(Counter, { key: name, name })));
  }
  remount();
  const first = render(Probe, {});
  buttonsIn(first)[0].props.onClick();
  textOf(first); inputsIn(first); buttonsIn(first);
  eq(mounts, 2, 'hook harness helpers inspect each committed component without remounting it');
  const reversed = render(Probe, { order: ['b', 'a'] });
  eq(buttonsIn(reversed).map(rawText), ['b', 'a!'], 'hook harness retains state by key when siblings reorder');
  eq(buttonsIn(reversed).map((button) => button.props['data-ref']), ['b', 'a'], 'hook harness keeps refs in their component scope');
  const swapped = render(Probe, { other: true });
  eq(textOf(swapped), 'models:0', 'hook harness never passes another component state to discovery hooks at the same key');
  eq(cleanups, 2, 'hook harness runs cleanup for components removed from the rendered tree');
  const reopened = render(Probe, { order: ['a'] });
  eq(textOf(reopened), 'a', 'hook harness resets state after unmount and reopen at the same key');
  remount();
  eq(cleanups, 3, 'hook harness remount also cleans the prior component effects');
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
  /** Switch the live dictionary, the way the shell does when the operator flips locale. */
  state.setLocale = (language) => { dict = state.dictionaries[0].dicts[language]; };
  return { ctx, state };
}

const { ctx, state } = makeCtx();
exported.apply(ctx);

eq(state.dictionaries.length, 1, 'apply registers one dictionary set');
eq(state.dictionaries[0].ns, 'settings.accountPool', 'dictionary namespace');
const zhKeys = Object.keys(state.dictionaries[0].dicts.zh).sort();
const enKeys = Object.keys(state.dictionaries[0].dicts.en).sort();
eq(enKeys, zhKeys, 'zh and en must declare exactly the same keys');

// The Models page exposes exactly three child slots and none of them is inside
// the add-provider card. The pool switcher that used to be DOM-seated into that
// card is gone (DESIGN.md §27), so the plugin touches none of its four surfaces.
eq(state.injections.length, 2, 'apply occupies two slots');
const bySlot = {};
for (const injection of state.injections) bySlot[injection.slotName] = injection;
eq(
  Object.keys(bySlot).sort(),
  ['settings.models.provider-card', 'settings.section'],
  'the settings page and the pool provider card — the footer card is gone',
);
eq(state.effects.length, 2, 'apply runs exactly the dictionaries and stylesheet effects');

const entry = bySlot['settings.section'].contribute();
eq(entry.meta.name, 'settings.section', 'registration names its slot');
eq(entry.meta.id, 'accountPool', 'registration id');
eq(entry.meta.order, 14, 'registration order');
eq(entry.meta.locale, 'settings.accountPool', 'registration locale');
eq(entry.meta.label(), '账号池', 'the nav label comes from the locale');
eq(typeof entry.render, 'function', 'the registration renders');

const originalRegistrationFetch = globalThis.fetch;
const originalProviderRegister = ctx.get('slots').register;
let providerCard;
globalThis.fetch = async () => ({ ok: true, json: async () => ({ settingsNs: 'account-pool-v048' }) });
ctx.get('slots').register = (...args) => { const result = originalProviderRegister(...args); providerCard = result; return () => {}; };
const disposeProviderCard = bySlot['settings.models.provider-card'].contribute();
await new Promise((resolve) => setImmediate(resolve));
globalThis.fetch = originalRegistrationFetch;
ctx.get('slots').register = originalProviderRegister;
eq(providerCard.meta.name, 'settings.models.provider-card', 'the provider card names its slot');
eq(providerCard.meta.key, 'account-pool-v048', 'the provider card follows the live Loader ENTRY ID');
eq(exported.FOOTER_SLOT, undefined, 'no footer slot export: that surface is gone');

// Styles are inserted once by apply, not per render.
eq(styleElements.length, 1, 'apply inserts exactly one stylesheet');
ok(styleElements[0].textContent.includes('.dap-root'), 'the stylesheet carries the page styles');

const page = entry.render({ close: () => {} });

// ------------------------------------------------- three states

const loading = await renderState(page, 'pending');
ok(textOf(loading.tree).includes('账号池'), 'loading state still shows the heading');
ok(textOf(loading.tree).includes('正在读取账号池'), 'loading state shows its message');
// The first-load placeholder explains what it is waiting on and announces
// itself to assistive tech; it must not offer a retry (nothing has failed).
ok(textOf(loading.tree).includes('正在向 Host 请求账号、分组与用量数据。'), 'loading state explains what it waits for');
ok(classesIn(loading.tree).includes('dap-spinner'), 'loading state shows a spinner');
eq(buttonsIn(loading.tree).filter((button) => rawText(button) === '重新读取').length, 0, 'loading state offers no retry');
eq(styleElements.length, 1, 'rendering does not insert a second stylesheet');

const errored = await renderState(page, 'error');
ok(textOf(errored.tree).includes('domain exploded'), 'error state surfaces the Host message');
// The failure state has to name the problem, keep the raw Host message, and
// give the operator a way out that re-reads the accounts route.
ok(textOf(errored.tree).includes('无法读取账号池'), 'error state names the failure');
ok(textOf(errored.tree).includes('Host 没有返回账号数据。检查后端是否已重启，然后重试。'), 'error state explains the likely cause');
const retry = buttonsLabelled(errored.tree, '重新读取');
eq(retry.length, 1, 'error state offers exactly one retry');
ok(typeof retry[0].props.onClick === 'function', 'the retry button is wired to a handler');
eq(errored.calls.filter((call) => call.url === 'api/accountPool.accounts').length, 1, 'the failing state reads accounts once');
// This harness runs each effect slot exactly once, so it cannot observe the
// nonce-driven refetch that the retry triggers. The browser rig
// (_account-pool-ui-work) exercises that path under real React instead.

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
eq(buttonsLabelled(actions.tree, '设为优先').length, 0, 'group routes have no obsolete global preference action');
await buttonsLabelled(actions.tree, '停用')[0].props.onClick();
await sweep();
const post = actions.calls.find((call) => call.method === 'POST');
eq(post?.url, 'api/accountPool.account', 'row changes use the write route');
eq(JSON.parse(post.body), { id: 'a1', action: 'disable' }, 'row action addresses one account');

// ------------------------------- the add-provider card is left alone

/**
 * The pool switcher used to be installed as a third tab inside the shipped
 * add-provider card (DESIGN.md §23) and was removed in §27. The card is modelled
 * exactly as the shell renders it — a tablist holding an indicator plus the two
 * shipped segments, and the two panels the section hides and shows — and this
 * section is the guard that the plugin seats nothing in it any more: a DOM seat
 * creeping back would fail here before it could break the page again.
 */
function mountAddCard(suffix) {
  const card = document.createElement('div');
  const modes = document.createElement('div');
  const tablist = document.createElement('div');
  tablist.setAttribute('role', 'tablist');
  tablist.setAttribute('aria-label', '添加方式');
  tablist.style.setProperty('--dsh-segment-count', '2');
  tablist.style.setProperty('--dsh-segment-index', '0');
  tablist.appendChild(document.createElement('span'));

  const makeTab = (value, selected) => {
    const tab = document.createElement('button');
    tab.setAttribute('role', 'tab');
    tab.setAttribute('id', `add-${suffix}-${value}`);
    tab.setAttribute('aria-controls', `add-${suffix}-${value}-panel`);
    tab.setAttribute('aria-selected', selected ? 'true' : 'false');
    tab.className = 'hash_tab';
    tab.textContent = value === 'catalog' ? '第三方模型提供商' : '自定义模型 API';
    tablist.appendChild(tab);
    return tab;
  };
  const catalog = makeTab('catalog', true);
  const custom = makeTab('custom', false);
  modes.appendChild(tablist);
  card.appendChild(modes);

  const makePanel = (value) => {
    const panel = document.createElement('div');
    panel.setAttribute('id', `add-${suffix}-${value}-panel`);
    panel.hidden = value !== 'catalog';
    card.appendChild(panel);
    return panel;
  };
  const catalogPanel = makePanel('catalog');
  const customPanel = makePanel('custom');
  document.body.appendChild(card);
  return { card, tablist, catalog, custom, catalogPanel, customPanel };
}

const untouched = mountAddCard('add1');
await flushAndSettle();
eq(untouched.tablist.querySelectorAll('button[role="tab"]').length, 2, 'the shipped card still has its two segments');
eq(untouched.tablist.style.getPropertyValue('--dsh-segment-count'), '2', 'and the shipped indicator still counts two');
eq(untouched.catalog.getAttribute('aria-selected'), 'true', 'the shipped selection is untouched');
eq(document.getElementById('dsh-account-pool-add-tab'), null, 'no pool tab is seated');
eq(document.getElementById('dsh-account-pool-add-panel'), null, 'and no pool panel either');
eq(document.querySelectorAll('[id^="dsh-account-pool-add-"]').length, 0, 'nothing carries the old seat id prefix');
eq(document.querySelectorAll('[data-dsh-account-pool="add-tab"]').length, 0, 'and no marker element was planted');
eq(roots.length, 0, 'no React root is mounted into the card');
eq(state.effects.length, 2, 'and apply installs no effect for a seat');

// Mutations after the card appears change nothing: there is no observer left to
// react to them.
untouched.card.remove();
await flushAndSettle();
const readded = mountAddCard('add2');
await flushAndSettle();
eq(readded.tablist.querySelectorAll('button[role="tab"]').length, 2, 'a re-opened card is untouched too');
eq(roots.length, 0, 'and still no root is created');
// ------------------------------------------------- the pool provider card

const providerState = await renderState(providerCard.render({ close: () => {} }), 'ready');
const providerText = textOf(providerState.tree);
ok(providerText.includes('5 个账号'), `the provider card summarises the pool, got: ${providerText}`);
ok(providerText.includes('可用 2'), 'and counts the ready accounts');
ok(providerText.includes('冷却 1'), 'and the cooling ones');

// The same card sits under a GROUP row too, and there it must scope to that
// group: `pool-cheap` holds a1 alone, so it can never report the pool's five.
const groupCardState = await renderState(
  providerCard.render({ close: () => {}, provider: { provider: 'pool-cheap', displayName: '便宜池' } }),
  'ready',
);
const groupCardText = textOf(groupCardState.tree);
ok(groupCardText.includes('1 个账号'), `a group row counts its own accounts, got: ${groupCardText}`);
ok(groupCardText.includes('可用 1'), 'and their ready/cooling split');
eq(groupCardText.includes('5 个账号'), false, 'never the whole pool');
ok(groupCardText.includes('已启用'), 'group provider reports enabled state');
buttonsLabelled(groupCardState.tree, '停用')[0].props.onClick();
await sweep();
const groupToggle = JSON.parse(groupCardState.calls.filter((call) => call.method === 'POST').at(-1).body);
eq(groupToggle.action, 'group-update', 'provider toggle uses group management action');
eq(groupToggle.id, 'cheap', 'provider toggle addresses its own group');
eq(groupToggle.group.enabled, false, 'provider toggle disables group calls');
const groupEditState = await renderState(providerCard.render({ provider: { provider: 'pool-cheap' } }), 'ready');
buttonsLabelled(groupEditState.tree, '编辑')[0].props.onClick();
await sweep();
// Rerender the original provider component to inspect its form.
const providerComponent = providerCard.render({ provider: { provider: 'pool-cheap' } });
const providerFormTree = render(providerComponent.type, providerComponent.props);
ok(textOf(providerFormTree).includes('启用此模型提供商'), 'Models group editor exposes durable enabled setting');

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
await sweep();
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
await sweep();
const filled = render(page.type, page.props);
const saveButton = buttonsLabelled(filled, '保存')[0];
ok(saveButton !== undefined, 'the form offers save');
await nodesIn(filled, 'form')[0].props.onSubmit({ preventDefault() {} });
await sweep();

const createBody = JSON.parse(posts(crud.calls).at(-1).body);
eq(createBody.action, 'create', 'saving a new account uses the create verb');
eq(createBody.id, 'gamma', 'the id comes from the form');
eq('credential' in createBody, false, 'an untouched key field sends no credential');
eq(createBody.account.platform, 'anthropic', 'the platform comes from the select');
eq(createBody.account.models, [], 'a blank model list means "all models"');

// Delete is armed by the first click and only fires on the second.
const beforeDelete = posts(crud.calls).length;
buttonsLabelled(crud.tree, '删除')[0].props.onClick();
await sweep();
const armed = render(page.type, page.props);
ok(textOf(armed).includes('确认删除'), 'the first click arms the delete');
eq(posts(crud.calls).length, beforeDelete, 'and nothing is deleted yet');

buttonsLabelled(armed, '确认删除')[0].props.onClick();
await sweep();
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
await sweep();
const editingAccount = render(page.type, page.props);
// Filtered by class: the page also renders a row checkbox per account and a select-all.
const boxes = inputsIn(editingAccount).filter((input) => input.props.className === 'dap-check-group');
eq(boxes.length, 1, 'one checkbox per existing group');
eq(boxes[0].props.checked, true, 'a1 is already in it');

await boxes[0].props.onChange();
await sweep();
const toggled = render(page.type, page.props);
eq(
  inputsIn(toggled).filter((input) => input.props.className === 'dap-check-group')[0].props.checked,
  false,
  'clicking clears it',
);

await nodesIn(toggled, 'form')[0].props.onSubmit({ preventDefault() {} });
await sweep();
const membership = JSON.parse(posts(groupState.calls).at(-1).body);
eq(membership.action, 'update', 'membership is edited through the account CRUD');
eq(membership.account.groups, [], 'and the cleared set is what gets sent');

// Creating a group goes through the same single write route.
buttonsLabelled(groupState.tree, '新建分组')[0].props.onClick();
await sweep();
const groupFormOpen = render(page.type, page.props);
ok(textOf(groupFormOpen).includes('会成为路由后缀'), 'the group form explains that the id becomes a route');
eq(buttonsLabelled(groupFormOpen, '从上游获取模型').length, 0, 'new unsaved groups never expose upstream discovery');

const groupFields = inputsIn(groupFormOpen).filter((input) => (input.props.type ?? 'text') === 'text');
groupFields[0].props.onChange({ target: { value: 'vip' } });
await sweep();
{ const tree = render(page.type, page.props); const form = nodesIn(tree, 'form')[0]; if (form) await form.props.onSubmit({ preventDefault() {} }); else await buttonsLabelled(tree, '保存')[0].props.onClick(); }
await sweep();
const madeGroup = JSON.parse(posts(groupState.calls).at(-1).body);
eq(madeGroup.action, 'group-create');
eq(madeGroup.id, 'vip', 'the group id travels as the TOP-LEVEL id, exactly like an account id');
eq(madeGroup.group.models, [], 'a blank allow-list means no extra restriction');

// ------------------------------------------------- group upstream discovery

// Drive the shipped page rather than extracting GroupForm or inventing state.
// Discovery is a separate POST; all other routes retain the normal page fixture.
async function openGroupDiscovery() {
  const state = await renderState(page, 'ready');
  buttonsLabelled(state.tree, '编辑').at(-1).props.onClick();
  const view = () => render(page.type, page.props);
  const form = () => nodesIn(view(), 'form')[0];
  const models = () => inputsIn(form()).find((input) => input.props['aria-label'] === '模型白名单（逗号分隔，留空=不限）');
  const options = () => inputsIn(form()).filter((input) => input.props.type === 'checkbox' && input.props['aria-label'] !== '启用此模型提供商');
  const discover = () => buttonsLabelled(form(), '从上游获取模型')[0];
  const originalFetch = globalThis.fetch;
  const requests = [];
  let respond;
  globalThis.fetch = (url, init) => {
    if (init?.method === 'POST' && JSON.parse(init.body).action === 'group-models') {
      const request = { url: String(url), method: init.method, body: init.body, init };
      requests.push(request);
      state.calls.push(request);
      if (!respond) throw new Error('discovery response not configured');
      return respond(request);
    }
    return originalFetch(url, init);
  };
  return {
    ...state, view, form, models, options, discover, requests,
    respondWith: (handler) => { respond = handler; },
    restore: () => { globalThis.fetch = originalFetch; },
    updates: () => posts(state.calls).filter((call) => JSON.parse(call.body).action === 'group-update'),
  };
}
const discoveryResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

{
  const state = await openGroupDiscovery();
  try {
    state.models().props.onChange({ target: { value: 'manual-z, cheap-model, manual-z' } });
    let finish;
    state.respondWith(() => new Promise((resolve) => { finish = resolve; }));
    const firstButton = state.discover();
    const pendingRequest = firstButton.props.onClick();
    await firstButton.props.onClick();
    eq(state.requests.length, 1, 'group discovery ref rejects a duplicate click before rerender');
    eq(JSON.parse(state.requests[0].body), { action: 'group-models', id: 'cheap' }, 'group discovery sends only group id and action, never credentials or unsaved values');
    eq(state.requests[0].url, 'api/accountPool.account', 'group discovery uses the existing action route');
    eq(state.requests[0].init.credentials, 'same-origin', 'group discovery keeps browser session credentials');
    ok(state.requests[0].init.signal instanceof AbortSignal, 'group discovery supplies an abort signal');
    eq(buttonsLabelled(state.form(), '获取中…')[0].props.disabled, true, 'group discovery disables duplicate fetch while pending');
    eq(buttonsLabelled(state.form(), '保存')[0].props.disabled, true, 'group discovery disables Save while pending');
    eq(state.models().props.disabled, true, 'group discovery disables model editing while pending');
    await state.form().props.onSubmit({ preventDefault() {} });
    eq(state.updates().length, 0, 'submit guard blocks a group save during discovery even when invoked directly');
    finish(discoveryResponse({
      ok: true,
      models: [' gpt-5 ', 'claude-a', 'gpt-5', '', null],
      sources: [
        { id: 'a1', label: '主号', models: [], error: 'OAuth model discovery unsupported' },
        { id: 'a2', label: 'Working account', models: ['gpt-5', 'claude-a'] },
        { id: 'a3', label: '', models: [], error: 'HTTP 429' },
      ],
      catalogRefreshed: true,
    }));
    await pendingRequest;
    eq(state.models().props.value, 'manual-z, cheap-model, gpt-5, claude-a', 'successful discovery merges unique trimmed models with existing manual entries');
    eq(state.options().map((input) => [input.props['aria-label'], input.props.checked]), [['gpt-5', true], ['claude-a', true]], 'discovered models start selected for review');
    ok(textOf(state.form()).includes('已获取 2 个模型'), 'group discovery reports normalized model count');
    ok(textOf(state.form()).includes('主号: OAuth model discovery unsupported'), 'partial discovery shows named OAuth account error alongside successful models');
    ok(textOf(state.form()).includes('a3: HTTP 429'), 'partial discovery uses account id when its label is blank');
    eq(buttonsLabelled(state.form(), '保存')[0].props.disabled, false, 'Save becomes available after partial discovery completes');
    eq(state.updates().length, 0, 'catalog refresh and automatic model selection never save the group');

    const search = () => inputsIn(state.form()).find((input) => input.props.type === 'search');
    search().props.onChange({ target: { value: 'GPT' } });
    eq(state.options().map((input) => input.props['aria-label']), ['gpt-5'], 'discovery search matches model IDs without case sensitivity');
    state.options()[0].props.onChange({ target: { checked: false } });
    eq(state.models().props.value, 'manual-z, cheap-model, claude-a', 'unchecking a search result removes only that model');
    ok(textOf(state.form()).includes('已选 3 个模型'), 'selection count includes manual and hidden selected models');
    search().props.onChange({ target: { value: 'no-match' } });
    eq(state.options().length, 0, 'search can hide all discovered options');
    eq(state.models().props.value, 'manual-z, cheap-model, claude-a', 'search never changes selected or manual models');
    buttonsLabelled(state.form(), '全选')[0].props.onClick();
    eq(state.models().props.value, 'manual-z, cheap-model, claude-a, gpt-5', 'Select all includes hidden results and retains manual values');
    search().props.onChange({ target: { value: '' } });
    buttonsLabelled(state.form(), '清除选择')[0].props.onClick();
    eq(state.models().props.value, '', 'Clear selection explicitly clears the editable allow-list');
    ok(state.options().every((input) => input.props.checked === false), 'cleared selection unchecks every discovered model');
    state.options().find((input) => input.props['aria-label'] === 'claude-a').props.onChange({ target: { checked: true } });
    state.models().props.onChange({ target: { value: 'claude-a, manual-final\nclaude-a' } });
    eq(state.updates().length, 0, 'search, selection and manual edits issue no group save');
    await state.form().props.onSubmit({ preventDefault() {} });
    await settle();
    eq(state.updates().length, 1, 'only explicit Save submits one group update');
    eq(JSON.parse(state.updates()[0].body), {
      id: 'cheap', action: 'group-update',
      group: { label: '便宜池', description: '', selectionMode: 'sticky', enabled: true, models: ['claude-a', 'manual-final'] },
    }, 'Save persists the reviewed deduplicated allow-list, with no discovery response or secrets');
  } finally { state.restore(); }
}

{
  const state = await openGroupDiscovery();
  try {
    const manual = 'manual-one, manual-two\nmanual-one';
    state.models().props.onChange({ target: { value: manual } });
    for (const [label, handler, message] of [
      ['HTTP error', () => discoveryResponse({ error: { message: 'directory unavailable' } }, 503), 'directory unavailable'],
      ['network error', () => Promise.reject(new Error('connection refused')), 'connection refused'],
      ['invalid success body', () => discoveryResponse({ ok: true, models: null, sources: [], catalogRefreshed: false }), 'HTTP 200'],
      ['backend rejection', () => discoveryResponse({ ok: false, models: [], error: { message: 'group not found' } }), 'group not found'],
    ]) {
      state.respondWith(handler);
      await state.discover().props.onClick();
      eq(state.models().props.value, manual, `${label} preserves the exact manually entered model text`);
      ok(textOf(state.form()).includes(`获取失败：${message}`), `${label} displays the discovery failure for correction`);
      eq(buttonsLabelled(state.form(), '保存')[0].props.disabled, false, `${label} restores manual Save`);
      eq(state.discover().props.disabled, false, `${label} releases the request ref for retry`);
      eq(state.updates().length, 0, `${label} performs no group save`);
    }
    state.respondWith(() => discoveryResponse({
      ok: true, models: [],
      sources: [{ id: 'a1', label: '主号', models: [], error: 'OAuth model discovery unsupported' }],
      catalogRefreshed: false,
    }));
    await state.discover().props.onClick();
    ok(textOf(state.form()).includes('已获取 0 个模型'), 'empty upstream catalog shows zero results');
    ok(textOf(state.form()).includes('主号: OAuth model discovery unsupported'), 'empty catalog still exposes per-account errors');
    ok(!textOf(state.form()).includes('获取失败'), 'successful empty response clears earlier transport error');
    eq(state.models().props.value, 'manual-one, manual-two', 'empty success retains every manual model');
    eq(state.options().length, 0, 'empty catalog renders no model checkboxes');
    eq(inputsIn(state.form()).filter((input) => input.props.type === 'search').length, 0, 'empty catalog has no misleading search control');
    eq(buttonsLabelled(state.form(), '全选').length, 0, 'empty catalog has no Select all action');
    eq(state.updates().length, 0, 'empty discovery never saves an empty whitelist');

    state.respondWith(() => discoveryResponse({ ok: true, models: ['retry-model'], sources: [], catalogRefreshed: true }));
    await state.discover().props.onClick();
    const reviewed = state.models().props.value;
    let fail;
    state.respondWith(() => new Promise((_resolve, reject) => { fail = reject; }));
    const retry = state.discover().props.onClick();
    ok(state.options().every((input) => input.props.disabled === true), 'repeat discovery disables existing model options');
    eq(buttonsLabelled(state.form(), '全选')[0].props.disabled, true, 'repeat discovery disables Select all');
    eq(buttonsLabelled(state.form(), '清除选择')[0].props.disabled, true, 'repeat discovery disables Clear selection');
    fail(new Error('retry unavailable'));
    await retry;
    eq(state.models().props.value, reviewed, 'failed refresh preserves the last reviewed manual and discovered models');
    eq(state.options().map((input) => [input.props['aria-label'], input.props.checked]), [['retry-model', true]], 'failed refresh retains prior selected results for manual save');
    eq(state.updates().length, 0, 'retry and failure still do not save the group');
  } finally { state.restore(); }
}

{
  const state = await openGroupDiscovery();
  try {
    let finish;
    state.respondWith(() => new Promise((resolve) => { finish = resolve; }));
    const pending = state.discover().props.onClick();
    buttonsLabelled(state.form(), '取消')[0].props.onClick();
    eq(state.requests[0].init.signal.aborted, true, 'group Cancel aborts the in-flight discovery request');
    eq(nodesIn(state.view(), 'form').length, 0, 'group Cancel closes the editor while discovery is pending');
    // A mock may resolve even after abort; the client must still ignore its body.
    finish(discoveryResponse({ ok: true, models: ['cancelled-model'], sources: [], catalogRefreshed: true }));
    await pending;
    ok(!textOf(state.view()).includes('cancelled-model'), 'late cancelled discovery never leaks results into the page');
    buttonsLabelled(state.view(), '编辑').at(-1).props.onClick();
    eq(state.models().props.value, 'cheap-model', 'reopening a cancelled group editor starts from stored models');
    eq(state.options().length, 0, 'reopening a cancelled editor clears its previous discovery state');
    eq(state.updates().length, 0, 'cancel and late response never save a group');
  } finally { state.restore(); }
}

// ------------------------------------------------- batch from the UI

const batchState = await renderState(page, 'ready');
const rowBoxes = inputsIn(batchState.tree).filter((input) => input.props.className === 'dap-check-row');
eq(rowBoxes.length, 5, 'every account row can be selected');
eq(
  inputsIn(batchState.tree).filter((input) => input.props.className === 'dap-check-all').length,
  1,
  'and there is exactly one select-all',
);

await rowBoxes[0].props.onChange();
await sweep();
const picked = render(page.type, page.props);
ok(textOf(picked).includes('已选 1 个'), 'the toolbar reports how many are selected');

// The toolbar renders ABOVE the table, so its 停用 is the first one on the page.
await buttonsLabelled(picked, '停用')[0].props.onClick();
await sweep();
const batchBody = JSON.parse(posts(batchState.calls).at(-1).body);
eq(batchBody.action, 'batch');
eq(batchBody.verb, 'disable');
eq(batchBody.ids.length, 1, 'exactly the selected accounts travel, not the whole pool');

// A successful batch clears the selection, so the toolbar retracts by itself.
eq(
  textOf(render(page.type, page.props)).includes('已选 1 个'),
  false,
  'a successful batch clears the selection and hides the toolbar',
);

// Deleting is ARMED first, so a single click can never destroy accounts.
await rowBoxes[0].props.onChange();
await sweep();
const postsBeforeArm = posts(batchState.calls).length;
const armedStart = render(page.type, page.props);
ok(textOf(armedStart).includes('批量删除'), 'the toolbar offers a delete');

await buttonsLabelled(armedStart, '批量删除')[0].props.onClick();
await sweep();
const armedDelete = render(page.type, page.props);
ok(textOf(armedDelete).includes('确认删除 1 个'), 'the first click only ARMS it, and names the count');
eq(posts(batchState.calls).length, postsBeforeArm, 'arming issues NO request');

// Changing the selection disarms it, so an armed delete cannot fire on a different set.
await inputsIn(armedDelete).filter((input) => input.props.className === 'dap-check-row')[1].props.onChange();
await sweep();
ok(textOf(render(page.type, page.props)).includes('确认删除') === false, 'changing the selection disarms it again');

// Re-select and confirm: the SECOND click is what actually deletes.
await inputsIn(render(page.type, page.props)).filter((input) => input.props.className === 'dap-check-row')[0].props.onChange();
await sweep();
await buttonsLabelled(render(page.type, page.props), '批量删除')[0].props.onClick();
await sweep();
await buttonsLabelled(render(page.type, page.props), '确认删除 1 个')[0].props.onClick();
await sweep();
const delBody = JSON.parse(posts(batchState.calls).at(-1).body);
eq(delBody.verb, 'delete', 'the confirmed click is what deletes');
eq(delBody.ids.length, 1, 'and it still names only the selected accounts');

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
    await sweep();
  }
  const opened = render(page.type, page.props);
  nodesIn(opened, 'select').find((node) => !node.props['aria-label']).props.onChange({ target: { value: groupId } });
  await sweep();
  const typed = render(page.type, page.props);
  nodesIn(typed, 'textarea')[0].props.onChange({ target: { value: text } });
  await sweep();
}

const importState = await renderState(page, 'ready');
await fillImport('cheap', '{"accounts":[]}');
const importOpen = render(page.type, page.props);
ok(textOf(importOpen).includes('导入到分组'), 'the import panel offers a target group');
eq(nodesIn(importOpen, 'select').filter((node) => !node.props['aria-label']).length, 1, 'exactly one target-group select');

await buttonsLabelled(importOpen, '开始导入')[0].props.onClick();
await sweep();
const intoGroup = JSON.parse(posts(importState.calls).at(-1).body);
eq(intoGroup.action, 'import');
eq(intoGroup.group, 'cheap', 'the chosen group travels with the import');

// "No group" must OMIT the field: an empty id would be looked up and rejected.
await fillImport('', '{"accounts":[]}');
await buttonsLabelled(render(page.type, page.props), '开始导入')[0].props.onClick();
await sweep();
const ungrouped = JSON.parse(posts(importState.calls).at(-1).body);
eq('group' in ungrouped, false, 'choosing no group omits the field entirely');

// ------------------------------------------------- OAuth sign-in from the page

const oauthState = await renderState(page, 'ready');
{
  const head = buttonsLabelled(oauthState.tree, 'OAuth 登录');
  ok(head.length === 1, 'the page header offers an OAuth sign-in button');
  head[0].props.onClick();
  await sweep();
}

const oauthOpen = render(page.type, page.props);
ok(textOf(oauthOpen).includes('OAuth 登录上游账号'), 'the panel opens with its title');

// The provider picker is fed by the separate directory request, and it must show
// WHICH provider is the awkward one — that is the whole point of `manualOnly`
// and `unverified` travelling with the entry. The panel carries a second select
// as well — the loopback spelling, an input to `oauth-start` — so the provider
// assertions are scoped to the picker that actually holds provider ids.
{
  const selects = nodesIn(oauthOpen, 'select').filter((node) => !node.props['aria-label']);
  eq(selects.length, 2, 'the provider picker and the loopback spelling');
  const providerSelect = selects.find((select) => nodesIn(select, 'option').some((option) => option.props.value === 'anthropic'));
  ok(providerSelect !== undefined, 'one of the two is the provider picker');
  const hostSelect = selects.find((select) => select !== providerSelect);
  eq(
    nodesIn(hostSelect, 'option').map((option) => option.props.value).sort(),
    ['', '127.0.0.1'],
    'the other one offers both spellings of the loopback host',
  );
  // Walked recursively: the fake createElement does NOT flatten an array of
  // children the way real React does, so the options are nested one level deeper.
  const options = nodesIn(providerSelect, 'option');
  eq(options.length, 4, 'every provider is offered');
  eq(options.map((option) => option.props.value).sort(), ['anthropic', 'gemini', 'grok', 'openai'], 'and each carries its id as the value');
  // `manualOnly` is a panel-level hint rather than part of the option label: the
  // operator needs it while reading the instructions, not while scanning a list.
  eq(rawText(options.find((option) => option.props.value === 'gemini')), 'Google (Gemini CLI)');
  ok(rawText(options.find((option) => option.props.value === 'anthropic')).includes('未核实'), 'Anthropic says its endpoints are unverified');
  eq(rawText(options.find((option) => option.props.value === 'openai')), 'OpenAI (Codex)', 'a verified provider carries no caveat');
}

// Switching to Gemini must warn BEFORE the operator is sent to the vendor.
{
  nodesIn(render(page.type, page.props), 'select').find((node) => !node.props['aria-label']).props.onChange({ target: { value: 'gemini' } });
  await sweep();
  ok(textOf(render(page.type, page.props)).includes('厂商那边'), 'the panel says the code has to be pasted back');
  nodesIn(render(page.type, page.props), 'select').find((node) => !node.props['aria-label']).props.onChange({ target: { value: 'openai' } });
  await sweep();
}

// Starting the login posts `oauth-start` with the chosen provider and puts the
// authorization URL on screen (opening a tab is best-effort, the URL is not).
await buttonsLabelled(render(page.type, page.props), '开始登录')[0].props.onClick();
await sweep();

const startedBody = JSON.parse(posts(oauthState.calls).at(-1).body);
eq(startedBody.action, 'oauth-start');
eq(startedBody.provider, 'openai', 'the picker value travels as the provider id');

const oauthWaiting = render(page.type, page.props);
ok(textOf(oauthWaiting).includes('等待授权'), 'the panel shows it is waiting for the vendor');
ok(textOf(oauthWaiting).includes('https://vendor.example/auth'), 'the authorization URL is visible even if the tab did not open');
ok(textOf(oauthWaiting).includes('本地回调已就绪'), 'a loopback login says the page will notice on its own');

// Finishing posts the pasted input for the pending flow.
{
  const box = inputsIn(render(page.type, page.props)).find((input) => input.props.placeholder?.includes('oauth/callback'));
  ok(box !== undefined, 'there is a paste box for the callback URL');
  box.props.onChange({ target: { value: 'http://localhost:14518/oauth/callback?code=C1&state=nonce-1' } });
  await sweep();
}
await buttonsLabelled(render(page.type, page.props), '完成登录')[0].props.onClick();
await sweep();

const finishBody = JSON.parse(posts(oauthState.calls).at(-1).body);
eq(finishBody.action, 'oauth-finish');
eq(finishBody.flow, 'openai-flow1', 'the finish addresses the flow the start returned');
eq(finishBody.input, 'http://localhost:14518/oauth/callback?code=C1&state=nonce-1', 'the pasted text is sent verbatim — the host parses it');
{
  const done = render(page.type, page.props);
  ok(textOf(done).includes('openai-abc123'), 'the new account id is reported back');
  const completed=buttonsLabelled(done,'完成并返回')[0];ok(completed!==undefined&&completed.props.disabled!==true,'successful login has an enabled completion action');
  eq(buttonsLabelled(done,'取消登录').length,0,'successful login no longer offers cancellation');
  eq(buttonsLabelled(done,'自检参数').length,0,'successful login hides obsolete parameter checks');
  ok(!textOf(done).includes('https://vendor.example/auth'),'successful login removes the authorization URL');
  ok(!inputsIn(done).some(n=>n.props.placeholder?.includes('oauth/callback')),'successful login removes manual code entry');
  const before=posts(oauthState.calls).length;completed.props.onClick();await sweep();
  eq(buttonsLabelled(render(page.type,page.props),'完成并返回').length,0,'completion action closes login panel');
  eq(posts(oauthState.calls).length,before,'completion neither repeats token exchange nor cancels login');
}

// Automatic callback completion has no pasted input, and stops its pending timer.
{
  const state=await renderState(page,'ready');buttonsLabelled(state.tree,'OAuth 登录')[0].props.onClick();await sweep();
  await buttonsLabelled(render(page.type,page.props),'开始登录')[0].props.onClick();await sweep();
  let releases=[];const oldFetch=globalThis.fetch;const oldSet=globalThis.setInterval;const oldClear=globalThis.clearInterval;
  globalThis.setInterval=(fn,ms)=>{const id=++testTimerId;testIntervals.set(id,{fn,ms});return id;};globalThis.clearInterval=id=>testIntervals.delete(id);
  globalThis.fetch=async(url,init)=>{if(init?.method==='POST'&&JSON.parse(init.body).action==='oauth-status'){state.calls.push({url:String(url),method:'POST',body:init.body});return new Promise(resolve=>releases.push(resolve));}return oldFetch(url,init);};
  render(page.type,page.props);const timer=[...testIntervals.values()].find(entry=>entry.ms===2000);ok(!!timer,'automatic login starts polling while pending');timer.fn();timer.fn();await new Promise(resolve=>setImmediate(resolve));
  const doneFlow={...oauthStarted('openai').flow,status:'done',accountId:'auto-account'};releases[0]({ok:true,status:200,json:async()=>({flow:doneFlow})});await sweep();
  let view=render(page.type,page.props);ok(textOf(view).includes('auto-account'),'automatic callback reports the saved account without pasted code');
  const finished=buttonsLabelled(view,'完成并返回')[0];ok(!!finished&&finished.props.disabled!==true,'automatic completion action is enabled with empty input');
  ok(![...testIntervals.values()].some(entry=>entry.ms===2000),'successful callback stops polling');
  buttonsLabelled(view,'继续添加账号')[0].props.onClick();view=render(page.type,page.props);ok(buttonsLabelled(view,'开始登录').length===1,'add another returns to provider setup');
  releases[1]({ok:true,status:200,json:async()=>({flow:doneFlow})});await sweep();view=render(page.type,page.props);ok(!textOf(view).includes('auto-account'),'late response cannot restore an old completed flow');
  eq(posts(state.calls).filter(call=>['oauth-finish','oauth-cancel'].includes(JSON.parse(call.body).action)).length,0,'automatic completion needs no second exchange or cancellation');
  globalThis.fetch=oldFetch;globalThis.setInterval=oldSet;globalThis.clearInterval=oldClear;
}
// Cancelling posts `oauth-cancel` and closes the panel.
{
  const cancelledState = await renderState(page, 'ready');
  buttonsLabelled(cancelledState.tree, 'OAuth 登录')[0].props.onClick();
  await sweep();
  await buttonsLabelled(render(page.type, page.props), '开始登录')[0].props.onClick();
  await sweep();
  await buttonsLabelled(render(page.type, page.props), '取消登录')[0].props.onClick();
  await sweep();

  const cancelBody = JSON.parse(posts(cancelledState.calls).at(-1).body);
  eq(cancelBody.action, 'oauth-cancel');
  eq(cancelBody.flow, 'openai-flow1');
  eq(buttonsLabelled(render(page.type, page.props), '开始登录').length, 0, 'the panel closed with the login');
}

// ------------------------------------------------- per-pool priority from the UI

const prioState = await renderState(page, 'ready');
buttonsLabelled(prioState.tree, '编辑')[0].props.onClick();
await sweep();
const prioBoxes = inputsIn(render(page.type, page.props))
  .filter((input) => input.props.className === 'dap-check-prio');
ok(prioBoxes.length >= 1, 'a priority input exists for pools the account belongs to');

await prioBoxes[0].props.onChange({ target: { value: '7' } });
await sweep();
{ const tree = render(page.type, page.props); const form = nodesIn(tree, 'form')[0]; if (form) await form.props.onSubmit({ preventDefault() {} }); else await buttonsLabelled(tree, '保存')[0].props.onClick(); }
await sweep();

// Deliberately loose about the COUNT (the fixture may hold several pools) but strict
// about the contract: the account update goes first, and each ranking is its OWN
// action because the write route takes one action at a time.
const prioPosts = posts(prioState.calls);
eq(JSON.parse(prioPosts[0].body).action, 'update', 'the account update goes first');
const prioBody = JSON.parse(prioPosts.at(-1).body);
eq(prioBody.action, 'priority-set', 'the ranking travels as its own action');
ok(prioPosts.length >= 2, 'so one save can be more than one request');
if (prioBody.group !== undefined) {
  eq(prioBody.group, 'cheap');
  eq(prioBody.priority, 7, 'and as a NUMBER: the host rejects a string with invalid-priority');
}

// ------------------------------------------------- Claude Code mode from the UI

// a1 is the Anthropic account, and the fixture holds it in the mode.

{
  const state = await renderState(page, 'ready');

  ok(textOf(state.tree).includes('anthropic · CC 模式'), 'a disguised account is marked in its own row');
  eq(buttonsLabelled(state.tree, '关闭 CC 模式').length, 1, 'and its row offers to turn the mode off');
  eq(
    buttonsLabelled(state.tree, '开启 CC 模式').length,
    0,
    'the switch is not drawn for non-Anthropic accounts, where the host gate would ignore it',
  );

  buttonsLabelled(state.tree, '关闭 CC 模式')[0].props.onClick();
  await sweep();
  const sent = JSON.parse(posts(state.calls).at(-1).body);
  eq(sent.action, 'set-mimicry', 'the switch is a named account action, not a generic patch');
  eq(sent.id, 'a1', 'addressed at the account it was drawn on');
  eq(sent.mimicry, 'off', 'and it sends the opposite of the current state');
}

// The form also edits the mode explicitly, next to the credential type that
// decides which header the secret travels in.
{
  const state = await renderState(page, 'ready');
  buttonsLabelled(state.tree, '编辑')[0].props.onClick();
  await sweep();
  const form = render(page.type, page.props);
  const selects = nodesIn(form, 'select');

  const mimicrySelect = selects.find((select) => select.props.value === 'claude-code');
  ok(mimicrySelect !== undefined, 'the form opens on the STORED mode, not on the default');
  eq(
    selects.some((select) => select.props.value === 'oauth'),
    true,
    'and on the stored credential type, which decides Bearer vs x-api-key',
  );

  mimicrySelect.props.onChange({ target: { value: 'off' } });
  await sweep();
  { const tree = render(page.type, page.props); const form = nodesIn(tree, 'form')[0]; if (form) await form.props.onSubmit({ preventDefault() {} }); else await buttonsLabelled(tree, '保存')[0].props.onClick(); }
  await sweep();

  const saved = JSON.parse(posts(state.calls).at(-1).body);
  eq(saved.action, 'update');
  eq(saved.account.mimicry, 'off', 'the form sends the chosen mode');
  eq(saved.account.authMode, 'oauth', 'and preserves the credential type it did not touch');
}


// Management parity regressions: state truth, filtered selection and API contracts.
{
  eq(exported.statusOf({ status: 'active', schedulable: false }, NOW).key, 'statusPaused', 'manual scheduling pause is never reported ready');
  eq(exported.statusOf({ status: 'active', schedulable: true, expiresAt: new Date(NOW - 1).toISOString() }, NOW).key, 'statusExpired', 'expiry is visible to operators');
  eq(exported.statusOf({ status: 'active', schedulable: true, expiresAt: new Date(NOW - 1).toISOString(), autoPauseOnExpired: false }, NOW).key, 'statusActive', 'expiry without auto pause stays schedulable');
  eq(exported.filterAccounts(ACCOUNTS_BODY.accounts, { platform: 'openai', status: 'statusCooling' }, NOW).map(a => a.id), ['a2'], 'platform and state filters intersect');
  eq(exported.filterAccounts(ACCOUNTS_BODY.accounts, { group: 'cheap' }, NOW).map(a => a.id), ['a1'], 'group filter respects membership');
  eq(exported.filterAccounts(ACCOUNTS_BODY.accounts, { group: '__ungrouped' }, NOW).length, 4, 'ungrouped is not the all groups filter');
  eq(exported.filterAccounts([{ id: 'x', notes: 'Backup WEST', models: ['sonnet'], priority: 2 }, { id: 'y', priority: 1 }], { query: 'west' }, NOW).map(a => a.id), ['x'], 'search includes notes without case sensitivity');
  eq(exported.filterAccounts([{ id: 'z', priority: 3 }, { id: 'b', priority: 1 }], {}, NOW).map(a => a.id), ['b','z'], 'priority sorting is numeric');
  eq(exported.filterAccounts([{ id: 'z', lastUsedAt: '2026-01-02T00:00:00.000Z' }, { id: 'b', lastUsedAt: null }], { sort: 'recent' }, NOW).map(a => a.id), ['z','b'], 'never used accounts follow recently used accounts');
  eq(exported.localDateInput(null), '', 'empty expiry remains empty');

  const state = await renderState(page, 'ready');
  const filter = nodesIn(state.tree, 'select').find(n => n.props['aria-label'] === '全部平台');
  filter.props.onChange({ target: { value: 'openai' } });
  await sweep();
  const filtered = render(page.type, page.props);
  eq(inputsIn(filtered).filter(n => n.props.className === 'dap-check-row').length, 1, 'the table displays only matched accounts');
  inputsIn(filtered).find(n => n.props.className === 'dap-check-all').props.onChange();
  await sweep();
  await buttonsLabelled(render(page.type, page.props), '暂停调度')[0].props.onClick();
  await sweep();
  const sent = JSON.parse(posts(state.calls).at(-1).body);
  eq(sent.verb, 'pause-scheduling', 'filtered batch pause uses host verb');
  eq(sent.ids, ['a2'], 'select all affects only the visible filtered accounts');
}
{
  const state = await renderState(page, 'ready');
  await buttonsLabelled(state.tree, '暂停调度')[0].props.onClick();
  await sweep();
  eq(JSON.parse(posts(state.calls).at(-1).body).action, 'pause-scheduling', 'row pause uses the same state contract as batch');
  await buttonsLabelled(render(page.type, page.props), '重置异常')[0].props.onClick();
  await sweep();
  eq(JSON.parse(posts(state.calls).at(-1).body).action, 'reset-error', 'error recovery is a dedicated action');
}
{
  const state = await renderState(page, 'ready');
  inputsIn(state.tree).find(n => n.props.className === 'dap-check-row').props.onChange();
  await sweep();
  buttonsLabelled(render(page.type, page.props), '批量编辑')[0].props.onClick();
  await sweep();
  const opened = render(page.type, page.props);
  inputsIn(opened).find(n => n.props.type === 'number').props.onChange({ target: { value: '7' } });
  await sweep();
  await buttonsLabelled(render(page.type, page.props), '应用到所选账号')[0].props.onClick();
  await sweep();
  const sent = JSON.parse(posts(state.calls).at(-1).body);
  eq(sent.verb, 'update', 'batch edit uses the batch update contract');
  eq(sent.account, { priority: 7 }, 'untouched batch values never overwrite accounts');
}
{
  const state = await renderState(page, 'ready');
  buttonsLabelled(state.tree, '编辑')[0].props.onClick();
  await sweep();
  let tree = render(page.type, page.props);
  const form = nodesIn(tree, 'form')[0];
  const fields = inputsIn(form);
  fields.find(n => n.props.type === 'datetime-local').props.onChange({ target: { value: '2028-01-02T03:04' } });
  fields.find(n => n.props.type === 'number' && n.props.value === '').props.onChange({ target: { value: '5' } });
  await sweep();
  tree = render(page.type, page.props);
  await nodesIn(tree, 'form')[0].props.onSubmit({ preventDefault() {} });
  await sweep();
  const sent = JSON.parse(posts(state.calls)[0].body);
  eq(sent.account.expiresAt, new Date('2028-01-02T03:04').toISOString(), 'local datetime is stored as a canonical UTC instant');
  eq(sent.account.loadFactor, 5, 'load factor is numeric');
  eq(sent.account.schedulable, true, 'saving metadata preserves scheduling state');
}
{
  const state = await renderState(page, 'ready');
  const stub = makeFetch('ready');
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST' && JSON.parse(init.body).action === 'test') {
      const body = JSON.parse(init.body);
      state.calls.push({ url, method: 'POST', body: init.body });
      return { ok: true, status: 200, json: async () => ({ ok: true, test: { ok: false, message: 'Authentication refused', latencyMs: 8 } }) };
    }
    return stub.impl(url, init);
  };
  const button = buttonsLabelled(state.tree, '测试连接').find(n => !n.props.disabled);
  button.props.onClick();
  await sweep();
  const opened = render(page.type, page.props);
  const model = inputsIn(opened).find(n => n.props.type === 'text' && n.props.value === '');
  model.props.onChange({ target: { value: 'claude-sonnet-4' } });
  await sweep();
  await buttonsLabelled(render(page.type, page.props), '测试连接')[0].props.onClick();
  await sweep();
  eq(JSON.parse(posts(state.calls).at(-1).body), { id: 'a1', action: 'test', model: 'claude-sonnet-4' }, 'test addresses one account and the selected model');
  ok(textOf(render(page.type, page.props)).includes('Authentication refused'), 'HTTP 200 with failed probe is displayed as failure');
}
{
  const oldVersion = ACCOUNTS_BODY.managementVersion;
  delete ACCOUNTS_BODY.managementVersion;
  const state = await renderState(page, 'ready');
  ok(textOf(state.tree).includes('重启 DSH'), 'old host has a clear activation notice');
  eq(buttonsLabelled(state.tree, '测试连接').length, 0, 'old host never receives unsupported test action');
  eq(buttonsLabelled(state.tree, '导出配置').length, 0, 'export is gated on management capabilities');
  buttonsLabelled(state.tree, '编辑')[0].props.onClick();
  await sweep();
  const tree = render(page.type, page.props);
  eq(inputsIn(tree).filter(n => n.props.type === 'datetime-local').length, 0, 'old host has no unusable expiry field');
  await nodesIn(tree, 'form')[0].props.onSubmit({ preventDefault() {} });
  await sweep();
  const patch = JSON.parse(posts(state.calls)[0].body).account;
  eq('notes' in patch, false, 'old host saves omit newly introduced fields');
  ACCOUNTS_BODY.managementVersion = oldVersion;
}


{
  const state = await renderState(page, 'ready');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST' && JSON.parse(init.body).action === 'batch') {
      state.calls.push({ url, method: 'POST', body: init.body });
      return { ok: true, status: 200, json: async () => ({ ok: false, done: ['a1'], failed: [{ id: 'a2', reason: 'account-busy' }] }) };
    }
    return originalFetch(url, init);
  };
  inputsIn(state.tree).find(n => n.props.className === 'dap-check-all').props.onChange();
  await sweep();
  await buttonsLabelled(render(page.type, page.props), '停用')[0].props.onClick();
  await sweep();
  const tree = render(page.type, page.props);
  ok(textOf(tree).includes('a2: account-busy'), 'partial batch failures show the per-account reason');
  ok(textOf(tree).includes('成功: a1'), 'partial successes remain visible');
  eq(inputsIn(tree).filter(n => n.props.className === 'dap-check-row' && n.props.checked).length, 1, 'failed accounts remain selected for retry');
}
{
  const original = ACCOUNTS_BODY.accounts;
  ACCOUNTS_BODY.accounts = Array.from({ length: 55 }, (_, i) => ({ ...original[0], id: `account-${i}`, label: `Account ${i}`, priority: i }));
  const state = await renderState(page, 'ready');
  eq(inputsIn(state.tree).filter(n => n.props.className === 'dap-check-row').length, 50, 'default page caps displayed accounts at 50');
  buttonsLabelled(state.tree, '下一页')[0].props.onClick();
  await sweep();
  const second = render(page.type, page.props);
  eq(inputsIn(second).filter(n => n.props.className === 'dap-check-row').length, 5, 'last page displays the remaining accounts');
  inputsIn(second).find(n => n.props.className === 'dap-check-all').props.onChange();
  await sweep();
  await buttonsLabelled(render(page.type, page.props), '停用')[0].props.onClick();
  await sweep();
  eq(JSON.parse(posts(state.calls).at(-1).body).ids, ['account-50','account-51','account-52','account-53','account-54'], 'page selection never accidentally operates on the whole pool');
  ACCOUNTS_BODY.accounts = original;
}
{
  const state = await renderState(page, 'ready');
  buttonsLabelled(state.tree, '编辑').at(-1).props.onClick();
  await sweep();
  const tree = render(page.type, page.props);
  const mode = nodesIn(nodesIn(tree, 'form')[0], 'select').find(n => n.props.value === 'sticky');
  mode.props.onChange({ target: { value: 'weighted-random' } });
  await sweep();
  await nodesIn(render(page.type, page.props), 'form')[0].props.onSubmit({ preventDefault() {} });
  await sweep();
  eq(JSON.parse(posts(state.calls).at(-1).body).group.selectionMode, 'weighted-random', 'group strategy is persisted through the group API');
}

{
  ACCOUNTS_BODY.quotaVersion = 1;
  const original=ACCOUNTS_BODY.accounts;
  ACCOUNTS_BODY.accounts=[{...original[0],quota:{supported:true,ok:true,at:new Date(NOW).toISOString(),source:'codex',plan:'plus',windows:[{id:'primary',label:'5h',remainingPercent:0,usedPercent:100,resetAt:new Date(NOW+120000).toISOString()}]}}];
  const state=await renderState(page,'ready');
  ok(textOf(state.tree).includes('余 0%'),'a depleted remote window displays zero, not unknown');
  eq(nodesIn(state.tree,'progress')[0].props.value,0,'quota progress represents true remaining balance');
  await sweep();
  await buttonsLabelled(render(page.type,page.props),'刷新用量')[0].props.onClick();
  await sweep();
  eq(posts(state.calls).map(call=>JSON.parse(call.body)).find(body=>body.action==='quota'&&body.force===true),{id:'a1',action:'quota',force:true},'manual query explicitly refreshes upstream quota');
  ACCOUNTS_BODY.accounts=[{...original[0],quota:{supported:true,ok:false,stale:true,lastSuccessAt:new Date(NOW-120000).toISOString(),at:new Date(NOW).toISOString(),message:'HTTP 503',windows:[{id:'primary',label:'5h',remainingPercent:80}]}}];
  const stale=await renderState(page,'ready');
  ok(textOf(stale.tree).includes('数据已过期'),'failed refresh distinguishes stale quota from current success');
  buttonsLabelled(stale.tree,'查看用量 ›')[0].props.onClick();
  ok(textOf(render(page.type,page.props)).includes('HTTP 503'),'quota failure remains visible alongside last success');
  ACCOUNTS_BODY.accounts=[{...original[0],platform:'openai',authMode:'oauth',chatgptAccountId:'workspace-test',quota:null}];
  const edit=await renderState(page,'ready');buttonsLabelled(edit.tree,'编辑')[0].props.onClick();await sweep();
  const tree=render(page.type,page.props);
  const idInput=inputsIn(tree).find(n=>n.props.value==='workspace-test');
  ok(!!idInput,'Codex workspace override appears in account editor');
  idInput.props.onChange({target:{value:'workspace-new'}});await sweep();
  await nodesIn(render(page.type,page.props),'form')[0].props.onSubmit({preventDefault(){}});await sweep();
  eq(JSON.parse(posts(edit.calls).at(-1).body).account.chatgptAccountId,'workspace-new','Codex account id saves through native capability gate');
  ACCOUNTS_BODY.accounts=original;delete ACCOUNTS_BODY.quotaVersion;
}
{
  const state=await renderState(page,'ready');
  eq(buttonsLabelled(state.tree,'刷新用量').length,0,'old host never exposes unsupported quota actions');
  ok(textOf(state.tree).includes('Codex / Gemini 原生调用'),'old host explains the native protocol restart requirement');
}
// ------------------------------------------------- supplier setup, mock-only HTTP
{
  const old=await renderState(page,'ready');
  ok(textOf(old.tree).includes('简化的供应商接入'),'supplier old backend gives a restart hint');
  eq(buttonsLabelled(old.tree,'接入供应商').length,0,'supplier gate never sends unsupported action');
  eq(buttonsLabelled(old.tree,'新增账号').length,1,'supplier gate preserves original account add');
  ACCOUNTS_BODY.supplierVersion=1;
  const state=await renderState(page,'ready');
  eq(buttonsLabelled(state.tree,'新增账号').length,0,'new backend makes supplier setup the default');
  eq(buttonsLabelled(state.tree,'高级新增账号').length,1,'advanced account setup remains accessible');
  buttonsLabelled(state.tree,'接入供应商')[0].props.onClick();
  const view=()=>render(page.type,page.props);
  let tree=view();
  eq(nodesIn(tree,'form').length,1,'supplier setup opens one form');
  eq(inputsIn(tree).filter(n=>n.props.type==='password').length,1,'supplier API key is masked');
  ok(!textOf(tree).includes('ID（唯一'),'simple supplier setup omits account ID');
  ok(!textOf(tree).includes('权重'),'simple supplier setup omits scheduling weights');
  // Scoped to the form: the page as a whole also draws one `details` per account
  // row (the expiry disclosure and the row's action menu), so counting over the
  // whole tree measures the fixture, not the supplier form.
  eq(nodesIn(nodesIn(tree,'form')[0],'details').length,1,'supplier group and Claude settings are tucked into details');
  const input=(label,value)=>{const n=inputsIn(view()).find(n=>n.props['aria-label']===label);if(!n)throw Error('missing '+label);n.props.onChange({target:{value}});};
  const modelInput=(value)=>nodesIn(view(),'textarea').find(n=>n.props['aria-label']==='可用模型').props.onChange({target:{value}});
  const choice=(label,value)=>nodesIn(view(),'select').find(n=>n.props['aria-label']===label).props.onChange({target:{value}});
  eq(buttonsLabelled(tree,'接入供应商').at(-1).props.disabled,true,'missing required supplier fields disable submit');
  input('供应商名称',' Anyrouter1 ');input('API 地址','https://supplier.invalid/v1');input('API Key','fixture-key');modelInput('claude-test, claude-test\nclaude-backup');
  eq(buttonsLabelled(view(),'接入供应商').at(-1).props.disabled,false,'valid supplier fields enable submit');
  let captured;
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{captured=JSON.parse(init.body);return{ok:true,status:200,json:async()=>({ok:true,action:'supplier-connect',provider:{id:'pool-new',name:'Anyrouter1',models:['claude-test','claude-backup']}})};};
  await nodesIn(view(),'form')[0].props.onSubmit({preventDefault(){}});
  await sweep();
  eq(captured,{id:'',action:'supplier-connect',supplier:{name:'Anyrouter1',platform:'anthropic',baseUrl:'https://supplier.invalid/v1',models:['claude-test','claude-backup'],mimicry:'off',betas:[]},credential:'fixture-key'},'supplier POST has only required setup payload and deduplicated models');
  tree=view();
  ok(textOf(tree).includes('已接入 Anyrouter1'),'supplier success names the connected supplier');
  ok(textOf(tree).includes('claude-backup'),'supplier success shows available models');
  ok(textOf(tree).includes('聊天输入框下方'),'supplier success guides chat model selection');
  eq(nodesIn(tree,'form').length,0,'supplier success closes secret form');
  globalThis.fetch=originalFetch;
  buttonsLabelled(view(),'接入供应商')[0].props.onClick();
  eq(inputsIn(view()).find(n=>n.props['aria-label']==='API Key').props.value,'','new supplier setup never restores a key');
  buttonsLabelled(view(),'取消')[0].props.onClick();
  delete ACCOUNTS_BODY.supplierVersion;
}
{
  ACCOUNTS_BODY.supplierVersion=1;
  const state=await renderState(page,'ready');buttonsLabelled(state.tree,'接入供应商')[0].props.onClick();
  const view=()=>render(page.type,page.props);
  const input=(label,value)=>inputsIn(view()).find(n=>n.props['aria-label']===label).props.onChange({target:{value}});
  const models=()=>nodesIn(view(),'textarea').find(n=>n.props['aria-label']==='可用模型');
  const choice=(label,value)=>nodesIn(view(),'select').find(n=>n.props['aria-label']===label).props.onChange({target:{value}});
  input('供应商名称','Fixture');input('API 地址','https://supplier.invalid');input('API Key','fixture-key');models().props.onChange({target:{value:'manual-model'}});
  let captured;const oldFetch=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{captured=JSON.parse(init.body);return{ok:false,status:503,json:async()=>({error:{message:'directory unavailable'}})};};
  await buttonsLabelled(view(),'获取模型目录')[0].props.onClick();
  eq(captured,{id:'',action:'supplier-models',supplier:{platform:'anthropic',baseUrl:'https://supplier.invalid'},credential:'fixture-key'},'model discovery has no account save or inference fields');
  eq(models().props.value,'manual-model','directory error preserves manually entered models');
  ok(textOf(view()).includes('可以手动填写模型'),'directory error gives manual fallback');
  let resolve;globalThis.fetch=()=>new Promise(r=>{resolve=r;});
  const delayed=buttonsLabelled(view(),'获取模型目录')[0].props.onClick();
  eq(buttonsLabelled(view(),'正在获取…')[0].props.disabled,true,'directory request shows pending');
  models().props.onChange({target:{value:'edited-after-request'}});
  resolve({ok:true,status:200,json:async()=>({ok:true,models:['stale-model']})});await delayed;
  eq(models().props.value,'edited-after-request','late directory success never overwrites newer manual input');
  let reject;globalThis.fetch=()=>new Promise((_resolve,r)=>{reject=r;});
  const oldFailure=buttonsLabelled(view(),'获取模型目录')[0].props.onClick();
  input('API 地址','https://replacement.invalid');
  reject(new Error('stale-directory-error'));await oldFailure;
  ok(!textOf(view()).includes('stale-directory-error'),'late directory failure never replaces state after endpoint edit');
  eq(models().props.value,'edited-after-request','endpoint edit preserves manual model entries');
  globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({ok:true,models:['model-a','model-a','model-b']})});
  await buttonsLabelled(view(),'获取模型目录')[0].props.onClick();
  eq(models().props.value,'model-a\nmodel-b','current directory success writes editable unique model IDs');
  choice('加入已有供应商 / 分组','cheap');choice('Claude Code 模式','claude-code');input('可选 Anthropic Beta（逗号分隔）','test-beta');
  globalThis.fetch=async(url,init)=>{captured=JSON.parse(init.body);return{ok:false,status:400,json:async()=>({error:{message:'group model restriction'}})};};
  await nodesIn(view(),'form')[0].props.onSubmit({preventDefault(){}});await sweep();
  eq(captured.supplier.groupId,'cheap','supplier supports joining an existing group');
  eq(captured.supplier.mimicry,'claude-code','supplier advanced Claude mode is sent');
  eq(captured.supplier.betas,['test-beta'],'supplier advanced beta values are sent');
  ok(textOf(view()).includes('group model restriction'),'host whitelist rejection stays visible for correction');
  eq(inputsIn(view()).find(n=>n.props['aria-label']==='API Key').props.value,'fixture-key','failed connect allows correction and retry');
  choice('调用协议','openai');
  globalThis.fetch=async(url,init)=>{captured=JSON.parse(init.body);return{ok:false,status:400,json:async()=>({error:{message:'fixture failure'}})};};
  await nodesIn(view(),'form')[0].props.onSubmit({preventDefault(){}});await sweep();
  ok(!('mimicry'in captured.supplier)&&!('betas'in captured.supplier),'non-Anthropic protocol omits stale Claude options');
  let finish;globalThis.fetch=()=>new Promise(r=>{finish=r;});
  const cancelledDiscovery=buttonsLabelled(view(),'获取模型目录')[0].props.onClick();
  buttonsLabelled(view(),'取消')[0].props.onClick();
  finish({ok:true,status:200,json:async()=>({ok:true,models:['cancelled-model']})});await cancelledDiscovery;
  eq(nodesIn(view(),'form').length,0,'late discovery after cancel never reopens supplier form');
  ok(!textOf(view()).includes('cancelled-model'),'cancelled discovery does not leak results into page');
  globalThis.fetch=oldFetch;delete ACCOUNTS_BODY.supplierVersion;
}
{
  ACCOUNTS_BODY.supplierVersion=1;ACCOUNTS_BODY.openaiProtocolVersion=1;
  const state=await renderState(page,'ready');buttonsLabelled(state.tree,'接入供应商')[0].props.onClick();
  const view=()=>render(page.type,page.props);
  const input=(label,value)=>inputsIn(view()).find(n=>n.props['aria-label']===label).props.onChange({target:{value}});
  const choice=(label,value)=>nodesIn(view(),'select').find(n=>n.props['aria-label']===label).props.onChange({target:{value}});
  ok(!nodesIn(view(),'select').some(n=>n.props['aria-label']==='请求格式'),'Anthropic supplier does not show OpenAI format');
  choice('调用协议','openai');
  eq(nodesIn(view(),'select').find(n=>n.props['aria-label']==='请求格式').props.value,'chat-completions','legacy format remains default');
  eq(nodesIn(view(),'option').find(n=>n.props.value==='websocket').props.disabled,true,'Chat Completions cannot choose WebSocket');
  choice('请求格式','responses');choice('传输方式','websocket');
  input('供应商名称','Response supplier');input('API 地址','wss://relay.invalid/v1/responses');input('API Key','fixture-response-key');
  nodesIn(view(),'textarea').find(n=>n.props['aria-label']==='可用模型').props.onChange({target:{value:'response-model'}});
  const oldFetch=globalThis.fetch;let captured;
  globalThis.fetch=async(_url,init)=>{captured=JSON.parse(init.body);return{ok:false,status:400,json:async()=>({error:{message:'fixture-rejection'}})};};
  await nodesIn(view(),'form')[0].props.onSubmit({preventDefault(){}});await sweep();
  eq(captured.supplier.openaiApi,'responses','supplier save sends Responses format');eq(captured.supplier.openaiTransport,'websocket','supplier save sends WebSocket transport');eq(captured.supplier.baseUrl,'wss://relay.invalid/v1/responses','supplier accepts WS address');
  choice('请求格式','chat-completions');eq(nodesIn(view(),'select').find(n=>n.props['aria-label']==='传输方式').props.value,'http','returning to chat resets transport');
  choice('调用协议','anthropic');input('API 地址','https://relay.invalid');await nodesIn(view(),'form')[0].props.onSubmit({preventDefault(){}});await sweep();
  ok(!('openaiApi' in captured.supplier)&&!('openaiTransport' in captured.supplier),'other protocol does not send stale OpenAI fields');
  globalThis.fetch=oldFetch;delete ACCOUNTS_BODY.openaiProtocolVersion;delete ACCOUNTS_BODY.supplierVersion;
}
{
  const original=ACCOUNTS_BODY.accounts[0];ACCOUNTS_BODY.accounts[0]={...original,platform:'openai',authMode:'api-key',openaiApi:'responses',openaiTransport:'websocket'};ACCOUNTS_BODY.openaiProtocolVersion=1;
  const state=await renderState(page,'ready');buttonsLabelled(state.tree,'编辑')[0].props.onClick();await sweep();
  const view=()=>render(page.type,page.props);
  eq(nodesIn(view(),'select').find(n=>n.props['aria-label']==='请求格式').props.value,'responses','edit loads saved Responses format');
  eq(nodesIn(view(),'select').find(n=>n.props['aria-label']==='传输方式').props.value,'websocket','edit loads saved WebSocket transport');
  await nodesIn(view(),'form')[0].props.onSubmit({preventDefault(){}});await sweep();
  const saved=JSON.parse(posts(state.calls).find(call=>JSON.parse(call.body).action==='update').body).account;
  eq(saved.openaiApi,'responses','untouched edit preserves saved request format');eq(saved.openaiTransport,'websocket','untouched edit preserves saved transport');
  ACCOUNTS_BODY.accounts[0]=original;delete ACCOUNTS_BODY.openaiProtocolVersion;
}
// ------------------------------------------------- account-level pool detection retries
{
  const previousVersion=ACCOUNTS_BODY.detectionVersion;
  const originalAccount={...ACCOUNTS_BODY.accounts[0]};
  const keys=['poolDetectionRetry','poolDetectionRetries','poolDetectionRetryDelayMs','poolDetectionKeywords'];
  const view=()=>render(page.type,page.props);
  const field=(label)=>inputsIn(view()).find(n=>n.props['aria-label']===label);
  const keywordBox=()=>nodesIn(view(),'textarea').find(n=>n.props['aria-label']==='检测关键词（每行一个）');
  const toggle=()=>field('池检测重试');
  const change=(label,value)=>field(label).props.onChange({target:{value}});
  const save=async()=>{await nodesIn(view(),'form')[0].props.onSubmit({preventDefault(){}});await sweep();};
  const patchOf=(state)=>JSON.parse(posts(state.calls).find(call=>['create','update'].includes(JSON.parse(call.body).action)).body).account;
  const selectFields=(account)=>Object.fromEntries(keys.map(key=>[key,account[key]]));
  const defaults={poolDetectionRetry:false,poolDetectionRetries:2,poolDetectionRetryDelayMs:1000,poolDetectionKeywords:['号池检测','池检测','号池不可用']};
  try {
    ACCOUNTS_BODY.detectionVersion=1;
    {
      const state=await renderState(page,'ready');buttonsLabelled(state.tree,'新增账号')[0].props.onClick();await sweep();
      eq(toggle().props.checked,false,'new account detection retries are opt-in');
      eq(field('额外重试次数（0–5）').props.value,'2','new form counts additional attempts');
      eq(field('重试间隔（毫秒，100–10000）').props.value,'1000','new form default delay is one second');
      eq(keywordBox().props.value,'号池检测\n池检测\n号池不可用','new form uses exactly the three default detection keywords');
      eq(keywordBox().props.disabled,true,'disabled retry options stay visible without being editable');
      ok(textOf(view()).includes('仅在输出前重试同一账号'),'editor explains output boundary and account ownership');
      ok(textOf(view()).includes('达到重试上限后明确返回失败'),'editor explains bounded failure');
      await save();eq(selectFields(patchOf(state)),defaults,'new account saves explicit opt-in default policy');
    }
    {
      const state=await renderState(page,'ready');buttonsLabelled(state.tree,'编辑')[0].props.onClick();await sweep();
      toggle().props.onChange({target:{checked:true}});await sweep();
      eq(keywordBox().props.disabled,false,'toggling retry on enables keyword editing');
      change('额外重试次数（0–5）','5');change('重试间隔（毫秒，100–10000）','100');
      keywordBox().props.onChange({target:{value:'  定制检测，暂不可用  \r\n relay,busy\n\n [literal.*] '}});await sweep();
      await save();eq(selectFields(patchOf(state)),{poolDetectionRetry:true,poolDetectionRetries:5,poolDetectionRetryDelayMs:100,poolDetectionKeywords:['定制检测，暂不可用','relay,busy','[literal.*]']},'enabled retry saves numeric bounds and newline-delimited literal keywords without punctuation splitting');
    }
    const custom={poolDetectionRetry:true,poolDetectionRetries:4,poolDetectionRetryDelayMs:2345,poolDetectionKeywords:['仅该账号检测','relay,busy','[literal.*]']};
    Object.assign(ACCOUNTS_BODY.accounts[0],custom);
    {
      const state=await renderState(page,'ready');buttonsLabelled(state.tree,'编辑')[0].props.onClick();await sweep();
      eq(toggle().props.checked,true,'edit opens on the stored enabled state');
      eq(field('额外重试次数（0–5）').props.value,'4','edit opens on custom retry count');
      eq(field('重试间隔（毫秒，100–10000）').props.value,'2345','edit opens on custom delay');
      eq(keywordBox().props.value,custom.poolDetectionKeywords.join('\n'),'edit loads all custom keywords');
      await save();eq(selectFields(patchOf(state)),custom,'untouched edit preserves stored custom retry policy');
    }
    {
      const state=await renderState(page,'ready');buttonsLabelled(state.tree,'编辑')[0].props.onClick();await sweep();
      toggle().props.onChange({target:{checked:false}});await sweep();
      eq(field('额外重试次数（0–5）').props.disabled,true,'turning off disables configuration inputs');
      eq(keywordBox().props.value,custom.poolDetectionKeywords.join('\n'),'turning off retains custom keyword text');
      toggle().props.onChange({target:{checked:true}});await sweep();
      eq(field('重试间隔（毫秒，100–10000）').props.value,'2345','turning back on restores existing delay');
      toggle().props.onChange({target:{checked:false}});await sweep();await save();
      eq(selectFields(patchOf(state)),{...custom,poolDetectionRetry:false},'saving off retains retry count, delay and custom keywords');
    }
    for(const oldVersion of [undefined,0]) {
      if(oldVersion===undefined)delete ACCOUNTS_BODY.detectionVersion;else ACCOUNTS_BODY.detectionVersion=oldVersion;
      for(const create of [false,true]) {
        const state=await renderState(page,'ready');buttonsLabelled(state.tree,create?'新增账号':'编辑')[0].props.onClick();await sweep();
        eq(toggle(),undefined,'legacy host does not expose a retry enable control');
        eq(keywordBox(),undefined,'legacy host has no unusable keyword editor');
        ok(textOf(view()).includes('重启 DSH 后可配置池检测重试'),'legacy form offers a concise restart notice');
        await save();const saved=patchOf(state);ok(keys.every(key=>!(key in saved)),'legacy create/edit never posts new policy fields even when loaded account has them');
      }
    }
    ACCOUNTS_BODY.detectionVersion=1;
    {
      const state=await renderState(page,'ready');buttonsLabelled(state.tree,'编辑')[0].props.onClick();await sweep();
      const numbers=[['额外重试次数（0–5）','6'],['额外重试次数（0–5）','-1'],['额外重试次数（0–5）','1.5'],['额外重试次数（0–5）',''],['重试间隔（毫秒，100–10000）','99'],['重试间隔（毫秒，100–10000）','10001'],['重试间隔（毫秒，100–10000）','100.5'],['重试间隔（毫秒，100–10000）','']];
      for(const [label,value] of numbers){change('额外重试次数（0–5）','2');change('重试间隔（毫秒，100–10000）','1000');change(label,value);await sweep();await save();eq(posts(state.calls).length,0,'invalid retry bounds are rejected before POST: '+label+'='+value);}
      change('额外重试次数（0–5）','2');change('重试间隔（毫秒，100–10000）','1000');
      for(const value of [Array.from({length:21},(_,i)=>'keyword-'+i).join('\n'),'x'.repeat(201)]){keywordBox().props.onChange({target:{value}});await sweep();await save();eq(posts(state.calls).length,0,'keyword count and length limits are enforced before POST');}
      ok(textOf(view()).includes('关键词最多 20 项'),'invalid policy remains visible for correction');
      change('额外重试次数（0–5）','0');change('重试间隔（毫秒，100–10000）','10000');keywordBox().props.onChange({target:{value:''}});await sweep();
      await save();eq(selectFields(patchOf(state)),{poolDetectionRetry:true,poolDetectionRetries:0,poolDetectionRetryDelayMs:10000,poolDetectionKeywords:[]},'zero additional attempts and intentionally empty keywords never become defaults');
    }
  } finally {
    ACCOUNTS_BODY.accounts[0]=originalAccount;
    if(previousVersion===undefined)delete ACCOUNTS_BODY.detectionVersion;else ACCOUNTS_BODY.detectionVersion=previousVersion;
  }
}
// ------------------------------------------------- report

if (failures.length > 0) {
  for (const { label, error } of failures) console.error(`✗${label}\n    ${error.message}`);
  console.error(`\n${passed}/${checks} 通过：${failures.length} 失败`);
  process.exitCode = 1;
} else {
  console.log(`✓ ${passed}/${checks} 通过`);
}
