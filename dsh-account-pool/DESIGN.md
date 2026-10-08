# dsh-account-pool — 设计与演进记录

> 当前使用方式和能力以 [README.md](README.md) 与源码为准。本文保留早期设计和后续演进记录，其中“待评审”、首选分组、模型页第三页签、配置覆盖持久化账号等历史描述不再代表当前实现。
>
> 管理增强已实现账号搜索筛选分页、备注/有效期/负载编辑、暂停恢复调度、异常恢复、真实账号测试、批量编辑与逐项反馈、分组独立调度策略、无密钥的元数据导出恢复。账号配置仅初始化不存在的 ID，已有账号的管理设置和运行状态在重启后保留。前端支持旧后端能力检测；更新后端需要重启 DSH。

> 已接入 Codex OAuth Responses、Gemini Code Assist / API Key 原生流协议，并增加 Codex、Claude OAuth 与 Gemini Code Assist 的远端额度查询。用法、项目 / 工作区身份字段和缓存边界见 README。
>
> 目标：在 DSH 里做一套**自用规模**的账号池。对标 [sub2api](https://github.com/Wei-Shaw/sub2api) 的**号池核心状态机**，
> 但明确**不做**它的多租户/计费/伪装层。本地 sub2api 源码参考在 [_sub2api/repo](../_sub2api/repo)。

状态：**待评审**。评审通过后再写代码。

---

## 1. 范围

### 做

| # | 能力 | 说明 |
|---|---|---|
| 1 | 账号表 + 可调度性判定 | 照抄 sub2api 的 `IsSchedulable()` 七条件与三段冷却时间戳 |
| 2 | 两层选路 | 粘性会话（TTL 1h）→ 负载感知（优先级 → 负载率 → LRU） |
| 3 | 错误分类与冷却回写 | 含"400/413/422 不冷却"这条防级联规则 |
| 4 | 降级（failover） | 单次请求内换号重试，同号重试不计入切换次数 |
| 5 | 用量记账 | 从 `StreamChunk.usage` 落库（含 cacheRead/cacheWrite/reasoning） |
| 6 | 管理面 | 账号增删改查、状态查看、手动清冷却 |

### 不做（第一期）

- ❌ ~~上游身份伪装（Claude Code 系统提示词复刻、`cc_version` 同步、TLS 指纹、UA 对齐）~~
  —— **本条后来被推翻**，以「账号级、默认关闭」的开关实现，见 §21。
- ❌ 多租户、API Key 发放、订阅、支付、兑换码
- ❌ 集群一致性（Redis 快照 + outbox 广播）
- ❌ 对外 HTTP 网关（`/v1/messages` 等）—— 见第 10 节"第二期"
- ❌ 图片/视频/音频计费，只做 token

> **为什么砍掉伪装层**：它是 sub2api 工作量的主要部分（见 [gateway_service.go:38-57](../_sub2api/repo/backend/internal/service/gateway_service.go#L38-L57)
> 逐字内嵌真实 Claude Code 系统提示词的注释），也是封号风险的来源。自用场景不需要对上游伪装成官方 CLI；
> 一旦需要，就是持续对抗维护，而不是一次性工程。
>
> **补记（§21）：这条被推翻了，但不是无条件推翻。** 需要它的场景只有一个，而且很硬：
> Anthropic 把**订阅号（OAuth）凭据**限定给 Claude Code 使用，不伪装，池子里的订阅号一个也跑不起来。
> 所以它现在是**账号级、默认关闭**的开关，而不是全局行为——不需要的人完全不受影响；
> 一开始那条"持续对抗维护"的判断依然成立，只是成本现在被明确地压在一个可关闭的模块组里。

---

## 2. 与 sub2api 的对照：抄什么

| sub2api 机制 | 源码位置 | 本方案 |
|---|---|---|
| `IsSchedulable()` 七条件 | [account.go:182-203](../_sub2api/repo/backend/internal/service/account.go#L182-L203) | ✅ 直接照搬语义 |
| `stickySessionTTL = time.Hour` | [gateway_service.go:36](../_sub2api/repo/backend/internal/service/gateway_service.go#L36) | ✅ 1 小时 |
| `load_factor` 与 `concurrency` 分离 | [account.go:169-180](../_sub2api/repo/backend/internal/service/account.go#L169-L180) | ✅ 排序权重 ≠ 硬上限 |
| 两层选路入口 | [gateway_scheduling.go:24-100](../_sub2api/repo/backend/internal/service/gateway_scheduling.go#L24-L100) | ✅ 粘性 → 负载感知 |
| 400/413/422 不冷却 | `ratelimit_service.go` | ✅ 关键规则，必须有测试 |
| 同号重试不算切换 | `failover_loop.go` | ✅ |
| 粘性命中被跳过时**不覆盖原绑定** | `gateway_scheduling.go` | ✅ |
| OpenAI 高级调度器（TopK + 多维权值） | [openai_account_scheduler.go:2100](../_sub2api/repo/backend/internal/service/openai_account_scheduler.go#L2100) | ⏸ 第三期再考虑 |
| 余额在途预占、RPM 三区、粘性队列 | 多处 | ⏸ 第三期 |
| 伪装 / 计费 / 多租户 / 集群 | —— | ❌ 不做 |

---

## 3. 数据模型（domain spec）

用 DSH 的 `defineDomain` / `domainTable`（来自 `@deepseek-ai/dsh-storage-domain`），
校验用 zod，持久化由 storage 后端负责。参考实例：
[dsh-schedule.storage.js](refs/dsh-schedule.storage.js)、[dsh-workspace.spec.js](refs/dsh-workspace.spec.js)。

```js
import { z } from 'zod';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';

const accountSchema = z.object({
  id: z.string().min(1),
  label: z.string().default(''),
  platform: z.enum(['anthropic', 'openai', 'gemini', 'grok', 'custom']),
  baseUrl: z.string().optional(),

  // --- 管理状态（对应 sub2api: status / schedulable / error_message）---
  status: z.enum(['active', 'error', 'disabled']).default('active'),
  schedulable: z.boolean().default(true),
  errorMessage: z.string().default(''),

  // --- 调度权重（sub2api: priority / load_factor / concurrency）---
  priority: z.number().int().default(100),      // 越小越优先
  loadFactor: z.number().int().positive().nullable().default(null), // 排序权重
  concurrency: z.number().int().min(0).default(4),                  // 硬上限；0 = 不限
  models: z.array(z.string()).default([]),                          // 空数组 = 支持任意模型

  // --- 有效期（sub2api: expires_at / auto_pause_on_expired）---
  expiresAt: z.string().nullable().default(null),   // ISO 8601
  autoPauseOnExpired: z.boolean().default(true),

  // --- 三段冷却（sub2api 的同名三个字段）---
  rateLimitResetAt: z.string().nullable().default(null),          // 429：账号级限流窗口
  overloadUntil: z.string().nullable().default(null),             // 5xx/529：过载窗口
  tempUnschedulableUntil: z.string().nullable().default(null),    // 401/403/传输故障
  tempUnschedulableReason: z.string().default(''),

  // --- 观测 ---
  lastUsedAt: z.string().nullable().default(null),
  consecutiveFailures: z.number().int().min(0).default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();

const bindingSchema = z.object({          // 粘性会话绑定
  sessionHash: z.string().min(1),
  accountId: z.string().min(1),
  platform: z.string().min(1),
  boundAt: z.string(),
  expiresAt: z.string(),                  // boundAt + 1h
}).strict();

const usageSchema = z.object({            // 用量记录
  id: z.string().min(1),
  at: z.string(),
  accountId: z.string(),
  sessionId: z.string(),
  platform: z.string(),
  model: z.string(),
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  cacheReadTokens: z.number().default(0),
  cacheWriteTokens: z.number().default(0),
  reasoningTokens: z.number().default(0),
  accountSwitches: z.number().int().min(0).default(0),
  ok: z.boolean(),
  errorCode: z.string().default(''),
}).strict();

export const poolDomain = defineDomain({
  name: 'account-pool',
  version: 1,
  invalidRecords: 'backup-and-skip',      // 单条坏记录不阻塞整个 domain 打开
  global: {
    schema: z.object({ installedAt: z.string(), totalRequests: z.number().default(0) }).strict(),
    initial: { installedAt: new Date(0).toISOString(), totalRequests: 0 },
  },
  tables: {
    accounts: domainTable(accountSchema),
    bindings: domainTable(bindingSchema),
    usage: domainTable(usageSchema),
  },
});
```

### 已知问题（请评审）

1. **`usage` 表会无界膨胀**。DSH 默认存储是 JSON 单文件（`@deepseek-ai/dsh-storage-json`）。
   第一期先不做保留策略，但**每写完 N 条要提示**，第三期改成按天分桶或挂 sqlite backend。
2. **凭据不落在 domain 里**。第一期账号只存 `baseUrl` + 外部 API Key（从插件 Config 读），
   第三期接入 `ctx.credentials`（`set(ref, value)` / `resolve(ref)`），账号行仅保留 `credentialRef`。

---

## 4. 可调度性状态机

直接对应 [sub2api account.go:182-203](../_sub2api/repo/backend/internal/service/account.go#L182-L203)：

```js
export function isSchedulable(account, now) {
  if (account.status !== 'active') return false;
  if (!account.schedulable) return false;
  if (account.autoPauseOnExpired && account.expiresAt && now >= Date.parse(account.expiresAt)) return false;
  if (account.overloadUntil && now < Date.parse(account.overloadUntil)) return false;
  if (account.rateLimitResetAt && now < Date.parse(account.rateLimitResetAt)) return false;
  if (account.tempUnschedulableUntil && now < Date.parse(account.tempUnschedulableUntil)) return false;
  return true;
}
```

模型的**模型级**过滤（某账号不支持某模型）不写进状态机，放在选路的候选过滤里。

---

## 5. 错误分类与冷却回写

`classifyFailure(failure)` → 冷却决策。**这张表是核心，必须有测试覆盖。**

| 上游信号 | 决策 | 写入字段 | 默认时长 |
|---|---|---|---|
| 429，带 `providerRetryAfterMs` | `rate-limit` | `rateLimitResetAt` | 用 retry-after，否则 60s |
| 429，无 retry-after | `rate-limit` | `rateLimitResetAt` | 60s |
| 401 / 403 | `auth-fail` | `tempUnschedulableUntil` + `consecutiveFailures++` | 15min；连续 3 次 → `status='error'` |
| 5xx / 529 / 过载语义 | `overload` | `overloadUntil` + `consecutiveFailures++` | 30s，渐进（30s → 10min → 1h） |
| 传输层错误（无 status） | `transport` | `tempUnschedulableUntil` | 5min |
| **400 / 413 / 422** | **`none`** | **不写任何字段** | —— |
| abort / 用户取消 | `none` | 不写 | —— |
| 其他 4xx | `none` | 只记 usage，不改状态 | —— |

> **`none` 那两行是整个设计里最容易被忽略、后果最严重的部分。**
> sub2api 的代码里专门有注释防"号池级联冷却"：一个坏请求（比如超长 prompt 触发 400）
> 如果被当成账号故障，会把全部账号逐个冷却，池子直接空掉。

成功请求要重置 `consecutiveFailures = 0` 并清掉临时冷却（但**不清** `rateLimitResetAt` —— 那是上游窗口，得等它自然到期）。

---

## 6. 两层选路

```
selectCandidate({ accounts, bindings, sessionHash, requestedModel, excluded, now, inflight, mode })
│
├─ 1. 候选过滤
│     isSchedulable(a, now)
│   ∧ supportsModel(a, requestedModel)
│   ∧ !excluded.has(a.id)
│   ∧ inflight(a.id) < a.concurrency   (concurrency 为 0 时跳过此条)
│
├─ 2. Layer 1：粘性（硬命中）
│     b = bindings[sessionHash]
│     if b 存在 ∧ !过期 ∧ b.accountId ∈ 候选  → 直接返回
│     if b 存在但 accountId ∉ 候选           → **不删绑定**，落到 Layer 2
│                                                 （sub2api 语义：被跳过不等于失效）
│     if b 已过期                             → 删绑定，落到 Layer 2
│
└─ 3. Layer 2：负载感知
      mode === 'prefer_soonest_reset'
        ? 按窗口重置时间升序
        : 按 (priority 升序, loadRatio 升序, lastUsedAt 升序)
      loadRatio = inflight(a.id) / max(1, a.loadFactor ?? a.concurrency ?? 1)
      并列 → 稳定 tie-break（按 id），保证可测
```

**绑定的删除策略**（kernel 自己从不删，策略在 adapter）：

| 情形 | 绑定 | 理由 |
|---|---|---|
| 账号**被冷却**（写入了冷却窗口） | **删除** | 账号已不可调度，留着会让会话反复撞它 |
| 账号只是**容量满 / 被本次请求排除** | **保留** | 暂时性，容量一松就该回到原账号（sub2api 语义） |
| 绑定**过期** | 删除 | TTL 到点 |

**粘性键用 DSH 自己的 `sessionId`**，不需要像 sub2api 那样自己算 session hash
（`GenerateOptions` 里现成有 `sessionId`）。

---

## 7. 挂载点：怎么接进 DSH

已实测确认的 API（不是推测）：

| 用途 | API | 证据 |
|---|---|---|
| 打开 domain | `await ctx.storageDomain.open(spec)` → `domain.table('accounts')` | [dsh-workspace.index.js:378](refs/dsh-workspace.index.js) |
| 释放 | `ctx.effect(() => () => domain.close(), 'label')` | 同上 :379 |
| 注册 provider | `ctx.llm.registerAdapter(providers, adapter)` | Service 契约 `llm` |
| 客户端 → 宿主 RPC | 宿主 `harness.handle(method, fn)`；客户端 `host.call(method, args)` | [host-runner.index.js:525](refs/dsh-cordis-host-runner.index.js) |
| 管理面 UI | 客户端 `slots.register({name:'settings.section', id, order, label}, render)` | [usage-report/lib/client.js:439-449](../dsh-usage-report/lib/client.js#L439-L449) |
| 后台巡检 | `ctx.interval` / `jobs` | Cordis timer verbs |

### 主路径：注册一个 `pool` provider

```js
export const name = 'dsh-account-pool';
export const inject = ['storageDomain'];          // llm 用 ctx.get 软获取

export async function apply(ctx, config) {
  const domain = await ctx.storageDomain.open(poolDomain);
  ctx.effect(() => () => domain.close(), 'account-pool: domainClose');

  const accounts = domain.table('accounts');
  const bindings = domain.table('bindings');

  const llm = ctx.get('llm');
  if (llm === undefined) return;

  llm.registerAdapter(['pool'], createPoolAdapter({
    accounts, bindings,
    upstream: config.upstream,     // 每个 platform 怎么发请求
    now: () => Date.now(),
    logger: ctx.logger,
  }));
}
```

`createPoolAdapter` 是纯逻辑 + 一个注入的 `upstream` 调用器：

```js
async *stream(options) {
  const excluded = new Set();
  let switches = 0;
  for (;;) {
    const account = selectCandidate({ ..., excluded, sessionHash: options.sessionId });
    if (!account) throw new LlmError('POOL_EXHAUSTED', ...);
    try {
      for await (const chunk of upstream.stream(account, options)) { yield chunk; }
      onSuccess(account);                     // consecutiveFailures = 0
      bind(sessionHash, account);             // 写粘性绑定
      return;
    } catch (failure) {
      const decision = classifyFailure(failure);
      if (decision.kind === 'none') throw failure;     // 400/abort：直接上抛
      writeCooldown(account, decision);                // 写冷却
      excluded.add(account.id);
      if (++switches > maxSwitches) throw failure;
      // 同账号重试不计入 switches（本方案直接换号，故此处 switches === 换号次数）
    }
  }
}
```

### 辅路径（第一期不做，留作第三期）

- `ctx.on('llm/stream', (options, next) => ...)` —— 全局拦截，可用于给**非 pool provider** 也加降级。
- `ctx.on('agent/request-error', (payload, next) => ...)` —— `RequestErrorAction = {kind:'retry'} | undefined`；
  返回 `{kind:'retry'}` 表示自己接管恢复。适合处理 adapter 重试预算耗尽后的最后一搏。
- `ctx.on('agent/request', (payload, next) => ...)` —— 替换每步的 `provider`/`model`。

---

## 8. 目录结构

```
dsh-account-pool/
├── package.json            # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml        # 往 profile 插一行
├── DESIGN.md               # 本文档
├── lib/
│   ├── kernel.js           # 纯函数：isSchedulable / selectCandidate / classifyFailure / writeCooldown
│   ├── adapter.js          # createPoolAdapter（依赖注入 upstream，可离线测）
│   ├── host.js             # Host 半边：domain + registerAdapter + harness.handle
│   └── client.js           # Client 半边：settings.section 管理页（第三期）
├── refs/                   # 从 app.asar 抽出的 DSH 源码片段（只读参考）
└── tools/
    └── kernel-test.mjs     # 零依赖离线测试
```

**分层原则**：`kernel.js` 与 `adapter.js` **不 import 任何 DSH 模块**，只依赖注入的接口。
这样它们在 `node tools/kernel-test.mjs` 下能零依赖跑，不启动 DSH、不联网。

---

## 9. 测试策略

最小闭环要证明的三件事（对应目标里的"两个账号 + 429 降级 + 粘性"）：

| 用例 | 断言 |
|---|---|
| 粘性命中 | 同一 `sessionId` 两次请求选到同一账号 |
| 粘性被排除时不覆盖绑定 | 账号 A 被冷却后选 B；A 恢复后同 session 又选回 A |
| 429 降级 | A 返回 429 → 写 `rateLimitResetAt` → 本次请求改用 B → 结果正常 |
| **400 不冷却** | A 返回 400 → A 状态**零变化**、不换号、错误上抛 |
| 负载感知 | 同优先级下，`inflight/loadFactor` 小的优先 |
| 优先级 | `priority` 小的优先于负载 |
| 连续失败升级 | 401 三次 → `status='error'` |
| 池耗尽 | 全部不可调度 → 抛 `POOL_EXHAUSTED` |

补一条防回归断言：**任何 `none` 类错误之后，账号表逐字段与调用前相等**。

---

## 10. 分期

| 期 | 内容 | 交付 |
|---|---|---|
| **1（本次）** | `kernel.js` + `adapter.js` + 离线测试，用假 upstream | 测试全绿，不碰 DSH 运行时 |
| 2 | `host.js` 接 domain，用 `llm.registerAdapter` 注册 `pool` provider，实机验证一次真实调用 | 能在 DSH 里选到 `pool` provider 并跑通 |
| 3 | `ctx.credentials` 存凭据、保活巡检（`ctx.interval`）、用量落库、`settings.section` 管理页 | 可日常使用 |
| 4（可选） | 对外网关：`webServer.register({kind:'prefix', path:'/v1'})` + 自建 API Key 鉴权 | 只在真需要时才做 |

---

## 11. 待实测确认的假设

1. ~~**`apply` 是否允许返回 Promise。**~~ **已解决：允许。**
   证据在 Cordis 的 effect 执行器 [cordis.fiber.ts:366-374](refs/cordis.fiber.ts#L366-L374)：
   ```ts
   const effect: Effect = runner.execute.call(this)   // 函数插件即 apply(ctx, config)
   if (typeof effect === 'function') { return runner.collect(effect) }
   else if (isNullable(effect)) { /* return */ }
   else if (!isObject(effect)) { throw new TypeError('Invalid effect') }
   else if ('then' in effect) { return effect.then(safeCollect) }   // Promise 被 await
   ```
   所以 `export async function apply(...)` 合法，**且 resolve 出来的值必须是 disposer 函数或 `null`/`undefined`**，
   否则 `safeCollect` 抛 `TypeError: Invalid effect`。推荐的收尾写法直接是 `return () => domain.close();`。
2. ~~**`ctx.storageDomain` 与 `ctx.storage.domain` 的关系。**~~ **已解决：用 `ctx.storageDomain`。**
   workspace 自身的代码就是 `await this.ctx.storageDomain.open(workspaceDomainSpec)`。
3. **`llm.registerAdapter` 注册的 provider 是否出现在设置里的模型选择器。** 需要
   `llm.registerConfigurableProviders(...)` 配合，第二期验证。
4. **`StreamChunk.usage` 是否每个 platform 都保证发。** 记账要能容忍缺失（`accumulateUsage` 已接受
   `undefined`/`null` 并保持 0）。
5. ~~**第三方插件能否 `import '@deepseek-ai/*'`。**~~ **已解决：不要试，改成手写 spec。**
   见 §13。

---

## 12. 第一期实现记录（已跑通）

代码：[lib/kernel.js](lib/kernel.js)、[lib/adapter.js](lib/adapter.js)、[tools/kernel-test.mjs](tools/kernel-test.mjs)。
`node tools/kernel-test.mjs` → **35/35 通过**，无网络、无 DSH 运行时。

实现过程中定死了三条计划里没写清的语义，都是 correctness 问题：

1. **承诺规则（commitment rule）** —— 一旦已经向消费者 `yield` 过任何 chunk，
   后续失败**不得再换号**，否则会把同一段输出吐两遍。此时仍然写冷却（账号确实坏了），
   但错误直接上抛。因此"开了流立刻用终止 `finish` chunk 报错"是可重试的
   （因为在转发它之前就被拦下），而"吐了几个 delta 之后才炸"不可重试。
2. **切换预算耗尽的语义** —— 用完 `maxSwitches` 后抛出**最后一个上游错误**，而不是
   `POOL_EXHAUSTED`；后者只留给"一开始就没有可调度账号"。前者对调用方信息量更大，
   也与 sub2api 的 failover 循环一致。
3. **`kind: 'none'` 用引用相等来保证** —— `applyCooldown` 在 `none` 时返回**同一个对象**，
   所以测试可以用 `assert.equal(after, before)` 证明"一个字段都没动"，
   而不只是 deepEqual（后者挡不住"写了个等值的新对象"）。

---

## 13. 第二期进展：domain 层落地 + 两个依赖决策

新增 [lib/domain.js](lib/domain.js) 与 [tools/domain-test.mjs](tools/domain-test.mjs)。
当前测试合计 **45/45**（kernel 35 + domain 10）。

### 决策一：手写 domain spec，不 import DSH 内部包

原计划 `import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'`。查证后放弃：

- 从 profile 目录解析不到 `@deepseek-ai/*`（`import.meta.resolve` 失败），它们只存在于 app.asar 内。
- profile 里**唯一一个已发布的第三方插件** `@hytime/dsh-thinking-effort` 的运行时依赖只有
  `@deepseek-ai/schemastery` 和 `yaml`——即"裸导入靠插件自己声明 dependencies、由 pnpm 装进 profile"，
  而不是靠宿主注入 `@deepseek-ai/*`。
- 而那两个 helper 是纯函数（[dsh-storage-domain.index.js:46-76](refs/dsh-storage-domain.index.js#L46-L76)）：
  ```js
  function domainTable(schema) { return { valueSchema: schema }; }
  function defineDomain(spec) { /* 一堆校验，然后 */ return spec; }   // 原样返回
  ```

所以 `lib/domain.js` 直接字面量构造同一形状的 spec，并自带 `assertDomainSpec()` 复刻那几条
eager 校验（版本非负整数、名称 slug、`invalidRecords` 只能 `backup-and-skip`、global schema 不得接受 `null`），
保持"模块加载即 fail-loud"。**唯一的真实依赖是 `zod@^4`**（domain facility 用它校验每条落库记录）。

### 决策二：`baseUrl` 是 nullable 而不是 optional

设计稿 §3 写的是 `z.string().optional()`，但适配器与小节 §3 的样例数据都写 `baseUrl: null`，
而 schema 是 `.strict()` 的——这会在**下一次 `open()`** 时才炸（domain 拒绝加载），而不是在写入时。
已改为 `z.string().nullable().default(null)`，并加测试断言 `baseUrl` 默认就是 `null`。

### 新增的测试思路：把 schema 与适配器焊死

最容易漂移的地方是"适配器写什么"和"schema 收什么"。所以 domain 测试不是静态校验 schema，
而是：**用 schema 造账号 → 让适配器真实跑一遍（含 429 降级、401 三次升级、400 零写入）
→ 校验它通过 `persist` 写出的每一条记录仍然合法**。写入时即校验，漂移会当场失败而不是攒到重启。

---

## 14. 第三期进展：Host 半边接线完成（仍未实机安装）

新增 [lib/host.js](lib/host.js)、[tools/host-test.mjs](tools/host-test.mjs)、
[cordis.patch.yml](cordis.patch.yml)、[README.md](README.md)。
测试合计 **58/58**（kernel 35 + domain 10 + host 13）。

`mountPool(ctx, options)` 是唯一动服务的地方，`apply` 只是它的薄壳，所以假 ctx 就能全测：
开 domain、按 Config 对账账号、把三张表接成适配器的 persist、注册 `pool` provider、
挂两条认证只读路由（`/api/accountPool.accounts`、`/api/accountPool.usage`）、定时清扫过期绑定。

### 三个降级决策

1. **没有 upstream 就不注册 provider**，只记一条 warn 进"仅管理"模式。
   注册一个够不到任何东西的 provider，比不注册更糟——调用方会选到它然后失败。
2. **`llm` / `connection` 用 `ctx.get()` 软获取**，缺哪个就少哪个能力并记日志；
   只有 `storageDomain` 是硬依赖（`inject`），因为池子没有持久化就没有意义。
3. **对账保留运行时状态**。Config 里的账号只刷新 operator 拥有的静态字段
   （priority / concurrency / baseUrl / models / …），冷却窗口和计数器一律保留——
   否则每次重启都会清掉冷却，把池子直接送回限流中的账号。

### 测试抓到的三个真 bug

1. **`inject` 写错**：host.js 里硬用了 `ctx.storageDomain`，却只声明了 `inject = ['connection']`。
   按 Cordis 语义，没声明的服务不会出现在上下文属性上 → 运行时 `undefined`。
   应该是 `inject = ['storageDomain']`（设计稿 §7 本来就是对的，是我写实现时写歪了）。
2. **适配器构造函数过严**：原来要求 `upstream` 必须存在，导致"仅管理"模式连构造都过不去。
   改成惰性——构造时可缺，真正 `stream()` 时才抛 `POOL_NO_UPSTREAM`。
   这样没有传输层时，`listAccounts` / `pruneBindings` / 手动改号这些管理投影仍然可用。
3. **`dispose` 不幂等**：`routeDisposers.reverse()` 会原地改数组，二次 dispose 会把
   路由 disposer 再跑一遍。改成 `[...routeDisposers].reverse()` + `disposed` 标志。

### 仍未做

- **实机安装验证**：需要把 bundle 装进 `desktop` profile，确认 fiber 变 active。
  这会改动用户的 profile（可回退），等确认后再做。
- **上游 HTTP 传输**：真正向 `account.baseUrl` 发请求、把 SSE 映射成 `StreamChunk`。
  这是"能真的跑流量"的最后一块。
- **Client 管理页**：`settings.section` 一页，走 `host.call` 或现有认证路由。

---

## 15. 第四期进展：上游传输完成，全链路打通

新增 [lib/upstream.js](lib/upstream.js) 与 [tools/upstream-test.mjs](tools/upstream-test.mjs)。
测试合计 **73/73**（kernel 35 + domain 10 + upstream 15 + host 13）。

`createHttpUpstream({ fetchImpl, resolveCredential })` 支持两种方言：
Anthropic Messages（`/v1/messages`，`x-api-key` + `anthropic-version`）与
OpenAI Chat Completions（`/v1/chat/completions`，Bearer；`custom` 平台复用）。
`fetch` 与凭据解析都是注入的，所以这层也能离线测——假 fetch 返回**真实 `Response` 对象**，
代码走的是真的 `ReadableStream` + `TextDecoder`，只有 socket 是假的。

账号表新增 `credentialRef`（`z.string().nullable()`）。**密钥本身绝不落 domain**：
那一行会被校验、记日志、并通过管理路由返回，把 token 放进去等于在三个面上泄一遍。
真正的解析留给第三期的 `ctx.credentials`。

### 五条正确性决策

1. **`block-end` 必须携带真实 block。** 起初我打算发 `{}` 占位，但消费者会把 `block-end`
   当作权威内容；发一个假 block 比不发更糟。所以两种方言都累积块内容，`block-end` 带真值。
2. **终止性 `finish` chunk 在转发之前拦下。** 与 adapter 的承诺规则呼应：上游用
   `finish{reason:'error'}` 报错时，只要还没吐过 delta 就仍可换号；一旦吐过就只能上抛。
3. **`retry-after` 驱动冷却窗口**，而不是用默认 60 秒——上游明确告诉了我们要等多久。
   同时 clamp 到 6 小时：上游给一个荒谬值不能把账号停一周。
4. **图片/文件显式抛 `POOL_UNSUPPORTED_CONTENT`**，不静默丢弃。静默丢内容会让用户以为
   模型"没看见图"，而实际上是我们的传输层没送。
5. **配置类错误不该冷却账号——这条是本轮修掉的一个真缺陷。** 起初
   `POOL_NO_CREDENTIAL` / `POOL_UNSUPPORTED_CONTENT` / `POOL_NO_UPSTREAM` 都不带 `status`，
   于是被 `classifyFailure` 归进 `transport`，把账号停 5 分钟。但它们是**我们自己的配置问题**，
   在**每个账号上都会以同样方式失败**——冷却一个账号只是白烧池子，换号也毫无意义。
   现在有了显式的 `CONFIG_ERROR_CODES` 集合归入 `kind: 'none'`（与 400 同类）：
   错误照常上抛给调用方，但账号状态零改动、也不触发换号。

### 测试抓到的 bug

`parseSse` 里写了 `const drain = function* drainComplete() {...}` 却调用 `yield* drainComplete()`——
命名函数表达式的名字只在自身内部可见，赋值给 `drain` 就意味着外部没有 `drainComplete`。
7 个测试一起炸，一眼定位。

### 最有价值的一项测试

`upstream-test.mjs` 最后一段是**全链路**：真实 `Response` 承载一个带 `retry-after: 30` 的
真 429 → `createHttpUpstream` → `createPoolAdapter` → kernel。断言三件事：
只换号一次且顺序正确、冷却窗口是上游给的 **30 秒**（不是默认值）、以及同一会话下一轮
**直接粘回 a2、不再碰 a1**。这是第一次端到端证明"传输 → 降级 → 冷却 → 粘性"整条链是通的。

### 仍未做

- **实机安装验证**：把 bundle 装进 `desktop` profile，确认 fiber 变 active、domain 在真实
  存储后端上打开。会改动用户 profile（可回退），待确认。
- 其它已知语义缺口：`POOL_EMPTY_BODY`（200 但无 body）目前按 `transport` 冷却——
  这是有意的，上游行为异常时短暂停调是合理的；但若实际观察到此码频繁出现，应重新归类。

---

## 16. 第五期进展：Client 管理页完成

新增 [lib/client.js](lib/client.js) 与 [tools/client-test.mjs](tools/client-test.mjs)。
测试合计 **135/135**（kernel 36 + domain 10 + upstream 16 + host 13 + client 60）。

`settings.section` 注册了一页「账号池」，读 Host 那两条认证路由，显示：
三张汇总卡（账号数/可用·冷却·异常、累计请求、粘性绑定）、账号表
（标签、平台、状态胶囊、优先级、并发、**冷却倒计时 + 原因**、连续失败）、最近 50 条用量
（时间、账号、模型、输入/输出/缓存读、换号次数、结果）。

手写 JS、无构建步骤，形态抄的是同目录里已经在跑的 `dsh-usage-report`：
`window.__ModuleLoader__.load` + `require('react')` + `createElement`。

### 几个刻意的决定

1. **主题令牌是查出来的，不是猜的。** 先调 `cordis Theme` inspect provider 拿到真实的
   `--dsw-alias-*` 名单（`--dsw-alias-bg-layer-1`、`--dsw-alias-state-warn-primary`、
   `--dsw-alias-label-secondary` …）再写 CSS。radius 没有令牌，用 `var(--dsw-radius-sm,6px)` 兜底。
2. **倒计时是本地滴答，不重新拉数据。** 每秒 `setNow`，冷却剩余由三个窗口里**最远的那个**算出来——
   页面永远不会少报等待时间。
3. **`auth-fail` 与 `transport` 分开显示。** 两者共用 `tempUnschedulableUntil` 字段，
   靠 `tempUnschedulableReason` 区分，否则"鉴权失败"会被笼统显示成"传输故障"，
   而那两种情况的处置完全不同。
4. **密钥不上页面。** 账号行只有 `credentialRef`（不透明句柄），页面读到的就是这些。

### 假 React 的三处不忠实（测试自己抓出来的）

离线渲染的难点在于：假渲染器只要有一点和真渲染器不同，测试就会误报。三处：

1. **`createElement` 必须把 children 折进 `props`。** 我最初的假实现只放在 `node.children` 上，
   于是 `Pill` 读 `props.children` 拿到 `undefined`——真 React 是会折进去的。
2. **惰性组件必须展开。** `h(Card, {...})` 在没有渲染器时**只是数据**，不是渲染结果。
   所以测试里写了一个 `expand()`，把无 hook 的函数组件递归调用掉
   （这页里只有 `PoolSection` 用 hook，且是显式调用的，所以展开子组件不会打乱 hook 游标）。
3. **className 要拆成 token。** `classesIn` 原先把整个 `"dap-pill dap-pill-ready"` 当一个元素推入，
   于是 `includes('dap-pill-ready')` 恒为 false。这个误报最难查——类名在 dump 里明明"看得见"。

第 3 条我一开始以为是渲染 bug，把类名清单打进失败详情才看清是断言的问题。

### 仍未做

- **凭据走 `ctx.credentials`**：目前账号只有 `credentialRef`，没有真实的密钥解析。

---

## 17. 第六期：切换能力 + 实机安装

测试合计 **167/167**（kernel 41 + domain 10 + upstream 16 + host 16 + client 84）。

### 新增：账号级与提供商级切换

- **账号级**（`applyAccountAction`，纯函数 + 单一写路由 `POST /api/accountPool.account`）：
  `enable` / `disable` / `prefer` / `clear-cooldown` / `set-priority`。
  刻意保持正交——**`enable` 不会顺手清掉冷却窗口**。窗口是上游对自己额度的陈述，
  只有时间（或显式的 `clear-cooldown`）能解除；把两者合并会让"重新启用这个账号"
  静默覆盖一个真实的限流，正是那种会换来封号的悄悄越权。
- **`prefer`** 把优先级设成**严格低于**所有兄弟账号，所以它在优先级这个键上直接胜出，
  而不是打平后掉到负载率比较——这就是"随便切换"的实现。
- **提供商级**：`llm.registerConfigurableProviders([{provider:'pool', settingsNs: <Loader 条目 id>, settingsPath: []}])`，
  `settingsNs` 用的是**条目 id**（官方 DeepSeek provider 也这么写），因为那正是 Models 卡片要编辑的设置文档；
  `settingsPath: []` 表示整份文档就是该 provider 的配置。
- **入口三处**：设置导航的「账号池」页（`settings.section`）、「模型」页新增控件下方的
  「号池管理」卡片（`settings.models.footer`）、以及 `pool` provider 卡片上的摘要
  （`settings.models.provider-card`，key = 条目 id）。

**一处产品决定**：没有上游传输时**不注册也不声明** provider。声明一个选不动、够不到的
provider 比不声明更糟——同一条理由上一期已用在 `registerAdapter` 上，这次只是把它贯彻到目录层。

### 实机安装：两个只有真跑才会暴露的问题

安装本身成功（pnpm link 进 `desktop` profile），但**激活失败**：

```
StorageError: invalid unit name 'account-pool'
  at validateDescriptor (dsh-storage-json/lib/index.js:590)
```

1. **我手写复刻的姓名校验器是错的。** 真实规则在 `@deepseek-ai/dsh-storage` 里是
   `/^[a-z][a-z0-9_]*$/` —— **下划线，没有连字符**。我按直觉写成 `/^[a-z][a-z0-9-]*$/`，
   于是本地 167 项测试全绿、`assertDomainSpec()` 也放行，只有真实 `open()` 才拒绝。
   域名已改为 `account_pool`，并把这条正则连同它的出处一起写进 `lib/domain.js` 的注释。
   教训很直白：**别手写复刻厂商校验器**；复刻了一份就必须把它当作"待验证的猜测"，而不是事实。
2. ~~**相对依赖不参与热重载**~~ —— **本条的结论已被推翻，见 §19**。
   当时我看到堆栈行号与磁盘文件逐行吻合，就断定"条目模块被重新导入了"。
   实际原因是**开机加载的就是那份文件**，所以那个观察什么也证明不了。
   真相是：条目重载**不会重新导入任何模块**，宿主侧任何改动都要重启进程。
   这条已写进 [cordis.patch.yml](cordis.patch.yml) 的注释，因为它是使用这个插件时最容易踩的坑。

### 仍未做

- **凭据走 `ctx.credentials`**：没有它，`pool` provider 拿不到密钥，`upstream` 也无从构造，
  所以插件装上后是"仅管理"模式。
- **管理页写操作的乐观更新**：现在每次动作后整表重取，够用但不精致。

---

## 18. 对照 new-api：采纳了两条，明确放弃了几条

参考对象：[QuantumNous/new-api](https://github.com/QuantumNous/new-api)（AGPL-3.0，Go + GORM，
~49k star）。本地稀疏克隆在 [_newapi/repo](../_newapi/repo)，只取了
`model/` `controller/` `service/` `middleware/` `common/` `relay/` `setting/`。

它是这个品类里最早也最成熟的项目，确实有几处比 sub2api 和我这版都更干净。

### 它的核心结构

**`Ability` 表**（[ability.go:18-26](../_newapi/repo/model/ability.go#L18-L26)）是一张
**物化的路由索引**：`(group, model, channel_id)` 三主键，带 `enabled / priority / weight / tag`。
渠道一改就重建它的 abilities。选路于是变成索引查找，而不是"遍历渠道再逐个判断支持哪些模型"。

### 选路：优先级是"重试层"，同层用加权随机

[channel_cache.go:117-217](../_newapi/repo/model/channel_cache.go#L117-L217)（内存热路径）
与 [ability.go:108-164](../_newapi/repo/model/ability.go#L108-L164)（DB 路径）是同一套语义：

1. 取该 `(group, model)` 下的候选，收集**去重后的优先级**并降序排序；
2. `retry` 命中第 N 个优先级 —— 也就是**优先级 = 备用顺序**：重试第 N 次就下探到第 N 层；
   `retry` 超出层数则夹到最后一层；
3. 在**该层内**按 `weight` 加权随机抽一个。

加权随机带三条平滑规则（`channel_cache.go:188-200`）：权重全为 0 时按 `n*100` 等概率；
平均权重 < 10 时整体 ×100；否则直接按权重占比累积游走。**权重 0 的渠道不会被饿死**。

### 错误处置：策略是配置数据，不是分支

[service/channel.go:57-77](../_newapi/repo/service/channel.go#L57-L77) 的 `ShouldDisableChannel`
按顺序判断：`IsChannelError` → 真；`IsSkipRetryError` → **假**（"别重试"不等于"禁用渠道"，
这是两个正交的轴）；再查 `ShouldDisableByStatusCode`（**支持通配符**）；最后对错误正文做
**关键词匹配**（Aho-Corasick）。配套还有 `AutomaticDisableChannelEnabled` 全局开关、
`IsAlwaysSkipRetryCode/StatusCode` 排除表。
[relay_error.go:21-58](../_newapi/repo/service/relay_error.go#L21-L58) 的 `DecideRelayRetry`
返回 `PolicyDecision{Action, Reason, Source}` —— **每个决策都带原因与来源**，写进请求日志。

### 禁用状态：自动 vs 手动是两种状态，且只有自动的能被自动恢复

`ChannelStatusEnabled` / `ChannelStatusAutoDisabled` / `ChannelStatusManuallyDisabled`，
而 [ShouldEnableChannel](../_newapi/repo/service/channel.go#L79-L90) **只**自动恢复
`AutoDisabled`——手动停用的永远不会被自动打开。

### 亲和（粘性）是一个一等概念

[channel_affinity.go](../_newapi/repo/service/channel_affinity.go) 1020 行：规则名、TTL、
key 来源（参数模板 / 正则 / JSON path）、内存+Redis 混合缓存，以及一个我没想到的开关
——**`SkipRetry`**：严格会话下，粘性失败时**宁可让请求失败也不换渠道**
（对依赖 prompt cache 的负载，悄悄换号的代价可能大于报错）。

### 采纳了什么（已实现 + 已测）

1. **失败策略改成数据**：`DEFAULT_FAILURE_POLICY` + `matchesStatus`（支持 `'5xx'` 这类通配），
   `classifyFailure(failure, account, now, policy)` 接受覆盖。
   默认值与它替代的硬编码表**逐条等价**（有测试钉住），所以这次改造是行为中性的。
   `keywordRules` **默认为空**——按正文匹配是"池子被无关措辞拖进冷却"的经典成因，必须显式开启。
   而且**状态码规则先于关键词求值**，所以一个把 400 写成 "rate limit exceeded" 的上游不会被误判。
2. **`weight` + `weightedPick` + `weighted-random` 选路模式**：平滑规则照搬（全 0 等概率、
   均值 <10 时 ×100、否则权重游走），`random` 可注入所以分布可精确断言
   （测试验证了 3:1 恰好落在 0.75，以及 25/75 的实际分布）。

### 明确没有采纳的（附理由）

| 它的做法 | 为什么这里不做 |
|---|---|
| `Ability` 物化索引 | 自用规模是个位数账号，`models.includes()` 的 O(n) 扫描更简单也更难写错；账号上百再说。**但形状记下了**。 |
| Aho-Corasick 关键词引擎 | 需要引库 + 配置面；几条规则的 `String.includes` 在这个规模等价。 |
| 内存+Redis 混合亲和缓存、集群广播 | DSH 是单进程。我的「内存快照为准 + 写穿 domain」正是这个规模该有的形状。 |
| 每次请求带 `PolicyDecision` 写日志 | 我已有 `attempts[]` 与决策上的 `reason`；没有请求日志存储，完整决策链是空转。 |
| 探测成功后自动启用 `AutoDisabled` | 我没有主动探针；`error` 账号只能靠显式 `clear-cooldown` 复活。**这是已知缺口**。 |
| 多渠道 key（一个渠道内一组 key） | sub2api 叫 spark 影子账号；超出本期范围。 |

### ⚠ 一个必须记住的相反的约定

**优先级方向是反的。** new-api 排序 `priority DESC`、**数值越大越先试**
（[ability.go:115](../_newapi/repo/model/ability.go#L115)、`:163`）；
这个池子相反：**数值越小越好**，因为 `prefer` 要能设成 `min - 1`。
照抄它的任何一条规则前，先把大小号翻过来——这是一类很难在测试里发现、上线才炸的错。
已写进 `selectCandidate` 的文档注释。

### 顺带一句：它把 `weight` 存成 uint 并用整数 rand

那些 `+10` / `×100` 的平滑**不是**审美，而是为了让"整数权重 + 整数随机"在各种极端
（全 0、均值极小）下仍然是可控分布。我照搬了这套数学，包括两个分支的常量。

---

## 19. 实机排障：三个 bug，其中一个是我自己的错误结论

用户重启后，页面渲染正常但报 **HTTP 404**。排查链如下，每一步都留了证据。

### 证据 1：进程确实重启了，domain 确实打开了

进程启动时间 20:48:36，而 `~/.dsh/storages/account_pool.json` 于 20:48:40 被写入，
里面是两个账号（`weight` 默认 0 已落库）。所以域名修复**生效**、`open()` 成功，
失败点在 `open()` **之后**。

### 证据 2：`ctx.get` 走的是只由 `inject` 填充的 isolate 映射

[refs/cordis.index.js](refs/cordis.index.js) 的 `_getImpl`：

```js
_getImpl(name, strict = true) {
  const key = this.ctx[symbols.isolate][name];
  const impl = key && this.store[key];
  if (!impl) return;
  if (strict && impl.fiber.state !== 2) return;   // 2 = ACTIVE
  return impl;
}
```

而这张 isolate/intercept 表，是 [cordis.fiber.ts](refs/cordis.fiber.ts) 里**遍历插件自己的 `inject`** 填出来的。
我的插件与提供 `connection` / `llm` 的条目是 `include` 下的**兄弟**，兄弟的服务不声明就看不见。

→ **bug 1：`inject` 只写了 `['storageDomain']`。** 于是 `ctx.get('connection')` 返回 `undefined`、
路由一个都没注册 → 404；`ctx.get('llm')` 同样为 undefined，`pool` provider 也不会注册。
而 fiber 本身是**成功激活**的，所以除了我埋的一条 warn，没有任何地方报错。

**撤回一条我自己写错的判断**：原设计说"`llm`/`connection` 软获取，缺了就优雅降级"。
软获取**仍然要求该服务可达**，而可达性由 `inject` 决定。声明三个是修复，不是仪式。
运行时检查（服务存在但缺方法）保留。

### 证据 3：domain 句柄泄漏

修完 `inject` 后重载，报 `DomainError: domain 'account_pool' is already open`。

→ **bug 2：我把 domain 的释放只挂在 `apply` 返回的 disposer 上。**
只要 `open()` 之后的任何一步抛错，那个返回值就永远不会被收集，句柄泄漏、名字被永久占用，
之后每次挂载都失败。而正确写法我**早就读过**——`dsh-workspace` 的
`ctx.effect(() => () => domain.close(), 'workspace.domainClose')`——却没有照做。

修复两条：
- 拿到 domain **之后立刻**用 `ctx.effect` 注册释放（在其它工作之前），任何后续抛错都会走 fiber 清理；
- `openDomain()` 遇到 `already-open` 时，从 facility 取回泄漏的句柄、关掉、再重开，
  用于拯救**已经**泄漏的进程。取不到句柄（说明是真的并发占用）就原样抛出，绝不静默抢占。

### 证据 4：条目重载根本不会重新导入模块

修完句柄泄漏后再重载，**报的还是旧错误**，且堆栈里的 `host.js:111` / `host.js:332`
与当前文件完全对不上（当前文件里 open 调用在 149 行、总行数 410）。

→ **bug 3：我上一期的结论是错的。** 当时我看到行号吻合，就断定"条目模块被重新导入了"。
真相是**开机加载的就是那份文件**，那个观察证明不了任何事。
实际行为：**Node 的 ESM 缓存活到进程结束、加载器不清除它；禁用再启用条目会重新执行 `apply`，
但不会重新导入任何模块。** 所以宿主侧任何改动都必须**重启 DSH**；只有 `lib/client.js`
走 HTTP 取 bundle，能靠刷新页面热重载。

已同步写进 [cordis.patch.yml](cordis.patch.yml) 与 [README.md](README.md)——
这是这个插件日常开发里最容易浪费时间的一条。

### 证据 5（真正的根因）：`ctx.interval` 在没声明 `timer` 时**读取即抛错**

修完上述两条后重启，页面依旧 404，而且自检文件根本没生成 → `mountPool` 没跑完。
`set_plugin` 回报了真正的异常：

```
Error: cannot get property "timer" without inject
  at mountPool (host.js:350:18)
```

第 350 行正是 `if (typeof ctx.interval === 'function')`。

**`ctx.interval` 不是普通属性，而是 Cordis 的服务访问器**：服务未声明时，读它会抛
`cannot get property "timer" without inject`，而不是返回 `undefined`。于是
`typeof ctx.interval` 直接把整个挂载炸掉。

这一行**同时解释了最早那次失败**：当时 `inject` 只有 `storageDomain`，同一个 `ctx.interval`
抛错发生在 `open()` 与账号对账**之后**——所以 domain 文件写出来了、句柄泄漏了、
路由一个没注册、页面报 404。**三个现象，一个根因。**

同时确认：`inject` 补 `connection` / `llm` 是**必要但不充分**的。即使没有这个抛错，
`ctx.get('connection')` 返回 `undefined` 也会让路由被跳过，结果同样是 404。两条都得修。

修复：`inject` 补上 `timer`；并把该访问包进 try/catch，让"没有 timer"只损失清扫任务、
而不是整个插件。测试里加了一条专门复现它的回归用例（假 ctx 的 `interval` 用 getter 抛错）。

**通用教训**：Cordis 上下文上凡是**服务**，未声明时要么不可见（`ctx.get` 返回 `undefined`）、
要么**直接抛错**（属性访问）。"先用 `typeof` 探一下再用"这个习惯是危险的——探测本身就可能抛。

### 新增：挂载自检

为了不再出现"页面 404、日志无声"这类哑失败，`mountPool` 支持 `statusDumpPath`：
挂载时把**实际解析到的东西**写成 JSON——三个能力各自是否可达、adapter / provider 声明、
路由条数、账号数、entry id。[cordis.patch.yml](cordis.patch.yml) 已默认开启，
写到 `~/.dsh/account-pool-status.json`。下次再遇到 404，先看这个文件。

---

## 20. 分组：补上 new-api 的 `(group, model)` 那一维

在此之前这个池子是**扁平的**：全部账号在一个平面里按优先级/权重/粘性排序。
而 new-api 的 `Ability` 表主键就是 `(group, model, channel_id)`，sub2api 也有
`groups` + `account_groups`（**组内独立 priority**）。少了这一维，
"这批便宜号只服务这个场景、那批贵的服务另一个"就表达不出来。

### 数据模型

- `groups` 表：`id`（slug，**它就是路由后缀**）、`label`、`description`、
  `models[]`（在账号自身 `models` 之上再加一层白名单）、时间戳
- `account.groups: string[]`，`.default([])`

### 四个决定

1. **空的 `groups` 表示"只属于默认池"，不是"属于所有组"。**
   如果反过来，**新建一个组就会自动吞掉全部已有账号**，组永远不可能是一个刻意挑选的子集。
   这条最容易写反，所以在代码、测试、这里各写了一遍。
2. **一组一条 provider 路由**：`pool` 是全集，`pool-<id>` 是单组。
   DSH 里最自然的"把组绑到某个东西上"的位置就是 **provider 路由**
   （new-api 绑 token、sub2api 绑 API Key）。组因此成为**模型页里可切换的东西**，
   而不只是一个只能看的数据字段。
3. **过滤发生在候选集上，内核一行未改。**
   `candidatesFor(provider, model)` 在进 `selectCandidate` **之前**筛账号，
   于是选路、冷却、粘性、加权随机、降级循环**全部自动继承**，
   `kernel.js` 至今没有出现过"组"这个词。
4. **未知组返回"没有候选"，不回退整池。**
   回退会把"路由名拼错"这种配置错误伪装成一切正常的真实流量。宁可 `POOL_EXHAUSTED`。

### 生命周期

| 动作 | 行为 |
|---|---|
| 建组 / 删组 | `refreshRoutes()` 用 `registerAdapter` 返回句柄的 **`.replace(providers)`** 换路由表，**不重挂适配器** |
| 改组（名称/白名单/说明） | 同上；**`id` 建后不可改**，因为它就是路由后缀，改名等于悄悄换掉别人已选中的路由 |
| 删组 | 只摘除归属，账号存活；响应回 `detached` 列出被改的账号——组是账号的**视图**，不是所有者 |
| 账号引用不存在的组 | 写入时 400 `unknown-group`（否则拼错组名会让账号**静默地**不属于任何组） |
| 导入 | 可选目标组。sub2api 备份本身没有分组概念，所以这是**导入选项**而不是解析字段；目标组不存在则整批拒绝，一个都不写 |

### 为什么 `DOMAIN_VERSION` 仍是 1

这次是**纯加法**：多一张表 + 一个带默认值的字段。旧记录照常打开（新表读出来是空的）。
升版本理论上更正规，但那要求存储后端**真的实现** `compatibleVersions` 的兼容读取——
我无法离线验证，而一旦它不支持，`open()` 会直接失败，插件整个挂不上。
所以：**纯加法的格式改动不升版本**；等真的出现不兼容的字段变更时再升，并同时声明 `compatibleVersions`。

### 本目标内仍未做

- **组内独立优先级**（`account_groups`：账号 × 组 × priority）。即同一个账号在 A 组排第 1、
  在 B 组排第 5。这是 goal 里的**可选项**，用户未要求，因此没做。
- **组级配额/倍率**（sub2api 的 `daily_limit_usd` / `rate_multiplier`）——不在本目标内。

测试合计 **251/251**（kernel 54 + domain 13 + upstream 16 + host 30 + client 120 + importer 18）。

---

## 21. Claude Code 模式：一个模块组，不是一个函数

§1 把「上游身份伪装」整条划掉了，理由是它是 sub2api 工作量的主体、且属于持续对抗维护。
这条现在被**有条件地**推翻：伪装以**账号级、默认关闭**的开关存在（`account.mimicry === 'claude-code'`），
不需要的人完全不受影响。推翻它的理由不是"功能齐全好看"，而是一个硬约束：

> Anthropic 把**订阅号（OAuth）凭据**限定给 Claude Code 使用。一个拿着订阅号的池子，
> 不伪装成官方 CLI 就一个号也用不了——要么被判非官方客户端而走 extra usage 计费，要么直接被拒。

### 21.1 为什么是「模块组 + 若干小模块」

一开始它是一张 `lib/mimicry.js`。那样能用，但把三件**互相独立、各自会错**的事焊在了一起：

- beta 集合错 → 请求被判第三方（降级计费）；
- 指纹算法错 → `cc_version` 与真实 CLI 不一致；
- `user_id` 帧格式错 → 单次请求内部自相矛盾。

三者是三个 bug、三种修法、三种现象，焊在一个文件里就一个都看不见。所以拆成
`lib/claude-code/` 一个模块组，由组里的**控制器**按固定顺序执行若干**只负责一件事**的小模块：

| 小模块 | 它唯一负责的那件事 | 来源 |
|---|---|---|
| `betas.js` | 该 auth mode 有权声明的 `anthropic-beta` 集合 | sub2api `FullClaudeCodeMimicryBetas` / `APIKeyBetaHeader` |
| `identity.js` | 持久的 device_id / account_uuid / session_uuid | sub2api `identity_service.go` |
| `billing.js` | `x-anthropic-billing-header` 归因块与 `cc_version.{fp}` 指纹 | `gateway_billing_block.go` |
| `system.js` | 三块 `system` 数组 + 把调用方 system 迁进对话历史 | `gateway_claude_oauth_body.go` |
| `metadata.js` | `metadata.user_id` 的两种帧格式与解析 | `metadata_userid.go` |
| `defaults.js` | 真实 CLI 必发字段（`temperature`、`tools`、thinking 打开时的 `context_management`） | `gateway_claude_oauth_body.go` |
| `model.js` | 会拒绝 CLI 常规字段的模型族（Opus 5.5 拒 `temperature`） | 同上 |
| `headers.js` | CLI 请求头集合（UA / X-Stainless-* / session id / Accept） | `header_util.go` + `gateway_upstream_request.go` |

外加两个叶子模块：`constants.js`（全部常量，不 import 任何东西——kernel 也从这里取模式词表，
所以内核仍然是零依赖的）与 `hash.js`（身份与计费共用的 SHA-256/UUID 原语，抽出来是为了
**两者不可能各自漂移**）。`version.js` 单独放版本算术，因为版本要同时决定 UA、`cc_version`
和 `user_id` 的帧格式。

### 21.2 执行顺序是契约，不是偏好

```
betas → identity → billing → system → metadata → defaults → headers
```

- `identity` 必须在 `metadata` 之前（它产出三元组），也必须在 `headers` 之前（session id 要和 `user_id` 一致）；
- `billing` 必须在 `system` 之前（`system[0]` 就是那块归因文本）；
- `betas` 必须在 `headers` 之前（后者发布 beta 头）；
- `headers` 放最后，因为它是唯一需要看到全部已解析值的模块。

控制器还有两条**不是防御性填充**的保证：

1. **版本只解析一次**，放在 plan 上。UA 里的版本、`cc_version` 里的版本、`user_id` 该用哪种帧格式，
   全部读同一个值——单次请求内部自相矛盾，恰恰是上游"这真的是 CLI 吗"检查要找的东西。
2. **拒绝二次执行**。第二次跑会把**我们自己刚拼好的三块 system** 当成"调用方的 system 提示词"
   再迁进对话历史，产出一个一眼假的请求。`isAlreadyDisguised()` 从 `system[0]` 是不是计费块来判定，
   并有专门的回归用例。

### 21.3 身份是**推导**的，不是随机存下来的

sub2api 生成 32 字节随机 `client_id` 然后冻在缓存里（7 天 TTL、只升不降、无重置入口）。
本插件改成**从账号 id 推导**：

```js
deviceIdFor(account) = sha256('account-pool:device:' + account.id)      // 64 hex
accountUuidFor(account) = uuidFromSeed('account-pool:account:' + account.id)
sessionIdFor(account, sessionId) = uuidFromSeed('account-pool:session:' + id + '::' + sessionId)
```

要的性质完全一样（**在账号生命周期内恒定**、跨重启不变），而且推导还额外拿到三点：
不需要写路径、不可能漂移、整组保持纯函数。需要指定值的场景用账号字段钉死
（`mimicryClientId` / `mimicryAccountUuid`）。

`sessionId` 用的是**调用方已经给的 `sessionId`**（也就是粘性路由的键），而不是 sub2api 那种
"账号 + 客户端区分因子 + 首条 user 文本"的近似——本插件不是无状态代理，有真实的会话标识可用。

### 21.4 伪装到底复刻了什么

- **请求头**：`claude-cli/<ver> (external, cli)` 的 UA、`x-app: cli`、全套 `x-stainless-*`
  （lang js / package-version 0.94.0 / OS Linux / arch arm64 / runtime node / v24.3.0）、
  `anthropic-dangerous-direct-browser-access: true`、`x-claude-code-session-id`、`x-client-request-id`、
  流式请求的 `x-stainless-helper-method: stream`。
  `Accept` 是 **`application/json`**，不是 `text/event-stream` —— 真实 CLI 即使在流式请求里也这么发
  （`stream: true` 在 body 里，响应本来就是 SSE），`text/event-stream` 反而是"客户端预协商响应格式"
  的第三方形态。
- **请求 URL**：`/v1/messages?beta=true`。CLI 恒定带这个查询串（sub2api 的 `claudeAPIURL` 与中继
  URL 都带），少了它 URL 就是整条链路上唯一一个没有任何 CC 客户端发过的东西。
- **beta 集合**：OAuth 用官方全套（含 `oauth-2025-04-20`）；API-key 用不含 `oauth-*` 的那套。
- **system 三块**：
  `[0]` 计费归因块（不带 `cache_control`，与真实 CLI 一致）→
  `[1]` `You are Claude Code, Anthropic's official CLI for Claude.`（也不带）→
  `[2]` 工具无关的通用提示词扩充段（**带** `cache_control: ephemeral/5m`，作为稳定缓存断点）。
  第 `[2]` 块是**逐字**的：包含末尾的 `# Tone and style` 整段，只剔除会污染被代理用户行为的
  工具专属章节（`# Doing tasks` / `# Using your tools` / `# Executing actions`）。
- **调用方的 system 被迁移，而不是被前缀**。sub2api 的注释点破了"只前置 banner"为什么不成立：
  检测读的是整个 `system` 参数，banner 后面仍是非 CLI 文本，照样判第三方。所以原始 system 文本被搬进
  对话历史（一条 `[System Instructions]\n…` 的 user 轮 + 一条 `Understood. I will follow these instructions.`
  的 assistant 轮），`system` 只剩上面三块。两个细节：
  - **判定用前缀，不用等号**。真实 CLI 不止一个 banner：标准 CLI、Agent SDK、Explore Agent、
    compact/summarise agent 各有自己的开场白，四个都是第一方。所以 `shouldMigrateSystem()` 走
    `CLAUDE_CODE_PROMPT_PREFIXES` 前缀表——把 Agent SDK 的请求当"外来文本"处理，会凭空加一轮
    真实 CLI 永远不会发的 user/assistant，正是这组模块要避免的那种自相矛盾。
  - **调用方的 `cache_control` 跟着文本一起搬**。缓存断点是**计费字段**：丢一个，调用方的缓存前缀
    就每一轮按全价重算。取原 system 里**最后一个**断点（块被合并成一条消息后，最后一个是最接近的边界）。
- **`metadata.user_id`**：CLI ≥ 2.1.78 用内嵌 JSON，更早用 `user_<64hex>_account_<uuid>_session_<uuid>`。
  帧格式由同一个版本号决定。
- **计费指纹**：`sha256("59cf53e54c78" + 首条 user 文本的第 4/7/20 个字符 + 版本).slice(0,3)`。
  索引用的是 **UTF-8 字节偏移**（原实现是 Go `string[i]` 的字节语义）。用 UTF-16 码元索引在纯 ASCII
  下完全一致、在第一条消息含中文时才会分叉——所以专门有一条**差分回归用例**，同时断言"等于字节解、
  不等于 UTF-16 解"。
- **CLI 必发字段**：`temperature`（默认 1）、`tools`（没有也要发 `[]`）、以及 thinking 打开时的
  `context_management`。最后一项不是装饰：beta 集合里声明了 `context-management-2025-06-27`，
  却没有对应的 body 字段，是一次请求内部的自相矛盾。真实行为是
  `thinking.type ∈ {enabled, adaptive}` 且调用方没传时补
  `{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}`。
  补字段的门是**这次请求实际声明的 beta**（`CONTEXT_MANAGEMENT_BETA` 只声明一次，betas 与 defaults
  两个模块都读它）：OAuth 那套含该 token 所以补，API-key 那套不含所以不但不补，调用方传了还会**删掉**
  ——头里有、体里没有和体里有、头里没有，都是上游用 400 回答的同一类不对称。
- **Opus 5.5 不发 `temperature`**：这一族模型**拒绝**该字段，真实 CLI 因此不发。无脑补
  `temperature: 1` 会把一次忠实请求变成 400，所以 `model.js` 提供 `isOpus55()`，默认值模块先问它。
  识别保持保守——`claude-opus-5-5` / `claude-opus-5-5-thinking` / `anthropic/claude-opus-5.5` 命中，
  `claude-opus-5` 与 `claude-opus-5-50` 不命中（猜错会静默丢掉一个模型接受的字段）。
- **不发 `cch=`**：官方客户端已不再发它，继续注入只会让请求**更不像** CLI。

### 21.5 顺手修掉的一个真缺陷：`authMode`

做这件事时发现导入的账号一直是错的：`importer.js` 把 sub2api 的 `type: 'oauth'` 丢掉了，
而 `buildAnthropicRequest` 对**所有** Anthropic 账号一律发 `x-api-key`。也就是说，
一个从 sub2api 备份导入的订阅号，会把 access_token 塞进 `x-api-key` 发出去——上游只会回 401。
更糟的是 `host-test.mjs` 把这个错误行为**写成了断言**（`headers['x-api-key'] === 'at-real'`），
于是它一直绿着。

现在 `authMode`（`'api-key' | 'oauth'`）是账号上的一个字段：
- `'oauth'` → `Authorization: Bearer` + 单条 `oauth-2025-04-20`；
- `'api-key'` → `x-api-key`，不声明任何 beta。

导入器负责把它填对：声明的 `type` 优先，没声明就从凭据包**推断**（有 `access_token` 且没有
`api_key` 即 OAuth）。这是**事实**而不是策略，所以导入时自动设置；
而 `mimicry` 是**选择**，导入器一律不碰——因为偷偷改写别人的 system 提示词，
和这个池子在别处反复拒绝的那种"静默越权"是同一类错误。

### 21.6 诚实的边界

| 复刻不到的东西 | 为什么 | 后果 |
|---|---|---|
| 请求头的**精确大小写** | sub2api 自己写 raw header（Go），这里由 `fetch`/undici 构造 `Headers`，会把名字小写化 | **低风险，但确实不一致**：HTTP 头名本就不区分大小写，而且 HTTP/2（RFC 7540 §8.1.2）**要求**头名全小写，真实 CLI 走 H2 时线上也是小写。所以这不构成协议错误；只是"逐字节一致"这句话不成立 |
| TLS / HTTP2 指纹，以及**协议版本本身** | Node 的 `fetch`（undici）默认走 HTTP/1.1，且无法塑形 ClientHello 与 HTTP2 settings 帧 | 这是本层**真正**的缺口：这类检测看到的仍是 Node + H1.1。要改就得把传输层从 `fetch` 换成裸 `http2` 客户端，并连带重做响应侧的流式读取 |
| `session_id` 与真实 CLI 的随机性一致 | 真实 CLI 是进程级随机 UUID，无状态代理无法复原 | 本插件用 `sessionId` 推导，跨轮稳定；语义上更接近"同一会话同一 id" |
| `accept-language` 与 `sec-fetch-mode` | 真实 CLI 抓包里有两个头，其值来自 `claude.DefaultHeaders()`，而该 Go 包的源码不在本工作区；凭空编一个值只会**新增**一个不一致 | 缺这两个头。它们的取值依赖抓包，不猜；要用就把账号上的固定头配上 |
| 改动对模型可见 | 伪装必然把官方身份块与扩充段放进 `system` | 这是**功能的一部分**，不是副作用；调用方原本的提示词仍然完整送达（走对话历史） |

### 21.7 数据模型与版本

`accountSchema` 新增五个字段，全部带默认值：`authMode`、`mimicry`、`mimicryClientId`、
`mimicryAccountUuid`、`mimicryCliVersion`。

**`DOMAIN_VERSION` 仍是 1**，理由同 §20：这是纯加法，旧记录照常打开（新字段读出来是默认值）。
升版本要求存储后端真的实现 `compatibleVersions` 的兼容读取，而离线无法验证——一旦它不支持，
`open()` 会直接失败、插件整个挂不上。等出现真正不兼容的字段变更时再升。

### 21.8 界面与入口

- **账号池页**：平台列直接标出 `anthropic · CC 模式`（状态可见，不必从按钮文字反推）；
  行内一键「开启/关闭 CC 模式」（`set-mimicry`）。**只对 anthropic 账号渲染**——
  host 的门就是 `platform === 'anthropic'`，在别的平台画一个改不动任何东西的按钮是误导。
- **账号编辑表单**：`凭据类型` 与 `Claude Code 模式` 两个下拉，回填**已存值**而不是默认值
  （否则"打开表单→保存"会静默关掉已开启的伪装）。
- **配置**：`cordis.patch.yml` 的账号条目可以直接写 `mimicry: claude-code`、
  `authMode: oauth`（两者都在 `STATIC_ACCOUNT_FIELDS` 里，重启对账时刷新，但不碰冷却窗口）。
- **自检**：`account-pool-status.json` 现在多一段 `claudeCode`，报告有多少账号在伪装中、
  以及其中有多少**没有**用 OAuth——这个组合合法但几乎总是配错，而上游只会回 401 而不是给诊断。

### 21.9 测试

新增 `tools/claude-code-test.mjs`（**43 项**），分两层：模块组机制（注册表顺序、`off` 的语义、
二次执行守卫、定向禁用、版本只解析一次）与逐模块（每个模块自己的事实，且尽量对着**从真实算法推出的
字面量**断言，而不是对着自己的另一个函数断言——否则算法整体改错也能自洽通过）。
最后一层走**真实 transport**，验证"自洽但根本没发出去"的伪装会被抓到。

`client-test.mjs` 加了 6 项界面断言（行内标记、一键开关发出的 body、只对 anthropic 渲染、
表单回填已存值并保留未触碰的 authMode）；`host-test.mjs` 加了一条端到端：
**管理路由 → domain 行 → 传输层请求头与请求体**，并验证非法模式被拒且行未被改动。

本期收尾时全量：`claude-code 43 + kernel 60 + domain 13 + upstream 16 + host 36 + client 150 + importer 18`。

### 21.10 第二轮对齐：把"大概像"改成"发出去的东西一样"

第一轮的伪装是自洽的，但对着 `_sub2api` 的 mimic 路径逐项复核后，仍有 8 处"我们自己一致、
真实 CLI 不这么发"的差异。它们的共同特征不是功能缺失，而是**只有抓包才能发现**的细节，
所以没有一项能被"自己的测试通过"证明：

| 差异 | 真实 CLI 的行为 | 原来的行为 | 后果 |
|---|---|---|---|
| `Accept` | `application/json`（流式也一样） | `text/event-stream` | 第三方形态：预协商响应格式 |
| `?beta=true` | 恒定带 | 没有 | URL 是链路上唯一没有 CC 客户端发过的东西 |
| `x-stainless-helper-method` | 流式请求带 `stream` | 没有 | 少一个 SDK 侧标记 |
| `EXPANSION_PROMPT` | 含 `# Tone and style` 整段 | 被截断，注释却写 verbatim | 块体量比真实 CLI 短 |
| 迁移时的 `cache_control` | 跟着文本搬 | 丢弃 | 调用方缓存前缀每轮全价 |
| 迁移判定 | 前缀匹配（4 个第一方 banner） | 只认等号 | Agent SDK 请求被加一轮假 user/assistant |
| Opus 5.5 的 `temperature` | 不发（模型拒绝） | 无条件补 1 | 一次忠实请求变成 400 |
| thinking 的 `context_management` | 打开时补默认块 | 不补 | 声明了 beta 却没有对应字段 |

两处**刻意没做**的，写在 §21.6 的边界表里而不是悄悄糊过去：`accept-language` / `sec-fetch-mode`
（值在拿不到源码的 Go 包里，编一个只会新增不一致），以及 `max_tokens` 的 CLI 默认 128000
（本插件的 transport 永远会算出 `max_tokens`，所以对齐它属于改预算策略，不是改伪装形状）。

---

## 22. OAuth 登录：一个功能，不是一次登录

在此之前，往池子里放订阅号的唯一途径是**导入**（sub2api 备份或 CPA auth 文件，见 §17 的导入器）。
那些文件从哪来，是本插件不回答的问题；而一个只有导入没有登录的号池，实际上要求操作者先在别处
跑一套完整的 OAuth 客户端。

§21 又把这件事顶到了台面上：订阅号（OAuth）凭据**只有伪装成官方 CLI 才用得了**。所以
"账号池能登录" 和 "账号池能用订阅号" 是同一件事的两半。

### 22.1 为什么这不是"加一个按钮"

一个 OAuth 登录自动成立的条件有六条，缺一条它就是个看起来能用、几小时后开始 401 的功能：

1. **PKCE 的字母表是各家自己定的。** RFC 7636 §4.1 允许 `[A-Za-z0-9-._~]`，base64url 和 hex 都合法；
   但厂商哈希的是**你发给它的那个字符串**。OpenAI 的客户端用 hex 生成 verifier、用 base64url 生成
   challenge（`openai/oauth.go:155-177` 明写了这一点）。发错字母表得到的是 `invalid_grant`，
   本地没有任何症状。
2. **redirect URI 不总是我们能选的。** Google 的内置客户端**只允许**
   `https://codeassist.google.com/authcode`（`geminicli/constants.go:36` +
   `gemini_oauth_service.go:166-172`），回调落在 Google 自己的页面上，本地监听永远收不到。
3. **state 是防 CSRF 的门，不是装饰。** 回调带着它回来，必须与我们记下的那个比。
4. **授权码是一次性的，verifier 只在这一次登录的内存里。** 同一个码重放一次，
   即使发出去也只会得到 `invalid_grant`。
5. **access token 几小时就过期。** 不做续期，登录成功当天下午就变成上游 401，
   而失败看起来像"凭据坏了"而不是"少了一半功能"。**所以续期是功能的一部分，不是后续优化。**
6. **刷新会轮换 refresh token。** 多个请求同时撞上过期，会开多个刷新、互相覆盖轮换结果。

下面每一条都有对应的实现位置。

### 22.2 方法论：从源码抄，不靠记忆；抄不到就标出来

这张表里每个端点、client_id、scope、token 字段名都是从**能跑的参考实现**里读出来的，
`lib/oauth/providers.js` 把出处写在常量旁边。理由是硬性的：client_id 或字段名差一个字符，
远端回一个 400，本地什么都没发生——把出处写在值旁边，是唯一能让下一个人核对的写法。

| 提供商 | authorize | token 交换 | PKCE verifier | 回调 | 出处是否核实 |
|---|---|---|---|---|---|
| OpenAI (Codex) | `auth.openai.com/oauth/authorize` | form | **hex(64B)** | 本地监听 | ✅ `pkg/openai/oauth.go` |
| xAI (Grok) | `auth.x.ai/oauth2/authorize` | form | base64url(32B) | 本地监听 | ✅ `pkg/xai/oauth.go` |
| Google (Gemini CLI) | `accounts.google.com/o/oauth2/v2/auth` | form + **client_secret** | base64url(32B) | **固定** `codeassist.google.com/authcode` | ✅ `pkg/geminicli/*` |
| Anthropic (Claude Code) | `claude.ai/oauth/authorize` | json | base64url | 本地监听 | ❌ **未核实**，见 §22.6 |

参考检出是**裁剪过**的：`backend/internal/pkg/oauth`（Claude 的 OAuth 客户端）、
`pkg/claude`、`internal/repository`（各家 token 交换的 HTTP 调用点在那一层）都不在里面。
所以 Anthropic 那一行是整张表里唯一没有源码出处的，处理方式是**显式标注 + 可覆盖**，
而不是猜一个看起来合理的值然后当它是事实：`unverified: true` 会传到界面上，三个字符串
（authorize / token / client_id）都能在 `oauth-start` 的请求体里覆盖——漂了就是改配置，不是改代码。

### 22.3 一次登录的状态机

```
start(providerId)
  ├─ PKCE pair（字母表按 provider 定）+ state（编码也按 provider 定）+ 需要时再生成 nonce
  ├─ redirect URI：provider 固定值 > 调用方解析出的回环地址 > provider 默认值
  ├─ 拼 authorize URL（含 client_id / scope / code_challenge=S256）
  └─ 存进 flow store（TTL + 容量上限），返回**不含 verifier** 的快照
        ↓  （浏览器里去厂商那边）
finish(flowId, input)
  ├─ 先校验 state  → 不匹配就被拒，而且**不消费**这个 flow
  │                 （一次 CSRF 尝试不该杀掉操作者正在进行的登录）
  ├─ 再要求 code 非空
  ├─ 消费 flow（一个授权码只能用一次；重放会拿到"这个码已经换过了"而不是远端的 invalid_grant）
  ├─ provider.exchange()：按各家的方言发 token 请求
  ├─ 把 per-flow 的 client 覆盖折进 bundle（否则几小时后的刷新会以 invalid_client 失败）
  └─ onFinish()：**先写凭据，再写账号行**
```

最后一步的顺序是承重的，和 §17 的导入、`create` 一样：`credentials.set` 被拒（比如有个只读来源
遮住了这个引用）时，账号行绝不能已经存在——否则库里多一行指向不存在密钥的账号，而它只会在
第一次请求时以 401 暴露。

### 22.4 两条回调路径，且界面说清楚走的是哪条

- **本地回环监听**（OpenAI / xAI / Anthropic）：host 在**第一次真的发起登录时**才 `listen(0, '127.0.0.1')`。
  端口交给 OS 选，避免两个 DSH 实例撞端口；选出来的端口再拼进 redirect URI——所以 URI 是
  每次登录算出来的，不是常量。登录完成后立刻关掉，另有一个**闲置计时器**兜底：
  操作者开了登录页就走人，什么请求都不会发来，没有这个计时器进程会一直占着端口。
  绑不上端口（权限、端口耗尽）时降级成手动粘贴，而不是让登录无法完成。
  **并发发起的两次登录共享同一次绑定**：否则两个 `oauth-start` 同时到达时会双双看到"没有监听"、
  各绑一个，抢输的那个端口就永久泄漏了。
- **手动粘贴**（所有提供商，Gemini 必须）：解析器接受三种形态——裸 code、`code#state`、
  **整条回调 URL**（地址栏里实际显示的就是这个）。参考实现里只有 xAI 会解析整条 URL，
  但要求人去地址栏里手工抠一个查询参数，本来就是"登录偶发失败"的来源之一。

`redirect_uri` 的选择顺序写在 `start()` 里，且**flow 存的是同一个值**：token 交换会把 redirect_uri
回传，多一个字符厂商就拒收这个码。这一条正是我自己写错过的地方（授权 URL 用了监听端口、
flow 里却存了 provider 默认值），而 `host-test.mjs` 里那条断言
（`started.flow.redirectUri === authUrl 里的 redirect_uri`）就是为它加的。

### 22.5 落地、防重复、防累积

- **建号**：id 从 **flow id** 派生（`openai-a1b2c3d4e5f6`），不从邮箱派生——邮箱 slug 会和已有账号
  撞名，而 flow id 天然唯一且仍然可读；给人看的名字放进 `label`（邮箱或 provider 名）。
  自动带上 `authMode: 'oauth'`，因为那是**关于这份凭据的事实**，不是偏好：不写的话
  订阅号的 token 会走 `x-api-key` 发出去，上游只回 401（§21.5 踩过同一个坑）。
- **一次登录只换一次**：`oauthFinishes` 缓存已完成的 flow；引擎侧 `flow.consumed` 拦住
  "换失败了再点一次"——发出去也不可能成功，明说比让远端再拒一次强。
- **防累积**：flow store 有 TTL（默认 15 分钟）和容量上限（默认 8），**按最旧优先淘汰**。
  容量计数曾有个真 bug：`size()` 顺手跑了带容量裁剪的 `evict()`，于是"问一下有几个登录"
  本身就会删掉登录——只有在一个测试里 `create` 之间穿插 `size()` 才看得见。
- **凭据续期**（`lib/oauth/refresh.js`）：在**每次请求解析凭据的那个点**判断
  `expires_at` 是否进入 5 分钟窗口，是就刷新并落库。没有定时任务、没有"刷新"按钮可忘记按。
  同 `(credentialRef, platform)` 的并发请求共享**同一个 promise**，所以 N 个并发请求只开一次 token 请求，
  也不会互相覆盖轮换后的 refresh token。刷新**失败时返回旧 token 而不抛错**——
  上游的 401 带着真实原因，而 `classifyFailure` 本来就知道怎么处理它，这一层没有更好的话可说。

### 22.6 诚实的边界

| 没做的事 | 为什么 | 后果 |
|---|---|---|
| **Anthropic 的端点未经核实** | 参考出货里那个包不在检出中（§22.2） | 界面上直接标"端点未核实"；三项都可按 flow 覆盖。这是本功能里唯一不是"读来的"事实 |
| **设备码流程** | 参考实现里确实有一套（`pkg/xai/sso_device.go`），但它带有自己的验证/批准/轮询与 cookie 落盘路径，是一块独立的功能 | 只有授权码流程。没有浏览器的场景（纯终端）用不了登录 |
| **密码登录换 SSO** | 同上，且要落 `sso`/`sso-rw` cookie，参考实现专门写了清理逻辑 | 不做。凭据库只放 OAuth token |
| **Antigravity**（第三家 Google 客户端） | 它与 Gemini 是两套独立的 client_id/scope/端点，多了 `cclog`/`experimentsandconfigs` 等 scope | 不做。要做就是往表里加一行 |
| **自动探测 Gemini 的 `project_id`** | 参考实现登录后会打 `loadCodeAssist` 拿 project_id 与 tier，必要时还要 `onboardUser` | 登录时把这件事**作为 caveat 说出来**，不偷偷少一个字段：Code Assist 没有 project_id 就用不了 |
| **后台定时刷新** | 请求时刷新的前提是"有人用"；账号闲置时 token 过期不重要 | 长期不用的账号，第一次请求会多花一次刷新往返（并发已收敛为一次） |
| **内置 Google client_secret** | 参考实现把那份被公开的 secret 硬编码进二进制，同时也认环境变量（`constants.go:42-45`） | 本插件**只读环境变量** `GEMINI_CLI_OAUTH_CLIENT_SECRET`。少一个便利，多一条"这个仓库里没有别人的凭据" |

### 22.7 数据模型与版本

**账号行没有为 OAuth 新增任何字段，`DOMAIN_VERSION` 仍是 1。** 这正是 `credentialRef` 那层抽象的
回报（§17）：登录产出的东西和其它路径一样，是"一行账号 + 凭据库里的一条 JSON bundle"。
凭据库里的 bundle 形状（`access_token` / `refresh_token` / `expires_at` / `client_id` / `email` /
各家特有字段）与导入器写进去的形状一致，所以 `decodeBundle` 和续期逻辑对两条路径一视同仁——
`refreshAccountCredential` 甚至分不清一个号是登录来的还是导入来的。

host 侧新增**一条只读路由** `/api/accountPool.oauth`（GET，提供商目录 + 活动 flow + 回调监听状态），
写操作走原有的单写路由新增的四个动词（`oauth-start` / `oauth-finish` / `oauth-status` / `oauth-cancel`）。
没有新开"万能 patch"面。

### 22.8 界面

- **账号池页头部**多一个「OAuth 登录」，面板里：提供商下拉（未核实的、必须手动粘贴的，都在选项里标出来）、
  「开始登录」、「打开授权页」（链接 + 复制按钮，因为弹窗可能被拦）、粘贴框、「完成登录」、「取消登录」。
- **轮询只在 flow 处于 `pending` 且不是手动模式时跑**，flow 一离开 `pending` 就停——
  一个比它的登录活得久的定时器就是泄漏。
- **caveat 直接显示**（Gemini 的 project_id、Anthropic 的"记得开 CC 模式"）：
  提供商的 `exchange()` 返回它，引擎把它带进 flow 快照，界面照着渲染。
- 粘贴框**始终可用**（固定回调的提供商需要它，监听坏掉时更需要），但不强制。

### 22.9 测试

新增 `tools/oauth-test.mjs`（**69 项**），四层：

1. **密码学材料对比标准**：PKCE 复刻 **RFC 7636 附录 B** 的向量（`dBjftJeZ4CVP…` →
   `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`），以及 hex verifier 那条陷阱——
   断言 challenge 是**对字符串**哈希、**不等于**对字节哈希。对着自己另一个函数断言的话，
   算法整体改错照样绿。
2. **flow store 的边界语义**：TTL 精确到毫秒、容量淘汰最旧、`list` 会清理过期流（否则路由永远
   把过期流报成 pending）、`size` 不删东西。
3. **逐 provider 的 URL 与请求体**：四家都必须带 state + PKCE + client_id；OpenAI 的两个 Codex 标志；
   xAI 的 `referrer=sub2api`；Google 的固定 redirect 压过调用方给的值；各家的 Content-Type 与
   grant_type；缺 `access_token` 的响应必须显式失败而不是存一个空 bearer。
4. **续期**：未到期不发请求、到期才刷、厂商不轮换时保留旧 refresh token、失败回退旧 token、
   **N 个并发只发一次刷新**（用一个永不 resolve 的假 `fetch` 卡闸门，放行前就断言计数）。
   最后一层还有一个**真的绑端口**的回环用例：`127.0.0.1` 临时端口上跟自己对一次 HTTP。

`host-test.mjs` 加 12 项**端到端**：提供商目录 → `oauth-start`（断言授权 URL 里的 `redirect_uri`
与 flow 里的是同一个、且真的绑上了端口；**两次并发 start 共享一个监听**，否则抢输的端口就漏了）
→ `oauth-finish`（断言密钥进了凭据库、bundle 是完整 JSON、账号行是 `authMode: oauth`、
**账号行里不含密钥**、解析出来的是裸 bearer）→ 新账号真的能过 `adapter.stream()`。
另有 state 不匹配不建号、未知 provider / 组在登录前就被拒、取消会释放端口、
Gemini 走固定回调且不绑端口、caveat 传到了 flow 上。

`client-test.mjs` 加 9 项：面板从独立路由取提供商目录、未核实与手动粘贴在界面上可见、
`oauth-start` 的 body 带 provider、授权 URL 即使弹窗被拦也留在屏幕上、等待态与"本地回调已就绪"、
`oauth-finish` 的 body 带 flow id 与粘进来的原文、完成后报出新账号 id、取消发 `oauth-cancel` 并关面板。

### 22.10 这一期踩到的两个"假绿"和三个测试替身缺陷

值得单独记一笔，因为它们都不是功能写错，而是**验证方式**出了问题：

1. **`assert.rejects(fetch(...))` 少了 `await`**：三个新用例留下了悬挂的 promise，
   进程在报告完 "46/48 通过" 之后再也不退出。测试文件必须以退出码为准则，
   "跑完了但进程不结束" 也算失败。
2. **`fixed 14/14` 却是错的**：我写了个自动补引号的修复脚本，它把引号插在了**第三个**引号处
   而不是第四个，然后照样报告"全部修复"。只有 `node --check` 的退出码才算数——
   **脚本自己的成功汇报不算证据**。
3. **测试替身缺口（三处）**，都由"崩溃发生在报告之前"而伪装成别的问题：
   - mock 的 `createRoot` 缺 `render()`：seat 一安装就抛错，第三个标签页永不出现，
     看起来像 bundle 的问题；
   - mock 元素只有 `document` 有 `querySelectorAll`，元素上没有：`card.tablist.querySelectorAll(...)`
     直接 TypeError；
   - `eq()` 用 `JSON.stringify` 比较 DOM 节点，而节点有 `parentNode` 回环引用，必抛。
   `client-test.mjs` 现在给 `eq` 之外补了 `ok(a === b)` 的用法，并加了
   `process.on('uncaughtException')`：崩溃时先把**已经记录的失败**打印出来，
   而不是让一次"其实早就失败了"的运行看起来毫无输出。

顺带修掉的两个**真**缺陷（都是这一期的 seat 代码，与 OAuth 无关，但在本轮暴露）：

- `assert()` 只比较**记下来的** `label`，所以上游把标签文字清空后没有任何东西恢复它；
  现在比较 DOM 里**实际**的文字。
- 点击已发布的标签页时，`activate(false)` 在自己已经是 `false` 时提前返回，
  于是两个 panel 的可见性停留在上一次选择上；现在点击后无条件重新对齐。

本期收尾全量：`oauth 73 + host 51 + client 222 + kernel 60 + domain 13 + upstream 16 + claude-code 43 + importer 18 = 496`。

### 22.11 OpenAI 的回调是实测出来的，不是推理出来的

这一节是**被用户按着头才做对的**，值得完整记录，因为它演示了本项目反复强调的那条规矩：
**能实测的绝不要推理。**

#### 曾经错在哪

`invalid_authorize_request` 这个错误来回出现了三次，我的两次"修复"都是推理出来的：

1. **第一版**：让系统挑空闲端口，把 `http://localhost:<随机>/oauth/callback` 当 `redirect_uri`
   发出去。→ 400。
2. **第二版**：从（更旧的）参考常量里读到 `http://localhost:1455/auth/callback`，
   把端口钉死在 1455。→ **仍然 400**，因为**主机名错了**。
3. 期间我还下过一个错误结论："`auth.openai.com` 在 Cloudflare 后面，程序化验证走不通。"
   **这个结论也是错的**——那只是 User-Agent 的事，换一个浏览器 UA 就通，302 立刻可见。

#### 怎么定死的

**（a）从真实二进制里读常量。** 本机没有 CLI 可执行文件，于是从 npm 拉官方包：
`@openai/codex` 是个薄启动器，真正的平台包是 `@openai/codex-win32-x64`
（`https://registry.npmjs.org/@openai/codex/-/codex-0.160.1-win32-x64.tgz`，155 MB）。
从里面的 `codex.exe` 抠出的字符串给出四件事：

```
CODEX_APP_SERVER_LOGIN_CLIENT_ID   app_EMoamEEZ73f0CkXaXp7hrann
scope                              openid profile email offline_access api.connectors.read api.connectors.invoke
回环监听                            http://127.0.0.1:<PORT>/auth/callback
授权参数                            id_token_add_organizations / codex_cli_simplified_flow / originator / allowed_workspace_id
```

**（b）拿授权端点做差分探测。** 换浏览器 UA 后它对每个参数都给出明确答复：

| `redirect_uri` | 结果 |
|---|---|
| `http://127.0.0.1:1455/auth/callback` | **302 → `/log-in`** ✅ |
| `http://127.0.0.1:52111/auth/callback`（随机端口） | **302** ✅ |
| `http://localhost:52111/auth/callback` | **400 `invalid_authorize_request`** |
| `http://127.0.0.1:52111/oauth/callback`（路径错） | **400** |
| 不带 `state` | **400** |
| scope 去掉 `offline_access` | 302 ✅（所以 scope 不是成因） |

**结论：注册的是 `127.0.0.1` + 任意端口 + `/auth/callback`。** 主机名与路径必须一致，
端口自由——这正是真 Codex 客户端的行为（`127.0.0.1:0`，端口交给 OS 分配）。

#### 代码因此改成什么样

- `callbackRedirectUri()` 的默认主机从 `localhost` 改成 **`127.0.0.1`**（这本身就是一个隐患：
  双栈机器上 `localhost` 可能先解析到 `::1`，而监听只绑了 IPv4）。
- OpenAI provider 去掉 `callbackPort: 1455`，改为 `callbackHost: '127.0.0.1'` +
  `callbackPath: '/auth/callback'`，端口交给 OS——与真客户端一致，也不会因为 1455 被占而失败。
- scope 换成从 `codex.exe` 读到的完整串。
- 监听器复用判据补上 **HOST**：`localhost` 与 `127.0.0.1` 是两个不同的注册，不能互相顶替。
- `oauth-check` 改用 `providerRedirectUri()`：**已绑定的监听器才是权威**——
  它报的是授权 URL 里真正写出去的那个端口，而不是配置里的 `callbackPort ?? 0`（那会报 `:0`，
  于是自检永远误报自己的 URL 不对）。

#### 还差一步：token 能拿到，但按现有传输发请求上游不认

sub2api 里 Codex OAuth 账号的出口**不是** `api.openai.com`：

```
chatgptCodexURL = "https://chatgpt.com/backend-api/codex/responses"
```

而且 `chatgpt_account_id` 是**请求头**。本插件的 OpenAI 传输走
`${baseUrl ?? 'https://api.openai.com'}/v1/chat/completions`，所以登录能成功、
账号会落库，但第一次发请求不会被上游接受。补齐这条链路（Codex 出口 + 那个头）
是一个独立步骤，不在"登录"这件事里，但**必须写在限制里**，否则就是"能登不能用"的假功能。

## 23. 模型页的第三个页签：给一个核心没留插槽的位置补一个座位

> **已废止（见 §27）**：这套 DOM 座位已在 2026-10-06 撤掉。本节保留为当时的决策记录，
> 阅读时请以 §27 为准。

「设置 → 模型」→「+ 添加模型提供商」展开后，页签行现在有三个页签：
「第三方模型提供商 / 自定义模型 API / **号池管理**」。前两个是核心画的，第三个是本插件补的；
原来那张 `settings.models.footer` 卡片**不再注册**——同一份内容不在页面上出现两次。

### 23.1 为什么是 DOM，而不是 `slots.register`

实测（实时 Slot Inspect + `refs/dsh-cordis-client-runner.client.js` 的插槽清单）：模型页
（`settings.section` 的 `models` 条目）声明的子插槽**只有三个**——`settings.models.provider-card`
（keyed）、`settings.models.footer`（list）、`settings.models.sign-in`（single），声明在
`refs/ui-settings-models.client.js:4059-4074`。而添加卡片里的页签行是核心用一个固定两项的
`SegmentedControl` 画的（`refs/ui-settings-models.client.js:2240-2271`），**没有页签插槽**。
于是只有两条路：改核心（动 `app.asar`，或 fork 那个 186KB 的 bundle——升级即废），
或者在 DOM 上补一个座位。选了后者：它是唯一既不碰安装体、又不 fork 上游的做法。

### 23.2 耦合的是哪些事实（没有一个 hash 类名）

- `button[role="tab"][id$="-catalog"]` / `-custom`，以及它们 `aria-controls` 指向的面板；
- tablist 上的 `--dsh-segment-count` / `--dsh-segment-index`：核心那个滑动指示器
  （`SegmentedControl.module.css` 的 `span.indicator`）用它算宽度与位移，所以把 count 改成 3、
  激活时把 index 改成 2，滑块就自己落到第三个座位上；
- 两个面板的 `hidden` 属性：核心按 `mode !== 'catalog' | 'custom'` 写它。

新页签是**克隆**核心页签得到的：`.tab` 的类名是 hash 的，克隆一份就自动继承全部样式，
一个魔法类名都不用写。页签追加在 tablist 末尾、面板容器追加在 `addCard` 末尾——
React 只在自己拥有的锚点前插入，把外来节点放在最后一位最安全。

### 23.3 幂等断言 + 两段观察器

`assert()` 只在值不一致时写 DOM，并用 `busy` 挡住自己触发的观察器回调，所以"没有东西要改"
的一轮批处理会收敛而不是自激（测试用**写入计数**断言了这一点）。React 每次渲染都会把
`--dsh-segment-count` 写回 2、把面板 `hidden` 写回它的 mode，观察器在同一次微任务里改回来——
MutationObserver 回调早于绘制，所以看不到闪烁。

观察器分两段：没坐上座位时只看 `document.body` 的 childList，并且 80ms 合并一次
（改动这个文档的不止设置面板）；坐上座位后改看卡片本身与它**父节点**的 childList——
后者是必需的：卡片被 React 整体卸载时，变更发生在父节点上，盯卡片自己看不到它消失。

### 23.4 失效模式

- 找不到页签行（例如核心将来只画标题、不画分段控件）：**不装座位**，打一条带
  `dsh-account-pool` 前缀的 `console.warn`，模型页就没有号池入口，「账号池」页与 pool
  provider 卡片不受影响。
- 拿不到 `react-dom/client`：同上。`require` 用 try/catch 包着，绝不让插件半边整体挂掉。
- 因此**这个页签在，就说明耦合的 DOM 契约还成立**；它不在了，先看控制台那条警告。

### 23.5 与核心的键盘差异

我们的页签自己处理方向键（←/↑/Home 把焦点交回当前选中的核心页签，→/↓/End 留在原处），
不走核心 `SegmentedControl` 的 `walk()`，所以不完全等同原生三段控件的键盘行为。

### 23.6 测试

`tools/client-test.mjs` 用一个最小 DOM（元素/属性/样式表/子节点/监听器/`cloneNode`/`isConnected`，
加一个可手动 flush 的 `MutationObserver`）伪造出核心那张卡片，然后依次验证：
装配（第三个页签在末尾、类名克隆自核心页签、`--dsh-segment-count = 3`）→
点击（两个核心面板隐藏、指示器 index = 2、面板内容与旧卡片逐字一致且真的 POST 出 `prefer`）→
交还选择（跟随核心的 `aria-selected`）→ React 复渲染后被改回（并断言"无事可做的一轮不写 DOM"）→
换语言（页签与面板正文都跟随）→ 关闭卡片（`root.unmount()` + 节点回收）→ 重开（只有新的一份，不叠加）→
没有页签行的卡片（恰好警告一次）→ dispose（不再安装）。

## 24. 让 `pool` 出现在「模型」页的 provider 列表里：一个 `Config` schema 才是命名空间

**现象**：上游配好了、`providerDeclared: true`、`routes: 4`，适配器注册成功、输入框的 provider
选择器里也能选到 `pool`——但「设置 → 模型」那张 provider 列表里**根本没有这一行**，
所以"号池"没法像 `LocalHost` / `Anyrouter` 那样在那里被绑定。

**根因（两步都必要）**：

1. 列表里的行 = 目录条目 + 已注册路由（`refs/ui-settings-models.client.js:907-930`），
   每一行在 store 里算 `configured` 时要求它的 `settingsNs` 能查到设置**命名空间**
   （`:1035`），列表渲染再丢掉查不到的那些（`:2127-2129`：`if (namespace === void 0) return null`）。
2. 一个 Loader 条目的命名空间**只来自它导出的 `Config` schema**。实测：实时 Config Inspect 里
   `include:account-pool` 的 `status` 是 **`absent`**（本机其它自装插件 `usage-report` /
   `github` / `mcp-skills` / `context-window` 也都一样），而 `@hytime/dsh-thinking-effort`
   （profile 里的第三方插件，`import z from "@deepseek-ai/schemastery"`）是 `schema`。

所以：`registerConfigurableProviders` 里写 `settingsNs: 'account-pool'` 而不导出 schema，
等于把行交给了一个不存在的命名空间——**行被静默丢掉，不是没注册**。

**修法**：`lib/host.js` 导出 `Config = z.object({...})`，并把
`@deepseek-ai/schemastery`（DSH 出货的同一个版本 3.18.4，npm 上公开）提成正式依赖。
schema 只声明 YAML 能表达的那些键（`statusDumpPath` / `providerDisplayName` /
`pruneIntervalMs` / `oauth*` / `refreshEnabled` / `accounts`）。

**为什么这样是安全的**：schemastery 会**保留** schema 没提到的键（对着 3.18.4 实测过），
所以操作者现有的 config 解析后原样保留；`accounts` 故意写成 `z.array(z.any())`——
它的形状归 `lib/domain.js` 的 domain schema 管，在这里再声明一遍就是第二个事实来源。
`tools/host-test.mjs` 里那条 `config:` 用例把这两点焊死：导出存在、账号列表不被重塑、
未知键存活、空 config 只解析出声明过的默认值（`accounts: []`）。

**顺带修掉的另一半**：行的名字取自 `providerInfo(route).name`（`:1031`、`:92`），
而它原本对**所有**路由返回同一个名字——于是即便行能显示，`pool` 与每个
`pool-<组名>` 也会全叫「号池」。现在默认路由答 `PROVIDER_LABEL`（「号池」），
分组路由答**自己那一组的 label**（没 label 用组 id），并且这个常量同时喂给
目录条目和适配器，免得两个界面各叫各的（以前目录发「号池」、适配器发英文默认值）。

### 24.1 每个分组都进目录；"优先"与"能不能调用"是两件事

行能画出来之后还有一层：**目录里当时只声明了 `pool` 一条**。分组虽然各有自己的路由
（`pool-<组名>`，注册在适配器上、输入框的 provider 选择器里能选到），却没进目录——而列表的
行只来自"目录条目 + 已注册路由"里**命名空间能解析**的那些，所以分组连行都没有。

现在 `directoryEntries()` 按 `adapter.routesFor()` 逐路由声明，名字直接取
`adapter.providerInfo(route).name`——**一个命名权威**，目录和输入框选择器不会再各叫各的：
`号池` 一行，每个分组各一行、各自叫组名。`refreshRoutes()`（建组 / 改组 / 删组都会走）
同时 `replace()` 路由表与目录，所以建完分组**不需要重启**就能看到那一行。

`settings.models.provider-card` 是**按行派发**的（`entryKey = settingsNs`，owner props 里带
`provider: row.entry`），所以这张卡片现在按**该行的路由**取范围：分组行只报这一组的账号数，
不再报整个池的。注册时若把 owner 的 `provider` 丢掉，每行都会显示全池的数字——
`tools/client-test.mjs` 里 `pool-cheap` 那条（`1 个账号`，而不是 `5 个`）就是钉这个的。

顺带把"优先"放回它该在的位置：**它只决定默认那条 `pool` 路由落到哪个分组的账号上**
（首选分组没有成员时退化回整池），与"分组能不能被选、能不能调用"无关。要直接调用某个分组，
就在 provider 选择器里选它的路由 `pool-<组名>`。

### 24.2 为什么不写进 `llm-pi-ai` 的 `providers:`，以及「自定义」那个 chip 是怎么来的

profile 里 `LocalHost` / `Anyrouter` 那些行来自 **`@deepseek-ai/dsh-llm-pi-ai` 自己的 `providers:`
配置**：每条告诉那个插件"用哪个 `api`、打哪个 `baseURL`、密钥环境变量叫什么"，由**它自己的适配器**
去发请求，并且用同一个目录 API 把路由声明出来。

**号池的路由不能写进那张表**：`llm.registerAdapter` 的契约是
"any provider already has an adapter → 抛 `DUPLICATE_ADAPTER`，且 all-or-nothing"。
同一个 `pool` 若被 pi-ai 认领，号池自己的适配器就注册不上，整池一起废掉。
路由必须归**号池自己的适配器**，所以"出现在上面"这件事走的是**同一个目录 API**
（`registerConfigurableProviders`），只是服务方不同。

行上那个「自定义」小标签由目录条目的 `declared` 决定（`refs/ui-settings-models.client.js:2172`）。
它的语义是"由配置声明、不是出货目录里的"——号池与各分组正是这种情况，所以我们显式传
`declared: true`，让这几行和 `LocalHost` / `Anyrouter` 长得一致。这个 flag 的另外两个读者在
pi-ai / deepseek 的**家族编辑器**里（`:1657`、`:1789`），而未知命名空间（如本插件的
`account-pool`）根本进不到那段代码，所以对号池没有副作用。

**凭证那一列不会亮**，这是对的：号池没有"一条 API key"，密钥是**每个账号一条**
（`credentialRef`，在「账号池」页或本插件的设置里管），所以目录条目不带 `apiKeyEnv`——
核心也就不会给它画那个绿点或"密钥缺失"的提示。

### 24.3 "怎么调用某个分组"：路由与模型，两半都得能被选中

调用一条路由 = 在会话（或 Agent 预设 / `agent-default-model`）里声明
`provider: pool-<组名>` 加一个 `model`。provider 那一半靠"路由已注册 + 名字逐路由正确"；
**model 那一半原来根本不成立**：适配器的 `listModels()` 一直返回空数组（创建适配器时
从没传过 `models`），而选择器只能列出适配器**自报**的模型——于是号池和每个分组都是
"注册了、命名了、选不中"。这就是"我怎么调用"的答案里缺的那块。

现在 `listModels(route)` 逐路由算：**该路由背后账号允许的 id ∩ 该分组允许的 id**（两边都写
"全部"时这个账号贡献不出任何具体 id），再并上 config 的 `models:`。所以

- `pool-<组名>`：只看这一组的成员账号与该组的 allow-list；
- `pool`：没有首选分组时覆盖全部账号，有首选分组时与该分组一致（和 `candidatesFor` 同一条规则）；
- 未知分组：什么都不报（同样对齐 `candidatesFor`，不假装能服务）。

**config 的 `models:` 是必需的兜底**：账号与分组都写"全部"时插件没有任何具体 id 可报，
只有 `models:` 能让这条路由在选择器里被选中。`host-test.mjs` 的
`models: a route advertises what its accounts AND its group allow, plus the config list`
把三种情况（交集、首选分组收窄、未知分组为空）都钉住了。

## 25. 一个落在第一个 SSE 事件之前的 400：「会话启动不了」

### 25.1 症状与第一手数据

`session-69daf001` 在 `~/.dsh/sessions/...` 里的记录**只有一个 session header**，一条 turn/step
事件都没有；projcache 里却是 `turns=1 steps=1 llmMs=0 outputTokens=0`、`turnOutline` 的
prompt/response 都是空串。同一夜用 `anyrouter` 路由的会话是同一个签名（`3645c78d` 三次
"Hello World"、`1b185805` 两次，全 0 token）。所以"启动不了"不是会话打不开，而是**每一轮
在产出任何 token 之前就结束了**。

### 25.2 根因是上游的 400，不是号池

用插件自己的 transport（同一个 `buildAnthropicRequest`，同一份凭据）直连
`https://anyrouter.top` 复现：

```
POST /v1/messages?beta=true   anthropic-beta: claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14
→ 400 {"error":"1m 上下文已经全量可用，请启用 1m 上下文后重试","type":"error"}
```

同一个请求只多一个 `context-1m-2025-08-07`：

```
→ 200 text/event-stream
   event: message_start      (model "anthropic/claude-fable-5.1")
   event: content_block_delta …
   event: message_delta      usage {input_tokens:184, output_tokens:33, thinking_tokens:15}
   event: message_stop
```

也就是说：**上游只服务声称 1M 上下文的客户端**，而 400 落在 `message_start` 之前。
`adapter.js` 的 `classifyFailure` 判定这个 400 不归账号（passthrough），于是不冷却、不换号，
直接把错误抛回 agent loop —— 那一轮没有 token、没有事件，表现就是"点了没反应"。
这解释了三件事：为什么 `Anyrouter` 账号的 `consecutiveFailures` 还是 0、为什么冷却窗口是空的、
为什么会话记录里连一条错误事件都没有。

### 25.3 修法：账号级 `betas`（opt-in）

新增账号字段 `betas: string[]`（默认空），由 `betas.js` 的 `accountExtraBetas()` 过滤
（去空、去重、非字符串丢弃）后**追加在 auth mode 自己的集合之后**，并由 transport 在
**没有伪装**时自己设 `anthropic-beta`（否则这个字段只在 Claude Code 模式下生效）。

不把它塞进 `API_KEY_MIMICRY_BETAS`：上游不支持的 beta 本身就是 400，把 1M 强加给每个
api-key 账号等于用一个账号的需求去赌另一个账号的模型能不能吃这个 token。默认空还保证
"没声明的账号发出去的字节和改动前完全一样"。

### 25.4 落地位置：config，而不是 store 行

`Anyrouter` 的 `betas` 写在 `cordis.patch.yml` 的 `accounts:` 里（`host.js` 的
`STATIC_ACCOUNT_FIELDS` 同时加上 `betas`）。理由是 `reconcileConfiguredAccounts` 每次
mount 都会把静态字段刷回去、且**不碰冷却窗口**：即使 store 行被别的路径重写成没有 `betas`
的版本，重启后也会自动补回来。所以没有直接改 `~/.dsh/storages/account_pool.json`。

### 25.5 验证与遗留观察

- 全套 504 项：kernel 60 / domain 14 / upstream 18 / claude-code 46 / importer 18 /
  oauth 73 / host 53 / client 222，全绿（本次新增 7 项：claude-code 3 项——追加与去重、
  列表过滤、两种模式下的 wire；upstream 2 项——终止事件、提前离开要 cancel；domain 1 项
  默认空；host 1 项 reconcile 刷新 `betas` 且不碰冷却窗口）。
- 端到端：用 store 里的真账号 + 真凭据跑 `createPoolAdapter(...).stream({provider:'pool-nyroute'})`，
  拿到真实回复 `"收到"`；把 `betas` 去掉后同一调用**在 549ms 内**复现同一个 400，且号池状态
  仍是 `failures=0 cooldown=null` —— 与会话记录里那个「零 token、零事件、不冷却」的签名逐项吻合。
  结论不是推理出来的。

### 25.6 第二个缺陷：`message_stop` 之后上游还挂着 socket

1M 修好之后立刻暴露出第二个问题：一轮真机请求的文本 5.5s 就到齐了，但 `usage`/`finish` 要到
**40.6s** 才出现 —— 因为 `mapAnthropic` 一直读到 socket 关闭才算结束，而 Anyrouter 在
`message_stop` 之后又把连接挂了约 35s。文本早在屏幕上，agent loop 却还在等「本轮结束」的许可，
每一次工具调用都要多付这 35s。

Messages 规范里 `message_stop` 就是终止事件，`usage` 与 `stop_reason` 在它**之前**的
`message_delta` 里已经到齐，所以 `mapAnthropic` 现在在 `message_stop` 处结束迭代；同时
`parseSse` 的 finally 从「只 `releaseLock()`」改成「先 `cancel()` 再释放」，否则每轮都会漏一个
等着被 GC 的连接。

修完实测：整轮 **7.06s** 完成（原 40.57s），文本 126 output tokens，`finish.kind = stop`。
`upstream-test.mjs` 新增两项钉住它：一个 never-resolving 的事件源证明终止事件之后不会继续
pull，一个带 `cancel()` 的 `ReadableStream` 证明消费者提前离开时连接被真正关掉。

### 25.7 已知缺口

管理界面上还没有 `betas` 的输入框（host 的 `update` 动作已经接受这个字段，
`EDITABLE_ACCOUNT_FIELDS` 里有它，UI 只是没画）。当前实例走的是 config 声明这条路。

## 26. 第二个「无法启动」：DSH 在发请求之前就把这条路由否掉了

### 26.1 症状：1M 修好之后，号池路由依然整个不动

重启加载了 §25 的修复后，新会话（`session-7ff6b731`）仍然是同一个签名：记录里只有一个
session header，`turns=1 steps=1 llmMs=0 outputTokens=0`。

这次直接拿 DSH 自己当实验台：在工作流里用 provider 覆盖跑 agent —— 默认模型 ✓（`DEFAULT-OK`）、
显式 `localhost` ✓（`LOCALHOST-OK`）、`pool` 与 `pool-nyroute` 都返回 `null`（agent 失败），
另加一个**不存在的 provider** 作对照（也 `null`）。子 agent 机制没坏，是这两条路由在 DSH 里
根本不可调用。同一时刻插件自己的 transport 用真账号 + 真凭据跑
`createPoolAdapter(...).stream()`：**两条路由都正常**（7.4s；带长 system + tools 6.1s，真回复）。
所以问题既不在号池选路、也不在上游。

### 26.2 根因：被继承的 `reasoningEffort` 撞上「没声明档位」的模型

DSH 的调用链（读自 `app.asar` 里的 `dsh-llm` 与 `dsh-agent-loop`）：

- profile 的 `agent-default-model` 配置里写着 `reasoningEffort: max`，agent loop 把它当作
  **agent options** 交给每一轮（`dsh-agent-loop/lib/index.js:1172`：
  `const reasoningEffort = this.options.reasoningEffort ?? persistedReasoningEffort`）。
- 于是这一轮的调用配置是
  `{provider:'pool', model:'claude-fable-5-1-reversed', reasoningEffort:'max'}` ——
  **即使会话里存的 modelSelection 没有写 effort**，这个值照样从上面传下来。
- `llm.prepareCall` → `resolveModelInfoFor` → `normalizeModelInfo` → `resolveCallWithInfo`：
  当模型**没有** `reasoning` 元数据、而调用**带了** effort 时，它在**任何 provider I/O 之前**抛
  `provider "pool" model "claude-fable-5-1-reversed" does not support reasoning effort "max"`
  （`UNSUPPORTED_REASONING_EFFORT`，`dsh-llm/lib/index.js:2177-2178`）。
- 号池的 `resolveModel()` 当时只回 `{provider, id, name, context}` —— 没有 `reasoning`。
  所以**每一轮都死在这里**：没有 token、没有事件、没有冷却，表现就是「会话启动不了」。
  同一个 session 换成 localhost 模型就没事 —— 那些模型在 profile 目录里都声明了
  `off..max`。

这解释了为什么两个 session（`69daf001` 与 `7ff6b731`）连一条错误事件都没留下：失败发生在
会话事件写入之前，错误只出现在 UI 上。

### 26.3 修法：声明号池接受的档位，并在能编码的方言上真的编码

- `adapter.js` 新增 `POOL_REASONING_EFFORTS`：`off/minimal/low/medium/high/xhigh/max`，
  `name` 沿用 DSH 自己的拼法（`off` → `Off`），`resolveModel()` 返回
  `reasoning: { efforts }`。**故意不声明 `defaultEffort`**：一旦声明，DSH 会把它注入到
  没有点名 effort 的调用里、并作为 `adapterDefaults` 持久化 —— 那是在改用户没要求改的请求。
- 档位在**能编码的方言**上真的发出去：`buildOpenAIRequest` 现在带 `reasoning_effort`
  （`off` 不发 —— 点名 `off` 与不点名是同一个请求）。Anthropic Messages **没有**这个字段，
  所以那里的档位是「被接受但不编码」，上游模型保持自己的思考策略。这一条写在代码注释与本
  节里，不假装它生效。
- 验证：把 DSH 的 `normalizeModelInfo` + `resolveCallWithInfo` **逐行照抄**成脚本，对**旧**
  元数据跑出与线上一致的 `UNSUPPORTED_REASONING_EFFORT`（错误文案一字不差），对**新**元数据
  通过并把 effort 定为 `max`。全套 **506 项**通过（新增 2 项：档位声明、OpenAI 线的
  `reasoning_effort`）。

### 26.4 输出上限：从 transport 兜底的 4096 提到模型声明的 64000

`resolveModel()` 现在同时声明 `defaultMaxTokens: 64000`（`POOL_DEFAULT_MAX_TOKENS`）。
声明在**模型**上而不是只改 transport 兜底，是因为这才是 DSH 读的字段：
`resolveCallWithInfo` 会把 `info.defaultMaxTokens` 物化进调用配置、并标成 adapterDefault，
于是每次请求都重新派生，不会被当成用户做过的选择持久化下来。`host.js` 把同一个常量交给
transport，所以直接 `stream()` 调用与真实 DSH 轮次预算一致。

理由是实测：上游对 8192 / 16000 / 32000 / 64000 / 100000 全部返回 200，而 4096 会在
"一次工具调用 + 模型思考"就跑满、正文还没出来。64000 与 DSH 自己目录里 1M 上下文模型的写法
一致，且稳稳落在实测可接受范围内。预算只是上限，只有真正生成的 token 才计费。

上下文窗口仍声明 `200000`（不是 1M）：网上虽然带着 `context-1m-2025-08-07`，但让 DSH 更早
压缩是保守且安全的一侧，等真的需要再放开。

## 27. 撤掉模型页添加供应商卡里的「号池管理」页签

### 27.1 为什么撤

那个页签是 §23 的 DOM seat：模型页的添加供应商卡**没有可注册的插槽**（它的子插槽只有
`provider-card`、`footer`、`sign-in`），所以只能靠 `MutationObserver` 往宿主的标签行里插第三个
标签，还要自己维护 `--dsh-segment-count` / `--dsh-segment-index` 和面板显隐。代价是明确的：

- 它读宿主的 DOM 结构，宿主改版就失效，失效时只能 `console.warn` 一次；
- 「设为优先」这件事在「账号池」页里已经有完整surface（分组列表、优先开关、批量、导入），
  模型页那个 tab 只是同一件事的第二个入口，而且是**唯一一个必须靠 DOM 座位才能存在的入口**。

### 27.2 删掉了什么（`lib/client.js`，-15.5KB）

| 删掉的东西 | 说明 |
|---|---|
| `ModelsPoolCard` | 页签面板里的内容（池/分组的行 + 设为优先/取消优先） |
| `installAddPanelSeat` | 座位本体：找卡、克隆标签、观察器、几何变量、面板显隐、teardown |
| `ADD_TAB_ID` / `ADD_PANEL_ID` / `ADD_TAB_SEGMENTS` / `ADD_TAB_INDEX` | 座位用的 id 与几何常量，**连它们的 `exports` 一起**（只删定义留导出，下一轮就会炸成 ReferenceError） |
| `apply()` 里安装座位的那第三个 effect | 现在只剩字典与样式两个 effect |
| `react-dom/client` 的动态 require | 它只服务于座位，注释里那句"将来构建里没有它时只丢座位"也随之作废 |

保留不动：`settings.section`（「账号池」页）、`settings.models.provider-card`（模型页里每行
provider 下方的卡）、纯函数与样式表。模型页那张添加供应商卡现在**一个字节都不被插件碰**。

### 27.3 测试怎么跟着改

`tools/client-test.mjs` 原有约 200 行专测座位（装 tab、`aria-controls`、指示器几何、locale 跟随、
卸载、结构变了只警告一次）。现在换成**负向守卫**：把宿主的卡按原样搭出来，断言插件不去动它 ——
两个标签还在、`--dsh-segment-count` 仍是 `2`、没有 `dsh-account-pool-add-*` 的 id、没有
`data-dsh-account-pool` 标记、没有 React root、`apply()` 只有 2 个 effect、卡片移除重开也不变。

**"页签不许回来"是被测试钉住的，而不是靠删掉测试留下一片空白**：座位若被重新加回，这里第一时间
变红。全套 179 项通过。

### 27.4 这次事故本身（为什么第一遍把 DSH 弄坏了）

第一遍尝试（另一个会话）只删了 22 处编辑里的三块大定义，却留下了函数体的后半段（`render`/
`find`/`build`/观察器/`return { dispose }`）、`apply()` 里的调用点，以及那两个**只剩导出、没有
定义**的常量 —— 结果客户端半边是语法错误（`Unexpected token 'function'`），
DSH 的 `web boot` 直接报 `1 entry did not activate`，整页打不开。

两条教训，写在这里当规矩：

1. **删一个跨函数的特性要按边界整体删**：函数头、函数体、调用点、常量、导出、动态依赖、文档，
   一次删干净；判断边界靠"下一个顶层声明"，不要靠"某一层缩进的 `}`"。
2. **删完立刻跑那条特性的测试**。测试红着就停下，不要继续往下删 —— 上一次就是一路删到
   文件语法都不成立才收手。

### 27.5 遗留（已清）

这里原本记着 `dicts` 里还留着三个只有被删组件用过的键（`modelsTitle` / `modelsHint` /
`modelsEmpty`）。§28.4 那一轮做死代码清理时按源码可达性复核过一遍：这三个键当时**已经不在**
了，本节的说法是陈旧的。§28.4 另删了 17 个确实无人引用的键，现在 `dicts` 里没有死键。

---

## 28. 前端重构：单文件内部重组、状态视图、死代码清理

一次只动 `lib/client.js` 的结构性重构，行为按位保持。目标有四块：A 单文件内部重组、
B 拆多文件 chunk、C 视觉/交互重做、D 修遗留与死代码。B 的结论是**不做**（§28.5）。

重构前后的量级（以本轮重构自身结束时的文件为准）：`lib/client.js` 从 175,676 B / 2,426 行
变成 189,138 B / 2,728 行；`tools/client-test.mjs` 从 91,814 B / 1,654 行变成
93,281 B / 1,670 行，断言数从 317 涨到 325。**没有构建步骤**：这个文件仍是手写的最终
产物，`package.json` 的 `exports["./client"]` 直接指向它。

需要说明的是，本节落地期间有另一个会话在同一个 `lib/client.js` 上并行加 `ProviderPoolCard`
（模型页供应商卡的账号摘要与分组增删），所以文件此后又长到 194,109 B / 2,778 行、断言
330 项。两组改动是**叠加**的，不是互相覆盖：并行那侧的标记（`ProviderPoolCard`、
`dap-models-provider`、`providerDeleteHint`、`dap-avatar`、`dap-btn-danger`）与本节的所有
标记（三个状态组件、`dap-state`/`dap-spinner`、四个新字典键、两个新 hook、17 个死键
确实已删）在同一份文件里同时成立，`node --check` 干净、门禁 330/330 通过。

### 28.1 为什么仍然是单文件

DSH 的客户端半边是一个 `window.__ModuleLoader__.load({ id, factory })` 调用，浏览器把它
当**一个**脚本取回并求值。这个包从第一期起就是手写纯 JS（无 JSX、无 TS、无打包器），
`lib/client.js` 即成品。把它切成多个文件要换取的收益（更小的阅读单元）远小于代价：
只有一个入口能被热重载（§28.5）。所以这一轮选了 A —— **在文件内部划边界**，而不是在
文件之间。

### 28.2 A：内部重组 —— 组件与 hook 的边界

重构的核心约束来自离线测试装置：`tools/client-test.mjs` 里的假 React 只有一个全局
`cursor`，`expandNode` 会用**同一个** cursor 去调用任何 `typeof node.type === 'function'`
的子组件。所以：

> **被抽出来的子组件必须是 hook-free 的**（props 进、元素出）；只有 `PoolSection`
> 和测试显式挂载的那几个表单面板（`SupplierForm` / `AccountForm` / `GroupForm` /
> `OAuthPanel`）可以调 hook。

自定义 hook 只在**从 `PoolSection` 的 render 内部调用**时才允许抽，因为要保住调用顺序 ——
`useQuotaQueue` 就因此被否决（它需要 `visible`，而 `visible` 算在 hooks 之后）。

按这个约束落地的结构：

| 区 | 内容 |
| --- | --- |
| § 1 | 常量：路由、id、词表 |
| § 2 | 字典 `zh` / `en`，键集一致 |
| § 3 | 样式表，一个 `<style>`，作用域在 `.dap-root` |
| § 4 | hooks —— 唯一有状态的代码 |
| § 5 | 纯函数（无 React、无 DOM） |
| § 6 | 原语：所有面板复用的无 hook 积木 |
| § 7 | 额度视图 |
| § 8 | 行组件：一条账号行、一条用量行 |
| § 9 | 表单：供应商接入、账号编辑/新建、分组编辑/新建 |
| § 10 | OAuth 面板 |
| § 11 | 页面外壳：头部、汇总卡、以及三个状态视图 |
| § 12 | 面板：每个页签主体、表单、工具栏，全是无 hook 组件 |
| § 13 | `PoolSection` —— 设置页，持有全部页面状态 |
| § 14 | 供应商卡 + 注册 |

§ 4 的 hook 调用顺序是契约，按序为：`useJson`、`useAction`、`useResetCredits`、
`useAccountQuotas`、`useMoreMenuDismissal`、`useNow`。§ 12 的 15 个面板组件
（`PoolHeader`、`PoolCards`、`PoolToolbar`、`PoolPagination`、`PoolTabs`、
`ActionResultPanel`、`GroupsPanel`、`UsagePanel`、`AccountsPanel`、`TestPanel`、
`BatchEditPanel`、`ImportPanel`、`BatchBar`、`AccountUsagePanel`，加上 § 11 的三个状态视图）
一律 hook-free，`PoolSection` 负责算好值、组好节点、以 props 传下去（prop drilling 是
这里接受的做法）。

新抽出的 hook：

- `useResetCredits(t, action, quotaData)` → `{ confirmation, setConfirmation, error,
  setError, begin, confirm, cancel, restoreFor }`：重置请求的账本，落在
  `sessionStorage` 的 `dsh-account-pool:pending-resets` 上，按 `RESET_ID_PATTERN`
  过滤（只收 v4 UUID 形状的 id），最多留 100 条。
- `useMoreMenuDismissal()`：行内「更多」菜单的关闭，监听 `pointerdown`、Esc、
  捕获阶段的 `scroll`、以及 `resize`。
- `useNow(intervalMs = 1000)`：给冷却倒计时用的时钟。

抽组件时踩到并修掉的坑，记在这里当规矩：`AccountsPanel` 少传了 `onToggleOne`
（`ReferenceError: toggleOne is not defined`）；`BatchBar` 第一版**改掉了删除语义**
（补 `onDelete` prop 才恢复两段式批量删除）。**行为按位保持**是这一阶段的硬要求 ——
两段式批量删除、重置请求 id 账本、导入时「未分组就不发 group」这三条都不许动。

### 28.3 C：首屏三态与重试

首屏原来只有一行文字。现在三种状态各有自己的组件，都在 § 11、都 hook-free：

- `PoolLoadingState`：`role="status"` + `aria-live="polite"`，一个 `.dap-spinner`、
  标题、以及一句「正在向 Host 请求账号、分组与用量数据」。**不给重试按钮** ——
  什么都还没失败。
- `PoolErrorState`：`role="alert"`，一个图标、标题「无法读取账号池」、一句指出最可能
  原因的提示（后端是否已重启）、**原样保留** Host 返回的 `message`（放在
  `.dap-state-detail` 里，等宽字体），以及一个「重新读取」按钮，点了就把 `nonce` 加一
  触发重取。
- `PoolEmptyState`：`{ icon, message }`，替掉了三处重复的内联空态（分组、用量、账号列表）。

`PoolSection` 的两个提前 return 改成渲染 `PoolLoadingState` / `PoolErrorState`。新增 4 个
字典键 × 2 种语言（`loadingHint`、`loadFailedTitle`、`loadFailedHint`、`retryLoad`），
以及 `.dap-state*`、`.dap-spinner`、`@keyframes dap-spin` 一套 CSS，并把
`prefers-reduced-motion` 的覆盖扩到 spinner（动画时长拉到 2.4s，不是直接停）。

### 28.4 D：死代码清理

两条都按**源码可达性**判定，不按测试覆盖率 —— 测试没跑到不等于死键（实测有 74 个键
没被这套测试跑到但都是活的）。

**字典死键**：建了一个一次性探针，把 `client-test.mjs` 复制一份，在 `locale.bind`
里记下 `usedKeys`，报告时以 `dicts.zh` 的声明列表为准，**只**把两个字典块从源码里剥掉，
再看剩下的源码里有没有 `'key'` / `"key"` 出现。结论是删掉 17 个键：`accountDetails`、
`actPrefer`、`actQuota`、`actUnprefer`、`batchPartial`、`colCooling`、`colCredential`、
`colGroups`、`colPlatform`、`colQuota`、`groupRoutes`、`no`、`preferred`、`providerTitle`、
`quotaUsageNotSupported`、`quotaUsed`、`yes`。zh / en 两侧同步删。

**重复词表**：逐条核过，**全是活的**（`PLATFORMS`、`AUTH_MODES`、`SELECTION_MODES`、
`MIMICRY_MODES`、`POOL_DETECTION_KEYWORDS`、`SUPPLIER_PLATFORMS`、`USAGE_LIMIT`、
`RESET_ID_PATTERN`、`WINDOWS`），没有可删的。

**孤儿 CSS**：用「CSS 里定义了 `.dap-x`，但 CSS 块之外没有任何地方引用」判定，删了 11 条
规则（`dap-add-panel`、`dap-btn-icon`、`dap-dot`、`dap-field-wide`、`dap-models`、
`dap-models-bare`、`dap-models-head`、`dap-models-title`、`dap-models-row`、
`dap-models-name`、`dap-preferred`）。判据要用「`.dap-x` 后面跟非标识符字符」这种正则，
否则会把 `.dap-foo-bar` 当成 `.dap-foo`。剩下 4 条报出来的
（`dap-pill-ready` / `dap-pill-cooling` / `dap-pill-failed` / `dap-pill-idle`）是**误报**：
它们由 `` `dap-pill dap-pill-${props.tone}` `` 拼出来，是活的，不能删。

删 CSS 之前先备份 `lib/client.js`，每条规则都断言「命中且只命中一次」再删，删完 `node
--check` 加跑全套测试。

### 28.5 B：拆多文件 chunk —— 查清了，决定不做

DSH 确实支持包内 chunk，机制在 `@deepseek-ai/dsh-client-modules` 里，全都核过了：

- 浏览器侧 `require.async(spec)`：要求 `spec.startsWith("./")`，取 `spec.slice(2)`
  当文件名，`CLIENT_CHUNK` 正则校验（`/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/`），
  然后走 `importChunk(ownerId, fileName)`。**返回 Promise。**
- Host 侧 `chunkResponse` 读 `join(dirname(clientPath), fileName)`，即 `client.js`
  的同级兄弟文件，以 `/plugins/<id>/<fileName>?rev=<rev>` 提供。
- 官方自己的用法是 `React.lazy(async () => ({ default: (await require.async("./client.pdf.js")).PdfBody }))`
  —— 也就是 **chunk 必须挂在异步边界后面**。

不做，理由三条：

1. **这个前端没有天然的异步边界**。设置页是一个同步 render 函数，要挂 chunk 就得给它
   套 `React.lazy` + `Suspense`，等于为了拆文件引入一层新的加载态 —— 与 §28.3 想减少
   状态、而不是增加状态的意图相反。
2. **热重载会退化**。现在改 `lib/client.js` 只需刷新页面（浏览器重新 HTTP 取回）。一旦
   拆出 `client.<name>.js`，**只有入口还热重载**；改任何 chunk 都要**完整重启 DSH**
   （Node ESM 缓存按解析后的 URL 缓存、从不驱逐，见 `cordis.patch.yml` 头部）。
   而且 `chunkUrl()` 要求 owner bundle 的 URL 资源段正好是 `${row.id}/client.js`，
   `rev` 由**入口**文件的 mtime/size 推出，chunk 自身是 `immutable` 缓存的 —— 也就是
   chunk 一改就得换入口的 rev 才能失效。
3. **收益与代价不成比例**。`client-test.mjs` 用 `new Function(...)` 求值单一源码字符串，
   预览装置也用单一 bundle；两边都得改成能模拟 chunk 解析。而已安装的插件里**没有一个**
   是这么发的。为一个 189KB 的手写文件换这些，不值。

一句话：**能力是真的，收益是假的**。留着这条结论，将来文件真涨到需要拆时再回来。
