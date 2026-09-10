// Serving a video to the chat.
//
// A screenshot rides in the transcript as base64 because it is a few hundred
// kilobytes; a screen recording is tens of megabytes, and a data URL of one
// would be copied through IPC, held in a string, and re-parsed on every render.
// So a video is never carried — it is SERVED, from the file the agent wrote, on
// its own scheme (`floe-media://`), which is what also gives the player byte
// ranges and therefore a seek bar that works before the file has downloaded.
//
// Electron-free on purpose: `protocol.handle` in index.ts is three lines of
// wiring around `mediaResponse`, and everything with a decision in it is here,
// testable with plain node.

import { createReadStream, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, resolve, basename } from 'node:path'
import { Readable } from 'node:stream'
import type { MediaChunk, MediaFile } from '../shared/types'

export const SCHEME = 'floe-media'

/** Extension → what the player is being handed. Chromium plays `.mov` when it
    is h264/aac, which is what every screen recorder writes. */
const MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm'
}

/**
 * Turn what a message said into an absolute path, or null when the text names
 * nothing this machine can open.
 *
 * `~` is expanded here rather than by a shell: the string came out of a model's
 * answer and is never run.
 */
export function resolveMediaPath(candidate: string, cwd?: string): string | null {
  if (!candidate || /[\x00-\x1f\x7f]/.test(candidate)) return null
  const path = candidate.startsWith('~/') ? resolve(homedir(), candidate.slice(2)) : candidate
  if (isAbsolute(path)) return path
  // A relative path only means something against the tree the session works in.
  return cwd ? resolve(cwd, path) : null
}

const extOf = (path: string): string => (path.split('.').pop() ?? '').toLowerCase()

/**
 * What the renderer needs to draw a player, or null: the file is not there, is
 * not a video, or is a directory with a video's name.
 *
 * No permission check beyond "it is a video that exists". The paths come from
 * the agent's own answer, and that agent already reads and writes this
 * filesystem directly — a whitelist here would block `~/Desktop/demo.mov` while
 * protecting nothing.
 */
export function probeMedia(candidate: string, cwd?: string): MediaFile | null {
  const path = resolveMediaPath(candidate, cwd)
  if (!path) return null
  const mediaType = MIME[extOf(path)]
  if (!mediaType) return null
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size === 0) return null
    return { url: mediaUrl(path), mediaType, size: stat.size, name: basename(path), path }
  } catch {
    return null
  }
}

/**
 * The path as a URL of our scheme. Encoded segment by segment so a space, a `#`
 * or a `?` in a file name survives the round trip — the pathname is the path.
 */
export function mediaUrl(path: string): string {
  return `${SCHEME}://file` + path.split('/').map(encodeURIComponent).join('/')
}

/** The path back out of a `floe-media://` URL, or null if it is not one. */
export function pathFromMediaUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== `${SCHEME}:`) return null
    return parsed.pathname.split('/').map(decodeURIComponent).join('/')
  } catch {
    return null
  }
}

/**
 * The byte range the player asked for, clamped to the file, or null for "all of
 * it". Only the single-range form matters: it is the only one <video> sends.
 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  const m = header && /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, from, to] = m
  // `bytes=-500` means the LAST 500 bytes, which is how a player reads an MP4's
  // trailing index (a moov atom at the end) before it can play anything.
  if (!from) {
    const len = Number(to)
    if (!len) return null
    return { start: Math.max(0, size - len), end: size - 1 }
  }
  const start = Number(from)
  if (start >= size) return null
  return { start, end: to ? Math.min(Number(to), size - 1) : size - 1 }
}

/**
 * Answer one request for a media URL.
 *
 * Always advertises `Accept-Ranges`, and answers a range with a 206 — without
 * it Chromium has to buffer the whole recording before the scrubber will move.
 */
export function mediaResponse(url: string, range: string | null): Response {
  const path = pathFromMediaUrl(url)
  if (!path) return new Response('bad media url', { status: 400 })

  const mediaType = MIME[extOf(path)]
  if (!mediaType) return new Response('not a video', { status: 415 })

  let size = 0
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return new Response('not found', { status: 404 })
    size = stat.size
  } catch {
    return new Response('not found', { status: 404 })
  }

  const want = parseRange(range, size)
  if (range && !want)
    return new Response('range not satisfiable', {
      status: 416,
      headers: { 'Content-Range': `bytes */${size}` }
    })

  const { start, end } = want ?? { start: 0, end: size - 1 }
  const body = Readable.toWeb(
    createReadStream(path, { start, end })
  ) as unknown as ReadableStream<Uint8Array>

  return new Response(body, {
    status: want ? 206 : 200,
    headers: {
      'Content-Type': mediaType,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      ...(want ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {})
    }
  })
}

/**
 * How much of a file one `media:read` answers.
 *
 * A gate frame is a whole message in memory on both ends, and base64 makes it a
 * third bigger again — so a recording crosses in slices, and a 200 MB one never
 * becomes a 270 MB string.
 */
export const CHUNK_LIMIT = 1024 * 1024

const clamp = (n: unknown, max: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(Math.max(0, Math.trunc(n)), max) : 0

/**
 * A slice of a video, as base64 — the only path by which a recording's bytes
 * ever leave this process on the wire.
 *
 * It exists for one case: a browser tab can only fetch from the daemon that
 * served it, so a video that lives on ANOTHER paired machine cannot be reached
 * over HTTP at all. The serving daemon pulls it over the gate with this and
 * re-serves it (server plugin, `/media/<backend>/…`). Locally nothing calls it:
 * `floe-media://` and `/media/local/…` both read the file directly.
 *
 * Same policy as `probeMedia` — it answers for a video that is really there,
 * and null for anything else, so a caller cannot read `/etc/passwd` by naming
 * it here.
 */
export async function readMediaChunk(
  candidate: string,
  start: number,
  length: number
): Promise<MediaChunk | null> {
  const media = probeMedia(candidate)
  if (!media) return null

  const from = clamp(start, media.size)
  const want = Math.min(clamp(length, CHUNK_LIMIT), media.size - from)
  const buf = Buffer.alloc(want)

  const file = await open(media.path, 'r')
  try {
    const { bytesRead } = await file.read(buf, 0, want, from)
    return {
      mediaType: media.mediaType,
      size: media.size,
      start: from,
      end: from + bytesRead - 1,
      base64: buf.subarray(0, bytesRead).toString('base64')
    }
  } finally {
    await file.close()
  }
}
