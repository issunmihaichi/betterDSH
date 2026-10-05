/**
 * dsh-mcp-skills — browser half.
 *
 * Registers one `settings.section` page ("MCP 与技能") with two tabs:
 *
 *   MCP 服务器    every `mcp-*` row the Loader is running: transport, endpoint,
 *                 live phase, how many tools it contributed to the model, an
 *                 enable/disable switch, and a JSON editor for its config.
 *
 *   技能库        every skill the registry serves: where it came from, which
 *                 provider owns it, whether the model may invoke it, and its
 *                 full body on demand.
 *
 * All data comes from the Host half over the authenticated `/api` channel using
 * ordinary document-relative `fetch`, exactly like the app's own pages. Shipped
 * as a DSH client bundle (`window.__ModuleLoader__.load`), hand-written in plain
 * JavaScript: React arrives through the module table and the panels are built
 * with createElement, so no build step is needed to edit this file.
 */
window.__ModuleLoader__.load({
	id: 'dsh-mcp-skills',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');
		const h = React.createElement;

		/** Host routes this page reads; document-relative, like the app's own. */
		const ROUTE_STATUS = 'api/mcpskills.status';
		const ROUTE_MCP_TOGGLE = 'api/mcpskills.mcp.toggle';
		const ROUTE_MCP_CONFIG = 'api/mcpskills.mcp.config';
		const ROUTE_SKILL_GET = 'api/mcpskills.skill';
		const ROUTE_SKILL_TOGGLE = 'api/mcpskills.skill.toggle';

		/** Locale namespace owned by this plugin. */
		const NS = 'settings.mcpSkills';
		/** Settings nav cell. */
		const SECTION_ID = 'mcp-skills';
		const SECTION_ORDER = 15;

		const zh = {
			title: 'MCP 与技能',
			subtitle: '统一查看本机已挂载的 MCP 服务器与技能库；启停即时生效，配置改动会被写回你的 profile 补丁层。',
			tabMcp: 'MCP 服务器',
			tabSkills: '技能库',
			refresh: '刷新',
			loading: '正在读取…',
			failed: '读取失败：{message}',
			emptyMcp: '还没有配置任何 MCP 服务器。可以用下面的「编辑配置」为现有行写入配置，或在 profile 的 cordis.patch.yml 里插入一行 mcp-* 。',
			emptySkills: '技能库是空的：既没有内置技能，也没有在技能根目录下发现 SKILL.md。',
			enabled: '已启用',
			disabled: '已停用',
			phaseActive: '运行中',
			phaseLoading: '加载中',
			phasePending: '等待中',
			phaseFailed: '加载失败',
			serverName: '标识',
			transport: '传输',
			endpoint: '地址',
			tools: '工具',
			toolCount: '{count} 个',
			showTools: '查看工具',
			hideTools: '收起工具',
			editConfig: '编辑配置',
			configTitle: '{name} 的配置',
			configHint: '密钥类字段显示为 ***；直接保存会保留原值，只有你改写它才会变化。',
			save: '保存',
			saving: '保存中…',
			saved: '已保存',
			cancel: '关闭',
			badJson: '配置不是合法 JSON。',
			skillView: '查看',
			skillModel: '模型可调用',
			skillUser: '用户可调用',
			skillSource: '来源',
			skillProvider: '提供方',
			skillNoPath: '该技能没有本地文件，无法切换',
			skillTitle: '{name}',
			mcpSummary: '{total} 个服务器 · 已启用 {enabled} · 已停用 {disabled} · 共 {tools} 个工具',
			skillSummary: '{total} 个技能 · 模型可调用 {model}',
			rootsFrom: '项目目录：{cwd}',
			localOnly: '仅本机'
		};

		const en = {
			title: 'MCP & Skills',
			subtitle: 'Every MCP server and skill this machine has mounted. Toggles apply immediately; config edits are written back to your profile patch layer.',
			tabMcp: 'MCP servers',
			tabSkills: 'Skills',
			refresh: 'Refresh',
			loading: 'Loading…',
			failed: 'Failed: {message}',
			emptyMcp: 'No MCP servers configured yet. Use “Edit config” on an existing row, or insert an mcp-* row in your profile cordis.patch.yml.',
			emptySkills: 'The skill registry is empty: no bundled skills and no SKILL.md found under the skill roots.',
			enabled: 'Enabled',
			disabled: 'Disabled',
			phaseActive: 'running',
			phaseLoading: 'loading',
			phasePending: 'pending',
			phaseFailed: 'failed',
			serverName: 'Name',
			transport: 'Transport',
			endpoint: 'Endpoint',
			tools: 'Tools',
			toolCount: '{count}',
			showTools: 'Show tools',
			hideTools: 'Hide tools',
			editConfig: 'Edit config',
			configTitle: 'Config of {name}',
			configHint: 'Credential fields show as ***; saving keeps the stored value unless you change it.',
			save: 'Save',
			saving: 'Saving…',
			saved: 'Saved',
			cancel: 'Close',
			badJson: 'Config is not valid JSON.',
			skillView: 'View',
			skillModel: 'Model-invocable',
			skillUser: 'User-invocable',
			skillSource: 'Source',
			skillProvider: 'Provider',
			skillNoPath: 'This skill has no local file to switch',
			skillTitle: '{name}',
			mcpSummary: '{total} servers · {enabled} enabled · {disabled} disabled · {tools} tools',
			skillSummary: '{total} skills · {model} model-invocable',
			rootsFrom: 'Project directory: {cwd}',
			localOnly: 'Local only'
		};

		const dicts = { zh, en };

		/** Substitute `{name}` placeholders. */
		function fill(text, values) {
			return String(text).replace(/\{(\w+)\}/g, (whole, key) => (values !== undefined && key in values ? String(values[key]) : whole));
		}

		const C = {
			text: 'var(--dsw-alias-label-primary)',
			dim: 'var(--dsw-alias-label-secondary)',
			faint: 'var(--dsw-alias-label-tertiary)',
			border: 'var(--dsw-alias-border-l1)',
			layer: 'var(--dsw-alias-bg-layer-1)',
			ok: 'var(--dsw-alias-state-success-primary)',
			warn: 'var(--dsw-alias-state-warn-primary)',
			err: 'var(--dsw-alias-state-error-primary)',
		};

		function Button({ children, onClick, disabled, kind }) {
			const primary = kind === 'primary';
			return h('button', {
				onClick,
				disabled: disabled === true,
				style: {
					padding: '4px 10px',
					fontSize: 12,
					borderRadius: 8,
					cursor: disabled === true ? 'default' : 'pointer',
					opacity: disabled === true ? 0.5 : 1,
					border: '1px solid ' + (primary ? 'transparent' : C.border),
					background: primary ? 'var(--dsw-alias-brand-primary)' : C.layer,
					color: primary ? '#fff' : C.text,
				},
			}, children);
		}

		function Toggle({ checked, onChange, disabled }) {
			return h('button', {
				onClick: () => { if (disabled !== true) onChange(!checked); },
				disabled: disabled === true,
				style: {
					width: 38,
					height: 20,
					borderRadius: 999,
					border: '1px solid ' + C.border,
					background: checked ? C.ok : 'transparent',
					position: 'relative',
					cursor: disabled === true ? 'default' : 'pointer',
					opacity: disabled === true ? 0.5 : 1,
					flex: '0 0 auto',
				},
			}, h('span', {
				style: {
					position: 'absolute',
					top: 2,
					left: checked ? 20 : 2,
					width: 14,
					height: 14,
					borderRadius: '50%',
					background: '#fff',
					transition: 'left .15s',
				},
			}));
		}

		function Card({ children }) {
			return h('div', {
				style: {
					border: '1px solid ' + C.border,
					borderRadius: 10,
					padding: '10px 12px',
					background: C.layer,
					display: 'flex',
					flexDirection: 'column',
					gap: 6,
				},
			}, children);
		}

		function Badge({ text, tone }) {
			const color = tone === 'ok' ? C.ok : tone === 'err' ? C.err : tone === 'warn' ? C.warn : C.faint;
			return h('span', {
				style: {
					fontSize: 11,
					padding: '1px 7px',
					borderRadius: 999,
					border: '1px solid ' + color,
					color,
					whiteSpace: 'nowrap',
				},
			}, text);
		}

		function Empty({ text }) {
			return h('div', { style: { color: C.faint, fontSize: 12, padding: '10px 2px' } }, text);
		}

		function Modal({ title, hint, children, onClose, t }) {
			return h('div', {
				style: {
					position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)',
					display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60,
				},
				onClick: onClose,
			}, h('div', {
				onClick: (event) => event.stopPropagation(),
				style: {
					background: 'var(--dsw-alias-bg-base, #fff)', border: '1px solid ' + C.border,
					borderRadius: 12, padding: 16, width: 'min(760px, 92vw)', maxHeight: '82vh',
					display: 'flex', flexDirection: 'column', gap: 10, overflow: 'auto',
				},
			}, [
				h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
					h('div', { key: 'title', style: { fontSize: 14, fontWeight: 600, color: C.text, flex: 1 } }, title),
					h(Button, { key: 'close', onClick: onClose }, t('cancel')),
				]),
				hint === undefined ? null : h('div', { key: 'hint', style: { fontSize: 12, color: C.faint } }, hint),
				h('div', { key: 'body' }, children),
			]));
		}

		/** Read a JSON endpoint, turning any failure into a thrown Error. */
		async function readJson(url, init) {
			const response = await fetch(url, init);
			const text = await response.text();
			let body;
			try {
				body = text === '' ? {} : JSON.parse(text);
			} catch {
				throw new Error('HTTP ' + String(response.status) + ' ' + text.slice(0, 200));
			}
			if (!response.ok) throw new Error(body?.message ?? ('HTTP ' + String(response.status)));
			return body;
		}

		const PHASE = {
			active: ['phaseActive', 'ok'],
			loading: ['phaseLoading', 'warn'],
			pending: ['phasePending', 'warn'],
			failed: ['phaseFailed', 'err'],
		};

		/** One MCP server row. */
		function McpRow({ row, t, busy, onToggle, onEdit }) {
			const [open, setOpen] = React.useState(false);
			const phase = PHASE[row.phase];
			return h(Card, null, [
				h('div', { key: 'top', style: { display: 'flex', alignItems: 'center', gap: 10 } }, [
					h(Toggle, {
						key: 'toggle',
						checked: row.enabled,
						disabled: busy || row.entryId === null,
						onChange: (next) => onToggle(row, next),
					}),
					h('div', { key: 'name', style: { flex: 1, minWidth: 0 } }, [
						h('div', { style: { fontSize: 13, color: C.text, fontWeight: 600 } }, row.serverName),
						h('div', {
							style: { fontSize: 11, color: C.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
						}, row.transport + ' · ' + row.endpoint),
					]),
					h(Badge, { key: 'enabled', text: row.enabled ? t('enabled') : t('disabled'), tone: row.enabled ? 'ok' : 'muted' }),
					phase === undefined ? null : h(Badge, { key: 'phase', text: t(phase[0]), tone: phase[1] }),
				]),
				h('div', { key: 'bottom', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
					h('span', { key: 'tools', style: { fontSize: 12, color: C.dim } }, t('tools') + ': ' + fill(t('toolCount'), { count: row.toolCount })),
					row.tools.length === 0 ? null : h(Button, { key: 'expand', onClick: () => setOpen(!open) }, open ? t('hideTools') : t('showTools')),
					h(Button, { key: 'edit', onClick: () => onEdit(row), disabled: row.editable !== true }, t('editConfig')),
				]),
				row.error === null || row.error === undefined ? null : h('div', { key: 'err', style: { fontSize: 12, color: C.err } }, row.error),
				open ? h('div', {
					key: 'toolList',
					style: { fontSize: 12, color: C.dim, display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 },
				}, row.tools.slice(0, 40).map((tool) => h('div', { key: tool.fullName }, '• ' + tool.name))) : null,
			]);
		}

		/** One skill row. */
		function SkillRow({ item, t, busy, onToggle, onView }) {
			const canToggle = typeof item.path === 'string' && item.path !== '' && /SKILL\.md$/i.test(item.path);
			return h(Card, null, [
				h('div', { key: 'top', style: { display: 'flex', alignItems: 'center', gap: 10 } }, [
					canToggle ? h(Toggle, {
						key: 'toggle',
						checked: item.modelInvocable,
						disabled: busy,
						onChange: (next) => onToggle(item, next),
					}) : null,
					h('div', { key: 'name', style: { flex: 1, minWidth: 0 } }, [
						h('div', { style: { fontSize: 13, color: C.text, fontWeight: 600 } }, item.name),
						h('div', { style: { fontSize: 12, color: C.dim } }, item.description),
					]),
					h(Badge, { key: 'src', text: item.source, tone: 'muted' }),
					h(Button, { key: 'view', onClick: () => onView(item) }, t('skillView')),
				]),
				h('div', { key: 'meta', style: { fontSize: 11, color: C.faint, display: 'flex', gap: 10, flexWrap: 'wrap' } }, [
					h('span', { key: 'provider' }, t('skillProvider') + ': ' + (item.provider === '' ? '—' : item.provider)),
					h('span', { key: 'model' }, t('skillModel') + ': ' + (item.modelInvocable ? '✓' : '✗')),
					h('span', { key: 'user' }, t('skillUser') + ': ' + (item.userInvocable ? '✓' : '✗')),
					canToggle ? null : h('span', { key: 'nopath', style: { color: C.warn } }, t('skillNoPath')),
				]),
			]);
		}

		/** The settings page itself. */
		function Panel({ ctx, t, tRaw }) {
			const [data, setData] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [tab, setTab] = React.useState('mcp');
			const [note, setNote] = React.useState(null);
			const [config, setConfig] = React.useState(null);
			const [skill, setSkill] = React.useState(null);
			const alive = React.useRef(true);

			React.useEffect(() => () => { alive.current = false; }, []);

			const load = React.useCallback(async () => {
				try {
					const body = await readJson(ROUTE_STATUS);
					if (!alive.current) return;
					setData(body);
					setError(null);
				} catch (err) {
					if (!alive.current) return;
					setError(err?.message ?? String(err));
				}
			}, []);

			React.useEffect(() => { void load(); }, [load]);

			const run = async (fn) => {
				setBusy(true);
				setNote(null);
				try {
					const outcome = await fn();
					if (outcome !== undefined && outcome.status !== undefined) setData(outcome.status);
					return outcome;
				} catch (err) {
					setError(err?.message ?? String(err));
					return undefined;
				} finally {
					setBusy(false);
				}
			};

			const toggleMcp = (row, next) => run(async () => {
				const outcome = await readJson(ROUTE_MCP_TOGGLE, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ entryId: row.entryId, patchId: row.patchId, enabled: next }),
				});
				setNote(row.serverName + ': ' + (next ? t('enabled') : t('disabled')));
				return outcome;
			}).catch(() => undefined);

			const openConfig = (row) => run(async () => {
				const body = await readJson(ROUTE_MCP_CONFIG + '?patchId=' + encodeURIComponent(row.patchId));
				setConfig({ row, text: body.text ?? JSON.stringify(body.config ?? {}, null, 2) });
				return undefined;
			}).catch(() => undefined);

			const saveConfig = () => run(async () => {
				let parsed;
				try {
					parsed = JSON.parse(config.text);
				} catch {
					setError(t('badJson'));
					return undefined;
				}
				const outcome = await readJson(ROUTE_MCP_CONFIG, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ patchId: config.row.patchId, config: parsed }),
				});
				setConfig(null);
				setNote(t('saved'));
				return outcome;
			}).catch(() => undefined);

			const toggleSkill = (item, next) => run(async () => {
				const outcome = await readJson(ROUTE_SKILL_TOGGLE, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ path: item.path, modelInvocable: next }),
				});
				setNote(item.name + ': ' + (next ? t('skillModel') + ' ✓' : t('skillModel') + ' ✗'));
				return outcome;
			}).catch(() => undefined);

			const viewSkill = (item) => run(async () => {
				const body = await readJson(ROUTE_SKILL_GET + '?name=' + encodeURIComponent(item.name));
				if (body.ok === true) setSkill(body.skill);
				else setError(body.message ?? 'failed');
				return undefined;
			}).catch(() => undefined);

			const tabButton = (id, label) => h('button', {
				key: id,
				onClick: () => setTab(id),
				style: {
					padding: '4px 12px',
					fontSize: 12,
					borderRadius: 8,
					border: '1px solid ' + (tab === id ? 'transparent' : C.border),
					background: tab === id ? 'var(--dsw-alias-brand-primary)' : 'transparent',
					color: tab === id ? '#fff' : C.text,
					cursor: 'pointer',
				},
			}, label);

			const header = h('div', { key: 'head', style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
				h('div', { style: { fontSize: 16, fontWeight: 600, color: C.text } }, t('title')),
				h('div', { style: { fontSize: 12, color: C.dim } }, t('subtitle')),
			]);

			const toolbar = h('div', { key: 'bar', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
				tabButton('mcp', t('tabMcp')),
				tabButton('skills', t('tabSkills')),
				h('div', { key: 'spacer', style: { flex: 1 } }),
				note === null ? null : h('span', { key: 'note', style: { fontSize: 12, color: C.ok } }, note),
				h(Button, { key: 'refresh', onClick: () => { void load(); }, disabled: busy }, t('refresh')),
			]);

			const body = [];
			if (data === null) body.push(h(Empty, { key: 'loading', text: t('loading') }));
			else if (tab === 'mcp') {
				body.push(h('div', { key: 'sum', style: { fontSize: 12, color: C.dim } }, fill(t('mcpSummary'), {
					total: data.mcp.total, enabled: data.mcp.enabled, disabled: data.mcp.disabled, tools: data.mcp.toolTotal,
				})));
				body.push(data.mcp.rows.length === 0
					? h(Empty, { key: 'empty', text: t('emptyMcp') })
					: h('div', { key: 'rows', style: { display: 'flex', flexDirection: 'column', gap: 8 } },
						data.mcp.rows.map((row) => h(McpRow, {
							key: row.patchId, row, t, busy, onToggle: toggleMcp, onEdit: openConfig,
						}))));
			} else {
				body.push(h('div', { key: 'sum', style: { fontSize: 12, color: C.dim } }, fill(t('skillSummary'), {
					total: data.skills.total, model: data.skills.modelInvocable,
				})));
				if (data.skills.cwd !== null && data.skills.cwd !== undefined) {
					body.push(h('div', { key: 'cwd', style: { fontSize: 11, color: C.faint } }, fill(t('rootsFrom'), { cwd: data.skills.cwd })));
				}
				if (data.skills.error !== null && data.skills.error !== undefined) {
					body.push(h('div', { key: 'serr', style: { fontSize: 12, color: C.err } }, data.skills.error));
				}
				body.push(data.skills.items.length === 0
					? h(Empty, { key: 'empty', text: t('emptySkills') })
					: h('div', { key: 'rows', style: { display: 'flex', flexDirection: 'column', gap: 8 } },
						data.skills.items.map((item) => h(SkillRow, {
							key: item.name + '|' + String(item.path), item, t, busy, onToggle: toggleSkill, onView: viewSkill,
						}))));
			}

			const overlays = [];
			if (config !== null) {
				overlays.push(h(Modal, {
					key: 'config',
					t,
					title: fill(t('configTitle'), { name: config.row.serverName }),
					hint: t('configHint'),
					onClose: () => setConfig(null),
				}, [
					h('textarea', {
						key: 'ta',
						value: config.text,
						onChange: (event) => setConfig({ ...config, text: event.target.value }),
						spellCheck: false,
						style: {
							width: '100%', minHeight: '38vh', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
							fontSize: 12, lineHeight: 1.5, padding: 10, borderRadius: 8,
							border: '1px solid ' + C.border, background: C.layer, color: C.text,
						},
					}),
					h('div', { key: 'actions', style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
						h(Button, { kind: 'primary', onClick: () => { void saveConfig(); }, disabled: busy }, busy ? t('saving') : t('save'))),
				]));
			}
			if (skill !== null) {
				overlays.push(h(Modal, {
					key: 'skill',
					t,
					title: fill(t('skillTitle'), { name: skill.name }),
					hint: skill.description,
					onClose: () => setSkill(null),
				}, h('pre', {
					style: {
						margin: 0, padding: 10, borderRadius: 8, border: '1px solid ' + C.border,
						background: C.layer, color: C.text, fontSize: 12, lineHeight: 1.6,
						whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '56vh', overflow: 'auto',
					},
				}, skill.content)));
			}

			return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 2px' } }, [
				header,
				error === null ? null : h('div', { key: 'error', style: { fontSize: 12, color: C.err } }, fill(t('failed'), { message: error })),
				toolbar,
				h('div', { key: 'body', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, body),
				...overlays,
			]);
		}

		const name = 'dsh-mcp-skills';
		const inject = ['slots', 'locale'];

		/**
		 * Mount the page into the settings panel.
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			const slots = ctx.get('slots');
			if (slots === undefined) return;
			const locale = ctx.get('locale');
			const t = locale.bind(NS);
			ctx.effect(() => locale.register(NS, dicts), 'mcp-skills: dictionaries');
			slots.inject('settings.section', () => slots.register({
				name: 'settings.section',
				id: SECTION_ID,
				order: SECTION_ORDER,
				locale: NS,
				label: () => t('title'),
			}, (props) => h(Panel, { ctx, t })));
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		exports.ROUTE_STATUS = ROUTE_STATUS;

		module.exports = exports;
		return module.exports;
	},
});
