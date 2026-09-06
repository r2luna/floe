// The colony board's stages — three layers, each falling back to the one above.
//
//   1. the built-in default below, so a fresh install has a working board;
//   2. `[colony]` in `~/.config/floe/floe.toml`, the user's own default;
//   3. `~/.config/floe/projects/<dir>/colony.toml`, this project's board.
//
// Two rules make the merge readable (spec D10, D11):
//
//   THE STAGE LIST IS ALL-OR-NOTHING. A layer that declares any stage replaces
//   the inherited list entirely. Patching an ordered list needs identity and
//   position rules nobody can read at a glance; replacing is one rule, and the
//   file shows exactly what the board is.
//
//   SCALARS INHERIT. `cap` unset in the project file means the global one, and
//   unset there means the built-in — so "same stages, lower cap here" is one
//   line rather than a copied list.
//
// `inbox` and `done` are never written in config (D12): they are the ends of any
// board, not stages, and declaring them would invite deleting them.
//
// Reading never throws (D14). A bad value falls back and lands in `errors`,
// which is the whole reason an agent is allowed to edit these files.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDir } from '../dataDir'
import { ErrorSink, type ConfigError } from './errors'
import { TableReader, subTable } from './read'
import { keyLine, parseToml } from './toml'
import { PROVIDERS } from './floe'
import { projectScan } from './projectStore'

/** One column of the board: a name, and the three things that ARE its behaviour. */
export interface ColonyStage {
  /** The column label. Free text — it is a label, not an identity. */
  name: string
  /** The FLOE skill that runs when a task enters (D17), not a harness's slash command. */
  skill: string
  /** Unset falls through to the session default, same as `model` (D16). */
  harness?: (typeof PROVIDERS)[number]
  /** That harness's own slug. Unset means whatever a new session would have used. */
  model?: string
  /** How many tasks this stage WORKS at once. Unset inherits the board's cap. */
  cap?: number
  /**
   * Dropped from config while tasks still sit in it (D13). It keeps its column,
   * greyed and capped at 0, until it drains — no task disappears because
   * somebody edited a file.
   */
  retired?: boolean
}

export interface ColonyConfig {
  /** The default cap for a stage that does not set its own. */
  cap: number
  stages: ColonyStage[]
}

/** The two fixed ends of any board: backlog and exit. Never stages. */
export const INBOX = 'inbox'
export const DONE = 'done'

/**
 * Layer 1. It names BUILT-IN skills on purpose (D18): a default board pointing
 * at skills the user has not written yet would be a board that cannot run.
 */
export const DEFAULT_COLONY: ColonyConfig = {
  cap: 5,
  stages: [
    { name: 'specifier', skill: 'colony-specify', model: 'opus' },
    { name: 'coder', skill: 'colony-implement', model: 'opus' },
    { name: 'cleaner', skill: 'colony-refactor', model: 'opus', cap: 1 },
    { name: 'architect', skill: 'colony-architecture', model: 'sonnet' },
    { name: 'hardener', skill: 'colony-review', model: 'opus' },
    { name: 'qa', skill: 'colony-verify', model: 'haiku' }
  ]
}

export const colonyPath = (dir: string): string => join(dir, 'colony.toml')

/** What one layer contributes. `stages` undefined means "declared none" — see D10. */
interface Layer {
  cap?: number
  stages?: ColonyStage[]
}

/**
 * Read the `[[stage]]` entries of one table.
 *
 * `table` is the dotted header errors point at, so the global file's mistakes
 * land under `[[colony.stage]]` and the project file's under `[[stage]]`.
 */
function readStages(
  sink: ErrorSink,
  raw: string,
  entries: unknown,
  table: string
): ColonyStage[] | undefined {
  if (entries === undefined) return undefined
  if (!Array.isArray(entries)) {
    sink.add(keyLine(raw, undefined, table.split('.').pop() ?? table), `${table} must be a list of [[${table}]] entries`)
    return undefined
  }
  const stages: ColonyStage[] = []
  const taken = new Set<string>()
  entries.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) return
    const t = new TableReader(sink, raw, entry as Record<string, unknown>, table, index)
    const name = t.optStr('name')?.trim()
    const skill = t.optStr('skill')?.trim()
    if (!name || !skill) {
      t.reject(name ? 'skill' : 'name', 'a stage needs both a name and a skill')
      return
    }
    // The two ends are the board's, not the user's. Silently accepting one here
    // would let a file delete the backlog by shadowing it.
    if (name === INBOX || name === DONE) {
      t.reject('name', `${INBOX} and ${DONE} are the board's own ends — they cannot be declared as stages`)
      return
    }
    if (taken.has(name)) {
      t.reject('name', `two stages are both called "${name}" — the name is how a lane is addressed`)
      return
    }
    taken.add(name)
    stages.push({
      name,
      skill,
      harness: t.optOneOf('harness', PROVIDERS),
      model: t.optStr('model')?.trim() || undefined,
      cap: t.has('cap') ? t.num('cap', 1, { min: 0, max: 50 }) : undefined
    })
  })
  return stages
}

