// Making a `floe-media://` address playable in a tab.
//
// A recording is served, never carried through IPC (see src/main/media.ts). On
// the desktop it is served on a scheme Chromium was taught at boot; a tab was
// taught nothing, so the daemon serves the same bytes over HTTP at `/media/…`.
//
// The rewrite happens HERE, on the way out of `media:probe`, rather than in the
// component that reads the url. That keeps the renderer free of any idea that a
// web build exists: `Video.tsx` renders `file.url` and is right on both hosts,
// because by the time it sees the url it is already the right one.
//
// The path is not re-encoded: `/media/<backend>` + the url's own pathname is
// byte-for-byte what `mediaUrl()` produced, and the daemon hands that straight
// back to the same parser. One encoding rule, one place.
//
// The backend id is in the url because a tab has exactly one origin and Floe
// has many machines: the probe was answered by whichever backend the rail
// points at, and the file only exists THERE. Without the id the daemon would
// look for someone else's recording on its own disk and answer 404.

const SCHEME_PREFIX = 'floe-media://file'

/**
 * The same address, as the page can fetch it: `/media/<backend>/<path>`.
 * Anything else passes through.
 */
export function toHttpMediaUrl(url: string, backendId: string): string {
  if (!url.startsWith(SCHEME_PREFIX)) return url
  return `/media/${encodeURIComponent(backendId)}${url.slice(SCHEME_PREFIX.length)}`
}

/**
 * `media:probe`'s answer with its url made fetchable.
 *
 * Null and malformed answers pass through untouched — this is a rewrite, not a
 * validator, and inventing a shape here would hide a real bug from the caller.
 */
export function rewriteProbe(result: unknown, backendId: string): unknown {
  if (!result || typeof result !== 'object') return result
  const file = result as { url?: unknown }
  if (typeof file.url !== 'string') return result
  return { ...file, url: toHttpMediaUrl(file.url, backendId) }
}

/**
 * `claude:transcript`'s answer with every served image made fetchable — the
 * same rewrite as the probe's, applied to each `image` row's `src`. Anything
 * that is not a list, or a row without one, passes through untouched.
 */
export function rewriteTranscript(result: unknown, backendId: string): unknown {
  if (!Array.isArray(result)) return result
  return result.map((item: unknown) => {
    if (!item || typeof item !== 'object') return item
    const row = item as { src?: unknown }
    if (typeof row.src !== 'string') return item
    return { ...row, src: toHttpMediaUrl(row.src, backendId) }
  })
}
