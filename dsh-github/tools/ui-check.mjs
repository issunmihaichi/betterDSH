// Render the running GUI in a throwaway headless Chrome and dump what the
// Settings panel (and my GitHub section) actually looks like.
//
//   node tools/ui-check.mjs [labelPattern]
//
// The /api requests need the browser-session cookie; this script mints the same
// cookie the open page holds, from the harness's own stored signing secret
// (see tools/e2e-check.mjs). Loopback only, nothing printed.
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const baseUrl = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387';
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const label = process.argv[2] ?? 'GitHub';
const stubFresh = process.argv.includes('--stub-fresh');
const stub = process.argv.includes('--stub') || stubFresh;
const port = process.env.CDP_PORT ?? '9333';
const outPrefix = process.env.SHOT_PREFIX ?? 'ui';
const chromePath = process.env.CHROME
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const b64url = (value) => Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');

function signingSecret() {
  const text = readFileSync(join(dshHome, '.credentials.yaml'), 'utf8');
  const marker = text.indexOf('client-connection/browser-session:');
  const window = text.slice(marker, marker + 600);
  const match = /secret:\s*["']?([A-Za-z0-9_\-+/=]+)["']?/u.exec(window);
  return Buffer.from(match[1], 'base64url');
}

function sessionCookie() {
  const authority = new URL(baseUrl).host;
  const name = `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}`;
  const now = Date.now();
  const body = b64url(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 3_600_000 }));
  return { name, value: `v1.${body}.${b64url(createHmac('sha256', signingSecret()).update(body).digest())}` };
}

const cookie = sessionCookie();
const profileDir = mkdtempSync(join(tmpdir(), 'dsh-ui-check-'));
const chrome = spawn(chromePath, [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--window-size=1600,1000',
  '--hide-scrollbars',
  'about:blank',
], { stdio: 'ignore', windowsHide: true });

