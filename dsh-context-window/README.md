# dsh-context-window — 输入框下方那个「白圈」点开后的弹层

保留 composer 里那个小小的占用圆环（`◔ 57%`）当触发器，**只换掉它点开的弹层**：

- **圆环**：原样保留——同样的 14px 尺寸 / 2px 描边 / track+fill 主题色 / hover 底色 / 百分比读数
- **弹层**：标题行 `上下文窗口 · 572.4k / 1M (57%) · ›` + 一条整窗分段占用条（264px，同 DSH 原生弹层）
- **点标题行**：展开分项 — 对话消息 / MCP 工具 / 系统工具 / 系统提示词 / 技能 / 剩余空间
- **点 MCP 工具**：先出**服务层**（`github 46 ~12.5k`），再点某个服务才展开它的**工具层**（`issue_write ~902` …）
- **点系统工具 / 技能**：展开各自的逐项明细
- **MCP 明细末尾**：一句「在「设置 → MCP 与技能」里停用某个服务，就能省下它这一份成本。」——这份成本是
  真的，但只有那一页能真的把服务关掉；两页现在用**同一套计价公式**，所以这句话里的数字在两边一致
  （`dsh-mcp-skills/tools/host-test.mjs` 逐输入断言两份 `estimate.js` 副本相等）

| 圆环 | 弹层 | 展开分项 |
| --- | --- | --- |
| ![圆环](docs/screenshots/live-ring-trigger.png) | ![弹层](docs/screenshots/live-popover.png) | ![展开](docs/screenshots/live-rows.png) |

| MCP 第一层（服务） | MCP 第二层（该服务的工具） | 技能 + skill 工具标注 |
| --- | --- | --- |
| ![服务](docs/screenshots/live-mcp-servers.png) | ![工具](docs/screenshots/live-mcp-tools.png) | ![技能](docs/screenshots/live-skills-expanded.png) |

上图为真实运行中的 DSH（`desktop` profile）截图，不是设计稿。

## 0.4.1 输入用量缺失时的占用修复

上游输入用量为 `0` 时，官方压力投影可能只剩采样后的新增消息，导致顶部显示 `1.4k` 而分项合计约 `64.4k`。此时圆环和顶部总数改用 `messageTokens + toolsTokens + systemTokens`，顶部显示 `~` 表示估算；缺少输入采样时也采用这一回退。有有效的非零输入/缓存压力时仍使用官方压力投影。

## 每一行的数据来源

| 行 | 来源 | 精确性 |
| --- | --- | --- |
| `572.4k / 1M (57%)` | 有非零输入采样时取官方 `contextPressure`；缺失或为零时取分项估算总和并显示 `~` | 上游采样或估算 |
| 对话消息 | 官方 `contextBreakdown.messageTokens` **减去**技能目录那一条消息 | 启发式估算 |
| MCP 工具 `46` | 最新 `request/header` 里名字为 `mcp__<server>__<tool>` 的工具（dsh-mcp-client 的命名约定），按服务分组 | 分类精确 |
| 系统工具 `33` | 同一批工具里其余的 | 分类精确 |
| 系统提示词 | 官方 `contextBreakdown.systemTokens` | 启发式估算 |
| 技能 `4` | DSH 自己注入的那条 `user/message`（`source.kind = 'skill-catalog'`，带 `entries`）；行内还会标注 `skill 工具本身 ~88 · 计入系统工具` | 精确 |
| 剩余空间 | 窗口 − 上面三项官方估算桶之和 | 启发式估算 |

拆分**逐层归一化**到官方总数：`MCP + 系统工具 = 工具定义`、各服务之和 = MCP 行、
`对话消息 + 技能 = 消息`。（某个服务的工具清单被截断时，可见工具保留各自真实单价，
剩余部分由「还有 N 项未显示」承担，不会被摊到可见项上。）

token 价格用 DSH 自己的计价公式（`lib/estimate.js` 是 `@deepseek-ai/dsh-token-meter/estimate` 的同值副本；
宿主插件无法按裸包名导入 DSH 内部包），启发式部分保留 DSH 自己的 `~`；计数（46 / 33 / 4）是精确值。

**仍然不显示**：Memory files、Autocompact buffer —— DSH 现有投影与会话记录里没有对应的精确来源。

## 架构

| 半边 | 文件 | 职责 |
| --- | --- | --- |
| Client | `lib/client.js` | 圆环触发器 + 弹层；读官方投影（实时），弹层打开时轮询宿主分类路由；逐层归一化 |
| Host | `lib/host.v4.js` | 认证 `/api` 通道上的精确路由 `GET /api/context-window.detail?session=<id>`（5s 缓存） |
| 纯函数 | `lib/classify.js` | 工具 MCP/内置分类、按服务分组、技能目录与 skill 工具识别（可离线测） |
| 计价 | `lib/estimate.js` | DSH 计价公式的同值副本（含出处说明） |

