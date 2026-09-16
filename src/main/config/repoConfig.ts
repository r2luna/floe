// `<repo>/.floe/` — the project's own config, kept in the repository.
//
// What describes the project lives with it: its settings (config.toml), its
// processes (commands.toml), its MCP servers (mcp.toml) and its skills. The
// global `~/.config/floe/projects/<dir>/config.toml` keeps only what this
// machine needs to find the repo and draw it in the sidebar.
//
// Anything that must not be committed goes under `.floe/local/`, which
// `.floe/.gitignore` keeps out of git: MCP credentials, and commands scoped to
// one worktree by absolute path.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const repoFloeDir = (projectPath: string): string => join(projectPath, '.floe')
export const repoLocalDir = (projectPath: string): string => join(repoFloeDir(projectPath), 'local')
export const repoConfigPath = (projectPath: string): string => join(repoFloeDir(projectPath), 'config.toml')

/** Create `.floe/`, and keep `local/` ignored the first time anything lands there. */
export function ensureRepoDir(projectPath: string, local = false): string {
  const dir = local ? repoLocalDir(projectPath) : repoFloeDir(projectPath)
  mkdirSync(dir, { recursive: true })
  if (local) ensureIgnore(projectPath)
  return dir
}

function ensureIgnore(projectPath: string): void {
  const file = join(repoFloeDir(projectPath), '.gitignore')
  const raw = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (raw.split(/\r?\n/).some((line) => line.trim() === 'local/')) return
  writeFileSync(file, `${raw}${raw && !raw.endsWith('\n') ? '\n' : ''}local/\n`)
}
