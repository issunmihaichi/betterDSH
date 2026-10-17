import { preflight } from '../lib/host.js';

const args = process.argv.slice(2);
const modulePath = args.find(value => !value.startsWith('--'));
if (!modulePath) {
  console.error('Usage: ELECTRON_RUN_AS_NODE=1 <host-exe> tools/preflight.mjs <absolute-original-module-path> [--companion-enabled --disable-original]');
  process.exitCode = 2;
} else {
  try {
    console.log(JSON.stringify(preflight({ originalModulePath: modulePath }, {
      disableOriginal: args.includes('--disable-original'),
      companionEnabled: args.includes('--companion-enabled'),
    }), null, 2));
  } catch (error) {
    console.error(`Preflight failed; do NOT disable the official entry: ${error.message}`);
    process.exitCode = 1;
  }
}
