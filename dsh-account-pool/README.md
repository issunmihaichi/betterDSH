# DSH 账号池

将上游账号汇成 `pool` provider，并按 [sub2api](https://github.com/Wei-Shaw/sub2api) 账号管理的主要操作管理账号、分组、调度和冷却。

## 本机 API 出口（0.4.26 / runtime 0.4.49-local-tauri）

新增 **设置 → 账号池 → 设置 → 本机 API**。先生成独立 API Key，再启用监听并保存，默认 Base URL 为 `http://127.0.0.1:19389/v1`。只接受本机原生服务的 Bearer 鉴权调用，不开放局域网、不接受浏览器跨域请求；池内上游密钥不会返回给调用方。API Key 只在生成/轮换响应中显示一次，丢失后请轮换。

提供 `GET /v1/models`、`POST /v1/chat/completions` 和 **`POST /v1/responses`**（普通 JSON / 各自协议 SSE），沿用同一账号池的调度、分组、冷却、重试和用量记录。Responses 支持文本/内联图片、function工具及完整历史重放；使用同一 Base URL 和既有 Key，无需重新生成。它是无状态兼容子集：`store:false`，不支持 `previous_response_id` 续接、非空 encrypted include、后台任务、内置工具及结构化输出；不假称完全兼容 Codex CLI。Embeddings、远程图片 URL 和部分请求选项仍不支持。完整示例和限制见 [本机 API 接入文档](<LOCAL-API.md>)。

本次修复 Project Graph/Tauri 原生 HTTP 请求自动带 Origin 时被误拦截的403。只允许三个标准 Tauri Origin，仍要求精确 `127.0.0.1:<port>` Host、回环来源与 Bearer Key；不开放通用浏览器 CORS。既有 Responses、per-preset compaction 等功能保留，**未合入尚未部署的 Gemini CPA 分支**。生效后用管理接口的 `runtimeRevision: 0.4.49-local-tauri` 与 `localApiProtocols` 中的 responses 核验；客户端是已构建 bundle，需刷新当前 GUI，不依赖开发服务器。当前 Host 无热重载时需重启 DSH，不能把安装文件当成新协议已上线。升级保留原 Key、端口、启用状态及账号/分组；不自动启用、轮换或发真实上游请求。

以下保留历史功能和版本记录，其中“尚未部署”等描述对应当时版本，不代表本次部署验收结果。

## 使用入口与生效

打开 **设置 → 账号池**。本机 desktop profile 通过本地发行包安装，开发源码与实际运行包分离。页面顶部展示账号、请求、分组与粘性绑定概览，下方通过「账号管理 / 分组管理 / 请求用量」切换。OpenAI / Claude / Gemini 的 OAuth 账号在当前可见页自动读取上游用量，最多同时查询 2 个账号，默认缓存 60 秒；账号行显示额度进度，可点击「查看用量」展开详情，或点击「刷新用量」手动刷新。账号行保留编辑与测试入口，其余操作在「更多」菜单；有效期可展开查看。切换页面保留未提交的编辑内容，窄屏下账号表格变为卡片布局。

客户端是手写的最终 bundle，布局与样式修改刷新页面即可加载。当前 GUI 的插件发布接口已确认客户端内容与本地文件一致。

发行源码保留 Codex 图片输入、分组模型管理、上游模型获取、原生能力配置和 OpenAI Responses / WebSocket 功能。当前包版本为 **0.4.26**，后端入口为 [本机 API 快照](lib/runtime-v0.4.49-local-tauri/host.js)：以 runtime 0.4.43 批量归因快照为基线，新增 per-preset 压缩、本机 Chat Completions / Responses 出口与 Tauri 原生请求 Origin 修复，保留可选插件隔离、用量重置、计时、思考档位记录、Codex 连续性、Fast / Ultrafast、v2 加密压缩与批量归因。**本次更新发行源码与离线测试；没有安装、重启或改动 live profile，不以源码准备代替部署授权。** 独立 ESM 路径避免旧模块身份复用，但包名解析仍可能缓存，因此未来部署后应完整重启 DSH 并核验管理 API 的 `runtimeRevision: 0.4.49-local-tauri`。原有缓存、用量、重置卡和请求重试均包含在新快照中；后续源模块变更必须生成新快照，不改写已发布目录。普通页面刷新不能更新 Host。

### Codex v2 加密压缩上下文（开发源码，尚未部署）

新增独立入口 **设置 → Codex兼容 → v2 加密压缩上下文**，默认关闭。只有账号池接入了兼容的 BasicCompactionEngine 和 LLM 适配器边界后才允许开启；设置保存到账号池持久化 singleton，不改账号、传输方式、模型或其它插件配置。读取/保存设置不发送模型请求。**该功能已保留在新的 runtime 0.4.43 批量归因快照中，但本次未安装、不重启当前 GUI。** 后续部署 Host 仍需单独授权；客户端也需在原 GUI 刷新验收，不能把源码编辑或快照生成视为已上线。

启用后，仅由 Codex OAuth 账号承接的账号池模型，在既有自动/手动压缩时机使用普通 Responses 流：广告 `x-codex-beta-features: remote_compaction_v2`，历史末尾追加 `compaction_trigger`，不改用 `/responses/compact`，不发送文字摘要指令。HTTP 和 WebSocket 都支持；若另行配置了不同的摘要模型/路由，继续用原文字摘要，不用不可跨范围的密文假装完成压缩。上游必须成功完成且恰好返回一条 `compaction`，其它输出不作为摘要或工具调用公开执行。中断、取消、多个结果或密钥故障不落地加密 checkpoint；未取消的原生压缩失败回退现有文字摘要器，可能增加一次模型调用的用量。

原生压缩保留用户输入在 compaction item 前显式重放，助手/工具历史由密文承接。用户输入（含当次已解析的图片/文件 handle）与上游密文一并用已有独立 AES-256-GCM replay key 封装，作为 checkpoint 文本块的 `codexCompaction` sidecar，经原 Basic 引擎的压缩记录、surface replacement 和现有 JSONL 保存。公开 checkpoint 文字只是标记，不把它当真实摘要发给模型；token、上游密文和 response ID 不直接写入公开块。单条封装仍限 4 MiB，单次加密状态总回放预算为 16 MiB；用户输入超出封装限额时回退文字摘要，不自行截掉指令。不宣称复制了原生 Codex 的全部用户消息截断/图片预算策略。

同账号主体、workspace、endpoint、模型及会话范围一致时可在冷重启后继续用密文；同主体的 JWT 刷新不破坏持久化状态。换账号/模型/endpoint、fork、关闭设置或密钥不可用时，按 checkpoint 的原始引用，从**当前会话自己的权威日志**恢复对应历史，并递归展开此前的压缩记录，不跨主体搬运密文、不重复拼回助手历史。恢复出的文件通过当前 `llm.fileRequestText`，图片通过原有附件预览路径。外部模型恢复保留已准备调用固定的适配器/dispatch，不重新选路。历史被编辑、引用丢失、仅导出表面 checkpoint 或状态无法验证时明确拒绝，不静默丢掉背景继续回答；恢复原文可能重新触及上下文上限，需要普通压缩或更大的窗口。

专项离线入口：`node tools/test.mjs codex-compaction`；[协议与恢复测试](tools/codex-compaction-test.mjs)、[设置持久化测试](tools/codex-compaction-host-test.mjs)及[安装版 Basic/JSONL 冷恢复集成](tools/actual-codex-compaction-test.mjs)。安装版集成通过 `ELECTRON_RUN_AS_NODE=1` 使用现有 Electron 的 ASAR loader，以 synthetic 独立会话和 mock HTTP 检查真实引擎、重复压缩、冷恢复、文件投影及 prepared dispatch；不读取 live 凭据/会话，不调用真实供应商。服务端兼容性仍需另行授权真实账号验证，离线通过不等同于已上线或计费/任务质量保证。

### Codex Fast / Ultrafast（0.4.18 / runtime 0.4.41-codex-speed）

在输入栏模型/推理弹窗的「速度」区域选择 **Standard / Fast**；只有具体账号与模型的官方目录明确广告 `ultrafast` 时才增加 **Ultrafast**。不凭 PRO 标签猜测权限，不常驻显示套餐限制。输入栏模型左侧的闪电只读：灰色为 Standard，亮色单闪电为 Fast，双闪电为 Ultrafast；权限失效时双闪电变灰并提供悬停说明，仍可退回 Standard。图标表示已保存的速度偏好，不是延迟或实际计费档位测量。

选择按会话 + provider + 模型持久化，保存成功才更新显示。Fast 向 Codex OAuth 发送 `service_tier: priority`，Ultrafast 发送 `service_tier: ultrafast`；Standard 不发送该字段。加速模式只路由到相应 Codex OAuth 账号，Ultrafast 还必须具备当前身份/模型的目录证据；不会把字段发给 API-key、Claude 或 Gemini，也不静默降级。若权限不可用，切回 Standard 或刷新能力。切换速度会重置 WebSocket 的增量请求基线，完整上下文重新发送。

接口为认证 `accountPool.codexSpeed` GET/POST，能力目录读取只调用官方 `/models`、不发模型生成请求、不将令牌/原始错误送到前端。思考插件的弹窗扩展由本次可重放客户端补丁提供；后端包与客户端都需更新。Host 更新后完整重启 DSH，再刷新现有 GUI。离线测试：`node tools/test.mjs codex-speed`。

### 最近用量：首字 / 输出时长 / TPS

在 **设置 → 账号池 → 请求用量** 的每条记录中，Token 列后新增三项性能指标：

- **首字**：从请求开始到首个非空文字、思考或工具参数输出，包含重试、检测重试与换号等待，不把空事件或用量事件当成首字。
- **输出时长**：从首个有效输出到上游流结束（或错误/取消）的耗时，不包含首字等待，也不包含结束后的持久化时间。
- **TPS**：上游实际报告的输出 Token ÷ 输出秒数，按上游口径包含思考 Token。没有真实 Token 计数、输出时长为零或无法可靠计时时显示 `—`，不按文字长度估算。

短延迟显示毫秒，较长时间显示秒；窄屏可横向滚动查看完整表格。历史记录没有采集过计时数据，三项显示 `—`，不会补造数据。异常中断但已产生输出时保留可测得的首字与输出时长，Token 不完整时不估算 TPS。计时覆盖普通调用、账号测试与定向探针，测量不会改变重试、调度或上游请求。管理 API 以 `usageTimingVersion: 1` 声明支持，记录字段为 `firstTokenMs`、`outputDurationMs`、`outputTps`；异步迭代器结束前的消费背压仍包含在观测耗时中。

离线测试：`node tools/test.mjs timing`（synthetic upstream/clock，不访问供应商），另有 `node tools/host-test.mjs` 的持久化/API 回归。客户端刷新即可加载新列；Host 更新后重启 DSH，新的请求才会采集计时。

### 独立 Auto Review 判断模型

打开 **设置 → 账号池 → Auto Review**，选择「跟随当前会话模型」或「使用指定账号池模型」，再选择账号池 / 分组与模型并保存。默认跟随会话；保存通过审核增强插件的官方 settings 持久化，从下一次风险判断生效，不改变聊天模型、账号配置或审批策略。

此页依赖 `dsh-codex-review-attribution` 提供的 `autoReview.model` v1 认证接口。插件未启用/版本不兼容时显示不可用，账号管理仍可使用。只列出已注册可调用的账号池模型；已移除的指定模型会报错，不静默回退。读取目录/保存选择不发模型请求。`never` 等策略不因模型选择被改成自动审批；只有既有审批流程调用 Auto Review 时才使用该设置。

### 归因完成后的可选调度暂停（0.4.17 / runtime 0.4.26）

`accountPoolModelProbe` v1 新增可选能力 `pauseSchedulingVersion: 1`，prepared handle 提供 `await pauseScheduling()`，成功返回 `{ alreadyPaused: boolean }`。调用前重新核对准备时的精确连接 key，并检查插件生命周期；连接已更改、账号已删除或插件已卸载时拒绝操作。只将当前账号的 `schedulable` 改为 `false`，健康、冷却、分组、优先级、标签、用量及时间戳均原样保留；不恢复已删账号、不自动恢复调度。

调度暂停通过既有 operation-write ledger / flush 等待持久化。并发 prepared handles 共享同一次写入；已暂停账号不重复写入；写入失败返回 `persist-failed` 而不是误报成功，清理故障后重试会补写存储。归因策略和设置由 detector 插件拥有，账号池不根据分数自行判断型号。当前版本只完成离线测试和发行源码更新，未替换或重载 live 插件。

### 归因暂停 UI 合并（0.4.19 / runtime 0.4.42-attribution-merge）

在确认三次归因采样时，仅当 detector 元数据 `autoPauseOnMismatch: true` 才显示自动暂停说明：需三条有效采样、其它参考模型的库内概率至少 90%；这是行为比较，不是型号认证，策略仍由 detector 拥有。确认绑定当前策略，读取失败、插件卸载或策略变化会撤销旧确认，不能用旧回调发起测试。

账号状态旁按 `job.schedulingAction.state` 区分「已自动暂停」「原本已暂停」「暂停失败」与「能力不可用」；前两项为 `status`，后两项为 `alert`。不根据预测标签自行推断暂停。终态 `paused` / `already-paused` / `pause-error` 每个任务只触发一次账号列表读取（失败时内存可能已变化），后续相同结果轮询不产生刷新循环；读取/渲染不发送调度写入或模型请求。

[客户端行为测试](tools/client-test.mjs)覆盖确认开关、旧策略回调失效、七种动作状态、语义角色、一次性账号状态刷新、运行中不刷新、重复轮询与异常能力撤销。Host 既有精确连接/生命周期/持久化测试保留；此次源模块审计确认最新 runtime 0.4.41 的全部后端功能按字节保留，只有 Host 修订号更新为 0.4.42。新 [快照清单](lib/runtime-v0.4.42-attribution-merge/snapshot.json)与普通源模块一致，未重写旧快照。

### 所选账号批量模型归因（0.4.20 / runtime 0.4.43-batch-attribution，尚未部署）

在 **设置 → 账号池 → 账号管理** 勾选账号后，选择条新增 **批量模型归因**。此入口仅在可选 detector 明确提供 `batchVersion: 1`、`batchLimit: 100` 且已启用时出现；旧版本或缺失插件不出现批量入口，原账号管理与单账号归因能力保持独立。每批最多 100 个账号，所有所选账号均须就绪；不会静默忽略未就绪账号，也不提供并发配置。

首次点击只展示确认，不发送模型请求。确认列出捕获时的全部账号与测试模型，明确说明 **N 个账号、每个账号 3 次、最多 3×N 次模型调用**，逐账号顺序执行、每次输出 token 预算与超时及可能收费的限制（Codex OAuth 当前不发送此 token 上限，不构成最大账单保证）。仅当 detector 的 `autoPauseOnMismatch` 明确为 `true` 时追加自动暂停政策说明；若同时明确 `pauseAvailable: false`，额外提示旧账号池能力不可自动暂停，归因仍可执行。确认绑定选择、目标 key、预算、超时、政策与暂停能力；选择或配置变更、读取失败、插件卸载或最新元数据变忙会撤销旧确认。提交前再次检查权威元数据，不替换已确认的账号或型号。

提交只调用 `pool-batch-start`，发送捕获的 `{ targets: [{ accountId, expectedKey }] }`。现有只读 pool 轮询提供 batch 进度和正常单账号 job；进度面板显示排队、执行、完成、跳过、出错或取消，以及每个账号的行为参考匹配和调度暂停结果。清除选择不会收起正在执行的批次。**取消批量归因** 使用独立的 `pool-batch-cancel` 与 batch ID，不调用单任务取消；运行中和取消清理未结束时禁用单账号开始及其它账号批量操作。自动暂停结果仍每个任务只读取一次账号状态，不由 UI 推断身份或发送调度写入。

同步单飞锁防止快速重复提交；失败、超时或响应形状不兼容只显示错误并读取状态协调，不自动重放可能收费的请求。刷新/打开页面、轮询和取消都不是重新提交批次。批次状态由 detector 的当前 Host 管理，完整页面刷新通过公开元数据重新发现；这里不声明客户端可以回滚已发生的模型费用。

[客户端离线行为测试](tools/client-test.mjs)使用 synthetic 目标、deferred 响应与语义树，覆盖选择/费用确认、变化后的旧回调、100 账号上限、未就绪选择、双提交排除、旧可选 backend 与未知字段、malformed batch、错误协调、独立取消、取消清理、逐账号结果和终态暂停的一次性账号刷新。未安装、部署或运行付费模型探测；Host 及 Client 的真实 GUI 生效验收仍需后续授权。

### 可选插件独立性（0.4.16 / runtime 0.4.26）

账号池不要求模型归因或自动审查归因插件安装/启用。模型归因 API 缺失、404/503、非 JSON、版本/数据形状不兼容时，撤销归因能力及旧确认，账号管理/调度仍正常；缺失能力每 30 秒只读重新探测，晚加载可恢复（也可手动刷新）。元数据读取不调用模型。旧按钮回调在能力撤销后不能启动探针。

可选审查桥随子生命周期连接/断开；诊断方法缺失、抛错或返回坏数据时仅将桥标记为不可用/不兼容，不让账号列表或状态转储失败。未安装审查增强不影响普通账号调用，也不会跳过官方审核规则。详见 [独立性契约与测试边界](../docs/PLUGIN-INDEPENDENCE.md)。本轮仅更新发行源码，未部署当前运行实例。

### Codex OAuth WebSocket 续接（0.4.15 / runtime 0.4.24）

在 **设置 → 账号池 → 编辑 OpenAI OAuth 账号 → 传输方式** 选择 WebSocket。仅当管理 API 声明 `codexWebSocketVersion: 1` 时显示；已有账号默认 HTTP 不变，保存其它字段不会重置已选择的 WebSocket。Codex 始终使用官方 `/backend-api/codex/responses` 方言，不需要选择 API-key 的 Responses 格式。通用 API-key WebSocket 仍保留原独立实现。

按 Codex 0.160.1 使用 `response.create` 与 `responses_websockets=2026-02-06`。普通会话成功完成后复用连接；仅当前完整输入严格包含上一请求和经校验的原生输出、且模型/指令/工具/思考参数不变时，发送 `previous_response_id` 与新增输入。每次消息仍带当前 turn 的 `client_metadata`。通过原有加密 replay 验证输出顺序和内容，未知输出、缺少 replay、编辑/压缩后的历史走完整请求，不猜测差异、不恢复已删历史。

连接状态只在当前 Host 内存中，按会话隔离并对同会话请求串行处理。换账号、token 刷新、workspace、模型或 endpoint 会使旧连接/response id 失效；标题、压缩、审查、探测及缺少 session 的请求不继承普通会话连接。重启后使用完整输入重建，原持久化 encrypted reasoning 继续有效。连接/缓存数量、等待和缓冲有上限，空闲及卸载关闭连接，不保存 token、response id 或请求正文到管理诊断。

`previous_response_not_found` 或连接寿命到期时，仅在尚未输出的情况下重建连接并重发一次完整请求。连接/协议不兼容在尚未输出时可退回 HTTP，同一驻留会话后续沿用回退；401/403/429 与语义请求错误保留给原账号池策略，不被 HTTP 回退掩盖。已输出、取消或中断后不自动重放，避免重复正文和工具调用。管理 API 的 `codexWebSocket` 只返回脱敏计数，可用于检查实际连接复用、增量和回退；这不是计费统计。

离线测试入口：`node tools/test.mjs codex-ws`（模拟与本机测试服务器，无供应商调用）。完整回归另含 Codex 加密续传、API-key Responses、Host 与客户端表单；真实账号验证需单独同意少量额度消耗。此功能对齐传输续接，不等同于复制原生 Codex 的提示词、工具、压缩策略或任务质量。

### 账号定向模型归因（0.4.14 / runtime 0.4.23）

账号状态标签下新增「模型归因测试」，由已启用的 `dsh-lm-detector` 0.1.1 提供能力与集中配置。在 **设置 → 模型归因** 控制入口开关、每个平台的测试模型、思考强度、输出 token 预算及超时。读取页面/状态不发模型请求；每次须点测试并确认费用提示，才执行三条独立行为指纹探针。结果显示参考接近模型和 Top 5，不当作真实型号证明。

Host 仅向本机可选插件提供 `accountPoolModelProbe` v1：`targets()` 返回无凭据/URL的目标摘要，`prepare(id, {model, reasoningEffort, maxTokens})` 捕获账号连接与准确模型，返回 `selection` / `target` / `stream(prompt, signal)`。定向探针绕过暂停/禁用调度但仍占并发槽；没有账号池重试、检测重试、粘性绑定或换号。失败不会改账号健康或冷却状态，实际用量仍记录。账号删除或连接配置变更、插件卸载或显式取消时安全中止；不恢复已删除账号。

界面只发送账号 ID 与确认时的目标/设置摘要 key，不能提交提示词、密钥或任意上游地址。模型允许列表和单账号思考档位在 Host 校验，配置的型号不被静默替换。不配置平台型号时才选择账号允许列表中的第一个模型；列表也为空会要求设置型号。内置参考库将 `gpt-6-astra/6.1-sol` 合并，不能借此区分两个型号；更新后的参考库按其实际标签比较，不将独立 `gpt-6.1-sol` 强行合并。测试与部署验证均使用 synthetic 目标，没有主动消耗真实账号额度。

### Codex 长任务连续性（0.4.12 / runtime 0.4.21）

移除进程内、1 小时 / 512 条限制的工具推理缓存。仅在 Codex 上游明确成功完成时，把原生输出顺序计划保存到 DSH `finish.replayState`；原生 Agent 将它随 `assistant/message.source` 写入现有会话 JSONL，所以纯文本、工具调用前后和尾部推理都能经同会话重启恢复。保留 reasoning / message / function_call 的相对顺序及 message phase；相同推理密文的不同出现次数不再全局去重。文本和工具参数仍以可见会话内容为准，仅保存摘要校验和引用，不存重复正文。

`replayState` 会经浏览器/API/导出传递，**不是私密服务端通道**。因此上游推理密文再由本地 AES-256-GCM 封装，独立 32 字节密钥按需存于已有 credentials 服务的 `DSH_ACCOUNT_POOL_CODEX_REPLAY_KEY_V1`，不从 OAuth token 派生。密钥须随本机凭据一起备份；删除/换掉密钥会让旧封装只能安全退回中性历史，不会自动重建可解密的旧状态。密钥无效、无法保存或回读不一致时不覆盖它，日志只给固定脱敏警告；管理 API 的 `codexContinuity.keyState` 为 `not-loaded` / `ready` / `unavailable`。

回放隔离绑定账号行及创建代、credentialRef、access JWT 的 issuer/subject、凭据权威 workspace 与实际选中 workspace、规范 endpoint、准确 model 和 session。**同主体同 workspace 的普通 JWT 刷新保持续传**；不把 JWT 解码当验签/授权。Opaque bearer 缺少稳定主体时仍绑定 token 指纹，即使有可能过期的 id_token 也不跨 token 猜身份。换号、换模型、普通 fork、新 session、标题/压缩/探测/审查和其他专用用途不会误用旧推理；可见内容被编辑、删块、摘要不匹配、密文被改、版本不兼容时整条消息退回原中性历史。失败、流截断、incomplete 或中途取消不产出成功续传状态。

每条封装最多 4 MiB 明文；每次请求最多回放 16 MiB 隐含推理，优先最近的完整消息，超限旧消息仍保留可见正文，不截断密文、不从已经压缩删除的旧消息重新拼接内容。Codex OAuth 的粘性绑定改为 **7 天空闲窗口**，成功命中也续期，并使用既有绑定表持久化；显式非粘性分组策略、不可用/冷却/容量及切号规则照常有效，不宣称永不切号。

离线回归覆盖真实安装版 DSH 的 prepared dispatch、BlockAssembler、Agent settlement 形状、JSONL flush 与新服务冷恢复，含纯文本、工具链、token 刷新、分叉拒绝、原生顺序、超过 512 次工具/多轮历史、预算、篡改、密钥故障及跨账号 failover。协议专项见 [连续性回归](tools/codex-continuity-test.mjs)，真实存储集成见 [安装版恢复回归](tools/actual-codex-continuity-test.mjs)。均为 mock HTTP，不消耗账号额度。**升级前从未持久化的旧推理无法补回；这修复连续性风险，不代表已经达到 Codex 原生的全部能力或相同任务质量。**

### Codex 协议与用量归因（0.4.11 / runtime 0.4.20，后续版本保留）

按 [官方 Codex 0.160.1 元数据格式](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/core/src/responses_metadata.rs)发送 `client_metadata` 字符串映射与 `x-codex-turn-metadata` JSON 字符串，同时投射兼容请求头。主任务使用 `thread_source=user`，真实子代理使用 `subagent`、`subagent_kind=thread_spawn` 和 `x-openai-subagent=collab_spawn`；标题采用[官方 `thread_title`](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/tui/src/app/thread_title.rs#L103-L113)；压缩使用 `request_kind=compaction`，保持所属线程来源，不伪造 Codex 压缩策略。

会话来源来自 DSH `sessions.get().header`，以 `origin=subagent` 区分子代理与普通 fork。子线程独立，父/root 关联按真实父链派生；不会合并所有线程。`sessionProjections.stateOf(session, 'turnBoundary')` 在当前真实 turn 内提供稳定标识，工具采样与 OAuth 刷新不改变它；无 projection 时生成请求级 fallback，同请求重试、检测重试和切号复用冻结快照。所有 Codex 请求都有最小脱敏 metadata；无会话调用仅使用请求级临时身份，不增加持久缓存键。来源未知省略 `thread_source`，不冒充主任务。标题线程独立，清除协作父链。

新增官方 `session-id` / `thread-id` 请求头。普通主任务沿用原缓存身份；非根请求的 canonical session 指向真实 root，thread 指向自身。原 `prompt_cache_key` 与旧 `session_id` 头保留，所以子线程的旧缓存键和 canonical root session 可不同；这不是身份不一致，不应强行合并。新增官方头可能影响服务端亲和行为，实际缓存命中仍需观察；`store:false` 不变，不发送原始本地会话 ID。

官方自动审查 producer 本身不传 session 或用途。可选 [自动审查归因入口](../dsh-codex-review-attribution/README.md) 精确复用原审核 Gate，通过本地版本化 `codexRequestProvenance` 传递 owner/request 身份，既不猜 prompt/model，也不提前填通用 `sessionId` 改变账号选路。仅已选中的 Codex OAuth 上游消费该扩展：使用 `guardian_review` / `guardian` 用途标记、独立审查 thread/turn 和真实 owner 父关系，不使用持久 prompt cache；不宣称 DSH 是官方 Guardian 执行环境，不发送专用 Guardian 路由/credits/history 字段。入口缺失、不兼容或来源无法确定时保持未分类的合法协议身份，审核规则不变。

账号管理 API 返回 `codexAttributionVersion: 2` 及协议/来源能力，`reviewBridge` 表示可选入口实际开启，不代表已观察到官网分类。不会伪造 analytics、sandbox、turn trigger 或压缩实现遥测，也不制造 prewarm 请求。这修复客户端信息缺口，**不保证官网服务端立即按预期归类，也不能追溯修正历史 Unknown**。应观察新产生的用量；刷新周期和最终类别由 OpenAI 决定。回归均用模拟 HTTP，不消耗真实账号额度。

### Codex 出站归因诊断（0.4.13 / runtime 0.4.22）

保留已有、与原生协议核对过的用途字段，不根据提示词或模型名猜类别。新增管理 API `codexAttributionDispatch`：`bySource` 为 `user` / `subagent` / `thread_title` / `guardian_review` / `unknown`，`byRequestKind` 为 `turn` / `compaction`；`missingSourceReasons` 区分缺少 session ID、session 服务不可用、session 未找到及其他来源缺失。统计读取实际构造的 canonical metadata，仅在 Codex OAuth 即将派发 HTTP fetch 或 WebSocket 尝试时增加，不改请求体、请求头、缓存、账号选路或审核行为。

计数是**本次 Host 挂载以来的派发尝试数**，同请求重试/切号会分别计数，失败的 fetch 也算尝试；不是成功请求数、token 数、账单或官网归因结果。发送前取消、无凭据及本地请求校验失败不计数。重新挂载/完整重启清零；自定义 upstream 不经过此观测点，`enabled:false`，不得把零理解为没有用量。仅使用固定类别与时间，不持久化请求正文、原始会话/账号标识或凭据。每种未知原因每次挂载最多报警一次；报警/诊断失败不阻止模型调用。

可在现有 GUI 的浏览器开发者控制台中只读取脱敏字段（当前登录态，未登录会返回鉴权失败）：

```js
fetch('/api/accountPool.accounts').then(r => {
  if (!r.ok) throw new Error(`Local API HTTP ${r.status}`);
  return r.json();
}).then(s => console.log({ runtimeRevision: s.runtimeRevision, attribution: s.codexAttributionDispatch }));
```

正常使用产生新请求后，若 `unknown` 增加，先按缺失原因追查生产者，不伪装成 Tasks 或 Auto review；若 `unknown` 不增加而官网仍显示 Unknown，需要核对同一时间范围/账号和服务端分类，不能据此断言客户端漏字段。历史用量不能本地重写，`officialAnalyticsVerified:false` 保留。离线测试额外比较新旧运行版各类 synthetic 请求的**完整请求体与请求头逐字节一致**。

### Codex 图片输入

OpenAI OAuth（ChatGPT/Codex）账号支持用户消息中的 PNG、JPEG、WebP 和 GIF 图片。聊天上传或粘贴的图片通过 DSH `attachments.readImageRequest` 读取请求预览，再转换为 Responses `input_image` 数据 URL；多张图片与前后文字的顺序不变，图片也可以单独发送。读取尊重取消信号，同一请求中重复的附件只读取一次，预览目标不超过 4,194,304 像素 / 1 MiB。已标记为 offloaded 的历史图片保留文字占位，不重新读取。

仅由 Codex OAuth 账号承接的模型路由默认声明 `text + image`，无需手动开启；显式 `input: [text]` 覆盖仍受尊重。混入其他尚未实现图片传输的账号时，使用专门的 Codex 分组，避免整池自动退为仅文本。此功能不代表 Anthropic、Gemini 或 API-key Responses 已支持图片，也不支持 assistant/system/developer/tool 消息中的图片、PDF 或其他文件输入。

离线回归覆盖图文顺序、多图、仅图片、附件解析、取消、工具历史和 Host 服务接线；安装版 DSH 的实际 prepared-call 测试使用模拟 HTTP，未消耗真实账号额度。

插件的 `accounts` 配置仅初始化不存在的账号。已有账号以管理页保存的数据为准，重启保留优先级、分组、调度状态、有效期和凭据；修改配置中的同 ID 账号不再自动覆盖管理数据。需要更新已有账号时使用管理页。

OAuth 登录自动或手动完成后显示简洁的成功确认页，提供 **完成并返回** 和 **继续添加账号**，隐藏已失效的授权链接、回调输入与取消操作。完成按钮只返回账号列表，不会重复兑换授权码或撤销账号。本地回调先完整发送成功页面，再释放监听端口，避免账号已保存但浏览器因连接提前关闭而报错；成功后停止轮询，旧响应不会覆盖下一次登录。

## 分组模型与上游目录

用户创建的分组会显示在 **设置 → 模型**，使用与原生提供商一致的单行条目；默认整池不另建“号池”条目。点击分组的 **编辑 → 从上游获取模型**，使用该分组账号已保存的 API Key 读取 Anthropic、OpenAI 兼容或 Gemini 模型目录，合并去重后可搜索、勾选、全选并保存。账号池页的分组编辑器也提供同一入口。

获取成功会刷新对应账号的模型目录并保留原有模型；分组白名单需点击 **保存** 才生效。获取失败的账号保留原配置，页面逐项显示原因，手动输入始终可用。OAuth 订阅账号当前不支持通过此入口读取模型目录，需手动填写模型 ID；没有账号的分组应先加入账号。获取过程只读取模型目录，不发送聊天请求。

## 原生能力配置

账号池的模型能力覆盖保存在本插件原生 `Config.providers[provider].modelOverrides[model]` 中，通过 DSH 的 `configForms` 队列或 `settings.mutate` 按字段保存。字段包括 `contextWindow`、`input`、`reasoningEfforts` 和可选显示名；模型归属、分组白名单和调度仍取决于账号池本身。恢复默认只删除对应覆盖字段。desktop profile 插入条目的 `name` 使用规范 `file:///<path>/host.js`，与 Loader 当前条目一致；这样原生 `configEditor` 添加同 ID 的配置补丁时能够匹配条目，避免被误判为其他覆盖层阻止写入。

“模型能力与档位”插件通过原生 `llm.listConfigurableProviders()` 与 `session.modelCatalog()` 同步实际分组，不再仅限于 `llm-pi-ai` 的静态配置。能力修改后发布原生目录失效事件，模型选择器及档位页面重新读取。上下文窗口与思考档位由账号池 adapter 的 `resolveModel` / `prepareCall` 解析生效；输入格式与档位映射仍受实际账号传输支持限制。

档位编辑页使用带 `expectedRevision` 的原生 `settings.mutate`，不再依赖只返回 boolean、丢失具体错误的 `configForms.mutate` 分支。版本冲突会重新读取后仅重试一次，普通拒绝原样显示原因。对当前目录提供 `xhigh` 而不提供 `max` 的号池模型，新增 Max 档默认线上值为 `xhigh`；Max 是界面别名，不是额外高于 Xhigh 的推理等级，手工已有映射不会被静默修改。当前已在实际 GUI 保存并验证 `pool-plus / gpt-6.1-sol` 的 `max: xhigh`，既有上下文与图片设置保留。

## 0.4.18 管理账号测试重试

修复管理页「测试」绕过普通请求重试的问题。测试和正常聊天现在都对尚未输出的临时网络错误、5xx 使用 `requestRetries`（默认 3 次，首次加重试共 4 次）；测试仍固定在指定账号，不切换账号。重试期间不写冷却，耗尽后仅应用一次失败状态。诊断原本 disabled/error 的账号仍允许，等待期间删除或修改调度状态会停止重试；总测试超时涵盖退避等待并释放并发槽。401/403、请求类 4xx、已输出后的失败仍不盲目重放。

定向离线验证包含管理测试成功恢复、耗尽后一次冷却、认证错误不重试、部分输出不重放、超时取消、删除不复活、调度编辑和 disabled 诊断。请求重试 11 项、池检测 36 项、Host 100 项均通过；没有额外调用真实上游测试账号。

## 前端结构与首屏状态

`lib/client.js` 仍是手写的单一最终 bundle，没有构建步骤；这一轮只在文件内部划了边界，没有拆成多个文件。文件按编号分区：常量、字典、样式表、hooks、纯函数、原语、额度视图、行组件、表单、OAuth 面板、页面外壳、面板、`PoolSection`、供应商卡与注册。除 `PoolSection` 和测试显式挂载的几个表单面板外，其余组件都是无 hook 的纯函数（props 进、元素出）；有状态的逻辑集中在几个自定义 hook 里，只在 `PoolSection` 的 render 中按固定顺序调用。按位保持的行为包括两段式批量删除、重置请求 id 账本、以及导入时未分组就不发 group。

首屏现在有三种状态视图。**加载中**给出一句「正在向 Host 请求账号、分组与用量数据」并显示转圈，不带重试按钮。**读取失败**（Host 没有返回账号数据）显示「无法读取账号池」、一句提示检查后端是否已重启、**原样保留** Host 返回的错误信息，并给出「重新读取」按钮，点击后重新请求。三种空态（分组、用量、账号列表）共用同一套图标加文案的呈现。首次读取与刷新分开处理：刷新失败保留上次成功数据和已挂载的表单草稿（包括未提交凭据），明确提示数据尚未更新、保留 Host 原始错误并提供重试；不会退回首屏而卸载编辑器。读取有 30 秒超时，换页卸载或重新读取会取消旧请求，晚到的响应不会覆盖新状态。

OAuth 提供商目录有独立的加载、读取失败与空目录状态；失败可在面板内单独重试，页面「刷新」也会重新读取目录。管理操作使用同步单飞锁，避免 React 尚未刷新按钮禁用状态时重复派发；页面卸载后不再消费旧操作的 UI 回调或触发刷新。这里不自动重放写操作，也不声称客户端可以撤销已由 Host 提交的请求。

账号编辑的「保存」可能包含账号主保存和多个组内优先级请求。当前编辑器只在收到主保存的明确成功响应后记录已保存的账号 ID 和阶段；后续优先级失败会保留草稿、显示「账号已保存」及原始失败原因。同草稿再点保存只继续未完成的优先级；修改主字段后则更新已经保存的 ID，不再次创建账号，已确认的新增 ID 不可更改。每次打开编辑器有独立 generation，旧请求完成不会关闭新编辑器或继续旧编辑器的剩余步骤。阶段记录只在该编辑器的内存里，关闭或刷新页面不会恢复它，**不是事务或回滚**；主保存结果不明确时不自动假定成功，应先刷新核对。

分组页与模型提供商卡共用命名删除确认：首次点击只显示目标分组名称以及「账号会保留」的影响说明，不发删除请求；再点「确认删除」才发送该分组 ID。可取消或按 Escape 解除确认，离开分组页、打开另一分组编辑器也会解除；提交期间不把取消按钮当成撤销已经发出的请求。

管理写操作的持久化失败返回 **HTTP 503**，错误码 `persist-failed`，且 `ok: false` / `persisted: false` / `runtimeMayHaveChanged: true`；不会再用成功响应掩盖写盘拒绝。页面保留错误供核对，操作级写入账本隔离无关的后台用量写入失败。**这不是事务回滚**：部分内存状态、凭据或此前步骤可能已改变，看到此错误应先刷新核对当前状态并排查存储，再决定是否重试；不要把整项操作重复派发当成必然安全。普通源码与当前发布的 runtime 快照同步此语义，仍需按后端重载规则载入后才影响正在运行的 DSH。

按源码可达性清掉了 17 个无人引用的字典键和 11 条孤儿 CSS 规则；重复词表逐条核过后全部是活的，未删。DSH 本身支持包内动态 chunk（`require.async("./client.<name>.js")`，官方用它配 `React.lazy`），但这个前端没有天然的异步边界，拆分会引入新的加载态、并让热重载退化为「只有入口热重载、改 chunk 必须完整重启 DSH」，收益与代价不成比例，因此决定不拆。完整结论见 DESIGN.md §28。

## 0.4.8 临时请求重试与断流

单个已选账号在尚未输出任何 chunk 时，可对临时网络错误和 5xx 重试 3 次，默认等待 1、2、4 秒，再沿用原账号切换和冷却机制。`requestRetries` 可设为 0–5，`requestRetryDelayMs` 和 `requestRetryMaxDelayMs` 控制退避。401/403 和请求类 4xx 不在同账号重试；429 有可用备用账号时立即切换，只有没有备用账号且上游明确给出不超过 30 秒的 Retry-After 时才原账号等待重试。账号专用的关键词检测重试仍单独受其开关和次数控制。

取消请求会停止等待并释放并发；等待中禁用或移出分组的账号不会继续请求。已输出后失败明确标为 `POOL_PARTIAL_RESPONSE`，不重复发送；Anthropic 缺少 `message_stop` 的提前 EOF 不再当正常完成。异常携带 DSH 可识别的错误快照，保留状态码及等待提示，避免统一变为 `UNKNOWN`。

本次只运行离线定向验证：请求重试 7 项、已有检测重试 6 项、HTTP 映射和切换 29 项，均通过。继续原前端重构是用户授权的真实会话请求；验证脚本没有额外调用真实上游探测账号。

## 0.4.7 Codex 缓存请求键

Codex 请求现在将非空会话 ID 与本地账号记录、ChatGPT 工作区和已解析上游地址一起派生为稳定 UUID，作为 `prompt_cache_key` 和 `session_id` 请求头发送，不直接发送原会话 ID。同一会话与账号在连续轮次、OAuth token 刷新后保持同一个键；切换会话、账号记录、工作区或上游地址时隔离，无会话 ID 时省略。这能改善缓存亲和性，实际命中仍取决于模型支持、相同提示前缀及缓存是否仍可用，首次或短请求仍可能为 0。`store:false` 保留；缓存读继续使用 `response.usage.input_tokens_details.cached_tokens`，上游未返回该字段时仍记为 0，不能据此区分未命中与统计缺失。定向验证只使用模拟 HTTP 与用量，未请求真实上游；当前 0.4.8 运行快照已包含并载入此后端改动。

## 0.4.6 Codex 请求身份兼容

Codex 请求的 `User-Agent` 与 `version` 从固定的 `0.146.0` 同步更新为 [官方稳定版 0.160.1](https://github.com/openai/codex/releases/tag/rust-v0.160.1)。本地参考的 `gpt-6.1-sol` 模型元数据标注最低客户端版本为 `0.153.0`，旧声明低于该版本；本次保持模型名和 Responses 入口不变。

直接录入的 OAuth 凭据包现在识别 `chatgpt_account_id`、`chatgptAccountId`、`account_id` 和 `accountId`，优先使用凭据包指定的工作区，再回退到 JWT。编辑页显式填写的 ChatGPT 账号 ID 仍拥有最高优先级，避免改变用户选择。

定向离线检查验证请求版本、原始模型名和工作区选择。这些检查没有请求真实上游，因此不证明客户端版本就是某次模型不支持 400 的根因；载入新后端后仍需用实际账号复测。模型元数据的 Lite 标记没有足够证据证明这次拒绝必须使用 Lite，本次未改变工具协议。

## 0.4.5 OAuth 用量与 Codex 重置卡

OAuth 账号的用量详情展示上游返回的额度窗口、剩余比例与重置时间；未返回的数据显示未知。Codex 账号另可查看重置卡可用数与到期时间。点击「使用重置卡」先确认，每次消费一张；实际重置哪些窗口以上游响应为准，不承诺同时重置 5 小时和每周额度。卡片读取失败、没有可用卡或仍使用旧后端时，消费入口禁用。

消费成功后刷新用量与卡片列表。只有后续额度查询成功、数据不是旧缓存，且上游明确返回 `rate_limit.allowed === true` 和 `rate_limit.limit_reached === false` 时，才从最新的同连接账号记录清除 429 限流冷却（`rateLimitResetAt`）。缺少这些明确字段或刷新失败时不清除；过载、传输与鉴权冷却，以及账号禁用和调度开关保持原样。

若断网或请求中断导致消费结果不确定，保留原请求 UUID，重新查询并恢复同一请求，避免生成新 UUID 再消费一张。当前浏览器会话的 `sessionStorage` 仅保存连接 key 与请求 UUID，不保存凭据。账号连接变化后不复用旧连接的请求。后端的结果缓存与未确认请求记录保存在当前进程；若 DSH 在未确认时重启，且卡数已为零，安全预检会拒绝继续消费，此时需要从上游确认先前结果。

重置卡接入依据本地 sub2api 与 new-api 参考实现，以下路径用于插件访问对应上游；这不代表已验证的公开官方 API：

| 接口 | 用途 |
|---|---|
| `GET /backend-api/wham/rate-limit-reset-credits` | 读取重置卡可用数与到期信息 |
| `POST /backend-api/wham/rate-limit-reset-credits/consume` | 使用 `{redeem_request_id}` 传入请求 UUID，消费一张重置卡 |

本地定向验证使用模拟上游，不代表已用真实账号兑换或消费重置卡。

## 0.4.4 sub2api / CPA 导入兼容

在账号池点击 **导入**，粘贴 JSON；支持 sub2api 管理员备份的 `{data:{accounts:[…]}}`、`{accounts:[…]}`、账号数组或单个账号，以及 CPA 单个 auth JSON 或 auth 数组。目前入口接收 JSON 文本，没有 ZIP 或整个目录上传。

sub2api 导入保留凭据包、认证类型、优先级、并发、有效期，以及 `credentials.base_url` 的自定义上游地址。CPA Codex / Claude 使用顶层 `access_token`；CPA Gemini 的 `{type:"gemini", token:{access_token, refresh_token, expiry}, project_id}` 会规范为可供现有传输读取的 OAuth 凭据，保留项目 ID、刷新令牌和有效期。导入时可选择目标分组；原系统的代理与分组配置不随账号自动迁移。

已用模拟数据验证管理接口导入、凭据保存、Codex / Claude / Gemini 请求身份及账号元数据重新加载。Antigravity 记录目前映射为 Gemini 账号，原生 Antigravity 调用没有验证。没有使用真实账号文件或凭据；此后端修复需要重启 DSH 载入。

## 0.4.3 账号池检测重试

账号编辑新增 **池检测重试**。默认关闭；开启后，用关键词识别临时检测错误，优先于 HTTP 状态的冷却规则。默认关键词为 `号池检测`、`池检测`、`号池不可用`，可以按实际上游提示修改。采用文本包含匹配，不把普通 403、429 或全部“不可用”错误自动当成检测。

默认对同一账号额外重试 2 次，间隔 1000 毫秒；可设置 0–5 次、100–10000 毫秒。命中检测时不增加失败计数、不写冷却、不删除已有粘性绑定；到达上限时返回明确错误，不无限重试。已经输出部分内容后不会重试，以免重复回复；用户取消会中断等待。账号测试也遵守此设置。

需要重启 DSH 载入新后端，再在 **设置 → 账号池 → 编辑账号** 勾选并保存。旧后端会显示重启提示，不发送不支持的新字段。开启设置不会自动清除已经存在的限流或鉴权冷却；需要时使用管理页已有的「清冷却」。设置随账号持久化，并包含在无凭据配置导出和恢复中。

匹配覆盖所有协议的 HTTP 错误响应，以及 Anthropic / OpenAI Chat 的 SSE 错误提示。Codex / Gemini 原生 SSE 映射器目前可能隐藏原始错误文字，因此这类流内提示不保证可按关键词识别。验证覆盖检测成功与耗尽、普通限流、取消、部分输出、并发、管理页保存后立即测试，以及真实 DSH 的准备调用路径；均使用模拟上游。

## 0.4.2 全部模型与分组目录

账号模型清单留空表示该账号允许调用全部模型；分组模型清单用于维护菜单中的具体模型名称。总号池现在也会读取不限制模型的成员所属分组中的模型，使「号池」和 `Sub-Anyrouter` 都能显示分组中的两项模型。以后新增模型只需修改分组清单，不必在账号与分组重复填写。没有成员的分组不会向总号池贡献模型，明确限制模型的账号仍按原来的白名单过滤。

当前 Anyrouter 账号已由用户保存为 `models: []`，保留这个设置。需要重启一次 DSH 来载入这次总号池目录的后端修复；之后管理页保存账号或分组都会通知原生菜单刷新目录。「允许全部」表示取消插件内的账号白名单限制，不代表上游实际支持所有模型，协议与上游权限仍需匹配。

## 0.4.1 原生模型菜单兼容

聊天模型菜单中的每个号池分组以 `Sub-<分组名称>` 显示，例如 **Sub-Anyrouter**。显示名变化不更改 `pool-<groupId>` 内部路由；名称已经带 `Sub-` 时不会重复添加。点击分组中的模型会保留完整的供应商路由与模型 ID，确保同名模型也只使用选定号池的成员。总号池入口继续保留。

原生菜单使用 DSH 的 `modelCatalog` 从适配器路由、成员模型白名单与分组白名单构建目录。没有成员或有效模型的分组被原生菜单过滤。当前本机 Anyrouter 账号已从未分组修正为 `anyrouter` 分组，仅修改归属字段并保留修改前备份；需要重启 DSH 才会载入修正后的持久化数据和适配器源码。分组白名单中的模型还需要至少一个成员账号允许，才会出现在菜单里。

推理档位按当前路由与模型的潜在账号支持取交集。Codex OAuth 与 Gemini 不再显示本地请求构建器不接受的 `max`；已有明确保存的 native `max` 会由运行时提前拒绝，需要改选支持的档位，不会静默映射。Anthropic 的旧兼容档位行为保留。

使用当前安装 DSH 的真实 `buildModelCatalog`、`modelAvailable`、`resolveCallConfig` 和准备调用接口验证目录名称、空组过滤、成员加入、同模型跨分组选路、删除分组后旧选择失效、目录刷新事件与请求构建器能力一致。模拟调用不使用真实账号凭据。

## 0.4.0 供应商接入

账号池主页以 **接入供应商** 作为主入口。填写供应商名称、协议、API 地址、API Key 和模型，一次保存即创建账号、命名号池和聊天供应商，无需另外填写账号 ID、凭据引用或建立分组。模型可以通过 **获取模型目录** 查询，也可以按行或逗号手动填写；供应商名称和地址由用户填写，Claude Code 兼容模式与 Anthropic Beta 可以在高级设置中按需配置。查询只读取目录，不保存配置、不发送推理请求。OpenAI 兼容接入可选择 Chat Completions（`/v1/chat/completions`）或 Responses（`/v1/responses`）；Responses 可使用 HTTP 流式（SSE）或 WebSocket 传输。WebSocket 使用 API Key 的 Bearer 握手认证，发送 `response.create` 并接收 Responses 事件，需要上游明确支持该传输。可填 HTTP(S) 根地址或 WS(S) Responses 地址，模型目录查询仍走 HTTP。既有账号保持原 Chat Completions / HTTP 默认；账号编辑和元数据导入导出会保留协议选择。此处针对 API Key 接入，Codex OAuth 沿用原专用通道。Responses 支持文本、工具调用、用量和推理摘要；图片和 stop sequences 当前不支持。失败、提前断流、取消与超时会明确结束请求，WebSocket 不自动回退 HTTP。

新命名号池的模型来自账号，避免在账号和分组重复维护白名单。更多 API Key 可在高级选项选择已有供应商 / 分组，继续使用相同的聊天入口；已有分组的模型白名单冲突会明确报错。协议地址支持 API 根地址、带 `/v1` 的地址或复制的常见请求端点，保存时统一归一化，避免请求路径重复。

接入成功会显示供应商名称、模型和聊天选择指引。账号新增、修改、导入和 OAuth 接入都会刷新聊天模型目录；独立供应商号池不会混入无法由其成员调用的全局模型。保存失败会回滚新账号、分组和凭据，不显示空供应商。旧账号、已有分组、OAuth 登录、导入以及高级调度编辑保持可用。后端需要重启后启用，新页面在旧后端下保留原新增入口并提示重启。

## 0.3.1 聊天接口兼容修复

真实会话中 `registration.adapter.prepareCall is not a function` 表示错误发生在 DSH 调用准备阶段，请求尚未发往上游。管理页账号测试直接调用传输，因而可能测试成功但聊天失败。0.3.1 已补齐当前 DSH 的 `prepareCall` 与 `imageRequestPricing` 接口，保留会话、分组和号池换号逻辑；用户取消不会再误触账号冷却或故障切换。

新增 `tools/prepared-call-test.mjs` 纳入默认回归。`tools/actual-runtime-test.mjs` 另外从当前 Windows 安装的 DSH 加载真实 LlmRuntime，复现旧接口错误并验证主池 / 分组池调用、默认参数、回答组装、一次性分发和取消。该检查使用模拟 HTTP，无真实账号请求；运行需用安装的 Electron 配合 `ELECTRON_RUN_AS_NODE=1`。

## 账号管理

- 搜索账号 ID、名称、备注、模型和上游地址；按平台、凭据类型、状态、分组筛选。
- 按优先级、名称或最近使用排序；每页 20 / 50 / 100 个账号。全选只选择当前页，可跨页保留选择。
- 新增、编辑、删除账号；填写备注、凭据类型、模型列表、优先级、权重、负载系数、并发上限和有效期。Anthropic 账号可编辑需要的 Beta 请求特性。
- 分别管理账号启用状态与允许调度开关。暂停调度保留账号状态、错误和冷却；恢复调度不自动清冷却或启用停用账号。
- 显示已停用、异常、暂停调度、已到期、冷却和可用状态。有效期使用本地时间输入，保存为 UTC；可关闭到期自动暂停。
- 重置异常清除失败计数和错误，将异常账号恢复为 active，保留停用状态、调度开关和上游冷却。
- 账号测试指定模型，向单个账号发送真实小请求，使用现有上游传输。测试有超时、并发限制和用量记账，不换号，不自动启用账号。显示最近测试结果与延迟，管理接口不返回模型回答或原始错误响应。
- 凭据只写入 credentials 服务；表格仅显示是否配置，不预填密钥。

## 分组与调度

每个分组对应一条 `pool-<groupId>` provider。默认 `pool` 覆盖所有账号。旧版“设为优先分组”不再使用；每个分组可以在会话模型选择器里直接选择。

分组可设置模型允许列表，账号可属于多个组，并为每个组单独设置优先级。分组调度策略：

| 策略 | 行为 |
|---|---|
| 粘性会话 | 优先复用会话绑定，未命中时按负载选路 |
| 负载感知 | 跳过粘性绑定，按优先级、负载和最近使用选择 |
| 最早重置 | 跳过粘性绑定，优先即将重置的可调度账号 |
| 加权随机 | 跳过粘性绑定，按账号权重选择 |

账号的并发限制、有效期和三种冷却窗口仍参与可调度性判定。默认池保留原来的选路配置。

## 批量维护与配置备份

批量启用 / 停用、暂停 / 恢复调度、清冷却、重置异常、归组 / 移出组、删除，以及统一编辑优先级、并发、权重、模型列表。仅修改填写的字段。删除保留二次点击确认。

批量操作逐账号返回结果；部分失败也会展示成功账号与失败原因，并保留失败账号的选择供重试。

“导出配置”导出所选账号，未选择时导出全部；包含账号元数据、相关分组与组内优先级，**不包含密钥、凭据引用或上游地址**。这份文件是配置备份，不能单独恢复完整连接。

用“导入”重新导入 `dsh-account-pool-metadata` 文件：已有同 ID 账号合并元数据并保留凭据、连接和运行状态；新账号默认暂停调度，填写上游地址和凭据后再恢复。原有 sub2api、CPA 和账号列表导入继续可用。

## 用量与刷新

查看最近 50 条请求，按账号或模型筛选，显示该窗口内的成功 / 失败次数和输入 / 输出 token。时间显示为本地日期时间；token 单元格提示缓存写入与推理 token；失败结果提示错误码。

模型列在模型名下显示本次请求的思考等级。未映射时显示 `等级 high`；映射时显示 `等级 high → xhigh`；选择的等级被移除时显示 `等级 off → 不发送`。这是账号池发往传输层的请求参数记录，不代表上游确认实际采用该等级。Host 持久化 `reasoningEffort`（选择等级）和 `mappedReasoningEffort`（映射结果，省略参数为 `null`），prepared 调用和定向探针保留准备时的映射快照，后续配置修改不会改变历史。旧记录未采集等级，显示“等级未记录”，不推测或回填。客户端刷新后显示新布局；后端更新需完整重启，之后的新请求才包含等级记录。

统计仅涵盖这些最近记录，不代表全量日统计或上游剩余额度。可开启每 15 秒刷新；填写表单、测试、批量编辑或 OAuth 登录时暂停刷新，避免打断操作。

## 原生 Codex 与 Gemini 调用

OpenAI OAuth 账号自动使用 `https://chatgpt.com/backend-api/codex/responses`，支持文本流、函数工具及结果回传、推理 effort、缓存和推理 token 统计。完整 OAuth 令牌包中的 ChatGPT 账号 ID 用于工作区选择；也可在编辑页填写账号 ID 覆盖它。只有裸 token 时，从 JWT 声明读取；无法读取时必须手动补齐。OpenAI API Key 账号继续使用 Chat Completions。

Codex OAuth 端点不支持 `maxTokens`、`temperature` 和 `stop`，插件不会发送这些字段。账号测试仍使用短提示，但 Codex 测试无法保证 64 token 的硬上限。Response 失败、incomplete 和缺少成功终态的断流会报错，进入已有号池失败处理。

Gemini OAuth 账号自动使用 Code Assist `v1internal:streamGenerateContent`，发送项目 ID、模型和原生请求。项目优先读取编辑页填写的 Google 项目 ID，其次读取令牌包；缺少时调用 `loadCodeAssist` 自动发现并短期缓存。若 Google 账号尚未完成 Code Assist 设置，需先在 Gemini CLI 完成设置或手动提供已授权项目；插件不会自动开通项目或套餐。Gemini API Key 账号使用 Generative Language 原生 `v1beta/models/...:streamGenerateContent`。

两种协议都支持文本与函数工具。Codex 私有加密推理和 Gemini thoughtSignature 通过有界进程缓存保留工具续链，按账号、凭据身份、模型和端点隔离，不出现在管理接口或配置导出中；重启清空该缓存。Gemini 3 历史缺少签名时采用参考实现的兼容标记。图片、文件和多媒体仍未支持。

## 远端额度

账号行显示上游额度进度，OpenAI / Claude / Gemini 的 OAuth 账号在当前可见页自动查询；点击「查看用量」展开详情，点击「刷新用量」手动刷新。支持：

| 账号 | 读取接口与数据 |
|---|---|
| OpenAI / Codex OAuth | `/backend-api/wham/usage`：主、次及专项窗口，剩余百分比、重置时间、套餐与点数 |
| Claude / Anthropic OAuth | `/api/oauth/usage`：五小时、七天及模型专项窗口 |
| Gemini Code Assist OAuth | `v1internal:retrieveUserQuota`：按模型返回的剩余比例、数量及重置时间 |

额度读取厂商的上游用量接口，管理员配置的推理转发地址不会改变查询地址。查询不发送推理请求，不影响账号调度状态或冷却。默认缓存 60 秒，相同账号并发查询合并；可见页自动查询最多同时处理 2 个账号，其他页与不可见账号不自动查询。手动刷新绕过缓存，单次查询 20 秒超时。列表每 15 秒刷新读取本地快照，远端自动查询仍遵守可见范围、缓存和并发限制。

查询失败会保留上次成功数据并标注旧缓存，显示固定诊断和查询时间；未提供窗口或不支持查询的账号显示未知，不当作零额度。API Key、自定义和 Grok 账号当前没有接入公开远端额度接口。额度快照只在当前进程缓存，重启后需重新查询。

## 与完整 sub2api 的边界

本插件对齐本机账号管理与调度操作。尚未实现 sub2api 的代理管理、RPM / 费用预算、多租户和计费、定时测试、完整厂商专项设置，以及图片 / 文件传输。

协议、额度与重置卡的定向测试使用模拟上游，未用真实卡验证消费；实际调用、查询或用卡仍取决于厂商授权、账号资格及网络可达性。

## 验证

日常按改动选择测试；文案或低影响调整不新增机械断言。涉及调用、冷却或持久化行为时验证对应场景，只有公共接口、存储格式或大范围调度变更才执行完整回归。

| 命令 | 范围 |
|---|---|
| `pnpm test` | 显示功能选择提示，不自动跑测试 |
| `pnpm test quota` 或 `pnpm test:quota` | OAuth 远端用量的规范化、缓存、并发及查询失败处理 |
| `pnpm test reset-credits` 或 `pnpm test:reset-credits` | 重置卡列表、确认消费、请求 UUID 恢复及消费后的刷新处理 |
| `pnpm test detection` 或 `pnpm test:detection` | 检测重试的关键场景：成功不冷却、普通限流、次数上限、部分输出、取消、账号测试 |
| `pnpm test client` / `host` / `domain` | 对应界面、管理接口或存储检查，可按需组合，例如 `pnpm test host domain` |
| `pnpm test:detection:all` | 检测重试的完整边界场景 |
| `pnpm test:all` | 完整回归，仅在需要时显式运行 |

现有测试保留复用；验证结果按本次实际检查的行为和结果说明，不把累计断言数当作独立场景。

当前 GUI 的插件发布接口已返回新版客户端的 HTTP 200，并确认内容与本地脚本一致；尚未在已登录的真实浏览器中逐项点击验证。
