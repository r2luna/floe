import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { detectDevCommand, detectPackageManager, startDev, stopDev } from './devServer.ts'
import type { DevEvent } from './devServer.ts'

// The dev runner spawns whatever `detectDevCommand` names. A bin dir of tiny
// scripts at the front of PATH makes that a real spawn of a fake npm, so the
// stdout/url/exit wiring is exercised without a project's real dev server.
const BIN = mkdtempSync(join(tmpdir(), 'floe-dev-bin-'))
const realPath = process.env.PATH ?? ''
process.env.PATH = `${BIN}:${realPath}`

function fakeBin(name: string, body: string): void {
  const path = join(BIN, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

// Two URLs on purpose: only the first is announced.
fakeBin('npm', 'echo "ready at http://localhost:5173/"\necho "also http://127.0.0.1:9999/"')
fakeBin('sleeper', 'exec sleep 30')

const worktree = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'floe-dev-'))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return dir
}

function fakeWin(): { win: BrowserWindow; events: DevEvent[] } {
  const events: DevEvent[] = []
  const win = {
    isDestroyed: () => false,
    webContents: { send: (_ch: string, payload: DevEvent) => events.push(payload) }
  }
  return { win: win as unknown as BrowserWindow, events }
}

/** Resolve when the run ends, so no test finishes with a child still alive. */
const exited = (events: DevEvent[]): Promise<DevEvent> =>
  new Promise((resolve) => {
    const tick = setInterval(() => {
      const exit = events.find((e) => e.kind === 'exit')
      if (exit) {
        clearInterval(tick)
        resolve(exit)
      }
    }, 5)
  })

test('detectPackageManager: bun beats pnpm beats yarn, npm is the fallback', () => {
  assert.equal(detectPackageManager(worktree({ 'bun.lockb': '', 'pnpm-lock.yaml': '' })), 'bun')
  assert.equal(detectPackageManager(worktree({ 'bun.lock': '' })), 'bun')
  assert.equal(detectPackageManager(worktree({ 'pnpm-lock.yaml': '', 'yarn.lock': '' })), 'pnpm')
  assert.equal(detectPackageManager(worktree({ 'yarn.lock': '' })), 'yarn')
  assert.equal(detectPackageManager(worktree({})), 'npm')
})

test('a node project runs its package manager’s dev script', () => {
  const dir = worktree({
    'package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
    'pnpm-lock.yaml': ''
  })
  assert.deepEqual(detectDevCommand(dir), {
    cmd: 'pnpm',
    args: ['run', 'dev'],
    kind: 'node',
    label: 'pnpm run dev'
  })
})

test('a package.json without a dev script is not a node project', () => {
  const dir = worktree({ 'package.json': JSON.stringify({ scripts: { build: 'tsc' } }) })
  assert.equal(detectDevCommand(dir), null)
})

test('a malformed package.json falls through instead of throwing', () => {
  // Laravel below it still answers, which is the point of falling through.
  const dir = worktree({ 'package.json': '{ not json', artisan: '', 'composer.json': '{}' })
  assert.deepEqual(detectDevCommand(dir), {
    cmd: 'php',
    args: ['artisan', 'serve'],
    kind: 'laravel',
    label: 'artisan serve'
  })
})

test('laravel: composer dev when it has one, artisan serve otherwise', () => {
  const withDev = worktree({
    artisan: '',
    'composer.json': JSON.stringify({ scripts: { dev: ['a', 'b'] } })
  })
  assert.deepEqual(detectDevCommand(withDev), {
    cmd: 'composer',
    args: ['dev'],
    kind: 'laravel',
    label: 'composer dev'
  })

  const malformed = worktree({ artisan: '', 'composer.json': '{ not json' })
  assert.equal(detectDevCommand(malformed)?.label, 'artisan serve')

  // artisan without composer.json is not enough to call it a Laravel project.
  assert.equal(detectDevCommand(worktree({ artisan: '' })), null)
})

test('an empty directory has no dev command', () => {
  assert.equal(detectDevCommand(worktree({})), null)
})

test('startDev: started, logs, the first URL only, then exit', async () => {
  const dir = worktree({ 'package.json': JSON.stringify({ scripts: { dev: 'x' } }) })
  const { win, events } = fakeWin()
  const command = startDev(win, dir, 'feat/x')
  assert.equal(command?.label, 'npm run dev')

  const exit = await exited(events)
  assert.equal(exit.kind === 'exit' && exit.code, 0)
  assert.equal(events[0].kind, 'started')
  assert.equal(events.at(-1)?.kind, 'exit')
  const started = events[0]
  assert.equal(started.kind === 'started' && started.label, 'npm run dev')
  const urls = events.filter((e) => e.kind === 'url')
  assert.equal(urls.length, 1)
  assert.equal(urls[0].kind === 'url' && urls[0].url, 'http://localhost:5173/')
  // Every event carries the worktree it belongs to.
  assert.ok(events.every((e) => e.worktreePath === dir))
  const log = events.find((e) => e.kind === 'log')
  assert.match(log?.kind === 'log' ? log.text : '', /ready at/)
})

test('startDev: nothing to run answers null and emits nothing', () => {
  const { win, events } = fakeWin()
  assert.equal(startDev(win, worktree({}), 'feat/x'), null)
  assert.deepEqual(events, [])
})

test('startDev: a missing binary is reported as "<cmd> not found"', async () => {
  const dir = worktree({ 'package.json': JSON.stringify({ scripts: { dev: 'x' } }), 'bun.lockb': '' })
  const { win, events } = fakeWin()
  const noPath = process.env.PATH
  process.env.PATH = join(BIN, 'empty')
  try {
    assert.equal(startDev(win, dir, 'feat/x')?.cmd, 'bun')
  } finally {
    process.env.PATH = noPath
  }
  const exit = await exited(events)
  assert.equal(exit.kind === 'exit' && exit.code, 1)
  assert.equal(exit.kind === 'exit' && exit.message, 'bun not found')
})

test('stopDev kills the run', async () => {
  const dir = worktree({ 'package.json': JSON.stringify({ scripts: { dev: 'x' } }) })
  // A dev server does not exit on its own, so point npm at something that waits.
  fakeBin('npm', 'exec sleep 1')

  const { win, events } = fakeWin()
  startDev(win, dir, 'feat/x')
  stopDev(dir)
  const exit = await exited(events)
  assert.equal(exit.kind === 'exit' && exit.code, 0) // killed → no code → 0
  stopDev(dir) // nothing left to stop: a no-op, not a throw
})

test('starting again replaces the previous run', async () => {
  const dir = worktree({ 'package.json': JSON.stringify({ scripts: { dev: 'x' } }) })
  const first = fakeWin()
  startDev(first.win, dir, 'feat/x')
  const second = fakeWin()
  startDev(second.win, dir, 'feat/x')

  // The first run is stopped by the second one starting — one run per worktree.
  const firstExit = await exited(first.events)
  assert.equal(firstExit.kind === 'exit' && firstExit.code, 0)
  assert.equal(second.events[0].kind, 'started')
  await exited(second.events)
})

test('a destroyed window is never sent to', async () => {
  const dir = worktree({ 'package.json': JSON.stringify({ scripts: { dev: 'x' } }) })
  let sends = 0
  const win = {
    isDestroyed: () => true,
    webContents: { send: () => sends++ }
  } as unknown as BrowserWindow
  startDev(win, dir, 'feat/x')
  await new Promise((r) => setTimeout(r, 150))
  stopDev(dir)
  assert.equal(sends, 0)
})

after(() => {
  process.env.PATH = realPath
})
