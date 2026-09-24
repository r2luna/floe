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
// Circular with relay.ts (it starts the turns it relays) — safe: neither side
// touches the other at module top level.
import { armAddress, armRelay } from './relay'
import { armSpawnedClose } from './spawned'
import { runRuntime } from './runtimes'
import { expandSkills } from '../shared/skills'
import { expandSessionRefs } from '../shared/sessionRefs'
import { resolveSessionRef } from './sessionRefs'
import { readSkill } from './config/skills'
import { projectFor } from './config/projectStore'
import { floeConfig } from './config/floe'
import { getCreatedSession, setCreatedSessionChoice } from './sessionStore'
import { isQueryKey, parentKeyOf } from '../shared/queries'
// Circular with queries.ts (it starts the turns that merge and peek) — safe on
// the same terms as relay.ts: neither side touches the other at module level.
import {
  canRunInQuery,
  echoOpening,
  noteOpened,
  openQueryFor,
  queryOptions,
  refuse,
  refuseReason,
  withOpeningContext
} from './queries'

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
  // A query key is not a session, so the effort the person last chose lives on
  // the session it was opened FROM. Without this the lookup misses and the
  // query silently falls back to floe.toml's default.
  const session = sessionId ? getCreatedSession(parentKeyOf(sessionId)) : undefined
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
 * What the session itself runs on — the picker's answer to "who answers here".
 *
 * The same shape as a route's, so the relay turn is an ordinary turn: what the
 * session last chose, falling back to the harness block and then to floe.toml,
 * exactly as a message addressed to that harness would.
 */
export function optionsForSession(key: string): AgentRunOptions {
  // Resolved through the parent for a query key. Left to miss, it would report
  // `claude` for a codex query — which is the exact condition startTurn reads
  // to arm the relay, so the relay would fire INSIDE the query and Claude would
  // take a turn in the codex panel.
  const session = getCreatedSession(parentKeyOf(key))
  const harness = session?.provider ?? 'claude'
  const base = optionsForRoute({ harness, prompt: '' }, key)
  // The session's OWN model, not the harness default: a chat pinned to sonnet
  // must not answer on opus because the last message went to codex.
  return { ...base, model: session?.model || base.model }
}

/**
 * The harness these options run on. Stated by the caller; `isCodexModel` stays
 * only as the fallback for a choice made before providers existed (a persisted
 * model with no provider beside it).
 */
const providerOf = (options: AgentRunOptions): string =>
  options.provider ?? (isCodexModel(options.model) ? 'codex' : 'claude')

/**
 * Run one turn.
 *
 * Skills and `#session` references expand ABOVE the provider split, because
 * that is the whole reason they live in Floe's config: `/deploy` and the
 * session you pointed at have to mean the same thing whichever CLI answers.
 * Expanding per runtime would be four copies of one rule.
 *
 * Every turn is watched for where it should go next. Handed to a harness the
 * session does NOT answer as, the answer comes back to the session's own model,
 * which says what it makes of it and can ask the harness more; answered in the
 * session's own voice, a handle the model wrote is delivered to the harness it
 * names. See relay.ts — that is what makes `@codex` a conversation instead of a
 * message you then have to carry by hand.
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
  // Skills first, then the `#session` references — including any the skill's
  // own text turned out to contain, which is the right way round: a skill that
  // names a session means that session.
  const expanded = expandSessionRefs(
    expandSkills(prompt, (name) => readSkill(name, projectFor(worktreePath) ?? undefined)),
    (slug) => resolveSessionRef(slug, worktreePath)
  )
  // Anything but Claude runs on the machine's own runtime and answers over the
  // same agent:event channel.
  const provider = providerOf(options)
  const own = optionsForSession(key)
  // Either way, somebody is listening to how this turn ends. Handed to another
  // harness, the relay brings the answer back here; answered in the session's
  // own voice, armAddress delivers whatever IT addresses — which is what makes
  // `@codex` written by the model reach codex, and not just read like it did.
  //
  // Except inside a query. Nothing watches a query's `done` for what to do
  // next — merge and peek are what read it, under your command and at the
  // moment you give it. A relay armed here would start a turn of the parent's
  // own model in the query's panel the second the harness finished.
  if (!isQueryKey(key)) {
    if (provider !== (own.provider ?? 'claude')) armRelay(win, key, worktreePath, provider, own)
    else armAddress(win, key, worktreePath, own)
    // And, for a session an agent opened, the one that hands the work back and
    // takes the row off the screen. Armed here rather than beside the relay's
    // own waiter because it is not about who answered: a lane finishing is a
    // lane finishing whichever harness ran it.
    armSpawnedClose(win, key)
  }
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
      options.shown,
      options.panel
    )
    return
  }
  sendToAgent(win, key, worktreePath, expanded, options, images, files)
}

/**
 * The one place a prompt's DESTINATION is decided.
 *
 * There are five doors into startTurn, not one — the composer (`agent:start`),
 * the MCP `send_message`, `create_session` with a prompt, a scheduled followup,
 * and the relay itself. Deciding in the composer's `onSend` would cover exactly
 * one of them: an agent sending `@codex …` over `send_message` would keep the
 * old semantics, and "could an agent do this without the UI?" would stop being
 * answerable. So the decision lives beside the rest of what has to be true of a
 * turn whichever door it was.
 *
 * It takes INTENTION, not text to reinterpret. Three of those doors strip the
 * handle before they get here — the composer sends `route.prompt`, `sendOptions`
 * returns the prompt without it, `armAddress` the same — so a `routeOf(prompt)`
 * inside this function would read clean text and never redirect anything. Each
 * door has already parsed the route; it passes it on instead of throwing it out.
 *
 * With a route, the message opens (or refocuses) a query and runs there — D7,
 * always, not only while the session is busy. Without one it is the session's
 * own turn, exactly as before.
 */
