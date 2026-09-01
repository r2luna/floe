// Which model answers, and how hard it thinks.
//
// Both are passed straight through to the CLI (`--model`, `--effort`), so the
// ids here are the CLI's own aliases rather than full model names — the CLI
// resolves them to whatever the current release points at, which means this
// list does not go stale every time a model ships.

import { EFFORTS, type Effort, type PermissionMode } from '../../shared/types'
import { DEFAULT_MODE, MODES, modeFromLabel, modeLabel, nearestMode } from '../../shared/modes.ts'

export interface ModelChoice {
  model: string
  effort: Effort
  /**
   * Which runtime answers. Absent means Claude — the default, and what every
   * choice saved before other runtimes existed reads as.
   */
  provider?: string
  /**
   * How much the runtime is allowed to do. Absent means a choice saved before
   * the mode picker existed, which reads as the safe middle: ask first.
   */
  mode?: PermissionMode
}

export const MODELS: { id: string; label: string }[] = [
  { id: 'fable', label: 'Fable 5' },
  { id: 'opus', label: 'Opus 5' },
  { id: 'sonnet', label: 'Sonnet 5' },
  { id: 'haiku', label: 'Haiku 4.5' }
]

// One list, in shared/types.ts — main reads it out of floe.toml and the handle
// parser tells an effort from a model name by membership in it.
export { EFFORTS } from '../../shared/types'

/**
 * The built-in fallback, used until floe.toml has been read and whenever it says
 * nothing useful. Not what a new session starts on — that is `defaultChoice()`.
 */
export const DEFAULT_CHOICE: ModelChoice = { model: 'opus', effort: 'high', mode: DEFAULT_MODE }

// `[agent]` from floe.toml, pushed in at boot rather than read here: the config
// arrives over async IPC and `loadChoice` is called synchronously from render.
let configured: ModelChoice = DEFAULT_CHOICE

// Who the user is called in the chat, on the same rule as the launcher's
// greeting: `[user] name` from floe.toml, or what the machine says. Pushed in
// from appearance.ts for the same reason as the choice above — the transcript
// names its speaker from a synchronous render path.
let nick = 'you'

/** Install the user's nick. Lower-cased: these are IRC nicks, not signatures. */
export function setUserNick(name: string): void {
  nick = name.trim().toLowerCase() || 'you'
}

/** The user's nick, for the `nick!ident@host` a transcript entry is headed by. */
export function userNick(): string {
  return nick
}

/** Install the configured default. Called at boot and whenever the file changes. */
export function setDefaultChoice(agent: {
  model: string
  effort: string
  provider: string
  mode: string
}): void {
  const effort = EFFORTS.includes(agent.effort as Effort) ? (agent.effort as Effort) : DEFAULT_CHOICE.effort
  const provider = agent.provider && agent.provider !== 'claude' ? agent.provider : undefined
  // Snapped, not trusted: floe.toml can name a mode the configured runtime
  // cannot do, and a new session must not start on a flag that fails the turn.
  const mode = nearestMode(modeFromLabel(agent.mode) ?? DEFAULT_MODE, provider)
  configured = provider ? { model: agent.model, effort, provider, mode } : { model: agent.model, effort, mode }
}

/** What a new session starts on: the config, or the built-in fallback. */
export function defaultChoice(): ModelChoice {
  return configured
}

// `[harness.*]` from floe.toml — what each harness answers with when a message
// names it without naming a model. Module state for the same reason as the
// choice above: `routeChoice` is called from a keystroke handler, not from an
// effect that could await the file.
let harnessDefaults: Record<string, { model?: string; effort?: string }> = {}

/** Install the per-harness defaults. Called from applyConfig, same as the rest. */
export function setHarnessDefaults(harness: Record<string, { model?: string; effort?: string }>): void {
  harnessDefaults = harness
}

/** What `[harness.<id>]` says, or nothing. */
export function harnessDefault(id: string): { model?: string; effort?: Effort } {
  const set = harnessDefaults[id]
  if (!set) return {}
  return {
    model: set.model,
    effort: EFFORTS.includes(set.effort as Effort) ? (set.effort as Effort) : undefined
  }
}

