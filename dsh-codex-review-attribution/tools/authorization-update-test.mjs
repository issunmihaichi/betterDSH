import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { apply } from '../lib/host.js';
import { loadOriginal, assertOriginalShape, REVIEWED_VARIANTS } from '../lib/original.js';
import { installOriginal } from '../lib/installation.js';
import { sessionFixture, decisionStream, deferred } from './fixtures.mjs';
import { versions, hashes, officialPath, derivedOfficial, harness, poolServices, fixedSelection } from './offline-fixtures.mjs';

for (const version of versions) {
  const config = { originalModulePath: officialPath(version) };
  test(`${version}: unmodified real official fixture matches the independently recorded audited digest and shape`, () => {
    assert.equal(createHash('sha256').update(readFileSync(config.originalModulePath)).digest('hex'), hashes[version]);
    const loaded = loadOriginal(config);
    assert.equal(loaded.compatible, true);
    assert.deepEqual(loaded.original.inject, version === 'target' ? ['approval', 'llm', 'permissionPresets', 'sessions', 'tools', 'workingDirectory'] : ['approval', 'llm', 'permissionPresets', 'sessions', 'tools']);
    const other = REVIEWED_VARIANTS.find(row => row.sha256 !== hashes[version]);
    assert.throws(() => assertOriginalShape(loaded.original, other.sha256), /shape is incompatible/, 'known digest cannot be paired with the other contract');
  });

  const cases = [
    { label: 'low allow / never', response: '{"risk":"low","decision":"allow"}', result: 'allow', next: 1 },
    { label: 'medium allow / ask', response: '{"risk":"medium","decision":"allow"}', approval: 'ask', result: 'allow', next: 1 },
    { label: 'medium denial / never', response: '{"risk":"medium","decision":"deny","reason":"No authorization"}', result: 'deny', next: 0, code: true },
    { label: 'high denial / never', response: '{"risk":"high","decision":"deny"}', result: 'deny', next: 0, code: true },
    { label: 'denial / ask yields localized ask', response: '{"risk":"medium","decision":"deny","reason":"No authorization"}', approval: 'ask', result: 'ask', next: 1 },
    { label: 'high denial / ask retains official ask behavior', response: '{"risk":"high","decision":"deny"}', approval: 'ask', result: 'ask', next: 1 },
    { label: 'allow retains downstream deny', response: '{"risk":"low","decision":"allow"}', downstream: 'deny', result: 'deny', next: 1 },
    { label: 'denial / ask retains downstream cancel', response: '{"risk":"high","decision":"deny"}', approval: 'ask', downstream: 'cancel', result: 'cancel', next: 1 },
    { label: 'malformed JSON', response: 'not-json', result: 'deny', next: 0 },
    { label: 'high cannot allow', response: '{"risk":"high","decision":"allow"}', result: 'deny', next: 0 },
    { label: 'low cannot deny', response: '{"risk":"low","decision":"deny"}', result: 'deny', next: 0 },
    { label: 'allow cannot explain', response: '{"risk":"medium","decision":"allow","reason":"yes"}', result: 'deny', next: 0 },
    { label: 'duplicate JSON members', response: '{"risk":"high","risk":"low","decision":"allow"}', result: 'deny', next: 0 },
    { label: 'stream provider error', stream: () => decisionStream(undefined, { error: new Error('offline provider failed') }), result: 'deny', next: 0 },
    { label: 'terminal error', stream: () => decisionStream('{"risk":"low","decision":"allow"}', { finish: { kind: 'error', failure: { code: 'OFFLINE', message: 'failure' } } }), result: 'deny', next: 0 },
    { label: 'terminal abort', stream: () => decisionStream('{"risk":"low","decision":"allow"}', { finish: { kind: 'aborted', failure: { code: 'OFFLINE', message: 'abort' } } }), result: 'deny', next: 0 },
    { label: 'missing finish', stream: () => (async function* () { yield { type: 'text-delta', index: 0, text: '{"risk":"low","decision":"allow"}' }; })(), result: 'deny', next: 0 },
    { label: 'post-terminal data', stream: () => (async function* () { yield* decisionStream('{"risk":"low","decision":"allow"}'); yield { type: 'text-delta', index: 2, text: 'more' }; })(), result: 'deny', next: 0 },
    { label: 'incomplete request header', valid: false, result: 'deny', next: 0 },
  ];
  for (const mode of ['native', 'ptc']) for (const row of cases) test(`${version}/${mode}: actual official and augmented gates agree: ${row.label}`, async () => {
    const fixture = sessionFixture({ mode, valid: row.valid ?? true });
    const invoke = async wrapped => {
      const h = harness(version, { sessions: [fixture.session], response: row.response, approval: row.approval, stream: row.stream });
      if (wrapped) apply(h.ctx, config); else loadOriginal(config).original.apply(h.ctx);
      let calls = 0;
      try {
        const result = await h.handler(fixture.exec, () => { calls++; return { kind: row.downstream ?? 'allow' }; });
        assert.equal(result.kind, row.result); assert.equal(calls, row.next);
        if (row.code) assert.equal(result.info.code, 'AUTO_REVIEW_DENIED');
        if (row.result === 'ask') assert.ok(result.displayReason.zh);
        if (calls === 0 && !row.code) assert.match(result.reason, /failed; its body was not executed/);
        return { result, calls, requests: h.requests.map(({ signal, codexRequestProvenance, ...rest }) => rest) };
      } finally { await h.dispose(); fixture.session.preset = 'auto'; }
    };
    assert.deepEqual(await invoke(true), await invoke(false), 'augmentation cannot change the official gate result, prompt, route or downstream decisions');
  });

  test(`${version}: unknown hash runs the real official deny gate without attribution or invented authorization`, async () => {
    const h = harness(version, { response: '{"risk":"high","decision":"deny"}' });
    apply(h.ctx, { originalModulePath: derivedOfficial(version, 'unknown-hash') });
    try {
      assert.equal(h.registered, 1);
      const result = await h.handler(sessionFixture().exec, () => { throw new Error('must not execute'); });
      assert.equal(result.kind, 'deny'); assert.equal(result.info.code, 'AUTO_REVIEW_DENIED');
      assert.equal(h.requests[0].codexRequestProvenance, undefined);
      assert.equal(h.provided.get('codexReviewAttribution').snapshot().status, 'disabled-incompatible');
    } finally { await h.dispose(); }
  });

  test(`${version}: unknown shape refuses before Auto, diagnostics or a hook can be registered`, () => {
    const h = harness(version);
    assert.throws(() => apply(h.ctx, { originalModulePath: derivedOfficial(version, 'unknown-shape') }), /shape is incompatible/);
    assert.equal(h.registered, 0); assert.equal(h.handlers.length, 0); assert.equal(h.provided.size, 0);
  });

  test(`${version}: fixed reviewer is never silently replaced by session route on unaudited source`, async () => {
    const h = poolServices(harness(version));
    try {
      assert.throws(() => apply(h.ctx, { originalModulePath: derivedOfficial(version, 'unknown-hash'), reviewerModel: fixedSelection }), /fixed reviewer|Fixed reviewer/);
      assert.equal(h.registered, 0); assert.equal(h.requests.length, 0);
    } finally { await h.dispose(); }
  });

  test(`${version}: unavailable fixed model, loader or provider errors deny before downstream and never fall back`, async () => {
    for (const failure of ['model', 'loader', 'provider']) {
      const h = poolServices(harness(version));
      if (failure === 'model') h.ctx.llm.listModels = async () => [];
      if (failure === 'loader') h.ctx.loader = undefined;
      if (failure === 'provider') h.ctx.llm.listModels = async () => { throw new Error('offline catalog error'); };
      apply(h.ctx, { ...config, reviewerModel: fixedSelection });
      try {
        const result = await h.handler(sessionFixture().exec, () => { throw new Error('must not execute'); });
        assert.equal(result.kind, 'deny'); assert.match(result.reason, /failed; its body was not executed/);
        assert.equal(h.requests.length, 0);
      } finally { await h.dispose(); }
    }
  });

  test(`${version}: facade failure preserves official session gate but cannot bypass an explicit fixed reviewer`, async () => {
    for (const fixed of [false, true]) {
      const h = harness(version, { response: '{"risk":"high","decision":"deny"}' });
      // Noncritical facade reflection fails; the real official services still work.
      const ctx = new Proxy(h.ctx, {
        ownKeys() { throw new Error('offline reflection failure'); },
        get(target, key) { const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; },
      });
      const loaded = loadOriginal(config);
      try {
        if (fixed) {
          assert.throws(() => installOriginal(ctx, loaded, { reviewerModel: () => fixedSelection }), /fixed reviewer|Fixed reviewer/);
          assert.equal(h.registered, 0);
        } else {
          installOriginal(ctx, loaded);
          assert.equal((await h.handler(sessionFixture().exec, () => { throw new Error('must not execute'); })).kind, 'deny');
          assert.equal(h.requests[0].codexRequestProvenance, undefined);
          assert.equal(h.provided.get('codexReviewAttribution').snapshot().status, 'disabled-missing');
        }
      } finally { await h.dispose(); }
    }
  });

  test(`${version}: actual fixed allow snapshots the live selection per review without changing policy or the chat route`, async () => {
    const { exec, session } = sessionFixture();
    const h = poolServices(harness(version, { sessions: [session] }));
    const reference = harness(version);
    loadOriginal(config).original.apply(reference.ctx);
    let selection = fixedSelection;
    apply(h.ctx, { ...config, reviewerModel: { get: () => selection } });
    const entered = deferred(), released = deferred();
    h.ctx.llm.listModels = async () => { entered.resolve(); await released.promise; return [{ id: 'review-model', name: 'Reviewer' }]; };
    try {
      const first = h.handler(exec, () => ({ kind: 'allow' }));
      await entered.promise;
      selection = { mode: 'session' };
      assert.equal((await h.handler(exec, () => ({ kind: 'allow' }))).kind, 'allow');
      released.resolve(); assert.equal((await first).kind, 'allow');
      assert.equal((await reference.handler(exec, () => ({ kind: 'allow' }))).kind, 'allow');
      const [sessionRequest, fixedRequest] = h.requests;
      assert.equal(sessionRequest.provider, 'mock'); assert.equal(sessionRequest.model, 'mock-model');
      assert.equal(fixedRequest.provider, 'pool-test'); assert.equal(fixedRequest.model, 'review-model');
      assert.deepEqual(fixedRequest.messages, reference.requests[0].messages);
      assert.equal(fixedRequest.system, reference.requests[0].system);
      assert.equal(fixedRequest.temperature, 0); assert.equal(Object.isFrozen(fixedRequest), true);
      assert.equal(Object.isFrozen(fixedRequest.messages), true);
      assert.equal(fixedRequest.codexRequestProvenance.ownerSessionId, session.id);
      assert.notEqual(fixedRequest.codexRequestProvenance.requestId, sessionRequest.codexRequestProvenance.requestId);
      assert.deepEqual(session.requestHeader().config, { provider: 'mock', model: 'mock-model' });
      if (version === 'target') assert.equal(fixedRequest.signal, h.ensures[0].signal);
      assert.equal(h.registered, 1, 'volatile selection never remounts Auto');
    } finally { released.resolve(); await h.dispose(); await reference.dispose(); }
  });

  test(`${version}: unrelated streams and official skip paths never acquire a fixed route or provenance`, async () => {
    const h = poolServices(harness(version)); apply(h.ctx, { ...config, reviewerModel: fixedSelection });
    try {
      for (const kind of ['no-agent', 'not-auto', 'outer-ptc']) {
        const { exec, session } = sessionFixture();
        if (kind === 'no-agent') exec.agent = undefined;
        if (kind === 'not-auto') session.preset = 'workspace-write';
        if (kind === 'outer-ptc') exec.name = 'run_code';
        assert.equal((await h.handler(exec, () => ({ kind: 'allow' }))).kind, 'allow');
      }
      assert.equal(h.requests.length, 0);
      const options = { provider: 'chat', model: 'chat-model' }; h.ctx.llm.stream(options);
      assert.equal(h.requests[0], options);
    } finally { await h.dispose(); }
  });
}

