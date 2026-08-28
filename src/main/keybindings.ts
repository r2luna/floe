// User-customizable keybindings, loaded from a Ghostty-style plain-text config
// the user owns and edits. The renderer keeps the DEFAULT_KEYMAP; this layer
// only parses the user's *overrides* (rebind a chord, or `unbind` a default)
// and validates them against the canonical command id list before the renderer
// merges them in. Living in the main process keeps the file I/O and validation
// off the renderer and lets us import the shared id set without renderer code.
//
// File format (`~/.config/rookery/keybindings`):
//
//   # comment
//   keybind = cmd+shift+p = palette.toggle
//   keybind = cmd+t       = unbind         # drop a default binding
//
// Chords are normalized to the same shape `eventToChord` produces in the
// renderer (modifiers in cmd, ctrl, alt, shift order; key lowercased) so a
// user's `shift+cmd+p` still matches the event's `cmd+shift+p`.

import { shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { dirname, join } from 'node:path'
import { COMMAND_ID_SET } from '../shared/commandIds'
import { configDir } from './dataDir'

// A parse problem tied to a line, surfaced to the renderer so the user can be
// told their config has a typo instead of silently dropping the binding.
export interface KeybindingError {
  line: number
  text: string
  reason: string
}

// `null` value means "unbind this chord" (remove a default).
export interface KeybindingsConfig {
  path: string
  overrides: Record<string, string | null>
  errors: KeybindingError[]
}

const MODIFIERS = new Set(['cmd', 'ctrl', 'alt', 'shift'])
const MODIFIER_ORDER = ['cmd', 'ctrl', 'alt', 'shift']

// Aliases people reach for; normalized to our canonical token.
const MODIFIER_ALIASES: Record<string, string> = {
  meta: 'cmd',
  super: 'cmd',
  command: 'cmd',
  '⌘': 'cmd',
  control: 'ctrl',
  '⌃': 'ctrl',
  option: 'alt',
  opt: 'alt',
  '⌥': 'alt',
  '⇧': 'shift'
}

export function keybindingsPath(): string {
  return join(configDir(), 'keybindings')
}

// Normalize a user-written chord into the canonical form `eventToChord`
// produces. Returns null if it isn't a valid chord (no key, unknown shape).
export function normalizeChord(raw: string): string | null {
  const tokens = raw
    .split('+')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .map((t) => MODIFIER_ALIASES[t] ?? t)
  if (tokens.length === 0) return null

  const mods = new Set<string>()
  let key: string | null = null
  for (const t of tokens) {
    if (MODIFIERS.has(t)) {
      mods.add(t)
      continue
    }
    if (key !== null) return null // two non-modifier keys — invalid
    key = t
  }
  if (key === null) return null // modifiers with no key

  const ordered = MODIFIER_ORDER.filter((m) => mods.has(m))
  ordered.push(key)
  return ordered.join('+')
}

// Parse the config text into overrides + errors. Pure, so it's testable and the
// caller decides where the text comes from.
export function parseKeybindings(text: string): {
  overrides: Record<string, string | null>
  errors: KeybindingError[]
} {
  const overrides: Record<string, string | null> = {}
  const errors: KeybindingError[] = []

  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    const raw = lines[i]
    const stripped = raw.replace(/#.*$/, '').trim()
    if (!stripped) continue

    // `keybind = <chord> = <action>` — three `=`-separated parts.
    const parts = stripped.split('=').map((p) => p.trim())
    if (parts.length !== 3 || parts[0].toLowerCase() !== 'keybind') {
      errors.push({ line: lineNo, text: raw.trim(), reason: 'expected `keybind = <chord> = <command>`' })
      continue
    }

    const chord = normalizeChord(parts[1])
    if (!chord) {
      errors.push({ line: lineNo, text: raw.trim(), reason: `invalid chord "${parts[1]}"` })
      continue
    }

    const action = parts[2]
    if (action.toLowerCase() === 'unbind') {
      overrides[chord] = null
      continue
    }
    if (!COMMAND_ID_SET.has(action)) {
      errors.push({ line: lineNo, text: raw.trim(), reason: `unknown command "${action}"` })
      continue
    }
    overrides[chord] = action
  }

  return { overrides, errors }
}

// Drop a commented template the first time so the file is discoverable and the
// user has the syntax in front of them instead of a blank file.
const TEMPLATE = `# Rookery keybindings — remap any command to your own chord.
#
# Syntax:
#   keybind = <chord> = <command-id>
#   keybind = <chord> = unbind          # remove a built-in binding
#
# Chords combine cmd, ctrl, alt, shift with one key, joined by +:
#   keybind = cmd+shift+p = palette.toggle
#   keybind = ctrl+\` = terminal.toggle
#
# Run "Edit keybindings" from the command palette to reopen this file.
# Lines starting with # are ignored. Unknown commands are reported, not applied.
#
# Examples (uncomment and edit):
# keybind = cmd+t = session.new
# keybind = cmd+k = palette.toggle
`

function ensureFile(path: string): void {
  if (existsSync(path)) return
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, TEMPLATE)
  } catch {
    // Non-fatal: if we can't scaffold it, load() just returns no overrides.
  }
}

export function loadKeybindings(): KeybindingsConfig {
  const path = keybindingsPath()
  ensureFile(path)
  if (!existsSync(path)) return { path, overrides: {}, errors: [] }
  try {
    const text = readFileSync(path, 'utf8')
    const { overrides, errors } = parseKeybindings(text)
    return { path, overrides, errors }
  } catch (err) {
    return {
      path,
      overrides: {},
      errors: [{ line: 0, text: '', reason: `could not read file: ${(err as Error).message}` }]
    }
  }
}

// Open the config in the user's default editor (or reveal it). Keyboard-first:
// the "Edit keybindings" command routes here so the user never needs the mouse.
export async function revealKeybindings(): Promise<void> {
  const path = keybindingsPath()
  ensureFile(path)
  await shell.openPath(path)
}

// Watch the file and fire `onChange` (debounced) on every edit so the renderer
// can hot-reload bindings without an app restart.
export function watchKeybindings(onChange: () => void): () => void {
  const path = keybindingsPath()
  ensureFile(path)
  let timer: NodeJS.Timeout | null = null
  let watcher: FSWatcher | null = null
  try {
    // Watch the directory, not the file: editors that replace-on-save (write to
    // a temp file then rename) break a file-level watch.
    watcher = watch(dirname(path), (_event, filename) => {
      if (filename && filename !== 'keybindings') return
      if (timer) clearTimeout(timer)
      timer = setTimeout(onChange, 120)
    })
  } catch {
    return () => {}
  }
  return () => {
    if (timer) clearTimeout(timer)
    watcher?.close()
  }
}
