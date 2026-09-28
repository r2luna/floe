// The tasks panel's storage: one numbered folder per idea, in the project's
// main checkout.
//
//   .floe/tasks/017-task-panel/   while it is an idea, being shaped, or ready
//   specs/017-task-panel/         once it is sent to the colony
//
// Both are committed on master — the user wants the ideas in git. Floe itself
// only ever writes these folders in the MAIN checkout: a task added by an agent
// working in a worktree still lands on master, or it would exist on that one
// branch only. The one commit Floe makes is the move on send; edits while
// shaping are the user's to commit.
//
// task.md holds the task: a small frontmatter (title, status, kind, created,
// links, depends) over the idea itself. plan.md is the plan. Anything else in
// the folder — html designs, drawings, notes — is listed as the task's files.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
  type FSWatcher
} from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import type {
  TaskCard,
  TaskFileEntry,
  TaskFileType,
  TaskFolder,
  TaskFolderDetail,
  TaskFolderKind,
  TaskFolderPatch,
  TaskFolderStatus
} from '../shared/taskFolders'
import { SHAPING_STATUSES, TASK_FOLDER_STATUSES } from '../shared/taskFolders.ts'

export const TASKS_DIR = '.floe/tasks'
const SPECS_DIR = 'specs'
const TASK_FILE = 'task.md'
const PLAN_FILE = 'plan.md'
/** Where a sent task's colony lanes write, inside the task's own folder. */
export const COLONY_SUBDIR = 'colony'

const FOLDER = /^(\d{3})-[a-z0-9][a-z0-9-]*$/
const KINDS: TaskFolderKind[] = ['feat', 'fix', 'chore']

// ---------------------------------------------------------------------------
// task.md
// ---------------------------------------------------------------------------

export interface TaskMeta {
  title: string
  status: TaskFolderStatus
  kind: TaskFolderKind
  created?: string
  links: string[]
  depends: string[]
  /** Keys this file does not know, kept so a hand-added line survives a rewrite. */
  extra: [string, string][]
}

const LIST_KEYS = new Set(['links', 'depends'])

/**
 * Read task.md. Deliberately forgiving: a file a person or an agent wrote by
 * hand with no frontmatter at all is still a task — its first heading is the
 * title and the rest is the idea.
 */
export function parseTaskMd(text: string, fallbackTitle = ''): { meta: TaskMeta; body: string } {
  const meta: TaskMeta = { title: '', status: 'idea', kind: 'feat', links: [], depends: [], extra: [] }
  let body = text
  const fence = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (fence) {
    body = text.slice(fence[0].length)
    let list: 'links' | 'depends' | null = null
    for (const raw of fence[1].split(/\r?\n/)) {
      const item = /^\s+-\s*(.+)$/.exec(raw)
      if (item && list) {
        meta[list].push(unquote(item[1]))
        continue
      }
      const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw)
      if (!kv) continue
      const [, key, value] = kv
      list = null
      if (LIST_KEYS.has(key)) {
        list = key as 'links' | 'depends'
        // `depends: [012, 014]` on one line is the other way people write a list.
        const inline = /^\[(.*)\]$/.exec(value.trim())
        if (inline) meta[list].push(...inline[1].split(',').map((v) => unquote(v)).filter(Boolean))
        else if (value.trim()) meta[list].push(unquote(value))
      } else if (key === 'title') meta.title = unquote(value)
      else if (key === 'status') meta.status = asStatus(unquote(value))
      else if (key === 'kind') meta.kind = asKind(unquote(value))
      else if (key === 'created') meta.created = unquote(value) || undefined
      else meta.extra.push([key, value])
    }
  }
  body = body.replace(/^\s*\n/, '')
  if (!meta.title) {
    const heading = /^#\s+(.+)\n?/.exec(body)
    if (heading) {
      meta.title = heading[1].trim()
      body = body.slice(heading[0].length).replace(/^\s*\n/, '')
    } else meta.title = fallbackTitle
  }
  return { meta, body: body.trimEnd() }
}

export function serializeTaskMd(meta: TaskMeta, body: string): string {
  const lines = ['---', `title: ${meta.title}`, `status: ${meta.status}`, `kind: ${meta.kind}`]
  if (meta.created) lines.push(`created: ${meta.created}`)
  if (meta.links.length) lines.push('links:', ...meta.links.map((l) => `  - ${l}`))
  if (meta.depends.length) lines.push('depends:', ...meta.depends.map((d) => `  - ${d}`))
  for (const [key, value] of meta.extra) lines.push(`${key}: ${value}`)
  lines.push('---', '')
  const idea = body.trim()
  return `${lines.join('\n')}${idea ? `\n${idea}\n` : ''}`
}

