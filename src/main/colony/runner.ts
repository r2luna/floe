// What actually moves a card: admit a task into a free spot, run the stage's
// skill in a session minted for that step, read the hand-off line off the last
// message, and move it on.
//
// One rule keeps the scheduler honest: ONLY `working` AND `blocked` TAKE A SPOT.
// A task holding at a full stage's door costs nothing, which is why a jam at one
// stage never freezes the stage behind it (spec D4). Holding is drawn at the
// door it is stuck at, so a task that finishes `coder` and finds `cleaner` full
// moves to CLEANER's holding band, not to a "done" pile in coder.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { capOf, colonyConfig, columnsFor, DONE, INBOX, resolveFlag, type ColonyStage } from '../config/colony'
import { addCreatedSession, closeSession, getAllCreatedSessions } from '../sessionStore'
import { sessionRuntime, onceTurnDone, hasActiveTurn } from '../agent'
import { startTurn } from '../turn'
import {
  changedFiles,
  commitPaths,
  createWorktree,
  defaultBranch,
  deleteBranch,
  dirtySnapshot,
  isMergedInto,
  mergeWorktree,
  readBase,
  restoreBranch,
  restoreSnapshot,
  snapshotTree,
  uncommittedWork,
  undoMerge,
  type MergeResult
} from '../git'
import { provisionWorktree } from '../provision'
import { teardownWorktree } from '../worktreeTeardown'
import { listSkills } from '../config/skills'
import { parseFindings, parseHandoff, type Board, type BoardColumn } from '../../shared/colony'
import { usageOf } from '../usageLedger'
import { writeReport } from './report'
import { getEvent, patchEvent, recordEvent } from './events'
import {
  allTasks,
  getNanny,
  setNanny,
  getTask,
  listTasks,
  patchTask,
  recordVisit,
  type ColonyTask,
  type StepRecord,
  type TaskStatus,
  type TaskVisit
} from './store'

/**
 * The key a session's live connection sits under.
 *
 * Same convention mcpServer uses, restated here rather than imported because
 * mcpServer imports THIS file for its tools — and a cycle between them would be
 * paid for at boot, not at the call.
 */
function connKeyFor(id: string): string {
  const s = getAllCreatedSessions().find((x) => x.id === id)
  if (!s) return id
  for (const k of [s.id, s.claudeId, ...(s.pastClaudeIds ?? [])]) if (k && sessionRuntime(k).live) return k
  return s.claudeId ?? s.id
}

