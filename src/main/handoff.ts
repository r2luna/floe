// Carrying a Floe session across harnesses.
//
// One session is one conversation, but the thing answering it changes: Claude
// on one turn, codex or gemini or a local model on the next. The panel merges
// every source on screen, so the conversation reads as continuous — while the
// model answering it starts cold, having never been told any of it.
//
// So before a harness takes a turn it is handed what it has not seen: the
// entries after its watermark, rendered by shared/handoff.ts and prepended to
// its prompt.
//
// The watermark is the whole design, and it is stored the way each harness
// actually remembers (see MEMORY below) rather than in one uniform table:
//
//  - claude keeps its history on disk and `--resume`s it, so its watermark is
//    read straight off the transcript — the last thing it said is the last
//    thing it has. Nothing to persist, and nothing to migrate for the sessions
//    that already exist.
//  - codex, opencode and the local models keep a thread in a Map that dies with
//    the process, so their watermark lives in a Map that dies with it too. A
//    restart re-hands them the conversation, because a restart is exactly when
//    they lost it.
//  - gemini keeps nothing (its `--resume` cannot name our session), so its
//    watermark never moves and it is handed the conversation every turn. That
//    is not a workaround for the switch — it is the only way gemini has ever
//    been able to hold a conversation in Floe at all.
//
// Called from the two places a turn actually begins (agent.sendToAgent for
// Claude, runtimes.runRuntime for everyone else) rather than from the IPC
// handler, so a turn started by the MCP server or a followup timer is seeded
// too.

import type { BrowserWindow } from 'electron'
import { loadClaudeTranscript, type TranscriptItem } from './claudeSessions'
import { readRuntimeTranscript, logTurn } from './runtimeLog'
// Session or query — the transcript reader must not care which registry holds
// the key it was handed. See identity.ts.
import { agentIdentityNames, agentResumeId } from './identity'
import { buildPacket, PACKET_OPEN, stripPacket } from '../shared/handoff'
import { hasRelay, stripRelay } from '../shared/relay'
// Circular with agent.ts (it imports seedFor) — safe on the same terms as
// agent↔mcpServer: neither side touches the other at module top level.
import { sendAgentEvent } from './agent'
import { log } from './log'

/** How long a harness holds a conversation on its own. */
type Memory = 'durable' | 'process' | 'none'

const MEMORY: Record<string, Memory> = {
  claude: 'durable',
  codex: 'process',
  opencode: 'process',
  lmstudio: 'process',
  ollama: 'process'
}

// A harness nobody has classified is assumed to remember nothing. Wrong in the
// cheap direction: it re-reads a history it already had, instead of answering
// as a stranger.
const memoryOf = (harness: string): Memory => MEMORY[harness] ?? 'none'

/** Watermarks for the harnesses whose own memory dies with this process. */
const processSeen = new Map<string, number>()

const processKey = (key: string, harness: string): string => `${key}|${harness}`

/** Drop a closed session's watermarks, next to the threads they belong to. */
export function forgetSeen(key: string): void {
  // A snapshot, not a view: the loop deletes from the map it walks.
  for (const k of Array.from(processSeen.keys())) if (k.startsWith(`${key}|`)) processSeen.delete(k)
}

/** True when this entry was written by a harness answering, not by the user. */
function authoredBy(item: TranscriptItem): string | undefined {
  if (item.role !== 'assistant') return undefined
  return item.provider ?? 'claude'
}

/**
 * Everything said in a session, whoever said it.
 *
 * Two sources: Claude's own JSONL (named after ITS session id, so the Floe key
 * is resolved first) and our log for every other runtime. Merged on time, so
 * the conversation reads in the order it happened rather than one source after
 * the other.
 *
 * Packets are stripped on the way out. They are ours, not the conversation's:
 * left in, the block handed to codex reads back as something the user typed —
 * shown that way in the chat, and shipped again inside the NEXT packet, so the
 * history doubles on every switch.
 */