const unquote = (v: string): string => v.trim().replace(/^(['"])(.*)\1$/, '$2').trim()

const asStatus = (v: string): TaskFolderStatus =>
  (TASK_FOLDER_STATUSES as string[]).includes(v) ? (v as TaskFolderStatus) : 'idea'

const asKind = (v: string): TaskFolderKind => ((KINDS as string[]).includes(v) ? (v as TaskFolderKind) : 'feat')

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

/** A title as a folder name's slug: lowercase words joined by dashes. */
export function slugify(title: string): string {
  return (
    title
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '') || 'task'
  )
}

/** Every numbered folder under one parent dir, as `[name, number]`. */
function numbered(root: string, parent: string): { name: string; number: string }[] {
  let entries
  try {
    entries = readdirSync(join(root, parent), { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, match: FOLDER.exec(e.name) }))
    .filter((e): e is { name: string; match: RegExpExecArray } => !!e.match)
    .map((e) => ({ name: e.name, number: e.match[1] }))
}

/**
 * The next free number: one past the highest in either place a task can be.
 * Never reused, so `017` means one task forever — a sent task still holds its
 * number from `specs/`.
 */
export function nextNumber(root: string): string {
  const all = [...numbered(root, TASKS_DIR), ...numbered(root, SPECS_DIR)].map((e) => Number(e.number))
  return String((all.length ? Math.max(...all) : 0) + 1).padStart(3, '0')
}

/** Find a task by number (`17`, `017`) or by folder name. */
function locate(root: string, ref: string): { dir: string; name: string; sent: boolean } {
  const wanted = /^\d+$/.test(ref.trim()) ? ref.trim().padStart(3, '0') : null
  for (const [parent, sent] of [
    [TASKS_DIR, false],
    [SPECS_DIR, true]
  ] as const) {
    for (const e of numbered(root, parent)) {
      if (!existsSync(join(root, parent, e.name, TASK_FILE))) continue
      if (e.number === wanted || e.name === ref.trim()) return { dir: `${parent}/${e.name}`, name: e.name, sent }
    }
  }
  throw new Error(`No task ${ref} in ${root}`)
}

/** Every file under a folder, relative to it, skipping the colony's own subfolder. */
function walk(abs: string, rel = ''): string[] {
  let entries
  try {
    entries = readdirSync(join(abs, rel), { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const path = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      if (!rel && e.name === COLONY_SUBDIR) continue
      out.push(...walk(abs, path))
    } else if (e.isFile()) out.push(path)
  }
  return out.sort((a, b) => a.localeCompare(b))
}

export function fileTypeOf(path: string): TaskFileType {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return 'link'
  if (/\.html?$/i.test(path)) return 'html'
  if (/\.excalidraw$/i.test(path)) return 'drawing'
  if (/\.(md|markdown)$/i.test(path)) return 'markdown'
  return 'file'
}

/** The order the files list draws: designs, drawings, links, then the rest. */
const TYPE_ORDER: TaskFileType[] = ['html', 'drawing', 'link', 'markdown', 'file']

function filesOf(abs: string, links: string[]): TaskFileEntry[] {
  const files = walk(abs)
    .filter((p) => p !== TASK_FILE && p !== PLAN_FILE)
    .map((path) => ({ type: fileTypeOf(path), path }))
  const all = [...files, ...links.map((path) => ({ type: 'link' as const, path }))]
  return all.sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type))
}

function newestWrite(abs: string): number {
  let newest = 0
  for (const rel of walk(abs)) {
    try {
      newest = Math.max(newest, statSync(join(abs, rel)).mtimeMs)
    } catch {
      /* gone between the walk and the stat */
    }
  }
  return newest
}

/** How the panel finds the colony card a sent task became. */
export type CardLookup = (root: string, folderName: string) => TaskCard | undefined

function summarize(root: string, dir: string, name: string, sent: boolean, card: CardLookup): TaskFolder {
  const abs = join(root, dir)
  const { meta } = parseTaskMd(readFileSync(join(abs, TASK_FILE), 'utf8'), name.slice(4).replace(/-/g, ' '))
  const files = filesOf(abs, meta.links)
  const found = sent ? card(root, name) : undefined
  return {
    number: name.slice(0, 3),
    name,
    dir,
    title: meta.title,
    // A sent task's status is the colony's, not the file's: `in dev` was written
    // once, on send, and `done` is never written at all — a commit on master
    // after the merge would make the colony's undo refuse (it checks base has
    // not moved since).
    status: sent ? (found?.merged ? 'done' : 'in dev') : meta.status === 'in dev' || meta.status === 'done' ? 'ready' : meta.status,
    kind: meta.kind,
    ...(meta.created ? { created: meta.created } : {}),
    links: meta.links,
    depends: meta.depends,
    hasPlan: existsSync(join(abs, PLAN_FILE)),
    counts: {
      html: files.filter((f) => f.type === 'html').length,
      drawing: files.filter((f) => f.type === 'drawing').length,
      link: files.filter((f) => f.type === 'link').length,
      other: files.filter((f) => f.type === 'markdown' || f.type === 'file').length
    },
    ...(found ? { card: found } : {}),
    mtime: newestWrite(abs)
  }
}

/** Every task in the project, shaping ones first, newest first inside each place. */
export function listTaskFolders(root: string, card: CardLookup): TaskFolder[] {
  const out: TaskFolder[] = []
  for (const [parent, sent] of [
    [TASKS_DIR, false],
    [SPECS_DIR, true]
  ] as const) {
    for (const e of numbered(root, parent)) {
      if (!existsSync(join(root, parent, e.name, TASK_FILE))) continue
      try {
        out.push(summarize(root, `${parent}/${e.name}`, e.name, sent, card))
      } catch {
        /* unreadable task.md: skip rather than hide every other task */
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

export function readTaskFolder(root: string, ref: string, card: CardLookup): TaskFolderDetail {
  const at = locate(root, ref)
  const abs = join(root, at.dir)
  const { meta, body } = parseTaskMd(readFileSync(join(abs, TASK_FILE), 'utf8'))
  const planFile = join(abs, PLAN_FILE)
  return {
    ...summarize(root, at.dir, at.name, at.sent, card),
    idea: body,
    plan: existsSync(planFile) ? readFileSync(planFile, 'utf8') : null,
    files: filesOf(abs, meta.links)
  }
}

export interface NewTaskFolder {
  title: string
  idea?: string
  kind?: TaskFolderKind
  status?: TaskFolderStatus
}

/** Who is asking. Only the user may say a task is ready — see updateTaskFolder. */
export type Actor = 'user' | 'agent'

/** YYYY-MM-DD in the machine's own timezone — the day the user had the idea, not UTC's. */
export function localDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function createTaskFolder(root: string, task: NewTaskFolder, by: Actor): TaskFolderDetail {
  const title = task.title.trim()
  if (!title) throw new Error('A task needs a title')
  const status = task.status ?? 'idea'
  statusAllowed(status, by)
  const number = nextNumber(root)
  const name = `${number}-${slugify(title)}`
  const abs = join(root, TASKS_DIR, name)
  mkdirSync(abs, { recursive: true })
  const meta: TaskMeta = {
    title,
    status,
    kind: task.kind ?? 'feat',
    created: localDate(new Date()),
    links: [],
    depends: [],
    extra: []
  }
  writeFileSync(join(abs, TASK_FILE), serializeTaskMd(meta, task.idea ?? ''))
  return readTaskFolder(root, number, () => undefined)
}

/**
 * The approval rule. `ready` is the gate the colony opens on, so an agent that
 * could set it could approve its own plan and send it. `in dev` and `done` are
 * never set by anyone: send and the colony decide them.
 */
function statusAllowed(status: TaskFolderStatus, by: Actor): void {
  if (!SHAPING_STATUSES.includes(status)) throw new Error(`"${status}" is set by the colony, not by hand`)
  if (status === 'ready' && by !== 'user') throw new Error('Only the user can mark a task ready')
}

/** A task that can still change: one that has not been sent. */
function editable(root: string, ref: string): { abs: string; name: string } {
  const at = locate(root, ref)
  if (at.sent) throw new Error(`Task ${at.name} is in development — it is read-only now`)
  return { abs: join(root, at.dir), name: at.name }
}

function rewrite(abs: string, change: (meta: TaskMeta, body: string) => { meta: TaskMeta; body: string }): void {
  const file = join(abs, TASK_FILE)
  const { meta, body } = parseTaskMd(readFileSync(file, 'utf8'))
  const next = change(meta, body)
  writeFileSync(file, serializeTaskMd(next.meta, next.body))
}

export function updateTaskFolder(root: string, ref: string, patch: TaskFolderPatch, by: Actor): TaskFolderDetail {
  const { abs } = editable(root, ref)
  if (patch.status) statusAllowed(patch.status, by)
  rewrite(abs, (meta, body) => ({
    meta: {
      ...meta,
      ...(patch.title?.trim() ? { title: patch.title.trim() } : {}),
      ...(patch.kind ? { kind: patch.kind } : {}),
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.depends ? { depends: patch.depends.map((d) => d.trim().padStart(3, '0')) } : {})
    },
    body: patch.idea ?? body
  }))
  return readTaskFolder(root, ref, () => undefined)
}

/** One step along idea → shaping → ready, or back. The keyboard's `[` and `]`. */
export function stepTaskStatus(root: string, ref: string, delta: 1 | -1, by: Actor): TaskFolderDetail {
  const { abs } = editable(root, ref)
  const { meta } = parseTaskMd(readFileSync(join(abs, TASK_FILE), 'utf8'))
  const at = Math.max(0, SHAPING_STATUSES.indexOf(meta.status))
  const next = SHAPING_STATUSES[Math.min(SHAPING_STATUSES.length - 1, Math.max(0, at + delta))]
  return updateTaskFolder(root, ref, { status: next }, by)
}

/**
 * Delete a task and everything in its folder. The keyboard's `d`, after a
 * confirm. Only a task that has not been sent: a sent one is committed on
 * master and its branch is being built from it. Nothing is committed here —
 * a tracked task shows up as a deletion for you to commit, like any edit.
 */
export function deleteTaskFolder(root: string, ref: string): { deleted: string } {
  const { abs, name } = editable(root, ref)
  rmSync(abs, { recursive: true, force: true })
  return { deleted: name }
}

/** plan.md's path relative to the project, created empty when missing — what `p` opens. */
export function ensurePlan(root: string, ref: string): string {
  const { abs } = editable(root, ref)
  const file = join(abs, PLAN_FILE)
  if (!existsSync(file)) writeFileSync(file, '# Plan\n\n')
  return relative(root, file)
}

/** A path inside the task folder, refusing anything that climbs out of it. */
function inside(abs: string, rel: string): string {
  const target = resolve(abs, rel)
  if (!target.startsWith(abs + sep)) throw new Error(`"${rel}" is outside the task folder`)
  return target
}

export type Attachment =
  | { link: string }
  /** Write a file into the folder. */
  | { name: string; content: string }
  /** Copy a file from anywhere on this machine into the folder. */
  | { copyFrom: string; name?: string }

export function attachToTask(root: string, ref: string, what: Attachment): TaskFolderDetail {
  const { abs } = editable(root, ref)
  if ('link' in what) {
    const url = what.link.trim()
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) throw new Error(`Not a URL: ${url}`)
    rewrite(abs, (meta, body) => ({ meta: { ...meta, links: [...new Set([...meta.links, url])] }, body }))
  } else {
    const name = 'copyFrom' in what ? (what.name ?? basename(what.copyFrom)) : what.name
    if (name === TASK_FILE) throw new Error('task.md is the task itself — use task_update')
    const target = inside(abs, name)
    mkdirSync(resolve(target, '..'), { recursive: true })
    if ('copyFrom' in what) copyFileSync(what.copyFrom, target)
    else writeFileSync(target, what.content)
  }
  return readTaskFolder(root, ref, () => undefined)
}

/** Remove a link, or delete a file from the folder. The keyboard's `x`. */
export function detachFromTask(root: string, ref: string, target: string): TaskFolderDetail {
  const { abs } = editable(root, ref)
  if (fileTypeOf(target) === 'link') {
    rewrite(abs, (meta, body) => ({ meta: { ...meta, links: meta.links.filter((l) => l !== target) }, body }))
  } else {
    if (target === TASK_FILE) throw new Error('task.md is the task itself — it cannot be detached')
    unlinkSync(inside(abs, target))
  }
  return readTaskFolder(root, ref, () => undefined)
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

/** What send needs from git and the colony — injected, so it is testable without either. */
export interface SendDeps {
  mainBranch: (root: string) => Promise<string>
  checkedOutBranch: (root: string) => Promise<string | null>
  isTracked: (root: string, rel: string) => Promise<boolean>
  commitPaths: (root: string, paths: string[], message: string) => Promise<boolean>
  /** Put a card on the board and start it. Returns the card. */
  startCard: (card: { project: string; name: string; kind: TaskFolderKind; brief: string; specDir: string; dependsOn: string[] }) => Promise<TaskCard>
  /** The card already made for this folder, if a previous send got that far. */
  findCard: CardLookup
  /** Release a card that exists but never left the backlog. */
  releaseCard: (id: string) => Promise<TaskCard>
}

/** The brief the colony's first lane reads. A pointer to the task, never a copy of it. */
export function briefFor(dir: string, title: string, hasPlan: boolean): string {
  return [
    title,
    '',
    `The approved task is ${dir}/: task.md is the idea${hasPlan ? ', plan.md is the plan' : ' (it has no plan.md)'}, and any other files are its designs and drawings.`,
    `Treat ${dir}/ as read-only. Write your own documents in ${dir}/${COLONY_SUBDIR}/.`
  ].join('\n')
}

/**
 * Hand a ready task to the colony.
 *
 * 1. The folder moves `.floe/tasks/N` → `specs/N`, its status becomes `in dev`,
 *    and the move is committed on master — both paths, so the commit carries the
 *    deletion as well as the addition. Committed BEFORE the card exists: a
 *    worktree is a checkout of a commit, and a card started early would be cut
 *    from a master that does not have the folder yet.
 * 2. The card is created and started, its spec folder inside the task's.
 *
 * Idempotent: sending a task that is already in `specs/` finishes whatever the
 * last send did not — creates the missing card, or releases one that never left
 * the backlog. That is the recovery for a send that died halfway.
 */
export async function sendTaskFolder(root: string, ref: string, deps: SendDeps): Promise<TaskFolderDetail> {
  let at = locate(root, ref)
  const main = await deps.mainBranch(root)
  const here = await deps.checkedOutBranch(root)
  if (here !== main) {
    throw new Error(`The main checkout is on ${here ?? 'a detached HEAD'}, not ${main} — tasks only move on ${main}`)
  }

  if (!at.sent) {
    const abs = join(root, at.dir)
    const { meta } = parseTaskMd(readFileSync(join(abs, TASK_FILE), 'utf8'))
    if (meta.status !== 'ready') throw new Error(`Task ${at.name} is ${meta.status} — only a ready task can be sent`)
    const from = at.dir
    const to = `${SPECS_DIR}/${at.name}`
    if (existsSync(join(root, to))) throw new Error(`${to} already exists`)
    const tracked = await deps.isTracked(root, from)
    mkdirSync(join(root, SPECS_DIR), { recursive: true })
    renameSync(abs, join(root, to))
    rewrite(join(root, to), (m, body) => ({ meta: { ...m, status: 'in dev' }, body }))
    const committed = await deps.commitPaths(root, tracked ? [from, to] : [to], `chore(tasks): start ${at.name}`)
    if (!committed) throw new Error(`Moved ${at.name} to ${to} but could not commit it — commit it, then send again`)
    at = { dir: to, name: at.name, sent: true }
  }

  const existing = deps.findCard(root, at.name)
  if (!existing) {
    const { meta } = parseTaskMd(readFileSync(join(root, at.dir, TASK_FILE), 'utf8'))
    const dependsOn = meta.depends
      .map((n) => {
        try {
          return deps.findCard(root, locate(root, n).name)?.id
        } catch {
          return undefined
        }
      })
      .filter((id): id is string => !!id)
    await deps.startCard({
      project: root,
      name: at.name,
      kind: meta.kind,
      brief: briefFor(at.dir, meta.title, existsSync(join(root, at.dir, PLAN_FILE))),
      specDir: `${at.dir}/${COLONY_SUBDIR}`,
      dependsOn
    })
  } else if (existing.stage === 'inbox' && !existing.branch) {
    await deps.releaseCard(existing.id)
  }
  return readTaskFolder(root, at.name, deps.findCard)
}

// ---------------------------------------------------------------------------
// Watching
// ---------------------------------------------------------------------------

// One live watcher per project root, on both places a task can be. Recursive,
// because an agent writing a design into a task folder is a change to that
// task. Debounced: one write is several fs events.
const watchers = new Map<string, FSWatcher[]>()

/** The slice of Electron's WebContents the watcher uses — a fake in tests. */
export interface TaskEventSink {
  isDestroyed: () => boolean
  send: (channel: string, payload: { root: string }) => void
  once: (event: 'destroyed', fn: () => void) => void
}

export function watchTaskFolders(wc: TaskEventSink, root: string): void {
  if (watchers.has(root)) return
  const fire = debounce(() => {
    if (!wc.isDestroyed()) wc.send('tasks:event', { root })
  }, 150)
  const open: FSWatcher[] = []
  for (const dir of [TASKS_DIR, SPECS_DIR]) {
    const abs = join(root, dir)
    try {
      if (dir === TASKS_DIR) mkdirSync(abs, { recursive: true })
      open.push(watch(abs, { recursive: true }, fire))
    } catch {
      /* specs/ may not exist yet — the tasks dir alone still catches new ideas */
    }
  }
  watchers.set(root, open)
  wc.once('destroyed', () => {
    for (const w of watchers.get(root) ?? []) w.close()
    watchers.delete(root)
  })
}

function debounce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  return () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(fn, ms)
  }
}
