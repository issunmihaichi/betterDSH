/** Repository-only parity checks. Neither standalone plugin test imports its sibling. */
import assert from 'node:assert/strict';
import * as mine from '../dsh-mcp-skills/lib/estimate.js';
import * as panel from '../dsh-context-window/lib/estimate.js';
for (const key of ['CHARS_PER_TOKEN', 'BLOCK_OVERHEAD', 'ROLE_OVERHEAD']) assert.equal(mine[key], panel[key], key);
const samples = {
  estimateText: ['', 'a', 'abcd', 'abcde', '你好世界', 'x'.repeat(101)],
  estimateContent: [[], [{ type: 'text', text: 'hello' }], [{ type: 'reasoning', text: 'why' }], [{ type: 'tool-call', name: 'read', arguments: '{"path":"a"}' }], [{ type: 'unknown-extensible', weird: true }]],
  estimateToolsTokens: [[], [{ name: 'x', description: 'y' }], [{ name: 'mcp__github__issue_write', description: 'w', parameters: { type: 'object', properties: {} } }], [{ name: 'a' }, { name: 'b', description: 'z' }]],
  estimateMessage: [{ role: 'system', content: [{ type: 'text', text: 'prompt' }] }, { role: 'user', content: [{ type: 'text', text: 'hi' }] }, { role: 'tool', content: [{ type: 'tool-result', text: 'ok' }] }, { role: 'assistant', content: [] }],
};
let checked = 3;
for (const [method, values] of Object.entries(samples)) for (const value of values) {
  assert.equal(mine[method](value), panel[method](value), `${method}(${JSON.stringify(value)})`);
  checked++;
}
console.log(`Estimator parity: ${checked} cross-plugin contracts passed (repository-only).`);
