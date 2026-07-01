# proactive-nudge

一个很小的 proactive 主动消息 worker，适合接在自己的聊天应用 / AI companion / agent gateway 后面。

它做的事情很简单：让用户自己设置多久没说话后触发一次提醒，并预先自定义到点后要注入的消息内容；后台检查最后一条用户消息的时间；到点后把这条 `[nudge]` 用户消息注入正常聊天接口；模型照常读取上下文、记忆和工具后生成回复；最后可以把回复摘要推送到手机。

## 为什么要这么做

很多“主动找你说话”的实现其实只是 cron 定时推一句固定文案。这样很容易像闹钟：用户明明刚刚聊过，它也会硬发；模型没有上下文；发出来的东西不像真实聊天。

这个项目的思路是：**主动触发只负责制造一次对话机会，真正回复仍然走原本的聊天链路。**

也就是说，proactive worker 不直接塞一条 assistant 消息，而是注入一条特殊的 user message：

```txt
[nudge] ...
```

然后交给原来的 gateway / model / memory / tools 去生成回复。这样模型看到的是完整上下文，前端聊天记录里也会留下完整过程。

## 核心机制

- **用户自定义间隔**：前端或管理面板保存 `intervalMin` / `intervalMax`，可以固定间隔，也可以随机间隔。
- **用户自定义注入内容**：被注入的 `[nudge]` 文案不是 worker 写死的，而是由用户提前配置；它可以是提醒、撒娇、心跳测试、夜班触发词，或者任何希望模型看到的上下文入口。
- **检查最后一条用户消息**：主动触发围绕“用户侧多久没说话”来判断，所以检查最后一条 `role === "user"` 的消息时间；`[nudge]` 本身也是 user message，会自然成为下一轮计时的起点。
- **剩余时间续等**：如果设置 50 分钟触发，但用户 33 分钟前刚说过话，worker 只会再等约 17 分钟，而不是重新等一整轮。
- **走正常聊天入口**：到点后调用 `/gateway/send`，发送 `[nudge] ...`，让模型按正常上下文生成回复。
- **system prompt 协议**：在 system prompt 里告诉模型 `[nudge]` 是自动定时注入，不是用户本人刚刚打字；回复时不要提系统、注入、自动。
- **可选 Web Push**：worker 读取 SSE 回复文本后，可以把前 200 字推到手机。

## 工作流程

1. 用户在前端设置 proactive 开关、目标对话、注入文案、最小/最大间隔。
2. 配置存进后端 `settings.push`。
3. Node worker 常驻运行，定时读取配置。
4. worker 找到目标对话；如果未指定对话，就默认选最近对话。
5. worker 从对话历史倒序查找最后一条 user message。
6. 如果还没到 `intervalMin`，计算剩余时间并在剩余时间后再检查。
7. 如果已经到点，调用 `/gateway/send` 注入 `[nudge] ...`。
8. gateway 返回 SSE，worker 收集 `content_block_delta` 文本。
9. 如果配置了 push endpoint，就把回复摘要推送到手机。

## 后端接口约定

这个 worker 默认你的 chat backend 有这些接口：

```txt
GET  /settings
GET  /conversations
GET  /conversations/:id
POST /gateway/send
```

### `GET /settings`

需要返回类似：

```json
{
  "push": {
    "enabled": true,
    "conversation_id": "",
    "message": "It has been a while since we talked. Check in naturally.",
    "intervalMin": 30,
    "intervalMax": 60
  }
}
```

字段说明：

- `enabled`：是否开启。
- `conversation_id`：目标对话；空字符串表示使用最近对话。
- `message`：用户预先自定义的 nudge 文本；到点后会以 `[nudge] ${message}` 的形式进入正常聊天接口。
- `intervalMin`：最短静默时间，单位分钟。
- `intervalMax`：下一轮随机等待上限；和 `intervalMin` 相同就是固定间隔。

### `GET /conversations`

返回对话列表，至少需要有：

```json
[
  {
    "id": "conversation-id",
    "created_at": "2026-07-01T12:00:00.000Z",
    "updated_at": "2026-07-01T12:30:00.000Z"
  }
]
```

如果没有指定 `conversation_id`，worker 会按 `updated_at` / `created_at` 选择最近对话。

### `GET /conversations/:id`

返回对话详情，消息需要带毫秒时间戳：

```json
{
  "id": "conversation-id",
  "messages": [
    { "role": "user", "content": "hi", "timestamp": 1780000000000 },
    { "role": "assistant", "content": "hello", "timestamp": 1780000005000 }
  ]
}
```

### `POST /gateway/send`

接受：

```json
{
  "conversation_id": "conversation-id",
  "message": "[nudge] ..."
}
```

返回 SSE。当前示例代码会收集形如下面的事件：

```json
{
  "type": "content_block_delta",
  "delta": { "text": "..." }
}
```

如果你的 SSE 格式不同，改 `collectAssistantTextFromSse()` 即可。

## System Prompt 片段

在你的 system prompt 里加类似内容：

```md
Messages beginning with `[nudge]` are scheduled proactive prompts, not freshly typed user messages.

When you receive one, treat it as an opportunity to naturally check in with the user using the current conversation context. Do not mention automation, scheduling, injection, system messages, or the `[nudge]` marker.
```

中文也可以：

```md
以 `[nudge]` 开头的用户消息是自动定时注入的，不是用户本人刚刚打字发的。收到时把它当成一次主动找用户说话的机会，根据上下文自然回复。不要提到系统、注入、自动、定时或 `[nudge]` 标记。
```

## 运行

```bash
cp .env.example .env
npm start
```

生产环境可以用 PM2：

```bash
pm2 start src/proactive-nudge.mjs --name proactive-nudge
pm2 save
```

## 环境变量

```txt
CHAT_API              chat backend 地址
CHAT_API_TOKEN        Bearer token；如果后端只允许本机访问，可以不用
CHAT_API_TOKEN_FILE   存放 token 的文件路径
PUSH_ENDPOINT         可选，Web Push 服务地址
PUSH_TITLE            推送标题
PUSH_URL              点击推送打开的 URL
FIRST_CHECK_MS        第一次检查前等待多久，默认 180000
```

## 前端怎么做

前端只需要做一个设置面板，保存这些字段到 `/settings`：

```json
{
  "push": {
    "enabled": true,
    "conversation_id": "",
    "message": "收到这条说明我很久没找你了，可以自然地来找我说话。",
    "intervalMin": 30,
    "intervalMax": 60
  }
}
```

如果想让用户自己选目标对话，就从 `/conversations` 拉列表；如果不想做这么复杂，`conversation_id` 留空，让 worker 默认找最近对话也可以。

## 不建议这样做

- 不建议固定 cron 每隔 N 分钟直接推文案，容易打断正在聊天的人。
- 不建议直接写入 assistant message，这样模型没机会根据上下文判断该怎么说。
- 不建议让模型在回复里解释“这是自动提醒”，会很出戏。
- 不建议把触发条件写成“最后任意消息时间”，否则 assistant 的普通回复也会改变静默判断；这里更推荐围绕 user-side event 计时。

## License

MIT
