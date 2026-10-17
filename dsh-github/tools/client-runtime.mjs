// Offline hook/effect scheduler for real ModuleLoader client event tests.
// Intentionally no DOM, server, Harness configuration, packages or network.
import assert from 'node:assert/strict';

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

/** Fetch receives actual Request objects, including native body parsing. */
export function interceptFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (path, init) => {
    const request = path instanceof Request ? path : new Request(new URL(path, 'http://offline/'), init);
    calls.push(request);
    return handler(request, calls.length);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** Timers advance explicitly; unresolved requests cannot schedule extra polls. */
export function fakeTimers() {
  const oldSet = globalThis.setTimeout;
  const oldClear = globalThis.clearTimeout;
  const timers = new Map();
  let serial = 0;
  const schedule = (fn, delay) => { const id = ++serial; timers.set(id, { fn, delay }); return id; };
  const cancel = (id) => { timers.delete(id); };
  globalThis.setTimeout = schedule;
  globalThis.clearTimeout = cancel;
  return {
    timers, schedule, cancel,
    runNext() {
      const next = timers.entries().next().value;
      assert.ok(next, 'expected a scheduled timer');
      timers.delete(next[0]);
      return next[1].fn();
    },
    restore() { globalThis.setTimeout = oldSet; globalThis.clearTimeout = oldClear; },
  };
}

export const drain = () => new Promise((resolve) => setImmediate(resolve));

const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b)
  && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));

/** Hook slots persist across renders; dependency changes run effect cleanup. */
export function mountComponent(React, Component, initialProps) {
  const originals = Object.fromEntries(['useState', 'useRef', 'useEffect', 'useMemo', 'useCallback'].map((key) => [key, React[key]]));
  const slots = [];
  let cursor = 0;
  let dirty = true;
  let alive = true;
  let rendering = false;
  let props = initialProps;
  let tree;
  let unmountedWrites = 0;
  let pendingEffects = [];
  const slot = (kind) => {
    assert.ok(rendering, `${kind} outside render`);
    const index = cursor++;
    slots[index] ??= { kind };
    assert.equal(slots[index].kind, kind, 'hook order changed');
    return slots[index];
  };
  React.useState = (initial) => {
    const cell = slot('state');
    if (!('value' in cell)) cell.value = typeof initial === 'function' ? initial() : initial;
    cell.set ??= (value) => {
      if (!alive) { unmountedWrites += 1; return; }
      const next = typeof value === 'function' ? value(cell.value) : value;
      if (!Object.is(next, cell.value)) { cell.value = next; dirty = true; }
    };
    return [cell.value, cell.set];
  };
  React.useRef = (initial) => {
    const cell = slot('ref');
    cell.value ??= { current: initial };
    return cell.value;
  };
  React.useMemo = (fn, deps) => {
    const cell = slot('memo');
    if (!sameDeps(cell.deps, deps)) { cell.value = fn(); cell.deps = deps; }
    return cell.value;
  };
  React.useCallback = (fn, deps) => React.useMemo(() => fn, deps);
  React.useEffect = (fn, deps) => {
    const cell = slot('effect');
    if (!sameDeps(cell.deps, deps)) {
      cell.deps = deps;
      pendingEffects.push(() => { cell.cleanup?.(); cell.cleanup = fn(); });
    }
  };
  const instance = {
    get tree() { return tree; },
    get unmountedWrites() { return unmountedWrites; },
    render(nextProps) {
      if (nextProps !== undefined) { props = nextProps; dirty = true; }
      for (let round = 0; dirty; round += 1) {
        assert.ok(round < 30, 'render/effect loop did not settle');
        dirty = false;
        cursor = 0;
        rendering = true;
        try { tree = Component(props); } finally { rendering = false; }
        const effects = pendingEffects;
        pendingEffects = [];
        for (const run of effects) run();
      }
      return tree;
    },
    unmount() {
      if (!alive) return;
      alive = false;
      for (const cell of slots) if (cell.kind === 'effect') cell.cleanup?.();
      Object.assign(React, originals);
    },
  };
  instance.render();
  return instance;
}
