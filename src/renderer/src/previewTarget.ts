/**
 * What a shell block could show in the browser panel, if anything.
 *
 * A block that opens a page (`open "$PWD/mocks/x.html"`), names a local HTML
 * file, or carries a URL can be previewed where it stands instead of leaving
 * the app. The first match wins: a URL over a file, since a command that has
 * both is usually serving the file at that URL.
 */
export type PreviewTarget = { kind: 'url'; value: string } | { kind: 'file'; value: string }

const URL_RE = /\bhttps?:\/\/[^\s"'`)<>]+/
const LOCAL_RE = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/[^\s"'`)<>]*)?/
const QUOTED_FILE_RE = /["'`]([^"'`]*\.html?)["'`]/i
const BARE_FILE_RE = /(?:^|\s)((?:\$\{?PWD\}?|~|\.{1,2}|\/)?[^\s"'`;&|)]*\.html?)(?=[\s;&|)]|$)/im

export function previewTarget(code: string): PreviewTarget | null {
  const url = URL_RE.exec(code)?.[0]
  if (url) return { kind: 'url', value: url }
  const local = LOCAL_RE.exec(code)?.[0]
  if (local) return { kind: 'url', value: `http://${local}` }
  const file = QUOTED_FILE_RE.exec(code)?.[1] ?? BARE_FILE_RE.exec(code)?.[1]
  if (file) return { kind: 'file', value: file }
  return null
}

/**
 * The file a target names, as one absolute path. `$PWD` and a relative path
 * mean the session's worktree — the block was written to be run there. A `~`
 * path is left as it is: it is absolute already, for a home this side cannot
 * spell.
 */
function absoluteOf(value: string, cwd: string): string {
  const base = cwd.replace(/\/+$/, '')
  const path = value.replace(/^\$\{?PWD\}?/, base)
  if (path.startsWith('~') || path.startsWith('/')) return path
  return `${base}/${path.replace(/^\.\//, '')}`
}

/**
 * The URL the browser panel loads for a target.
 */
export function previewUrl(target: PreviewTarget, cwd: string): string {
  if (target.kind === 'url') return target.value
  const path = absoluteOf(target.value, cwd)
  if (path.startsWith('~')) return `file://${path}`
  return `file://${encodeURI(path)}`
}

/**
 * The path INSIDE the worktree this target names, or null.
 *
 * A page that lives in the tree you are working in has a better home than the
 * browser panel: the file reader draws it (previewKind 'html'), in the panel
 * every other file of that worktree opens in, with the tree still beside it.
 * The browser stays for what is really elsewhere — a URL, a file under `~`.
 *
 * `..` disqualifies rather than resolves: a path that climbs out and back in is
 * not something this should be guessing about.
 */
export function inWorktree(target: PreviewTarget, cwd: string): string | null {
  if (target.kind !== 'file' || !cwd) return null
  const base = cwd.replace(/\/+$/, '')
  const path = absoluteOf(target.value, cwd)
  if (!path.startsWith(`${base}/`)) return null
  const rel = path.slice(base.length + 1)
  return rel && !rel.split('/').includes('..') ? rel : null
}