/**
 * The choice a message that opens with `@harness` goes out on.
 *
 * Three sources, narrowest first: what the message itself named, then that
 * harness's block in floe.toml, then the composer's own effort — which is the
 * one thing the user set most recently and would be surprised to lose.
 *
 * The model does NOT fall back to the composer's: `opus` means nothing to
 * Ollama. Claude borrows the configured default rather than being sent an empty
 * `--model`; everything else gets an empty one, which each harness reads as
 * "whatever you are set to" — the CLIs use their own configured model and LM
 * Studio uses whichever is loaded.
 *
 * Nothing is invented for the two that want a model NAMED (see NEEDS_MODEL).
 * Standing the first one on the list in would pick by alphabet — here, a model
 * far too big to load — and turn a clear "no model loaded" into a two-minute
 * wait that ends in "insufficient system resources". Name it in
 * `[harness.ollama]`, or in the handle.
 */
export function routeChoice(
  route: { harness: string; model?: string; effort?: Effort },
  from: ModelChoice
): ModelChoice {
  const set = harnessDefault(route.harness)
  const claude = route.harness === 'claude'
  const model = route.model ?? set.model ?? (claude ? defaultChoice().model : '')
  return {
    model,
    effort: route.effort ?? set.effort ?? from.effort,
    provider: claude ? undefined : route.harness,
    // The mode you are on keeps travelling, snapped to what this harness can
    // honestly do — the same rule as switching harness in the picker.
    mode: nearestMode(from.mode ?? DEFAULT_MODE, claude ? undefined : route.harness)
  }
}

const KEY = 'floe.model'

/** The last choice made, or the default. Bad JSON falls back rather than throws. */
export function loadChoice(): ModelChoice {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return defaultChoice()
    const parsed = JSON.parse(raw) as Partial<ModelChoice>
    const effort = EFFORTS.includes(parsed.effort as Effort)
      ? (parsed.effort as Effort)
      : defaultChoice().effort
    // No saved mode falls back to the CONFIGURED one, not to the built-in: a
    // floe.toml that says `full` has to survive a choice saved before the mode
    // picker existed, or the setting would look like it does nothing.
    // Then snapped to the saved runtime, since the two are picked independently
    // and a stale pair would otherwise send `plan` to gemini.
    const wanted = MODES.some((m) => m.id === parsed.mode)
      ? (parsed.mode as PermissionMode)
      : (defaultChoice().mode ?? DEFAULT_MODE)
    const mode = nearestMode(wanted, parsed.provider)
    // Another runtime's model cannot be checked against MODELS — that list is
    // Claude's. Trust it: it came from that tool's own catalogue when it was
    // picked, and the runtime itself is the only honest judge of it now.
    // An empty model is meaningful for another runtime: "whatever you are
    // configured for". Only Claude requires a named model.
    if (parsed.provider && parsed.provider !== 'claude')
      return { model: parsed.model ?? '', effort, provider: parsed.provider, mode }
    // Claude's own aliases ARE checkable, and an id we no longer offer would be
    // passed to the CLI verbatim and fail the turn.
    const model = MODELS.some((m) => m.id === parsed.model) ? parsed.model! : defaultChoice().model
    return { model, effort, mode }
  } catch {
    return defaultChoice()
  }
}

export function saveChoice(choice: ModelChoice): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(choice))
  } catch {
    /* private mode or a full quota — the choice just won't outlive the window */
  }
}

/**
 * The choice the last answer in a transcript went out with.
 *
 * A session answers as whoever answered it last, so reopening one must point
 * the composer back at that model — not at whatever was picked in some other
 * chat, which is what a single saved choice would do. Null when the transcript
 * names nothing we can act on: guessing is worse than leaving the picker be.
 */
export function lastChoice(
  items: { role: string; model?: string; effort?: string; provider?: string }[]
): ModelChoice | null {
  const last = [...items].reverse().find((i) => i.role === 'assistant' && i.model)
  if (!last?.model) return null
  const effort = EFFORTS.includes(last.effort as Effort)
    ? (last.effort as Effort)
    : defaultChoice().effort
  // Another runtime logs the slug it was given, which is the same string the
  // picker sends back.
  if (last.provider && last.provider !== 'claude')
    return { model: last.model, effort, provider: last.provider }
  // Claude stamps the concrete id it resolved (`claude-opus-5-20260101`), never
  // the alias you pick; the CLI only accepts the alias back.
  const alias = MODELS.find((m) => last.model!.includes(m.id))
  return alias ? { model: alias.id, effort } : null
}

