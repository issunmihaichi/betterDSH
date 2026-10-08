/**
 * Context window panel — browser half.
 *
 * Keeps the composer's small occupancy ring exactly where it is (that ring is the
 * only affordance for context usage) and replaces the popover it opens:
 *
 *   trigger   ◯ 31%                       unchanged: same ring, size, hover tint
 *
 *   popover   Context window      306.1k / 1M (31%)   ›
 *             ███████▍▎▏░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
 *
 *             …and, once the header row is expanded, one row per bucket:
 *             messages, MCP tools, system tools, system prompt, skills, free.
 *             The rows that come from a classification (MCP tools, system tools,
 *             skills) disclose their items when clicked.
 *
 * The shipped ring is not a slot occupant; it is hard-rendered next to this seat
 * inside the composer dock. This panel therefore hides that node and draws its
 * own identical ring (same 14px geometry, 2px stroke, track/fill tokens, hover
 * treatment) so the trigger is visually unchanged while its popover is ours.
 *
 * Numbers come from two places, and never from a guess of our own:
 *   - the live official projections the render tree injects — `contextPressure`
 *     (provider-reported occupancy and route capacity) and `contextBreakdown`
 *     (the official system/tools/messages split);
 *   - the Host half's classification route, which says *which* tools are MCP
 *     (`mcp__<server>__<tool>`) and *which* durable message is DSH's skill
 *     catalog, each priced with DSH's own estimator.
 * Reported nonzero input pressure controls the total. If a provider omits
 * input usage or reports zero, the total falls back to the official heuristic
 * breakdown and carries `~`; the ring and header use the same resolved value.
 * The classification splits those heuristic totals into rows.
 *
 * Shipped as a DSH client bundle (`window.__ModuleLoader__.load`), hand-written
 * in plain JavaScript: React and ReactDOM arrive through the module table and the
 * tree is built with createElement, so editing this file needs no build step.
 */
