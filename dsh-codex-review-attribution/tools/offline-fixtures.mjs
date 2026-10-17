import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mockContext } from './fixtures.mjs';
export const versions = ['current', 'target'];
export const hashes = { current: '697b168133d5d9a3c2b33380cc407b8e94d9c454791b66d2173049af5e8d0033', target: '14b0fec944f734a888468b75ee9d7ae121383f018ce5bf76c4506393a910787f' };
export const officialPath = version => fileURLToPath(new URL(`./fixtures/${version}/app.asar/dsh/node_modules/@deepseek-ai/dsh-experimental-auto-review/lib/index.js`, import.meta.url));
export function derivedOfficial(version, kind) {
  const destination = officialPath(`generated-${version}-${kind}`);
  assert.ok(destination.startsWith(fileURLToPath(new URL('./fixtures/', import.meta.url))));
  mkdirSync(path.dirname(destination), { recursive: true });
  const source = readFileSync(officialPath(version), 'utf8');
  // Exercise the actual authorization code, not a fake replacement gate.
  const transformed = kind === 'unknown-hash' ? `${source}\n// Test-only unaudited source change.\n` : source.replace('"tools"', '"unexpected-service"');
  assert.notEqual(transformed, source);
  writeFileSync(destination, transformed);
  return destination;
}
export function harness(version, options = {}) {
  const h = mockContext(options);
  h.ensures = [];
  if (version === 'target') {
    const directory = { ensure(agent, signal) { assert.equal(this, directory); h.ensures.push({ agent, signal }); signal.throwIfAborted(); return Promise.resolve('D:\\resolved-project'); } };
    h.ctx.workingDirectory = directory;
  }
  return h;
}
export function poolServices(h) {
  h.ctx.llm.listProviders = () => [{ id: 'pool-test' }, { id: 'not-pool' }];
  h.ctx.llm.listConfigurableProviders = () => [{ provider: 'pool-test', displayName: 'Pool', settingsNs: 'custom-pool' }];
  h.ctx.llm.listModels = async () => [{ id: 'review-model', name: 'Reviewer' }];
  h.ctx.loader = { entries: () => [{ options: { name: 'dsh-account-pool', id: 'custom-pool' }, fiber: {} }] };
  return h;
}
export const fixedSelection = { mode: 'fixed', provider: 'pool-test', model: 'review-model' };
export async function settle(root) {
  for (const runtime of root.registry.values()) for (const fiber of runtime.fibers) await fiber.await();
}
