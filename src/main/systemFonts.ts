// The font families installed on this machine, for Settings → Font family.
//
// Asked of the OS rather than of Chromium: `queryLocalFonts()` sits behind a
// permission prompt and says nothing about which faces are monospaced, and the
// picker exists to put those first. macOS answers through AppKit (osascript's
// JavaScript bridge ships with every Mac), Linux through fontconfig. Anywhere
// else the list is empty and the row stays a box you type a name into.

import { execFile } from 'node:child_process'

export interface SystemFont {
  family: string
  mono: boolean
}

// NSFixedPitchFontMask is set per member, so a family counts as mono when any
// member carries it. Families starting with "." are the system's private UI
// faces — not something a user can pick by name.
const MAC_SCRIPT = `
ObjC.import('AppKit');
const fm = $.NSFontManager.sharedFontManager;
ObjC.deepUnwrap(fm.availableFontFamilies).filter((f) => !f.startsWith('.')).map((f) => {
  const members = ObjC.deepUnwrap(fm.availableMembersOfFontFamily(f)) || [];
  return (members.some((m) => (m[3] & 0x400) !== 0) ? 'M' : 'P') + '\\t' + f;
}).join('\\n');
`

// The fixed-pitch bit misses faces that are monospaced in every way a user
// cares about: ligature fonts (FiraCode, Dank Mono) and anything whose glyph
// table holds one double-width icon. Their names say what they are — except
// "Unicode", and Nerd Fonts' "Propo" builds, which are proportional on purpose.
const MONO_NAME = /mono|(?<!uni)code|courier|consol|terminal|\bnf\b|nerd font/i
const NOT_MONO = /propo/i

/** `M\tFamily` / `P\tFamily` lines from MAC_SCRIPT. */
export function parseMacFonts(out: string): SystemFont[] {
  return out
    .split('\n')
    .map((line) => line.split('\t'))
    .filter(([, family]) => family?.trim())
    .map(([mark, family]) => ({ family: family.trim(), mono: mark === 'M' }))
}

/**
 * `fc-list --format '%{family[0]}\t%{spacing}\n'` — one line per face, so a
 * family repeats once per weight and style. Spacing 100 is mono, 90 is dual
 * width (CJK-capable mono faces); either counts. A face with no spacing is
 * proportional.
 */
export function parseFcList(out: string): SystemFont[] {
  const mono = new Map<string, boolean>()
  for (const line of out.split('\n')) {
    const [family, spacing] = line.split('\t')
    const name = family?.trim()
    if (!name) continue
    const fixed = spacing === '100' || spacing === '90'
    mono.set(name, (mono.get(name) ?? false) || fixed)
  }
  return [...mono].map(([family, isMono]) => ({ family, mono: isMono }))
}

/** Mono first, then by name — the order the picker shows them in. */
export function sortFonts(fonts: SystemFont[]): SystemFont[] {
  const seen = new Set<string>()
  return fonts
    .filter((f) => !seen.has(f.family) && seen.add(f.family))
    .map((f) => ({ family: f.family, mono: f.mono || (MONO_NAME.test(f.family) && !NOT_MONO.test(f.family)) }))
    .sort((a, b) => Number(b.mono) - Number(a.mono) || a.family.localeCompare(b.family))
}

type Run = (cmd: string, args: string[]) => Promise<string>

const run: Run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout)
    )
  )

// Installing a font mid-session is rare and a restart picks it up; walking
// every family again each time Settings opens is not free.
let cached: Promise<SystemFont[]> | null = null

/** Every installed family, mono first. Empty where the OS cannot be asked. */
export function listSystemFonts(platform: NodeJS.Platform = process.platform, exec: Run = run): Promise<SystemFont[]> {
  if (exec === run && cached) return cached
  const ask =
    platform === 'darwin'
      ? exec('osascript', ['-l', 'JavaScript', '-e', MAC_SCRIPT]).then(parseMacFonts)
      : platform === 'linux'
        ? exec('fc-list', ['--format', '%{family[0]}\t%{spacing}\n']).then(parseFcList)
        : Promise.resolve([])
  const result = ask.then(sortFonts, () => [])
  if (exec === run) cached = result
  return result
}