/** The artifact directory a lane reads and writes — LANE-CONTRACT's `specs/<dir>/`. */
export const taskDirFor = (branch: string): string => join('specs', branch.replace(/\//g, '-'))

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

/** Assemble one project's board: the config's stages, plus the two fixed ends. */
export function boardFor(project: string): Board {
  const config = colonyConfig(project)
  // Merged and cleaned up: its worktree and branch are gone, so there is nothing
  // left on the board to act on. The store keeps it — a dependency it satisfied
  // and a merge the log can still undo both point at it.
  //
  // A measured step keeps the lane's whole last message for the report. The
  // board is read on every card move and by the nanny on every question, so it
  // goes out without them — `writeTaskReport` is where they are read.
  const tasks = listTasks(project)
    .filter((t) => !t.archivedAt)
    .map((t) =>
      t.report ? { ...t, visits: t.visits.map((v) => (v.step ? { ...v, step: { ...v.step, message: '' } } : v)) } : t
    )
  const stages = columnsFor(config, tasks.map((t) => t.stage))

  const column = (name: string, stage?: ColonyStage): BoardColumn => {
    const mine = tasks.filter((t) => t.stage === name)
    // `blocked` is DERIVED, not stored: whether a session is waiting on you is
    // the agent's live state, and a second copy of it in the task file would go
    // stale the moment you answered the question from the chat instead of the
    // board. A working task whose session is waiting IS the needs-you band.
    const pick = (status: TaskStatus): ColonyTask[] =>
      mine.filter((t) => (t.status === 'working' ? (waiting(t) ? 'blocked' : 'working') : t.status) === status)
    return {
      name,
      skill: stage?.skill ?? '',
      harness: stage?.harness,
      model: stage?.model,
      // The two ends have no cap and no skill: they are backlog and exit, not
      // stages, and a queue at the exit would be a queue for nothing.
      cap: stage ? capOf(stage, config) : undefined,
      retired: stage?.retired,
      blocked: pick('blocked'),
      working: pick('working'),
      holding: pick('holding'),
      settled: pick('settled')
    }
  }

  return {
    project,
    columns: [column(INBOX), ...stages.map((s) => column(s.name, s)), column(DONE)],
    automerge: config.automerge,
    report: config.report,
    configPath: config.path,
    errors: config.errors.map((e) => ({ file: e.file, line: e.line, reason: e.reason }))
  }
}

/** One card as `colony_board({ compact: true })` returns it. */
export interface CompactTask {
  id: string
  name: string
  kind: string
  stage: string
  status: TaskStatus
  line?: string
  warn?: string
  branch?: string
  base?: string
  dependsOn?: string[]
  mergedAt?: number
  /** The last three lanes' verdicts, oldest first. A `none` is a lane that never said. */
  lastVerdicts: { stage: string; verdict: string }[]
}

/**
 * The board without the briefs and transcripts.
 *
 * What a manager polling the board needs is where each card is and what the
 * last lanes said about it. The full board carries every brief, which is tens
 * of thousands of characters per read on a board of feature-sized tasks.
 */
export function compactBoard(project: string): {
  project: string
  automerge: boolean
  columns: { name: string; cap?: number; tasks: CompactTask[] }[]
  errors: Board['errors']
} {
  const board = boardFor(project)
  const card = (t: ColonyTask, status: TaskStatus): CompactTask => ({
    id: t.id,
    name: t.name,
    kind: t.kind,
    stage: t.stage,
    status,
    line: t.line,
    warn: t.warn,
    branch: t.branch,
    base: t.base,
    dependsOn: t.dependsOn,
    mergedAt: t.mergedAt,
    lastVerdicts: t.visits.slice(-3).map((v) => ({ stage: v.stage, verdict: v.verdict }))
  })
  return {
    project,
    automerge: board.automerge,
    columns: board.columns.map((c) => ({
      name: c.name,
      cap: c.cap,
      tasks: [
        ...c.blocked.map((t) => card(t, 'blocked')),
        ...c.working.map((t) => card(t, 'working')),
        ...c.holding.map((t) => card(t, 'holding')),
        ...c.settled.map((t) => card(t, 'settled'))
      ]
    })),
    errors: board.errors
  }
}

/** Is this task's session stopped on a question for you? See `pick` above. */
function waiting(task: ColonyTask): boolean {
  return !!task.sessionId && sessionRuntime(connKeyFor(task.sessionId)).waiting
}

/** The stage after `name`, or `done` when there is none. `null` when `name` is unknown. */
function nextStage(project: string, name: string): string | null {
  const { stages } = colonyConfig(project)
  if (name === INBOX) return stages[0]?.name ?? DONE
  const at = stages.findIndex((s) => s.name === name)
  if (at === -1) return DONE // a retired stage's exit is forward, never back into itself
  return stages[at + 1]?.name ?? DONE
}

// ---------------------------------------------------------------------------
// Releasing a task from the backlog
// ---------------------------------------------------------------------------

/**
 * Cut the task's worktree, write its brief where the first lane will look for
 * it, and put it at the first stage's door.
 *
 * The tree is cut HERE and not when the task was created, because a backlog item
 * that has not been started should cost nothing — provisioning a worktree is
 * minutes of installs for a card the user may never release.
 */
export async function releaseTask(win: BrowserWindow, id: string): Promise<ColonyTask> {
  const task = getTask(id)
  if (!task) throw new Error(`Unknown task: ${id}`)
  // Already past the backlog. The one thing left to release is a card a lane
  // parked as a question the board cannot answer for you — `stop`, or a return
  // to a lane nobody has. Putting it back at its door is the way out, and it is
  // the same key, because it is the same intent: run this.
  if (task.stage !== INBOX) {
    if (task.status !== 'blocked') return task
    const requeued = patchTask(id, { status: 'holding', warn: undefined, line: 'starting again' }) ?? task
    tick(win, task.project)
    return requeued
  }

  // A DEPENDENCY GATES THE WORKTREE, NOT THE LANES. Holding the card in the
  // backlog is the only thing that keeps two dependent trees from existing at
  // once: cut them both and the second is already built on a base missing the
  // first, and no amount of scheduling fixes that after the fact. Cheap, too —
  // a card that never left the backlog has paid for nothing.
  const unmet = unmetDeps(task)
  if (unmet.length) {
    const queued = patchTask(id, {
      // Remember that somebody asked. Nothing else knows this card is next, and
      // the sweep after a merge is what acts on it.
      queued: true,
      line: `waiting on ${unmet.map((t) => t.name).join(', ')}`
    })
    pushBoard(win, task.project)
    return queued ?? task
  }

  let worktreePath = task.worktreePath
  let branch = task.branch
  if (!worktreePath) {
    // `<kind>/<name>` — the branch says what the change IS before you read it.
    const worktrees = await createWorktree(task.project, `${task.kind}/${task.name}`, {
      note: task.brief.slice(0, 80),
      base: task.base
    })
    const created = worktrees[worktrees.length - 1]
    worktreePath = created.path
    branch = created.branch
    // The same per-stack setup the in-app create flow runs — otherwise the lane
    // opens in a tree with no dependencies. Fire-and-forget: progress streams to
    // the setup checklist, and the first lane reads files, not node_modules.
    const tree = created.path
    void provisionWorktree(win, task.project, tree, created.branch)
      .then(() => recordProvisionDirt(id, tree))
      .catch(() => undefined)
  }

  // LANE-CONTRACT points every lane at `specs/<dir>/`. The request has to be
  // there before the first one runs, or the specifier opens on an empty room.
  const dir = join(worktreePath, taskDirFor(branch ?? task.name))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'task.md')
  if (!existsSync(file)) {
    writeFileSync(file, `# ${task.name}\n\nkind: ${task.kind}\n\n${task.brief.trim()}\n`)
  }

  const moved = patchTask(id, {
    branch,
    worktreePath,
    // The branch it was really cut from, written down while `.gw-base` still
    // exists: cleanup removes the tree, and the merge check outlives it.
    base: task.base ?? readBase(worktreePath),
    queued: undefined,
    stage: nextStage(task.project, INBOX) ?? DONE,
    status: 'holding',
    line: undefined
  })
  tick(win, task.project)
  return moved ?? task
}

/**
 * What provisioning left changed in tracked files, once it is done.
 *
 * An install that regenerates a tooling file makes every tree it provisions
 * dirty, and a dirty tree refuses to merge. Recorded so `mergeTask` can put those
 * files back — the ones nobody has touched since — instead of refusing.
 */
async function recordProvisionDirt(id: string, worktreePath: string): Promise<void> {
  const snapshot = await dirtySnapshot(worktreePath)
  if (Object.keys(snapshot).length) patchTask(id, { provisionDirt: snapshot })
}

/** The branch a task merges into: its own, the tree's `.gw-base`, or the project's main branch. */
async function baseOf(task: ColonyTask): Promise<string> {
  return task.base ?? (task.worktreePath ? readBase(task.worktreePath) : undefined) ?? (await defaultBranch(task.project))
}

/**
 * Commit the task's `specs/<dir>/` in its worktree.
 *
 * Lanes write their documents and do not all commit them — a QA lane's
 * `verify.md` especially. Left untracked they make the tree dirty, which refuses
 * the merge, and they are lost when the tree is cleaned up. So the board files
 * them itself, after every lane and once more before the merge.
 */
async function fileArtifacts(task: ColonyTask, after: string): Promise<void> {
  if (!task.worktreePath) return
  const dir = taskDirFor(task.branch ?? task.name)
  await commitPaths(task.worktreePath, [dir], `docs(colony): ${after} artifacts for ${task.name}`).catch(() => false)
}

// ---------------------------------------------------------------------------
// Dependencies and merging
// ---------------------------------------------------------------------------

/**
 * The dependencies of `task` that have not landed on base yet.
 *
 * A dependency id nobody recognises is DROPPED rather than treated as unmet: a
 * card taken off the board would otherwise park everything behind it forever,
 * with nothing left on the board to explain why.
 */
export function unmetDeps(task: ColonyTask): ColonyTask[] {
  if (!task.dependsOn?.length) return []
  const unmet: ColonyTask[] = []
  for (const id of task.dependsOn) {
    const dep = getTask(id)
    if (!dep || dep.mergedAt) continue
    unmet.push(dep)
  }
  return unmet
}

/**
 * Merge a finished task's branch into its base.
 *
 * Only from `done`, and only once. `mergeWorktree` is the safe one-shot — it
 * refuses on a dirty tree and aborts on a conflict, leaving the worktree exactly
 * as it was — so every way this can fail is a message on the card rather than a
 * half-merged branch. That is what makes it safe to call without asking.
 */
export async function mergeTask(win: BrowserWindow | undefined, id: string): Promise<MergeResult> {
  if (merging.has(id)) return { ok: false, message: 'That task is already being merged' }
  merging.add(id)
  try {
    return await landTask(win, id)
  } finally {
    merging.delete(id)
  }
}

/**
 * Tasks a merge is running for right now. `reconcileMerged` leaves them alone:
 * base has already moved before `mergedAt` is written, and noticing that halfway
 * would record the same merge twice and release its dependents twice.
 */
const merging = new Set<string>()

async function landTask(win: BrowserWindow | undefined, id: string): Promise<MergeResult> {
  const task = getTask(id)
  if (!task) return { ok: false, message: `Unknown task: ${id}` }
  if (task.mergedAt) return { ok: true, message: `"${task.name}" is already merged` }
  if (task.stage !== DONE) return { ok: false, message: `"${task.name}" is still in ${task.stage}` }
  if (!task.worktreePath) return { ok: false, message: `"${task.name}" has no worktree to merge` }

  // The two kinds of dirt that are not work: documents a lane left untracked,
  // and files provisioning regenerated that no lane touched since.
  await fileArtifacts(task, 'merge')
  if (task.provisionDirt) await restoreSnapshot(task.worktreePath, task.provisionDirt).catch(() => [])

  const result = await mergeWorktree(task.project, task.worktreePath)
  if (!result.ok) {
    // On the card, not thrown: the board is where somebody finds out, and a
    // refused merge is a thing to read, not an exception to handle.
    patchTask(id, { warn: result.message, line: 'not merged' })
    recordEvent({
      project: task.project,
      kind: 'refused',
      task: id,
      taskName: task.name,
      branch: task.branch,
      worktreePath: task.worktreePath,
      text: `reached done but did not merge: ${result.message ?? 'no reason given'}`
    })
    pushBoard(win, task.project)
    return result
  }

  patchTask(id, { mergedAt: Date.now(), warn: undefined, line: 'merged' })
  // The base branch moved, outside any worktree, without anybody asking. It is
  // the one thing here that has to be both written down and reversible — see
  // events.ts, and `undoTaskMerge` below.
  recordEvent({
    project: task.project,
    kind: 'merged',
    task: id,
    taskName: task.name,
    branch: task.branch,
    worktreePath: task.worktreePath,
    base: result.base,
    baseBefore: result.baseBefore,
    baseAfter: result.baseAfter,
    text: `${task.branch ?? task.name} → ${result.base ?? 'base'}`
  })
  // Before the sweep, not after: both are `git worktree` in the same repo, and
  // two of them at once is a lock fight.
  if (resolveFlag(task, colonyConfig(task.project), 'cleanup')) await cleanupTask(win, id)
  // A merge is the ONLY thing that satisfies a dependency, so it is the only
  // place the queue behind one can move.
  await sweepReleases(win, task.project)
  pushBoard(win, task.project)
  return result
}

/**
 * Take a merged task's worktree and branch away, and the card off the board.
 *
 * Refuses — with the reason on the card — rather than deleting anything that is
 * not already on base: a branch with commits base lacks, uncommitted work in
 * the tree, or a session still mid-turn in it. The store keeps the card
 * (`archivedAt`), because dependents and the log still point at it.
 */
export async function cleanupTask(win: BrowserWindow | undefined, id: string): Promise<boolean> {
  const task = getTask(id)
  if (!task?.mergedAt || !task.worktreePath || !task.branch) return false
  const base = await baseOf(task)
  const refusal = await cleanupRefusal(task, task.worktreePath, task.branch, base)
  if (refusal) {
    patchTask(id, { warn: `not cleaned up: ${refusal}` })
    pushBoard(win, task.project)
    return false
  }

  await teardownWorktree(task.project, task.worktreePath)
  const deleted = await deleteBranch(task.project, task.branch, true)
  patchTask(id, {
    archivedAt: Date.now(),
    worktreePath: undefined,
    line: 'merged and cleaned up',
    warn: deleted.ok ? undefined : `branch not deleted: ${deleted.message ?? 'no reason given'}`
  })
  recordEvent({
    project: task.project,
    kind: 'cleaned',
    task: id,
    taskName: task.name,
    branch: task.branch,
    base,
    text: `removed its worktree${deleted.ok ? ` and deleted ${task.branch}` : ''}`
  })
  pushBoard(win, task.project)
  return true
}

/** Why a merged task's tree may not be removed yet, or null. */
async function cleanupRefusal(
  task: ColonyTask,
  worktreePath: string,
  branch: string,
  base: string
): Promise<string | null> {
  if (task.sessionId && hasActiveTurn(connKeyFor(task.sessionId))) return 'a session is still working in its worktree'
  // A lane that committed after the merge: deleting the branch would lose it.
  if (!(await isMergedInto(task.project, branch, base))) return `${branch} has commits that are not on ${base}`
  const dirt = await uncommittedWork(worktreePath)
  if (dirt.length) return `uncommitted changes in its worktree (${dirt.slice(0, 3).join(', ')})`
  return null
}

/**
 * Notice the finished tasks somebody merged by hand.
 *
 * A dependency is only satisfied by `mergedAt`, which only the board's own merge
 * used to set — so a task merged from a terminal released nothing behind it.
 * Only cards in `done`: a branch with no commits of its own is an ancestor of
 * base too, and a card still in a lane has not finished just because its branch
 * has not moved yet.
 *
 * Runs git once per finished, unmerged card, so it is called where the board is
 * read on request — never from `boardFor`, which runs on every card move.
 */
export async function reconcileMerged(win: BrowserWindow | undefined, project: string): Promise<ColonyTask[]> {
  const merged: ColonyTask[] = []
  const candidates = listTasks(project).filter((t) => t.stage === DONE && !t.mergedAt && t.branch && !merging.has(t.id))
  for (const task of candidates) {
    const base = await baseOf(task)
    if (!(await isMergedInto(project, task.branch as string, base))) continue
    const marked = patchTask(task.id, { mergedAt: Date.now(), warn: undefined, line: 'merged outside the board' })
    // No commits to undo with: the board did not make this merge, and an undo
    // that guessed at where base used to be would be the second accident.
    recordEvent({
      project,
      kind: 'merged',
      task: task.id,
      taskName: task.name,
      branch: task.branch,
      worktreePath: task.worktreePath,
      base,
      text: `${task.branch} → ${base}, merged outside the board`
    })
    if (marked) merged.push(marked)
  }
  for (const task of merged) {
    if (resolveFlag(task, colonyConfig(project), 'cleanup')) await cleanupTask(win, task.id)
  }
  if (merged.length) {
    await sweepReleases(win, project)
    pushBoard(win, project)
  }
  return merged
}

/**
 * Put base back where it was before one of the board's own merges.
 *
 * The card goes back to `done`, unmerged — which is the truthful state, not a
 * rewind: the branch and its worktree were never touched, so what actually
 * happened is that the work stopped being on base. Anything the merge released
 * KEEPS its worktree: those trees exist, lanes have run in them, and deleting
 * somebody's work to tidy up a bookkeeping edge is the one thing an undo must
 * not do. The log says they were released, and it stays true.
 */
export async function undoTaskMerge(win: BrowserWindow | undefined, eventId: string): Promise<MergeResult> {
  const event = getEvent(eventId)
  if (!event) return { ok: false, message: 'That board event is gone' }
  if (event.kind !== 'merged') return { ok: false, message: 'That event was not a merge' }
  if (event.undoneAt) return { ok: false, message: `"${event.taskName}" has already been put back` }
  if (!event.base || !event.baseBefore || !event.baseAfter) {
    return { ok: false, message: 'That merge was recorded without the commits an undo needs' }
  }

  const result = await undoMerge(event.project, event.base, event.baseAfter, event.baseBefore)
  if (!result.ok) return result

  patchEvent(eventId, { undoneAt: Date.now() })
  // A cleaned-up task's branch is gone, and after the reset its commits are
  // reachable from nothing. `baseAfter` is a fast-forward of that branch, so
  // pointing the branch back at it un-loses the work.
  const restored = event.branch ? await restoreBranch(event.project, event.branch, event.baseAfter) : true
  const card = getTask(event.task)
  // Back to unmerged, not back to a stage: the lanes all passed it, and undoing
  // where the work SITS is a different decision from undoing where it landed.
  patchTask(event.task, {
    mergedAt: undefined,
    archivedAt: undefined,
    line: card?.archivedAt ? 'merge undone — branch restored, its worktree was removed' : 'merge undone',
    warn: restored ? undefined : `could not restore ${event.branch} at ${event.baseAfter.slice(0, 8)}`
  })
  pushBoard(win, event.project)
  nudgeNanny(win, event.project, `the merge of "${event.taskName}" was undone — ${event.base} is back where it was.`)
  return result
}

/**
 * Release the cards that were waiting on something that has now merged.
 *
 * Oldest intent first, the same rule the stage queues use: a card that has been
 * waiting longest goes first, or a busy board starves whatever asked while it
 * was blocked.
 */
export async function sweepReleases(win: BrowserWindow | undefined, project: string): Promise<ColonyTask[]> {
  if (!win) return []
  const ready = listTasks(project)
    .filter((t) => t.queued && t.stage === INBOX && unmetDeps(t).length === 0)
    .sort((a, b) => a.updatedAt - b.updatedAt)
  const released: ColonyTask[] = []
  // Serially, not in parallel: each one cuts a worktree in the same repo, and
  // `git worktree add` twice at once in one repo is a lock fight.
  for (const task of ready) {
    try {
      const out = await releaseTask(win, task.id)
      released.push(out)
      // Only the SWEEP writes a `released` event. A card the user released by
      // hand is not news — they were there. This one let itself out.
      recordEvent({
        project: project,
        kind: 'released',
        task: out.id,
        taskName: out.name,
        branch: out.branch,
        worktreePath: out.worktreePath,
        text: `was queued behind a dependency — it merged, so the worktree was cut`
      })
    } catch (err) {
      patchTask(task.id, { warn: `could not release: ${(err as Error).message}` })
    }
  }
  return released
}

/**
 * Put a card back in the backlog, worktree and all.
 *
 * The way out of an automatic release: the board let it out because its
 * dependency merged, and you would rather it waited. Its tree stays — cutting it
 * was the expensive part and lanes may already have run in it — so this is a
 * park, not an undo. `releaseTask` starts it again from the same door.
 */
export function holdTask(win: BrowserWindow | undefined, id: string): ColonyTask | undefined {
  const task = getTask(id)
  if (!task) return undefined
  // Nothing to park: it is already in the backlog, or it has landed and the
  // board is done with it.
  if (task.stage === INBOX || task.mergedAt) return task
  const held = patchTask(id, { stage: INBOX, status: 'holding', line: 'held — release it when you want it' })
  pushBoard(win, task.project)
  return held
}

/** Two live tasks writing the same files, and which files. */
export interface TaskOverlap {
  files: string[]
  tasks: { id: string; name: string; stage: string; branch?: string }[]
}

/**
 * Live tasks whose worktrees touch the same files.
 *
 * The net UNDER `dependsOn`, not a replacement for it: by the time this can see
 * anything, both trees are already cut, so it reports a collision instead of
 * preventing one. Still worth reporting — the alternative is finding out at the
 * second merge, after a lane spent its whole turn building on the wrong base.
 *
 * Not folded into `boardFor`: this runs git in every worktree, and the board is
 * read on every card move and every question anyone asks about it.
 */
export async function overlappingTasks(project: string): Promise<TaskOverlap[]> {
  const live = listTasks(project).filter((t) => t.worktreePath && !t.mergedAt && t.stage !== INBOX)
  const byFile = new Map<string, ColonyTask[]>()
  await Promise.all(
    live.map(async (task) => {
      const files = await changedFiles(task.worktreePath as string).catch(() => [])
      for (const file of files) {
        const at = byFile.get(file.relPath)
        if (at) at.push(task)
        else byFile.set(file.relPath, [task])
      }
    })
  )

  // Grouped by the SET of tasks, not by the file: "these two share nine files"
  // is one thing to decide about, and nine separate findings is not.
  const groups = new Map<string, { tasks: ColonyTask[]; files: string[] }>()
  for (const [relPath, tasks] of byFile) {
    if (tasks.length < 2) continue
    const sorted = [...tasks].sort((a, b) => a.id.localeCompare(b.id))
    const key = sorted.map((t) => t.id).join('+')
    const at = groups.get(key)
    if (at) at.files.push(relPath)
    else groups.set(key, { tasks: sorted, files: [relPath] })
  }

  return [...groups.values()]
    .sort((a, b) => b.files.length - a.files.length)
    .map(({ tasks, files }) => ({
      files: files.sort(),
      tasks: tasks.map((t) => ({ id: t.id, name: t.name, stage: t.stage, branch: t.branch }))
    }))
}

// ---------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------

/**
 * Projects a pass is already running for.
 *
 * `tick` itself is synchronous, so two passes cannot interleave — but the pass
 * it schedules is not: starting a lane goes through `startTurn`, and a second
 * tick arriving before the first one's writes are visible would admit two tasks
 * into one spot. One flag per project is the whole lock: the board is
 * project-scoped, so two projects never contend.
 */
const ticking = new Set<string>()

/**
 * Admit whatever fits, once, for one project.
 *
 * Called after every state change rather than on a timer: the only things that
 * free a spot are a lane finishing, a question being answered and a config edit,
 * and each of them already calls this.
 */
export function tick(win: BrowserWindow, project: string): void {
  if (ticking.has(project)) return
  ticking.add(project)
  try {
    const config = colonyConfig(project)
    for (const stage of config.stages) {
      const cap = capOf(stage, config)
      if (cap <= 0) continue
      // Re-read per stage: admitting into `coder` changes what `coder` counts,
      // and a snapshot taken before the loop would let the next iteration admit
      // against a count that is already stale.
      const mine = listTasks(project).filter((t) => t.stage === stage.name)
      let busy = mine.filter((t) => t.status === 'working' || t.status === 'blocked').length
      // Oldest first: a task that has been holding longest goes first, or a busy
      // board would starve whatever arrived while it was full.
      const queue = mine.filter((t) => t.status === 'holding').sort((a, b) => a.updatedAt - b.updatedAt)
      for (const task of queue) {
        if (busy >= cap) break
        if (!startLane(win, task, stage)) continue
        busy++
      }
    }
  } finally {
    ticking.delete(project)
  }
}

/**
 * Put a lane's agent on a task. False means the task did not start.
 *
 * A stage whose skill does not resolve holds its tasks and starts nothing
 * (D19): sending a literal `/colony-implement` to a harness that has never heard
 * of it produces a confident answer to the wrong question, and failing closed is
 * cheaper than an agent guessing.
 */
function startLane(win: BrowserWindow, task: ColonyTask, stage: ColonyStage): boolean {
  if (!task.worktreePath) return false
  const known = listSkills(task.project).some((s) => s.name === stage.skill)
  if (!known) {
    patchTask(task.id, { warn: `stage "${stage.name}" names a skill that does not exist: ${stage.skill}` })
    return false
  }

  // The session the card is pointing at right now — the lane that ran last, or
  // the chat you have been having with it. It is mid-turn when you are talking
  // to it, and the step about to start would be a SECOND agent in the same
  // worktree. Wait for that turn instead, and ask the board to look again when
  // it ends: nothing else would. Without this the card holds at the door until
  // some unrelated change happens to tick the board.
  const held = task.sessionId ? connKeyFor(task.sessionId) : undefined
  if (held && hasActiveTurn(held)) {
    onceTurnDone(held, () => tick(win, task.project))
    return false
  }

  // ONE SESSION PER STEP, not per task (D28). LANE-CONTRACT opens every lane
  // with "you are a new session with no memory of the lanes that ran before",
  // and a session shared across stages made that a lie: the coder inherited the
  // specifier's whole conversation instead of reading the artifacts off disk,
  // which is the hand-off this board is built on. It also means a lane's context
  // is its own step, not five steps of transcript it never needed.
  //
  // The card still has ONE chat behind ⏎ — `sessionId` is whichever lane is on
  // it now, or the last one that was. The earlier ones stay in the worktree's
  // session list, which is where a finished lane's transcript belongs.
  const sessionId = randomUUID()
  addCreatedSession({
    id: sessionId,
    worktreePath: task.worktreePath,
    title: `${task.name} · ${stage.name}`
  })
  // Deliberately NOT marked `spawnedBy`, though a lane is agent-driven and the
  // flag looks like it fits. `spawnedBy` means "no human can see this session",
  // so agent.ts answers the child's AskUserQuestion itself with
  // CHILD_ANSWERS_ITSELF and never shows a card — which is right for a session
  // an agent opened for its own background work, and wrong here. A lane's
  // question is the ONE thing this board is built to show: it is the needs-you
  // band, the attention strip and the only use of the accent colour. Marked
  // spawned, that band could never fill and a card could never ask.

  // THE STEP REPORT TRACKS A CARD FROM ITS FIRST STAGE ON. Entering the first
  // stage with the report on is the moment it starts; a card already past it
  // stays untracked, because a report missing its first steps would draw the
  // steps that did run as the whole story. Once tracked, it stays tracked until
  // done, even if the switch goes off midway — half a report is the same lie.
  const config = colonyConfig(task.project)
  const startsHere = config.stages[0]?.name === stage.name
  const report = task.report ?? (startsHere && config.report ? { since: Date.now() } : undefined)
  const startedAt = Date.now()

  patchTask(task.id, {
    sessionId,
    status: 'working',
    warn: undefined,
    line: `${stage.name}: starting`,
    ...(report ? { report: { ...report, current: { at: startedAt } } } : {})
  })

  // `/skill` and not the skill's text: startTurn expands the token before
  // dispatch, so one Floe skill reaches opus, haiku and codex as the same
  // instructions — which is the whole reason a lane can pick its own model.
  const prompt = lanePrompt(task, stage) + (report ? `\n\n${findingsAsk(task)}` : '')

  if (!report) return dispatchLane(win, task, stage, sessionId, prompt)
  // Snapshot BEFORE the lane gets its prompt, so the step's diff is only what
  // it wrote. Async, so the card already holds its spot (`working`, above) and
  // the scheduler counts it; the turn starts when the tree is taken.
  const worktreePath = task.worktreePath
  void snapshotTree(worktreePath)
    .catch(() => undefined)
    .then((tree) => {
      const now = getTask(task.id)
      // Moved or archived while git ran: this step is not the card's any more.
      if (!now || now.sessionId !== sessionId || now.status !== 'working') return
      if (tree && now.report) patchTask(task.id, { report: { ...now.report, current: { at: startedAt, tree } } })
      dispatchLane(win, task, stage, sessionId, prompt)
    })
  return true
}

/**
 * What a tracked lane is asked for on top of its skill: a `FINDINGS:` block,
 * and the findings earlier steps already raised, so it can mark its own repeats.
 *
 * Inlined rather than written to the artifacts directory: that directory lands
 * on base with the merge, and the report's bookkeeping has no business in the
 * project's history.
 */
export function findingsAsk(task: ColonyTask): string {
  const earlier = task.visits.flatMap((v) =>
    (v.step?.findings ?? []).filter((f) => f.fresh).map((f) => `- ${v.stage}: [${f.severity}] ${f.text}`)
  )
  return [
    'STEP REPORT — this board is measuring what each step adds. End your last message with a findings block, directly above your COLONY: line:',
    '',
    'FINDINGS:',
    '- [high|med|low] new: <one line>',
    '- [high|med|low] seen <stage>: <one line>',
    '',
    'A finding is a problem, risk or decision you identified in this step — not a summary of what you changed.',
    'Mark it `seen <stage>` when an earlier step already raised it (listed below), `new` otherwise.',
    'Write `FINDINGS: none` when you found nothing.',
    '',
    'Raised by earlier steps on this task:',
    ...(earlier.length ? earlier : ['(none yet)'])
  ].join('\n')
}

/** Hand the lane its prompt, and listen for how the turn ends. False means it did not start. */
function dispatchLane(win: BrowserWindow, task: ColonyTask, stage: ColonyStage, sessionId: string, prompt: string): boolean {
  if (!task.worktreePath) return false
  try {
    // The session id itself is the key: one minted a moment ago has no claudeId
    // yet and no live connection sitting under another name.
    startTurn(win, sessionId, task.worktreePath, prompt, {
      permissionMode: 'skip',
      model: stage.model,
      provider: stage.harness
    })
  } catch (err) {
    // Back to the door rather than stuck at `working`: nobody would be listening
    // for a turn that never started, so the card would hold a spot forever.
    //
    // The session minted for this step goes with it. A turn that never started
    // leaves an empty chat, and one per failed attempt would pile up in the
    // tree's session list — so the card points back at the last step that ran.
    closeSession({ id: sessionId, worktreePath: task.worktreePath })
    patchTask(task.id, {
      sessionId: task.sessionId,
      status: 'holding',
      line: undefined,
      warn: `${stage.name} could not start: ${(err as Error).message}`,
      // The step never ran, so it has nothing to measure.
      ...(getTask(task.id)?.report ? { report: { ...(getTask(task.id)?.report ?? { since: Date.now() }), current: undefined } } : {})
    })
    return false
  }
  // AFTER the dispatch, not before. A listener registered for a turn that then
  // failed to start cannot be taken back off (`onceTurnDone` has no remove), so
  // it would fire on whatever turn ran in this session next and move the card on
  // a verdict from another conversation. The done event can only arrive on a
  // later tick, so there is no turn to miss by registering here.
  onceTurnDone(sessionId, (text) => finishLane(win, task.id, stage.name, text))
  return true
}

/**
 * The standing instruction an autonomous task's lanes open with.
 *
 * In the prompt and not only in the contract, because it is a fact about this
 * task, and the contract is the same text for every task on every board.
 */
export const AUTONOMOUS_BOARD =
  'AUTONOMOUS BOARD: nobody will answer a question on this task — not the user, not the nanny. ' +
  'Do not call AskUserQuestion and do not end a turn with a question. When a decision is open, take the ' +
  'recommended option (the brief\'s Decisions and Still open sections first), record it as (assumed) in your ' +
  'artifact, and keep going.'

/** What a lane is dispatched with: the skill, where the task is, and the brief. */
function lanePrompt(task: ColonyTask, stage: ColonyStage): string {
  const autonomous = resolveFlag(task, colonyConfig(task.project), 'autonomous')
  return [
    `/${stage.skill}`,
    '',
    `Task: ${task.name} (${task.kind})`,
    `Artifacts: ${taskDirFor(task.branch ?? task.name)}/`,
    // LANE-CONTRACT diffs against this. Without it a lane on a feature's parent
    // branch reviews the whole feature as if this task wrote it.
    `Base: ${task.base ?? 'the default branch'}`,
    ...(autonomous ? ['', AUTONOMOUS_BOARD] : []),
    '',
    task.brief.trim()
  ].join('\n')
}

/** The one follow-up a lane gets when its turn ended without a hand-off line. */
export const VERDICT_NUDGE = [
  'Your last message did not end with the hand-off line, so the board cannot tell how this lane ended.',
  'Do no more work. Reply with exactly one line, alone:',
  '',
  'COLONY: pass',
  'COLONY: return <lane> — <one line: what is wrong>',
  'COLONY: stop — <one line: why this task should not continue>'
].join('\n')

/**
 * Ask a lane that ended without a verdict for one, once.
 *
 * On the next tick rather than inside the turn-done callback: the turn is still
 * being closed when its listeners run, and a second prompt into a session that
 * has not finished its first is two turns in one conversation.
 */
function askForVerdict(win: BrowserWindow, task: ColonyTask, stageName: string): void {
  const giveUp = (): void => finishLane(win, task.id, stageName, '', true)
  const sessionId = task.sessionId
  const worktreePath = task.worktreePath
  if (!sessionId || !worktreePath) return giveUp()
  const stage = colonyConfig(task.project).stages.find((s) => s.name === stageName)
  patchTask(task.id, { line: `${stageName}: asking for its verdict` })
  pushBoard(win, task.project)
  setTimeout(() => {
    try {
      startTurn(win, sessionId, worktreePath, VERDICT_NUDGE, {
        permissionMode: 'skip',
        model: stage?.model,
        provider: stage?.harness
      })
    } catch {
      return giveUp()
    }
    onceTurnDone(sessionId, (text) => finishLane(win, task.id, stageName, text, true))
  }, 0)
}

/**
 * A lane's turn ended. Read its verdict and move the card.
 *
 * No line, or one the board cannot parse, is `pass` with a warning — that is
 * what LANE-CONTRACT promises the agent, so the board has to keep the promise
 * rather than quietly failing closed on it.
 */
function finishLane(win: BrowserWindow, id: string, stage: string, text: string, asked = false): void {
  const task = getTask(id)
  // Moved out from under the lane (answered, archived, dragged) while it ran —
  // the board's later state wins over a verdict about where it used to be.
  if (!task || task.stage !== stage || task.status !== 'working') return
  const current = task.report?.current
  if (!current || !task.worktreePath) return settleLane(win, id, stage, text, undefined, asked)

  // Measured: take the end snapshot BEFORE the card moves. Moving it ticks the
  // board, and the next lane starting in this worktree would write into the
  // tree this step is about to be diffed on.
  const sessionId = task.sessionId
  const at = colonyConfig(task.project).stages.find((s) => s.name === stage)
  void snapshotTree(task.worktreePath)
    .catch(() => undefined)
    .then((treeAfter) => {
      const found = parseFindings(text)
      settleLane(win, id, stage, text, {
        startedAt: current.at,
        endedAt: Date.now(),
        harness: at?.harness ?? 'claude',
        model: at?.model,
        usage: usageOf(sessionId ? sessionKeys(sessionId) : []),
        treeBefore: current.tree,
        treeAfter,
        findingsDeclared: found.declared,
        findings: found.findings,
        // The END of the message: that is where the findings and the verdict are.
        message: text.length > MESSAGE_CAP ? `…${text.slice(-MESSAGE_CAP)}` : text
      }, asked)
    })
}

/** How much of a lane's last message a step record keeps. */
const MESSAGE_CAP = 20_000

/** Every key a session's spend can have been recorded under. */
function sessionKeys(id: string): string[] {
  const s = getAllCreatedSessions().find((x) => x.id === id)
  return s ? [s.id, ...(s.claudeId ? [s.claudeId] : []), ...(s.pastClaudeIds ?? [])] : [id]
}

/** Record the verdict — and, when measured, the step — and move the card. */
function settleLane(
  win: BrowserWindow,
  id: string,
  stage: string,
  text: string,
  step?: StepRecord,
  asked = false
): void {
  const task = getTask(id)
  if (!task || task.stage !== stage || task.status !== 'working') return

  const handoff = parseHandoff(text)
  // Most missing lines are a lane that forgot to write one. Asking costs one
  // short turn; guessing `pass` sends unverified work on to the next lane.
  if (!handoff && !asked) return askForVerdict(win, task, stage)
  const at = Date.now()

  // The step's own session goes on the visit: with one session per step, that
  // pointer is the only way back to the transcript that produced this verdict.
  const sessionId = task.sessionId
  // The step rides on the visit, and the card stops pointing at a running step.
  const visit = (v: TaskVisit): TaskVisit => (step ? { ...v, step } : v)
  const measured = task.report ? { report: { ...task.report, current: undefined } } : {}

  if (handoff?.verdict === 'stop') {
    recordVisit(id, visit({ at, stage, sessionId, verdict: 'stop', why: handoff.why }), {
      ...measured,
      stage: INBOX,
      status: 'holding',
      line: handoff.why || 'stopped'
    })
    // A stop is a decision the board cannot make. That is exactly what the
    // manager is for — tell her rather than leaving the card in the backlog for
    // somebody to notice.
    recordEvent({
      project: task.project,
      kind: 'stopped',
      task: id,
      taskName: task.name,
      branch: task.branch,
      worktreePath: task.worktreePath,
      text: `stopped in ${stage}: ${handoff.why || 'no reason given'}`
    })
    nudgeNanny(win, task.project, `"${task.name}" stopped in ${stage}: ${handoff.why || 'no reason given'}`)
  } else if (handoff?.verdict === 'return') {
    // A return is a second visit, not a fresh arrival (D23): the pass count is
    // what the card prints, and a task bouncing between two lanes is the signal
    // that something is wrong with the task rather than with the lane.
    const back = colonyConfig(task.project).stages.find((s) => s.name === handoff.lane)
    recordVisit(id, visit({ at, stage, sessionId, verdict: 'return', why: handoff.why }), {
      ...measured,
      // A lane that names a stage nobody has is not a reason to lose the task —
      // park it as a question instead.
      stage: back ? back.name : stage,
      status: back ? 'holding' : 'blocked',
      line: back ? `returned from ${stage}: ${handoff.why}` : `returned to an unknown lane "${handoff.lane}"`
    })
    // A return to a real lane moves itself. A return to a lane nobody has is
    // parked, and stays parked until a human renames a stage or requeues it.
    if (!back) {
      recordEvent({
        project: task.project,
        kind: 'lost',
        task: id,
        taskName: task.name,
        branch: task.branch,
        worktreePath: task.worktreePath,
        text: `${stage} handed it back to "${handoff.lane}", which is not a stage on this board`
      })
      nudgeNanny(win, task.project, `"${task.name}" returned to a lane nobody has: "${handoff.lane}"`)
    }
  } else {
    const next = nextStage(task.project, stage) ?? DONE
    recordVisit(id, visit({ at, stage, sessionId, verdict: handoff ? 'pass' : 'none' }), {
      ...measured,
      stage: next,
      status: next === DONE ? 'settled' : 'holding',
      passes: task.passes + 1,
      warn: handoff ? undefined : `${stage} ended without a COLONY: line`,
      line: next === DONE ? 'done' : `passed ${stage}`
    })
    // Reaching `done` is the moment the merge question becomes answerable, and
    // the moment whatever is queued behind this task can move. Floating on
    // purpose: `finishLane` is a turn-done listener and merging is git, so it
    // cannot be waited for here without holding the harness's callback open.
    if (next === DONE) {
      recordEvent({
        project: task.project,
        kind: 'passed',
        task: id,
        taskName: task.name,
        branch: task.branch,
        worktreePath: task.worktreePath,
        text: `passed ${stage} — the last stage, so it reached done`
      })
    }
  }

  pushBoard(win, task.project)
  // The next lane and the merge both start from the tree as it is on disk, so
  // they wait for this lane's documents to be committed.
  const reachedDone = getTask(id)?.stage === DONE
  void fileArtifacts(task, stage).finally(() => {
    if (reachedDone) void settleDone(win, id)
    tick(win, task.project)
    pushBoard(win, task.project)
  })
}

/**
 * What happens once a card lands in `done`: merge it if the board says to, and
 * tell the manager either way.
 *
 * The merge is mechanical and the reporting is not, which is why it splits here.
 * `mergeWorktree` already refuses everything it should refuse, so "merge it" is
 * a decision no judgement is needed for — but a refused merge, and the question
 * of what to start next, are exactly what a person wants a sentence about.
 */
async function settleDone(win: BrowserWindow, id: string): Promise<void> {
  const task = getTask(id)
  if (!task || task.stage !== DONE || task.mergedAt) return

  // The last lane never said how it ended. Everything before it may have passed,
  // but "the lane that verifies it went quiet" is not a pass anybody should
  // merge on without reading it first.
  const last = task.visits[task.visits.length - 1]
  if (last?.verdict === 'none') {
    patchTask(id, { warn: `${last.stage} never gave a verdict — not merged automatically` })
    await sweepReleases(win, task.project)
    nudgeNanny(win, task.project, `"${task.name}" reached done, but ${last.stage} ended without a verdict — it was not merged. Read that lane's transcript before merging it.`)
    pushBoard(win, task.project)
    return
  }

  if (!colonyConfig(task.project).automerge) {
    // Still sweep: `automerge = false` is about who runs the merge, not about
    // whether a card that merged earlier releases what was waiting on it.
    await sweepReleases(win, task.project)
    await reportDone(win, id)
    nudgeNanny(win, task.project, `"${task.name}" reached done and is waiting to be merged (automerge is off).`)
    return
  }

  const result = await mergeTask(win, id)
  // AFTER the merge attempt, never before: the report goes into the main
  // checkout, and the merge is the thing that looks at that checkout.
  await reportDone(win, id)
  nudgeNanny(
    win,
    task.project,
    result.ok
      ? `"${task.name}" reached done and merged cleanly into base.`
      : `"${task.name}" reached done but did not merge: ${result.message ?? 'no reason given'}`
  )
}

/** The report a tracked card gets on reaching done. A failure is a warning, never a stuck card. */
async function reportDone(win: BrowserWindow, id: string): Promise<void> {
  if (!getTask(id)?.report) return
  try {
    await writeTaskReport(win, id)
  } catch (err) {
    patchTask(id, { warn: `report not written: ${(err as Error).message}` })
    pushBoard(win, getTask(id)?.project ?? '')
  }
}

/**
 * Write (or rewrite) a tracked card's report now, and return the file.
 *
 * Callable at any point, not only at done: a card that stopped or bounced is
 * exactly the one whose steps you want to read, and it may never reach done.
 */
export async function writeTaskReport(
  win: BrowserWindow | undefined,
  id: string
): Promise<Awaited<ReturnType<typeof writeReport>>> {
  const task = getTask(id)
  if (!task) throw new Error(`Unknown task: ${id}`)
  if (!task.report) throw new Error(`"${task.name}" is not tracked — turn the report on before it enters the first stage`)
  const written = await writeReport(task)
  const now = getTask(id)
  if (now?.report) patchTask(id, { report: { ...now.report, file: written.file } })
  pushBoard(win, task.project)
  return written
}

// ---------------------------------------------------------------------------
// Telling the renderer
// ---------------------------------------------------------------------------

export function pushBoard(win: BrowserWindow | undefined, project: string): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send('colony:event', { project })
}

