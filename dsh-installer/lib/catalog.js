/** Installer policy is data, separate from transport and task execution. */
export const CATALOG = Object.freeze([
  { name: 'dsh-usage-report', title: '用量统计', description: '本机会话 Token 用量，按天查看。', setup: '无需账号配置；真实日志与投影缓存可能有差异。' },
  { name: 'dsh-account-pool', title: '账号池', description: '账号、分组、调度、重试与额度管理。', setup: '安装后自行添加账号和凭据；不会预置账号。' },
  { name: 'dsh-context-window', title: '上下文窗口', description: '输入区占用明细：工具、MCP 与技能。', setup: '安装或更新宿主模块后重启 DSH。' },
  { name: 'dsh-github', title: 'GitHub 管理', description: 'GitHub 设置页、MCP 连接与仓库管理。', setup: '在 GitHub 设置页自行配置令牌；向导不读取凭据。' },
  { name: 'dsh-mcp-skills', title: 'MCP 与技能', description: '统一查看和管理 MCP 服务器与技能。', setup: '安装后进入 MCP 与技能页维护配置。' },
].map(item => Object.freeze(item)));

/** Never expose arbitrary manager diagnostics as error codes in the GUI. */
const PUBLIC_CODES = new Set(['incompatible-version', 'management-required', 'not-bundle', 'invalid-spec', 'not-removable', 'stop-profile', 'bundle-in-use', 'invalid-bundle', 'source-outside-repository', 'source-unavailable', 'source-changed-replan', 'bundle-problem', 'installation-failed', 'build-approval-required', 'cancelled', 'overridden']);
export function publicErrorCode(code, fallback = 'installation-failed') {
  return PUBLIC_CODES.has(code) ? code : fallback;
}
export function bundleAction(row) {
  if (row?.error) return 'blocked';
  if (!row?.installed) return 'install';
  return row.enabled ? 'skip' : 'enable';
}
