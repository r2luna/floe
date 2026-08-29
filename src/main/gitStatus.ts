import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { WorktreeStatus } from '../shared/types'

const exec = promisify(execFile)

/**
 * One worktree's git dirt, as the sidebar prints it: `+2 ~5 −1 ⇡2 ⇣3`.
 *
 * Deliberately NOT part of listWorktrees: that call gates landing on a session,
 * and a `git status` per worktree was what made it slow (see the note there).
 * The sidebar asks for this separately, after the list is already on screen.
 */
export function parseStatus(out: string): WorktreeStatus {
  const status: WorktreeStatus = {
    added: 0,
    modified: 0,
    deleted: 0,
    ahead: 0,
    behind: 0,
    upstream: false
  }
  for (const line of out.split('\n')) {
    if (!line) continue
    if (line.startsWith('## ')) {
      // `## feat/x...origin/feat/x [ahead 2, behind 3]`. No `...` means the
      // branch has no upstream — nothing to push TO, which is a different
      // statement from "nothing to push".
      status.upstream = line.includes('...')
      status.ahead = Number(/\bahead (\d+)/.exec(line)?.[1] ?? 0)
      status.behind = Number(/\bbehind (\d+)/.exec(line)?.[1] ?? 0)
      continue
    }
    // Counted per FILE, and by what happened to the file — not by staged vs
    // unstaged. "What do I have to commit" is the question the row answers.
    const xy = line.slice(0, 2)
    if (xy === '??') status.added++
    else if (xy.includes('A')) status.added++
    else if (xy.includes('D')) status.deleted++
    else if (xy.trim()) status.modified++
  }
  return status
}

export async function worktreeStatus(path: string): Promise<WorktreeStatus | null> {
  try {
    // `--no-renames` so a rename reads as one delete plus one add, which is what
    // the two numbers already mean — and keeps the line format to a plain XY.
    const { stdout } = await exec('git', [
      '-C',
      path,
      'status',
      '--porcelain=v1',
      '-b',
      '--no-renames',
      '--untracked-files=all'
    ])
    return parseStatus(stdout)
  } catch {
    // Not a repo, or the worktree is gone from disk. The row just shows nothing.
    return null
  }
}
