import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { homedir } from 'node:os'
import type { FloeApi } from './api.ts'

// The preload runs on import: it builds the router, fetches `backends:get`, and
// hands the api to contextBridge. So everything it needs is faked BEFORE the
// import — a scriptable `electron`, a package.json without an import attribute,
// and a WebSocket that never leaves the process.

const hookSource = `
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
export async function resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: 'stub:electron', shortCircuit: true, format: 'module' }
  if (specifier.endsWith('/package.json')) return { url: 'stub:pkg', shortCircuit: true, format: 'module' }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\\.[a-z]+$/i.test(specifier)) {
    try {
      const base = context.parentURL ? new URL(specifier, context.parentURL) : pathToFileURL(specifier)
      const tsPath = fileURLToPath(base) + '.ts'
      if (existsSync(tsPath)) return next(specifier + '.ts', context)
    } catch {}
  }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (url === 'stub:pkg') {
    return { format: 'module', shortCircuit: true, source: "export default { version: '9.9.9' }" }
  }
  if (url === 'stub:electron') {
    return { format: 'module', shortCircuit: true, source: \`
      const subs = new Map()
      export const state = { backends: [], fail: false, invokes: [], exposed: null }
      export const ipcRenderer = {
        invoke: async (channel, ...args) => {
          state.invokes.push([channel, args])
          if (channel !== 'backends:get') return { on: 'local', channel }
          if (state.fail) throw new Error('no handler for backends:get')
          return state.backends
        },
        on: (channel, listener) => {
          if (!subs.has(channel)) subs.set(channel, new Set())
          subs.get(channel).add(listener)
        },
        removeListener: (channel, listener) => { subs.get(channel)?.delete(listener) },
        emit: (channel, ...args) => { for (const l of subs.get(channel) ?? []) l({}, ...args) }
      }
      export const contextBridge = { exposeInMainWorld: (_key, value) => { state.exposed = value } }
      export default { ipcRenderer, contextBridge }
    \` }
  }
  return next(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

/** Every socket the preload opened, in order — never a real connection. */
const opened: FakeSocket[] = []

class FakeSocket {
  static readonly OPEN = 1
  readonly url: string
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  token = ''
  closed = false
  readonly invokes: Array<{ channel: string; args: unknown[] }> = []

  constructor(url: string) {
    this.url = url
    opened.push(this)
    // The handshake cannot answer before the caller has wired onmessage.
    queueMicrotask(() => this.onopen?.())
  }

  send(raw: string): void {
    const msg = JSON.parse(raw) as { kind: string; id: number; channel: string; args: unknown[]; token: string }
    if (msg.kind === 'hello') {
      this.token = msg.token
      this.deliver({ kind: 'hello-ok', version: '9.9.9' })
      return
    }
    this.invokes.push({ channel: msg.channel, args: msg.args })
    this.deliver({ kind: 'result', id: msg.id, ok: true, value: { on: this.url, channel: msg.channel } })
  }

  /** Push a frame the way a remote backend would. */
  deliver(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  close(): void {
    this.closed = true
    this.readyState = 3
    this.onclose?.()
  }
}

Object.assign(globalThis, { WebSocket: FakeSocket })
process.env.FLOE_WORKTREE = 'crap'

interface ElectronStub {
  state: {
    backends: Array<{ id: string; label: string; url: string; token: string }>
    fail: boolean
    invokes: Array<[string, unknown[]]>
    exposed: FloeApi | null
  }
  ipcRenderer: { emit: (channel: string, ...args: unknown[]) => void }
}

// A non-literal specifier: the stub above is what actually loads, and its shape
// is not electron's.
const electronSpecifier = 'electron'
const { state, ipcRenderer } = (await import(electronSpecifier)) as unknown as ElectronStub

const MAC = { id: 'mac', label: 'cypher', url: 'ws://cypher.ts.net:41680', token: 'k1' }
const NAS = { id: 'nas', label: 'nas', url: 'ws://nas.ts.net:41680', token: 'k9' }
state.backends = [MAC]

await import('./index.ts')

/** Let the handshake, the backends:get round-trip and any queued invoke settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
await settle()

const api = state.exposed!
const localLabel = homedir().split('/').pop()

/** Re-run the preload's sync the way main does when a machine is paired. */
async function repair(list: Array<{ id: string; label: string; url: string; token: string }>): Promise<void> {
  state.backends = list
  ipcRenderer.emit('backends:changed')
  await settle()
}

test('the api reaches the renderer with the machines main knew at load', () => {
  assert.equal(typeof api.projects.list, 'function')
  assert.equal(api.appVersion, '9.9.9')
  assert.equal(api.tag, 'crap')
  assert.deepEqual(api.backends.list(), [
    { id: 'local', label: localLabel, homeDir: homedir(), remote: false },
    { id: 'mac', label: 'cypher', homeDir: '', remote: true }
  ])
  // The preload opens the url main gave it verbatim — the https/wss rule is the
  // browser build's problem (src/web/backendUrl.ts), not this window's.
  assert.equal(opened.length, 1)
  assert.equal(opened[0].url, MAC.url)
  assert.equal(opened[0].token, 'k1')
  assert.equal(api.backends.state('mac'), 'open')
  assert.equal(api.backends.state('local'), 'open')
  assert.equal(api.backends.state('ghost'), 'closed')
})

test('a subscription made before a machine was paired still hears its events', async () => {
  const seen: unknown[] = []
  const off = api.agent.onEvent((payload) => void seen.push(payload))

  await repair([MAC, NAS])
  assert.equal(opened.length, 2, 'only the new machine got a socket')
  assert.equal(opened[0].closed, false, 'an unchanged machine keeps its socket')
  assert.equal(opened[1].url, NAS.url)

  opened[1].deliver({ kind: 'event', channel: 'agent:event', args: [{ sessionId: 's1' }] })
  assert.deepEqual(seen, [{ sessionId: 's1' }])

  // And stops when the renderer unsubscribes.
  off()
  opened[1].deliver({ kind: 'event', channel: 'agent:event', args: [{ sessionId: 's2' }] })
  assert.deepEqual(seen, [{ sessionId: 's1' }])
})

test('a machine re-paired at a new token gets a new socket, and the old one closes', async () => {
  await repair([{ ...MAC, token: 'k2' }, NAS])

  assert.equal(opened[0].closed, true)
  assert.equal(opened.length, 3)
  assert.equal(opened[2].url, MAC.url)
  assert.equal(opened[2].token, 'k2')
  // Replaced, not patched in place: the row is deleted and re-added, so it
  // moves to the end of the map the rail reads.
  assert.deepEqual(api.backends.list().map((b) => b.id), ['local', 'nas', 'mac'])
})

test('the pointer steers workspace calls; a pinned channel never leaves this window', async () => {
  assert.equal(api.backends.use('ghost'), false, 'an id no machine answers to is refused')
  assert.equal(api.backends.current(), 'local')
  assert.equal(api.backends.use('nas'), true)

  const before = state.invokes.length
  await api.getSystemPrompt()
  assert.deepEqual(opened[1].invokes.at(-1), { channel: 'settings:getSystemPrompt', args: [] })
  assert.equal(state.invokes.length, before, 'nothing went to the main process')

  await api.config.get()
  assert.deepEqual(state.invokes.at(-1), ['config:get', []])
  assert.equal(opened[1].invokes.at(-1)!.channel, 'settings:getSystemPrompt')
})

test('invokeOn runs on the machine it names, pins what is pinned, and refuses ghosts', async () => {
  await api.backends.invokeOn('mac', 'projects:probe', '/srv/repo')
  assert.deepEqual(opened[2].invokes.at(-1), { channel: 'projects:probe', args: ['/srv/repo'] })

  // Naming a machine asks where the WORK runs, not where this window's config is.
  const before = state.invokes.length
  await api.backends.invokeOn('mac', 'config:get')
  assert.deepEqual(state.invokes.at(-1), ['config:get', []])
  assert.equal(state.invokes.length, before + 1)

  await assert.rejects(api.backends.invokeOn('ghost', 'projects:probe', '/x'), /No such backend: ghost/)
})

test('a machine that goes away is closed, and the pointer comes home', async () => {
  assert.equal(api.backends.current(), 'nas')
  await repair([{ ...MAC, token: 'k2' }])

  assert.equal(opened[1].closed, true)
  assert.deepEqual(api.backends.list().map((b) => b.id), ['local', 'mac'])
  assert.equal(api.backends.current(), 'local', 'workspace calls cannot follow a machine that is gone')
})

test('a main process with no backends handler leaves the window local-only', async () => {
  state.fail = true
  ipcRenderer.emit('backends:changed')
  await settle()

  // The rejection is swallowed, and nothing was torn down on the way.
  assert.deepEqual(api.backends.list().map((b) => b.id), ['local', 'mac'])
  state.fail = false
})
