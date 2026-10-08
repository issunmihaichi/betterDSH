import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const scopes = {
  retry: [['--test', 'tools/retry-test.mjs']],
  detection: [['tools/detection-test.mjs', '--quick']],
  client: [['tools/client-test.mjs']],
  host: [['tools/host-test.mjs']],
  domain: [['tools/domain-test.mjs']],
  routing: [['tools/kernel-test.mjs'], ['tools/prepared-call-test.mjs']],
  upstream: [['tools/upstream-test.mjs']],
  supplier: [['tools/supplier-test.mjs']],
  quota: [['tools/quota-test.mjs']],
  'reset-credits': [['tools/reset-credits-test.mjs']],
  oauth: [['tools/oauth-test.mjs']],
  importer: [['tools/importer-test.mjs'], ['tools/host-test.mjs', '--import-only']],
  codex: [['--test', 'tools/codex-test.mjs']],
  gemini: [['--test', 'tools/gemini-test.mjs']],
};
const selected = process.argv.slice(2);
if (selected.length === 0) {
  console.log('未运行测试。请按改动选择功能，例如 pnpm test detection 或 pnpm test client。');
  console.log('可选功能：' + Object.keys(scopes).join(', '));
  console.log('远端用量：pnpm test:quota；重置卡：pnpm test:reset-credits。');
  console.log('检测重试：pnpm test:detection；完整回归：pnpm test:all。');
} else {
  for (const scope of selected) {
    if (!Object.hasOwn(scopes, scope)) {
      console.error('未知测试功能：' + scope);
      process.exit(1);
    }
  }
  for (const scope of new Set(selected)) {
    for (const args of scopes[scope]) {
      const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
      if (result.error) { console.error(result.error.message); process.exit(1); }
      if (result.status !== 0) process.exit(result.status ?? 1);
    }
  }
}
