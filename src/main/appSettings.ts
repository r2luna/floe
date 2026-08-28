import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDir, dataDir } from './dataDir'

// Small global (per-machine) settings that main-process code needs outside any
// one session — e.g. a system prompt every spawned Claude process should get,
// regardless of which project/worktree/pipeline started it. Renderer-only
// cosmetics (theme, fonts…) stay in localStorage; this is for things agent.ts
// itself reads when it spawns the CLI.
//
// The system prompt is prose, so it lives as its own Markdown file in
// `configDir()` — greppable, diffable, and safe to keep in a dotfiles repo,
// instead of one JSON string with escaped newlines. The old
// `<userData>/appSettings.json` is still read as a fallback and migrated on
// first read.

const promptFile = (): string => join(configDir(), 'system-prompt.md')
const legacyFile = (): string => join(dataDir(), 'appSettings.json')

function readLegacy(): string {
  const file = legacyFile()
  if (!existsSync(file)) return ''
  try {
    return (JSON.parse(readFileSync(file, 'utf8')) as { systemPrompt?: string }).systemPrompt ?? ''
  } catch {
    return ''
  }
}

export function getSystemPrompt(): string {
  const file = promptFile()
  if (existsSync(file)) {
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return ''
    }
  }
  const legacy = readLegacy()
  // Migrate once, so the prompt shows up in the config dir without waiting for
  // the user to open Settings and re-save it.
  if (legacy) setSystemPrompt(legacy)
  return legacy
}

export function setSystemPrompt(value: string): void {
  writeFileSync(promptFile(), value)
}
