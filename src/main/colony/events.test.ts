import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHook } from '../config/hook.test-helper.ts'

installHook()

const dir = mkdtempSync(join(tmpdir(), 'colony-events-'))
const { setSharedDataDir } = await import('../dataDir.ts')
setSharedDataDir(dir)

const { listEvents, recordEvent } = await import('./events.ts')

const event = (board: string, n: number) =>
  ({ project: '/p', board, kind: 'passed', task: `t${n}`, taskName: `n${n}`, text: '' }) as const

test('each board keeps its own log', () => {
  recordEvent(event('/p', 1))
  recordEvent(event('/p/.worktrees/a', 2))
  assert.deepEqual(listEvents('/p').map((e) => e.task), ['t1'])
  assert.deepEqual(listEvents('/p/.worktrees/a').map((e) => e.task), ['t2'])
})

test('an event from before boards were split is on the root board', () => {
  const file = join(dir, 'colony-events.json')
  const store = JSON.parse(readFileSync(file, 'utf8'))
  store.events.push({ id: 'ev_old', project: '/p', at: 1, kind: 'merged', task: 'old', taskName: 'old', text: '' })
  writeFileSync(file, JSON.stringify(store))
  assert.deepEqual(listEvents('/p').map((e) => e.task), ['t1', 'old'])
})

test('the log is trimmed per board — a busy board does not push another one out', () => {
  for (let n = 0; n < 205; n++) recordEvent(event('/p/.worktrees/busy', 100 + n))
  assert.equal(listEvents('/p/.worktrees/busy').length, 200)
  assert.equal(listEvents('/p').length, 2)
  assert.equal(listEvents('/p/.worktrees/a').length, 1)
})
