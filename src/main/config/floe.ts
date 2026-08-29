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
import { editToml, parseToml, type TomlValue } from './toml'
import { writeTomlFile } from './io'
import { FLOE_TOML } from './template'
import { DEFAULT_GROUP } from '../../shared/types'

export const MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const THEMES = ['system', 'dark', 'light'] as const

export const PROVIDERS = ['claude', 'codex', 'opencode', 'gemini', 'lmstudio', 'ollama'] as const
// The written names for how much the agent may do. `MODES` in shared/modes.ts
// carries the same four under the ids the CLIs use; these are the words a
// person types in a config file.
export const MODES = ['plan', 'ask', 'auto', 'full'] as const

export interface FloeConfig {
  appearance: { fontFamily?: string; fontSize: number; theme: (typeof THEMES)[number] }
  agent: {
    model: (typeof MODELS)[number]
    effort: (typeof EFFORTS)[number]
    provider: (typeof PROVIDERS)[number]
    mode: (typeof MODES)[number]
    systemPromptFile: string
  }
  terminal: { shell?: string }
  editor: { command: string }
  sandbox: { enabled: boolean }
  update: { checkIntervalHours: number }
  projects: { groups: string[] }
  integrations: { jira: { site?: string; email?: string }; bitbucket: { email?: string } }
}

export const DEFAULTS: FloeConfig = {
  // `dark` rather than `system`: dark is what the app has always been and what
  // it is designed at, so following the OS by default would flip an existing
  // user into light on the next launch without them asking for it.
  appearance: { fontFamily: undefined, fontSize: 13, theme: 'dark' },
  agent: {
    model: 'opus',
    effort: 'high',
    provider: 'claude',
    mode: 'ask',
    systemPromptFile: 'system-prompt.md'
  },
  terminal: { shell: undefined },
  editor: { command: 'nvim' },
  sandbox: { enabled: true },
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
  const terminal = subTable(sink, raw, root, 'terminal')
  const editor = subTable(sink, raw, root, 'editor')
  const sandbox = subTable(sink, raw, root, 'sandbox')
  const update = subTable(sink, raw, root, 'update')
  const projects = subTable(sink, raw, root, 'projects')
  const integrations = (root.integrations ?? {}) as Record<string, unknown>
  const jira = subTable(sink, raw, integrations, 'jira')
  const bitbucket = subTable(sink, raw, integrations, 'bitbucket')

  return {
    config: {
      appearance: {
        fontFamily: appearance?.optStr('font-family'),
        fontSize: appearance?.num('font-size', d.appearance.fontSize, { min: 6, max: 48 }) ?? d.appearance.fontSize,
        theme: appearance?.oneOf('theme', THEMES, d.appearance.theme) ?? d.appearance.theme
      },
      agent: {
        model: agent?.oneOf('model', MODELS, d.agent.model) ?? d.agent.model,
        effort: agent?.oneOf('effort', EFFORTS, d.agent.effort) ?? d.agent.effort,
        provider: agent?.oneOf('provider', PROVIDERS, d.agent.provider) ?? d.agent.provider,
        mode: agent?.oneOf('mode', MODES, d.agent.mode) ?? d.agent.mode,
        systemPromptFile: agent?.str('system-prompt', d.agent.systemPromptFile) ?? d.agent.systemPromptFile
      },
      terminal: { shell: terminal?.optStr('shell') },
      // Not `oneOf`: the known ids are what Settings offers, not the whole set —
      // any editor binary on the machine is a valid answer here.
      editor: { command: editor?.str('command', d.editor.command) ?? d.editor.command },
      sandbox: { enabled: sandbox?.bool('enabled', d.sandbox.enabled) ?? d.sandbox.enabled },
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
