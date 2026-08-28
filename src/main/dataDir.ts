import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Where the app's *persistent* JSON stores live (sessions, projects, workflows,
// commands, integrations, …). This must be ONE place per machine — not one per
// dev worktree.
//
// In dev we isolate Electron's `userData` per git worktree (see
// `isolateUserDataPerWorktree`) so concurrent dev instances don't fight over
// Electron's own locks/caches. But that isolation also scattered the user's
// sessions into a separate `sessions.json` per worktree: do real work in the dev
// build, relaunch it from a different worktree, and everything looked gone —
// it was just sitting in another store. So point the persistent stores at a
// single shared dir instead, kept apart from Electron's per-worktree userData.
//
// Packaged builds never isolate, so `sharedOverride` stays null and this is just
// `userData` — the one canonical store.
let sharedOverride: string | null = null

export function setSharedDataDir(dir: string): void {
  // The dev-shared dir doesn't exist yet on first launch (userData does), and the
  // stores writeFileSync straight into it — so create it here or every save ENOENTs.
  mkdirSync(dir, { recursive: true })
  sharedOverride = dir
}

export function dataDir(): string {
  return sharedOverride ?? app.getPath('userData')
}

// The user's *hand-editable, backup-worthy* config — keybindings, the system
// prompt, the command definitions. Kept out of `dataDir()` on purpose: that one
// mixes in state (sessions, running pipelines) and machine-bound secrets
// (safeStorage-encrypted tokens), none of which belong in a dotfiles repo.
// Same dir the app already used for `keybindings`, now XDG-aware.
export function configDir(): string {
  const dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'rookery')
  mkdirSync(dir, { recursive: true })
  return dir
}