// ---------------------------------------------------------------------------
// The nanny
// ---------------------------------------------------------------------------

/**
 * The board's own session — one per project, in the project root.
 *
 * The root and not a worktree: she is the one session that is about the whole
 * board, and a nanny living in one task's tree would go away with it. She runs
 * with the user's normal permissions, unlike a lane: she is a chat, and the
 * person talking to her is right there.
 */
export function nannyFor(project: string): {
  sessionId: string
  worktreePath: string
  /** Just minted, so the caller opens her with the skill that says who she is. */
  fresh: boolean
} {
  const existing = getNanny(project)
  if (existing && getAllCreatedSessions().some((s) => s.id === existing)) {
    return { sessionId: existing, worktreePath: project, fresh: false }
  }
  const sessionId = randomUUID()
  addCreatedSession({ id: sessionId, worktreePath: project, title: 'nanny' })
  setNanny(project, sessionId)
  return { sessionId, worktreePath: project, fresh: true }
}

/**
 * The message a brand-new nanny opens with.
 *
 * Sent once, on the turn that creates her, rather than left for the user to
 * type: a chat that has not read the skill is not the nanny, it is a chat in the
 * project root — and the first thing anyone asks her is the thing she cannot
 * answer without it.
 */
export function nannyOpener(project: string): string {
  return [
    '/colony-nanny',
    '',
    `You are the nanny for the project at ${project}.`,
    'Read the board. Tell me what is holding, what is done and not merged yet,',
    'and what is queued behind something. Two lines. Then wait.'
  ].join('\n')
}

