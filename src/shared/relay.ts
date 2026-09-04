// What happens after the harness you addressed answers.
//
// `@codex revisa isso` hands one message to codex, and until now that was the
// whole of it: codex answered into the chat and the model the session is set to
// never read a word of it. The two never talked — you did, by copying one's
// answer into the other's box.
//
// So a routed turn is followed by a turn on the session's own model, handed the
// answer that just landed (the words themselves ride in the handoff packet —
// see main/handoff.ts) and told to act on it. And it can answer BACK: a reply
// with `@codex` at the start of one of its lines is routed exactly as the
// composer would route it, so the two hold a real conversation instead of
// taking turns at you.
//
// This file is the policy — what is said, and how long it may go on. The wiring
// that starts the turns is main/relay.ts.

import { routeAt, type Route } from './mentions.ts'

/**
 * How many times the session's own model may hand the conversation back.
 *
 * Two models that keep asking each other one more question is a loop nobody
 * ordered, and every hop is a real turn on a real CLI. Three is enough for
 * "answer / that is wrong because X / fair, then Y" and short enough that a
 * runaway costs minutes, not an afternoon.
 */
export const MAX_HOPS = 3

/**
 * The envelope the relay prompt travels in.
 *
 * Marked because it is plumbing, not conversation: the transcript strips it
 * (see stripRelay) so the chat shows codex's answer and the model's reply to
 * it, and not the note that made one follow the other.
 */
const OPEN = '<floe-relay'
const CLOSE = '</floe-relay>'

/**
 * What the session's own model is handed when the harness answers.
 *
 * It is told three things, because without any one of them the turn reads as a
 * non sequitur: that the message was not addressed to it, that the answer above
 * is the other harness's, and that it may answer that harness directly.
 *
 * `hops` is how many exchanges have already happened, so the last one it is
 * allowed says so — a conversation that gets cut off mid-question is worse than
 * one that knows to land.
 */
export function relayPrompt(harness: string, hops = 0): string {
  const last = hops >= MAX_HOPS - 1
  const opening =
    hops === 0
      ? `The last message in this chat was addressed to ${harness}, not to you. ${harness} has now answered, above.`
      : `${harness} answered what you asked it, above.`
  return [
    `${OPEN} from="${harness}">`,
    opening,
    '',
    `Read it and act on it: say what you make of it, say where it is wrong and why, and do the work if there is work to do. Do not summarise it back — the person read it too.`,
    '',
    last
      ? `This is the last exchange with ${harness} on this thread, so close it out here rather than asking it something else.`
      : `To ask ${harness} something back, put \`@${harness} \` at the START of a line — that line and everything you write after it is handed to it, so say what you have to say first and address it last. Its answer comes back here and you get it.`,
    CLOSE
  ].join('\n')
}

/**
 * What the session's own model is handed when a query is peeked at or merged.
 *
 * The same envelope as the relay's, for the same reason: this is plumbing, and
 * read back off the transcript it would look like a message the user typed.
 *
 * The difference from `relayPrompt` is the one that matters here. A relay is
 * automatic and expects an answer back to the harness; a peek is something the
 * PERSON asked for, from a conversation running in its own panel — and there is
 * no handing anything back, because the query is still sitting there with a
 * composer in it. So the model is told to read and act, and told plainly not to
 * try to answer the other harness through this chat.
 */
export function queryPrompt(harness: string, opts: { merged: boolean; entries: number }): string {
  return [
    `${OPEN} from="${harness}">`,
    opts.merged
      ? `The ${harness} query beside this chat has been merged into it and closed. Everything it said that you had not already read is above.`
      : `You are being shown ${opts.entries === 1 ? 'a message' : `${opts.entries} messages`} from the ${harness} query running beside this chat. It stays open; this is a look at it, not a handover.`,
    '',
    'Read it and act on it: say what you make of it, say where it is wrong and why, and do the work if there is work to do. Do not summarise it back — the person read it too.',
    '',
    opts.merged
      ? `${harness} is gone from this thread. Anything else you want from it is a new query the person opens.`
      : `Do not address ${harness} from here — it has its own panel and the person is talking to it there. Answer to them.`,
    CLOSE
  ].join('\n')
}

/** The stand-in for a relayed line in the transcript — stripped like the rest. */
export const relayMark = (from: string): string => `${OPEN} from="${from}"/>`

/**
 * The harness a relayed reply hands the conversation back to, if it does.
 *
 * The same rule as the composer's — a handle at the start of a LINE addresses
 * it, mid-sentence it is only a name — but read over the whole reply rather
 * than its first character.
 *
 * That is the difference between the relay working and not. What arrives here
 * is everything the model said this turn, joined (see agent.ts's
 * `lastAssistantText`): the sentence it opened with, the note between two tool
 * calls, and then the line addressing codex. Requiring the handle at offset 0
 * meant a model that said one word before addressing it was never heard, which
 * is nearly every turn — the handle showed up in the chat and nothing was sent.
 *
 * The LAST such line wins, because a model writes its thinking first and its
 * question last, and everything from there to the end goes over: a question
 * worth relaying rarely fits on one line.
 */
export function relayBack(reply: string, harnesses: readonly string[], hops: number): Route | null {
  if (hops >= MAX_HOPS) return null
  const lines = reply.split('\n')
  // A handle inside code is a quote of one — the model showing how to address
  // codex, in an answer explaining that it can. Both spellings of a code block
  // count, because the model picks whichever suits the answer: a fence, and the
  // four-space indent that means the same thing in Markdown. Missing the second
  // was not theoretical — an answer that WROTE OUT the example addressed it.
  let fenced = false
  let found: { route: Route; at: number } | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Indented code. Checked first and outside a fence only, so that a fence
    // marker sitting in an indented block is code rather than a delimiter.
    if (!fenced && /^(?: {4}|\t)/.test(line)) continue
    // Up to three spaces is still a fence; the fourth made it code, above.
    if (/^ {0,3}(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const route = routeAt(line, harnesses)
    if (route) found = { route, at: i }
  }
  if (!found) return null
  const rest = [found.route.prompt, ...lines.slice(found.at + 1)].join('\n').trim()
  return rest ? { ...found.route, prompt: rest } : null
}

/** True when this text is one of our envelopes rather than something said. */
export const hasRelay = (text: string): boolean => text.includes(OPEN)

/**
 * The envelope taken out of a transcript entry.
 *
 * Ours, not the conversation's: read back, a relay prompt would look like a
 * message the user typed, and the whole point of the relay is that they did not
 * have to.
 */
export function stripRelay(text: string): string {
  return text
    .replace(new RegExp(`${OPEN}[^>]*/>`, 'g'), '')
    .replace(new RegExp(`${OPEN}[^>]*>[\\s\\S]*?${CLOSE}`, 'g'), '')
    .trim()
}
