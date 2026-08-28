# Bug report — agent turn hangs forever after reusing a dead connection

**Symptom reported by the user:** two worktree tabs stuck showing something like
"claude cli not found"; the session never produces output again after that.

**Reproduction context:** running the `os` project's `epic/jobs` epic overnight
across many parallel worktree pipelines (`start_pipeline`/`send_message` via the
`mcp__rookery` MCP tools). Ten tickets shipped fine across several waves. Two
sessions in the next wave (`feat-dos-329`, `feat-dos-332`) went silent mid-`plan`
step and never recovered, hours after their last successful turn.

## What the log proves

`~/Library/Application Support/rookery/logs/agent.log`, both frozen keys:

```
{"t":"...T15:13:56Z","event":"turn-done","key":"25eace74-...","ok":true,"turnMs":152231}
{"t":"...T15:14:06Z","event":"turn-done","key":"203af058-...","ok":true,"turnMs":224797}
```

No further `spawn`, `turn-done`, `child-close`, `child-error`, `stuck-silent`, or
`recover-stuck-silent` event for either key for 2h20m+ afterward. Sending a fresh
`send_message` to `203af058-...` at `17:38:06Z` produced:

```
{"t":"...T17:38:06.751Z","event":"turn-start","key":"203af058-...","promptLen":108,...}
```

— a `turn-start` with **no `spawn` event immediately before it**, unlike every
other occurrence in the file (1952 `turn-start` vs. 847 `spawn` total — reuse is
normal, but every fresh spawn is always paired). Nothing followed: no
`turn-done`, no error, no watchdog event, for another 15+ minutes.

Full-file event tally: `child-error` occurs **zero times ever** in this log's
history, despite the exact string `'claude CLI not found'` existing in the
source (see below) as the one thing that would explain the user's report
literally. That string never fired via the code path that produces it, which
means the UI text the user saw is either a stale/cached state or comes from
somewhere else — worth checking the renderer side too.

`ps aux` at the time of investigation showed **13 `<defunct>` (zombie) `claude`
processes** system-wide, alongside a recurring, unrelated crash:

```
{"event":"main:uncaughtException","error":"TypeError: Cannot read properties of
undefined (reading 'close')\n    at BrowserWindow.<anonymous>
(.../out/main/index.js:1721:22)"}
```

— seen intermittently for weeks, most recently ~13h before this incident. Not
proven to be the trigger, but a plausible one (see hypothesis below).

## Root cause (traced in source, `src/main/agent.ts`)

`sendToAgent` (line 341) only treats a connection as dead — and respawns — when
Node has already observed the exit:

```ts
if (conn && (conn.child.exitCode !== null || conn.child.signalCode !== null)) {
  conns.delete(key)
  conn = undefined
}
...
if (!conn) conn = spawnConn(win, key, worktreePath, options)
...
log('turn-start', { key, ... })
write(conn, { type: 'user', message: {...} })
```

A zombie/defunct child (reaped by the OS but never processed by Node's
`child_process` event loop — e.g. if the main process was busy or the streams
were left half-open) still reads `exitCode === null`. `sendToAgent` reuses it,
skips `spawnConn` (hence no `spawn` log), and writes straight to a dead stdin.

That write's failure is swallowed with zero signal, at line 276:

```ts
child.stdin.on('error', () => {})
```

Compare to the child-level handler a few lines down (line 292), which *does*
log and *does* produce the exact string the user reported:

```ts
child.on('error', (e) => {
  ...
  send(win, key, { kind: 'error', message: e.message.includes('ENOENT') ? 'claude CLI not found' : e.message })
  send(win, key, { kind: 'done', ok: false })
})
```

So: a stdin EPIPE from a zombie child hits the silent handler, not this one —
the turn is marked active with no way to ever complete.

The watchdog (`startAgentWatchdog`, line 586) should catch this via
`SILENT_STUCK_MS`/`SILENT_RECOVER_MS` once `lastActivityAt` stops advancing.
It never did, for either key, over 2h20m — well past any of the watchdog's
thresholds. The watchdog loop has no `try/catch` per key:

```ts
watchdog = setInterval(() => {
  for (const [key, conn] of conns) {
    const childAlive = conn.child.exitCode === null && conn.child.signalCode === null
    const action = watchdogAction(conn, now, childAlive)
    if (action === 'recover') { ... send(conn.win, key, ...) ... }
    ...
  }
}, WATCHDOG_MS)
```

If any single entry's `conn.win` is a destroyed `BrowserWindow` (matching the
`Cannot read properties of undefined (reading 'close')` crash signature seen
elsewhere in this same log), a throw inside that iteration aborts the rest of
the `for` loop for that tick — silently skipping every other key that tick.
If the same stale entry throws on every tick, no other connection's watchdog
ever runs again, indefinitely, with no crash and no log line to point at it.

## Proposed fixes (smallest first)

1. **Log the swallowed stdin error** (`agent.ts:276`) instead of the empty
   handler — at minimum `log('stdin-write-error', { key, message: e.message })`
   so this failure mode stops being invisible. Ideally treat it like
   `child-error`: mark the conn dead, notify the UI, allow the next
   `sendToAgent` to respawn instead of reusing.
2. **Wrap each per-key watchdog iteration in `try/catch`** (`agent.ts:590`) so
   one bad `conn`/`conn.win` can't silently stop every other session's
   recovery. This alone would likely have caught both frozen sessions here.
3. **Broaden the dead-connection check** in `sendToAgent` (`agent.ts:355`) to
   also treat `conn.child.stdin.destroyed` or `conn.child.killed` as dead, not
   only `exitCode`/`signalCode` — a zombie may not have updated those yet.
4. Separately: track down the `Cannot read properties of undefined (reading
   'close')` `main:uncaughtException` — recurring for weeks, plausible trigger
   for #2. Stack only has bundled line numbers (`out/main/index.js:1721`), a
   sourcemap would help pin it to source.

## Workaround used

Recreating the two worktrees under new branch names and redispatching the
pipeline unstuck the equivalent issue in an earlier wave of the same overnight
run — consistent with "a *new* `conns` key never inherits a stale connection."
Restarting the Rookery app is the more general fix (clears every stale `conn`
in memory) but wasn't confirmed against this specific incident before this
report was filed.
