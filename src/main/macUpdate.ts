// Installing an update on macOS, where Squirrel cannot.
//
// The public builds are unsigned, and Squirrel.Mac only swaps in an update
// signed by the installed app's identity — so on this platform electron-updater
// can find a release and download it, but never apply it. That used to end at
// the release page, with the user dragging a new bundle into /Applications by
// hand. This does the same three moves the person would: fetch the zip, unpack
// it, put it where the old bundle is.
//
// The swap cannot happen in this process: the bundle being replaced is the one
// running. So the moves are written to a script that waits for our pid to go
// away, swaps, and launches the new app — the app's own replacement outlives
// it by design.
//
// Electron-free on purpose, like media.ts: everything with a decision in it is
// here, behind injected `Tools`, and testable under plain node.

import type { Dirent } from 'node:fs'

/** Where a version's macOS zip lives. `arm64` is the only Mac build cut today,
    and electron-builder leaves the arch out of an x64 name. */
export function macZipUrl(version: string, arch: string): string {
  const suffix = arch === 'arm64' ? '-arm64-mac.zip' : '-mac.zip'
  return `https://github.com/r2luna/floe/releases/download/v${version}/Floe-${version}${suffix}`
}

/**
 * The `.app` the running executable belongs to, or null outside a bundle
 * (`electron-vite dev`, a CI run, a unit test).
 */
export function appBundlePath(execPath: string): string | null {
  const marker = '/Contents/MacOS/'
  const at = execPath.indexOf(marker)
  if (at < 0) return null
  const bundle = execPath.slice(0, at)
  return bundle.endsWith('.app') ? bundle : null
}

/** The single `.app` an unpacked zip holds, or null when it holds none. */
export function bundleInside(entries: Dirent[]): string | null {
  return entries.find((e) => e.isDirectory() && e.name.endsWith('.app'))?.name ?? null
}

/** How long the script waits for the app to go away, in tenths of a second. */
export const WAIT_TICKS = 200

/**
 * The swap, as a script that outlives us.
 *
 * Ordered so that a failure leaves a working app behind: the old bundle is
 * moved aside rather than deleted, and put back if the new one cannot take its
 * place. Only the last step throws the old one away.
 *
 * The quarantine flag is cleared because the zip was fetched by this process
 * rather than by a browser — nothing has asked the user to approve the new
 * bundle, and Gatekeeper would refuse a flagged one that nobody vouched for.
 */
export function swapScript(opts: { bundle: string; staged: string; pid: number }): string {
  if (!opts.bundle.endsWith('.app')) throw new Error(`Refusing to swap ${opts.bundle}: not an .app bundle.`)
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  const bundle = q(opts.bundle)
  const staged = q(opts.staged)
  const backup = q(`${opts.bundle}.old`)
  return `#!/bin/bash
set -u
# The app is still quitting. Wait for it — replacing a bundle out from under a
# live process is what leaves a half-swapped app behind. If it is still there
# when the wait runs out, do nothing: the old app is running and working, and
# swapping under it is the one outcome worse than not updating.
for _ in $(seq 1 ${WAIT_TICKS}); do
  kill -0 ${opts.pid} 2>/dev/null || break
  sleep 0.1
done
kill -0 ${opts.pid} 2>/dev/null && exit 1
rm -rf ${backup}
mv ${bundle} ${backup} || exit 1
if ! mv ${staged} ${bundle}; then
  mv ${backup} ${bundle}
  exit 1
fi
rm -rf ${backup}
xattr -dr com.apple.quarantine ${bundle} 2>/dev/null || true
open -n ${bundle}
`
}

/** The machine this runs on, injected so the decisions above stay testable. */
export interface Tools {
  arch: string
  execPath: string
  pid: number
  tempDir: string
  /** Fetch the zip to `file`. Rejects on a non-200, like any failed download. */
  download: (url: string, file: string) => Promise<void>
  /** `ditto -x -k zip dir` — the unarchiver that keeps a bundle's symlinks. */
  unzip: (zip: string, dir: string) => Promise<void>
  readDir: (dir: string) => Promise<Dirent[]>
  /** Can we replace the bundle at all? False for an app in a read-only place. */
  writable: (path: string) => Promise<boolean>
  writeScript: (file: string, body: string) => Promise<void>
  /** Start the script detached, so it survives this process exiting. */
  spawnDetached: (file: string) => void
  quit: () => void
}

/**
 * Fetch `version`, stage it beside the installed bundle, and hand the swap to a
 * script before quitting.
 *
 * Throws with a reason the user can act on. The caller falls back to the
 * release page, which is the manual path this replaces — an update that cannot
 * install itself must still be installable.
 */
export async function installMacUpdate(version: string, tools: Tools): Promise<void> {
  const bundle = appBundlePath(tools.execPath)
  if (!bundle) throw new Error('Floe is not running from an .app bundle.')
  // The parent, not the bundle: the swap renames inside /Applications, which is
  // the permission that actually decides whether this can work.
  const parent = bundle.slice(0, bundle.lastIndexOf('/')) || '/'
  if (!(await tools.writable(parent))) throw new Error(`${parent} is not writable.`)

  const zip = `${tools.tempDir}/Floe-${version}.zip`
  const unpacked = `${tools.tempDir}/Floe-${version}`
  await tools.download(macZipUrl(version, tools.arch), zip)
  await tools.unzip(zip, unpacked)
  const name = bundleInside(await tools.readDir(unpacked))
  if (!name) throw new Error('The downloaded archive holds no .app bundle.')

  const script = `${tools.tempDir}/floe-swap-${version}.sh`
  await tools.writeScript(script, swapScript({ bundle, staged: `${unpacked}/${name}`, pid: tools.pid }))
  tools.spawnDetached(script)
  tools.quit()
}
