# betterDSH

一组让 **DSH（DeepSeek Harness）** 更好用的插件合集。每个插件都是独立可装载的 bundle：
Host 半边在认证的 `/api` 通道上注册路由，Client 半边以 `window.__ModuleLoader__.load`
形态注册到 Web GUI 的某个槽位（设置页 / 设置分区 / 会话界面），**无需构建步骤**。

仓库里的 5 个插件都来自本机正在运行的 `link:` 安装，即：**这里就是运行中代码的副本**。

## 插件一览

| 插件 | 版本 | 作用 | 挂载点 |
| --- | --- | --- | --- |
| [`dsh-usage-report`](dsh-usage-report/README.md) | 0.1.0 | 设置里的「用量」页：按天统计本机会话输入/输出 token（纯本地，无外网请求、无计费数据） | `settings.section` (id `usage`) |
| [`dsh-account-pool`](dsh-account-pool/README.md) | 0.1.0 | 账号池：两层选路（粘性会话 + 负载感知）、失败冷却与降级 | 设置页 + Host 上游适配 |
| [`dsh-context-window`](dsh-context-window/README.md) | 0.4.0 | 输入框下方「白圈」点开的弹层：官方占用投影 + 宿主分类（MCP 工具两层展开 / 系统工具 / 技能） | 会话输入区 |
| [`dsh-github`](dsh-github/README.md) | 0.1.0 | 设置里的 GitHub 管理页、`/github` 人类命令、远程仓库克隆进工作区 | `settings.section` + 命令 |
| [`dsh-mcp-skills`](dsh-mcp-skills/README.md) | 0.1.0 | 设置里的「MCP 与技能」页：统一管理 MCP 服务器（启停/配置/工具数）与技能库 | `settings.section` |

每个插件的完整说明、架构、实测数据与已知限制都在它自己的 `README.md` 里；
`dsh-account-pool` 另有一份 49 KB 的 [`DESIGN.md`](dsh-account-pool/DESIGN.md)。

![设置 → 用量（最近 30 天）](dsh-usage-report/docs/screenshots/live-settings-usage-30d.png)

## 仓库结构

```
betterDSH/
├── dsh-usage-report/          # 每个插件一个顶层目录，目录名 = 包名
│   ├── package.json           #   dsh.bundle.patch + dsh.client(platform: web) 声明
│   ├── cordis.patch.yml       #   往 profile 里插入一行条目
│   ├── lib/                   #   host.js / client.js（手写 JS，无构建）
│   ├── docs/screenshots/      #   实机截图
│   ├── tools/                 #   零依赖测试与诊断脚本
│   └── README.md
├── dsh-account-pool/
├── dsh-context-window/
├── dsh-github/
└── dsh-mcp-skills/
```

## 安装

DSH 的插件装载由 **profile** 驱动。以 `desktop` profile 为例，两处需要改：

1. `C:\Users\Administrator\.dsh\profiles\desktop\package.json`
   - `dependencies` 加一行：`"dsh-usage-report": "link:<本仓路径>/dsh-usage-report"`
   - `dsh.profile.bundles` 追加：`dsh-usage-report`
2. profile 的 `cordis.patch.yml` 末尾由插件管理器写入一行：`- id: usage-report` / `disabled: false`

通常不必手写，交给插件管理器：

```powershell
# 安装（把路径换成你克隆下来的位置）
plugin_manager install_bundle target = "<本仓路径>\dsh-usage-report"
# 卸载
plugin_manager remove_bundle  target = "dsh-usage-report"
```

安装后 profile 的 `node_modules/<包名>` 是指向插件目录的 **链接**，
所以**改这里的文件就是改运行中的插件**。

### ⚠️ 关于 `cordis.patch.yml` 里的绝对路径

5 个插件里有 4 个（`usage-report` / `account-pool` / `context-window` / `github`）的
patch 条目写的是**本机绝对路径**，例如：

```yaml
- insert:
    - id: usage-report
      name: D:/Backup/Documents/deepseek-harness/default-workspace/dsh-usage-report/lib/host.js
```

这是 `link:` 安装下的刻意选择：加载器按 **specifier** 记忆已导入的宿主模块，
用绝对路径命名条目才能在**不重启应用**的前提下改 `lib/host.js` 就生效
（[`dsh-usage-report/cordis.patch.yml`](dsh-usage-report/cordis.patch.yml) 的注释里有完整解释）。

**换机器 / 换克隆位置时，这个路径必须改。** 或者改成可移植写法——走 `package.json`
的 `exports` 解析，代价是只在进程启动时读取一次：

```yaml
- insert:
    - id: usage-report
      name: dsh-usage-report        # 用包名替代绝对路径
```

`dsh-mcp-skills` 用的已经是包名写法，无需改动。

## 测试

除 `dsh-account-pool` 需要 `zod` 外，其余插件**零依赖**，测试脚本也都不需要网络：

```powershell
cd dsh-usage-report   ; node tools/report-test.mjs; node tools/host-test.mjs; node tools/client-test.mjs
cd dsh-context-window ; node tools/host-test.mjs;   node tools/client-test.mjs
cd dsh-github         ; node tools/pure-test.mjs;   node tools/host-test.mjs; node tools/client-test.mjs
cd dsh-account-pool   ; pnpm install; pnpm test     # 6 支脚本，依赖 zod
```

`dsh-mcp-skills` 没有测试脚本。各插件 README 里记录了实测结果
（例如 `dsh-usage-report` 合计 163/163 通过，含与 DSH `tokenUsage` 投影的逐会话对账）。

## 没有收录的东西

- `node_modules/` —— 见 `.gitignore`。
- 各插件的 `refs/` 目录 —— 那是从本机已安装的 `app.asar` 里抽出来**只读参考**的 DSH 源码片段
  （单个文件最大 353 KB），运行时不依赖，属于研究材料而非插件本体，因此未上传。
  需要的话可以单独补一个仓库。
- 工作区里的其他非插件内容（`dsh-plugin-descriptions-cn` 等）也没有收录，
  本仓只放 DSH 插件。

## License

MIT，见 [`LICENSE`](LICENSE)。
