import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { SocketIpc } from '../preload/socketIpc.ts'

// Hermetic browser: the tab's globals and a WebSocket that never leaves the
// process. `createSocketIpc` is the real one — the transport is what the bridge
// is made of, so faking it would test nothing.

type Listener = (...a: unknown[]) => void
type Frame = Record<string, unknown>

/** Answers the fake daemon gives, per channel. Reset before every test. */
const answers = new Map<string, (args: unknown[]) => unknown>()
/** Every socket the bridge opened, in order. */
let opened: FakeSocket[] = []
/** The `change` handlers `matchMedia(...).addEventListener` collected. */
let mediaHandlers: Array<(e: { matches: boolean }) => void> = []
let prefersDark = false

class FakeSocket {
  static readonly OPEN = 1
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  token = ''
  closed = false
  /** Invoke frames that actually reached this socket. */
  readonly invokes: Array<{ channel: string; args: unknown[] }> = []

  readonly url: string

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
      this.deliver({ kind: 'hello-ok', version: 'test' })
      return
    }
    this.invokes.push({ channel: msg.channel, args: msg.args })
    const answer = answers.get(msg.channel)
    if (!answer) {
      this.deliver({ kind: 'result', id: msg.id, ok: false, error: `no handler for ${msg.channel}` })
      return
    }
    this.deliver({ kind: 'result', id: msg.id, ok: true, value: answer(msg.args) })
  }

  /** Push a frame the way the daemon would. */
  deliver(frame: Frame): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  close(): void {
    this.closed = true
    this.readyState = 3
    this.onclose?.()
  }
}

const openedCalls: string[] = []
Object.defineProperty(globalThis, 'navigator', {
  value: { platform: 'MacIntel', userAgent: 'floe-test/1' },
  configurable: true,
  writable: true
})
/** What `files:openDownload` did in the tab: the anchor it clicked. */
let downloaded: Array<{ name: string; bytes: number }> = []
let lastBlobSize = 0

// The real URL class stays: bridge.ts parses backend addresses with it. Only
// the two blob methods a tab would have are added.
Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} })

Object.assign(globalThis, {
  WebSocket: FakeSocket,
  Blob: class {
    constructor(parts: Uint8Array[]) {
      lastBlobSize = parts.reduce((n, p) => n + p.length, 0)
    }
  },
  atob: (b64: string) => Buffer.from(b64, 'base64').toString('binary'),
  document: {
    createElement: () => ({
      href: '',
      download: '',
      click(this: { download: string }) {
        downloaded.push({ name: this.download, bytes: lastBlobSize })
      }
    })
  },
  location: { protocol: 'https:', host: 'floe.pinguim.io' },
  matchMedia: () => ({
    matches: prefersDark,
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => mediaHandlers.push(fn)
  }),
  window: {
    focus: () => {},
    open: (url: string, target: string, features: string) =>
      openedCalls.push(`${url} ${target} ${features}`)
  }
})

const { browserHandlers, createWebBridge, newBackendTable, reconcileBackends, webHost, webIpc } =
  await import('./bridge.ts')
type Boot = Parameters<typeof createWebBridge>[0]

const boot: Boot = {
  token: 'tok',
  homeDir: '/home/r2luna',
  platform: 'linux',
  version: '0.15.0',
  wsUrl: 'wss://floe.pinguim.io/ws',
  label: 'link'
}

beforeEach(() => {
  answers.clear()
  opened = []
  mediaHandlers = []
  downloaded = []
  lastBlobSize = 0
  openedCalls.length = 0
  prefersDark = false
})

/** A SocketIpc that records instead of connecting — for the table-level tests. */
function stubIpc(): SocketIpc & { closed: boolean; subscribed: string[] } {
  const s = {
    closed: false,
    subscribed: [] as string[],
    invoke: async (channel: string, ...args: unknown[]) => ({ channel, args }),
    on: (channel: string) => void s.subscribed.push(channel),
    removeListener: () => {},
    close: () => void (s.closed = true),
    state: () => 'open' as const,
    onState: () => {},
    serverVersion: () => 'test'
  }
  return s
}

