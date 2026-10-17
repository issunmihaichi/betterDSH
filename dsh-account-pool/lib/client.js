/**
 * Account pool — browser half.
 *
 * Registers the account-pool and Codex compatibility `settings.section` pages.
 * The pool renders live accounts, cooldowns, bindings and recent usage; the
 * compatibility page manages an explicit, capability-gated compaction setting.
 *
 * Every number comes from the Host half over its two authenticated routes on
 * the `/api` channel. Account rows never expose upstream credentials. The local
 * API card can receive its separate client API key once, on explicit creation
 * or rotation; that key stays in the card's memory until dismissed or left.
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

		// =====================================================================
		// § 1  Constants — routes, ids, vocabularies
		// =====================================================================

		/** Host routes this page reads and writes; document-relative, like the app's other routes. */
		const ACCOUNTS_ROUTE = 'api/accountPool.accounts';
		const USAGE_ROUTE = 'api/accountPool.usage';
		const ACTION_ROUTE = 'api/accountPool.account';
		const OAUTH_ROUTE = 'api/accountPool.oauth';
		/** Locale namespace owned by this plugin. */
		const NS = 'settings.accountPool';
		/** Settings nav cell: fresh id, right after the usage page. */
		const SECTION_ID = 'accountPool';
		const SECTION_ORDER = 14;
		/**
		 * The keyed card the Models page renders on a provider directory row,
		 * dispatched with the Loader entry id.
		 *
		 * The pool switcher that used to be installed as a third tab inside the
		 * shipped add-provider card is gone (DESIGN.md §27): that card is left exactly
		 * as the shell renders it, and 「账号池」 is the only surface that manages pools.
		 */
		const PROVIDER_CARD_SLOT = 'settings.models.provider-card';
		/**
		 * The provider-card key is the Loader ENTRY ID (that is what the Host half
		 * declares as `settingsNs`), and cordis.patch.yml pins that id.
		 */
		const ENTRY_ID = 'account-pool';
		/** Platforms the form offers; must stay in step with the domain enum. */
		const PLATFORMS = ['anthropic', 'openai', 'gemini', 'grok', 'custom'];
		/**
		 * Credential type and Claude Code mode vocabularies. Inlined for the same
		 * reason as `PLATFORMS` — this bundle has no import step — so they must stay
		 * in step with `lib/claude-code/constants.js`. A drifted value here is not
		 * silent: the Host rejects the action with `invalid-argument`.
		 */
		const AUTH_MODES = ['api-key', 'oauth'];
		const SELECTION_MODES = [['sticky', 'modeSticky'], ['load-aware', 'modeLoad'], ['prefer_soonest_reset', 'modeReset'], ['weighted-random', 'modeWeighted']];
		const MIMICRY_MODES = ['off', 'claude-code'];
		const POOL_DETECTION_KEYWORDS = ['号池检测', '池检测', '号池不可用'];
		/** How many usage rows to show. */
		const USAGE_LIMIT = 50;
		/**
		 * A v4 UUID. Reset requests are keyed by one, and an id that fails this test
		 * is discarded rather than replayed, so a corrupt session record can never
		 * turn into a duplicate reset.
		 */
		const RESET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

		const SUPPLIER_PLATFORMS = ['anthropic', 'openai', 'gemini'];
		const SUPPLIER_ZH = {
			connectSupplier: '接入供应商', advancedAdd: '高级新增账号', supplierTitle: '接入供应商',
			supplierHint: '填写供应商信息与 API Key。接入后，在聊天的模型列表里选择该供应商下的模型。',
			openaiApi: '请求格式', openaiTransport: '传输方式', openaiChat: 'Chat Completions（/chat/completions）', openaiResponses: 'Responses（/responses）', openaiHttp: 'HTTP 流式（SSE）', openaiWebSocket: 'WebSocket', openaiWebSocketHint: 'WebSocket 需要上游支持 Responses WebSocket；模型目录仍通过 HTTP 获取。',
			codexWebSocketHint: 'Codex OAuth 使用固定的原生端点，无需选择请求格式。默认使用 HTTP；WebSocket 支持原生连接复用与增量续接，不可用时回退到 HTTP。',
			supplierName: '供应商名称', supplierProtocol: '调用协议', supplierAddress: 'API 地址', supplierKey: 'API Key', supplierModels: '可用模型',
			supplierModelsHint: '多个模型用逗号或换行分隔，也可以从上游获取。', supplierDiscover: '获取模型目录', supplierDiscovering: '正在获取…',
			supplierDiscoveryFailed: '获取失败：{message}。可以手动填写模型后接入。', supplierDiscoveryEmpty: '上游没有返回模型，请手动填写。', supplierDiscoveryDone: '已获取 {n} 个模型，可以编辑后接入。',
			supplierAdvanced: '高级设置', supplierGroup: '加入已有供应商 / 分组', supplierNewGroup: '新建供应商',
			supplierGroupHint: '同一供应商下可接入多个账号。已有分组限制模型时，需要填写它允许的模型。',
			supplierClaudeCode: 'Claude Code 模式', supplierBeta: '可选 Anthropic Beta（逗号分隔）',
			supplierRequired: '请填写供应商名称、API 地址、API Key 和至少一个模型。', supplierUrlInvalid: '请填写完整的 HTTP / HTTPS 地址；OpenAI 兼容也支持 WS / WSS 地址。',
			supplierRestart: '重启 DSH 后可使用简化的供应商接入。现在仍可通过「新增账号」添加。',
			supplierConnected: '已接入 {name}', supplierNext: '打开聊天输入框下方的模型列表，选择「{name}」下的模型，即可开始聊天。',
			supplierAnthropic: 'Claude / Anthropic', supplierOpenai: 'OpenAI 兼容', supplierGemini: 'Gemini API', supplierCustom: '其他 OpenAI 兼容',
		};
		const SUPPLIER_EN = {
			connectSupplier: 'Connect supplier', advancedAdd: 'Advanced account setup', supplierTitle: 'Connect supplier',
			supplierHint: 'Enter the supplier details and API key. After connecting, choose one of its models in the chat model list.',
			openaiApi: 'Request format', openaiTransport: 'Transport', openaiChat: 'Chat Completions (/chat/completions)', openaiResponses: 'Responses (/responses)', openaiHttp: 'HTTP streaming (SSE)', openaiWebSocket: 'WebSocket', openaiWebSocketHint: 'WebSocket requires upstream Responses WebSocket support; model discovery still uses HTTP.',
			codexWebSocketHint: 'Codex OAuth uses a fixed native endpoint, with no request format to choose. HTTP is the default; WebSocket supports native connection reuse and incremental continuation, with HTTP fallback when unavailable.',
			supplierName: 'Supplier name', supplierProtocol: 'API protocol', supplierAddress: 'API URL', supplierKey: 'API key', supplierModels: 'Available models',
			supplierModelsHint: 'Separate models with commas or newlines, or fetch them from the supplier.', supplierDiscover: 'Fetch model list', supplierDiscovering: 'Fetching…',
			supplierDiscoveryFailed: 'Could not fetch models: {message}. You can enter models manually and connect.', supplierDiscoveryEmpty: 'The supplier returned no models. Enter them manually.', supplierDiscoveryDone: 'Fetched {n} models. You can edit them before connecting.',
			supplierAdvanced: 'Advanced settings', supplierGroup: 'Join an existing supplier / group', supplierNewGroup: 'Create a new supplier',
			supplierGroupHint: 'A supplier can contain multiple accounts. If the existing group restricts models, enter models it allows.',
			supplierClaudeCode: 'Claude Code mode', supplierBeta: 'Optional Anthropic betas (comma-separated)',
			supplierRequired: 'Enter a supplier name, API URL, API key and at least one model.', supplierUrlInvalid: 'Enter a full HTTP / HTTPS URL; OpenAI-compatible suppliers also accept WS / WSS URLs.',
			supplierRestart: 'Restart DSH to use simplified supplier setup. You can still use Add account now.',
			supplierConnected: 'Connected {name}', supplierNext: 'Open the model list below the chat input and choose a model under “{name}” to start chatting.',
			supplierAnthropic: 'Claude / Anthropic', supplierOpenai: 'OpenAI compatible', supplierGemini: 'Gemini API', supplierCustom: 'Other OpenAI compatible',
		};

		// =====================================================================
		// § 2  Dictionaries — `zh` and `en` are the same key set, merged with the
		//      supplier block above. Both must stay in lockstep: the locale
		//      registry enforces bilingual balance at registration.
		// =====================================================================

		const zh = {
			...SUPPLIER_ZH,
			colFirstToken: "首字",
			colOutputDuration: "输出时长",
			colOutputTps: "TPS",
			firstTokenHint: "从请求开始到首个文字、思考或工具参数输出，包含重试与换号等待。",
			outputDurationHint: "从首个输出到流结束的耗时，不含首字等待。",
			outputTpsHint: "上游实际输出 Token ÷ 输出秒数；按上游口径包含思考 Token，不估算缺失值。",
			usageTimingUnavailable: "未记录或无法计算",
			usageTimingHint: "首字包含思考与工具参数输出；历史记录未采集的计时显示 —。",
			codexCompatibilityTitle: 'Codex兼容',
			codexCompatibilityIntro: '管理账号池的 Codex OAuth 兼容设置；不会改变其他账号的请求格式或传输方式。',
			codexCompactionTitle: 'v2 加密压缩上下文',
			codexCompactionEnable: '启用 v2 加密压缩上下文（默认关闭）',
			codexCompactionScope: '仅适用于 Codex OAuth 账号，不影响 API Key 或其他平台账号。',
			codexCompactionTiming: '使用原有的自动或手动上下文压缩时机；打开此设置页或保存开关不会发起 LLM 请求。',
			codexCompactionHistory: '切换账号、切换模型或关闭开关后，恢复使用原始对话历史。',
			codexCompactionFallback: '上游不支持时，会在返回 unsupported 前尝试回退到文字摘要；这一尝试可能产生额外用量。',
			codexCompatibilityLoading: '正在读取 Codex 兼容设置…',
			codexCompatibilityRestart: '当前 Host 尚未提供兼容的 Codex 设置接口。请更新并重启 DSH，然后刷新此页。',
			codexCompatibilityUnavailable: 'Codex v2 加密压缩上下文当前不可用，开关无法保存。请确认后端能力已启用并重启 DSH，然后刷新重试。',
			codexCompatibilityReadFailed: '无法读取 Codex 兼容设置。草稿已保留，请刷新重试；不会自动重发保存请求。',
			codexCompatibilitySaved: '已保存 Codex 兼容设置。',
			localApiTitle: '本机 API',
			localApiIntro: '仅监听 127.0.0.1，提供 OpenAI Chat Completions（/v1/chat/completions）；新版 Host 另支持 Responses（/v1/responses）。使用独立 API Key，原始池内密钥不会外泄给调用方。',
			localApiEnable: '启用本机 API', localApiPort: '端口（1024–65535）',
			localApiPortHint: '默认 19389。修改端口并保存会关闭旧监听端口，中断其进行中的调用。',
			localApiInvalidPort: '请输入 1024–65535 之间的整数端口。',
			localApiKeyRequired: '首次使用请先生成并保存 API Key，再启用本机 API。',
			localApiRuntime: '运行状态 (running)', localApiRunning: '运行中', localApiStopped: '未运行',
			localApiBaseUrl: 'Base URL', localApiKeyConfigured: 'API Key (keyConfigured)', localApiError: '服务错误 (error)', localApiNoError: '无',
			localApiLoading: '正在读取本机 API 状态…',
			localApiRestart: '当前 Host 尚未提供兼容的本机 API 接口，无法保存。请更新并重启 DSH，然后刷新。',
			localApiReadFailed: '无法读取最新本机 API 状态，操作已暂停。草稿已保留，请刷新重试。',
			localApiSaved: '已保存本机 API 设置。请以运行状态和服务错误为准。',
			localApiGenerate: '生成 API Key', localApiRotate: '轮换 API Key', localApiConfirmRotate: '确认轮换 API Key',
			localApiRotateWarning: '旧 API Key 将立即失效，使用旧 Key 的后续调用会失败。请更新所有本机客户端；已开始的请求可以完成。确认轮换？',
			localApiKeyCreated: '已生成新的 API Key。',
			localApiKeyOnce: '此 Key 仅在本次响应中显示，请立即复制并妥善保存。关闭显示或离开「设置」后无法再次查看；不会写入浏览器存储或日志。',
			localApiKeyLabel: '本机 API Key（仅显示一次）', localApiCloseKey: '关闭并清除 Key 显示',
			localApiCopyBaseUrl: '复制 Base URL', localApiCopyKey: '复制 API Key',
			localApiBaseUrlCopied: '已复制 Base URL。', localApiKeyCopied: '已复制 API Key。',
			localApiCopyFailed: '未能确认复制成功，请手动选择并复制。',
			localApiDraft: '有未保存的更改；刷新状态不会覆盖草稿。', localApiDiscard: '放弃草稿',
			localApiInvalidReply: 'Host 返回了不兼容的本机 API 响应，未确认成功。请刷新核对状态，不会自动重发操作。',
			tabAutoReview: "Auto Review",
			reviewTitle: "Auto Review 判断模型",
			reviewHint: "选择用于判断指令风险的模型；独立于当前聊天模型。配置保存后，从下一次审核开始生效。",
			reviewPolicyHint: "这里只设置审核模型，不开启自动审批，也不改变审批策略。只有审批流程调用 Auto Review 时才会使用。",
			reviewMode: "判断模型来源",
			reviewSession: "跟随当前会话模型（默认）",
			reviewFixed: "使用指定账号池模型",
			reviewProvider: "账号池 / 分组",
			reviewModel: "判断模型",
			reviewChooseProvider: "请选择账号池",
			reviewChooseModel: "请选择模型",
			reviewLoading: "正在读取审核模型配置…",
			reviewUnavailable: "Auto Review 模型配置暂不可用。请确认审核插件已启用并已更新，然后刷新重试。",
			reviewInvalid: "所选模型当前不可用，请重新选择。审核不会自动回退到聊天模型。",
			reviewSaved: "已保存，下次 Auto Review 判断时生效。",
			usageSummary: '最近 {n} 条 · 成功 {ok} · 失败 {failed} · 输入 {input} / 输出 {output}', usageAccount: '全部账号用量', usageModel: '筛选模型…', cacheDetail: '缓存写 {write} · 推理 {reasoning}',
			fieldPoolDetectionRetry: '池检测重试',
			poolDetectionHint: '命中检测关键词时不冷却账号，仅在输出前重试同一账号；达到重试上限后明确返回失败。次数为额外尝试次数，0 表示不重试。',
			fieldPoolDetectionRetries: '额外重试次数（0–5）',
			fieldPoolDetectionRetryDelayMs: '重试间隔（毫秒，100–10000）',
			fieldPoolDetectionKeywords: '检测关键词（每行一个）',
			poolDetectionKeywordsHint: '按文字关键词匹配，不使用正则；最多 20 项，每项 1–200 字符。',
			poolDetectionInvalid: '请填写 0–5 的整数重试次数、100–10000 毫秒的整数间隔，关键词最多 20 项且每项不超过 200 字符。',
			poolDetectionRestart: '重启 DSH 后可配置池检测重试。',
			fieldBetas: 'Anthropic Beta（多个值用逗号分隔）',
			fieldSelectionMode: '分组调度策略', modeSticky: '粘性会话', modeLoad: '负载感知', modeReset: '最早重置', modeWeighted: '加权随机', pagePrev: '上一页', pageNext: '下一页', pageSize: '每页数量', pageOf: '第 {page} / {total} 页',
			restartRequired: '管理界面已更新。重启 DSH 后可使用账号测试、有效期编辑和新增批量操作。',
			search: '搜索账号、备注、模型或地址…',
			allPlatforms: '全部平台',
			allStates: '全部状态',
			allGroups: '全部分组',
			ungrouped: '未分组',
			noMatches: '没有符合条件的账号',
			shown: '匹配 {n} / 共 {total} 个',
			sortPriority: '按优先级',
			sortName: '按账号名称',
			sortRecent: '按最近使用',
			autoRefresh: '每 15 秒刷新',
			statusPaused: '已暂停调度',
			statusExpired: '已到期',
			actPause: '暂停调度',
			actResume: '恢复调度',
			actResetError: '重置异常',
			actTest: '测试连接',
			fieldNotes: '备注',
			fieldExpiresAt: '有效期（本地时间，留空=永久）',
			fieldLoadFactor: '负载系数（留空=使用并发上限）',
			fieldSchedulable: '允许调度',
			fieldAutoPause: '到期自动暂停',
			colExpires: '有效期', quotaUnknown: '尚未查询', quotaUnsupported: '该类型暂无远端额度接口', quotaStale: '上次成功查询，数据已过期', quotaAt: '查询时间', quotaRemaining: '剩余 {n}%', quotaAmount: '剩余 {n}', quotaReset: '重置 {at}', quotaUnlimited: '无限', quotaCredits: '点数 {n}', quotaNoData: '上游未提供额度窗口', quotaRestart: '重启 DSH 后可使用远端额度查询和 Codex / Gemini 原生调用。', fieldProjectId: 'Google 项目 ID（留空自动发现）', fieldChatgptAccountId: 'ChatGPT 账号 ID（留空读取登录凭据）',
			colLastUsed: '最近使用',
			colAuthMode: '类型',
			exportAction: '导出配置',
			exportHint: '导出账号与分组配置，不包含密钥',
			resultTitle: '操作结果',
			testPassed: '测试成功 · {ms} ms',
			testFailed: '测试失败：{message}',
			actClearCooldown: '清冷却',
			batchEdit: '批量编辑',
			batchEditHint: '仅填写需要统一修改的字段；留空的字段保持原值。',
			batchSave: '应用到所选账号',
			resultDismiss: '收起结果',
			permanent: '永久',

			title: '账号池',
			intro: '管理账号与分组，让每次请求都有清晰的去向。',
			tabAccounts: '账号管理', tabGroups: '分组管理', tabUsage: '请求用量', tabSettings: '设置', poolSettingsTitle: '账号池设置', poolSettingsIntro: '管理账号池的独立功能设置。每项单独保存，沿用原有持久化配置，不会自动开启或改变账号连接。', tabLabel: '账号池管理页面',
			cardGroups: '账号分组', cardGroupsHint: '独立路由，灵活调度',
			accountsHint: '查看账号状态，维护连接与调度配置。', groupsHint: '把账号组织成独立号池，在模型菜单中快速切换。', usageHint: '最近请求的结果、Token 消耗与换号记录。',
			colConnection: '连接 / 凭据', colScheduling: '调度', colActivity: '用量 / 额度',
			viewAccountUsage: '查看用量', accountUsageTitle: '{name} · 用量与额度', accountUsageHint: '显示上游订阅额度；每个窗口按平台自己的周期重置。', refreshAccountUsage: '刷新用量', quotaLoading: '正在查询额度…', quotaRefreshing: '正在更新…', quotaQueryFailed: '额度查询失败，点击刷新重试。', quotaRemainingShort: '余 {n}%', quotaWindowPrimary: '主窗口', quotaWindowSecondary: '次窗口', quotaWindowHours: '{n} 小时', quotaWindowDays: '{n} 天', quotaResetsIn: '{time}后重置', quotaResetPending: '等待上游更新重置窗口', quotaUnknownValue: '未提供用量',
			resetCardRetry: '重查本次使用结果', resetCardUncertain: '上次请求的结果尚未确认。此操作会复用原请求标识，查询同一次使用的结果。',
			resetCards: '重置卡', resetCardsCount: '{n} 张可用', resetCardsUnknown: '尚未查询重置卡', resetCardsFailed: '重置卡查询失败', resetCardsExpired: '卡片到期', resetCardUse: '使用重置卡', resetCardConfirmTitle: '确认使用 {name} 的重置卡？', resetCardConfirmHint: '将消耗此账号的 1 张可用重置卡。实际重置的窗口以上游返回为准。', resetCardConfirm: '确认使用 1 张', resetCardCancel: '取消使用重置卡', resetCardNone: '没有可用重置卡', resetCardRestart: '重启 DSH 后可查询和使用重置卡。', resetCardSuccess: '已使用 1 张重置卡，重置 {n} 个额度窗口。', resetCardCrypto: '当前浏览器无法生成请求标识，请刷新后重试。', resetCardRefreshHint: '使用后会重新查询额度和剩余卡数。',
			moreActions: '更多操作', allModels: '全部模型', clearFilters: '清除筛选',
			sectionConnection: '基本信息与连接', sectionScheduling: '调度与有效期',
			usageRequests: '请求数', usageSuccess: '成功', usageFailures: '失败', usageInput: '输入 Token', usageOutput: '输出 Token',
			refresh: '刷新',
			loading: '正在读取账号池…',
			loadingHint: '正在向 Host 请求账号、分组与用量数据。',
			loadFailedTitle: '无法读取账号池',
			loadFailedHint: 'Host 没有返回账号数据。检查后端是否已重启，然后重试。',
			retryLoad: '重新读取',
			noConnection: '当前环境没有可用的连接',
			readTimeout: '读取超时，请重试。', refreshFailed: '刷新失败，仍显示上次成功读取的数据。',
			oauthDirectoryLoading: '正在读取 OAuth 提供商…', oauthDirectoryFailed: '无法读取 OAuth 提供商',
			empty: '账号池还没有账号。点击「接入供应商」、导入配置或通过 OAuth 登录添加。',
			cardAccounts: '账号',
			cardAccountsHint: '可用 {ready} · 冷却 {cooling} · 异常 {failed}',
			cardRequests: '累计请求',
			cardRequestsHint: '自本插件安装以来',
			cardBindings: '粘性绑定',
			cardBindingsHint: '会话 → 账号',
			accountsTitle: '账号',
			usageTitle: '最近用量',
			colAccount: '账号',
			colStatus: '状态',
			colPriority: '优先级',
			colSlots: '并发',
			colFailures: '连续失败',
			colTime: '时间',
			colModel: '模型',
			usageEffort: '等级 {level}', usageEffortMapped: '等级 {requested} → {mapped}',
			usageEffortUnknown: '等级未记录', usageEffortOmitted: '不发送',
			usageEffortDetail: '选择等级：{requested}；请求映射：{mapped}。按本次请求记录，不代表上游确认。',
			usageEffortUnknownHint: '本条请求未记录等级信息，不根据当前配置推测历史等级。',
			colTokens: '输入 / 输出 / 缓存读',
			colSwitches: '换号',
			colResult: '结果',
			colActions: '操作',
			actEnable: '启用',
			actDisable: '停用',
			batchSelected: '已选 {n} 个',
			batchPickGroup: '选择分组…',
			batchJoin: '加入分组',
			batchLeave: '移出分组',
			batchClear: '清除选择',
			batchDelete: '批量删除',
			batchConfirmDelete: '确认删除 {n} 个',
			actClear: '清冷却',
			actWorking: '处理中…',
			actFailed: '操作失败：{message}',
			providerEnabled: '已启用', providerDisabled: '已停用', fieldGroupEnabled: '启用此模型提供商',
			groupFetchModels: '从上游获取模型', groupFetchingModels: '获取中…',
			groupModelsHint: '读取此分组账号的上游模型目录并更新账号模型列表；分组白名单在保存后生效。',
			groupModelsFetched: '已获取 {n} 个模型，勾选后保存。', groupModelsEmpty: '已获取 0 个模型，原有白名单已保留。', groupModelsFailed: '获取失败：{message}',
			groupModelsSelectAll: '全选', groupModelsClear: '清除选择', groupModelsSearch: '搜索上游模型…', groupModelsSelected: '已选 {n} 个模型',
			providerDeleteHint: '删除「{name}」分组和对应模型入口？分组中的账号会保留。',
			providerHint: '{total} 个账号 · 可用 {ready} · 冷却 {cooling}',
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
			fieldCredential: '密钥 / OAuth 令牌包',
			fieldCredentialKeep: '留空表示不修改',
			fieldModels: '模型（逗号分隔，留空=全部）',
			fieldPriority: '优先级（越小越优先）',
			fieldWeight: '权重',
			fieldConcurrency: '并发上限（0=不限）',
			fieldAuthMode: '凭据类型',
			fieldMimicry: 'Claude Code 模式',
			authModeApiKey: 'API Key（x-api-key）',
			authModeOauth: 'OAuth 订阅号（Bearer）',
			mimicryOff: '关闭',
			mimicryClaudeCode: '伪装成官方 CLI',
			mimicryOn: 'CC 模式',
			actMimicryOn: '开启 CC 模式',
			actMimicryOff: '关闭 CC 模式',
			mimicryHint: 'Claude Code 模式：把该账号的上游请求伪装成官方 CLI —— 改写 system 为官方三块形态、注入 x-anthropic-billing-header 计费块与 metadata.user_id 指纹、对齐 CLI 请求头与 ?beta=true 端点，并补齐 CLI 必发字段（Opus 5.5 不发 temperature）。只有订阅号（OAuth）需要它；开启后客户端原本的 system 提示词会被迁移到首轮对话里，缓存断点跟着一起搬。',
			credConfigured: '已配置',
			credMissing: '未配置',
			credReadOnly: '只读',
			credSource: '来源 {source}',
			importAction: '导入',
			oauthAction: 'OAuth 登录',
			oauthTitle: 'OAuth 登录上游账号',
			oauthHint: '选择提供商并点击「开始登录」，在官方授权页完成登录。本地回调会自动接入账号；需要手动完成时，再粘贴回调地址或 code。',
			oauthProvider: '提供商',
			oauthStart: '开始登录',
			oauthOpen: '打开授权页',
			oauthWaiting: '等待授权…',
			oauthManual: '这个提供商的回调地址在厂商那边，需要你手动把地址栏里的整条 URL（或 code）粘回来。',
			oauthCallback: '本地回调已就绪：授权完成后本页会自动发现（也可以手动粘贴）。',
			oauthInput: '回调地址或 code',
			oauthInputPlaceholder: 'http://localhost:14518/oauth/callback?code=…&state=…',
			oauthFinish: '完成登录',
			oauthCancel: '取消登录',
			oauthDone: '登录成功，账号 {id} 已加入号池',
			oauthCompletedTitle: '登录已完成', oauthCompletedHint: '账号已保存。点击「完成并返回」查看账号列表。', oauthReturn: '完成并返回', oauthAddAnother: '继续添加账号',
			oauthFailed: '登录失败：{message}',
			oauthExpires: '本次登录 {time} 后过期',
			oauthNoCredential: '凭据服务不可用，登录结果无处保存',
			oauthUnverified: '端点未核实',
			oauthCaveat: '注意：{text}',
			oauthCopy: '复制',
			oauthCopied: '已复制',
			oauthCheck: '自检参数',
			oauthCheckOk: '本插件发出去的那几个参数没问题。若浏览器里仍是错误页，请把地址栏里那条 URL（或页面上的错误 JSON）发出来 —— 那是厂商自己的话。',
			oauthCheckProblems: '发现问题：{list}',
			oauthRedirectHost: '回调主机名',
			oauthRedirectHostHint: '厂商那边注册的是哪个就选哪个 —— `localhost` 和 `127.0.0.1` 在它们看来是两个不同的字符串，不会互相兼容。授权页报 invalid_authorize_request／redirect_uri 时先换这个。',
			oauthEmptyProviders: '没有可用的 OAuth 提供商',
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
			formGroupCreate: '新建分组',
			formGroupEdit: '编辑分组 {id}',
			fieldGroupId: 'ID（会成为路由后缀：号池-<ID>）',
			fieldGroupLabel: '名称',
			fieldGroupModels: '模型白名单（逗号分隔，留空=不限）',
			fieldGroupDescription: '说明',
			fieldGroups: '所属分组',
			fieldGroupPriority: '组内优先级（留空=用账号自身优先级）',
			fieldGroupPriorityInherit: '继承',
			accountSaveCheckpoint: '账号 {id} 已保存；组内优先级逐项另存。再次保存会继续未完成步骤；如修改账号字段，则更新此账号，不会再次创建。这不是事务回滚。',
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
			footer: '账号池本机管理 · 用量与重置卡数据来自上游',
		};

		const en = {
			...SUPPLIER_EN,
			colFirstToken: "First token",
			colOutputDuration: "Output duration",
			colOutputTps: "TPS",
			firstTokenHint: "Request start to first text, reasoning or tool-argument output, including retries and account-switch waits.",
			outputDurationHint: "Time from first output to stream termination, excluding the first-token wait.",
			outputTpsHint: "Actual upstream output tokens divided by output seconds; includes reasoning according to the upstream token definition. Missing values are not estimated.",
			usageTimingUnavailable: "Not recorded or cannot be calculated",
			usageTimingHint: "First token includes reasoning and tool arguments; historical records without timing show —.",
			codexCompatibilityTitle: 'Codex compatibility',
			codexCompatibilityIntro: 'Manage Codex OAuth compatibility for the account pool without changing other accounts’ request formats or transports.',
			codexCompactionTitle: 'v2 encrypted context compaction',
			codexCompactionEnable: 'Enable v2 encrypted context compaction (off by default)',
			codexCompactionScope: 'Applies only to Codex OAuth accounts, not API keys or other platforms.',
			codexCompactionTiming: 'Uses the existing automatic or manual context compaction timing. Opening this page or saving the switch does not send an LLM request.',
			codexCompactionHistory: 'Switching accounts, switching models or turning this off restores the original conversation history.',
			codexCompactionFallback: 'If the upstream does not support it, a text-summary fallback is attempted before reporting unsupported. This attempt may incur additional usage.',
			codexCompatibilityLoading: 'Loading Codex compatibility settings…',
			codexCompatibilityRestart: 'This Host does not expose a compatible Codex settings API yet. Update and restart DSH, then refresh this page.',
			codexCompatibilityUnavailable: 'Codex v2 encrypted context compaction is unavailable and cannot be saved. Check backend support and restart DSH, then refresh to retry.',
			codexCompatibilityReadFailed: 'Could not read Codex compatibility settings. Your draft is kept; refresh to retry. Save requests are never replayed automatically.',
			codexCompatibilitySaved: 'Codex compatibility settings saved.',
			localApiTitle: 'Local API',
			localApiIntro: 'Listens only on 127.0.0.1 and exposes OpenAI Chat Completions (/v1/chat/completions); updated Hosts also support Responses (/v1/responses). Uses a separate API key; original pool credentials are never exposed to callers.',
			localApiEnable: 'Enable local API', localApiPort: 'Port (1024–65535)',
			localApiPortHint: 'Default: 19389. Saving a new port closes the old listener and interrupts its in-flight calls.',
			localApiInvalidPort: 'Enter an integer port between 1024 and 65535.',
			localApiKeyRequired: 'First generate and safely save an API key, then enable the local API.',
			localApiRuntime: 'Runtime (running)', localApiRunning: 'Running', localApiStopped: 'Stopped',
			localApiBaseUrl: 'Base URL', localApiKeyConfigured: 'API key (keyConfigured)', localApiError: 'Service error (error)', localApiNoError: 'None',
			localApiLoading: 'Reading local API status…',
			localApiRestart: 'This Host does not expose a compatible local API. Saving is disabled. Update and restart DSH, then refresh.',
			localApiReadFailed: 'Could not read the latest local API status; actions are paused. Your draft is kept. Refresh to retry.',
			localApiSaved: 'Local API settings saved. Check the runtime status and service error below.',
			localApiGenerate: 'Generate API key', localApiRotate: 'Rotate API key', localApiConfirmRotate: 'Confirm API key rotation',
			localApiRotateWarning: 'The old API key will become invalid immediately and subsequent calls using it will fail. Update every local client; requests already started may finish. Rotate the key?',
			localApiKeyCreated: 'A new API key was generated.',
			localApiKeyOnce: 'This key is shown only in this response. Copy it now and store it safely. Closing this display or leaving Settings clears it; it is never written to browser storage or logs.',
			localApiKeyLabel: 'Local API key (shown once)', localApiCloseKey: 'Close and clear key display',
			localApiCopyBaseUrl: 'Copy Base URL', localApiCopyKey: 'Copy API key',
			localApiBaseUrlCopied: 'Base URL copied.', localApiKeyCopied: 'API key copied.',
			localApiCopyFailed: 'Could not confirm the copy succeeded. Select and copy the value manually.',
			localApiDraft: 'Unsaved changes; status refreshes will not overwrite your draft.', localApiDiscard: 'Discard draft',
			localApiInvalidReply: 'The Host returned an incompatible local API response; success was not confirmed. Refresh to check its status. Actions are never replayed automatically.',
			tabAutoReview: "Auto Review",
			reviewTitle: "Auto Review classifier model",
			reviewHint: "Choose the model used to classify command risk, independently of the chat model. Saved changes apply to the next review.",
			reviewPolicyHint: "This setting does not enable automatic approval or change the approval policy. It is used only when the approval flow invokes Auto Review.",
			reviewMode: "Classifier model source",
			reviewSession: "Follow current session model (default)",
			reviewFixed: "Use a specific account pool model",
			reviewProvider: "Account pool / group",
			reviewModel: "Classifier model",
			reviewChooseProvider: "Select an account pool",
			reviewChooseModel: "Select a model",
			reviewLoading: "Loading reviewer model settings…",
			reviewUnavailable: "Auto Review model settings are unavailable. Enable and update the reviewer plugin, then refresh to retry.",
			reviewInvalid: "The selected model is unavailable. Select another; reviews will not silently fall back to the chat model.",
			reviewSaved: "Saved. Applies to the next Auto Review classification.",
			usageSummary: 'Latest {n} records · Success {ok} · Failed {failed} · Input {input} / Output {output}', usageAccount: 'All account usage', usageModel: 'Filter models…', cacheDetail: 'Cache write {write} · Reasoning {reasoning}',
			fieldPoolDetectionRetry: 'Pool detection retry',
			poolDetectionHint: 'Matched detection keywords do not cool down the account. Retry the same account only before output; report failure when the retry limit is reached. The count is additional attempts; 0 disables retries.',
			fieldPoolDetectionRetries: 'Additional retries (0–5)',
			fieldPoolDetectionRetryDelayMs: 'Retry interval (ms, 100–10000)',
			fieldPoolDetectionKeywords: 'Detection keywords (one per line)',
			poolDetectionKeywordsHint: 'Literal keywords, no regular expressions. Up to 20 entries, 1–200 characters each.',
			poolDetectionInvalid: 'Enter integer retries from 0 to 5, an integer interval from 100 to 10000 ms, and up to 20 keywords of at most 200 characters each.',
			poolDetectionRestart: 'Restart DSH to configure pool detection retries.',
			fieldBetas: 'Anthropic betas (comma separated)',
			fieldSelectionMode: 'Group scheduling strategy', modeSticky: 'Sticky session', modeLoad: 'Load aware', modeReset: 'Soonest reset', modeWeighted: 'Weighted random', pagePrev: 'Previous', pageNext: 'Next', pageSize: 'Page size', pageOf: 'Page {page} of {total}',
			restartRequired: 'The management page is updated. Restart DSH to enable account tests, expiry editing and new batch actions.',
			search: 'Search accounts, notes, models or URL…',
			allPlatforms: 'All platforms',
			allStates: 'All statuses',
			allGroups: 'All groups',
			ungrouped: 'Ungrouped',
			noMatches: 'No accounts match these filters',
			shown: 'Showing {n} of {total}',
			sortPriority: 'Priority',
			sortName: 'Account name',
			sortRecent: 'Last used',
			autoRefresh: 'Refresh every 15 seconds',
			statusPaused: 'Scheduling paused',
			statusExpired: 'Expired',
			actPause: 'Pause scheduling',
			actResume: 'Resume scheduling',
			actResetError: 'Reset error',
			actTest: 'Test connection',
			fieldNotes: 'Notes',
			fieldExpiresAt: 'Expires at (local time, blank = permanent)',
			fieldLoadFactor: 'Load factor (blank = concurrency)',
			fieldSchedulable: 'Allow scheduling',
			fieldAutoPause: 'Pause when expired',
			colExpires: 'Expires at', quotaUnknown: 'Not queried', quotaUnsupported: 'No remote quota API for this account type', quotaStale: 'Last successful query; data is stale', quotaAt: 'Queried at', quotaRemaining: '{n}% remaining', quotaAmount: '{n} remaining', quotaReset: 'Resets {at}', quotaUnlimited: 'Unlimited', quotaCredits: 'Credits {n}', quotaNoData: 'Upstream provided no quota windows', quotaRestart: 'Restart DSH to enable remote quota queries and native Codex / Gemini calls.', fieldProjectId: 'Google project ID (discover if blank)', fieldChatgptAccountId: 'ChatGPT account ID (from login if blank)',
			colLastUsed: 'Last used',
			colAuthMode: 'Type',
			exportAction: 'Export configuration',
			exportHint: 'Export account and group configuration without secrets',
			resultTitle: 'Action results',
			testPassed: 'Test passed · {ms} ms',
			testFailed: 'Test failed: {message}',
			actClearCooldown: 'Clear cooldown',
			batchEdit: 'Batch edit',
			batchEditHint: 'Fill only fields to change for all selected accounts; blank fields remain unchanged.',
			batchSave: 'Apply to selected accounts',
			resultDismiss: 'Dismiss results',
			permanent: 'Permanent',

			title: 'Account pool',
			intro: 'Manage accounts and groups, and see where each request goes.',
			tabAccounts: 'Accounts', tabGroups: 'Groups', tabUsage: 'Usage', tabSettings: 'Settings', poolSettingsTitle: 'Account pool settings', poolSettingsIntro: 'Manage independent account-pool features. Each setting saves separately using existing persistence; nothing is enabled automatically and account connections stay unchanged.', tabLabel: 'Account pool pages',
			cardGroups: 'Account groups', cardGroupsHint: 'Independent routes and scheduling',
			accountsHint: 'Monitor account health and manage connections and scheduling.', groupsHint: 'Organize accounts into pools you can select from the model menu.', usageHint: 'Recent request results, token usage and account switches.',
			colConnection: 'Connection / credential', colScheduling: 'Scheduling', colActivity: 'Usage / quota',
			viewAccountUsage: 'View usage', accountUsageTitle: '{name} · Usage and quota', accountUsageHint: 'Subscription quota from the provider; each window resets on its own schedule.', refreshAccountUsage: 'Refresh usage', quotaLoading: 'Querying quota…', quotaRefreshing: 'Updating…', quotaQueryFailed: 'Quota query failed. Refresh to retry.', quotaRemainingShort: '{n}% left', quotaWindowPrimary: 'Primary window', quotaWindowSecondary: 'Secondary window', quotaWindowHours: '{n} hours', quotaWindowDays: '{n} days', quotaResetsIn: 'Resets in {time}', quotaResetPending: 'Waiting for the provider to update this window', quotaUnknownValue: 'Usage not provided',
			resetCardRetry: 'Check this reset result', resetCardUncertain: 'The previous request has no confirmed result. This reuses its request ID to recover the same operation.',
			resetCards: 'Reset cards', resetCardsCount: '{n} available', resetCardsUnknown: 'Reset cards not queried', resetCardsFailed: 'Reset card query failed', resetCardsExpired: 'Card expires', resetCardUse: 'Use reset card', resetCardConfirmTitle: 'Use a reset card for {name}?', resetCardConfirmHint: 'This consumes one available reset card on this account. The provider determines which windows reset.', resetCardConfirm: 'Confirm use of 1 card', resetCardCancel: 'Cancel reset card use', resetCardNone: 'No reset cards available', resetCardRestart: 'Restart DSH to query and use reset cards.', resetCardSuccess: 'Used 1 reset card and reset {n} quota windows.', resetCardCrypto: 'This browser cannot create a request ID. Refresh and retry.', resetCardRefreshHint: 'Quota and card count are queried again after use.',
			moreActions: 'More actions', allModels: 'All models', clearFilters: 'Clear filters',
			sectionConnection: 'Account & connection', sectionScheduling: 'Scheduling & expiry',
			usageRequests: 'Requests', usageSuccess: 'Succeeded', usageFailures: 'Failed', usageInput: 'Input tokens', usageOutput: 'Output tokens',
			refresh: 'Refresh',
			loading: 'Reading the account pool…',
			loadingHint: 'Requesting accounts, groups, and usage from the Host.',
			loadFailedTitle: 'The account pool could not be read',
			loadFailedHint: 'The Host returned no account data. Check that the backend has restarted, then retry.',
			retryLoad: 'Read again',
			noConnection: 'No usable connection in this environment',
			readTimeout: 'The read timed out. Please retry.', refreshFailed: 'Refresh failed. Showing the last successfully read data.',
			oauthDirectoryLoading: 'Reading OAuth providers…', oauthDirectoryFailed: 'OAuth providers could not be read',
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
			colStatus: 'Status',
			colPriority: 'Priority',
			colSlots: 'Slots',
			colFailures: 'Failures',
			colTime: 'Time',
			colModel: 'Model',
			usageEffort: 'Level {level}', usageEffortMapped: 'Level {requested} → {mapped}',
			usageEffortUnknown: 'Level not recorded', usageEffortOmitted: 'Not sent',
			usageEffortDetail: 'Selected level: {requested}; request mapping: {mapped}. Recorded for this request, not confirmed by the upstream.',
			usageEffortUnknownHint: 'This request has no recorded level. Historical levels are not inferred from current settings.',
			colTokens: 'in / out / cache-read',
			colSwitches: 'Switches',
			colResult: 'Result',
			colActions: 'Actions',
			actEnable: 'Enable',
			actDisable: 'Disable',
			batchSelected: '{n} selected',
			batchPickGroup: 'Pick a group…',
			batchJoin: 'Add to group',
			batchLeave: 'Remove from group',
			batchClear: 'Clear selection',
			batchDelete: 'Delete selected',
			batchConfirmDelete: 'Confirm deleting {n}',
			actClear: 'Clear cooldown',
			actWorking: 'Working…',
			actFailed: 'Action failed: {message}',
			providerEnabled: 'Enabled', providerDisabled: 'Disabled', fieldGroupEnabled: 'Enable this model provider',
			groupFetchModels: 'Fetch models from upstream', groupFetchingModels: 'Fetching…',
			groupModelsHint: 'Fetch this group’s upstream catalogs and refresh account model lists. The group allowlist takes effect after saving.',
			groupModelsFetched: 'Fetched {n} models. Select models, then save.', groupModelsEmpty: 'Fetched 0 models. The existing allowlist has been kept.', groupModelsFailed: 'Fetch failed: {message}',
			groupModelsSelectAll: 'Select all', groupModelsClear: 'Clear selection', groupModelsSearch: 'Search upstream models…', groupModelsSelected: '{n} models selected',
			providerDeleteHint: 'Delete the group “{name}” and its model entry? Its accounts will be kept.',
			providerHint: '{total} accounts · {ready} ready · {cooling} cooling',
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
			fieldCredential: 'API key / OAuth credential bundle',
			fieldCredentialKeep: 'Leave blank to keep',
			fieldModels: 'Models (comma separated; blank = all)',
			fieldPriority: 'Priority (lower wins)',
			fieldWeight: 'Weight',
			fieldConcurrency: 'Concurrency cap (0 = unlimited)',
			fieldAuthMode: 'Credential type',
			fieldMimicry: 'Claude Code mode',
			authModeApiKey: 'API key (x-api-key)',
			authModeOauth: 'OAuth subscription (Bearer)',
			mimicryOff: 'Off',
			mimicryClaudeCode: 'Impersonate the official CLI',
			mimicryOn: 'CC mode',
			actMimicryOn: 'Enable CC mode',
			actMimicryOff: 'Disable CC mode',
			mimicryHint: 'Claude Code mode: disguise this account’s upstream request as the official CLI — rebuilds `system` into the official three blocks, injects the x-anthropic-billing-header block plus the metadata.user_id fingerprint, aligns the CLI headers and the ?beta=true endpoint, and fills the fields the CLI always sends (Opus 5.5 gets no temperature). Only subscription (OAuth) accounts need it; enabling it migrates the client’s own system prompt into the first turn of the conversation, cache breakpoint included.',
			credConfigured: 'set',
			credMissing: 'unset',
			credReadOnly: 'read-only',
			credSource: 'from {source}',
			importAction: 'Import',
			oauthAction: 'OAuth sign-in',
			oauthTitle: 'Sign in an upstream account over OAuth',
			oauthHint: 'Choose a provider and start the login on its official consent page. A local callback adds the account automatically; paste the callback URL or code only when manual completion is needed.',
			oauthProvider: 'Provider',
			oauthStart: 'Start login',
			oauthOpen: 'Open the consent page',
			oauthWaiting: 'Waiting for authorization…',
			oauthManual: 'This provider sends the callback to its own page, so paste the whole URL from the address bar (or the code) back here.',
			oauthCallback: 'The local callback listener is up: this page discovers the result on its own (pasting still works).',
			oauthInput: 'Callback URL or code',
			oauthInputPlaceholder: 'http://localhost:14518/oauth/callback?code=…&state=…',
			oauthFinish: 'Finish login',
			oauthCancel: 'Cancel login',
			oauthDone: 'Signed in — account {id} was added to the pool',
			oauthCompletedTitle: 'Sign-in complete', oauthCompletedHint: 'Your account is saved. Select Done and return to view the account list.', oauthReturn: 'Done and return', oauthAddAnother: 'Add another account',
			oauthFailed: 'Login failed: {message}',
			oauthExpires: 'This login expires in {time}',
			oauthNoCredential: 'The credentials service is unavailable, so a login could not be stored',
			oauthUnverified: 'endpoints unverified',
			oauthCaveat: 'Note: {text}',
			oauthCopy: 'Copy',
			oauthCopied: 'Copied',
			oauthCheck: 'Check parameters',
			oauthCheckOk: 'Every parameter this pool controls looks right. If the browser still shows an error page, send the URL from the address bar (or the error JSON on the page) — that is the vendor’s own message.',
			oauthCheckProblems: 'Problem found: {list}',
			oauthRedirectHost: 'Callback hostname',
			oauthRedirectHostHint: 'Pick the spelling the vendor registered — `localhost` and `127.0.0.1` are two different strings to them and are not interchangeable. Switch this first when the consent page answers invalid_authorize_request / redirect_uri.',
			oauthEmptyProviders: 'No OAuth provider is available',
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
			formGroupCreate: 'New group',
			formGroupEdit: 'Edit group {id}',
			fieldGroupId: 'ID (becomes the route suffix: pool-<ID>)',
			fieldGroupLabel: 'Name',
			fieldGroupModels: 'Model allow-list (comma separated; blank = any)',
			fieldGroupDescription: 'Description',
			fieldGroups: 'Groups',
			fieldGroupPriority: 'Priority within each pool (blank = inherit the account’s own)',
			fieldGroupPriorityInherit: 'inherit',
			accountSaveCheckpoint: 'Account {id} was saved; group priorities are separate writes. Save again to continue unfinished steps, or update this account if its fields changed. It will not be created again. This is not a transaction rollback.',
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
			footer: 'Local account management · Usage and reset card data come from the provider',
		};

		Object.assign(zh, { attributionTest: '模型归因测试', attributionStart: '确认开始 · 3 次调用', attributionCost: '固定此账号执行 3 次采样，可能消耗额度；每次请求预算 {tokens} 输出 token，超时 {seconds} 秒。当前 Codex OAuth 不发送此 token 上限，不能保证最大账单。', attributionModel: '测试模型：{model}', attributionConfigure: '开关和参数在「模型归因」插件设置', attributionRunning: '归因中 · {done}/3', attributionCancel: '取消归因', attributionReference: '参考接近：{model}', attributionDetails: '归因结果', attributionCaveat: '仅为参考集行为匹配，不是模型身份认证；内置参考库 astra/sol 合并，更新后的参考库按其标签比较。', attributionNoScore: '样本不足，未确认', attributionCancelled: '归因已取消', attributionFailed: '归因出错', attributionRefresh: '刷新归因状态', attributionChanged: '账号或测试设置已变更，请刷新并重新确认。' });
		Object.assign(en, { attributionTest: 'Model attribution test', attributionStart: 'Confirm · 3 calls', attributionCost: 'Pin this account for 3 probes; usage may be charged. Request budget: {tokens} output tokens, {seconds}s per probe. Current Codex OAuth does not send this token cap; it is not a billing limit.', attributionModel: 'Probe model: {model}', attributionConfigure: 'Configure in the Model attribution plugin', attributionRunning: 'Attribution · {done}/3', attributionCancel: 'Cancel attribution', attributionReference: 'Closest reference: {model}', attributionDetails: 'Attribution result', attributionCaveat: 'Closed-set behavioral comparison, not identity authentication. The bundled reference merges astra/sol; updated references use their own labels.', attributionNoScore: 'Insufficient samples; unconfirmed', attributionCancelled: 'Attribution cancelled', attributionFailed: 'Attribution failed', attributionRefresh: 'Refresh attribution status', attributionChanged: 'Account or probe settings changed. Refresh and confirm again.' });
		Object.assign(zh, { attributionPaused: '行为不匹配 · 已自动暂停调度', attributionAlreadyPaused: '行为不匹配 · 账号已经暂停调度', attributionPauseFailed: '自动暂停失败，请刷新并检查账号调度', attributionPauseUnavailable: '自动暂停不可用，请升级账号池或手动暂停', attributionAutoPauseNote: '已开启不匹配自动暂停：3 条有效采样且其他参考模型库内概率 ≥90% 时暂停此账号。可在「模型归因」插件设置关闭；行为比较不是身份认证。' });
		Object.assign(en, { attributionPaused: 'Behavior mismatch · scheduling paused automatically', attributionAlreadyPaused: 'Behavior mismatch · account already paused', attributionPauseFailed: 'Automatic pause failed; refresh and check scheduling', attributionPauseUnavailable: 'Automatic pause unavailable; upgrade the pool or pause manually', attributionAutoPauseNote: 'Automatic pause enabled: 3 valid samples and ≥90% closed-set probability for another reference model pauses this account. Disable in Model attribution settings. Not identity verification.' });
		Object.assign(zh, { attributionBatch: '批量模型归因', attributionBatchConfirm: '确认批量归因 · {n} 个账号 · {calls} 次调用', attributionBatchCost: '按顺序逐个账号执行，每个账号 3 次模型调用，共 {n} 个账号、最多 {calls} 次调用；可能产生费用，不自动重试提交。', attributionBatchLimit: '每批最多 100 个账号，请减少选择后重试。', attributionBatchUnready: '所选账号中有未就绪或未提供模型归因的账号；请调整选择。', attributionBatchProgress: '批量归因 · {done}/{total} 个账号 · {state}', attributionBatchCancel: '取消批量归因', attributionBatchUnavailable: '无法读取批量归因状态，请刷新重试；不会自动重新提交。', attributionBatchQueued: '排队中', attributionBatchRunning: '执行中', attributionBatchCompleted: '已完成', attributionBatchSkipped: '已跳过', attributionBatchError: '出错', attributionBatchCancelled: '已取消', attributionBatchCancelling: '正在取消，等待当前账号退出…' });
		Object.assign(en, { attributionBatch: 'Batch model attribution', attributionBatchConfirm: 'Confirm batch · {n} accounts · {calls} calls', attributionBatchCost: 'Run accounts sequentially, 3 model calls per account: {n} accounts, up to {calls} calls. Usage may be charged. Submissions are never retried automatically.', attributionBatchLimit: 'At most 100 accounts per batch. Reduce the selection and retry.', attributionBatchUnready: 'Some selected accounts are not ready or do not support model attribution. Adjust the selection.', attributionBatchProgress: 'Batch attribution · {done}/{total} accounts · {state}', attributionBatchCancel: 'Cancel batch attribution', attributionBatchUnavailable: 'Could not read batch attribution status. Refresh to retry; the batch will not be resubmitted automatically.', attributionBatchQueued: 'Queued', attributionBatchRunning: 'Running', attributionBatchCompleted: 'Completed', attributionBatchSkipped: 'Skipped', attributionBatchError: 'Error', attributionBatchCancelled: 'Cancelled', attributionBatchCancelling: 'Cancellation requested; waiting for the current account to stop…' });
		const dicts = { zh, en };

		// =====================================================================
		// § 3  Stylesheet — one `<style>` tag, scoped under `.dap-root`, coloured
		//      entirely through `--dsw-alias-*` platform variables so the page
		//      follows the shell's light/dark theme without a second stylesheet.
		// =====================================================================

		const CSS = `
.dap-attribution{display:grid;gap:5px;margin-top:14px;max-width:190px;font-size:11px;overflow-wrap:anywhere}.dap-attribution .dap-btn{padding:4px 7px;font-size:11px;min-height:28px;justify-self:start}.dap-attribution p{margin:0}.dap-attribution-confirm{display:grid;gap:6px}.dap-attribution details{max-width:100%;white-space:normal}
.dap-root{--dap-accent:var(--dsw-alias-brand-primary,#4263eb);--dap-surface:var(--dsw-alias-bg-layer-1,#fff);--dap-base:var(--dsw-alias-bg-base,#f7f8fb);--dap-border:var(--dsw-alias-border-l1,#e8ebf1);--dap-text:var(--dsw-alias-label-primary,#202635);--dap-muted:var(--dsw-alias-label-secondary,#7b8495);--dap-soft:color-mix(in srgb,var(--dap-accent) 7%,var(--dap-surface));display:flex;flex-direction:column;gap:22px;min-width:0;padding:8px 0 24px;color:var(--dap-text);font-size:13px;line-height:1.55}
.dap-root *{box-sizing:border-box}.dap-root [hidden]{display:none!important}
.dap-models-provider[data-native-edit=true] .dap-provider-edit-fallback{display:none}.dap-models-provider{padding:12px 20px;gap:12px}.dap-models-provider[data-expanded=false]{display:none}.dap-models-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.dap-provider-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none;background:var(--dsw-alias-state-success-primary,#20c56b)}.dap-provider-dot[data-enabled=false]{background:var(--dsw-alias-label-tertiary,#777)}.dap-provider-state{font-size:12px;color:var(--dap-muted)}.dap-provider-state[data-enabled=true]{color:var(--dsw-alias-state-success-primary,#208669)}
.dap-head{display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap;padding:4px 0 2px}
.dap-head-text{display:flex;gap:14px;align-items:center;flex:1 1 270px;min-width:0}.dap-heading-copy{min-width:0}
.dap-brand-mark{display:grid;place-items:center;flex:none;width:46px;height:46px;border:1px solid color-mix(in srgb,var(--dap-accent) 18%,var(--dap-border));border-radius:14px;background:var(--dap-soft);color:var(--dap-accent)}
.dap-title{margin:0;font-size:24px;font-weight:650;letter-spacing:-.5px;line-height:1.35;color:var(--dsw-alias-label-primary,#202635)}
.dap-intro{margin:5px 0 0;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary,#7b8495)}
.dap-icon{width:17px;height:17px;flex:none;stroke:currentColor;stroke-width:1.7;fill:none;stroke-linecap:round;stroke-linejoin:round}
.dap-head-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.dap-btn,.dap-refresh{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;border:1px solid var(--dsw-alias-border-l1,#e8ebf1);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#202635);border-radius:8px;padding:5px 11px;font:inherit;font-size:12px;line-height:20px;font-weight:500;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s,color .15s}
.dap-btn:hover:not(:disabled),.dap-refresh:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4263eb) 6%,var(--dsw-alias-bg-layer-1,#fff));border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4263eb) 32%,var(--dsw-alias-border-l1,#e8ebf1))}
.dap-btn:disabled,.dap-refresh:disabled,.dap-input:disabled{opacity:.5;cursor:default}.dap-btn-primary{color:var(--dsw-alias-bg-base,#fff);background:var(--dsw-alias-brand-primary,#4263eb);border-color:var(--dsw-alias-brand-primary,#4263eb)}.dap-btn-primary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4263eb) 88%,#000);color:var(--dsw-alias-bg-base,#fff);border-color:transparent}
.dap-btn-danger{color:var(--dsw-alias-state-error-primary,#db5262)}.dap-btn-soft{color:var(--dsw-alias-brand-primary,#4263eb);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4263eb) 8%,var(--dsw-alias-bg-layer-1,#fff));border-color:transparent}
.dap-root :is(button,input,select,textarea,summary):focus-visible{outline:2px solid var(--dap-accent);outline-offset:3px}
.dap-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.dap-card{min-width:0;border:1px solid var(--dap-border);border-radius:13px;background:var(--dap-surface);padding:17px 18px;box-shadow:0 2px 5px #00000003}.dap-card-top{display:flex;justify-content:space-between;align-items:center;gap:10px}.dap-card-icon{display:grid;place-items:center;width:30px;height:30px;border-radius:9px;background:var(--dap-soft);color:var(--dap-accent)}.dap-card-label{font-size:12px;color:var(--dap-muted);font-weight:500}.dap-card-value{margin-top:8px;font-size:28px;line-height:1.3;font-weight:650;letter-spacing:-.6px;color:var(--dap-text);font-variant-numeric:tabular-nums}.dap-card-hint{margin-top:6px;font-size:11px;line-height:1.6;color:var(--dap-muted)}
.dap-workspace{display:flex;flex-direction:column;gap:16px;min-width:0}.dap-tabs{display:flex;gap:6px;border-bottom:1px solid var(--dap-border);padding:0 2px;overflow-x:auto}.dap-tab{display:inline-flex;align-items:center;justify-content:center;gap:8px;flex:none;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dap-muted);font:inherit;font-size:13px;font-weight:500;padding:11px 14px 13px;cursor:pointer}.dap-tab[aria-selected=true]{border-bottom-color:var(--dap-accent);color:var(--dap-accent)}.dap-tab:hover{color:var(--dap-text)}.dap-tab-count{font-size:10px;line-height:18px;min-width:20px;text-align:center;padding:0 5px;border-radius:5px;background:color-mix(in srgb,var(--dap-muted) 9%,var(--dap-surface));color:var(--dap-muted)}.dap-tab[aria-selected=true] .dap-tab-count{background:var(--dap-soft);color:var(--dap-accent)}
.dap-panel{min-width:0;border:1px solid var(--dap-border);border-radius:13px;background:var(--dap-surface)}.dap-panel-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:18px 20px 14px;flex-wrap:wrap}.dap-panel-title{margin:0;font-size:14px;font-weight:600;color:var(--dap-text)}.dap-panel-subtitle{font-size:11px;color:var(--dap-muted);margin:3px 0 0}.dap-panel-count{font-size:11px;color:var(--dap-muted)}
.dap-toolbar{display:flex;gap:9px;flex-wrap:wrap;align-items:center;padding:0 20px 16px}.dap-toolbar .dap-input{max-width:100%;min-height:34px}.dap-toolbar .dap-check-label{margin-left:auto;color:var(--dap-muted);font-size:11px}.dap-search-box{position:relative;flex:1 1 240px;min-width:180px}.dap-search-box>.dap-icon{position:absolute;top:10px;left:10px;color:var(--dap-muted);pointer-events:none}.dap-search-box>.dap-search{width:100%;padding-left:34px}.dap-filter-meta{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-basis:100%;padding-top:3px;font-size:11px;color:var(--dap-muted)}.dap-pagination{border-top:1px solid var(--dap-border);padding:12px 20px;justify-content:space-between}.dap-pagination .dap-input{width:68px;min-height:30px}.dap-pagination .dap-check-label{margin-left:0}.dap-pagination-nav{display:flex;align-items:center;gap:10px}.dap-page-label{font-size:11px;color:var(--dap-muted)}
.dap-usage-table{min-width:1050px}.dap-usage-table td:first-child,.dap-usage-table td:nth-child(2){white-space:nowrap}.dap-usage-table td:nth-child(3){min-width:140px}.dap-usage-table .dap-timing{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.dap-timing-hint{margin:0 22px 12px;color:var(--dap-muted);font-size:11px;line-height:1.6}
.dap-table-wrap{max-width:100%;overflow-x:auto;border-radius:0 0 12px 12px}.dap-table{width:100%;border-collapse:collapse;font-size:12px;line-height:1.5}.dap-table th{text-align:left;font-weight:500;font-size:11px;color:var(--dap-muted);padding:11px 16px;background:color-mix(in srgb,var(--dap-muted) 4%,var(--dap-surface));border-block:1px solid var(--dap-border);white-space:nowrap}.dap-table td{padding:15px 16px;border-bottom:1px solid var(--dap-border);color:var(--dap-text);vertical-align:top}.dap-table tbody tr:last-child td{border-bottom:0}.dap-table tbody tr:hover{background:color-mix(in srgb,var(--dap-accent) 3%,var(--dap-surface))}.dap-table tr[data-selected=true]{background:var(--dap-soft)}.dap-account-table{min-width:850px}.dap-account-table .dap-cell-select{width:35px;padding-left:18px;padding-right:0}.dap-account-table .dap-cell-account{width:23%;min-width:170px}.dap-account-table .dap-cell-protocol{width:15%}.dap-account-table .dap-cell-status{width:14%}.dap-account-table .dap-cell-schedule{width:12%}.dap-account-table .dap-cell-activity{width:18%}.dap-account-table .dap-cell-actions{width:18%;white-space:nowrap}.dap-account-table th,.dap-account-table td{padding-left:12px;padding-right:12px}
.dap-identity{display:flex;gap:10px;align-items:flex-start;min-width:0}.dap-avatar{display:grid;place-items:center;flex:none;width:32px;height:32px;border:1px solid var(--dap-border);background:var(--dap-base);color:var(--dap-accent);border-radius:9px;font-size:12px;font-weight:600}.dap-identity-copy{min-width:0}.dap-account-name{font-size:12px;font-weight:600;overflow-wrap:anywhere;max-width:240px}.dap-cell-meta{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:5px;font-size:11px;color:var(--dap-muted)}.dap-cell-stack{display:flex;flex-direction:column;gap:5px;font-size:11px}.dap-row-tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:7px}.dap-tag{display:inline-block;padding:1px 6px;border:1px solid var(--dap-border);border-radius:5px;font-size:10px;color:var(--dap-muted);max-width:100%;overflow-wrap:anywhere}.dap-protocol{font-weight:500;font-size:12px}.dap-num{font-variant-numeric:tabular-nums;white-space:nowrap}.dap-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px}.dap-dim{color:var(--dsw-alias-label-secondary,#7b8495)}.dap-note{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:1.6;margin-top:3px}.dap-pill{display:inline-flex;align-items:center;gap:5px;border-radius:6px;padding:2px 7px;font-size:11px;line-height:18px;white-space:nowrap;border:1px solid transparent;font-weight:500}.dap-pill::before{content:'';width:5px;height:5px;border-radius:50%;background:currentColor}.dap-pill-ready{color:var(--dsw-alias-state-success-primary,#208669);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#208669) 9%,transparent)}.dap-pill-cooling{color:var(--dsw-alias-state-warn-primary,#b78224);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b78224) 10%,transparent)}.dap-pill-failed{color:var(--dsw-alias-state-error-primary,#d04f60);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d04f60) 9%,transparent)}.dap-pill-idle{color:var(--dap-muted);background:color-mix(in srgb,var(--dap-muted) 9%,transparent)}
.dap-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.dap-cell-actions .dap-btn{min-height:28px;padding:3px 8px;font-size:11px}.dap-more{position:relative;display:inline-block}.dap-more>summary{display:flex;align-items:center;justify-content:center;gap:4px;list-style:none;cursor:pointer;min-height:28px;border-radius:7px;padding:4px 6px;color:var(--dap-muted);font-size:11px}.dap-more>summary>span{font-size:20px;line-height:20px}.dap-more>summary::-webkit-details-marker{display:none}.dap-more[open]>summary,.dap-more>summary:hover{background:var(--dap-soft);color:var(--dap-accent)}.dap-more-menu{position:fixed;z-index:1000;min-width:176px;border:1px solid var(--dap-border);background:var(--dap-surface);border-radius:10px;padding:6px;box-shadow:0 8px 26px #00000016;display:flex;flex-direction:column;gap:2px}.dap-more-menu .dap-btn{justify-content:flex-start;width:100%;border:0;background:transparent;min-height:32px;padding:6px 9px;font-weight:400}.dap-more-menu .dap-btn-danger{border-top:1px solid var(--dap-border);border-radius:0 0 5px 5px;margin-top:3px}.dap-row-more{padding:0;border:0;background:transparent;color:var(--dap-muted);font:inherit;font-size:10px;cursor:pointer}.dap-row-more>summary{list-style:none}.dap-row-more>summary::-webkit-details-marker{display:none}.dap-row-more[open]>summary{color:var(--dap-accent);margin-bottom:8px}.dap-row-more .dap-quota{min-width:0;max-width:230px}
.dap-batch{display:flex;flex-wrap:wrap;gap:7px;align-items:center;padding:13px 16px;margin:0 20px 16px;border:1px solid color-mix(in srgb,var(--dap-accent) 20%,var(--dap-border));border-radius:9px;background:var(--dap-soft)}.dap-batch-count{font-size:11px;color:var(--dap-accent);font-weight:600;margin-right:4px}.dap-status{padding:22px 20px;font-size:12px;color:var(--dap-muted);line-height:1.7}.dap-empty{display:flex;flex-direction:column;align-items:center;gap:12px;text-align:center;padding:48px 24px}.dap-empty-icon{display:grid;place-items:center;width:48px;height:48px;border:1px solid var(--dap-border);border-radius:14px;background:var(--dap-base);color:var(--dap-muted)}.dap-empty-icon>.dap-icon{width:23px;height:23px}
.dap-state{display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center;padding:56px 24px;border:1px solid var(--dap-border);border-radius:13px;background:var(--dap-surface)}.dap-state-title{margin:0;font-size:14px;font-weight:600;color:var(--dap-text)}.dap-state-hint{margin:0;max-width:52ch;font-size:12px;line-height:1.7;color:var(--dap-muted)}.dap-state-detail{margin:0;max-width:60ch;padding:9px 12px;border-radius:8px;background:var(--dap-base);border:1px solid var(--dap-border);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.7;color:var(--dsw-alias-state-error-primary,#d04f60);overflow-wrap:anywhere}.dap-state-icon{display:grid;place-items:center;width:48px;height:48px;border:1px solid var(--dap-border);border-radius:14px;background:var(--dap-base);color:var(--dap-muted)}.dap-state-icon>.dap-icon{width:23px;height:23px}.dap-state-error .dap-state-icon{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d04f60) 30%,var(--dap-border));color:var(--dsw-alias-state-error-primary,#d04f60)}
.dap-spinner{width:26px;height:26px;border:2px solid color-mix(in srgb,var(--dap-accent) 22%,transparent);border-top-color:var(--dap-accent);border-radius:50%;animation:dap-spin .7s linear infinite}@keyframes dap-spin{to{transform:rotate(360deg)}}
.dap-foot{font-size:11px;line-height:1.6;color:var(--dap-muted);padding:0 2px}
.dap-form{border:1px solid var(--dap-border);border-radius:12px;background:var(--dap-surface);padding:22px;display:flex;flex-direction:column;gap:20px;margin:0 20px 20px;min-width:0}.dap-form-title{font-size:15px;font-weight:600;color:var(--dap-text);letter-spacing:-.1px}.dap-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.dap-form-section{margin:0;padding:18px 0 0;border:0;border-top:1px solid var(--dap-border);min-width:0}.dap-form-section>legend{padding:0 10px 0 0;font-size:12px;font-weight:600;color:var(--dap-text)}.dap-form-section .dap-form-grid{margin-top:3px}.dap-field{display:flex;flex-direction:column;gap:7px;min-width:0}.dap-field-label{font-size:11px;color:var(--dsw-alias-label-secondary,#7b8495);font-weight:500}.dap-input{border:1px solid var(--dsw-alias-border-l1,#e8ebf1);border-radius:8px;background:var(--dsw-alias-bg-base,#f7f8fb);color:var(--dsw-alias-label-primary,#202635);font:inherit;font-size:12px;line-height:20px;padding:8px 10px;min-width:0;max-width:100%;transition:border-color .15s}.dap-input::placeholder{color:var(--dsw-alias-label-secondary,#7b8495);opacity:.75}.dap-input:focus{border-color:var(--dsw-alias-brand-primary,#4263eb)}.dap-form .dap-input{width:100%}.dap-form .dap-dim{font-size:11px;line-height:1.7}.dap-form-actions{display:flex;justify-content:flex-end;gap:8px;border-top:1px solid var(--dap-border);padding-top:16px}.dap-form-actions .dap-btn{min-width:74px}.dap-textarea{min-height:170px;width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.7;white-space:pre;resize:vertical}.dap-detection{padding:16px;border-radius:10px;background:var(--dap-base);border:1px solid var(--dap-border);gap:12px}.dap-check-label{display:flex;gap:8px;align-items:center;font-size:12px;line-height:1.6}.dap-root input[type=checkbox]{width:14px;height:14px;flex:none;accent-color:var(--dap-accent);cursor:pointer;margin:0}.dap-check-prio{border:1px solid var(--dap-border);border-radius:6px;background:var(--dap-base);color:var(--dap-text);padding:5px 7px;width:110px;font:inherit;font-size:11px}.dap-group-options{display:flex;flex-wrap:wrap;gap:8px}.dap-group-options>label{display:flex;align-items:center;gap:7px;padding:8px 10px;border:1px solid var(--dap-border);border-radius:7px;background:var(--dap-base)}
.dap-cred-set{color:var(--dsw-alias-state-success-primary,#208669);font-size:10px}.dap-cred-missing{color:var(--dsw-alias-state-warn-primary,#b78224);font-size:10px}.dap-error{font-size:11px;line-height:1.7;color:var(--dsw-alias-state-error-primary,#d04f60)}.dap-result{margin:0;padding:16px 20px;background:var(--dap-soft);border:1px solid color-mix(in srgb,var(--dap-accent) 18%,var(--dap-border));border-radius:10px;font-size:12px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere}.dap-result>strong{margin-right:12px}.dap-result>.dap-btn{float:right}.dap-result>div{margin-top:8px}
.dap-group-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;padding:0 20px 20px}.dap-group-card{border:1px solid var(--dap-border);border-radius:11px;padding:18px;display:flex;flex-direction:column;gap:12px;min-width:0}.dap-group-heading{display:flex;gap:10px;align-items:center}.dap-group-heading .dap-avatar{background:var(--dap-soft);color:var(--dap-accent)}.dap-group-name{font-size:13px;font-weight:600;overflow-wrap:anywhere}.dap-group-meta{display:flex;flex-wrap:wrap;gap:7px;color:var(--dap-muted);font-size:11px}.dap-group-models{display:flex;gap:5px;flex-wrap:wrap;min-height:24px}.dap-group-footer{display:flex;justify-content:space-between;gap:8px;align-items:center;padding-top:12px;border-top:1px solid var(--dap-border);margin-top:auto}.dap-group-desc{font-size:11px;color:var(--dap-muted);margin:0;overflow-wrap:anywhere}
.dap-quota{min-width:0;max-width:none;font-size:12px;line-height:1.65}.dap-quota-window{margin:7px 0;min-width:0}.dap-quota-window-head{display:flex;justify-content:space-between;gap:8px;align-items:baseline}.dap-quota-window-head>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dap-quota-window-head>strong{font-weight:600;font-size:11px}.dap-quota-window>progress{display:block;width:100%;height:5px;margin:5px 0;border:0;border-radius:6px;overflow:hidden;background:var(--dap-base);--dap-meter:var(--dsw-alias-state-success-primary,#208669);accent-color:var(--dap-meter)}.dap-quota-window>progress[data-tone=warn]{--dap-meter:var(--dsw-alias-state-warn-primary,#b78224)}.dap-quota-window>progress[data-tone=low]{--dap-meter:var(--dsw-alias-state-error-primary,#d04f60)}.dap-quota-window>progress::-webkit-progress-bar{background:var(--dap-base);border-radius:6px}.dap-quota-window>progress::-webkit-progress-value{background:var(--dap-meter);border-radius:6px}.dap-quota-window>progress::-moz-progress-bar{background:var(--dap-meter);border-radius:6px}.dap-quota-summary{min-width:140px;display:flex;flex-direction:column;align-items:stretch;gap:3px}.dap-quota-summary .dap-quota-window{margin:2px 0}.dap-quota-summary .dap-quota-window-head{font-size:10px}.dap-quota-summary .dap-quota-reset{font-size:9px;overflow-wrap:anywhere}.dap-quota-summary>.dap-error{font-size:10px}.dap-quota-plan{display:inline-flex;align-items:center;align-self:flex-start;justify-self:start;width:fit-content;max-width:100%;padding:1px 7px;border:1px solid var(--dap-border);border-radius:5px;color:var(--dap-accent);font-size:10px;font-weight:600;overflow-wrap:anywhere;background:var(--dap-soft)}.dap-usage-link{text-align:left;color:var(--dap-accent);font-size:11px;margin-top:4px;align-self:flex-start}.dap-usage-link:hover{text-decoration:underline}.dap-last-used{font-size:10px;overflow-wrap:anywhere}.dap-reset-count{font-size:10px;margin-top:3px}.dap-account-usage-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}.dap-account-usage-head .dap-form-title{margin:0;overflow-wrap:anywhere}.dap-account-usage-head p{margin:6px 0 0}.dap-account-usage-grid{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:22px}.dap-account-usage .dap-quota{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-content:start}.dap-account-usage .dap-quota>.dap-quota-plan,.dap-account-usage .dap-quota>.dap-dim,.dap-account-usage .dap-quota>.dap-error,.dap-quota-balance{grid-column:1/-1}.dap-account-usage .dap-quota-window{padding:12px;border:1px solid var(--dap-border);border-radius:9px;margin:0;background:var(--dap-base)}.dap-account-usage .dap-quota-window>progress{background:var(--dap-border);margin:10px 0}.dap-account-usage .dap-quota-window>progress::-webkit-progress-bar{background:var(--dap-border)}.dap-quota-balance{overflow-wrap:anywhere}.dap-reset-credits{display:flex;flex-direction:column;gap:10px;border-left:1px solid var(--dap-border);padding-left:22px;min-width:0;font-size:12px}.dap-reset-heading{display:flex;align-items:center;justify-content:space-between;gap:10px}.dap-reset-heading>strong{font-size:13px}.dap-reset-credits p{margin:0;font-size:11px;line-height:1.7}.dap-reset-credits>.dap-btn{align-self:flex-start;margin-top:4px}.dap-reset-expiry{overflow-wrap:anywhere}.dap-reset-confirm{padding:14px;border:1px solid color-mix(in srgb,var(--dap-accent) 25%,var(--dap-border));border-radius:9px;background:var(--dap-soft);display:flex;flex-direction:column;gap:10px;min-width:0}.dap-reset-confirm>strong{font-size:12px;overflow-wrap:anywhere}.dap-reset-confirm .dap-actions{gap:8px}.dap-reset-confirm .dap-btn{white-space:normal;text-align:center}.dap-usage-summary{display:flex;gap:20px;flex-wrap:wrap;margin:0 20px 18px;padding:14px 16px;border-radius:9px;background:var(--dap-base);font-size:11px;color:var(--dap-muted)}.dap-usage-summary strong{display:block;font-size:17px;line-height:1.4;color:var(--dap-text);font-weight:600;font-variant-numeric:tabular-nums}
.dap-upstream-models{display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--dap-border);border-radius:8px}.dap-model-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 14px;max-height:220px;overflow:auto}.dap-model-option{display:flex;align-items:center;gap:7px;min-width:0;font-size:12px;overflow-wrap:anywhere}.dap-model-option input{flex:none}
.dap-models-hint{font-size:11px;color:var(--dsw-alias-label-secondary,#7b8495)}
.dap-local-api{margin-bottom:18px}.dap-local-api-status{display:grid;grid-template-columns:minmax(130px,auto) minmax(0,1fr);gap:8px 18px;margin:0;font-size:12px}.dap-local-api-status dt{color:var(--dap-muted)}.dap-local-api-status dd{margin:0;overflow-wrap:anywhere}.dap-local-api-confirm,.dap-local-api-secret{display:flex;flex-direction:column;gap:12px;padding:16px;border:1px solid var(--dap-border);border-radius:10px;background:var(--dap-base);min-width:0}.dap-local-api-confirm p{margin:0}.dap-local-api-secret{border-color:color-mix(in srgb,var(--dap-accent) 35%,var(--dap-border));background:var(--dap-soft)}.dap-local-api-secret input{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}@media(max-width:580px){.dap-local-api-status{grid-template-columns:1fr;gap:4px}.dap-local-api-status dd{margin-bottom:8px}.dap-local-api .dap-actions{gap:8px}.dap-local-api .dap-btn{white-space:normal;text-align:center}}
.dap-usage-table .dap-usage-model{min-width:174px}.dap-usage-model-name{display:block;white-space:nowrap}.dap-usage-effort{display:inline-block;margin-top:5px;padding:1px 6px;border:1px solid var(--dap-border);border-radius:5px;background:var(--dap-soft);color:var(--dap-accent);font-size:10px;line-height:18px;overflow-wrap:anywhere}.dap-usage-effort[data-recorded=false]{padding:0;border:0;background:transparent;color:var(--dap-muted)}
@media(max-width:1100px){.dap-head{align-items:flex-start}.dap-head-actions{flex-basis:100%}.dap-cards{gap:10px}.dap-card{padding:15px}.dap-account-table .dap-cell-actions .dap-actions{gap:3px}}
@media(max-width:760px){.dap-account-usage-grid{grid-template-columns:1fr;gap:18px}.dap-reset-credits{padding:18px 0 0;border-left:0;border-top:1px solid var(--dap-border)}.dap-root{gap:18px}.dap-cards{grid-template-columns:repeat(2,minmax(0,1fr))}.dap-card-value{font-size:25px}.dap-group-grid{grid-template-columns:1fr}.dap-panel-head{padding:16px}.dap-toolbar{padding-left:16px;padding-right:16px}.dap-batch,.dap-form{margin-left:16px;margin-right:16px}.dap-form{padding:18px}.dap-toolbar .dap-input{flex:1 1 120px}.dap-search-box{flex-basis:100%}.dap-tabs{gap:0}.dap-tab{padding-left:12px;padding-right:12px}.dap-usage-summary{margin-left:16px;margin-right:16px}}
@media(max-width:580px){.dap-tabs{overflow-x:visible}.dap-tab{flex:1 1 0;min-width:0;gap:6px;padding:11px 6px}.dap-tab .dap-icon{width:15px;height:15px}.dap-tab-count{display:none}.dap-pagination .dap-check-label{white-space:nowrap}.dap-pagination .dap-input{flex:none;width:58px}.dap-title{font-size:22px}.dap-brand-mark{width:40px;height:40px;border-radius:12px}.dap-head-actions{gap:6px}.dap-head-actions>.dap-btn,.dap-head-actions>.dap-refresh{font-size:11px;padding:5px 9px}.dap-card-hint{font-size:10px}.dap-form-grid{grid-template-columns:1fr}.dap-account-table{display:block;min-width:0}.dap-account-table thead{display:none}.dap-account-table tbody{display:block}.dap-account-table tr{display:grid;grid-template-columns:1fr 1fr;gap:12px 18px;padding:20px 16px;border-top:1px solid var(--dap-border);position:relative}.dap-account-table td{display:block;padding:0!important;border:0;min-width:0;width:auto!important}.dap-account-table .dap-cell-select{position:absolute;right:18px;top:22px}.dap-account-table .dap-cell-account{grid-column:1/-1;min-width:0;padding-right:30px!important}.dap-account-table .dap-cell-activity{grid-column:1/-1}.dap-account-table .dap-cell-activity .dap-quota-summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 14px}.dap-cell-activity .dap-quota-summary>.dap-quota-plan,.dap-cell-activity .dap-quota-summary>.dap-dim,.dap-cell-activity .dap-quota-summary>.dap-error,.dap-cell-activity .dap-quota-summary>.dap-usage-link{grid-column:1/-1}.dap-account-usage .dap-quota{grid-template-columns:1fr}.dap-account-usage-head>.dap-actions{width:100%}.dap-account-usage-head>.dap-actions>.dap-btn{flex:1}.dap-account-table .dap-cell-actions{grid-column:1/-1;border-top:1px solid var(--dap-border);padding-top:12px!important}.dap-account-table .dap-cell-actions .dap-actions{gap:7px}.dap-account-table .dap-cell-schedule::before{content:attr(data-label);display:block;color:var(--dap-muted);font-size:10px;margin-bottom:5px}.dap-account-name{max-width:none}.dap-more-menu{left:0;right:auto}.dap-table-wrap{overflow:visible}.dap-panel:has(.dap-usage-table) .dap-table-wrap{overflow-x:auto}.dap-usage-table{min-width:700px}.dap-note{max-width:230px}.dap-pagination{gap:12px}.dap-form-actions{justify-content:stretch}.dap-form-actions>.dap-btn{flex:1}.dap-status{padding:18px 16px}.dap-empty{padding:36px 20px}}
@media(prefers-reduced-motion:reduce){.dap-btn,.dap-refresh,.dap-input{transition:none}.dap-spinner{animation-duration:2.4s}}
`;

		// Each bundle owns its node. Older bundles restore before newer ones so
		// a delayed cleanup/recovery during hot reload cannot override newer CSS.
		const STYLE_GENERATION_KEY = Symbol.for('dsh-account-pool.styles.generation');
		const styleGeneration = (window[STYLE_GENERATION_KEY] ?? 0) + 1;
		window[STYLE_GENERATION_KEY] = styleGeneration;
		let styleUsers = 0;
		let styleElement = null;
		let styleObserver = null;
		let observedHead = null;

		function ensureStyles() {
			if (styleUsers === 0) return;
			const head = document.head;
			if (styleObserver !== null && observedHead !== head) {
				styleObserver.disconnect();
				// Also notice replacement of head, without observing body updates.
				styleObserver.observe(document.documentElement, { childList: true });
				if (head !== null) styleObserver.observe(head, { childList: true, characterData: true, subtree: true });
				observedHead = head;
			}
			if (head === null) return;
			if (styleElement.textContent !== CSS) styleElement.textContent = CSS;
			if (styleElement.parentNode !== head) {
				const newer = [...head.querySelectorAll('style[data-dsh-plugin="dsh-account-pool"]')]
					.find((element) => Number(element.getAttribute('data-dap-style-generation')) > styleGeneration);
				if (newer) head.insertBefore(styleElement, newer);
				else head.appendChild(styleElement);
			}
		}

		/** Plugin and mounted roots hold independent, idempotent style leases. */
		function acquireStyles() {
			styleUsers += 1;
			if (styleElement === null) {
				styleElement = document.createElement('style');
				styleElement.setAttribute('data-dsh-plugin', 'dsh-account-pool');
				styleElement.setAttribute('data-dap-style-generation', String(styleGeneration));
				if (typeof MutationObserver !== 'undefined') {
					styleObserver = new MutationObserver(ensureStyles);
					styleObserver.observe(document.documentElement, { childList: true });
				}
			}
			ensureStyles();
			let released = false;
			return () => {
				if (released) return;
				released = true;
				styleUsers -= 1;
				if (styleUsers !== 0) return;
				styleObserver?.disconnect();
				styleObserver = null;
				observedHead = null;
				if (styleElement.parentNode !== null) styleElement.parentNode.removeChild(styleElement);
				styleElement = null;
			};
		}

		function insertStyles(ctx) {
			return ctx.effect(acquireStyles, 'account-pool: stylesheet');
		}

		function useStyles() {
			React.useEffect(acquireStyles, []);
		}

		// =====================================================================
		// § 4  Hooks — the only stateful code in the bundle. They are called from
		//      `PoolSection` (and the two provider halves), never from a child
		//      component, so the render tree stays pure and the offline test can
		//      expand it without a hook runtime. In call order: useJson,
		//      useAction, useResetCredits, useAccountQuotas, useMoreMenuDismissal,
		//      useNow.
		// =====================================================================

		/** Authenticated JSON transport shared by reads and operator actions. */
		async function poolJson(route, init, t) {
			if (typeof fetch !== 'function') throw new Error(t('noConnection'));
			const response = await fetch(route, { ...init, credentials: 'same-origin' });
			const body = await response.json().catch(() => null);
			if (!response.ok || body === null) {
				const error = new Error(body?.error?.message ?? `HTTP ${String(response.status)}`);
				error.actionBody = body;
				throw error;
			}
			return body;
		}

		/** Read one Host route; `nonce` re-runs it. */
		function useJson(route, nonce, t) {
			const [state, setState] = React.useState({ status: 'loading', body: null, error: null });
			React.useEffect(() => {
				let alive = true;
				const controller = new AbortController();
				const timeout = setTimeout(() => controller.abort(), 30000);
				setState((previous) => ({ status: 'loading', body: previous.body, error: null }));
				(async () => {
					try {
						const body = await poolJson(route, {
							method: 'GET',
							headers: { accept: 'application/json' },
							signal: controller.signal,
						}, t);
						if (!alive) return;
						setState({ status: 'ready', body, error: null });
					} catch (error) {
						if (!alive) return;
						setState((previous) => ({ status: 'error', body: previous.body, error: error.name === 'AbortError' ? t('readTimeout') : error instanceof Error ? error.message : String(error) }));
					} finally { clearTimeout(timeout); }
				})();
				return () => { alive = false; clearTimeout(timeout); controller.abort(); };
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
			const [state, setState] = React.useState({ pending: false, error: null, result: null });
			const [busyId, setBusyId] = React.useState(null);
			const locked = React.useRef(false);
			const mounted = React.useRef(true);
			React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
			function run(id, action, extra, onResult, onFailure) {
				// React's disabled state lands on the next render, not this event turn.
				if (locked.current || !mounted.current) return Promise.resolve(false);
				locked.current = true;
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
						const batchResult = action === 'batch' && Array.isArray(body?.done) && Array.isArray(body?.failed);
						if (!response.ok || body === null || (body.ok !== true && !batchResult)) {
							const failure = new Error(body?.error?.message ?? `HTTP ${String(response.status)}`);
							failure.actionBody = body;
							throw failure;
						}
						if (!mounted.current) return false;
						setState({ pending: false, error: null, result: body });
						setBusyId(null);
						onResult?.(body);
						refresh();
						return true;
					} catch (error) {
						if (!mounted.current) return false;
						setState({ pending: false, error: error instanceof Error ? error.message : String(error) });
						setBusyId(null);
						onFailure?.(error.actionBody ?? null);
						return false;
					} finally { locked.current = false; }
				})();
			}
			return { pending: state.pending, busyId, error: state.error, result: state.result, dismiss: () => setState((previous) => ({ ...previous, result: null })), run };
		}

		/**
		 * The reset-credit flow. A reset may have been applied by the provider even
		 * when the reply never arrived, so the request id is persisted per account
		 * and replayed on the next attempt instead of issuing a second reset.
		 */
		function useResetCredits(t, action, quotaData) {
			const [confirmation, setConfirmation] = React.useState(null);
			const [error, setError] = React.useState(null);
			const sending = React.useRef(false);
			const requests = React.useRef(null);
			if (requests.current === null) {
				try {
					const saved = JSON.parse(globalThis.sessionStorage?.getItem('dsh-account-pool:pending-resets') || '{}');
					requests.current = Object.fromEntries(Object.entries(saved).filter(([, value]) => RESET_ID_PATTERN.test(value?.requestId || '')).slice(-100));
				} catch { requests.current = {}; }
			}
			function save() {
				try { globalThis.sessionStorage?.setItem('dsh-account-pool:pending-resets', JSON.stringify(requests.current)); } catch { /* The in-memory ID still supports recovery if browser storage is unavailable. */ }
			}
			/** The confirmation to re-open when this account already has a live id. */
			function restoreFor(account) {
				const saved = requests.current[quotaAccountKey(account)];
				return saved ? { ...saved, id: account.id, name: account.label || account.id, key: quotaAccountKey(account), dispatched: true } : null;
			}
			function begin(account, usagePending) {
				if (!account || action.pending || usagePending) return;
				setError(null);
				const key = quotaAccountKey(account);
				const saved = requests.current[key];
				const requestId = saved?.requestId || globalThis.crypto?.randomUUID?.();
				if (!requestId) { setError(t('resetCardCrypto')); return; }
				setConfirmation({ id: account.id, name: account.label || account.id, key, requestId, dispatched: !!saved });
			}
			async function confirm(account, resetReady) {
				if (!account || !confirmation || confirmation.id !== account.id || sending.current || action.pending || !resetReady) return;
				const key = quotaAccountKey(account);
				if (confirmation.key && confirmation.key !== key) return;
				const requestId = confirmation.requestId;
				sending.current = true;
				setError(null);
				requests.current[key] = { requestId, dispatched: true };
				save();
				try {
					await action.run(account.id, 'quota-reset', { confirm: true, requestId }, (body) => {
						delete requests.current[key]; save();
						setConfirmation(null);
						quotaData.applyResult(account, body);
					}, (body) => {
						const uncertain = !body || body.uncertain === true;
						const restoredId = RESET_ID_PATTERN.test(body?.requestId || '') ? body.requestId : requestId;
						if (uncertain) {
							requests.current[key] = { requestId: restoredId, dispatched: true }; save();
							setConfirmation({ id: account.id, name: account.label || account.id, key, requestId: restoredId, dispatched: true });
						} else {
							delete requests.current[key]; save(); setConfirmation(null);
						}
						setError(body?.error?.message || t('resetCardUncertain'));
						if (body?.resetCredits) quotaData.applyResult(account, { quota: quotaData.forAccount(account).quota, resetCredits: body.resetCredits });
					});
				} finally { sending.current = false; }
			}
			function cancel() { setConfirmation(null); setError(null); }
			return { confirmation, setConfirmation, error, setError, begin, confirm, cancel, restoreFor };
		}

		/**
		 * The row "更多" menus are native `<details>`, which stay open when the user
		 * clicks elsewhere. One listener pair closes them on an outside pointer,
		 * Escape, scroll, or resize.
		 */
		function useMoreMenuDismissal() {
			React.useEffect(() => {
				const closeMenus = (event) => {
					if (event.type === 'keydown' && event.key !== 'Escape') return;
					for (const details of document.querySelectorAll('.dap-root .dap-more[open]')) {
						if (event.type === 'pointerdown' && details.contains(event.target)) continue;
						details.open = false;
						if (event.type === 'keydown') details.querySelector('summary').focus();
					}
				};
				document.addEventListener('pointerdown', closeMenus);
				document.addEventListener('keydown', closeMenus);
				document.addEventListener('scroll', closeMenus, true);
				window.addEventListener?.('resize', closeMenus);
				return () => {
					document.removeEventListener('pointerdown', closeMenus);
					document.removeEventListener('keydown', closeMenus);
					document.removeEventListener('scroll', closeMenus, true);
					window.removeEventListener?.('resize', closeMenus);
				};
			}, []);
		}

		/** A ticking clock, so "cooling for" counts down without a refetch. */
		function useNow(intervalMs = 1000) {
			const [now, setNow] = React.useState(() => Date.now());
			React.useEffect(() => {
				const timer = setInterval(() => setNow(Date.now()), intervalMs);
				return () => clearInterval(timer);
			}, [intervalMs]);
			return now;
		}

		// Quota reads have a separate queue from account writes and a one-minute cache.
		function useAccountQuotas(t) {
			const [snapshots, setSnapshots] = React.useState({});
			const [pendingIds, setPendingIds] = React.useState(() => new Set());
			const refs = React.useRef({ alive: true, cache: new Map(), flights: new Map() });
			React.useEffect(() => {
				refs.current.alive = true;
				return () => { refs.current.alive = false; for (const flight of refs.current.flights.values()) flight.controller.abort(); refs.current.flights.clear(); };
			}, []);
			function publish(account, body) {
				const key = quotaAccountKey(account);
				const snapshot = { key, quota: body.quota, resetCredits: body.resetCredits };
				refs.current.cache.set(account.id, { key, at: Date.now(), snapshot });
				if (refs.current.alive) setSnapshots((previous) => ({ ...previous, [account.id]: snapshot }));
				return snapshot;
			}
			function applyResult(account, body) {
				const previous = refs.current.flights.get(account.id);
				if (previous) { refs.current.flights.delete(account.id); previous.controller.abort(); }
				setPendingIds((current) => { const next = new Set(current); next.delete(account.id); return next; });
				return publish(account, body);
			}
			async function load(account, force = false) {
				if (!canQueryQuota(account) || !account.credential?.configured) return;
				const key = quotaAccountKey(account);
				const existing = refs.current.flights.get(account.id);
				if (existing?.key === key) return existing.promise;
				const cached = refs.current.cache.get(account.id);
				if (!force && cached?.key === key && Date.now() - cached.at < 60000) return cached.snapshot;
				if (existing) existing.controller.abort();
				const flight = { key, controller: new AbortController() };
				refs.current.flights.set(account.id, flight);
				setPendingIds((current) => new Set([...current, account.id]));
				flight.promise = (async () => {
					const timer = setTimeout(() => flight.controller.abort(), 25000);
					try {
						const response = await fetch(ACTION_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, credentials: 'same-origin', signal: flight.controller.signal, body: JSON.stringify({ id: account.id, action: 'quota', force }) });
						const body = await response.json().catch(() => null);
						if (!response.ok || body?.ok !== true || !body.quota) throw new Error(body?.error?.message || t('quotaQueryFailed'));
						if (refs.current.alive && refs.current.flights.get(account.id) === flight) return publish(account, body);
					} catch (error) {
						if (refs.current.alive && refs.current.flights.get(account.id) === flight) {
							const old = cached?.key === key ? cached.snapshot : { quota: account.quota, resetCredits: account.resetCredits };
							return publish(account, { quota: { ...(old.quota ?? {}), supported: true, ok: false, stale: !!old.quota?.ok || old.quota?.stale === true, message: error.name === 'AbortError' ? t('quotaQueryFailed') : error.message, windows: old.quota?.windows ?? [] }, resetCredits: old.resetCredits ? { ...old.resetCredits, ok: false, stale: true } : undefined });
						}
					} finally {
						clearTimeout(timer);
						if (refs.current.flights.get(account.id) === flight) {
							refs.current.flights.delete(account.id);
							if (refs.current.alive) setPendingIds((current) => { const next = new Set(current); next.delete(account.id); return next; });
						}
					}
				})();
				return flight.promise;
			}
			function forAccount(account) {
				const snapshot = snapshots[account.id];
				return snapshot?.key === quotaAccountKey(account) ? snapshot : { quota: account.quota, resetCredits: account.resetCredits };
			}
			return { load, applyResult, forAccount, pendingIds };
		}

		// =====================================================================
		// § 5  Pure helpers — no React, no DOM. Exported so the offline test can
		//      exercise the state derivation directly.
		// =====================================================================

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
			if (account.schedulable === false) return { key: 'statusPaused', tone: 'idle' };
			if (account.autoPauseOnExpired !== false && account.expiresAt && Date.parse(account.expiresAt) <= now) return { key: 'statusExpired', tone: 'idle' };
			if (coolingOf(account, now) !== null) return { key: 'statusCooling', tone: 'cooling' };
			return { key: 'statusActive', tone: 'ready' };
		}

		function filterAccounts(accounts, filters, now) {
			const query = (filters.query ?? '').trim().toLowerCase();
			return accounts.filter((account) => {
				if (filters.platform && account.platform !== filters.platform) return false;
				if (filters.authMode && (account.authMode ?? 'api-key') !== filters.authMode) return false;
				if (filters.status && statusOf(account, now).key !== filters.status) return false;
				if (filters.group === '__ungrouped' && (account.groups ?? []).length > 0) return false;
				if (filters.group && filters.group !== '__ungrouped' && !(account.groups ?? []).includes(filters.group)) return false;
				return !query || [account.id, account.label, account.notes, account.baseUrl, ...(account.models ?? [])].join(' ').toLowerCase().includes(query);
			}).sort((a, b) => {
				if (filters.sort === 'name') return (a.label || a.id).localeCompare(b.label || b.id);
				if (filters.sort === 'recent') return (Date.parse(b.lastUsedAt) || 0) - (Date.parse(a.lastUsedAt) || 0);
				return (a.priority ?? 100) - (b.priority ?? 100) || a.id.localeCompare(b.id);
			});
		}

		function localDateInput(value) {
			if (!value || Number.isNaN(Date.parse(value))) return '';
			const date = new Date(value);
			return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
		}

		function formatRemaining(ms, t) {
			const seconds = Math.max(0, Math.round(ms / 1000));
			if (seconds < 90) return t('secondsShort', { n: String(seconds) });
			const minutes = Math.round(seconds / 60);
			if (minutes < 90) return t('minutesShort', { n: String(minutes) });
			return t('hoursShort', { n: String(Math.round(minutes / 60)) });
		}

		/** Nullable measurements stay unknown; never coerce null or strings into zero. */
		function usageMetric(value) {
			return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
		}

		function formatUsageDuration(value) {
			const ms = usageMetric(value);
			if (ms === null) return '—';
			if (ms < 1000) return `${Math.round(ms)} ms`;
			return `${(ms / 1000).toFixed(2)} s`;
		}

		function formatUsageTps(value) {
			const tps = usageMetric(value);
			return tps === null ? '—' : `${tps.toFixed(1)} tok/s`;
		}

		function compact(value) {
			const n = Number(value);
			if (!Number.isFinite(n)) return '0';
			if (n < 1000) return String(n);
			if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
			return `${(n / 1_000_000).toFixed(1)}M`;
		}

		// =====================================================================
		// § 6  Primitives — the hook-free building blocks every panel reuses.
		// =====================================================================

		function Pill(props) {
			return h('span', { className: `dap-pill dap-pill-${props.tone}` }, props.children);
		}

		function Icon({ name, className = '' }) {
			const paths = {
				pool: 'M5 4h14v5H5z M5 15h14v5H5z M8 6.5h.01 M8 17.5h.01 M12 9v6',
				accounts: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
				activity: 'M3 12h4l3-8 4 16 3-8h4',
				link: 'M10 13a5 5 0 0 0 7 .5l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7-.5l-3 3a5 5 0 0 0 7 7l2-2',
				groups: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
				search: 'M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15 M16 16l5 5',
				plus: 'M12 5v14 M5 12h14',
				refresh: 'M20 7v5h-5 M4 17v-5h5 M5.6 7a7.5 7.5 0 0 1 12.4-2L20 8 M4 16l2 3a7.5 7.5 0 0 0 12.4-2',
				chevron: 'M7 10l5 5 5-5',
			};
			return h('svg', { className: `dap-icon ${className}`.trim(), viewBox: '0 0 24 24', 'aria-hidden': true, focusable: false }, h('path', { d: paths[name] ?? paths.pool }));
		}

		function Card(props) {
			return h('div', { className: 'dap-card' }, [
				h('div', { className: 'dap-card-top', key: 'top' }, [
					h('div', { className: 'dap-card-label', key: 'l' }, props.label),
					h('span', { className: 'dap-card-icon', key: 'i' }, h(Icon, { name: props.icon || 'activity' })),
				]),
				h('div', { className: 'dap-card-value', key: 'v' }, props.value),
				props.hint === undefined ? null : h('div', { className: 'dap-card-hint', key: 'h' }, props.hint),
			]);
		}

		// =====================================================================
		// § 7  Quota views — the rate-limit / reset-credit readouts, shared by the
		//      account row, the usage panel and the action result.
		// =====================================================================

		function canQueryQuota(account) {
			return account.authMode === 'oauth' && ['openai', 'anthropic', 'gemini'].includes(account.platform);
		}

		function quotaAccountKey(account) {
			return JSON.stringify([account.id, account.platform, account.authMode, account.credentialRef, account.baseUrl, account.chatgptAccountId, account.projectId, account.credential?.configured]);
		}

		function quotaWindowLabel(window, t) {
			const seconds = window.windowSeconds;
			let duration = null;
			if (seconds > 0 && seconds % 86400 === 0) duration = t('quotaWindowDays', { n: String(seconds / 86400) });
			else if (seconds > 0 && seconds % 3600 === 0) duration = t('quotaWindowHours', { n: String(seconds / 3600) });
			const id = String(window.id || '');
			if (id === 'primary' || id === 'secondary') return duration || t(id === 'primary' ? 'quotaWindowPrimary' : 'quotaWindowSecondary');
			if (id === 'five_hour' || id === 'seven_day') return t(id === 'five_hour' ? 'quotaWindowHours' : 'quotaWindowDays', { n: id === 'five_hour' ? '5' : '7' });
			return window.label || duration || id;
		}

		function quotaPercent(window) {
			if (Number.isFinite(window.remainingPercent)) return Math.max(0, Math.min(100, window.remainingPercent));
			if (Number.isFinite(window.usedPercent)) return Math.max(0, Math.min(100, 100 - window.usedPercent));
			return null;
		}

		function QuotaWindow({ window, t, now, compact: small = false }) {
			const remaining = quotaPercent(window);
			const label = quotaWindowLabel(window, t);
			const resetMs = window.resetAt ? Date.parse(window.resetAt) : NaN;
			const value = remaining !== null ? t(small ? 'quotaRemainingShort' : 'quotaRemaining', { n: String(Math.round(remaining * 10) / 10) }) : window.remainingAmount != null ? t('quotaAmount', { n: String(window.remainingAmount) }) : t('quotaUnknownValue');
			return h('div', { className: 'dap-quota-window' }, [
				h('div', { key: 'head', className: 'dap-quota-window-head' }, [h('span', { key: 'label', title: label }, label), h('strong', { key: 'value', className: 'dap-num' }, value)]),
				remaining === null ? null : h('progress', { key: 'bar', max: 100, value: remaining, 'data-tone': remaining <= 10 ? 'low' : remaining <= 30 ? 'warn' : 'ready', 'aria-label': `${label}: ${value}` }),
				Number.isFinite(resetMs) ? h('div', { key: 'reset', className: 'dap-dim dap-quota-reset', title: new Date(resetMs).toLocaleString() }, small ? (resetMs > now ? t('quotaResetsIn', { time: formatRemaining(resetMs - now, t) }) : t('quotaResetPending')) : t('quotaReset', { at: new Date(resetMs).toLocaleString() })) : null,
			]);
		}

		function QuotaView({ quota, t, now = Date.now() }) {
			if (!quota) return h('span', { className: 'dap-dim' }, t('quotaUnknown'));
			if (quota.supported === false) return h('span', { className: 'dap-dim' }, t('quotaUnsupported'));
			return h('div', { className: 'dap-quota' }, [
				quota.plan ? h('div', { key: 'plan', className: 'dap-quota-plan' }, quota.plan) : null,
				quota.stale ? h('div', { key: 'stale', className: 'dap-error' }, t('quotaStale')) : null,
				quota.ok === false ? h('div', { key: 'error', className: 'dap-error' }, quota.message || quota.error?.message || quota.errorCode || t('quotaQueryFailed')) : null,
				...(quota.windows ?? []).map((window, index) => h(QuotaWindow, { key: `${window.id}-${index}`, window, t, now })),
				quota.ok && !quota.windows?.length ? h('div', { key: 'empty', className: 'dap-dim' }, t('quotaNoData')) : null,
				quota.credits ? h('div', { key: 'credits', className: 'dap-quota-balance' }, t('quotaCredits', { n: quota.credits.unlimited ? t('quotaUnlimited') : quota.credits.balance ?? t('none') })) : null,
				(quota.lastSuccessAt || quota.at) ? h('div', { key: 'at', className: 'dap-dim' }, `${t('quotaAt')}: ${new Date(quota.lastSuccessAt || quota.at).toLocaleString()}`) : null,
			]);
		}

		function QuotaSummary({ account, quota, resetCredits, pending, t, now, onView }) {
			return h('div', { className: 'dap-quota-summary', 'aria-busy': pending }, [
				quota?.plan ? h('span', { key: 'plan', className: 'dap-quota-plan' }, quota.plan) : null,
				!quota ? h('span', { key: 'empty', className: 'dap-dim' }, t(pending ? 'quotaLoading' : 'quotaUnknown')) : null,
				quota?.stale || quota?.ok === false ? h('span', { key: 'error', className: 'dap-error' }, t(quota.stale ? 'quotaStale' : 'quotaQueryFailed')) : null,
				...(quota?.windows ?? []).slice(0, 2).map((window, index) => h(QuotaWindow, { key: `${window.id}-${index}`, window, compact: true, t, now })),
				quota?.ok && !quota.windows?.length ? h('span', { key: 'none', className: 'dap-dim' }, t('quotaNoData')) : null,
				account.platform === 'openai' && resetCredits ? h('span', { key: 'cards', className: 'dap-dim dap-reset-count' }, `${t('resetCards')} · ${resetCredits.ok && Number.isFinite(resetCredits.availableCount) ? t('resetCardsCount', { n: String(resetCredits.availableCount) }) : t('resetCardsFailed')}`) : null,
				h('button', { key: 'view', type: 'button', className: 'dap-row-more dap-usage-link', onClick: onView }, [t('viewAccountUsage'), ' ›']),
			]);
		}

		function ResetCreditsView({ snapshot, ready, t, pending, configured, confirmation, onUse, onConfirm, onCancel, error }) {
			const available = ready && snapshot?.ok === true && !snapshot.stale && Number.isFinite(snapshot.availableCount) && snapshot.availableCount > 0;
			return h('div', { className: 'dap-reset-credits' }, [
				h('div', { key: 'head', className: 'dap-reset-heading' }, [h('strong', { key: 'title' }, t('resetCards')), h('span', { key: 'count', className: 'dap-quota-plan' }, snapshot?.ok && Number.isFinite(snapshot.availableCount) ? t('resetCardsCount', { n: String(snapshot.availableCount) }) : '—')]),
				!ready ? h('p', { key: 'restart', className: 'dap-dim' }, t('resetCardRestart')) : !snapshot ? h('p', { key: 'unknown', className: 'dap-dim' }, t('resetCardsUnknown')) : snapshot.ok === false || snapshot.stale ? h('p', { key: 'error', className: 'dap-error' }, snapshot.error?.message || t('resetCardsFailed')) : snapshot.availableCount === 0 ? h('p', { key: 'none', className: 'dap-dim' }, t('resetCardNone')) : null,
				...(snapshot?.credits ?? []).filter((credit) => credit.expiresAt && Number.isFinite(Date.parse(credit.expiresAt))).map((credit, index) => h('div', { key: `expiry-${index}`, className: 'dap-dim dap-reset-expiry' }, `${t('resetCardsExpired')}: ${new Date(credit.expiresAt).toLocaleString()}`)),
				(snapshot?.lastSuccessAt || snapshot?.at) ? h('div', { key: 'at', className: 'dap-dim' }, `${t('quotaAt')}: ${new Date(snapshot.lastSuccessAt || snapshot.at).toLocaleString()}`) : null,
				confirmation ? h('div', { key: 'confirm', className: 'dap-reset-confirm', role: 'group', 'aria-label': t('resetCardConfirmTitle', { name: confirmation.name }) }, [
					h('strong', { key: 'title' }, t('resetCardConfirmTitle', { name: confirmation.name })),
					h('p', { key: 'hint' }, t(confirmation.dispatched ? 'resetCardUncertain' : 'resetCardConfirmHint')),
					error ? h('p', { key: 'error', className: 'dap-error', role: 'alert' }, error) : null,
					h('div', { key: 'actions', className: 'dap-actions' }, [h('button', { key: 'confirm', type: 'button', className: 'dap-btn dap-btn-primary', disabled: pending || !ready || !configured || (!confirmation.dispatched && !available), onClick: onConfirm }, t(pending ? 'actWorking' : confirmation.dispatched ? 'resetCardRetry' : 'resetCardConfirm')), h('button', { key: 'cancel', type: 'button', className: 'dap-btn', 'aria-label': t('resetCardCancel'), disabled: pending, onClick: onCancel }, t('cancel'))]),
				]) : h('button', { key: 'use', type: 'button', className: 'dap-btn dap-btn-soft', disabled: pending || !configured || !available, onClick: onUse }, t('resetCardUse')),
				!confirmation && error ? h('p', { key: 'action-error', className: 'dap-error', role: 'alert' }, error) : null,
				h('p', { key: 'hint', className: 'dap-dim' }, t('resetCardRefreshHint')),
			]);
		}

		// =====================================================================
		// § 8  Row components — one account row and one usage row.
		// =====================================================================

		// Validate every optional field consumed by the row renderer. An installed but
		// incompatible companion is no more authoritative than a missing route.
		function validAttribution(body) {
			const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
			const text = value => value == null || typeof value === 'string';
			const number = value => value == null || (typeof value === 'number' && Number.isFinite(value));
			if (!object(body) || body.version !== 1 || typeof body.available !== 'boolean' || typeof body.enabled !== 'boolean' || typeof body.busy !== 'boolean' || !Array.isArray(body.rows)) return false;
			if (body.autoPauseOnMismatch != null && typeof body.autoPauseOnMismatch !== 'boolean') return false;
			if (body.pauseAvailable != null && typeof body.pauseAvailable !== 'boolean') return false;
			if (body.batchVersion != null && body.batchVersion !== 1) return false;
			if (body.batchVersion === 1 && (body.batchLimit !== 100 || (body.activeBatch != null && !validAttributionBatch(body.activeBatch)))) return false;
			if (body.limits != null && (!object(body.limits) || !number(body.limits.maxTokens) || !number(body.limits.timeoutMs))) return false;
			const ids = new Set();
			return body.rows.every(row => {
				if (!object(row) || typeof row.accountId !== 'string' || !row.accountId || ids.has(row.accountId) || typeof row.ready !== 'boolean' || !text(row.key) || (row.ready && !row.key) || !text(row.model) || !text(row.reason) || !text(row.label)) return false;
				ids.add(row.accountId);
				const job = row.job;
				if (job == null) return true;
				if (!object(job) || typeof job.id !== 'string' || !job.id || !['running', 'completed', 'cancelled', 'error'].includes(job.state) || !text(job.error)) return false;
				if (job.schedulingAction != null && (!object(job.schedulingAction) || !['paused', 'already-paused', 'pause-error', 'unavailable', 'skipped', 'matched', 'disabled'].includes(job.schedulingAction.state))) return false;
				if (job.progress != null && (!object(job.progress) || !number(job.progress.completed))) return false;
				if (job.probes != null && (!Array.isArray(job.probes) || !job.probes.every(probe => object(probe) && number(probe.index) && text(probe.error)))) return false;
				const analysis = job.analysis;
				return analysis == null || (object(analysis) && text(analysis.prediction_name) && number(analysis.used_outputs)
					&& (analysis.results == null || (Array.isArray(analysis.results) && analysis.results.every(match => object(match) && text(match.display_name) && number(match.probability)))));
			});
		}

		function validAttributionBatch(batch) {
			const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
			const text = value => value == null || typeof value === 'string';
			const count = value => Number.isInteger(value) && value >= 0 && value <= 100;
			if (!object(batch) || typeof batch.id !== 'string' || !batch.id || !['running', 'completed', 'cancelled', 'error'].includes(batch.state)
				|| typeof batch.cancelRequested !== 'boolean' || !Array.isArray(batch.rows) || batch.rows.length < 1 || batch.rows.length > 100) return false;
			if (!object(batch.progress) || !count(batch.progress.completed) || batch.progress.total !== batch.rows.length || batch.progress.completed > batch.progress.total
				|| !count(batch.progress.current) || batch.progress.current > batch.progress.total) return false;
			if (batch.error != null && !text(batch.error)) return false;
			if (batch.settling != null && typeof batch.settling !== 'boolean') return false;
			const ids = new Set();
			return batch.rows.every(row => {
				if (!object(row) || typeof row.accountId !== 'string' || !row.accountId || ids.has(row.accountId) || typeof row.key !== 'string' || !row.key
					|| !text(row.label) || !text(row.model) || !text(row.error) || !text(row.skipReason)
					|| !['queued', 'running', 'completed', 'skipped', 'error', 'cancelled'].includes(row.state)) return false;
				ids.add(row.accountId);
				// Reuse the normal job contract; unknown companion fields remain harmless.
				return validAttribution({ version: 1, available: true, enabled: true, busy: false, rows: [{ ...row, ready: true }] });
			});
		}

		function useModelAttribution(nonce, t, onSchedulingChanged, selection, actionState) {
			const observedPauses = React.useRef(new Set());
			const [tick, setTick] = React.useState(0);
			const [meta, setMeta] = React.useState({ status: 'loading', body: null });
			const [confirmation, setConfirmation] = React.useState(null);
			const [pending, setPending] = React.useState(null);
			const [error, setError] = React.useState('');
			const locked = React.useRef(false), alive = React.useRef(true), latest = React.useRef(null), armed = React.useRef(null);
			const [batchConfirmation, setBatchConfirmation] = React.useState(null);
			const [batchSnapshot, setBatchSnapshot] = React.useState(null);
			const [batchError, setBatchError] = React.useState('');
			const batchArmed = React.useRef(null), knownBatchBusy = React.useRef(false);
			const renderedSelection = selection?.current;
			const confirm = value => { armed.current = value; setConfirmation(value); };
			const confirmBatch = value => { batchArmed.current = value; setBatchConfirmation(value); };
			const batchRunning = body => body?.activeBatch?.state === 'running' || body?.activeBatch?.settling === true;
			const batchSupported = body => body?.available === true && body.enabled === true && body.batchVersion === 1 && body.batchLimit === 100;
			function validBatchConfirmation(body, captured) {
				if (!captured || !batchSupported(body) || body.busy || batchRunning(body) || actionState?.current.pending
					|| body.limits?.maxTokens !== captured.limits.maxTokens || body.limits?.timeoutMs !== captured.limits.timeoutMs
					|| (body.autoPauseOnMismatch === true) !== captured.autoPauseOnMismatch || body.pauseAvailable !== captured.pauseAvailable || selection?.current.size !== captured.rows.length) return false;
				return captured.rows.every(row => selection.current.has(row.accountId) && body.rows.some(current => current.accountId === row.accountId && current.ready && current.key === row.key));
			}
			React.useEffect(() => { alive.current = true; return () => { alive.current = false; latest.current = null; armed.current = null; batchArmed.current = null; }; }, []);
			// Unlike ordinary pool reads, a capability must never retain a failed read's
			// old body. Revoke its ref synchronously, before React commits another render.
			React.useEffect(() => {
				let active = true;
				const controller = new AbortController();
				const timeout = setTimeout(() => controller.abort(), 30000);
				latest.current = null;
				setMeta({ status: 'loading', body: null });
				(async () => {
					try {
						const response = await fetch('api/lm-detector/pool', { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' }, signal: controller.signal });
						const rawBody = await response.json();
						// Do not consume unadvertised fields from older optional companions.
						const body = rawBody?.batchVersion === 1 ? rawBody : { ...rawBody, activeBatch: null };
						if (!active) return;
						if (controller.signal.aborted || !response.ok || !validAttribution(body)) throw new Error('unavailable');
						latest.current = body;
						knownBatchBusy.current = batchRunning(body);
						const row = body.rows.find(item => item.accountId === armed.current?.accountId);
						if (!body.available || !body.enabled || !row?.ready || row.key !== armed.current?.key || body.busy
							|| body.limits?.maxTokens !== armed.current?.limits.maxTokens || body.limits?.timeoutMs !== armed.current?.limits.timeoutMs
							|| (body.autoPauseOnMismatch === true) !== armed.current?.autoPauseOnMismatch || body.pauseAvailable !== armed.current?.pauseAvailable) confirm(null);
						if (!validBatchConfirmation(body, batchArmed.current)) confirmBatch(null);
						if (body.activeBatch) setBatchSnapshot(body.activeBatch);
						setMeta({ status: 'ready', body });
					} catch {
						if (!active) return;
						latest.current = null; confirm(null); confirmBatch(null);
						setMeta({ status: 'unavailable', body: null });
					} finally { clearTimeout(timeout); }
				})();
				return () => { active = false; latest.current = null; clearTimeout(timeout); controller.abort(); };
			}, [nonce, tick]);
			const refresh = () => { latest.current = null; setTick(value => value + 1); };
			React.useEffect(() => {
				if (meta.status === 'loading') return;
				// Low-frequency discovery also runs after initial 404, disable or unload.
				const delay = meta.body?.available && meta.body.enabled ? (meta.body.busy || batchRunning(meta.body) ? 1500 : 6000) : 30000;
				const timer = setTimeout(refresh, delay);
				return () => clearTimeout(timer);
			}, [meta]);
			React.useEffect(() => {
				if (meta.status !== 'ready' || !meta.body?.available || !meta.body.enabled) return;
				let changed = false;
				for (const row of [...meta.body.rows, ...(meta.body.activeBatch?.rows ?? [])]) {
					const job = row.job;
					if (job?.state !== 'running' && ['paused', 'already-paused', 'pause-error'].includes(job?.schedulingAction?.state) && !observedPauses.current.has(job.id)) {
						observedPauses.current.add(job.id); changed = true;
					}
				}
				// A failed durable pause may still have changed memory; read the pool
				// once per job, never send a scheduling write or trigger a polling loop.
				if (changed) onSchedulingChanged?.();
			}, [meta]);
			function currentRow(row) {
				const body = latest.current;
				if (!alive.current || locked.current || !body?.available || !body.enabled || body !== meta.body || !row) return null;
				const current = body.rows.find(item => item.accountId === row.accountId);
				return current?.key === row.key ? current : null;
			}
			async function run(kind, row) {
				const current = currentRow(row);
				if (!current) return;
				if (batchRunning(latest.current) || (kind === 'start' ? armed.current !== row || !current.ready || latest.current.busy : current.job?.state !== 'running' || current.job.id !== row.job?.id)) return;
				locked.current = true; setPending({ accountId: row.accountId, kind }); setError('');
				try {
					const response = await fetch(`api/lm-detector/${kind === 'start' ? 'pool-start' : 'cancel'}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(30000), headers: { 'content-type': 'application/json' }, body: JSON.stringify(kind === 'start' ? { accountId: row.accountId, expectedKey: row.key } : { id: current.job.id }) });
					const next = await response.json();
					if (!response.ok || typeof next?.id !== 'string' || !next.id) throw new Error(next?.error?.message || `HTTP ${response.status}`);
					if (alive.current) confirm(null);
				} catch (failure) {
					if (alive.current) { latest.current = null; confirm(null); setMeta({ status: 'unavailable', body: null }); setError(failure.name === 'TimeoutError' ? t('readTimeout') : failure.message || t('failed')); }
				} finally { locked.current = false; if (alive.current) { setPending(null); refresh(); } }
			}
			function batchSelectionReason(body = latest.current) {
				if ((selection?.current.size ?? 0) > 100) return t('attributionBatchLimit');
				if (!selection?.current.size || [...selection.current].some(id => !body?.rows.some(row => row.accountId === id && row.ready && row.key))) return t('attributionBatchUnready');
				return '';
			}
			function armBatch() {
				const body = latest.current;
				if (!alive.current || locked.current || body !== meta.body || selection?.current !== renderedSelection || !batchSupported(body) || body.busy || batchRunning(body) || actionState?.current.pending || batchSelectionReason(body)) return;
				confirm(null); setBatchError('');
				// Capture EVERY selected row and its key; never filter unready accounts or
				// substitute freshly configured rows behind an already approved prompt.
				confirmBatch({ rows: [...selection.current].map(id => ({ ...body.rows.find(row => row.accountId === id) })), limits: { ...body.limits }, autoPauseOnMismatch: body.autoPauseOnMismatch === true, pauseAvailable: body.pauseAvailable });
			}
			async function runBatchAttribution(kind, captured) {
				const body = latest.current;
				if (!alive.current || locked.current || !batchSupported(body) || body !== meta.body) return;
				if (kind === 'start' ? batchArmed.current !== captured || !validBatchConfirmation(body, captured)
					: !batchRunning(body) || body.activeBatch.id !== captured?.id || body.activeBatch.cancelRequested) return;
				locked.current = true; knownBatchBusy.current = true; setPending({ kind: `batch-${kind}` }); setBatchError(''); confirm(null); confirmBatch(null);
				try {
					const response = await fetch(`api/lm-detector/pool-batch-${kind}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(30000), headers: { 'content-type': 'application/json' }, body: JSON.stringify(kind === 'start' ? { targets: captured.rows.map(row => ({ accountId: row.accountId, expectedKey: row.key })) } : { id: captured.id }) });
					const next = await response.json();
					if (!response.ok || !validAttributionBatch(next?.batch)) throw new Error(typeof next?.error?.message === 'string' ? next.error.message : !response.ok ? `HTTP ${response.status}` : t('attributionBatchUnavailable'));
					if (alive.current) { knownBatchBusy.current = next.batch.state === 'running' || next.batch.settling === true; setBatchSnapshot(next.batch); }
				} catch (failure) {
					if (alive.current) setBatchError(failure.name === 'TimeoutError' ? t('readTimeout') : failure.message || t('failed'));
				} finally {
					// Read to reconcile an ambiguous POST; never replay a paid operation.
					if (alive.current) { latest.current = null; setPending(null); refresh(); }
					locked.current = false;
				}
			}
			return { body: meta.body, loading: meta.status === 'loading', pending, error, confirmation,
				arm: row => { const current = currentRow(row); if (!current?.ready || latest.current.busy || batchRunning(latest.current)) return; setError(''); confirmBatch(null); confirm({ ...current, limits: { ...latest.current.limits }, autoPauseOnMismatch: latest.current.autoPauseOnMismatch === true, pauseAvailable: latest.current.pauseAvailable }); },
				dismiss: () => confirm(null), start: row => run('start', row), cancel: row => run('cancel', row), refresh,
				batchConfirmation, batch: meta.body?.activeBatch || batchSnapshot, batchError,
				batchAvailable: batchSupported(meta.body), batchDisabled: !batchSupported(meta.body) || meta.status !== 'ready' || !!pending || meta.body.busy || batchRunning(meta.body) || actionState?.current.pending || !!batchSelectionReason(meta.body),
				batchReason: batchSelectionReason(meta.body), armBatch, dismissBatch: () => confirmBatch(null),
				startBatch: captured => runBatchAttribution('start', captured), cancelBatch: batch => runBatchAttribution('cancel', batch),
				batchBusy: () => locked.current || (latest.current ? batchRunning(latest.current) : knownBatchBusy.current),
				batchStale: !!batchSnapshot && (meta.status !== 'ready' || !batchSupported(meta.body) || meta.body.activeBatch?.id !== batchSnapshot.id),
				batchCancelDisabled: meta.status !== 'ready' || !!pending || !batchRunning(meta.body) || meta.body?.activeBatch?.cancelRequested === true };
		}

		function AttributionRowControl({ account, attribution, actionPending, t }) {
			if (attribution?.body?.version !== 1 || attribution.body.available !== true || attribution.body.enabled !== true) return null;
			const row = attribution.body.rows?.find(item => item.accountId === account.id);
			if (!row) return null;
			const job = row.job, active = job?.state === 'running';
			const armed = attribution.confirmation?.accountId === account.id;
			const waiting = !!attribution.pending || actionPending;
			const batchOwned = attribution.body.activeBatch?.state === 'running' || attribution.body.activeBatch?.settling === true;
			const disabled = waiting || !row.ready || attribution.loading || attribution.body.busy || batchOwned;
			const analysis = job?.analysis;
			const pauseState = job?.schedulingAction?.state;
			const pauseLabel = { paused: 'attributionPaused', 'already-paused': 'attributionAlreadyPaused', 'pause-error': 'attributionPauseFailed', unavailable: 'attributionPauseUnavailable' }[pauseState];
			const result = analysis?.prediction_name ? t('attributionReference', { model: analysis.prediction_name }) : job?.state === 'cancelled' ? t('attributionCancelled') : job?.state === 'error' ? t('attributionFailed') : t('attributionNoScore');
			const btn = (key, label, onClick, off) => h('button', { key, type: 'button', className: 'dap-btn', disabled: off, onClick }, label);
			return h('div', { className: 'dap-attribution', 'aria-busy': active || attribution.pending?.accountId === account.id }, [
				btn('test', active ? t('attributionRunning', { done: String(job.progress?.completed ?? 0) }) : t('attributionTest'), () => attribution.arm(row), disabled),
				h('span', { key: 'model', className: 'dap-dim', title: t('attributionConfigure') }, t('attributionModel', { model: row.model || '—' })),
				pauseLabel ? h('p', { key: 'pauseAction', role: ['pause-error', 'unavailable'].includes(pauseState) ? 'alert' : 'status', className: ['pause-error', 'unavailable'].includes(pauseState) ? 'dap-error' : 'dap-dim' }, t(pauseLabel)) : null,
				!row.ready ? h('span', { key: 'reason', className: 'dap-dim' }, row.reason) : null,
				armed ? h('div', { key: 'confirmation', role: 'group', 'aria-label': t('attributionTest'), className: 'dap-attribution-confirm' }, [
					h('p', { key: 'cost' }, t('attributionCost', { tokens: String(attribution.confirmation.limits.maxTokens ?? 8192), seconds: String((attribution.confirmation.limits.timeoutMs ?? 250000) / 1000) })),
					attribution.confirmation.autoPauseOnMismatch ? h('p', { key: 'autoPause', className: 'dap-dim' }, t('attributionAutoPauseNote')) : null,
					attribution.confirmation.autoPauseOnMismatch && attribution.confirmation.pauseAvailable === false ? h('p', { key: 'pauseUnavailable', className: 'dap-error', role: 'alert' }, t('attributionPauseUnavailable')) : null,
					btn('start', t('attributionStart'), () => attribution.start(attribution.confirmation), disabled), btn('dismiss', t('cancel'), attribution.dismiss, waiting),
				]) : null,
				active && !batchOwned ? btn('cancel', t('attributionCancel'), () => attribution.cancel(row), waiting) : null,
				job && !active ? h('details', { key: 'result', className: 'dap-row-more' }, [
					h('summary', { key: 'summary', title: t('attributionCaveat') }, result),
					h('p', { key: 'caveat', className: 'dap-dim' }, t('attributionCaveat')),
					h('p', { key: 'samples', className: 'dap-dim' }, `${analysis?.used_outputs ?? 0}/3 · ${row.model}`),
					...(analysis?.results ?? []).slice(0, 5).map((match, index) => h('div', { key: index, className: 'dap-dim' }, `${index + 1}. ${match.display_name}${typeof match.probability === 'number' && Number.isFinite(match.probability) ? ` · ${(match.probability * 100).toFixed(1)}%` : ''}`)),
					job.error ? h('p', { key: 'error', className: 'dap-error' }, job.error) : null,
					...(job.probes ?? []).filter(probe => probe.error).map(probe => h('p', { key: `probe-${probe.index}`, className: 'dap-error' }, `${probe.index}: ${probe.error}`)),
				]) : null,
				attribution.error && (armed || active || attribution.pending?.accountId === account.id) ? h('p', { key: 'error', className: 'dap-error', role: 'alert' }, attribution.error) : null,
			]);
		}

		function AttributionBatchPanel({ attribution, t, pending }) {
			const captured = attribution.batchConfirmation, batch = attribution.batch;
			if (!captured && !batch && !attribution.batchError) return null;
			const stateLabel = state => t({ queued: 'attributionBatchQueued', running: 'attributionBatchRunning', completed: 'attributionBatchCompleted', skipped: 'attributionBatchSkipped', error: 'attributionBatchError', cancelled: 'attributionBatchCancelled' }[state]);
			const btn = (key, label, onClick, disabled) => h('button', { key, type: 'button', className: 'dap-btn', onClick, disabled }, label);
			const active = batch?.state === 'running' || batch?.settling === true;
			return h('section', { className: 'dap-form dap-attribution-batch', 'aria-label': t('attributionBatch'), 'aria-busy': !!attribution.pending || active }, [
				h('h4', { key: 'title', className: 'dap-form-title' }, t('attributionBatch')),
				captured ? h('div', { key: 'confirmation', role: 'group', 'aria-label': t('attributionBatchConfirm', { n: captured.rows.length, calls: captured.rows.length * 3 }) }, [
					h('p', { key: 'cost' }, t('attributionBatchCost', { n: captured.rows.length, calls: captured.rows.length * 3 })),
					h('p', { key: 'budget' }, t('attributionCost', { tokens: captured.limits.maxTokens ?? 8192, seconds: (captured.limits.timeoutMs ?? 250000) / 1000 })),
					captured.autoPauseOnMismatch ? h('p', { key: 'autoPause', className: 'dap-dim' }, t('attributionAutoPauseNote')) : null,
					captured.autoPauseOnMismatch && captured.pauseAvailable === false ? h('p', { key: 'pauseUnavailable', className: 'dap-error', role: 'alert' }, t('attributionPauseUnavailable')) : null,
					h('ul', { key: 'targets' }, captured.rows.map(row => h('li', { key: row.accountId }, `${row.label || row.accountId} · ${row.model || '—'}`))),
					btn('start', t('attributionBatchConfirm', { n: captured.rows.length, calls: captured.rows.length * 3 }), () => attribution.startBatch(captured), pending || attribution.batchDisabled),
					btn('dismiss', t('cancel'), attribution.dismissBatch, !!attribution.pending),
				]) : null,
				batch ? h('div', { key: 'progress' }, [
					h('p', { key: 'status', role: 'status', 'aria-live': 'polite' }, t('attributionBatchProgress', { done: batch.progress.completed, total: batch.progress.total, state: stateLabel(batch.state) })),
					active && batch.cancelRequested ? h('p', { key: 'cancelling', role: 'status' }, t('attributionBatchCancelling')) : null,
					active ? btn('cancel', t('attributionBatchCancel'), () => attribution.cancelBatch(batch), attribution.batchCancelDisabled) : null,
					attribution.batchStale && !attribution.loading ? h('p', { key: 'unavailable', role: 'alert', className: 'dap-error' }, t('attributionBatchUnavailable')) : null,
					h('p', { key: 'caveat', className: 'dap-dim' }, t('attributionCaveat')),
					h('ul', { key: 'rows' }, batch.rows.map(row => {
						const job = row.job, pauseState = job?.schedulingAction?.state;
						const pauseLabel = { paused: 'attributionPaused', 'already-paused': 'attributionAlreadyPaused', 'pause-error': 'attributionPauseFailed', unavailable: 'attributionPauseUnavailable' }[pauseState];
						return h('li', { key: row.accountId }, [
							h('strong', { key: 'name' }, `${row.label || row.accountId} · ${row.model || '—'} · ${stateLabel(row.state)}`),
							job?.analysis?.prediction_name ? h('p', { key: 'prediction' }, t('attributionReference', { model: job.analysis.prediction_name })) : null,
							job?.state === 'completed' && !job.analysis?.prediction_name ? h('p', { key: 'noScore' }, t('attributionNoScore')) : null,
							pauseLabel ? h('p', { key: 'pause', role: ['pause-error', 'unavailable'].includes(pauseState) ? 'alert' : 'status' }, t(pauseLabel)) : null,
							row.error || row.skipReason || job?.error ? h('p', { key: 'error', className: 'dap-error' }, row.error || row.skipReason || job.error) : null,
						]);
					})),
					batch.error ? h('p', { key: 'error', className: 'dap-error', role: 'alert' }, batch.error) : null,
				]) : null,
				attribution.batchError ? h('p', { key: 'error', className: 'dap-error', role: 'alert' }, attribution.batchError) : null,
				btn('refresh', t('attributionRefresh'), attribution.refresh, !!attribution.pending),
			]);
		}

		function AccountRow(props) {
			const { account, now, t, action, pool, selected, onSelect } = props;
			const cooling = coolingOf(account, now);
			const status = statusOf(account, now);
			const busy = action.pending && action.busyId === account.id;
			const disabled = account.status === 'disabled';
			// Only the credential summary is present in the browser payload.
			const credential = account.credential ?? { configured: false, writable: false };
			const confirming = pool.confirmingId === account.id;
			const quotaState = pool.quotaData.forAccount(account);
			const quotaPending = pool.quotaData.pendingIds.has(account.id);
			const name = account.label || account.id;
			return h('tr', { 'data-selected': selected === true }, [
				h('td', { key: 'sel', className: 'dap-cell-select' }, h('input', {
					type: 'checkbox', className: 'dap-check-row', 'aria-label': `${t('colAccount')}: ${name}`,
					checked: selected === true, disabled: action.pending, onChange: () => onSelect(account.id),
				})),
				h('td', { key: 'a', className: 'dap-cell-account' }, h('div', { className: 'dap-identity' }, [
					h('span', { className: 'dap-avatar', key: 'avatar', 'aria-hidden': true }, (name || 'A').slice(0, 1).toUpperCase()),
					h('div', { className: 'dap-identity-copy', key: 'copy' }, [
						h('div', { className: 'dap-account-name', key: 'name' }, name),
						account.label ? h('div', { className: 'dap-mono dap-dim', key: 'id' }, account.id) : null,
						h('div', { className: 'dap-row-tags', key: 'groups' }, (account.groups ?? []).length === 0
							? h('span', { className: 'dap-tag' }, t('noGroups'))
							: account.groups.map((id) => h('span', { className: 'dap-tag', key: id }, id))),
						account.notes ? h('div', { className: 'dap-dim dap-note', key: 'note', title: account.notes }, account.notes) : null,
						account.errorMessage ? h('div', { className: 'dap-error dap-note', key: 'err', title: account.errorMessage }, account.errorMessage) : null,
						account.lastTestAt ? h('div', { className: account.lastTestOk ? 'dap-cred-set dap-note' : 'dap-error dap-note', key: 'health', title: `${new Date(account.lastTestAt).toLocaleString()} · ${account.lastTestModel || ''}` }, account.lastTestOk ? t('testPassed', { ms: String(account.lastTestLatencyMs ?? 0) }) : t('testFailed', { message: account.lastTestMessage || account.lastTestErrorCode || t('failed') })) : null,
					]),
				])),
				h('td', { key: 'p', className: 'dap-cell-protocol' }, [
					h('div', { className: 'dap-protocol', key: 'platform' }, [account.platform, account.platform === 'anthropic' && account.mimicry === 'claude-code' ? ' · ' : null, account.platform === 'anthropic' && account.mimicry === 'claude-code' ? h('span', { className: 'dap-tag', key: 'cc' }, t('mimicryOn')) : null]),
					h('div', { className: 'dap-cell-meta', key: 'type' }, [account.authMode === 'oauth' ? 'OAuth' : 'API Key', account.platform === 'anthropic' && account.mimicry === 'claude-code' ? h('span', { className: 'dap-tag', key: 'cc' }, t('mimicryOn')) : null]),
					h('div', { className: 'dap-cell-meta', key: 'credential' }, h('span', {
						className: credential.configured ? 'dap-cred-set' : 'dap-cred-missing',
						title: credential.source === undefined ? '' : t('credSource', { source: credential.source }),
					}, `${t(credential.configured ? 'credConfigured' : 'credMissing')}${credential.configured && credential.writable === false ? ` · ${t('credReadOnly')}` : ''}`)),
				]),
				h('td', { key: 's', className: 'dap-cell-status' }, [
					h(Pill, { key: 'pill', tone: status.tone }, t(status.key)),
					cooling === null ? null : h('div', { className: 'dap-cell-meta dap-num', key: 'cooling' }, `${formatRemaining(cooling.until - now, t)} · ${t(cooling.reasonKey)}`),
					(account.consecutiveFailures ?? 0) === 0 ? null : h('div', { className: 'dap-cell-meta', key: 'failures' }, `${t('colFailures')} ${account.consecutiveFailures}`),
					h(AttributionRowControl, { key: 'attribution', account, attribution: pool.attribution, actionPending: action.pending, t }),
				]),
				h('td', { key: 'pr', className: 'dap-cell-schedule', 'data-label': t('colScheduling') }, h('div', { className: 'dap-cell-stack' }, [
					h('span', { className: 'dap-num', key: 'priority' }, [h('span', { className: 'dap-dim', key: 'l' }, `${t('colPriority')} `), String(account.priority)]),
					h('span', { className: 'dap-num', key: 'concurrency' }, [h('span', { className: 'dap-dim', key: 'l' }, `${t('colSlots')} `), account.concurrency === 0 ? '∞' : String(account.concurrency)]),
					account.weight ? h('span', { className: 'dap-dim dap-num', key: 'weight' }, `${t('fieldWeight')} ${account.weight}`) : null,
				])),
				h('td', { key: 'used', className: 'dap-cell-activity' }, h('div', { className: 'dap-cell-stack' }, [
					pool.quotaReady && canQueryQuota(account) ? h(QuotaSummary, { key: 'quota', account, ...quotaState, pending: quotaPending, t, now, onView: () => pool.onViewUsage(account) }) : null,
					h('span', { className: 'dap-dim dap-last-used', key: 'at', title: account.lastUsedAt ? new Date(account.lastUsedAt).toLocaleString() : '' }, `${t('colLastUsed')} · ${account.lastUsedAt ? new Date(account.lastUsedAt).toLocaleDateString() : t('none')}`),
					h('details', { className: 'dap-row-more', key: 'details' }, [
						h('summary', { key: 'summary' }, [t('colExpires'), ' ›']),
						h('div', { key: 'expiry', className: 'dap-cell-stack' }, h('span', null, account.expiresAt ? new Date(account.expiresAt).toLocaleString() : t('permanent'))),
					]),
				])),
				h('td', { key: 'x', className: 'dap-cell-actions' }, h('div', { className: 'dap-actions' }, [
					h('button', { key: 'edit', type: 'button', className: 'dap-btn dap-btn-soft', disabled: action.pending, onClick: () => pool.onEdit(account) }, t('editAccount')),
					!pool.managementReady ? null : h('button', { key: 'test', type: 'button', className: 'dap-btn', disabled: action.pending || !credential.configured, onClick: () => pool.onTest(account) }, t('actTest')),
					h('details', { key: 'more', className: 'dap-more', name: 'dap-account-actions', onToggle: positionMoreMenu }, [
						h('summary', { key: 'summary', title: t('moreActions'), 'aria-label': `${t('moreActions')}: ${name}` }, h('span', { 'aria-hidden': true }, '⋯')),
						h('div', { className: 'dap-more-menu', key: 'menu' }, [
							!pool.quotaReady || !canQueryQuota(account) ? null : h('button', { key: 'quota', type: 'button', className: 'dap-btn', disabled: action.pending || quotaPending || !credential.configured, onClick: () => pool.onRefreshQuota(account) }, t('refreshAccountUsage')),
							!pool.managementReady ? null : h('button', { key: 'schedule', type: 'button', className: 'dap-btn', disabled: action.pending, onClick: () => action.run(account.id, account.schedulable === false ? 'resume-scheduling' : 'pause-scheduling') }, t(account.schedulable === false ? 'actResume' : 'actPause')),
							pool.managementReady && account.status === 'error' ? h('button', { key: 'reset', type: 'button', className: 'dap-btn', disabled: action.pending, onClick: () => action.run(account.id, 'reset-error') }, t('actResetError')) : null,
							h('button', { key: 'toggle', type: 'button', className: 'dap-btn', disabled: action.pending, onClick: () => action.run(account.id, disabled ? 'enable' : 'disable') }, busy ? t('actWorking') : (disabled ? t('actEnable') : t('actDisable'))),
							account.platform !== 'anthropic' ? null : h('button', { key: 'mimicry', type: 'button', className: 'dap-btn', disabled: action.pending, title: t('mimicryHint'), onClick: () => action.run(account.id, 'set-mimicry', { mimicry: account.mimicry === 'claude-code' ? 'off' : 'claude-code' }) }, account.mimicry === 'claude-code' ? t('actMimicryOff') : t('actMimicryOn')),
							cooling === null ? null : h('button', { key: 'clear', type: 'button', className: 'dap-btn', disabled: action.pending, onClick: () => action.run(account.id, 'clear-cooldown') }, t('actClear')),
							h('button', { key: 'delete', type: 'button', className: 'dap-btn dap-btn-danger', disabled: action.pending, onClick: () => pool.onDelete(account) }, confirming ? t('confirmDelete') : t('deleteAccount')),
						]),
					]),
				])),
			]);
		}

		// Fixed positioning keeps menus outside the table's horizontal scroll clip.
		function positionMoreMenu(event) {
			const details = event.currentTarget;
			if (!details.open) return;
			const menu = details.querySelector('.dap-more-menu');
			const rect = details.querySelector('summary').getBoundingClientRect();
			const inset = 10;
			const width = menu.offsetWidth;
			const height = menu.offsetHeight;
			menu.style.left = `${Math.max(inset, Math.min(rect.right - width, window.innerWidth - width - inset))}px`;
			menu.style.top = `${Math.max(inset, rect.bottom + height + 6 > window.innerHeight ? rect.top - height - 6 : rect.bottom + 6)}px`;
		}

		/** Use only the per-request snapshot, never the model's current mapping. */
		function usageEffortDisplay(row, t) {
			const requested = row.reasoningEffort;
			if (typeof requested !== 'string' || requested === '') {
				return { label: t('usageEffortUnknown'), title: t('usageEffortUnknownHint'), recorded: false };
			}
			const mapped = row.mappedReasoningEffort;
			const effective = typeof mapped === 'string' && mapped !== '' ? mapped : t('usageEffortOmitted');
			return {
				label: requested === mapped ? t('usageEffort', { level: requested }) : t('usageEffortMapped', { requested, mapped: effective }),
				title: t('usageEffortDetail', { requested, mapped: effective }),
				recorded: true,
			};
		}

		function UsageRow(props) {
			const { row, t } = props;
			const effort = usageEffortDisplay(row, t);
			return h('tr', null, [
				h('td', { key: 't', className: 'dap-dim dap-num', title: row.at }, new Date(row.at).toLocaleString()),
				h('td', { key: 'a', className: 'dap-mono' }, row.accountId === '' ? t('none') : row.accountId),
				h('td', { key: 'm', className: 'dap-usage-model' }, [
					h('span', { key: 'name', className: 'dap-usage-model-name', title: row.model }, row.model === '' ? t('none') : row.model),
					h('span', { key: 'effort', className: 'dap-usage-effort', 'data-recorded': effort.recorded, title: effort.title }, effort.label),
				]),
				h('td', { key: 'k', className: 'dap-num', title: t('cacheDetail', { write: compact(row.cacheWriteTokens), reasoning: compact(row.reasoningTokens) }) }, [
					compact(row.inputTokens), ' / ', compact(row.outputTokens), ' / ', compact(row.cacheReadTokens),
				]),
				h('td', { key: 'first', className: 'dap-num dap-timing', title: usageMetric(row.firstTokenMs) === null ? t('usageTimingUnavailable') : t('firstTokenHint') }, formatUsageDuration(row.firstTokenMs)),
				h('td', { key: 'duration', className: 'dap-num dap-timing', title: usageMetric(row.outputDurationMs) === null ? t('usageTimingUnavailable') : t('outputDurationHint') }, formatUsageDuration(row.outputDurationMs)),
				h('td', { key: 'tps', className: 'dap-num dap-timing', title: usageMetric(row.outputTps) === null ? t('usageTimingUnavailable') : t('outputTpsHint') }, formatUsageTps(row.outputTps)),
				h('td', { key: 's', className: 'dap-num' }, String(row.accountSwitches)),
				h('td', { key: 'r', title: row.errorCode || '' }, h(Pill, { tone: row.ok ? 'ready' : 'failed' }, t(row.ok ? 'ok' : 'failed'))),
			]);
		}

		/**
		 * One labelled input. A plain function component (no hooks), so it is safe
		 * for the offline test's tree expander to invoke.
		 */
		// =====================================================================
		// § 9  Forms — supplier connect, account edit/create, group edit/create.
		//      Each owns its own draft state; they are the only child components
		//      that call hooks, and the test mounts them explicitly.
		// =====================================================================

		function Field(props) {
			return h('label', { className: 'dap-field' }, [
				h('span', { className: 'dap-field-label', key: 'l' }, props.label),
				h('input', {
					key: 'i',
					className: 'dap-input',
					type: props.type ?? 'text',
					min: props.min,
					max: props.max,
					step: props.step,
					value: props.value,
					placeholder: props.placeholder,
					'aria-label': props.label,
					disabled: props.disabled,
					onChange: (event) => props.onChange(event.target.value),
				}),
			]);
		}

		function OpenaiProtocolFields({ t, values, set, pending }) {
			return h(React.Fragment, {}, [
				h('label', { key: 'api', className: 'dap-field' }, [h('span', { className: 'dap-field-label' }, t('openaiApi')), h('select', { className: 'dap-input', 'aria-label': t('openaiApi'), value: values.openaiApi ?? 'chat-completions', disabled: pending, onChange: (event) => { set('openaiApi')(event.target.value); if (event.target.value !== 'responses') set('openaiTransport')('http'); } }, [h('option', { key: 'chat', value: 'chat-completions' }, t('openaiChat')), h('option', { key: 'responses', value: 'responses' }, t('openaiResponses'))])]),
				h('label', { key: 'transport', className: 'dap-field' }, [h('span', { className: 'dap-field-label' }, t('openaiTransport')), h('select', { className: 'dap-input', 'aria-label': t('openaiTransport'), value: values.openaiTransport ?? 'http', disabled: pending, onChange: (event) => set('openaiTransport')(event.target.value) }, [h('option', { key: 'http', value: 'http' }, t('openaiHttp')), h('option', { key: 'websocket', value: 'websocket', disabled: values.openaiApi !== 'responses' }, t('openaiWebSocket'))]), values.openaiTransport === 'websocket' ? h('span', { className: 'dap-dim' }, t('openaiWebSocketHint')) : null]),
			]);
		}

		const supplierModels = (text) => [...new Set(String(text ?? '').split(/[,\n\r]+/).map((value) => value.trim()).filter(Boolean))];
		function SupplierForm({ t, groups, pending, error, onSave, onCancel, openaiProtocolReady }) {
			const [values, setValues] = React.useState({ name: '', platform: 'anthropic', openaiApi: 'chat-completions', openaiTransport: 'http', baseUrl: '', models: '', groupId: '', mimicry: 'off', betas: '' });
			const [credential, setCredential] = React.useState('');
			const [discovery, setDiscovery] = React.useState({ pending: false, error: null, count: null });
			const [validation, setValidation] = React.useState(null);
			const operation = React.useRef(0);
			const saving = React.useRef(false);
			React.useEffect(() => () => { operation.current++; }, []);
			const invalidate = () => { operation.current++; setDiscovery({ pending: false, error: null, count: null }); setValidation(null); };
			const set = (key) => (value) => { invalidate(); setValues((previous) => ({ ...previous, [key]: value })); };
			const setKey = (value) => { invalidate(); setCredential(value); };
			const validUrl = () => { try { return (values.platform === 'openai' ? ['https:', 'http:', 'wss:', 'ws:'] : ['https:', 'http:']).includes(new URL(values.baseUrl.trim()).protocol); } catch { return false; } };
			async function discover() {
				if (pending || saving.current || discovery.pending || !credential.trim()) return;
				if (!validUrl()) { setValidation(t('supplierUrlInvalid')); return; }
				const seq = ++operation.current;
				setDiscovery({ pending: true, error: null, count: null });
				try {
					const response = await fetch(ACTION_ROUTE, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ id: '', action: 'supplier-models', supplier: { platform: values.platform, baseUrl: values.baseUrl.trim(), ...(openaiProtocolReady && values.platform === 'openai' ? { openaiApi: values.openaiApi, openaiTransport: values.openaiTransport } : {}) }, credential: credential.trim() }) });
					const body = await response.json();
					if (seq !== operation.current) return;
					if (!response.ok || body?.ok !== true || !Array.isArray(body.models)) throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
					const models = [...new Set(body.models.filter((value) => typeof value === 'string').map((value) => value.trim()).filter(Boolean))];
					if (!models.length) { setDiscovery({ pending: false, error: t('supplierDiscoveryEmpty'), count: null }); return; }
					setValues((previous) => ({ ...previous, models: models.join('\n') }));
					setDiscovery({ pending: false, error: null, count: models.length });
				} catch (failure) {
					if (seq !== operation.current) return;
					setDiscovery({ pending: false, error: t('supplierDiscoveryFailed', { message: failure instanceof Error ? failure.message : String(failure) }), count: null });
				}
			}
			const models = supplierModels(values.models);
			const valid = !!values.name.trim() && !!values.baseUrl.trim() && !!credential.trim() && models.length > 0;
			async function submit() {
				if (pending || saving.current) return;
				if (!valid) { setValidation(t('supplierRequired')); return; }
				if (!validUrl()) { setValidation(t('supplierUrlInvalid')); return; }
				invalidate(); saving.current = true;
				try {
					const ok = await onSave({ supplier: { name: values.name.trim(), platform: values.platform, baseUrl: values.baseUrl.trim(), models, ...(openaiProtocolReady && values.platform === 'openai' ? { openaiApi: values.openaiApi, openaiTransport: values.openaiTransport } : {}), ...(values.groupId ? { groupId: values.groupId } : {}), ...(values.platform === 'anthropic' ? { mimicry: values.mimicry, betas: supplierModels(values.betas) } : {}) }, credential: credential.trim() });
					if (ok) setCredential('');
				} finally { saving.current = false; }
			}
			return h('form', { className: 'dap-form', onSubmit: (event) => { event.preventDefault(); return submit(); } }, [
				h('div', { key: 'title', className: 'dap-form-title' }, t('supplierTitle')),
				h('p', { key: 'hint', className: 'dap-intro' }, t('supplierHint')),
				h('div', { key: 'fields', className: 'dap-form-grid' }, [
					h(Field, { key: 'name', label: t('supplierName'), disabled: pending, value: values.name, onChange: set('name') }),
					h('label', { key: 'platform', className: 'dap-field' }, [h('span', { className: 'dap-field-label' }, t('supplierProtocol')), h('select', { className: 'dap-input', 'aria-label': t('supplierProtocol'), value: values.platform, disabled: pending, onChange: (event) => set('platform')(event.target.value) }, SUPPLIER_PLATFORMS.map((value) => h('option', { key: value, value }, t({ anthropic: 'supplierAnthropic', openai: 'supplierOpenai', gemini: 'supplierGemini', custom: 'supplierCustom' }[value]))))]),
					openaiProtocolReady && values.platform === 'openai' ? h(OpenaiProtocolFields, { key: 'openai-protocol', t, values, set, pending }) : null,
					h(Field, { key: 'url', label: t('supplierAddress'), disabled: pending, placeholder: 'https://api.example.com', value: values.baseUrl, onChange: set('baseUrl') }),
					h(Field, { key: 'key', type: 'password', label: t('supplierKey'), disabled: pending, value: credential, onChange: setKey }),
				]),
				h('label', { key: 'models', className: 'dap-field' }, [h('span', { className: 'dap-field-label' }, t('supplierModels')), h('textarea', { className: 'dap-input', rows: 4, 'aria-label': t('supplierModels'), value: values.models, disabled: pending, onChange: (event) => set('models')(event.target.value) }), h('span', { className: 'dap-dim' }, t('supplierModelsHint'))]),
				h('button', { key: 'discover', type: 'button', className: 'dap-btn', disabled: pending || discovery.pending || !values.baseUrl.trim() || !credential.trim(), onClick: discover }, t(discovery.pending ? 'supplierDiscovering' : 'supplierDiscover')),
				discovery.error ? h('div', { key: 'discovery-error', className: 'dap-error', role: 'status' }, discovery.error) : discovery.count !== null ? h('div', { key: 'discovery-count', className: 'dap-dim', role: 'status' }, t('supplierDiscoveryDone', { n: String(discovery.count) })) : null,
				h('details', { key: 'advanced' }, [h('summary', {}, t('supplierAdvanced')), h('div', { className: 'dap-form-grid' }, [
					h('label', { key: 'group', className: 'dap-field' }, [h('span', { className: 'dap-field-label' }, t('supplierGroup')), h('select', { className: 'dap-input', 'aria-label': t('supplierGroup'), value: values.groupId, disabled: pending, onChange: (event) => set('groupId')(event.target.value) }, [h('option', { key: '', value: '' }, t('supplierNewGroup')), ...groups.map((group) => h('option', { key: group.id, value: group.id }, group.label || group.id))]), h('span', { className: 'dap-dim' }, t('supplierGroupHint'))]),
					values.platform !== 'anthropic' ? null : h('label', { key: 'mimicry', className: 'dap-field' }, [h('span', { className: 'dap-field-label' }, t('supplierClaudeCode')), h('select', { className: 'dap-input', 'aria-label': t('supplierClaudeCode'), value: values.mimicry, disabled: pending, onChange: (event) => set('mimicry')(event.target.value) }, MIMICRY_MODES.map((value) => h('option', { key: value, value }, t(value === 'off' ? 'mimicryOff' : 'mimicryClaudeCode'))))]),
					values.platform !== 'anthropic' ? null : h(Field, { key: 'betas', label: t('supplierBeta'), disabled: pending, value: values.betas, onChange: set('betas') }),
				])]),
				validation || error ? h('div', { key: 'error', className: 'dap-error', role: 'alert' }, validation || error) : null,
				h('div', { key: 'actions', className: 'dap-form-actions' }, [h('button', { type: 'submit', className: 'dap-btn dap-btn-primary', disabled: pending || !valid }, t(pending ? 'saving' : 'connectSupplier')), h('button', { type: 'button', className: 'dap-btn', disabled: pending, onClick: () => { invalidate(); setCredential(''); onCancel(); } }, t('cancel'))]),
			]);
		}

		const isCodexOAuth = (values) => values.platform === 'openai' && values.authMode === 'oauth';
		const isOpenaiApiKey = (values) => ['openai', 'grok', 'custom'].includes(values.platform) && (values.authMode ?? 'api-key') === 'api-key';

		/** Normalize protocol fields at mode/platform changes and the save boundary.
		 * Codex's endpoint ignores openaiApi; its capability is independent of the
		 * generic Responses API capability. Never send WS to an older OAuth host.
		 */
		function accountProtocol(values, openaiProtocolReady, codexWebSocketReady) {
			if (isCodexOAuth(values) && codexWebSocketReady) return { openaiApi: 'chat-completions', openaiTransport: values.openaiTransport === 'websocket' ? 'websocket' : 'http' };
			if (isOpenaiApiKey(values) && openaiProtocolReady) {
				const openaiApi = values.openaiApi === 'responses' ? 'responses' : 'chat-completions';
				return { openaiApi, openaiTransport: openaiApi === 'responses' && values.openaiTransport === 'websocket' ? 'websocket' : 'http' };
			}
			return { openaiApi: 'chat-completions', openaiTransport: 'http' };
		}

		function CodexTransportField({ t, values, set, pending }) {
			return h('label', { className: 'dap-field' }, [
				h('span', { key: 'label', className: 'dap-field-label' }, t('openaiTransport')),
				h('select', { key: 'select', className: 'dap-input', 'aria-label': t('openaiTransport'), 'aria-describedby': 'dap-codex-transport-hint', value: values.openaiTransport ?? 'http', disabled: pending, onChange: (event) => set('openaiTransport')(event.target.value) }, [
					h('option', { key: 'http', value: 'http' }, t('openaiHttp')),
					h('option', { key: 'websocket', value: 'websocket' }, t('openaiWebSocket')),
				]),
				h('span', { key: 'hint', id: 'dap-codex-transport-hint', className: 'dap-dim' }, t('codexWebSocketHint')),
			]);
		}

		/** Add / edit form. The secret is write-only: it is never pre-filled. */
		function AccountForm(props) {
			const { t, mode, initial, configured, pending, error, onSave, onCancel, allGroups, managementReady, quotaReady, detectionReady, openaiProtocolReady, codexWebSocketReady, savedId } = props;
			const [values, setValues] = React.useState(() => ({ ...initial }));
			const [credential, setCredential] = React.useState('');
			const [validationError, setValidationError] = React.useState(null);
			const set = (key) => (value) => {
				setValidationError(null);
				setValues((previous) => {
					const next = { ...previous, [key]: value };
					return key === 'platform' || key === 'authMode' ? { ...next, ...accountProtocol(next, openaiProtocolReady, codexWebSocketReady) } : next;
				});
			};

			function submit() {
				const retries = Number(values.poolDetectionRetries ?? 2);
				const delayMs = Number(values.poolDetectionRetryDelayMs ?? 1000);
				const keywords = String(values.poolDetectionKeywords ?? POOL_DETECTION_KEYWORDS.join('\n')).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
				if (detectionReady && (String(values.poolDetectionRetries ?? 2).trim() === '' || !Number.isInteger(retries) || retries < 0 || retries > 5
					|| String(values.poolDetectionRetryDelayMs ?? 1000).trim() === '' || !Number.isInteger(delayMs) || delayMs < 100 || delayMs > 10000
					|| keywords.length > 20 || keywords.some((value) => value.length > 200))) {
					setValidationError(t('poolDetectionInvalid'));
					return;
				}
				setValidationError(null);
				return onSave({
					id: savedId || values.id,
					account: {
						label: values.label,
						...(detectionReady ? {
							poolDetectionRetry: values.poolDetectionRetry === true,
							poolDetectionRetries: retries,
							poolDetectionRetryDelayMs: delayMs,
							poolDetectionKeywords: keywords,
						} : {}),
						...(quotaReady ? { projectId: values.projectId?.trim() || null, chatgptAccountId: values.chatgptAccountId?.trim() || null } : {}),
						...(managementReady ? { notes: values.notes ?? '',
						betas: String(values.betas ?? '').split(',').map((value) => value.trim()).filter(Boolean),
						expiresAt: values.expiresAt ? new Date(values.expiresAt).toISOString() : null,
						autoPauseOnExpired: values.autoPauseOnExpired !== false,
						schedulable: values.schedulable !== false,
						loadFactor: values.loadFactor === '' || values.loadFactor == null ? null : Number(values.loadFactor) } : {}),
						...(openaiProtocolReady || (codexWebSocketReady && (isCodexOAuth(values) || isCodexOAuth(initial))) ? accountProtocol(values, openaiProtocolReady, codexWebSocketReady) : {}),
						platform: values.platform,
						baseUrl: values.baseUrl === '' ? null : values.baseUrl,
						models: String(values.models).split(',').map((part) => part.trim()).filter((part) => part !== ''),
						groups: values.groups ?? [],
						priority: Number(values.priority),
						weight: Number(values.weight),
						concurrency: Number(values.concurrency),
						// Sent unconditionally, even for platforms where they cannot apply:
						// an explicit "off" is a recorded decision, whereas omitting the
						// field would leave a previously enabled disguise silently in place.
						authMode: values.authMode ?? AUTH_MODES[0],
						mimicry: values.mimicry ?? MIMICRY_MODES[0],
					},
					// `undefined` means "leave the stored secret alone".
					credential: credential === '' ? undefined : credential,
					// Per-pool priority overrides, sent alongside the account so one save
					// expresses "this account, ranked this way in these pools".
					groupPriorities: values.groupPriorities ?? {},
				});
			}

			const fields = [
					mode === 'create' ? h(Field, { key: 'id', label: t('fieldId'), value: savedId || values.id, disabled: pending || !!savedId, onChange: set('id') }) : null,
					h(Field, { key: 'label', label: t('fieldLabel'), value: values.label, onChange: set('label') }),
					h('label', { className: 'dap-field', key: 'platform' }, [
						h('span', { className: 'dap-field-label', key: 'l' }, t('fieldPlatform')),
						h('select', {
							key: 's', className: 'dap-input', 'aria-label': t('fieldPlatform'), value: values.platform, disabled: pending,
							onChange: (event) => set('platform')(event.target.value),
						}, PLATFORMS.map((name) => h('option', { key: name, value: name }, name))),
					]),
			// OAuth and API-key classification is part of the account on every platform.
			// The Claude Code mode selector remains Anthropic-only.
					h('label', { className: 'dap-field', key: 'authMode' }, [
						h('span', { className: 'dap-field-label', key: 'l' }, t('fieldAuthMode')),
						h('select', {
							key: 's', className: 'dap-input', 'aria-label': t('fieldAuthMode'), value: values.authMode ?? AUTH_MODES[0], disabled: pending,
							onChange: (event) => set('authMode')(event.target.value),
						}, AUTH_MODES.map((name) => h('option', { key: name, value: name },
							t(name === 'oauth' ? 'authModeOauth' : 'authModeApiKey')))),
					]),
					values.platform !== 'anthropic' ? null : h('label', {
						className: 'dap-field', key: 'mimicry', title: t('mimicryHint'),
					}, [
						h('span', { className: 'dap-field-label', key: 'l' }, t('fieldMimicry')),
						h('select', {
							key: 's', className: 'dap-input', value: values.mimicry ?? MIMICRY_MODES[0],
							onChange: (event) => set('mimicry')(event.target.value),
						}, MIMICRY_MODES.map((name) => h('option', { key: name, value: name },
							t(name === 'claude-code' ? 'mimicryClaudeCode' : 'mimicryOff')))),
					]),
					!quotaReady || values.platform !== 'gemini' || values.authMode !== 'oauth' ? null : h(Field, { key: 'projectId', label: t('fieldProjectId'), value: values.projectId ?? '', onChange: set('projectId') }),
					!quotaReady || values.platform !== 'openai' || values.authMode !== 'oauth' ? null : h(Field, { key: 'chatgptAccountId', label: t('fieldChatgptAccountId'), value: values.chatgptAccountId ?? '', onChange: set('chatgptAccountId') }),
					openaiProtocolReady && isOpenaiApiKey(values) ? h(OpenaiProtocolFields, { key: 'openai-protocol', t, values, set, pending }) : null,
					codexWebSocketReady && isCodexOAuth(values) ? h(CodexTransportField, { key: 'codex-transport', t, values, set, pending }) : null,
					h(Field, { key: 'baseUrl', label: t('fieldBaseUrl'), value: values.baseUrl, onChange: set('baseUrl') }),
					h(Field, {
						key: 'credential', label: t('fieldCredential'), type: 'password', value: credential,
						placeholder: configured ? t('credConfigured') : t('fieldCredentialKeep'),
						onChange: setCredential,
					}),
					h(Field, { key: 'models', label: t('fieldModels'), value: values.models, onChange: set('models') }),
					h(Field, { key: 'priority', label: t('fieldPriority'), value: values.priority, onChange: set('priority') }),
					h(Field, { key: 'weight', label: t('fieldWeight'), value: values.weight, onChange: set('weight') }),
					h(Field, { key: 'concurrency', type: 'number', label: t('fieldConcurrency'), value: values.concurrency, onChange: set('concurrency') }),
					!managementReady ? null : h(Field, { key: 'loadFactor', type: 'number', label: t('fieldLoadFactor'), value: values.loadFactor ?? '', onChange: set('loadFactor') }),
					!managementReady ? null : h(Field, { key: 'expiresAt', type: 'datetime-local', label: t('fieldExpiresAt'), value: values.expiresAt ?? '', onChange: set('expiresAt') }),
					!managementReady ? null : h(Field, { key: 'notes', label: t('fieldNotes'), value: values.notes ?? '', onChange: set('notes') }),
					!managementReady || values.platform !== 'anthropic' ? null : h(Field, { key: 'betas', label: t('fieldBetas'), value: values.betas ?? '', onChange: set('betas') }),
					...(managementReady ? ['schedulable', 'autoPauseOnExpired'] : []).map((key) => h('label', { key, className: 'dap-check-label' }, [h('input', { type: 'checkbox', checked: values[key] !== false, onChange: (event) => setValues((previous) => ({ ...previous, [key]: event.target.checked })) }), t(key === 'schedulable' ? 'fieldSchedulable' : 'fieldAutoPause')])),
			];
			const schedulingKeys = new Set(['priority', 'weight', 'concurrency', 'loadFactor', 'expiresAt', 'schedulable', 'autoPauseOnExpired']);
			const section = (key, label, scheduling) => h('fieldset', { className: 'dap-form-section', key }, [
				h('legend', { key: 'title' }, t(label)),
				h('div', { className: 'dap-form-grid', key: 'grid' }, fields.filter((field) => field && schedulingKeys.has(field.key ?? field.props.key) === scheduling)),
			]);
			return h('form', { className: 'dap-form', onSubmit: (event) => { event.preventDefault(); return submit(); } }, [
				h('div', { className: 'dap-form-title', key: 'title' }, mode === 'create' ? t('formCreate') : t('formEdit', { id: values.id })),
				savedId ? h('p', { key: 'save-checkpoint', className: 'dap-models-hint', role: 'status' }, t('accountSaveCheckpoint', { id: savedId })) : null,
				section('connection', 'sectionConnection', false),
				section('scheduling', 'sectionScheduling', true),
				!detectionReady ? h('div', { className: 'dap-dim', key: 'detection-restart' }, t('poolDetectionRestart')) : h('div', { className: 'dap-field dap-detection', key: 'detection' }, [
					h('label', { className: 'dap-check-label', key: 'enabled' }, [h('input', { type: 'checkbox', 'aria-label': t('fieldPoolDetectionRetry'), checked: values.poolDetectionRetry === true, disabled: pending, onChange: (event) => set('poolDetectionRetry')(event.target.checked) }), t('fieldPoolDetectionRetry')]),
					h('div', { className: 'dap-dim', key: 'hint' }, t('poolDetectionHint')),
					h('div', { className: 'dap-form-grid', key: 'options' }, [
						h(Field, { key: 'retries', type: 'number', min: 0, max: 5, step: 1, label: t('fieldPoolDetectionRetries'), value: values.poolDetectionRetries ?? '2', disabled: pending || values.poolDetectionRetry !== true, onChange: set('poolDetectionRetries') }),
						h(Field, { key: 'delay', type: 'number', min: 100, max: 10000, step: 1, label: t('fieldPoolDetectionRetryDelayMs'), value: values.poolDetectionRetryDelayMs ?? '1000', disabled: pending || values.poolDetectionRetry !== true, onChange: set('poolDetectionRetryDelayMs') }),
					]),
					h('label', { className: 'dap-field', key: 'keywords' }, [
						h('span', { className: 'dap-field-label' }, t('fieldPoolDetectionKeywords')),
						h('textarea', { className: 'dap-input', rows: 3, 'aria-label': t('fieldPoolDetectionKeywords'), value: values.poolDetectionKeywords ?? POOL_DETECTION_KEYWORDS.join('\n'), disabled: pending || values.poolDetectionRetry !== true, onChange: (event) => set('poolDetectionKeywords')(event.target.value) }),
						h('span', { className: 'dap-dim' }, t('poolDetectionKeywordsHint')),
					]),
				]),
				validationError === null ? null : h('div', { className: 'dap-error', role: 'alert', key: 'validation' }, validationError),
				// Membership is a set of checkboxes drawn from the groups that actually
				// exist, so assigning one cannot introduce a typo the host would reject.
				(allGroups ?? []).length === 0 ? null : h('div', { className: 'dap-field', key: 'groups' }, [
					h('span', { className: 'dap-field-label', key: 'l' }, t('fieldGroups')),
					h('div', { className: 'dap-group-options', key: 'c' }, allGroups.map((group) => h(
						'label',
						{ key: group.id, className: 'dap-models-hint' },
						[
							h('input', {
								key: 'i',
								className: 'dap-check-group',
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
				// Per-pool ranking. Inputs exist only for the pools this account actually
				// belongs to, because an override is meaningless outside them.
				(values.groups ?? []).length === 0 ? null : h('div', { className: 'dap-field', key: 'gprio' }, [
					h('span', { className: 'dap-field-label', key: 'l' }, t('fieldGroupPriority')),
					h('div', { className: 'dap-group-options', key: 'c' }, values.groups.map((groupId) => {
						const group = (allGroups ?? []).find((candidate) => candidate.id === groupId);
						return h('label', { key: groupId, className: 'dap-models-hint' }, [
							h('span', { key: 'n' }, group === undefined || group.label === '' ? groupId : group.label),
							h('input', {
								key: 'i',
								className: 'dap-check-prio',
								type: 'number',
								value: (values.groupPriorities ?? {})[groupId] ?? '',
								placeholder: t('fieldGroupPriorityInherit'),
								onChange: (event) => setValues((previous) => ({
									...previous,
									groupPriorities: { ...(previous.groupPriorities ?? {}), [groupId]: event.target.value },
								})),
							}),
						]);
					})),
				]),
				error === null ? null : h('div', { className: 'dap-error', role: 'alert', key: 'err' }, error),
				h('div', { className: 'dap-form-actions', key: 'actions' }, [
					h('button', {
						key: 'save', type: 'submit', className: 'dap-btn dap-btn-primary',
						disabled: pending,
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
			const { t, mode, initial, pending, error, onSave, onCancel, managementReady } = props;
			const [values, setValues] = React.useState(() => ({ ...initial }));
			const [discovery, setDiscovery] = React.useState({ pending: false, models: null, sources: [], error: null });
			const [modelSearch, setModelSearch] = React.useState('');
			const discoveryRequest = React.useRef(null);
			React.useEffect(() => () => discoveryRequest.current?.abort(), []);
			const set = (key) => (value) => setValues((previous) => ({ ...previous, [key]: value }));
			const parseModels = (text) => [...new Set(String(text ?? '').split(/[\n,]/).map((part) => part.trim()).filter(Boolean))];
			const selectedModels = parseModels(values.models);
			async function fetchGroupModels() {
				if (pending || discoveryRequest.current || mode !== 'edit') return;
				const controller = new AbortController();
				discoveryRequest.current = controller;
				setDiscovery((previous) => ({ ...previous, pending: true, error: null }));
				try {
					const response = await fetch(ACTION_ROUTE, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, signal: controller.signal, body: JSON.stringify({ action: 'group-models', id: values.id }) });
					const body = await response.json();
					if (!response.ok || body?.ok !== true || !Array.isArray(body.models)) throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
					if (controller.signal.aborted) return;
					const models = [...new Set(body.models.filter((model) => typeof model === 'string' && model.trim()).map((model) => model.trim()))];
					setDiscovery({ pending: false, models, sources: body.sources ?? [], error: null });
					// Keep existing manual entries; discovered models are selected for review.
					setValues((previous) => ({ ...previous, models: [...new Set([...parseModels(previous.models), ...models])].join(', ') }));
				} catch (error) {
					if (!controller.signal.aborted) setDiscovery((previous) => ({ ...previous, pending: false, error: t('groupModelsFailed', { message: error.message }) }));
				} finally { if (discoveryRequest.current === controller) discoveryRequest.current = null; }
			}

			function submit() {
				if (pending || discoveryRequest.current) return;
				onSave({
					id: values.id,
					group: {
						label: values.label,
						description: values.description,
						...(managementReady ? { selectionMode: values.selectionMode ?? 'sticky', enabled: values.enabled !== false } : {}),
						models: parseModels(values.models),
					},
				});
			}

			return h('form', { className: 'dap-form', onSubmit: (event) => { event.preventDefault(); submit(); } }, [
				h('div', { className: 'dap-form-title', key: 'title' },
					mode === 'create' ? t('formGroupCreate') : t('formGroupEdit', { id: values.id })),
				h('div', { className: 'dap-form-grid', key: 'grid' }, [
					mode === 'create' ? h(Field, { key: 'id', label: t('fieldGroupId'), value: values.id, onChange: set('id') }) : null,
					h(Field, { key: 'label', label: t('fieldGroupLabel'), value: values.label, onChange: set('label') }),
					h('label', { key: 'models', className: 'dap-field' }, [
						h('span', { className: 'dap-field-label' }, t('fieldGroupModels')),
						h('input', { className: 'dap-input', value: values.models, disabled: pending || discovery.pending, 'aria-label': t('fieldGroupModels'), onChange: (event) => set('models')(event.target.value) }),
						mode !== 'edit' ? null : h('button', { type: 'button', className: 'dap-btn', disabled: pending || discovery.pending, onClick: fetchGroupModels }, t(discovery.pending ? 'groupFetchingModels' : 'groupFetchModels')),
					]),
					h(Field, { key: 'description', label: t('fieldGroupDescription'), value: values.description, onChange: set('description') }),
					!managementReady ? null : h('label', { key: 'enabled', className: 'dap-check-label' }, [h('input', { type: 'checkbox', 'aria-label': t('fieldGroupEnabled'), checked: values.enabled !== false, disabled: pending, onChange: (event) => set('enabled')(event.target.checked) }), t('fieldGroupEnabled')]),
					!managementReady ? null : h('label', { key: 'selectionMode', className: 'dap-field' }, [h('span', { className: 'dap-field-label' }, t('fieldSelectionMode')), h('select', { className: 'dap-input', value: values.selectionMode ?? 'sticky', onChange: (event) => set('selectionMode')(event.target.value) }, SELECTION_MODES.map(([value, key]) => h('option', { key: value, value }, t(key))))]),
				]),
				mode !== 'edit' ? null : h('p', { key: 'fetch-hint', className: 'dap-models-hint' }, t('groupModelsHint')),
				discovery.error ? h('div', { key: 'fetch-error', className: 'dap-error', role: 'alert' }, discovery.error) : null,
				discovery.models === null ? null : h('div', { key: 'discovered', className: 'dap-upstream-models' }, [
					h('span', { key: 'count', className: 'dap-dim', role: 'status' }, t(discovery.models.length ? 'groupModelsFetched' : 'groupModelsEmpty', { n: String(discovery.models.length) })),
					...discovery.sources.filter((source) => source.error).map((source) => h('span', { key: 'source-' + source.id, className: 'dap-error', role: 'status' }, (source.label || source.id) + ': ' + source.error)),
					discovery.models.length === 0 ? null : h('div', { key: 'actions', className: 'dap-actions' }, [
						h('input', { type: 'search', className: 'dap-input', 'aria-label': t('groupModelsSearch'), placeholder: t('groupModelsSearch'), value: modelSearch, onChange: (event) => setModelSearch(event.target.value) }),
						h('button', { type: 'button', className: 'dap-btn', disabled: pending || discovery.pending, onClick: () => setValues((previous) => ({ ...previous, models: [...new Set([...parseModels(previous.models), ...discovery.models])].join(', ') })) }, t('groupModelsSelectAll')),
						h('button', { type: 'button', className: 'dap-btn', disabled: pending || discovery.pending, onClick: () => set('models')('') }, t('groupModelsClear')),
					]),
					h('div', { key: 'options', className: 'dap-model-options' }, discovery.models.filter((model) => model.toLowerCase().includes(modelSearch.toLowerCase())).map((model) => h('label', { key: model, className: 'dap-model-option' }, [
						h('input', { type: 'checkbox', checked: selectedModels.includes(model), 'aria-label': model, disabled: pending || discovery.pending, onChange: (event) => setValues((previous) => ({ ...previous, models: (event.target.checked ? [...new Set([...parseModels(previous.models), model])] : parseModels(previous.models).filter((selected) => selected !== model)).join(', ') })) }), model,
					]))),
					h('span', { key: 'selected', className: 'dap-models-hint' }, t('groupModelsSelected', { n: String(selectedModels.length) })),
				]),
				error === null ? null : h('div', { className: 'dap-error', key: 'err' }, error),
				h('div', { className: 'dap-form-actions', key: 'actions' }, [
					h('button', {
						key: 'save', type: 'submit', className: 'dap-btn dap-btn-primary',
						disabled: pending || discovery.pending,
					}, pending ? t('saving') : t('save')),
					h('button', {
						key: 'cancel', type: 'button', className: 'dap-btn',
						disabled: pending, onClick: () => { discoveryRequest.current?.abort(); onCancel(); },
					}, t('cancel')),
				]),
			]);
		}

		/**
		 * OAuth sign-in panel.
		 *
		 * Two ways to complete a login, and the panel shows which one applies rather
		 * than pretending there is only one:
		 *
		 *   - the host bound its loopback listener, so the vendor redirects straight
		 *     to it and this panel finds out by POLLING `/oauth-status` (the browser
		 *     tab the operator signed in on cannot reach this page);
		 *   - the vendor owns the redirect (Google's built-in client), or the port
		 *     could not be bound, so the operator pastes the callback URL by hand.
		 *
		 * Polling only runs while a flow is pending, and stops the moment the flow
		 * leaves `pending` — a timer that outlives its login is a leak, and one that
		 * polls a finished flow is a request per interval for nothing.
		 */
		// =====================================================================
		// § 10  OAuth panel — the provider directory and the live login flow.
		// =====================================================================

		function OAuthDirectoryState({ t, status, error, onRetry, onClose }) {
			return h('div', { className: 'dap-form', role: status === 'error' ? 'alert' : 'status' }, [
				h('strong', { key: 'title' }, t(status === 'error' ? 'oauthDirectoryFailed' : 'oauthDirectoryLoading')),
				error ? h('p', { key: 'error', className: 'dap-error' }, error) : null,
				h('div', { key: 'actions', className: 'dap-form-actions' }, [
					status === 'error' ? h('button', { key: 'retry', type: 'button', className: 'dap-btn', onClick: onRetry }, t('retryLoad')) : null,
					h('button', { key: 'close', type: 'button', className: 'dap-btn', onClick: onClose }, t('cancel')),
				]),
			]);
		}

		function OAuthPanel(props) {
			const { t, onClose, onChanged, providers, credentialsAvailable } = props;
			const [provider, setProvider] = React.useState(() => (providers[0]?.id ?? ''));
			const [flow, setFlow] = React.useState(null);
			const [manual, setManual] = React.useState(false);
			const [input, setInput] = React.useState('');
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState(null);
			const [done, setDone] = React.useState(null);
			const [copied, setCopied] = React.useState(false);
			/**
			 * Which spelling of the loopback host the flow advertises. Only rendered
			 * when a listener was bound, and only because a vendor that registered
			 * one spelling will not accept the other.
			 */
			const [redirectHost, setRedirectHost] = React.useState('');
			/** `oauth-check`'s verdict: a list of problems, or `null` before asking. */
			const [problems, setProblems] = React.useState(null);
			const activeFlow = React.useRef(null);
			React.useEffect(() => () => { activeFlow.current = null; }, []);

			/** One POST to the write route, with the same envelope `useAction` uses. */
			async function post(id, action, extra) {
				if (typeof fetch !== 'function') throw new Error(t('noConnection'));
				const response = await fetch(ACTION_ROUTE, {
					method: 'POST',
					headers: { 'content-type': 'application/json', accept: 'application/json' },
					credentials: 'same-origin',
					body: JSON.stringify({ id, action, ...(extra ?? {}) }),
				});
				const body = await response.json().catch(() => null);
				if (!response.ok || body === null) {
					// The flow's own last words are more useful than a status code.
					throw new Error(body?.error?.message ?? `HTTP ${String(response.status)}`);
				}
				return body;
			}

			async function poll(flowId) {
				if (activeFlow.current?.id !== flowId || activeFlow.current.status === 'done') return;
				try {
					const body = await post('', 'oauth-status', { flow: flowId });
					const current = body.flow;
					if (current === null || current === undefined || activeFlow.current?.id !== flowId || activeFlow.current.status === 'done') return;
					activeFlow.current = current;
					setFlow(current);
					if (current.status === 'done') {
						if (current.manualOnly !== true) setManual(false);
						setDone(current.accountId ?? '');
						onChanged();
					}
					if (current.status === 'error') setError(current.error ?? t('oauthFailed', { message: '?' }));
				} catch { /* a transient poll failure must not close the panel */ }
			}

			// The interval is set up ONCE per pending flow, keyed by the flow id and
			// the manual flag, and torn down in the cleanup — so completing a login
			// (which flips the status) stops it without a second timer.
			const pollKey = flow !== null && flow.status === 'pending' && flow.manualOnly !== true ? flow.id : null;
			React.useEffect(() => {
				if (pollKey === null || typeof setInterval !== 'function') return undefined;
				const timer = setInterval(() => { void poll(pollKey); }, 2000);
				return () => { clearInterval(timer); };
			}, [pollKey, t]);

			async function start() {
				activeFlow.current = null;
				setInput('');
				setBusy(true);
				setError(null);
				setDone(null);
				setCopied(false);
				setProblems(null);
				try {
					const body = await post('', 'oauth-start', {
						provider,
						// Omitted when unset, so the host keeps the provider default.
						...(redirectHost === '' ? {} : { redirectHost }),
					});
					activeFlow.current = body.flow ?? null;
					setFlow(body.flow ?? null);
					setManual(body.manualOnly === true);
					// Opening the tab is the whole point of the button; a blocked popup
					// leaves the URL on screen to click instead.
					if (body.flow?.authUrl !== undefined && typeof window !== 'undefined') {
						try { window.open(body.flow.authUrl, '_blank', 'noopener'); } catch { /* the URL is on screen */ }
					}
				} catch (caught) {
					setError(caught instanceof Error ? caught.message : String(caught));
				} finally {
					setBusy(false);
				}
			}

			/** Ask the host which locally-provable parameters look wrong. */
			async function check() {
				if (flow === null) return;
				setBusy(true);
				try {
					const body = await post('', 'oauth-check', { flow: flow.id });
					setProblems(body.problems ?? []);
				} catch (caught) {
					setError(caught instanceof Error ? caught.message : String(caught));
				} finally {
					setBusy(false);
				}
			}

			async function finish() {
				if (flow === null) return;
				setBusy(true);
				setError(null);
				try {
					const body = await post('', 'oauth-finish', { flow: flow.id, input });
					activeFlow.current = body.flow ?? flow;
					setFlow(body.flow ?? flow);
					setDone(body.flow?.accountId ?? '');
					setInput('');
					onChanged();
				} catch (caught) {
					setError(caught instanceof Error ? caught.message : String(caught));
					void poll(flow.id);
				} finally {
					setBusy(false);
				}
			}

			async function cancel() {
				activeFlow.current = null;
				if (flow !== null) {
					try { await post('', 'oauth-cancel', { flow: flow.id }); } catch { /* nothing to undo */ }
				}
				setFlow(null);
				setInput('');
				setError(null);
				setDone(null);
				onClose();
			}

			function copy(url) {
				try {
					if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText !== undefined) {
						void navigator.clipboard.writeText(url);
						setCopied(true);
					}
				} catch { /* selecting the text by hand still works */ }
			}

			const current = providers.find((entry) => entry.id === provider);
			const pending = flow !== null && flow.status === 'pending';
			const expiredAt = flow === null ? null : Date.parse(flow.expiresAt);

			if (done !== null) return h('div', { className: 'dap-form', key: 'oauth' }, [
				h('div', { className: 'dap-form-title', key: 'title' }, t('oauthCompletedTitle')),
				h('div', { className: 'dap-status', role: 'status', key: 'done' }, t('oauthDone', { id: done })),
				h('p', { className: 'dap-intro', key: 'hint' }, t('oauthCompletedHint')),
				h('div', { className: 'dap-form-actions', key: 'actions' }, [
					h('button', { key: 'return', type: 'button', className: 'dap-btn dap-btn-primary', onClick: () => { activeFlow.current = null; onClose(); } }, t('oauthReturn')),
					h('button', { key: 'another', type: 'button', className: 'dap-btn', onClick: () => { activeFlow.current = null; setFlow(null); setInput(''); setDone(null); setError(null); setProblems(null); setCopied(false); setManual(false); } }, t('oauthAddAnother')),
				]),
			]);

			return h('div', { className: 'dap-form', key: 'oauth' }, [
				h('div', { className: 'dap-form-title', key: 'title' }, t('oauthTitle')),
				h('p', { className: 'dap-intro', key: 'hint' }, t('oauthHint')),
				credentialsAvailable === false
					? h('div', { className: 'dap-status dap-error', key: 'nocred' }, t('oauthNoCredential'))
					: null,
				providers.length === 0
					? h('div', { className: 'dap-status', key: 'none' }, t('oauthEmptyProviders'))
					: h('label', { className: 'dap-field', key: 'provider' }, [
						h('span', { className: 'dap-field-label', key: 'l' }, t('oauthProvider')),
						h('select', {
							key: 's',
							className: 'dap-input',
							value: provider,
							disabled: busy || pending,
							onChange: (event) => {
								setProvider(event.target.value);
								setFlow(null);
								setError(null);
								setDone(null);
							},
						}, providers.map((entry) => h('option', { key: entry.id, value: entry.id },
							entry.unverified === true ? `${entry.label} · ${t('oauthUnverified')}` : entry.label))),
					]),
				// The loopback spelling. Rendered only while nothing is live: it is an
				// input to `oauth-start`, so changing it mid-flow would do nothing and
				// imply otherwise.
				flow !== null ? null : h('label', {
					className: 'dap-field', key: 'redirectHost', title: t('oauthRedirectHostHint'),
				}, [
					h('span', { className: 'dap-field-label', key: 'l' }, t('oauthRedirectHost')),
					h('select', {
						key: 's', className: 'dap-input', value: redirectHost,
						onChange: (event) => setRedirectHost(event.target.value),
					}, [
						h('option', { key: '__default', value: '' }, 'localhost'),
						h('option', { key: '__ip', value: '127.0.0.1' }, '127.0.0.1'),
					]),
				]),
				// The vendor's own hint about how the redirect comes back. Shown before
				// the login starts, so the operator knows whether to keep the tab open.
				flow === null
					? (current?.manualOnly === true ? h('p', { className: 'dap-intro', key: 'manual-hint' }, t('oauthManual')) : null)
					: (manual ? h('p', { className: 'dap-intro', key: 'manual' }, t('oauthManual')) : h('p', { className: 'dap-intro', key: 'auto' }, t('oauthCallback'))),
				flow === null ? null : h('div', { className: 'dap-field', key: 'url' }, [
					h('span', { className: 'dap-field-label', key: 'l' }, t('oauthOpen')),
					h('div', { className: 'dap-actions', key: 'v' }, [
						h('a', {
							key: 'a', className: 'dap-models-hint', href: flow.authUrl, target: '_blank', rel: 'noopener noreferrer',
						}, flow.authUrl),
						h('button', {
							key: 'c', type: 'button', className: 'dap-btn',
							onClick: () => copy(flow.authUrl),
						}, copied ? t('oauthCopied') : t('oauthCopy')),
					]),
					pending && expiredAt !== null && Number.isFinite(expiredAt)
						? h('span', { key: 'e', className: 'dap-models-hint' },
							t('oauthExpires', { time: formatRemaining(expiredAt - Date.now(), t) }))
						: null,
				]),
				// The paste box is always available (a fixed-redirect provider needs
				// it, and a broken listener is exactly when a manual path earns its
				// keep) but it is only EMPHASISED when it is the only way through.
				flow === null ? null : h('label', { className: 'dap-field', key: 'input' }, [
					h('span', { className: 'dap-field-label', key: 'l' }, t('oauthInput')),
					h('input', {
						key: 'i', className: 'dap-input', type: 'text', value: input,
						placeholder: t('oauthInputPlaceholder'),
						onChange: (event) => setInput(event.target.value),
					}),
				]),
				pending ? h('div', { className: 'dap-status', key: 'waiting' }, t('oauthWaiting')) : null,
				done === null ? null : h('div', { className: 'dap-status', key: 'done' }, t('oauthDone', { id: done })),
				flow !== null && flow.caveat !== null && flow.caveat !== undefined
					? h('div', { className: 'dap-status', key: 'caveat' }, t('oauthCaveat', { text: flow.caveat }))
					: null,
				problems === null ? null : h(
					'div',
					{ className: problems.length === 0 ? 'dap-status' : 'dap-status dap-error', key: 'problems' },
					problems.length === 0
						? t('oauthCheckOk')
						// A vendor error cannot be resolved from here, so the message says
						// what WOULD be resolvable: the parameters this pool controls.
						: t('oauthCheckProblems', { list: problems.join('; ') }),
				),
				error === null ? null : h('div', { className: 'dap-error', key: 'err' }, t('oauthFailed', { message: error })),
				h('div', { className: 'dap-form-actions', key: 'actions' }, [
					flow === null
						? h('button', {
							key: 'start', type: 'button', className: 'dap-btn dap-btn-primary',
							disabled: busy || providers.length === 0 || credentialsAvailable === false,
							onClick: start,
						}, busy ? t('saving') : t('oauthStart'))
						: h('button', {
							key: 'finish', type: 'button', className: 'dap-btn dap-btn-primary',
							disabled: busy || input.trim() === '',
							onClick: finish,
						}, busy ? t('saving') : t('oauthFinish')),
					h('button', {
						key: 'cancel', type: 'button', className: 'dap-btn', disabled: busy, onClick: cancel,
					}, t('oauthCancel')),
					// Only meaningful once a flow exists (there are parameters to check).
					flow === null ? null : h('button', {
						key: 'check', type: 'button', className: 'dap-btn', disabled: busy, onClick: check,
					}, t('oauthCheck')),
				]),
			]);
		}

		// =====================================================================
		// § 11  Page chrome — the header and the summary cards. Both are pure
		//       functions of props: no hooks, no page state, so the offline test
		//       can expand them without a hook runtime (see tools/client-test.mjs).
		// =====================================================================

		/** The first-load placeholder: the page has no data yet. */
		function PoolLoadingState(props) {
			const { t } = props;
			return h('div', { className: 'dap-state', key: 'loading', role: 'status', 'aria-live': 'polite' }, [
				h('span', { className: 'dap-spinner', key: 'spinner' }),
				h('h4', { className: 'dap-state-title', key: 'title' }, t('loading')),
				h('p', { className: 'dap-state-hint', key: 'hint' }, t('loadingHint')),
			]);
		}

		/** The first-load failure: the Host never returned a body, so there is
		 *  nothing to show. The raw message is kept verbatim — it is the only
		 *  clue about which route or service failed. */
		function PoolErrorState(props) {
			const { t, message, onRetry } = props;
			return h('div', { className: 'dap-state dap-state-error', key: 'error', role: 'alert' }, [
				h('span', { className: 'dap-state-icon', key: 'icon' }, h(Icon, { name: 'refresh' })),
				h('h4', { className: 'dap-state-title', key: 'title' }, t('loadFailedTitle')),
				h('p', { className: 'dap-state-hint', key: 'hint' }, t('loadFailedHint')),
				message ? h('p', { className: 'dap-state-detail', key: 'detail' }, message) : null,
				h('button', { className: 'dap-btn dap-btn-primary', key: 'retry', type: 'button', onClick: onRetry }, t('retryLoad')),
			]);
		}

		/** The "nothing here" body shared by the three panels: one icon and one
		 *  line of explanation. Panels pass their own icon and copy. */
		function PoolEmptyState(props) {
			const { icon, message } = props;
			return h('div', { className: 'dap-status dap-empty', key: 'empty' }, [
				h('span', { className: 'dap-empty-icon', key: 'icon' }, h(Icon, { name: icon })),
				message,
			]);
		}

		/** Brand mark, title, and the row of page-level verbs. */
		function PoolHeader(props) {
			const { t, managementReady, supplierReady, pending, onExport, onToggleOauth, onToggleImport, onToggleSupplier, onAdvancedAdd, onRefresh } = props;
			return h('div', { className: 'dap-head', key: 'head' }, [
				h('div', { className: 'dap-head-text', key: 'text' }, [
					h('span', { className: 'dap-brand-mark', key: 'icon' }, h(Icon, { name: 'pool' })),
					h('div', { className: 'dap-heading-copy', key: 'copy' }, [
						h('h3', { className: 'dap-title', key: 'title' }, t('title')),
						h('p', { className: 'dap-intro', key: 'intro' }, t('intro')),
					]),
				]),
				h('div', { className: 'dap-head-actions', key: 'actions' }, [
					!managementReady ? null : h('button', { className: 'dap-refresh', key: 'export', type: 'button', title: t('exportHint'), onClick: onExport }, t('exportAction')),
					h('button', { className: 'dap-refresh', key: 'oauth', type: 'button', onClick: onToggleOauth }, t('oauthAction')),
					h('button', { className: 'dap-refresh', key: 'import', type: 'button', onClick: onToggleImport }, t('importAction')),
					h('button', {
						className: 'dap-btn dap-btn-primary', key: 'supplier', type: 'button', disabled: pending,
						onClick: onToggleSupplier,
					}, [h(Icon, { key: 'icon', name: 'plus' }), t(supplierReady ? 'connectSupplier' : 'addAccount')]),
					supplierReady ? h('button', {
						className: 'dap-refresh', key: 'add', type: 'button', disabled: pending, onClick: onAdvancedAdd,
					}, t('advancedAdd')) : null,
					h('button', { className: 'dap-refresh', key: 'refresh', type: 'button', onClick: onRefresh }, t('refresh')),
				]),
			]);
		}

		/** The four headline numbers above the tabs. */
		function PoolCards(props) {
			const { t, accountsBody, totalAccounts, groupCount, counts } = props;
			return h('div', { className: 'dap-cards', key: 'cards' }, [
				h(Card, {
					key: 'a', icon: 'accounts', label: t('cardAccounts'), value: String(totalAccounts),
					hint: t('cardAccountsHint', { ready: String(counts.ready), cooling: String(counts.cooling), failed: String(counts.failed) }),
				}),
				h(Card, {
					key: 'r', icon: 'activity', label: t('cardRequests'), value: compact(accountsBody?.totalRequests ?? 0),
					hint: t('cardRequestsHint'),
				}),
				h(Card, {
					key: 'g', icon: 'groups', label: t('cardGroups'), value: String(groupCount),
					hint: t('cardGroupsHint'),
				}),
				h(Card, {
					key: 'b', icon: 'link', label: t('cardBindings'), value: String((accountsBody?.bindings ?? []).length),
					hint: t('cardBindingsHint'),
				}),
			]);
		}

		// =====================================================================
		// § 12  Panels — every tab body, form, and toolbar, as hook-free
		//       components. PoolSection (§ 13) owns the state and hands each one
		//       the values and callbacks it needs, so the offline test can expand
		//       them without a hook runtime.
		// =====================================================================

		/** Search box, the five filter selects, and the result count / auto-refresh row. */
		function PoolToolbar(props) {
			const { t, filters, groups, shown, total, autoRefresh, onFilter, onClearFilters, onToggleAutoRefresh } = props;
			return h('div', { className: 'dap-toolbar', key: 'filters' }, [
				h('div', { className: 'dap-search-box', key: 'search' }, [
					h(Icon, { name: 'search', key: 'icon' }),
					h('input', { key: 'input', type: 'search', className: 'dap-input dap-search', placeholder: t('search'), 'aria-label': t('search'), value: filters.query, onChange: (event) => onFilter('query', event.target.value) }),
				]),
				...[
					['platform', t('allPlatforms'), PLATFORMS.map((value) => [value, value])],
					['authMode', t('colAuthMode'), [['api-key', 'API Key'], ['oauth', 'OAuth']]],
					['status', t('allStates'), ['statusActive', 'statusCooling', 'statusError', 'statusDisabled', 'statusPaused', 'statusExpired'].map((value) => [value, t(value)])],
					['group', t('allGroups'), [['__ungrouped', t('ungrouped')], ...groups.map((group) => [group.id, group.label || group.id])]],
					['sort', null, [['priority', t('sortPriority')], ['name', t('sortName')], ['recent', t('sortRecent')]]],
				].map(([key, label, choices]) => h('select', { key, className: 'dap-input', 'aria-label': label || t('sortPriority'), value: filters[key], onChange: (event) => onFilter(key, event.target.value) }, [label ? h('option', { key: '__all', value: '' }, label) : null, ...choices.map(([value, text]) => h('option', { key: value, value }, text))])),
				h('div', { className: 'dap-filter-meta', key: 'meta' }, [
					h('span', { key: 'count' }, t('shown', { n: String(shown), total: String(total) })),
					['query', 'platform', 'authMode', 'status', 'group'].some((key) => filters[key]) ? h('button', { key: 'clear', type: 'button', className: 'dap-row-more', onClick: onClearFilters }, t('clearFilters')) : null,
					h('label', { key: 'auto', className: 'dap-check-label' }, [h('input', { type: 'checkbox', checked: autoRefresh, onChange: (event) => onToggleAutoRefresh(event.target.checked) }), t('autoRefresh')]),
				]),
			]);
		}

		/** Page-size select and the prev/next pager. */
		function PoolPagination(props) {
			const { t, pageSize, currentPage, pageCount, onPageSize, onPrev, onNext } = props;
			return h('div', { className: 'dap-toolbar dap-pagination', key: 'pagination' }, [
				h('label', { key: 'size', className: 'dap-check-label' }, [t('pageSize'), h('select', { className: 'dap-input', 'aria-label': t('pageSize'), value: pageSize, onChange: (event) => onPageSize(Number(event.target.value)) }, [20, 50, 100].map((n) => h('option', { key: n, value: n }, String(n))))]),
				h('div', { className: 'dap-pagination-nav', key: 'nav' }, [
					h('button', { key: 'prev', className: 'dap-btn', type: 'button', disabled: currentPage === 0, onClick: onPrev }, t('pagePrev')),
					h('span', { key: 'page', className: 'dap-page-label' }, t('pageOf', { page: String(currentPage + 1), total: String(pageCount) })),
					h('button', { key: 'next', className: 'dap-btn', type: 'button', disabled: currentPage + 1 >= pageCount, onClick: onNext }, t('pageNext')),
				]),
			]);
		}

		/**
		 * The tab strip. Roving-tabindex keyboard support is local to the strip
		 * (arrow keys move focus and selection together), so it lives here rather
		 * than in the page state.
		 */
		/** Independent reviewer settings: never writes chat models or approval policy. */
		function AutoReviewPanel({ t }) {
			const [nonce, setNonce] = React.useState(0);
			const state = useJson('api/autoReview.model', nonce, t);
			const [draft, setDraft] = React.useState({ mode: 'session' });
			const [pending, setPending] = React.useState(false);
			const [error, setError] = React.useState(null);
			const [saved, setSaved] = React.useState(false);
			const dirty = React.useRef(false);
			const flight = React.useRef(null);
			const mounted = React.useRef(true);
			React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; flight.current?.abort(); }; }, []);
			const body = state.body;
			const ready = state.status === 'ready' && body?.version === 1 && body.available === true && body.compatible === true;
			React.useEffect(() => {
				if (ready && !dirty.current) setDraft(body.selection);
			}, [body, ready]);
			const choices = ready && Array.isArray(body.choices) ? body.choices : [];
			const providers = [...new Map(choices.map((row) => [row.provider, row.providerName || row.provider])).entries()];
			const models = choices.filter((row) => row.provider === draft.provider);
			const valid = draft.mode === 'session' || choices.some((row) => row.provider === draft.provider && row.model === draft.model);
			function change(next) { if (flight.current) return; dirty.current = true; setDraft(next); setSaved(false); setError(null); }
			async function save(event) {
				event.preventDefault();
				if (!mounted.current || flight.current || !ready || !valid) return;
				const controller = new AbortController(); flight.current = controller;
				const timeout = setTimeout(() => controller.abort(), 30000);
				setPending(true); setError(null); setSaved(false);
				try {
					const response = await fetch('api/autoReview.model', {
						method: 'POST', credentials: 'same-origin', signal: controller.signal,
						headers: { 'content-type': 'application/json', accept: 'application/json' },
						body: JSON.stringify({ selection: draft, expectedRevision: body.revision }),
					});
					const result = await response.json().catch(() => null);
					if (!response.ok || result?.version !== 1 || result.available !== true) throw new Error(result?.error?.message || `HTTP ${response.status}`);
					if (!mounted.current) return;
					dirty.current = false; setDraft(result.selection); setSaved(true); setNonce((value) => value + 1);
				} catch (failure) {
					if (mounted.current) setError(failure.name === 'AbortError' ? t('readTimeout') : failure.message);
				} finally {
					clearTimeout(timeout);
					if (flight.current === controller) flight.current = null;
					if (mounted.current) setPending(false);
				}
			}
			const disabled = pending || !ready;
			return h('section', { className: 'dap-section', 'aria-busy': pending || state.status === 'loading' }, [
				h('h3', { key: 'title' }, t('reviewTitle')),
				h('p', { className: 'dap-muted', key: 'hint' }, t('reviewHint')),
				h('p', { className: 'dap-muted', key: 'policy' }, t('reviewPolicyHint')),
				state.status === 'loading' ? h('p', { key: 'loading', role: 'status' }, t('reviewLoading')) : null,
				state.status !== 'loading' && !ready ? h('div', { key: 'unavailable', className: 'dap-error', role: 'alert' }, [t('reviewUnavailable'), state.error ? h('div', { key: 'detail' }, state.error) : null]) : null,
				h('form', { key: 'form', onSubmit: save }, [
					h('label', { key: 'mode', className: 'dap-field' }, [t('reviewMode'), h('select', { className: 'dap-input', value: draft.mode, disabled, onChange: (event) => change(event.target.value === 'session' ? { mode: 'session' } : { mode: 'fixed', provider: providers[0]?.[0] || '', model: choices[0]?.model || '' }) }, [
						h('option', { key: 'session', value: 'session' }, t('reviewSession')),
						h('option', { key: 'fixed', value: 'fixed' }, t('reviewFixed')),
					])]),
					draft.mode !== 'fixed' ? null : h('div', { key: 'fixed', className: 'dap-form-grid' }, [
						h('label', { key: 'provider', className: 'dap-field' }, [t('reviewProvider'), h('select', { className: 'dap-input', value: draft.provider, disabled, onChange: (event) => change({ mode: 'fixed', provider: event.target.value, model: choices.find((row) => row.provider === event.target.value)?.model || '' }) }, [
							!providers.some(([provider]) => provider === draft.provider) ? h('option', { key: 'missing', value: draft.provider || '' }, draft.provider || t('reviewChooseProvider')) : null,
							...providers.map(([provider, label]) => h('option', { key: provider, value: provider }, label)),
						])]),
						h('label', { key: 'model', className: 'dap-field' }, [t('reviewModel'), h('select', { className: 'dap-input', value: draft.model, disabled, onChange: (event) => change({ ...draft, model: event.target.value }) }, [
							!models.some((row) => row.model === draft.model) ? h('option', { key: 'missing', value: draft.model || '' }, draft.model || t('reviewChooseModel')) : null,
							...models.map((row) => h('option', { key: row.model, value: row.model }, row.modelName || row.model)),
						])]),
					]),
					ready && draft.mode === 'fixed' && !valid ? h('p', { key: 'invalid', className: 'dap-error', role: 'alert' }, t('reviewInvalid')) : null,
					h('div', { key: 'actions', className: 'dap-form-actions' }, [
						h('button', { key: 'save', type: 'submit', className: 'dap-btn dap-btn-primary', disabled: disabled || !valid }, pending ? t('saving') : t('save')),
						h('button', { key: 'refresh', type: 'button', className: 'dap-btn', disabled: pending, onClick: () => { dirty.current = false; setError(null); setSaved(false); setNonce((value) => value + 1); } }, t('refresh')),
					]),
				]),
				error ? h('p', { key: 'error', className: 'dap-error', role: 'alert' }, error) : null,
				saved ? h('p', { key: 'saved', role: 'status' }, t('reviewSaved')) : null,
			]);
		}

		function PoolTabs(props) {
			const { t, tabs, activeTab, onSelect } = props;
			return h('div', { className: 'dap-tabs', role: 'tablist', 'aria-label': t('tabLabel'), key: 'tabs' }, tabs.map(([id, label, count, icon], index) => h('button', {
				key: id, id: `dap-tab-${id}`, type: 'button', className: 'dap-tab', role: 'tab',
				'aria-selected': activeTab === id, 'aria-controls': `dap-panel-${id}`, tabIndex: activeTab === id ? 0 : -1,
				onClick: () => onSelect(id),
				onKeyDown: (event) => {
					const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
					if (next === null) return;
					event.preventDefault(); onSelect(tabs[next][0]);
					event.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next].focus();
				},
			}, [h(Icon, { key: 'icon', name: icon }), t(label), count == null ? null : h('span', { className: 'dap-tab-count', key: 'count' }, String(count))])));
		}

		/**
		 * The outcome of the last action, rendered above the tabs. Every branch is
		 * derived from the action result alone, so this stays a pure view.
		 */
		function ActionResultPanel(props) {
			const { t, result, now, onDismiss } = props;
			if (!result) return null;
			return h('div', { className: 'dap-result', key: 'result', role: 'status' }, [
				h('strong', { key: 'title' }, t('resultTitle')),
				h('button', { key: 'dismiss', type: 'button', className: 'dap-btn', onClick: onDismiss }, t('resultDismiss')),
				result.action === 'supplier-connect' && result.provider ? h('div', { key: 'supplier' }, [
					h('strong', {}, t('supplierConnected', { name: result.provider.name })),
					h('div', { className: 'dap-dim' }, `${t('supplierModels')}: ${(result.provider.models ?? []).join(', ')}`),
					h('p', {}, t('supplierNext', { name: result.provider.name })),
				]) : null,
				result.reset ? h('div', { key: 'reset', className: 'dap-cred-set' }, t('resetCardSuccess', { n: String(result.reset.windowsReset) })) : null,
				result.refreshError ? h('div', { key: 'refresh-error', className: 'dap-error' }, result.refreshError.message) : null,
				result.syncError ? h('div', { key: 'sync-error', className: 'dap-error' }, result.syncError.message) : null,
				result.quota && !result.reset ? h(QuotaView, { key: 'quota', quota: result.quota, t, now }) : null,
				result.test ? h('div', { key: 'test', className: result.test.ok ? 'dap-cred-set' : 'dap-error' }, result.test.ok ? t('testPassed', { ms: String(result.test.latencyMs ?? 0) }) : t('testFailed', { message: result.test.message || result.test.error || 'Unknown error' })) : null,
				Array.isArray(result.done) ? h('div', { key: 'done', className: 'dap-dim' }, `${t('ok')}: ${result.done.join(', ')}`) : null,
				...(result.failed ?? []).map((entry, index) => h('div', { key: index, className: 'dap-error' }, `${entry.id}: ${entry.error?.message || entry.reason || entry.error || t('failed')}`)),
				Array.isArray(result.created) ? h('div', { key: 'created', className: 'dap-dim' }, t('importDone', { created: String(result.created.length), errors: String(result.errors?.length ?? 0) })) : null,
				Array.isArray(result.updated) ? h('div', { key: 'updated', className: 'dap-dim' }, `${t('editAccount')}: ${result.updated.join(', ')}`) : null,
				result.errors?.length ? h('div', { key: 'import-errors', className: 'dap-error' }, JSON.stringify(result.errors)) : null,
			]);
		}

		/** Shared, named two-step confirmation; deleting a group keeps its accounts. */
		function GroupDeleteConfirmation({ t, group, pending, onConfirm, onCancel }) {
			return h('div', { className: 'dap-form', role: 'group', 'aria-label': t('providerDeleteHint', { name: group.label || group.id }), onKeyDown: (event) => {
				if (event.key === 'Escape' && !pending) { event.preventDefault(); event.stopPropagation(); onCancel(); }
			} }, [
				h('p', { key: 'hint' }, t('providerDeleteHint', { name: group.label || group.id })),
				h('div', { key: 'buttons', className: 'dap-actions' }, [
					h('button', { key: 'confirm', type: 'button', className: 'dap-btn dap-btn-danger', 'aria-label': `${t('confirmDelete')} ${group.label || group.id}`, disabled: pending, onClick: onConfirm }, t('confirmDelete')),
					h('button', { key: 'cancel', type: 'button', className: 'dap-btn', disabled: pending, onClick: onCancel }, t('cancel')),
				]),
			]);
		}

		/** The group cards: one per group, with member count, strategy and model tags. */
		function GroupsPanel(props) {
			const { t, groups, groupCounts, managementReady, pending, form, confirmation, onCreate, onEdit, onDelete } = props;
			return h('div', { className: 'dap-panel', key: 'groups' }, [
				h('div', { className: 'dap-panel-head', key: 'h' }, [
					h('div', { key: 'copy' }, [h('h4', { className: 'dap-panel-title', key: 't' }, t('groupsTitle')), h('p', { className: 'dap-panel-subtitle', key: 'hint' }, t('groupsHint'))]),
					h('button', { className: 'dap-btn dap-btn-primary', key: 'add', type: 'button', disabled: pending, onClick: onCreate }, [h(Icon, { name: 'plus', key: 'icon' }), t('groupAdd')]),
				]),
				form,
				confirmation,
				groups.length === 0
					? h(PoolEmptyState, { key: 'empty', icon: 'groups', message: t('groupEmpty') })
					: h('div', { className: 'dap-group-grid', key: 'list' }, groups.map((group) => h('div', { className: 'dap-group-card', key: group.id }, [
						h('div', { className: 'dap-group-heading', key: 'heading' }, [
							h('span', { className: 'dap-avatar', key: 'icon' }, h(Icon, { name: 'groups' })),
							h('div', { key: 'name' }, [h('div', { className: 'dap-group-name', key: 'label' }, group.label || group.id), h('div', { className: 'dap-mono dap-dim', key: 'id' }, group.id)]),
						]),
						h('div', { className: 'dap-group-meta', key: 'meta' }, [
							h('span', { key: 'members' }, t('groupMembers', { n: String(groupCounts.get(group.id) ?? 0) })),
							!managementReady ? null : h('span', { className: 'dap-tag', key: 'strategy' }, t(SELECTION_MODES.find(([value]) => value === (group.selectionMode ?? 'sticky'))?.[1] ?? 'modeSticky')),
						]),
						group.description ? h('p', { className: 'dap-group-desc', key: 'description' }, group.description) : null,
						h('div', { className: 'dap-group-models', key: 'models' }, (group.models ?? []).length === 0 ? h('span', { className: 'dap-tag' }, t('allModels')) : group.models.map((model) => h('span', { className: 'dap-tag', key: model, title: model }, model))),
						h('div', { className: 'dap-group-footer', key: 'footer' }, [
							h('span', { className: 'dap-mono dap-dim', key: 'route' }, `pool-${group.id}`),
							h('div', { className: 'dap-actions', key: 'actions' }, [
								h('button', { key: 'edit', type: 'button', className: 'dap-btn', disabled: pending, onClick: () => onEdit(group) }, t('editAccount')),
								h('button', { key: 'delete', type: 'button', className: 'dap-btn dap-btn-danger', disabled: pending, onClick: () => onDelete(group) }, t('deleteAccount')),
							]),
						]),
					]))),
			]);
		}

		/** Recent request log: the two filters, the summary strip, and the table. */
		function UsagePanel(props) {
			const { t, list, rows, summary, filters, status, error, onFilter } = props;
			return h('div', { className: 'dap-panel', key: 'usage' }, [
				h('div', { className: 'dap-panel-head', key: 'h' }, h('div', null, [h('h4', { className: 'dap-panel-title', key: 'title' }, t('usageTitle')), h('p', { className: 'dap-panel-subtitle', key: 'hint' }, t('usageHint'))])),
				h('div', { className: 'dap-toolbar', key: 'usage-filters' }, [
					h('select', { className: 'dap-input', 'aria-label': t('usageAccount'), value: filters.account, onChange: (event) => onFilter('account', event.target.value) }, [h('option', { value: '', key: '__all' }, t('usageAccount')), ...list.map((account) => h('option', { value: account.id, key: account.id }, account.label || account.id))]),
					h('input', { className: 'dap-input', type: 'search', 'aria-label': t('usageModel'), placeholder: t('usageModel'), value: filters.model, onChange: (event) => onFilter('model', event.target.value) }),
				]),
				h('p', { key: 'timing-hint', className: 'dap-timing-hint' }, t('usageTimingHint')),
				status === 'error' ? h('div', { key: 'error', className: 'dap-status dap-error' }, error) : null,
				h('div', { className: 'dap-usage-summary', key: 'summary', 'aria-label': t('usageSummary', { n: String(rows.length), ok: String(summary.ok), failed: String(summary.failed), input: compact(summary.input), output: compact(summary.output) }) }, [
					['usageRequests', rows.length], ['usageSuccess', summary.ok], ['usageFailures', summary.failed], ['usageInput', compact(summary.input)], ['usageOutput', compact(summary.output)],
				].map(([label, value]) => h('div', { key: label }, [h('strong', { key: 'n' }, String(value)), t(label)]))),
				rows.length === 0
					? h(PoolEmptyState, { key: 'empty', icon: 'activity', message: t('none') })
					: h('div', { className: 'dap-table-wrap', key: 'table-wrap' }, h('table', { className: 'dap-table dap-usage-table', key: 'table' }, [
						h('thead', { key: 'head' }, h('tr', null, [
							h('th', { key: 't', scope: 'col' }, t('colTime')),
							h('th', { key: 'a', scope: 'col' }, t('colAccount')),
							h('th', { key: 'm', scope: 'col', className: 'dap-usage-model' }, t('colModel')),
							h('th', { key: 'k', scope: 'col' }, t('colTokens')),
							h('th', { key: 'first', scope: 'col', className: 'dap-timing', title: t('firstTokenHint') }, t('colFirstToken')),
							h('th', { key: 'duration', scope: 'col', className: 'dap-timing', title: t('outputDurationHint') }, t('colOutputDuration')),
							h('th', { key: 'tps', scope: 'col', className: 'dap-timing', title: t('outputTpsHint') }, t('colOutputTps')),
							h('th', { key: 's', scope: 'col' }, t('colSwitches')),
							h('th', { key: 'r', scope: 'col' }, t('colResult')),
						])),
						h('tbody', { key: 'body' }, rows.map((row, index) => h(UsageRow, { key: `${row.at}-${String(index)}`, row, t }))),
					])),
			]);
		}

		/**
		 * The account tab. Everything inside it — the toolbar, the open forms, the
		 * batch bar, the pager — is built by the caller and handed in as an already
		 * rendered node, so this component only owns the header, the restart
		 * notices, the selection table and the ordering between them.
		 */
		function AccountsPanel(props) {
			const {
				t, list, visible, selected, now, pool, action, pending,
				managementReady, quotaReady, supplierReady,
				toolbar, accountUsagePanel, supplierForm, form, testPanel, batchEditPanel,
				importPanel, oauthPanel, batchBar, pagination, onToggleAll, onToggleOne,
			} = props;
			return h('div', { className: 'dap-panel', key: 'accounts' }, [
				h('div', { className: 'dap-panel-head', key: 'h' }, [
					h('div', { key: 'copy' }, [h('h4', { className: 'dap-panel-title', key: 'title' }, t('accountsTitle')), h('p', { className: 'dap-panel-subtitle', key: 'hint' }, t('accountsHint'))]),
					h('span', { className: 'dap-panel-count', key: 'count' }, t('groupMembers', { n: String(list.length) })),
				]),
				!managementReady ? h('div', { className: 'dap-status', key: 'restart' }, t('restartRequired')) : null,
				!quotaReady && managementReady ? h('div', { className: 'dap-status', key: 'quota-restart' }, t('quotaRestart')) : null,
				toolbar,
				accountUsagePanel,
				!supplierReady ? h('div', { className: 'dap-status', key: 'supplier-restart' }, t('supplierRestart')) : null,
				supplierForm,
				form,
				testPanel,
				batchEditPanel,
				importPanel,
				oauthPanel,
				batchBar,
				visible.length === 0
					? h(PoolEmptyState, {
						key: 'empty', icon: list.length === 0 ? 'accounts' : 'search',
						message: t(list.length === 0 ? 'empty' : 'noMatches'),
					})
					: h('div', { className: 'dap-table-wrap', key: 'table-wrap' }, h('table', { className: 'dap-table dap-account-table', key: 'table' }, [
						h('thead', { key: 'head' }, h('tr', null, [
							h('th', { key: 'sel', className: 'dap-cell-select', scope: 'col' }, h('input', {
								type: 'checkbox', className: 'dap-check-all', 'aria-label': t('batchSelected', { n: String(visible.length) }),
								checked: visible.length > 0 && visible.every((account) => selected.has(account.id)),
								disabled: pending, onChange: () => onToggleAll(),
							})),
							h('th', { key: 'a', className: 'dap-cell-account', scope: 'col' }, t('colAccount')),
							h('th', { key: 'p', className: 'dap-cell-protocol', scope: 'col' }, t('colConnection')),
							h('th', { key: 's', className: 'dap-cell-status', scope: 'col' }, t('colStatus')),
							h('th', { key: 'pr', className: 'dap-cell-schedule', scope: 'col' }, t('colScheduling')),
							h('th', { key: 'used', className: 'dap-cell-activity', scope: 'col' }, t('colActivity')),
							h('th', { key: 'x', className: 'dap-cell-actions', scope: 'col' }, t('colActions')),
						])),
						h('tbody', { key: 'body' }, visible.map((account) => h(AccountRow, {
							key: account.id, account, now, t, action, pool,
							selected: selected.has(account.id), onSelect: onToggleOne,
						}))),
					])),
				pagination,
			]);
		}

		/** One-off connectivity probe for a single account. */
		function TestPanel(props) {
			const { t, testing, pending, onModel, onRun, onCancel } = props;
			return h('div', { className: 'dap-form', key: 'test' }, [
				h('div', { className: 'dap-form-title', key: 'title' }, `${t('actTest')} · ${testing.label}`),
				h(Field, { key: 'model', label: t('colModel'), value: testing.model, onChange: onModel }),
				h('div', { className: 'dap-form-actions', key: 'actions' }, [
					h('button', { type: 'button', className: 'dap-btn dap-btn-primary', disabled: pending || !testing.model.trim(), onClick: onRun }, t('actTest')),
					h('button', { type: 'button', className: 'dap-btn', disabled: pending, onClick: onCancel }, t('cancel')),
				]),
			]);
		}

		/** Bulk edit of the scheduling fields across the current selection. */
		function BatchEditPanel(props) {
			const { t, values, pending, onValue, onSave } = props;
			return h('div', { className: 'dap-form', key: 'batch-edit' }, [
				h('p', { className: 'dap-intro' }, t('batchEditHint')),
				h('div', { className: 'dap-form-grid' }, ['priority', 'concurrency', 'weight', 'models'].map((key) => h(Field, { key, label: t({ priority: 'fieldPriority', concurrency: 'fieldConcurrency', weight: 'fieldWeight', models: 'fieldModels' }[key]), type: key === 'models' ? 'text' : 'number', value: values[key], onChange: (value) => onValue(key, value) }))),
				h('button', { type: 'button', className: 'dap-btn dap-btn-primary', disabled: pending || Object.values(values).every((value) => value.trim() === ''), onClick: onSave }, t('batchSave')),
			]);
		}

		/** Paste-a-document import box, with an optional target group. */
		function ImportPanel(props) {
			const { t, groups, document: text, group, pending, onChange, onGroup, onRun, onCancel } = props;
			return h('div', { className: 'dap-form', key: 'import' }, [
				h('div', { className: 'dap-form-title', key: 'title' }, t('importTitle')),
				h('p', { className: 'dap-intro', key: 'hint' }, t('importHint')),
				groups.length === 0 ? null : h('label', { className: 'dap-field', key: 'target' }, [
					h('span', { className: 'dap-field-label', key: 'l' }, t('importTarget')),
					h('select', {
						key: 's', className: 'dap-input', value: group,
						onChange: (event) => onGroup(event.target.value),
					}, [
						h('option', { key: '__none', value: '' }, t('importTargetNone')),
						...groups.map((entry) => h(
							'option',
							{ key: entry.id, value: entry.id },
							entry.label === '' ? entry.id : entry.label,
						)),
					]),
				]),
				h('textarea', {
					key: 'body',
					className: 'dap-input dap-textarea',
					value: text,
					placeholder: t('importPlaceholder'),
					onChange: (event) => onChange(event.target.value),
				}),
				h('div', { className: 'dap-form-actions', key: 'actions' }, [
					h('button', {
						key: 'run', type: 'button', className: 'dap-btn dap-btn-primary',
						disabled: pending || text.trim() === '',
						onClick: onRun,
					}, pending ? t('saving') : t('importRun')),
					h('button', {
						key: 'cancel', type: 'button', className: 'dap-btn',
						disabled: pending, onClick: onCancel,
					}, t('cancel')),
				]),
			]);
		}

		/**
		 * The floating bar over a non-empty selection. It only issues verbs; the
		 * host validates every id and reports per-account outcomes.
		 */
		function BatchBar(props) {
			const { t, count, groups, group, confirming, pending, managementReady, attribution, onGroup, onRun, onDelete, onToggleEdit, onClear } = props;
			return h('div', { className: 'dap-batch', key: 'batch' }, [
				h('span', { className: 'dap-batch-count', key: 'n' }, t('batchSelected', { n: String(count) })),
				attribution.batchAvailable ? h('button', { key: 'attribution', type: 'button', className: 'dap-btn', disabled: pending || attribution.batchDisabled, onClick: attribution.armBatch, title: attribution.batchReason || t('attributionConfigure') }, t('attributionBatch')) : null,
				attribution.batchAvailable && attribution.batchReason ? h('span', { key: 'attribution-reason', className: 'dap-dim' }, attribution.batchReason) : null,
				h('button', { key: 'on', type: 'button', className: 'dap-btn', disabled: pending, onClick: () => onRun('enable') }, t('actEnable')),
				h('button', { key: 'off', type: 'button', className: 'dap-btn', disabled: pending, onClick: () => onRun('disable') }, t('actDisable')),
				h('button', { key: 'cool', type: 'button', className: 'dap-btn', disabled: pending, onClick: () => onRun('clear-cooldown') }, t('actClearCooldown')),
				!managementReady ? null : h('button', { key: 'pause', type: 'button', className: 'dap-btn', disabled: pending, onClick: () => onRun('pause-scheduling') }, t('actPause')),
				!managementReady ? null : h('button', { key: 'resume', type: 'button', className: 'dap-btn', disabled: pending, onClick: () => onRun('resume-scheduling') }, t('actResume')),
				!managementReady ? null : h('button', { key: 'reset', type: 'button', className: 'dap-btn', disabled: pending, onClick: () => onRun('reset-error') }, t('actResetError')),
				!managementReady ? null : h('button', { key: 'edit', type: 'button', className: 'dap-btn', disabled: pending, onClick: onToggleEdit }, t('batchEdit')),
				groups.length === 0 ? null : h('select', {
					key: 'pick', className: 'dap-input', value: group,
					onChange: (event) => onGroup(event.target.value),
				}, [
					h('option', { key: '__none', value: '' }, t('batchPickGroup')),
					...groups.map((entry) => h(
						'option',
						{ key: entry.id, value: entry.id },
						entry.label === '' ? entry.id : entry.label,
					)),
				]),
				groups.length === 0 ? null : h('button', {
					key: 'join', type: 'button', className: 'dap-btn',
					disabled: pending || group === '',
					onClick: () => onRun('group-add', { group }),
				}, t('batchJoin')),
				groups.length === 0 ? null : h('button', {
					key: 'leave', type: 'button', className: 'dap-btn',
					disabled: pending || group === '',
					onClick: () => onRun('group-remove', { group }),
				}, t('batchLeave')),
				// Two-step on purpose: deleting N accounts is irreversible, so the first
				// click only ARMS it, and the label then names exactly how many would go.
				h('button', {
					key: 'del', type: 'button', className: 'dap-btn',
					disabled: pending,
					onClick: onDelete,
				}, confirming
					? t('batchConfirmDelete', { n: String(count) })
					: t('batchDelete')),
				h('button', { key: 'clear', type: 'button', className: 'dap-btn', onClick: onClear }, t('batchClear')),
			]);
		}
		/**
		 * The per-account quota drawer under the table. The reset-credit flow is
		 * owned by PoolSection (it needs the request-id ledger), so it arrives here
		 * as already-built handlers.
		 */
		function AccountUsagePanel(props) {
			const {
				t, account, snapshot, quotaReady, now, pending, usagePending, resetReady,
				resetConfirmation, resetError, onRefresh, onClose, onUseReset, onConfirmReset, onCancelReset,
			} = props;
			if (!account || !quotaReady || !canQueryQuota(account)) return null;
			const name = account.label || account.id;
			return h('section', { className: 'dap-form dap-account-usage', key: 'account-usage', 'aria-label': t('accountUsageTitle', { name }) }, [
				h('div', { key: 'head', className: 'dap-account-usage-head' }, [
					h('div', { key: 'copy' }, [h('h4', { className: 'dap-form-title', tabIndex: -1, key: 'title' }, t('accountUsageTitle', { name })), h('p', { key: 'hint', className: 'dap-dim' }, t('accountUsageHint'))]),
					h('div', { key: 'actions', className: 'dap-actions' }, [h('button', { key: 'refresh', type: 'button', className: 'dap-btn', disabled: pending || usagePending || !account.credential?.configured, onClick: onRefresh }, t(usagePending ? 'quotaRefreshing' : 'refreshAccountUsage')), h('button', { key: 'close', type: 'button', className: 'dap-btn', onClick: onClose }, t('resultDismiss'))]),
				]),
				h('div', { key: 'body', className: 'dap-account-usage-grid' }, [
					h(QuotaView, { key: 'quota', quota: snapshot.quota, t, now }),
					account.platform !== 'openai' ? null : h(ResetCreditsView, { key: 'cards', snapshot: snapshot.resetCredits, ready: resetReady, t, pending: pending || usagePending, configured: account.credential?.configured, confirmation: resetConfirmation?.id === account.id && resetConfirmation.key === quotaAccountKey(account) ? resetConfirmation : null, onUse: onUseReset, onConfirm: onConfirmReset, onCancel: onCancelReset, error: resetError }),
				]),
			]);
		}

		// =====================================================================
		// § 13  PoolSection — the settings page. Owns all page state, fetches the
		//       three Host routes, and assembles the panels below. Its own
		//       render body is deliberately thin: the chrome is § 11, and the
		//       remaining panels are built from hook-free components (§ 12).
		// =====================================================================

		function PoolSection(props) {
			const { ctx, t } = props;
			useStyles();

			const [nonce, setNonce] = React.useState(0);
			const [oauthNonce, setOauthNonce] = React.useState(0);
			const action = useAction(() => setNonce((value) => value + 1), t);
			const accounts = useJson(ACCOUNTS_ROUTE, nonce, t);
			const usage = useJson(`${USAGE_ROUTE}?limit=${String(USAGE_LIMIT)}`, nonce, t);
			// The OAuth provider directory is its own request, and deliberately not
			// part of the accounts payload: the accounts route is on the hot path for
			// every page render, while the provider list is static reference data.
			const oauth = useJson(OAUTH_ROUTE, oauthNonce, t);
			const now = useNow();
			const [editing, setEditing] = React.useState(null);
			const editorRef = React.useRef(null);
			const editorGeneration = React.useRef(0);
			React.useEffect(() => () => { editorRef.current = null; }, []);
			function setEditor(next) {
				// Every opening is a distinct editing session, even for the same ID.
				editorRef.current = next === null ? null : { ...next, generation: ++editorGeneration.current, progress: { pending: false, savedId: null, signature: null, priorities: new Map() } };
				setEditing(editorRef.current);
			}
			const [confirmingId, setConfirmingId] = React.useState(null);
			const [importing, setImporting] = React.useState(null);
			const [importGroup, setImportGroup] = React.useState('');
			const [oauthOpen, setOauthOpen] = React.useState(false);
			const [editingGroup, setEditingGroup] = React.useState(null);
			const [confirmingGroupId, setConfirmingGroupId] = React.useState(null);
			const [selected, setSelectedState] = React.useState(() => new Set());
			const selectedRef = React.useRef(selected);
			function setSelected(next) {
				selectedRef.current = typeof next === 'function' ? next(selectedRef.current) : next;
				attribution.dismissBatch();
				setSelectedState(selectedRef.current);
			}
			const [batchGroup, setBatchGroup] = React.useState('');
			// Arming state for the destructive batch verb, so one click never deletes.
			const [confirmingBatch, setConfirmingBatch] = React.useState(false);
			const [filters, setFilters] = React.useState({ query: '', platform: '', status: '', group: '', authMode: '', sort: 'priority' });
			const [autoRefresh, setAutoRefresh] = React.useState(false);
			const [testing, setTesting] = React.useState(null);
			const [batchEditing, setBatchEditing] = React.useState(false);
			const [batchValues, setBatchValues] = React.useState({ priority: '', concurrency: '', weight: '', models: '' });
			const [exportError, setExportError] = React.useState(null);
			const [usageFilters, setUsageFilters] = React.useState({ account: '', model: '' });
			const [pageIndex, setPageIndex] = React.useState(0);
			const [pageSize, setPageSize] = React.useState(50);
			const [supplierOpen, setSupplierOpen] = React.useState(false);
			const [activeTab, setActiveTab] = React.useState('accounts');
			// Mount settings only when visited, then retain unsaved drafts across tabs.
			const [settingsVisited, setSettingsVisited] = React.useState(false);
			const quotaData = useAccountQuotas(t);
			const actionState = React.useRef(action);
			actionState.current = action;
			const attribution = useModelAttribution(nonce, t, () => setNonce(value => value + 1), selectedRef, actionState);
			const batchAttributionBusy = attribution.batchBusy();
			const [usageAccountId, setUsageAccountId] = React.useState(null);
			const reset = useResetCredits(t, action, quotaData);
			const { confirmation: resetConfirmation, error: resetError } = reset;
			useMoreMenuDismissal();
			const supplierReady = accounts.body?.supplierVersion >= 1;
			const managementReady = accounts.body?.managementVersion >= 2;
			const quotaReady = accounts.body?.quotaVersion >= 1;
			const detectionReady = (accounts.body?.detectionVersion ?? 0) >= 1;
			const openaiProtocolReady = (accounts.body?.openaiProtocolVersion ?? 0) >= 1;
			const codexWebSocketReady = (accounts.body?.codexWebSocketVersion ?? 0) >= 1;

			/** Row-level handlers plus the pending delete confirmation. */
			const pool = {
				confirmingId,
				managementReady,
				quotaReady,
				quotaData,
				attribution,
				onViewUsage: (account) => {
					setActiveTab('accounts');
					setUsageAccountId(account.id);
					reset.setError(null);
					reset.setConfirmation(reset.restoreFor(account));
					void quotaData.load(account);
				},
				onRefreshQuota: (account) => { void quotaData.load(account, true); },
				onTest: (account) => { setActiveTab('accounts'); setTesting({ id: account.id, model: account.models?.[0] ?? '', label: account.label || account.id }); },
				onEdit: (account) => {
					setActiveTab('accounts');
					setSupplierOpen(false);
					setConfirmingId(null);
					setEditor({
						mode: 'edit',
						id: account.id,
						configured: account.credential?.configured === true,
						initial: {
							id: account.id,
							label: account.label ?? '',
							poolDetectionRetry: account.poolDetectionRetry === true,
							poolDetectionRetries: String(account.poolDetectionRetries ?? 2),
							poolDetectionRetryDelayMs: String(account.poolDetectionRetryDelayMs ?? 1000),
							poolDetectionKeywords: (account.poolDetectionKeywords ?? POOL_DETECTION_KEYWORDS).join('\n'),
							projectId: account.projectId ?? '', chatgptAccountId: account.chatgptAccountId ?? '', notes: account.notes ?? '', betas: (account.betas ?? []).join(', '), expiresAt: localDateInput(account.expiresAt),
							autoPauseOnExpired: account.autoPauseOnExpired !== false, schedulable: account.schedulable !== false,
							loadFactor: account.loadFactor == null ? '' : String(account.loadFactor),
							platform: account.platform,
							baseUrl: account.baseUrl ?? '',
							openaiApi: account.openaiApi ?? 'chat-completions', openaiTransport: account.openaiTransport ?? 'http',
							models: (account.models ?? []).join(', '),
							groups: [...(account.groups ?? [])],
							// The overrides that already exist for THIS account, so the form
							// opens showing the real ranking rather than blanks.
							groupPriorities: Object.fromEntries(
								(accounts.body?.priorities ?? [])
									.filter((entry) => entry.accountId === account.id)
									.map((entry) => [entry.groupId, String(entry.priority)]),
							),
							priority: String(account.priority),
							weight: String(account.weight ?? 0),
							concurrency: String(account.concurrency ?? 0),
							// Without these the selects would open on the defaults instead of
							// on what is stored, and saving the form would then silently reset
							// an enabled disguise.
							authMode: account.authMode ?? AUTH_MODES[0],
							mimicry: account.mimicry ?? MIMICRY_MODES[0],
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
				setActiveTab('accounts');
				setConfirmingId(null);
				setEditor({
					mode: 'create',
					id: '',
					configured: false,
					initial: {
						id: '', label: '', platform: PLATFORMS[0], baseUrl: '',
						poolDetectionRetry: false, poolDetectionRetries: '2', poolDetectionRetryDelayMs: '1000', poolDetectionKeywords: POOL_DETECTION_KEYWORDS.join('\n'),
						models: '', groups: [], priority: '100', weight: '0', concurrency: '4',
						authMode: AUTH_MODES[0], mimicry: MIMICRY_MODES[0],
					},
				});
			}

			async function saveForm(payload) {
				const session = editing;
				if (!session || editorRef.current?.progress !== session.progress || session.progress.pending || action.pending) return false;
				const progress = session.progress;
				const current = () => editorRef.current?.progress === progress;
				const publish = () => { if (current()) setEditing((previous) => ({ ...previous })); };
				const extra = { account: payload.account, ...(payload.credential === undefined ? {} : { credential: payload.credential }) };
				const signature = JSON.stringify(extra);
				progress.pending = true;
				publish();
				try {
					// Only a confirmed main save arms this checkpoint; ambiguous failures
					// are not silently treated as committed or automatically replayed.
					if (progress.signature !== signature) {
						const verb = progress.savedId || session.mode === 'edit' ? 'update' : 'create';
						const ok = await action.run(progress.savedId || payload.id, verb, extra, (body) => {
							progress.savedId = body.account?.id || String(payload.id).trim();
							progress.signature = signature;
							progress.priorities.clear();
						});
						if (!ok || !current()) return false;
						publish();
					}
					// Each priority is independently acknowledged. Same-draft retries
					// continue only unfinished steps; changed main fields update the saved ID.
					for (const [groupId, raw] of Object.entries(payload.groupPriorities ?? {})) {
						if (!current()) return false;
						const text = String(raw ?? '').trim();
						if (progress.priorities.get(groupId) === text) continue;
						const sent = text === ''
							? await action.run(progress.savedId, 'priority-clear', { group: groupId })
							: await action.run(progress.savedId, 'priority-set', { group: groupId, priority: Number(text) });
						if (!sent || !current()) return false;
						progress.priorities.set(groupId, text);
					}
					if (current()) setEditor(null);
					return true;
				} finally { progress.pending = false; publish(); }
			}

			const form = editing === null ? null : h(AccountForm, {
				// Each opening has its own key/checkpoint, including reopening the same
				// account while an old completion is still pending. Drafts stay mounted
				// across read retries, but never leak between editing sessions.
				key: `form-${editing.generation}`,
				t,
				mode: editing.mode,
				initial: editing.initial,
				configured: editing.configured === true,
				pending: action.pending || editing.progress.pending,
				savedId: editing.progress.savedId,
				error: action.error,
				onSave: saveForm,
				onCancel: () => setEditor(null),
				// Read inline: the `allGroups` const is declared further down, and a
				// `const` does not hoist.
				allGroups: accounts.body?.groups ?? [],
				managementReady,
				quotaReady,
				detectionReady, openaiProtocolReady, codexWebSocketReady,
			});

			const supplierForm = !supplierOpen || !supplierReady ? null : h(SupplierForm, {
				key: 'supplier-form', t, groups: accounts.body?.groups ?? [], pending: action.pending, error: action.error, openaiProtocolReady,
				onSave: async (payload) => { const ok = await action.run('', 'supplier-connect', payload); if (ok) setSupplierOpen(false); return ok; },
				onCancel: () => setSupplierOpen(false),
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

			const importPanel = importing === null ? null : h(ImportPanel, {
				t, groups: accounts.body?.groups ?? [], document: importing, group: importGroup, pending: action.pending,
				onChange: setImporting, onGroup: setImportGroup, onRun: runImport, onCancel: () => setImporting(null),
			});

			// --- batch ------------------------------------------------------------
			// Selection is purely a view concern; the host still validates every id and
			// reports per-account outcomes, so a stale selection cannot corrupt anything.
			function toggleOne(accountId) {
				setConfirmingBatch(false);
				setSelected((previous) => {
					const next = new Set(previous);
					if (next.has(accountId)) next.delete(accountId);
					else next.add(accountId);
					return next;
				});
			}

			function toggleAll() {
				setConfirmingBatch(false);
				setSelected((previous) => (visible.length > 0 && visible.every((account) => previous.has(account.id))
					? new Set([...previous].filter((id) => !visible.some((account) => account.id === id)))
					: new Set([...previous, ...visible.map((account) => account.id)])));
			}

			async function runBatch(verb, extra = {}) {
				if (attribution.batchBusy()) return;
				attribution.dismissBatch();
				// Disarm FIRST: a stale armed state must never delete on a later click.
				setConfirmingBatch(false);
				const ok = await action.run('', 'batch', { ids: [...selected], verb, ...extra }, (body) => setSelected(new Set((body.failed ?? []).map((entry) => entry.id))));
				if (ok) setBatchEditing(false);
			}

			const batchGroups = accounts.body?.groups ?? [];
			const selectionBar = selected.size === 0 ? null : h(BatchBar, {
				t, count: selected.size, groups: batchGroups, group: batchGroup, confirming: confirmingBatch,
				pending: action.pending || batchAttributionBusy, managementReady, attribution,
				onGroup: setBatchGroup,
				onRun: (verb, extra) => { void runBatch(verb, extra); },
				onDelete: () => { if (attribution.batchBusy()) return; attribution.dismissBatch(); if (!confirmingBatch) setConfirmingBatch(true); else void runBatch('delete'); },
				onToggleEdit: () => { if (attribution.batchBusy()) return; attribution.dismissBatch(); setBatchEditing((value) => !value); },
				onClear: () => setSelected(new Set()),
			});

			const batchBar = [selectionBar, h(AttributionBatchPanel, { key: 'attribution-batch', attribution, t, pending: action.pending })];

			// --- groups ----------------------------------------------------------
			const allGroups = accounts.body?.groups ?? [];
			const groupCounts = new Map();
			// `list` is declared further down, and a `const` does not hoist — read the
			// body directly here instead of relying on declaration order.
			for (const account of accounts.body?.accounts ?? []) {
				for (const id of account.groups ?? []) groupCounts.set(id, (groupCounts.get(id) ?? 0) + 1);
			}

			function startGroupCreate() {
				setConfirmingGroupId(null);
				setEditingGroup({
					mode: 'create',
					id: '',
					initial: { id: '', label: '', models: '', description: '' },
				});
			}

			function startGroupEdit(group) {
				setConfirmingGroupId(null);
				setEditingGroup({
					mode: 'edit',
					id: group.id,
					initial: {
						id: group.id,
						label: group.label ?? '',
						models: (group.models ?? []).join(', '),
						description: group.description ?? '',
						selectionMode: group.selectionMode ?? 'sticky',
						enabled: group.enabled !== false,
					},
				});
			}

			async function saveGroup(payload) {
				const verb = editingGroup.mode === 'create' ? 'group-create' : 'group-update';
				const ok = await action.run(payload.id, verb, { group: payload.group });
				if (ok) setEditingGroup(null);
			}

			const groupForm = editingGroup === null ? null : h(GroupForm, {
				// Same reason as the account form: a fixed key would leak one group's
				// values into the next group's editor.
				key: `groupform-${editingGroup.id ?? ''}`,
				t,
				mode: editingGroup.mode,
				initial: editingGroup.initial,
				pending: action.pending,
				error: action.error,
				onSave: saveGroup,
				onCancel: () => setEditingGroup(null),
				managementReady,
			});

			const confirmingGroup = allGroups.find((group) => group.id === confirmingGroupId);
			const groupConfirmation = confirmingGroup ? h(GroupDeleteConfirmation, {
				t, group: confirmingGroup, pending: action.pending,
				onCancel: () => setConfirmingGroupId(null),
				onConfirm: () => action.run(confirmingGroup.id, 'group-delete', {}, () => setConfirmingGroupId((id) => id === confirmingGroup.id ? null : id)),
			}) : null;
			const groupsPanel = h(GroupsPanel, {
				t, groups: allGroups, groupCounts, managementReady, pending: action.pending, form: groupForm, confirmation: groupConfirmation,
				onCreate: startGroupCreate,
				onEdit: startGroupEdit,
				onDelete: (group) => { setEditingGroup(null); setConfirmingGroupId(group.id); },
			});

			const list = accounts.body?.accounts ?? [];
			const filtered = filterAccounts(list, filters, now);
			const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
			const currentPage = Math.min(pageIndex, pageCount - 1);
			const visible = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
			const visibleQuotaKey = visible.filter(canQueryQuota).map(quotaAccountKey).join('|');
			React.useEffect(() => {
				if (!quotaReady || accounts.status !== 'ready' || activeTab !== 'accounts') return;
				let cancelled = false;
				let index = 0;
				const queue = visible.filter((account) => canQueryQuota(account) && account.credential?.configured);
				async function worker() {
					while (!cancelled && index < queue.length) await quotaData.load(queue[index++]);
				}
				void worker();
				void worker();
				return () => { cancelled = true; };
			}, [visibleQuotaKey, accounts.body, accounts.status, quotaReady, activeTab]);
			const usageAccount = list.find((account) => account.id === usageAccountId);
			const usageSnapshot = usageAccount ? quotaData.forAccount(usageAccount) : null;
			const resetReady = accounts.body?.resetCreditsVersion >= 1;
			const usagePending = usageAccount ? quotaData.pendingIds.has(usageAccount.id) : false;
			const beginReset = () => reset.begin(usageAccount, usagePending);
			const confirmReset = () => reset.confirm(usageAccount, resetReady);
			const counts = { ready: 0, cooling: 0, failed: 0 };
			for (const account of list) {
				const tone = statusOf(account, now).tone;
				if (tone === 'ready') counts.ready += 1;
				else if (tone === 'cooling') counts.cooling += 1;
				else if (tone === 'failed') counts.failed += 1;
			}
			// Each group is a separate provider route; ranking lives on its accounts.

			React.useEffect(() => {
				if (!autoRefresh || action.pending || resetConfirmation || supplierOpen || editing || editingGroup || confirmingGroupId || importing !== null || oauthOpen || testing || batchEditing) return;
				const timer = setInterval(() => setNonce((value) => value + 1), 15000);
				return () => clearInterval(timer);
			}, [autoRefresh, action.pending, resetConfirmation, supplierOpen, editing, editingGroup, confirmingGroupId, importing, oauthOpen, testing, batchEditing]);
			React.useEffect(() => {
				if (!usageAccountId) return;
				const panel = document.querySelector('.dap-account-usage');
				panel?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
				panel?.querySelector('.dap-form-title')?.focus?.({ preventScroll: true });
			}, [usageAccountId]);

			const head = h(PoolHeader, {
				key: 'head', t, managementReady, supplierReady, pending: action.pending,
				onExport: async () => {
					setExportError(null);
					try {
						const response = await fetch(ACTION_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ action: 'export', ...(selected.size ? { ids: [...selected] } : {}) }) });
						const body = await response.json();
						if (!response.ok) throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
						const url = URL.createObjectURL(new Blob([JSON.stringify(body.document, null, 2)], { type: 'application/json' }));
						const link = document.createElement('a'); link.href = url; link.download = 'account-pool-config.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
					} catch (error) { setExportError(error.message); }
				},
				onToggleOauth: () => { setActiveTab('accounts'); setOauthOpen((current) => !current); },
				onToggleImport: () => { setActiveTab('accounts'); setImporting((current) => (current === null ? '' : null)); },
				onToggleSupplier: () => { setActiveTab('accounts'); if (supplierReady) { setEditor(null); setSupplierOpen((current) => !current); } else startCreate(); },
				onAdvancedAdd: () => { setSupplierOpen(false); startCreate(); },
				onRefresh: () => { setNonce((value) => value + 1); setOauthNonce((value) => value + 1); },
			});

			if (accounts.status === 'loading' && accounts.body === null) {
				return h('div', { className: 'dap-root' }, [head, h(PoolLoadingState, { key: 'loading', t })]);
			}
			if (accounts.status === 'error' && accounts.body === null) {
				return h('div', { className: 'dap-root' }, [
					head,
					h(PoolErrorState, {
						key: 'error', t, message: accounts.error,
						onRetry: () => setNonce((value) => value + 1),
					}),
				]);
			}

			const cards = h(PoolCards, {
				key: 'cards', t, accountsBody: accounts.body, totalAccounts: list.length,
				groupCount: allGroups.length, counts,
			});

			const oauthPanel = oauthOpen !== true ? null : oauth.body === null ? h(OAuthDirectoryState, {
				t, status: oauth.status, error: oauth.error,
				onRetry: () => setOauthNonce((value) => value + 1), onClose: () => setOauthOpen(false),
			}) : h(OAuthPanel, {
				// Remounted per open, so a half-finished login from a previous visit is
				// not resurrected into a form that no longer matches the server's flows.
				key: 'oauth-panel',
				t,
				providers: oauth.body?.providers ?? [],
				credentialsAvailable: oauth.body?.credentialsAvailable,
				onClose: () => setOauthOpen(false),
				// A new account changes the table, the group member counts and the
				// routes; one refresh covers all three.
				onChanged: () => setNonce((value) => value + 1),
			});

			const setFilter = (key, value) => { setPageIndex(0); setConfirmingBatch(false); setFilters((previous) => ({ ...previous, [key]: value })); };
			const toolbar = h(PoolToolbar, {
				key: 'filters', t, filters, groups: allGroups, shown: filtered.length, total: list.length, autoRefresh,
				onFilter: setFilter,
				onClearFilters: () => { setFilters({ query: '', platform: '', status: '', group: '', authMode: '', sort: 'priority' }); setPageIndex(0); setConfirmingBatch(false); },
				onToggleAutoRefresh: setAutoRefresh,
			});
			const pagination = h(PoolPagination, {
				key: 'pagination', t, pageSize, currentPage, pageCount,
				onPageSize: (size) => { setPageSize(size); setPageIndex(0); setConfirmingBatch(false); },
				onPrev: () => { setPageIndex(currentPage - 1); setConfirmingBatch(false); },
				onNext: () => { setPageIndex(currentPage + 1); setConfirmingBatch(false); },
			});
			const testPanel = testing === null ? null : h(TestPanel, {
				t, testing, pending: action.pending,
				onModel: (model) => setTesting((previous) => ({ ...previous, model })),
				onRun: async () => { if (await action.run(testing.id, 'test', { model: testing.model.trim() })) setTesting(null); },
				onCancel: () => setTesting(null),
			});
			const batchEditPanel = !batchEditing || selected.size === 0 ? null : h(BatchEditPanel, {
				t, values: batchValues, pending: action.pending || batchAttributionBusy,
				onValue: (key, value) => setBatchValues((previous) => ({ ...previous, [key]: value })),
				onSave: () => {
					const account = {};
					for (const [key, value] of Object.entries(batchValues)) if (value.trim() !== '') account[key] = key === 'models' ? value.split(',').map((part) => part.trim()).filter(Boolean) : Number(value);
					void runBatch('update', { account });
				},
			});
			const resultPanel = h(ActionResultPanel, { t, result: action.result, now, onDismiss: action.dismiss });

			const accountUsagePanel = h(AccountUsagePanel, {
				t, account: usageAccount, snapshot: usageSnapshot, quotaReady, now,
				pending: action.pending, usagePending, resetReady, resetConfirmation, resetError,
				onRefresh: () => { void quotaData.load(usageAccount, true); },
				onClose: () => { setUsageAccountId(null); reset.cancel(); },
				onUseReset: beginReset,
				onConfirmReset: confirmReset,
				onCancelReset: () => { if (resetConfirmation?.dispatched) setUsageAccountId(null); reset.cancel(); },
			});
			const accountPanel = h(AccountsPanel, {
				t, list, visible, selected, now, pool, action, pending: action.pending,
				managementReady, quotaReady, supplierReady,
				toolbar, accountUsagePanel, supplierForm, form, testPanel, batchEditPanel,
				importPanel, oauthPanel, batchBar, pagination, onToggleAll: toggleAll, onToggleOne: toggleOne,
			});
			const recentRows = usage.body?.rows ?? [];
			const rows = recentRows.filter((row) => (!usageFilters.account || row.accountId === usageFilters.account) && (!usageFilters.model || row.model.toLowerCase().includes(usageFilters.model.toLowerCase())));
			const summary = rows.reduce((value, row) => ({ ok: value.ok + (row.ok ? 1 : 0), failed: value.failed + (row.ok ? 0 : 1), input: value.input + (row.inputTokens || 0), output: value.output + (row.outputTokens || 0) }), { ok: 0, failed: 0, input: 0, output: 0 });
			const usagePanel = h(UsagePanel, {
				t, list, rows, summary, filters: usageFilters, status: usage.status, error: usage.error,
				onFilter: (key, value) => setUsageFilters((previous) => ({ ...previous, [key]: value })),
			});

			const tabs = [['accounts', 'tabAccounts', list.length, 'accounts'], ['groups', 'tabGroups', allGroups.length, 'groups'], ['usage', 'tabUsage', recentRows.length, 'activity'], ['auto-review', 'tabAutoReview', null, 'activity'], ['settings', 'tabSettings', null, 'settings']];
			const tabBar = h(PoolTabs, { t, tabs, activeTab, onSelect: (tab) => { if (tab === 'settings') setSettingsVisited(true); setActiveTab(tab); if (tab !== 'groups') setConfirmingGroupId(null); } });

			return h('div', { className: 'dap-root', 'aria-busy': accounts.status === 'loading' }, [
				head, cards,
				h('div', { className: 'dap-workspace', key: 'workspace' }, [
					tabBar,
					accounts.error ? h('div', { key: 'refresh-error', className: 'dap-result', role: 'alert' }, [
						h('strong', { key: 'hint' }, t('refreshFailed')),
						h('div', { key: 'detail', className: 'dap-error' }, accounts.error),
						h('button', { key: 'retry', type: 'button', className: 'dap-btn', onClick: () => setNonce((value) => value + 1) }, t('retryLoad')),
					]) : null,
					oauthOpen && oauth.body !== null && oauth.error ? h('div', { key: 'oauth-refresh-error', className: 'dap-result', role: 'alert' }, [
						h('strong', { key: 'hint' }, t('refreshFailed')),
						h('div', { key: 'detail', className: 'dap-error' }, oauth.error),
						h('button', { key: 'retry', type: 'button', className: 'dap-btn', onClick: () => setOauthNonce((value) => value + 1) }, t('retryLoad')),
					]) : null,
					action.error === null ? null : h('div', { className: 'dap-error dap-result', role: 'alert', key: 'action-error' }, t('actFailed', { message: action.error })),
					exportError ? h('div', { className: 'dap-error dap-result', role: 'alert', key: 'export-error' }, exportError) : null,
					resultPanel,
					...[['accounts', accountPanel], ['groups', groupsPanel], ['usage', usagePanel], ['auto-review', activeTab === 'auto-review' ? h(AutoReviewPanel, { t }) : null], ['settings', settingsVisited ? h(PoolSettingsPanel, { t, active: activeTab === 'settings' }) : null]].map(([id, panel]) => h('div', {
						key: id, id: `dap-panel-${id}`, role: 'tabpanel', 'aria-labelledby': `dap-tab-${id}`, hidden: activeTab !== id,
					}, panel)),
				]),
				h('div', { className: 'dap-foot', key: 'foot' }, t('footer')),
			]);
		}

		/**
		 * `pool-<groupId>` → the group id; the default `pool` (or anything else) →
		 * `undefined`, which means "the whole pool". Mirrors `groupOfProvider` in
		 * lib/adapter.js: this bundle is hand-written with no import step, so the
		 * two have to agree by construction — the tests pin the shape.
		 */
		// =====================================================================
		// § 14  Provider card + registration — the Models-page summary row and the
		//       `apply()` entry point that seats both slots.
		// =====================================================================

		const groupOfRoute = (route) => (
			typeof route === 'string' && route.startsWith('pool-') && route.length > 'pool-'.length
				? route.slice('pool-'.length)
				: undefined
		);

		/**
		 * Summary line rendered under a provider row this plugin owns: the pool
		 * itself, plus one row per group. The ROW's route decides the scope, so a
		 * group row never reports the whole pool's numbers.
		 */
		function ProviderPoolCard(props) {
			const { t, provider } = props;
			useStyles();
			const groupId = groupOfRoute(provider?.provider);
			const [revision, setRevision] = React.useState(0);
			const [editing, setEditing] = React.useState(false);
			const [confirming, setConfirming] = React.useState(false);
			const accounts = useJson(ACCOUNTS_ROUTE, revision, t);
			const action = useAction(() => setRevision((value) => value + 1), t);
			const group = accounts.body?.groups?.find((entry) => entry.id === groupId);
			const cardRef = React.useRef(null);
			React.useEffect(() => {
				if (!groupId) return;
				const card = cardRef.current;
				const row = card?.closest('li');
				const editButton = row?.querySelector('button');
				if (!editButton) return;
				card.dataset.nativeEdit = 'true';
				const edit = (event) => { event.preventDefault(); event.stopImmediatePropagation(); setEditing((value) => !value); setConfirming(false); };
				editButton.addEventListener('click', edit, true);
				// Reuse the surrounding Models page's button styles and action row.
				const document = card.ownerDocument;
				const removeButton = document.createElement('button');
				const nativeRemove = [...row.parentElement.querySelectorAll('button')].find((button) => button !== editButton && button.textContent.trim() === t('deleteAccount'));
				removeButton.type = 'button';
				removeButton.className = nativeRemove?.className || 'dap-btn dap-btn-danger';
				removeButton.textContent = t('deleteAccount');
				removeButton.setAttribute('aria-label', `${t('deleteAccount')} ${group?.label || groupId}`);
				removeButton.disabled = action.pending || accounts.status !== 'ready';
				const remove = () => { setConfirming(true); setEditing(false); };
				removeButton.addEventListener('click', remove);
				editButton.parentElement.append(removeButton);
				const dot = document.createElement('span');
				dot.className = 'dap-provider-dot';
				dot.dataset.enabled = String(group?.enabled !== false);
				dot.setAttribute('role', 'img');
				dot.setAttribute('aria-label', t(group?.enabled === false ? 'providerDisabled' : 'providerEnabled'));
				dot.title = dot.getAttribute('aria-label');
				row.firstElementChild?.firstElementChild?.append(dot);
				return () => { editButton.removeEventListener('click', edit, true); removeButton.remove(); dot.remove(); };
			}, [groupId, group?.label, group?.enabled, accounts.status, action.pending]);
			const all = accounts.body?.accounts ?? [];
			const list = groupId === undefined ? all : all.filter((account) => (account.groups ?? []).includes(groupId));
			const now = Date.now();
			const counts = { ready: 0, cooling: 0 };
			for (const account of list) {
				const tone = statusOf(account, now).tone;
				if (tone === 'ready') counts.ready += 1;
				else if (tone === 'cooling') counts.cooling += 1;
			}
			const disabled = action.pending || accounts.status !== 'ready';
			return h('div', { ref: cardRef, className: 'dap-root dap-models-provider', 'data-expanded': editing || confirming || !!accounts.error || !!action.error, 'data-pool-provider': provider?.provider }, [
				h('div', { className: 'dap-models-toolbar', key: 'toolbar' }, [
					h('span', { className: 'dap-dim', key: 'summary' }, t('providerHint', { total: String(list.length), ready: String(counts.ready), cooling: String(counts.cooling) })),
					!group ? null : h('span', { className: 'dap-actions', key: 'actions' }, [
						h('span', { key: 'state', role: 'status', className: 'dap-provider-state', 'data-enabled': group.enabled !== false }, t(group.enabled === false ? 'providerDisabled' : 'providerEnabled')),
						h('button', { key: 'edit', type: 'button', className: 'dap-btn dap-provider-edit-fallback', disabled, 'aria-label': `${t('editAccount')} ${group.label || group.id}`, onClick: () => { setEditing(!editing); setConfirming(false); } }, t('editAccount')),
						h('button', { key: 'toggle', type: 'button', className: 'dap-btn', disabled, onClick: () => action.run(groupId, 'group-update', { group: { enabled: group.enabled === false } }) }, t(group.enabled === false ? 'actEnable' : 'actDisable')),
						h('button', { key: 'delete', type: 'button', className: 'dap-btn dap-btn-danger', disabled, onClick: () => { setConfirming(true); setEditing(false); } }, t('deleteAccount')),
					]),
				]),
				accounts.error ? h('p', { key: 'read-error', className: 'dap-error', role: 'alert' }, accounts.error) : null,
				!editing && action.error ? h('p', { key: 'error', className: 'dap-error', role: 'alert' }, action.error) : null,
				confirming && group ? h(GroupDeleteConfirmation, {
					key: 'confirmation', t, group, pending: disabled,
					onConfirm: () => action.run(groupId, 'group-delete', {}, () => setConfirming(false)),
					onCancel: () => setConfirming(false),
				}) : null,
				!editing || !group ? null : h(GroupForm, {
					key: `provider-form-${group.id}`, t, mode: 'edit', managementReady: true,
					initial: { ...group, models: (group.models ?? []).join(', ') }, pending: action.pending, error: action.error,
					onCancel: () => setEditing(false),
					onSave: ({ id, group: edits }) => action.run(id, 'group-update', { group: edits }, () => setEditing(false)),
				}),
			]);
		}

		/** Account-pool-owned settings, separate from management and review tabs. */
		function PoolSettingsPanel({ t, active }) {
			return h('section', { className: 'dap-settings', 'aria-label': t('poolSettingsTitle') }, [
				h('div', { key: 'head', className: 'dap-panel-head' }, h('div', { className: 'dap-heading-copy' }, [
					h('h2', { key: 'title', className: 'dap-panel-title' }, t('poolSettingsTitle')),
					h('p', { key: 'intro', className: 'dap-intro' }, t('poolSettingsIntro')),
				])),
				h(LocalApiSettings, { key: 'local-api', t, active }),
				h(CodexCompactionSettings, { key: 'v2-compaction', t }),
			]);
		}
		/** Only public status fields are retained; an API key never enters a shared action result. */
		function localApiSnapshot(value) {
			if (!value || typeof value !== 'object' || Array.isArray(value)
				|| typeof value.enabled !== 'boolean' || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535
				|| typeof value.running !== 'boolean' || typeof value.baseUrl !== 'string'
				|| typeof value.keyConfigured !== 'boolean' || (value.error !== null && typeof value.error !== 'string')) return null;
			const { enabled, port, running, baseUrl, keyConfigured, error } = value;
			return { enabled, port, running, baseUrl, keyConfigured, error };
		}

		function LocalApiSettings({ t, active }) {
			const [remote, setRemote] = React.useState({ status: 'loading', settings: null, error: null });
			const [draft, setDraft] = React.useState({ enabled: false, port: '19389' });
			const [pending, setPending] = React.useState(null);
			const [confirmation, setConfirmation] = React.useState(false);
			const [apiKey, setApiKey] = React.useState('');
			const [notice, setNotice] = React.useState('');
			const [error, setError] = React.useState('');
			const [copying, setCopying] = React.useState(false);
			const control = React.useRef({ alive: true, active, ready: false, reading: false, writing: false, dirty: false,
				readId: 0, epoch: 0, copyId: 0, copying: false, key: '', confirmed: false, settings: null, draft });
			const current = control.current;
			current.active = active;
			function clearKey() {
				current.key = ''; current.copyId += 1; current.copying = false;
				if (current.alive) { setApiKey(''); setCopying(false); setNotice(''); }
			}
			function disarm() { current.confirmed = false; if (current.alive) setConfirmation(false); }
			function adoptDraft(settings) {
				current.draft = { enabled: settings.enabled, port: String(settings.port) };
				setDraft(current.draft);
			}
			React.useEffect(() => {
				current.alive = true;
				return () => { current.alive = false; current.ready = false; current.key = ''; current.writeController?.abort(); };
			}, []);

			async function refresh() {
				if (!current.alive || !current.active || current.reading || current.writing) return;
				current.reading = true; current.ready = false; disarm();
				const id = ++current.readId;
				const controller = new AbortController();
				current.readController = controller;
				const timeout = setTimeout(() => controller.abort(), 30000);
				setRemote(previous => ({ ...previous, status: 'loading', error: null }));
				try {
					const body = await poolJson(ACCOUNTS_ROUTE, { method: 'GET', cache: 'no-store', headers: { accept: 'application/json' }, signal: controller.signal }, t);
					if (!current.alive || id !== current.readId) return;
					if (controller.signal.aborted) throw new Error(t('readTimeout'));
					const settings = body.localApiVersion === 1 ? localApiSnapshot(body.localApi) : null;
					if (!settings) { setRemote(previous => ({ ...previous, status: 'unsupported', error: null })); return; }
					current.settings = settings; current.ready = true;
					setRemote({ status: 'ready', settings, error: null });
					if (!current.dirty) adoptDraft(settings);
				} catch (failure) {
					if (!current.alive || id !== current.readId) return;
					setRemote(previous => ({ ...previous, status: 'error', error: failure.name === 'AbortError' ? t('readTimeout') : failure.message || t('failed') }));
				} finally {
					clearTimeout(timeout);
					if (id === current.readId) { current.reading = false; current.readController = null; }
				}
			}
			React.useEffect(() => {
				if (active) void refresh();
				const timer = active ? setInterval(() => { void refresh(); }, 15000) : null;
				return () => {
					// Settings remain mounted to preserve drafts. Leaving must still revoke
					// secrets, clipboard callbacks and late responses from this visit.
					current.epoch += 1; current.ready = false; current.readId += 1;
					current.readController?.abort(); current.readController = null; current.reading = false;
					if (timer !== null) clearInterval(timer);
					clearKey(); disarm();
				};
			}, [active, t]);

			const canWrite = () => current.alive && current.active && current.ready && !current.reading && !current.writing;
			const validPort = value => /^\d+$/.test(value) && Number.isInteger(Number(value)) && Number(value) >= 1024 && Number(value) <= 65535;
			function change(name, value) {
				if (!canWrite() || (name === 'enabled' && (typeof value !== 'boolean' || (value && !current.settings.keyConfigured)))) return;
				current.dirty = true; current.draft = { ...current.draft, [name]: value };
				setDraft(current.draft); setNotice(''); setError('');
			}
			async function write(kind) {
				if (!canWrite()) return false;
				const rotate = kind === 'rotate';
				if (rotate && current.settings.keyConfigured && !current.confirmed) return false;
				if (!rotate && (!validPort(current.draft.port) || (current.draft.enabled && !current.settings.keyConfigured))) return false;
				current.writing = true;
				const epoch = current.epoch;
				const controller = new AbortController();
				current.writeController = controller;
				const timeout = setTimeout(() => controller.abort(), 30000);
				let reconcile = false;
				setPending(kind); setNotice(''); setError(''); disarm();
				if (rotate) clearKey();
				try {
					const payload = rotate ? { action: 'local-api-rotate-key' }
						: { action: 'local-api-update', enabled: current.draft.enabled, port: Number(current.draft.port) };
					const body = await poolJson(ACTION_ROUTE, { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json', accept: 'application/json' }, signal: controller.signal, body: JSON.stringify(payload) }, t);
					if (controller.signal.aborted) throw new Error(t('readTimeout'));
					const settings = localApiSnapshot(body.localApi);
					if (body.ok !== true) throw new Error(typeof body.error?.message === 'string' ? body.error.message : t('localApiInvalidReply'));
					if (!settings || (rotate && (!settings.keyConfigured || typeof body.apiKey !== 'string' || !body.apiKey))
						|| (body.apiKey !== undefined && (typeof body.apiKey !== 'string' || !body.apiKey || !settings.keyConfigured))) throw new Error(t('localApiInvalidReply'));
					if (!current.alive) return false;
					current.settings = settings; current.ready = current.active;
					setRemote({ status: 'ready', settings, error: null });
					// Rotation changes no draft settings, even when the operator edited a port.
					if (!rotate) { current.dirty = false; adoptDraft(settings); }
					if (current.active && epoch === current.epoch) {
						if (body.apiKey) { current.key = body.apiKey; setApiKey(body.apiKey); }
						setNotice(rotate ? 'localApiKeyCreated' : 'localApiSaved');
					}
					return true;
				} catch (failure) {
					if (current.alive) {
						current.ready = false; reconcile = true;
						setError(failure.name === 'AbortError' ? t('readTimeout') : failure.message || t('failed'));
					}
					return false;
				} finally {
					clearTimeout(timeout); current.writeController = null; current.writing = false;
					if (current.alive) { setPending(null); if (reconcile) void refresh(); }
				}
			}
			function requestKey() {
				if (!canWrite()) return;
				if (current.settings.keyConfigured) { current.confirmed = true; setConfirmation(true); setNotice(''); }
				else return write('rotate');
			}
			async function copy(kind) {
				if (!current.alive || !current.active || current.copying) return;
				const value = kind === 'key' ? current.key : current.ready ? current.settings?.baseUrl : '';
				if (!value) return;
				const id = ++current.copyId;
				current.copying = true; setCopying(true); setNotice(''); setError('');
				try {
					if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') throw new Error('clipboard-unavailable');
					await navigator.clipboard.writeText(value);
					if (current.alive && current.active && id === current.copyId) setNotice(kind === 'key' ? 'localApiKeyCopied' : 'localApiBaseUrlCopied');
				} catch {
					// Clipboard errors must never interpolate the value being copied.
					if (current.alive && current.active && id === current.copyId) setError(t('localApiCopyFailed'));
				} finally {
					if (id === current.copyId) { current.copying = false; if (current.alive) setCopying(false); }
				}
			}
			const settings = remote.settings;
			const disabled = !active || !current.ready || !!pending || remote.status !== 'ready';
			const portValid = validPort(draft.port);
			const button = (key, label, onClick, off = disabled, extra = '') => h('button', { key, type: 'button', className: `dap-btn ${extra}`, disabled: off, onClick }, t(label));
			return h('section', { className: 'dap-panel dap-local-api', 'aria-labelledby': 'dap-local-api-title', 'aria-busy': !!pending || remote.status === 'loading' }, [
				h('div', { key: 'head', className: 'dap-panel-head' }, h('h3', { id: 'dap-local-api-title', className: 'dap-panel-title' }, t('localApiTitle'))),
				h('form', { key: 'form', className: 'dap-form', onSubmit: event => { event.preventDefault(); return write('save'); } }, [
					h('p', { key: 'intro', id: 'dap-local-api-intro', className: 'dap-intro' }, t('localApiIntro')),
					h('label', { key: 'enabled', className: 'dap-check-label' }, [
						h('input', { key: 'input', type: 'checkbox', role: 'switch', 'aria-checked': draft.enabled, 'aria-label': t('localApiEnable'), 'aria-describedby': 'dap-local-api-intro', checked: draft.enabled, disabled: disabled || (!settings?.keyConfigured && !draft.enabled), onChange: event => change('enabled', event.target.checked) }), t('localApiEnable'),
					]),
					h(Field, { key: 'port', type: 'number', min: 1024, max: 65535, step: 1, label: t('localApiPort'), value: draft.port, disabled, onChange: value => change('port', value) }),
					h('p', { key: 'port-hint', className: 'dap-intro' }, t('localApiPortHint')),
					!portValid ? h('p', { key: 'invalid-port', role: 'alert', className: 'dap-error' }, t('localApiInvalidPort')) : null,
					settings && !settings.keyConfigured ? h('p', { key: 'key-required', className: 'dap-intro' }, t('localApiKeyRequired')) : null,
					h('dl', { key: 'status', className: 'dap-local-api-status', 'aria-live': 'polite' }, [
						h('dt', { key: 'running-label' }, t('localApiRuntime')), h('dd', { key: 'running' }, settings ? t(settings.running ? 'localApiRunning' : 'localApiStopped') : '—'),
						h('dt', { key: 'url-label' }, t('localApiBaseUrl')), h('dd', { key: 'url' }, settings?.baseUrl || '—'),
						h('dt', { key: 'key-label' }, t('localApiKeyConfigured')), h('dd', { key: 'key' }, settings ? t(settings.keyConfigured ? 'credConfigured' : 'credMissing') : '—'),
						h('dt', { key: 'error-label' }, t('localApiError')), h('dd', { key: 'error', className: settings?.error ? 'dap-error' : '' }, settings ? settings.error || t('localApiNoError') : '—'),
					]),
					remote.status === 'loading' ? h('p', { key: 'loading', role: 'status' }, t('localApiLoading')) : null,
					remote.status === 'unsupported' ? h('p', { key: 'unsupported', role: 'alert', className: 'dap-error' }, t('localApiRestart')) : null,
					remote.status === 'error' ? h('div', { key: 'read-error', role: 'alert', className: 'dap-error' }, [t('localApiReadFailed'), h('div', { key: 'detail' }, remote.error)]) : null,
					current.dirty ? h('p', { key: 'draft', className: 'dap-intro' }, t('localApiDraft')) : null,
					error ? h('p', { key: 'action-error', role: 'alert', className: 'dap-error' }, t('actFailed', { message: error })) : null,
					notice ? h('p', { key: 'notice', role: 'status' }, t(notice)) : null,
					confirmation && active ? h('div', { key: 'confirmation', className: 'dap-local-api-confirm', role: 'group', 'aria-label': t('localApiConfirmRotate') }, [
						h('p', { key: 'warning' }, t('localApiRotateWarning')),
						h('div', { key: 'buttons', className: 'dap-actions' }, [button('confirm', 'localApiConfirmRotate', () => write('rotate'), disabled, 'dap-btn-danger'), button('cancel', 'cancel', disarm, !!pending)]),
					]) : null,
					active && apiKey ? h('div', { key: 'secret', className: 'dap-local-api-secret' }, [
						h('p', { key: 'warning', className: 'dap-intro' }, t('localApiKeyOnce')),
						h('label', { key: 'key', className: 'dap-field' }, [h('span', { key: 'label', className: 'dap-field-label' }, t('localApiKeyLabel')), h('input', { key: 'value', className: 'dap-input', type: 'text', readOnly: true, value: apiKey, 'aria-label': t('localApiKeyLabel'), autoComplete: 'off', spellCheck: false })]),
						h('div', { key: 'actions', className: 'dap-actions' }, [button('copy', 'localApiCopyKey', () => copy('key'), copying || !!pending), button('close', 'localApiCloseKey', clearKey, false)]),
					]) : null,
					h('div', { key: 'actions', className: 'dap-actions' }, [
						h('button', { key: 'save', type: 'submit', className: 'dap-btn dap-btn-primary', disabled: disabled || !portValid || (draft.enabled && !settings?.keyConfigured) }, t(pending === 'save' ? 'saving' : 'save')),
						button('rotate', pending === 'rotate' ? 'actWorking' : settings?.keyConfigured ? 'localApiRotate' : 'localApiGenerate', requestKey),
						button('copy-url', 'localApiCopyBaseUrl', () => copy('url'), disabled || copying || !settings?.baseUrl),
						button('refresh', 'refresh', refresh, !active || !!pending || remote.status === 'loading'),
						current.dirty ? button('discard', 'localApiDiscard', () => { if (!canWrite()) return; current.dirty = false; adoptDraft(current.settings); setNotice(''); setError(''); }) : null,
					]),
				]),
			]);
		}

		function CodexCompactionSettings({ t }) {
			useStyles();
			const [nonce, setNonce] = React.useState(0);
			const state = useJson(ACCOUNTS_ROUTE, nonce, t);
			const action = useAction(() => setNonce((value) => value + 1), t);
			const [draft, setDraft] = React.useState(false);
			const [saved, setSaved] = React.useState(false);
			const dirty = React.useRef(false);
			const saving = React.useRef(false);
			const latest = React.useRef(null);
			React.useEffect(() => () => { latest.current = null; }, []);
			const settings = state.body?.codexCompatibility;
			const compatible = state.body?.codexCompatibilityVersion === 1
				&& typeof settings?.encryptedCompactionV2 === 'boolean' && typeof settings?.available === 'boolean';
			const ready = state.status === 'ready' && compatible && settings.available === true;
			React.useEffect(() => {
				if (state.status === 'ready' && compatible && !dirty.current) setDraft(settings.encryptedCompactionV2);
			}, [state.body, state.status, compatible]);
			// Old rendered callbacks must not write after a refresh removed capability.
			latest.current = { ready, draft, pending: action.pending };
			function change(event) {
				const current = latest.current;
				if (!current?.ready || current.pending || saving.current || typeof event.target.checked !== 'boolean') return;
				dirty.current = true;
				setDraft(event.target.checked);
				setSaved(false);
			}
			async function save(event) {
				event.preventDefault();
				const current = latest.current;
				if (!current?.ready || current.pending || saving.current) return false;
				saving.current = true;
				setSaved(false);
				try {
					// No account id or transport edits: this is one explicit global setting.
					return await action.run(undefined, 'codex-compatibility-update', { encryptedCompactionV2: current.draft }, () => {
						dirty.current = false;
						setSaved(true);
					});
				} finally { saving.current = false; }
			}
			const disabled = !ready || action.pending;
			const descriptionIds = ['scope', 'timing', 'history', 'fallback'];
			return h('div', { className: 'dap-settings-card', 'aria-busy': action.pending || state.status === 'loading' }, [
				h('section', { key: 'panel', className: 'dap-panel', 'aria-labelledby': 'dap-codex-compaction-title' }, [
					h('div', { key: 'head', className: 'dap-panel-head' }, h('h3', { id: 'dap-codex-compaction-title', className: 'dap-panel-title' }, t('codexCompactionTitle'))),
					h('form', { key: 'form', className: 'dap-form', onSubmit: save, 'aria-busy': action.pending }, [
						h('label', { key: 'enable', htmlFor: 'dap-codex-encrypted-compaction-v2', className: 'dap-check-label' }, [
							h('input', { key: 'input', id: 'dap-codex-encrypted-compaction-v2', type: 'checkbox', checked: draft, disabled,
								'aria-label': t('codexCompactionEnable'), 'aria-describedby': descriptionIds.map((id) => `dap-codex-compaction-${id}`).join(' '), onChange: change }),
							t('codexCompactionEnable'),
						]),
						...descriptionIds.map((id) => h('p', { key: id, id: `dap-codex-compaction-${id}`, className: 'dap-intro' }, t(`codexCompaction${id[0].toUpperCase()}${id.slice(1)}`))),
						state.status === 'loading' ? h('p', { key: 'loading', role: 'status' }, t('codexCompatibilityLoading')) : null,
						state.status === 'error' ? h('div', { key: 'read-error', className: 'dap-error', role: 'alert' }, [t('codexCompatibilityReadFailed'), h('div', { key: 'detail' }, state.error)]) : null,
						state.status === 'ready' && !ready ? h('p', { key: 'unavailable', className: 'dap-error', role: 'alert' }, t(compatible ? 'codexCompatibilityUnavailable' : 'codexCompatibilityRestart')) : null,
						action.error ? h('p', { key: 'save-error', className: 'dap-error', role: 'alert' }, t('actFailed', { message: action.error })) : null,
						saved ? h('p', { key: 'saved', role: 'status' }, t('codexCompatibilitySaved')) : null,
						h('div', { key: 'actions', className: 'dap-form-actions' }, [
							h('button', { key: 'save', type: 'submit', className: 'dap-btn dap-btn-primary', disabled }, action.pending ? t('saving') : t('save')),
							h('button', { key: 'refresh', type: 'button', className: 'dap-btn', disabled: action.pending, onClick: () => {
								if (!latest.current || saving.current) return;
								setNonce((value) => value + 1);
							} }, t('refresh')),
						]),
					]),
				]),
			]);
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

			// 2. Feature settings live in the account-pool Settings tab, not a second
			// top-level navigation entry. One card under every provider row this plugin owns — the pool and each
			//    group — keyed by the Loader entry id, the same value the Host half
			//    declares as `settingsNs`. The row's own route travels in the owner's
			//    `provider` prop, so a group row must be handed it or every row would
			//    report the whole pool's numbers.
			slots.inject(PROVIDER_CARD_SLOT, () => {
				const abort = new AbortController();
				let unregister;
				let disposed = false;
				fetch(ACCOUNTS_ROUTE, { credentials: 'same-origin', signal: abort.signal })
					.then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); })
					.then((body) => {
						if (disposed) return;
						const key = body.settingsNs || ENTRY_ID;
						unregister = slots.register({ name: PROVIDER_CARD_SLOT, key }, (props) => h(ProviderPoolCard, { ctx, t, provider: props.provider }));
					})
					.catch((error) => { if (!abort.signal.aborted) console.error('account-pool provider management:', error); });
				return () => { disposed = true; abort.abort(); unregister?.(); };
			});
		}

		exports.name = 'dsh-account-pool';
		exports.inject = ['slots', 'locale'];
		exports.apply = apply;
		exports.SECTION_ID = SECTION_ID;
		exports.SECTION_ORDER = SECTION_ORDER;
		exports.PROVIDER_CARD_SLOT = PROVIDER_CARD_SLOT;
		exports.ENTRY_ID = ENTRY_ID;
		exports.ACTION_ROUTE = ACTION_ROUTE;
		exports.NS = NS;
		// Pure helpers, exported so the offline test can exercise the state
		// derivation without a renderer.
		exports.coolingOf = coolingOf;
		exports.statusOf = statusOf;
		exports.filterAccounts = filterAccounts;
		exports.localDateInput = localDateInput;
		exports.formatRemaining = formatRemaining;
		exports.compact = compact;
		exports.formatUsageDuration = formatUsageDuration;
		exports.formatUsageTps = formatUsageTps;
		exports.usageEffortDisplay = usageEffortDisplay;
		exports.WINDOWS = WINDOWS;

		module.exports = exports;
		return module.exports;
	},
});
