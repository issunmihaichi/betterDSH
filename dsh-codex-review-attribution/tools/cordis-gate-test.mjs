import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { apply, Config, inject } from '../lib/host.js';
import { mockContext, sessionFixture, deferred } from './fixtures.mjs';

if (!process.versions.electron) throw new Error('Use ELECTRON_RUN_AS_NODE=1 with installed DeepSeek Harness.exe');
const rootPath = path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'dsh');
const require = createRequire(path.join(rootPath, 'package.json'));
const { Context } = require('@deepseek-ai/cordis');
const { AUTO_PRESET } = require('@deepseek-ai/dsh-permission-presets');
const config = { originalModulePath: require.resolve('@deepseek-ai/dsh-experimental-auto-review') };

test('real Cordis full companion apply on mock services aborts native/PTC before drain', { timeout: 3000 }, async () => {
  const root = new Context(); const entered = deferred(); let starts = 0;
  const a = sessionFixture({ id: 'real-fiber-A', mode: 'native', preset: AUTO_PRESET }), b = sessionFixture({ id: 'real-fiber-B', mode: 'ptc', preset: AUTO_PRESET });
  const h = mockContext({ sessions: [a.session, b.session], stream(options) {
    if (++starts === 2) entered.resolve();
    return (async function* () {
      if (!options.signal.aborted) await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'MOCK', message: 'mock lifecycle abort' } } };
    })();
  } });
  const services = root.plugin({ name: 'only-mock-services', apply(ctx) { for (const key of inject) ctx.provide(key, h.ctx[key]); } }); await services;
  const companion = root.plugin({ name: 'test-companion', inject, Config, apply }, config); await companion;
  assert.equal(h.registered, 1);
  const service = root.get('codexReviewAttribution'); assert.ok(service);
  const pending = [root.waterfall('tools/pre-execute', a.exec, () => { throw new Error('must not execute'); }), root.waterfall('tools/pre-execute', b.exec, () => { throw new Error('must not execute'); })];
  await entered.promise;
  assert.deepEqual(h.requests.map(options => options.codexRequestProvenance.ownerSessionId), ['real-fiber-A', 'real-fiber-B']);
  await companion.dispose();
  assert.deepEqual(await Promise.all(pending), [{ kind: 'cancel' }, { kind: 'cancel' }]);
  assert.equal(h.registered, 0); assert.equal(root.get('codexReviewAttribution'), undefined);
  assert.equal(service.snapshot().status, 'disposed');
  assert.equal(a.session.preset, 'danger-full-access'); assert.equal(b.session.preset, 'danger-full-access');
  const sentinel = { kind: 'allow' }; assert.equal(root.waterfall('tools/pre-execute', a.exec, () => sentinel), sentinel, 'original handler removed');
  await services.dispose();
});

test('real Cordis fixed reviewer reads sibling loader via public get without expanding official inject', async () => {
  const root = new Context(); const { exec, session } = sessionFixture({ preset: AUTO_PRESET });
  const h = mockContext({ response: '{"risk":"high","decision":"deny"}', sessions: [session] });
  h.ctx.llm.listProviders = () => [{ id: 'pool-test' }];
  h.ctx.llm.listConfigurableProviders = () => [{ provider: 'pool-test', displayName: 'test', settingsNs: 'custom-pool' }];
  h.ctx.llm.listModels = async () => [{ id: 'review-model', name: 'Reviewer' }];
  const services = root.plugin({ name: 'mock-route-services', apply(ctx) {
    for (const key of inject) ctx.provide(key, h.ctx[key]);
    ctx.provide('loader', { entries: () => [{ options: { name: 'dsh-account-pool', id: 'custom-pool' }, fiber: {} }] });
  } });
  await services;
  const companion = root.plugin({ name: 'test-fixed-companion', inject, Config, apply }, { ...config, reviewerModel: { mode: 'fixed', provider: 'pool-test', model: 'review-model' } });
  await companion;
  const result = await root.waterfall('tools/pre-execute', exec, () => { throw new Error('must not execute'); });
  assert.equal(result.kind, 'deny'); assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].provider, 'pool-test'); assert.equal(h.requests[0].model, 'review-model');
  assert.deepEqual(inject, ['approval', 'llm', 'permissionPresets', 'sessions', 'tools']);
  await companion.dispose(); await services.dispose();
});
