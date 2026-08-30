import type { TranscriptItem } from '../../main/claudeSessions'

// The transcript panel's state machine, kept apart from the hook that drives
// it: these are the rules that say where a line lands and which row an event
// belongs to, and they are worth testing without mounting React.

// Everything this panel has streamed, split in two: `live` holds the settled
// entries (user turns, tool rows, finished assistant runs), `tail` the one
// assistant run still growing. Only the tail changes per delta.
export interface LiveState {
  live: TranscriptItem[]
  tail: TranscriptItem | null
}

export type LiveAction =
  | { type: 'reset' }
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
  // The turn ended: settle the tail, then stamp what it cost onto the LAST
  // assistant entry of the run — the one the footer prints under.
  | { type: 'finish'; ms?: number; tokens: number }

// Exported for its unit test: the subagent rules (patch by id, never append a
// second row, never let a turn end with a row still working) are the kind of
// thing you cannot see by looking at a screenshot of one happy path.
export function liveReducer(state: LiveState, action: LiveAction): LiveState {
  switch (action.type) {
    case 'reset':
      return { live: [], tail: null }
    case 'push': {
      const live = state.tail ? [...state.live, state.tail] : state.live
      return { live: [...live, action.item], tail: null }
    }
    case 'text':
      return state.tail
        ? {
            ...state,
            tail: { ...state.tail, text: (state.tail.text ?? '') + (action.item.text ?? '') }
          }
        : { ...state, tail: action.item }
    case 'settle':
      return state.tail ? { live: [...state.live, state.tail], tail: null } : state
    case 'agent': {
      // Newest first: a session that ran the same agent twice patches the row
      // that is still open, not the one that already closed.
      for (let i = state.live.length - 1; i >= 0; i--) {
        const row = state.live[i]
        if (row.role !== 'subagent' || row.toolUseId !== action.toolUseId) continue
        const next = { ...row }
        for (const [k, v] of Object.entries(action.patch)) {
          if (v !== undefined) (next as Record<string, unknown>)[k] = v
        }
        const live = [...state.live]
        live[i] = next
        return { ...state, live }
      }
      return state
    }
    case 'finish': {
      const live = state.tail ? [...state.live, state.tail] : [...state.live]
      // The turn is over, so nothing is still working. agent.ts closes each row
      // as its result returns and sweeps orphans, but a row left pulsing after
      // the answer is printed would be the panel telling a story the session
      // has already ended.
      for (let i = 0; i < live.length; i++) {
        if (live[i].role === 'subagent' && live[i].running) {
          live[i] = { ...live[i], running: false, lastTool: '' }
        }
      }
      // A turn that only ran tools has no assistant entry to stamp, and the
      // cost of a turn that said nothing has nowhere to be printed.
      for (let i = live.length - 1; i >= 0; i--) {
        if (live[i].role !== 'assistant') continue
        live[i] = { ...live[i], ms: action.ms, contextTokens: action.tokens || live[i].contextTokens }
        break
      }
      return { live, tail: null }
    }
  }
}
