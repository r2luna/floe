// `~/.config/floe/keybindings.toml` — every binding, written out.
//
// The file used to hold only OVERRIDES, in a Ghostty-style plain-text format:
// what you did not write, you could not see. That made "unbind" a special word
// and left the real keymap invisible unless you read the source. Now the whole
// default table is generated into the file (from shared/defaultKeymap.ts, which
// carries the prose too), so the file IS the keymap: edit a `key` to rebind,
// delete an entry to drop the binding.
//
// The defaults still live in code, and that is the safety net. If this file does
// not parse, names a command that does not exist, or carries a `when` that does
// not compile, the app falls back to the ENTIRE default map and reports the
// problems. A half-applied keymap — some keys working, some silently gone — is
// far worse than losing your customizations for one launch.

import { shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { COMMAND_ID_SET } from '../shared/commandIds'
import { DEFAULT_KEYMAP, KEYMAP_SECTIONS, UNBOUND_SUGGESTIONS } from '../shared/defaultKeymap'
import { normalizeChord, parseWhen, type Keybind } from '../shared/keymap'
import { configDir } from './dataDir'
import { editToml, parseToml } from './config/toml'
import { writeTomlFile } from './config/io'

// A parse problem tied to a line, surfaced to the renderer so the user can be
// told their config has a typo instead of silently dropping the binding.
export interface KeybindingError {
  line: number
  text: string
  reason: string
}

export interface KeybindingsConfig {
  path: string
  /** The bindings in force — the user's file, or the defaults when it can't be used. */
  binds: Keybind[]
  /** True when `binds` is the built-in table because the file could not be trusted. */
  usingDefaults: boolean
  errors: KeybindingError[]
  /**
   * Commands the app ships a default binding for that this file has no entry
   * for at all — almost always bindings added by an update, since the file is
   * only generated once and never rewritten behind the user's back.
   *
   * NOT auto-added: "delete an entry to drop the binding" has to mean it, and a
   * command you unbound on purpose is indistinguishable here from one that did
   * not exist when the file was written. So it is reported, and reset is offered.
   */
  missing: string[]
}

export function keybindingsPath(): string {
  return join(configDir(), 'keybindings.toml')
}

// ---------------------------------------------------------------------------
// Generating
// ---------------------------------------------------------------------------

const BANNER = (title: string): string =>
  `# ==============================================================================\n#  ${title}\n# ==============================================================================`

/** A `# | …` block comment, the shape the rest of the config files use. */
function block(title: string, body: string): string {
  const rule = '# ' + '-'.repeat(78)
  const lines = body.split('\n').map((l) => (l ? `# | ${l}` : '# |'))
  return [rule, `# | ${title}`, rule, '# |', ...lines, '# |', rule].join('\n')
}

function renderBind(bind: Keybind, commented = false): string {
  const fields: Array<[string, string]> = [
    // A suggestion with no chord still shows the key line, so binding it is
    // filling in a blank rather than remembering the field's name.
    ['key', bind.key ? JSON.stringify(bind.key) : '""  # choose a chord'],
    ['command', JSON.stringify(bind.command)]
  ]
  if (bind.arg !== undefined) fields.push(['arg', JSON.stringify(bind.arg)])
  // Single-quoted so a `when` containing double quotes (`panel == "diff"`) reads
  // the way it is documented instead of as a wall of backslashes.
  if (bind.when !== undefined) fields.push(['when', `'${bind.when}'`])
  const width = Math.max(...fields.map(([k]) => k.length))
  const prefix = commented ? '# ' : ''
  return [
    `${prefix}[[keybind]]`,
    ...fields.map(([k, v]) => `${prefix}${k.padEnd(width)} = ${v}`)
  ].join('\n')
}

const WRITING_A_BINDING = `Each \`[[keybind]]\` needs a \`key\` and a \`command\`. Chords combine \`super\`,
\`ctrl\`, \`alt\` and \`shift\` with one key, joined by \`+\`.

\`super\` is Command on a Mac and the Super/Windows key on Linux — one word for
one physical key, so this file moves between machines unchanged. \`cmd\`,
\`command\`, \`meta\`, \`win\` and \`⌘\` are all accepted and normalize to it.
Modifier order does not matter either: \`shift+cmd+p\` and \`super+shift+p\` are
the same chord. A leading \`super+k \` makes it a two-step sequence.

\`arg\` passes a value to commands that take one, such as which panel to jump
to. \`when\` limits the binding to a situation — see the reference at the
bottom of this file. Without it, a binding with no modifier only fires while
you are NOT typing, since a bare letter inside the composer has to stay a
letter.

Entries are matched top to bottom and the first match wins, which is how two
bindings can share a chord and differ only by their \`when\`. Delete an entry
to drop that binding; the app keeps working from its built-in defaults if
this whole file ever fails to parse.`

const WHEN_REFERENCE = `\`when\` decides whether a binding is live right now. Leave it out and the
binding always fires — except for chords with no modifier, which never fire
while you are typing, since a bare letter inside the composer has to stay a
letter.

The conditions:

  typing              focus is in a text field (the composer, a search box)
  selecting           a line selection is open in the focused panel
  moving              a project is being moved between groups (\`m\`)
  stack-below         the focused panel has a neighbour docked below it
  stack-above         the focused panel has a neighbour docked above it
  panel == "diff"     the focused panel is of that kind
  panel != "terminal" the focused panel is anything else
  panel in ["a","b"]  the focused panel is one of these kinds

Panel kinds: chat, diff, files, changes, terminal, projects, worktrees.

Combine them with \`and\`, \`or\` and \`not\`. \`and\` binds tighter than \`or\`, so
\`a and b or c\` reads as \`(a and b) or c\`. There are no parentheses — if you
need them, write two entries instead.

Entries are matched top to bottom and the first match wins. That is how one
chord can do two jobs: put the narrower condition first.

Examples:

  when = "typing"
      Only while you are in a text field. Escape uses this to leave the
      composer before it means anything else.

  when = "not typing"
      Everywhere except a text field. Rarely needed — it is already the
      default for a binding with no modifier.

  when = 'panel == "diff" and selecting'
      Both have to hold. \`c\` comments a selection only in a diff, and only
      once there is something selected.

  when = 'panel in ["projects", "worktrees"]'
      Bare \`h\` and \`l\` jump between those two lists, and stay free letters
      in every other panel.

  when = "stack-below"
      Put this entry above the unconditional one and ⌃J moves down the
      stack when there is a stack, and scrolls when there isn't:

        [[keybind]]
        key     = "ctrl+j"
        command = "panel.down"
        when    = "stack-below"

        [[keybind]]
        key     = "ctrl+j"
        command = "scroll.down"

  when = 'not panel == "terminal"'
      Everywhere but the terminal, which swallows most keys anyway.`

/** The whole file, built from the same table the app resolves against. */
export function generateKeybindings(): string {
  const parts: string[] = [
    BANNER('Floe — keybindings') +
      `\n#  Every binding the app ships with, written out in full. This file is the\n` +
      `#  source of truth: edit a \`key\` to rebind, delete an entry to drop the\n` +
      `#  binding, add your own at the bottom. A problem anywhere in here — a typo,\n` +
      `#  an unknown command, a \`when\` that does not compile — falls back to the\n` +
      `#  built-in defaults for the whole file and is reported in Settings, rather\n` +
      `#  than leaving you with half a keymap.\n# ==============================================================================`,
    block('Writing a Binding', WRITING_A_BINDING)
  ]

  for (const section of KEYMAP_SECTIONS) {
    parts.push(block(section.title, section.doc))
    parts.push(section.binds.map((b) => renderBind(b)).join('\n\n'))
  }

  parts.push(
    block(
      'Unbound Commands',
      `These ship with no key and are reachable from the command palette only.
Uncomment one and give it a chord to bind it.`
    )
  )
  parts.push(
    UNBOUND_SUGGESTIONS.map((s) => renderBind({ key: s.key ?? '', command: s.command }, true)).join('\n\n')
  )

  parts.push(BANNER('Writing a `when` Condition') + '\n' + block('', WHEN_REFERENCE).split('\n').slice(3, -2).join('\n'))
  return parts.join('\n\n\n') + '\n'
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Read a keybindings file into bindings.
 *
 * Pure, so the caller decides where the text comes from — and so the fallback
 * rule (any error means the defaults) is testable without touching a disk.
 */
export function parseKeybindings(text: string): { binds: Keybind[]; errors: KeybindingError[] } {
  const errors: KeybindingError[] = []
  const lines = text.split(/\r?\n/)
  const at = (needle: string): { line: number; text: string } => {
    const index = lines.findIndex((l) => l.includes(needle))
    return index === -1 ? { line: 1, text: '' } : { line: index + 1, text: lines[index].trim() }
  }

  const parsed = parseToml<{ keybind?: unknown }>(text)
  if (!parsed.ok) {
    return {
      binds: [],
      errors: [{ line: parsed.error.line, text: lines[parsed.error.line - 1]?.trim() ?? '', reason: parsed.error.message }]
    }
  }

  const entries = parsed.value.keybind
  if (entries === undefined) return { binds: [], errors: [] }
  if (!Array.isArray(entries)) {
    return { binds: [], errors: [{ line: 1, text: '', reason: 'keybind must be a list of [[keybind]] entries' }] }
  }

  const binds: Keybind[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    const key = typeof e.key === 'string' ? e.key.trim() : ''
    const command = typeof e.command === 'string' ? e.command : ''
    if (!key) {
      errors.push({ ...at(command), reason: `binding for "${command}" has no key` })
      continue
    }
    if (!COMMAND_ID_SET.has(command)) {
      errors.push({ ...at(key), reason: `unknown command "${command}"` })
      continue
    }
    if (e.when !== undefined) {
      if (typeof e.when !== 'string') {
        errors.push({ ...at(key), reason: 'when must be a string' })
        continue
      }
      const when = parseWhen(e.when)
      if (!when.ok) {
        errors.push({ ...at(key), reason: when.reason })
        continue
      }
    }
    binds.push({
      key: normalizeChord(key),
      command,
      arg: typeof e.arg === 'string' ? e.arg : undefined,
      when: typeof e.when === 'string' ? e.when : undefined
    })
  }
  return { binds, errors }
}

// ---------------------------------------------------------------------------
// The file on disk
// ---------------------------------------------------------------------------

/** Write the file if it isn't there. */
export function ensureKeybindings(): void {
  const path = keybindingsPath()
  if (existsSync(path)) return
  mkdirSync(dirname(path), { recursive: true })
  writeTomlFile(path, generateKeybindings())
}

export function loadKeybindings(): KeybindingsConfig {
  const path = keybindingsPath()
  try {
    ensureKeybindings()
  } catch {
    // Can't scaffold (read-only home, no permissions) — the defaults still work.
  }
  if (!existsSync(path)) return { path, binds: DEFAULT_KEYMAP, usingDefaults: true, errors: [], missing: [] }
  try {
    const { binds, errors } = parseKeybindings(readFileSync(path, 'utf8'))
    // All-or-nothing: see the note at the top. Half a keymap is the one outcome
    // worth refusing.
    if (errors.length) return { path, binds: DEFAULT_KEYMAP, usingDefaults: true, errors, missing: [] }
    return { path, binds, usingDefaults: false, errors: [], missing: missingDefaults(binds) }
  } catch (err) {
    return {
      path,
      binds: DEFAULT_KEYMAP,
      usingDefaults: true,
      errors: [{ line: 0, text: '', reason: `could not read file: ${(err as Error).message}` }],
      missing: []
    }
  }
}

/** Default-bound commands the file does not mention at all. */
function missingDefaults(binds: Keybind[]): string[] {
  const present = new Set(binds.map((b) => b.command))
  const missing = new Set<string>()
  for (const bind of DEFAULT_KEYMAP) if (!present.has(bind.command)) missing.add(bind.command)
  return [...missing]
}

// Open the config in the user's default editor (or reveal it). Keyboard-first:
// the "Edit keybindings" command routes here so the user never needs the mouse.
export async function revealKeybindings(): Promise<void> {
  try {
    ensureKeybindings()
  } catch {
    /* opening a missing file just fails below, which is loud enough */
  }
  await shell.openPath(keybindingsPath())
}

// Watch the file and fire `onChange` (debounced) on every edit so the renderer
// can hot-reload bindings without an app restart.
export function watchKeybindings(onChange: () => void): () => void {
  const path = keybindingsPath()
  let timer: NodeJS.Timeout | null = null
  let watcher: FSWatcher | null = null
  try {
    // Watch the directory, not the file: editors that replace-on-save (write to
    // a temp file then rename) break a file-level watch.
    watcher = watch(dirname(path), (_event, filename) => {
      if (filename && filename !== basename(path)) return
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

/**
 * Rewrite the file from the built-in defaults.
 *
 * The user's version is kept as `keybindings.toml.bak` rather than overwritten:
 * this is the answer to "an update added a binding my file doesn't have", and
 * losing a year of customizations to fix that would be a bad trade. One backup,
 * replaced each time — a chain of `.bak.bak` helps nobody.
 */
export function resetKeybindings(): string {
  const path = keybindingsPath()
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) renameSync(path, `${path}.bak`)
  writeFileSync(path, generateKeybindings())
  return path
}

/**
 * Point a command at a new chord, from the UI.
 *
 * Edits the entry already in the file rather than appending a second one for the
 * same command: two entries would both be live, and the first would win — so a
 * rebind from the palette would appear to do nothing. Falls back to appending
 * only when the command has no entry at all (one of the unbound suggestions).
 */
export function rebindCommand(command: string, chord: string): void {
  ensureKeybindings()
  const path = keybindingsPath()
  const raw = readFileSync(path, 'utf8')
  const parsed = parseToml<{ keybind?: Array<Record<string, unknown>> }>(raw)
  if (!parsed.ok) throw new Error(`cannot rebind while ${basename(path)} has an error on line ${parsed.error.line}`)
  const key = normalizeChord(chord)
  const index = (parsed.value.keybind ?? []).findIndex((e) => e.command === command)
  writeTomlFile(
    path,
    editToml(raw, [
      index >= 0
        ? { op: 'setInEntry', table: 'keybind', index, key: 'key', value: key }
        : { op: 'appendEntry', table: 'keybind', fields: [['key', key], ['command', command]] }
    ])
  )
}
