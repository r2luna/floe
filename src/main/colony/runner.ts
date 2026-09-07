// What actually moves a card: admit a task into a free spot, run the stage's
// skill in the task's own session, read the hand-off line off the last message,
// and move it on.
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
import { capOf, colonyConfig, columnsFor, DONE, INBOX, type ColonyStage } from '../config/colony'
import { addCreatedSession, getAllCreatedSessions } from '../sessionStore'
import { sessionRuntime, onceTurnDone, hasActiveTurn } from '../agent'
import { startTurn } from '../turn'
import { createWorktree } from '../git'
import { provisionWorktree } from '../provision'
import { listSkills } from '../config/skills'
import { parseHandoff, type Board, type BoardColumn } from '../../shared/colony'
import {
  allTasks,
  getNanny,
  setNanny,
  getTask,
  listTasks,
  patchTask,
  recordVisit,
  type ColonyTask,
  type TaskStatus
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
  const tasks = listTasks(project)
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
    errors: config.errors.map((e) => ({ file: e.file, line: e.line, reason: e.reason }))
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

  let worktreePath = task.worktreePath
  let branch = task.branch
  if (!worktreePath) {
    // `<kind>/<name>` — the branch says what the change IS before you read it.
    const worktrees = await createWorktree(task.project, `${task.kind}/${task.name}`, {
      note: task.brief.slice(0, 80)
    })
    const created = worktrees[worktrees.length - 1]
    worktreePath = created.path
    branch = created.branch
    // The same per-stack setup the in-app create flow runs — otherwise the lane
    // opens in a tree with no dependencies. Fire-and-forget: progress streams to
    // the setup checklist, and the first lane reads files, not node_modules.
    void provisionWorktree(win, task.project, created.path, created.branch)
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
    stage: nextStage(task.project, INBOX) ?? DONE,
    status: 'holding',
    line: undefined
  })
  tick(win, task.project)
  return moved ?? task
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

  // One session per TASK, not per lane: the card's chat is the task's whole
  // history, and a session per stage would mean six chats behind one card and no
  // answer to "which one does ⏎ open?".
  let sessionId = task.sessionId
  if (!sessionId || !getAllCreatedSessions().some((s) => s.id === sessionId)) {
    sessionId = randomUUID()
    addCreatedSession({ id: sessionId, worktreePath: task.worktreePath, title: task.name })
    // Deliberately NOT marked `spawnedBy`, though a lane is agent-driven and the
    // flag looks like it fits. `spawnedBy` means "no human can see this
    // session", so agent.ts answers the child's AskUserQuestion itself with
    // CHILD_ANSWERS_ITSELF and never shows a card — which is right for a session
    // an agent opened for its own background work, and wrong here. A lane's
    // question is the ONE thing this board is built to show: it is the needs-you
    // band, the attention strip and the only use of the accent colour. Marked
    // spawned, that band could never fill and a card could never ask.
  }

  const key = connKeyFor(sessionId)
  // The card's session is mid-turn — you are talking to it. Wait for that turn
  // rather than queueing the lane behind your sentence, and ask the board to
  // look again when it ends: nothing else would. Without this the card holds at
  // the door until some unrelated change happens to tick the board.
  if (hasActiveTurn(key)) {
    onceTurnDone(key, () => tick(win, task.project))
    return false
  }

  patchTask(task.id, {
    sessionId,
    status: 'working',
    warn: undefined,
    line: `${stage.name}: starting`
  })

  // `/skill` and not the skill's text: startTurn expands the token before
  // dispatch, so one Floe skill reaches opus, haiku and codex as the same
  // instructions — which is the whole reason a lane can pick its own model.
  const prompt = `/${stage.skill}\n\nTask: ${task.name} (${task.kind})\nArtifacts: ${taskDirFor(task.branch ?? task.name)}/\n\n${task.brief.trim()}`

  try {
    startTurn(win, key, task.worktreePath, prompt, {
      permissionMode: 'skip',
      model: stage.model,
      provider: stage.harness
    })
  } catch (err) {
    // Back to the door rather than stuck at `working`: nobody would be listening
    // for a turn that never started, so the card would hold a spot forever.
    patchTask(task.id, {
      status: 'holding',
      line: undefined,
      warn: `${stage.name} could not start: ${(err as Error).message}`
    })
    return false
  }
  // AFTER the dispatch, not before. A listener registered for a turn that then
  // failed to start cannot be taken back off (`onceTurnDone` has no remove), so
  // it would fire on whatever turn ran in this session next and move the card on
  // a verdict from another conversation. The done event can only arrive on a
  // later tick, so there is no turn to miss by registering here.
  onceTurnDone(key, (text) => finishLane(win, task.id, stage.name, text))
  return true
}

/**
 * A lane's turn ended. Read its verdict and move the card.
 *
 * No line, or one the board cannot parse, is `pass` with a warning — that is
 * what LANE-CONTRACT promises the agent, so the board has to keep the promise
 * rather than quietly failing closed on it.
 */
function finishLane(win: BrowserWindow, id: string, stage: string, text: string): void {
  const task = getTask(id)
  // Moved out from under the lane (answered, archived, dragged) while it ran —
  // the board's later state wins over a verdict about where it used to be.
  if (!task || task.stage !== stage || task.status !== 'working') return

  const handoff = parseHandoff(text)
  const at = Date.now()

  if (handoff?.verdict === 'stop') {
    recordVisit(id, { at, stage, verdict: 'stop', why: handoff.why }, {
      stage: INBOX,
      status: 'holding',
      line: handoff.why || 'stopped'
    })
  } else if (handoff?.verdict === 'return') {
    // A return is a second visit, not a fresh arrival (D23): the pass count is
    // what the card prints, and a task bouncing between two lanes is the signal
    // that something is wrong with the task rather than with the lane.
    const back = colonyConfig(task.project).stages.find((s) => s.name === handoff.lane)
    recordVisit(id, { at, stage, verdict: 'return', why: handoff.why }, {
      // A lane that names a stage nobody has is not a reason to lose the task —
      // park it as a question instead.
      stage: back ? back.name : stage,
      status: back ? 'holding' : 'blocked',
      line: back ? `returned from ${stage}: ${handoff.why}` : `returned to an unknown lane "${handoff.lane}"`
    })
  } else {
    const next = nextStage(task.project, stage) ?? DONE
    recordVisit(id, { at, stage, verdict: handoff ? 'pass' : 'none' }, {
      stage: next,
      status: next === DONE ? 'settled' : 'holding',
      passes: task.passes + 1,
      warn: handoff ? undefined : `${stage} ended without a COLONY: line`,
      line: next === DONE ? 'done' : `passed ${stage}`
    })
  }

  tick(win, task.project)
  pushBoard(win, task.project)
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
    'Read the board and tell me what is holding, in the two lines your skill describes.',
    'Then wait.'
  ].join('\n')
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
}
