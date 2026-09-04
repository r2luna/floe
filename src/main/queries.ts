// A query: talking to another agent without stopping the one you have.
//
// `@codex analisa isso` while Claude is mid-turn used to go in the queue — you
// waited for the turn to end, and then the answer landed in the same scroll, in
// the middle of the work. A query instead opens its own panel with its own
// transcript and runs in parallel.
//
// The whole thing rests on one fact: a query is just another agent key. See
// shared/queries.ts. What lives here is the part a key cannot carry — who may
// open one, what it runs as, and (in M2) the three actions that close the
// cycle: merge, peek and discard.

import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import type { AgentRunOptions, PermissionMode, Query, QueryMark } from '../shared/types'
import { supportsMode } from '../shared/modes'
import { parseQueryKey, queryKey } from '../shared/queries'
import {
  addQuery,
  findQuery,
  getCreatedSession,
  getQueries,
  setQueryOutcome
} from './sessionStore'
// Circular with agent.ts (nothing there imports this at module top level) —
// safe on the same terms as handoff↔agent.
import { activeTurnKeys, onceTurnDone, sendAgentEvent, stopAgent } from './agent'
import { dropRuntimeTranscript, logTurn } from './runtimeLog'
import { forgetRead, forgetSeen, packetFrom } from './handoff'
import { forgetThread } from './runtimes'
import { queryPrompt, relayMark } from '../shared/relay'
// Circular with turn.ts (it opens the queries this starts turns for) — safe on
// the same terms as relay↔turn: neither side runs the other at import.
import { optionsForRoute, optionsForSession, startTurn } from './turn'
import { agentIdentityNames } from './identity'
import { log } from './log'

/**
 * What a query is allowed to do. Not a setting: a query is a second agent
 * pointed at a worktree that somebody else is already writing in, and two
 * writers in one checkout is the failure this is here to prevent (R5).
 */
export const QUERY_MODE: PermissionMode = 'plan'

/**
 * Whether this harness can hold a query at all.
 *
 * `plan` is the barrier, and it has to be a real one. `nearestMode` would
 * happily snap the mode to something the harness CAN do — gemini has no
 * read-only setting, so it would land on `default` and start asking permission
 * to edit. And a query gets no Floe MCP token (D8), which also means the
 * managed hooks stop recognising it: the second layer of protection goes with
 * the first. A harness that cannot do `plan` is refused rather than promised a
 * read-only that does not exist.
 */
export function canOpenQuery(harness: string): boolean {
  return supportsMode(harness, QUERY_MODE)
}

/** Why this harness cannot hold one, in words the chat can print. */
export function refuseReason(harness: string): string {
  return `${harness} has no read-only mode, so it cannot hold a query. A query never writes — open the harness in the chat instead if that is what you want.`
}

/**
 * The session a key belongs to, by the one name that never forks.
 *
 * A panel keys itself `claudeId ?? id` and an agent may say any past id, while
 * `claude --resume` mints a fresh claudeId on every respawn. Naming a query
 * after whichever of those the caller happened to hold would give one session
 * two queries on one harness, each streaming into a transcript the other also
 * has open. The store's `id` is the only stable one, so that is the one the key
 * is built from.
 */
export function parentIdOf(parentKey: string): string {
  return getCreatedSession(parentKey)?.id ?? parentKey
}

/** Every query opened off this session, whichever of its names you ask by. */
export function queriesFor(parentKey: string): Query[] {
  return getQueries(parentIdOf(parentKey))
}

/** The query on this harness, if the session has one. */
export function queryFor(parentKey: string, harness: string): Query | undefined {
  return findQuery(queryKey(parentIdOf(parentKey), harness))
}

/**
 * Whether a turn is already running in this query.
 *
 * A query is one conversation, and the rules for talking into a busy one are
 * already written (docs/message-queue.md): Claude takes a second message as a
 * steer, folding it into the turn in flight; a one-shot runtime cannot, because
 * its run IS the request and a second `codex exec` races the first.
 *
 * The renderer enforces that for what YOU type, and only for what you type —
 * the queue lives in `useTranscript`. Every other door into a query (an agent's
 * `send_message`, a followup, `@codex` written by the model, a fan-out) reaches
 * `startTurn` with nothing between it and the runtime, so the rule has to hold
 * here too or it holds only for the composer.
 */
export function queryBusy(qkey: string): boolean {
  const names = new Set(agentIdentityNames(qkey))
  return activeTurnKeys().some((k) => names.has(k))
}

