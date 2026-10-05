/**
 * Account pool — browser half.
 *
 * Registers one `settings.section` page ("账号池") that renders the pool's
 * live state: which accounts exist, which are cooling and for how long, the
 * sticky bindings, and the most recent usage records.
 *
 * Every number comes from the Host half over its two authenticated routes on
 * the `/api` channel. The page makes no other network request and never sees a
 * credential: the account rows it reads contain `credentialRef` (an opaque
 * handle) and nothing more.
 *
 * Shipped as a DSH client bundle (`window.__ModuleLoader__.load`), hand-written
 * in plain JavaScript: React arrives through the module table, and the page is
 * built with createElement so no build step is required to edit it.
 */
window.__ModuleLoader__.load({
	id: 'dsh-account-pool',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');
		const h = React.createElement;

		/** Host routes this page reads and writes; document-relative, like the app's other routes. */
		const ACCOUNTS_ROUTE = 'api/accountPool.accounts';
		const USAGE_ROUTE = 'api/accountPool.usage';
		const ACTION_ROUTE = 'api/accountPool.account';
		/** Locale namespace owned by this plugin. */
		const NS = 'settings.accountPool';
		/** Settings nav cell: fresh id, right after the usage page. */
		const SECTION_ID = 'accountPool';
		const SECTION_ORDER = 14;
		/** Slots the Models page exposes for a provider directory row and the area after the add controls. */
		const FOOTER_SLOT = 'settings.models.footer';
		const PROVIDER_CARD_SLOT = 'settings.models.provider-card';
		const FOOTER_ORDER = 20;
		/**
		 * The provider-card key is the Loader ENTRY ID (that is what the Host half
		 * declares as `settingsNs`), and cordis.patch.yml pins that id.
		 */
		const ENTRY_ID = 'account-pool';
		/** Platforms the form offers; must stay in step with the domain enum. */
		const PLATFORMS = ['anthropic', 'openai', 'gemini', 'grok', 'custom'];
		/** How many usage rows to show. */
		const USAGE_LIMIT = 50;

		const zh = {
			title: '账号池',
			intro: '本机账号池：上游账号的调度状态、冷却窗口与最近用量。密钥不在本页显示，账号行只持有一个凭据引用。',
			refresh: '刷新',
			loading: '正在读取账号池…',
			noConnection: '当前环境没有可用的连接',
			empty: '账号池还没有账号。在插件配置里加入账号后重启该条目即可。',
			cardAccounts: '账号',
			cardAccountsHint: '可用 {ready} · 冷却 {cooling} · 异常 {failed}',
			cardRequests: '累计请求',
			cardRequestsHint: '自本插件安装以来',
			cardBindings: '粘性绑定',
			cardBindingsHint: '会话 → 账号',
			accountsTitle: '账号',
			usageTitle: '最近用量',
			colAccount: '账号',
			colPlatform: '平台',
			colStatus: '状态',
			colPriority: '优先级',
			colSlots: '并发',
			colCooling: '冷却剩余',
			colFailures: '连续失败',
			colTime: '时间',
			colModel: '模型',
			colTokens: '输入 / 输出 / 缓存读',
			colSwitches: '换号',
			colResult: '结果',
			colActions: '操作',
			actEnable: '启用',
			actDisable: '停用',
			actPrefer: '设为优先',
			actClear: '清冷却',
			actWorking: '处理中…',
			actFailed: '操作失败：{message}',
			preferred: '当前优先',
			modelsTitle: '号池管理',
			modelsHint: '选择一个账号作为首选，或在「账号池」页管理全部账号。',
			modelsEmpty: '账号池还没有账号，先到「账号池」页添加。',
			providerTitle: '号池',
			providerHint: '{total} 个账号 · 可用 {ready} · 冷却 {cooling}',
			colCredential: '凭据',
			addAccount: '新增账号',
			editAccount: '编辑',
			deleteAccount: '删除',
			confirmDelete: '确认删除',
			save: '保存',
			cancel: '取消',
			saving: '保存中…',
			formCreate: '新增账号',
			formEdit: '编辑账号 {id}',
			fieldId: 'ID（唯一，创建后不可改）',
			fieldLabel: '标签',
			fieldPlatform: '平台',
			fieldBaseUrl: '上游地址',
			fieldCredential: '密钥',
			fieldCredentialKeep: '留空表示不修改',
			fieldModels: '模型（逗号分隔，留空=全部）',
			fieldPriority: '优先级（越小越优先）',
			fieldWeight: '权重',
			fieldConcurrency: '并发上限（0=不限）',
			credConfigured: '已配置',
			credMissing: '未配置',
			credReadOnly: '只读',
			credSource: '来源 {source}',
			importAction: '导入',
			importTitle: '导入号池',
			importHint: '粘贴 sub2api 管理员备份，或 CPA auth 文件（JSON）。支持 {data:{accounts:[…]}}、裸数组、单个账号／单个 CPA 文件。',
			importRun: '开始导入',
			importPlaceholder: '{ "data": { "accounts": [ … ] } }',
			importDone: '导入 {created} 个，报告 {errors} 条问题',
			importTarget: '导入到分组',
			importTargetNone: '不分组',
			groupsTitle: '分组',
			groupAdd: '新建分组',
			groupEmpty: '还没有分组。分组会作为独立的模型提供商出现（号池-组名），可在「模型」页直接切换。',
			groupMembers: '{n} 个账号',
			groupRoutes: '路由',
			formGroupCreate: '新建分组',
			formGroupEdit: '编辑分组 {id}',
			fieldGroupId: 'ID（会成为路由后缀：号池-<ID>）',
			fieldGroupLabel: '名称',
			fieldGroupModels: '模型白名单（逗号分隔，留空=不限）',
			fieldGroupDescription: '说明',
			colGroups: '分组',
			fieldGroups: '所属分组',
			noGroups: '未分组',
			statusActive: '可用',
			statusError: '异常',
			statusDisabled: '已停用',
			statusCooling: '冷却中',
			none: '—',
			ok: '成功',
			failed: '失败',
			reasonRateLimit: '限流',
			reasonOverload: '过载',
			reasonAuthFail: '鉴权失败',
			reasonTransport: '传输故障',
			secondsShort: '{n} 秒',
			minutesShort: '{n} 分',
			hoursShort: '{n} 小时',
			footer: '仅本机 · 数据来自插件自己的 domain 表',
		};

		const en = {
			title: 'Account pool',
			intro: 'Local account pool: scheduling state, cooling windows and recent usage. Secrets are never shown here — an account row holds only a credential reference.',
			refresh: 'Refresh',
			loading: 'Reading the account pool…',
			noConnection: 'No usable connection in this environment',
			empty: 'The pool has no accounts yet. Add accounts to the plugin config and reload the entry.',
			cardAccounts: 'Accounts',
			cardAccountsHint: '{ready} ready · {cooling} cooling · {failed} failed',
			cardRequests: 'Total requests',
			cardRequestsHint: 'Since this plugin was installed',
			cardBindings: 'Sticky bindings',
			cardBindingsHint: 'session → account',
			accountsTitle: 'Accounts',
			usageTitle: 'Recent usage',
			colAccount: 'Account',
			colPlatform: 'Platform',
			colStatus: 'Status',
			colPriority: 'Priority',
			colSlots: 'Slots',
			colCooling: 'Cooling for',
			colFailures: 'Failures',
			colTime: 'Time',
			colModel: 'Model',
			colTokens: 'in / out / cache-read',
			colSwitches: 'Switches',
			colResult: 'Result',
			colActions: 'Actions',
			actEnable: 'Enable',
			actDisable: 'Disable',
			actPrefer: 'Make preferred',
			actClear: 'Clear cooldown',
			actWorking: 'Working…',
			actFailed: 'Action failed: {message}',
			preferred: 'preferred',
			modelsTitle: 'Account pool',
			modelsHint: 'Pick an account to prefer, or manage the whole pool on the Account pool page.',
			modelsEmpty: 'The pool has no accounts yet — add them on the Account pool page.',
			providerTitle: 'Account pool',
			providerHint: '{total} accounts · {ready} ready · {cooling} cooling',
			colCredential: 'Credential',
			addAccount: 'Add account',
			editAccount: 'Edit',
			deleteAccount: 'Delete',
			confirmDelete: 'Confirm delete',
			save: 'Save',
			cancel: 'Cancel',
			saving: 'Saving…',
			formCreate: 'New account',
			formEdit: 'Edit account {id}',
			fieldId: 'ID (unique, cannot change later)',
			fieldLabel: 'Label',
			fieldPlatform: 'Platform',
			fieldBaseUrl: 'Base URL',
			fieldCredential: 'API key',
			fieldCredentialKeep: 'Leave blank to keep',
			fieldModels: 'Models (comma separated; blank = all)',
			fieldPriority: 'Priority (lower wins)',
			fieldWeight: 'Weight',
			fieldConcurrency: 'Concurrency cap (0 = unlimited)',
			credConfigured: 'set',
			credMissing: 'unset',
			credReadOnly: 'read-only',
			credSource: 'from {source}',
			importAction: 'Import',
			importTitle: 'Import a pool',
			importHint: 'Paste a sub2api admin backup, or CPA auth files (JSON). Accepts {data:{accounts:[…]}}, a bare array, a single account, or a single CPA file.',
			importRun: 'Import',
			importPlaceholder: '{ "data": { "accounts": [ … ] } }',
			importDone: 'Imported {created}; {errors} problem(s) reported',
			importTarget: 'Import into group',
			importTargetNone: 'No group',
			groupsTitle: 'Groups',
			groupAdd: 'New group',
			groupEmpty: 'No groups yet. Each group appears as its own model provider (pool-<id>) and can be switched on the Models page.',
			groupMembers: '{n} account(s)',
			groupRoutes: 'Routes',
			formGroupCreate: 'New group',
			formGroupEdit: 'Edit group {id}',
			fieldGroupId: 'ID (becomes the route suffix: pool-<ID>)',
			fieldGroupLabel: 'Name',
			fieldGroupModels: 'Model allow-list (comma separated; blank = any)',
			fieldGroupDescription: 'Description',
			colGroups: 'Groups',
			fieldGroups: 'Groups',
			noGroups: 'ungrouped',
			statusActive: 'ready',
			statusError: 'failed',
			statusDisabled: 'disabled',
			statusCooling: 'cooling',
			none: '—',
			ok: 'ok',
			failed: 'failed',
			reasonRateLimit: 'rate limit',
			reasonOverload: 'overload',
			reasonAuthFail: 'auth',
			reasonTransport: 'transport',
			secondsShort: '{n}s',
			minutesShort: '{n}m',
			hoursShort: '{n}h',
			footer: 'Local only · read from the plugin’s own domain tables',
		};

		const dicts = { zh, en };

		const CSS = `
.dap-root{display:flex;flex-direction:column;gap:14px;padding:2px 0 4px}
.dap-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}
.dap-head-text{flex:1 1 auto;min-width:0}
.dap-title{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dap-intro{margin:4px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dap-refresh{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm,6px);padding:2px 10px;font:inherit;font-size:12px;line-height:20px;cursor:pointer}
.dap-refresh:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.dap-cards{display:flex;gap:10px;flex-wrap:wrap}
.dap-card{flex:1 1 170px;min-width:0;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1);padding:10px 12px}
.dap-card-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dap-card-value{margin-top:2px;font-size:20px;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.dap-card-hint{margin-top:2px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dap-panel{border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dap-panel-head{display:flex;align-items:baseline;gap:8px;padding:10px 12px 8px}
.dap-panel-title{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dap-table{width:100%;border-collapse:collapse;font-size:12px}
.dap-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-secondary);padding:6px 12px;border-top:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.dap-table td{padding:6px 12px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);vertical-align:top}
.dap-num{font-variant-numeric:tabular-nums;white-space:nowrap}
.dap-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
.dap-dim{color:var(--dsw-alias-label-secondary)}
.dap-pill{display:inline-block;border-radius:999px;padding:0 7px;font-size:11px;line-height:16px;border:1px solid transparent}
.dap-pill-ready{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.dap-pill-cooling{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dap-pill-failed{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dap-pill-idle{color:var(--dsw-alias-state-idle-primary);border-color:var(--dsw-alias-border-l2)}
.dap-status{padding:12px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dap-foot{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dap-actions{display:flex;gap:6px;flex-wrap:wrap}
.dap-btn{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm,6px);padding:0 7px;font:inherit;font-size:11px;line-height:18px;cursor:pointer;white-space:nowrap}
.dap-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.dap-btn:disabled{opacity:.5;cursor:default}
.dap-btn-primary{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dap-error{font-size:11px;color:var(--dsw-alias-state-error-primary)}
.dap-models{display:flex;flex-direction:column;gap:8px;border:1px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px);padding:10px 12px}
.dap-models-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.dap-models-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dap-models-hint{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dap-models-row{display:flex;align-items:center;gap:8px;font-size:12px;padding:4px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.dap-models-name{font-weight:500;color:var(--dsw-alias-label-primary)}
.dap-preferred{font-size:11px;color:var(--dsw-alias-brand-primary)}
.dap-form{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2);padding:12px;display:flex;flex-direction:column;gap:10px}
.dap-form-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dap-form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px 12px}
.dap-field{display:flex;flex-direction:column;gap:3px;min-width:0}
.dap-field-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dap-input{border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:20px;padding:2px 7px;min-width:0}
.dap-form-actions{display:flex;gap:8px}
.dap-cred-set{color:var(--dsw-alias-state-success-primary);font-size:11px}
.dap-cred-missing{color:var(--dsw-alias-state-warn-primary);font-size:11px}
.dap-textarea{min-height:130px;width:100%;box-sizing:border-box;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;white-space:pre;resize:vertical}
.dap-head-actions{display:flex;gap:8px;align-items:flex-start}
`;

		/** Insert this plugin's stylesheet once, from `apply`. */
		function insertStyles(ctx) {
			return ctx.effect(() => {
				const element = document.createElement('style');
				element.setAttribute('data-dsh-plugin', 'dsh-account-pool');
				element.textContent = CSS;
				document.head.appendChild(element);
				return () => {
					if (element.parentNode !== null) element.parentNode.removeChild(element);
				};
			}, 'account-pool: stylesheet');
		}

		/** Read one Host route; `nonce` re-runs it. */
		function useJson(route, nonce, t) {
			const [state, setState] = React.useState({ status: 'loading', body: null, error: null });
			React.useEffect(() => {
				let alive = true;
				setState((previous) => ({ status: 'loading', body: previous.body, error: null }));
				(async () => {
					try {
						if (typeof fetch !== 'function') throw new Error(t('noConnection'));
						const response = await fetch(route, {
							method: 'GET',
							headers: { accept: 'application/json' },
							credentials: 'same-origin',
						});
						const body = await response.json().catch(() => null);
						if (!alive) return;
						if (!response.ok || body === null) {
							throw new Error(body?.error?.message ?? `HTTP ${String(response.status)}`);
						}
						setState({ status: 'ready', body, error: null });
					} catch (error) {
						if (!alive) return;
						setState({ status: 'error', body: null, error: error instanceof Error ? error.message : String(error) });
					}
				})();
				return () => { alive = false; };
			}, [route, nonce, t]);
			return state;
		}

		/**
		 * Run one operator action against the Host's single write route.
		 *
		 * Only one action may be in flight at a time (`pending` disables every
		 * button) because each one rewrites the same account records; letting two
		 * race would make the `prefer` ranking depend on arrival order.
		 */
		function useAction(refresh, t) {
			const [state, setState] = React.useState({ pending: false, error: null });
			const [busyId, setBusyId] = React.useState(null);
			function run(id, action, extra) {
				setState({ pending: true, error: null });
				setBusyId(id);
				// Returns a promise resolving to whether it succeeded, so a form can
				// stay open on failure instead of silently closing.
				return (async () => {
					try {
						if (typeof fetch !== 'function') throw new Error(t('noConnection'));
						const response = await fetch(ACTION_ROUTE, {
							method: 'POST',
							headers: { 'content-type': 'application/json', accept: 'application/json' },
							credentials: 'same-origin',
							body: JSON.stringify({ id, action, ...(extra ?? {}) }),
						});
						const body = await response.json().catch(() => null);
						if (!response.ok || body === null || body.ok !== true) {
							throw new Error(body?.error?.message ?? `HTTP ${String(response.status)}`);
						}
						setState({ pending: false, error: null });
						setBusyId(null);
						refresh();
						return true;
					} catch (error) {
						setState({ pending: false, error: error instanceof Error ? error.message : String(error) });
						setBusyId(null);
						return false;
					}
				})();
			}
			return { pending: state.pending, busyId, error: state.error, run };
		}

		const WINDOWS = [
			['rateLimitResetAt', 'reasonRateLimit'],
			['overloadUntil', 'reasonOverload'],
			['tempUnschedulableUntil', 'reasonTransport'],
		];

		/** The furthest-future cooling window on one account, or null. */
		function coolingOf(account, now) {
			let best = null;
			for (const [field, reasonKey] of WINDOWS) {
				const raw = account[field];
				if (typeof raw !== 'string') continue;
				const until = Date.parse(raw);
				if (Number.isNaN(until) || until <= now) continue;
				if (best === null || until > best.until) {
					best = { until, field, reasonKey: account.tempUnschedulableReason === 'auth-fail' && field === 'tempUnschedulableUntil' ? 'reasonAuthFail' : reasonKey };
				}
			}
			return best;
		}

		function statusOf(account, now) {
			if (account.status === 'error') return { key: 'statusError', tone: 'failed' };
			if (account.status === 'disabled') return { key: 'statusDisabled', tone: 'idle' };
			if (coolingOf(account, now) !== null) return { key: 'statusCooling', tone: 'cooling' };
			return { key: 'statusActive', tone: 'ready' };
		}

		function formatRemaining(ms, t) {
			const seconds = Math.max(0, Math.round(ms / 1000));
			if (seconds < 90) return t('secondsShort', { n: String(seconds) });
			const minutes = Math.round(seconds / 60);
			if (minutes < 90) return t('minutesShort', { n: String(minutes) });
			return t('hoursShort', { n: String(Math.round(minutes / 60)) });
		}

		function compact(value) {
			const n = Number(value);
			if (!Number.isFinite(n)) return '0';
			if (n < 1000) return String(n);
			if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
			return `${(n / 1_000_000).toFixed(1)}M`;
		}

		function Pill(props) {
			return h('span', { className: `dap-pill dap-pill-${props.tone}` }, props.children);
		}

		function Card(props) {
			return h('div', { className: 'dap-card' }, [
				h('div', { className: 'dap-card-label', key: 'l' }, props.label),
				h('div', { className: 'dap-card-value', key: 'v' }, props.value),
				props.hint === undefined ? null : h('div', { className: 'dap-card-hint', key: 'h' }, props.hint),
			]);
		}

		function AccountRow(props) {
			const { account, now, t, action, pool } = props;
			const cooling = coolingOf(account, now);
			const status = statusOf(account, now);
			const busy = action.pending && action.busyId === account.id;
			const disabled = account.status === 'disabled';
			// The host sends a SUMMARY of the credential, never the secret itself.
			const credential = account.credential ?? { configured: false, writable: false };
			const confirming = pool.confirmingId === account.id;
			return h('tr', null, [
				h('td', { key: 'a' }, [
					h('div', null, account.label === '' ? account.id : account.label),
					account.label === '' ? null : h('div', { className: 'dap-mono dap-dim', key: 'id' }, account.id),
				]),
				h('td', { key: 'p', className: 'dap-dim' }, account.platform),
				h('td', { key: 's' }, h(Pill, { tone: status.tone }, t(status.key))),
				h('td', { key: 'g', className: 'dap-dim' }, (account.groups ?? []).length === 0
					? t('noGroups')
					: account.groups.join(', ')),
				h('td', { key: 'pr', className: 'dap-num' }, String(account.priority)),
				h('td', { key: 'c', className: 'dap-num' }, account.concurrency === 0 ? '∞' : String(account.concurrency)),
				h('td', { key: 'w', className: 'dap-num' }, cooling === null
					? t('none')
					: `${formatRemaining(cooling.until - now, t)} · ${t(cooling.reasonKey)}`),
				h('td', { key: 'f', className: 'dap-num' }, String(account.consecutiveFailures ?? 0)),
				h('td', { key: 'cr' }, h('span', {
					className: credential.configured ? 'dap-cred-set' : 'dap-cred-missing',
					title: credential.source === undefined ? '' : t('credSource', { source: credential.source }),
				}, `${t(credential.configured ? 'credConfigured' : 'credMissing')}${credential.configured && credential.writable === false ? ` · ${t('credReadOnly')}` : ''}`)),
				h('td', { key: 'x' }, h('div', { className: 'dap-actions' }, [
					h('button', {
						key: 'toggle', type: 'button', className: 'dap-btn',
						disabled: action.pending,
						onClick: () => action.run(account.id, disabled ? 'enable' : 'disable'),
					}, busy ? t('actWorking') : (disabled ? t('actEnable') : t('actDisable'))),
					cooling === null ? null : h('button', {
						key: 'clear', type: 'button', className: 'dap-btn',
						disabled: action.pending,
						onClick: () => action.run(account.id, 'clear-cooldown'),
					}, t('actClear')),
					props.preferred === true
						? h('span', { key: 'is-preferred', className: 'dap-preferred' }, t('preferred'))
						: h('button', {
							key: 'prefer', type: 'button', className: 'dap-btn dap-btn-primary',
							disabled: action.pending,
							onClick: () => action.run(account.id, 'prefer'),
						}, t('actPrefer')),
					h('button', {
						key: 'edit', type: 'button', className: 'dap-btn',
						disabled: action.pending, onClick: () => pool.onEdit(account),
					}, t('editAccount')),
					h('button', {
						key: 'delete', type: 'button', className: 'dap-btn',
						disabled: action.pending, onClick: () => pool.onDelete(account),
					}, confirming ? t('confirmDelete') : t('deleteAccount')),
				])),
			]);
		}

		function UsageRow(props) {
			const { row, t } = props;
			return h('tr', null, [
				h('td', { key: 't', className: 'dap-dim dap-num' }, row.at.slice(11, 19)),
				h('td', { key: 'a', className: 'dap-mono' }, row.accountId === '' ? t('none') : row.accountId),
				h('td', { key: 'm', className: 'dap-dim' }, row.model === '' ? t('none') : row.model),
				h('td', { key: 'k', className: 'dap-num' }, [
					compact(row.inputTokens), ' / ', compact(row.outputTokens), ' / ', compact(row.cacheReadTokens),
				]),
				h('td', { key: 's', className: 'dap-num' }, String(row.accountSwitches)),
				h('td', { key: 'r' }, h(Pill, { tone: row.ok ? 'ready' : 'failed' }, t(row.ok ? 'ok' : 'failed'))),
			]);
		}

		/**
		 * One labelled input. A plain function component (no hooks), so it is safe
		 * for the offline test's tree expander to invoke.
		 */
		function Field(props) {
			return h('label', { className: 'dap-field' }, [
				h('span', { className: 'dap-field-label', key: 'l' }, props.label),
				h('input', {
					key: 'i',
					className: 'dap-input',
					type: props.type ?? 'text',
					value: props.value,
					placeholder: props.placeholder,
					onChange: (event) => props.onChange(event.target.value),
				}),
			]);
		}

		/** Add / edit form. The secret is write-only: it is never pre-filled. */
		function AccountForm(props) {
			const { t, mode, initial, configured, pending, error, onSave, onCancel, allGroups } = props;
			const [values, setValues] = React.useState(() => ({ ...initial }));
			const [credential, setCredential] = React.useState('');
			const set = (key) => (value) => setValues((previous) => ({ ...previous, [key]: value }));

			function submit() {
				onSave({
					id: values.id,
					account: {
						label: values.label,
						platform: values.platform,
						baseUrl: values.baseUrl === '' ? null : values.baseUrl,
						models: String(values.models).split(',').map((part) => part.trim()).filter((part) => part !== ''),
						groups: values.groups ?? [],
						priority: Number(values.priority),
						weight: Number(values.weight),
						concurrency: Number(values.concurrency),
					},
					// `undefined` means "leave the stored secret alone".
					credential: credential === '' ? undefined : credential,
				});
			}

			return h('div', { className: 'dap-form' }, [
				h('div', { className: 'dap-form-title', key: 'title' },
					mode === 'create' ? t('formCreate') : t('formEdit', { id: values.id })),
				h('div', { className: 'dap-form-grid', key: 'grid' }, [
					mode === 'create' ? h(Field, { key: 'id', label: t('fieldId'), value: values.id, onChange: set('id') }) : null,
					h(Field, { key: 'label', label: t('fieldLabel'), value: values.label, onChange: set('label') }),
					h('label', { className: 'dap-field', key: 'platform' }, [
						h('span', { className: 'dap-field-label', key: 'l' }, t('fieldPlatform')),
						h('select', {
							key: 's', className: 'dap-input', value: values.platform,
							onChange: (event) => set('platform')(event.target.value),
						}, PLATFORMS.map((name) => h('option', { key: name, value: name }, name))),
					]),
					h(Field, { key: 'baseUrl', label: t('fieldBaseUrl'), value: values.baseUrl, onChange: set('baseUrl') }),
					h(Field, {
						key: 'credential', label: t('fieldCredential'), type: 'password', value: credential,
						placeholder: configured ? t('credConfigured') : t('fieldCredentialKeep'),
						onChange: setCredential,
					}),
					h(Field, { key: 'models', label: t('fieldModels'), value: values.models, onChange: set('models') }),
					h(Field, { key: 'priority', label: t('fieldPriority'), value: values.priority, onChange: set('priority') }),
					h(Field, { key: 'weight', label: t('fieldWeight'), value: values.weight, onChange: set('weight') }),
					h(Field, { key: 'concurrency', label: t('fieldConcurrency'), value: values.concurrency, onChange: set('concurrency') }),
				]),
				// Membership is a set of checkboxes drawn from the groups that actually
				// exist, so assigning one cannot introduce a typo the host would reject.
				(allGroups ?? []).length === 0 ? null : h('div', { className: 'dap-field', key: 'groups' }, [
					h('span', { className: 'dap-field-label', key: 'l' }, t('fieldGroups')),
					h('div', { className: 'dap-actions', key: 'c' }, allGroups.map((group) => h(
						'label',
						{ key: group.id, className: 'dap-models-hint' },
						[
							h('input', {
								key: 'i',
								type: 'checkbox',
								checked: (values.groups ?? []).includes(group.id),
								onChange: () => setValues((previous) => {
									const current = previous.groups ?? [];
									return {
										...previous,
										groups: current.includes(group.id)
											? current.filter((id) => id !== group.id)
											: [...current, group.id],
									};
								}),
							}),
							h('span', { key: 's' }, group.label === '' ? group.id : group.label),
						],
					))),
				]),
				error === null ? null : h('div', { className: 'dap-error', key: 'err' }, error),
				h('div', { className: 'dap-form-actions', key: 'actions' }, [
					h('button', {
						key: 'save', type: 'button', className: 'dap-btn dap-btn-primary',
						disabled: pending, onClick: submit,
					}, pending ? t('saving') : t('save')),
					h('button', {
						key: 'cancel', type: 'button', className: 'dap-btn',
						disabled: pending, onClick: onCancel,
					}, t('cancel')),
				]),
			]);
		}

		/**
		 * Group create / edit form.
		 *
		 * The id is fixed after creation because it IS the provider route suffix —
		 * renaming a group would silently change the route anyone had selected.
		 */
		function GroupForm(props) {
			const { t, mode, initial, pending, error, onSave, onCancel } = props;
			const [values, setValues] = React.useState(() => ({ ...initial }));
			const set = (key) => (value) => setValues((previous) => ({ ...previous, [key]: value }));

			function submit() {
				onSave({
					id: values.id,
					group: {
						label: values.label,
						description: values.description,
						models: String(values.models).split(',').map((part) => part.trim()).filter((part) => part !== ''),
					},
				});
			}

			return h('div', { className: 'dap-form' }, [
				h('div', { className: 'dap-form-title', key: 'title' },
					mode === 'create' ? t('formGroupCreate') : t('formGroupEdit', { id: values.id })),
				h('div', { className: 'dap-form-grid', key: 'grid' }, [
					mode === 'create' ? h(Field, { key: 'id', label: t('fieldGroupId'), value: values.id, onChange: set('id') }) : null,
					h(Field, { key: 'label', label: t('fieldGroupLabel'), value: values.label, onChange: set('label') }),
					h(Field, { key: 'models', label: t('fieldGroupModels'), value: values.models, onChange: set('models') }),
					h(Field, { key: 'description', label: t('fieldGroupDescription'), value: values.description, onChange: set('description') }),
				]),
				error === null ? null : h('div', { className: 'dap-error', key: 'err' }, error),
				h('div', { className: 'dap-form-actions', key: 'actions' }, [
					h('button', {
						key: 'save', type: 'button', className: 'dap-btn dap-btn-primary',
						disabled: pending, onClick: submit,
					}, pending ? t('saving') : t('save')),
					h('button', {
						key: 'cancel', type: 'button', className: 'dap-btn',
						disabled: pending, onClick: onCancel,
					}, t('cancel')),
				]),
			]);
		}

		function PoolSection(props) {
			const { ctx, t } = props;

			const [nonce, setNonce] = React.useState(0);
			const action = useAction(() => setNonce((value) => value + 1), t);
			const accounts = useJson(ACCOUNTS_ROUTE, nonce, t);
			const usage = useJson(`${USAGE_ROUTE}?limit=${String(USAGE_LIMIT)}`, nonce, t);
			const [now, setNow] = React.useState(() => Date.now());
			const [editing, setEditing] = React.useState(null);
			const [confirmingId, setConfirmingId] = React.useState(null);
			const [importing, setImporting] = React.useState(null);
			const [importGroup, setImportGroup] = React.useState('');
			const [editingGroup, setEditingGroup] = React.useState(null);

			/** Row-level handlers plus the pending delete confirmation. */
			const pool = {
				confirmingId,
				onEdit: (account) => {
					setConfirmingId(null);
					setEditing({
						mode: 'edit',
						id: account.id,
						configured: account.credential?.configured === true,
						initial: {
							id: account.id,
							label: account.label ?? '',
							platform: account.platform,
							baseUrl: account.baseUrl ?? '',
							models: (account.models ?? []).join(', '),
							groups: [...(account.groups ?? [])],
							priority: String(account.priority),
							weight: String(account.weight ?? 0),
							concurrency: String(account.concurrency ?? 0),
						},
					});
				},
				// Two clicks: the first arms, the second deletes. Deleting an account
				// takes its credential with it, so a stray click must not do it.
				onDelete: (account) => {
					if (confirmingId !== account.id) { setConfirmingId(account.id); return; }
					setConfirmingId(null);
					void action.run(account.id, 'delete');
				},
			};

			function startCreate() {
				setConfirmingId(null);
				setEditing({
					mode: 'create',
					id: '',
					configured: false,
					initial: {
						id: '', label: '', platform: PLATFORMS[0], baseUrl: '',
						models: '', groups: [], priority: '100', weight: '0', concurrency: '4',
					},
				});
			}

			async function saveForm(payload) {
				const verb = editing.mode === 'create' ? 'create' : 'update';
				const ok = await action.run(payload.id, verb, {
					account: payload.account,
					// Omit the key entirely when untouched: the host treats `undefined`
					// as "leave the stored secret alone".
					...(payload.credential === undefined ? {} : { credential: payload.credential }),
				});
				if (ok) setEditing(null);
			}

			const form = editing === null ? null : h(AccountForm, {
				key: 'form',
				t,
				mode: editing.mode,
				initial: editing.initial,
				configured: editing.configured === true,
				pending: action.pending,
				error: action.error,
				onSave: saveForm,
				onCancel: () => setEditing(null),
				// Read inline: the `allGroups` const is declared further down, and a
				// `const` does not hoist.
				allGroups: accounts.body?.groups ?? [],
			});

			async function runImport() {
				const ok = await action.run('', 'import', {
					document: importing ?? '',
					// Omitted entirely when "no group" is chosen, so the default stays
					// "ungrouped" rather than an empty group id the host would reject.
					...(importGroup === '' ? {} : { group: importGroup }),
				});
				// `run` refreshes on success; just close the box.
				if (ok) setImporting(null);
			}

			const importPanel = importing === null ? null : h('div', { className: 'dap-form', key: 'import' }, [
				h('div', { className: 'dap-form-title', key: 'title' }, t('importTitle')),
				h('p', { className: 'dap-intro', key: 'hint' }, t('importHint')),
				// Read the groups off the body inline: the `allGroups` const is declared
				// further down and a `const` does not hoist.
				(accounts.body?.groups ?? []).length === 0 ? null : h('label', { className: 'dap-field', key: 'target' }, [
					h('span', { className: 'dap-field-label', key: 'l' }, t('importTarget')),
					h('select', {
						key: 's', className: 'dap-input', value: importGroup,
						onChange: (event) => setImportGroup(event.target.value),
					}, [
						h('option', { key: '__none', value: '' }, t('importTargetNone')),
						...accounts.body.groups.map((group) => h(
							'option',
							{ key: group.id, value: group.id },
							group.label === '' ? group.id : group.label,
						)),
					]),
				]),
				h('textarea', {
					key: 'body',
					className: 'dap-input dap-textarea',
					value: importing,
					placeholder: t('importPlaceholder'),
					onChange: (event) => setImporting(event.target.value),
				}),
				h('div', { className: 'dap-form-actions', key: 'actions' }, [
					h('button', {
						key: 'run', type: 'button', className: 'dap-btn dap-btn-primary',
						disabled: action.pending || importing.trim() === '',
						onClick: runImport,
					}, action.pending ? t('saving') : t('importRun')),
					h('button', {
						key: 'cancel', type: 'button', className: 'dap-btn',
						disabled: action.pending, onClick: () => setImporting(null),
					}, t('cancel')),
				]),
			]);

			// --- groups ----------------------------------------------------------
			const allGroups = accounts.body?.groups ?? [];
			const groupCounts = new Map();
			// `list` is declared further down, and a `const` does not hoist — read the
			// body directly here instead of relying on declaration order.
			for (const account of accounts.body?.accounts ?? []) {
				for (const id of account.groups ?? []) groupCounts.set(id, (groupCounts.get(id) ?? 0) + 1);
			}

			function startGroupCreate() {
				setEditingGroup({
					mode: 'create',
					id: '',
					initial: { id: '', label: '', models: '', description: '' },
				});
			}

			function startGroupEdit(group) {
				setEditingGroup({
					mode: 'edit',
					id: group.id,
					initial: {
						id: group.id,
						label: group.label ?? '',
						models: (group.models ?? []).join(', '),
						description: group.description ?? '',
					},
				});
			}

			async function saveGroup(payload) {
				const verb = editingGroup.mode === 'create' ? 'group-create' : 'group-update';
				const ok = await action.run(payload.id, verb, { group: payload.group });
				if (ok) setEditingGroup(null);
			}

			const groupForm = editingGroup === null ? null : h(GroupForm, {
				key: 'groupform',
				t,
				mode: editingGroup.mode,
				initial: editingGroup.initial,
				pending: action.pending,
				error: action.error,
				onSave: saveGroup,
				onCancel: () => setEditingGroup(null),
			});

			const groupsPanel = h('div', { className: 'dap-panel', key: 'groups' }, [
				h('div', { className: 'dap-panel-head', key: 'h' }, [
					h('h4', { className: 'dap-panel-title', key: 't' }, t('groupsTitle')),
					h('button', {
						className: 'dap-refresh', key: 'add', type: 'button', onClick: startGroupCreate,
					}, t('groupAdd')),
				]),
				groupForm,
				allGroups.length === 0
					? h('div', { className: 'dap-status', key: 'empty' }, t('groupEmpty'))
					: h('div', { className: 'dap-status', key: 'list', style: undefined }, allGroups.map((group) => h(
						'div',
						{ className: 'dap-models-row', key: group.id },
						[
							h('span', { className: 'dap-models-name', key: 'n' }, group.label === '' ? group.id : group.label),
							// Showing the real route makes it obvious what appears in the Models page.
							h('span', { className: 'dap-mono dap-dim', key: 'r' }, `pool-${group.id}`),
							h('span', { className: 'dap-models-hint', key: 'm' }, t('groupMembers', { n: String(groupCounts.get(group.id) ?? 0) })),
							group.models.length === 0 ? null : h('span', { className: 'dap-models-hint', key: 'l' }, group.models.join(', ')),
							h('button', {
								key: 'e', type: 'button', className: 'dap-btn',
								disabled: action.pending, onClick: () => startGroupEdit(group),
							}, t('editAccount')),
							h('button', {
								key: 'd', type: 'button', className: 'dap-btn',
								disabled: action.pending,
								// One click, unlike account delete: a group owns no accounts, so
								// deleting one is recoverable by recreating it.
								onClick: () => { void action.run(group.id, 'group-delete'); },
							}, t('deleteAccount')),
						],
					))),
			]);

			// Ticking clock so "cooling for" counts down without a refetch.
			React.useEffect(() => {
				const timer = setInterval(() => setNow(Date.now()), 1000);
				return () => clearInterval(timer);
			}, []);

			const list = accounts.body?.accounts ?? [];
			const counts = { ready: 0, cooling: 0, failed: 0 };
			for (const account of list) {
				const tone = statusOf(account, now).tone;
				if (tone === 'ready') counts.ready += 1;
				else if (tone === 'cooling') counts.cooling += 1;
				else if (tone === 'failed') counts.failed += 1;
			}
			// The lowest priority value is the one the scheduler reaches first.
			const best = list.reduce(
				(lowest, account) => (Number.isFinite(account.priority) ? Math.min(lowest, account.priority) : lowest),
				Number.POSITIVE_INFINITY,
			);

			const head = h('div', { className: 'dap-head', key: 'head' }, [
				h('div', { className: 'dap-head-text', key: 'text' }, [
					h('h3', { className: 'dap-title', key: 'title' }, t('title')),
					h('p', { className: 'dap-intro', key: 'intro' }, t('intro')),
				]),
				h('div', { className: 'dap-head-actions', key: 'actions' }, [
					h('button', {
						className: 'dap-refresh', key: 'import', type: 'button',
						onClick: () => setImporting((current) => (current === null ? '' : null)),
					}, t('importAction')),
					h('button', {
						className: 'dap-refresh', key: 'add', type: 'button',
						onClick: startCreate,
					}, t('addAccount')),
					h('button', {
						className: 'dap-refresh', key: 'refresh', type: 'button',
						onClick: () => setNonce((value) => value + 1),
					}, t('refresh')),
				]),
			]);

			if (accounts.status === 'loading' && accounts.body === null) {
				return h('div', { className: 'dap-root' }, [head, h('div', { className: 'dap-status', key: 'loading' }, t('loading'))]);
			}
			if (accounts.status === 'error' && accounts.body === null) {
				return h('div', { className: 'dap-root' }, [head, h('div', { className: 'dap-status', key: 'error' }, accounts.error)]);
			}

			const cards = h('div', { className: 'dap-cards', key: 'cards' }, [
				h(Card, {
					key: 'a', label: t('cardAccounts'), value: String(list.length),
					hint: t('cardAccountsHint', { ready: String(counts.ready), cooling: String(counts.cooling), failed: String(counts.failed) }),
				}),
				h(Card, {
					key: 'r', label: t('cardRequests'), value: compact(accounts.body?.totalRequests ?? 0),
					hint: t('cardRequestsHint'),
				}),
				h(Card, {
					key: 'b', label: t('cardBindings'), value: String((accounts.body?.bindings ?? []).length),
					hint: t('cardBindingsHint'),
				}),
			]);

			const accountPanel = h('div', { className: 'dap-panel', key: 'accounts' }, [
				h('div', { className: 'dap-panel-head', key: 'h' }, h('h4', { className: 'dap-panel-title' }, t('accountsTitle'))),
				action.error === null ? null : h('div', { className: 'dap-status dap-error', key: 'err' }, t('actFailed', { message: action.error })),
				form,
				importPanel,
				list.length === 0
					? h('div', { className: 'dap-status', key: 'empty' }, t('empty'))
					: h('table', { className: 'dap-table', key: 'table' }, [
						h('thead', { key: 'head' }, h('tr', null, [
							h('th', { key: 'a' }, t('colAccount')),
							h('th', { key: 'p' }, t('colPlatform')),
							h('th', { key: 's' }, t('colStatus')),
							h('th', { key: 'g' }, t('colGroups')),
							h('th', { key: 'cr' }, t('colCredential')),
							h('th', { key: 'pr' }, t('colPriority')),
							h('th', { key: 'c' }, t('colSlots')),
							h('th', { key: 'w' }, t('colCooling')),
							h('th', { key: 'f' }, t('colFailures')),
							h('th', { key: 'x' }, t('colActions')),
						])),
						h('tbody', { key: 'body' }, list.map((account) => h(AccountRow, {
							key: account.id,
							account,
							now,
							t,
							action,
							pool,
							preferred: Number.isFinite(account.priority) && account.priority === best,
						}))),
					]),
			]);

			const rows = usage.body?.rows ?? [];
			const usagePanel = h('div', { className: 'dap-panel', key: 'usage' }, [
				h('div', { className: 'dap-panel-head', key: 'h' }, h('h4', { className: 'dap-panel-title' }, t('usageTitle'))),
				rows.length === 0
					? h('div', { className: 'dap-status', key: 'empty' }, t('none'))
					: h('table', { className: 'dap-table', key: 'table' }, [
						h('thead', { key: 'head' }, h('tr', null, [
							h('th', { key: 't' }, t('colTime')),
							h('th', { key: 'a' }, t('colAccount')),
							h('th', { key: 'm' }, t('colModel')),
							h('th', { key: 'k' }, t('colTokens')),
							h('th', { key: 's' }, t('colSwitches')),
							h('th', { key: 'r' }, t('colResult')),
						])),
						h('tbody', { key: 'body' }, rows.map((row, index) => h(UsageRow, { key: `${row.at}-${String(index)}`, row, t }))),
					]),
			]);

			return h('div', { className: 'dap-root' }, [
				head, cards, accountPanel, groupsPanel, usagePanel,
				h('div', { className: 'dap-foot', key: 'foot' }, t('footer')),
			]);
		}

		/**
		 * The 「号池管理」 card in the Models page footer — the seat the official
		 * slot description reserves for exactly this ("ordered extension area after
		 * the provider rows and the add controls"). It is a switching surface: one
		 * click makes an account preferred, without leaving the Models page.
		 */
		function ModelsPoolCard(props) {
			const { ctx, t } = props;
			const [nonce, setNonce] = React.useState(0);
			const action = useAction(() => setNonce((value) => value + 1), t);
			const accounts = useJson(ACCOUNTS_ROUTE, nonce, t);
			const list = accounts.body?.accounts ?? [];
			const now = Date.now();

			if (accounts.status === 'error' && accounts.body === null) {
				return h('div', { className: 'dap-models' }, h('div', { className: 'dap-error' }, accounts.error));
			}

			// The lowest priority value is the one the scheduler reaches first.
			const best = list.reduce(
				(lowest, account) => (Number.isFinite(account.priority) ? Math.min(lowest, account.priority) : lowest),
				Number.POSITIVE_INFINITY,
			);

			return h('div', { className: 'dap-models' }, [
				h('div', { className: 'dap-models-head', key: 'head' }, [
					h('span', { className: 'dap-models-title', key: 'title' }, t('modelsTitle')),
					h('span', { className: 'dap-models-hint', key: 'hint' }, t('modelsHint')),
				]),
				action.error === null ? null : h('div', { className: 'dap-error', key: 'err' }, t('actFailed', { message: action.error })),
				list.length === 0
					? h('div', { className: 'dap-models-hint', key: 'empty' }, t('modelsEmpty'))
					: h('div', { key: 'list' }, list.map((account) => {
						const status = statusOf(account, now);
						const isPreferred = Number.isFinite(account.priority) && account.priority === best;
						return h('div', { className: 'dap-models-row', key: account.id }, [
							h('span', { className: 'dap-models-name', key: 'n' }, account.label === '' ? account.id : account.label),
							h(Pill, { key: 's', tone: status.tone }, t(status.key)),
							isPreferred ? h('span', { className: 'dap-preferred', key: 'p' }, t('preferred')) : null,
							h('button', {
								key: 'b', type: 'button', className: 'dap-btn dap-btn-primary',
								disabled: action.pending || isPreferred,
								onClick: () => action.run(account.id, 'prefer'),
							}, t('actPrefer')),
						]);
					})),
			]);
		}

		/** Summary line rendered on the `pool` provider's own Models card. */
		function ProviderPoolCard(props) {
			const { t } = props;
			const accounts = useJson(ACCOUNTS_ROUTE, 0, t);
			const list = accounts.body?.accounts ?? [];
			const now = Date.now();
			const counts = { ready: 0, cooling: 0 };
			for (const account of list) {
				const tone = statusOf(account, now).tone;
				if (tone === 'ready') counts.ready += 1;
				else if (tone === 'cooling') counts.cooling += 1;
			}
			return h('div', { className: 'dap-models-hint' }, t('providerHint', {
				total: String(list.length), ready: String(counts.ready), cooling: String(counts.cooling),
			}));
		}

		function apply(ctx) {
			const slots = ctx.get('slots');
			if (slots === undefined) return;
			const locale = ctx.get('locale');
			const t = locale.bind(NS);

			ctx.effect(() => locale.register(NS, dicts), 'account-pool: dictionaries');
			insertStyles(ctx);

			// 1. The standalone settings page.
			slots.inject('settings.section', () => slots.register({
				name: 'settings.section',
				id: SECTION_ID,
				order: SECTION_ORDER,
				locale: NS,
				label: () => t('title'),
			}, (props) => h(PoolSection, { ctx, t, close: props.close })));

			// 2. The switching card next to "add a model provider".
			slots.inject(FOOTER_SLOT, () => slots.register({
				name: FOOTER_SLOT,
				id: SECTION_ID,
				order: FOOTER_ORDER,
				locale: NS,
				label: () => t('modelsTitle'),
			}, (props) => h(ModelsPoolCard, { ctx, t, close: props.close })));

			// 3. The `pool` provider's own card, keyed by the Loader entry id — the
			//    same value the Host half declares as `settingsNs`.
			slots.inject(PROVIDER_CARD_SLOT, () => slots.register({
				name: PROVIDER_CARD_SLOT,
				key: ENTRY_ID,
			}, (props) => h(ProviderPoolCard, { ctx, t, close: props.close })));
		}

		exports.name = 'dsh-account-pool';
		exports.inject = ['slots', 'locale'];
		exports.apply = apply;
		exports.SECTION_ID = SECTION_ID;
		exports.SECTION_ORDER = SECTION_ORDER;
		exports.FOOTER_SLOT = FOOTER_SLOT;
		exports.PROVIDER_CARD_SLOT = PROVIDER_CARD_SLOT;
		exports.ENTRY_ID = ENTRY_ID;
		exports.ACTION_ROUTE = ACTION_ROUTE;
		exports.NS = NS;
		// Pure helpers, exported so the offline test can exercise the state
		// derivation without a renderer.
		exports.coolingOf = coolingOf;
		exports.statusOf = statusOf;
		exports.formatRemaining = formatRemaining;
		exports.compact = compact;
		exports.WINDOWS = WINDOWS;

		module.exports = exports;
		return module.exports;
	},
});