/** The short label for a model id, for the composer button. */
export function labelOf(model: string): string {
  // An empty model means "whatever that runtime is set to" — it still needs a
  // word on the button.
  return MODELS.find((m) => m.id === model)?.label ?? (model || 'default')
}

/**
 * The model, as an IRC host.
 *
 * On IRC a line is `nick@host` and the host says where the person is speaking
 * from — which is exactly what a model is here. So the transcript prints
 * `claude@opus-5`, and the vendor prefix and the release date go: they are the
 * parts that say nothing about who answered.
 *
 * A synthetic reply (the CLI answering /usage itself) has no model, so it gets
 * no host rather than a made-up one.
 */
export function hostOf(model?: string): string | undefined {
  if (!model || model === '<synthetic>') return undefined
  return (
    model
      // claude-opus-5 → opus-5, and gpt-5.6-sol survives untouched.
      .replace(/^(claude|anthropic)[-/]/, '')
      // A trailing release stamp: claude-haiku-4-5-20251001 → haiku-4-5.
      .replace(/-\d{8}$/, '')
      .toLowerCase() || undefined
  )
}

/**
 * The full IRC address for a message: `nick!ident@host`.
 *
 * IRC gives a speaker three parts, and a turn here has exactly three facts
 * worth naming — who answered, how hard it was told to think, and which model
 * it ran on. `claude!max@opus-5`.
 *
 * Each part is dropped when it is unknown rather than filled in with a guess:
 * a synthetic reply has no model and no effort, and prints as a bare nick.
 */
export function addressOf(
  nick: string,
  model?: string,
  effort?: string
): { nick: string; ident?: string; host?: string } {
  const host = hostOf(model)
  // No host means nothing ran — an effort on its own would describe a turn that
  // never happened.
  return { nick, ident: host ? effort : undefined, host }
}

/**
 * Two messages are the same speaker only if all three parts match.
 *
 * This is what decides whether a run of messages prints one header or several:
 * on IRC the same nick from a different host is a different speaker, and here
 * that is literally true — `claude!high@opus-5` and `claude!low@sonnet-5` are
 * not the same thing answering you.
 */
export function speakerKey(who: { nick: string; ident?: string; host?: string }): string {
  return `${who.nick}!${who.ident ?? ''}@${who.host ?? ''}`
}

// Claude's own windows, by alias. The only hardcoded numbers left: the claude
// CLI does not report a model's context size anywhere we can read, unlike codex
// (its model cache states it) and LM Studio (its API does).
// ponytail: update when a model ships with a different window. A wrong number
// here makes the gauge lie by a percentage, not break.
const CLAUDE_WINDOWS: Record<string, number> = {
  fable: 1_000_000,
  opus: 1_000_000,
  sonnet: 1_000_000,
  haiku: 200_000
}

/**
 * How much context the chosen model has, or undefined when nobody says.
 *
 * The gauge is meaningless without the right denominator: a 262k local model
 * measured against Claude's million reads as almost empty when it is nearly
 * full. So the window comes from whoever knows it — the runtime for its own
 * models, this table for Claude's.
 */
export function windowOf(
  choice: ModelChoice,
  agents: { id: string; models: { slug: string; contextWindow?: number }[] }[]
): number | undefined {
  if (!choice.provider || choice.provider === 'claude') return CLAUDE_WINDOWS[choice.model]
  const agent = agents.find((a) => a.id === choice.provider)
  return agent?.models.find((m) => m.slug === choice.model)?.contextWindow
}

/**
 * What the composer's picker button says: harness, model, effort.
 *
 * The harness leads because it is the part that changes what you get. Without
 * it, a runtime whose model we cannot name reads as "default" — a word that
 * answers nothing: default of what?
 */
export function describeChoice(choice: ModelChoice): {
  harness: string
  model: string
  effort: string
  mode: string
} {
  const harness = choice.provider ?? 'claude'
  return {
    harness,
    mode: modeLabel(choice.mode ?? DEFAULT_MODE),
    // Claude's aliases have proper labels; another runtime's slug is already
    // its own name. An empty model means the runtime's own configured one,
    // which has no name to show here — the harness alone is the answer.
    model: harness === 'claude' ? labelOf(choice.model) : choice.model,
    effort: choice.effort
  }
}
