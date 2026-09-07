// Waiting on real filesystem watchers, debounces and spawned processes.
//
// This exists because `await wait(400)` then `assert.equal(fired, 1)` is a bet
// on the machine, and the bet is lost roughly one run in twenty. Two forces
// pull in opposite directions:
//
//   Too early. fs.watch is not synchronous with the write that caused it —
//   macOS FSEvents batches with its own latency, Linux inotify hands the event
//   to the loop on its own schedule, and every watcher here then debounces on
//   top (120ms in keybindings and config, 150ms in draw, 250ms in reviewWatch
//   and plans, 300ms in commandRunner). Under `--experimental-test-coverage`
//   every one of those callbacks runs instrumented, so a delay that clears the
//   window on a plain run does not clear it under the gate. That is the
//   "expected 1, got 0" failure.
//
//   Too late. A single save is several fs events (truncate, write, close; an
//   atomic save is tmp + rename), and FSEvents can replay a change made just
//   before the watch armed. Counting the instant the first event lands means a
//   duplicate that was already in flight arrives after the assertion and the
//   next test inherits it. That is the "expected 1, got 2" failure.
//
// So: `waitFor` for the first force, `settle` for the second. Neither one
// loosens a count — they decide *when* to count. "Exactly one debounced call"
// still has to be exactly one.
//
// Excluded from the CRAP metric by its `.test-helper.ts` name, and outside the
// `src/**/*.test.ts` glob, so `node --test` does not try to run it.

const POLL_MS = 10

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Poll `predicate` until it is true, or throw once `timeout` has passed.
 *
 * The throw is the point: a silent give-up turns a watcher that never fired
 * into a confusing assertion failure three lines further down. `what` labels
 * the message; without one the predicate's own source is used, which for
 * `() => sent.length > 0` reads better than anything a caller would type.
 */
export async function waitFor(
  predicate: () => boolean,
  timeout = 5_000,
  what?: string
): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeout}ms waiting for ${what ?? predicate.toString()}`)
    }
    await sleep(POLL_MS)
  }
}

/**
 * Poll `read` until it has not changed for `quietMs`, then return the value it
 * settled on.
 *
 * This is what makes a "collapses into one call" assertion mean something. The
 * caller wants to count after the event stream is finished, not at the first
 * sign of life — so the quiet window has to outlast the watcher's debounce, and
 * every event that arrives restarts it. A stream that never goes quiet is a
 * real bug (a watcher firing in a loop), so that throws rather than returning a
 * number the caller would assert on.
 *
 * It is also the honest way to assert a negative. `settle(() => fired)` on a
 * counter that stays at 0 waits out `quietMs` exactly like a fixed delay would,
 * but if a stray event does land the window extends and the assertion still
 * catches it.
 */
export async function settle(
  read: () => number,
  quietMs = 400,
  timeout = 8_000
): Promise<number> {
  const deadline = Date.now() + timeout
  let seen = read()
  let lastChange = Date.now()
  for (;;) {
    if (Date.now() - lastChange >= quietMs) return seen
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeout}ms waiting for ${quietMs}ms of quiet (still at ${seen})`)
    }
    await sleep(POLL_MS)
    const now = read()
    if (now !== seen) {
      seen = now
      lastChange = Date.now()
    }
  }
}
