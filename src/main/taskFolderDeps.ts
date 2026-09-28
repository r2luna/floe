// The tasks panel wired to the real git and the real colony board.
//
// Kept out of taskFolders.ts so that file stays testable with plain node: it
// takes these as arguments, and the IPC handlers and MCP tools pass them in.

import type { BrowserWindow } from 'electron'
import { checkedOutBranch, commitPaths, defaultBranch, isTracked } from './git'
import { addTask, listTasks, type ColonyTask } from './colony/store'
import { pushBoard, releaseTask } from './colony/runner'
import { COLONY_SUBDIR, type CardLookup, type SendDeps } from './taskFolders'
import type { TaskCard } from '../shared/taskFolders'

function toCard(task: ColonyTask): TaskCard {
  return {
    id: task.id,
    stage: task.stage,
    status: task.status,
    ...(task.line ? { line: task.line } : {}),
    ...(task.branch ? { branch: task.branch } : {}),
    merged: !!task.mergedAt
  }
}

/**
 * The card a sent task became: the one whose spec folder is inside the task's.
 * By folder and not by name — the board renames a card whose name is taken,
 * but it never moves its spec folder.
 */
export const cardLookup: CardLookup = (root, folderName) => {
  const specDir = `specs/${folderName}/${COLONY_SUBDIR}`
  const found = listTasks(root).find((t) => t.specDir === specDir)
  return found ? toCard(found) : undefined
}

export function sendDeps(win: BrowserWindow | null | undefined): SendDeps {
  const needWindow = (): BrowserWindow => {
    if (!win || win.isDestroyed()) throw new Error('No Floe window is open to cut the worktree in')
    return win
  }
  return {
    mainBranch: defaultBranch,
    checkedOutBranch,
    isTracked,
    commitPaths,
    findCard: cardLookup,
    startCard: async (card) => {
      const w = needWindow()
      const created = addTask({ ...card, dependsOn: card.dependsOn })
      const released = await releaseTask(w, created.id)
      pushBoard(w, card.project)
      return toCard(released)
    },
    releaseCard: async (id) => {
      const w = needWindow()
      const released = await releaseTask(w, id)
      pushBoard(w, released.project)
      return toCard(released)
    }
  }
}
