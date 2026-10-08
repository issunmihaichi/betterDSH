import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const plugin = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = process.argv[2] ?? '0.4.8';
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9-]+)?$/.test(version)) throw new Error('Invalid runtime snapshot version');
const source = path.join(plugin, 'lib');
const target = path.join(source, `runtime-v${version}`);
const files = [
  'adapter.js','detection.js','domain.js','group-models.js','host.js','importer.js','kernel.js','oauth.js','quota.js','reset-credits.js','retry.js','supplier.js','upstream.js',
  'claude-code/betas.js','claude-code/billing.js','claude-code/constants.js','claude-code/defaults.js','claude-code/hash.js','claude-code/headers.js','claude-code/identity.js','claude-code/index.js','claude-code/metadata.js','claude-code/model.js','claude-code/system.js','claude-code/version.js',
  'native/codex.js','native/gemini.js','native/openai-responses.js','native/openai-responses-websocket.js','oauth/callback.js','oauth/engine.js','oauth/pkce.js','oauth/providers.js','oauth/refresh.js',
];
const manifest = { version, source: '../', files: {} };
for (const relative of files) {
  const bytes = fs.readFileSync(path.join(source, relative));
  const output = path.join(target, relative);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  if (fs.existsSync(output)) {
    if (!fs.readFileSync(output).equals(bytes)) throw new Error(`Runtime snapshot already exists with different content: ${relative}`);
  } else fs.writeFileSync(output, bytes, { flag: 'wx' });
  manifest.files[relative] = createHash('sha256').update(bytes).digest('hex');
}
const manifestPath = path.join(target, 'snapshot.json');
if (!fs.existsSync(manifestPath)) fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
console.log(`Prepared ${files.length} source-identical backend modules: lib/runtime-v${version}/host.js`);
