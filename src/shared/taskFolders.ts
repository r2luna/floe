// The tasks panel's shapes: an idea that grows into a plan and is handed to the
// colony. Main reads the folders, the renderer draws them, MCP returns them —
// so the shapes live here rather than being copied across the IPC seam.
//
// A task is a numbered folder in the project's main checkout, committed on
// master: `.floe/tasks/017-slug/` while it is being shaped, `specs/017-slug/`
// once it is sent. See mocks/task-panel.html for the design.

/** Where a task is. The last two are never set by hand — the colony decides them. */
export type TaskFolderStatus = 'idea' | 'shaping' | 'ready' | 'in dev' | 'done'

/** The order the ladder draws, left to right. */
export const TASK_FOLDER_STATUSES: TaskFolderStatus[] = ['idea', 'shaping', 'ready', 'in dev', 'done']

/** The statuses a person moves a task through with `[` and `]`. */
export const SHAPING_STATUSES: TaskFolderStatus[] = ['idea', 'shaping', 'ready']

export type TaskFolderKind = 'feat' | 'fix' | 'chore'

/** How a file in the folder opens: the icon it gets, and the panel `⏎` picks. */
export type TaskFileType = 'html' | 'drawing' | 'markdown' | 'file' | 'link'

export interface TaskFileEntry {
  type: TaskFileType
  /** Relative to the task folder, or the URL for a link. */
  path: string
}

/** The colony card a sent task became, as far as the panel needs it. */
export interface TaskCard {
  id: string
  stage: string
  status: string
  line?: string
  branch?: string
  merged: boolean
}

export interface TaskFolder {
  /** Three digits, zero-padded: `017`. Never reused. */
  number: string
  /** The folder's name: `017-task-panel-for-ideas`. */
  name: string
  /** Relative to the project root: `.floe/tasks/017-…` or `specs/017-…`. */
  dir: string
  title: string
  status: TaskFolderStatus
  kind: TaskFolderKind
  created?: string
  links: string[]
  /** Task numbers this one waits on, mapped to their colony cards on send. */
  depends: string[]
  hasPlan: boolean
  /** File counts for the list row: html designs, drawings, links, everything else. */
  counts: { html: number; drawing: number; link: number; other: number }
  /** The colony card, once sent. Missing on a sent task means it is not on the board. */
  card?: TaskCard
  /** Newest write in the folder, for ordering inside a status group. */
  mtime: number
}

export interface TaskFolderDetail extends TaskFolder {
  /** The body of task.md: the idea, in the user's words. */
  idea: string
  /** plan.md, or null when there is none yet. */
  plan: string | null
  /** Every other file in the folder, plus the links, in the order the panel lists them. */
  files: TaskFileEntry[]
}

/** What `task_update` / the item view may change. */
export interface TaskFolderPatch {
  title?: string
  idea?: string
  kind?: TaskFolderKind
  status?: TaskFolderStatus
  depends?: string[]
}
