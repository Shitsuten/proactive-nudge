# proactive-nudge

A small proactive messaging worker for chat apps.

It lets the user configure an idle interval, checks the timestamp of the last user message, injects a `[nudge]` message through the normal chat pipeline when the interval has elapsed, and optionally pushes the generated reply to a phone.

## Why this exists

Most "proactive AI" implementations are just cron jobs that send a fixed reminder. That feels wrong in chat: it interrupts active conversations, ignores context, and sounds like a notification system instead of a person.

This pattern keeps the model in the normal conversation loop:

1. The user configures a nudge message and interval.
2. A background worker checks the target conversation.
3. If the last user message is too recent, the worker waits only the remaining time.
4. If enough time has passed, the worker sends `[nudge] ...` into the regular chat endpoint.
5. The model sees the usual system prompt, memory, tools, and history.
6. The worker reads the SSE reply and can forward a short preview via Web Push.

## Key ideas

- **User-configurable timing**: store `intervalMin` and `intervalMax` in backend settings.
- **Last-user-message gate**: assistant replies do not reset the timer; only the user's latest message matters.
- **Remaining-delay scheduling**: if the minimum interval is 50 minutes and the user spoke 33 minutes ago, wait about 17 minutes, not a full new cycle.
- **Normal chat pipeline**: do not directly insert a fake assistant message. Inject a `[nudge]` user message and let the existing gateway generate the reply.
- **Prompt protocol**: teach the model what `[nudge]` means in the system prompt, and tell it not to mention automation.

## Expected backend API

The worker expects a chat backend with these endpoints:

```txt
GET  /settings
GET  /conversations
GET  /conversations/:id
POST /gateway/send
```

`/settings` should contain:

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

`/conversations/:id` should return messages with timestamps:

```json
{
  "id": "conversation-id",
  "messages": [
    { "role": "user", "content": "hi", "timestamp": 1780000000000 },
    { "role": "assistant", "content": "hello", "timestamp": 1780000005000 }
  ]
}
```

`/gateway/send` should accept a JSON body:

```json
{
  "conversation_id": "conversation-id",
  "message": "[nudge] ..."
}
```

and return an SSE response containing `content_block_delta` events.

## System prompt snippet

Add something like this to your system prompt:

```md
Messages beginning with `[nudge]` are scheduled proactive prompts, not freshly typed user messages.

When you receive one, treat it as an opportunity to naturally check in with the user using the current conversation context. Do not mention automation, scheduling, injection, system messages, or the `[nudge]` marker.
```

## Run

```bash
cp .env.example .env
npm start
```

For production, run it under a process manager:

```bash
pm2 start src/proactive-nudge.mjs --name proactive-nudge
pm2 save
```

## Configuration

Environment variables:

```txt
CHAT_API              Chat backend base URL
CHAT_API_TOKEN        Bearer token, optional if your backend is local-only
CHAT_API_TOKEN_FILE   File containing bearer token
PUSH_ENDPOINT         Optional push endpoint
PUSH_TITLE            Push notification title
PUSH_URL              URL opened from notification
FIRST_CHECK_MS        Delay before first check
```

## License

MIT
