import { safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../dataDir'
import { floeConfig, setFloeValue } from '../config/floe'
import { projectScan, updateProject } from '../config/projectStore'

// Persistence for the Jira connection. The API token is the one secret here, so
// it's encrypted at rest with Electron's safeStorage (backed by the OS keychain
// — Keychain on macOS, libsecret on Linux, DPAPI on Windows) and only ever
// decrypted in the main process when a request is about to be made. The token is
// never written in clear text and never crosses to the renderer.
//
// Credentials are global (connect once, use everywhere); only the project key is
// per-repo, kept in `projectByRoot` so each worktree/repo maps to its Jira board.
//
// The split across two files is on purpose: `site` and `email` are not secret,
// so they live in `floe.toml` where the user can read and edit them (and keep
// them in a dotfiles repo), while the token never leaves this keychain-encrypted
// store. The copies here are the fallback for a connection made before the TOML
// existed.
interface JiraStore {
  site?: string // base URL, e.g. "https://yourco.atlassian.net" (no trailing slash)
  email?: string // Atlassian account email — the Basic-auth username
  tokenEnc?: string // base64 of safeStorage.encryptString(token)
  projectByRoot: Record<string, string> // repo root → Jira project key (e.g. "PROJ")
}

/** The connection's non-secret half: floe.toml first, the legacy store second. */
function identity(store: JiraStore): { site?: string; email?: string } {
  const configured = floeConfig().integrations.jira
  return { site: configured.site ?? store.site, email: configured.email ?? store.email }
}

const storeFile = (): string => join(dataDir(), 'jira.json')

function read(): JiraStore {
  const file = storeFile()
  if (!existsSync(file)) return { projectByRoot: {} }
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (!data || typeof data !== 'object') return { projectByRoot: {} }
    return {
      site: typeof data.site === 'string' ? data.site : undefined,
      email: typeof data.email === 'string' ? data.email : undefined,
      tokenEnc: typeof data.tokenEnc === 'string' ? data.tokenEnc : undefined,
      projectByRoot:
        data.projectByRoot && typeof data.projectByRoot === 'object' ? data.projectByRoot : {}
    }
  } catch {
    return { projectByRoot: {} }
  }
}

function write(store: JiraStore): void {
  writeFileSync(storeFile(), JSON.stringify(store, null, 2))
}

// Normalize a site URL: ensure an https scheme, drop any trailing slash and path
// so we can safely append `/rest/api/3/...` later.
function normalizeSite(raw: string): string {
  let s = raw.trim()
  if (!s) return ''
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`
  try {
    const u = new URL(s)
    return `${u.protocol}//${u.host}`
  } catch {
    return s.replace(/\/+$/, '')
  }
}

// What the renderer is allowed to see: whether we're connected and the identity,
// but never the token itself.
export interface JiraConnection {
  connected: boolean
  site?: string
  email?: string
}

export function getJiraConnection(): JiraConnection {
  const s = read()
  const { site, email } = identity(s)
  const connected = Boolean(site && email && s.tokenEnc)
  return { connected, site, email }
}

// The full credentials, decrypted — main-process only, for making requests.
export interface JiraCreds {
  site: string
  email: string
  token: string
}

// safeStorage.decryptString() hits the OS keychain. Cache the result per
// process instead of re-decrypting on every call (PR/task refresh polls this
// on tab open, window refocus, and `r`) — otherwise a keychain whose "always
// allow" grant doesn't stick (e.g. unsigned dev builds) re-prompts constantly.
let credsCache: { tokenEnc: string; creds: JiraCreds } | null = null

export function getJiraCreds(): JiraCreds | null {
  const s = read()
  const { site, email } = identity(s)
  if (!site || !email || !s.tokenEnc) return null
  if (credsCache?.tokenEnc === s.tokenEnc) return credsCache.creds
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    const token = safeStorage.decryptString(Buffer.from(s.tokenEnc, 'base64'))
    if (!token) return null
    const creds = { site, email, token }
    credsCache = { tokenEnc: s.tokenEnc, creds }
    return creds
  } catch {
    return null
  }
}

export function setJiraCreds(input: { site: string; email: string; token: string }): void {
  const site = normalizeSite(input.site ?? '')
  const email = (input.email ?? '').trim()
  const token = (input.token ?? '').trim()
  if (!site) throw new Error('A Jira site URL is required (e.g. yourco.atlassian.net).')
  if (!email) throw new Error('Your Atlassian account email is required.')
  if (!token) throw new Error('An API token is required.')
  if (!safeStorage.isEncryptionAvailable())
    throw new Error('Secure storage is unavailable on this system — cannot save the token.')
  const tokenEnc = safeStorage.encryptString(token).toString('base64')
  const store = read()
  write({ ...store, site, email, tokenEnc })
  // The non-secret half goes where the user can see it. Written second so a
  // failure here leaves a working connection rather than a token with no site.
  setFloeValue('integrations.jira', 'site', site)
  setFloeValue('integrations.jira', 'email', email)
}

// Forget the connection (the per-repo project keys are kept — they're not secret
// and the user likely reconnects the same Jira).
export function clearJiraCreds(): void {
  const store = read()
  write({ projectByRoot: store.projectByRoot })
  credsCache = null
}

// Which Jira board a repo maps to. Per-project, so it lives in that project's
// own `config.toml` next to everything else about it — the legacy `projectByRoot`
// map is still read for repos configured before that move.
export function getProjectKey(root: string): string | undefined {
  if (!root) return undefined
  return projectScan().projects.find((p) => p.path === root)?.jiraProject ?? read().projectByRoot[root]
}

export function setProjectKey(root: string, key: string): void {
  if (!root) return
  const k = (key ?? '').trim().toUpperCase()
  // Only for a tracked project: a worktree or a repo the user has not added has
  // no config file to write into, so those keep using the legacy map.
  if (projectScan().byPath.has(root)) {
    if (k) updateProject(root, [{ op: 'set', table: 'integrations', key: 'jira-project', value: k }])
    else updateProject(root, [{ op: 'unset', table: 'integrations', key: 'jira-project' }])
    return
  }
  const store = read()
  if (!k) delete store.projectByRoot[root]
  else store.projectByRoot[root] = k
  write(store)
}
