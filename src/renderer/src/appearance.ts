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
import type { TransparencyId } from '../../shared/types'

type Theme = 'system' | 'dark' | 'light'

// `[appearance] transparency` and its amount, kept for the same reason `chosen`
// is: an OS flip has to re-decide whether THIS theme is glassed without
// re-reading the file.
let glass: TransparencyId = 'off'
let glassAmount = 18

/**
 * Turn the per-theme choice into the one bit the stylesheet reads.
 *
 * The window is already non-opaque whenever transparency names any theme (main
 * clears its fill; see transparencyOn), so this attribute is what decides
 * whether the surfaces let that blur through or cover it — which is how a
 * `dark`-only glass stays solid in light without touching the window.
 *
 * macOS only: the blur is an NSVisualEffectView. Elsewhere — and in the browser
 * build, where `platform` is the browser's — translucent surfaces would sit over
 * nothing at all, so the app stays opaque.
 */
function applyGlass(dark: boolean): void {
  const supported = window.floe.platform === 'darwin'
  const on = supported && (glass === 'all' || glass === (dark ? 'dark' : 'light'))
  document.documentElement.dataset.vibrancy = on ? 'on' : 'off'
  // The alpha every glassed surface is tinted at. Stated as "how much comes
  // through" in the file, because that is the thing being judged.
  document.documentElement.style.setProperty('--glass', String(1 - glassAmount / 100))
}

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
  applyGlass(dark)
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
    // Layout is a stylesheet switch, not a component one: every layout renders
    // the same transcript, and the rules keyed off this attribute are what move
    // the nick, the air and the surfaces. See CHAT_LAYOUTS in shared/types.
    document.documentElement.dataset.chatLayout = config.appearance.chatLayout
    // Before applyTheme: it resolves dark/light and applies the glass with it.
    glass = config.appearance.transparency
    glassAmount = config.appearance.transparencyAmount
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
