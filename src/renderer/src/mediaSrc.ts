// The one address in the UI that a browser cannot resolve.
//
// A recording is served, not carried (main/media.ts), and on the desktop it is
// served on a scheme Chromium was taught at boot — `floe-media://`. A tab was
// taught nothing, so there the same file comes off the daemon's HTTP route.
//
// The path is not re-encoded here: `/media` + the url's own pathname is exactly
// what `mediaUrl()` built, and webServer.ts hands that straight back to the
// same parser. One encoding rule, one place.

const SCHEME_PREFIX = 'floe-media://file'

/** True when this page was served to a browser rather than a BrowserWindow. */
export const isWeb = (): boolean => '__FLOE_BOOT__' in window

/** What to put in a `src=`: unchanged on the desktop, the HTTP route on the web. */
export function mediaSrc(url: string, web = isWeb()): string {
  if (!web || !url.startsWith(SCHEME_PREFIX)) return url
  return `/media${url.slice(SCHEME_PREFIX.length)}`
}
