// The bits of floe.toml the renderer applies to itself: `[appearance]` — font,
// size and theme — and the `[agent]` default.
//
// Only the font FAMILY is a CSS variable. The size is not: the stylesheet spells
// every size in px (fifty of them), so a `--font-size` would scale nothing —
// making it work would mean rewriting the whole sheet in rem. The size is
// applied as a window zoom instead, in the main process, which scales the UI the
// way a terminal's font size does: text, padding and rules together. See
// `applyZoom` in main/index.ts.

import { useEffect, useState } from 'react'
import { setDefaultChoice, setHarnessDefaults, setUserNick } from './models'

type Theme = 'system' | 'dark' | 'light'

// The theme in force, kept so an OS switch can be applied without re-reading the
// config — and ignored when the config names a theme outright.
let chosen: Theme = 'system'

/**
 * Put `light` or `dark` on <html>, which is what every themed rule keys off.
 *
 * `system` is the only value that consults the OS. The other two mean it: an app
 * pinned to dark stays dark when the Mac flips at sunset, which is the whole
 * reason to pin it.
 */
async function applyTheme(theme: Theme): Promise<void> {
  chosen = theme
  const dark = theme === 'system' ? await window.floe.theme.isDark() : theme === 'dark'
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}

/**
 * Maple Mono NF stays pinned behind whatever face is chosen.
 *
 * It is never the primary — it is there so the Nerd Font glyphs a normal font
 * lacks (eza's icons, fish's prompt) still resolve per-glyph. Dropping it when
 * the user picks their own font would turn those into tofu.
 */
function fontStack(family: string | undefined): string {
  const chosen = family?.trim()
  const fallback = '"Maple Mono NF", ui-monospace, SFMono-Regular, Menlo, "Cascadia Code", monospace'
  return chosen ? `"${chosen}", ${fallback}` : `"CommitMonoPinguim", ${fallback}`
}

/**
 * Pull floe.toml into the renderer.
 *
 * Two settings, one fetch: the font face, and the model a new session starts on.
 * Both land in module state rather than in props, because both are read from
 * synchronous render paths that cannot await an IPC round trip — which is also
 * why main.tsx awaits this once before mounting anything.
 */
export async function applyConfig(): Promise<void> {
  try {
    const config = await window.floe.config.get()
    document.documentElement.style.setProperty('--mono', fontStack(config.appearance.fontFamily))
    await applyTheme(config.appearance.theme)
    setDefaultChoice(config.agent)
    setHarnessDefaults(config.harness)
    setVim(config.composer.vim)
    // Resolved in main — config first, then git/system — so the chat's nick and
    // the launcher's greeting can never disagree about who you are. NOT awaited:
    // on cold start this path runs `git config` and `id -F` in main, and the
    // nick only labels transcript rows, so it must not hold up the first paint.
    void window.floe
      .userName()
      .then(setUserNick)
      .catch(() => {})
  } catch {
    // No config is not a reason to show no app: the built-in defaults stand.
  }
}

// Whether the composer is modal. Module state for the same reason the font is:
// the Composer mounts and unmounts constantly (every panel switch), and a flag
// re-fetched per mount would flicker the mode indicator on every one of them.
let vim = false
const vimWatchers = new Set<(on: boolean) => void>()

function setVim(on: boolean): void {
  if (on === vim) return
  vim = on
  for (const w of vimWatchers) w(on)
}

/** Vim motions in the message box — `[composer] vim` in floe.toml. */
export function useVimEnabled(): boolean {
  const [on, setOn] = useState(vim)
  useEffect(() => {
    setOn(vim)
    vimWatchers.add(setOn)
    return () => void vimWatchers.delete(setOn)
  }, [])
  return on
}

/** Re-read it whenever the file changes, so an edit lands without a restart. */
export function useAppearance(): void {
  useEffect(() => {
    const stopConfig = window.floe.config.onChange(() => void applyConfig())
    // The OS flipping only matters under `system`; under a pinned theme it is
    // exactly the event the user asked us to ignore.
    const stopOs = window.floe.theme.onChange(() => {
      if (chosen === 'system') void applyTheme('system')
    })
    return () => {
      stopConfig()
      stopOs()
    }
  }, [])
}
