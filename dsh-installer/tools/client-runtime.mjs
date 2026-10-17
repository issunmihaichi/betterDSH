// Small deterministic hook/event harness. No DOM or live service access.
export function runtime() {
  const values = []; const effects = []; const timers = new Map();
  let cursor = 0; let component; let tree; let mounted = false; let nextTimer = 0; let stateWrites = 0;
  const pendingEffects = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) { const slot = cursor++; if (!(slot in values)) values[slot] = typeof initial === 'function' ? initial() : initial; return [values[slot], next => { stateWrites++; values[slot] = typeof next === 'function' ? next(values[slot]) : next; }]; },
    useRef(initial) { const slot = cursor++; return values[slot] ??= { current: initial }; },
    useEffect(effect, deps) { const slot = cursor++; const previous = effects[slot]; if (!previous || deps.some((value, index) => value !== previous.deps[index])) { pendingEffects.push(() => { previous?.cleanup?.(); effects[slot] = { deps, cleanup: effect() }; }); } },
  };
  function render() { if (!mounted) return tree; cursor = 0; tree = component(); for (const effect of pendingEffects.splice(0)) effect(); return tree; }
  return { React,
    mount(fn) { component = fn; mounted = true; return render(); }, render,
    unmount() { mounted = false; for (const effect of effects) effect?.cleanup?.(); },
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    runTimer() { const entry = timers.entries().next().value; if (!entry) throw Error('No scheduled timer'); timers.delete(entry[0]); return entry[1](); },
    get timerCount() { return timers.size; }, get tree() { return tree; }, get stateWrites() { return stateWrites; },
  };
}
export function flatten(tree, nodes = []) { if (Array.isArray(tree)) { tree.forEach(child => flatten(child, nodes)); return nodes; } if (!tree || typeof tree !== 'object') return nodes; if (tree.type) nodes.push(tree); flatten(tree.children, nodes); return nodes; }
export function text(tree) { if (Array.isArray(tree)) return tree.map(text).join(''); return tree && typeof tree === 'object' ? text(tree.children) : tree == null ? '' : String(tree); }
export const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
export function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; }
