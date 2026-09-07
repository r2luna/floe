import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

// `ps -A` is the one thing this module does, so the test replaces
// node:child_process through a loader hook: real spawns would make the parsed
// rows whatever this machine happens to be running. The stub forwards every
// call to a global the test owns, so each case decides what `ps` "printed".
type ExecFileCb = (err: Error | null, stdout: string) => void
interface PsCall {
  cmd: string
  args: string[]
}

const g = globalThis as typeof globalThis & {
  __floePsCalls?: PsCall[]
  __floePsReply?: (cb: ExecFileCb) => void
}
g.__floePsCalls = []
g.__floePsReply = (cb) => cb(null, '')

const hookSource = `
export async function resolve(specifier, context, next) {
  if (specifier === 'node:child_process') {
    return { url: 'stub:child_process', shortCircuit: true, format: 'module' }
  }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (url === 'stub:child_process') {
    const src = [
      'export function execFile(cmd, args, cb) {',
      '  globalThis.__floePsCalls.push({ cmd, args })',
      '  globalThis.__floePsReply(cb)',
      '}',
      'export default { execFile };'
    ].join('\\n')
    return { format: 'module', shortCircuit: true, source: src }
  }
  return next(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

// The TTL cache reads Date.now(), so time is mocked for the whole file: a test
// that needs a fresh spawn ticks past the TTL instead of sleeping 1.5s.
mock.timers.enable({ apis: ['Date'], now: 1_000_000 })

const { snapshotProcesses } = await import('./psSnapshot.ts')

const PS_OUT = [
  '    1     0     1  12000',
  '  501     1   501   2048',
  '  502   501   501    512',
  'ps: bogus line',
  ''
].join('\n')

test('parses `ps -A` into pid/ppid/pgid rows, with rss in bytes', async () => {
  g.__floePsCalls = []
  g.__floePsReply = (cb) => cb(null, PS_OUT)

  const rows = await snapshotProcesses()

  assert.deepEqual(g.__floePsCalls, [{ cmd: 'ps', args: ['-A', '-o', 'pid=,ppid=,pgid=,rss='] }])
  assert.deepEqual(rows, [
    { pid: 1, ppid: 0, pgid: 1, rssBytes: 12000 * 1024 },
    { pid: 501, ppid: 1, pgid: 501, rssBytes: 2048 * 1024 },
    { pid: 502, ppid: 501, pgid: 501, rssBytes: 512 * 1024 }
  ])
})

// The point of the module: two pollers on the same 2s cadence share one scan.
test('a second call inside the TTL reuses the snapshot instead of spawning again', async () => {
  g.__floePsCalls = []
  mock.timers.tick(1_400) // still under TTL

  const [a, b] = await Promise.all([snapshotProcesses(), snapshotProcesses()])

  assert.equal(g.__floePsCalls.length, 0)
  assert.deepEqual(a, b)
  assert.equal(a.length, 3)
})

test('past the TTL the table is scanned again', async () => {
  g.__floePsCalls = []
  g.__floePsReply = (cb) => cb(null, '  7   1   7   4\n')
  mock.timers.tick(1_600)

  const rows = await snapshotProcesses()

  assert.equal(g.__floePsCalls.length, 1)
  assert.deepEqual(rows, [{ pid: 7, ppid: 1, pgid: 7, rssBytes: 4096 }])
})

// A machine without `ps` (or one where it fails) must not break the memory
// widget — an empty table just means "nothing to add".
test('a failing ps is an empty table, not a rejection', async () => {
  mock.timers.tick(1_600)
  g.__floePsReply = (cb) => cb(new Error('ENOENT'), '')

  assert.deepEqual(await snapshotProcesses(), [])
})
