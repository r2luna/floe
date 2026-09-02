# Sending while busy: steer (Claude) or queue (one-shot runtimes)

What happens to a message typed while a turn is in flight depends on whether
the runtime answering has a live loop to inject into.

## Claude: steer, never queue

Files: `src/renderer/src/useTranscript.ts` (`send`), `src/main/agent.ts`
(`sendToAgent`).

A mid-turn send goes out immediately. The renderer calls `agent.start` as
usual; in main, `sendToAgent` sees `conn.turnActive` and takes the steer path:
no turn-state reset, no respawn — it just writes the `{type:'user'}` line to
the live CLI's stdin. The CLI's own agent loop queues the message and folds it
into the work in flight, so it continues **the same turn** (same mechanism
Claude Code's TUI and t3code use).

Notes on the steer path:

- **Option changes are ignored mid-turn.** Honouring a model/mode change means
  killing the child, which would abort the very turn being steered. The new
  options apply from the next idle send, which respawns on `optionsKey` change
  as before.
- **No `markTurnStart`.** The running turn's replay buffer stays intact; a
  panel mounting mid-turn still replays the whole turn.
- **The steered message is kept twice, shown once.** The CLI does NOT echo it
  as a user line: it queues it, folds it into the turn, and writes what it
  absorbed as an `attachment` line (`queued_command`) — only when the tool call
  in flight ends. `loadClaudeTranscript` reads that line as your message, and
  until it exists `sendToAgent` keeps a `steer` event in the replay so a panel
  mounting mid-turn still shows what was said. The renderer drops the disk copy
  of a line the stream already carries (`transcriptState.ts`, `dropOnce`).
- **Paused turns too.** A pending permission/question flips the renderer's
  `running` to false but leaves `conn.turnActive` true, so a send while paused
  is also a steer — the CLI holds it until the prompt is resolved, exactly like
  typing during a permission prompt in Claude Code.

## One-shot runtimes (codex, opencode, lmstudio, ollama): queue

These run as a single request/response (`codex exec`, `opencode run`, one HTTP
call). There is no live loop to inject into, and firing a second exec while the
first runs would race it. So the old client-side buffer still applies, only for
these providers:

1. **Buffer** — `queued` state in `useTranscript.ts`, one list per session.
2. **Enqueue** — `send()` while `running` and the chosen provider is not
   Claude pushes onto the list.
3. **Boundary** — the `done` event flips `running` false; the drainer effect
   fires on the true→false edge only (`wasRunning` ref).
4. **One per boundary** — `draining` ref keeps a boundary to a single
   delivery; `takeBatch` (`queue.ts`) merges a contiguous run of ⌘L-linked
   items into one message.
5. **Options at delivery** — model/effort are read from refs at send time, so
   a message that waited uses the settings in effect when it fires.

## Not part of this

The interrupt path (⌘.) is separate — that aborts the current turn. Steering
and queueing only ever add context; they never cancel work in flight.
