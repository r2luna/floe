import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import {
  attachTerminal,
  detachTerminal,
  noteTerminalOutput,
  sendToTerminal
} from './terminalBus.ts'

// Every case drives the clock, because the bus holds a played command until the
// PTY has been quiet — real timers would make these tests seconds long.
const withClock = (body: (tick: (ms: number) => void) => void): void => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  try {
    body((ms) => mock.timers.tick(ms))
  } finally {
    mock.timers.reset()
  }
}

test('a command waits for the terminal to attach', () => {
  withClock((tick) => {
    const got: string[] = []
    sendToTerminal('t1', 'ls')
    tick(1000)
    assert.equal(got.length, 0, 'nothing to type into yet')
    attachTerminal('t1', (d) => got.push(d))
    tick(200)
    assert.deepEqual(got, ['ls\r'])
    detachTerminal('t1')
  })
})

test('a command holds until the shell stops talking', () => {
  withClock((tick) => {
    const got: string[] = []
    attachTerminal('t2', (d) => got.push(d))
    sendToTerminal('t2', 'wc -l')
    tick(100)
    noteTerminalOutput('t2') // boot output — its query answers are in flight
    tick(100)
    assert.equal(got.length, 0, 'the quiet window restarted with the output')
    tick(50)
    assert.deepEqual(got, ['wc -l\r'])
    detachTerminal('t2')
  })
})

test('a terminal that never goes quiet still gets the command', () => {
  withClock((tick) => {
    const got: string[] = []
    attachTerminal('t3', (d) => got.push(d))
    sendToTerminal('t3', 'echo hi')
    for (let i = 0; i < 40; i++) {
      tick(50)
      noteTerminalOutput('t3')
    }
    assert.deepEqual(got, ['echo hi\r'], 'typed once the max wait ran out')
    detachTerminal('t3')
  })
})

test('queued commands keep their order', () => {
  withClock((tick) => {
    const got: string[] = []
    sendToTerminal('t4', 'first')
    sendToTerminal('t4', 'second')
    attachTerminal('t4', (d) => got.push(d))
    tick(200)
    assert.deepEqual(got, ['first\r', 'second\r'])
    detachTerminal('t4')
  })
})

test('detaching drops the pending drain, and re-attaching resumes it', () => {
  withClock((tick) => {
    const got: string[] = []
    attachTerminal('t5', () => assert.fail('the detached sink must not be used'))
    sendToTerminal('t5', 'ls')
    detachTerminal('t5')
    tick(1000)
    attachTerminal('t5', (d) => got.push(d))
    tick(200)
    assert.deepEqual(got, ['ls\r'])
    detachTerminal('t5')
  })
})
