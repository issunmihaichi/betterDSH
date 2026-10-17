# 插件独立运行契约与验证

## 结论与范围

独立运行指 **在兼容 DSH 宿主中，只安装所需的 betterDSH 插件，无须同时安装其他 betterDSH 功能插件**。不代表不需要 DSH 核心、React/ModuleLoader、插件自己的 npm 依赖、凭据或远端服务。

本次覆盖六个默认 bundle 及可选自动审查归因包；模型归因插件虽不属于本仓合集，其与账号池的可选 API 联动也在缺失/异常测试范围内。仅修改发行源码，不安装、不更新 live profile、不重启应用、不调用付费模型。

## 依赖边界

| 插件 | 必要宿主能力 | 其他功能插件缺失时的行为 |
| --- | --- | --- |
| 用量统计 | `connection`；统计时需要核心 `sessionQuery`；浏览器需要 slots/locale | 不读取账号池 API；可选 `uiWorkspace` 缺失/不兼容只隐藏导航，统计不受影响；点击时失效给局部提示 |
| 账号池 | `storageDomain`、`llm`、`connection`、`timer`、`credentials`、`attachments`、`sessions`、`sessionProjections`；声明的 schemastery/zod/ws | 不要求模型归因/审查增强；缺失归因 API 隐藏测试入口，晚加载重探测；审查诊断故障不影响账号列表/调度 |
| 上下文窗口 | `connection`、`sessionQuery`、`webServer`；官方会话 UI、ReactDOM | 分类逻辑和 token 估计在本包，不要求 MCP 与技能或用量插件；工具/技能来自会话数据 |
| GitHub | `connection`；MCP 功能需要官方 MCP client，下载需要 Git/凭据 | 不要求 `dsh-mcp-skills`；commands 缺失不撤销主 API，迟加载/重载跟随注册；工作区表按使用时查询 |
| MCP 与技能 | `connection`；对应操作需核心 pluginManager/configEditor/tools/skills 等服务 | 不导入 GitHub 或上下文窗口插件；缺核心管理能力显示不可用/返回结构化错误，不假装操作成功 |
| 安装向导 | `connection`、官方 `pluginManager`、官方插件详情 UI | 其余五插件都未安装也可启动；缺源码仅标记该项不可安装，不在读取状态时安装任何东西 |
| 自动审查归因 | approval/llm/permissionPresets/sessions/tools，以及受检的官方审核模块 | 不依赖账号池；**官方审核模块缺失时明确拒绝启用，不注册替代 Gate，不通过跳过审核来伪造独立性** |

必需的核心服务缺失时，Cordis 可以等待服务或停止相关插件；不是“保证删除任何 DSH 内置插件后功能仍完整”。尤其上下文窗口的直接 `apply` mock 503 测试不等于真实 Cordis 缺少顶层注入时仍会保留 API。

## 本轮修复

1. **账号池可选模型归因隔离**：专用 capability 状态，不复用失败后的旧缓存；校验版本、行和嵌套结果数组；404/503、HTML、网络失败、坏响应均不使账号行渲染崩溃。失效时撤销确认和旧回调能力；无能力时每 30 秒只读探测，正常/运行中仍分别按 6 秒/1.5 秒读取。绝不自动启动模型探针。
2. **账号池可选审查桥隔离**：防护 snapshot 缺方法/抛错/异常 getter/错误版本/异步返回；仅返回固定诊断状态及白名单字段。迟加载、替换、卸载不阻塞主账号池。
3. **GitHub 服务加载顺序**：workspaceRegistry 不再在启动时固定捕获；commands 通过可选子生命周期注册与注销，不使主 API 等待命令服务。
4. **用量导航降级**：检查 `openSession` 方法，并捕获调用时缺失、同步错误及异步拒绝；保留统计和设置页。
5. **测试去除硬耦合**：MCP 与技能自己的 Host 测试不再静态导入上下文窗口；跨包公式一致性单独移到仓库测试，未删除该质量约束。
6. **发行入口同步**：账号池新入口为 [runtime 0.4.25](../dsh-account-pool/lib/runtime-v0.4.25-plugin-independence/host.js)，旧快照不改写；包版本 0.4.16。GitHub 0.1.3、用量 0.2.1。

## 自动化验证

```powershell
node tools/standalone-test.mjs                      # 七个插件，逐个独立目录
node tools/standalone-test.mjs dsh-mcp-skills        # 只测一个插件
node tools/estimator-parity-test.mjs                # 仓库级跨包一致性
node tools/test.mjs usage account context github mcp installer review independence --report=results.json
```

[隔离测试脚本](../tools/standalone-test.mjs)按包的 `files` 清单复制运行文件与独立测试工具，每个插件使用不同的临时父目录，**其余插件不在该目录树内**；只链接已安装且在清单声明的 npm 依赖。导入真实 `main`（账号池是版本化快照），检查可达运行模块的本包边界与声明依赖，然后执行本包 Host/Client 离线用例。测试结束只清理自己创建的临时目录。

[GitHub 生命周期测试](../dsh-github/tools/lifecycle-test.mjs)调用真实 `apply`，用模拟的 Cordis 子生命周期控制服务迟到、卸载和重挂，核对注册/注销与 API 保留。[跨包估计测试](../tools/estimator-parity-test.mjs)保留 22 个公式/常量一致性断言。

基线现有功能测试 31 条命令全部通过，但发行契约因根文档的用量版本过期失败（总计 31/32）。隔离测试额外复现了 MCP 测试的 `ERR_MODULE_NOT_FOUND`，说明原全量测试通过不等于单插件可独立测试；已修复引用边界与版本表。

### 最终执行结果

Node v24.21.0，完整上述命令执行：**35/35 命令通过，0 失败**。

- 单插件独立目录：**7/7 通过**，其余兄弟插件不在该目录树内。
- 账号池：Host **114/114**、Client **847/847**；覆盖缺失/加载/卸载/不兼容及旧回调撤权。
- 用量：Client **110/110**；安装向导 Host **18/18**；自动审查归因 mock **19/19**。
- 发行契约：**7 个 bundle、63 个可达 JS 模块**通过；账号池新快照与源文件及摘要一致。
- 跨包估计算法：**22 项**一致性断言通过。
- `git diff --check` 按仓库原有 `core.autocrlf=true` 配置通过；新增测试脚本语法检查通过。未修改仓库换行配置。

不将同一测试在主套件和隔离套件里的重复执行累计成额外独立场景数。

## 验证限制与后续事项

- 这里的服务/React 渲染测试是离线 fixture，不是真实 Cordis 调度、浏览器渲染或任意插件组合的穷举。没有安装七个新包到当前 GUI，也没有执行真实插件卸载/重启验收。
- 未移除真实 DSH 核心插件，未读取真实会话/凭据，未运行供应商或 GitHub live 测试；本机 HTTP/WebSocket fixture 不等于供应商实测。
- 独立隔离测试验证完整发行入口和已覆盖功能，不声称所有异常输入都不可能崩溃。
- GitHub 自身卸载时已启动 clone 的取消/后续副作用、用量插件自身卸载时进行中的统计收口、上下文窗口样式卸载清理是另外的生命周期议题；本轮不把它们误报为“缺兄弟插件导致崩溃”，也不宣称已全部解决。
- 上下文窗口的历史迁移工具仍依赖用量开发工具；它不是发布入口或默认测试，不能当作独立安装所需的运行依赖。

更新部署时要同步 Host 与 Client；Host 需要重启 DSH，Client 需要刷新 GUI。本轮没有打包/安装替换当前实例，也没有提交或推送仓库。
