# 账号池本机 OpenAI-compatible API

本模块让**本机的原生程序**通过 Chat Completions 或无状态 Responses 调用现有账号池。它不是完整 OpenAI API 实现，不是公网服务，也不是独立守护进程。DSH Host 必须持续运行。Responses 出口从 **0.4.24 / runtime 0.4.47-local-responses** 起提供；只安装文件但未重启旧 Host 时，旧进程仍不会提供新协议。

## 开启与客户端配置

1. 打开 **设置 → 账号池 → 设置 → 本机 API**。默认关闭。
2. 先生成随机 API Key，复制并安全保存；生成/轮换响应仅显示一次，不会把明文密钥放入账号池配置表或模型列表。
3. 启用服务，默认端口 `19389`。
4. 在本机客户端填写：
   - Base URL：`http://127.0.0.1:19389/v1`
   - API Key：刚生成的本机 API Key（**不是上游账号密钥**）。
   - Model：账号池可用的模型 ID。

必须使用 `127.0.0.1`，不能换成 `localhost`、电脑名、局域网 IP 或反向代理域名。轮换立即影响**之后认证的新请求**；已经通过认证的请求可以完成。关闭服务会取消正在进行的请求并关闭本机连接，不会销毁共享账号池 adapter。

### Project Graph 桌面版

- AI API Base URL 填 `http://127.0.0.1:19389/v1`，不要使用 localhost、局域网 IP 或反向代理地址。
- 填账号池页面生成的独立 Key 与可用模型 ID，无需更换现有 Key。Project Graph 的 OpenAI-compatible provider 使用 `/chat/completions`，网关同时保留 Responses。
- 原因：Project Graph 使用 Tauri 的原生 HTTP 插件，该插件会自动添加 WebView 的 Origin；0.4.24 及更早网关将任何 Origin 视为浏览器而拒绝，造成认证前403。0.4.26 针对标准 Tauri 来源修复，不是放开所有网页。
- 升级需要重启 DSH Host 才能换用新入口；刷新页面或在旧 Host 上重试不会更新其已加载代码。升级保留现有开关、端口和密钥，不自动重发真实模型调用。
- 依据：[Project Graph AIEngine](<https://github.com/graphif/project-graph/blob/master/app/src/core/service/dataManageService/aiEngine/AIEngine.tsx>)、[Tauri HTTP Origin 注入](<https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/http/src/commands.rs>)、[原生 fetch 不受浏览器 CORS 限制](<https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/http/guest-js/index.ts>)。

### PowerShell 示例

使用环境变量保存本机 Key，避免把 Key 写入脚本或命令历史。下面假设已设置 `$env:ACCOUNT_POOL_API_KEY`：

```powershell
$base = 'http://127.0.0.1:19389/v1'
$headers = @{ Authorization = "Bearer $env:ACCOUNT_POOL_API_KEY" }
Invoke-RestMethod -Uri "$base/models" -Headers $headers

$request = @{
  model = '实际模型ID'
  messages = @(@{ role = 'user'; content = '请用一句话介绍自己。' })
  stream = $false
} | ConvertTo-Json -Depth 10
Invoke-RestMethod -Uri "$base/chat/completions" -Method Post `
  -Headers $headers -ContentType 'application/json; charset=utf-8' `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($request))
```

如需分组与粘性会话：

```powershell
$headers['X-Account-Pool-Group'] = '分组ID' # 填真实groupId，不是分组显示名或pool-前缀路由
$headers['X-Account-Pool-Session'] = 'my-native-client-session-1'
```

实际 groupId 仅允许 1–128 个 ASCII 字母、数字、点、下划线、连字符，首字符须为字母或数字。示例中的中文占位符必须替换。

## HTTP 接口

以下三个端点均要求 `Authorization: Bearer <本机Key>`：

| 端点 | 说明 |
| --- | --- |
| `GET /v1/models` | 调用同一 adapter 的 `listModels(provider)`；返回 OpenAI `list`，每个模型仅有 `id/object/created/owned_by`。不返回账号 ID、凭据、上游 URL、配额、内部诊断。`created=0`，`owned_by=account-pool` 为固定公共占位值。 |
| `POST /v1/chat/completions` | 经严格验证后调用**同一 `adapter.stream`**。保留既有分组、模型 allow-list、粘性、并发限制、冷却、限流重试/故障切换、用量与耗时统计。 |
| `POST /v1/responses` | 无状态 Responses 文本、函数工具和内联图片输入；返回 Responses JSON 或具名 SSE 事件。使用与 Chat Completions 相同的 adapter、鉴权与路由。 |

不接受查询参数、尾部斜杠、其他路径、GET body 或自定义上游地址。Responses 的 retrieve/delete/cancel/compact、embeddings、音频等端点未实现。请求类型须为 `application/json`，可带 `charset=utf-8`；不支持压缩请求体。

- 不传 `X-Account-Pool-Group`：使用默认 `pool`，即整个账号池。
- 传 groupId：使用 `pool-<groupId>`。无此分组/已禁用分组不会回退到全部账号；模型列表为空，生成通常返回 503。
- `X-Account-Pool-Session` 可省略；省略则不创建外部客户端粘性身份。值须为 1–256 个非空白可打印 ASCII 字符。
- 外部会话 ID 与分组一起 SHA-256 后加 `local-api:` 前缀，避免冒充 DSH 内部会话，也避免不同分组互相覆盖绑定。相同外部 ID、相同分组稳定复用身份；其粘性仍服从分组策略。
- 分组 header 是**选路**，不是多租户权限隔离：持有本机 Key 的程序可以选择任意可用分组。

## Responses 出口

沿用相同 Base URL 和 API Key，将端点改为 `/v1/responses`。例如 Python OpenAI SDK：

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:19389/v1",
    api_key=os.environ["ACCOUNT_POOL_API_KEY"],
)
result = client.responses.create(
    model="实际模型ID",
    input="请用一句话介绍自己。",
    store=False,
)
print(result.output_text)