let targets;
for (let attempt = 0; attempt < 40; attempt += 1) {
  await sleep(400);
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    if (Array.isArray(targets) && targets.length > 0) break;
  } catch { /* keep waiting for the debugger port */ }
}
const page = (targets ?? []).find((target) => target.type === 'page');
if (page === undefined) {
  chrome.kill();
  throw new Error('headless Chrome did not expose a page target');
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
const lines = [];
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
    lines.push(`[${message.params.type}] ${message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ')}`);
  }
  if (message.method === 'Runtime.exceptionThrown') {
    lines.push(`[exception] ${message.params.exceptionDetails.text} ${message.params.exceptionDetails.exception?.description ?? ''}`);
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
const shoot = async (name) => {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = `${outPrefix}-${name}.png`;
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log('shot:', file);
  return file;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

// `--stub` renders the page against data a configured token would produce: the
// connected states (tool list, account repository list) cannot be reached
// without a real token, and this is how their layout is still verified in the
// real app shell. Every other request passes through untouched.
if (stub) {
  const stubStatus = {
    settings: {
      version: 1, serverName: 'github', transport: 'streamable-http',
      url: 'https://api.githubcopilot.com/mcp/', command: 'github-mcp-server', argsText: 'stdio',
      cwd: '', toolsets: 'context,repos,issues,pull_requests', readOnly: false, tokenSource: 'store',
      envVar: 'GITHUB_PERSONAL_ACCESS_TOKEN', failOnStartupError: false, cloneRoot: '', cloneDepth: 0, cloneBranch: '',
    },
    token: { present: true, source: 'store', envVar: 'GITHUB_PERSONAL_ACCESS_TOKEN', preview: 'ghp_…abcd (20 字符)' },
    mcp: {
      rowId: 'github-mcp', found: true, enabled: true, phase: 'active', serverName: 'github',
      transport: 'streamable-http', endpoint: 'https://api.githubcopilot.com/mcp/', toolCount: 3, tokenPresent: true,
    },
    tools: [
      { name: 'mcp__github__search_repositories', shortName: 'search_repositories', description: 'Find repositories by name, owner or topic', parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string', description: 'search text' }, perPage: { type: 'integer', description: 'results per page' } } } },
      { name: 'mcp__github__get_file_contents', shortName: 'get_file_contents', description: 'Read a file or list a directory', parameters: { type: 'object', required: ['owner', 'repo'], properties: { owner: { type: 'string' }, repo: { type: 'string' }, path: { type: 'string' } } } },
      { name: 'mcp__github__create_issue', shortName: 'create_issue', description: 'Create an issue', parameters: { type: 'object', required: ['owner', 'repo', 'title'], properties: { title: { type: 'string' }, body: { type: 'string' } } } },
    ],
    repos: [{ name: 'Hello-World', path: 'C:\\Users\\me\\.dsh\\github-repos\\Hello-World', remote: 'https://github.com/octocat/Hello-World.git', branch: 'main', updatedAt: 1 }],
    cloneRoot: 'C:\\Users\\me\\.dsh\\github-repos',
    git: { ok: true, version: 'git version 2.55.0.windows.3' },
    command: { name: 'github', hint: '[list|tools|call|clone|repos|status|help]', description: 'GitHub MCP', listed: true, catalog: [{ name: 'github' }, { name: 'plan' }] },
    storeDir: 'C:\\Users\\me\\.dsh\\github-mcp',
    settingsPath: 'C:\\Users\\me\\.dsh\\github-mcp\\settings.json',
    lastError: null,
    generatedAt: 1,
  };
  const stubRemote = {
    ok: true,
    account: { login: 'octocat', name: 'The Octocat', avatarUrl: '' },
    page: 1,
    scanned: 5,
    hasMore: true,
    rateLimit: { remaining: 4998, limit: 5000, resetAt: 0 },
    items: [
      { fullName: 'octocat/Hello-World', private: false, language: 'Go', defaultBranch: 'main', description: 'My first repository on GitHub', archived: false, fork: false },
      { fullName: 'octocat/Spoon-Knife', private: false, language: 'HTML', defaultBranch: 'gh-pages', description: 'This repo is for demonstration purposes only.', archived: false, fork: true },
      { fullName: 'acme-internal/deploy-secrets', private: true, language: 'TypeScript', defaultBranch: 'main', description: '内部署脚本与凭据轮换', archived: false, fork: false },
      { fullName: 'acme-internal/legacy-etl', private: true, language: 'Python', defaultBranch: 'develop', description: '老的数据同步任务，已停止维护', archived: true, fork: false },
      { fullName: 'octocat/git-consortium', private: false, language: '', defaultBranch: 'master', description: '', archived: false, fork: false },
    ],
  };
  // `--stub-fresh` renders the wizard the way a first run sees it: nothing
  // configured yet, so the token step is the one that opens.
  if (stubFresh) {
    stubStatus.settings = { ...stubStatus.settings, wizardDone: false };
    stubStatus.token = { present: false, source: 'store', envVar: 'GITHUB_PERSONAL_ACCESS_TOKEN', preview: '' };
    stubStatus.mcp = { ...stubStatus.mcp, enabled: false, phase: null, toolCount: 0, tokenPresent: false };
    stubStatus.tools = [];
    stubStatus.repos = [];
  }
  const source = `(() => {
    const real = window.fetch.bind(window);
    const json = (body) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = (init && init.method) || 'GET';
      if (url.includes('api/github.remote') && method === 'GET') return json(${JSON.stringify(stubRemote)});
      if (url.includes('api/github.status') && method === 'GET') return json(${JSON.stringify(stubStatus)});
      return real(input, init);
    };
  })();`;
  await send('Page.addScriptToEvaluateOnNewDocument', { source });
  console.log(`stub installed (${stubFresh ? 'first run' : 'connected'}): status + remote listing answered locally`);
}
await send('Network.setCookie', {
  name: cookie.name,
  value: cookie.value,
  domain: '127.0.0.1',
  path: '/',
  httpOnly: true,
  sameSite: 'Strict',
  expires: Math.floor(Date.now() / 1000) + 3600,
});
await send('Page.navigate', { url: baseUrl });
await sleep(9000);
await shoot('01-boot');

// Dismiss the first-run welcome modal when this fresh profile shows one.
for (let attempt = 0; attempt < 4; attempt += 1) {
  const dismissed = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button')];
    const next = buttons.find((element) => /^(继续|开始使用|知道了|跳过|Continue|Get started|Got it|Skip)$/.test((element.textContent ?? '').trim()));
    if (next === undefined) return 'none';
    next.click();
    return next.textContent.trim();
  })()`);
  if (dismissed === 'none') break;
  console.log('dismissed:', dismissed);
  await sleep(1500);
}
await shoot('02-ready');

// Open the settings panel.
const opened = await evaluate(`(() => {
  const buttons = [...document.querySelectorAll('button')];
  const trigger = buttons.find((element) => /设置|Settings/.test(element.textContent ?? ''));
  if (trigger === undefined) return 'no-trigger';
  trigger.click();
  return trigger.textContent.trim();
})()`);
console.log('settings trigger:', opened);
await sleep(2500);
await shoot('03-settings');

// Dump every settings nav row: label, tag, class names and icon markup.
const navRows = await evaluate(`(() => {
  const rows = [];
  const buttons = [...document.querySelectorAll('button')];
  for (const button of buttons) {
    const text = (button.textContent ?? '').trim();
    if (text === '' || text.length > 24) continue;
    const rect = button.getBoundingClientRect();
    if (rect.width === 0) continue;
    const openers = [...button.querySelectorAll('svg, img, span, i')].slice(0, 6).map((node) => ({
      tag: node.tagName.toLowerCase(),
      cls: node.getAttribute('class') ?? '',
      style: node.getAttribute('style') ?? '',
      radius: getComputedStyle(node).borderRadius,
      w: Math.round(node.getBoundingClientRect().width),
      h: Math.round(node.getBoundingClientRect().height),
      svg: node.tagName.toLowerCase() === 'svg' ? node.outerHTML.slice(0, 160) : (node.querySelector('svg')?.outerHTML.slice(0, 160) ?? ''),
    }));
    rows.push({ text, cls: button.getAttribute('class') ?? '', radius: getComputedStyle(button).borderRadius, icon: openers });
  }
  return rows.slice(0, 40);
})()`);
const navFile = `${outPrefix}-nav.json`;
writeFileSync(navFile, JSON.stringify(navRows, null, 2));
console.log('nav rows ->', navFile);
for (const row of navRows ?? []) {
  if (row.icon.length > 0) console.log(`nav "${row.text}" radius=${row.radius} icon=${JSON.stringify(row.icon[0])}`);
}

// Click the requested section.
const clicked = await evaluate(`(() => {
  const pattern = new RegExp(${JSON.stringify(`^${label}`)}, 'i');
  const buttons = [...document.querySelectorAll('button')];
  const cell = buttons.find((element) => pattern.test((element.textContent ?? '').trim()));
  if (cell === undefined) return 'not-found:' + JSON.stringify(buttons.map((b) => (b.textContent ?? '').trim()).filter(Boolean).slice(0, 30));
  cell.click();
  return 'clicked:' + (cell.textContent ?? '').trim();
})()`);
console.log('nav click:', clicked);
await sleep(4000);
await shoot('04-section');

// Measure every switch-like control on the page: this is how the shipped
// design draws a toggle, and the page under test must match it.
const controls = await evaluate(`(() => {
  const out = [];
  for (const node of document.querySelectorAll('[role=switch], [role=checkbox], input[type=checkbox], input[type=radio], select, [aria-checked]')) {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    out.push({
      tag: node.tagName.toLowerCase(),
      role: node.getAttribute('role') ?? '',
      cls: node.getAttribute('class') ?? '',
      ariaChecked: node.getAttribute('aria-checked') ?? '',
      checked: node.checked ?? null,
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      radius: style.borderRadius,
      bg: style.backgroundColor,
      border: style.border,
      color: style.color,
      html: node.outerHTML.slice(0, 220),
    });
  }
  return out;
})()`);
const controlFile = `${outPrefix}-controls.json`;
writeFileSync(controlFile, JSON.stringify(controls, null, 2));
console.log(`controls -> ${controlFile} (${String(controls?.length ?? 0)})`);
for (const control of controls ?? []) {
  console.log(`  ${control.tag}[${control.role}] ${String(control.w)}x${String(control.h)} r=${control.radius} bg=${control.bg} checked=${String(control.checked)} aria=${control.ariaChecked} :: ${control.html.slice(0, 120)}`);
}

// The stylesheet rules behind the shipped switch, with their theme tokens.
const rules = await evaluate(`(() => {
  const out = [];
  for (const sheet of document.styleSheets) {
    let list;
    try { list = sheet.cssRules; } catch { continue; }
    for (const rule of list) {
      const selector = rule.selectorText ?? '';
      if (!/_switch_|_thumb_/.test(selector)) continue;
      out.push({ selector, css: rule.cssText.slice(0, 400) });
    }
  }
  return out;
})()`);
console.log(`--- shipped switch CSS (${String(rules?.length ?? 0)} rules) ---`);
for (const rule of rules ?? []) console.log(`${rule.selector}\n    ${rule.css}`);

// Scroll the settings content to its bottom: the lower cards (tools, remote
// repository) are what a user must reach next.
const scrolled = await evaluate(`(() => {
  const dialog = document.querySelector('[role=dialog]') ?? document.body;
  const candidates = [dialog, ...dialog.querySelectorAll('*')];
  for (const node of candidates) {
    if (node.scrollHeight > node.clientHeight + 40 && node.clientHeight > 200) {
      node.scrollTop = node.scrollHeight;
      return node.tagName + '.' + (node.getAttribute('class') ?? '') + ' scrolled to ' + String(node.scrollTop);
    }
  }
  return 'no scroller';
})()`);
console.log('scroll:', scrolled);
await sleep(1200);
await shoot('05-bottom');

// Ask for the remote-repository confirmation overlay: pick a repository from
// the account list (or type one), which is what arms the download confirmation.
// Nothing is downloaded until 确认下载 is pressed.
const typed = await evaluate(`(() => {
  const row = document.querySelector('.dsg-repo-row');
  if (row !== null) { row.click(); return 'clicked-row:' + (row.innerText.split('\\n')[0] ?? ''); }
  const input = [...document.querySelectorAll('input')].find((node) => (node.placeholder ?? '').includes('owner/repo') || (node.placeholder ?? '').includes('github.com'));
  if (input === undefined) return 'no-repo-input';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'octocat/Hello-World');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return 'typed';
})()`);
console.log('repository pick:', typed);
await sleep(2500);
await shoot('06-confirm');
const confirmText = await evaluate(`(() => {
  const overlay = document.querySelector('.dsg-overlay');
  return overlay === null ? '(no overlay)' : overlay.innerText;
})()`);
console.log('--- confirmation overlay ---');
console.log(confirmText);

const panel = await evaluate(`(document.querySelector('[role=dialog]') ?? document.body).innerText.slice(0, 2500)`);
console.log('--- panel text ---');
console.log(panel);
console.log('--- console ---');
console.log(lines.slice(-30).join('\n') || '(clean)');
socket.close();
chrome.kill();
