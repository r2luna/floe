import { test } from 'node:test'
import assert from 'node:assert/strict'

// The poller reads `window.floe.agent` and listens on `document`; a `node
// --test` process has neither. Stubs of just what it touches.
let calls = 0
let answer: () => Promise<string[]> = () => Promise.resolve(['a'])
;(globalThis as { window?: unknown }).window = {
  floe: {
    agent: {
      active: () => {
        calls++
        return answer()
      },
      waiting: () => Promise.resolve(['w'])
    }
  }
}
;(globalThis as { document?: unknown }).document = {
  hidden: false,
  addEventListener: () => {},
  removeEventListener: () => {}
}

const { refreshTurns, subscribeTurns, turnsPolling } = await import('./activeTurns.ts')

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

test('every subscriber hears one answer, asked for once', async () => {
  calls = 0
  const heard: string[][] = []
  const offA = subscribeTurns((s) => heard.push(s.active ?? []))
  const offB = subscribeTurns((s) => heard.push(s.active ?? []))
  assert.equal(turnsPolling(), true)
  await tick()
  await tick()
  // Two mounts in the same tick share the request that was already out.
  assert.equal(calls, 1)
  assert.deepEqual(heard, [['a'], ['a']])
  offA()
  assert.equal(turnsPolling(), true, 'still one listener')
  offB()
  assert.equal(turnsPolling(), false, 'the timer goes with the last listener')
})

test('a failed read is a null, not an empty list', async () => {
  answer = () => Promise.reject(new Error('gone'))
  const snapshot = await refreshTurns()
  assert.equal(snapshot.active, null)
  assert.deepEqual(snapshot.waiting, ['w'])
  answer = () => Promise.resolve(['a'])
})

test('a concurrent refresh shares the request in flight', async () => {
  calls = 0
  const [x, y] = await Promise.all([refreshTurns(), refreshTurns()])
  assert.equal(calls, 1)
  assert.equal(x, y)
})
