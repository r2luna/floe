// `~/.config/floe/floe.toml` — the machine-wide settings.
//
// Everything here is global: how the app looks, which model a new session
// starts on, whether installs are sandboxed. Anything per-project lives in that
// project's own directory under `projects/`, so this file stays short enough to
// read in one screen.
//
// Reading NEVER throws and never leaves a hole: a bad value falls back to its
// default and lands in `errors`, which Settings shows. That is the whole reason
// the app can let agents edit this file.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDir } from '../dataDir'
import { ErrorSink, type ConfigError } from './errors'
import { TableReader, subTable } from './read'
import { editToml, keyLine, parseToml, type TomlValue } from './toml'
import { writeTomlFile } from './io'
import { FLOE_TOML } from './template'
import { DEFAULT_GROUP, NOTIFY_SOUNDS, PENGUIN_COLORS, PENGUIN_HEADS } from '../../shared/types'
import { HARNESSES } from '../../shared/modes'
import { EFFORTS } from '../../shared/types'

export const MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const
export { EFFORTS } from '../../shared/types'
export const THEMES = ['system', 'dark', 'light'] as const

export const PROVIDERS = ['claude', 'codex', 'opencode', 'gemini', 'lmstudio', 'ollama'] as const
// The written names for how much the agent may do. `MODES` in shared/modes.ts
// carries the same four under the ids the CLIs use; these are the words a
// person types in a config file.
// `full` is the pre-rename word for `bypass`; old configs still have to read.
export const MODES = ['plan', 'ask', 'auto', 'bypass', 'full'] as const

/** One harness's own defaults. Both optional: unset means "ask the harness". */
export interface HarnessDefault {
  /**
   * Not validated against a list: only codex and LM Studio can be asked what
   * they run, and a slug we cannot check is still the runtime's own business —
   * the same reasoning as `editor.command`.
   */
  model?: string
  effort?: (typeof EFFORTS)[number]
}

export interface FloeConfig {
  appearance: {
    fontFamily?: string
    fontSize: number
    theme: (typeof THEMES)[number]
    penguin: (typeof PENGUIN_HEADS)[number]
    penguinColor: (typeof PENGUIN_COLORS)[number]
  }
  agent: {
    model: (typeof MODELS)[number]
    effort: (typeof EFFORTS)[number]
    provider: (typeof PROVIDERS)[number]
    mode: (typeof MODES)[number]
    systemPromptFile: string
  }
  /**
   * What each harness answers with when the message names it but not a model —
   * `@codex revisa isso`, or a `[harness.codex]` block in the file.
   *
   * Separate from `agent` on purpose: `agent` is what a NEW SESSION starts on,
   * one harness and one model. This is per harness, and applies whichever
   * session you are in. Absent means the harness's own default.
   */
  harness: Record<string, HarnessDefault>
  /** Who the launcher greets. Empty means "whoever this machine says I am". */
  user: { name?: string }
  terminal: { shell?: string }
  /** The message box: vim motions on or off. */
  composer: { vim: boolean }
  editor: { command: string }
  sandbox: { enabled: boolean }
  notifications: { sound: (typeof NOTIFY_SOUNDS)[number] }
  update: { checkIntervalHours: number }
  projects: { groups: string[] }
  integrations: { jira: { site?: string; email?: string }; bitbucket: { email?: string } }
}

export const DEFAULTS: FloeConfig = {
  // `dark` rather than `system`: dark is what the app has always been and what
  // it is designed at, so following the OS by default would flip an existing
  // user into light on the next launch without them asking for it.
  appearance: { fontFamily: undefined, fontSize: 13, theme: 'system', penguin: 'classic', penguinColor: 'accent' },
  agent: {
    model: 'opus',
    effort: 'high',
    provider: 'claude',
    mode: 'ask',
    systemPromptFile: 'system-prompt.md'
  },
  // Empty, not one entry per harness: a harness with nothing set here is not
  // the same as one set to "" — it means nobody has answered the question.
  harness: {},
  user: { name: undefined },
  terminal: { shell: undefined },
  composer: { vim: false },
  editor: { command: 'nvim' },
  sandbox: { enabled: true },
  notifications: { sound: 'chime' },
  update: { checkIntervalHours: 6 },
  projects: { groups: [DEFAULT_GROUP] },
  // The optional keys are spelled out rather than omitted so this object has the
  // same shape a parse produces — which is what lets a test assert that an empty
  // file and the defaults are the same thing.
  integrations: { jira: { site: undefined, email: undefined }, bitbucket: { email: undefined } }
}

