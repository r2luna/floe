// Who is in the channel, and how you name them in a sentence.
//
// The transcript is a channel with several voices in it — you, the model
// answering you, the subagents it sends out, other sessions, other runtimes.
// Once there is more than one, "ask it again" stops meaning anything, so each
// voice gets a handle you can point at: `@explore-3fa9`, `@codex`, `@floe-8f`.
//
// A handle REFERENCES, it does not route: `@codex revisa isso` still goes to
// the model you are talking to, which reads the handle and calls that agent.

import type { TranscriptItem } from '../../main/claudeSessions'
import { agentNick } from '../../shared/nicks.ts'

export interface Handle {
  nick: string
  /** What kind of voice this is — the menu says it, and it orders the list. */
  kind: 'you' | 'model' | 'agent' | 'session' | 'runtime'
  /** The last thing it was doing, when there is one: a Task's description. */
  detail?: string
}

/**
 * A handle at the start of a word: `@nick`. Never mid-word, so `user@host` and
 * an email address are left alone — the same rule the composer's `/` and `#`
 * menus use (see trigger.ts).
 */
const MENTION = /(^|[\s(])@([a-z0-9][a-z0-9-]*)/g

/**
 * Split `text` into runs of plain text and the handles mentioned in it, in
 * order. The renderer draws the handles as chips; everything else is left
 * exactly as it was typed.
 */
export function splitMentions(text: string): Array<{ text: string; nick?: string }> {
  const out: Array<{ text: string; nick?: string }> = []
  let at = 0
  for (const m of text.matchAll(MENTION)) {
    const start = (m.index ?? 0) + m[1].length
    if (start > at) out.push({ text: text.slice(at, start) })
    out.push({ text: `@${m[2]}`, nick: m[2] })
    at = start + 1 + m[2].length
  }
  if (at < text.length) out.push({ text: text.slice(at) })
  return out
}

/**
 * Everyone you can name right now: the voices that have spoken in this
 * conversation, then the runtimes you can still call into it.
 *
 * Most recent first among the agents, because the one you mean is almost always
 * the one that just answered. `you` and the model lead the list — they are the
 * two constants of every channel.
 */
export function rosterOf(
  items: TranscriptItem[],
  opts: { you: string; model: string; runtimes?: string[] }
): Handle[] {
  const out: Handle[] = [
    { nick: opts.you, kind: 'you', detail: 'you' },
    { nick: opts.model, kind: 'model', detail: 'answering here' }
  ]
  const seen = new Set(out.map((h) => h.nick))
  // Backwards: the newest voice is the one you are most likely to mean.
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.role === 'subagent') {
      const nick = agentNick(item.agentType, item.toolUseId, item.harness)
      if (seen.has(nick)) continue
      seen.add(nick)
      out.push({ nick, kind: 'agent', detail: item.summary || item.agentType })
      continue
    }
    // A voice that spoke: another session (role 'user') or an agent's report
    // (role 'assistant'). Both carry the nick they spoke under.
    if (!item.from || seen.has(item.from)) continue
    seen.add(item.from)
    out.push({
      nick: item.from,
      kind: item.role === 'user' ? 'session' : 'agent',
      detail: item.role === 'user' ? 'another session' : 'reported back'
    })
  }
  // A runtime nobody has called yet is still someone you can address — that is
  // how `@codex` gets into a conversation it has not joined.
  for (const nick of opts.runtimes ?? []) {
    if (seen.has(nick)) continue
    seen.add(nick)
    out.push({ nick, kind: 'runtime', detail: 'available' })
  }
  return out
}
