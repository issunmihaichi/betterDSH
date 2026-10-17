# 维护与回归指南

## 代码边界

- 六个插件都是独立 DSH bundle：Host 负责官方服务、持久化与认证 API；Client 只负责视图和交互。
- 不另起替代 DSH server，不复制业务配置到向导，不将 secrets 送给浏览器。
- 当前保留单一手写客户端 ModuleLoader bundle。不要为“文件变小”随意拆成 ESM chunks：宿主/客户端模块的缓存与资源修订机制可能让子模块更新失效。
- 在客户端单文件内用明确命名的 pure helpers、hooks、components、registration 区块划分责任。先用行为测试证明边界，再按真实体积/加载需求决定是否构建拆分。
- 安装向导的目录与公开错误策略位于 [catalog 模块](dsh-installer/lib/catalog.js)，其 Host 保留请求/任务边界。

## 本机开发源码与发行副本

工作区原始 `dsh-*` 目录可能被运行中的 profile `link:` 引用；本仓是单独的发行副本。修改本仓不会自动改动那套 live 安装。

账号池目前通过一个版本化宿主快照发布。若修改普通 `lib` 宿主模块，必须生成新版本快照并更新包入口，不能原地改写旧目录；当前 [发行快照](dsh-account-pool/lib/runtime-v0.4.49-local-tauri/snapshot.json) 的 SHA256 与源码须一致。
不是“测试普通源码通过”就说明发布的 snapshot 也包含修复。

## 统一离线测试入口

先确保 Node 可用。账号池依赖可在其目录运行 `pnpm install --frozen-lockfile` 安装；其余插件没有新增外部测试依赖。

在仓库根目录：

```powershell
node tools/test.mjs                # 六插件全量离线回归 + 发行契约
node tools/test.mjs usage installer # 聚焦回归
node tools/contracts-test.mjs      # 单独验证打包入口/模块边界/快照
node tools/test.mjs --report=../betterDSH-test-results.json # 可选 JSON 命令级记录
```

也可通过根 [package.json](package.json) 的 `pnpm test` 调用。

可用 scope：`usage`、`account`、`context`、`github`、`mcp`、`installer`、`review`、`independence`。默认运行前六项及 `independence`；`review` 的完整专项 mock suite 可显式选择。`independence` 默认覆盖七个插件的独立目录测试及跨包估计算法一致性。

- [统一测试脚本](tools/test.mjs)使用当前 Node 可执行文件，stdio 继承，不依赖 shell 中另一个 `node`。
- 每条失败都记录非零退出；继续其他插件以收集完整结果，最终失败退出。
- 用量默认只跑 `--synthetic-only`。真实会话对账是单独的非确定性检查，不能让私有本机数据成为每次 CI 的条件。
- 不运行 `live`、`e2e`、OAuth 真登录或真实 MCP 修改脚本；这些可能写 profile 或令牌，必须单独人工确认。
- 原有旧测试编号会随着新增场景变化。记录脚本级退出与覆盖的行为，不把硬编码“全部 N/N”当长期品质指标。

## 测试要求

1. API 保存测试使用真实 `Request`，不能用可无限重复读 body 的 fake 来掩盖 Fetch body 消费问题。
2. 对异步 UI 用可反序返回的 deferred Promise 测试，不只匹配源码字符串。
3. 保存逻辑测试包括立即拒绝、延迟拒绝和并发隔离；不能只 await Promise resolve 就判成功。
4. 在响应/树上断言脱敏，覆盖 env、headers、URL、args。秘密测试使用固定假值，不读取 live 凭据。
5. 以用户动作覆盖 loading/empty/error/stale/retry，而不是只渲染一个成功截图。
6. 对话框、开关和图表新增语义树断言；焦点陷阱/屏幕阅读器仍需要真实浏览器测试。

## 发布检查

```powershell
git diff --check
node tools/test.mjs
# 每个插件目录：
pnpm pack --pack-destination <仓库外输出目录>
```

也可使用 [打包验证脚本](tools/package-release.py)：

```powershell
python tools/package-release.py --node <已有node.exe> --pnpm <已有pnpm.mjs> --out <包输出目录> --zip <合集.zip>
```

只打包固定六个 bundle，不安装/发布；逐字节核对运行源码（pnpm 重排的 package.json 按完整 JSON 语义核对），检查入口、exports、相对依赖与可移植 patch，再创建只含六个当前版本的 ZIP（tgz + 已展开运行目录 + 安装说明 + SHA256）。已有旧版本 tgz 不删除，也不会混入新 ZIP。运行目录不带 tools 测试，完整维护仍使用源码仓库。

核对：

- 入口/patch 都在包内；间接本地 imports 也在 files 白名单内。
- bundle patch 只用可移植包名，无开发机器的绝对入口或诊断输出。
- 不收录依赖、refs、浏览器 profile、真实日志、私有认证 URL、临时截图脚本、凭据。
- 包版本、根 README 与各插件文档一致；账号池版本化快照标记不等同于 package semver。
- 更新 Host 后提醒重启；Client 刷新页面后验收。只有核实对应 dev watcher 才能承诺 HMR，无 watcher 不承诺自动热更新。
- 改运行中的 GUI 时在原有 URL 刷新验证，不靠替代 server 的页面判断生效。
- 提交/推送/修改 live 安装与编辑发布源码是不同动作，按用户要求执行，不静默跨越边界。

逐插件交互目标、已知风险和验收层级见 [UX 设计基线](docs/UX-DESIGN.md)。
