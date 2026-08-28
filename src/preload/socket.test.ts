import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createSocketIpc } from './socket.ts'

// Minimal WebSocket stand-in: it connects, records sends, and — like a link
// wedged by a dropped VPN — never answers and never closes on its own.
class FakeSocket {
  static OPEN = 1
  static instances: FakeSocket[] = []
  readyState = FakeSocket.OPEN
  sent: string[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  closed = false
  constructor() {
    FakeSocket.instances.push(this)
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
  }
  reply(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
}

const settle = (): Promise<void> => new Promise((r) => process.nextTick(r))

// Regression: a hung connection (Tailscale dropped, no FIN) leaves the socket
// OPEN forever, so `onclose` never fires and every in-flight invoke sits in
// `pending` — the UI just does nothing, with no error. The heartbeat must notice
// the missing pongs, reject the pending invokes and report the disconnect.
test('a socket that stops ponging is dropped and fails its pending invokes', async () => {
  const g = globalThis as unknown as { WebSocket: unknown }
  const realWs = g.WebSocket
  g.WebSocket = FakeSocket
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const statuses: boolean[] = []
  try {
    const ipc = createSocketIpc('ws://test/ws', (s) => statuses.push(s.connected))
    const sock = FakeSocket.instances[0]
    sock.onopen?.()

    let failure: Error | null = null
    let resolved = false
    void ipc.invoke('worktrees:create', '/repo', 'branch', {}).then(
      () => (resolved = true),
      (e: Error) => (failure = e)
    )

    // Heartbeat #1: we ping, the server answers — the link is alive, so the
    // in-flight invoke must be left alone.
    mock.timers.tick(5000)
    assert.deepEqual(JSON.parse(sock.sent.at(-1) as string), { t: 'ping' })
    sock.reply({ t: 'pong' })
    mock.timers.tick(5000)
    await settle()
    assert.equal(failure, null)
    assert.equal(resolved, false)

    // Now the link wedges: pings go out, nothing comes back. Once past the
    // deadline the socket is dropped and the invoke rejects instead of hanging.
    mock.timers.tick(15000)
    await settle()
    assert.equal((failure as unknown as Error)?.name, 'RookeryTransport')
    assert.equal((failure as unknown as Error)?.message, 'disconnected')
    assert.equal(sock.closed, true)
    assert.equal(statuses.at(-1), false) // drives the "not connected" notice
  } finally {
    mock.timers.reset()
    g.WebSocket = realWs
  }
})