export function sessionTranscript(worktreePath: string, sessionId: string): TranscriptItem[] {
  const claude = loadClaudeTranscript(worktreePath, agentResumeId(sessionId) ?? sessionId)
  // Under every name this session has answered to, not just the one asked for.
  // The log is keyed by whatever key the turn ran under — Floe's own id for a
  // session an agent drives, the CLI's for a panel that has been through a
  // Claude turn — so a chat where both harnesses have spoken has its history in
  // two files, and reading one of them dropped codex out of the conversation
  // entirely. Same rule as agent.ts's sessionNames, for the same reason.
  const runtime = agentIdentityNames(sessionId).flatMap(readRuntimeTranscript)
  const all = runtime.length
    ? [...claude, ...runtime].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
    : claude
  return all
    .map((i) => (i.text?.includes(PACKET_OPEN) ? { ...i, text: stripPacket(i.text) } : i))
    // Relay envelopes go the same way, and for the same reason: the note that
    // told the model to read what codex said is ours, and read back it would
    // look like a message the user typed. What is left of one is nothing, so
    // the filter below drops the line entirely. See shared/relay.ts.
    .map((i) => (i.text && hasRelay(i.text) ? { ...i, text: stripRelay(i.text) } : i))
    .filter((i) => i.role !== 'user' || (i.text ?? '').trim().length > 0)
}

/**
 * How far one conversation has been read INTO another.
 *
 * The watermarks above answer "what has this harness not seen of its own
 * chat". This answers a different question — "what has the chat not been shown
 * of the query beside it" — and it needs its own storage for a reason that only
 * looks like a detail: `watermark()` reads Claude's off its transcript, and
 * Claude never speaks inside a codex query, so it would read 0 forever and a
 * merge after a peek would re-ship every line.
 *
 * Same shape, same lifetime (a Map that dies with the process, which is also
 * when the conns and threads it describes die), keyed by the pair rather than
 * by (key, harness).
 */
const readInto = new Map<string, number>()

const readKey = (fromKey: string, toKey: string): string => `${fromKey}»${toKey}`

/** Drop a closed query's read marks, next to the watermarks they sit beside. */
export function forgetRead(fromKey: string): void {
  // A snapshot, not a view: the loop deletes from the map it walks.
  for (const k of Array.from(readInto.keys())) if (k.startsWith(`${fromKey}»`)) readInto.delete(k)
}

/**
 * One conversation, packaged for another to read — what peek and merge send.
 *
 * `since: 'watermark'` is everything `toKey` has not been shown yet, which is
 * what makes merge-after-peek send the rest instead of the lot. `'all'` is the
 * whole thing, for a caller that wants it whatever has been read.
 *
 * Returns null when there is nothing new: the caller says so rather than
 * starting a turn whose entire content is an empty block.
 */
export function packetFrom(
  worktreePath: string,
  fromKey: string,
  toKey: string,
  opts: { since: 'watermark' | 'all'; to: string }
): { packet: string; entries: number } | null {
  const items = sessionTranscript(worktreePath, fromKey)
  const seen = opts.since === 'watermark' ? (readInto.get(readKey(fromKey, toKey)) ?? 0) : 0
  // Our own chips are bookkeeping, not conversation — the same filter seedFor
  // applies, and for the same reason.
  const gap = items.filter(
    (i) => (i.at ?? 0) > seen && !(i.role === 'tool' && (i.name === 'handoff' || i.name === 'query'))
  )
  if (!gap.length) return null
  const packet = buildPacket(gap, { to: opts.to })
  if (!packet) return null
  // Moved at the START, exactly as seedFor does: a turn that dies halfway has
  // still delivered its packet, and re-sending would pay twice for context the
  // model already read.
  //
  // Marked at the LAST ENTRY SENT rather than at the wall clock. The two are
  // nearly the same instant, and the difference is the bug: an entry written
  // while the packet was being built carries an earlier `at` than `Date.now()`,
  // so a clock mark would skip it and the chat would never see that line at
  // all. The mark can only move forward.
  const last = gap[gap.length - 1].at ?? Date.now()
  readInto.set(readKey(fromKey, toKey), Math.max(seen, last))
  log('query-packet', { from: fromKey, to: toKey, entries: gap.length, chars: packet.length })
  return { packet, entries: gap.length }
}

