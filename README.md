# betterDSH

一组让 **DSH（DeepSeek Harness）** 更好用的插件：五个功能插件，加一个原生插件详情中的安装向导。每个都是独立 bundle；Host 调用官方服务并提供认证 API，Client 用单一手写 ModuleLoader bundle 注册原生槽位，**无需构建步骤**。

本仓是与工作区 `link:` 开发安装分离的发行副本。源码变更不代表 live 安装已更新；Codex 专项包通过单独的受控升级和实际 Host 核验生效，不自动提交或推送。其它插件的 UX/可维护性说明与专项部署状态分开记录。

当前同步基线（2026-10-18）：账号池 **0.4.26 / runtime 0.4.49-local-tauri**，自动审查归因 **0.1.2**，其余插件保持 0.2.1 / 0.4.3 / 0.1.3 / 0.1.1 / 0.1.0。提交与推送只更新本发行副本，不安装、不重启 GUI。

## 插件一览

| 插件 | 版本 | 主要用途 | 本轮改进 |
| --- | --- | --- | --- |
| [用量统计](dsh-usage-report/README.md) | 0.2.1 | 设置中的本机日用量趋势，不含计费数据 | 可选工作区服务缺失/卸载/不兼容时保留统计，导航失败局部提示 |
| [账号池](dsh-account-pool/README.md) | 0.4.26 | 粘性会话/负载选路、分组、额度与失败恢复，可选的**本机 API**（Chat Completions / Responses） | 本机 API 与 Tauri 原生请求 Origin 修复；保留 Codex Fast / Ultrafast、v2 加密压缩、批量归因与自动暂停 |
| [上下文窗口](dsh-context-window/README.md) | 0.4.3 | 会话输入区占用环与分类面板 | 分类读取单飞/清理、旧数据反馈、键盘与焦点、视窗限高；工具平铺 `server · tool` |
| [GitHub 管理](dsh-github/README.md) | 0.1.3 | 设置页、`/github` 命令、远程仓库克隆 | 命令和工作区服务迟加载、替换及卸载时重接，不阻塞主 API |
| [MCP 与技能](dsh-mcp-skills/README.md) | 0.1.1 | MCP 启停/配置、技能目录 | 单次读取请求体、凭据脱敏、弹层局部错误与覆盖确认、开关/键盘语义 |
| [安装向导](dsh-installer/README.md) | 0.1.0 | 原生插件详情中安装上述五个功能插件 | 来源检查、只读预览、确认互斥、安全错误与进度、完成状态刷新 |

### 可选 Codex 专项入口

| 插件 | 版本 | 用途 | 默认状态 |
| --- | --- | --- | --- |
| [自动审查归因](dsh-codex-review-attribution/README.md) | 0.1.2 | 复用宿主原审核 Gate，为 Codex OAuth 请求补充明确来源并配置审核模型 | 禁用；兼容预检及停机切换后启用 |

此包独立打包，不属于上述六包合集或向导的默认安装范围；不得与原自动审查 Gate 同时启用。不修改 ASAR、审批规则或非 Codex 路由，官网最终分类不由客户端控制。

## 独立运行

各功能插件可以按需单独安装，不要求同时安装其余 betterDSH 插件。账号池的模型归因/审查增强是可选联动；缺失或响应异常时只撤销增强，不影响账号主功能。七个插件均提供无兄弟插件目录的隔离验证；核心 DSH 服务和各自声明的 npm 依赖仍然必需，自动审查归因仍必须通过官方审核模块兼容检查。

依赖矩阵、已修复风险及离线/真实运行边界见 [插件独立性说明](docs/PLUGIN-INDEPENDENCE.md)。本仓只做源码与离线回归，安装、重启与 live 核验另行授权执行。

## 安装

推荐先在 DSH 官方插件管理器安装向导所在目录（**绝对路径**），再到「插件 → dsh-installer → 配置详情」检查本地仓库、勾选、预览并确认。

```text
plugin_manager install_bundle target = "D:/path/to/betterDSH/dsh-installer"
```

也可分别安装功能插件目录。向导不自动下载仓库，已有插件只启用或跳过，**不覆盖更新旧安装**；升级已有插件请在官方管理器单独处理。

- 六个 bundle patch 都用可移植包名，无开发机器的绝对入口。
- 不预置账号、令牌、私有日志或诊断输出路径；安装后自行配置。
- 账号池通过版本化 Host 快照加载；发行契约检查其内容与普通源码一致。
- 官方管理器可选择链接或复制目录，不假定所有安装都是 `link:`。
- Host 按导入标识缓存，更新后**重启 DSH**；Client 更新后刷新 GUI。没确认 dev watcher 在运行，不承诺自动 HMR。

## UX 与维护约定

详见 [UX 设计与验收基线](docs/UX-DESIGN.md)、[维护与回归指南](CONTRIBUTING.md)、[本轮验证记录](docs/VALIDATION.md)。

核心约定：加载不伪装零值；失败不丢草稿；旧结果明确标记；提交有同步互斥；写失败不显示成功；危险动作核对计划；错误给下一步；密钥不进入浏览器展示。

保留简单发行架构，不为“拆文件”引入未经验证的客户端 chunks。纯规则与行为回归约束状态边界，Host 的持久化与任务结果是事实来源。

## 离线测试

仓库根提供统一入口，使用当前 Node 子进程且继承 stdio：

```powershell
# 首次：账号池需安装其声明的 schemastery / zod / ws 依赖
# 在 dsh-account-pool 目录执行 pnpm install --frozen-lockfile
node tools/test.mjs                  # 六插件离线回归 + 七包独立性 + 发行契约
node tools/standalone-test.mjs       # 七插件逐个独立目录验证
node tools/test.mjs usage installer  # 聚焦回归
node tools/contracts-test.mjs        # 主入口/文件白名单/相对依赖/快照一致
```

统一脚本不读取真实会话日志、不执行 live/e2e 登录或安装。账号池 HTTP/WebSocket 回归只启动测试用本机端点，不访问供应商。用量真实日志对账另用其 `test:local`。

**测试边界：**本轮完成离线 API、状态/事件、deferred、焦点接口模拟与打包契约；未在当前运行 GUI 安装、重启或执行真实浏览器/屏幕阅读器验收。旧截图与旧 live 数字在各插件说明中明确标记为历史，不能当成本轮视觉验收。

此前用量真实日志对账 78 条中 72 条与投影缓存一致、6 条不一致（完整 183/189）；这项兼容性差异未修复，本轮不宣称真实对账全部通过。

## 仓库结构

```text
betterDSH/
├── dsh-usage-report/
├── dsh-account-pool/
├── dsh-context-window/
├── dsh-github/
├── dsh-mcp-skills/
├── dsh-installer/
├── docs/UX-DESIGN.md
├── CONTRIBUTING.md
└── tools/                      # 六插件统一离线回归/发行契约
```

各插件自带 Host/Client、可移植 patch、说明和独立 tests；账号池另有历史领域 [设计说明](dsh-account-pool/DESIGN.md)。不收录 `node_modules`、从宿主提取的 refs、浏览器 profile、真实凭据或工作区其他项目。

## License

MIT，见 [LICENSE](LICENSE)。
