# Bug report — `start_pipeline` runs in the focused worktree, not the one it was given

**Symptom reported by the user:** asking an agent (over `mcp__rookery`) to start a
pipeline in a fresh worktree of the `os` project — e.g.
`/Users/r2luna/code/01.r2luna/01.projects/os/.worktrees/feat-dos-349-v2` — opened
the session but ran it against
`/Users/r2luna/code/01.r2luna/01.projects/rookery/.worktrees/tui`: the worktree
that happened to be focused in the UI at that moment. Reproduced 3× in a row.

No damage on any of the three: the session noticed the codebase mismatch and
stopped on its own within 15–20s.

## What the code proves

The path is intact right up to the renderer. `src/main/mcpServer.ts:278`
(`start_pipeline`) forwards the tool's `worktree` argument verbatim:

```ts
pushCommand({ kind: 'start_pipeline', callerKey: token, worktreePath: worktree, ... })
```

`src/renderer/src/App.tsx` (`handleMcpCommand`, `case 'start_pipeline'`) also uses
it correctly to create and focus the session:

```ts
const sid = command.sessionId ?? newSession(command.worktreePath)
if (!focusSession(command.worktreePath, sid)) { ... }
pipeline.start(sid, command.input, command.pipelineKind)
```

The path is then **thrown away**. `pipeline.start` only carries the session id, so
the App-side `send`/`commit` deps handed to `useWorkflowRunner` re-derived the
worktree for every step:

```ts
send: (sessionId, prompt, mode, model, effort) => {
  const wt = sessionsRef.current.find((s) => s.id === sessionId)?.worktreePath ?? activeWorktree?.path
  if (!wt) return
  ...
  deliver(sessionId, wt, prompt, ...)
}
```

That lookup misses, and the `?? activeWorktree?.path` fallback wins.

## Root cause

Three facts compose into the bug:

1. `sessionsRef.current = sessions` is assigned **during render**
   (`src/renderer/src/app/hooks/useSessions.ts:53`). It is a mirror of React
   state, not a live buffer.
2. `newSession()` appends via `setSessions((prev) => [...prev, ...])` — queued,
   applied on the next render. Within the same tick `sessionsRef.current` still
   holds the pre-append list.
3. `useWorkflowRunner.start()` dispatches step 1 **synchronously**: `put(...)`
   then `run(boundId, actions)` → `deps.send(...)`.

So `start_pipeline` creates the session and sends its first prompt in one tick,
and `sessionsRef.current.find(s => s.id === sid)` is `undefined` for the session
that was just created. The fallback then resolves to `activeWorktree` — the
UI-focused worktree — and `deliver()` passes it to `agent:start`, which hands it
to `spawnConn` as the child's cwd (`src/main/agent.ts:392`). Every subsequent
step of that run repeated the same miss, so the whole pipeline lived in the wrong
worktree.

A second, permanent variant of the same miss: `start_pipeline` with an explicit
`session_id` whose project isn't loaded in the renderer. Its session is not in
`sessions` at all, so *every* step fell through to UI focus, not just the first.

**Why the UI never showed this:** `startPipeline()` (the launch dialog) creates the
session with `newSession(wt.path)` where `wt` *is* `activeWorktree`. The lookup
misses there too — the fallback just happens to produce the correct answer. Only
the MCP entry point can name a worktree other than the focused one, so only it
could be wrong.

**Not affected:** `create_session` passes `command.worktreePath` straight to
`window.rookery.agent.start(...)`, so the session it opens (and its first prompt)
always spawn in the requested worktree. Only pipeline steps re-derived the path.

## Fix

`src/renderer/src/workflow/pipelineWorktree.ts` (new) —
`resolvePipelineWorktree(bindings, sessions, sessionId)`: an explicit binding
wins, the session list is the fallback, and an unresolved session returns
`undefined`. UI focus is no longer a source of truth anywhere in this path.

In `App.tsx`:

- `pipelineWorktrees` ref: the worktree each live pipeline is bound to, written
  **before** `pipeline.start(...)` at both call sites (the MCP command uses
  `command.worktreePath`, the launch dialog uses the active worktree) and on
  restore (persisted per worktree, so its own path is authoritative).
- `send`/`commit` resolve through `resolvePipelineWorktree` and bail when it
  yields nothing, instead of falling back to `activeWorktree?.path`.

Net effect: the explicit `worktreePath` always wins, and a pipeline that cannot
prove its worktree sends nothing rather than running against whatever is on
screen.

## Tests

`src/renderer/src/workflow/pipelineWorktree.test.ts` — binding beats the session
list; session list used when unbound; the regression case (session the list has
not caught up with) resolves to its binding; unknown + unbound resolves to
`undefined`.

`pnpm typecheck` clean, `pnpm test` 264 pass / 1 skipped.
