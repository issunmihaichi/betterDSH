// Live verification for the context-window panel: loads the authenticated GUI in
// a headless Chrome over CDP, checks the occupancy ring is still the trigger and
// the shipped meter is gone, then captures four states:
//
//   01-ring            the trigger, unchanged
//   02-popover         the popover it opens (compact)
//   03-rows            the bucket rows, from the live Host classification
//   04-mcp-expanded    the MCP row's per-tool list
//   05-skills-expanded the skill row, rendered from a real catalog payload
//
// The first four read the live Host route. The fifth stubs only the `skills`
// block (real numbers from a session that had a skill catalog) because a session
// that started before the skill provider was enabled has no catalog of its own.
// usage: node tools/verify-live.mjs <authenticatedUrl> [outPrefix]
import fs from 'node:fs';

const url = process.argv[2];
const prefix = process.argv[3] ?? 'live-context-window';
const PORT = process.env.CDP_PORT ?? '9222';
if (url === undefined) throw new Error('usage: node verify-live.mjs <authenticatedUrl> [outPrefix]');

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((target) => target.type === 'page');
if (page === undefined) throw new Error('no page target — is headless Chrome running with --remote-debugging-port?');

const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
const consoleLines = [];
let nextId = 0;
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined && pending.has(message.id)) {
    const settle = pending.get(message.id);
    pending.delete(message.id);
    settle(message);
    return;
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    consoleLines.push(`[${message.params.type}] ${message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ')}`);
  }
  if (message.method === 'Runtime.exceptionThrown') {
    consoleLines.push(`[exception] ${message.params.exceptionDetails.text} ${message.params.exceptionDetails.exception?.description ?? ''}`);
  }
});
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, (message) => {
    if (message.error !== undefined) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
    else resolve(message.result);
  });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.text);
  return result.result?.value;
};
const shoot = async (name, clip) => {
  const shot = await send('Page.captureScreenshot', clip === undefined
    ? { format: 'png', captureBeyondViewport: false }
    : { format: 'png', captureBeyondViewport: true, clip: { ...clip, scale: 2 } });
  const file = `${prefix}-${name}.png`;
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log('shot:', file);
};

/** Shared in-page helpers: the seat, the popover, layout boxes and framing. */
const HELPERS = `
  const seat = () => document.querySelector('[data-testid="context-window"]');
  const panel = () => document.querySelector('[data-testid="context-window-panel"]');
  const rowOf = (element) => {
    let node = element.parentElement;
    while (node !== null && node !== document.body && getComputedStyle(node).display === 'contents') node = node.parentElement;
    return node;
  };
  const box = (element) => {
    if (element === null) return null;
    const rect = element.getBoundingClientRect();
    return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  };
  const rows = () => [...document.querySelectorAll('[data-testid="context-window-panel"] .dcw-row')]
    .map((row) => row.innerText.replace(/\\n/g, ' | '));
  const disclosures = () => [...document.querySelectorAll('[data-testid="context-window-panel"] .dcw-disclosure')];
  const framePanel = () => {
    const pop = panel();
    if (pop === null) return null;
    const rect = pop.getBoundingClientRect();
    return { x: Math.max(0, rect.x - 20), y: Math.max(0, rect.y - 20), width: rect.width + 40, height: rect.height + 40 };
  };
  const clickTrigger = () => seat()?.querySelector('button[aria-haspopup="dialog"]')?.click();
  const clickHeader = () => panel()?.querySelector('button[aria-expanded]')?.click();
`;

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await sleep(8000);

