// Taking a worktree down completely: its processes, its Herd site and database,
// then the tree itself.
//
// Its own module so the colony runner can clean up a merged task without
// importing index.ts, which is where the IPC half of this used to live.

import { stopDev } from './devServer'
import { killCommandsForWorktree } from './commandRunner'
import { killTerminalsForWorktree } from './terminal'
import { dropWorktreeDatabase, unlinkWorktreeSite } from './provision'
import { removeWorktree } from './git'

// Everything spawned inside a worktree, stopped — before it is removed. Agent
// sessions are stopped by the renderer beforehand.
export function stopWorktreeProcesses(target: string): void {
  stopDev(target)
  killCommandsForWorktree(target)
  killTerminalsForWorktree(target)
}

/**
 * The guided remove's steps with nobody to confirm them: stop, unlink the site,
 * drop the database, remove the tree. The site and database steps are
 * best-effort and skip themselves on a stack that has neither — a leftover
 * database is litter, not a reason to keep the tree.
 */
export async function teardownWorktree(root: string, target: string): Promise<void> {
  stopWorktreeProcesses(target)
  const quiet = (): void => undefined
  await unlinkWorktreeSite(target, quiet).catch(() => undefined)
  await dropWorktreeDatabase(target, root, quiet).catch(() => undefined)
  await removeWorktree(root, target)
}
