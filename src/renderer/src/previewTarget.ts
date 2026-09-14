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
 * The URL the browser panel loads for a target. `$PWD` and a relative path
 * mean the session's worktree — the block was written to be run there.
 */
export function previewUrl(target: PreviewTarget, cwd: string): string {
  if (target.kind === 'url') return target.value
  let path = target.value.replace(/^\$\{?PWD\}?/, cwd)
  if (path.startsWith('~')) return `file://${path}`
  if (!path.startsWith('/')) path = `${cwd.replace(/\/$/, '')}/${path.replace(/^\.\//, '')}`
  return `file://${encodeURI(path)}`
}
