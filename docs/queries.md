# Queries: talking to another agent without stopping the one you have

`@codex analisa isso` while Claude is mid-turn used to go in the queue. You
waited for the turn to end, and then codex's answer landed in the same scroll,
in the middle of the work.

Now it opens a **query**: a second conversation, in its own panel, on its own
key, running in parallel. It is read-only by construction. Three actions close
the cycle — **merge**, **peek**, **discard**.

The name is IRC's, for a private side conversation. `lane` was taken: it is
already the renderer's panel layout (`lane.ts`, `laneStore.ts`).

## The one idea

**A query is just another agent key.**

The whole main process is indexed by a plain string — the conns and their
`turnActive`, the runtime threads, the handoff watermarks, the replay snapshots,
the seq counters, the turn log, `agent:stop`, `agent:replay`. None of them care
what the string means. So:

```
qkey = `${sessionId}~${harness}`     // shared/queries.ts
```

runs beside `sessionId` without a single structure changing shape, and
`useTranscript(worktreePath, qkey)` in the renderer gives the panel streaming,
"is typing", the queue, stop and mid-turn replay for free — the same hook,
pointed at a different string.

The separator is `~` because it cannot occur inside a session id: Floe mints
UUIDs and `claude:<uuid>`, the CLI mints UUIDs.

The key is built from the session's **stable Floe id**, never from `claudeId` —
`claude --resume` forks a new claudeId on every respawn, and a query named after
one would split in two the next time the CLI restarted.

## Lifecycle

| | |
|---|---|
| **open** | `@codex …` from any door. Idempotent by key: asking codex a second thing is the same query, and the panel focuses instead of stacking. |
| **peek** (`⌘⇧G`) | The chat is handed what it has not read, and takes a turn on it. Nothing closes. |
| **merge** (`⌘⇧M`) | The chat is handed **the rest**, and the query closes. |
| **discard** (`⌘⇧D`) | The query closes and the chat never sees a word. The transcript stays — the dead line offers `reopen`. |
| **reopen** | A discarded or merged query comes back — its transcript is still its own, under its own key. |

`⌘W` deliberately does not discard. Closing a panel and throwing a conversation
away are different things, and one key for both would make the safe habit
destructive.

## The watermark

What makes peek and merge compose. `packetFrom` (`main/handoff.ts`) keeps a mark
per `(queryKey, chatKey)` pair: peek sends everything past it and moves it, so a
merge afterwards sends only what arrived since.

It is its own map rather than the `(key, harness)` watermarks beside it, for a
reason that only looks like a detail: `watermark()` reads Claude's off *its*
transcript, and Claude never speaks inside a codex query — so it would read 0
forever and every merge after a peek would re-ship every line.

The mark moves to **the last entry sent**, not to the wall clock: an entry
written while the packet was being built carries an earlier `at` than
`Date.now()`, and a clock mark would skip it for good. It moves as the packet is
BUILT, so the window is checked before that — a merge that cannot deliver must
not consume the mark for a turn that never started, and must not close.

And it **survives the close**. The entry and the transcript both outlive a merge
(that is what `reopen` reads), so what the chat has already been shown has to
outlive it too — cleared with the conn, the second press of `⌘⇧M` pasted
everything the first had just delivered. It is dropped where it stops meaning
anything: with the record itself, when the session closes or the worktree goes.

## One turn at a time

A query is one conversation, and the rules for talking into a busy one are
already written (`docs/message-queue.md`): Claude takes a second message as a
**steer**, folding it into the turn in flight; a one-shot runtime cannot,
because its run *is* the request and a second `codex exec` races the first.

The renderer enforces that for what you type, and only for what you type — the
queue lives in `useTranscript`. Every other door (an agent's `send_message`, a
followup, `@codex` written by the model, a fan-out) reaches `startTurn` with
nothing in between, so `canRunInQuery` holds the same rule in main. A message
into a busy one-shot query is **refused and says so** rather than queued: a
second queue in main would have no panel to show what is waiting in it.

## Five doors, one decision

`startTurn` has five callers, not one:

| Door | Where |
|---|---|
| composer | `main/index.ts` (`agent:start`) |
| MCP `send_message` | `mcpServer.ts` |
| MCP `create_session` with a prompt | `mcpServer.ts` |
| a scheduled followup | `mcpServer.ts` |
| the relay's `armAddress` | `relay.ts` |

Deciding in the renderer's `onSend` would cover exactly one of them, and an
agent sending `@codex …` over `send_message` would keep the old semantics. So
the decision lives in **`dispatchTurn` (`main/turn.ts`)**, beside everything else
that has to be true of a turn whichever door it was.

It takes **intention, not text**. Three of those doors strip the handle before
they get here — the composer sends `route.prompt`, `sendOptions` returns the
prompt without it, `armAddress` the same — so a `routeOf(prompt)` inside
`dispatchTurn` would read clean text and never redirect anything. Each door
parses the route and passes it on:

```ts
dispatchTurn({ win, parentKey, worktreePath, prompt, route, origin })
```

With a `route` it opens (or refocuses) a query and runs there. Without one it is
the session's own turn, exactly as before.

## Read-only, and how it is actually enforced

A query is a second agent pointed at a worktree somebody else is already writing
in. Two writers in one checkout is the failure this exists to prevent, so a
query runs at `plan` and the mode is not read from the parent — the parent may
well be on bypass.

**A harness without a real `plan` mode cannot hold a query.** `nearestMode`
would happily snap to something it *can* do — gemini has no read-only setting,
so it would land on "ask" and start requesting permission to edit. Refusing is
better than promising a read-only that does not exist. In practice: claude,
codex and opencode can; gemini, lmstudio and ollama cannot, and the refusal says
which and why in the chat that asked.

