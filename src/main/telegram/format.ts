// What the bot says, as text. Pure, so every message shape is tested without a
// bot behind it. Plain text, never Markdown: an agent's answer is full of `_`
// and `*` that Telegram's parser would reject as broken entities and drop the
// whole message.

import type { AgentPermission, AgentQuestion } from '../../shared/types'

/** Telegram's hard limit is 4096 characters; the label and part marker need room. */
export const MAX_TEXT = 3900

/** How many messages one answer may take before the start of it is dropped. */
export const MAX_PARTS = 4

export interface SessionInfo {
  /** Floe's own session id — what send_message takes. */
  id: string
  title: string
  worktreePath: string
}

const lastSegment = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

/** `floe/telegram · Fix the login` for a worktree, `floe · Fix the login` for the main checkout. */
export function sessionLabel(s: SessionInfo): string {
  const [repo, worktree] = s.worktreePath.split('/.worktrees/')
  const where = worktree ? `${lastSegment(repo)}/${worktree}` : lastSegment(repo)
  return `${where} · ${s.title || 'Untitled'}`
}

/**
 * Split an answer into messages, breaking at a paragraph or line where one is
 * close. Past MAX_PARTS the START is dropped: the end of an agent's answer is
 * where it says what it did and what it needs.
 */
export function chunk(text: string, max = MAX_TEXT, parts = MAX_PARTS): string[] {
  const out: string[] = []
  let rest = text.trim()
  while (rest.length > max) {
    const window = rest.slice(0, max)
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'))
    const at = cut > max / 2 ? cut : max
    out.push(rest.slice(0, at).trimEnd())
    rest = rest.slice(at).trimStart()
  }
  if (rest) out.push(rest)
  if (out.length <= parts) return out
  const dropped = out.length - parts
  return [`(${dropped} earlier part${dropped > 1 ? 's' : ''} omitted)\n\n${out[out.length - parts]}`, ...out.slice(-parts + 1)]
}

/** A finished turn: the label, then the answer, split to fit. */
export function doneMessages(label: string, text: string, ok: boolean): string[] {
  const head = ok ? `✅ ${label}` : `⏹ ${label} (stopped)`
  const body = chunk(text)
  if (!body.length) return [`${head}\n\n(no text in the final message)`]
  return body.map((part, i) => (i === 0 ? `${head}\n\n${part}` : part))
}

export function errorMessage(label: string, message: string): string {
  return `⚠️ ${label}\n\n${message.slice(0, MAX_TEXT)}`
}

export function permissionMessage(label: string, p: AgentPermission): string {
  const what = p.summary ? `${p.toolName}: ${p.summary}` : p.toolName
  return `🔐 ${label}\n\nWants to run ${what.slice(0, MAX_TEXT)}`
}

export function questionMessage(label: string, questions: AgentQuestion[]): string {
  const lines = questions.map((q) => {
    const opts = q.options.map((o, i) => `  ${i + 1}. ${o.label}`).join('\n')
    return opts ? `${q.question}\n${opts}` : q.question
  })
  const hint = questions.length === 1 && questions[0].options.length ? 'Tap an option or reply with text.' : 'Reply with your answer.'
  return `❓ ${label}\n\n${lines.join('\n\n')}\n\n${hint}`.slice(0, MAX_TEXT)
}

export const HELP = [
  'Floe relays your chats here while you are away from it.',
  '',
  'Reply to a message to answer that chat.',
  'Plain text goes to the chat you last heard from (or picked).',
  '',
  '/sessions — recent chats, tap one to talk to it',
  '/status — away state and current chat',
  '/help — this message'
].join('\n')

export const COMMANDS = [
  { command: 'sessions', description: 'Recent chats' },
  { command: 'status', description: 'Away state and current chat' },
  { command: 'help', description: 'How this works' }
]

export interface Command {
  name: string
  arg: string
}

/** `/use@floe_bot 3` → { name: 'use', arg: '3' }; null for anything that is not a command. */
export function parseCommand(text: string): Command | null {
  const m = /^\/([a-z_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/i.exec(text.trim())
  return m ? { name: m[1].toLowerCase(), arg: (m[2] ?? '').trim() } : null
}
