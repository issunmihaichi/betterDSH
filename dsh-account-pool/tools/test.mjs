import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const scopes = {
  'local-tauri': [['--test', 'tools/local-api-tauri-test.mjs']],
  'local-api': [['--test', 'tools/local-api-test.mjs', 'tools/local-api-tauri-test.mjs', 'tools/local-api-controller-test.mjs', 'tools/local-api-host-test.mjs', 'tools/local-api-responses-request-test.mjs', 'tools/local-api-responses-output-test.mjs', 'tools/local-api-responses-http-test.mjs'], ['tools/local-api-client-test.mjs']],
  'local-responses': [['--test', 'tools/local-api-responses-request-test.mjs', 'tools/local-api-responses-output-test.mjs', 'tools/local-api-responses-http-test.mjs']],
  'codex-speed': [['--test', 'tools/codex-speed-test.mjs']],
  retry: [['--test', 'tools/retry-test.mjs']],
  detection: [['tools/detection-test.mjs', '--quick']],
  client: [['tools/client-test.mjs']],
  timing: [['--test', 'tools/usage-timing-test.mjs', 'tools/usage-timing-client-test.mjs']],
  host: [['tools/host-test.mjs']],
  domain: [['tools/domain-test.mjs']],
  routing: [['tools/kernel-test.mjs'], ['tools/prepared-call-test.mjs'], ['tools/usage-effort-test.mjs']],
  'usage-effort': [['tools/usage-effort-test.mjs'], ['tools/host-test.mjs', '--name=usage effort'], ['tools/client-test.mjs']],
  upstream: [['tools/upstream-test.mjs']],
  supplier: [['tools/supplier-test.mjs']],
  quota: [['tools/quota-test.mjs']],
  'reset-credits': [['tools/reset-credits-test.mjs']],
  oauth: [['tools/oauth-test.mjs']],
  importer: [['tools/importer-test.mjs'], ['tools/host-test.mjs', '--import-only']],
  codex: [['--test', 'tools/codex-test.mjs', 'tools/codex-continuity-test.mjs', 'tools/codex-attribution-test.mjs']],
  attribution: [['--test', 'tools/codex-attribution-test.mjs'], ['tools/host-test.mjs', '--name=Codex']],
  'codex-ws': [['--test', 'tools/codex-websocket-test.mjs', 'tools/codex-websocket-integration-test.mjs']],
  'model-probe': [['--test', 'tools/model-probe-test.mjs'], ['tools/client-test.mjs']],
  continuity: [['--test', 'tools/codex-continuity-test.mjs']],
  'codex-compaction': [['--test', 'tools/codex-compaction-test.mjs', 'tools/codex-compaction-host-test.mjs']],
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