/**
 * True when a message may go out now — and says so in the panel when it may not.
 *
 * Refused rather than queued: a queue in main would be a second one, beside the
 * renderer's, with no panel to show what is waiting in it. A message told it
 * did not go out is worse than one silently dropped only if it never happens;
 * this is the door an agent uses, and an agent can read the refusal and retry.
 */
export function canRunInQuery(win: BrowserWindow | null, qkey: string, harness: string): boolean {
  // Claude steers: a second message joins the turn in flight rather than
  // starting one beside it. That is the CLI's own behaviour, not ours.
  if (harness === 'claude' || !queryBusy(qkey)) return true
  log('query-busy', { key: qkey, harness })
  refuse(win, qkey, `${harness} is still answering. Wait for this turn to end.`)
  return false
}

export interface OpenedQuery {
  query: Query
  /** The agent key it runs under — what `useTranscript` and the conns use. */
  key: string
}

/**
 * Open the query for this harness off this session, or bring back the one that
 * is already open. Returns null when the harness cannot hold one.
 *
 * Announced to the renderer rather than returned to it, because the door that
 * opens a query is not always the one with a panel in front of it: an agent can
 * open one over `send_message`, on a followup timer, or by writing `@codex`
 * into its own answer. The panel appears the same way in all four cases.
 */
export function openQueryFor(
  win: BrowserWindow | null,
  parentKey: string,
  worktreePath: string,
  spec: { harness: string; model?: string; effort?: Query['effort']; openedBy?: 'user' | 'agent' }
): OpenedQuery | null {
  if (!canOpenQuery(spec.harness)) return null
  const sessionId = parentIdOf(parentKey)
  const query = addQuery({
    sessionId,
    harness: spec.harness,
    model: spec.model,
    effort: spec.effort,
    mode: QUERY_MODE,
    openedBy: spec.openedBy ?? 'user'
  })
  if (!query) return null
  log('query-open', { key: query.id, harness: spec.harness, by: query.openedBy })
  announce(win, query, worktreePath)
  return { query, key: query.id }
}

/**
 * Tell the renderer a query was born (or came back), so the panel appears.
 *
 * `parentKeys` rides along because the renderer cannot work it out: a panel
 * keys itself `claudeId ?? id` while a query is named after the session's
 * stable id, so "is this query's parent the chat I am showing?" is a question
 * only the id resolution can answer — and it has to be answered, or an agent
 * opening a query off another session drops a panel into the chat you are
 * reading. See identity.ts.
 */
export function announce(win: BrowserWindow | null, query: Query, worktreePath: string): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send('query:opened', {
    query,
    worktreePath,
    parentKeys: agentIdentityNames(query.sessionId)
  })
}

/**
 * The one line the PARENT chat gets: a query opened, and where it is.
 *
 * The conversation itself belongs to the query's own panel — that is the whole
 * point of it running beside the chat instead of in it. What the chat keeps is
 * a mark that it happened, in the same shape the handoff chip already uses.
 */
export function noteOpened(win: BrowserWindow | null, parentKey: string, query: Query): void {
  note(win, parentKey, `${query.harness} query open`, { key: query.id, harness: query.harness })
}

/**
 * The opening message, shown in the query's own panel.
 *
 * Sent as a `steer` because that is exactly what it is from the panel's point
 * of view: a user line it did not type itself, arriving on a turn it did not
 * start. The kind already pushes a user row and already drops the JSONL copy
 * when the CLI writes its own — see transcriptState's `dropOnce`.
 *
 * Only for a turn main dispatched. A message typed INTO the query's composer
 * has been on screen since before it left the renderer, and echoing it back
 * would print it twice.
 */
export function echoOpening(win: BrowserWindow | null, key: string, text: string): void {
  if (!win || win.isDestroyed() || !text.trim()) return
  sendAgentEvent(win, key, { kind: 'steer', text, at: Date.now() })
}

/**
 * Say, in the chat that asked, why the query did not open.
 *
 * A tool row and not an `error` event: the parent is very likely MID-TURN — the
 * whole point of a query is being able to speak while it works — and `error`
 * is one of the two kinds that mean a turn ENDED. Reporting our refusal that
 * way would take the "is typing" line off a turn that is still running.
 */
export function refuse(win: BrowserWindow | null, parentKey: string, reason: string): void {
  log('query-refused', { key: parentKey, reason })
  logTurn(parentKey, { role: 'tool', name: 'query', summary: reason })
  if (win && !win.isDestroyed())
    sendAgentEvent(win, parentKey, { kind: 'tool', name: 'query', summary: reason })
}