export const floeConfigPath = (): string => join(configDir(), 'floe.toml')

/**
 * Create the file if it isn't there.
 *
 * Generated on every boot rather than on first edit (see the note in
 * keybindings.ts): a config you can't see is a config you don't know you can
 * change, and the app is meant to be driven from these files.
 */
export function ensureFloeConfig(): void {
  const path = floeConfigPath()
  if (existsSync(path)) return
  writeTomlFile(path, FLOE_TOML)
}

/**
 * The group list, with the default guaranteed first.
 *
 * `deleteGroup` moves orphaned projects into it, so it has to exist even in a
 * file where the user removed it.
 */
function withDefaultGroup(groups: string[] | undefined): string[] {
  const rest = (groups ?? []).filter((g) => g && g !== DEFAULT_GROUP)
  return [DEFAULT_GROUP, ...rest]
}

export interface FloeConfigResult {
  config: FloeConfig
  errors: ConfigError[]
}

/**
 * `[harness.codex]`, `[harness.lmstudio]`, … — one block per harness.
 *
 * Only the harnesses Floe can actually run are read. A block for anything else
 * is left alone rather than reported: the file is hand-edited, and a name we do
 * not know today may be a runtime we grow tomorrow.
 *
 * The reader is built by hand rather than through `subTable` so its errors
 * carry the DOTTED header — an effort typo has to point at the line under
 * `[harness.codex]`, not at a `[codex]` table that does not exist.
 */
function readHarnesses(
  sink: ErrorSink,
  raw: string,
  root: Record<string, unknown>
): Record<string, HarnessDefault> {
  const table = root.harness
  if (typeof table !== 'object' || table === null || Array.isArray(table)) {
    if (table !== undefined) sink.add(keyLine(raw, undefined, 'harness'), 'harness must be a table')
    return {}
  }
  const out: Record<string, HarnessDefault> = {}
  for (const id of HARNESSES) {
    const block = (table as Record<string, unknown>)[id]
    if (block === undefined) continue
    if (typeof block !== 'object' || block === null || Array.isArray(block)) {
      sink.add(keyLine(raw, 'harness', id), `harness.${id} must be a table`)
      continue
    }
    const reader = new TableReader(sink, raw, block as Record<string, unknown>, `harness.${id}`)
    const model = reader.optStr('model')?.trim()
    // An empty string is how Settings writes "unset" — it cannot delete a line,
    // and `effort = ""` reading as an error would make the way back out of a
    // choice look like a mistake.
    const effort = reader.str('effort', '').trim() ? reader.optOneOf('effort', EFFORTS) : undefined
    // An empty block is the same as no block — do not put a hole in the map
    // that every reader would then have to check for.
    if (model || effort) out[id] = { model: model || undefined, effort }
  }
  return out
}

