// Serving a picture or a recording that lives on ANOTHER paired machine.
//
// The desktop window attached to a remote backend gets that machine's
// `floe-media://file/…` addresses back from a probe or a transcript. Loaded as
// they are, the scheme reads the same path off THIS disk and answers 404 — the
// broken thumbnail under a message that named `/tmp/demo.png` on the server.
// So the preload re-addresses them (`floe-media://remote/<backend>/…`, see
// shared/mediaUrl.ts) and the scheme handler lands here: the bytes are pulled
// over that machine's gate in slices (`media:read` on its side) and streamed
// back as this response, ranges included. The web build does the same from the
// daemon (the server plugin's remoteMedia.ts) — this is the window's half.

import { WebSocket } from 'ws'
import { parseServerMsg, type HelloMsg, type InvokeMsg } from '../shared/remoteProtocol.ts'
import type { MediaChunk, MediaFile } from '../shared/types'
import { CHUNK_LIMIT, parseRange } from './media.ts'

/** How long one invoke waits before the machine is called gone. A response
    that hangs is a thumbnail that never resolves to "couldn't load". */
export const INVOKE_TIMEOUT_MS = 15_000

export interface GateClient {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  close(): void
}

/** Where a machine's gate is and the token it wants — a `BackendEntry`. */
export interface GateAddress {
  url: string
  token: string
}

/**
 * One short-lived connection to a paired machine's gate, opened per request
 * and closed with it. The window's own socket lives in the preload, out of
 * main's reach, and a tailnet handshake costs milliseconds against a file.
 */
export function connectGate(url: string, token: string, version: string): GateClient {
  const ws = new WebSocket(url)
  const pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>()
  let nextId = 1
  let dead: Error | null = null

  const ready = new Promise<void>((resolve, reject) => {
    const die = (err: Error): void => {
      dead ??= err
      reject(err)
      for (const p of pending.values()) p.fail(err)
      pending.clear()
    }
    ws.on('open', () => {
      const hello: HelloMsg = { kind: 'hello', token, version }
      ws.send(JSON.stringify(hello))
    })
    ws.on('message', (data) => {
      const msg = parseServerMsg(data.toString())
      if (msg?.kind === 'hello-ok') resolve()
      else if (msg?.kind === 'hello-err') die(new Error(`gate refused: ${msg.error}`))
      else if (msg?.kind === 'result') {
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.ok) p?.ok(msg.value)
        else p?.fail(new Error(msg.error ?? 'remote error'))
      }
    })
    ws.on('error', (err) => die(err instanceof Error ? err : new Error(String(err))))
    ws.on('close', () => die(new Error('gate closed')))
  })
  // Whoever awaits `invoke` answers this rejection; without the no-op it is
  // also an unhandled one.
  ready.catch(() => {})

  return {
    async invoke(channel, ...args) {
      await ready
      if (dead) throw dead
      const id = nextId++
      const msg: InvokeMsg = { kind: 'invoke', id, channel, args }
      return new Promise((ok, fail) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          fail(new Error(`${channel} timed out after ${INVOKE_TIMEOUT_MS}ms`))
        }, INVOKE_TIMEOUT_MS)
        const done = <T>(f: (v: T) => void) => (v: T) => {
          clearTimeout(timer)
          f(v)
        }
        pending.set(id, { ok: done(ok), fail: done(fail) })
        ws.send(JSON.stringify(msg))
      })
    },
    close() {
      ws.terminate()
    }
  }
}

/**
 * Answer one request for a file on another machine: probe it there, honour the
 * range the player asked for, and stream the slices as they arrive.
 *
 * `backend` is undefined when the machine was unpaired since the url was made
 * — a 404, not a hang.
 */
export async function remoteMediaResponse(
  backend: GateAddress | undefined,
  path: string,
  range: string | null,
  version: string,
  connect: typeof connectGate = connectGate
): Promise<Response> {
  if (!backend) return new Response('unknown machine', { status: 404 })
  const gate = connect(backend.url, backend.token, version)

  let media: MediaFile | null
  try {
    media = (await gate.invoke('media:file', path)) as MediaFile | null
  } catch {
    gate.close()
    return new Response('machine unreachable', { status: 502 })
  }
  if (!media) {
    gate.close()
    return new Response('not found', { status: 404 })
  }

  const want = parseRange(range, media.size)
  if (range && !want) {
    gate.close()
    return new Response('range not satisfiable', {
      status: 416,
      headers: { 'Content-Range': `bytes */${media.size}` }
    })
  }

  const { start, end } = want ?? { start: 0, end: media.size - 1 }
  let at = start
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = (await gate.invoke('media:read', path, at, Math.min(CHUNK_LIMIT, end - at + 1))) as MediaChunk | null
        const bytes = chunk ? Buffer.from(chunk.base64, 'base64') : Buffer.alloc(0)
        // A machine that answers nothing has nothing left to give: the short
        // body is the truth, and asking again would never end.
        if (bytes.length) controller.enqueue(new Uint8Array(bytes))
        at += bytes.length
        if (!bytes.length || at > end) {
          controller.close()
          gate.close()
        }
      } catch (err) {
        controller.error(err)
        gate.close()
      }
    },
    cancel() {
      gate.close()
    }
  })

  return new Response(body, {
    status: want ? 206 : 200,
    headers: {
      'Content-Type': media.mediaType,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      ...(want ? { 'Content-Range': `bytes ${start}-${end}/${media.size}` } : {})
    }
  })
}
