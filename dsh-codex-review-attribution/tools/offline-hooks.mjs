// TEST ONLY. No profile, ASAR, provider, or transport is loaded by these tests.
import { registerHooks } from 'node:module';
const data = source => `data:text/javascript,${encodeURIComponent(source)}`;
const overrides = {
  '@deepseek-ai/dsh-permission-presets': data('export const AUTO_PRESET = "auto";'),
  '@deepseek-ai/dsh-tools': data('export const RUN_CODE_NAME = "run_code";'),
  '@deepseek-ai/dsh-brand': data('export const brandString = value => value;'),
  '@deepseek-ai/dsh-util-crypto': data('export { randomUUID } from "node:crypto";'),
};
registerHooks({ resolve(specifier, context, next) {
  const version = /\/fixtures\/(?:generated-)?current(?:-|\/)/.test(context.parentURL ?? '') ? 'current' : 'target';
  const fixture = specifier === '@deepseek-ai/dsh-llm' ? 'assembler.js' : specifier === '@deepseek-ai/dsh-util-values' ? 'values.js' : undefined;
  if (fixture) return { url: new URL(`./fixtures/${version}/dependencies/${fixture}`, import.meta.url).href, shortCircuit: true };
  if (overrides[specifier]) return { url: overrides[specifier], shortCircuit: true };
  return next(specifier, context);
} });
globalThis.fetch = () => { throw new Error('Network forbidden in offline review tests'); };