/**
 * Notes waiting to reach a project's nanny, and whether a flush is already due.
 *
 * Buffered rather than sent one per event, for two reasons. A nanny mid-turn
 * cannot take a second prompt — `startTurn` on a busy session is a second agent
 * in the same conversation. And five lanes finishing inside a second is ONE
 * thing to tell her, not five turns that each re-read the same board.
 */
const nannyNotes = new Map<string, string[]>()
const nannyDue = new Set<string>()

/**
 * Tell the project's manager that something on the board moved.
 *
 * Only an EXISTING nanny, never a new one. Minting her here would open a chat
 * nobody asked for and start it talking to a panel that is not on screen — the
 * same reason the `colony:nanny` handler leaves the opener to the renderer.
 */
export function nudgeNanny(win: BrowserWindow | undefined, project: string, note: string): void {
  if (!win || win.isDestroyed()) return
  const sessionId = getNanny(project)
  if (!sessionId || !getAllCreatedSessions().some((s) => s.id === sessionId)) return

  nannyNotes.set(project, [...(nannyNotes.get(project) ?? []), note])
  if (nannyDue.has(project)) return
  nannyDue.add(project)
  // A beat, so a burst of lanes finishing together collapses into one turn
  // rather than racing each other to be the one that reports.
  setTimeout(() => flushNanny(win, project, sessionId), 250)
}

