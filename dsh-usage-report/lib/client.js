/**
 * Local usage report — browser half.
 *
 * Registers one `settings.section` page ("用量") that renders this machine's
 * daily input/output token totals. All numbers come from the Host half over the
 * authenticated `/usage-report` Connection RPC channel; the page itself makes
 * no network request of its own and shows no cost or billing data.
 *
 * Shipped as a DSH client bundle (`window.__ModuleLoader__.load`), hand-written
 * in plain JavaScript: React arrives through the module table, and the panel is
 * built with createElement so no build step is required to edit it.
 */
window.__ModuleLoader__.load({
	id: 'dsh-usage-report',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');
		const h = React.createElement;

		/** Host route this page reads; document-relative, like the app's other routes. */
		const ROUTE = 'api/usage.report';
		/** Locale namespace owned by this plugin. */
		const NS = 'settings.usageReport';
		/** Settings nav cell: fresh id, right after the reasoning-effort page. */
		const SECTION_ID = 'usage';
		const SECTION_ORDER = 13;
		/** Ranges the panel offers, in days. */
		const RANGES = [7, 30, 90];
		/** Series colors: warm for input, green for output (matches the design). */
		const INPUT_COLOR = 'var(--dsw-alias-state-warn-primary)';
		const OUTPUT_COLOR = 'var(--dsw-alias-state-success-primary)';

		const zh = {
			title: '用量',
			intro: '本机统计：数据来自本机保存的会话日志，按天汇总输入与输出 token。不含费用，也不发送任何网络请求。',
			input: '输入 token',
			output: '输出 token',
			inputHint: '未缓存 {uncached} · 缓存读 {read} · 缓存写 {write}',
			outputHint: '{requests} 次模型回复',
			chartTitle: '每日 Token 用量',
			chartSubtitle: '最近 {days} 天的输入与输出 token',
			legendInput: '输入',
			legendOutput: '输出',
			loading: '正在统计本机会话…',
			refresh: '刷新',
			empty: '这个时间范围内还没有用量记录。',
			failed: '读取本机用量失败：{message}',
			noConnection: '连接服务不可用，无法读取本机用量。',
			rangeDays: '{days} 天',
			footer: '统计范围 {first} ~ {last} · 扫描 {scanned} 个会话（跳过 {skipped}）· 生成于 {at}',
			footerNoData: '暂无可统计的会话。',
			tipTokens: '{day}：输入 {input}，输出 {output}',
			localBadge: '仅本机'
		};

		const en = {
			title: 'Usage',
			intro: 'On this device: folded from local session logs, per day, input and output tokens. No cost data and no network request.',
			input: 'Input tokens',
			output: 'Output tokens',
			inputHint: 'uncached {uncached} · cache read {read} · cache write {write}',
			outputHint: '{requests} model replies',
			chartTitle: 'Tokens per day',
			chartSubtitle: 'Input and output tokens over the last {days} days',
			legendInput: 'Input',
			legendOutput: 'Output',
			loading: 'Counting local sessions…',
			refresh: 'Refresh',
			empty: 'No usage recorded in this range yet.',
			failed: 'Reading local usage failed: {message}',
			noConnection: 'The connection service is unavailable, so local usage cannot be read.',
			rangeDays: '{days}d',
			footer: 'Range {first} ~ {last} · scanned {scanned} sessions (skipped {skipped}) · generated {at}',
			footerNoData: 'No sessions to count yet.',
			tipTokens: '{day}: input {input}, output {output}',
			localBadge: 'On device'
		};

		const dicts = { zh, en };

		/** Interpolate `{name}` placeholders; missing values stay literal. */
		function fill(template, values) {
			return String(template).replace(/\{(\w+)\}/g, (whole, key) => (
				values[key] === undefined ? whole : String(values[key])
			));
		}

		/** Compact token count: 950, 12.3K, 5.9M, 1.20B. */
		function formatTokens(value) {
			if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '0';
			if (value >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
			if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
			if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
			if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
			return String(Math.round(value));
		}

		/** Axis ticks: the same scale with a trailing `.0` dropped (`120M`, not `120.0M`). */
		function formatAxis(value) {
			const text = formatTokens(value);
			return /\.0[KMBT]$/.test(text) ? text.replace('.0', '') : text;
		}

		/** Round an axis maximum up to a readable 1/2/2.5/3/4/5/6/8 × 10^n step. */
		function niceMax(value) {
			if (!Number.isFinite(value) || value <= 0) return 1;
			const magnitude = 10 ** Math.floor(Math.log10(value));
			const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
			for (const step of steps) {
				if (value <= step * magnitude) return step * magnitude;
			}
			return 10 * magnitude;
		}

		/** One settings page's stylesheet, injected once per plugin load. */
		const CSS = `
.dsu-root{display:flex;flex-direction:column;gap:14px;padding-bottom:8px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.dsu-head{display:flex;align-items:flex-start;gap:12px}
.dsu-title{font-size:15px;font-weight:600;line-height:22px;margin:0 0 2px}
.dsu-intro{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;flex:1;min-width:0}
.dsu-ranges{display:flex;gap:4px;flex:none}
.dsu-range{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm,6px);padding:2px 8px;font-family:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dsu-range:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsu-range[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-weight:500}
.dsu-cards{display:flex;gap:12px;flex-wrap:wrap}
.dsu-card{flex:1 1 220px;min-width:0;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1);padding:12px 14px}
.dsu-card-label{color:var(--dsw-alias-label-secondary);font-size:12px;display:flex;align-items:center;gap:6px}
.dsu-dot{width:8px;height:8px;border-radius:50%;flex:none;display:inline-block}
.dsu-card-value{font-size:22px;font-weight:600;line-height:30px;margin-top:2px}
.dsu-card-hint{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsu-panel{border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1);padding:12px 14px 8px}
.dsu-panel-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.dsu-panel-title{font-size:14px;font-weight:600;margin:0}
.dsu-panel-sub{color:var(--dsw-alias-label-secondary);font-size:12px}
.dsu-legend{display:flex;gap:14px;margin:8px 0 4px}
.dsu-legend-item{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dsu-chart{width:100%;height:auto;display:block;overflow:visible}
.dsu-grid{stroke:var(--dsw-alias-border-l1);stroke-width:1;shape-rendering:crispEdges}
.dsu-axis{fill:var(--dsw-alias-label-secondary);font-size:10px}
.dsu-empty{fill:var(--dsw-alias-label-secondary);font-size:12px}
.dsu-status{color:var(--dsw-alias-label-secondary);font-size:12px;display:flex;align-items:center;gap:8px;min-height:120px;justify-content:center}
.dsu-status-error{color:var(--dsw-alias-state-error-primary)}
.dsu-footer{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsu-badge{border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:0 6px;font-size:10px;line-height:15px;color:var(--dsw-alias-label-secondary)}
.dsu-refresh{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm,6px);padding:0 6px;font-family:inherit;font-size:11px;line-height:17px;cursor:pointer}
.dsu-refresh:hover{background:var(--dsw-alias-interactive-bg-hover)}
`;

		function useStyles(ctx) {
			React.useEffect(() => ctx.effect(() => {
				const element = document.createElement('style');
				element.setAttribute('data-dsh-plugin', 'dsh-usage-report');
				element.textContent = CSS;
				document.head.appendChild(element);
				return () => {
					if (element.parentNode !== null) element.parentNode.removeChild(element);
				};
			}, 'usage-report: stylesheet'), [ctx]);
		}

		/** Ask the Host half for one range's report over its authenticated route. */
		function useReport(rangeDays, nonce, t) {
			const [state, setState] = React.useState({ status: 'loading', report: null, error: null });
			React.useEffect(() => {
				let alive = true;
				setState((previous) => ({ status: 'loading', report: previous.report, error: null }));
				(async () => {
					try {
						if (typeof fetch !== 'function') throw new Error(t('noConnection'));
						const response = await fetch(`${ROUTE}?range=${String(rangeDays)}`, {
							method: 'GET',
							headers: { accept: 'application/json' },
							credentials: 'same-origin',
						});
						const body = await response.json().catch(() => null);
						if (!alive) return;
						if (!response.ok || body === null) {
							throw new Error(body?.error?.message ?? `HTTP ${String(response.status)}`);
						}
						setState({ status: 'ready', report: body, error: null });
					} catch (error) {
						if (!alive) return;
						setState({
							status: 'error',
							report: null,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				})();
				return () => { alive = false; };
			}, [rangeDays, nonce, t]);
			return state;
		}

		function StatCard(props) {
			return h('div', { className: 'dsu-card' }, [
				h('div', { className: 'dsu-card-label', key: 'label' }, [
					h('span', {
						className: 'dsu-dot',
						key: 'dot',
						style: { background: props.color },
					}),
					props.label,
				]),
				h('div', { className: 'dsu-card-value', key: 'value' }, `${formatTokens(props.value)} token`),
				h('div', { className: 'dsu-card-hint', key: 'hint', title: props.hint }, props.hint),
			]);
		}

		/**
		 * Grouped per-day bars over an SVG viewBox, so the chart scales with the
		 * settings panel instead of measuring the DOM.
		 */
		function DailyChart(props) {
			const { days, t } = props;
			const width = 540;
			const height = 200;
			const padLeft = 44;
			const padRight = 6;
			const padTop = 8;
			const padBottom = 22;
			const plotWidth = width - padLeft - padRight;
			const plotHeight = height - padTop - padBottom;
			const peak = days.reduce((max, day) => Math.max(max, day.input, day.output), 0);
			const scaleMax = niceMax(peak);
			const slot = plotWidth / Math.max(1, days.length);
			const barWidth = Math.max(1.2, Math.min(7, slot * 0.32));
			const gap = Math.max(0.4, Math.min(2, slot * 0.08));
			const yOf = (value) => padTop + plotHeight - (value / scaleMax) * plotHeight;
			const gridlines = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
				value: scaleMax * ratio,
				y: padTop + plotHeight - ratio * plotHeight,
			}));
			// Evenly spaced ticks including both ends, so the last two labels of a
			// 30/90-day axis cannot collide.
			const tickCount = Math.min(8, days.length);
			const labelIndices = new Set(Array.from({ length: tickCount }, (_, tick) => (
				Math.round((tick * (days.length - 1)) / Math.max(1, tickCount - 1))
			)));
			const children = [];

			for (const line of gridlines) {
				children.push(h('line', {
					key: `grid-${line.y}`,
					className: 'dsu-grid',
					x1: padLeft,
					x2: width - padRight,
					y1: line.y,
					y2: line.y,
				}));
				children.push(h('text', {
					key: `grid-label-${line.y}`,
					className: 'dsu-axis',
					x: padLeft - 6,
					y: line.y + 3,
					textAnchor: 'end',
				}, formatAxis(line.value)));
			}

			days.forEach((day, index) => {
				const center = padLeft + slot * (index + 0.5);
				const bars = [
					{ key: 'input', value: day.input, color: INPUT_COLOR, x: center - barWidth - gap / 2 },
					{ key: 'output', value: day.output, color: OUTPUT_COLOR, x: center + gap / 2 },
				];
				for (const bar of bars) {
					if (bar.value <= 0) continue;
					const y = yOf(bar.value);
					children.push(h('rect', {
						key: `${bar.key}-${day.day}`,
						x: bar.x,
						y,
						width: barWidth,
						height: Math.max(2, padTop + plotHeight - y),
						rx: Math.min(1.5, barWidth / 2),
						fill: bar.color,
					}));
				}
				children.push(h('rect', {
					key: `hit-${day.day}`,
					x: padLeft + slot * index,
					y: padTop,
					width: slot,
					height: plotHeight,
					fill: 'transparent',
				}, h('title', null, fill(t('tipTokens'), {
					day: day.day,
					input: formatTokens(day.input),
					output: formatTokens(day.output),
				}))));
				if (labelIndices.has(index)) {
					children.push(h('text', {
						key: `x-${day.day}`,
						className: 'dsu-axis',
						x: center,
						y: height - 6,
						textAnchor: 'middle',
					}, day.label));
				}
			});

			if (peak <= 0) {
				children.push(h('text', {
					key: 'empty',
					className: 'dsu-empty',
					x: padLeft + plotWidth / 2,
					y: padTop + plotHeight / 2,
					textAnchor: 'middle',
				}, t('empty')));
			}

			return h('svg', {
				className: 'dsu-chart',
				viewBox: `0 0 ${String(width)} ${String(height)}`,
				role: 'img',
				preserveAspectRatio: 'none',
				'aria-label': t('chartTitle'),
			}, children);
		}

		/** The registered settings page. */
		function UsageSection(props) {
			const { t } = props;
			const [rangeDays, setRangeDays] = React.useState(30);
			const [nonce, setNonce] = React.useState(0);
			useStyles(props.ctx);
			const state = useReport(rangeDays, nonce, t);
			const report = state.report;

			const head = h('div', { className: 'dsu-head', key: 'head' }, [
				h('div', { key: 'text', style: { flex: '1 1 auto', minWidth: '0' } }, [
					h('h3', { className: 'dsu-title', key: 'title' }, t('title')),
					h('div', { className: 'dsu-intro', key: 'intro' }, t('intro')),
				]),
				h('div', { className: 'dsu-ranges', key: 'ranges' }, RANGES.map((days) => h('button', {
					key: days,
					type: 'button',
					className: 'dsu-range',
					'aria-pressed': days === rangeDays ? 'true' : 'false',
					onClick: () => setRangeDays(days),
				}, fill(t('rangeDays'), { days })))),
			]);

			if (state.status === 'loading' && report === null) {
				return h('div', { className: 'dsu-root' }, [head, h('div', { className: 'dsu-status', key: 'loading' }, t('loading'))]);
			}
			if (state.status === 'error') {
				return h('div', { className: 'dsu-root' }, [
					head,
					h('div', { className: 'dsu-status dsu-status-error', key: 'error' }, fill(t('failed'), { message: state.error })),
				]);
			}

			const totals = report?.totals ?? { input: 0, output: 0, uncachedInput: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
			const meta = report?.meta ?? {};
			const days = report?.days ?? [];
			const generated = report === null ? '' : new Date(report.generatedAt).toLocaleString();

			return h('div', { className: 'dsu-root' }, [
				head,
				h('div', { className: 'dsu-cards', key: 'cards' }, [
					h(StatCard, {
						key: 'input',
						color: INPUT_COLOR,
						label: t('input'),
						value: totals.input,
						hint: fill(t('inputHint'), {
							uncached: formatTokens(totals.uncachedInput),
							read: formatTokens(totals.cacheRead),
							write: formatTokens(totals.cacheWrite),
						}),
					}),
					h(StatCard, {
						key: 'output',
						color: OUTPUT_COLOR,
						label: t('output'),
						value: totals.output,
						hint: fill(t('outputHint'), { requests: String(totals.requests) }),
					}),
				]),
				h('div', { className: 'dsu-panel', key: 'panel' }, [
					h('div', { className: 'dsu-panel-head', key: 'head' }, [
						h('h4', { className: 'dsu-panel-title', key: 'title' }, t('chartTitle')),
						h('span', { className: 'dsu-panel-sub', key: 'sub' }, fill(t('chartSubtitle'), { days: String(rangeDays) })),
						h('button', {
							key: 'refresh',
							type: 'button',
							className: 'dsu-refresh',
							style: { marginLeft: 'auto' },
							onClick: () => setNonce((value) => value + 1),
						}, t('refresh')),
					]),
					h('div', { className: 'dsu-legend', key: 'legend' }, [
						h('span', { className: 'dsu-legend-item', key: 'input' }, [
							h('span', { className: 'dsu-dot', key: 'dot', style: { background: INPUT_COLOR } }),
							t('legendInput'),
						]),
						h('span', { className: 'dsu-legend-item', key: 'output' }, [
							h('span', { className: 'dsu-dot', key: 'dot', style: { background: OUTPUT_COLOR } }),
							t('legendOutput'),
						]),
					]),
					h(DailyChart, { key: 'chart', days, t }),
				]),
				h('div', { className: 'dsu-footer', key: 'footer' }, [
					h('span', { className: 'dsu-badge', key: 'badge' }, t('localBadge')),
					h('span', {
						key: 'meta',
						title: meta.skippedReasons?.length ? meta.skippedReasons.join('\n') : undefined,
					}, report === null || (meta.sessionCount ?? 0) === 0
						? t('footerNoData')
						: fill(t('footer'), {
							first: meta.firstActiveDay ?? '—',
							last: meta.lastActiveDay ?? '—',
							scanned: String(meta.scannedSessions ?? 0),
							skipped: String(meta.skippedSessions ?? 0),
							at: generated,
						})),
				]),
			]);
		}

		const name = 'dsh-usage-report';
		const inject = ['slots', 'locale'];

		/**
		 * Mount the usage page into the settings panel.
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			const slots = ctx.get('slots');
			if (slots === undefined) return;
			const locale = ctx.get('locale');
			const t = locale.bind(NS);
			ctx.effect(() => locale.register(NS, dicts), 'usage-report: dictionaries');
			slots.inject('settings.section', () => slots.register({
				name: 'settings.section',
				id: SECTION_ID,
				order: SECTION_ORDER,
				locale: NS,
				label: () => t('title'),
			}, (props) => h(UsageSection, {
				ctx,
				t,
				close: props.close,
			})));
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		exports.formatTokens = formatTokens;
		exports.formatAxis = formatAxis;
		exports.niceMax = niceMax;
		exports.ROUTE = ROUTE;
		exports.NS = NS;

		module.exports = exports;
		return module.exports;
	},
});
