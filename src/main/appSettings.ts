import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { configDir } from './dataDir'
import { floeConfig } from './config/floe'
import { writeFileAtomic } from './config/io'

// The system prompt every spawned Claude process gets, whatever project,
// worktree or pipeline started it.
//
// It is prose, so it lives as its own Markdown file in `configDir()` —
// greppable, diffable, and safe to keep in a dotfiles repo — instead of one JSON
// string with escaped newlines. Which file is `[agent] system-prompt` in
// floe.toml, but the answer always resolves inside the config directory: the
// whole point of that directory is that copying it moves your setup, and a
// prompt sitting somewhere else would not come along.

/** The name a generated floe.toml carries, and the fallback for a bad one. */
const DEFAULT_PROMPT_FILE = 'system-prompt.md'

function promptFile(): string {
  const dir = configDir()
  const configured = floeConfig().agent.systemPromptFile
  const file = resolve(dir, configured)
  // `resolve` already absorbs a leading `/` or a `~` that never expanded; what
  // it can't absorb is `../` climbing out. A name that leaves the directory is
  // not a name we honour — fall back to the default rather than write there.
  const inside = relative(dir, file)
  if (!inside || inside.startsWith('..')) return join(dir, DEFAULT_PROMPT_FILE)
  return file
}

export const systemPromptPath = promptFile

/**
 * The generated file's explanation, written as HTML comments.
 *
 * The same reason floe.toml ships documented: a file you can't see is a file you
 * don't know you can change. Comments rather than prose because everything left
 * in this file is sent to the model verbatim — the header has to be invisible to
 * it, or a freshly generated file would start every session by explaining Floe's
 * config layout to the agent.
 */
export const SYSTEM_PROMPT_MD = `<!--
===============================================================================
 Floe — system prompt
===============================================================================
 Whatever you write here is appended to the built-in system prompt of EVERY
 session Floe starts, in every project and every worktree. Leave it empty and
 nothing is appended at all.

 Use it for what is true of you rather than of one repo — how you want to be
 addressed, the language to answer in, conventions you hold everywhere. Anything
 that belongs to a single project belongs in that project's CLAUDE.md instead.

 HTML comments like this one are stripped before the text is sent, so notes to
 yourself cost the model nothing.

 Which file this is is \`[agent] system-prompt\` in floe.toml. It always lives in
 this directory, so copying ~/.config/floe brings your prompt with it.
===============================================================================
-->
`

/**
 * Create the file if it isn't there.
 *
 * Generated on every boot, like the rest of the config directory: the prompt is
 * a feature you discover by finding the file, not one you have to be told about.
 */
export function ensureSystemPrompt(): void {
  const file = promptFile()
  if (existsSync(file)) return
  mkdirSync(dirname(file), { recursive: true })
  writeFileAtomic(file, SYSTEM_PROMPT_MD)
}

/** Drop the header and anything else commented out; empty means "append nothing". */
export function stripPromptComments(raw: string): string {
  return raw.replace(/<!--[\s\S]*?-->/g, '').trim()
}

export function getSystemPrompt(): string {
  const file = promptFile()
  if (!existsSync(file)) return ''
  try {
    return stripPromptComments(readFileSync(file, 'utf8'))
  } catch {
    return ''
  }
}

export function setSystemPrompt(value: string): void {
  const file = promptFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileAtomic(file, value)
}