for (let attempt = 0; attempt < 4; attempt += 1) {
  const dismissed = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button')];
    const next = buttons.find((element) => /^(继续|开始使用|知道了|Continue|Get started|Got it)$/.test((element.textContent ?? '').trim()));
    if (next === undefined) return 'none';
    next.click();
    return next.textContent.trim();
  })()`);
  if (dismissed === 'none') break;
  console.log('dismissed:', dismissed);
  await sleep(1200);
}
await sleep(1500);

const openedSession = await evaluate(`(() => {
  const matches = [...document.querySelectorAll('button, a, [role="button"], li, div, span')]
    .filter((element) => /上下文显示整理成/.test(element.textContent ?? ''))
    .filter((element) => (element.textContent ?? '').trim().length < 60 && element.getClientRects().length > 0);
  const row = matches[matches.length - 1];
  if (row === undefined) return 'no-session-row';
  row.click();
  return 'clicked:' + (row.textContent ?? '').trim().slice(0, 24);
})()`);
console.log('open session:', openedSession);
await sleep(9000);

console.log('--- trigger ---');
console.log(JSON.stringify(await evaluate(`(() => {
  ${HELPERS}
  const root = seat();
  if (root === null) return { seat: false };
  const trigger = root.querySelector('button[aria-haspopup="dialog"]');
  const shipped = [...document.querySelectorAll('button[aria-haspopup="dialog"][aria-label]')]
    .filter((button) => /[%％]/.test(button.getAttribute('aria-label') ?? '') && button.querySelectorAll('svg circle').length >= 2);
  return {
    seat: true,
    triggerLabel: trigger?.getAttribute('aria-label') ?? null,
    ringBox: box(trigger?.querySelector('svg') ?? null),
    shippedMeters: shipped.map((button) => ({ label: button.getAttribute('aria-label'), hidden: button.getClientRects().length === 0 })),
  };
})()`), null, 2));
const ringClip = await evaluate(`(() => { ${HELPERS} const trigger = seat()?.querySelector('button[aria-haspopup="dialog"]'); return trigger ? { x: Math.max(0, trigger.getBoundingClientRect().x - 30), y: Math.max(0, trigger.getBoundingClientRect().y - 30), width: 149, height: 82 } : null; })()`);
if (ringClip !== null) await shoot('01-ring', ringClip);

await evaluate(`(() => { ${HELPERS} clickTrigger(); return 'ok'; })()`);
await sleep(1200);
console.log('--- popover (compact) ---');
console.log(await evaluate(`(() => { ${HELPERS} return panel()?.innerText ?? '(no panel)'; })()`));
const compactClip = await evaluate(`(() => { ${HELPERS} return framePanel(); })()`);
if (compactClip !== null) await shoot('02-popover', compactClip);

await evaluate(`(() => { ${HELPERS} clickHeader(); return 'ok'; })()`);
await sleep(1200);
console.log('--- rows (live classification) ---');
const rowText = await evaluate(`(() => { ${HELPERS} return rows(); })()`);
console.log(JSON.stringify(rowText, null, 2));
console.log('row count:', rowText.length, '| disclosures:', await evaluate(`(() => { ${HELPERS} return disclosures().length; })()`));
const rowsClip = await evaluate(`(() => { ${HELPERS} return framePanel(); })()`);
if (rowsClip !== null) await shoot('03-rows', rowsClip);

console.log('--- expand the MCP row (level 1: servers) ---');
const mcpOpened = await evaluate(`(() => {
  ${HELPERS}
  const mcp = disclosures().find((button) => /MCP/.test(button.innerText));
  if (mcp === undefined) return 'no-mcp-row';
  mcp.click();
  return 'clicked:' + mcp.innerText.replace(/\\n/g, ' ');
})()`);
console.log(mcpOpened);
await sleep(1000);
console.log(JSON.stringify(await evaluate(`(() => {
  ${HELPERS}
  return [...document.querySelectorAll('[data-testid="context-window-panel"] .dcw-item-button')].map((item) => item.innerText.replace(/\\n/g, ' '));
})()`), null, 2));
const serversClip = await evaluate(`(() => { ${HELPERS} return framePanel(); })()`);
if (serversClip !== null) await shoot('04-mcp-servers', serversClip);

console.log('--- expand one server (level 2: its tools) ---');
const serverOpened = await evaluate(`(() => {
  ${HELPERS}
  const server = [...document.querySelectorAll('[data-testid="context-window-panel"] .dcw-item-button')]
    .find((item) => /github/.test(item.innerText));
  if (server === undefined) return 'no-server-row';
  server.click();
  return 'clicked:' + server.innerText.replace(/\\n/g, ' ');
})()`);
console.log(serverOpened);
await sleep(1000);
console.log(JSON.stringify(await evaluate(`(() => {
  ${HELPERS}
  return [...document.querySelectorAll('[data-testid="context-window-panel"] .dcw-subitems .dcw-item')].slice(0, 6).map((item) => item.innerText.replace(/\\n/g, ' '));
})()`), null, 2));
const toolsClip = await evaluate(`(() => { ${HELPERS} return framePanel(); })()`);
if (toolsClip !== null) await shoot('05-mcp-tools', toolsClip);

// The skill row: real catalog numbers from a session that has one, injected into
// the live payload, so the row is rendered from DSH's own catalog shape.
console.log('--- skills row (real catalog payload) ---');
const stubbed = await evaluate(`(() => {
  // Wrap the panel's own request: the live payload keeps its real session and
  // tools; only the skills block is filled in from a real catalog.
  const real = window.fetch.bind(window);
  const skills = {
    seq: 10, update: false, count: 4, tokens: 556, chars: 2192,
    tool: { name: 'skill', tokens: 88 },
    items: [
      { name: 'office-xlsx', tokens: 112 },
      { name: 'office-pptx', tokens: 98 },
      { name: 'office-docx', tokens: 96 },
      { name: 'diagnose-windows-sandbox-acl', tokens: 88 },
    ],
  };
  window.fetch = async (input, init) => {
    const response = await real(input, init);
    if (!String(input).includes('context-window.detail')) return response;
    const payload = await response.json();
    return new Response(JSON.stringify({ ...payload, skills }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { stubbed: true };
})()`);
console.log(JSON.stringify(stubbed));
await evaluate(`(() => { ${HELPERS} clickTrigger(); return 'close'; })()`);
await sleep(400);
await evaluate(`(() => { ${HELPERS} clickTrigger(); return 'reopen'; })()`);
await sleep(1500);
await evaluate(`(() => { ${HELPERS} clickHeader(); return 'expand'; })()`);
await sleep(1200);
const skillRows = await evaluate(`(() => { ${HELPERS} return rows(); })()`);
console.log(JSON.stringify(skillRows, null, 2));
await evaluate(`(() => {
  ${HELPERS}
  const skills = disclosures().find((button) => /技能|Skills/.test(button.innerText));
  if (skills !== undefined) skills.click();
  return 'ok';
})()`);
await sleep(1000);
console.log(JSON.stringify(await evaluate(`(() => {
  ${HELPERS}
  return [...document.querySelectorAll('[data-testid="context-window-panel"] .dcw-item')].map((item) => item.innerText.replace(/\\n/g, ' '));
})()`), null, 2));
const skillsClip = await evaluate(`(() => { ${HELPERS} return framePanel(); })()`);
if (skillsClip !== null) await shoot('06-skills-expanded', skillsClip);

console.log('--- console ---');
console.log(consoleLines.slice(-20).join('\n') || '(clean)');
socket.close();
