// What the scheduler decides, with nothing real behind it.
//
// The board's own logic is the thing under test: which card is admitted, what a
// hand-off line moves, what a crash puts back at the door. Everything past that
// seam — the agent, the turn, git, the provisioner — is stubbed at the module
// boundary, so a failure here is a decision this file got wrong and never a
// slow git or a missing harness. Config, the project scan, the skill list and
// the task store are the REAL modules, pointed at a tmpdir: they are cheap, and
// stubbing them would only test the stubs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

/** What the stubbed modules read and record. The tests drive the board through this. */
interface Stubs {
  /** key → what `sessionRuntime` reports for it. */
  runtime: Map<string, { live: boolean; running: boolean; waiting: boolean; since: number; lastLine: string }>
  /** keys `hasActiveTurn` says yes to. */
  active: Set<string>
  /** Every `onceTurnDone` registration, in order — how a test ends a lane's turn. */
  listeners: { key: string; cb: (text: string) => void }[]
  /** Every dispatched turn. */
  turns: { key: string; worktreePath: string; prompt: string; options: Record<string, unknown> }[]
  /** Set to make the next `startTurn` throw, as a missing harness would. */
  startTurnError: string | null
  created: { root: string; branch: string }[]
  provisioned: { root: string; worktreePath: string; branch: string }[]
  /** What `createWorktree` hands back. */
  worktreeFor: (root: string, branch: string) => { path: string; branch: string }[]
  /** Every `mergeWorktree` call, in order. */
  merges: { root: string; target: string }[]
  /** What `mergeWorktree` answers. Clean unless a test says otherwise. */
  mergeResult: (root: string, target: string) => {
    ok: boolean
    message?: string
    base?: string
    baseBefore?: string
    baseAfter?: string
  }
  /** Every `undoMerge` call, and what it answers. */
  undos: { root: string; base: string; expected: string; to: string }[]
  undoResult: (root: string, base: string) => { ok: boolean; message?: string }
  /** worktree path → the relative paths `changedFiles` reports for it. */
  changed: Map<string, string[]>
  /** The options every `createWorktree` was called with. */
  createOptions: Record<string, unknown>[]
  /** Every `commitPaths` call, in order, with the turn count at that moment. */
  commits: { worktree: string; paths: string[]; message: string; turnsBefore: number }[]
  /** Whether `isMergedInto` says yes. */
  mergedInto: (branch: string, base: string) => boolean
  /** What `dirtySnapshot` reports, and every `restoreSnapshot` call. */
  dirt: Record<string, string>
  restores: { worktree: string; snapshot: Record<string, string> }[]
  /** worktree path → what `uncommittedWork` reports. */
  uncommitted: Map<string, string[]>
  teardowns: { root: string; target: string }[]
  deletedBranches: string[]
  restoredBranches: { branch: string; sha: string }[]
  /** Every `readBase` answer, by worktree path. */
  bases: Map<string, string>
}

/**
 * What a clean `mergeWorktree` answers.
 *
 * A constant rather than an object literal per test, because it carries the
 * commits an undo needs — and a test that restored the default by hand without
 * them silently took the undo button away from every test after it.
 */
const CLEAN_MERGE = { ok: true, message: 'merged', base: 'main', baseBefore: 'aaa1111', baseAfter: 'bbb2222' }

const stubs: Stubs = {
  runtime: new Map(),
  active: new Set(),
  listeners: [],
  turns: [],
  startTurnError: null,
  created: [],
  provisioned: [],
  worktreeFor: (_root, branch) => [{ path: '/nowhere', branch }],
  merges: [],
  mergeResult: () => CLEAN_MERGE,
  changed: new Map(),
  undos: [],
  undoResult: () => ({ ok: true, message: 'put back' }),
  createOptions: [],
  commits: [],
  mergedInto: () => true,
  dirt: {},
  restores: [],
  uncommitted: new Map(),
  teardowns: [],
  deletedBranches: [],
  restoredBranches: [],
  bases: new Map()
}
;(globalThis as unknown as { __colonyStubs: Stubs }).__colonyStubs = stubs

// The same extensionless-import + `electron` hook the other main tests use, plus
// four stub modules served ONLY to runner.ts — matching on the parent keeps the
// real modules real for everyone else in the graph.
const hookSource = `
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
const STUBS = { '../agent': 'stub:agent', '../turn': 'stub:turn', '../git': 'stub:git', '../provision': 'stub:provision', '../worktreeTeardown': 'stub:teardown' }
const SOURCES = {
  'stub:agent': [
    'const s = () => globalThis.__colonyStubs',
    'export function sessionRuntime(key) { return s().runtime.get(key) ?? { live: false, running: false, waiting: false, since: 0, lastLine: "" } }',
    'export function hasActiveTurn(key) { return s().active.has(key) }',
    'export function onceTurnDone(key, cb) { s().listeners.push({ key, cb }) }'
  ].join('\\n'),
  'stub:turn': [
    'export function startTurn(win, key, worktreePath, prompt, options) {',
    '  const s = globalThis.__colonyStubs',
    '  if (s.startTurnError) throw new Error(s.startTurnError)',
    '  s.turns.push({ key, worktreePath, prompt, options })',
    '}'
  ].join('\\n'),
  'stub:git': [
    'export async function createWorktree(root, branch, options) {',
    '  const s = globalThis.__colonyStubs',
    '  s.created.push({ root, branch })',
    '  s.createOptions.push(options ?? {})',
    '  return s.worktreeFor(root, branch)',
    '}',
    'export async function mergeWorktree(root, target) {',
    '  const s = globalThis.__colonyStubs',
    '  s.merges.push({ root, target })',
    '  return s.mergeResult(root, target)',
    '}',
    'export async function changedFiles(worktreePath) {',
    '  const s = globalThis.__colonyStubs',
    '  return (s.changed.get(worktreePath) ?? []).map((relPath) => ({ relPath }))',
    '}',
    'export async function undoMerge(root, base, expected, to) {',
    '  const s = globalThis.__colonyStubs',
    '  s.undos.push({ root, base, expected, to })',
    '  return s.undoResult(root, base)',
    '}',
    'const s = () => globalThis.__colonyStubs',
    'export async function commitPaths(worktree, paths, message) { s().commits.push({ worktree, paths, message, turnsBefore: s().turns.length }); return true }',
    'export async function defaultBranch() { return "main" }',
    'export async function deleteBranch(root, branch) { s().deletedBranches.push(branch); return { ok: true } }',
    'export async function dirtySnapshot() { return s().dirt }',
    'export async function isMergedInto(root, branch, base) { return s().mergedInto(branch, base) }',
    'export function readBase(path) { return s().bases.get(path) }',
    'export async function restoreBranch(root, branch, sha) { s().restoredBranches.push({ branch, sha }); return true }',
    'export async function restoreSnapshot(worktree, snapshot) { s().restores.push({ worktree, snapshot }); return Object.keys(snapshot) }',
    'export async function uncommittedWork(path) { return s().uncommitted.get(path) ?? [] }'
  ].join('\\n'),
  'stub:teardown': [
    'export async function teardownWorktree(root, target) { globalThis.__colonyStubs.teardowns.push({ root, target }) }'
  ].join('\\n'),
  'stub:provision': [
    'export async function provisionWorktree(win, root, worktreePath, branch) {',
    '  globalThis.__colonyStubs.provisioned.push({ root, worktreePath, branch })',
    '}'
  ].join('\\n')
}
export async function resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: 'stub:electron', shortCircuit: true, format: 'module' }
  if (context.parentURL && context.parentURL.endsWith('/colony/runner.ts') && STUBS[specifier]) {
    return { url: STUBS[specifier], shortCircuit: true, format: 'module' }
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\\.[a-z]+$/i.test(specifier)) {
    try {
      const base = context.parentURL ? new URL(specifier, context.parentURL) : pathToFileURL(specifier)
      const tsPath = fileURLToPath(base) + '.ts'
      if (existsSync(tsPath)) return next(specifier + '.ts', context)
    } catch {}
  }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (url === 'stub:electron') {
    return {
      format: 'module',
      shortCircuit: true,
      source: "export const app = { getPath: () => '/tmp' }; export class BrowserWindow {}; export const dialog = {}; export const shell = {}; export const safeStorage = { isEncryptionAvailable: () => false }; export const ipcMain = { handle: () => {}, removeHandler: () => {} }; export default {};"
    }
  }
  if (SOURCES[url]) return { format: 'module', shortCircuit: true, source: SOURCES[url] }
  return next(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

// ---------------------------------------------------------------------------
// A machine of our own
// ---------------------------------------------------------------------------

const home = mkdtempSync(join(tmpdir(), 'floe-colony-runner-'))
process.env.XDG_CONFIG_HOME = join(home, 'config')
const configDir = join(home, 'config', 'floe')
mkdirSync(join(configDir, 'skills'), { recursive: true })
for (const skill of ['colony-implement', 'colony-verify']) {
  writeFileSync(join(configDir, 'skills', `${skill}.md`), `# ${skill}\n`)
}

