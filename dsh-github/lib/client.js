/**
 * dsh-github — browser half.
 *
 * One `settings.section` page ("GitHub") that manages the whole feature:
 *
 *   令牌 / 传输   the personal access token and the transport the Host will
 *                 hand to the MCP client row (hosted Streamable HTTP or a local
 *                 stdio `github-mcp-server`).
 *   工具          every GitHub MCP tool the bridge currently exposes, with
 *                 parameters and a caller for trying one immediately.
 *   远程仓库      「远程连接仓库」: pick a repository, see exactly what will be
 *                 downloaded, confirm, then watch the clone's own progress and
 *                 the workspace registration that follows.
 *
 * Shipped as a DSH client bundle (`window.__ModuleLoader__.load`) in plain
 * JavaScript: React arrives through the module table, the page is built with
 * createElement, and every read or write goes to the Host half over the
 * authenticated `/api/github.*` routes. No build step is involved.
 */
window.__ModuleLoader__.load({
	id: 'dsh-github',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');
		const h = React.createElement;

		/** Locale namespace owned by this plugin. */
		const NS = 'settings.github';
		/**
		 * Settings nav cell and its position.
		 *
		 * The profile's five contributed pages sit on one ascending ladder, so no
		 * two of them can drift into an accidental tie (a tie is broken by bundle
		 * order, which is invisible in the UI):
		 *
		 *   12 thinking-effort · 13 usage · 14 account-pool · 15 MCP & skills · 16 GitHub
		 *
		 * This page used to sit on 14 — the same slot account-pool claimed, so the
		 * order users saw was decided by the profile's bundle list rather than by
		 * either plugin. 16 keeps GitHub last, next to the integration it manages.
		 */
		const SECTION_ID = 'github';
		const SECTION_ORDER = 16;

		const ROUTES = {
			status: 'api/github.status',
			settings: 'api/github.settings',
			token: 'api/github.token',
			connection: 'api/github.connection',
			call: 'api/github.call',
			remote: 'api/github.remote',
			clone: 'api/github.clone',
		};

		const TOOLSET_HINT = 'context,repos,issues,pull_requests,actions,code_security,discussions,git,labels,notifications,orgs,projects,users';

		const zh = {
			title: 'GitHub',
			intro: '用 Personal Access Token 连接 github/github-mcp-server，让模型直接调用 GitHub 工具；也可以把远程仓库下载到本机并注册为工作区。令牌只保存在本机。',
			refresh: '刷新',
			wizardTitle: '设置向导',
			wizardProgress: '第 {index}/{total} 步 · {label}',
			wizardStepTransport: '连接方式',
			wizardStepToken: '访问令牌',
			wizardStepConnect: '建立连接',
			wizardStepRepos: '下载仓库',
			wizardIntroTransport: '先用推荐的远程方式：本机不需要安装任何东西。想用本地 github-mcp-server 就切到 stdio。',
			wizardSaveTransport: '保存并继续',
			wizardIntroToken: '在 GitHub 上建一个 Token 再粘到下面：fine-grained 需要 Contents / Metadata 的读权限，classic 勾 repo。点「校验并保存」会先拿它去问 GitHub，验证通过才落盘。',
			wizardOpenTokens: '打开 GitHub 令牌页面 ↗',
			wizardVerify: '校验并保存',
			wizardVerifying: '正在校验…',
			wizardVerified: '校验通过：{login}',
			wizardUseEnv: '改用环境变量',
			wizardTokenNeeded: '还没有可用的令牌：粘贴一个后点「校验并保存」。',
			wizardIntroConnect: '现在把令牌交给 MCP 客户端，建立连接并拉取工具清单。',
			wizardConnectNow: '立即连接',
			wizardConnectWait: '正在连接…',
			wizardConnectState: '插件行 {phase} · 已发现 {count} 个工具',
			wizardConnectHint: '工具数为 0 时：确认令牌还有效、toolsets 是否限定了范围，然后点「刷新」或「立即连接」重试。',
			wizardIntroRepos: '连接好了。最后可以下载一个仓库当工作区，也可以直接完成。',
			wizardFinish: '完成',
			wizardSkip: '跳过向导',
			wizardBack: '上一步',
			wizardNext: '下一步',
			wizardRerun: '重新运行设置向导',
			wizardAdvanced: '高级设置（令牌 / 传输 / 工具 / 仓库）',
			wizardHideAdvanced: '收起高级设置',
			loading: '正在读取 GitHub 配置…',
			failed: '读取失败：{message}',
			noConnection: '连接服务不可用，无法读取 GitHub 配置。',
			statusTitle: '连接状态',
			stateConnected: '已连接',
			stateEnabled: '已启用，等待工具同步',
			stateDisabled: '未连接',
			stateMissing: '缺少 MCP 连接行',
			phase: '加载状态 {phase}',
			phaseUnknown: '未知',
			toolCount: '{count} 个工具',
			tokenCardTitle: '访问令牌',
			tokenIntro: '在 GitHub → Settings → Developer settings 创建 fine-grained 或 classic token。仅保存在本机（{path}）。',
			tokenPresent: '已配置：{preview}（来源 {source}）',
			tokenMissing: '尚未配置令牌。',
			tokenSource: '令牌来源',
			tokenField: 'Token',
			sourceStore: '本机保存的令牌',
			sourceEnv: '环境变量',
			envVar: '环境变量名',
			tokenPlaceholder: '粘贴 ghp_… 或 github_pat_…',
			saveToken: '保存令牌并应用',
			clearToken: '清除令牌',
			transportCardTitle: '传输方式',
			transportIntro: '远程 Streamable HTTP 不需要本地安装；本地 stdio 需要先准备好 github-mcp-server 可执行文件。',
			transportHttp: '远程 Streamable HTTP（推荐）',
			transportStdio: '本地 stdio（github-mcp-server）',
			url: 'MCP 端点',
			command: '可执行文件',
			args: '启动参数',
			cwd: '工作目录（可选）',
			toolsets: '工具集（toolsets）',
			toolsetsHint: '可选：{list}',
			readOnly: '不允许任何写操作（只读）',
			readOnlyShort: '只读模式',
			failOnStartup: '连接失败时拒绝激活 MCP 插件行',
			failOnStartupShort: '严格启动',
			saveSettings: '保存并应用',
			connect: '连接',
			disconnect: '断开连接',
			connecting: '正在连接…',
			toolsCardTitle: 'GitHub 工具',
			toolsIntro: '来自 MCP 服务器的工具，模型侧名字是 mcp__{server}__<工具名>；输入栏里也可以用 /github 调用。',
			toolsEmpty: '当前没有工具。保存令牌并点击「连接」后，这里会列出 GitHub MCP 的工具。',
			toolsFilter: '过滤工具…',
			params: '参数',
			noParams: '无参数',
			required: '必填',
			optional: '可选',
			call: '调用',
			calling: '调用中…',
			result: '结果',
			callFailed: '调用失败：{message}',
			repoCardTitle: '远程连接仓库',
			repoIntro: '直接列出你 GitHub 账号下的全部仓库（自己、组织与协作），点一个仓库即可下载到本机并注册成 DSH 工作区。下载由本机 git 执行。',
			accountLine: '已连接为 {login}',
			accountUnknown: '已连接 GitHub',
			loadedCount: '已加载 {loaded} 个仓库',
			scannedCount: '已扫描 {scanned} 个仓库',
			searchPlaceholder: '搜索你的仓库（名称 / 描述 / 语言）…',
			refreshList: '刷新列表',
			loadMore: '加载更多',
			loadingRepos: '正在读取你的仓库…',
			noRepos: '没有匹配的仓库。',
			needToken: '先在「访问令牌」里保存 Personal Access Token，这里就会列出你账号下的全部仓库（自己、组织与协作）。',
			tagPrivate: '私有',
			tagPublic: '公开',
			tagArchived: '已归档',
			manualToggle: '手动输入 owner/repo',
			manualHide: '收起手动输入',
			noDescription: '（无描述）',
			unknownBranch: '未知',
			defaultBranch: '默认分支 {branch}',
			remoteFailed: '读取仓库列表失败：{message}',
			confirmBranch: '分支：{branch}',
			confirmToken: '将使用已保存的令牌完成下载，完成后会把 origin 还原为不含令牌的地址。',
			repoLabel: '仓库',
			repoPlaceholder: 'owner/repo 或 https://github.com/owner/repo',
			branchLabel: '分支（可选）',
			dirLabel: '目录名（可选）',
			cloneRootLabel: '下载目录',
			pickDir: '选择目录…',
			connectRepo: '远程连接仓库',
			preparing: '正在生成下载计划…',
			confirmTitle: '即将开始下载',
			confirmBody: '将执行本机 git clone，把仓库下载到下面的目录，并在完成后注册为 DSH 工作区。',
			confirmTarget: '目标：{dest}',
			confirmSource: '来源：{url}',
			confirmGo: '确认下载',
			confirmCancel: '取消',
			downloading: '正在下载…',
			downloadDone: '下载完成',
			downloadFailed: '下载失败',
			workspaceCreated: '已注册为工作区。',
			workspaceFailed: '注册工作区失败：{reason}',
			reposTitle: '已下载的仓库',
			openWorkspace: '打开工作区',
			openWorkspaceFailed: '打不开这个工作区：它可能已被移除，或在设置里重新注册过。',
			reposEmpty: '下载目录里还没有 git 仓库。',
			reopen: '打开所在目录',
			openFailed: '打开失败：{message}',
			gitMissing: '未检测到可用的 git：{reason}',
			gitOk: '{version}',
			lastError: '最近错误：{message}',
			store: '配置目录 {dir}',
			advanced: '高级',
			commandHint: '命令行：{usage}',
			catalog: '/github 命令已注册：{list}',
			catalogMissing: '/github 命令尚未出现在指令目录中。'
		};

		const en = {
			title: 'GitHub',
			intro: 'Connect github/github-mcp-server with a personal access token so the model can call GitHub tools, and download remote repositories into a DSH workspace. The token never leaves this machine.',
			refresh: 'Refresh',
			wizardTitle: 'Setup wizard',
			wizardProgress: 'Step {index} of {total} · {label}',
			wizardStepTransport: 'Transport',
			wizardStepToken: 'Access token',
			wizardStepConnect: 'Connect',
			wizardStepRepos: 'Download a repository',
			wizardIntroTransport: 'Start with the hosted transport: nothing has to be installed locally. Switch to stdio to use a local github-mcp-server.',
			wizardSaveTransport: 'Save and continue',
			wizardIntroToken: 'Create a token on GitHub and paste it below: fine-grained needs read access to Contents / Metadata, classic needs repo. “Verify and save” asks GitHub first and only then stores it.',
			wizardOpenTokens: 'Open the GitHub token page ↗',
			wizardVerify: 'Verify and save',
			wizardVerifying: 'Verifying…',
			wizardVerified: 'Verified as {login}',
			wizardUseEnv: 'Use an environment variable',
			wizardTokenNeeded: 'No usable token yet: paste one and press “Verify and save”.',
			wizardIntroConnect: 'Hand the token to the MCP client and pull the tool list.',
			wizardConnectNow: 'Connect now',
			wizardConnectWait: 'Connecting…',
			wizardConnectState: 'Row {phase} · {count} tools discovered',
			wizardConnectHint: 'If the tool count is 0: check that the token is still valid and that toolsets is not narrowing the surface, then press Refresh or Connect now again.',
			wizardIntroRepos: 'Connected. As a last step you can download a repository as a workspace, or just finish.',
			wizardFinish: 'Finish',
			wizardSkip: 'Skip the wizard',
			wizardBack: 'Back',
			wizardNext: 'Next',
			wizardRerun: 'Run the setup wizard again',
			wizardAdvanced: 'Advanced (token / transport / tools / repositories)',
			wizardHideAdvanced: 'Hide advanced settings',
			loading: 'Reading GitHub configuration…',
			failed: 'Reading failed: {message}',
			noConnection: 'The connection service is unavailable, so GitHub configuration cannot be read.',
			statusTitle: 'Connection',
			stateConnected: 'Connected',
			stateEnabled: 'Enabled, waiting for tool sync',
			stateDisabled: 'Not connected',
			stateMissing: 'MCP row missing',
			phase: 'Loader phase {phase}',
			phaseUnknown: 'unknown',
			toolCount: '{count} tools',
			tokenCardTitle: 'Access token',
			tokenIntro: 'Create a fine-grained or classic token under GitHub → Settings → Developer settings. Stored on this machine only ({path}).',
			tokenPresent: 'Configured: {preview} (source {source})',
			tokenMissing: 'No token configured yet.',
			tokenSource: 'Token source',
			tokenField: 'Token',
			sourceStore: 'Token stored on this machine',
			sourceEnv: 'Environment variable',
			envVar: 'Variable name',
			tokenPlaceholder: 'Paste ghp_… or github_pat_…',
			saveToken: 'Save token and apply',
			clearToken: 'Clear token',
			transportCardTitle: 'Transport',
			transportIntro: 'Hosted Streamable HTTP needs no local install; local stdio needs a github-mcp-server executable.',
			transportHttp: 'Hosted Streamable HTTP (recommended)',
			transportStdio: 'Local stdio (github-mcp-server)',
			url: 'MCP endpoint',
			command: 'Executable',
			args: 'Arguments',
			cwd: 'Working directory (optional)',
			toolsets: 'Toolsets',
			toolsetsHint: 'Known: {list}',
			readOnly: 'Refuse every write operation',
			readOnlyShort: 'Read-only',
			failOnStartup: 'Reject activation of the MCP row when the connection fails',
			failOnStartupShort: 'Strict startup',
			saveSettings: 'Save and apply',
			connect: 'Connect',
			disconnect: 'Disconnect',
			connecting: 'Connecting…',
			toolsCardTitle: 'GitHub tools',
			toolsIntro: 'Tools from the MCP server. The model sees them as mcp__{server}__<tool>; the composer also offers /github.',
			toolsEmpty: 'No tools yet. Save a token and press Connect to list the GitHub MCP tools here.',
			toolsFilter: 'Filter tools…',
			params: 'Parameters',
			noParams: 'No parameters',
			required: 'required',
			optional: 'optional',
			call: 'Call',
			calling: 'Calling…',
			result: 'Result',
			callFailed: 'Call failed: {message}',
			repoCardTitle: 'Connect a remote repository',
			repoIntro: 'Lists every repository your GitHub account can see (owned, organization and collaborator); pick one to download it to this machine and register it as a DSH workspace. The download runs this machine\u2019s git.',
			accountLine: 'Connected as {login}',
			accountUnknown: 'Connected to GitHub',
			loadedCount: '{loaded} repositories loaded',
			scannedCount: 'scanned {scanned} repositories',
			searchPlaceholder: 'Search your repositories (name / description / language)…',
			refreshList: 'Refresh list',
			loadMore: 'Load more',
			loadingRepos: 'Reading your repositories…',
			noRepos: 'No matching repository.',
			needToken: 'Save a personal access token under Access token first; this then lists every repository your account can see (owned, organization and collaborator).',
			tagPrivate: 'Private',
			tagPublic: 'Public',
			tagArchived: 'Archived',
			manualToggle: 'Enter owner/repo manually',
			manualHide: 'Hide manual entry',
			noDescription: '(no description)',
			unknownBranch: 'unknown',
			defaultBranch: 'default {branch}',
			remoteFailed: 'Reading the repository list failed: {message}',
			confirmBranch: 'Branch: {branch}',
			confirmToken: 'The saved token is used for the download, and origin is restored without it afterwards.',
			repoLabel: 'Repository',
			repoPlaceholder: 'owner/repo or https://github.com/owner/repo',
			branchLabel: 'Branch (optional)',
			dirLabel: 'Directory name (optional)',
			cloneRootLabel: 'Download directory',
			pickDir: 'Choose directory…',
			connectRepo: 'Connect remote repository',
			preparing: 'Building the download plan…',
			confirmTitle: 'Download is about to start',
			confirmBody: 'This machine\u2019s git will clone the repository into the directory below, and it becomes a DSH workspace when the download finishes.',
			confirmTarget: 'Target: {dest}',
			confirmSource: 'Source: {url}',
			confirmGo: 'Start download',
			confirmCancel: 'Cancel',
			downloading: 'Downloading…',
			downloadDone: 'Download complete',
			downloadFailed: 'Download failed',
			workspaceCreated: 'Registered as a workspace.',
			workspaceFailed: 'Workspace registration failed: {reason}',
			reposTitle: 'Downloaded repositories',
			openWorkspace: 'Open workspace',
			openWorkspaceFailed: 'Could not open that workspace: it may have been removed, or re-registered in settings.',
			reposEmpty: 'No git repository in the download directory yet.',
			reopen: 'Open containing directory',
			openFailed: 'Open failed: {message}',
			gitMissing: 'No usable git found: {reason}',
			gitOk: '{version}',
			lastError: 'Last error: {message}',
			store: 'Configuration directory {dir}',
			advanced: 'Advanced',
			commandHint: 'Command line: {usage}',
			catalog: '/github is registered: {list}',
			catalogMissing: '/github is not in the command directory yet.'
		};

		const dicts = { zh, en };

		/** Interpolate `{name}` placeholders; missing values stay literal. */
		function fill(template, values) {
			return String(template).replace(/\{(\w+)\}/g, (whole, key) => (
				values[key] === undefined ? whole : String(values[key])
			));
		}

		/** One authenticated JSON request against this plugin's Host routes. */
		async function request(path, options) {
			const init = { method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin' };
			if (options !== undefined && options.body !== undefined) {
				init.method = 'POST';
				init.headers = { ...init.headers, 'content-type': 'application/json' };
				init.body = JSON.stringify(options.body);
			}
			const response = await fetch(path, init);
			const body = await response.json().catch(() => null);
			if (body === null) throw new Error(`HTTP ${String(response.status)}`);
			return body;
		}

		const CSS = `
.dsg-root{display:flex;flex-direction:column;gap:14px;padding-bottom:8px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.dsg-head{display:flex;align-items:flex-start;gap:12px}
.dsg-title{font-size:15px;font-weight:600;line-height:22px;margin:0 0 2px}
.dsg-intro{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;flex:1;min-width:0}
.dsg-btn{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-sm,6px);padding:3px 10px;font-family:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}
.dsg-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsg-btn:disabled{opacity:.5;cursor:default}
.dsg-btn-primary{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);font-weight:500}
.dsg-btn-danger{color:var(--dsw-alias-state-error-primary)}
.dsg-seg{display:flex;gap:4px;flex-wrap:wrap;min-width:0}
.dsg-seg-item{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:999px;padding:3px 10px;font-family:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}
.dsg-seg-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsg-seg-item[aria-checked="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-weight:500}
.dsg-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer}
.dsg-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}
.dsg-switch:disabled{cursor:default;opacity:.5}
.dsg-switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsg-switch-thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transition:transform .12s}
.dsg-switch[aria-checked="false"] .dsg-switch-thumb{background:var(--dsw-alias-switch-thumb)}
.dsg-card{border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1);padding:12px 14px}
.dsg-card-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.dsg-card-title{font-size:14px;font-weight:600;margin:0}
.dsg-card-sub{color:var(--dsw-alias-label-secondary);font-size:12px}
.dsg-strip{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.dsg-strip>*{min-width:0}
.dsg-stat{min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1);padding:10px 12px}
.dsg-stat-label{color:var(--dsw-alias-label-secondary);font-size:12px;display:flex;align-items:center;gap:6px}
.dsg-dot{width:8px;height:8px;border-radius:50%;flex:none;display:inline-block}
.dsg-stat-value{font-size:15px;font-weight:600;line-height:24px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsg-stat-hint{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsg-grid{display:grid;grid-template-columns:120px minmax(0,1fr);gap:8px 12px;align-items:center}
.dsg-grid>*{min-width:0}
.dsg-label{color:var(--dsw-alias-label-secondary);font-size:12px}
.dsg-input,.dsg-select,.dsg-textarea{width:100%;min-width:0;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px;padding:4px 8px}
.dsg-textarea{resize:vertical;min-height:52px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.dsg-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0}
.dsg-check{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary);font-size:12px}
.dsg-hint{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;grid-column:2;overflow-wrap:anywhere}
.dsg-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.dsg-error{color:var(--dsw-alias-state-error-primary);font-size:12px}
.dsg-ok{color:var(--dsw-alias-state-success-primary);font-size:12px}
.dsg-warn{color:var(--dsw-alias-state-warn-primary);font-size:12px}
.dsg-empty{color:var(--dsw-alias-label-secondary);font-size:12px}
.dsg-tools{display:flex;flex-direction:column;gap:6px;max-height:260px;overflow:auto;margin-top:4px}
.dsg-tool{border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,6px);padding:6px 8px;cursor:pointer;background:transparent}
.dsg-tool[aria-pressed="true"]{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.dsg-tool-name{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}
.dsg-tool-desc{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsg-params{margin:6px 0 0;padding-left:16px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px;list-style:disc}
.dsg-pre{margin:4px 0 0;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto}
.dsg-repos{display:flex;flex-direction:column;gap:6px;margin-top:6px}
.dsg-repo{border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,6px);padding:6px 8px}
.dsg-repo-name{font-size:12px;font-weight:500}
.dsg-repo-path{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;word-break:break-all}
.dsg-repolist{display:flex;flex-direction:column;gap:4px;max-height:260px;overflow:auto;margin-top:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,6px);padding:6px}
.dsg-repolist-empty{color:var(--dsw-alias-label-secondary);font-size:12px;padding:12px;text-align:center}
.dsg-repo-row{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid transparent;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font-family:inherit;text-align:left;cursor:pointer}
.dsg-repo-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsg-repo-row[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.dsg-repo-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column}
.dsg-repo-main .dsg-repo-name,.dsg-repo-main .dsg-repo-meta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsg-repo-meta{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.dsg-tag{flex:none;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:0 6px;font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dsg-tag-private{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dsg-wizard{gap:10px}
.dsg-steps{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0 10px}
.dsg-step{border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dsg-step-active{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-weight:500}
.dsg-step-done{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.dsg-link{color:var(--dsw-alias-state-business-primary);font-size:12px;line-height:18px;text-decoration:none;display:inline-block;margin-top:4px}
.dsg-link:hover{text-decoration:underline}
.dsg-linkbutton{border:0;background:transparent;padding:0;color:var(--dsw-alias-state-business-primary);font-family:inherit;font-size:11px;line-height:17px;cursor:pointer}
.dsg-linkbutton:hover{text-decoration:underline}
.dsg-overlay{margin-top:10px;border:1px solid var(--dsw-alias-state-warn-primary);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2);padding:10px 12px}
.dsg-overlay-title{font-weight:600;color:var(--dsw-alias-state-warn-primary);font-size:13px;margin:0 0 4px}
.dsg-badge{border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:0 6px;font-size:10px;line-height:15px;color:var(--dsw-alias-label-secondary)}
.dsg-status{color:var(--dsw-alias-label-secondary);font-size:12px;display:flex;align-items:center;gap:8px;min-height:80px;justify-content:center}
`;

		function useStyles(ctx) {
			React.useEffect(() => ctx.effect(() => {
				const element = document.createElement('style');
				element.setAttribute('data-dsh-plugin', 'dsh-github');
				element.textContent = CSS;
				document.head.appendChild(element);
				return () => {
					if (element.parentNode !== null) element.parentNode.removeChild(element);
				};
			}, 'dsh-github: stylesheet'), [ctx]);
		}

		/** Poll the Host status route; `nonce` forces one refresh. */
		function useStatus(nonce) {
			const [state, setState] = React.useState({ status: 'loading', data: null, error: null });
			React.useEffect(() => {
				let alive = true;
				(async () => {
					try {
						const data = await request(ROUTES.status);
						if (!alive) return;
						if (data?.ok === false) throw new Error(data.message ?? 'status failed');
						setState({ status: 'ready', data, error: null });
					} catch (error) {
						if (!alive) return;
						setState({ status: 'error', data: null, error: error instanceof Error ? error.message : String(error) });
					}
				})();
				return () => { alive = false; };
			}, [nonce]);
			return state;
		}

		function Button(props) {
			const { variant, ...rest } = props;
			const className = ['dsg-btn', variant === 'primary' ? 'dsg-btn-primary' : '', variant === 'danger' ? 'dsg-btn-danger' : '']
				.filter((part) => part !== '').join(' ');
			return h('button', { type: 'button', className, ...rest });
		}

		/** The shipped toggle: a 36×20 pill with a round 16px thumb. */
		function Switch(props) {
			const checked = props.checked === true;
			return h('button', {
				type: 'button',
				role: 'switch',
				className: 'dsg-switch',
				'aria-checked': checked ? 'true' : 'false',
				'aria-label': props.label,
				disabled: props.disabled === true,
				onClick: () => props.onChange(checked !== true),
			}, h('span', {
				className: 'dsg-switch-thumb',
				style: { transform: checked ? 'translateX(16px)' : 'none' },
			}));
		}

		/** Rounded segmented choice — the shipped theme selector's shape. */
		function Segmented(props) {
			return h('div', { className: 'dsg-seg', role: 'radiogroup', 'aria-label': props.label }, props.options.map((option) => h('button', {
				key: option.value,
				type: 'button',
				role: 'radio',
				className: 'dsg-seg-item',
				'aria-checked': option.value === props.value ? 'true' : 'false',
				onClick: () => props.onChange(option.value),
			}, option.label)));
		}

		/** One labelled preference row: text on the left, control on the right. */
		function SwitchRow(props) {
			return [
				h('span', { className: 'dsg-label', key: 'label' }, props.label),
				h('label', { className: 'dsg-check', key: 'control' }, [
					h(Switch, {
						key: 'switch',
						checked: props.checked,
						label: props.label,
						onChange: props.onChange,
					}),
					h('span', { key: 'text' }, props.text),
				]),
			];
		}

		function Card(props) {
			return h('section', { className: 'dsg-card' }, [
				h('div', { className: 'dsg-card-head', key: 'head' }, [
					h('h3', { className: 'dsg-card-title', key: 'title' }, props.title),
					props.sub === undefined ? null : h('span', { className: 'dsg-card-sub', key: 'sub' }, props.sub),
				]),
				h('div', { key: 'body' }, props.children),
			]);
		}

		function Stat(props) {
			return h('div', { className: 'dsg-stat' }, [
				h('div', { className: 'dsg-stat-label', key: 'label' }, [
					h('span', { className: 'dsg-dot', key: 'dot', style: { background: props.color } }),
					props.label,
				]),
				h('div', { className: 'dsg-stat-value', key: 'value', title: props.value }, props.value),
				h('div', { className: 'dsg-stat-hint', key: 'hint', title: props.hint }, props.hint ?? ''),
			]);
		}

		/** Token card: source, secret entry, save/clear. */
		function TokenCard(props) {
			const { t, data, onChanged } = props;
			const [draft, setDraft] = React.useState('');
			const [envVar, setEnvVar] = React.useState(data.settings.envVar);
			const [busy, setBusy] = React.useState(false);
			const [message, setMessage] = React.useState(null);

			const submit = async (body) => {
				setBusy(true);
				setMessage(null);
				try {
					const outcome = await request(ROUTES.token, { body });
					setDraft('');
					if (outcome.ok === false) setMessage({ kind: 'error', text: outcome.applied?.message ?? outcome.message ?? 'failed' });
					else setMessage({ kind: 'ok', text: t('tokenPresent', { preview: outcome.status?.token?.preview ?? '', source: outcome.status?.token?.source ?? '' }) });
					onChanged();
				} catch (error) {
					setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
				} finally {
					setBusy(false);
				}
			};

			return h(Card, { title: t('tokenCardTitle') }, [
				h('div', { className: 'dsg-card-sub', key: 'intro', style: { marginBottom: '8px' } }, fill(t('tokenIntro'), { path: data.settingsPath })),
				h('div', { className: 'dsg-grid', key: 'grid' }, [
					h('span', { className: 'dsg-label', key: 'source-l' }, t('tokenSource')),
					h(Segmented, {
						key: 'source',
						label: t('tokenSource'),
						value: data.settings.tokenSource,
						options: [
							{ value: 'store', label: t('sourceStore') },
							{ value: 'env', label: t('sourceEnv') },
						],
						onChange: (value) => { void request(ROUTES.settings, { body: { settings: { tokenSource: value } } }).then(onChanged); },
					}),
					data.settings.tokenSource === 'env' ? h('span', { className: 'dsg-label', key: 'env-l' }, t('envVar')) : null,
					data.settings.tokenSource === 'env' ? h('div', { className: 'dsg-inline', key: 'env' }, [
						h('input', {
							className: 'dsg-input',
							value: envVar,
							onChange: (event) => setEnvVar(event.target.value),
							onBlur: () => { void request(ROUTES.settings, { body: { settings: { envVar } } }).then(onChanged); },
						}),
					]) : null,
					h('span', { className: 'dsg-label', key: 'token-l' }, t('tokenField')),
					h('div', { className: 'dsg-inline', key: 'token' }, [
						h('input', {
							className: 'dsg-input',
							type: 'password',
							placeholder: t('tokenPlaceholder'),
							value: draft,
							onChange: (event) => setDraft(event.target.value),
						}),
						h(Button, { key: 'save', variant: 'primary', disabled: busy || draft.trim() === '', onClick: () => submit({ token: draft }) }, t('saveToken')),
						h(Button, { key: 'clear', variant: 'danger', disabled: busy || data.token.present !== true, onClick: () => submit({ clear: true }) }, t('clearToken')),
					]),
					h('span', { className: 'dsg-hint', key: 'hint' }, data.token.present === true
						? fill(t('tokenPresent'), { preview: data.token.preview, source: data.token.source })
						: t('tokenMissing')),
				]),
				message === null ? null : h('div', { key: 'msg', className: message.kind === 'ok' ? 'dsg-ok' : 'dsg-error' }, message.text),
			]);
		}

		/** Transport card: hosted HTTP or local stdio, plus connect/disconnect. */
		function TransportCard(props) {
			const { t, data, onChanged } = props;
			const [draft, setDraft] = React.useState(data.settings);
			const [busy, setBusy] = React.useState(false);
			const [message, setMessage] = React.useState(null);

			React.useEffect(() => { setDraft(data.settings); }, [data.settings]);

			const patch = (values) => setDraft((previous) => ({ ...previous, ...values }));

			const save = async (extra) => {
				setBusy(true);
				setMessage(null);
				try {
					const outcome = await request(ROUTES.settings, { body: { settings: { ...draft, ...(extra ?? {}) } } });
					if (outcome.ok === false) setMessage({ kind: 'error', text: outcome.applied?.message ?? outcome.message ?? 'failed' });
					else setMessage({ kind: 'ok', text: t('saveSettings') });
					onChanged();
				} catch (error) {
					setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
				} finally {
					setBusy(false);
				}
			};

			const toggle = async (action) => {
				setBusy(true);
				setMessage(null);
				try {
					const outcome = await request(ROUTES.connection, { body: { action } });
					if (outcome.ok !== true) setMessage({ kind: 'error', text: outcome.message ?? 'failed' });
					else setMessage({ kind: 'ok', text: action === 'connect' ? t('connect') : t('disconnect') });
					onChanged();
				} catch (error) {
					setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
				} finally {
					setBusy(false);
				}
			};

			const stdio = draft.transport === 'stdio';
			return h(Card, { title: t('transportCardTitle') }, [
				h('div', { className: 'dsg-card-sub', key: 'intro', style: { marginBottom: '8px' } }, t('transportIntro')),
				h('div', { className: 'dsg-grid', key: 'grid' }, [
					h('span', { className: 'dsg-label', key: 'transport-l' }, t('transportCardTitle')),
					h(Segmented, {
						key: 'transport',
						label: t('transportCardTitle'),
						value: draft.transport,
						options: [
							{ value: 'streamable-http', label: t('transportHttp') },
							{ value: 'stdio', label: t('transportStdio') },
						],
						onChange: (value) => patch({ transport: value }),
					}),
					stdio ? h('span', { className: 'dsg-label', key: 'command-l' }, t('command')) : h('span', { className: 'dsg-label', key: 'url-l' }, t('url')),
					stdio
						? h('input', { key: 'command', className: 'dsg-input', value: draft.command, onChange: (event) => patch({ command: event.target.value }) })
						: h('input', { key: 'url', className: 'dsg-input', value: draft.url, onChange: (event) => patch({ url: event.target.value }) }),
					stdio ? h('span', { className: 'dsg-label', key: 'args-l' }, t('args')) : null,
					stdio ? h('input', { key: 'args', className: 'dsg-input', value: draft.argsText, onChange: (event) => patch({ argsText: event.target.value }) }) : null,
					stdio ? h('span', { className: 'dsg-label', key: 'cwd-l' }, t('cwd')) : null,
					stdio ? h('input', { key: 'cwd', className: 'dsg-input', value: draft.cwd, onChange: (event) => patch({ cwd: event.target.value }) }) : null,
					h('span', { className: 'dsg-label', key: 'toolsets-l' }, t('toolsets')),
					h('input', { key: 'toolsets', className: 'dsg-input', value: draft.toolsets, onChange: (event) => patch({ toolsets: event.target.value }) }),
					h('span', { className: 'dsg-hint', key: 'toolsets-hint' }, fill(t('toolsetsHint'), { list: TOOLSET_HINT })),
					h(SwitchRow, {
						key: 'readonly',
						label: t('readOnlyShort'),
						text: t('readOnly'),
						checked: draft.readOnly === true,
						onChange: (value) => patch({ readOnly: value }),
					}),
					h(SwitchRow, {
						key: 'fail',
						label: t('failOnStartupShort'),
						text: t('failOnStartup'),
						checked: draft.failOnStartupError === true,
						onChange: (value) => patch({ failOnStartupError: value }),
					}),
					h('span', { className: 'dsg-label', key: 'clone-root-l' }, t('cloneRootLabel')),
					h('div', { className: 'dsg-inline', key: 'clone-root' }, [
						h('input', { key: 'root', className: 'dsg-input', value: draft.cloneRoot, placeholder: data.cloneRoot, onChange: (event) => patch({ cloneRoot: event.target.value }) }),
						h(Button, {
							key: 'pick',
							onClick: async () => {
								try {
									const directory = await props.pickDirectory();
									if (typeof directory === 'string' && directory !== '') patch({ cloneRoot: directory });
								} catch { /* the picker is optional */ }
							},
						}, t('pickDir')),
					]),
				]),
				h('div', { className: 'dsg-actions', key: 'actions' }, [
					h(Button, { key: 'save', variant: 'primary', disabled: busy, onClick: () => save() }, t('saveSettings')),
					h(Button, { key: 'connect', disabled: busy, onClick: () => toggle('connect') }, busy ? t('connecting') : t('connect')),
					h(Button, { key: 'disconnect', disabled: busy || data.mcp.enabled !== true, onClick: () => toggle('disconnect') }, t('disconnect')),
				]),
				message === null ? null : h('div', { key: 'msg', className: message.kind === 'ok' ? 'dsg-ok' : 'dsg-error' }, message.text),
				data.lastError === null || data.lastError === undefined ? null : h('div', { key: 'last', className: 'dsg-error' }, fill(t('lastError'), { message: data.lastError })),
			]);
		}

		/** Tool explorer: filter, inspect parameters, call one tool. */
		function ToolCard(props) {
			const { t, data } = props;
			const [filter, setFilter] = React.useState('');
			const [selected, setSelected] = React.useState(null);
			const [argumentText, setArgumentText] = React.useState('{}');
			const [result, setResult] = React.useState(null);
			const [busy, setBusy] = React.useState(false);

			const needle = filter.trim().toLowerCase();
			const tools = (data.tools ?? []).filter((tool) => needle === ''
				|| tool.shortName.toLowerCase().includes(needle)
				|| String(tool.description ?? '').toLowerCase().includes(needle));
			const active = tools.find((tool) => tool.shortName === selected) ?? null;

			const call = async () => {
				if (active === null) return;
				setBusy(true);
				setResult(null);
				try {
					let parsed;
					try {
						parsed = JSON.parse(argumentText === '' ? '{}' : argumentText);
					} catch (error) {
						setResult({ kind: 'error', text: fill(t('callFailed'), { message: error instanceof Error ? error.message : String(error) }) });
						return;
					}
					const outcome = await request(ROUTES.call, { body: { name: active.shortName, arguments: parsed } });
					if (outcome.ok === false) setResult({ kind: 'error', text: fill(t('callFailed'), { message: outcome.message ?? 'failed' }) });
					else setResult({ kind: outcome.isError === true ? 'error' : 'ok', text: outcome.text ?? '' });
				} catch (error) {
					setResult({ kind: 'error', text: fill(t('callFailed'), { message: error instanceof Error ? error.message : String(error) }) });
				} finally {
					setBusy(false);
				}
			};

			const parameters = active === null ? [] : parameterRows(active.parameters);

			return h(Card, { title: t('toolsCardTitle'), sub: fill(t('toolCount'), { count: (data.tools ?? []).length }) }, [
				h('div', { className: 'dsg-card-sub', key: 'intro', style: { marginBottom: '8px' } }, fill(t('toolsIntro'), { server: data.mcp.serverName })),
				(data.tools ?? []).length === 0
					? h('div', { className: 'dsg-empty', key: 'empty' }, t('toolsEmpty'))
					: [
						h('input', {
							key: 'filter',
							className: 'dsg-input',
							placeholder: t('toolsFilter'),
							value: filter,
							onChange: (event) => setFilter(event.target.value),
						}),
						h('div', { className: 'dsg-tools', key: 'list' }, tools.slice(0, 200).map((tool) => h('button', {
							key: tool.shortName,
							type: 'button',
							className: 'dsg-tool',
							'aria-pressed': tool.shortName === selected ? 'true' : 'false',
							onClick: () => {
								setSelected(tool.shortName);
								setArgumentText('{}');
								setResult(null);
							},
						}, [
							h('div', { className: 'dsg-tool-name', key: 'name' }, tool.shortName),
							h('div', { className: 'dsg-tool-desc', key: 'desc', title: tool.description }, String(tool.description ?? '')),
						]))),
						active === null ? null : h('div', { key: 'detail' }, [
							h('div', { className: 'dsg-label', key: 'params-title', style: { marginTop: '10px' } }, t('params')),
							parameters.length === 0
								? h('div', { className: 'dsg-empty', key: 'no-params' }, t('noParams'))
								: h('ul', { className: 'dsg-params', key: 'params' }, parameters.map((row) => h('li', { key: row.name }, row.text))),
							h('textarea', {
								key: 'args',
								className: 'dsg-textarea',
								value: argumentText,
								onChange: (event) => setArgumentText(event.target.value),
								placeholder: '{}',
							}),
							h('div', { className: 'dsg-actions', key: 'actions' }, [
								h(Button, { key: 'call', variant: 'primary', disabled: busy, onClick: call }, busy ? t('calling') : t('call')),
							]),
							result === null ? null : h('pre', {
								key: 'result',
								className: 'dsg-pre',
								style: result.kind === 'error' ? { color: 'var(--dsw-alias-state-error-primary)' } : undefined,
							}, result.text),
						]),
					],
			]);
		}

		/** Parameter list of one tool schema, required parameters first. */
		function parameterRows(parameters) {
			const properties = parameters !== null && typeof parameters === 'object' ? parameters.properties : undefined;
			if (properties === null || typeof properties !== 'object') return [];
			const required = new Set(Array.isArray(parameters.required) ? parameters.required : []);
			return Object.keys(properties)
				.sort((left, right) => Number(required.has(right)) - Number(required.has(left)))
				.map((name) => {
					const node = properties[name] ?? {};
					const type = typeof node.type === 'string' ? node.type : Array.isArray(node.enum) ? 'enum' : 'any';
					const description = String(node.description ?? '').split('\n')[0].slice(0, 120);
					return {
						name,
						text: `${required.has(name) ? '必填' : '可选'} ${name}: ${type}${description === '' ? '' : ` — ${description}`}`,
					};
				});
		}

		/** 「远程连接仓库」: your account's repositories, pick one, confirm, download. */
		function RepoCard(props) {
			const { t, data, onChanged, onOpenWorkspace } = props;
			const [filter, setFilter] = React.useState('');
			const [listing, setListing] = React.useState({ status: 'idle', account: null, items: [], page: 0, hasMore: false, scanned: 0, error: null });
			const [plan, setPlan] = React.useState(null);
			const [job, setJob] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [message, setMessage] = React.useState(null);
			const [manualOpen, setManualOpen] = React.useState(false);
			const [manual, setManual] = React.useState('');

			const tokenReady = data.token.present === true;

			/**
			 * Switch the app to a downloaded clone's workspace.
			 *
			 * `uiWorkspace.openWorkspace` is the shell's own navigation face (the
			 * same one the conversation header calls). It is a soft dependency: a
			 * host without it, or a workspace since removed, must surface as one
			 * sentence here rather than as an unhandled rejection in the console.
			 */
			const openWorkspace = (entry) => {
				const fail = () => setMessage({ kind: 'error', text: t('openWorkspaceFailed') });
				try {
					const outcome = onOpenWorkspace(entry);
					if (outcome !== null && outcome !== undefined && typeof outcome.then === 'function') {
						outcome.catch(fail);
					}
				} catch {
					fail();
				}
			};

			const load = React.useCallback(async (page, query, append) => {
				setListing((previous) => ({ ...previous, status: 'loading', error: null }));
				try {
					const outcome = await request(`${ROUTES.remote}?page=${String(page)}&q=${encodeURIComponent(query)}`);
					if (outcome.ok !== true) {
						setListing((previous) => ({ ...previous, status: 'error', error: outcome.message ?? 'failed' }));
						return;
					}
					setListing((previous) => ({
						status: 'ready',
						account: outcome.account ?? previous.account,
						items: append === true ? [...previous.items, ...(outcome.items ?? [])] : (outcome.items ?? []),
						page: outcome.page ?? page,
						hasMore: outcome.hasMore === true,
						scanned: outcome.scanned ?? 0,
						error: null,
					}));
				} catch (error) {
					setListing((previous) => ({ ...previous, status: 'error', error: error instanceof Error ? error.message : String(error) }));
				}
			}, []);

			// Load on mount and whenever the search text settles.
			React.useEffect(() => {
				if (tokenReady !== true) return undefined;
				let alive = true;
				const timer = setTimeout(() => { if (alive) void load(1, filter, false); }, filter === '' ? 0 : 450);
				return () => { alive = false; clearTimeout(timer); };
			}, [filter, tokenReady, load]);

			// While a clone runs, follow it; when it settles, refresh the page data.
			React.useEffect(() => {
				if (job === null || job.state !== 'running') return undefined;
				let alive = true;
				const timer = setInterval(async () => {
					try {
						const outcome = await request(`${ROUTES.clone}?id=${encodeURIComponent(job.id)}`);
						if (!alive) return;
						if (outcome.ok === true) {
							setJob(outcome.job);
							if (outcome.job.state !== 'running') onChanged();
						}
					} catch { /* keep polling; a transient failure must not stop the watch */ }
				}, 700);
				return () => { alive = false; clearInterval(timer); };
			}, [job, onChanged]);

			const ask = async (body) => {
				setBusy(true);
				setMessage(null);
				try {
					const outcome = await request(ROUTES.clone, { body });
					if (outcome.ok !== true) setMessage({ kind: 'error', text: outcome.message ?? 'failed' });
					else setPlan(outcome.plan);
				} catch (error) {
					setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
				} finally {
					setBusy(false);
				}
			};

			const confirm = async () => {
				if (plan === null) return;
				setBusy(true);
				setMessage(null);
				try {
					const outcome = await request(ROUTES.clone, {
						body: { repo: plan.fullName, branch: plan.branch, private: plan.private === true, confirm: true },
					});
					if (outcome.ok !== true) setMessage({ kind: 'error', text: outcome.message ?? 'failed' });
					else {
						setJob(outcome.job);
						setPlan(null);
					}
				} catch (error) {
					setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
				} finally {
					setBusy(false);
				}
			};

			const stateColor = job === null ? undefined : job.state === 'done'
				? 'var(--dsw-alias-state-success-primary)'
				: job.state === 'failed' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-warn-primary)';
			const stateText = job === null ? '' : job.state === 'done' ? t('downloadDone') : job.state === 'failed' ? t('downloadFailed') : t('downloading');

			const picker = tokenReady !== true
				? h('div', { className: 'dsg-empty', key: 'need-token' }, t('needToken'))
				: [
					h('div', { className: 'dsg-inline', key: 'account', style: { justifyContent: 'space-between', marginBottom: '6px' } }, [
						h('span', { key: 'left', className: 'dsg-card-sub' }, [
							listing.account === null ? t('accountUnknown') : fill(t('accountLine'), { login: listing.account.login }),
							' · ',
							listing.scanned > 0 && filter.trim() !== ''
								? fill(t('scannedCount'), { scanned: listing.scanned })
								: fill(t('loadedCount'), { loaded: listing.items.length }),
						]),
						h(Button, {
							key: 'refresh',
							disabled: listing.status === 'loading',
							onClick: () => load(1, filter, false),
						}, t('refreshList')),
					]),
					h('input', {
						key: 'search',
						className: 'dsg-input',
						placeholder: t('searchPlaceholder'),
						value: filter,
						onChange: (event) => setFilter(event.target.value),
					}),
					h('div', { className: 'dsg-repolist', key: 'list' },
						(listing.status === 'loading' || listing.status === 'idle') && listing.items.length === 0
							? h('div', { className: 'dsg-repolist-empty', key: 'loading' }, t('loadingRepos'))
							: listing.status === 'error'
								? h('div', { className: 'dsg-repolist-empty dsg-error', key: 'error' }, fill(t('remoteFailed'), { message: listing.error ?? '' }))
								: listing.items.length === 0
									? h('div', { className: 'dsg-repolist-empty', key: 'empty' }, t('noRepos'))
									: listing.items.map((repo) => h('button', {
										key: repo.fullName,
										type: 'button',
										className: 'dsg-repo-row',
										'aria-pressed': plan !== null && plan.fullName === repo.fullName ? 'true' : 'false',
										onClick: () => { setPlan(null); setMessage(null); void ask({ repo: repo.fullName, branch: repo.defaultBranch, private: repo.private }); },
									}, [
										h('span', { className: 'dsg-repo-main', key: 'main' }, [
											h('span', { className: 'dsg-repo-name', key: 'name' }, repo.fullName),
											h('span', { className: 'dsg-repo-meta', key: 'meta', title: repo.description }, [
												repo.description === '' ? t('noDescription') : repo.description,
												' · ',
												fill(t('defaultBranch'), { branch: repo.defaultBranch === '' ? t('unknownBranch') : repo.defaultBranch }),
											].join('')),
										]),
										h('span', { className: repo.private ? 'dsg-tag dsg-tag-private' : 'dsg-tag', key: 'private' }, repo.private ? t('tagPrivate') : t('tagPublic')),
										repo.archived === true ? h('span', { className: 'dsg-tag', key: 'archived' }, t('tagArchived')) : null,
										repo.language === '' ? null : h('span', { className: 'dsg-tag', key: 'lang' }, repo.language),
									])),
					),
					listing.hasMore === true && filter.trim() === ''
						? h('div', { className: 'dsg-actions', key: 'more' }, [
							h(Button, { key: 'more', disabled: listing.status === 'loading', onClick: () => load(listing.page + 1, '', true) }, t('loadMore')),
						])
						: null,
					h('div', { className: 'dsg-actions', key: 'manual' }, [
						h(Button, { key: 'toggle', onClick: () => setManualOpen((open) => open !== true) }, manualOpen === true ? t('manualHide') : t('manualToggle')),
						manualOpen === true ? h('input', {
							key: 'manual',
							className: 'dsg-input',
							style: { flex: '1 1 240px' },
							placeholder: t('repoPlaceholder'),
							value: manual,
							onChange: (event) => setManual(event.target.value),
						}) : null,
						manualOpen === true ? h(Button, {
							key: 'go',
							disabled: busy || manual.trim() === '',
							onClick: () => ask({ repo: manual }),
						}, t('connectRepo')) : null,
					]),
				];

			return h(Card, { title: t('repoCardTitle') }, [
				h('div', { className: 'dsg-card-sub', key: 'intro', style: { marginBottom: '8px' } }, t('repoIntro')),
				h('div', { key: 'picker' }, picker),
				plan === null ? null : h('div', { className: 'dsg-overlay', key: 'confirm' }, [
					h('p', { className: 'dsg-overlay-title', key: 'title' }, t('confirmTitle')),
					h('div', { className: 'dsg-card-sub', key: 'body' }, t('confirmBody')),
					h('div', { className: 'dsg-repo-path', key: 'src' }, fill(t('confirmSource'), { url: plan.cloneUrl })),
					h('div', { className: 'dsg-repo-path', key: 'dest' }, fill(t('confirmTarget'), { dest: plan.dest })),
					plan.branch === '' ? null : h('div', { className: 'dsg-repo-path', key: 'branch' }, fill(t('confirmBranch'), { branch: plan.branch })),
					plan.usesToken === true ? h('div', { className: 'dsg-card-sub', key: 'token' }, t('confirmToken')) : null,
					h('div', { className: 'dsg-actions', key: 'go' }, [
						h(Button, { key: 'go', variant: 'primary', disabled: busy, onClick: confirm }, t('confirmGo')),
						h(Button, { key: 'cancel', onClick: () => setPlan(null) }, t('confirmCancel')),
					]),
				]),
				job === null ? null : h('div', { key: 'job' }, [
					h('div', { key: 'state', style: { color: stateColor, fontSize: '12px', marginTop: '8px' } }, `${stateText} — ${job.repo}${job.state === 'done' ? ` → ${job.dest}` : ''}`),
					job.workspace === null || job.workspace === undefined ? null : h('div', {
						key: 'workspace',
						className: job.workspace.created === true ? 'dsg-ok' : 'dsg-warn',
					}, job.workspace.created === true ? t('workspaceCreated') : fill(t('workspaceFailed'), { reason: job.workspace.reason ?? '' })),
					h('pre', { key: 'log', className: 'dsg-pre' }, (job.log ?? []).slice(-14).join('\n')),
				]),
				message === null ? null : h('div', { key: 'msg', className: 'dsg-error' }, message.text),
				h('div', { key: 'repos-title', className: 'dsg-label', style: { marginTop: '12px' } }, t('reposTitle')),
				(data.repos ?? []).length === 0
					? h('div', { className: 'dsg-empty', key: 'repos-empty' }, t('reposEmpty'))
					: h('div', { className: 'dsg-repos', key: 'repos' }, data.repos.map((entry) => {
						// The host annotates a clone with the workspace that owns its
						// directory; without that id there is nothing to open, so the
						// row falls back to showing the path alone.
						const canOpen = typeof entry.workspaceId === 'string' && entry.workspaceId !== ''
							&& typeof onOpenWorkspace === 'function';
						return h('div', { className: 'dsg-repo', key: entry.path }, [
							h('div', { className: 'dsg-repo-name', key: 'name' }, `${entry.name}${entry.branch === undefined ? '' : ` @${entry.branch}`}`),
							h('div', { className: 'dsg-repo-path', key: 'path' }, entry.path),
							entry.remote === undefined ? null : h('div', { className: 'dsg-repo-path', key: 'remote' }, entry.remote),
							canOpen
								? h('div', { key: 'open', style: { marginTop: '6px' } },
									h(Button, { onClick: () => openWorkspace(entry) }, t('openWorkspace')))
								: null,
						]);
					})),
			]);
		}

		/** Setup-wizard steps, in order. */
		const WIZARD_STEPS = ['transport', 'token', 'connect', 'repos'];

		/** Locale keys for the step names, so the indicator and the body agree. */
		const WIZARD_LABELS = {
			transport: 'wizardStepTransport',
			token: 'wizardStepToken',
			connect: 'wizardStepConnect',
			repos: 'wizardStepRepos',
		};

		/**
		 * Which step a status should open on: whatever is still missing, so a
		 * half-configured install resumes where it stopped instead of starting over.
		 */
		function setupStep(status) {
			const hasToken = status !== null && status !== undefined && status.token?.present === true;
			const mcp = status?.mcp ?? {};
			if (hasToken !== true) return 'token';
			if (mcp.enabled !== true || mcp.phase !== 'active' || (mcp.toolCount ?? 0) === 0) return 'connect';
			return 'repos';
		}

		/**
		 * The first-run向导: 连接方式 → 令牌（先校验再落盘）→ 建立连接 → 下载第一个仓库.
		 *
		 * It is a page inside the settings section rather than a
		 * `settings.onboarding` step on purpose: that slot mounts a blocking
		 * modal that owns `#root` inertness until completed, which is the wrong
		 * weight for an optional integration. This wizard is always reachable,
		 * resumes at the first unfinished step, and can be skipped in one click.
		 */
		function SetupWizard(props) {
			const { t, data, onChanged, onDone, onOpenWorkspace } = props;
			const derived = setupStep(data);
			const [page, setPage] = React.useState(derived);
			const [busy, setBusy] = React.useState(false);
			const [note, setNote] = React.useState(null);
			const [draft, setDraft] = React.useState({
				transport: data.settings.transport,
				url: data.settings.url,
				command: data.settings.command,
				argsText: data.settings.argsText,
				token: '',
			});

			const index = Math.max(0, WIZARD_STEPS.indexOf(page));
			const step = WIZARD_STEPS[index] ?? 'token';
			const tokenReady = data.token.present === true;
			const toolReady = data.mcp.enabled === true && (data.mcp.toolCount ?? 0) > 0;
			const tools = data.tools ?? [];

			/** One route call with the wizard's busy/notice handling. */
			const call = async (path, body) => {
				setBusy(true);
				setNote(null);
				try {
					const outcome = await request(path, { body });
					if (outcome.ok !== true) {
						setNote({ kind: 'error', text: outcome.message ?? outcome.applied?.message ?? 'failed' });
					}
					onChanged();
					return outcome;
				} catch (error) {
					setNote({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
					return null;
				} finally {
					setBusy(false);
				}
			};

			const go = (next) => {
				setNote(null);
				setPage(next);
			};

			const saveTransport = async () => {
				const outcome = await call(ROUTES.settings, {
					settings: {
						transport: draft.transport,
						url: draft.url,
						command: draft.command,
						argsText: draft.argsText,
					},
				});
				if (outcome !== null && outcome.ok === true) go('token');
			};

			/** Report a verified token, or fall back to "saved" on an older host. */
			const reportVerified = (outcome) => {
				if (outcome.verified === true) {
					setNote({ kind: 'ok', text: fill(t('wizardVerified'), { login: outcome.account?.login ?? '?' }) });
				} else {
					// A host generation without the verify branch stores the token
					// and reports nothing; claim only what actually happened.
					setNote({
						kind: 'ok',
						text: fill(t('tokenPresent'), {
							preview: outcome.status?.token?.preview ?? '',
							source: outcome.status?.token?.source ?? '',
						}),
					});
				}
				go('connect');
			};

			const verifyStore = async () => {
				const outcome = await call(ROUTES.token, { token: draft.token, verify: true });
				if (outcome !== null && outcome.ok === true) reportVerified(outcome);
			};

			const verifyEnv = async () => {
				const saved = await call(ROUTES.settings, { settings: { tokenSource: 'env' } });
				if (saved === null || saved.ok !== true) return;
				const checked = await call(ROUTES.token, { verify: true });
				if (checked !== null && checked.ok === true) reportVerified(checked);
			};

			const connectNow = async () => {
				const outcome = await call(ROUTES.connection, { action: 'connect' });
				if (outcome !== null && outcome.ok === true) {
					setNote({
						kind: 'ok',
						text: fill(t('wizardConnectState'), {
							phase: outcome.status?.mcp?.phase ?? 'active',
							count: outcome.status?.mcp?.toolCount ?? 0,
						}),
					});
				}
			};

			/** Finish and skip do the same thing: stop showing the wizard. */
			const leave = async () => {
				await call(ROUTES.settings, { settings: { wizardDone: true } });
				onDone();
			};

			const stepsRow = h('div', { className: 'dsg-steps', key: 'steps' }, WIZARD_STEPS.map((name, at) => h('span', {
				key: name,
				className: at === index ? 'dsg-step dsg-step-active' : at < index ? 'dsg-step dsg-step-done' : 'dsg-step',
			}, `${String(at + 1)}. ${t(WIZARD_LABELS[name])}`)));

			const head = h('div', { className: 'dsg-card-head', key: 'head' }, [
				h('h3', { className: 'dsg-card-title', key: 'title' }, t('wizardTitle')),
				h('span', { className: 'dsg-card-sub', key: 'sub' }, fill(t('wizardProgress'), {
					index: index + 1,
					total: WIZARD_STEPS.length,
					label: t(WIZARD_LABELS[step]),
				})),
			]);

			const noteNode = note === null ? null : h('div', {
				key: 'note',
				className: note.kind === 'ok' ? 'dsg-ok' : 'dsg-error',
			}, note.text);

			const nav = h('div', { className: 'dsg-actions', key: 'nav' }, [
				index > 0 ? h(Button, { key: 'back', disabled: busy, onClick: () => go(WIZARD_STEPS[index - 1]) }, t('wizardBack')) : null,
				step === 'token' && tokenReady === true ? h(Button, { key: 'next', onClick: () => go('connect') }, t('wizardNext')) : null,
				step === 'connect' && toolReady === true ? h(Button, { key: 'next', onClick: () => go('repos') }, t('wizardNext')) : null,
				step === 'repos' ? h(Button, { key: 'finish', variant: 'primary', disabled: busy, onClick: leave }, t('wizardFinish')) : null,
				step !== 'repos' ? h(Button, { key: 'skip', disabled: busy, onClick: leave }, t('wizardSkip')) : null,
			]);

			if (step === 'repos') {
				return h('div', { className: 'dsg-wizard', key: 'wizard' }, [
					h('section', { className: 'dsg-card', key: 'head' }, [head, stepsRow, h('p', { className: 'dsg-card-sub', key: 'intro' }, t('wizardIntroRepos'))]),
					h(RepoCard, { key: 'repo', t, data, onChanged, onOpenWorkspace }),
					noteNode,
					nav,
				]);
			}

			const body = step === 'transport'
				? [
					h('p', { className: 'dsg-card-sub', key: 'intro' }, t('wizardIntroTransport')),
					h('div', { className: 'dsg-grid', key: 'grid' }, [
						h('span', { className: 'dsg-label', key: 'tl' }, t('transportCardTitle')),
						h(Segmented, {
							key: 'transport',
							label: t('transportCardTitle'),
							value: draft.transport,
							options: [
								{ value: 'streamable-http', label: t('transportHttp') },
								{ value: 'stdio', label: t('transportStdio') },
							],
							onChange: (value) => setDraft((previous) => ({ ...previous, transport: value })),
						}),
						draft.transport === 'stdio' ? h('span', { className: 'dsg-label', key: 'cl' }, t('command')) : h('span', { className: 'dsg-label', key: 'ul' }, t('url')),
						draft.transport === 'stdio'
							? h('input', { key: 'command', className: 'dsg-input', value: draft.command, onChange: (event) => setDraft((previous) => ({ ...previous, command: event.target.value })) })
							: h('input', { key: 'url', className: 'dsg-input', value: draft.url, onChange: (event) => setDraft((previous) => ({ ...previous, url: event.target.value })) }),
						draft.transport === 'stdio' ? h('span', { className: 'dsg-label', key: 'al' }, t('args')) : null,
						draft.transport === 'stdio' ? h('input', { key: 'args', className: 'dsg-input', value: draft.argsText, onChange: (event) => setDraft((previous) => ({ ...previous, argsText: event.target.value })) }) : null,
					]),
					h('div', { className: 'dsg-actions', key: 'go' }, [
						h(Button, { key: 'save', variant: 'primary', disabled: busy, onClick: saveTransport }, t('wizardSaveTransport')),
					]),
				]
				: step === 'token'
					? [
						h('p', { className: 'dsg-card-sub', key: 'intro' }, t('wizardIntroToken')),
						h('a', {
							key: 'link',
							className: 'dsg-link',
							href: 'https://github.com/settings/tokens',
							target: '_blank',
							rel: 'noreferrer',
						}, t('wizardOpenTokens')),
						h('div', { className: 'dsg-inline', key: 'row', style: { marginTop: '8px' } }, [
							h('input', {
								key: 'token',
								className: 'dsg-input',
								type: 'password',
								placeholder: t('tokenPlaceholder'),
								value: draft.token,
								onChange: (event) => setDraft((previous) => ({ ...previous, token: event.target.value })),
							}),
							h(Button, {
								key: 'verify',
								variant: 'primary',
								disabled: busy || draft.token.trim() === '',
								onClick: verifyStore,
							}, busy ? t('wizardVerifying') : t('wizardVerify')),
							h(Button, { key: 'env', disabled: busy, onClick: verifyEnv }, t('wizardUseEnv')),
						]),
						tokenReady === true
							? h('div', { key: 'present', className: 'dsg-ok' }, fill(t('tokenPresent'), { preview: data.token.preview, source: data.token.source }))
							: h('div', { key: 'absent', className: 'dsg-card-sub' }, t('wizardTokenNeeded')),
					]
					: [
						h('p', { className: 'dsg-card-sub', key: 'intro' }, t('wizardIntroConnect')),
						h('div', { key: 'state', className: 'dsg-card-sub' }, fill(t('wizardConnectState'), {
							phase: data.mcp.phase ?? t('phaseUnknown'),
							count: data.mcp.toolCount,
						})),
						tokenReady !== true ? h('div', { key: 'need', className: 'dsg-warn' }, t('wizardTokenNeeded')) : null,
						tools.length > 0
							? h('ul', { className: 'dsg-params', key: 'tools' }, tools.slice(0, 6).map((tool) => h('li', { key: tool.shortName }, tool.shortName)))
							: null,
						h('div', { className: 'dsg-hint', key: 'hint' }, t('wizardConnectHint')),
						h('div', { className: 'dsg-actions', key: 'go' }, [
							h(Button, {
								key: 'connect',
								variant: 'primary',
								disabled: busy || tokenReady !== true,
								onClick: connectNow,
							}, busy ? t('wizardConnectWait') : t('wizardConnectNow')),
							h(Button, { key: 'again', disabled: busy, onClick: onChanged }, t('refresh')),
						]),
					];

			return h('section', { className: 'dsg-card dsg-wizard', key: 'wizard' }, [head, stepsRow, h('div', { key: 'body' }, body), noteNode, nav]);
		}

		/** The registered settings page. */
		function GitHubSection(props) {
			const { t, ctx } = props;
			const [nonce, setNonce] = React.useState(0);
			const [showAdvanced, setShowAdvanced] = React.useState(false);
			const state = useStatus(nonce);
			useStyles(ctx);

			const reload = React.useCallback(() => setNonce((value) => value + 1), []);
			const pickDirectory = React.useCallback(async () => {
				const service = ctx.get('uiWorkspace');
				return typeof service?.pickDirectory === 'function' ? service.pickDirectory() : null;
			}, [ctx]);

			/**
			 * Open one downloaded clone's workspace through the shell's own
			 * navigation face. Throws when the service is absent so `RepoCard` can
			 * report it in one sentence instead of failing silently.
			 *
			 * @param entry - one `repos` row from `/api/github.status` (carries `workspaceId`).
			 */
			const openWorkspace = React.useCallback((entry) => {
				const service = ctx.get('uiWorkspace');
				if (typeof service?.openWorkspace !== 'function') {
					throw new Error('uiWorkspace.openWorkspace is unavailable');
				}
				return service.openWorkspace(entry.workspaceId, () => {});
			}, [ctx]);

			const head = h('div', { className: 'dsg-head', key: 'head' }, [
				h('div', { key: 'text', style: { flex: '1 1 auto', minWidth: '0' } }, [
					h('h3', { className: 'dsg-title', key: 'title' }, t('title')),
					h('div', { className: 'dsg-intro', key: 'intro' }, t('intro')),
				]),
				h('div', { className: 'dsg-inline', key: 'actions' }, [
					h(Button, { key: 'refresh', onClick: reload }, t('refresh')),
				]),
			]);

			if (state.status === 'loading' && state.data === null) {
				return h('div', { className: 'dsg-root' }, [head, h('div', { className: 'dsg-status', key: 'loading' }, t('loading'))]);
			}
			if (state.status === 'error' && state.data === null) {
				return h('div', { className: 'dsg-root' }, [head, h('div', { className: 'dsg-status dsg-error', key: 'error' }, fill(t('failed'), { message: state.error }) )]);
			}

			const data = state.data;
			const connected = data.mcp.enabled === true && data.mcp.toolCount > 0;
			const stateText = data.mcp.found !== true
				? t('stateMissing')
				: connected ? t('stateConnected') : data.mcp.enabled === true ? t('stateEnabled') : t('stateDisabled');
			const stateColor = connected
				? 'var(--dsw-alias-state-success-primary)'
				: data.mcp.found !== true ? 'var(--dsw-alias-state-error-primary)' : data.mcp.enabled === true ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-secondary)';

			// The wizard owns an unconfigured install; the detail cards appear
			// once it is done (or on demand from the wizard's advanced toggle).
			const wizardOpen = data.settings.wizardDone !== true;
			const cards = (wizardOpen === true && showAdvanced !== true) ? null : [
				h(TokenCard, { key: 'token', t, data, onChanged: reload }),
				h(TransportCard, { key: 'transport', t, data, onChanged: reload, pickDirectory }),
				h(ToolCard, { key: 'tools', t, data }),
				h(RepoCard, { key: 'repo', t, data, onChanged: reload, onOpenWorkspace: openWorkspace }),
			];

			return h('div', { className: 'dsg-root' }, [
				head,
				h('div', { className: 'dsg-strip', key: 'strip' }, [
					h(Stat, {
						key: 'state',
						color: stateColor,
						label: t('statusTitle'),
						value: stateText,
						hint: fill(t('phase'), { phase: data.mcp.phase ?? t('phaseUnknown') }),
					}),
					h(Stat, {
						key: 'tools',
						color: 'var(--dsw-alias-state-warn-primary)',
						label: t('toolsCardTitle'),
						value: fill(t('toolCount'), { count: data.mcp.toolCount }),
						hint: data.mcp.endpoint,
					}),
					h(Stat, {
						key: 'repo',
						color: 'var(--dsw-alias-state-success-primary)',
						label: t('reposTitle'),
						value: String((data.repos ?? []).length),
						hint: data.cloneRoot,
					}),
				]),
				data.git?.ok === false ? h('div', { key: 'git', className: 'dsg-warn' }, fill(t('gitMissing'), { reason: data.git.reason })) : null,
				wizardOpen === true
					? h(SetupWizard, { key: 'wizard', t, data, onChanged: reload, onDone: reload, onOpenWorkspace: openWorkspace })
					: null,
				wizardOpen === true
					? h('div', { className: 'dsg-actions', key: 'advanced' }, [
						h(Button, { key: 'toggle', onClick: () => setShowAdvanced((open) => open !== true) }, showAdvanced === true ? t('wizardHideAdvanced') : t('wizardAdvanced')),
					])
					: null,
				cards,
				h('div', { className: 'dsg-card-sub', key: 'footer' }, [
					h('span', { key: 'command' }, data.command?.listed === true
						? fill(t('catalog'), { list: (data.command.catalog ?? []).map((row) => `/${String(row.name)}`).join(' ') })
						: t('catalogMissing')),
					h('span', { key: 'sep' }, ' · '),
					h('span', { key: 'store' }, fill(t('store'), { dir: data.storeDir })),
					wizardOpen === true ? null : h('span', { key: 'rerun' }, [
						h('span', { key: 'sep2' }, ' · '),
						h('button', {
							key: 'rerun',
							type: 'button',
							className: 'dsg-linkbutton',
							onClick: async () => {
								await request(ROUTES.settings, { body: { settings: { wizardDone: false } } });
								reload();
							},
						}, t('wizardRerun')),
					]),
				]),
			]);
		}

		const name = 'dsh-github';
		const inject = ['slots', 'locale'];

		/**
		 * Mount the GitHub page into the settings panel.
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			const slots = ctx.get('slots');
			if (slots === undefined) return;
			const locale = ctx.get('locale');
			const t = locale.bind(NS);
			ctx.effect(() => locale.register(NS, dicts), 'dsh-github: dictionaries');
			slots.inject('settings.section', () => slots.register({
				name: 'settings.section',
				id: SECTION_ID,
				order: SECTION_ORDER,
				locale: NS,
				label: () => t('title'),
			}, (props) => h(GitHubSection, {
				ctx,
				t,
				close: props.close,
			})));
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		exports.NS = NS;
		exports.ROUTES = ROUTES;
		exports.fill = fill;
		exports.parameterRows = parameterRows;
		exports.GitHubSection = GitHubSection;
		exports.SetupWizard = SetupWizard;
		exports.setupStep = setupStep;
		exports.WIZARD_STEPS = WIZARD_STEPS;
		exports.WIZARD_LABELS = WIZARD_LABELS;
		exports.TokenCard = TokenCard;
		exports.TransportCard = TransportCard;
		exports.ToolCard = ToolCard;
		exports.RepoCard = RepoCard;

		module.exports = exports;
		return module.exports;
	},
});
