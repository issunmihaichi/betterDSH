import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { apply } from '../lib/host.js';
import { mockContext, sessionFixture } from './fixtures.mjs';

const officialPath = version => fileURLToPath(new URL(`./fixtures/${version}/app.asar/dsh/node_modules/@deepseek-ai/dsh-experimental-auto-review/lib/index.js`, import.meta.url));

// Agreed seam: actual host apply -> canonical source/shape audit -> actual
// official plugin -> tools/pre-execute, with only external services isolated.
test('0.2.1-rc.2 host loads canonical official gate and forwards workingDirectory.ensure', async () => {
  const { exec, session } = sessionFixture();
  session.header.cwd = undefined; // New host must use the resolved service, not old header facts.
  const h = mockContext({ sessions: [session] });
  const ensures = [];
  const service = { ensure(agent, signal) { assert.equal(this, service); ensures.push({ agent, signal }); return Promise.resolve('D:\\resolved-project'); } };
  h.ctx.workingDirectory = service;
  apply(h.ctx, { originalModulePath: officialPath('target') });
  try {
    assert.equal(h.registered, 1);
    const result = await h.handler(exec, () => ({ kind: 'allow' }));
    assert.equal(result.kind, 'allow');
    assert.equal(ensures.length, 1);
    assert.equal(ensures[0].agent, exec.agent);
    assert.equal(ensures[0].signal.aborted, false);
    assert.equal(ensures[0].signal, h.requests[0].signal, 'the official combined lifecycle/execution signal is forwarded unchanged');
    assert.match(h.requests[0].messages[0].content[0].text, /resolved-project/);
    assert.equal(h.requests[0].codexRequestProvenance.ownerSessionId, session.id);
    assert.equal(h.provided.get('codexReviewAttribution').snapshot().compatible, true);
  } finally { await h.dispose(); }
});
