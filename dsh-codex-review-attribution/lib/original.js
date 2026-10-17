import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { resolveConfig } from './config.js';

export const ORIGINAL_NAME = 'experimental-auto-review';
export const ORIGINAL_INJECT = Object.freeze(['approval', 'llm', 'permissionPresets', 'sessions', 'tools']);
// Whole-module audits; each digest is bound to its exact service contract.
// The official authorization implementation is never copied into this plugin.
export const REVIEWED_VARIANTS = Object.freeze([
  Object.freeze({ version: '0.2.0-rc.2', sha256: '697b168133d5d9a3c2b33380cc407b8e94d9c454791b66d2173049af5e8d0033', inject: ORIGINAL_INJECT }),
  Object.freeze({ version: '0.2.1-rc.2', sha256: '14b0fec944f734a888468b75ee9d7ae121383f018ce5bf76c4506393a910787f', inject: Object.freeze([...ORIGINAL_INJECT, 'workingDirectory']) }),
]);
export const REVIEWED_SHA256 = Object.freeze(REVIEWED_VARIANTS.map(variant => variant.sha256));
const require = createRequire(import.meta.url);
const canonicalSuffix = /(?:^|\/)app\.asar\/dsh\/node_modules\/@deepseek-ai\/dsh-experimental-auto-review\/lib\/index\.js$/;

export function assertOriginalShape(original, moduleSha256) {
  const reviewed = REVIEWED_VARIANTS.find(variant => variant.sha256 === moduleSha256);
  const candidates = reviewed ? [reviewed] : REVIEWED_VARIANTS;
  if (!original || typeof original.apply !== 'function' || original.name !== ORIGINAL_NAME || !Array.isArray(original.inject) || !candidates.some(variant => original.inject.length === variant.inject.length && variant.inject.every((value, index) => original.inject[index] === value))) {
    throw new TypeError('Official auto-review module shape is incompatible; refusing to register Auto');
  }
  return original;
}

export function loadOriginal(input) {
  const { originalModulePath } = resolveConfig(input);
  // Require the canonical host installation, never a workspace copy/npm replica.
  const resolvedPath = realpathSync(require.resolve(originalModulePath));
  if (!canonicalSuffix.test(resolvedPath.replaceAll('\\', '/'))) throw new TypeError('originalModulePath must identify the canonical installed ASAR auto-review module');
  const moduleSha256 = createHash('sha256').update(readFileSync(resolvedPath)).digest('hex');
  const original = assertOriginalShape(require(resolvedPath), moduleSha256);
  if (createHash('sha256').update(readFileSync(resolvedPath)).digest('hex') !== moduleSha256) throw new Error('Official module changed while loading; refusing to register Auto');
  return { original, moduleSha256, compatible: REVIEWED_SHA256.includes(moduleSha256) };
}

/** Read-only deployment check. A failed check never authorizes disabling the official entry. */
export function preflight(input, { disableOriginal = false, companionEnabled = false } = {}) {
  const loaded = loadOriginal(input);
  const canDisableOriginal = companionEnabled === true && input?.disabled !== true && loaded.compatible;
  if (disableOriginal && !canDisableOriginal) throw new Error('Preflight refused to disable the official entry: an enabled compatible companion is required');
  return Object.freeze({ version: 1, compatible: loaded.compatible, moduleSha256: loaded.moduleSha256,
    status: loaded.compatible ? 'compatible' : 'disabled-incompatible', canDisableOriginal });
}