const { setSharedDataDir } = await import('../dataDir.ts')
setSharedDataDir(join(home, 'data'))

const { invalidateProjects } = await import('../config/projectStore.ts')
const { addTask, getTask, listTasks, patchTask } = await import('./store.ts')
const { listEvents } = await import('./events.ts')
const { setProjectAutomerge } = await import('../config/colony.ts')
const { addCreatedSession, getAllCreatedSessions, linkCreatedSession } = await import(
  '../sessionStore.ts'
)
const {
  AUTONOMOUS_BOARD,
  boardFor,
  compactBoard,
  mergeTask,
  reconcileMerged,
  nannyFor,
  overlappingTasks,
  reconcileColony,
  releaseTask,
  holdTask,
  taskDirFor,
  tick,
  undoTaskMerge,
  unmetDeps
} = await import('./runner.ts')

/** Two stages, one spot each — enough board to jam. */
const TWO_STAGES = [
  'cap = 1',
  '',
  '[[stage]]',
  'name = "coder"',
  'skill = "colony-implement"',
  '',
  '[[stage]]',
  'name = "qa"',
  'skill = "colony-verify"'
].join('\n')

/** One stage: passing it is passing the board. */
const ONE_STAGE = ['[[stage]]', 'name = "coder"', 'skill = "colony-implement"'].join('\n')

/** `qa` works nobody, so a card that reaches its door stays there to be read. */
const QA_CLOSED = [TWO_STAGES, 'cap = 0'].join('\n')

/** The same, one stage earlier: a card returned to `coder` is not re-admitted. */
const CODER_CLOSED = [
  'cap = 1',
  '',
  '[[stage]]',
  'name = "coder"',
  'skill = "colony-implement"',
  'cap = 0',
  '',
  '[[stage]]',
  'name = "qa"',
  'skill = "colony-verify"'
].join('\n')

let projects = 0