test('canonical path check rejects an arbitrary workspace module before registration', () => {
  const h = harness('current');
  assert.throws(() => apply(h.ctx, { originalModulePath: new URL('../lib/host.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1') }), /canonical installed ASAR/);
  assert.equal(h.registered, 0); assert.equal(h.handlers.length, 0);
});

test('target: missing or malformed workingDirectory refuses installation; no header.cwd fallback', () => {
  for (const value of [undefined, null, {}, { ensure: true }]) {
    const h = harness('target'); h.ctx.workingDirectory = value;
    assert.throws(() => apply(h.ctx, { originalModulePath: officialPath('target') }), /workingDirectory/);
    assert.equal(h.registered, 0); assert.equal(h.handlers.length, 0); assert.equal(h.requests.length, 0);
  }
});

test('target: workingDirectory rejection and abort never dispatch a model or call downstream', async () => {
  for (const kind of ['reject', 'abort']) {
    const h = harness('target'); const { exec } = sessionFixture();
    const entered = deferred(); let received;
    h.ctx.workingDirectory = { ensure(agent, signal) { received = { agent, signal }; entered.resolve(); return kind === 'reject' ? Promise.reject(new Error('directory failed')) : new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } };
    apply(h.ctx, { originalModulePath: officialPath('target') });
    const controller = new AbortController(); exec.signal = controller.signal;
    const pending = h.handler(exec, () => { throw new Error('must not execute'); });
    await entered.promise;
    assert.equal(received.agent, exec.agent); assert.notEqual(received.signal, exec.signal);
    if (kind === 'abort') controller.abort(new Error('execution cancelled'));
    assert.equal((await pending).kind, 'deny'); assert.equal(h.requests.length, 0);
    if (kind === 'abort') assert.equal(received.signal.aborted, true);
    await h.dispose();
  }
});

test('current: no workingDirectory service is read and the original session cwd remains authoritative', async () => {
  const h = harness('current');
  Object.defineProperty(h.ctx, 'workingDirectory', { get() { throw new Error('old host must never access new service'); } });
  apply(h.ctx, { originalModulePath: officialPath('current') });
  try {
    const { exec, session } = sessionFixture();
    assert.equal((await h.handler(exec, () => ({ kind: 'allow' }))).kind, 'allow');
    assert.ok(h.requests[0].messages[0].content[0].text.includes(JSON.stringify(session.header.cwd)));
  } finally { await h.dispose(); }
});
