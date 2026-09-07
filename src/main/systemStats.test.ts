import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import type { PsRow } from './psSnapshot.ts'

// The memory total is app metrics + the RSS of process trees we spawned. Both
// halves come from the machine, so the loader hook replaces Electron and the
// four modules systemStats reads them from: the tree walk is then fed a table
// this test writes, which is the only way to assert what it actually sums.
const g = globalThis as typeof globalThis & {
  __floeAppMetrics?: { memory?: { workingSetSize?: number } }[]
  __floeRows?: PsRow[]
  __floeRoots?: { session: number[]; terminal: number[]; command: number[] }
  __floeSnapshots?: number
}
g.__floeAppMetrics = []
g.__floeRows = []
g.__floeRoots = { session: [], terminal: [], command: [] }
g.__floeSnapshots = 0

const hookSource = `
const STUBS = {
  'electron': "export const app = { getAppMetrics: () => globalThis.__floeAppMetrics }; export default {};",
  './psSnapshot': "export function snapshotProcesses() { globalThis.__floeSnapshots++; return Promise.resolve(globalThis.__floeRows) }",
  './agent': "export function getSessionPids() { return globalThis.__floeRoots.session }",
  './terminal': "export function getTerminalPids() { return globalThis.__floeRoots.terminal }",
  './commandRunner': "export function getCommandPids() { return globalThis.__floeRoots.command }"
}
export async function resolve(specifier, context, next) {
  if (STUBS[specifier]) return { url: 'stub:' + specifier, shortCircuit: true, format: 'module' }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (url.startsWith('stub:')) {
    return { format: 'module', shortCircuit: true, source: STUBS[url.slice(5)] }
  }
  return next(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

const { sampleMemory } = await import('./systemStats.ts')

const KB = 1024
const row = (pid: number, ppid: number, kb: number): PsRow => ({ pid, ppid, pgid: pid, rssBytes: kb * KB })

// 100 is a root with a child and a grandchild; 400 belongs to nobody we spawned.
const TABLE: PsRow[] = [row(100, 1, 10), row(200, 100, 20), row(300, 200, 30), row(400, 1, 999)]

function setup(roots: { session?: number[]; terminal?: number[]; command?: number[] }): void {
  g.__floeAppMetrics = [{ memory: { workingSetSize: 1 } }, { memory: { workingSetSize: 2 } }, {}]
  g.__floeRows = TABLE
  g.__floeRoots = { session: roots.session ?? [], terminal: roots.terminal ?? [], command: roots.command ?? [] }
  g.__floeSnapshots = 0
}

const APP_BYTES = 3 * KB // 1 + 2 KB, and the metric with no memory counts as 0

test('a root carries its whole descendant tree, and nothing else', async () => {
  setup({ session: [100] })
  const { totalBytes } = await sampleMemory()
  assert.equal(totalBytes, APP_BYTES + 60 * KB) // 10 + 20 + 30, never 400's 999
})

// Roots come from three independent registries, so the same process can be
// named twice — a terminal PTY under a session, say. Counting it twice would
// inflate the widget by the size of the biggest tree.
test('a process reachable from two roots is counted once', async () => {
  setup({ session: [100], terminal: [200], command: [300] })
  const { totalBytes } = await sampleMemory()
  assert.equal(totalBytes, APP_BYTES + 60 * KB)
})

test('a root that already exited adds nothing', async () => {
  setup({ session: [99999] })
  const { totalBytes } = await sampleMemory()
  assert.equal(totalBytes, APP_BYTES)
})

// `ps -A` is a full process-table scan; with nothing spawned there is nothing
// to look up, so the sample must not pay for one.
test('no spawned roots means no ps scan at all', async () => {
  setup({})
  const { totalBytes } = await sampleMemory()
  assert.equal(g.__floeSnapshots, 0)
  assert.equal(totalBytes, APP_BYTES)
})
