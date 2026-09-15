// What "Add project" reads out of its one field: `[host@]path`. No host means
// this machine. The host is whatever `ssh` would take, so the list of machines
// is not something the dialog has to know in advance.

export interface HostPath {
  /** Null for a path on this machine. */
  host: string | null
  path: string
}

/**
 * Split `gtt@~/code/app` into host and path.
 *
 * The host is only what comes before the first `@` when that prefix could not
 * itself be a path — no `/`, no leading `~` or `.` — so `~/a@b` and
 * `/srv/x@2` stay local paths.
 */
export function parseHostPath(input: string): HostPath {
  const typed = input.trim()
  const at = typed.indexOf('@')
  if (at <= 0) return { host: null, path: typed }
  const host = typed.slice(0, at)
  if (/[/\s]/.test(host) || host.startsWith('~') || host.startsWith('.')) return { host: null, path: typed }
  return { host, path: typed.slice(at + 1).trim() }
}
