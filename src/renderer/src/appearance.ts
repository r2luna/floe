// The bits of floe.toml the renderer applies to itself: `[appearance]` — font,
// size and theme — and the `[agent]` default.
//
// Only the font FAMILY is a CSS variable. The size is not: the stylesheet spells
// every size in px (fifty of them), so a `--font-size` would scale nothing —
// making it work would mean rewriting the whole sheet in rem. The size is
// applied as a window zoom instead, in the main process, which scales the UI the
// way a terminal's font size does: text, padding and rules together. See
// `applyZoom` in main/index.ts.

import { useEffect } from 'react'
import { setDefaultChoice } from './models'

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
  } catch {
    // No config is not a reason to show no app: the built-in defaults stand.
  }
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
