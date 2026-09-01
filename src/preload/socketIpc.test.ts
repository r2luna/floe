import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws'
import { parseClientMsg } from '../shared/remoteProtocol.ts'
import { createSocketIpc } from './socketIpc.ts'

// A minimal serve side speaking remoteProtocol.ts, the way the server-mode
// plugin does: hello gate, an invoke that answers, one that fails, and an
// event pushed after the handshake. Node 22's global WebSocket is the same
// client the preload uses in the renderer process.

const TOKEN = 'secret'
let wss: WebSocketServer
let port = 0

before(async () => {
  wss = new WebSocketServer({ port: 0 })
  await once(wss, 'listening')
  port = (wss.address() as { port: number }).port
  wss.on('connection', (ws: ServerSocket) => {
    let authed = false
    ws.on('message', (data) => {
      const msg = parseClientMsg(data.toString())
      if (!msg) return
      if (msg.kind === 'hello') {
        if (msg.token !== TOKEN) {
          ws.send(JSON.stringify({ kind: 'hello-err', error: 'bad token' }))
          ws.close()
          return
        }
        authed = true
        ws.send(JSON.stringify({ kind: 'hello-ok', version: '9.9.9' }))
        ws.send(JSON.stringify({ kind: 'event', channel: 'tick', args: ['t1', 2] }))
        return
      }
      if (!authed || msg.kind !== 'invoke') return
      if (msg.channel === 'sum') {
        ws.send(JSON.stringify({ kind: 'result', id: msg.id, ok: true, value: (msg.args as number[]).reduce((a, b) => a + b, 0) }))
      } else {
        ws.send(JSON.stringify({ kind: 'result', id: msg.id, ok: false, error: `no handler for ${msg.channel}` }))
      }
    })
  })
})

after(() => wss.close())

test('invokes round-trip after the hello handshake, including ones sent before it', async () => {
  const ipc = createSocketIpc(`ws://127.0.0.1:${port}`, TOKEN, '0.1.0')
  // Fired immediately — the socket is still connecting, so this exercises the queue.
  const early = ipc.invoke('sum', 1, 2)
  assert.equal(await early, 3)
  assert.equal(await ipc.invoke('sum', 10, 20, 30), 60)
  assert.equal(ipc.state(), 'open')
  assert.equal(ipc.serverVersion(), '9.9.9')
  ipc.close()
})

test('events reach listeners with the Electron calling convention (event first)', async () => {
  const ipc = createSocketIpc(`ws://127.0.0.1:${port}`, TOKEN, '0.1.0')
  const got = await new Promise<unknown[]>((resolve) => {
    ipc.on('tick', (_event: unknown, ...args: unknown[]) => resolve(args))
  })
  assert.deepEqual(got, ['t1', 2])
  ipc.close()
})

test('a failed remote handler rejects that invoke only', async () => {
  const ipc = createSocketIpc(`ws://127.0.0.1:${port}`, TOKEN, '0.1.0')
  await assert.rejects(ipc.invoke('nope'), /no handler for nope/)
  assert.equal(await ipc.invoke('sum', 5), 5)
  ipc.close()
})

test('a bad token rejects pending invokes and stays closed — no retry hammering', async () => {
  const ipc = createSocketIpc(`ws://127.0.0.1:${port}`, 'wrong', '0.1.0')
  await assert.rejects(ipc.invoke('sum', 1), /bad token|disconnected|closed/)
  await assert.rejects(ipc.invoke('sum', 1), /closed/)
  assert.equal(ipc.state(), 'closed')
})
