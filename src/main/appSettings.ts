import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { configDir } from './dataDir'
import { floeConfig } from './config/floe'

// The system prompt every spawned Claude process gets, whatever project,
// worktree or pipeline started it.
//
// It is prose, so it lives as its own Markdown file in `configDir()` —
// greppable, diffable, and safe to keep in a dotfiles repo — instead of one JSON
// string with escaped newlines. Which file is `[agent] system-prompt` in
// floe.toml, so the prompt can be a file you already keep somewhere else.

function promptFile(): string {
  const configured = floeConfig().agent.systemPromptFile
  // A relative name resolves against the config dir, so the common case stays
  // `system-prompt.md` and an absolute path still points wherever you want.
  return isAbsolute(configured) ? configured : join(configDir(), configured)
}

export function getSystemPrompt(): string {
  const file = promptFile()
  if (!existsSync(file)) return ''
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

export function setSystemPrompt(value: string): void {
  writeFileSync(promptFile(), value)
}
