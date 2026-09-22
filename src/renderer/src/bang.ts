// `!command` — shell mode.
//
// A draft that OPENS with `!` is not a message. The rest of the line is run in
// this chat's worktree and what it printed becomes the message, so the model
// works on top of a real result instead of guessing at one. The command line
// itself never goes out as text — typing `!git status` and getting a model's
// impression of what git would have said is the one outcome this must never
// produce.
//
// The parser lives apart from the composer because two sides read the same
// draft: the composer paints it (the `!` and the command are drawn as a
// command, not as prose) and the chat runs it.

import type { Token } from './markdown.ts'

/**
 * This draft is addressed to the shell.
 *
 * Only `!` — not whether there is anything after it. The moment the key is
 * pressed the composer changes colour, which is how the mode announces itself
 * to someone who did not know it was there.
 */
export const isBang = (text: string): boolean => text.trimStart().startsWith('!')

/** The command a `!` draft names, or null when there is nothing to run. */
export function readBang(text: string): string | null {
  const t = text.trim()
  if (!t.startsWith('!')) return null
  return t.slice(1).trim() || null
}

/** The longest run of backticks in `s` — what a fence has to beat to hold it. */
function ticks(s: string): number {
  let longest = 0
  let run = 0
  for (const ch of s) {
    run = ch === '`' ? run + 1 : 0
    if (run > longest) longest = run
  }
  return longest
}

/** `s` as inline code, wide enough to survive the backticks inside it. */
function inline(s: string): string {
  const fence = '`'.repeat(ticks(s) + 1)
  // A span whose text touches a backtick at either edge needs a space there;
  // the reader takes exactly one back off. `!echo \`date\`` is the whole reason.
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${s}${pad}${fence}`
}

/**
 * What the agent is told once the command has run.
 *
 * It reads as the user's own sentence — "I ran this, here is what it printed" —
 * because that is what it is: the run happened here, and the model is handed
 * the result. A non-zero exit is part of the result, not an error to swallow:
 * a failing build is usually the whole reason for running it.
 *
 * The fence is sized to the output rather than fixed at three backticks. A
 * command that prints markdown (`!cat README.md`, `!gh pr view`) closes a
 * three-tick fence halfway through and hands the model a truncated blob under
 * a stray heading.
 */
export function bangPrompt(command: string, output: string, code: number): string {
  const body = output.trim() || '(no output)'
  const head = code === 0 ? inline(command) : `${inline(command)} (exit ${code})`
  const fence = '`'.repeat(Math.max(3, ticks(body) + 1))
  return `I ran ${head}:\n\n${fence}\n${body}\n${fence}`
}

/**
 * The draft painted as a command: the `!` as its marker, the rest in the tone
 * that says it runs. Markdown highlighting is wrong here — `#` is a comment
 * and `*.ts` is a glob, and drawing them as a heading and an emphasis is the
 * composer claiming to be reading something it is not.
 */
export function bangTokens(text: string): Token[] {
  const at = text.length - text.trimStart().length
  const out: Token[] = []
  if (at) out.push({ text: text.slice(0, at), cls: '' })
  out.push({ text: '!', cls: 'md-bang' })
  const rest = text.slice(at + 1)
  if (rest) out.push({ text: rest, cls: 'md-shell' })
  return out
}
