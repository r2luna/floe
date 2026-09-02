import type { TranscriptItem } from '../../main/claudeSessions'
import { agentNick } from '../../shared/nicks.ts'

// The transcript panel's state machine, kept apart from the hook that drives
// it: these are the rules that say where a line lands and which row an event
// belongs to, and they are worth testing without mounting React.

// The whole transcript this panel shows, in three parts. `base` is what the
// JSONL held when the panel opened, `live` the settled entries streamed since,
// `tail` the one assistant run still growing. Only the tail changes per delta.
//
// `base` is in here rather than beside the reducer because a turn in flight
// reaches into it: a panel that opens mid-turn reads the subagent's launch off
// disk, and the events that close that row — and the report it comes back with
// — arrive afterwards. A reducer that could only see `live` answered them by
// appending a SECOND row for the same agent, which then never closed.
export interface LiveState {
  base: TranscriptItem[]
  live: TranscriptItem[]
  tail: TranscriptItem | null
  /**
   * Epoch ms the turn the live stream is carrying began. Everything the CLI has
   * written to the JSONL since then is the SAME turn the stream already holds,
   * so it is dropped from `base` — see `mine` for the lines that are still read
   * off disk after it.
   */
  since?: number
}

export type LiveAction =
  | { type: 'reset' }
  // The live stream owns the turn that started at `at`: whoever knows when the
  // turn began (this panel's own send, the `turn` event, the replay snapshot)
  // says so here, and the disk copy of that turn stops being shown.
  | { type: 'live-since'; at: number }
  // The transcript read off disk, once it lands. Rows the live stream already
  // pushed are dropped from it: the same agent must not arrive twice because
  // its launch was both written to the JSONL and streamed here, and neither
  // must the turn in flight (see `since`).
  | { type: 'load'; items: TranscriptItem[] }
  // A settled entry (user turn, tool row): settles the tail first, so a tool
  // call that interrupts the text keeps its place in the conversation.
  | { type: 'push'; item: TranscriptItem }
  // A text delta: grows the tail, or opens one from `item` if none is running.
  | { type: 'text'; item: TranscriptItem }
  | { type: 'settle' }
  // A subagent row changing state: found by its tool_use id and patched in
  // place, so a live agent's tool/token updates never append a second line.
  // Keys whose value is `undefined` are ignored — a progress event without a
  // tool must not erase the tool the row is already showing.
  | { type: 'agent'; toolUseId: string; patch: Partial<TranscriptItem> }
  // A subagent reporting back: what it says is a message in the channel, from
  // the agent's own nick — not another paragraph of the model that sent it out.
  // Its row is found by id only to read the nick from it.
  | { type: 'agent-reply'; toolUseId: string; text: string }
  // The turn ended: settle the tail, then stamp what it cost onto the LAST
  // assistant entry of the run — the one the footer prints under.
  | { type: 'finish'; ms?: number; tokens: number }

/**
 * Is this disk line one the live stream never carries?
 *
 * The replay of a turn in flight holds what the MODEL produced — its text, its
 * tool rows, its subagents, the peer lines said into it. What YOU put in is not
 * in there (the CLI writes your prompt to the JSONL at submit, and the replay
 * deliberately skips it), and neither are the artifacts a decision panel leaves
 * behind. Those are still read off disk however recent they are; everything
 * else from the turn in flight would be a second copy.
 */
function mine(item: TranscriptItem): boolean {
  if (item.by === 'user') return true
  if (item.role === 'image' || item.role === 'artifact') return true
  // `from` is another session speaking — the stream replays that as a `peer`.
  return item.role === 'user' && !item.from
}

/** What you said, as the live stream is already showing it. */
function saidLive(live: TranscriptItem[]): Set<string> {
  const said = new Set<string>()
  for (const i of live) if (mine(i) && i.text) said.add(i.text)
  return said
}

/**
 * The disk transcript with the turn the live stream already has cut out of it.
 *
 * `live` is passed so the one line that is in BOTH — a message typed into the
 * running turn, which the stream carries and the CLI writes to the JSONL when
 * it absorbs it — is kept once rather than shown twice.
 */
function beforeTurn(items: TranscriptItem[], since?: number, live: TranscriptItem[] = []): TranscriptItem[] {
  if (!since) return items
  const said = saidLive(live)
  return items.filter((i) => {
    if (!i.at || i.at < since) return true
    return mine(i) && !(i.text && said.has(i.text))
  })
}

/** Drop the first line of the running turn that says exactly this. */
function dropOnce(items: TranscriptItem[], text: string, since: number): TranscriptItem[] {
  const at = items.findIndex((i) => i.text === text && mine(i) && i.at !== undefined && i.at >= since)
  return at === -1 ? items : [...items.slice(0, at), ...items.slice(at + 1)]
}

/**
 * Where a subagent row is, newest first and `live` before `base`.
 *
 * Two places, one id: the launch can be on disk (the CLI writes each assistant
 * message as it closes, so a Task launched early in a turn is already there
 * when a panel opens) or in `live` (this panel watched it happen). Every event
 * that follows names the row by tool_use id alone, so finding it has to look in
 * both — and prefer the newer copy, which is the one still running.
 */
function rowAt(state: LiveState, toolUseId: string): { where: 'live' | 'base'; at: number } | null {
  for (let i = state.live.length - 1; i >= 0; i--) {
    const row = state.live[i]
    if (row.role === 'subagent' && row.toolUseId === toolUseId) return { where: 'live', at: i }
  }
  for (let i = state.base.length - 1; i >= 0; i--) {
    const row = state.base[i]
    if (row.role === 'subagent' && row.toolUseId === toolUseId) return { where: 'base', at: i }
  }
  return null
}

