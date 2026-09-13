// Reading and following Omarchy's current theme — `[appearance] theme = "omarchy"`.
//
// Omarchy writes the theme in force to `~/.local/state/omarchy/current/theme/`,
// and every switch replaces that directory whole: build `next-theme`, then
// `rm -rf theme` and `mv next-theme theme`. Two consequences shape this file.
//
// - The watch is on `current`, the stable parent. A watch on `theme` dies with
//   the directory it was opened on at the first switch.
// - Between the remove and the move the file does not exist. Reporting that
//   instant as "Omarchy is gone" would flash the app back to its own palette on
//   every switch, so a missing file is re-read a few times before it counts.
//
// No platform check: the path simply does not exist off Omarchy, and a floe.toml
// shared between a Mac and an Omarchy box has to mean the same thing on both.

import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseToml } from './config/toml'
import { resolveOmarchyPalette, type OmarchyPalette } from '../shared/omarchyPalette'

export const omarchyCurrentDir = (home = homedir()): string => join(home, '.local', 'state', 'omarchy', 'current')

/** The palette in force, or null when there is no Omarchy theme to read. */
export function readOmarchyPalette(home = homedir()): OmarchyPalette | null {
  const dir = join(omarchyCurrentDir(home), 'theme')
  try {
    const parsed = parseToml(readFileSync(join(dir, 'colors.toml'), 'utf8'))
    if (!parsed.ok) return null
    return resolveOmarchyPalette(parsed.value, existsSync(join(dir, 'light.mode')))
  } catch {
    return null
  }
}

export interface FollowOptions {
  /** Quiet time after the last filesystem event — a switch is several events. */
  debounceMs?: number
  /** Extra reads of a missing file before it counts as gone. */
  retries?: number
  retryMs?: number
}

/**
 * The settle-and-report half of the watcher, apart from `fs.watch` so the swap
 * gap can be tested without racing a real filesystem.
 *
 * `poke` is "something under current/ moved". It reports only a palette that
 * differs from the last one reported, so the several events of one switch — and
 * a switch to a theme with the same colours — cost the renderer nothing.
 */
export function followOmarchy(
  read: () => OmarchyPalette | null,
  onChange: (palette: OmarchyPalette | null) => void,
  { debounceMs = 80, retries = 3, retryMs = 50 }: FollowOptions = {}
): { poke: () => void; stop: () => void } {
  let last = JSON.stringify(read())
  let timer: NodeJS.Timeout | null = null

  const settle = (left: number): void => {
    const palette = read()
    if (palette === null && left > 0) {
      timer = setTimeout(() => settle(left - 1), retryMs)
      return
    }
    timer = null
    const key = JSON.stringify(palette)
    if (key === last) return
    last = key
    onChange(palette)
  }

  return {
    poke: () => {
      // A new event restarts the wait, retries included: the switch is still
      // in progress, and the read it would have made is already stale.
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => settle(retries), debounceMs)
    },
    stop: () => {
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}

/**
 * Report every change to Omarchy's palette until the returned stop is called.
 *
 * Nothing to watch without Omarchy, and nothing is set up: installing it later
 * takes a relaunch, which an OS-level install asks for anyway.
 */
export function watchOmarchyTheme(
  onChange: (palette: OmarchyPalette | null) => void,
  home = homedir(),
  options?: FollowOptions
): () => void {
  const dir = omarchyCurrentDir(home)
  if (!existsSync(dir)) return () => {}
  const follower = followOmarchy(() => readOmarchyPalette(home), onChange, options)
  let watcher: FSWatcher
  try {
    watcher = watch(dir, () => follower.poke())
  } catch {
    return () => {}
  }
  // An error (the directory itself removed) ends the watch; it must not throw
  // out of an event emitter nobody is listening on.
  watcher.on('error', () => follower.stop())
  return () => {
    follower.stop()
    watcher.close()
  }
}
