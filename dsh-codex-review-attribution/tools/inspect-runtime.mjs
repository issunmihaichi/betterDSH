// Read-only host API inspection; no plugin installation or model/tool requests.
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
const root = process.argv[2];
if (!root) throw new Error('Pass the canonical installed ASAR dsh directory');
const require = createRequire(path.join(root, 'package.json'));
for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/cordis-loader', '@deepseek-ai/schemastery']) {
  try { const file = require.resolve(name); console.log('\nPACKAGE', name, file); const source = readFileSync(file,'utf8'); const lines=source.split('\n'); for(let i=0;i<lines.length;i++) if(/provide\(|\.Config|config = .*Config|Config\(/.test(lines[i])) console.log(lines.slice(Math.max(0,i-4), Math.min(lines.length,i+9)).map((line,j)=>`${Math.max(0,i-4)+j+1}: ${line}`).join('\n')); } catch(error) { console.log(name, error.message); }
}
const { Context } = require('@deepseek-ai/cordis');
const ctx = new Context();
console.log('CONTEXT API', { provide: typeof ctx.provide, effect: typeof ctx.effect, set: typeof ctx.set, get: typeof ctx.get, reflectProvide: typeof ctx.reflect?.provide });
console.log('PUBLIC PROVIDE BODY', String(ctx.provide));
console.log('EVENTS WATERFALL BODY', String(ctx.events?.waterfall));
console.log('PUBLIC WATERFALL', typeof ctx.waterfall);
console.log('host cordis names',readdirSync(path.join(root,'node_modules','@deepseek-ai')).filter(name=>/cordis|loader/.test(name)));
