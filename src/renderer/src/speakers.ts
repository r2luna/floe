import type { TranscriptItem } from '../../main/claudeSessions'
import { addressOf, speakerKey, userNick, type ModelChoice } from './models.ts'

// Who each line of the transcript belongs to, kept apart from the panel that
// draws it: these are the rules that decide whose header a line prints under,
// and they are worth testing without mounting React.

export type Who = ReturnType<typeof addressOf>

// `nick!ident@host`, the way IRC writes a speaker: who answered, how hard it
// was told to think, and which model it ran on. Changing either mid-conversation
// breaks the run and prints a fresh header, because it IS a different speaker:
// same name, different machine. The nick is who answered: the runtime, not
// always Claude.
export function whoOf(item: TranscriptItem): Who {
  // A message another session sent here is that session speaking, not you: it
  // heads with their nick, gets their colour, and breaks the run — which is
  // exactly what it is, someone else taking the floor.
  if (item.from) return addressOf(item.from)
  return addressOf(
    item.role === 'user' ? userNick() : (item.provider ?? 'claude'),
    item.model,
    item.effort
  )
}

/**
 * A row that is the AGENT working rather than something you said.
 *
 * Images are excluded on purpose: the ones you attach are pushed right after
 * your own message and belong to it, and the ones a tool read already follow
 * the tool row that fetched them. A slash command you typed is excluded by its
 * `by` flag — it reloads as a tool row, but you are the one who ran it.
 */
export function isAct(item: TranscriptItem): boolean {
  if (item.role === 'tool') return item.by !== 'user'
  return item.role === 'subagent' || item.role === 'artifact'
}

/**
 * This session's own voice: an assistant line it wrote itself.
 *
 * A line carrying `from` was written by someone else — a subagent's report, a
 * peer session's message — and quoting it does not make it the speaker who ran
 * the work around it.
 */
const isOwnVoice = (item: TranscriptItem): boolean => item.role === 'assistant' && !item.from

/** The next thing SAID by the agent, before anyone else speaks. -1 if none. */
export function nextAssistant(items: TranscriptItem[], from: number): number {
  for (let i = from; i < items.length; i++) {
    if (isOwnVoice(items[i])) return i
    if (items[i].role === 'user') break
  }
  return -1
}

/**
 * Whose work a run of acts is.
 *
 * The answer it must never give is "the user": a message of yours followed by
 * ten tool calls used to print those calls under YOUR header, so the log read
 * as if you had run them — while what actually happened is the model going to
 * work on what you had just said.
 *
 * Who it is, in order: whoever speaks next (the answer these calls are part
 * of), else whoever spoke last (a turn cut short before it said anything), else
 * whoever is answering now — see answeringWho.
 */
export function actOwner(items: TranscriptItem[], at: number, pending?: Who): Who | undefined {
  const next = nextAssistant(items, at)
  if (next !== -1) return whoOf(items[next])
  for (let i = at - 1; i >= 0; i--) {
    if (isOwnVoice(items[i])) return whoOf(items[i])
  }
  return pending
}

/**
 * Who is answering right now: the streaming tail, else whoever answered last in
 * this session, else the runtime the composer is pointed at. Only ever a
 * fallback — it heads work that started before a single word was said, and the
 * moment one is said the answer comes from the message itself.
 */
export function answeringWho(
  items: TranscriptItem[],
  tail?: TranscriptItem,
  choice?: ModelChoice
): Who {
  if (tail) return whoOf(tail)
  for (let i = items.length - 1; i >= 0; i--) {
    if (isOwnVoice(items[i])) return whoOf(items[i])
  }
  return addressOf(choice?.provider ?? 'claude', choice?.model, choice?.effort)
}

/**
 * Who spoke last — lets the streaming tail decide if it continues the run.
 *
 * Acts count here exactly as they do in the Log: a run of tool calls after your
 * message is already headed with the agent's nick, so the text that follows
 * them continues THAT run instead of opening a second header for one answer.
 */
export function lastSpeaker(items: TranscriptItem[], pending?: Who): string | null {
  let sawAct = false
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.role === 'user' || item.role === 'assistant') {
      if (item.role === 'assistant' || !sawAct) return speakerKey(whoOf(item))
      break
    }
    if (isAct(item)) sawAct = true
  }
  return sawAct && pending ? speakerKey(pending) : null
}