/** Let the hello handshake and any queued invoke settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

// ── the transport ───────────────────────────────────────────────────────────

test('a pinned window channel is answered by the tab, never sent to the daemon', async () => {
  const { ipc, socket } = createWebBridge(boot)
  await settle()

  assert.equal(await ipc.invoke('window:focus'), true)
  prefersDark = true
  assert.equal(await ipc.invoke('theme:get'), true)

  // Only the bridge's own `backends:get` reached the wire.
  assert.deepEqual(
    opened[0].invokes.map((i) => i.channel),
    ['backends:get']
  )
  socket.close()
})

test('an unpinned channel goes over the socket, args intact', async () => {
  answers.set('sessions:list', (args) => ({ echoed: args }))
  const { ipc, socket } = createWebBridge(boot)
  await settle()

  assert.deepEqual(await ipc.invoke('sessions:list', 'a', 2), { echoed: ['a', 2] })
  assert.deepEqual(opened[0].invokes.at(-1), { channel: 'sessions:list', args: ['a', 2] })
  socket.close()
})

test('media:probe comes back with a url the tab can fetch', async () => {
  answers.set('media:probe', () => ({ kind: 'video', url: 'floe-media://file/srv/rec/a.mp4' }))
  const { ipc, socket } = createWebBridge(boot)
  await settle()

  assert.deepEqual(await ipc.invoke('media:probe', '/srv/rec/a.mp4'), {
    kind: 'video',
    url: '/media/local/srv/rec/a.mp4'
  })
  socket.close()
})

test('a tab is never the machine the files are on', async () => {
  const { host, socket } = createWebBridge(boot)
  await settle()
  // Not even for the daemon it is talking to: `o` has to put the file on the
  // computer the browser runs on, which is never the one answering.
  assert.equal(host.onThisMachine!(), false)
  socket.close()
})

test('opening a downloaded file in a tab is the browser saving it', async () => {
  const { ipc, socket } = createWebBridge(boot)
  await settle()

  const saved = await ipc.invoke('files:openDownload', 'demo.mp4', Buffer.from('0123456789').toString('base64'))
  // Null: where it landed is the browser's business. The daemon never sees it.
  assert.equal(saved, null)
  assert.deepEqual(downloaded, [{ name: 'demo.mp4', bytes: 10 }])
  assert.equal(opened[0].invokes.some((i) => i.channel === 'files:openDownload'), false)
  socket.close()
})

test('a video on another machine is fetched under that machine, not this one', async () => {
  answers.set('backends:get', () => [
    { id: 'mac', label: 'cypher', url: 'ws://cypher.leopon-sole.ts.net:443', token: 'k1' }
  ])
  answers.set('media:probe', () => ({ kind: 'video', url: 'floe-media://file/tmp/a.mp4' }))
  const { ipc, host, socket } = createWebBridge(boot)
  await settle()

  host.backendsCtl!.use('mac')
  const found = (await ipc.invoke('media:probe', '/tmp/a.mp4')) as { url: string }
  // The mac answered, so the daemon has to go and get it from the mac — the
  // same path on the daemon's own disk is a different file, or none.
  assert.equal(found.url, '/media/mac/tmp/a.mp4')
  socket.close()
})

test('with no wsUrl in the boot payload the socket follows the page', async () => {
  const { socket } = createWebBridge({ ...boot, wsUrl: '' })
  await settle()
  assert.equal(opened[0].url, 'wss://floe.pinguim.io/ws')
  assert.equal(opened[0].token, 'tok')
  socket.close()
})

test('a theme change the tab observes reaches the renderer subscription', async () => {
  const { ipc, socket } = createWebBridge(boot)
  await settle()

  const seen: unknown[][] = []
  ipc.on('theme:changed', (...a: unknown[]) => void seen.push(a))
  assert.equal(mediaHandlers.length, 1)
  mediaHandlers[0]({ matches: true })

  // Electron's calling convention: the event object first, then the payload.
  assert.deepEqual(seen, [[{}, true]])
  socket.close()
})

test('removeListener detaches from the tab, the daemon and every remote', async () => {
  const table = newBackendTable()
  const remote = stubIpc()
  const detached: string[] = []
  table.remotes.set('mac', {
    info: { id: 'mac', label: 'mac', homeDir: '', remote: true },
    ipc: { ...remote, removeListener: (c: string) => void detached.push(`remote:${c}`) }
  })
  const socket = stubIpc()
  const local = new Map<string, Set<Listener>>()
  const ipc = webIpc(
    { ...socket, removeListener: (c: string) => void detached.push(`socket:${c}`) },
    table,
    {},
    local
  )

  const listener: Listener = () => {}
  ipc.on('session:output', listener)
  assert.equal(table.subscriptions.length, 1)
  assert.equal(local.get('session:output')?.size, 1)

  ipc.removeListener('session:output', listener)
  assert.deepEqual(table.subscriptions, [])
  assert.equal(local.get('session:output')?.size, 0)
  assert.deepEqual(detached, ['socket:session:output', 'remote:session:output'])
})

test('the pointer steers unpinned calls, and pinned ones stay on the page', async () => {
  const table = newBackendTable()
  const socket = stubIpc()
  const remote = stubIpc()
  const routed: string[] = []
  table.remotes.set('mac', {
    info: { id: 'mac', label: 'mac', homeDir: '', remote: true },
    ipc: { ...remote, invoke: async (c: string) => void routed.push(c) }
  })
  const seen: string[] = []
  const ipc = webIpc({ ...socket, invoke: async (c: string) => void seen.push(c) }, table, {}, new Map())

  await ipc.invoke('sessions:list')
  table.current = 'mac'
  await ipc.invoke('sessions:list')
  await ipc.invoke('config:get')
  // An id that named a machine which has since gone falls back to the daemon.
  table.current = 'ghost'
  await ipc.invoke('sessions:list')

  assert.deepEqual(routed, ['sessions:list'])
  assert.deepEqual(seen, ['sessions:list', 'config:get', 'sessions:list'])
})

// ── browser handlers ────────────────────────────────────────────────────────

test('open:external opens a tab that cannot reach back at the token', async () => {
  await browserHandlers(() => {})['open:external']('https://example.com')
  assert.deepEqual(openedCalls, ['https://example.com _blank noopener,noreferrer'])
})

test('notify:show is a no-op where the browser has no Notification API', async () => {
  const emitted: unknown[][] = []
  const handlers = browserHandlers((...a: unknown[]) => void emitted.push(a))
  assert.equal(await handlers['notify:show']({ title: 't', body: 'b', sessionId: 's' }), undefined)
  assert.deepEqual(emitted, [])
})

// ── the backend table ───────────────────────────────────────────────────────

test('reconcile opens one socket per machine, upgrading the scheme to the page', () => {
  const table = newBackendTable()
  const made: Array<[string, string]> = []
  const open = (url: string, token: string): SocketIpc => {
    made.push([url, token])
    return stubIpc()
  }

  reconcileBackends(
    table,
    [
      { id: 'mac', label: 'cypher', url: 'ws://cypher.leopon-sole.ts.net:443', token: 'k1' },
      // No cert exists for a bare IP, so this machine is dropped, not downgraded.
      { id: 'nas', label: 'nas', url: 'ws://100.72.82.64:41680', token: 'k2' }
    ],
    open,
    'https:'
  )

  assert.deepEqual(made, [['wss://cypher.leopon-sole.ts.net/', 'k1']])
  assert.deepEqual([...table.remotes.keys()], ['mac'])
  assert.deepEqual(table.remotes.get('mac')!.info, {
    id: 'mac',
    label: 'cypher',
    homeDir: '',
    remote: true
  })
})

test('an unchanged machine keeps its socket; a re-paired one gets a new one', () => {
  const table = newBackendTable()
  const sockets: Array<SocketIpc & { closed: boolean }> = []
  const open = (): SocketIpc => {
    const s = stubIpc()
    sockets.push(s)
    return s
  }
  const row = { id: 'mac', label: 'cypher', url: 'wss://cypher.ts.net', token: 'k1' }

  reconcileBackends(table, [row], open, 'https:')
  reconcileBackends(table, [row], open, 'https:')
  assert.equal(sockets.length, 1, 'same address and token — no reconnect')
  assert.equal(sockets[0].closed, false)

  reconcileBackends(table, [{ ...row, token: 'k2' }], open, 'https:')
  assert.equal(sockets.length, 2, 'a new token replaces the socket')
  assert.equal(sockets[0].closed, true)
  assert.equal(table.remotes.get('mac')!.ipc, sockets[1])
})

test('a machine that disappears is closed, and the pointer comes home', () => {
  const table = newBackendTable()
  const sockets: Array<SocketIpc & { closed: boolean }> = []
  const open = (): SocketIpc => {
    const s = stubIpc()
    sockets.push(s)
    return s
  }

  reconcileBackends(table, [{ id: 'mac', label: 'cypher', url: 'wss://c.ts.net', token: 'k' }], open, 'https:')
  table.current = 'mac'
  reconcileBackends(table, [], open, 'https:')

  assert.equal(sockets[0].closed, true)
  assert.equal(table.remotes.size, 0)
  assert.equal(table.urls.size, 0)
  assert.equal(table.current, 'local', 'workspace calls cannot follow a machine that is gone')
})

test('a subscription made before a machine was paired replays onto its socket', () => {
  const table = newBackendTable()
  table.subscriptions.push({ channel: 'session:output', listener: () => {} })
  const made: Array<SocketIpc & { subscribed: string[] }> = []
  const open = (): SocketIpc => {
    const s = stubIpc()
    made.push(s)
    return s
  }

  reconcileBackends(table, [{ id: 'mac', label: 'c', url: 'wss://c.ts.net', token: 'k' }], open, 'https:')
  assert.deepEqual(made[0].subscribed, ['session:output'])
})

// ── the host ────────────────────────────────────────────────────────────────

test('the rail sees the serving daemon first, then every paired machine', () => {
  const table = newBackendTable()
  const socket = stubIpc()
  table.remotes.set('mac', {
    info: { id: 'mac', label: 'cypher', homeDir: '', remote: true },
    ipc: stubIpc()
  })
  const host = webHost(boot, table, socket)

  assert.equal(host.platform, 'MacIntel')
  assert.equal(host.version, 'floe-test/1')
  assert.equal(host.appVersion, '0.15.0')
  // A tab is not launched from a worktree.
  assert.equal(host.worktreeTag, null)
  assert.deepEqual(host.backendsCtl!.list(), [
    { id: 'local', label: 'link', homeDir: '/home/r2luna', remote: false },
    { id: 'mac', label: 'cypher', homeDir: '', remote: true }
  ])
})

test('use refuses an id no machine answers to', () => {
  const table = newBackendTable()
  const host = webHost(boot, table, stubIpc())
  table.remotes.set('mac', { info: { id: 'mac', label: 'c', homeDir: '', remote: true }, ipc: stubIpc() })

  assert.equal(host.backendsCtl!.use('ghost'), false)
  assert.equal(host.backendsCtl!.current(), 'local')
  assert.equal(host.backendsCtl!.use('mac'), true)
  assert.equal(host.backendsCtl!.current(), 'mac')
  assert.equal(host.backendsCtl!.use('local'), true)
  assert.equal(host.backendsCtl!.current(), 'local')
})

test('state reports the daemon socket for local and closed for an unknown id', () => {
  const table = newBackendTable()
  const host = webHost(boot, table, stubIpc())
  table.remotes.set('mac', { info: { id: 'mac', label: 'c', homeDir: '', remote: true }, ipc: stubIpc() })

  assert.equal(host.backendsCtl!.state('local'), 'open')
  assert.equal(host.backendsCtl!.state('mac'), 'open')
  assert.equal(host.backendsCtl!.state('ghost'), 'closed')
})

test('invokeOn runs on the machine it names, pins what is pinned, and refuses ghosts', async () => {
  const table = newBackendTable()
  const onDaemon: string[] = []
  const onMac: string[] = []
  table.remotes.set('mac', {
    info: { id: 'mac', label: 'c', homeDir: '', remote: true },
    ipc: { ...stubIpc(), invoke: async (c: string) => void onMac.push(c) }
  })
  const host = webHost(boot, table, { ...stubIpc(), invoke: async (c: string) => void onDaemon.push(c) })
  const ctl = host.backendsCtl!

  await ctl.invokeOn('local', 'projects:probe', '/x')
  await ctl.invokeOn('mac', 'projects:probe', '/x')
  // The page's own config, whatever machine is named.
  await ctl.invokeOn('mac', 'config:get')
  await assert.rejects(ctl.invokeOn('ghost', 'projects:probe', '/x'), /No such backend: ghost/)

  assert.deepEqual(onMac, ['projects:probe'])
  assert.deepEqual(onDaemon, ['projects:probe', 'config:get'])
})

// ── end to end ──────────────────────────────────────────────────────────────

test('the page learns its machines from the daemon, and re-syncs when they change', async () => {
  let list: unknown[] = [
    { id: 'mac', label: 'cypher', url: 'ws://cypher.leopon-sole.ts.net:443', token: 'k1' }
  ]
  answers.set('backends:get', () => list)

  const { host, socket } = createWebBridge(boot)
  await settle()

  assert.deepEqual(host.backendsCtl!.list().map((b) => b.id), ['local', 'mac'])
  // Mixed content is not a risk the page takes: the scheme followed the page.
  assert.equal(opened[1].url, 'wss://cypher.leopon-sole.ts.net/')
  assert.equal(opened[1].token, 'k1')

  host.backendsCtl!.use('mac')
  list = []
  opened[0].deliver({ kind: 'event', channel: 'backends:changed', args: [] })
  await settle()

  assert.equal(opened[1].closed, true)
  assert.deepEqual(host.backendsCtl!.list().map((b) => b.id), ['local'])
  assert.equal(host.backendsCtl!.current(), 'local')
  socket.close()
})

test('a daemon with no backends handler leaves the page local-only', async () => {
  const { host, socket } = createWebBridge(boot)
  await settle()
  assert.deepEqual(host.backendsCtl!.list().map((b) => b.id), ['local'])
  assert.equal(opened.length, 1)
  socket.close()
})
