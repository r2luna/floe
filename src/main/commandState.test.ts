import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BACKOFF_MAX_MS,
  BREAKER_LIMIT,
  BREAKER_WINDOW_MS,
  backoffMs,
  canStart,
  newLife,
  onExit,
  onSpawned,
  onStart,
  onStop,
  shouldWatchFire,
  type CommandLife
} from './commandState.ts'

// The whole point of this module is the two cases a boolean could not express:
// a stop that has been asked for but not landed, and a command dying as fast as
// it spawns. Both are tested here rather than through the runner, which would
// need a real PTY to reach them.

const running = (): CommandLife => onSpawned(onStart())

test('a start is refused while one is already in flight', () => {
  assert.equal(canStart(newLife()), true)
  assert.equal(canStart(onStart()), false, 'starting')
  assert.equal(canStart(running()), false, 'running')
  assert.equal(canStart(onStop(running())), false, 'stopping')
})

test('a start is allowed again once the process is gone', () => {
  const { life } = onExit(running(), 0, 1000, false)
  assert.equal(life.state, 'exited')
  assert.equal(canStart(life), true)
})

test('an exit the user asked for never restarts', () => {
  const { life, restartIn } = onExit(onStop(running()), 143, 1000, true)
  assert.equal(life.state, 'exited')
  assert.equal(restartIn, undefined, 'a stop is an instruction, not a failure')
})

test('a clean exit never restarts, even with auto-restart on', () => {
  const { restartIn } = onExit(running(), 0, 1000, true)
  assert.equal(restartIn, undefined)
})

test('a crash restarts on a growing backoff', () => {
  let life = running()
  const waits: number[] = []
  for (let i = 1; i <= 4; i++) {
    const r = onExit(life, 1, i * 1000, true)
    life = onSpawned(onStart())
    life.failures = r.life.failures // a restart is not a manual start: the window carries
    waits.push(r.restartIn as number)
  }
  assert.deepEqual(waits, [1000, 2000, 4000, 8000])
})

test('the breaker opens after enough failures inside the window', () => {
  let life: CommandLife = running()
  let last = onExit(life, 1, 1000, true)
  for (let i = 2; i <= BREAKER_LIMIT; i++) {
    life = { ...onSpawned(onStart()), failures: last.life.failures }
    last = onExit(life, 1, i * 1000, true)
  }
  assert.equal(last.life.state, 'crash-looping')
  assert.equal(last.restartIn, undefined, 'an open breaker schedules nothing')
  assert.match(last.life.reason ?? '', /auto-restart stopped/)
})

test('failures older than the window are forgiven', () => {
  // Four ancient crashes plus one now is not a loop — the fifth must still be
  // scheduled, or a command that fails once a day eventually refuses to run.
  const life: CommandLife = { state: 'running', failures: [1, 2, 3, 4] }
  const at = 5 + BREAKER_WINDOW_MS
  const { life: next, restartIn } = onExit(life, 1, at, true)
  assert.deepEqual(next.failures, [at])
  assert.equal(restartIn, 1000)
})

test('a manual start re-arms the breaker', () => {
  const looping: CommandLife = { state: 'crash-looping', failures: [1, 2, 3, 4, 5], reason: 'x' }
  assert.equal(canStart(looping), true, 'you can always ask again by hand')
  const life = onStart()
  assert.deepEqual(life.failures, [])
  assert.equal(life.reason, undefined)
})

test('backoff is capped', () => {
  assert.equal(backoffMs(1), 1000)
  assert.equal(backoffMs(99), BACKOFF_MAX_MS)
})

test('a watch event is ignored mid-spawn and mid-kill', () => {
  assert.equal(shouldWatchFire(running()), true)
  assert.equal(shouldWatchFire(onStart()), false)
  assert.equal(shouldWatchFire(onStop(running())), false)
  // An open breaker means the command is broken; re-running it on every file
  // save is exactly the loop the breaker just stopped.
  assert.equal(shouldWatchFire({ state: 'crash-looping', failures: [] }), false)
})
