# dsh-mcp-skills

设置里的 **「MCP 与技能」** 页：把本机已挂载的 MCP 服务器和技能库放在一个界面上管理。

这是 `dsh-mcp-skill-manager` 的重写版。原插件用 `connection.rpc.handle()` 注册了一个私有 RPC 通道
`/mcp-skill-panel`，但当前 DSH 版本的 `handle()` 是通过**调用方插件自己的 `ctx.webServer`** 挂路由的，
插件没 inject `webServer` 就会抛：

```
Error: cannot get property "webServer" without inject
```

异常被插件自己的 `try/catch` 吞掉，通道从未注册，页面请求拿到 405；而页面首次加载没有错误处理，
于是永远停在「加载中…」。本插件改为走**官方支持的 `/api` 通道**（`ctx.connection.fetch.register`），
和 DSH 自己的页面同一条路，因此在桌面版和浏览器里都能工作。

## 功能

### MCP 服务器

- 列出 Loader 当前真正在运行的 `mcp-*` 行（数据来自官方 `pluginManager` + `configEditor`，不再手工解析 `cordis.patch.yml`）。
- 每行显示：标识、传输方式、地址（stdio 显示 command+args）、启用状态、fiber 阶段（运行中/加载中/等待中/加载失败）、以及该服务器提供给模型的工具数量与工具名。
- **上下文成本**：每行还显示这些工具 schema 在模型上下文里的启发式开销（`~3.2k tok`，汇总行给合计）。计价用的是与「上下文窗口」圆环弹层**同一套公式**（`lib/estimate.js`，两份副本由 `tools/host-test.mjs` 逐输入断言相等），所以两个页面上的同一个服务是同一个数字。
- **归属标注**：由别的 bundle 写入的行（今天只有 `github-mcp` → `dsh-github`）会带一个「由 dsh-github 写入」徽标；编辑这种行时保存要**再点一次**（按钮先变成「确认覆盖并保存」），因为一次保存会整体替换那个插件写下的 config。
- 一键启用 / 停用（`pluginManager.setPluginEnabled`，即时生效，无需重启）。
- **编辑配置**：以 JSON 编辑该行的完整配置（`configEditor.edit` 写回 profile 补丁层）。
  标准密钥字段及其带前缀的名称（如 `Authorization`、`X-API-Key`、`GITHUB_PERSONAL_ACCESS_TOKEN`、
  `OPENAI_API_KEY`、`secret`、`cookie`）**只以 `***` 回传**。含 userinfo / 密钥查询参数的 URL、
  `args` 中的 `--token value`、`--api-key=value`、凭据 header / 环境变量赋值也会遮盖。
  配置读写保留遮盖值：保存未改动的占位符会还原已存密钥，显式填入新值才替换；普通非密钥字段
  可以保存字面量 `***`。状态页的地址使用独立脱敏视图，不拿展示文本作为运行配置。

### 技能库

- 列出技能注册表提供的全部技能（`ctx.get('skills').list()`）：名称、描述、来源（project-dsh / user-dsh / bundled / runtime …）、提供方、模型可调用 / 用户可调用。
- **查看**技能全文（`skills.get()`，含正文）。
- 切换**模型可调用**：注册表本身是 invocation-neutral 的，所以开关直接改写该技能 `SKILL.md` 的
  frontmatter 中的 `disable-model-invocation`（行级改写，不引入 YAML 依赖）。
  没有本地文件（例如 bundled / 远程技能）的条目会显示提示且不给开关。

## 操作反馈与键盘访问

- 配置编辑里的 JSON 错误和服务端保存失败显示在**编辑弹层内**，以 `role=alert` 宣告；保留草稿，
  不会把错误藏在遮罩后。改动文本会清除旧错误，并重置其他插件拥有行的覆盖确认。
- 对其他 bundle 拥有的行，先点「保存」只确认当前草稿；第二次按钮是「确认覆盖并保存」。
  两次点击之间如果再次编辑，必须重新确认。写入期间按钮禁用，成功后显示「已保存」。
