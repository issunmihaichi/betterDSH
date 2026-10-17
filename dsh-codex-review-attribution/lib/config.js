import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { currentSelection } from './reviewer-model.js';

export function validateConfig(input = {}) {
  const issues = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { issues: [{ message: 'Configuration must be an object' }] };
  const originalModulePath = input.originalModulePath ?? '';
  if (typeof originalModulePath !== 'string' || (originalModulePath !== '' && !path.isAbsolute(originalModulePath))) issues.push({ message: 'originalModulePath must be an absolute installed-module path', path: ['originalModulePath'] });
  if (Object.hasOwn(input, 'disabled') && typeof input.disabled !== 'boolean') issues.push({ message: 'disabled must be boolean', path: ['disabled'] });
  try { currentSelection(input); } catch (error) { issues.push({ message: error.message, path: ['reviewerModel'] }); }
  return issues.length ? { issues } : { value: { ...input, originalModulePath } };
}

// Only reviewer selection is volatile: official gate/ALS lifetime remains untouched on save.
export const Config = z.object({
  originalModulePath: z.string().pattern(/^(?:[A-Za-z]:[\\/]|\/|$)/).default(''),
  disabled: z.boolean(),
  reviewerModel: z.union([
    z.object({ mode: z.const('session').required() }),
    z.object({ mode: z.const('fixed').required(), provider: z.string().min(1).required(), model: z.string().min(1).required() }),
  ]).default({ mode: 'session' }).volatile(),
});

export function resolveConfig(input) {
  const result = validateConfig(input);
  if (result.issues) throw new TypeError(result.issues.map(issue => issue.message).join('; '));
  if (!result.value.originalModulePath) throw new TypeError('originalModulePath is required before enabling the companion');
  return result.value;
}