with client.responses.stream(
    model="实际模型ID",
    input="写一句问候。",
    store=False,
) as stream:
    for event in stream:
        if event.type == "response.output_text.delta":
            print(event.delta, end="", flush=True)
```

### 请求支持与无状态边界

- 必填 `model` 与 `input`。`input` 可为字符串或完整历史数组；支持简写 `{role, content}` 和 `type:message`。消息角色为 user/assistant，以及对话开头的 system/developer。`instructions` 为文字，按顺序与前置指令合并。
- 内容支持 `input_text`；assistant 历史支持 `output_text`（仅空 annotations/logprobs）。`input_image` 仅支持 user/工具结果中的规范内联 PNG/JPEG/WebP/GIF data URL、detail:auto，且必须通过相同模型图片能力检查。不会下载远程 URL 或读取文件。
- 工具为扁平 Responses function 定义：`{type:"function", name, description?, parameters?, strict:false}`。只支持省略/false 的 strict，不承诺严格结构化输出。`tool_choice` 只支持 auto/none；none 删除新工具声明，但保留历史调用/结果。网关不执行工具。
- 历史 `function_call` 保留 `call_id/name/arguments`；`function_call_output` 用 `call_id` 匹配前面的调用，`output` 支持文字或 input_text/input_image 列表，并为共享 adapter 补充工具名。每次请求请回传完整历史，包括之前的调用、结果和助手消息。
- 默认且仅支持 **store:false**；previous_response_id 仅可省略/null，background 仅可省略/false，include 仅可省略/[]。没有服务端响应存储或响应 ID 续接，也不会把上游 response ID/密文交给本机客户端。
- 因此依赖 `previous_response_id`、`include:["reasoning.encrypted_content"]`、非空 `encrypted_content`、item_reference、conversation、WebSocket、后台任务或内置 web_search/computer 等工具的客户端**不能宣称完全兼容**，会明确 400。不要直接假定 Codex CLI 的所有请求模式受支持。
- 历史 reasoning 只接受公开 `summary_text`，转成带 `[Prior assistant reasoning summary]` 标识的 assistant 文本；不是原生加密 reasoning 续接。缺省/null/空 encrypted_content 可接受，非空拒绝。
- 选项：stream:boolean、temperature:0–2、max_output_tokens:正32位整数、reasoning:{effort, summary?}。effort 为 none/minimal/low/medium/high/xhigh/max，none 映射到池的 off；summary 仅支持明确非 none effort 时的 auto。不支持单独 summary、concise/detailed。预算/温度/effort 的供应商差异与下方 Chat Completions 说明相同。
- 仅支持 `text:{format:{type:"text"}}`。structured output、parallel_tool_calls、强制/指定工具、未知字段及除上述例外外的显式 null 均拒绝，不静默忽略。

### JSON / SSE 返回

- JSON 为 `object:"response"`，生成独立 `resp_` ID，`output` 包含 assistant message/output_text、function_call，以及可见 reasoning summary；返回 `store:false`，不会提供上游 ID、私有 replay、签名或密文。未知用量返回 usage:null，不按文本估算。
- SSE 使用 `event: <type>` 和同类型 `data` JSON，带从0单调递增的 sequence_number。包括 response.created/in_progress、output_item.added/done、content_part.added/done、output_text.delta/done、function_call_arguments.delta/done，以及公开 reasoning_summary_* 事件。Responses 末尾**不发送 [DONE]**。
- 正常结束以 response.completed 收尾；输出预算结束/content_filter 为 response.incomplete，并有 incomplete_details.reason。只有共享 adapter 迭代器正常穷尽后才发送终态；不能把收到的第一个 finish 当成功。
- 首次可公开输出前仍保留 HTTP 4xx/502/503 错误；SSE 已开始后失败发送脱敏 response.failed，不再发送成功终态。断连、无法写出的失败帧或没有合法终态的 EOF 必须当失败，而不是凭 HTTP 200 判断成功。
- 工具名多数仅在 block-end 才出现，因此缓冲完整工具后发送合法 function_call item 和完整参数 delta；文本即时流式。output_index 按首次公开 item 分配并保持稳定，工具尚未可公开时可能排在之后已流出的文本后面。
- usage 使用池的真实不重叠计数：input_tokens = input + cacheRead + cacheWrite；output_tokens 含 reasoning，不重复相加；附带 cached_tokens/reasoning_tokens details。

线协议参考 [OpenAI 官方 Node SDK 类型](<https://github.com/openai/openai-node/blob/v4.104.0/src/resources/responses/responses.ts>)及其 [Responses 流式消费器](<https://github.com/openai/openai-node/blob/master/src/lib/responses/ResponseStream.ts>)。本机网关实现的是上述明确列出的兼容子集，而不是全部 OpenAI 服务端能力。

## Chat Completions 支持的请求范围

### 消息与工具

- `model` 必填，非空模型 ID（至多 256 字符，不含控制字符或空白）。不强制出现在 `/models`，因为池内可能有允许任意模型的账号。
- `messages` 非空数组；支持 `system`、`user`、`assistant`、`tool`。
- 所有 `system` 消息必须在对话消息之前，仅支持文字。多个前置 system 消息按顺序以两个换行合并成 adapter 的单个 system 指令。
- 文字可用字符串，或 `[{"type":"text","text":"..."}]`；assistant 发工具调用时允许 `content:null`。
- 支持 assistant `tool_calls` 的标准 function 格式；`function.arguments` 必须是**JSON 对象编码成的字符串**，避免跨协议把非 JSON 参数改写成另一语义。
- 支持 `role:tool` + `tool_call_id` + 文字结果；结果必须引用此前的、尚未回答的工具调用。本机网关会补充工具名，供 native transport 使用。
- `tools` 最多 128 个，只支持 function；函数名遵循 `[A-Za-z0-9_-]{1,64}`，支持 description 和 object JSON Schema parameters。省略 parameters 等于空 object schema。
- 工具定义只声明给模型，**网关不会执行工具**。客户端负责执行并回传工具结果。
- `tool_choice` 仅支持省略或 `"auto"`。`strict` 只支持省略或 `false`；不承诺严格结构化输出。

### 图片

仅在该池路由/模型的 `resolveModel` 宣告 `image` 输入时接受；混合不支持图片的账号会按能力交集拒绝，不能借图片请求绕过分组。

```json
{
  "type": "image_url",
  "image_url": {
    "url": "data:image/png;base64,<规范base64>",
    "detail": "auto"
  }
}
```

支持 user/tool 消息中的 PNG、JPEG、WebP、GIF **内联 data URL**；按原位置转换为 native image block。`detail` 仅支持省略/auto。不下载 HTTP(S) URL，不访问 `file:` 路径，不接受 durable attachment ID，也不支持 assistant/system 图片。不支持时明确 400。上游格式校验、媒体限制仍生效。

### 生成选项与供应商差异

| 字段 | 本机网关处理 |
| --- | --- |
| `stream` | 可省略/false 返回一次 JSON；true 返回 SSE。底层始终调用 adapter.stream。 |
| `stream_options.include_usage` | 仅在 stream=true 时接受 boolean；true 时成功 finish 后增加 choices=[] 的 usage chunk。未收到真实用量时 usage=null，不伪造 token 数。 |
| `temperature` | 0–2 的有限数，传为 adapter.temperature。 |
| `max_tokens` / `max_completion_tokens` | 二选一的正 32 位整数；均映射到 adapter 的单一 maxTokens 预算。null 不等于省略。**不承诺所有供应商都实现 OpenAI 的两种预算区别。** |
| `reasoning_effort` | 支持 off/minimal/low/medium/high/xhigh/max；OpenAI `none` 映射为池的 off。按 adapter 的模型能力验证，沿用该路由配置的 effort 映射。 |
| `n` | 仅省略或 1。 |

**继承既有 transport 的限制，而非额外更改上游协议：**

- Codex OAuth transport 不发送 `temperature`、`maxTokens`（其端点不接受）；这两个字段在该路由上不会形成温度/输出上限保证。需要严格预算的调用请使用支持该预算的池分组。
- API-key Responses 使用 `max_output_tokens`，既有 transport 最小值为 16；Chat Completions 使用 `max_tokens`；Anthropic 使用 `max_tokens`；Gemini 使用 `maxOutputTokens`。reasoning token 是否计入预算由供应商决定。
- Anthropic 的 reasoning_effort 属于池的 advisory 设置，既有 Messages transport 不直接发送 effort 字段；Gemini 根据模型转换为 thinking budget/level；Codex/Responses 使用各自原生 effort。
- off/none 表示池现有“关闭/不发送显式 effort”行为，并不保证每种模型停止思考。不要将它理解为跨供应商强制禁用 reasoning。
- 未显式提供预算/温度时沿用共享 adapter/transport 默认值。不会自动注入其他 OpenAI 参数。

除以上 allow-list 外的请求字段均明确 400，例如 `stop`、`top_p`、`seed`、`response_format`、`logprobs`、`logit_bias`、`user`、`store`、`metadata`、`service_tier`、`parallel_tool_calls`、旧版 `functions/function_call`、强制/指定/none tool_choice。消息 `name`、developer 角色、音频、视频、拒绝块和自定义 native options 同样拒绝。没有“接受但悄悄丢弃”的通用 passthrough。

## Chat Completions 返回、流式错误与用量

- 非流式返回 `chat.completion`，含 id、created、model、choices；正常完成原因映射为 stop/length/tool_calls/content_filter。
- SSE 返回 `chat.completion.chunk`；首次有可公开输出才提交 HTTP 200，首先发送 assistant role；成功时最后发送 finish、可选 usage、`data: [DONE]`。
- 上游多数 tool-call-delta 暂时没有函数名，因此网关**缓存单个工具到 block-end，再用一个合法 tool_calls delta 输出完整调用**。它不是每个参数字符实时透传；工具 index 为从 0 开始的稠密序号。
- 上游可见 reasoning summary 以兼容扩展 `reasoning_content` 返回（JSON message 或 SSE delta）。不输出私有 replay 状态、加密 reasoning、签名、内部元数据。未请求也可能由上游生成 summary。
- 用量只采用 adapter usage chunk，按池的增量语义累计；`prompt_tokens = inputTokens + cacheReadTokens + cacheWriteTokens`，`completion_tokens = outputTokens`（reasoning 不重复加），并提供 cached_tokens/reasoning_tokens details。没有用量时 JSON 省略 usage。
- 首输出前：参数/能力错误 400，认证失败 401，本机安全边界拒绝 403，路径/方法 404/405，超限 413，编码 415，池无可用账号/超时通常 503，其他上游失败 502。
- SSE 开始后：发送 `event: error` 和 `data: {"error":...}`，然后关闭流；**不再发送成功 finish 或 [DONE]**。客户端必须把 error 或无成功终止的 EOF 当作失败，不能仅凭 HTTP 200 判断成功。
- adapter 的 finish 之后还会继续读取到迭代器正常结束，确保最终统计/异常没有被提前转换成成功。
- 不对外复制上游错误原文、任意错误 code、账号标识、URL、栈、密钥；消息与 code 来自有限公共错误投影。

## 安全与资源限制

- 仅绑定 IPv4 `127.0.0.1`，检查远端地址，Host 必须**精确为 `127.0.0.1:<当前端口>`**。不信任 Forwarded/X-Forwarded-*。
- 接受没有 Origin 的原生服务；从 **0.4.26 / runtime 0.4.49-local-tauri** 起，也接受恰好一个且精确等于 `http://tauri.localhost`、`https://tauri.localhost` 或 `tauri://localhost` 的标准 Tauri Origin。用于 Project Graph 等原生 Tauri HTTP 插件兼容；Origin 不是应用身份证明，允许值仍必须满足回环连接、精确 Host 和独立 Bearer 鉴权。
- 其余 Origin（包括空值/null、重复值、伪装后缀、端口/路径变体、localhost 开发网页及公网网页）继续拒绝。不开通浏览器 CORS、不跳过 OPTIONS 鉴权；Tauri HTTP 插件通过原生 reqwest 发请求，本身不受浏览器 CORS 限制。浏览器、浏览器扩展和远程反向代理仍不是受支持客户端。
- Bearer 校验先 SHA-256 为固定长度摘要，再 `timingSafeEqual`。Key 验证 32–4096 个可打印非空白 ASCII 字符；**长度并不证明随机性**，Host 负责用密码学随机源生成 Key。
- 默认请求体上限 **8 MiB**，同时检查 Content-Length 与实际字节，严格 UTF-8/JSON；默认总请求时限 **120 秒**，涵盖上传、能力查询、上游等待和 SSE 背压。
- 输出文字/工具参数累计上限 **16 MiB**，最多 4096 个 block；超限失败而非悄悄截断。流式写满 socket 缓冲会等待 drain，不继续拉取 adapter。
- 断开、超时、关闭均通过同一个 AbortSignal 取消 adapter，并尝试 iterator.return。关闭最多额外等待 **250 ms** 让 cooperative transport 释放并发槽并记录失败用量；不合作的第三方 iterator 不会无限卡住 Host，不能承诺它的外部资源已立即释放。
- 本机明文 HTTP 的安全前提是可信本机进程。Key 持有者拥有池调用能力；不要分享给不可信程序，不要把端口代理到其他网卡。

