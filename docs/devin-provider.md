# Devin Sessions provider

WindsurfAPI 可以选择性地把 [Cognition Devin](https://devin.ai) 的官方 REST API 包装成 OpenAI / Anthropic 兼容端点 —— 让任何已经在用 `/v1/chat/completions` 或 `/v1/messages` 的客户端（OpenAI SDK / Anthropic SDK / Claude Code / Cursor / Cline）也能直接驱动 Devin session。

> ⚠️ 该 provider **完全独立于 Windsurf 账号池**：用的是你自己的 Devin API key、消耗你自己的 Devin org ACU 预算。Windsurf 账号是否登录、Language Server 是否启动，都不影响它。
> 没有 `DEVIN_API_KEY` 时，`devin*` 三个模型不会出现在 `/v1/models` 里，也不会触发任何上游调用。

## 模型清单

| 模型名         | `max_acu_limit` 默认 | 适用场景                                                          |
| -------------- | -------------------- | ----------------------------------------------------------------- |
| `devin`        | 由 Devin 决定        | 一般 agent 任务，让 Devin 自己估算预算                            |
| `devin-fast`   | `5`                  | 短任务 / 单次问答 / 想严格控制 ACU 消耗的场景                     |
| `devin-deep`   | `50`                 | 大型 refactor / 复杂调研 / 你愿意烧 ACU 让它跑久一点的场景         |

如果想在不重写代码的情况下临时改 `max_acu_limit`，在请求体的 `metadata.devin_max_acu` 里塞一个正整数就行（OpenAI body 原生支持 `metadata`）。

## 环境变量

复制 `.env.example` 顶上的 Devin 段，最少只要填 `DEVIN_API_KEY`。

| 变量                                | 默认                    | 说明                                                                                       |
| ----------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------ |
| `DEVIN_API_KEY`                     | **必填**                | Devin org 的 API key。Service-user key 以 `apk_` 开头，个人 key 以 `apk_user_` 开头。     |
| `DEVIN_API_BASE`                    | `https://api.devin.ai`  | 自定义只在 Devin Enterprise 上才需要。                                                     |
| `DEVIN_DEFAULT_SNAPSHOT_ID`         | —                       | 给每个 session 默认带上的 snapshot（仓库环境）id。可被 `metadata.devin_snapshot_id` 覆盖。 |
| `DEVIN_DEFAULT_PLAYBOOK_ID`         | —                       | 给每个 session 默认带上的 playbook id。可被 `metadata.devin_playbook_id` 覆盖。            |
| `DEVIN_POLL_INTERVAL_MS`            | `2000`                  | 轮询 `GET /v1/sessions/{id}` 的间隔。                                                      |
| `DEVIN_MAX_WAIT_MS`                 | `600000` (10 分钟)      | 同步等待 session 完成的总超时。超时后返回 `finish_reason=length`，但 session 仍然继续跑。  |
| `DEVIN_SESSION_CACHE_TTL_MS`        | `3600000` (1 小时)      | 指纹 → session_id 缓存的 TTL。                                                             |
| `DEVIN_SESSION_CACHE_MAX_ENTRIES`   | `1000`                  | 指纹缓存条目上限。超出后 LRU 淘汰。                                                        |

## 工作原理

Devin 不是模型推理服务，它是一个 async session 任务系统。每个"对话"实际上是：

1. **创建 session**：把 OpenAI `messages[]` 拼成单个 prompt 字符串（带 `<system>/<user>/<assistant>` 标签），调用 `POST /v1/sessions` 拿到 `session_id`。
2. **轮询**：每 `DEVIN_POLL_INTERVAL_MS` 调一次 `GET /v1/sessions/{id}`，直到 `status_enum` 变成 `finished` / `blocked` / `expired`，或者超过 `DEVIN_MAX_WAIT_MS`。
3. **聚合**：把 session 在这一轮产生的所有 `devin_message` / `assistant_message` 事件拼成一段 assistant 文本，按 OpenAI 响应格式返回。如果 Devin 开了 PR，PR 链接会被追加到响应末尾。

### Session 复用（自动指纹续聊）

普通 OpenAI 客户端的多轮对话长这样：

- 第 1 次请求：`[{user: "hi"}]`
- 第 2 次请求：`[{user: "hi"}, {assistant: "hello"}, {user: "follow-up"}]`

WindsurfAPI 会把"除最后一条 user 之外的所有消息"做一个 SHA-256 指纹，存进进程内缓存（默认 1 小时 TTL）。下一次请求带着扩展后的 history 来时，去掉新 user turn、计算指纹，如果命中就直接调 `POST /v1/sessions/{id}/message` 把新 user 发给原 session —— **不会重新创建一个 session 烧 ACU**。

每完成一轮，再用"完整 history（含本轮 assistant 回复）"的指纹把 session_id 重新存一份，保证下一轮还能命中。

### 手动指定 session

如果你想精确控制 session 而不依赖指纹，在请求里加一个 HTTP header：

```http
X-Devin-Session-Id: devin-XXXXXXXXXXXX
```

WindsurfAPI 会直接把这个 session 当成目标，把最后一条 user 消息作为 follow-up 发过去。指纹缓存被完全跳过。

返回响应里也会带这个 header，方便你下一轮继续用：

```http
x-devin-session-id: devin-XXXXXXXXXXXX
x-devin-status: finished
```

### 流式（SSE）

`stream: true` 走伪流式 —— 每次轮询 Devin session，如果发现新的 `devin_message` 事件，就以 OpenAI chat completion chunk 的形式发给客户端。这意味着：

- 客户端能渐进地看到 Devin 的输出，不会被 OpenAI SDK 的超时干掉
- 真正的 token-level streaming 是做不到的（Devin API 不暴露），但每条 Devin agent message 都会立刻 flush
- 心跳：每 15s 发一次 SSE comment 防代理掐连接

## OpenAI 客户端示例

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3003/v1", api_key="sk-anything")

# 非流式（小心 10 分钟超时，长任务建议开 stream）
resp = client.chat.completions.create(
    model="devin-fast",
    messages=[
        {"role": "system", "content": "you are a code assistant"},
        {"role": "user",   "content": "list the files in this repo"},
    ],
    metadata={"devin_max_acu": 3},
)
print(resp.choices[0].message.content)
print("session:", resp.x_devin["session_id"])

# 续聊 — 第二轮把第一轮的回复带上，指纹缓存会自动找到同一个 session
followup = client.chat.completions.create(
    model="devin-fast",
    messages=[
        {"role": "system", "content": "you are a code assistant"},
        {"role": "user",   "content": "list the files in this repo"},
        {"role": "assistant", "content": resp.choices[0].message.content},
        {"role": "user",   "content": "now read README.md"},
    ],
)
```

## Anthropic 客户端示例

`/v1/messages` 在内部走的是 OpenAI 翻译层 → `handleChatCompletions` → Devin adapter，所以 Anthropic SDK 也能直接拿来用：

```python
import anthropic

client = anthropic.Anthropic(base_url="http://localhost:3003", api_key="anything")
msg = client.messages.create(
    model="devin",
    max_tokens=1024,
    messages=[{"role": "user", "content": "summarize https://github.com/WHUT666/WindsurfAPI"}],
)
print(msg.content[0].text)
```

## 限制与注意

- **OpenAI `tools` 字段被忽略**：Devin 有自己的工具调用系统（shell、浏览器、文件读写），不接受外部 tool schema。如果客户端在 OpenAI 请求里塞了 `tools`，Devin 会照常工作但不会发回 `tool_calls`。
- **多模态降级**：Devin v1 API 是纯文本的。`image_url` / `input_image` 部分会被替换成 `[image: <url>]` 占位符告诉 Devin "用户上传了一张图"。需要视觉理解请用别的 provider。
- **缓存只在单进程内**：指纹 → session 缓存不是分布式的。多 worker 部署 / 横向扩容时不同副本可能会创建不同的 session。需要严格 session 路由的话用 `X-Devin-Session-Id` header。
- **超时与 ACU**：`DEVIN_MAX_WAIT_MS` 只控制我们这边等多久；超时后 OpenAI 响应 `finish_reason=length` 但 **Devin session 还会继续跑** —— 这是 Devin 的设计。下次同一会话的请求会通过指纹缓存把 session 接回来，看到完整结果。
- **没有 Windsurf 账号池保护**：Devin 401 / 429 不会被自动 fallback 到其他账号 —— 这里只有一份 Devin API key。错误会原样翻译成 OpenAI 错误格式返回。

## 拉取 PR / 结构化输出

Devin session 经常会以"开 PR"作为终态。adapter 检测到 `session.pull_request.url` 时，会把 PR 链接附加到 assistant 回复末尾：

```
（Devin 给的回复内容…）

---
Pull request: https://github.com/owner/repo/pull/123
```

如果你用 [Devin 的 `structured_output_schema`](https://docs.devin.ai/api-reference/structured-output)，可以在请求 `metadata` 里塞 `devin_structured_output_schema`，结构化结果会附在响应的 `x_devin.structured_output` 字段里 —— OpenAI 标准 `choices` 仍是文本，方便兼容那些不认识 `x_devin` 的客户端。
