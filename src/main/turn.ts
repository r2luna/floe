// Starting a turn, whichever door the prompt came in through.
//
// Two doors reach this: the composer, over `agent:start`, and an agent calling
// the MCP `send_message`. Everything that has to be true of a turn regardless
// of which one it was — skills expanded, the handle at the front read, the
// right harness picked — belongs here rather than in either door, or the two
// drift and "could an agent do this without the UI?" stops being answerable.

import type { BrowserWindow } from 'electron'
import {
  isCodexModel,
  type AgentRunOptions,
  type Effort,
  type FileAttachment,
  type ImageAttachment
} from '../shared/types'
import { HARNESSES, nearestMode } from '../shared/modes'
import { routeAt, type Route } from '../shared/mentions'
import { sendToAgent } from './agent'
import { runRuntime } from './runtimes'
import { expandSkills } from '../shared/skills'
import { readSkill } from './config/skills'
import { projectFor } from './config/projectStore'
import { floeConfig } from './config/floe'
import { getCreatedSession } from './sessionStore'

/**
 * The handle this prompt opens with, if it opens with one.
 *
 * Read against every harness Floe can run, not the ones this machine has
 * installed: an agent naming a harness that is not here should be told so by
 * that harness's own "not found", not silently answered by Claude.
 */
export const routeOf = (prompt: string): Route | null => routeAt(prompt, HARNESSES)

/**
 * What a routed message runs on: what the handle named, then `[harness.<id>]`
 * from floe.toml, then what the session itself is set to.
 *
 * The session's own effort travels because it is the part a person last chose;
 * its MODEL does not, because a model belongs to one harness — `opus` means
 * nothing to Ollama. Claude is the exception: it needs a name, so it falls back
 * to the configured default rather than being sent an empty `--model`.
 */
export function optionsForRoute(route: Route, sessionId?: string): AgentRunOptions {
  const config = floeConfig()
  const set = config.harness[route.harness] ?? {}
  const session = sessionId ? getCreatedSession(sessionId) : undefined
  const claude = route.harness === 'claude'
  const model = route.model ?? set.model ?? (claude ? config.agent.model : '')
  const effort = route.effort ?? set.effort ?? session?.effort ?? (config.agent.effort as Effort)
  return {
    model,
    effort,
    provider: claude ? 'claude' : route.harness,
    // The mode the session is on keeps travelling, snapped to what this harness
    // can honestly do — the same rule as changing harness in the picker.
    permissionMode: nearestMode(session?.permissionMode ?? 'skip', claude ? undefined : route.harness)
  }
}

/**
 * Run one turn.
 *
 * Skills expand ABOVE the provider split, because that is the whole reason they
 * live in Floe's config: `/deploy` has to mean the same thing whichever CLI
 * answers. Expanding per runtime would be four copies of one rule.
 */
export function startTurn(
  win: BrowserWindow,
  key: string,
  worktreePath: string,
  prompt: string,
  options: AgentRunOptions,
  images: ImageAttachment[] = [],
  files: FileAttachment[] = []
): void {
  const expanded = expandSkills(prompt, (name) => readSkill(name, projectFor(worktreePath) ?? undefined))
  // Anything but Claude runs on the machine's own runtime and answers over the
  // same agent:event channel. The provider is stated by the caller;
  // `isCodexModel` stays only as the fallback for a choice made before
  // providers existed (a persisted model with no provider beside it).
  const provider = options.provider ?? (isCodexModel(options.model) ? 'codex' : 'claude')
  if (provider !== 'claude') {
    void runRuntime(
      win,
      key,
      worktreePath,
      expanded,
      provider,
      options.model,
      options.effort,
      options.permissionMode,
      options.shown
    )
    return
  }
  sendToAgent(win, key, worktreePath, expanded, options, images, files)
}
