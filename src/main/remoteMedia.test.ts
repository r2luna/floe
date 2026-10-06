import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import { connectGate, remoteMediaResponse, type GateClient } from './remoteMedia.ts'

const FILE = Buffer.from('0123456789')

/** A paired machine's gate that holds one 10-byte picture at /tmp/demo.png. */
function fakeGate(token = 'k1'): Promise<{ url: string; close: () => void; reads: number[][] }> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  const reads: number[][] = []
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.kind === 'hello') {
        ws.send(JSON.stringify(msg.token === token ? { kind: 'hello-ok', version: '1' } : { kind: 'hello-err', error: 'bad token' }))
        return
      }
      const [path, start, length] = msg.args as [string, number, number]
      let value: unknown = null
      if (msg.channel === 'media:file' && path === '/tmp/demo.png')
        value = { url: 'floe-media://file/tmp/demo.png', mediaType: 'image/png', size: FILE.length, name: 'demo.png', path }
      if (msg.channel === 'media:read') {
        reads.push([start, length])
        const slice = FILE.subarray(start, start + Math.min(length, 4))
        value = { mediaType: 'image/png', size: FILE.length, start, end: start + slice.length - 1, base64: slice.toString('base64') }
      }
      if (msg.channel === 'boom') {
        ws.send(JSON.stringify({ kind: 'result', id: msg.id, ok: false, error: 'kaput' }))
        return
      }
      ws.send(JSON.stringify({ kind: 'result', id: msg.id, ok: true, value }))
    })
  })
  return new Promise((resolve) =>
    wss.on('listening', () =>
      resolve({ url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, close: () => wss.close(), reads })
    )
  )
}

test('a picture on another machine streams back whole, in slices', async () => {
  const gate = await fakeGate()
  const res = await remoteMediaResponse({ url: gate.url, token: 'k1' }, '/tmp/demo.png', null, '1')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('Content-Type'), 'image/png')
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), '0123456789')
  // The gate answers at most four bytes a time: the stream keeps asking.
  assert.deepEqual(gate.reads.map(([s]) => s), [0, 4, 8])
  gate.close()
})

test('a range comes back as a 206 with just those bytes', async () => {
  const gate = await fakeGate()
  const res = await remoteMediaResponse({ url: gate.url, token: 'k1' }, '/tmp/demo.png', 'bytes=2-4', '1')
  assert.equal(res.status, 206)
  assert.equal(res.headers.get('Content-Range'), 'bytes 2-4/10')
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), '234')
  const bad = await remoteMediaResponse({ url: gate.url, token: 'k1' }, '/tmp/demo.png', 'bytes=50-', '1')
  assert.equal(bad.status, 416)
  gate.close()
})

test('a missing file, a gone machine and a refused token each answer instead of hanging', async () => {
  const gate = await fakeGate()
  assert.equal((await remoteMediaResponse(undefined, '/tmp/demo.png', null, '1')).status, 404)
  assert.equal((await remoteMediaResponse({ url: gate.url, token: 'k1' }, '/tmp/nope.png', null, '1')).status, 404)
  assert.equal((await remoteMediaResponse({ url: gate.url, token: 'bad' }, '/tmp/demo.png', null, '1')).status, 502)
  assert.equal((await remoteMediaResponse({ url: 'ws://127.0.0.1:1', token: 'k1' }, '/x.png', null, '1')).status, 502)
  gate.close()
})

test('a remote error rejects the invoke with its message', async () => {
  const gate = await fakeGate()
  const client = connectGate(gate.url, 'k1', '1')
  await assert.rejects(client.invoke('boom'), /kaput/)
  client.close()
  gate.close()
})

test('a slice that fails mid-stream errors the body and closes the gate', async () => {
  let closed = false
  let calls = 0
  const flaky: GateClient = {
    invoke: async (channel) => {
      if (channel === 'media:file') return { url: '', mediaType: 'image/png', size: 10, name: 'a.png', path: '/a.png' }
      if (++calls > 1) throw new Error('gone')
      return { mediaType: 'image/png', size: 10, start: 0, end: 3, base64: Buffer.from('0123').toString('base64') }
    },
    close: () => {
      closed = true
    }
  }
  const res = await remoteMediaResponse({ url: 'x', token: 'y' }, '/a.png', null, '1', () => flaky)
  await assert.rejects(res.arrayBuffer())
  assert.equal(closed, true)
})

test('an empty slice ends the body short instead of asking forever', async () => {
  const empty: GateClient = {
    invoke: async (channel) =>
      channel === 'media:file' ? { url: '', mediaType: 'image/png', size: 10, name: 'a.png', path: '/a.png' } : null,
    close: () => {}
  }
  const res = await remoteMediaResponse({ url: 'x', token: 'y' }, '/a.png', null, '1', () => empty)
  assert.equal((await res.arrayBuffer()).byteLength, 0)
})