/** `[colony]` in floe.toml — the machine-wide board. */
export function parseGlobalColony(raw: string, file: string): { layer: Layer; errors: ConfigError[] } {
  const sink = new ErrorSink(file, raw)
  const parsed = parseToml(raw)
  if (!parsed.ok) {
    sink.add(parsed.error.line, parsed.error.message)
    return { layer: {}, errors: sink.errors }
  }
  const root = parsed.value as Record<string, unknown>
  const colony = subTable(sink, raw, root, 'colony')
  if (!colony) return { layer: {}, errors: sink.errors }
  return {
    layer: {
      cap: colony.has('cap') ? colony.num('cap', DEFAULT_COLONY.cap, { min: 1, max: 50 }) : undefined,
      stages: readStages(sink, raw, colony.raw_('stage'), 'colony.stage')
    },
    errors: sink.errors
  }
}

/** `~/.config/floe/projects/<dir>/colony.toml` — one project's board. */
export function parseProjectColony(raw: string, file: string): { layer: Layer; errors: ConfigError[] } {
  const sink = new ErrorSink(file, raw)
  const parsed = parseToml(raw)
  if (!parsed.ok) {
    sink.add(parsed.error.line, parsed.error.message)
    return { layer: {}, errors: sink.errors }
  }
  const root = parsed.value as Record<string, unknown>
  const t = new TableReader(sink, raw, root)
  return {
    layer: {
      cap: t.has('cap') ? t.num('cap', DEFAULT_COLONY.cap, { min: 1, max: 50 }) : undefined,
      stages: readStages(sink, raw, root.stage, 'stage')
    },
    errors: sink.errors
  }
}

/** Fold the layers, newest winning. Exported for the test, and for one rule in one place. */
export function mergeColony(layers: Layer[]): ColonyConfig {
  let cap = DEFAULT_COLONY.cap
  let stages = DEFAULT_COLONY.stages
  for (const layer of layers) {
    if (layer.cap !== undefined) cap = layer.cap
    // Length matters, not presence: a file with `[[stage]]` entries that were all
    // rejected has declared nothing usable, and inheriting beats an empty board.
    if (layer.stages && layer.stages.length) stages = layer.stages
  }
  return { cap, stages }
}

export interface ColonyResult extends ColonyConfig {
  /** Where this project's own file is, or would be. Null when the project isn't tracked. */
  path: string | null
  errors: ConfigError[]
}

/**
 * The board for one project.
 *
 * Uncached on purpose, unlike `floeConfig()`: this is read when the board paints
 * and when a lane finishes, not on every install, and the two files behind it are
 * hand-edited between those moments.
 */
/**
 * Layer 2 on its own, so Settings can report `[colony]`'s mistakes ONCE.
 *
 * `colonyConfig` folds it into every project's result, which is right for the
 * board and wrong for an error list — a typo in the machine-wide file would be
 * listed once per project you have added.
 */
export function globalColony(): { layer: Layer; errors: ConfigError[] } {
  const path = join(configDir(), 'floe.toml')
  if (!existsSync(path)) return { layer: {}, errors: [] }
  return parseGlobalColony(readFileSync(path, 'utf8'), path)
}

export function colonyConfig(projectPath: string): ColonyResult {
  const global = globalColony()
  const errors: ConfigError[] = [...global.errors]
  const layers: Layer[] = [global.layer]

  const dir = projectScan().byPath.get(projectPath)
  const path = dir ? colonyPath(dir) : null
  if (path && existsSync(path)) {
    const read = parseProjectColony(readFileSync(path, 'utf8'), path)
    layers.push(read.layer)
    errors.push(...read.errors)
  }

  return { ...mergeColony(layers), path, errors }
}

/** How many tasks a stage works at once — its own cap, or the board's. */
export function capOf(stage: ColonyStage, config: ColonyConfig): number {
  if (stage.retired) return 0
  return stage.cap ?? config.cap
}

/**
 * The board's columns for a project whose tasks sit in `occupied` stages.
 *
 * A stage a config edit removed is added back, retired, when a task is still in
 * it (D13) — after the stages it can no longer be reached from, in the order the
 * file last had them, which is the best guess available once the file forgot.
 */
export function columnsFor(config: ColonyConfig, occupied: Iterable<string>): ColonyStage[] {
  const known = new Set(config.stages.map((s) => s.name))
  const retired: ColonyStage[] = []
  for (const name of occupied) {
    if (name === INBOX || name === DONE || known.has(name)) continue
    known.add(name)
    retired.push({ name, skill: '', cap: 0, retired: true })
  }
  return [...config.stages, ...retired]
}
