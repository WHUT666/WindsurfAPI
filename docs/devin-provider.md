# Devin Sessions provider

WindsurfAPI 可以选择性地把 [Cognition Devin](https://devin.ai) 的官方 REST API 包装成 OpenAI / Anthropic 兼容端点 —— 让任何已经在用 `/v1/chat/completions` 或 `/v1/messages` 的客户端（OpenAI SDK / Anthropic SDK / Claude Code / Cursor / Cline）也能直接驱动 Devin session。

> ⚠️ 该 provider **完全独立于 Windsurf 账号池**：用的是你自己的 Devin API key、消耗你自己的 Devin org ACU 预算。Windsurf 账号是否登录、Language Server 是否启动，都不影响它。
> 没有 `DEVIN_API_KEY` 时，所有 `devin*` 模型都不会出现在 `/v1/models` 里，`/v1/devin/*` 反代路由也会统一回 503 `configuration_error`，不会触发任何上游调用。

## 模型清单

| 模型名             | `max_acu_limit` 默认 | 适用场景                                                          |
| ------------------ | -------------------- | ----------------------------------------------------------------- |
| `devin`            | 由 Devin 决定        | 一般 agent 任务，让 Devin 自己估算预算                            |
| `devin-low`        | `2`                  | 单轮快问快答、一次性脚本检查                                      |
| `devin-medium` *(= `devin-fast`)* | `5`     | 短任务 / 单次问答 / 想严格控制 ACU 消耗的场景                     |
| `devin-high`       | `20`                 | 中型 feature、跨 3-5 个文件的小型 refactor                        |
| `devin-xhigh` *(= `devin-deep`)*   | `50`    | 大型 refactor / 复杂调研                                          |
| `devin-max`        | `100`                | 多 PR 串联、需要长时间跑的复杂任务                                |
| `devin-acu-<N>`    | `<N>`                | 动态别名：把 N 替换成 1~10000 的整数，例 `devin-acu-30`           |

两组命名是等价的：`devin-fast` 和 `devin-medium` 走同一份 ACU 配额，`devin-deep` 和 `devin-xhigh` 同理。新代码推荐用 `low/medium/high/xhigh/max` 这套对称命名（与 EFFORT_LADDER 一致），老代码继续用 `devin-fast` / `devin-deep` 也完全 OK。

如果想在不重写代码的情况下临时改 `max_acu_limit`，在请求体的 `metadata.devin_max_acu` 里塞一个正整数就行（OpenAI body 原生支持 `metadata`），或者直接用 `model: devin-acu-N` 动态别名 —— 动态别名不需要在 `/v1/models` 里有对应条目，但 `parseDevinAcuAlias` 会把它识别成 `devin-sessions` provider 并应用到 session。

### 其它 metadata 传参

通过 OpenAI body 的 `metadata` 字段还能直接驱动 Devin 的其它会话级参数 —— 不需要走 `/v1/devin/*` 单独建 session：

| `metadata.*`                       | 上游字段                          | 说明                                                                 |
| ---------------------------------- | --------------------------------- | -------------------------------------------------------------------- |
| `devin_max_acu`                    | `max_acu_limit`                   | 覆盖模型自带的 ACU 上限                                              |
| `devin_snapshot_id`                | `snapshot_id`                     | 指定环境快照 id（覆盖 `DEVIN_DEFAULT_SNAPSHOT_ID`）                 |
| `devin_playbook_id`                | `playbook_id`                     | 指定 playbook id（覆盖 `DEVIN_DEFAULT_PLAYBOOK_ID`）                 |
| `devin_title`                      | `title`                           | session 标题，方便在 Devin dashboard 里识别                          |
| `devin_structured_output_schema`   | `structured_output_schema`        | 结构化输出 schema，session 终态会带在 `x_devin.structured_output` 里 |
| `devin_knowledge_ids` (array)      | `knowledge_ids`                   | 给 session 注入指定的 knowledge 条目（最多 64 条，空字符串会被剔除）|
| `devin_secret_ids` (array)         | `secret_ids`                      | 注入指定的 org-level secret（最多 64 条）                            |
| `devin_session_secrets` (object)   | `session_secrets`                 | 仅本次 session 生效的 key/value secret                               |
| `devin_tags` (array)               | `tags`                            | session tag，最多 32 条                                              |
| `devin_unlisted: true`             | `unlisted`                        | 不出现在公开 list                                                    |
| `devin_idempotent: true`           | `idempotent`                      | Devin 端的幂等创建                                                   |

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

## Devin Cloud REST 工具链反代（`/v1/devin/*`）

除了把 chat completions 翻译给 Devin 之外，WindsurfAPI 还在 `/v1/devin/*` 下挂了 Devin Cloud 的完整 REST 工具链，方便不想自己管 `DEVIN_API_KEY` 的客户端把 sessions / attachments / knowledge / playbooks / secrets / 以及 v3 RBAC 和 v2 enterprise 已发布的 admin / audit / consumption 接口都走这一个代理。总共白名单一百多条路由，全部定义在 `src/handlers/devin-passthrough.js` 的 `ALLOWED_ROUTES` 中。

### v1 （legacy，默认挂载名下；API key 需以 `apk_` / `apk_user_` 开头）

| 路由                                          | 方法              | 上游                                  |
| --------------------------------------------- | ----------------- | ------------------------------------- |
| `/v1/devin/sessions`                          | `GET` / `POST`    | `/v1/sessions`                        |
| `/v1/devin/sessions/:id`                      | `GET` / `DELETE`  | `/v1/sessions/{id}`                   |
| `/v1/devin/sessions/:id/message`              | `POST`            | `/v1/sessions/{id}/message`           |
| `/v1/devin/sessions/:id/tags`                 | `POST` / `PUT`    | `/v1/sessions/{id}/tags`              |
| `/v1/devin/attachments`                       | `POST` (multipart)| `/v1/attachments`                     |
| `/v1/devin/attachments/:id/file`              | `GET`             | `/v1/attachments/{id}/file` (302 透传)|
| `/v1/devin/knowledge`                         | `GET` / `POST`    | `/v1/knowledge`                       |
| `/v1/devin/knowledge/:id`                     | `PATCH` / `PUT` / `DELETE` | `/v1/knowledge/{id}`         |
| `/v1/devin/playbooks`                         | `GET` / `POST`    | `/v1/playbooks`                       |
| `/v1/devin/playbooks/:id`                     | `GET` / `PATCH` / `PUT` / `DELETE` | `/v1/playbooks/{id}` |
| `/v1/devin/secrets`                           | `GET` / `POST`    | `/v1/secrets`                         |
| `/v1/devin/secrets/:id`                       | `DELETE`          | `/v1/secrets/{id}`                    |

### v3 organizations（当前主推 API，RBAC / service-user token 以 `cog_` 开头）

全部路由都需要在客户端 URL 中显式带上 `org_id`，代理不会从 API key 中推断 —— 企业版下同一个 service-user token 可以跨 org 生效。

| 路由                                                                          | 方法                                       |
| ----------------------------------------------------------------------------- | ------------------------------------------ |
| `/v1/devin/v3/organizations/:org_id/sessions`                                 | `GET` / `POST`                             |
| `/v1/devin/v3/organizations/:org_id/sessions/insights`                        | `GET`                                      |
| `/v1/devin/v3/organizations/:org_id/sessions/:devin_id`                       | `GET` / `DELETE`                           |
| `/v1/devin/v3/organizations/:org_id/sessions/:devin_id/messages`              | `POST`                                     |
| `/v1/devin/v3/organizations/:org_id/sessions/:devin_id/tags`                  | `POST` (append) / `PUT` (replace)          |
| `/v1/devin/v3/organizations/:org_id/sessions/:devin_id/archive`               | `POST`                                     |
| `/v1/devin/v3/organizations/:org_id/sessions/:devin_id/attachments`           | `POST` (multipart)                         |
| `/v1/devin/v3/organizations/:org_id/sessions/:devin_id/insights/generate`     | `POST`                                     |
| `/v1/devin/v3/organizations/:org_id/knowledge/notes`                          | `GET` / `POST`                             |
| `/v1/devin/v3/organizations/:org_id/knowledge/notes/:note_id`                 | `GET` / `PATCH` / `PUT` / `DELETE`         |
| `/v1/devin/v3/organizations/:org_id/playbooks`                                | `GET` / `POST`                             |
| `/v1/devin/v3/organizations/:org_id/playbooks/:playbook_id`                   | `GET` / `PATCH` / `PUT` / `DELETE`         |
| `/v1/devin/v3/organizations/:org_id/secrets`                                  | `GET` / `POST`                             |
| `/v1/devin/v3/organizations/:org_id/secrets/:secret_id`                       | `DELETE`                                   |
| `/v1/devin/v3/organizations/:org_id/attachments`                              | `POST` (multipart)                         |
| `/v1/devin/v3/organizations/:org_id/attachments/:attachment_id/file`         | `GET` (302 透传)                            |
| `/v1/devin/v3/organizations/:org_id/service-users`                            | `GET` / `POST`                             |
| `/v1/devin/v3/organizations/:org_id/service-users/:user_id`                   | `GET` / `DELETE`                           |
| `/v1/devin/v3/organizations/:org_id/users`                                    | `GET`                                      |
| `/v1/devin/v3/organizations/:org_id/users/:user_id`                           | `GET`                                      |

### v3 enterprise（企业 admin跨 org 操作）

| 路由                                                       | 方法                                   |
| --------------------------------------------------------- | -------------------------------------- |
| `/v1/devin/v3/enterprise/organizations`                   | `GET` (list orgs in enterprise)        |
| `/v1/devin/v3/enterprise/sessions`                        | `GET`                                  |
| `/v1/devin/v3/enterprise/sessions/:devin_id`              | `GET` / `DELETE`                       |
| `/v1/devin/v3/enterprise/sessions/:devin_id/messages`     | `POST`                                 |
| `/v1/devin/v3/enterprise/sessions/:devin_id/archive`      | `POST`                                 |
| `/v1/devin/v3/enterprise/sessions/:devin_id/tags`         | `POST` (append) / `PUT` (replace)      |
| `/v1/devin/v3/enterprise/knowledge/notes`                 | `GET` / `POST`                         |
| `/v1/devin/v3/enterprise/knowledge/notes/:note_id`        | `GET` / `PATCH` / `PUT` / `DELETE`     |
| `/v1/devin/v3/enterprise/playbooks`                       | `GET` / `POST`                         |
| `/v1/devin/v3/enterprise/playbooks/:playbook_id`          | `GET` / `PATCH` / `PUT` / `DELETE`     |

### v2 enterprise（legacy，计费 / audit / member 管理）

v3 还没完全接管的部分都在 v2 上，这些路由需要 enterprise admin personal API key（`apk_user_` 且带 enterprise admin role）。

| 路由                                                       | 方法             |
| --------------------------------------------------------- | ---------------- |
| `/v1/devin/v2/enterprise/audit-logs`                      | `GET`            |
| `/v1/devin/v2/enterprise/consumption/cycles`              | `GET`            |
| `/v1/devin/v2/enterprise/consumption/daily`               | `GET`            |
| `/v1/devin/v2/enterprise/consumption/user-daily`          | `GET`            |
| `/v1/devin/v2/enterprise/consumption/pr-metrics`          | `GET`            |
| `/v1/devin/v2/enterprise/consumption/sessions-metrics`    | `GET`            |
| `/v1/devin/v2/enterprise/consumption/searches-metrics`    | `GET`            |
| `/v1/devin/v2/enterprise/consumption/usage-metrics`       | `GET`            |
| `/v1/devin/v2/enterprise/api-keys`                        | `GET` / `POST` / `DELETE` (后者是 bulk revoke) |
| `/v1/devin/v2/enterprise/api-keys/:key_id`                | `DELETE`         |
| `/v1/devin/v2/enterprise/members`                         | `GET`            |
| `/v1/devin/v2/enterprise/members/invite`                  | `POST`           |
| `/v1/devin/v2/enterprise/members/roles`                   | `GET` / `PATCH`  |
| `/v1/devin/v2/enterprise/members/roles/migrate`           | `POST`           |
| `/v1/devin/v2/enterprise/members/organizations`           | `GET`            |
| `/v1/devin/v2/enterprise/members/:member_id`              | `GET` / `DELETE` |
| `/v1/devin/v2/enterprise/organizations`                   | `GET` / `POST`   |
| `/v1/devin/v2/enterprise/groups`                          | `GET` / `POST`   |
| `/v1/devin/v2/enterprise/groups/:group_id`                | `GET`            |
| `/v1/devin/v2/enterprise/org-group-limits`                | `GET` / `PATCH`  |
| `/v1/devin/v2/enterprise/infrastructure/hypervisors`      | `GET`            |

关键行为：

- 所有路由都用 server 端的 `DEVIN_API_KEY` 作为上游 Bearer token，**客户端不需要、也不能传 Devin token**（防止凭证泄漏给反代消费方）。
- 仍受 proxy 自己的 `API_KEY` 网关保护（和 `/v1/chat/completions` 同一把锁）。
- multipart 上传是流式的，10 MB 内不缓冲；attachment 下载默认返回上游 302 让客户端直拉 presigned URL。
- 上游非 2xx 的响应体（Devin 的 JSON 错误详情）原样透传过来，方便客户端按 4xx/5xx 处理。
- `DEVIN_API_KEY` 没设的时候这些路由统一回 503 `configuration_error`。
- 路由白名单写死在 `src/handlers/devin-passthrough.js` 的 `ALLOWED_ROUTES` 里，未列出的 Devin endpoint 会回 404 —— 新增 endpoint 必须显式登记。

示例：

```bash
# 上传一份 README 给 Devin 作为后续 session 的 attachment
curl -s http://localhost:3003/v1/devin/attachments \
  -H "Authorization: Bearer $API_KEY" \
  -F file=@README.md

# 列最近的 session
curl -s http://localhost:3003/v1/devin/sessions?limit=20 \
  -H "Authorization: Bearer $API_KEY" | jq .

# 给已有 session 加 tag
curl -s http://localhost:3003/v1/devin/sessions/devin-abc123/tags \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"tags":["triage","demo"]}'

# 写一条 knowledge
curl -s http://localhost:3003/v1/devin/knowledge \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"deploy","contents":"npm run deploy","trigger":"When deploying"}'

# v3：帮某个用户创建一个 session（需要 ImpersonateOrgSessions 权限）
curl -s http://localhost:3003/v1/devin/v3/organizations/org-abc/sessions \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Fix issue #42","create_as_user_id":"user-zzz"}'

# v3：给已有 session 发后续消息（注意是 messages 不是 message）
curl -s http://localhost:3003/v1/devin/v3/organizations/org-abc/sessions/devin-xyz/messages \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"message":"please retry with verbose logs"}'

# v3：归档 session 以便后期查询
curl -s -X POST http://localhost:3003/v1/devin/v3/organizations/org-abc/sessions/devin-xyz/archive \
  -H "Authorization: Bearer $API_KEY"

# v2：查看 enterprise 本周期的 ACU 消耗
curl -s 'http://localhost:3003/v1/devin/v2/enterprise/consumption/cycles?limit=12' \
  -H "Authorization: Bearer $API_KEY" | jq .

# v2：拉近 30 天的 audit log
curl -s 'http://localhost:3003/v1/devin/v2/enterprise/audit-logs?days=30' \
  -H "Authorization: Bearer $API_KEY" | jq .
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
