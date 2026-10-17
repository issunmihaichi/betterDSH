import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, inject, Config } from '../lib/host.js';
import { deferred, sessionFixture, decisionStream } from './fixtures.mjs';
import { versions, officialPath, harness, poolServices, fixedSelection, settle } from './offline-fixtures.mjs';

for (const version of versions) {
  const { Context } = await import(`./fixtures/${version}/cordis.js`);
  const setup = async (h, config = {}, { directory = true, management = false } = {}) => {
    const root = new Context(); let route;
    const services = root.plugin({ name: 'offline-services', apply(ctx) {
      for (const key of inject) ctx.provide(key, h.ctx[key]);
      ctx.provide('loader', h.ctx.loader ?? { entries: () => [] });
      if (management) {
        ctx.provide('settings', { describe: () => [{ ns: 'custom-review-entry', revision: 1 }], mutate: async () => {} });
        ctx.provide('connection', { fetch: { register(value) { route = value; return () => { route = undefined; }; } } });
      }
    } });
    await services;
    let directoryFiber;
    const provideDirectory = async () => {
      directoryFiber = root.plugin({ name: `directory-${version}`, apply(ctx) { ctx.provide('workingDirectory', h.ctx.workingDirectory); } });
      await directoryFiber; await settle(root);
      return directoryFiber;
    };
    if (version === 'target' && directory) await provideDirectory();
    const companion = root.plugin({ name: `offline-companion-${version}`, inject, Config, apply(ctx, cfg) {
      ctx.fiber.entry = { options: { id: 'custom-review-entry' } };
      return apply(ctx, cfg);
    } }, { originalModulePath: officialPath(version), ...config });
    await companion; await settle(root);
    return { root, companion, services, provideDirectory, get directoryFiber() { return directoryFiber; }, get route() { return route; }, async dispose() { await companion.dispose(); if (directoryFiber) await directoryFiber.dispose(); await services.dispose(); } };
  };

  test(`${version}: real Cordis fixed reviewer discovers sibling loader and preserves the official request`, async () => {
    const { exec, session } = sessionFixture();
    const h = poolServices(harness(version, { sessions: [session], response: '{"risk":"high","decision":"deny"}' }));
    const c = await setup(h, { reviewerModel: fixedSelection });
    try {
      assert.equal(h.registered, 1);
      assert.equal((await c.root.waterfall('tools/pre-execute', exec, () => { throw new Error('deny must not call downstream'); })).kind, 'deny');
      const request = h.requests[0];
      assert.equal(request.provider, 'pool-test'); assert.equal(request.model, 'review-model');
      assert.equal(request.codexRequestProvenance.ownerSessionId, session.id);
      assert.equal(Object.isFrozen(request), true);
      assert.equal(h.ensures.length, version === 'target' ? 1 : 0);
    } finally { await c.dispose(); }
    assert.equal(h.registered, 0);
  });

  test(`${version}: management inherits the loader entry namespace across dynamic injection`, async () => {
    const h = poolServices(harness(version));
    const c = await setup(h, {}, { management: true });
    try {
      assert.ok(c.route, 'management route must exist on the target child as well as the old host');
      const response = await c.route.fetch(new Request('http://offline/api/autoReview.model'));
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.settingsNs, 'custom-review-entry'); assert.equal(body.available, true);
      assert.equal(body.choices[0].model, 'review-model');
    } finally { await c.dispose(); }
    assert.equal(c.route, undefined);
  });

  test(`${version}: actual native/PTC fixed reviewer lifecycle aborts before drain and removes all gate state`, { timeout: 3000 }, async () => {
    const entered = deferred(); let started = 0;
    const a = sessionFixture({ id: `${version}-A` }), b = sessionFixture({ id: `${version}-B`, mode: 'ptc' });
    const h = poolServices(harness(version, { sessions: [a.session, b.session], stream(options) {
      if (++started === 2) entered.resolve();
      return (async function* () {
        if (!options.signal.aborted) await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'OFFLINE', message: 'lifecycle abort' } } };
      })();
    } }));
    const c = await setup(h, { reviewerModel: fixedSelection });
    const service = c.root.get('codexReviewAttribution');
    const pending = [a, b].map(({ exec }) => c.root.waterfall('tools/pre-execute', exec, () => { throw new Error('must not execute'); }));
    await entered.promise;
    assert.deepEqual(h.requests.map(options => options.codexRequestProvenance.ownerSessionId), [a.session.id, b.session.id]);
    await c.dispose();
    assert.deepEqual(await Promise.all(pending), [{ kind: 'cancel' }, { kind: 'cancel' }]);
    assert.equal(service.snapshot().status, 'disposed');
    assert.equal(c.root.get('codexReviewAttribution'), undefined); assert.equal(h.registered, 0);
    assert.equal(a.session.preset, 'danger-full-access'); assert.equal(b.session.preset, 'danger-full-access');
    const sentinel = { kind: 'allow' };
    assert.equal(c.root.waterfall('tools/pre-execute', a.exec, () => sentinel), sentinel);
  });

  test(`${version}: disposal interrupts fixed-model discovery even if the catalog never resolves`, { timeout: 3000 }, async () => {
    const entered = deferred(), unresolved = deferred();
    const { exec, session } = sessionFixture();
    const h = poolServices(harness(version, { sessions: [session] }));
    h.ctx.llm.listModels = () => { entered.resolve(); return unresolved.promise; };
    const c = await setup(h, { reviewerModel: fixedSelection });
    const pending = c.root.waterfall('tools/pre-execute', exec, () => { throw new Error('must not execute'); });
    await entered.promise;
    await c.dispose();
    assert.deepEqual(await pending, { kind: 'cancel' });
    assert.equal(h.requests.length, 0); assert.equal(h.registered, 0);
    unresolved.resolve([]);
  });

  test(`${version}: disposal during downstream waiting returns official cancel instead of the late allow`, { timeout: 3000 }, async () => {
    const entered = deferred(), released = deferred();
    const { exec, session } = sessionFixture();
    const h = poolServices(harness(version, { sessions: [session] }));
    const c = await setup(h, { reviewerModel: fixedSelection });
    const pending = c.root.waterfall('tools/pre-execute', exec, async () => { entered.resolve(); await released.promise; return { kind: 'allow' }; });
    await entered.promise;
    assert.equal(h.requests.length, 1);
    const signal = h.requests[0].signal;
    const aborted = new Promise(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true }));
    const closing = c.dispose();
    // Drain waits for downstream, but the official lifecycle abort comes first.
    await aborted;
    released.resolve(); await closing;
    assert.deepEqual(await pending, { kind: 'cancel' }); assert.equal(h.registered, 0);
  });

  if (version === 'target') {
    test('target: no directory service means no advertised Auto; arrival loads, loss aborts, replacement reloads', { timeout: 3000 }, async () => {
      const entered = deferred();
      const { session, exec } = sessionFixture();
      const h = harness(version, { sessions: [session] });
      h.ctx.workingDirectory.ensure = (agent, signal) => {
        h.ensures.push({ agent, signal }); entered.resolve();
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      };
      const c = await setup(h, {}, { directory: false, management: true });
      try {
        assert.equal(h.registered, 0); assert.equal(c.root.get('codexReviewAttribution'), undefined); assert.equal(c.route, undefined);
        await c.provideDirectory(); assert.equal(h.registered, 1); assert.ok(c.route);
        const service = c.root.get('codexReviewAttribution');
        const pending = c.root.waterfall('tools/pre-execute', exec, () => { throw new Error('must not execute'); });
        await entered.promise;
        await c.directoryFiber.dispose(); await settle(c.root);
        assert.deepEqual(await pending, { kind: 'cancel' });
        assert.equal(h.ensures[0].signal.aborted, true); assert.equal(h.requests.length, 0);
        assert.equal(h.registered, 0); assert.equal(service.snapshot().status, 'disposed'); assert.equal(c.route, undefined);
        assert.equal(c.root.get('codexReviewAttribution'), undefined);
        h.ctx.workingDirectory = { ensure: async () => 'D:\\new-directory' };
        await c.provideDirectory(); assert.equal(h.registered, 1);
        session.preset = 'auto';
        assert.equal((await c.root.waterfall('tools/pre-execute', exec, () => ({ kind: 'allow' }))).kind, 'allow');
        assert.match(h.requests[0].messages[0].content[0].text, /new-directory/);
      } finally { await c.dispose(); }
    });
  }
}
