// Bringing a file to the machine you are sitting at.
//
// `o` opens a file in whatever app the OS thinks it is for — by handing over a
// PATH, which only means something on the machine that holds it. Attached to
// another machine (or in a tab, where the backend is never this computer) that
// opens the document on a desk nobody is at. So the window reads the file
// across in slices and opens the copy: `files:readChunk` on the machine that
// has it, `files:openDownload` on this one.
//
// Base64 all the way through, never decoded here: the renderer is only a pipe
// between two channels, and turning 200 MB into bytes and back again in the
// tab's heap would be work nobody asked for. That is what SLICE is about.

import type { FileChunk } from '../../shared/types'

/**
 * How much is asked for at a time — a byte under 1 MiB, and a multiple of 3.
 *
 * Three bytes are four base64 characters, so a slice whose length divides by 3
 * encodes with no padding and the pieces can simply be joined. A round 1 MiB
 * does not divide by 3: every slice would end in `=` and the join would be
 * gibberish the moment it was decoded.
 */
export const SLICE = 3 * 349_525

/** The most this will assemble. Past it, you want a real file transfer, not a
    string held whole in the renderer. */
export const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024

export const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/**
 * The whole file, as base64, from whichever machine `read` talks to.
 *
 * Rejects rather than returning something half-read: a truncated copy that
 * opens is worse than an error, because the app that opens it will blame the
 * file.
 */
export async function pullFile(
  read: (start: number, length: number) => Promise<FileChunk | null>
): Promise<{ name: string; base64: string }> {
  const parts: string[] = []
  let name = 'download'
  let at = 0

  for (;;) {
    const chunk = await read(at, SLICE)
    if (!chunk) throw new Error('the file is not there any more')
    if (chunk.size > MAX_DOWNLOAD_BYTES) {
      throw new Error(`too big to bring across (${mb(chunk.size)})`)
    }
    name = chunk.name
    const got = chunk.end - chunk.start + 1
    if (got <= 0) break
    parts.push(chunk.base64)
    at += got
    if (at >= chunk.size) break
    // Only the LAST slice may be short — an unaligned one in the middle would
    // pad, and the join would silently corrupt everything after it.
    if (got % 3 !== 0) throw new Error('the file was read short')
  }

  return { name, base64: parts.join('') }
}

/**
 * `o` when the file is elsewhere: pull it here and open the copy.
 *
 * Answers what to tell the user — the path on the desktop, and null in a tab,
 * where the browser took the download somewhere only it knows.
 */
export async function downloadAndOpen(
  worktreePath: string,
  relPath: string
): Promise<string | null> {
  const { name, base64 } = await pullFile((start, length) =>
    window.floe.files.readChunk(worktreePath, relPath, start, length)
  )
  return window.floe.files.openDownload(name, base64)
}