/**
 * What a query's turn runs on: the route's own model and effort, at `plan`.
 *
 * The mode is not negotiable and is not read from the parent — the parent may
 * well be on bypass, and inheriting that is the one thing a read-only side
 * conversation must never do.
 */
export function queryOptions(base: AgentRunOptions): AgentRunOptions {
  return { ...base, permissionMode: QUERY_MODE }
}

/** The harness a query key answers as — for the panel head and the log. */
export const harnessOf = (key: string): string | undefined => parseQueryKey(key)?.harness

// --- The three actions ------------------------------------------------------
//
// A query is a conversation you opened on the side; these are the only three
// ways it ends up mattering. Each is one sentence:
//
//   peek    — the chat reads what it has not read. Nothing closes.
//   merge   — the chat reads the rest, and the query closes.
//   discard — the chat never sees a word, and the query closes.
//
// The watermark is what makes the first two compose: peek then merge sends the
// REST, not the lot. See handoff.ts's `packetFrom`.

export interface QueryAction {
  /** How many entries went to the chat. 0 for a discard, or a peek with nothing new. */
  entries: number
  error?: string
}

/** Where a query lives, and who it belongs to. */
function contextOf(qkey: string): { query: Query; parentKey: string; worktreePath: string } | null {
  const query = findQuery(qkey)
  if (!query) return null
  const parent = getCreatedSession(query.sessionId)
  if (!parent) return null
  return { query, parentKey: query.sessionId, worktreePath: parent.worktreePath }
}

/**
 * Hand the chat what it has not read of this query, and start its turn on it.
 *
 * Shared by peek and merge, because they differ in exactly two things: whether
 * the query stays open, and what the note at the top says.
 */
function deliver(
  win: BrowserWindow | null,
  ctx: { query: Query; parentKey: string; worktreePath: string },
  merged: boolean
): QueryAction {
  const { query, parentKey, worktreePath } = ctx
  // Before the packet, not after: `packetFrom` MOVES the read mark as it builds
  // (a turn that dies halfway has still delivered its packet). Checked after,
  // a missing window consumed the mark for a turn that never started, and the
  // lines it covered could never be sent again.
  if (!win || win.isDestroyed()) return { entries: 0, error: 'No window to run the turn in.' }
  const own = optionsForSession(parentKey)
  const to = own.provider ?? 'claude'
  const built = packetFrom(worktreePath, query.id, parentKey, { since: 'watermark', to })
  if (!built) return { entries: 0 }
  // The packet first, then the note that says what it is — the same order the
  // relay uses, and for the same reason: the note is the instruction, and an
  // instruction after the data it is about is the one the model acts on.
  const prompt = built.packet + queryPrompt(query.harness, { merged, entries: built.entries })
  // `shown` is the envelope's stand-in: the words are in the query's own panel,
  // and printing them again in the chat under the user's name would say they
  // typed what codex said.
  startTurn(win, parentKey, worktreePath, prompt, { ...own, shown: relayMark(query.harness) })
  return { entries: built.entries }
}

/** The chat reads what is new. The query stays open, and stays yours. */
export function peekQuery(win: BrowserWindow | null, qkey: string): QueryAction {
  const ctx = contextOf(qkey)
  if (!ctx) return { entries: 0, error: `Unknown query: ${qkey}` }
  const out = deliver(win, ctx, false)
  log('query-peek', { key: qkey, entries: out.entries })
  if (out.entries)
    // Phrased to OPEN with the harness, like every other query chip: the fold
    // prints the nick itself and strips it off the front of the summary, so
    // "peeked at the codex query" came out as "codex peeked at the codex query".
    note(win, ctx.parentKey, `${ctx.query.harness} query peeked · ${out.entries} entries`, {
      key: qkey,
      harness: ctx.query.harness,
      entries: out.entries
    })
  return out
}

/**
 * The chat reads the rest, and the query is over.
 *
 * Merging twice is harmless by construction: the second call finds the
 * watermark already at the end, sends nothing, and closes a query that is
 * already closed. That is worth stating because "merge" is bound to a key, and
 * a key gets pressed twice.
 */