window.__ModuleLoader__.load({
	id: 'dsh-context-window',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');
		const ReactDOM = require('react-dom');
		const h = React.createElement;

		/** Locale namespace owned by this plugin. */
		const NS = 'contextWindow';
		/** Composer slot the trigger occupies: the dock row below the input card, where the shipped ring meter sits. */
		const SLOT = 'conversation.composer.dock';
		/** Occupant id, unique inside that list slot. */
		const SLOT_ID = 'context-window';
		/** Stylesheet identity, so the tag is injected once per plugin load. */
		const CSS_TAG_ID = 'dsh-context-window/ContextWindow.css';
		/** Host classification route: which tools are MCP, which message is the skill catalog. */
		const DETAIL_ROUTE = 'api/context-window.detail';
		/** Re-read cadence while the popover is open; the Host caches for a few seconds anyway. */
		const DETAIL_REFRESH_MS = 5_000;

		/** Ring geometry, copied from the shipped meter: 14px viewBox, 2px stroke. */
		const RADIUS = 5.5;
		const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
		/** Gap between the trigger and its popover, and the popover's viewport margin. */
		const GAP = 8;
		const MARGIN = 12;

		/**
		 * Segment and swatch tints. Messages reuses the shipped meter's blue; MCP
		 * takes the warn tint, built-in tools the success tint, the system prompt
		 * the shipped meter's neutral, and skills the shipped violet. The free
		 * remainder stays neutral so it reads as empty space, not a category.
		 */
		const TINT = {
			messages: 'var(--dsw-static-blue-450)',
			mcp: 'var(--dsw-alias-state-warn-primary)',
			systemTools: 'var(--dsw-alias-state-success-primary)',
			system: 'var(--dsw-static-neutral-bluish-400)',
			skills: '#a78bfa',
			adjustment: 'var(--dsw-static-neutral-bluish-500)',
			free: 'var(--dsw-alias-border-l3)',
		};

		const zh = {
			title: '上下文窗口',
			messages: '对话消息',
			tools: '工具定义',
			mcpTools: 'MCP 工具',
			systemTools: '系统工具',
			system: '系统提示词',
			skills: '技能',
			free: '剩余空间',
			adjustment: '用量差额',
			expand: '展开分项',
			collapse: '收起分项',
			moreItems: '还有 {count} 项未显示',
			mcpUnnamedServer: '（未命名服务）',
			skillToolNote: 'skill 工具本身 ~{tokens} · 计入系统工具',
			aria: '上下文已用 {percent}',
		};

		const en = {
			title: 'Context window',
			messages: 'Messages',
			tools: 'Tool definitions',
			mcpTools: 'MCP tools',
			systemTools: 'System tools',
			system: 'System prompt',
			skills: 'Skills',
			free: 'Free space',
			adjustment: 'Usage difference',
			expand: 'Expand breakdown',
			collapse: 'Collapse breakdown',
			moreItems: '{count} more not shown',
			mcpUnnamedServer: '(unnamed server)',
			skillToolNote: 'the skill tool itself ~{tokens} · counted under System tools',
			aria: '{percent} of context used',
		};

		const dicts = { zh, en };

		const CSS = `
.dcw-root{position:relative;flex:none;display:inline-flex}
.dcw-trigger{border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:var(--dsh-content-font-size-secondary,13px);font-variant-numeric:tabular-nums;line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:nowrap;cursor:pointer;background:0 0;border:none;flex:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}
.dcw-trigger:hover,.dcw-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dcw-track{fill:none;stroke:var(--dsw-alias-border-l3);stroke-width:2px}
.dcw-fill{fill:none;stroke:var(--dsw-alias-label-tertiary);stroke-width:2px;stroke-linecap:round}
.dcw-tip{position:absolute;left:50%;bottom:calc(100% + 6px);transform:translateX(-50%);z-index:1200;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .1s ease;background:var(--dsw-specific-menu);color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-sm);box-shadow:var(--dsw-elevation-prominent);padding:4px 8px;font-size:12px;line-height:18px;white-space:nowrap}
.dcw-root:hover .dcw-tip,.dcw-root:focus-within .dcw-tip{opacity:1;visibility:visible}
.dcw-panel{position:fixed;z-index:1100;box-sizing:border-box;width:min(264px,100vw - 24px);border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:12px;font-size:12px;line-height:20px}
.dcw-header{display:flex;align-items:center;gap:6px;width:100%;padding:0;background:0 0;border:none;font:inherit;color:inherit;text-align:left;cursor:pointer}
.dcw-title{flex:none;color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:500;line-height:24px}
.dcw-figures{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.dcw-chevron{flex:none;display:grid;place-items:center;color:var(--dsw-alias-label-tertiary);transition:transform .12s ease}
.dcw-chevron-open{transform:rotate(90deg)}
.dcw-bar{display:flex;gap:1px;height:4px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden;margin:10px 0 12px}
.dcw-segment{flex:none;min-width:0;height:100%;border-radius:1px}
.dcw-rest{flex:auto;min-width:0}
.dcw-rows{display:flex;flex-direction:column;gap:2px;margin:6px 0 0;padding:0}
.dcw-row{display:flex;align-items:center;gap:8px;font-size:12px;line-height:20px}
.dcw-term,.dcw-disclosure{display:flex;align-items:center;gap:6px;min-width:0;margin:0;padding:0;background:0 0;border:none;font:inherit;color:inherit;text-align:left}
.dcw-disclosure{cursor:pointer}
.dcw-disclosure:hover .dcw-label{color:var(--dsw-alias-label-primary)}
.dcw-disclosure .dcw-chevron svg{width:12px;height:12px}
.dcw-swatch{flex:none;width:8px;height:8px;border-radius:2px}
.dcw-label{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcw-def{display:flex;align-items:center;gap:8px;margin:0 0 0 auto}
.dcw-value{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.dcw-percent{flex:none;min-width:44px;text-align:right;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dcw-count{flex:none;min-width:20px;text-align:right;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dcw-items{display:flex;flex-direction:column;gap:1px;margin:1px 0 4px 12px;padding:0;border-left:1px solid var(--dsw-alias-border-l2);padding-left:8px}
.dcw-item{display:flex;align-items:baseline;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dcw-item-button{width:100%;background:0 0;border:none;font:inherit;color:inherit;text-align:left;cursor:pointer;padding:0;align-items:center}
.dcw-sections{display:flex;flex-direction:column;gap:2px;margin:8px 0 0;padding:0}
.dcw-section{display:flex;align-items:center;gap:6px;width:100%;padding:0;background:0 0;border:none;font:inherit;color:inherit;text-align:left;cursor:pointer}
.dcw-section:hover .dcw-section-label{color:var(--dsw-alias-label-primary)}
.dcw-section .dcw-chevron svg{width:12px;height:12px}
.dcw-section-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.dcw-section-value{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dcw-section-count{flex:none;min-width:20px;text-align:right;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dcw-list{display:flex;flex-direction:column;gap:1px;max-height:150px;margin:2px 0 4px 10px;padding:0 6px 0 8px;border-left:1px solid var(--dsw-alias-border-l2);overflow-y:auto;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
.dcw-list::-webkit-scrollbar{width:6px}
.dcw-list::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2);border-radius:3px}
.dcw-entry{display:flex;align-items:baseline;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dcw-entry-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcw-entry-value{margin-left:auto;font-variant-numeric:tabular-nums}
.dcw-item-button:hover .dcw-itemname{color:var(--dsw-alias-label-secondary)}
.dcw-itemname{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcw-itemcount{flex:none;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dcw-itemvalue{margin-left:auto;font-variant-numeric:tabular-nums}
.dcw-subitems{display:flex;flex-direction:column;gap:1px;margin:1px 0 2px 14px;padding:0 0 0 8px;border-left:1px solid var(--dsw-alias-border-l2)}
.dcw-more{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px}
`;

		// The stylesheet is written on EVERY module load, not only the first: an HMR
		// reload of this bundle keeps the old <style> tag, so a skip-if-present
		// pattern would leave stale CSS in place until a full page reload.
		if (typeof document !== 'undefined') {
			let tag = document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG_ID)}]`);
			if (tag === null) {
				tag = document.createElement('style');
				tag.dataset.plugin = 'dsh-context-window';
				tag.dataset.pluginCss = CSS_TAG_ID;
				document.head.appendChild(tag);
			}
			if (tag.textContent !== CSS) tag.textContent = CSS;
		}

		/**
		 * Interpolate `{name}` placeholders; missing values stay literal.
		 * @param template - localized template.
		 * @param values - placeholder values.
		 * @returns Filled text.
		 */
		function fill(template, values) {
			return String(template).replace(/\{(\w+)\}/g, (whole, key) => (
				values[key] === undefined ? whole : String(values[key])
			));
		}

		/**
		 * A usable non-negative count; anything else reads 0.
		 * @param value - candidate number.
		 * @returns the number, or 0.
		 */
		function numberOr(value) {
			return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
		}

		/**
		 * Compact token count in the design's own spelling: `49`, `21.5k`, `1M`.
		 * @param value - token count.
		 * @returns Compact count; non-positive and non-finite input reads `0`.
		 */
		function formatCompact(value) {
			if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '0';
			if (value >= 1e6) return `${String(Math.round((value / 1e6) * 10) / 10).replace(/\.0$/, '')}M`;
			if (value >= 1e3) return `${String(Math.round((value / 1e3) * 10) / 10).replace(/\.0$/, '')}k`;
			return String(Math.round(value));
		}

		/**
		 * One-decimal share, as the design shows it (`22.6%`, and `2.2%` for a
		 * half-way `2.15%`): rounding happens on the tenth before formatting, so a
		 * value landing exactly on `x.x5` rounds away from zero instead of falling
		 * to the nearest binary float.
		 * @param ratio - fraction of the context window.
		 * @returns Percent text; non-positive and non-finite input reads `0.0%`.
		 */
		function formatPercent(ratio) {
			if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0) return '0.0%';
			return `${(Math.round(ratio * 1000) / 10).toFixed(1)}%`;
		}

		/**
		 * Bounded display occupancy from the official `contextPressure` projection.
		 * @param pressure - latest token-meter projection.
		 * @returns Occupancy, or null until numerator and capacity are both known.
		 */
		function occupancyOf(pressure, breakdown, detail) {
			const measured = pressure?.projectedTokens ?? pressure?.pressureTokens;
			const capacity = pressure?.contextWindow;
			const compositionTotal = numberOr(breakdown?.messageTokens) + numberOr(breakdown?.toolsTokens) + numberOr(breakdown?.systemTokens);
			const fallback = typeof measured !== 'number' || !Number.isFinite(measured) || (pressure?.pressureTokens === 0 && compositionTotal > 0);
			const correction = detail?.usageCorrection;
			// A legacy sample is corrected only when both halves still refer to the
			// same pressure. A newly normalized sample must never be reduced again.
			const duplicateCache = !fallback && correction?.pressureTokens === pressure?.pressureTokens
				? numberOr(correction?.duplicateCacheTokens) : 0;
			const used = fallback ? (compositionTotal > 0 ? compositionTotal : undefined) : Math.max(0, measured - duplicateCache);
			if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || typeof capacity !== 'number' || !Number.isFinite(capacity) || !(capacity > 0)) return null;
			return {
				used,
				estimated: fallback || (typeof pressure?.pressureTokens === 'number' && measured !== pressure.pressureTokens),
				window: capacity,
				percent: Math.min(100, Math.round((used / capacity) * 100)),
				share: Math.min(1, used / capacity),
			};
		}

		/**
		 * Split one total across weights, without inventing or losing a token:
		 * largest-remainder allocation, so the parts always sum to the whole.
		 * @param total - official token total.
		 * @param weights - non-negative raw weights.
		 * @returns one value per weight, summing exactly to `total`.
		 */
		function distribute(total, weights) {
			const values = (Array.isArray(weights) ? weights : []).map(numberOr);
			const sum = values.reduce((running, weight) => running + weight, 0);
			if (!(total > 0) || !(sum > 0)) return values.map(() => 0);
			const exact = values.map((value) => (total * value) / sum);
			const parts = exact.map((value) => Math.floor(value));
			let remainder = total - parts.reduce((running, part) => running + part, 0);
			const order = exact
				.map((value, index) => ({ index, fraction: value - parts[index] }))
				.sort((left, right) => right.fraction - left.fraction || left.index - right.index);
			for (const entry of order) {
				if (remainder <= 0) break;
				parts[entry.index] += 1;
				remainder -= 1;
			}
			return parts;
		}

		/**
		 * Two-way split, kept as the name the composition reads best with.
		 * @param total - official token total.
		 * @param weights - exactly two weights (MCP first, built-in second).
		 * @returns the two values, summing to `total`.
		 */
		function allocate(total, weights) {
			return distribute(total, weights);
		}

		/**
		 * Composition rows plus the free remainder, all as shares of the window.
		 * With a classification payload the tools bucket splits into MCP and
		 * built-in (normalized onto the official total) and the skill catalog moves
		 * out of the message bucket; without one it stays a single tools row.
		 * @param breakdown - latest `contextBreakdown` projection, or undefined.
		 * @param capacity - context window size in tokens.
		 * @param detail - Host classification payload, or null while unavailable.
		 * @returns `{ rows, free, freeShare, classified }`.
		 */
		function compositionOf(breakdown, capacity, detail, usedTokens) {
			const messageTokens = numberOr(breakdown?.messageTokens);
			const toolsTokens = numberOr(breakdown?.toolsTokens);
			const systemTokens = numberOr(breakdown?.systemTokens);
			const skills = detail?.skills ?? null;
			const skillsTokens = Math.min(numberOr(skills?.tokens), messageTokens);
			const conversationTokens = Math.max(0, messageTokens - skillsTokens);
			const mcp = detail?.tools?.mcp ?? null;
			const systemTools = detail?.tools?.system ?? null;
			const classified = mcp !== null && systemTools !== null;
			const split = classified ? allocate(toolsTokens, [mcp.tokens, systemTools.tokens]) : null;
			const rows = [];
			const push = (definition, value, extra) => {
				if (!(value > 0)) return;
				rows.push({ ...definition, value, share: value / capacity, ...extra });
			};
			push({ key: 'messages', label: 'messages', tint: TINT.messages }, conversationTokens);
			if (split === null) {
				push({ key: 'tools', label: 'tools', tint: TINT.systemTools }, toolsTokens);
			} else {
				// Two disclosure levels for MCP: the servers first (already normalized
				// onto this row's value), then each server's own tools.
				const serverRows = Array.isArray(mcp.servers) ? mcp.servers : [];
				const serverTotals = distribute(split[0], serverRows.map((row) => row.tokens));
				const servers = serverRows.map((row, index) => {
					const tools = Array.isArray(row.items) ? row.items : [];
					// A complete list is normalized onto its server's total; a capped list
					// keeps its own per-tool prices, with the unlisted rest reported by the
					// "more" line instead of being spread over the visible tools.
					const complete = tools.length > 0 && tools.length >= numberOr(row.count);
					const toolTotals = complete
						? distribute(serverTotals[index], tools.map((item) => item.tokens))
						: tools.map((item) => numberOr(item.tokens));
					return {
						key: `server:${String(row.server)}`,
						server: String(row.server ?? ''),
						count: numberOr(row.count),
						tokens: serverTotals[index],
						items: tools.map((item, position) => ({
							name: String(item.name ?? ''),
							rawName: String(item.rawName ?? item.name ?? ''),
							tokens: toolTotals[position],
						})),
					};
				});
				push({ key: 'mcp', label: 'mcpTools', tint: TINT.mcp }, split[0], {
					count: numberOr(mcp.count),
					items: Array.isArray(mcp.items) ? mcp.items : [],
					servers,
				});
				push({ key: 'systemTools', label: 'systemTools', tint: TINT.systemTools }, split[1], {
					count: numberOr(systemTools.count),
					items: Array.isArray(systemTools.items) ? systemTools.items : [],
				});
			}
			push({ key: 'system', label: 'system', tint: TINT.system }, systemTokens);
			if (skills !== null) {
				push({ key: 'skills', label: 'skills', tint: TINT.skills }, skillsTokens, {
					count: numberOr(skills.count),
					items: Array.isArray(skills.items) ? skills.items : [],
					noteTokens: numberOr(skills.tool?.tokens),
				});
			}
			const known = rows.reduce((total, row) => total + row.value, 0);
			const used = typeof usedTokens === 'number' && Number.isFinite(usedTokens) && usedTokens >= 0 ? usedTokens : known;
			const adjustment = used - known;
			if (adjustment !== 0) {
				rows.push({ key: 'adjustment', label: 'adjustment', tint: TINT.adjustment, value: adjustment, share: adjustment / capacity, signed: true });
			}
			const free = Math.max(0, capacity - used);
			// A negative reconciliation has no physical segment. In that case the
			// bar apportions net occupancy by the positive estimates; the legend
			// retains their original values and explicitly shows the signed difference.
			const positiveRows = rows.filter((row) => row.value > 0);
			const positiveTotal = positiveRows.reduce((total, row) => total + row.value, 0);
			const occupiedShare = Math.min(1, used / capacity);
			const barRows = positiveRows.map((row) => ({ ...row, share: positiveTotal > 0 ? occupiedShare * row.value / positiveTotal : 0 }));
			return { rows, barRows, free, freeShare: free / capacity, classified };
		}

		/**
		 * Read the Host classification while the popover is open. Failure is silent:
		 * the panel degrades to the official three-bucket view.
		 * @param sessionId - current session id from the slot props.
		 * @param enabled - whether the popover is open.
		 * @returns the latest payload, or null.
		 */
		function useDetail(sessionId, enabled) {
			const [detail, setDetail] = React.useState(null);
			React.useEffect(() => {
				if (typeof sessionId !== 'string' || sessionId === '') return undefined;
				let cancelled = false;
				const load = () => {
					fetch(`${DETAIL_ROUTE}?session=${encodeURIComponent(sessionId)}`, { headers: { accept: 'application/json' } })
						.then((response) => (response.ok ? response.json() : undefined))
						.then((payload) => {
							if (cancelled || payload === undefined || payload?.error !== undefined) return;
							setDetail(payload);
						})
						.catch(() => {});
				};
				load();
				const timer = enabled ? setInterval(load, DETAIL_REFRESH_MS) : undefined;
				return () => {
					cancelled = true;
					clearInterval(timer);
				};
			}, [sessionId, enabled]);
			return detail?.sessionId === sessionId ? detail : null;
		}

		/**
		 * Hide the shipped ring meter: it is not a slot occupant but a hard-rendered
		 * sibling of this seat's wrapper inside the composer dock row, so the panel
		 * removes it at the DOM level and restores it on unmount. Detection stays
		 * structural rather than depending on a build-hashed class: the meter is a
		 * dialog trigger whose accessible name carries a percentage and whose icon
		 * is the two-circle occupancy ring. The wrapper walk is needed because DSH
		 * renders slot occupants through `display:contents` wrappers, so the element
		 * beside this seat is the wrapper, not the meter.
		 * @param rootRef - ref to this seat's root element.
		 * @param active - whether the seat is actually rendering.
		 */
		function useHideShippedMeter(rootRef, active) {
			React.useEffect(() => {
				if (!active) return undefined;
				const root = rootRef.current;
				if (root === null || typeof getComputedStyle !== 'function') return undefined;
				let container = root.parentElement;
				while (container !== null && container !== document.body && getComputedStyle(container).display === 'contents') {
					container = container.parentElement;
				}
				if (container === null) return undefined;
				const hidden = [];
				const isMeter = (element) => {
					if (element === root || element.contains(root)) return false;
					const trigger = element.querySelector?.('button[aria-haspopup="dialog"][aria-label]');
					if (trigger === null || trigger === undefined) return false;
					if (!/[%％]/.test(trigger.getAttribute('aria-label') ?? '')) return false;
					return trigger.querySelectorAll('svg circle').length >= 2;
				};
				const sweep = () => {
					for (const child of Array.from(container.children)) {
						if (!isMeter(child) || child.style.display === 'none') continue;
						child.style.display = 'none';
						hidden.push(child);
					}
				};
				sweep();
				const observer = new MutationObserver(sweep);
				observer.observe(container, { childList: true });
				return () => {
					observer.disconnect();
					for (const element of hidden) element.style.removeProperty('display');
				};
			}, [rootRef, active]);
		}

		/**
		 * Place the popover above the trigger, centred on it and clamped to the
		 * viewport; it flips below when there is no room above.
		 * @param anchorRef - ref to the trigger.
		 * @param panelRef - ref to the popover.
		 * @param open - whether the popover is mounted.
		 * @param revision - any value that changes the popover's height.
		 * @returns Fixed position, or null until measured.
		 */
		function usePanelPosition(anchorRef, panelRef, open, revision) {
			const [position, setPosition] = React.useState(null);
			React.useEffect(() => {
				if (!open) {
					setPosition(null);
					return undefined;
				}
				const update = () => {
					const anchor = anchorRef.current;
					const panel = panelRef.current;
					if (anchor === null || panel === null) return;
					const box = anchor.getBoundingClientRect();
					const width = panel.offsetWidth;
					const height = panel.offsetHeight;
					const maxLeft = Math.max(MARGIN, window.innerWidth - width - MARGIN);
					const left = Math.min(Math.max(box.left + box.width / 2 - width / 2, MARGIN), maxLeft);
					const above = box.top - GAP - height;
					const top = above >= MARGIN
						? above
						: Math.max(MARGIN, Math.min(window.innerHeight - height - MARGIN, box.bottom + GAP));
					setPosition({ left, top });
				};
				update();
				window.addEventListener('resize', update);
				window.addEventListener('scroll', update, true);
				return () => {
					window.removeEventListener('resize', update);
					window.removeEventListener('scroll', update, true);
				};
			}, [anchorRef, panelRef, open, revision]);
			return position;
		}

		/**
		 * Close the popover on an outside pointer press or Escape.
		 * @param rootRef - ref to the trigger's root (a press inside it is the trigger itself).
		 * @param panelRef - ref to the popover.
		 * @param open - whether the popover is mounted.
		 * @param close - close callback.
		 */
		function useDismiss(rootRef, panelRef, open, close) {
			React.useEffect(() => {
				if (!open) return undefined;
				const onPointerDown = (event) => {
					const target = event.target;
					if (rootRef.current?.contains(target) === true) return;
					if (panelRef.current?.contains(target) === true) return;
					close();
				};
				const onKeyDown = (event) => {
					if (event.key === 'Escape') close();
				};
				document.addEventListener('pointerdown', onPointerDown, true);
				document.addEventListener('keydown', onKeyDown);
				return () => {
					document.removeEventListener('pointerdown', onPointerDown, true);
					document.removeEventListener('keydown', onKeyDown);
				};
			}, [rootRef, panelRef, open, close]);
		}

		/** The occupancy ring: identical geometry and stroke tokens to the shipped meter. */
		function Ring({ percent }) {
			return h('svg', { viewBox: '0 0 14 14', width: '14', height: '14', 'aria-hidden': true }, [
				h('circle', { key: 'track', className: 'dcw-track', cx: '7', cy: '7', r: String(RADIUS) }),
				h('circle', {
					key: 'fill',
					className: 'dcw-fill',
					cx: '7',
					cy: '7',
					r: String(RADIUS),
					strokeDasharray: `${String((CIRCUMFERENCE * percent) / 100)} ${String(CIRCUMFERENCE)}`,
					transform: 'rotate(-90 7 7)',
				}),
			]);
		}

		/** The disclosure chevron, rotated a quarter turn while its section is open. */
		function Chevron({ open }) {
			return h('span', {
				className: open ? 'dcw-chevron dcw-chevron-open' : 'dcw-chevron',
				'aria-hidden': true,
			}, h('svg', { viewBox: '0 0 16 16', width: '16', height: '16' }, h('path', {
				// The shipped meter's path spans x 6.2..10.8, whose ink centre is 8.5 in a
				// 16-unit viewBox — 0.375px right of the box centre at 12px. Shifted 0.5 units
				// left so the triangle's ink bbox is exactly centred; the shape and stroke are
				// unchanged.
				d: 'M5.7 3.4 10.3 8l-4.6 4.6',
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: '1.6',
				strokeLinecap: 'round',
				strokeLinejoin: 'round',
			})));
		}

		/** The whole-window bar: one segment per bucket, then the empty remainder. */
		function OccupancyBar({ rows }) {
			return h('div', { className: 'dcw-bar', 'aria-hidden': true }, [
				...rows.map((row) => h('div', {
					key: row.key,
					className: 'dcw-segment',
					style: { width: `${String(row.share * 100)}%`, background: row.tint },
				})),
				h('div', { key: 'rest', className: 'dcw-rest' }),
			]);
		}

		/**
		 * Flatten one classified row into the entries its section lists. Following the
		 * reference panel, MCP tools carry a `server · tool` prefix rather than a
		 * nested level, and every entry keeps the tool's own price.
		 * @param row - one composition row.
		 * @returns `[{ key, label, title, tokens }]` in the row's own order.
		 */
		function entriesOf(row) {
			const servers = Array.isArray(row.servers) ? row.servers : [];
			if (servers.length > 0) {
				return servers.flatMap((server) => (Array.isArray(server.items) ? server.items : []).map((item) => ({
					key: `${String(server.server)}:${String(item.name)}`,
					label: server.server === ''
						? String(item.rawName ?? item.name)
						: `${String(server.server)} · ${String(item.rawName ?? item.name)}`,
					title: String(item.name),
					tokens: numberOr(item.tokens),
				})));
			}
			return (Array.isArray(row.items) ? row.items : []).map((item) => ({
				key: String(item.name),
				label: String(item.rawName ?? item.name),
				title: String(item.name),
				tokens: numberOr(item.tokens),
			}));
		}

		/**
		 * The disclosure sections under the legend, as the reference panel lays them
		 * out: one row per classified bucket (`MCP tools 21.5k 85`) and, while it is
		 * open, its entries in a scrollable list.
		 */
		function DetailSections(props) {
			const { rows, t, openRow, onToggleRow } = props;
			const sections = rows.filter((row) => entriesOf(row).length > 0);
			if (sections.length === 0) return null;
			return h('div', { className: 'dcw-sections' }, sections.flatMap((row) => {
				const entries = entriesOf(row);
				const open = openRow === row.key;
				const children = [
					h('button', {
						key: `${row.key}:head`,
						type: 'button',
						className: 'dcw-section',
						'aria-expanded': open,
						'aria-label': `${t(row.label)} — ${open ? t('collapse') : t('expand')}`,
						onClick: () => { onToggleRow(row.key); },
					}, [
						h(Chevron, { key: 'chevron', open }),
						h('span', { key: 'label', className: 'dcw-section-label' }, t(row.label)),
						h('span', { key: 'value', className: 'dcw-section-value' }, `~${formatCompact(row.value)}`),
						h('span', { key: 'count', className: 'dcw-section-count' }, String(row.count ?? entries.length)),
					]),
				];
				if (open) {
					const hidden = Math.max(0, numberOr(row.count) - entries.length);
					children.push(h('div', { key: `${row.key}:list`, className: 'dcw-list' }, [
						...entries.map((entry) => h('div', { key: entry.key, className: 'dcw-entry' }, [
							h('span', { key: 'name', className: 'dcw-entry-name', title: entry.title }, entry.label),
							h('span', { key: 'value', className: 'dcw-entry-value' }, `~${formatCompact(entry.tokens)}`),
						])),
						hidden > 0 ? h('div', { key: 'more', className: 'dcw-more' }, fill(t('moreItems'), { count: String(hidden) })) : null,
						numberOr(row.noteTokens) > 0
							? h('div', { key: 'note', className: 'dcw-more' }, fill(t('skillToolNote'), { tokens: formatCompact(row.noteTokens) }))
							: null,
					]));
				}
				return children;
			}));
		}

		/**
		 * The legend: one plain row per bucket, then the free remainder. Following
		 * the reference panel, the rows themselves carry no disclosure — the
		 * classified buckets are disclosed by the sections underneath.
		 */
		function BreakdownRows(props) {
			const { rows, free, freeShare, t } = props;
			const items = [...rows, { key: 'free', label: 'free', value: free, share: freeShare, tint: TINT.free }];
			return h('div', { className: 'dcw-rows' }, items.map((item) => h('div', { key: item.key, className: 'dcw-row' }, [
				h('span', { key: 'head', className: 'dcw-term' }, [
					h('span', { key: 'swatch', className: 'dcw-swatch', style: { background: item.tint }, 'aria-hidden': true }),
					h('span', { key: 'label', className: 'dcw-label' }, t(item.label)),
				]),
				h('span', { key: 'definition', className: 'dcw-def' }, [
					 h('span', { key: 'value', className: 'dcw-value' }, `~${item.signed ? (item.value < 0 ? '−' : '+') : ''}${formatCompact(Math.abs(item.value))}`),
					 h('span', { key: 'percent', className: 'dcw-percent' }, `${item.share < 0 ? '−' : ''}${formatPercent(Math.abs(item.share))}`),
				]),
			])));
		}

		/**
		 * The popover. The header row is the disclosure: the popover opens compact
		 * (title, figures, bar) and the row click reveals the per-bucket legend.
		 */
		function ContextPanel(props) {
			const { occupancy, rows, barRows, free, freeShare, expanded, onToggle, openRow, onToggleRow, t, panelRef, style } = props;
			const figures = `${occupancy.estimated ? '~' : ''}${formatCompact(occupancy.used)} / ${formatCompact(occupancy.window)} (${String(occupancy.percent)}%)`;
			return h('div', {
				ref: panelRef,
				className: 'dcw-panel',
				style: style ?? { visibility: 'hidden', left: 0, top: 0 },
				role: 'dialog',
				'aria-label': t('title'),
				'data-testid': 'context-window-panel',
			}, [
				h('button', {
					key: 'header',
					type: 'button',
					className: 'dcw-header',
					'aria-expanded': expanded,
					'aria-label': expanded ? t('collapse') : t('expand'),
					onClick: onToggle,
				}, [
					h('span', { key: 'title', className: 'dcw-title' }, t('title')),
					h('span', { key: 'figures', className: 'dcw-figures' }, figures),
					h(Chevron, { key: 'chevron', open: expanded }),
				]),
				h(OccupancyBar, { key: 'bar', rows: barRows ?? rows }),
				expanded ? h(BreakdownRows, { key: 'rows', rows, free, freeShare, t }) : null,
				expanded ? h(DetailSections, { key: 'sections', rows, t, openRow, onToggleRow }) : null,
			]);
		}

		/**
		 * The seat: the occupancy ring trigger and, on click, the new popover.
		 * Renders nothing until a provider reports both pressure and capacity,
		 * exactly like the meter it replaces.
		 */
		function ContextMeter(props) {
			const t = props.t ?? ((key) => key);
			const projectionOf = typeof props.useProjection === 'function' ? props.useProjection : () => undefined;
			const pressure = projectionOf('contextPressure');
			const breakdown = projectionOf('contextBreakdown');
			const [open, setOpen] = React.useState(false);
			const [expanded, setExpanded] = React.useState(false);
			const [openRow, setOpenRow] = React.useState(null);
			const rootRef = React.useRef(null);
			const panelRef = React.useRef(null);
			const detail = useDetail(typeof props.sessionId === 'string' ? props.sessionId : undefined, open);
			const occupancy = occupancyOf(pressure, breakdown, detail);
			useHideShippedMeter(rootRef, occupancy !== null);
			useDismiss(rootRef, panelRef, open, () => { setOpen(false); });
			const revision = `${String(expanded)}:${openRow ?? ''}:${String(detail?.generatedAt ?? 0)}`;
			const position = usePanelPosition(rootRef, panelRef, open, revision);
			if (occupancy === null) return null;
			const composition = compositionOf(breakdown, occupancy.window, detail, occupancy.used);
			const reading = `${String(occupancy.percent)}%`;
			const tip = fill(t('aria'), { percent: reading });
			return h('span', { ref: rootRef, className: 'dcw-root', 'data-testid': 'context-window' }, [
				h('button', {
					key: 'trigger',
					type: 'button',
					className: 'dcw-trigger',
					'aria-label': tip,
					'aria-haspopup': 'dialog',
					'aria-expanded': open,
					onClick: () => {
						setExpanded(false);
						setOpenRow(null);
						setOpen(!open);
					},
				}, [
					h(Ring, { key: 'ring', percent: occupancy.percent }),
					h('span', { key: 'reading' }, reading),
				]),
				h('span', { key: 'tip', className: 'dcw-tip', role: 'tooltip' }, tip),
				open ? ReactDOM.createPortal(h(ContextPanel, {
					key: 'panel',
					occupancy,
					rows: composition.rows,
					barRows: composition.barRows,
					free: composition.free,
					freeShare: composition.freeShare,
					expanded,
					onToggle: () => { setExpanded((value) => !value); },
					openRow,
					onToggleRow: (key) => { setOpenRow((current) => (current === key ? null : key)); },
					t,
					panelRef,
					style: position,
				}), document.body) : null,
			]);
		}

		const name = 'dsh-context-window';
		const inject = ['slots', 'locale'];

		/**
		 * Mount the meter into the composer dock.
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			const slots = ctx.get('slots');
			if (slots === undefined) return;
			const locale = ctx.get('locale');
			const t = locale === undefined ? (key) => key : locale.bind(NS);
			if (locale !== undefined) ctx.effect(() => locale.register(NS, dicts), 'context-window: dictionaries');
			slots.inject(SLOT, () => slots.register({
				name: SLOT,
				id: SLOT_ID,
				order: 0,
				locale: NS,
			}, (props) => h(ContextMeter, {
				t,
				useProjection: props.useProjection,
				sessionId: props.sessionId,
			})));
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		exports.NS = NS;
		exports.SLOT = SLOT;
		exports.SLOT_ID = SLOT_ID;
		exports.DETAIL_ROUTE = DETAIL_ROUTE;
		exports.TINT = TINT;
		exports.dicts = dicts;
		exports.fill = fill;
		exports.RADIUS = RADIUS;
		exports.CIRCUMFERENCE = CIRCUMFERENCE;
		exports.formatCompact = formatCompact;
		exports.formatPercent = formatPercent;
		exports.occupancyOf = occupancyOf;
		exports.allocate = allocate;
		exports.distribute = distribute;
		exports.compositionOf = compositionOf;
		exports.ContextMeter = ContextMeter;
		exports.ContextPanel = ContextPanel;
		exports.OccupancyBar = OccupancyBar;
		exports.BreakdownRows = BreakdownRows;
		exports.DetailSections = DetailSections;
		exports.entriesOf = entriesOf;
		exports.Ring = Ring;

		module.exports = exports;
		return module.exports;
	},
});
