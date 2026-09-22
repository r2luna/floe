// The address of a file on disk, as Floe's own scheme sees it.
//
// Split out of main/media.ts because the renderer needs it too: the file reader
// points an <iframe> at `floe-media://…` to draw an HTML page, and building that
// URL is the same two lines on both sides. What the scheme ANSWERS with is still
// main's business (media.ts) — this is only how a path is spelled.

export const SCHEME = 'floe-media'

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
