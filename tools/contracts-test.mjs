/** Packaging/entry contracts: a test that passes against lib/host.js must not
 * silently publish a stale versioned host. Normalize CRLF for Windows clones.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
const corePlugins = ['dsh-usage-report', 'dsh-account-pool', 'dsh-context-window', 'dsh-github', 'dsh-mcp-skills', 'dsh-installer'];
// Keep the six-bundle default release boundary. The security-sensitive review
// companion is independently packed and opt-in, never silently installed.
const optionalPlugins = process.argv.includes('--review') ? ['dsh-codex-review-attribution'] : [];
const plugins = process.argv.includes('--pool-only') ? ['dsh-account-pool', ...optionalPlugins] : [...corePlugins, ...optionalPlugins];
const normalize = content => content.replace(/\r\n/g, '\n');
function exportPaths(value) {
  if (typeof value === 'string') return value.startsWith('./') ? [value] : [];
  if (value && typeof value === 'object') return Object.values(value).flatMap(exportPaths);
  return [];
}
let inspected = 0;
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
for (const name of plugins) {
  const dir = resolve(root, name);
  const manifest = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'));
  assert.equal(manifest.name, name);
  assert.ok(readme.split('\n').some(line => line.includes(`(${name}/README.md)`) && line.includes(`| ${manifest.version} |`)), `${name}: root README version table is stale`);
  const files = manifest.files ?? [];
  const packaged = path => files.some(item => path === item || path.startsWith(item.replace(/\/$/, '') + '/'));
  const entries = [manifest.main, ...exportPaths(manifest.exports), ...[manifest.dsh?.bundle?.patch].flat()].filter(Boolean).flatMap(entry => {
    if (!entry.includes('*')) return [entry];
    const pattern = new RegExp('^' + entry.replace(/^\.\//, '').split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
    const matched = files.filter(path => pattern.test(path));
    assert.ok(matched.length, `${name}: export pattern has no shipped files: ${entry}`);
    return matched;
  });
  for (const entry of entries) {
    const path = entry.replace(/^\.\//, '');
    assert.ok(existsSync(resolve(dir, path)), `${name}: missing ${path}`);
    assert.ok(path === 'package.json' || packaged(path), `${name}: files list excludes ${path}`);
  }
  const patch = readFileSync(resolve(dir, manifest.dsh.bundle.patch), 'utf8');
  assert.ok(!/^\s+name:\s+(?:[A-Za-z]:[/\\]|\/)/m.test(patch), `${name}: nonportable absolute loader entry`);
  if (name === 'dsh-github') {
    assert.ok(/- id: github-mcp\s+name: ['"]?@deepseek-ai\/dsh-mcp-client['"]?\s+disabled: true/.test(patch), 'GitHub bundle must keep its default-disabled MCP bridge');
    assert.ok(!/Authorization|github_pat_|ghp_/.test(patch), 'GitHub release patch must not include credentials');
  }
  const visited = new Set();
  const walk = path => {
    if (visited.has(path) || !path.endsWith('.js')) return;
    visited.add(path);
    assert.ok(existsSync(path), `${name}: missing imported module ${path}`);
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*['"`](\.[^'"`]+)['"`]/g)) {
      // A version query changes the ESM cache key, not the packaged filename.
      const specifier = match[1].split(/[?#]/)[0];
      assert.ok(!specifier.includes('${'), `${name}: unresolved relative import ${match[1]}`);
      const target = resolve(dirname(path), specifier);
      const rel = relative(dir, target).split(sep).join('/');
      assert.ok(!rel.startsWith('..') && packaged(rel), `${name}: unshipped relative import ${rel}`);
      walk(target);
    }
  };
  walk(resolve(dir, manifest.main));
  const client = exportPaths(manifest.exports?.['./client'])[0];
  if (client) walk(resolve(dir, client));
  inspected += visited.size;
}
const lib = resolve(root, 'dsh-account-pool/lib');
const poolManifest = JSON.parse(readFileSync(resolve(lib, '../package.json'), 'utf8'));
const snapshotDir = dirname(resolve(lib, '..', poolManifest.main));
assert.match(relative(lib, snapshotDir), /^runtime-v[^/\\]+$/, 'Account-pool main must point at an immutable runtime');
const snapshot = JSON.parse(readFileSync(resolve(snapshotDir, 'snapshot.json'), 'utf8'));
for (const [path, expected] of Object.entries(snapshot.files)) {
  const source = normalize(readFileSync(resolve(lib, path), 'utf8'));
  const shipped = normalize(readFileSync(resolve(snapshotDir, path), 'utf8'));
  assert.equal(shipped, source, `Published account-pool snapshot is stale: ${path}`);
  assert.equal(createHash('sha256').update(shipped).digest('hex'), expected, `Snapshot digest is stale: ${path}`);
}
console.log(`Contracts passed: ${plugins.length} selected portable bundles, ${inspected} reachable JS modules, account-pool source/snapshot parity.`);
