import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { register } from 'node:module'
import type { BrowserWindow } from 'electron'
import { AWAY_MS } from '../shared/recap.ts'

// recap.ts spawns the CLI and reaches three modules that pull in electron. All
// four are swapped here: a fake child, and stubs that record what the recap
// wrote instead of touching the runtime log or a window. Same
// register-then-dynamic-import shape as claudeInfo.test.ts.
const hookSource = `
const STUB = {
  './agent': 'stub:agent',
  './identity': 'stub:identity',
  'node:child_process': 'stub:child_process'
}
export async function resolve(specifier, context, next) {
  const parent = String(context.parentURL)
  if (parent.includes('recap.ts') && STUB[specifier])
    return { url: STUB[specifier], shortCircuit: true, format: 'module' }
  if (specifier.startsWith('.') && !specifier.endsWith('.ts'))
    return next(specifier + '.ts', context)
  return next(specifier, context)
}
const SOURCE = {
  'stub:agent': 'export const sendAgentEvent = (win, key, event) => globalThis.__events.push({ key, event })',
  'stub:identity': 'export const agentResumeId = (key) => globalThis.__resume[key]',
  'stub:child_process': 'export const spawn = (...a) => globalThis.__floeSpawn(...a)'
}
export async function load(url, context, next) {
  if (SOURCE[url]) return { format: 'module', shortCircuit: true, source: SOURCE[url] }
  return next(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

class FakeStream extends EventEmitter {}

/** Just enough ChildProcess for the recap run: stdout, an end()able stdin, a kill. */
class FakeChild extends EventEmitter {
  stdout = new FakeStream()
  stderr = new FakeStream()
  ended: string[] = []
  killed = false
  stdin = {
    end: (s: string): void => {
      this.ended.push(s)
    }
  }
  kill(): boolean {
    this.killed = true
    return true
  }
  /** What the CLI printed, then exit — the whole life of a recap run. */
  finish(stdout: string): void {
    this.stdout.emit('data', Buffer.from(stdout))
    this.emit('close', 0)
  }
}

interface Evented {
  key: string
  event: { kind: string; name?: string; summary?: string }
}
const g = globalThis as unknown as {
  __floeSpawn: (cmd: string, args: string[], opts: { cwd: string }) => FakeChild
  __events: Evented[]
  __resume: Record<string, string | undefined>
}

let child: FakeChild
let spawned: { cmd: string; args: string[]; cwd: string }
g.__floeSpawn = (cmd, args, opts) => {
  spawned = { cmd, args, cwd: opts.cwd }
  child = new FakeChild()
  return child
}

const WIN = { isDestroyed: () => false } as unknown as BrowserWindow
const RESULT = '{"type":"result","subtype":"success","result":"Cut v0.32.1, gate green."}'

const { parseRecapResult, recapArgs, recapSession } = await import('./recap.ts')

function reset(resume: Record<string, string | undefined>): void {
  g.__events = []
  g.__resume = resume
}

test('the fork flag is there — without it the recap lands in the real transcript', () => {
  const args = recapArgs('abc-123')
  assert.ok(args.includes('--fork-session'))
  assert.deepEqual(args.slice(0, 3), ['-p', '--resume', 'abc-123'])
})

test('the recap run carries no MCP servers', () => {
  const args = recapArgs('abc-123')
  assert.ok(args.includes('--strict-mcp-config'))
  assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}')
})

test('the summary comes off the result line, past everything around it', () => {
  const stdout = [
    '{"type":"system","subtype":"init","session_id":"x"}',
    'not json at all',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"ignored"}]}}',
    RESULT,
    ''
  ].join('\n')
  assert.equal(parseRecapResult(stdout), 'Cut v0.32.1, gate green.')
})

test('a failed run is not a recap, whatever it put in result', () => {
  const stdout = '{"type":"result","subtype":"error_during_execution","result":"Execution error"}'
  assert.equal(parseRecapResult(stdout), '')
})

test('a run that said nothing yields nothing', () => {
  assert.equal(parseRecapResult(''), '')
  assert.equal(parseRecapResult('{"type":"system","subtype":"init"}'), '')
})

test('a recap is one event to the panel, and nothing on disk', async () => {
  reset({ sess: 'claude-1' })
  const pending = recapSession(WIN, 'sess', '/wt', 18 * 60_000)
  await settleSpawn()
  assert.equal(spawned.cmd, 'claude')
  assert.equal(spawned.cwd, '/wt')
  assert.deepEqual(child.ended, ['/recap\n'])
  child.finish(RESULT)

  const line = '(18m away) — Cut v0.32.1, gate green.'
  assert.equal(await pending, line)
  assert.deepEqual(g.__events, [
    { key: 'sess', event: { kind: 'tool', name: 'recap', summary: line } }
  ])
})

test('a session that never ran claude is never asked', async () => {
  reset({})
  assert.equal(await recapSession(WIN, 'sess', '/wt', AWAY_MS), null)
  assert.deepEqual(g.__events, [])
})

test('a CLI that fails writes nothing at all', async () => {
  reset({ sess: 'claude-1' })
  const pending = recapSession(WIN, 'sess', '/wt', AWAY_MS)
  await settleSpawn()
  child.emit('error', new Error('ENOENT'))
  assert.equal(await pending, null)
  assert.deepEqual(g.__events, [])
})

test('a CLI with nothing to say leaves the transcript alone', async () => {
  reset({ sess: 'claude-1' })
  const pending = recapSession(WIN, 'sess', '/wt', AWAY_MS)
  await settleSpawn()
  child.finish('{"type":"result","subtype":"success","result":"   "}')
  assert.equal(await pending, null)
  assert.deepEqual(g.__events, [])
})

/** Let recapSession reach its spawn before the fake child is driven. */
function settleSpawn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
