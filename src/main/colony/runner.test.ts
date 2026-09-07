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
}

const stubs: Stubs = {
  runtime: new Map(),
  active: new Set(),
  listeners: [],
  turns: [],
  startTurnError: null,
  created: [],
  provisioned: [],
  worktreeFor: (_root, branch) => [{ path: '/nowhere', branch }]
}
;(globalThis as unknown as { __colonyStubs: Stubs }).__colonyStubs = stubs

// The same extensionless-import + `electron` hook the other main tests use, plus
// four stub modules served ONLY to runner.ts — matching on the parent keeps the
// real modules real for everyone else in the graph.
const hookSource = `
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
const STUBS = { '../agent': 'stub:agent', '../turn': 'stub:turn', '../git': 'stub:git', '../provision': 'stub:provision' }
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
    'export async function createWorktree(root, branch) {',
    '  const s = globalThis.__colonyStubs',
    '  s.created.push({ root, branch })',
    '  return s.worktreeFor(root, branch)',
    '}'
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
const { addCreatedSession, getAllCreatedSessions, linkCreatedSession } = await import(
  '../sessionStore.ts'
)
const { boardFor, nannyFor, reconcileColony, releaseTask, taskDirFor, tick } = await import(
  './runner.ts'
)

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
  // One session per TASK, opened in the task's tree.
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

test('a turn that ends with no COLONY: line is a pass with a warning, as the contract promises', () => {
  const root = project(ONE_STAGE)
  const id = holdingAt(root, 'coder', 'no-line')
  tick(win, root)

  lastListener()('I got distracted and forgot to say anything.')

  const after = getTask(id)
  assert.equal(after?.stage, 'done')
  assert.equal(after?.passes, 1)
  assert.match(after?.warn ?? '', /coder ended without a COLONY: line/)
  assert.equal(after?.visits.at(-1)?.verdict, 'none')
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