/** Parse and validate the file. Missing file means defaults, not an error. */
export function parseFloeConfig(raw: string, file: string): FloeConfigResult {
  const sink = new ErrorSink(file, raw)
  const parsed = parseToml(raw)
  if (!parsed.ok) {
    // A file that doesn't parse gives us nothing to salvage — one unterminated
    // string makes every table after it meaningless. Defaults, and say why.
    sink.add(parsed.error.line, parsed.error.message)
    return { config: DEFAULTS, errors: sink.errors }
  }
  const root = parsed.value as Record<string, unknown>
  const d = DEFAULTS

  const appearance = subTable(sink, raw, root, 'appearance')
  const agent = subTable(sink, raw, root, 'agent')
  const user = subTable(sink, raw, root, 'user')
  const terminal = subTable(sink, raw, root, 'terminal')
  const composer = subTable(sink, raw, root, 'composer')
  const editor = subTable(sink, raw, root, 'editor')
  const sandbox = subTable(sink, raw, root, 'sandbox')
  const notifications = subTable(sink, raw, root, 'notifications')
  const update = subTable(sink, raw, root, 'update')
  const projects = subTable(sink, raw, root, 'projects')
  const harness = readHarnesses(sink, raw, root)
  const integrations = (root.integrations ?? {}) as Record<string, unknown>
  const jira = subTable(sink, raw, integrations, 'jira')
  const bitbucket = subTable(sink, raw, integrations, 'bitbucket')

  return {
    config: {
      appearance: {
        fontFamily: appearance?.optStr('font-family'),
        fontSize: appearance?.num('font-size', d.appearance.fontSize, { min: 6, max: 48 }) ?? d.appearance.fontSize,
        theme: appearance?.oneOf('theme', THEMES, d.appearance.theme) ?? d.appearance.theme,
        penguin: appearance?.oneOf('penguin', PENGUIN_HEADS, d.appearance.penguin) ?? d.appearance.penguin,
        penguinColor:
          appearance?.oneOf('penguin-color', PENGUIN_COLORS, d.appearance.penguinColor) ??
          d.appearance.penguinColor
      },
      agent: {
        model: agent?.oneOf('model', MODELS, d.agent.model) ?? d.agent.model,
        effort: agent?.oneOf('effort', EFFORTS, d.agent.effort) ?? d.agent.effort,
        provider: agent?.oneOf('provider', PROVIDERS, d.agent.provider) ?? d.agent.provider,
        mode: agent?.oneOf('mode', MODES, d.agent.mode) ?? d.agent.mode,
        systemPromptFile: agent?.str('system-prompt', d.agent.systemPromptFile) ?? d.agent.systemPromptFile
      },
      harness,
      // Blank is not a name: an emptied box means "go back to the machine's",
      // which is the same state as never having set one.
      user: { name: user?.optStr('name')?.trim() || undefined },
      terminal: { shell: terminal?.optStr('shell') },
      composer: { vim: composer?.bool('vim', d.composer.vim) ?? d.composer.vim },
      // Not `oneOf`: the known ids are what Settings offers, not the whole set —
      // any editor binary on the machine is a valid answer here.
      editor: { command: editor?.str('command', d.editor.command) ?? d.editor.command },
      sandbox: { enabled: sandbox?.bool('enabled', d.sandbox.enabled) ?? d.sandbox.enabled },
      notifications: {
        sound:
          notifications?.oneOf('sound', NOTIFY_SOUNDS, d.notifications.sound) ??
          d.notifications.sound
      },
      update: {
        checkIntervalHours:
          update?.num('check-interval-hours', d.update.checkIntervalHours, { min: 0.25, max: 168 }) ??
          d.update.checkIntervalHours
      },
      projects: { groups: withDefaultGroup(projects?.strArray('groups')) },
      integrations: {
        jira: { site: jira?.optStr('site'), email: jira?.optStr('email') },
        bitbucket: { email: bitbucket?.optStr('email') }
      }
    },
    errors: sink.errors
  }
}

// One parse per change, not one per read: `sandbox.enabled` is consulted on
// every install and the file only moves when someone edits it.
let cached: FloeConfigResult | null = null

export function floeConfig(): FloeConfig {
  return floeConfigResult().config
}

export function floeConfigResult(): FloeConfigResult {
  if (cached) return cached
  const path = floeConfigPath()
  if (!existsSync(path)) {
    cached = { config: DEFAULTS, errors: [] }
    return cached
  }
  cached = parseFloeConfig(readFileSync(path, 'utf8'), path)
  return cached
}

/** Drop the cache — the file watcher calls this when the file changes on disk. */
export function invalidateFloeConfig(): void {
  cached = null
}

/**
 * Change one setting, in place.
 *
 * Goes through the surgical editor so the block comments survive: this is what
 * Settings calls when a toggle flips, and the user's documented file must come
 * back looking the way they left it, one value different.
 */
export function setFloeValue(table: string, key: string, value: TomlValue): void {
  ensureFloeConfig()
  const path = floeConfigPath()
  const raw = readFileSync(path, 'utf8')
  writeTomlFile(path, editToml(raw, [{ op: 'set', table, key, value }]))
  invalidateFloeConfig()
}

export type { TableReader }