function flushNanny(win: BrowserWindow, project: string, sessionId: string): void {
  if (win.isDestroyed()) {
    nannyDue.delete(project)
    nannyNotes.delete(project)
    return
  }
  const key = connKeyFor(sessionId)
  // She is talking to the user. Wait — interrupting that turn would answer a
  // question nobody asked and lose the one they did. The notes keep piling up
  // in the meantime, which is the right outcome: they are still true.
  if (hasActiveTurn(key)) {
    onceTurnDone(key, () => flushNanny(win, project, sessionId))
    return
  }
  nannyDue.delete(project)
  const notes = nannyNotes.get(project) ?? []
  nannyNotes.delete(project)
  if (!notes.length) return

  const prompt = [
    'BOARD EVENT — nobody asked you a question. These cards moved on their own:',
    '',
    ...notes.map((note) => `- ${note}`),
    '',
    'Run your merge and ordering duties on the current board, then report in at',
    'most three lines: what landed, what is blocked, and what you started next.',
    'If nothing needs the user, say so in one line and stop.'
  ].join('\n')

  try {
    // Her own permissions, not a lane's `skip`: she merges into the user's base
    // branch and the user is right there in the panel watching her do it.
    startTurn(win, sessionId, project, prompt, { permissionMode: 'default' })
  } catch {
    // Nothing to recover. A manager who could not be told is a manager the user
    // asks instead, and the board itself is on screen and already correct.
  }
}

