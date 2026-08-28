import { safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './dataDir'

// Settings → Integrations credential store. The Jira API token is encrypted at
// rest with Electron's safeStorage (OS keychain-backed) — never written in
// plaintext and never returned to the renderer (only a `hasToken` flag is). Base
// URL + email are non-secret and stored alongside. A dedicated file keeps this
// out of the sessions/projects stores.

interface JiraStore {
  baseUrl?: string
  email?: string
  tokenEnc?: string
}

const file = (): string => join(dataDir(), 'integrations.json')

function read(): JiraStore {
  try {
    return existsSync(file()) ? (JSON.parse(readFileSync(file(), 'utf8')) as JiraStore) : {}
  } catch {
    return {}
  }
}

function write(store: JiraStore): void {
  writeFileSync(file(), JSON.stringify(store, null, 2))
}

function encrypt(token: string): string {
  // Prefer OS-backed encryption; fall back to base64 (obfuscation only) on the
  // rare platform where safeStorage is unavailable, so the feature still works.
  return safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(token).toString('base64')
    : Buffer.from(token, 'utf8').toString('base64')
}

function decrypt(enc: string): string | null {
  try {
    const buf = Buffer.from(enc, 'base64')
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8')
  } catch {
    return null
  }
}

export function getJira(): { baseUrl: string; email: string; hasToken: boolean } {
  const s = read()
  return { baseUrl: s.baseUrl ?? '', email: s.email ?? '', hasToken: !!s.tokenEnc }
}

// Persist Jira config. A token of `undefined`/`''` leaves the stored token
// untouched (so editing the URL doesn't wipe the saved secret).
export function setJira(input: { baseUrl: string; email: string; token?: string }): void {
  const s = read()
  s.baseUrl = input.baseUrl
  s.email = input.email
  if (input.token) s.tokenEnc = encrypt(input.token)
  write(s)
}

export async function testJira(): Promise<{ ok: boolean; message: string }> {
  const s = read()
  const token = s.tokenEnc ? decrypt(s.tokenEnc) : null
  if (!s.baseUrl || !s.email || !token) {
    return { ok: false, message: 'Missing base URL, email or token' }
  }
  try {
    const auth = Buffer.from(`${s.email}:${token}`).toString('base64')
    const res = await fetch(`${s.baseUrl.replace(/\/+$/, '')}/rest/api/3/myself`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' }
    })
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` }
    const me = (await res.json()) as { displayName?: string }
    return { ok: true, message: `Connected as ${me.displayName ?? s.email}` }
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }
}