export function mergeQuery(win: BrowserWindow | null, qkey: string): QueryAction {
  const ctx = contextOf(qkey)
  if (!ctx) return { entries: 0, error: `Unknown query: ${qkey}` }
  const out = deliver(win, ctx, true)
  // A merge that could not deliver has not merged. Closing anyway would mark
  // the conversation as read by a chat that never saw it, and there would be no
  // second chance — the entry says `merged` and the panel is gone.
  if (out.error) return out
  log('query-merge', { key: qkey, entries: out.entries })
  // The chat keeps a mark of it. The conversation itself arrived in the packet
  // above; this is the line the transcript folds — see the merged block (S3).
  note(
    win,
    ctx.parentKey,
    `${ctx.query.harness} query merged${out.entries ? ` · ${out.entries} entries` : ''}`,
    { key: qkey, harness: ctx.query.harness, outcome: 'merged', entries: out.entries }
  )
  setQueryOutcome(qkey, 'merged')
  release(win, qkey)
  announceClosed(win, qkey, 'merged', out.entries)
  return out
}

/** The chat never sees a word of it. */
export function discardQuery(win: BrowserWindow | null, qkey: string): QueryAction {
  const ctx = contextOf(qkey)
  if (!ctx) return { entries: 0, error: `Unknown query: ${qkey}` }
  log('query-discard', { key: qkey })
  // The dead line (S4). It is UI and nothing else — it enters no context, and
  // it is what `reopen` is offered from.
  note(win, ctx.parentKey, `${ctx.query.harness} query discarded`, {
    key: qkey,
    harness: ctx.query.harness,
    outcome: 'discarded',
    entries: 0
  })
  setQueryOutcome(qkey, 'discarded')
  release(win, qkey)
  // The transcript STAYS. Discard is a promise about the chat — it never sees a
  // word — not about the disk: the dead line it leaves offers `reopen`, and
  // reopening into an emptied conversation would be the app breaking its own
  // offer. The file is dropped with the record instead (`forgetQuery`).
  announceClosed(win, qkey, 'discarded', 0)
  return { entries: 0 }
}

/**
 * Let go of what a LIVE query was holding: the conn, the one-shot runtime's
 * thread, the handoff watermarks.
 *
 * Deliberately NOT the read mark. That mark is the record of what the chat has
 * already been shown, and the query's entry and transcript both outlive the
 * close — so wiping it made merging twice re-ship the whole conversation, with
 * the second press of ⌘⇧M pasting everything the first one had just delivered.
 * It is dropped where it stops meaning anything: with the record itself
 * (`forgetQuery`).
 */
function release(win: BrowserWindow | null, qkey: string): void {
  if (win && !win.isDestroyed()) stopAgent(win, qkey)
  for (const name of agentIdentityNames(qkey)) {
    forgetThread(name)
    forgetSeen(name)
  }
}

/**
 * Everything a query owns, for good — called when its RECORD goes, not when
 * the conversation ends.
 *
 * Discard keeps the transcript on purpose: the dead line in the chat offers
 * `reopen`, and a reopened query with an emptied transcript is a promise the
 * app broke. R4's worry (a file per thrown-away conversation, accumulating
 * forever) is answered here instead — the file dies with the entry that names
 * it, which is what closing the session or removing the worktree does.
 */
export function forgetQuery(qkey: string): void {
  for (const name of agentIdentityNames(qkey)) {
    forgetThread(name)
    forgetSeen(name)
    forgetRead(name)
    dropRuntimeTranscript(name)
  }
}

/** Let go of every query a session owns — its own close, or its worktree's. */
export function forgetQueriesOf(win: BrowserWindow | null, parentKey: string): void {
  for (const q of queriesFor(parentKey)) {
    release(win, q.id)
    forgetQuery(q.id)
  }
}

/** Tell the renderer to take the panel down, and what became of it. */
function announceClosed(
  win: BrowserWindow | null,
  qkey: string,
  outcome: 'merged' | 'discarded',
  entries: number
): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send('query:closed', { key: qkey, outcome, entries })
}

/**
 * A chip in the chat saying what just happened, in the handoff chip's shape.
 *
 * The mark travels with it and is the point: it is what lets the transcript
 * draw a merged query as a fold it can open and a discarded one as a line it
 * can bring back, instead of reading the sentence back for clues.
 */
function note(
  win: BrowserWindow | null,
  parentKey: string,
  summary: string,
  mark?: QueryMark
): void {
  logTurn(parentKey, { role: 'tool', name: 'query', summary, query: mark })
  if (win && !win.isDestroyed())
    sendAgentEvent(win, parentKey, { kind: 'tool', name: 'query', summary, query: mark })
}