// ---------------------------------------------------------------------------
// Coming back from a quit
// ---------------------------------------------------------------------------

/**
 * Un-stick the tasks a quit interrupted.
 *
 * `finishLane` is a one-shot listener on a live connection (`onceTurnDone`), so
 * a task that was `working` when the app went away has nobody left to read its
 * hand-off line — it would sit in that stage, holding a spot, until somebody
 * noticed by hand.
 *
 * They go back to `holding` in the SAME stage rather than forward: a lane that
 * did not report has not passed, and re-running it is cheap and safe. Every lane
 * is a fresh session that reads the artifacts and the diff off disk (see
 * LANE-CONTRACT), so a second run picks up where the first one stopped instead
 * of starting the work over.
 *
 * Called once, at boot, before the board is ever painted.
 */
export function reconcileColony(win: BrowserWindow): void {
  const projects = new Set<string>()
  for (const task of allTasks()) {
    if (task.status !== 'working') continue
    // A live turn survives nothing — but the check costs nothing either, and it
    // is what makes this safe to call more than once.
    if (task.sessionId && hasActiveTurn(connKeyFor(task.sessionId))) continue
    patchTask(task.id, { status: 'holding', line: 'interrupted — starting again' })
    projects.add(task.project)
  }
  for (const project of projects) {
    tick(win, project)
    pushBoard(win, project)
  }

  // Then the cards queued behind a dependency: it can have been merged from the
  // terminal while the app was closed, and nothing else would ever look again.
  // After the ticks and floating, because releasing cuts worktrees — boot is not
  // waiting on git, and `releaseTask` ticks and repaints for itself.
  //
  // The finished cards somebody merged by hand while the app was closed go
  // first, in the same chain: noticing one releases what waits on it, and two
  // sweeps of one board at once would release the same card twice.
  const pending = allTasks().filter((t) => t.queued || (t.stage === DONE && !t.mergedAt))
  for (const project of new Set(pending.map((t) => t.project))) {
    void reconcileMerged(win, project).then(() => sweepReleases(win, project))
  }
}
