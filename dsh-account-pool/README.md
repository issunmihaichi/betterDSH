# dsh-account-pool — DSH 账号池

在 DSH 里做一套**自用规模**的账号池：把多个上游账号汇成一个 `pool` provider，
按 sub2api 的号池核心状态机做选路、冷却和降级，并在界面里自由切换账号。

设计文档见 [DESIGN.md](DESIGN.md)（含与 sub2api 的逐条对照、每条规则的源码依据、
实机安装踩到的两个坑、以及 §18 对 [new-api](https://github.com/QuantumNous/new-api)
的对照——采纳了什么、明确放弃了什么）。

## 现状

**五层逻辑 + 切换能力已完成并离线验证（167 项）；已安装进 `desktop` profile，
需要重启一次 DSH 才能激活。**

| 能力 | 状态 |
|---|---|
| 账号表（zod schema + 落库形状） | ✅ |
| 可调度性判定（七条件 + 三段冷却窗口） | ✅ |
| 两层选路（粘性会话 1h + 负载感知） | ✅ |
| 失败分类与冷却回写（含"400/413/422 不冷却"、"配置类错误不冷却"） | ✅ |
| 失败策略可配置（状态码表 + 通配 + 可选关键词规则） | ✅ |
| 选路模式：粘性/负载感知/优先重置/加权随机（`weight`） | ✅ |
| **分组**：一组一条 provider 路由（`pool` / `pool-<组名>`），可在「模型」页切换 | ✅ |
| 分组管理 UI + 账号归属 + 导入指定组 | ✅ |
| 降级（单次请求内换号，含承诺规则） | ✅ |
| 用量记账（token 明细落库） | ✅ |
| 上游 HTTP 传输（Anthropic Messages + OpenAI Chat Completions，SSE→`StreamChunk`） | ✅ |
| Host 接线（domain / `llm` provider / 三条管理路由） | ✅ |
| 设置导航「账号池」页 | ✅ |
| 「模型」页「号池管理」卡片 + pool provider 卡片摘要 | ✅ |
| 账号级切换：启用/停用、设为优先、清冷却 | ✅ |
| 提供商级声明（`pool` 出现在模型提供商目录） | ✅ 仅在配了 upstream 时 |
| 凭据走 `ctx.credentials` | ❌ 未做（账号只有 `credentialRef` 占位） |
| 真实发请求 | ❌ 未做（缺凭据解析，见下） |

## 界面里在哪

- **设置 → 账号池**（左侧导航，在「用量」下面）：账号表 + 冷却倒计时 + 最近用量，
  每行有「启用/停用」「设为优先」「清冷却」。
- **设置 → 模型**，在「+ 添加模型提供商」下方：**号池管理**卡片，每个账号一行，
  一键「设为优先」——不用离开「模型」页就能切换账号。

## 安装 / 卸载

已装进 `desktop` profile（`link:` 到本目录，所以改文件即改插件）：

```powershell
# 卸载（插件页里移除该 bundle 亦可）
plugin_manager remove_bundle  target = "dsh-account-pool"
# 重新安装
plugin_manager install_bundle target = "D:\Backup\Documents\deepseek-harness\default-workspace\dsh-account-pool"
```

### ⚠ 改代码后怎么生效（重要）

| 改的文件 | 怎么生效 |
|---|---|
| `lib/client.js` | **刷新页面**即可（浏览器半边走 HTTP 取 bundle） |
| `lib/host.js` 或任何其它 `lib/*.js` | **重启 DSH** |

原因：Node 的 ESM 缓存按解析后的 URL 记住模块、活到进程结束，而**加载器不会清除它**——
禁用再启用条目会重新执行 `apply`，但**不会重新导入任何模块**，旧代码继续在跑。
这是实测出来的：改完文件后重载，报错堆栈里仍是**上一个版本的行号**（`host.js:111` 早已不是
`open` 调用所在的行）。我最初以为"条目用绝对路径命名就能热替换自己"，那是错的——
开关条目救不了宿主代码，只有客户端半边能热重载。详见 [DESIGN.md](DESIGN.md) §19。

## 测试

```bash
node tools/kernel-test.mjs     # 54 项：状态机、错误策略、选路、加权随机、分组过滤、降级
node tools/domain-test.mjs     # 13 项：schema 与适配器输出焊死、名称规则钉死、分组形状
node tools/upstream-test.mjs   # 16 项：SSE 解析、两种协议映射、端到端 429
node tools/host-test.mjs       # 30 项：假 ctx 下的接线、路由、写操作、分组与句柄归属、自检、释放
node tools/client-test.mjs     # 120 项：bundle 形态、注册、三态渲染、增删改、分组、导入
node tools/importer-test.mjs   # 18 项：sub2api 备份与 CPA auth 文件的解析
```

合计 **251 项**，零网络、零浏览器、零 DSH 运行时（除 `zod`）。

两项最有价值的测试：

- `upstream-test.mjs` 末段是**全链路**：真实 `Response` 对象承载一个带 `retry-after: 30` 的真 429
  → 传输层 → 适配器 → 内核。断言只换号一次、冷却窗口用的是**上游给的 30 秒**、且下一轮**粘回幸存账号**。
- `client-test.mjs` 用**假 React + 最小 DOM** 渲染真实 bundle，覆盖三态、断言 zh/en 词条键集合一致，
  并真的点按钮、断言发出的 POST body 是 `{id:'a2', action:'prefer'}`。

## 架构

```
lib/kernel.js    纯函数：isSchedulable / selectCandidate / classifyFailure / applyCooldown / applyAccountAction
lib/adapter.js   降级循环：选号 → 抢槽 → 转发 → 失败冷却换号（upstream 注入）
lib/domain.js    zod schema + domain spec（手写，不依赖 DSH 内部包）
lib/upstream.js  HTTP + SSE：两种协议方言 → StreamChunk（fetch 注入）
lib/host.js      接线：开 domain、注册 provider、三条管理路由、用量落库
lib/client.js    三处界面入口（手写 JS，无构建步骤）
```

前五个**都不 import 任何 DSH 模块**，所以整条链路都能离线跑。

## 已知限制

- **发不出真实请求**：账号只有 `credentialRef`，还没有接 `ctx.credentials`。
  所以 `cordis.patch.yml` 里表达不了 `upstream`，插件目前是"仅管理"模式——
  它**不会**注册 `pool` provider，也**不会**把它列进提供商目录。
- `usage` 表没有保留策略，会持续增长（JSON 存储下单文件）。
- 请求侧只支持 text / tool-call / tool-result；**图片和文件会显式抛错**而不是静默丢掉。
- `cordis.patch.yml` 里的两个示例账号（主号/备号）是为了让切换功能一装上就有东西可点，
  换成真实账号时记得改。
