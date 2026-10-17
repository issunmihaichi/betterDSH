/** Each plugin runs from its own directory tree with NO sibling plugin present.
 * Only declared third-party npm dependencies are linked from the local install.
 * Host services and browser APIs are offline fixtures, not the running profile.
 */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isBuiltin } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cases = {
  'dsh-usage-report': [['tools/host-test.mjs'], ['tools/client-test.mjs']],
  'dsh-account-pool': [['tools/host-test.mjs'], ['tools/client-test.mjs']],
  'dsh-context-window': [['tools/host-test.mjs'], ['tools/route-test.mjs'], ['tools/client-test.mjs']],
  'dsh-github': [['tools/host-test.mjs'], ['tools/lifecycle-test.mjs'], ['tools/client-test.mjs']],
  'dsh-mcp-skills': [['tools/host-test.mjs'], ['tools/client-test.mjs']],
  'dsh-installer': [['tools/host-test.mjs'], ['tools/client-test.mjs']],
  'dsh-codex-review-attribution': [['--test', 'tools/mock-test.mjs', 'tools/reviewer-model-test.mjs']],
};
const names = process.argv.slice(2);
for (const name of names) assert.ok(Object.hasOwn(cases, name), `Unknown plugin: ${name}`);
const selected = names.length ? [...new Set(names)] : Object.keys(cases);
const coreServices = new Set(['connection', 'storageDomain', 'llm', 'timer', 'credentials', 'attachments', 'sessions', 'sessionProjections', 'sessionQuery', 'webServer', 'pluginManager', 'approval', 'permissionPresets', 'tools']);
const scratch = mkdtempSync(join(tmpdir(), 'betterdsh-standalone-'));
let failed = 0;
function run(args, cwd) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit', timeout: 120_000 });
  if (result.error) console.error(result.error.message);
  assert.equal(result.status, 0, `Standalone command failed: ${basename(cwd)} ${args.join(' ')}`);
}
function exportPath(value) {
  return typeof value === 'string' ? value : value?.default;
}
try {
  for (const name of selected) {
    console.log(`\n=== standalone: ${name} (all sibling plugins absent) ===`);
    try {
      const source = join(root, name);
      const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
      // Separate parent trees matter: even a relative ../../other-plugin import
      // must fail rather than resolving another fixture copied earlier.
      const target = join(scratch, name, name);
      mkdirSync(target, { recursive: true });
      for (const entry of ['package.json', ...manifest.files, 'tools']) {
        assert.ok(!isAbsolute(entry) && !entry.split(/[\\/]/).includes('..'), 'Package files must stay local');
        cpSync(join(source, entry), join(target, entry), { recursive: true });
      }
      const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies };
      for (const dependency of Object.keys(dependencies)) {
        assert.ok(!Object.hasOwn(cases, dependency), `${name} must not require a sibling plugin`);
        const installed = join(source, 'node_modules', dependency);
        assert.ok(existsSync(installed), `Install declared npm dependency first: ${name}: ${dependency}`);
        const link = join(target, 'node_modules', dependency);
        mkdirSync(dirname(link), { recursive: true });
        symlinkSync(realpathSync(installed), link, process.platform === 'win32' ? 'junction' : 'dir');
      }
      for (const dependency of manifest.dsh?.client?.inject ?? []) {
        assert.ok(dependency.startsWith('@deepseek-ai/'), `${name}: unexpected non-core client prerequisite ${dependency}`);
      }
      // Audit reachable runtime imports: every local module must ship inside this
      // isolated package, every bare module must be builtin or declared npm.
      const visited = new Set();
      function walk(file) {
        file = resolve(file);
        const rel = relative(target, file);
        assert.ok(rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel), `${name}: runtime import escapes package`);
        if (visited.has(file)) return;
        visited.add(file);
        const text = readFileSync(file, 'utf8');
        for (const match of text.matchAll(/(?:^\s*(?:import|export)\s+(?:[^;'"`]*?\bfrom\s*)?|\b(?:import|require)\s*\()\s*['"`]([^'"`]+)['"`]/gm)) {
          const specifier = match[1];
          if (specifier.startsWith('.')) walk(resolve(dirname(file), specifier.split(/[?#]/)[0]));
          else {
            const pkg = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
            // React is injected by the DSH browser shell, never another bundle.
            assert.ok(isBuiltin(specifier) || ['react', 'react-dom'].includes(specifier) || Object.hasOwn(dependencies, pkg), `${name}: undeclared runtime dependency ${specifier}`);
          }
        }
      }
      walk(join(target, manifest.main));
      const client = exportPath(manifest.exports?.['./client']);
      if (client) walk(join(target, client));
      // Import the actual release entry (including the account-pool snapshot),
      // not just the source file its unit tests happen to use.
      run(['--input-type=module', '--eval', `
        import assert from 'node:assert/strict';
        import {pathToFileURL} from 'node:url';
        const module = await import(pathToFileURL(${JSON.stringify(join(target, manifest.main))}));
        const plugin = module.default ?? module;
        assert.equal(typeof plugin.apply, 'function');
        const allowed = new Set(${JSON.stringify([...coreServices])});
        const required = Array.isArray(plugin.inject) ? plugin.inject : plugin.inject?.required ?? [];
        for (const service of required) assert.ok(allowed.has(service), 'Non-core required service: ' + service);
      `], target);
      for (const args of cases[name]) run(args, target);
      console.log(`PASS standalone ${name}: release entry and offline Host/Client fixtures`);
    } catch (error) {
      failed++;
      console.error(error.stack);
    }
  }
} finally {
  // Delete only the exact fresh fixture tree created by this invocation; never
  // resolve an arbitrary user path into a cleanup target.
  assert.equal(dirname(resolve(scratch)), resolve(tmpdir()));
  assert.ok(basename(scratch).startsWith('betterdsh-standalone-'));
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`\nStandalone isolation: ${selected.length - failed}/${selected.length} plugins passed. No live profile or provider requests.`);
process.exitCode = failed ? 1 : 0;
