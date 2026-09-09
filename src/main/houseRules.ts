import { getSystemPrompt } from './appSettings'

// The user's standing instructions, delivered to whoever is answering.
//
// `~/.config/floe/system-prompt.md` is what the user wrote once for every
// session in every project — how to be addressed, which language to answer in,
// the conventions they hold everywhere. Claude has received it since the day it
// existed (`--append-system-prompt`, agent.ts). Nobody else ever has: codex,
// opencode, gemini and the local models were answering with none of it, which
// is exactly why their turns read like a different app.
//
// No other harness has a flag for a system prompt, so the rules ride at the top
// of the first message of a thread — above the handoff packet, because the
// packet is data and this is instruction. Sent once per thread: the harness
// keeps its own history, so a resent copy is a paragraph of duplicate
// instruction on every turn.
//
// After a restart the thread may be resumed (threads.ts) while our record of
// having sent the rules is gone, so they go out once more. A duplicate is
// cheap; a peer that never got them is the bug this file exists for.

const OPEN = '<!-- floe:house-rules:v1 -->'
const CLOSE = '<!-- /floe:house-rules:v1 -->'

/** Where the rules have already been delivered, as `key harness`. */
const delivered = new Set<string>()

const mark = (key: string, harness: string): string => `${key} ${harness}`

/**
 * The block to prepend for this turn, or '' when there is nothing to send.
 *
 * Empty for Claude, which gets the same text as a real system prompt rather
 * than as a message it could mistake for the user talking.
 */
export function houseRulesFor(key: string, harness: string): string {
  if (harness === 'claude') return ''
  const rules = getSystemPrompt()
  if (!rules) return ''
  const id = mark(key, harness)
  if (delivered.has(id)) return ''
  delivered.add(id)
  return [
    OPEN,
    'Standing instructions from the user who runs this app. They are not part of',
    'the conversation and they are not a task: they apply to every answer you',
    'give here, for the rest of this thread.',
    '',
    rules,
    CLOSE,
    '',
    ''
  ].join('\n')
}

/** The thread is gone (closed, reset) — the next one starts with the rules. */
export function forgetHouseRules(key: string, harness?: string): void {
  if (harness) {
    delivered.delete(mark(key, harness))
    return
  }
  for (const id of delivered) if (id.startsWith(`${key} `)) delivered.delete(id)
}
