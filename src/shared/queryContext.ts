/**
 * What a query knows about the chat it was opened from, on its first turn.
 *
 * A query used to start blank: `@codex confere o erro` reached codex with no
 * error in it, and codex asked for the thing the chat beside it had been
 * talking about for an hour. So the first turn carries the chat — as a summary
 * the parent's own CLI writes from a forked copy of the session, or, where
 * there is no Claude session to fork, as the raw tail of the conversation
 * (buildPacket, the same block a harness switch sends).
 *
 * This module is the part with no I/O: the instruction the summariser gets,
 * and the block the summary travels in. See main/queries.ts for when it runs.
 */
import { PACKET_CLOSE, PACKET_OPEN, UNTRUSTED_NOTICE } from './handoff'

/** What the forked session is asked, with the message the query is about. */
export function summaryInstruction(harness: string, prompt: string): string {
  return [
    `Another agent (${harness}) is about to answer a side question about this conversation.`,
    'It has not seen any of it. Write the briefing it needs to answer well:',
    'the goal, what was found or decided so far, open problems, and the files',
    'and file:line references involved. Plain prose and short lists, no preamble,',
    'at most 300 words. Do not answer the question yourself.',
    '',
    'The question:',
    prompt
  ].join('\n')
}

/**
 * The summary, wrapped as a packet.
 *
 * The packet markers are the point: `sessionTranscript` strips them, so the
 * summary never reads back as something the user typed in the query, and a
 * merge does not ship the chat's own summary back into the chat.
 */
export function summaryPacket(summary: string): string {
  return [
    PACKET_OPEN,
    'You are answering a side question about a conversation you were not part of. ' +
      'Below is a summary of it, written by the model running that conversation.',
    '',
    UNTRUSTED_NOTICE,
    '',
    '=== summary ===',
    summary.trim(),
    '=== end of summary ===',
    '',
    "The user's message follows.",
    PACKET_CLOSE,
    '',
    ''
  ].join('\n')
}