/** A tracked project with its own board — one per test, so no test inherits another's cards. */
function project(colonyToml = TWO_STAGES): string {
  const root = join(home, `repo-${++projects}`)
  const dir = join(configDir, 'projects', `p${projects}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.toml'), `path = "${root}"\n`)
  writeFileSync(join(dir, 'colony.toml'), colonyToml)
  invalidateProjects()
  return root
}

/** A worktree that really exists on disk, because releaseTask writes the brief into it. */
function tree(name: string): string {
  const path = join(home, `tree-${name}`)
  mkdirSync(path, { recursive: true })
  return path
}

const sent: { channel: string; payload: unknown }[] = []
const win = {
  isDestroyed: () => false,
  webContents: {
    send: (channel: string, payload: unknown): void => {
      sent.push({ channel, payload })
    }
  }
} as unknown as BrowserWindow

/** The listener the last started lane registered — the handle on "its turn ended". */
const lastListener = (): ((text: string) => void) => {
  const last = stubs.listeners[stubs.listeners.length - 1]
  assert.ok(last, 'a lane registered no done listener')
  return last.cb
}

/** A card already in a stage, holding at its door with a tree behind it. */
function holdingAt(root: string, stage: string, name: string): string {
  const task = addTask({ project: root, name, brief: `do ${name}` })
  patchTask(task.id, { stage, status: 'holding', worktreePath: tree(name), branch: `feat/${name}` })
  return task.id
}

test('a lane reads and writes specs/<branch with slashes flattened>/', () => {
  // LANE-CONTRACT states this rule to the agent; the board has to compute the
  // same path, or the brief is written where nobody looks for it.
  assert.equal(taskDirFor('feature/DOS-12'), 'specs/feature-DOS-12')
  assert.equal(taskDirFor('fix/backgrounded-polling'), 'specs/fix-backgrounded-polling')
  assert.equal(taskDirFor('plain'), 'specs/plain')
})

// ---------------------------------------------------------------------------
// Releasing
// ---------------------------------------------------------------------------

test('releasing a backlog card cuts its tree, writes the brief and starts the first lane', async () => {
  const root = project()
  const worktree = tree('release')
  stubs.worktreeFor = (_root, branch) => [{ path: worktree, branch }]
  const created = addTask({ project: root, name: 'Backgrounded Polling', kind: 'fix', brief: 'events drop' })

  const moved = await releaseTask(win, created.id)

  // `<kind>/<name>`, and the same per-stack setup the in-app create flow runs.
  assert.deepEqual(stubs.created.at(-1), { root, branch: 'fix/backgrounded-polling' })
  assert.equal(stubs.provisioned.at(-1)?.worktreePath, worktree)
  // The card is at the first stage's door, not in the backlog and not working:
  // admitting it is the tick's job, which runs after this patch.
  assert.equal(moved.stage, 'coder')
  assert.equal(moved.status, 'holding')

  // The brief has to be there before the specifier opens on it.
  const brief = readFileSync(join(worktree, taskDirFor('fix/backgrounded-polling'), 'task.md'), 'utf8')
  assert.match(brief, /^# backgrounded-polling$/m)
  assert.match(brief, /^kind: fix$/m)
  assert.match(brief, /events drop/)

  // And the tick that follows admitted it into the free spot.
  const after = getTask(created.id)
  assert.equal(after?.status, 'working')
  assert.equal(after?.line, 'coder: starting')
  const turn = stubs.turns.at(-1)
  assert.equal(turn?.worktreePath, worktree)
  // `/skill` and not the skill's text — startTurn expands the token.
  assert.match(turn?.prompt ?? '', /^\/colony-implement\n/)
  assert.match(turn?.prompt ?? '', /Artifacts: specs\/fix-backgrounded-polling\//)
  assert.equal(turn?.options.permissionMode, 'skip')
  // The step's own session, opened in the task's tree.
  assert.equal(getAllCreatedSessions().find((s) => s.id === after?.sessionId)?.worktreePath, worktree)
})

test('releasing an already-released card only un-parks a blocked one', async () => {
  const root = project()
  const id = holdingAt(root, 'coder', 'parked')
  patchTask(id, { status: 'settled' })
  const cut = stubs.created.length

  // Past the backlog and not blocked: nothing to release, and no second tree.
  const untouched = await releaseTask(win, id)
  assert.equal(untouched.status, 'settled')
  assert.equal(stubs.created.length, cut)

  // Blocked is the one case that IS a release — same key, same intent: run this.
  patchTask(id, { status: 'blocked', warn: 'asked a question' })
  const requeued = await releaseTask(win, id)
  assert.equal(requeued.status, 'holding')
  assert.equal(requeued.line, 'starting again')
  assert.equal(requeued.warn, undefined)
  assert.equal(stubs.created.length, cut)
  // The tick it triggers puts it straight back on a lane.
  assert.equal(getTask(id)?.status, 'working')
})

test('releasing a task the board does not have is an error, not a silent no-op', async () => {
  await assert.rejects(() => releaseTask(win, 'task_nope'), /Unknown task: task_nope/)
})

// ---------------------------------------------------------------------------
// Admitting
// ---------------------------------------------------------------------------

test('a stage whose skill does not exist warns and starts nothing (D19)', () => {
  const root = project(['[[stage]]', 'name = "coder"', 'skill = "no-such-skill"'].join('\n'))
  const id = holdingAt(root, 'coder', 'unknown-skill')
  const turns = stubs.turns.length

  tick(win, root)

  const after = getTask(id)
  assert.equal(after?.status, 'holding')
  assert.match(after?.warn ?? '', /stage "coder" names a skill that does not exist: no-such-skill/)
  assert.equal(stubs.turns.length, turns)
})

test('a card with no worktree is not startable, and holds without a warning', () => {
  const root = project()
  const task = addTask({ project: root, name: 'treeless', brief: '' })
  patchTask(task.id, { stage: 'coder', status: 'holding' })
  const turns = stubs.turns.length

  tick(win, root)

  const after = getTask(task.id)
  assert.equal(after?.status, 'holding')
  assert.equal(after?.warn, undefined)
  assert.equal(stubs.turns.length, turns)
})

test('a lane waits for the turn you are having, and the board looks again when it ends', () => {
  const root = project()
  const id = holdingAt(root, 'coder', 'mid-turn')
  const sessionId = 'sess-mid-turn'
  addCreatedSession({ id: sessionId, worktreePath: tree('mid-turn') })
  patchTask(id, { sessionId })
  stubs.active.add(sessionId)
  const turns = stubs.turns.length

  tick(win, root)

  // Queued behind your sentence, not dispatched into it.
  assert.equal(getTask(id)?.status, 'holding')
  assert.equal(stubs.turns.length, turns)

  // Nothing else would tick this board — the listener registered on your turn is
  // what gets the card off the door.
  const wake = lastListener()
  stubs.active.delete(sessionId)
  wake('')
  assert.equal(getTask(id)?.status, 'working')
  assert.equal(stubs.turns.length, turns + 1)
})

test('every step gets its own session, and the card points at the one running now', async () => {
  const root = project()
  const id = holdingAt(root, 'coder', 'per-step')

  tick(win, root)
  const first = getTask(id)?.sessionId
  assert.ok(first)

  lastListener()('COLONY: pass')
  await settle()

  // The next stage runs in a session of its own: LANE-CONTRACT promises each
  // lane no memory of the ones before it, and a shared session broke that.
  const after = getTask(id)
  assert.equal(after?.stage, 'qa')
  assert.equal(after?.status, 'working')
  assert.ok(after?.sessionId)
  assert.notEqual(after?.sessionId, first)

  // Both in the task's tree, and the finished one is still there to read back.
  const sessions = getAllCreatedSessions()
  const worktree = after?.worktreePath
  assert.equal(sessions.find((s) => s.id === first)?.worktreePath, worktree)
  assert.equal(sessions.find((s) => s.id === after?.sessionId)?.worktreePath, worktree)
  // Titled by step, or six sessions in one tree are six chats with one name.
  assert.equal(sessions.find((s) => s.id === first)?.title, 'per-step \u00b7 coder')
  assert.equal(sessions.find((s) => s.id === after?.sessionId)?.title, 'per-step \u00b7 qa')

  // And the visit points back at the session whose verdict moved the card.
  assert.equal(after?.visits.at(-1)?.stage, 'coder')
  assert.equal(after?.visits.at(-1)?.sessionId, first)
})

test('a re-run of the same stage is a new session too, not the interrupted one', () => {
  const root = project(ONE_STAGE)
  const id = holdingAt(root, 'coder', 'rerun')

  tick(win, root)
  const first = getTask(id)?.sessionId
  assert.ok(first)

  // The app went away mid-lane: nobody is left to read the hand-off line.
  reconcileColony(win)

  const after = getTask(id)
  assert.equal(after?.stage, 'coder')
  assert.equal(after?.status, 'working')
  assert.notEqual(after?.sessionId, first)
})

test('a turn that could not start puts the card back at the door instead of holding a spot', () => {
  const root = project()
  const id = holdingAt(root, 'coder', 'no-harness')
  stubs.startTurnError = 'codex is not installed'
  try {
    tick(win, root)
  } finally {
    stubs.startTurnError = null
  }

  const after = getTask(id)
  assert.equal(after?.status, 'holding')
  assert.equal(after?.line, undefined)
  assert.match(after?.warn ?? '', /coder could not start: codex is not installed/)
  // The step's session goes with the step: a turn that never started leaves an
  // empty chat, and one per failed attempt would pile up in the tree.
  assert.equal(after?.sessionId, undefined)
  assert.equal(getAllCreatedSessions().some((s) => s.worktreePath === tree('no-harness')), false)

  // Nobody was listening for a turn that never started, so the spot is free and
  // the next tick can use it.
  tick(win, root)
  assert.equal(getTask(id)?.status, 'working')
})

test('a full stage admits nobody else, and the card that waited longest goes first', async () => {
  const root = project()
  const first = holdingAt(root, 'coder', 'waited-longest')
  // updatedAt is what the queue sorts on, and patchTask stamps it — so the two
  // cards have to be parked a tick apart for "oldest first" to mean anything.
  await new Promise((resolve) => setTimeout(resolve, 2))
  const second = holdingAt(root, 'coder', 'arrived-later')

  tick(win, root)

  assert.equal(getTask(first)?.status, 'working')
  assert.equal(getTask(second)?.status, 'holding')
  // Holding costs no spot, so the jam at `coder` did not stop `qa` existing —
  // the card behind it is simply at the door (D4).
  assert.equal(getTask(second)?.warn, undefined)

  // A second tick changes nothing while the spot is taken.
  const turns = stubs.turns.length
  tick(win, root)
  assert.equal(stubs.turns.length, turns)
  assert.equal(getTask(second)?.status, 'holding')
})

test('a retired stage works nobody — its cap is zero and its cards stay put', () => {
  // `qa` is gone from the file while a card still sits in it (D13).
  const root = project(['[[stage]]', 'name = "coder"', 'skill = "colony-implement"'].join('\n'))
  const id = holdingAt(root, 'qa', 'draining')
  const turns = stubs.turns.length

  tick(win, root)

  assert.equal(getTask(id)?.status, 'holding')
  assert.equal(stubs.turns.length, turns)
  // It keeps a column all the same, so no task disappears because of an edit.
  const column = boardFor(root).columns.find((c) => c.name === 'qa')
  assert.equal(column?.retired, true)
  assert.equal(column?.cap, 0)
  assert.equal(column?.holding.length, 1)
})

// ---------------------------------------------------------------------------
// Finishing
// ---------------------------------------------------------------------------

test('COLONY: pass moves the card on, with the verdict recorded as one visit', () => {
  const root = project(QA_CLOSED)
  const id = holdingAt(root, 'coder', 'passing')
  tick(win, root)
  const turns = stubs.turns.length
  sent.length = 0

  lastListener()('Did the thing.\n\nCOLONY: pass')

  const after = getTask(id)
  assert.equal(after?.stage, 'qa')
  assert.equal(after?.status, 'holding')
  assert.equal(after?.passes, 1)
  assert.equal(after?.line, 'passed coder')
  assert.equal(after?.warn, undefined)
  assert.equal(after?.visits.at(-1)?.verdict, 'pass')
  assert.equal(after?.visits.at(-1)?.stage, 'coder')
  // `qa` is capped at 0 here, so the card is drawn at ITS door rather than in a
  // "done" pile back in coder — and nothing was dispatched.
  assert.equal(stubs.turns.length, turns)
  assert.deepEqual(sent.at(-1), { channel: 'colony:event', payload: { project: root } })
})

test('passing the last stage settles the card in done', () => {
  const root = project(ONE_STAGE)
  const id = holdingAt(root, 'coder', 'finishing')
  tick(win, root)

  lastListener()('COLONY: pass')

  const after = getTask(id)
  assert.equal(after?.stage, 'done')
  assert.equal(after?.status, 'settled')
  assert.equal(after?.line, 'done')
  assert.equal(after?.passes, 1)
})

test('a turn with no COLONY: line is asked for one, once, in the same session', async () => {
  const root = project(ONE_STAGE)
  const id = holdingAt(root, 'coder', 'asked-once')
  tick(win, root)
  const sessionId = getTask(id)?.sessionId
  const turns = stubs.turns.length

  lastListener()('I got distracted and forgot to say anything.')
  // Not moved on a guess.
  assert.equal(getTask(id)?.stage, 'coder')
  await new Promise((r) => setTimeout(r, 5))

  const nudge = stubs.turns.slice(turns)
  assert.equal(nudge.length, 1)
  assert.equal(nudge[0].key, sessionId)
  assert.match(nudge[0].prompt, /Reply with exactly one line/)

  // The answer to the nudge is the verdict.
  lastListener()('COLONY: stop — the brief contradicts itself')
  assert.equal(getTask(id)?.stage, 'inbox')
  assert.equal(getTask(id)?.visits.at(-1)?.verdict, 'stop')
})

test('still no line after asking is a pass with a warning, and a card like that is not merged on its own', async () => {
  const root = project(ONE_STAGE)
  const id = holdingAt(root, 'coder', 'no-line')
  tick(win, root)
  const merges = stubs.merges.length

  lastListener()('I got distracted and forgot to say anything.')
  await new Promise((r) => setTimeout(r, 5))
  lastListener()('Still nothing.')
  await settle()

  const after = getTask(id)
  assert.equal(after?.stage, 'done')
  assert.equal(after?.passes, 1)
  assert.equal(after?.visits.at(-1)?.verdict, 'none')
  assert.match(after?.warn ?? '', /coder never gave a verdict — not merged automatically/)
  assert.equal(stubs.merges.length, merges, 'automerge is on, and still nothing merged')
  assert.equal(after?.mergedAt, undefined)
})

test('COLONY: stop parks the card back in the backlog with the reason on it', () => {
  const root = project()
  const id = holdingAt(root, 'coder', 'stopping')
  tick(win, root)

  lastListener()('COLONY: stop — the spec contradicts itself')

  const after = getTask(id)
  assert.equal(after?.stage, 'inbox')
  assert.equal(after?.status, 'holding')
  assert.equal(after?.line, 'the spec contradicts itself')
  assert.equal(after?.passes, 0)
  assert.deepEqual(after?.visits.at(-1), {
    at: after?.visits.at(-1)?.at ?? 0,
    stage: 'coder',
    // The visit carries the session that step ran in — with one session per
    // step, that pointer is the only way back to the transcript behind the stop.
    sessionId: after?.sessionId,
    verdict: 'stop',
    why: 'the spec contradicts itself'
  })
})

test('COLONY: return sends the card back as a second visit, not a fresh arrival', () => {
  const root = project(CODER_CLOSED)
  const id = holdingAt(root, 'qa', 'returning')
  tick(win, root)

  lastListener()('COLONY: return coder — the tests fail')

  const back = getTask(id)
  assert.equal(back?.stage, 'coder')
  assert.equal(back?.status, 'holding')
  assert.equal(back?.line, 'returned from qa: the tests fail')
  // The pass count is what the card prints, and it did not pass (D23).
  assert.equal(back?.passes, 0)
  assert.deepEqual(
    { verdict: back?.visits.at(-1)?.verdict, stage: back?.visits.at(-1)?.stage, why: back?.visits.at(-1)?.why },
    { verdict: 'return', stage: 'qa', why: 'the tests fail' }
  )
})

test('a return to a lane nobody has parks the card as a question instead of losing it', () => {
  const root = project()
  const id = holdingAt(root, 'qa', 'unknown-lane')
  tick(win, root)

  lastListener()('COLONY: return nowhere — over to you')

  const parked = getTask(id)
  assert.equal(parked?.stage, 'qa')
  assert.equal(parked?.status, 'blocked')
  assert.equal(parked?.line, 'returned to an unknown lane "nowhere"')
})

test('a verdict about where the card used to be loses to where the board has since put it', () => {
  const root = project()
  const id = holdingAt(root, 'coder', 'moved-away')
  tick(win, root)
  const done = lastListener()

  // Answered, archived or dragged while the lane ran.
  patchTask(id, { stage: 'qa', status: 'holding' })
  const visits = getTask(id)?.visits.length ?? 0

  done('COLONY: pass')

  const after = getTask(id)
  assert.equal(after?.stage, 'qa')
  assert.equal(after?.status, 'holding')
  assert.equal(after?.visits.length, visits)
})

// ---------------------------------------------------------------------------
// Coming back from a quit
// ---------------------------------------------------------------------------

test('a quit un-sticks the tasks that were working, and leaves a live turn alone', () => {
  const root = project()
  const orphaned = holdingAt(root, 'coder', 'orphaned')
  const alive = holdingAt(root, 'qa', 'alive')
  const liveSession = 'sess-alive'
  addCreatedSession({ id: liveSession, worktreePath: tree('alive') })
  patchTask(orphaned, { status: 'working', line: 'coder: starting' })
  patchTask(alive, { status: 'working', sessionId: liveSession })
  stubs.active.add(liveSession)
  sent.length = 0

  reconcileColony(win)

  // Back to holding in the SAME stage: a lane that did not report has not passed.
  const after = getTask(orphaned)
  assert.equal(after?.stage, 'coder')
  assert.equal(after?.status, 'working', 'the tick that follows re-admits it')
  assert.equal(getTask(alive)?.status, 'working')
  assert.equal(getTask(alive)?.line, undefined, 'the live one was never touched')
  assert.ok(sent.some((e) => e.channel === 'colony:event'))
  stubs.active.delete(liveSession)
})

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

test('blocked is derived from the live session, under whichever key is actually live', () => {
  const root = project()
  const first = holdingAt(root, 'coder', 'asking')
  const second = holdingAt(root, 'qa', 'asking-on-a-past-id')
  const third = holdingAt(root, 'qa', 'asking-with-no-session')

  // 1. A session with no live connection at all: connKeyFor falls back to the
  //    stored claudeId, and that is where the waiting flag is read.
  const plain = 'sess-plain'
  addCreatedSession({ id: plain, worktreePath: tree('asking') })
  linkCreatedSession(plain, 'claude-plain')
  stubs.runtime.set('claude-plain', { live: false, running: false, waiting: true, since: 0, lastLine: '' })
  patchTask(first, { sessionId: plain, status: 'working' })

  // 2. A session that forked ids: the live connection still sits under the id
  //    the panel was opened with, so the key has to come off the trail.
  const forked = 'sess-forked'
  addCreatedSession({ id: forked, worktreePath: tree('forked') })
  linkCreatedSession(forked, 'claude-old')
  linkCreatedSession(forked, 'claude-new')
  stubs.runtime.set('claude-old', { live: true, running: false, waiting: true, since: 0, lastLine: '' })
  patchTask(second, { sessionId: forked, status: 'working' })

  // 3. A session the store has never heard of — the id itself is the key.
  stubs.runtime.set('ghost', { live: false, running: false, waiting: false, since: 0, lastLine: '' })
  patchTask(third, { sessionId: 'ghost', status: 'working' })

  const board = boardFor(root)
  const coder = board.columns.find((c) => c.name === 'coder')
  const qa = board.columns.find((c) => c.name === 'qa')

  assert.deepEqual(coder?.blocked.map((t) => t.id), [first])
  assert.deepEqual(coder?.working.map((t) => t.id), [])
  assert.deepEqual(qa?.blocked.map((t) => t.id), [second])
  // Not waiting is plain `working`, and a working task is never in two bands.
  assert.deepEqual(qa?.working.map((t) => t.id), [third])

  // The two fixed ends bracket the stages and carry no cap or skill.
  assert.deepEqual(board.columns.map((c) => c.name), ['inbox', 'coder', 'qa', 'done'])
  assert.equal(board.columns[0].cap, undefined)
  assert.equal(board.columns[0].skill, '')
  assert.equal(coder?.skill, 'colony-implement')
  assert.equal(coder?.cap, 1)
})

test('the nanny is one session per project, in the project root, minted once', () => {
  const root = project()
  const first = nannyFor(root)
  assert.equal(first.fresh, true)
  assert.equal(first.worktreePath, root)

  const again = nannyFor(root)
  assert.equal(again.fresh, false)
  assert.equal(again.sessionId, first.sessionId)
  // She is the board's session, not a task's — no card ever points at her.
  assert.equal(listTasks(root).some((t) => t.sessionId === first.sessionId), false)
})

// ---------------------------------------------------------------------------
// Dependencies, merging and the manager
// ---------------------------------------------------------------------------

/** Run the microtasks a floated `settleDone` / `sweepReleases` leaves behind. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

test('a card with an unmet dependency stays in the backlog instead of cutting a tree', async () => {
  const root = project(ONE_STAGE)
  const first = addTask({ project: root, name: 'first', brief: 'the base change' })
  const second = addTask({ project: root, name: 'second', brief: 'builds on it', dependsOn: [first.id] })
  const before = stubs.created.length

  const held = await releaseTask(win, second.id)

  // The whole point: no second worktree exists, so it cannot be built on a base
  // that is missing the first change.
  assert.equal(stubs.created.length, before)
  assert.equal(held.stage, 'inbox')
  assert.equal(held.worktreePath, undefined)
  // And it remembers that somebody asked, which is what the sweep acts on.
  assert.equal(held.queued, true)
  assert.match(held.line ?? '', /waiting on first/)
})

test('an unknown dependency id is dropped, not waited for forever', () => {
  const root = project(ONE_STAGE)
  const task = addTask({ project: root, name: 'orphan', brief: 'x', dependsOn: ['task_gone'] })
  assert.deepEqual(unmetDeps(task), [])
})

test('merging a dependency releases what was queued behind it', async () => {
  const root = project(ONE_STAGE)
  stubs.worktreeFor = (_root, branch) => [{ path: tree(branch.replace(/\//g, '-')), branch }]
  const first = addTask({ project: root, name: 'base', brief: 'the base change' })
  const second = addTask({ project: root, name: 'ontop', brief: 'builds on it', dependsOn: [first.id] })
  await releaseTask(win, first.id)
  await releaseTask(win, second.id)
  assert.equal(getTask(second.id)?.stage, 'inbox')

  // Take `base` all the way through the one stage it has.
  lastListener()('COLONY: pass')
  await settle()

  assert.equal(getTask(first.id)?.stage, 'done')
  assert.ok(getTask(first.id)?.mergedAt, 'reaching done should have merged it')
  assert.equal(getTask(first.id)?.line, 'merged')
  // Which is the only thing that could release the card behind it.
  const behind = getTask(second.id)
  assert.equal(behind?.stage, 'coder')
  assert.equal(behind?.queued, undefined)
  assert.ok(behind?.worktreePath, 'the dependent card should have a tree now')
})

test('a refused merge puts the reason on the card and leaves the branch alone', async () => {
  const root = project(ONE_STAGE)
  stubs.worktreeFor = (_root, branch) => [{ path: tree('refused'), branch }]
  stubs.mergeResult = () => ({ ok: false, message: '"feat/refused" has uncommitted changes' })
  const task = addTask({ project: root, name: 'refused', brief: 'x' })
  await releaseTask(win, task.id)
  lastListener()('COLONY: pass')
  await settle()
  stubs.mergeResult = () => CLEAN_MERGE

  const after = getTask(task.id)
  // Still finished, still not merged — and the card says why, rather than the
  // failure living only in a log nobody opens.
  assert.equal(after?.stage, 'done')
  assert.equal(after?.mergedAt, undefined)
  assert.equal(after?.line, 'not merged')
  assert.match(after?.warn ?? '', /uncommitted changes/)
})

test('automerge = false leaves a finished card for a human to land', async () => {
  // Before the `[[stage]]` header: a bare key after a table header belongs to
  // that table, not to the root.
  const root = project(['automerge = false', '', ONE_STAGE].join('\n'))
  stubs.worktreeFor = (_root, branch) => [{ path: tree('manual'), branch }]
  const task = addTask({ project: root, name: 'manual', brief: 'x' })
  await releaseTask(win, task.id)
  const before = stubs.merges.length
  lastListener()('COLONY: pass')
  await settle()

  assert.equal(stubs.merges.length, before, 'nothing should have been merged')
  assert.equal(getTask(task.id)?.stage, 'done')
  assert.equal(getTask(task.id)?.mergedAt, undefined)

  // And the explicit call still works, from `done` and only once.
  assert.equal((await mergeTask(win, task.id)).ok, true)
  assert.ok(getTask(task.id)?.mergedAt)
  const again = await mergeTask(win, task.id)
  assert.equal(stubs.merges.length, before + 1, 'the second call should not re-merge')
  assert.match(again.message ?? '', /already merged/)
})

test('a card that has not reached done cannot be merged', async () => {
  const root = project(TWO_STAGES)
  const id = holdingAt(root, 'coder', 'midway')
  const result = await mergeTask(win, id)
  assert.equal(result.ok, false)
  assert.match(result.message ?? '', /still in coder/)
})

test('overlapping tasks are grouped by the tasks that share the files', async () => {
  const root = project(TWO_STAGES)
  const a = holdingAt(root, 'coder', 'alpha')
  const b = holdingAt(root, 'coder', 'beta')
  const c = holdingAt(root, 'coder', 'gamma')
  const pathOf = (id: string): string => getTask(id)?.worktreePath as string
  stubs.changed.set(pathOf(a), ['src/turn.ts', 'src/agent.ts', 'README.md'])
  stubs.changed.set(pathOf(b), ['src/turn.ts', 'src/agent.ts'])
  stubs.changed.set(pathOf(c), ['docs/only-mine.md'])

  const overlaps = await overlappingTasks(root)

  // One finding for the pair, not one per shared file.
  assert.equal(overlaps.length, 1)
  assert.deepEqual(overlaps[0].files, ['src/agent.ts', 'src/turn.ts'])
  assert.deepEqual(overlaps[0].tasks.map((t) => t.name).sort(), ['alpha', 'beta'])
  // gamma shares nothing, so it is not in the answer at all.
  assert.ok(!overlaps.some((o) => o.tasks.some((t) => t.name === 'gamma')))
})

test('a merged task is no longer a conflict to worry about', async () => {
  const root = project(TWO_STAGES)
  const a = holdingAt(root, 'coder', 'landed')
  const b = holdingAt(root, 'coder', 'inflight')
  const pathOf = (id: string): string => getTask(id)?.worktreePath as string
  stubs.changed.set(pathOf(a), ['src/shared.ts'])
  stubs.changed.set(pathOf(b), ['src/shared.ts'])
  assert.equal((await overlappingTasks(root)).length, 1)

  patchTask(a, { mergedAt: Date.now() })
  assert.deepEqual(await overlappingTasks(root), [])
})

test('a card reaching done wakes the nanny, once, with every note', async () => {
  const root = project(ONE_STAGE)
  stubs.worktreeFor = (_root, branch) => [{ path: tree(branch.replace(/\//g, '-')), branch }]
  const nanny = nannyFor(root)
  const first = addTask({ project: root, name: 'one', brief: 'x' })
  const second = addTask({ project: root, name: 'two', brief: 'y' })
  await releaseTask(win, first.id)
  const firstListener = stubs.listeners[stubs.listeners.length - 1].cb
  await releaseTask(win, second.id)
  const secondListener = stubs.listeners[stubs.listeners.length - 1].cb

  const before = stubs.turns.length
  firstListener('COLONY: pass')
  secondListener('COLONY: pass')
  await settle()
  // Buffered behind the debounce until it fires.
  assert.equal(stubs.turns.length, before)
  await new Promise((r) => setTimeout(r, 400))

  const woken = stubs.turns.slice(before)
  // ONE turn for both cards, not one each — five lanes finishing together is one
  // thing to tell her about.
  assert.equal(woken.length, 1)
  assert.equal(woken[0].key, nanny.sessionId)
  assert.equal(woken[0].worktreePath, root)
  assert.match(woken[0].prompt, /^BOARD EVENT/)
  assert.match(woken[0].prompt, /"one" reached done and merged cleanly/)
  assert.match(woken[0].prompt, /"two" reached done and merged cleanly/)
  // Her own permissions, not a lane's — she merges into the user's base branch.
  assert.equal(woken[0].options.permissionMode, 'default')
})

test('a nanny mid-turn is not interrupted; the note waits for her turn to end', async () => {
  const root = project(ONE_STAGE)
  stubs.worktreeFor = (_root, branch) => [{ path: tree('busy-nanny'), branch }]
  const nanny = nannyFor(root)
  stubs.active.add(nanny.sessionId)
  const task = addTask({ project: root, name: 'quiet', brief: 'x' })
  await releaseTask(win, task.id)

  const before = stubs.turns.length
  lastListener()('COLONY: pass')
  await settle()
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(stubs.turns.length, before, 'she was talking to the user')

  // Her turn ends: the note it was holding goes out now.
  stubs.active.delete(nanny.sessionId)
  const parked = stubs.listeners.filter((l) => l.key === nanny.sessionId).at(-1)
  assert.ok(parked, 'the flush should have parked itself on her turn')
  parked.cb('')
  assert.equal(stubs.turns.length, before + 1)
  assert.match(stubs.turns.at(-1)?.prompt ?? '', /"quiet" reached done and merged cleanly/)
})

test('a board with no nanny yet is not given one behind the user\'s back', async () => {
  const root = project(ONE_STAGE)
  stubs.worktreeFor = (_root, branch) => [{ path: tree('no-nanny'), branch }]
  const task = addTask({ project: root, name: 'alone', brief: 'x' })
  await releaseTask(win, task.id)

  const before = stubs.turns.length
  lastListener()('COLONY: pass')
  await settle()
  await new Promise((r) => setTimeout(r, 400))

  // The card still merged — the manager is who gets told, not what does the work.
  assert.ok(getTask(task.id)?.mergedAt)
  assert.equal(stubs.turns.length, before, 'no session should have been opened to talk to')
})

// ---------------------------------------------------------------------------
// The board log: what happened, as distinct from what the nanny said about it
// ---------------------------------------------------------------------------

test('a merge the board made on its own is written down, with the commits an undo needs', async () => {
  const root = project(ONE_STAGE)
  stubs.worktreeFor = (_root, branch) => [{ path: tree('logged'), branch }]
  const task = addTask({ project: root, name: 'logged', brief: 'x' })
  await releaseTask(win, task.id)
  lastListener()('COLONY: pass')
  await settle()

  const kinds = listEvents(root).map((e) => e.kind)
  // Reaching the end and landing on base are two facts, not one: a board with
  // automerge off produces the first and not the second.
  assert.deepEqual(kinds, ['passed', 'merged'])

  const merged = listEvents(root).find((e) => e.kind === 'merged')
  assert.equal(merged?.taskName, 'logged')
  // Without these the row can print itself but cannot offer the way back out.
  assert.equal(merged?.base, 'main')
  assert.equal(merged?.baseBefore, 'aaa1111')
  assert.equal(merged?.baseAfter, 'bbb2222')
})

test('a refused merge is written down too — silence would be the whole bug', async () => {
  const root = project(ONE_STAGE)
  stubs.worktreeFor = (_root, branch) => [{ path: tree('refused-log'), branch }]
  stubs.mergeResult = () => ({ ok: false, message: 'has uncommitted changes' })
  const task = addTask({ project: root, name: 'refused-log', brief: 'x' })
  await releaseTask(win, task.id)
  lastListener()('COLONY: pass')
  await settle()
  stubs.mergeResult = () => CLEAN_MERGE

  const refused = listEvents(root).find((e) => e.kind === 'refused')
  assert.ok(refused, 'a merge that did not happen is still something that happened')
  assert.match(refused.text, /uncommitted changes/)
})

test('only the sweep writes a released event — a card you released yourself is not news', async () => {
  const root = project(ONE_STAGE)
  stubs.worktreeFor = (_root, branch) => [{ path: tree(branch.replace(/\//g, '-')), branch }]
  const first = addTask({ project: root, name: 'base-log', brief: 'x' })
  const second = addTask({ project: root, name: 'ontop-log', brief: 'y', dependsOn: [first.id] })

  await releaseTask(win, first.id)
  // Released by hand, so nothing is logged: you were there.
  assert.equal(listEvents(root).filter((e) => e.kind === 'released').length, 0)

  await releaseTask(win, second.id)
  assert.equal(listEvents(root).filter((e) => e.kind === 'released').length, 0)

  lastListener()('COLONY: pass')
  await settle()

  const released = listEvents(root).filter((e) => e.kind === 'released')
  assert.equal(released.length, 1)
  assert.equal(released[0].taskName, 'ontop-log')
})

test('a lane that stops, and one that returns to nowhere, both leave a record', async () => {
  const root = project(ONE_STAGE)
  stubs.worktreeFor = (_root, branch) => [{ path: tree('stopper'), branch }]
  const stopped = addTask({ project: root, name: 'stopper', brief: 'x' })
  await releaseTask(win, stopped.id)
  lastListener()('COLONY: stop — the API this needs does not exist yet')
  await settle()

  const lost = addTask({ project: root, name: 'loser', brief: 'y' })
  stubs.worktreeFor = (_root, branch) => [{ path: tree('loser'), branch }]
  await releaseTask(win, lost.id)
  lastListener()('COLONY: return designer — needs a mock first')
  await settle()

  const kinds = listEvents(root).map((e) => e.kind)
  assert.ok(kinds.includes('stopped'), 'a stop is a decision the board cannot make')
  assert.ok(kinds.includes('lost'), 'a card handed to a stage nobody has is stuck')
  assert.match(listEvents(root).find((e) => e.kind === 'stopped')?.text ?? '', /does not exist yet/)
  assert.match(listEvents(root).find((e) => e.kind === 'lost')?.text ?? '', /"designer"/)
})

test('undoing a merge puts the card back to unmerged and marks the row', async () => {
  const root = project(ONE_STAGE)
  stubs.worktreeFor = (_root, branch) => [{ path: tree('undoable'), branch }]
  const task = addTask({ project: root, name: 'undoable', brief: 'x' })
  await releaseTask(win, task.id)
  lastListener()('COLONY: pass')
  await settle()

  const merged = listEvents(root).find((e) => e.kind === 'merged')
  assert.ok(merged)
  assert.ok(getTask(task.id)?.mergedAt)

  const before = stubs.undos.length
  const result = await undoTaskMerge(win, merged.id)
  assert.equal(result.ok, true)
  // It asks git to move base from where the merge left it back to where it was.
  assert.deepEqual(stubs.undos.slice(before), [
    { root, base: 'main', expected: 'bbb2222', to: 'aaa1111' }
  ])

  // The card is finished and NOT on base — which is the truthful state, not a
  // rewind: the branch and its worktree were never touched.
  const after = getTask(task.id)
  assert.equal(after?.stage, 'done')
  assert.equal(after?.mergedAt, undefined)
  assert.equal(after?.line, 'merge undone')
  // And the row says so, instead of offering the same undo a second time.
  assert.ok(listEvents(root).find((e) => e.id === merged.id)?.undoneAt)
})

test('an undo git refuses changes nothing, and can be tried again', async () => {
  const root = project(ONE_STAGE)
  stubs.worktreeFor = (_root, branch) => [{ path: tree('moved-on'), branch }]
  const task = addTask({ project: root, name: 'moved-on', brief: 'x' })
  await releaseTask(win, task.id)
  lastListener()('COLONY: pass')
  await settle()
  const merged = listEvents(root).find((e) => e.kind === 'merged')
  assert.ok(merged)

  stubs.undoResult = () => ({ ok: false, message: '"main" has moved on since that merge' })
  const refused = await undoTaskMerge(win, merged.id)
  stubs.undoResult = () => ({ ok: true, message: 'put back' })

  assert.equal(refused.ok, false)
  assert.match(refused.message ?? '', /moved on/)
  // Nothing was recorded and nothing was patched: a refusal that half-applied
  // would be worse than no undo at all.
  assert.ok(getTask(task.id)?.mergedAt, 'the card is still merged')
  assert.equal(listEvents(root).find((e) => e.id === merged.id)?.undoneAt, undefined)

  // Once whatever blocked it is cleared, the same row still works.
  assert.equal((await undoTaskMerge(win, merged.id)).ok, true)
  const twice = await undoTaskMerge(win, merged.id)
  assert.equal(twice.ok, false)
  assert.match(twice.message ?? '', /already been put back/)
})

test('holding a released card parks it in the backlog and keeps its worktree', async () => {
  const root = project(ONE_STAGE)
  stubs.worktreeFor = (_root, branch) => [{ path: tree('parkable'), branch }]
  const task = addTask({ project: root, name: 'parkable', brief: 'x' })
  await releaseTask(win, task.id)
  const tree1 = getTask(task.id)?.worktreePath
  assert.ok(tree1)

  const held = holdTask(win, task.id)

  assert.equal(held?.stage, 'inbox')
  assert.equal(held?.status, 'holding')
  // A park, not an undo: cutting the tree was the expensive part and a lane has
  // already run in it.
  assert.equal(held?.worktreePath, tree1)
  assert.match(held?.line ?? '', /release it when you want it/)

  // And releasing it again starts it from the same door, without cutting twice.
  const cuts = stubs.created.length
  await releaseTask(win, task.id)
  assert.equal(stubs.created.length, cuts, 'the worktree was reused')
  assert.equal(getTask(task.id)?.stage, 'coder')
})

test('a merged card cannot be parked — the board is done with it', async () => {
  const root = project(ONE_STAGE)
  stubs.worktreeFor = (_root, branch) => [{ path: tree('landed-park'), branch }]
  const task = addTask({ project: root, name: 'landed-park', brief: 'x' })
  await releaseTask(win, task.id)
  lastListener()('COLONY: pass')
  await settle()
  assert.ok(getTask(task.id)?.mergedAt)

  const held = holdTask(win, task.id)
  assert.equal(held?.stage, 'done', 'it stayed where it was')
  assert.ok(held?.mergedAt)
})

test('the board reports its own automerge policy, and where the file is', () => {
  const on = project(ONE_STAGE)
  assert.equal(boardFor(on).automerge, true, 'the built-in default')
  assert.match(boardFor(on).configPath ?? '', /colony\.toml$/)

  const off = project(['automerge = false', '', ONE_STAGE].join('\n'))
  assert.equal(boardFor(off).automerge, false)
})

test('the automerge switch writes above the first [[stage]], where a bare key belongs', () => {
  const root = project(TWO_STAGES)
  assert.equal(boardFor(root).automerge, true)

  const file = setProjectAutomerge(root, false)
  const raw = readFileSync(file, 'utf8')

  // THE RULE: TOML scopes a bare key to the table above it. Written after a
  // `[[stage]]` header this would silently become `stage.automerge` — a value
  // nothing reads, on a board that carries on merging.
  assert.ok(raw.indexOf('automerge') < raw.indexOf('[[stage]]'), 'the key must precede the first table')
  assert.equal(boardFor(root).automerge, false, 'and the board reads it back')

  // The stages it was written around are untouched.
  assert.deepEqual(
    boardFor(root).columns.map((c) => c.name),
    ['inbox', 'coder', 'qa', 'done']
  )
})

test('flipping it twice rewrites the same line rather than stacking keys', () => {
  const root = project(TWO_STAGES)
  const file = setProjectAutomerge(root, false)
  setProjectAutomerge(root, true)
  setProjectAutomerge(root, false)
  const raw = readFileSync(file, 'utf8')
  assert.equal(raw.match(/^automerge\s*=/gm)?.length, 1, 'one key, not three')
  assert.equal(boardFor(root).automerge, false)
})

test('an automerge inside a [[stage]] is left alone — it is a different key', () => {
  // A stage may legitimately carry its own keys; rewriting one because it shares
  // a name with a root setting would move a stage's config to the board.
  const root = project(['[[stage]]', 'name = "coder"', 'skill = "colony-implement"', 'automerge = true'].join('\n'))
  const file = setProjectAutomerge(root, false)
  const raw = readFileSync(file, 'utf8')
  const lines = raw.split('\n')
  assert.match(lines[0], /^automerge = false$/, 'the root key was inserted at the top')
  // The one under the stage header is still there, untouched.
  assert.equal(lines.filter((l) => /^automerge\s*=/.test(l)).length, 2)
  assert.equal(boardFor(root).automerge, false)
})

test('the switch refuses a project Floe does not track — there is nowhere to write', () => {
  assert.throws(() => setProjectAutomerge(join(home, 'not-a-project'), false), /not tracked/)
})

// ---------------------------------------------------------------------------
// Feature boards: base, artifacts, provisioning dirt, cleanup, outside merges
// ---------------------------------------------------------------------------

/** Long enough for every floating git step in a merge-and-cleanup chain. */
const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

test('a task cut from a feature branch is cut from it, remembers it, and tells its lanes', async () => {
  const root = project(ONE_STAGE)
  const worktree = tree('on-parent')
  stubs.worktreeFor = (_root, branch) => [{ path: worktree, branch }]
  const task = addTask({ project: root, name: 'on-parent', brief: 'x', base: 'feat/parent' })

  await releaseTask(win, task.id)
  assert.equal(stubs.createOptions.at(-1)?.base, 'feat/parent')
  assert.equal(getTask(task.id)?.base, 'feat/parent')
  assert.match(stubs.turns.at(-1)?.prompt ?? '', /^Base: feat\/parent$/m)

  // Unset, the base the tree was really cut from is read back and kept.
  const plainTree = tree('plain-base')
  stubs.worktreeFor = (_root, branch) => [{ path: plainTree, branch }]
  stubs.bases.set(plainTree, 'main')
  const plain = addTask({ project: root, name: 'plain-base', brief: 'x' })
  await releaseTask(win, plain.id)
  assert.equal(stubs.createOptions.at(-1)?.base, undefined)
  assert.equal(getTask(plain.id)?.base, 'main')
})

test('an autonomous task says so in every lane prompt; an ordinary one does not', async () => {
  const root = project(TWO_STAGES)
  const loud = holdingAt(root, 'coder', 'ordinary')
  tick(win, root)
  assert.equal(getTask(loud)?.status, 'working')
  assert.doesNotMatch(stubs.turns.at(-1)?.prompt ?? '', /AUTONOMOUS BOARD/)

  const quietRoot = project(`autonomous = true\n${TWO_STAGES}`)
  const quiet = holdingAt(quietRoot, 'coder', 'quiet')
  tick(win, quietRoot)
  assert.equal(getTask(quiet)?.status, 'working')
  assert.ok((stubs.turns.at(-1)?.prompt ?? '').includes(AUTONOMOUS_BOARD))

  // A task's own flag wins over the board's.
  const overridden = addTask({ project: quietRoot, name: 'asks', brief: 'x', autonomous: false })
  patchTask(overridden.id, { stage: 'qa', status: 'holding', worktreePath: tree('asks'), branch: 'feat/asks' })
  tick(win, quietRoot)
  assert.equal(getTask(overridden.id)?.status, 'working')
  assert.doesNotMatch(stubs.turns.at(-1)?.prompt ?? '', /AUTONOMOUS BOARD/)
})

test('a lane’s documents are committed before the next lane is dispatched', async () => {
  const root = project()
  const id = holdingAt(root, 'coder', 'files-docs')
  tick(win, root)
  const turns = stubs.turns.length
  const commits = stubs.commits.length

  lastListener()('COLONY: pass')
  await settle()

  const commit = stubs.commits.slice(commits)[0]
  assert.ok(commit, 'the lane artifacts were committed')
  assert.deepEqual(commit.paths, ['specs/feat-files-docs'])
  assert.match(commit.message, /coder artifacts for files-docs/)
  assert.equal(commit.turnsBefore, turns, 'committed before qa started')
  assert.equal(stubs.turns.length, turns + 1, 'and qa started after')
  assert.equal(getTask(id)?.stage, 'qa')
})

test('what provisioning dirtied is recorded, and put back before the merge', async () => {
  const root = project(ONE_STAGE)
  const worktree = tree('dirty-provision')
  stubs.worktreeFor = (_root, branch) => [{ path: worktree, branch }]
  stubs.dirt = { 'CLAUDE.md': 'abc123' }
  const task = addTask({ project: root, name: 'dirty-provision', brief: 'x' })
  await releaseTask(win, task.id)
  await drain()
  assert.deepEqual(getTask(task.id)?.provisionDirt, { 'CLAUDE.md': 'abc123' })
  stubs.dirt = {}

  const restores = stubs.restores.length
  lastListener()('COLONY: pass')
  await drain()
  assert.deepEqual(stubs.restores.slice(restores), [{ worktree, snapshot: { 'CLAUDE.md': 'abc123' } }])
  assert.ok(getTask(task.id)?.mergedAt)
})

test('cleanup after a merge removes the tree, deletes the branch and takes the card off the board', async () => {
  const root = project(`cleanup = true\n\n${ONE_STAGE}`)
  const worktree = tree('cleaned')
  stubs.worktreeFor = (_root, branch) => [{ path: worktree, branch }]
  const task = addTask({ project: root, name: 'cleaned', brief: 'x', base: 'feat/parent' })
  const behind = addTask({ project: root, name: 'after-cleaned', brief: 'y', dependsOn: [task.id] })
  await releaseTask(win, task.id)
  await releaseTask(win, behind.id)

  lastListener()('COLONY: pass')
  await drain()

  const after = getTask(task.id)
  assert.ok(after?.mergedAt)
  assert.ok(after?.archivedAt, 'archived, not deleted — dependents and the log point at it')
  assert.equal(after?.worktreePath, undefined)
  assert.deepEqual(stubs.teardowns.at(-1), { root, target: worktree })
  assert.equal(stubs.deletedBranches.at(-1), 'feat/cleaned')
  assert.ok(listEvents(root).some((e) => e.kind === 'cleaned' && e.task === task.id))
  const onBoard = boardFor(root).columns.flatMap((c) => [...c.settled, ...c.holding, ...c.working, ...c.blocked])
  assert.equal(onBoard.some((t) => t.id === task.id), false)
  // The dependent was still released.
  assert.equal(getTask(behind.id)?.stage, 'coder')

  // Undo puts the deleted branch back where the merge left it.
  const merged = listEvents(root).find((e) => e.kind === 'merged' && e.task === task.id)
  assert.ok(merged)
  const undone = await undoTaskMerge(win, merged.id)
  assert.equal(undone.ok, true)
  assert.deepEqual(stubs.restoredBranches.at(-1), { branch: 'feat/cleaned', sha: 'bbb2222' })
  assert.equal(getTask(task.id)?.archivedAt, undefined)
  assert.match(getTask(task.id)?.line ?? '', /branch restored/)
})

test('cleanup refuses, with the reason on the card, when the branch or tree holds work base lacks', async () => {
  const root = project(ONE_STAGE)
  const worktree = tree('kept')
  stubs.worktreeFor = (_root, branch) => [{ path: worktree, branch }]
  const task = addTask({ project: root, name: 'kept', brief: 'x', cleanup: true })
  await releaseTask(win, task.id)
  const teardowns = stubs.teardowns.length

  stubs.mergedInto = () => false
  try {
    lastListener()('COLONY: pass')
    await drain()
  } finally {
    stubs.mergedInto = () => true
  }
  const after = getTask(task.id)
  assert.ok(after?.mergedAt)
  assert.equal(after?.archivedAt, undefined)
  assert.match(after?.warn ?? '', /not cleaned up: feat\/kept has commits that are not on main/)
  assert.equal(stubs.teardowns.length, teardowns)

  stubs.uncommitted.set(worktree, ['notes.txt'])
  try {
    const { cleanupTask } = await import('./runner.ts')
    assert.equal(await cleanupTask(win, task.id), false)
    assert.match(getTask(task.id)?.warn ?? '', /uncommitted changes in its worktree \(notes\.txt\)/)
  } finally {
    stubs.uncommitted.delete(worktree)
  }
})

test('a finished card merged outside the board counts as merged, and releases what waits on it', async () => {
  const root = project(ONE_STAGE)
  stubs.worktreeFor = (_root, branch) => [{ path: tree(branch.replace(/\//g, '-')), branch }]
  const first = addTask({ project: root, name: 'by-hand', brief: 'x' })
  const second = addTask({ project: root, name: 'waits-by-hand', brief: 'y', dependsOn: [first.id] })
  patchTask(first.id, { stage: 'done', status: 'settled', branch: 'feat/by-hand', worktreePath: tree('by-hand') })
  // Still in a lane: its branch is an ancestor of base only because it has no commits yet.
  const midway = addTask({ project: root, name: 'midway', brief: 'z' })
  patchTask(midway.id, { stage: 'coder', status: 'holding', branch: 'feat/midway', worktreePath: tree('midway') })
  await releaseTask(win, second.id)
  assert.equal(getTask(second.id)?.stage, 'inbox')

  const merged = await reconcileMerged(win, root)
  assert.deepEqual(merged.map((t) => t.id), [first.id])
  assert.ok(getTask(first.id)?.mergedAt)
  assert.equal(getTask(midway.id)?.mergedAt, undefined)
  assert.equal(getTask(second.id)?.stage, 'coder')
  const event = listEvents(root).find((e) => e.kind === 'merged' && e.task === first.id)
  assert.match(event?.text ?? '', /merged outside the board/)
  assert.equal(event?.baseBefore, undefined, 'no commits to undo with')
})

test('the compact board carries where each card is and its last verdicts, never the brief', async () => {
  const root = project()
  const id = holdingAt(root, 'coder', 'compact')
  patchTask(id, {
    base: 'feat/parent',
    visits: [
      { at: 1, stage: 'specifier', verdict: 'pass' },
      { at: 2, stage: 'coder', verdict: 'pass' },
      { at: 3, stage: 'qa', verdict: 'return', why: 'x' },
      { at: 4, stage: 'coder', verdict: 'none' }
    ]
  })
  const gone = addTask({ project: root, name: 'archived', brief: 'long brief' })
  patchTask(gone.id, { stage: 'done', status: 'settled', archivedAt: Date.now() })

  const board = compactBoard(root)
  const card = board.columns.flatMap((c) => c.tasks).find((t) => t.id === id)
  assert.ok(card)
  assert.equal(card.base, 'feat/parent')
  assert.equal(card.status, 'holding')
  assert.equal('brief' in card, false)
  assert.deepEqual(card.lastVerdicts, [
    { stage: 'coder', verdict: 'pass' },
    { stage: 'qa', verdict: 'return' },
    { stage: 'coder', verdict: 'none' }
  ])
  assert.equal(board.columns.flatMap((c) => c.tasks).some((t) => t.id === gone.id), false)
})
