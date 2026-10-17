/** Repository-level offline regression runner. Never touches a live profile. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
const root = fileURLToPath(new URL('../', import.meta.url));
const tasks = {
  usage: { dir: 'dsh-usage-report', runs: [['tools/report-test.mjs', '--synthetic-only'], ['tools/host-test.mjs'], ['tools/client-test.mjs']] },
  account: { dir: 'dsh-account-pool', runs: JSON.parse(readFileSync(new URL('../dsh-account-pool/package.json', import.meta.url), 'utf8')).scripts['test:all'].split(' && ').map(cmd => cmd.split(' ').slice(1)).concat([['--test', 'tools/codex-speed-test.mjs', 'tools/usage-timing-test.mjs'], ['tools/usage-timing-client-test.mjs'], ['--test', 'tools/retry-test.mjs'], ['tools/client-style-test.mjs'], ['--test', 'tools/local-api-test.mjs', 'tools/local-api-tauri-test.mjs', 'tools/local-api-controller-test.mjs', 'tools/local-api-host-test.mjs', 'tools/local-api-responses-request-test.mjs', 'tools/local-api-responses-output-test.mjs', 'tools/local-api-responses-http-test.mjs'], ['tools/local-api-client-test.mjs']]) },
  context: { dir: 'dsh-context-window', runs: [['tools/host-test.mjs'], ['tools/route-test.mjs'], ['tools/client-test.mjs']] },
  github: { dir: 'dsh-github', runs: [['tools/pure-test.mjs'], ['tools/host-test.mjs'], ['tools/lifecycle-test.mjs'], ['tools/client-test.mjs']] },
  mcp: { dir: 'dsh-mcp-skills', runs: [['tools/host-test.mjs'], ['tools/client-test.mjs']] },
  installer: { dir: 'dsh-installer', runs: [['tools/host-test.mjs'], ['tools/client-test.mjs']] },
  review: { dir: 'dsh-codex-review-attribution', runs: [['--test', 'tools/mock-test.mjs', 'tools/reviewer-model-test.mjs']] },
  independence: { dir: '.', runs: [['tools/standalone-test.mjs'], ['tools/estimator-parity-test.mjs']] },
};
const defaultScopes = ['usage', 'account', 'context', 'github', 'mcp', 'installer', 'independence'];
const args = process.argv.slice(2);
const reportFile = args.find(arg => arg.startsWith('--report='))?.slice('--report='.length);
const scopes = args.filter(arg => !arg.startsWith('--report='));
const results = [];
const startedAt = new Date().toISOString();
if (scopes.some(scope => !Object.hasOwn(tasks, scope))) {
  console.error('Unknown scope. Choose: ' + Object.keys(tasks).join(', ')); process.exit(1);
}
let failed = 0;
for (const scope of scopes.length ? [...new Set(scopes)] : defaultScopes) {
  const task = tasks[scope];
  for (const args of task.runs) {
    console.log(`\n=== ${scope}: ${args.join(' ')} ===`);
    const start = Date.now();
    const result = spawnSync(process.execPath, args, { cwd: root + task.dir, stdio: 'inherit' });
    results.push({ scope, command: args.join(' '), status: result.status, passed: !result.error && result.status === 0, durationMs: Date.now() - start, ...(result.error ? { error: result.error.message } : {}) });
    if (result.error) console.error(result.error.message);
    if (result.error || result.status !== 0) failed++;
  }
}
const contracts = spawnSync(process.execPath, ['tools/contracts-test.mjs', ...(scopes.includes('review') ? ['--review'] : [])], { cwd: root, stdio: 'inherit' });
if (contracts.error || contracts.status !== 0) failed++;
results.push({ scope: 'contracts', command: 'tools/contracts-test.mjs', status: contracts.status, passed: !contracts.error && contracts.status === 0 });
if (reportFile) writeFileSync(reportFile, JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), node: process.version, scopes: scopes.length ? scopes : defaultScopes, passedCommands: results.filter(result => result.passed).length, totalCommands: results.length, failedCommands: failed, boundary: 'offline fixtures only; no live/e2e/profile writes', results }, null, 2) + '\n');
console.log(`\nOffline suite: ${results.length - failed}/${results.length} commands passed, ${failed} failed. No live/e2e scripts executed.`);
process.exitCode = failed ? 1 : 0;
