import { safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../dataDir'
import { floeConfig, setFloeValue } from '../config/floe'

// Persistence for the Bitbucket Cloud connection. Auth is an Atlassian API token
// with scopes (app passwords are deprecated — brownouts from 2026-06-09, removed
// 2026-07-28). It's the same credential shape as Jira: HTTP Basic `email:token`,
// where `email` is the Atlassian account email and `token` is created at
// id.atlassian.com → Security → API tokens (grant the Bitbucket PR scopes).
//
// The token is the one secret here, so it's encrypted at rest with Electron's
// safeStorage (OS keychain — Keychain on macOS, libsecret on Linux, DPAPI on
// Windows) and only ever decrypted in the main process when a request is about
// to be made. It's never written in clear text and never crosses to the renderer.
//
// Credentials are global (connect once, use everywhere): the workspace/repo a PR
// belongs to comes from each repo's `bitbucket.org` remote, so — unlike Jira —
// there's no per-repo key to store. Mirrors `tasks/jiraConfig.ts`.
/** The account email from floe.toml, where the user can read and edit it. */
const configuredEmail = (): string | undefined => floeConfig().integrations.bitbucket.email

interface BitbucketStore {
  email?: string // Atlassian account email — the Basic-auth username
  tokenEnc?: string // base64 of safeStorage.encryptString(token)
}

const storeFile = (): string => join(dataDir(), 'bitbucket.json')

function read(): BitbucketStore {
  const file = storeFile()
  if (!existsSync(file)) return {}
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (!data || typeof data !== 'object') return {}
    return {
      email: typeof data.email === 'string' ? data.email : undefined,
      tokenEnc: typeof data.tokenEnc === 'string' ? data.tokenEnc : undefined
    }
  } catch {
    return {}
  }
}

function write(store: BitbucketStore): void {
  writeFileSync(storeFile(), JSON.stringify(store, null, 2))
}

// What the renderer is allowed to see: whether we're connected and the identity,
// but never the token itself.
export interface BitbucketConnection {
  connected: boolean
  email?: string
}

export function getBitbucketConnection(): BitbucketConnection {
  const s = read()
  const email = configuredEmail() ?? s.email
  return { connected: Boolean(email && s.tokenEnc), email }
}

// The full credentials, decrypted — main-process only, for making requests.
export interface BitbucketCreds {
  email: string
  token: string
}

// safeStorage.decryptString() hits the OS keychain. Cache the result per
// process instead of re-decrypting on every call (PR list refresh polls this
// on tab open, window refocus, and `r`) — otherwise a keychain whose "always
// allow" grant doesn't stick (e.g. unsigned dev builds) re-prompts constantly.
let credsCache: { tokenEnc: string; creds: BitbucketCreds } | null = null

export function getBitbucketCreds(): BitbucketCreds | null {
  const s = read()
  const email = configuredEmail() ?? s.email
  if (!email || !s.tokenEnc) return null
  if (credsCache?.tokenEnc === s.tokenEnc) return credsCache.creds
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    const token = safeStorage.decryptString(Buffer.from(s.tokenEnc, 'base64'))
    if (!token) return null
    const creds = { email, token }
    credsCache = { tokenEnc: s.tokenEnc, creds }
    return creds
  } catch {
    return null
  }
}

export function setBitbucketCreds(input: { email: string; token: string }): void {
  const email = (input.email ?? '').trim()
  const token = (input.token ?? '').trim()
  if (!email) throw new Error('Your Atlassian account email is required.')
  if (!token) throw new Error('An API token is required.')
  if (!safeStorage.isEncryptionAvailable())
    throw new Error('Secure storage is unavailable on this system — cannot save the token.')
  const tokenEnc = safeStorage.encryptString(token).toString('base64')
  write({ email, tokenEnc })
  // The non-secret half goes where the user can see and edit it; the token stays
  // in the keychain-encrypted store above.
  setFloeValue('integrations.bitbucket', 'email', email)
}

// Forget the connection.
export function clearBitbucketCreds(): void {
  write({})
  credsCache = null
}
