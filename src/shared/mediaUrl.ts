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

/** The path back out of a `floe-media://` URL, or null if it is not one —
    including a remote one, whose path names another machine's disk. */
export function pathFromMediaUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== `${SCHEME}:` || parsed.host !== 'file') return null
    return parsed.pathname.split('/').map(decodeURIComponent).join('/')
  } catch {
    return null
  }
}

// A file on ANOTHER paired machine. The desktop window asks a remote backend
// for a probe or a transcript and gets back that machine's `floe-media://file`
// address — which, loaded here, reads the same path off THIS disk. So the
// preload re-addresses the answer to the machine that gave it, and main pulls
// the bytes over that machine's gate (main/remoteMedia.ts). The web build does
// the same over HTTP (web/mediaRewrite.ts).
//
// The id is a path segment, not the host: a standard scheme lowercases its
// host, and an id is whatever the pairing named it.
const LOCAL_PREFIX = `${SCHEME}://file`
const REMOTE_PREFIX = `${SCHEME}://remote/`

/** A local address re-addressed to the machine it came from. Anything else
    passes through. */
export function remoteMediaUrl(url: string, backendId: string): string {
  if (!url.startsWith(LOCAL_PREFIX)) return url
  return REMOTE_PREFIX + encodeURIComponent(backendId) + url.slice(LOCAL_PREFIX.length)
}

/** A `file://` page on another machine as a remote address, so the browser
    panel loads it from there instead of this disk. Anything else passes
    through. The query is dropped: the scheme serves a path, not a request. */
export function remoteFileUrl(url: string, backendId: string): string {
  if (!url.startsWith('file:///')) return url
  try {
    const parsed = new URL(url)
    const path = parsed.pathname.split('/').map(decodeURIComponent).join('/')
    return remoteMediaUrl(mediaUrl(path), backendId) + parsed.hash
  } catch {
    return url
  }
}

/** The machine and path a remote address names, or null if it is not one. */
export function parseRemoteMediaUrl(url: string): { backendId: string; path: string } | null {
  if (!url.startsWith(REMOTE_PREFIX)) return null
  const rest = url.slice(REMOTE_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  try {
    return {
      backendId: decodeURIComponent(rest.slice(0, slash)),
      path: rest.slice(slash).split('/').map(decodeURIComponent).join('/')
    }
  } catch {
    return null
  }
}

/**
 * A probe answer (`media:probe`, `media:file`) with its url passed through
 * `to`. Null and malformed answers pass through untouched — this is a rewrite,
 * not a validator.
 */
export function mapProbeUrl(result: unknown, to: (url: string) => string): unknown {
  if (!result || typeof result !== 'object') return result
  const file = result as { url?: unknown }
  if (typeof file.url !== 'string') return result
  return { ...file, url: to(file.url) }
}

/** A transcript with every served image's `src` passed through `to`. Anything
    that is not a list, or a row without one, passes through untouched. */
export function mapTranscriptUrls(result: unknown, to: (url: string) => string): unknown {
  if (!Array.isArray(result)) return result
  return result.map((item: unknown) => {
    if (!item || typeof item !== 'object') return item
    const row = item as { src?: unknown }
    if (typeof row.src !== 'string') return item
    return { ...row, src: to(row.src) }
  })
}

/** The answers whose content is a host-specific media address, re-addressed
    with `to`; every other channel's answer is returned as is. */
export function mapMediaAnswer(channel: string, result: unknown, to: (url: string) => string): unknown {
  if (channel === 'media:probe' || channel === 'media:file') return mapProbeUrl(result, to)
  if (channel === 'claude:transcript' || channel === 'query:transcript') return mapTranscriptUrls(result, to)
  return result
}
