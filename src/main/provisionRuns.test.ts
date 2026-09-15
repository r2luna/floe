import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beginProvision, cancelProvision, provisionCancelled, trackChild } from './provisionRuns.ts'

test('cancelling a provision kills the steps running in its tree and waits for the run to end', async () => {
  const tree = mkdtempSync(join(tmpdir(), 'floe-provision-run-'))
  try {
    const run = beginProvision(tree)
    const child = spawn('sleep', ['30'], { cwd: join(tree), detached: process.platform !== 'win32' })
    trackChild(join(tree), child)
    const exited = new Promise<string | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)))
    // The run ends once its step dies, the way provisionWorktree's finally does.
    child.once('exit', () => run.end())

    await cancelProvision(tree)
    assert.equal(await exited, 'SIGTERM')
    assert.equal(provisionCancelled(tree), false, 'an ended run is forgotten')
  } finally {
    rmSync(tree, { recursive: true, force: true })
  }
})

test('a tree with no provision running cancels instantly, and a stranger process is left alone', async () => {
  const other = mkdtempSync(join(tmpdir(), 'floe-provision-none-'))
  try {
    await cancelProvision(other)
    const child = spawn('sleep', ['5'], { cwd: other })
    trackChild(other, child)
    await cancelProvision(other)
    assert.equal(child.exitCode, null, 'untracked by any run, still running')
    child.kill()
  } finally {
    rmSync(other, { recursive: true, force: true })
  }
})

test('a second run for the same tree cancels the first', () => {
  const first = beginProvision('/tree-twice')
  const second = beginProvision('/tree-twice')
  assert.equal(first.signal.aborted, true)
  assert.equal(second.signal.aborted, false)
  second.end()
  first.end()
})