/**
 * Bring a closed query back.
 *
 * Its transcript is still on disk under its own key, so reopening is opening:
 * `openQuery` clears the outcome and the panel reads the conversation back. The
 * one thing it does NOT restore is the read watermark — a reopened query starts
 * unread, which is the safe direction (the chat is offered lines it may already
 * have) rather than the lossy one.
 */
export function reopenQuery(win: BrowserWindow | null, qkey: string): OpenedQuery | null {
  const ctx = contextOf(qkey)
  if (!ctx) return null
  return openQueryFor(win, ctx.parentKey, ctx.worktreePath, {
    harness: ctx.query.harness,
    model: ctx.query.model,
    effort: ctx.query.effort,
    openedBy: ctx.query.openedBy
  })
}

// --- `@all`: one message, several agents ------------------------------------

/**
 * Ask several harnesses the same thing at once, and bring the answers back into
 * the chat side by side.
 *
 * Each target is an ordinary query — same key, same panel, same read-only, same
 * three actions — so nothing here is a second mechanism. What the fan-out adds
 * is only the comparison: every answer is ALSO mirrored into the chat under one
 * `fanoutId`, which is what lets the transcript draw them as columns instead of
 * as four replies in a row.
 *
 * **R7 — never every harness installed.** The targets are given, and the caller
 * that has none to give asks. Four turns nobody ordered is the failure this
 * signature exists to prevent, so there is nowhere in here to invent one.
 */
export function fanOut(
  win: BrowserWindow | null,
  parentKey: string,
  worktreePath: string,
  spec: { harnesses: string[]; prompt: string; effort?: Query['effort']; openedBy?: 'user' | 'agent' }
): { fanoutId: string; keys: string[]; refused: string[]; busy: string[] } {
  const fanoutId = randomUUID()
  const keys: string[] = []
  const refused: string[] = []
  // Already answering. `ask_all` naming one harness twice, or a fan-out over a
  // query still working, would otherwise race two runs of the same CLI.
  const busy: string[] = []
  for (const harness of spec.harnesses) {
    const opened = openQueryFor(win, parentKey, worktreePath, {
      harness,
      effort: spec.effort,
      openedBy: spec.openedBy ?? 'user'
    })
    if (!opened) {
      refused.push(harness)
      continue
    }
    if (!canRunInQuery(win, opened.key, harness)) {
      busy.push(harness)
      continue
    }
    keys.push(opened.key)
    echoOpening(win, opened.key, spec.prompt)
    // Watching the answer is the ONLY thing a fan-out turn does that a plain
    // query turn does not — and it is a mirror, not a relay: nothing is started
    // off the back of it. See startTurn, which arms nothing on a query key.
    onceTurnDone(opened.key, (text) => mirror(win, parentKey, fanoutId, opened.query, text))
    startTurn(
      win as BrowserWindow,
      opened.key,
      worktreePath,
      spec.prompt,
      queryOptions(optionsForRoute({ harness, effort: spec.effort, prompt: spec.prompt }, parentKey))
    )
  }
  if (refused.length)
    refuse(win, parentKey, `${refused.join(', ')} cannot hold a query: no read-only mode.`)
  log('query-fanout', { key: parentKey, to: keys.length, refused: refused.length, busy: busy.length })
  noteAsked(win, parentKey, fanoutId, keys.length)
  return { fanoutId, keys, refused, busy }
}

/** One column of the comparison, put where the two can be read against each other. */
function mirror(
  win: BrowserWindow | null,
  parentKey: string,
  fanoutId: string,
  query: Query,
  text: string
): void {
  // Nothing came back — the harness is not installed, the turn was stopped, it
  // died on spawn. An empty column is our plumbing reported as an answer.
  if (!text.trim()) return
  const mark: QueryMark = { key: query.id, harness: query.harness }
  logTurn(parentKey, {
    role: 'assistant',
    provider: query.harness,
    model: query.model,
    text,
    fanoutId,
    query: mark
  })
  if (win && !win.isDestroyed())
    sendAgentEvent(win, parentKey, {
      kind: 'fanout',
      fanoutId,
      provider: query.harness,
      model: query.model,
      text,
      query: mark
    })
}

/** The chip that says a fan-out went out, before any of it has come back. */
function noteAsked(
  win: BrowserWindow | null,
  parentKey: string,
  fanoutId: string,
  to: number
): void {
  if (!to) return
  note(win, parentKey, `asked ${to} ${to === 1 ? 'harness' : 'harnesses'}`, undefined)
  log('query-fanout-asked', { key: parentKey, fanoutId, to })
}