为什么圆环要自己画：官方 `ContextMeter` 的「圆环 + 弹层」是同一个组件、硬渲染在本插件座位旁边的兄弟节点，
不是槽位占位者。所以本插件按**结构**识别它（`aria-haspopup="dialog"` + 可访问名带百分比 + 两个圆的占用环）
并 `display:none`，然后在同一位置画一个同款圆环；识别失败只会退化成「多一个环」，不会误隐藏别的控件。

## 安装与重载（重要，含一个坑）

```powershell
plugin_manager install_bundle  target = "D:\Backup\Documents\deepseek-harness\default-workspace\dsh-context-window"
```

- **改 `lib/client.js`**：纯 JS 客户端 bundle，**无构建步骤**，存盘即热重载（刷新页面即见）。
- **改宿主侧任何文件**：装载器**按 specifier 记忆宿主模块**，Node 的 ESM 缓存**按 URL 记忆依赖**——
  所以改文件、关开 bundle 都不会重新导入。热重载的做法是**同时**做两件事：
  1. 入口文件名 +1（`host.v4.js` → `host.v5.js`，改 `cordis.patch.yml` 与 `package.json`，删旧文件）；
  2. 改入口里的 `REVISION = '4'` → `'5'`。
  入口对 `./classify.js` / `./estimate.js` 用的是 `` import(`./classify.js?rev=${REVISION}`) ``，
  这样依赖也会跟着换版本；只改文件名而不改 `REVISION` 会继续命中旧依赖（本次踩过：
  v3 入口拿到了旧 `classify.js`，服务层清单是空的）。
  不想折腾就重启一次 DSH。

## 验证（本机实测）

| 项目 | 结果 |
| --- | --- |
| `node tools/host-test.mjs` | **25/25**：MCP 命名解析、工具拆分与逐项计价、**按服务分组且每组带自己的工具清单**、技能目录识别、skill 工具自身价格、会话折叠、计价副本公式 |
| `node tools/client-test.mjs` | **44/44**：bundle 入口/导出/样式、数值格式化、`distribute` 最大余额法不增不减、**服务层/工具层两级归一化**、有/无分类两种构成、两级展开与按键语义、技能行对 skill 工具的标注、**MCP 明细末尾的管理提示（且只出现在 MCP 行）**、槽位注册 |
| 实机（真实会话） | 五行：`对话消息 ~466.2k 46.6%`、`MCP 工具 ~12.5k 1.3% 46`、`系统工具 ~6.9k 0.7% 33`、`系统提示词 ~2k 0.2%`、`剩余空间 ~512.3k 51.2%`；点 MCP 出 `github 46 ~12.5k`；再点出 46 个工具逐项（`issue_write ~902`、`pull_request_read ~637` …）；控制台零错误 |
| 实机（宿主路由） | `tools.total=19414`、`mcp=46/12513`、`server github: count=46 tokens=12724 items=46`；`skills: count=4 tokens=556 skillTool=88`（另一会话，含真实技能目录） |
| 技能行 | 行内提示 `skill 工具本身 ~88 · 计入系统工具`（`skill` 工具的 schema 一直算在系统工具的 6906 tok 里） |

`tools/verify-live.mjs` 是实机脚本（CDP 驱动，无第三方依赖）：

```powershell
# 先拿到带令牌的本机地址：给宿主半边配 debugDumpPath（见 cordis.patch.yml 注释）
node tools/verify-live.mjs <authenticatedUrl>
```

## 技能行为什么有时不出现

技能行只在**该会话确实带技能目录**时出现。目录由 DSH 的 `skill` 工具插件按 pre-step 注入，
前提是技能注册表里有「模型可调用」的技能：

- 之前本 profile 的文件系统技能提供者 `include:skill-filesystem` 是 **inactive**，注册表为空，
  没有目录消息，技能行不显示（`dsh-mcp-skills` 的技能页同样是空的）。
- 已启用：现在注册表里有 4 个内置技能（`office-docx/pptx/xlsx`、`diagnose-windows-sandbox-acl`）。
  改回去：`plugin_manager set_plugin  target = "include:skill-filesystem"  enabled = false`。
- 已经跑起来的会话不会补注入，**新开一个会话**（或在技能变化后的下一轮）才会出现技能行。
- 与技能相关的两种 token 要分清：**技能目录**（那条注入消息，占「技能」行）与
  **`skill` 工具自身的 schema**（约 88 tok，一直在「系统工具」里）——技能行会在明细末尾把这句标出来。

## 已知限制

- Memory files、Autocompact buffer 未实现（无精确来源）。
- 分类路由 5s 缓存、客户端 5s 轮询：弹层里的分项数字最多滞后几秒；圆环与标题行的占用始终实时。
- 工具/技能的 token 数是 DSH 计价口径的启发式值（带 `~`），不是供应商计费 token；拆分比例来自这些值。
- 分类路由不可用时（老版本 DSH、路由报错）自动退回官方三桶视图：对话消息 / 工具定义 / 系统提示词 / 剩余空间。