### D8 — a query gets no Floe MCP token

The token in `/mcp/<key>` *is* the session id, and a query key resolves to no
session — so a query would carry a token `findSessionAny` cannot resolve, and
every tool depending on it would break in silence. Paired with the read-only
promise, the honest answer is that a conversation which only reads should not be
opening panels, creating sessions or running commands in the app either.

Not minting the token is **not enough on its own**. Without a config of its own
the CLI falls back to the Floe server registered globally and comes back as
`/mcp/global` — the same tools under the wrong identity. So a query spawns with:

1. its own `--mcp-config`, empty (`emptyMcpConfigFor`);
2. `--strict-mcp-config`, so global and project configs are ignored;
3. no `--allowedTools mcp__floe`.

**Consequence, taken deliberately:** the managed hooks stop firing inside a
query — `hooks.ts`'s `DETECT_FLOE` recognises a Floe process by exactly those two
argv entries. `plan` is the barrier that replaces them, which is why a harness
without `plan` is refused outright.

**Cost:** an agent inside a query cannot drive Floe.

## Where the cascade stops

- **By text.** `startTurn` arms neither `armRelay` nor `armAddress` on a query
  key, so nothing watches a query's answer for another handle. One hop, then it
  is over. What reads a query's answer is merge and peek, under your command.
- **By MCP.** Closed by D8: no token, no tool call. The explicit guard —
  `dispatchTurn` refusing a route when `isQueryKey(parentKey)` — is the belt to
  those braces, for the day somebody gives a query a token and forgets why it
  did not have one.

A session can open as many queries as it likes. A query can open none.

## Identity

`main/identity.ts` is the one place a key is resolved to the ids it answers to —
sessions first, queries second, **ids only, never the record behind them**.

That last part is not fussiness. A query is opened from a session, and handing
back the parent's `CreatedSession` would make the parent's `spawnedBy` apply to
the query, which is exactly what makes the child auto-answerer (`agent.ts`)
swallow a query's `AskUserQuestion` instead of showing it. Names travel; the
record does not.

A query keeps its own `claudeId` / `pastClaudeIds` in the store. Without them a
query answered by Claude would lose its history on restart — and merge and peek
would then find nothing to build a packet from.

## Activity: the raw APIs stay raw

`activeTurnKeys()` and `waitingKeys()` include query keys, on purpose.

`useTranscript` uses `agent.active()` as a corrective watchdog: every 4s, a key
that is not in the list and has been quiet past `IDLE_GRACE_MS` has its turn
forced closed. Hide query keys there and every `QueryPanel` would conclude on
its own that its turn had ended, drop the typing line and drain its queue over a
turn that was still running. `busy()` in `relay.ts` needs the same raw truth.

The filter lives in exactly one place: `useSessionActivity`
(`renderer/src/useRunning.ts`) drops query keys from `busy`, `waiting` and
`unread`. The concrete leak it fixes is `unread` — a query key never matches a
row in the session list, so a mark set on one can never be read and hangs there
for good.

The Fleet list needs no filter: it tests exact names (`anyActiveTurn([s.id,
s.claudeId])`), and `sess~codex` is not `sess`.

## `@all` — one message, several agents

`@all o que voces acham` asks more than one harness at once. Each target is an
**ordinary query** — same key, same panel, same read-only, same three actions —
so nothing about it is a second mechanism. What the fan-out adds is the
comparison: every answer is also mirrored into the chat under one `fanoutId`,
and items sharing one render as columns instead of as four replies in a row.

`@all:high` sets one effort for everybody. `@all` mid-sentence is a word.

**R7 — it never fans out to every harness installed.** The targets are always
given, never inferred:

- **queries already open** → those, plus the harness answering in the chat.
  "Who am I talking to" includes the conversation you are typing in; asking
  again would be the app forgetting the panels on its own screen.
- **none open** → the picker asks (`AllPicker.tsx`). The chat's own harness is
  preselected and deselectable — asking only the others is a real case (Q6).

Four turns nobody ordered is the failure mode, and `routeAll` has nowhere in it
to produce them: it returns the message and the effort, and names no targets.

Each column offers the two things you want from a comparison. **follow** peeks
that one into the chat's context; **open** puts its panel back on screen. Neither
ends anything — choosing a path is not throwing the others away.

Agents get `ask_all`.

## What an agent can do

`open_query`, `list_queries`, `peek_query`, `merge_query`, `discard_query`,
`ask_all` — the same verbs a person has. And `send_message` with `@codex …` opens exactly
the query the composer would; if those two ever diverge, the feature is broken.

An agent opening a query puts a panel on somebody's screen, over
`send_message`, on a followup timer, or by writing `@codex` into its own answer.
That is "agent first" taken at its word, so the query records `openedBy` and the
panel says who opened it.

## Files

| | |
|---|---|
| `shared/queries.ts` | the key: `queryKey`, `parseQueryKey`, `isQueryKey`, `parentKeyOf` |
| `shared/queryStore.ts` | the pure list transforms, and `isValidQuery` as the trust boundary |
| `main/queries.ts` | who may open one, and the three actions |
| `main/identity.ts` | key → the ids it answers to, session or query |
| `main/turn.ts` | `dispatchTurn` — the one place a destination is decided |
| `main/handoff.ts` | `packetFrom` and the read watermark |
| `renderer/src/QueryPanel.tsx` | the panel |
| `renderer/src/AllPicker.tsx` | who `@all` goes to, when nothing is open to answer that |
| `shared/mentions.ts` | `routeAt` (a handle) and `routeAll` (`@all`) |