/**
 * The gap without the exchanges this harness ran itself.
 *
 * A watermark is stamped when a turn STARTS — so that a turn which dies halfway
 * does not re-ship the whole history on the retry — which means the turn's own
 * prompt and answer land after it and read as a gap on the next one. They are
 * not: the harness was handed that prompt directly and wrote that answer, and
 * its thread still holds both.
 *
 * Only for a harness that remembers. One that does not (gemini) needs its own
 * words back as much as anyone else's — that is the whole point.
 */
function withoutOwnTurns(gap: TranscriptItem[], harness: string): TranscriptItem[] {
  if (memoryOf(harness) === 'none') return gap
  return gap.filter((item, i) => {
    if (authoredBy(item) === harness) return false
    // A user message belongs to whoever answered it next.
    if (item.role === 'user') {
      const answer = gap.slice(i + 1).find(authoredBy)
      if (answer && authoredBy(answer) === harness) return false
    }
    return true
  })
}

/** How far this harness is holding the conversation already. */
function watermark(key: string, harness: string, items: TranscriptItem[]): number {
  switch (memoryOf(harness)) {
    case 'durable': {
      // Its own transcript is its memory, so the last thing it said is the last
      // thing it knows. Read rather than recorded: it is true for a session
      // that predates this file, and it cannot drift from the CLI's own state.
      let last = 0
      for (const i of items) if (authoredBy(i) === harness && (i.at ?? 0) > last) last = i.at!
      return last
    }
    case 'process':
      return processSeen.get(processKey(key, harness)) ?? 0
    case 'none':
      return 0
  }
}

/**
 * What to prepend to this harness's next prompt, or '' when it already holds
 * the conversation.
 *
 * The watermark moves at the START of the turn: a turn that dies halfway has
 * still delivered its packet, and re-sending the whole history on the retry
 * would be paying twice for context the model already read.
 */
export function seedFor(
  win: BrowserWindow | null,
  key: string,
  worktreePath: string,
  harness: string
): string {
  const items = sessionTranscript(worktreePath, key)
  const seen = watermark(key, harness, items)
  if (memoryOf(harness) === 'process') processSeen.set(processKey(key, harness), Date.now())
  // Our own handoff chips are bookkeeping, not conversation — a harness reading
  // "[ran handoff]" learns nothing except that this file exists.
  const gap = withoutOwnTurns(
    items.filter((i) => (i.at ?? 0) > seen && !(i.role === 'tool' && i.name === 'handoff')),
    harness
  )
  if (!gap.length) return ''
  const packet = buildPacket(gap, { to: harness })
  if (!packet) return ''
  // Who is handing over: the last harness that answered inside the gap. None
  // means the gap is only the user's own messages (or this harness's own turns,
  // for one that remembers nothing) — a refresh, not a handoff.
  const from = [...gap].reverse().map(authoredBy).find((a) => a && a !== harness)
  log('handoff', { key, from: from ?? harness, to: harness, entries: gap.length, chars: packet.length })
  // Say it happened, but only when it is news. A packet costs real tokens and
  // changes who knows what, so a switch belongs in the transcript it affects —
  // while gemini being re-read its own history every turn is just how gemini
  // works, and a chip on every message would be noise.
  if (from) {
    const label = `${from} → ${harness} · ${gap.length} entries`
    logTurn(key, { role: 'tool', name: 'handoff', summary: label })
    if (win && !win.isDestroyed()) sendAgentEvent(win, key, { kind: 'tool', name: 'handoff', summary: label })
  }
  return packet
}
