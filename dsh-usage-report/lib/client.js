/**
 * Local usage report — browser half.
 *
 * Registers one `settings.section` page ("用量") that renders this machine's
 * daily input/output token totals. All numbers come from the Host half over the
 * authenticated `/api/usage.report` Fetch route. Only the local DSH host is
 * queried; the page makes no provider request and shows no cost or billing data.
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
			intro: '本机统计：数据来自本机保存的会话日志，按天汇总输入与输出 token。不含费用，不向外部服务发送统计请求。',
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
			refreshing: '正在更新…',
			retry: '重试',
			stale: '更新失败，下面保留上次成功结果；请重试。',
			partial: '统计不完整：跳过 {skipped} 个会话，另有 {truncated} 个未扫描。',
			allFailed: '会话未能读取，不能将零值视为没有用量。',
			tableTitle: '查看每日精确数据',
			date: '日期',
			requests: '模型回复次数',
			rangeLabel: '统计时间范围',
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
			intro: 'On this device: folded from local session logs, per day, input and output tokens. No cost data and no external network request.',
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
			refreshing: 'Updating…',
			retry: 'Retry',
			stale: 'Update failed. The last successful result remains below; retry to update.',
			partial: 'Incomplete report: {skipped} sessions skipped, {truncated} not scanned.',
			allFailed: 'Sessions could not be read. Zero values do not mean no usage.',
			tableTitle: 'View exact daily data',
			date: 'Date',
			requests: 'Model replies',
			rangeLabel: 'Report time range',
			empty: 'No usage recorded in this range yet.',
			failed: 'Reading local usage failed: {message}',
			noConnection: 'The connection service is unavailable, so local usage cannot be read.',
			rangeDays: '{days}d',
			footer: 'Range {first} ~ {last} · scanned {scanned} sessions (skipped {skipped}) · generated {at}',
			footerNoData: 'No sessions to count yet.',
			tipTokens: '{day}: input {input}, output {output}',
			localBadge: 'On device'
		};

		Object.assign(zh, {
  "chatTitle": "聊天用量排行",
  "chatSubtitle": "按所选时间内的实际 Token 用量排序，展开查看模型明细",
  "chat": "聊天",
  "fiveHour": "占 5 小时限额的 %",
  "weekly": "占每周限额的 %",
  "usedTokens": "已用 Token",
  "share": "Token 占比",
  "quotaUnavailable": "本机日志不含套餐限额与计费额度，限额列显示 —；Token 占比不是套餐额度占比。",
  "showMore": "显示更多",
  "showLess": "收起",
  "openChat": "打开聊天",
  "openChatFailed": "暂时无法打开聊天，请确认工作区服务可用后重试；统计仍可查看。",
  "expandChat": "展开 {title} 的用量明细",
  "collapseChat": "收起 {title} 的用量明细",
  "model": "模型",
  "messages": "消息",
  "messagesSubtitle": "按天统计模型回复消息（含工具调用消息），不是用户发送条数",
  "byModel": "按模型",
  "byClient": "按使用端",
  "groupLabel": "消息分组方式",
  "clientUnknown": "未记录",
  "clientUnavailable": "历史日志未记录使用端，不能区分桌面端、Web 或 CLI。",
  "toolTitle": "工具活动",
  "toolSubtitle": "查看一段时间内调用了哪些工具和技能",
  "toolCalls": "工具调用",
  "toolHint": "按日志中的实际工具名分组；不推测插件归属。",
  "skillsUsed": "已使用技能",
  "skillsHint": "仅统计成功加载的技能次数，失败与继承记录不计入。",
  "updatedAt": "更新于 {at}",
  "exactTrend": "查看每日明细",
  "noActivity": "这个时间范围内没有活动记录。",
  "analyticsUnavailable": "新增统计尚未就绪，请更新 Host 后刷新。",
  "other": "其他",
  "unknown": "未知",
  "seriesLabel": "切换显示 {label}",
  "allReadFailed": "会话读取失败，无法显示可靠统计。",
  "chatDetails": "聊天模型用量明细",
  "noModelUsage": "本段时间没有带 Token 用量的模型回复。"
});
		Object.assign(en, {
  "chatTitle": "Chat usage ranking",
  "chatSubtitle": "Ranked by actual tokens in the selected range; expand for model details",
  "chat": "Chat",
  "fiveHour": "% of 5-hour limit",
  "weekly": "% of weekly limit",
  "usedTokens": "Tokens used",
  "share": "Token share",
  "quotaUnavailable": "Local logs contain no plan limits or billing credits. Limit columns show —; token share is not plan quota usage.",
  "showMore": "Show more",
  "showLess": "Show less",
  "openChat": "Open chat",
  "openChatFailed": "Chat could not be opened. Check the workspace service and retry; usage remains available.",
  "expandChat": "Expand usage for {title}",
  "collapseChat": "Collapse usage for {title}",
  "model": "Model",
  "messages": "Messages",
  "messagesSubtitle": "Daily model replies (including tool-call messages), not user prompts",
  "byModel": "By model",
  "byClient": "By client",
  "groupLabel": "Message grouping",
  "clientUnknown": "Not recorded",
  "clientUnavailable": "Historical logs do not record the client, so Desktop, Web and CLI cannot be distinguished.",
  "toolTitle": "Tool activity",
  "toolSubtitle": "See which tools and skills were used over time",
  "toolCalls": "Tool calls",
  "toolHint": "Grouped by the actual logged tool name; plugin ownership is not inferred.",
  "skillsUsed": "Skills used",
  "skillsHint": "Successful skill loads only; failures and inherited events are excluded.",
  "updatedAt": "Updated {at}",
  "exactTrend": "View daily details",
  "noActivity": "No activity recorded in this range.",
  "analyticsUnavailable": "New analytics are not ready. Update the Host and refresh.",
  "other": "Other",
  "unknown": "Unknown",
  "seriesLabel": "Toggle {label}",
  "allReadFailed": "Sessions could not be read; reliable analytics are unavailable.",
  "chatDetails": "Tokens by model in this chat",
  "noModelUsage": "No model replies with token usage in this range."
});
		zh.hiddenSeries = '全部曲线已隐藏，点击图例恢复。';
		en.hiddenSeries = 'All lines are hidden. Click a legend item to restore.';
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
.dsu-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}
.dsu-title{font-size:15px;font-weight:600;line-height:22px;margin:0 0 2px}
.dsu-intro{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;flex:1;min-width:0}
.dsu-ranges{display:flex;gap:4px;flex:none}
.dsu-range{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm,6px);padding:2px 8px;font-family:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dsu-range:hover{background:var(--dsw-alias-bg-layer-2)}
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
.dsu-refresh:hover{background:var(--dsw-alias-bg-layer-2)}
.dsu-analytics{display:flex;flex-direction:column;gap:14px;margin-top:18px;min-width:0}
.dsu-section-head{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap}
.dsu-section-title{font-size:16px;line-height:24px;font-weight:600;margin:0 0 3px}
.dsu-note{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin:0;overflow-wrap:anywhere}
.dsu-controls{display:flex;gap:8px;flex-wrap:wrap}
.dsu-segment{display:flex;padding:3px;gap:2px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;flex:none}
.dsu-segment button{border:0;background:transparent;color:var(--dsw-alias-label-secondary);padding:3px 10px;border-radius:9px;font:inherit;cursor:pointer;white-space:nowrap}
.dsu-segment button[aria-pressed="true"]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);font-weight:600}
.dsu-trend-card{border:1px solid var(--dsw-alias-border-l1);border-radius:18px;background:var(--dsw-alias-bg-layer-1);padding:18px 18px 12px;min-width:0}
.dsu-trend-label{margin:0;font-size:13px;font-weight:600}
.dsu-trend-value{font-size:28px;line-height:38px;font-weight:600;font-variant-numeric:tabular-nums}
.dsu-line-chart{width:100%;height:200px;display:block;margin-top:16px}
.dsu-trend-legend{display:flex;gap:8px 16px;flex-wrap:wrap;margin:10px 0}
.dsu-trend-legend button{display:flex;align-items:center;gap:6px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;max-width:100%;overflow-wrap:anywhere;text-align:left}
.dsu-trend-legend button[aria-pressed="false"]{opacity:.45;text-decoration:line-through}
.dsu-root button:focus-visible,.dsu-root summary:focus-visible,.dsu-day-hit:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}
.dsu-day-hit:hover,.dsu-day-hit:focus{fill:var(--dsw-alias-label-secondary);fill-opacity:.07}
.dsu-table-scroll{overflow-x:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:18px;background:var(--dsw-alias-bg-layer-1)}
.dsu-table{border-collapse:collapse;width:100%;font-size:12px;font-variant-numeric:tabular-nums}
.dsu-table caption{text-align:left;padding:10px 14px;color:var(--dsw-alias-label-secondary)}
.dsu-table th,.dsu-table td{padding:12px 14px;text-align:right;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.dsu-table th{font-weight:500;color:var(--dsw-alias-label-secondary)}
.dsu-table th:first-child,.dsu-table td:first-child{text-align:left}
.dsu-table tbody>tr:last-child>td,.dsu-table tbody>tr:last-child>th{border-bottom:0}
.dsu-chat-table{min-width:650px}
.dsu-chat-table th:first-child{min-width:180px;width:36%}
.dsu-chat-button{border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-weight:600;text-align:left;padding:0;display:flex;align-items:center;gap:10px;cursor:pointer;max-width:280px}
.dsu-chat-button span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsu-chat-row:hover{background:var(--dsw-alias-bg-layer-2)}
.dsu-chat-detail{padding:14px!important;background:var(--dsw-alias-bg-layer-2);white-space:normal!important;text-align:left!important}
.dsu-chat-detail .dsu-table{margin-bottom:10px}
.dsu-more{align-self:flex-start;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;padding:4px 10px;cursor:pointer}
.dsu-exact{color:var(--dsw-alias-label-secondary);font-size:12px}
.dsu-exact summary{cursor:pointer;margin-top:8px}
.dsu-exact table{margin-top:8px}
@media(max-width:600px){.dsu-trend-card{padding:14px 10px 10px}.dsu-line-chart{height:180px}.dsu-section-title{font-size:15px}.dsu-controls{width:100%}.dsu-table th,.dsu-table td{padding:10px}.dsu-analytics{margin-top:12px}}

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

		/** Pure transition rules keep old data only when it belongs to this range. */
		function reportState(previous, event) {
			if (event.type === 'start') return { status: 'loading', report: previous.report?.rangeDays === event.rangeDays ? previous.report : null, error: null };
			if (event.type === 'success') return { status: 'ready', report: event.report, error: null };
			return { status: 'error', report: previous.report?.rangeDays === event.rangeDays ? previous.report : null, error: event.error };
		}

		/** Ask the Host half for one range's report over its authenticated route. */
		function useReport(rangeDays, nonce, t) {
			const [state, setState] = React.useState({ status: 'loading', report: null, error: null });
			React.useEffect(() => {
				let alive = true;
				const controller = typeof AbortController === 'function' ? new AbortController() : null;
				setState((previous) => reportState(previous, { type: 'start', rangeDays }));
				(async () => {
					try {
						if (typeof fetch !== 'function') throw new Error(t('noConnection'));
						const response = await fetch(`${ROUTE}?range=${String(rangeDays)}${nonce > 0 ? '&refresh=1' : ''}`, {
							method: 'GET',
							headers: { accept: 'application/json' },
							credentials: 'same-origin',
							...(controller ? { signal: controller.signal } : {}),
						});
						const body = await response.json().catch(() => null);
						if (!alive) return;
						if (!response.ok || body === null) {
							throw new Error(body?.error?.message ?? `HTTP ${String(response.status)}`);
						}
						setState(previous => reportState(previous, { type: 'success', report: body }));
					} catch (error) {
						if (!alive) return;
						setState(previous => reportState(previous, { type: 'error', rangeDays, error: error instanceof Error ? error.message : String(error) }));
					}
				})();
				return () => { alive = false; controller?.abort(); };
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
				}, props.emptyText || t('empty')));
			}

			return h('svg', {
				className: 'dsu-chart',
				viewBox: `0 0 ${String(width)} ${String(height)}`,
				role: 'img',
				preserveAspectRatio: 'none',
				'aria-label': t('chartTitle'),
			}, children);
		}

		const PALETTE = ['#3378dd', '#ff994f', '#70cf8b', '#e786ba', '#ad93ed', '#53c6c4', '#b8b74e', '#d07a62'];
		function seriesColor(id) {
			let hash = 0;
			for (const char of String(id)) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
			return PALETTE[hash % PALETTE.length];
		}
		function seriesLabel(series, t) {
			return series.id === 'unknown' && series.label === '未记录' ? t('clientUnknown') : series.isOther ? t('other') : series.label;
		}
		/** Preserve every count while keeping the visible legend manageable. */
		function groupSeries(series, days, t, limit = 7) {
			const sorted = [...(series ?? [])].sort((a, b) => b.total - a.total || String(a.id).localeCompare(String(b.id)));
			if (sorted.length <= limit) return sorted;
			const rest = sorted.slice(limit);
			let otherId = '__usage_report_other__';
			while (sorted.some(item => item.id === otherId)) otherId += '_';
			return [...sorted.slice(0, limit), {
				id: otherId, isOther:true, label: t('other'), total: rest.reduce((sum, item) => sum + item.total, 0),
				values: days.map((_, i) => rest.reduce((sum, item) => sum + (item.values[i] ?? 0), 0)),
			}];
		}
		function Segment({ label, options, value, onChange }) {
			return h('div', {className:'dsu-segment', role:'group', 'aria-label':label}, options.map(option => h('button', {
				key:option.value, type:'button', 'aria-pressed':String(option.value === value), onClick:() => onChange(option.value),
			}, option.label)));
		}
		function LineChart({days, series, title, t, emptyText}) {
			const width = 720, height = 200, left = 44, right = 12, top = 8, bottom = 26;
			const plotWidth = width-left-right, plotHeight = height-top-bottom;
			const peak = series.reduce((max, item) => Math.max(max, ...item.values), 0);
			// Multiples of three keep all four count ticks integral, including 0/1/2/3.
			const max = Math.max(3, Math.ceil(niceMax(peak) / 3) * 3);
			const x = i => left + (i / Math.max(1, days.length-1)) * plotWidth;
			const y = n => top + plotHeight * (1 - n/max);
			const children = [h('title', {key:'title'}, title)];
			for (let i=0;i<=3;i++) {
				const n = i*max/3;
				children.push(h('line', {key:`grid-${i}`,className:'dsu-grid',x1:left,x2:width-right,y1:y(n),y2:y(n)}));
				children.push(h('text', {key:`label-${i}`,className:'dsu-axis',x:left-10,y:y(n)+3,textAnchor:'end'},formatAxis(n)));
			}
			for (const item of series) {
				children.push(h('polyline', {key:`line-${item.id}`, fill:'none',stroke:(item.color ?? seriesColor(item.id)),strokeWidth:2.3,vectorEffect:'non-scaling-stroke',points:days.map((_,i)=>`${x(i)},${y(item.values[i]??0)}`).join(' ')}));
				if (days.length === 1) children.push(h('circle',{key:`point-${item.id}`,cx:x(0),cy:y(item.values[0]??0),r:3,fill:(item.color ?? seriesColor(item.id))}));
			}
			const ticks = new Set([0, Math.floor((days.length-1)/2), days.length-1]);
			days.forEach((day,i)=>{
				const start = i===0 ? left : (x(i-1)+x(i))/2;
				const end = i===days.length-1 ? width-right : (x(i)+x(i+1))/2;
				const text = `${day.day}\n${series.map(item=>`${seriesLabel(item,t)}: ${item.values[i]??0}`).join('\n')}`;
				children.push(h('rect',{key:`hit-${day.day}`,className:'dsu-day-hit',x:start,y:top,width:Math.max(1,end-start),height:plotHeight,fill:'transparent',tabIndex:0,role:'img','aria-label':text},h('title',null,text)));
				if(ticks.has(i)) children.push(h('text',{key:`date-${day.day}`,className:'dsu-axis',x:x(i),y:height-6,textAnchor:i===0?'start':i===days.length-1?'end':'middle'},day.label));
			});
			if(peak===0) children.push(h('text',{key:'empty',className:'dsu-empty',x:left+plotWidth/2,y:top+plotHeight/2,textAnchor:'middle'},emptyText ?? t('noActivity')));
			return h('svg',{className:'dsu-line-chart',viewBox:`0 0 ${width} ${height}`,preserveAspectRatio:'none',role:'img','aria-label':title},children);
		}
		function TrendCard({title, data, days, t, hint}) {
			const [hidden,setHidden] = React.useState([]);
			const series = groupSeries(data.series ?? [],days,t).map((item,index)=>({...item,color:PALETTE[index]}));
			const visible = series.filter(item=>!hidden.includes(item.id));
			return h('div',{className:'dsu-trend-card'},[
				h('h5',{key:'title',className:'dsu-trend-label'},title),
				h('div',{key:'total',className:'dsu-trend-value'},String(data.total??0)),
				hint?h('p',{key:'hint',className:'dsu-note'},hint):null,
				h(LineChart,{key:'chart',days,series:visible,title,t,emptyText:series.length>0 && visible.length===0?t('hiddenSeries'):undefined}),
				h('div',{key:'legend',className:'dsu-trend-legend'},series.map(item=>h('button',{
					key:item.id,type:'button','aria-pressed':String(!hidden.includes(item.id)),title:fill(t('seriesLabel'),{label:seriesLabel(item,t)}),
					onClick:()=>setHidden(old=>old.includes(item.id)?old.filter(id=>id!==item.id):[...old,item.id]),
				},[h('span',{key:'dot',className:'dsu-dot',style:{background:(item.color ?? seriesColor(item.id))}}),`${seriesLabel(item,t)} (${item.total})`]))),
				h('details',{key:'exact',className:'dsu-exact'},[
					h('summary',{key:'summary'},t('exactTrend')),
					h('div',{key:'scroll',style:{overflowX:'auto'}},h('table',{className:'dsu-table'},[
						h('caption',{key:'caption'},title),
						h('thead',{key:'head'},h('tr',null,[h('th',{key:'date',scope:'col'},t('date')),...(data.series??[]).map(item=>h('th',{key:item.id,scope:'col'},seriesLabel(item,t)))])),
						h('tbody',{key:'body'},days.map((day,i)=>h('tr',{key:day.day},[h('th',{key:'date',scope:'row'},day.day),...(data.series??[]).map(item=>h('td',{key:item.id},String(item.values[i]??0)))]))),
					])),
				]),
			]);
		}
		/** Each activity section owns its 7/30-day range, as in the reference. */
		function ActivitySection({kind,nonce,t}) {
			const [range,setRange] = React.useState(7);
			const [group,setGroup] = React.useState('model');
			const [retry,setRetry] = React.useState(0);
			const state = useReport(range,nonce+retry,t);
			const report = state.report?.rangeDays===range?state.report:null;
			const analytics = report?.analytics;
			const failedAll = (report?.meta?.sessionCount??0)>0 && (report?.meta?.scannedSessions??0)===0;
			const messages = kind==='messages';
			const header = h('div',{key:'head',className:'dsu-section-head'},[
				h('div',{key:'text'},[
					h('h4',{key:'title',className:'dsu-section-title'},t(messages?'messages':'toolTitle')),
					h('p',{key:'sub',className:'dsu-note'},t(messages?'messagesSubtitle':'toolSubtitle')),
					report?h('p',{key:'updated',className:'dsu-note'},fill(t('updatedAt'),{at:new Date(report.generatedAt).toLocaleString()})):null,
				]),
				h('div',{key:'controls',className:'dsu-controls'},[
					h(Segment,{key:'range',label:t('rangeLabel'),options:[7,30].map(value=>({value,label:fill(t('rangeDays'),{days:value})})),value:range,onChange:setRange}),
					messages?h(Segment,{key:'group',label:t('groupLabel'),options:[{value:'model',label:t('byModel')},{value:'client',label:t('byClient')}],value:group,onChange:setGroup}):null,
				]),
			]);
			const content = [header];
			if(state.status==='loading') content.push(h('p',{key:'loading',className:'dsu-note',role:'status'},t('refreshing')));
			if(state.status==='error') content.push(h('div',{key:'error',role:'alert',className:'dsu-status-error'},[
				h('p',{key:'text'},report?t('stale'):fill(t('failed'),{message:state.error})),
				h('button',{key:'retry',className:'dsu-refresh',type:'button',onClick:()=>setRetry(value=>value+1)},t('retry')),
			]));
			if(report && !analytics) content.push(h('p',{key:'unavailable',className:'dsu-note'},t('analyticsUnavailable')));
			if(failedAll) content.push(h('p',{key:'failed-all',role:'alert'},t('allReadFailed')));
			if(report && (report.meta.skippedSessions+report.meta.truncatedSessions)>0) content.push(h('p',{key:'partial',className:'dsu-note',role:'status'},fill(t('partial'),{skipped:report.meta.skippedSessions,truncated:report.meta.truncatedSessions})));
			if(analytics && !failedAll) {
				if(messages) {
					if(group==='client' && !analytics.messages.clientSourceAvailable) content.push(h('p',{key:'client-note',className:'dsu-note'},t('clientUnavailable')));
					content.push(h(TrendCard,{key:`messages-${group}`,title:t('messages'),days:analytics.days,data:{total:analytics.messages.total,series:group==='model'?analytics.messages.byModel:analytics.messages.byClient},t}));
				} else {
					content.push(h(TrendCard,{key:'tools',title:t('toolCalls'),hint:t('toolHint'),days:analytics.days,data:analytics.tools,t}));
					content.push(h(TrendCard,{key:'skills',title:t('skillsUsed'),hint:t('skillsHint'),days:analytics.days,data:analytics.skills,t}));
				}
			}
			return h('section',{className:'dsu-analytics','aria-label':t(messages?'messages':'toolTitle'),'aria-busy':state.status==='loading'},content);
		}
		function ChatRanking({analytics,rangeDays,t,ctx,close,failedAll = false}) {
			const [limit,setLimit] = React.useState(5);
			const [expanded,setExpanded] = React.useState([]);
			const [navigationError,setNavigationError] = React.useState(false);
			React.useEffect(()=>{setLimit(5);setExpanded([]);setNavigationError(false);},[rangeDays]);
			async function openChat(id) {
				setNavigationError(false);
				try {
					// Resolve again on click: an optional service may disappear while
					// the row is expanded. Do not call a stale service or close on failure.
					const workspace = ctx.get('uiWorkspace');
					if (typeof workspace?.openSession !== 'function') throw new Error('unavailable');
					await workspace.openSession(id);
					close?.();
				} catch { setNavigationError(true); }
			}
			const chats = analytics?.chats??[];
			const rows = [];
			for(const [index,chat] of chats.slice(0,limit).entries()) {
				const open=expanded.includes(chat.id),detailId=`dsu-chat-${index}`;
				rows.push(h('tr',{key:chat.id,className:'dsu-chat-row'},[
					h('th',{key:'chat',scope:'row'},h('button',{type:'button',className:'dsu-chat-button','aria-expanded':String(open),'aria-controls':open?detailId:undefined,'aria-label':fill(t(open?'collapseChat':'expandChat'),{title:chat.title}),onClick:()=>setExpanded(old=>old.includes(chat.id)?old.filter(id=>id!==chat.id):[...old,chat.id])},[
						h('span',{key:'arrow','aria-hidden':true},open?'⌄':'›'),h('span',{key:'title',title:chat.title},chat.title),
					])),
					h('td',{key:'5h',title:t('quotaUnavailable')},'—'),h('td',{key:'week',title:t('quotaUnavailable')},'—'),
					h('td',{key:'tokens',title:String(chat.totalTokens)},formatTokens(chat.totalTokens)),
					h('td',{key:'share'},`${Number(chat.tokenSharePercent??0).toFixed(2)}%`),
				]));
				if(open) rows.push(h('tr',{key:`detail-${chat.id}`},h('td',{colSpan:5,className:'dsu-chat-detail',id:detailId},[
					h('div',{key:'scroll',style:{overflowX:'auto'}},h('table',{className:'dsu-table'},[
						h('caption',{key:'caption'},t('chatDetails')),
						h('thead',{key:'head'},h('tr',null,['model','input','output','requests'].map(key=>h('th',{key,scope:'col'},t(key))))),
						h('tbody',{key:'body'},(chat.models??[]).map(item=>h('tr',{key:item.id},[h('th',{key:'model',scope:'row'},seriesLabel(item,t)),h('td',{key:'in'},String(item.input)),h('td',{key:'out'},String(item.output)),h('td',{key:'requests'},String(item.requests))]))),
					])),
					(chat.models??[]).length===0?h('p',{key:'empty',className:'dsu-note'},t('noModelUsage')):null,
					typeof ctx.get('uiWorkspace')?.openSession==='function'?h('button',{key:'open',type:'button',className:'dsu-more',onClick:()=>openChat(chat.id)},t('openChat')):null,
				])));
			}
			return h('section',{className:'dsu-analytics','aria-label':t('chatTitle')},[
				h('div',{key:'head'},[h('h4',{key:'title',className:'dsu-section-title'},t('chatTitle')),h('p',{key:'sub',className:'dsu-note'},t('chatSubtitle'))]),
				h('p',{key:'quota',className:'dsu-note'},t('quotaUnavailable')),
				navigationError?h('p',{key:'navigation-error',className:'dsu-note',role:'alert'},t('openChatFailed')):null,
				!analytics?h('p',{key:'unavailable',className:'dsu-note'},t('analyticsUnavailable')):null,
				chats.length>0?h('div',{key:'table',className:'dsu-table-scroll'},h('table',{className:'dsu-table dsu-chat-table'},[
					h('thead',{key:'head'},h('tr',null,['chat','fiveHour','weekly','usedTokens','share'].map(key=>h('th',{key,scope:'col'},t(key))))),
					h('tbody',{key:'body'},rows),
				])):analytics?h('p',{key:'empty',className:'dsu-note',role:failedAll?'alert':undefined},t(failedAll?'allReadFailed':'noActivity')):null,
				chats.length>limit?h('button',{key:'more',className:'dsu-more',type:'button',onClick:()=>setLimit(old=>old+5)},t('showMore')):null,
				limit>5?h('button',{key:'less',className:'dsu-more',type:'button',onClick:()=>setLimit(5)},t('showLess')):null,
			]);
		}

		/** The registered settings page. */
		function UsageSection(props) {
			const { t } = props;
			const [rangeDays, setRangeDays] = React.useState(30);
			const [nonce, setNonce] = React.useState(0);
			useStyles(props.ctx);
			const state = useReport(rangeDays, nonce, t);
			const report = state.report?.rangeDays === rangeDays ? state.report : null;
			const loading = state.status === 'loading' || (state.report !== null && report === null);
			const refresh = h('button', { type: 'button', className: 'dsu-refresh', key: 'refresh', disabled: loading, onClick: () => setNonce(value => value + 1) }, loading ? t('refreshing') : state.status === 'error' ? t('retry') : t('refresh'));

			const head = h('div', { className: 'dsu-head', key: 'head' }, [
				h('div', { key: 'text', style: { flex: '1 1 auto', minWidth: '0' } }, [
					h('h3', { className: 'dsu-title', key: 'title' }, t('title')),
					h('div', { className: 'dsu-intro', key: 'intro' }, t('intro')),
				]),
				h('div', { className: 'dsu-ranges', key: 'ranges', role: 'group', 'aria-label': t('rangeLabel') }, RANGES.map((days) => h('button', {
					key: days,
					type: 'button',
					className: 'dsu-range',
					'aria-pressed': days === rangeDays ? 'true' : 'false',
					onClick: () => { setRangeDays(days); setNonce(0); },
				}, fill(t('rangeDays'), { days })))),
				refresh,
			]);

			if (loading && report === null) {
				return h('div', { className: 'dsu-root', 'aria-busy': true }, [head, h('div', { className: 'dsu-status', key: 'loading', role: 'status' }, t('loading'))]);
			}
			if (state.status === 'error' && report === null) {
				return h('div', { className: 'dsu-root' }, [
					head,
					h('div', { className: 'dsu-status dsu-status-error', key: 'error', role: 'alert' }, fill(t('failed'), { message: state.error })),
				]);
			}

			const totals = report?.totals ?? { input: 0, output: 0, uncachedInput: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
			const meta = report?.meta ?? {};
			const days = report?.days ?? [];
			const generated = report === null ? '' : new Date(report.generatedAt).toLocaleString();

			return h('div', { className: 'dsu-root', 'aria-busy': loading }, [
				head,
				loading ? h('p', { role: 'status', key: 'updating' }, t('refreshing')) : null,
				state.status === 'error' ? h('p', { role: 'alert', key: 'stale', className: 'dsu-status-error' }, t('stale')) : null,
				(meta.skippedSessions ?? 0) + (meta.truncatedSessions ?? 0) > 0 ? h('p', { role: 'status', key: 'partial' }, fill(t('partial'), { skipped: meta.skippedSessions ?? 0, truncated: meta.truncatedSessions ?? 0 })) : null,
				(meta.sessionCount ?? 0) > 0 && (meta.scannedSessions ?? 0) === 0 ? h('p', { role: 'alert', key: 'all-failed' }, t('allFailed')) : null,
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
					h(DailyChart, { key: 'chart', days, t, emptyText: (meta.sessionCount ?? 0) > 0 && (meta.scannedSessions ?? 0) === 0 ? t('allFailed') : undefined }),
					h('details', { key: 'exact-data' }, [
						h('summary', { key: 'toggle' }, t('tableTitle')),
						h('div', { key: 'scroll', style: { overflowX: 'auto' } }, h('table', { style: { width: '100%', textAlign: 'left' } }, [
							h('caption', { key: 'caption' }, t('chartTitle')),
							h('thead', { key: 'head' }, h('tr', null, ['date', 'input', 'output', 'requests'].map(key => h('th', { key, scope: 'col' }, t(key))))),
							h('tbody', { key: 'body' }, days.map(day => h('tr', { key: day.day }, [h('th', { key: 'day', scope: 'row' }, day.day), h('td', { key: 'input' }, String(day.input)), h('td', { key: 'output' }, String(day.output)), h('td', { key: 'requests' }, String(day.requests ?? 0))]))),
						])),
					]),
				]),
				h(ChatRanking, {key:'chats', analytics:report?.analytics, rangeDays, t, ctx:props.ctx, close:props.close, failedAll:(meta.sessionCount??0)>0 && (meta.scannedSessions??0)===0}),
				h(ActivitySection, {key:'tools', kind:'tools', nonce, t}),
				h(ActivitySection, {key:'messages', kind:'messages', nonce, t}),
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
		exports.reportState = reportState;
		exports.UsageSection = UsageSection;
		exports.useReport = useReport;
		exports.ROUTE = ROUTE;
		exports.NS = NS;
		exports.LineChart = LineChart;
		exports.TrendCard = TrendCard;
		exports.ChatRanking = ChatRanking;
		exports.ActivitySection = ActivitySection;
		exports.groupSeries = groupSeries;
		exports.seriesColor = seriesColor;

		module.exports = exports;
		return module.exports;
	},
});
