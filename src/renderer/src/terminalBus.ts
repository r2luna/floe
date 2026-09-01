// The seam between "something asked for a command to be run" and the terminal
// panel that runs it.
//
// Its own module, and deliberately not part of Terminal.tsx: the command
// registry sends commands here, and the registry is imported by node tests that
// cannot load a .tsx file. Nothing here touches the DOM.

/**
 * Terminals ready to be typed into, by id. A panel that is mounted and done
 * repainting registers a sink; anything sent before that waits below, because
 * bytes typed while the scrollback is being replayed come out interleaved with
 * the repaint.
 */
const sinks = new Map<string, (data: string) => void>()
const waiting = new Map<string, string[]>()

/**
 * Last time a terminal produced output, by id — attaching counts as output, so
 * a shell that is still booting gets its quiet window measured from the mount.
 */
const lastOutput = new Map<string, number>()
/** When the oldest queued command for a terminal started waiting, by id. */
const since = new Map<string, number>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

// A shell asks the terminal about itself at boot and at every prompt render
// (DA1, OSC 10/11, DSR cursor position). xterm answers those a round trip
// later, back through the same input channel a typed command uses. Type the
// command first and the answers land *after* the Enter — the foreground program
// doesn't consume them, so the tty echoes them as junk into its output
// (`^[[?1;2c^[]11;rgb:…^G^[[2;1R`). So a played command waits for the PTY to go
// quiet, which is when every answer in flight has already been delivered.
const QUIET_MS = 120
// …but not forever: a terminal that never stops printing (a `tail -f`, a dev
// server) would hold the command indefinitely. Past this, type it anyway.
const MAX_WAIT_MS = 2000

/** Type a command into a terminal, now or as soon as it can take it. */
export function sendToTerminal(termId: string, command: string): void {
  const data = `${command}\r`
  waiting.set(termId, [...(waiting.get(termId) ?? []), data])
  if (!since.has(termId)) since.set(termId, Date.now())
  schedule(termId)
}

/** A terminal announcing it can take input, and draining what waited for it. */
export function attachTerminal(termId: string, sink: (data: string) => void): void {
  sinks.set(termId, sink)
  lastOutput.set(termId, Date.now())
  schedule(termId)
}

/** A terminal reporting PTY output, which restarts its quiet window. */
export function noteTerminalOutput(termId: string): void {
  lastOutput.set(termId, Date.now())
}

export function detachTerminal(termId: string): void {
  sinks.delete(termId)
  const timer = timers.get(termId)
  if (timer) clearTimeout(timer)
  timers.delete(termId)
}

// Hand the queue to the sink once the terminal has been quiet long enough, or
// re-check when it will have been.
function schedule(termId: string): void {
  const sink = sinks.get(termId)
  const queued = waiting.get(termId)
  if (!sink || !queued?.length) return
  const timer = timers.get(termId)
  if (timer) clearTimeout(timer)
  timers.delete(termId)

  const now = Date.now()
  const quiet = now - (lastOutput.get(termId) ?? 0)
  const waited = now - (since.get(termId) ?? now)
  if (quiet < QUIET_MS && waited < MAX_WAIT_MS) {
    const wait = Math.min(QUIET_MS - quiet, MAX_WAIT_MS - waited)
    timers.set(
      termId,
      setTimeout(() => {
        timers.delete(termId)
        schedule(termId)
      }, wait)
    )
    return
  }

  waiting.delete(termId)
  since.delete(termId)
  for (const data of queued) sink(data)
}
