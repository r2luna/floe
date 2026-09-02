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
// that opens with `@codex` is routed exactly as the composer would route it, so
// the two hold a real conversation instead of taking turns at you.
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
      : `To ask ${harness} something back, START your reply with \`@${harness} \` and the rest of that first line is handed to it — its answer comes back here and you get it. Anything else you write is just your answer in the chat.`,
    CLOSE
  ].join('\n')
}

/** The stand-in for a relayed line in the transcript — stripped like the rest. */
export const relayMark = (from: string): string => `${OPEN} from="${from}"/>`

/**
 * The harness a relayed reply hands the conversation back to, if it does.
 *
 * The same rule as the composer's, and deliberately the same function: `@codex`
 * at the start of the line addresses it, anywhere else it is only a name. A
 * handle with nothing after it is not a question, and does not spend a hop.
 */
export function relayBack(reply: string, harnesses: readonly string[], hops: number): Route | null {
  if (hops >= MAX_HOPS) return null
  const route = routeAt(reply, harnesses)
  return route?.prompt.trim() ? route : null
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
