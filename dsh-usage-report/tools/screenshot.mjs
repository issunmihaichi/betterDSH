// Drive a headless Chrome over CDP: load the authenticated GUI URL, open
// Settings → 用量, and capture screenshots. Uses Node's built-in WebSocket, so
// no browser-automation dependency is needed.
// usage: node screenshot.mjs <authenticatedUrl> <outPrefix>
import fs from 'node:fs';

const url = process.argv[2];
const prefix = process.argv[3] ?? 'shot';
const PORT = process.env.CDP_PORT ?? '9222';
if (url === undefined) throw new Error('usage: node screenshot.mjs <url> <outPrefix>');

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((target) => target.type === 'page');
if (page === undefined) throw new Error('no page target');
console.log('target:', page.url);

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
  return result.result?.value;
};
const shoot = async (name) => {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = `${prefix}-${name}.png`;
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log('shot:', file);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await sleep(7000);
await shoot('01-boot');

const bodyText = await evaluate('document.body.innerText.slice(0, 400)');
console.log('body starts:', JSON.stringify(bodyText?.slice(0, 160)));

// Dismiss the preview/onboarding modal a brand-new browser profile shows.
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
await shoot('01b-after-welcome');

// Open the settings panel through the sidebar-foot trigger.
const opened = await evaluate(`(() => {
  const buttons = [...document.querySelectorAll('button')];
  const trigger = buttons.find((element) => /设置|Settings/.test(element.textContent ?? ''));
  if (trigger === undefined) return 'no-trigger';
  trigger.click();
  return trigger.textContent.trim();
})()`);
console.log('settings trigger:', opened);
await sleep(1500);
await shoot('02-settings');

// Select the 用量 section in the panel nav.
const navClicked = await evaluate(`(() => {
  const buttons = [...document.querySelectorAll('button')];
  const labels = buttons.map((element) => (element.textContent ?? '').trim()).filter(Boolean);
  const cell = buttons.find((element) => /^用量/.test((element.textContent ?? '').trim()));
  if (cell === undefined) return 'nav:' + JSON.stringify(labels.slice(0, 24));
  cell.click();
  return 'clicked:' + cell.textContent.trim();
})()`);
console.log('nav:', navClicked);
await sleep(4000);
await shoot('03-usage');

const panelText = await evaluate('(document.querySelector(\"[role=dialog]\") ?? document.body).innerText.slice(0, 1200)');
console.log('--- panel text (30d) ---');
console.log(panelText);

// Switch the range tab: the page must refetch and relabel with no reload.
const rangeSwitched = await evaluate(`(() => {
  const buttons = [...document.querySelectorAll('button')];
  const tab = buttons.find((element) => (element.textContent ?? '').trim() === '7 天');
  if (tab === undefined) return 'no-tab';
  tab.click();
  return 'clicked';
})()`);
console.log('range switch:', rangeSwitched);
await sleep(3500);
await shoot('04-usage-7d');
const weekText = await evaluate('(document.querySelector(\"[role=dialog]\") ?? document.body).innerText.split(\"每日 Token 用量\")[1]?.slice(0, 240) ?? \"\"');
console.log('--- chart area (7d) ---');
console.log(weekText);
console.log('--- console ---');
console.log(consoleLines.slice(-25).join('\n') || '(clean)');
socket.close();
