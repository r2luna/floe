// Which editor the `e` key opens, and how to reach it.
//
// Two kinds of editor, one setting. A terminal editor (nvim, vim, helix) runs
// inside the file panel on the app's own PTY — the panel BECOMES the editor.
// A GUI editor (VS Code, Zed, Sublime) can't live in a panel, so it is launched
// as a separate app with the file and line it should land on.
//
// `[editor] command` in floe.toml names one of the known ids below, or any
// binary of your own. An unknown name is treated as a terminal editor: that is
// the assumption that can be made safely about an arbitrary command, since a
// GUI launcher we guessed wrong about would open nothing and say nothing.

import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { floeConfig } from './config/floe'

export interface EditorSpec {
  /** What `[editor] command` is set to. */
  id: string
  /** The binary to run — a name we look up on PATH, or an absolute path. */
  bin: string
  /** True when it draws in a terminal, i.e. it runs in the panel's PTY. */
  terminal: boolean
  /** Extra places to look when PATH is the minimal one a GUI launch inherits. */
  fallbacks?: string[]
  /** How this editor is told to open a file, optionally on a line. */
  args?: (file: string, line: number | null) => string[]
}

// The editors offered in Settings. Anything else the user types still works —
// see `editorSpec` — this list is what we know how to find and how to aim.
export const KNOWN_EDITORS: EditorSpec[] = [
  { id: 'nvim', bin: 'nvim', terminal: true },
  { id: 'vim', bin: 'vim', terminal: true },
  { id: 'helix', bin: 'hx', terminal: true },
  {
    id: 'vscode',
    bin: 'code',
    terminal: false,
    fallbacks: ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'],
    // `-g file:line` reuses the open window instead of stacking a new one.
    args: (file, line) => ['--goto', line ? `${file}:${line}` : file]
  },
  {
    id: 'zed',
    bin: 'zed',
    terminal: false,
    fallbacks: ['/Applications/Zed.app/Contents/MacOS/cli'],
    args: (file, line) => [line ? `${file}:${line}` : file]
  },
  {
    id: 'sublime',
    bin: 'subl',
    terminal: false,
    fallbacks: ['/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl'],
    args: (file, line) => [line ? `${file}:${line}` : file]
  }
]

/** The spec for a configured command — a known id, or a terminal editor by that name. */
export function editorSpec(command: string): EditorSpec {
  const name = command.trim()
  const known = KNOWN_EDITORS.find((e) => e.id === name || e.bin === name)
  if (known) return known
  return { id: name, bin: name, terminal: true }
}

/** The configured editor, defaulting through the config's own default. */
export function currentEditor(): EditorSpec {
  return editorSpec(floeConfig().editor.command)
}

// A GUI launch inherits a minimal PATH, so `which` alone misses Homebrew and the
// editors' own CLI shims. Look through the usual bin directories too before
// giving up, and cache the answer — an editor does not move while the app runs.
const RESOLVE_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/snap/bin']
const cache = new Map<string, string | undefined>()

export function resolveEditorBin(spec: EditorSpec): string | undefined {
  if (cache.has(spec.id)) return cache.get(spec.id)
  const found = lookup(spec)
  cache.set(spec.id, found)
  return found
}

function lookup(spec: EditorSpec): string | undefined {
  if (spec.bin.includes('/')) return existsSync(spec.bin) ? spec.bin : undefined
  try {
    const out = execFileSync('/usr/bin/which', [spec.bin], { encoding: 'utf8' }).trim()
    if (out) return out
  } catch {
    /* not on PATH — keep looking */
  }
  for (const dir of RESOLVE_DIRS) {
    const path = join(dir, spec.bin)
    if (existsSync(path)) return path
  }
  return spec.fallbacks?.find((path) => existsSync(path))
}

/** Drop the resolution cache — the config watcher calls this on a change. */
export function invalidateEditorCache(): void {
  cache.clear()
}

export interface LaunchResult {
  /** 'panel' means the caller should open the in-app editor panel instead. */
  mode: 'panel' | 'external'
  /** Set when an external launch could not happen, for the caller to show. */
  error?: string
}

/**
 * Open `file` in the configured editor when that editor is a GUI one.
 *
 * Terminal editors are not launched here: they belong in the panel's PTY, so
 * this reports `panel` and the renderer opens the editor panel.
 */
export function launchEditor(cwd: string, file: string, line?: number): LaunchResult {
  const spec = currentEditor()
  if (spec.terminal) return { mode: 'panel' }

  const bin = resolveEditorBin(spec)
  if (!bin) return { mode: 'external', error: `${spec.id}: could not find \`${spec.bin}\` on this machine` }

  const at = Number.isInteger(line) && (line as number) > 0 ? (line as number) : null
  const args = spec.args ? spec.args(file, at) : [file]
  // Detached: the editor outlives this app, and a GUI editor that is already
  // running usually forks straight back anyway.
  execFile(bin, args, { cwd }, () => {
    /* the editor's own exit code is not ours to report */
  })
  return { mode: 'external' }
}

/**
 * The keystrokes that make a RUNNING terminal editor open another file.
 *
 * One editor per worktree means the second file you open has to reach the
 * session already on screen. Vim-likes take `:edit`; helix takes `:open`.
 * Anything else gets null — we don't type guesses into an unknown program.
 */
export function editKeys(spec: EditorSpec, file: string, line: number | null): string | null {
  // Build the path through the editor's own escaping (fnameescape / quoting)
  // rather than interpolating it raw, so spaces and metacharacters in a
  // filename cannot break out of the command.
  const quoted = file.replace(/'/g, "''") // vimscript single-quote escape
  if (spec.id === 'nvim' || spec.id === 'vim') {
    // Escape first: the editor may be in insert mode.
    return `\x1b:execute 'edit ' . fnameescape('${quoted}')\r` + (line ? `\x1b:${line}\r` : '')
  }
  if (spec.id === 'helix') {
    return `\x1b:open ${file.replace(/(["\s'\\])/g, '\\$1')}\r` + (line ? `\x1b:${line}\r` : '')
  }
  return null
}

/** The argv a fresh terminal editor is spawned with. */
export function spawnArgs(spec: EditorSpec, file: string | null, line: number | null): string[] {
  if (!file) return []
  // `--` terminates option parsing so a file named like `-c`/`+cmd` can't
  // smuggle a flag into the editor's argv. `+<line>` must precede it.
  // helix has no `+line`; it takes the line in the path itself.
  if (spec.id === 'helix') return ['--', line ? `${file}:${line}` : file]
  return [...(line ? [`+${line}`] : []), '--', file]
}
