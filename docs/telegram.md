# Telegram bot

While nobody is at Floe on a machine, that machine's bot relays its chats to Telegram:
finished turns, permission prompts and questions. Whatever you write back goes into the
chat. Code: `src/main/telegram/`.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token. **One bot
   per machine**: Telegram gives a token's updates to one poller at a time, so two
   machines sharing a token steal each other's messages. Status reports this as an error
   when it happens.
2. Ask an agent to call `telegram_setup` with the token (the MCP tool). It checks the
   token with Telegram, saves it, and returns a `pairCode`.
3. In Telegram, send `/pair <pairCode>` to the bot. That chat is now the only one the bot
   answers. Messages from any other chat get no reply.

`telegram_setup` also takes `away_after_minutes` (default 3), `enabled` and `unpair`.
`telegram_status` reports state, the pending code, whether you count as away, and the
last error. Settings live in `<dataDir>/telegram.json` (mode 600), not in `floe.toml`,
because the token is a secret bound to the machine.

## When it speaks

Only while you are **away**, meaning no Floe window showing this machine has had input
for `away_after_minutes`. Every window, whether the desktop app, a browser tab on the
daemon, or another Mac attached to this one, pings **every** backend it shows on key,
click, scroll or focus (`renderer/src/usePresence.ts` → `presence:ping`). A window
without focus does not ping.

A message you send from Telegram marks you away at once, so the answer comes back to
Telegram even if a window pinged a minute ago.

The bot skips queries, colony lanes and sessions an agent opened (`spawnedBy`), because
those report to whoever opened them.

## Talking to a chat

- **Reply** to any bot message to write to that chat.
- **Plain text** goes to the current chat: the one you last heard from, or the one you
  picked with `/sessions`.
- **Permissions** have Allow / Deny buttons. Replying `yes` / `allow` / `ok` allows, and
  any other reply denies.
- **Questions** show their options as buttons. Plain text to that chat answers its open
  question.
- A prompt already answered at the computer is not answered again from the phone.
- `/sessions`, `/status`, `/help`. Any other `/command` is passed to the chat as text,
  so `/deploy` reaches the skill.

A message from Telegram goes through the same entry point as `send_message`, with
`origin: 'user'`. A chat with no stored permission mode runs on `floe.toml`'s
`[agent] mode`, as the composer would, not on the agent default of bypass.

## Testing without Telegram

`FLOE_TELEGRAM_API=http://127.0.0.1:<port>` points the bot at a stand-in server. A stub
that queues injected updates for `getUpdates` and records `sendMessage` is enough to
drive pairing, the away gate, the round trip and permission taps against the real app.
