# dsh-account-pool — 设计文档（第一期：最小闭环）

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

- ❌ 上游身份伪装（Claude Code 系统提示词复刻、`cc_version` 同步、TLS 指纹、UA 对齐）
- ❌ 多租户、API Key 发放、订阅、支付、兑换码
- ❌ 集群一致性（Redis 快照 + outbox 广播）
- ❌ 对外 HTTP 网关（`/v1/messages` 等）—— 见第 10 节"第二期"
- ❌ 图片/视频/音频计费，只做 token

> **为什么砍掉伪装层**：它是 sub2api 工作量的主要部分（见 [gateway_service.go:38-57](../_sub2api/repo/backend/internal/service/gateway_service.go#L38-L57)
> 逐字内嵌真实 Claude Code 系统提示词的注释），也是封号风险的来源。自用场景不需要对上游伪装成官方 CLI；
> 一旦需要，就是持续对抗维护，而不是一次性工程。

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
