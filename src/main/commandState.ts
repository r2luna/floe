// Where a registered command IS, as one value the whole app agrees on.
//
// The runner used to answer this with a boolean (`running`), which cannot say
// the two things that matter most when a command misbehaves: that a stop was
// asked for and has not landed yet, and that a command with `auto-restart` is
// dying as fast as it is spawned. Both used to read as "running", so a restart
// loop looked healthy while it pinned a core.
//
// Kept free of electron/node-pty imports, like commandExit.ts, so the whole
// lifecycle — including the backoff and the breaker — is unit-testable without
// spawning anything.

/**
 * `starting` and `stopping` are the two transitional states, and they exist so
 * a second start (or a watch event, or an impatient keypress) can be refused
 * rather than queued into a second process. `crash-looping` is terminal until
 * something asks for a start by hand: the breaker opened, and re-arming it
 * automatically would be the loop we just stopped.
 */
export type CommandState = 'idle' | 'starting' | 'running' | 'stopping' | 'exited' | 'crash-looping'

/** How long a restart waits, and how far apart failures must be to be forgiven. */
export const BACKOFF_MIN_MS = 1000
export const BACKOFF_MAX_MS = 30_000
/** Failures inside this window count toward the breaker; older ones are dropped. */
export const BREAKER_WINDOW_MS = 60_000
/** Failures within the window that open the breaker. */
export const BREAKER_LIMIT = 5

/**
 * One command's lifecycle, as data.
 *
 * `failures` holds the epoch-ms of recent non-zero exits — a sliding window
 * rather than a counter, because a counter cannot tell four crashes this minute
 * from four crashes spread across the afternoon, and only the first is a loop.
 */
export interface CommandLife {
  state: CommandState
  /** Non-zero exits still inside the breaker window, oldest first. */
  failures: number[]
  /** Why the breaker opened, for the row to show. Cleared by a manual start. */
  reason?: string
}

export function newLife(): CommandLife {
  return { state: 'idle', failures: [] }
}

/**
 * The wait before restart number `n` (n = 1 for the first): 1s, 2s, 4s … capped
 * at 30s. A process that dies on a port conflict comes back fast enough to catch
 * the port freeing up, and one that dies on a syntax error stops burning CPU.
 */
export function backoffMs(n: number): number {
  if (n <= 1) return BACKOFF_MIN_MS
  return Math.min(BACKOFF_MIN_MS * 2 ** (n - 1), BACKOFF_MAX_MS)
}

/** Whether a start may begin now. A transitional state means one already is. */
export function canStart(life: CommandLife): boolean {
  return life.state === 'idle' || life.state === 'exited' || life.state === 'crash-looping'
}

/**
 * A start was asked for by hand.
 *
 * This is the only thing that re-arms the breaker: you looked at the reason, you
 * fixed something (or you did not), and you asked again. Everything automatic —
 * the watch, the auto-restart — goes through `onExit` instead and stays subject
 * to it.
 */
export function onStart(): CommandLife {
  return { state: 'starting', failures: [] }
}

/** The PTY is up. */
export function onSpawned(life: CommandLife): CommandLife {
  return { ...life, state: 'running' }
}

/** A stop was asked for; the process has been signalled but has not exited. */
export function onStop(life: CommandLife): CommandLife {
  return { ...life, state: 'stopping' }
}

/**
 * What to do now that the process is gone.
 *
 * `autoRestart` only survives an exit the user did not ask for: a stop is an
 * instruction, and bringing the process back would be the app arguing with it.
 * A clean exit (code 0) is likewise left alone — a one-shot that finished is not
 * a crash, and restarting it forever is how `migrate:fresh` wipes a database in
 * a loop.
 */
export function onExit(
  life: CommandLife,
  code: number,
  at: number,
  autoRestart: boolean
): { life: CommandLife; restartIn?: number } {
  const asked = life.state === 'stopping'
  if (asked || !autoRestart || code === 0) return { life: { ...life, state: 'exited' } }

  const failures = [...life.failures, at].filter((t) => at - t < BREAKER_WINDOW_MS)
  if (failures.length >= BREAKER_LIMIT) {
    return {
      life: {
        state: 'crash-looping',
        failures,
        reason: `exited ${failures.length}× in under a minute — auto-restart stopped`
      }
    }
  }
  return { life: { ...life, state: 'exited', failures }, restartIn: backoffMs(failures.length) }
}

/**
 * Whether a filesystem event should be acted on.
 *
 * A watch fires while the command is mid-spawn or mid-kill more often than it
 * looks: a `migrate:fresh` writing to the very directory it watches will do it
 * every time. Acting then stacks a second spawn onto a process that has not
 * finished starting, and the two race for the same port or the same database.
 */
export function shouldWatchFire(life: CommandLife): boolean {
  return life.state === 'running' || life.state === 'exited' || life.state === 'idle'
}
