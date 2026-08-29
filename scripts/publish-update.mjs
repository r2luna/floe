#!/usr/bin/env node
// Publish the built mac update to the homelab Forgejo generic package registry.
// The GitHub repo is archived, so `pnpm release` only *builds* (generic provider
// has no uploader) — this pushes dist/latest-mac.yml + the .zip (+ .dmg) to a
// fixed "latest" version so the app's generic updater always finds the newest.
//
//   token: ~/.floe-forgejo-token (or $FORGEJO_TOKEN), scope write:package
//
// Replacing the `latest` version drops the previous zip; a client mid-download
// during a release just retries next cycle. Fine for a personal app.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const BASE = 'https://git.pinguim.io/api/packages/r2luna/generic/floe-updates/latest'
const DIST = join(process.cwd(), 'dist')
const { version } = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))

const token =
  process.env.FORGEJO_TOKEN?.trim() ||
  readFileSync(join(homedir(), '.floe-forgejo-token'), 'utf8').trim()
if (!token) throw new Error('no Forgejo token (~/.floe-forgejo-token or $FORGEJO_TOKEN)')

// curl streams multi-hundred-MB bodies reliably; Node's fetch buffers a Buffer
// body and leaves the top-level await unsettled on large uploads (exit 13).
const curl = (args) =>
  execFileSync('curl', ['-sS', '-H', `Authorization: token ${token}`, ...args], {
    encoding: 'utf8'
  }).trim()

// Only THIS release's files — dist/ accumulates every historical build, so match
// on version, never a blanket *.zip/*.dmg glob. latest-mac.yml + the referenced
// .zip are what the updater needs; .dmg is first-install convenience.
const files = [
  'latest-mac.yml',
  `Floe-${version}-arm64-mac.zip`,
  `Floe-${version}-arm64.dmg`
]
for (const f of files) {
  if (!existsSync(join(DIST, f))) throw new Error(`dist/${f} missing — run the build first`)
}

// Wipe the old version so PUTs don't 409 on existing filenames.
const delCode = curl(['-o', '/dev/null', '-w', '%{http_code}', '-X', 'DELETE', BASE])
if (!['204', '404'].includes(delCode)) throw new Error(`delete latest failed: HTTP ${delCode}`)
console.log(`[publish] cleared old 'latest' (HTTP ${delCode})`)

for (const name of files) {
  const code = curl(['-o', '/dev/null', '-w', '%{http_code}', '-T', join(DIST, name), `${BASE}/${name}`])
  if (code !== '201') throw new Error(`upload ${name} failed: HTTP ${code}`)
  console.log(`[publish] uploaded ${name}`)
}
console.log(`[publish] done → ${BASE}/latest-mac.yml`)