- MCP / 技能开关都有 `role=switch`、当前 `aria-checked` 与包含条目名的可访问名称。
- 弹层具有 `role=dialog`、关联标题与 `aria-modal`；打开时聚焦弹层，Tab / Shift+Tab 保持在可用控件内，
  Escape 关闭，关闭后尝试返回原触发控件。离线测试覆盖这些 DOM 事件与焦点接口，**并非实机屏幕阅读器验收**。
- 首次读取失败会停止显示「正在读取」，保留错误与「刷新」恢复入口。

## 安装

```bash
cd ~/.dsh/profiles/desktop
pnpm add link:<本目录> --config.auto-install-peers=false
```

或走官方 CLI（会同时把 bundle 登记进 `dsh.profile.bundles`）：

```bash
dsh plugin --profile desktop add link:D:/path/to/betterDSH/dsh-mcp-skills
```

装完**重启一次 DSH**：宿主端的路由是在启动时组合的。

## 路由

宿主端在认证过的 `/api` 通道上注册 5 条精确路由：

| 路由 | 方法 | 作用 |
| --- | --- | --- |
| `/api/mcpskills.status` | GET | 页面全部数据（MCP 行 + 技能列表）；每个 MCP 行含 `toolTokens`（上下文成本）与 `owner`（写入方或 null），`mcp.toolTokens` 是合计 |
| `/api/mcpskills.mcp.toggle` | POST | `{ entryId \| patchId, enabled }` 启用/停用 MCP 行 |
| `/api/mcpskills.mcp.config` | GET / POST | 读（已脱敏，含 `ownedBy`）/ 写某一行的配置；写入时 `***` 占位符还原为已存值，保存前后端都会保留该行的密钥 |
| `/api/mcpskills.skill` | GET | `?name=` 取技能全文 |
| `/api/mcpskills.skill.toggle` | POST | `{ path, modelInvocable }` 改写 SKILL.md frontmatter |

## 说明

- 精确读写：MCP 行不手工解析、改写 `cordis.patch.yml`，启停与配置写入交给官方服务；技能开关按上述规则直接修改技能文件。
- 配置 POST 的 Fetch 请求体只读取一次；非法或空 JSON 请求体返回明确的 `400 bad-json`，不以内部 `500` 掩盖输入错误。
- 脱敏识别标准凭据字段、URL userinfo / 密钥查询参数和常见 argv 形态，并不是任意字符串的 DLP：
  不要把密钥藏在无语义的自定义字段或 URL 路径中。`args` 的占位符按原下标还原，编辑时不要移动遮盖参数；
  要重排参数请明确重填对应密钥。整体保存没有跨插件版本冲突检测，长时间打开的草稿仍需先确认当前行是否被其他插件更新。
- 数据不出本机：只读本机配置文件与技能文件，无任何网络请求。
- `lib/client.js` 是手写的 DSH client bundle（`window.__ModuleLoader__.load`），
  React 从模块表取得，UI 用 `createElement` 构建，改完不需要构建步骤。
- `lib/estimate.js` 是 DSH 自身计价公式的同值副本（出处 `@deepseek-ai/dsh-token-meter/estimate`，
  经 `dsh-context-window/lib/estimate.js`）。宿主插件不能按裸包名 import DSH 内部包，本插件也不
  import 兄弟插件，所以改用**副本 + 断言**：`tools/host-test.mjs` 同时 import 两份副本，逐输入比对
  并钉死黄金值，任一份漂移都会红。
- 归属映射 `ROW_OWNERS` 是一张静态表（`github-mcp → dsh-github`）。这是有意的：既然本插件坚持
  不解析补丁文件，就不能从补丁里推断归属；新增归属改这张表。
- 测试：`npm test`（= `node tools/host-test.mjs && node tools/client-test.mjs`），零网络、零浏览器、
  不需要 DSH 在运行。Host 回归使用真实、单次消费的 Fetch `Request`，覆盖配置保存、非法 body、
  env / header / argv / URL 脱敏与占位符还原；客户端回归包括弹层内错误、覆盖确认重置、延迟响应和键盘焦点边界。
- 本目录未提供 `live-probe.mjs`；离线回归不证明运行中的 Host 已加载新代码。要验证生效须另行授权实机检查，
  不要为运行离线测试而启停插件、编辑 profile 或保存真实配置。
