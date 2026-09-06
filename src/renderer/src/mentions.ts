// Who is in the channel, and how you name them in a sentence.
//
// The transcript is a channel with several voices in it — you, the model
// answering you, the subagents it sends out, other sessions, other runtimes.
// Once there is more than one, "ask it again" stops meaning anything, so each
// voice gets a handle you can point at: `@explore-3fa9`, `@codex`, `@floe-8f`.
//
// WHERE the handle sits decides what it does. Mid-sentence it REFERENCES —
// `pergunta pro @codex` goes to the model you are talking to, which reads the
// handle and calls that agent. At the START of the line it ROUTES: `@codex
// revisa isso` hands that one message to codex itself, and codex answers into
// this chat as another voice in it. Nothing about the session changes; the next
// message goes back to whoever the picker names.

import type { TranscriptItem } from '../../main/claudeSessions'
import { agentNick } from '../../shared/nicks.ts'
import { EFFORTS, harnessDefault } from './models.ts'
import type { PaletteItem } from './fuzzy.ts'
import { NEEDS_MODEL } from '../../shared/modes.ts'
// The handle parser is shared with main: an agent's `send_message` reads
// `@codex …` the same way the composer does. See shared/mentions.ts.
import { routeAt } from '../../shared/mentions.ts'

export { routeAt, routeAll, type Route } from '../../shared/mentions.ts'

export interface Handle {
  nick: string
  /** What kind of voice this is — the menu says it, and it orders the list. */
  kind: 'you' | 'model' | 'agent' | 'session' | 'runtime'
  /** The last thing it was doing, when there is one: a Task's description. */
  detail?: string
}

/**
 * A handle at the start of a word: `@nick`, and the `:model:effort` a routing
 * handle can carry. Never mid-word, so `user@host` and an email address are
 * left alone — the same rule the composer's `/` and `#` menus use (see
 * trigger.ts).
 */
const MENTION = /(^|[\s(])@([a-z0-9][a-z0-9-]*(?::[\w./-]+)*)/g

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
    // The whole handle is one chip, but the NICK is the name alone: the colour
    // is the speaker's, and `@codex:high` must not be a different colour from
    // `@codex` for having said how hard to think.
    out.push({ text: `@${m[2]}`, nick: m[2].split(':')[0] })
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

/**
 * The `@` menu: one row per voice, and under the harnesses, what to answer with.
 *
 * The top level is the roster — who is here. → then narrows a harness to its
 * models, and a model to the five efforts, each level writing a longer handle
 * than the last (`@codex`, `@codex:gpt-5.6-sol`, `@codex:gpt-5.6-sol:high`).
 * Every level is pickable on its own, so naming a model is something you CAN
 * do, never something you have to do.
 *
 * Only a harness gets variants. A subagent or another session is a reference,
 * and there is nothing to choose about how it answers.
 */
export function handleRows(
  roster: Handle[],
  opts: { harnesses: string[]; modelsOf: (harness: string) => { slug: string; label?: string }[] }
): PaletteItem[] {
  const efforts = (handle: string): PaletteItem[] =>
    EFFORTS.map((e) => ({ id: `${handle}:${e}`, title: e, group: 'effort' }))

  return roster.map((h) => {
    const row: PaletteItem = {
      id: `@${h.nick}`,
      title: h.nick,
      detail: h.detail,
      group: h.kind
    }
    if (!opts.harnesses.includes(h.nick)) return row
    const set = harnessDefault(h.nick)
    const models = opts.modelsOf(h.nick)
    // What naming no model actually gets you. A harness that needs one TOLD
    // does not have an "own" model to fall back on — LM Studio answers on
    // whatever is loaded, and Ollama says so plainly — and the row must not
    // promise otherwise.
    const bare = NEEDS_MODEL.includes(h.nick) ? 'whichever is loaded' : "the harness's own"
    return {
      ...row,
      variants: [
        // Its own default first: the row you want most of the time is the one
        // that says nothing, and it still has efforts under it.
        {
          id: `@${h.nick}`,
          title: set.model || 'default',
          detail: set.model ? 'from floe.toml' : bare,
          group: 'model',
          variants: efforts(`@${h.nick}`)
        },
        ...models
          .filter((m) => m.slug !== set.model)
          .map((m) => ({
            id: `@${h.nick}:${m.slug}`,
            title: m.slug,
            // Only when it says something the slug does not: LM Studio's label
            // IS its slug, and a row that prints the same words twice is noise.
            detail: m.label === m.slug ? undefined : m.label,
            group: 'model',
            variants: efforts(`@${h.nick}:${m.slug}`)
          }))
      ]
    }
  })
}

/**
 * The transcript with the addressed turns taken out.
 *
 * A session answers as whoever answered it LAST — which is how reopening a
 * codex chat puts the picker back on codex. A message handed to `@lmstudio` is
 * not that: it was one turn, and letting it repoint the session would make a
 * single question permanently change what the chat is. So the turns that
 * answered an addressed line do not count as the session's own voice.
 */
export function unrouted<T extends { role: string; text?: string }>(
  items: T[],
  harnesses: string[]
): T[] {
  let addressed = false
  return items.filter((item) => {
    if (item.role === 'user') {
      addressed = !!item.text && !!routeAt(item.text, harnesses)
      return true
    }
    // Everything up to the next user line belongs to that turn.
    return !addressed
  })
}
