// The API keys Settings collects for GitHub, Bitbucket and Jira.
//
// In dataDir(), not floe.toml: that file syncs and is meant to be read, and these
// are bound to one machine. Encrypted by the OS keychain where there is one; where
// there is not (a headless Linux daemon), the file is still 0600, the same footing
// as mcp.toml and gh's own hosts.yml.
//
// Nothing outside main reads a key back. Settings and the MCP tools see only
// integrationStatus(), which says whether one is saved.
import { safeStorage } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../config/io'
import { dataDir } from '../dataDir'
import { log } from '../log'
import type { SourceId } from '../../shared/worktreeSource'

export const CREDENTIAL_FIELDS = {
  github: ['token'],
  bitbucket: ['email', 'token'],
  jira: ['site', 'email', 'token']
} as const satisfies Record<SourceId, readonly string[]>

export type Credentials = Partial<Record<SourceId, Record<string, string>>>

/** What seals the file: the OS keychain, or null where there is none. */
export interface Cipher {
  encrypt: (text: string) => Buffer
  decrypt: (data: Buffer) => string
}

const SECRET = 0o600

/** The file's contents for `credentials`. */
export function sealCredentials(credentials: Credentials, cipher: Cipher | null): string {
  const json = JSON.stringify(credentials)
  return JSON.stringify(
    cipher ? { encrypted: true, data: cipher.encrypt(json).toString('base64') } : { encrypted: false, data: json }
  )
}

/**
 * What the file holds, or nothing when it cannot be read. A key sealed by another
 * machine's keychain is a key to ask for again, not a reason to stop opening
 * Settings.
 */
export function openCredentials(raw: string, cipher: Cipher | null): Credentials {
  try {
    const file = JSON.parse(raw) as { encrypted: boolean; data: string }
    if (!file.encrypted) return JSON.parse(file.data) as Credentials
    if (!cipher) return {}
    return JSON.parse(cipher.decrypt(Buffer.from(file.data, 'base64'))) as Credentials
  } catch (e) {
    log('integrations:credentials-unreadable', { error: (e as Error).name })
    return {}
  }
}

// `?.` because a daemon's electron shim has no safeStorage at all.
function osCipher(): Cipher | null {
  if (!safeStorage?.isEncryptionAvailable?.()) return null
  return { encrypt: (text) => safeStorage.encryptString(text), decrypt: (data) => safeStorage.decryptString(data) }
}

const credentialsPath = (): string => join(dataDir(), 'credentials.json')

export function readCredentials(): Credentials {
  const path = credentialsPath()
  return existsSync(path) ? openCredentials(readFileSync(path, 'utf8'), osCipher()) : {}
}

export function getCredential(source: SourceId, field: string): string {
  return readCredentials()[source]?.[field] ?? ''
}

/** Save one field. An empty value removes it. */
export function setCredential(source: SourceId, field: string, value: string): void {
  if (!(CREDENTIAL_FIELDS[source] as readonly string[]).includes(field)) {
    throw new Error(`${source} has no setting named ${field}`)
  }
  const credentials = readCredentials()
  const fields = { ...credentials[source] }
  if (value) fields[field] = value
  else delete fields[field]
  credentials[source] = fields
  writeFileAtomic(credentialsPath(), sealCredentials(credentials, osCipher()), SECRET)
}