export interface Dispatch {
  win: BrowserWindow
  /** The session this is being said in. Never a query key — see below. */
  parentKey: string
  worktreePath: string
  prompt: string
  /** The handle this message opened with, already read by the door. */
  route?: Route | null
  /** Who is sending. `user` is the composer; the rest are agents or timers. */
  origin: 'user' | 'mcp' | 'followup' | 'agent'
  /** What a NON-routed turn runs on, when the door already resolved it. */
  options?: AgentRunOptions
  images?: ImageAttachment[]
  files?: FileAttachment[]
}

export interface Dispatched {
  /** The key the turn actually started under — the query's, if it opened one. */
  key: string
  /** Set when this opened a query rather than taking the session's turn. */
  query?: boolean
  /** Set instead of starting anything, with the reason in the caller's words. */
  error?: string
}

export function dispatchTurn(d: Dispatch): Dispatched {
  const { win, parentKey, worktreePath, prompt } = d
  if (!d.route) {
    const options = d.options ?? optionsForSession(parentKey)
    // An unaddressed message is the session's own turn, so whoever takes it IS
    // who the session answers as. Recorded before startTurn reads it back:
    // left to the picker alone, a chat begun on codex had no provider stored,
    // read as `claude`, and every codex answer armed the relay — Claude then
    // took a turn nobody asked for, in a chat that was codex's.
    const provider = providerOf(options)
    if (!isQueryKey(parentKey) && provider !== (getCreatedSession(parentKey)?.provider ?? 'claude'))
      setCreatedSessionChoice(parentKey, { provider, model: options.model })
    startTurn(win, parentKey, worktreePath, prompt, options, d.images, d.files)
    return { key: parentKey }
  }

  // A query cannot open a query. The cascade already dies one hop out — nothing
  // watches a query's answer (see startTurn) and a query gets no MCP token
  // (D8) — so this is the belt to those braces, for the day somebody hands a
  // query a token and forgets why it did not have one.
  if (isQueryKey(parentKey)) {
    const error = 'A query cannot open another query.'
    refuse(win, parentKey, error)
    return { key: parentKey, error }
  }

  const opened = openQueryFor(win, parentKey, worktreePath, {
    harness: d.route.harness,
    model: d.route.model,
    effort: d.route.effort,
    openedBy: d.origin === 'user' ? 'user' : 'agent'
  })
  if (!opened) {
    const error = refuseReason(d.route.harness)
    refuse(win, parentKey, error)
    return { key: parentKey, error }
  }
  // One conversation, one turn at a time — the rule docs/message-queue.md
  // already states, applied at the door instead of only in the composer. Two
  // `@codex` in quick succession used to run two `codex exec` on one thread,
  // and the second overwrote the first's bookkeeping.
  if (!canRunInQuery(win, opened.key, d.route.harness))
    return { key: opened.key, query: true, error: `${d.route.harness} is still answering.` }
  noteOpened(win, parentKey, opened.query)
  // The panel shows the line that opened it. Before the turn, so it lands above
  // the answer rather than after it.
  echoOpening(win, opened.key, d.prompt)
  const route = d.route
  const options = queryOptions(optionsForRoute(route, parentKey))
  // The first turn waits on the chat's context; later ones start right away.
  // Shown as typed either way — the context is ours, not the user's line.
  withOpeningContext(win, opened.key, parentKey, worktreePath, route.harness, route.prompt, (prefix) =>
    startTurn(
      win,
      opened.key,
      worktreePath,
      prefix + route.prompt,
      prefix ? { ...options, shown: route.prompt } : options,
      d.images,
      d.files
    )
  )
  return { key: opened.key, query: true }
}