// Exported for its unit test: the subagent rules (patch by id, never append a
// second row, never let a turn end with a row still working) are the kind of
// thing you cannot see by looking at a screenshot of one happy path.
export function liveReducer(state: LiveState, action: LiveAction): LiveState {
  switch (action.type) {
    case 'reset':
      return { base: [], live: [], tail: null }
    case 'live-since':
      // Applied to what is already loaded too: the read can land before the
      // replay resolves, in which case the duplicate is on screen by the time
      // anyone knows a turn is in flight.
      return { ...state, since: action.at, base: beforeTurn(state.base, action.at, state.live) }
    case 'load': {
      // A subagent the live stream already opened is not loaded a second time:
      // the streamed copy is the one the events are patching.
      const known = new Set(
        state.live.filter((i) => i.role === 'subagent' && i.toolUseId).map((i) => i.toolUseId)
      )
      const items = known.size
        ? action.items.filter((i) => i.role !== 'subagent' || !known.has(i.toolUseId))
        : action.items
      return { ...state, base: beforeTurn(items, state.since, state.live) }
    }
    case 'push': {
      // A subagent row this panel already has (read off disk on open) must not
      // be opened again by the replay of the turn it is part of — two rows for
      // one agent, and only one of them ever closes.
      //
      // Only against a row still RUNNING: a closed row with the same id is a
      // finished agent, and a launch arriving after it is a second run that
      // deserves its own line.
      if (action.item.role === 'subagent' && action.item.toolUseId) {
        const open = rowAt(state, action.item.toolUseId)
        const row = open ? (open.where === 'live' ? state.live : state.base)[open.at] : undefined
        if (row?.running) return state
      }
      const live = state.tail ? [...state.live, state.tail] : state.live
      // A steer replayed into a panel that already read the JSONL copy of it:
      // one message, said once. Only the first match goes — the same line typed
      // twice into one turn is two lines, and both were really said.
      const base =
        state.since && mine(action.item) && action.item.text
          ? dropOnce(state.base, action.item.text, state.since)
          : state.base
      return { ...state, base, live: [...live, action.item], tail: null }
    }
    case 'text':
      return state.tail
        ? {
            ...state,
            tail: { ...state.tail, text: (state.tail.text ?? '') + (action.item.text ?? '') }
          }
        : { ...state, tail: action.item }
    case 'settle':
      return state.tail ? { ...state, live: [...state.live, state.tail], tail: null } : state
    case 'agent': {
      // Newest first: a session that ran the same agent twice patches the row
      // that is still open, not the one that already closed.
      const found = rowAt(state, action.toolUseId)
      if (!found) return state
      const list = found.where === 'live' ? state.live : state.base
      const next = { ...list[found.at] }
      for (const [k, v] of Object.entries(action.patch)) {
        if (v !== undefined) (next as Record<string, unknown>)[k] = v
      }
      const patched = [...list]
      patched[found.at] = next
      return found.where === 'live' ? { ...state, live: patched } : { ...state, base: patched }
    }
    case 'agent-reply': {
      const found = rowAt(state, action.toolUseId)
      const row = found ? (found.where === 'live' ? state.live : state.base)[found.at] : undefined
      // Settles the tail first, like any other spoken entry: the report lands
      // where the agent said it, not after the answer it interrupted.
      const live = state.tail ? [...state.live, state.tail] : state.live
      // No row to speak for at all — a report for an agent this panel never saw
      // launched. It is still said, under a bare `agent` nick: losing which
      // agent wrote it is better than losing the report, and both are better
      // than printing it under the model's nick (the bug this exists to avoid).
      return {
        ...state,
        live: [
          ...live,
          {
            role: 'assistant',
            from: agentNick(row?.agentType, row?.toolUseId, row?.harness),
            text: action.text,
            at: Date.now()
          }
        ],
        tail: null
      }
    }
    case 'finish': {
      const live = state.tail ? [...state.live, state.tail] : [...state.live]
      // The turn is over, so nothing is still working. agent.ts closes each row
      // as its result returns and sweeps orphans, but a row left pulsing after
      // the answer is printed would be the panel telling a story the session
      // has already ended. `base` too: a panel that opened mid-turn read those
      // rows off disk as running, and nothing else will ever close them.
      const base = [...state.base]
      for (let i = 0; i < base.length; i++) {
        if (base[i].role === 'subagent' && base[i].running) {
          base[i] = { ...base[i], running: false, lastTool: '' }
        }
      }
      for (let i = 0; i < live.length; i++) {
        if (live[i].role === 'subagent' && live[i].running) {
          live[i] = { ...live[i], running: false, lastTool: '' }
        }
      }
      // A turn that only ran tools has no assistant entry to stamp, and the
      // cost of a turn that said nothing has nowhere to be printed. A line with
      // `from` is not this turn's to stamp: an agent's report ending the turn
      // would print the PARENT's elapsed and fill on the agent's header.
      for (let i = live.length - 1; i >= 0; i--) {
        if (live[i].role !== 'assistant' || live[i].from) continue
        live[i] = { ...live[i], ms: action.ms, contextTokens: action.tokens || live[i].contextTokens }
        break
      }
      // `since` survives the turn: a transcript read slow enough to land after
      // the answer would still be carrying a copy of it.
      return { ...state, base, live, tail: null }
    }
  }
}
