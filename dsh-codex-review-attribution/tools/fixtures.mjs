import assert from 'node:assert/strict';

export function sessionFixture({ id = 'session-A', mode = 'native', preset = 'auto', valid = true } = {}) {
  const args = { path: 'project/file.txt' };
  const rootName = mode === 'ptc' ? 'run_code' : 'read';
  const rootArgs = mode === 'ptc' ? { code: 'await tools.read()' } : args;
  const raw = JSON.stringify(rootArgs);
  const step = { turn: 'turn-1', step: 'step-1' };
  const events = [
    { type: 'user/message', data: { source: { kind: 'user', rpcId: 'rpc-1' }, content: [{ type: 'text', text: 'Read project/file.txt only.' }] } },
    { type: 'turn/start', data: { turn: step.turn } },
    { type: 'step/start', data: step },
    { type: 'assistant/message', data: { ...step, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'root-1', name: rootName, arguments: raw }] } } },
    { type: 'tool/call', data: { ...step, callId: 'root-1', name: rootName, arguments: raw } },
  ].map((event, seq) => ({ ...event, seq }));
  const schema = { name: 'read', description: 'Read a local project file', parameters: { type: 'object', properties: { path: { type: 'string' } } } };
  if (mode === 'ptc') events.push({ seq: events.length, type: 'tool/ptc-dispatch-start', data: { parentCallId: 'root-1', rootCallId: 'root-1', subCallId: 'inner-1', name: 'read', arguments: args } });
  const session = {
    id, preset, header: { origin: 'user', cwd: 'D:\\project' }, surface: { nodes: [0, 3] },
    isOwnSeq: () => true,
    snapshotEvents: () => events,
    requestHeader: () => valid ? { config: { provider: 'mock', model: 'mock-model' }, tools: [schema] } : undefined,
  };
  const exec = { name: 'read', arguments: args, rootCallId: 'root-1', callId: mode === 'ptc' ? 'inner-1' : 'root-1', agent: { session }, signal: new AbortController().signal,
    ...(mode === 'ptc' ? { parent: { callId: 'root-1' }, schema } : {}) };
  return { session, exec, events };
}

export function decisionStream(text, { finish = { kind: 'stop' }, error, reasoning = true } = {}) {
  return (async function* () {
    if (error) throw error;
    if (reasoning) yield { type: 'reasoning-delta', index: 0, text: 'mock reasoning' };
    if (text !== undefined) yield { type: 'text-delta', index: 1, text };
    yield { type: 'finish', reason: finish };
  })();
}

export function mockContext({ response = '{"risk":"low","decision":"allow"}', approval = 'never', sessions = [], stream } = {}) {
  const effects = [], handlers = [], requests = [], provided = new Map();
  let registered = 0;
  const llm = { stream(options) { assert.equal(this, llm); requests.push(options); return stream ? stream(options, requests.length) : decisionStream(response); } };
  const ctx = {
    llm, approval: { overrideOf: () => approval },
    permissionPresets: { current: session => session.preset, set: (session, value) => { session.preset = value; }, registerAuto(callback) { registered += 1; this.registration = callback; return () => { registered -= 1; }; } },
    sessions: { list: () => sessions }, tools: {},
    marker() { assert.equal(this, ctx); return 'bound'; },
    on(event, handler, options) { assert.equal(this, ctx); const entry = { event, handler, options }; handlers.push(entry); return () => { const index = handlers.indexOf(entry); if (index >= 0) handlers.splice(index, 1); }; },
    effect(callback, label) { assert.equal(this, ctx); const value = callback(); const list = []; if (value?.next) { for (const disposer of value) list.push(disposer); } else if (typeof value === 'function') list.push(value); effects.push({ label, list }); return () => Promise.all(list.slice().reverse().map(disposer => disposer())); },
    provide(key, value) { assert.equal(this, ctx); provided.set(key, value); return () => provided.delete(key); },
    get(key) { assert.equal(this, ctx); return provided.get(key) ?? ctx[key]; },
  };
  return { ctx, requests, handlers, provided, get registered() { return registered; },
    get handler() { return handlers.find(entry => entry.event === 'tools/pre-execute')?.handler; },
    async dispose() { for (const effect of effects.slice().reverse()) for (const disposer of effect.list.slice().reverse()) await disposer(); },
  };
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