## 独立模块接口与离线测试

模块为 [lib/local-api.js](lib/local-api.js)，协议实现为 [lib/local-api-protocol.js](lib/local-api-protocol.js)：

```js
const api = await createLocalApiServer({
  adapter,                 // 已有同一个pool adapter
  apiKey,                  // Host管理的随机Key，最少32字符
  port: 19389,             // 独立模块允许0用于测试；生产管理层限制端口
  requestTimeoutMs: 120_000,
  maxBodyBytes: 8 * 1024 * 1024,
});
// api.port 为真实端口；api.baseUrl 含 /v1
api.setApiKey(newRandomKey); // 原子更新认证，不重绑端口，不中止已认证请求
await api.close();          // 幂等；不关闭adapter
```

离线测试包括 [Project Graph/Tauri 边界回归](<tools/local-api-tauri-test.mjs>)、[网关与 Chat 测试](<tools/local-api-test.mjs>)、[Responses 请求解析](<tools/local-api-responses-request-test.mjs>)、[Responses JSON/事件](<tools/local-api-responses-output-test.mjs>)及 [Responses HTTP 集成](<tools/local-api-responses-http-test.mjs>)。仅启动本机 fake adapter/server，另用真实 pool adapter + fake upstream 检查分组/故障切换/冷却/粘性/用量；没有真实上游调用。

```powershell
node tools/test.mjs local-api
node tools/test.mjs local-responses
node tools/test.mjs local-tauri
```
