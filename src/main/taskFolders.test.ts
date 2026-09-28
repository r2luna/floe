import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHook } from './config/hook.test-helper.ts'
import { makeGitRepo } from './gitFixture.test-helper.ts'
import type { TaskCard } from '../shared/taskFolders.ts'
import { taskChatOpener } from '../shared/taskFolders.ts'

// The send test runs the REAL git helpers against a fixture, and they inherit
// this process's environment — so the same walls git.test.ts puts up: no
// inherited GIT_* (a pre-commit hook exports GIT_DIR), and no walking up past tmp.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key]
const TMP = realpathSync(tmpdir())
process.env.GIT_CEILING_DIRECTORIES = TMP
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_SYSTEM = '/dev/null'
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Floe Test'
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@floe.invalid'

installHook()

const {
  attachToTask,
  briefFor,
  createTaskFolder,
  deleteTaskFolder,
  detachFromTask,
  ensurePlan,
  fileTypeOf,
  listTaskFolders,
  localDate,
  nextNumber,
  parseTaskMd,
  readTaskFolder,
  sendTaskFolder,
  serializeTaskMd,
  slugify,
  stepTaskStatus,
  updateTaskFolder,
  watchTaskFolders
} = await import('./taskFolders.ts')
const { checkedOutBranch, commitPaths, defaultBranch, isTracked } = await import('./git.ts')

const noCard = (): undefined => undefined

function project(): string {
  const dir = mkdtempSync(join(TMP, 'floe-tasks-'))
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('task.md round-trips: frontmatter, links, depends, and keys it does not know', () => {
  const text = [
    '---',
    'title: task panel for ideas',
    'status: shaping',
    'kind: fix',
    'created: 2026-09-27',
    'links:',
    '  - https://claude.ai/design/x',
    'depends: [012, 014]',
    'owner: rafael',
    '---',
    '',
    'A panel per project.'
  ].join('\n')
  const { meta, body } = parseTaskMd(text)
  assert.equal(meta.title, 'task panel for ideas')
  assert.equal(meta.status, 'shaping')
  assert.equal(meta.kind, 'fix')
  assert.deepEqual(meta.links, ['https://claude.ai/design/x'])
  assert.deepEqual(meta.depends, ['012', '014'])
  assert.equal(body, 'A panel per project.')
  // A line somebody added by hand survives a rewrite.
  const again = parseTaskMd(serializeTaskMd(meta, body))
  assert.deepEqual(again.meta, meta)
  assert.equal(again.body, body)
})

test('a hand-written task.md with no frontmatter is still a task: its heading is the title', () => {
  const { meta, body } = parseTaskMd('# Voice notes\n\nDictate into the composer.\n')
  assert.equal(meta.title, 'Voice notes')
  assert.equal(meta.status, 'idea')
  assert.equal(body, 'Dictate into the composer.')
  // Nonsense values fall back rather than throw.
  assert.equal(parseTaskMd('---\nstatus: cooking\nkind: epic\n---\n').meta.status, 'idea')
})

test('slugs are folder-safe and the number is one past the highest in either place', () => {
  assert.equal(slugify('Ação: Task Panel / ideas!'), 'acao-task-panel-ideas')
  assert.equal(slugify('!!!'), 'task')
  const root = project()
  assert.equal(nextNumber(root), '001')
  mkdirSync(join(root, '.floe/tasks/004-a'), { recursive: true })
  mkdirSync(join(root, 'specs/017-b'), { recursive: true })
  mkdirSync(join(root, 'specs/colony'), { recursive: true })
  // A sent task keeps its number: 017 is taken forever.
  assert.equal(nextNumber(root), '018')
})

test('create writes a numbered folder, and the list reads it back grouped by where it lives', () => {
  const root = project()
  const a = createTaskFolder(root, { title: 'First idea', idea: 'rough' }, 'agent')
  assert.equal(a.name, '001-first-idea')
  assert.equal(a.dir, '.floe/tasks/001-first-idea')
  assert.equal(a.status, 'idea')
  assert.equal(a.idea, 'rough')
  assert.equal(a.plan, null)
  createTaskFolder(root, { title: 'Second' }, 'user')
  const listed = listTaskFolders(root, noCard)
  assert.deepEqual(listed.map((t) => t.number).sort(), ['001', '002'])
  assert.throws(() => createTaskFolder(root, { title: '  ' }, 'user'), /needs a title/)
})

test('only the user can make a task ready, and nobody can set in dev or done by hand', () => {
  const root = project()
  createTaskFolder(root, { title: 'Gate' }, 'user')
  assert.throws(() => updateTaskFolder(root, '1', { status: 'ready' }, 'agent'), /Only the user/)
  assert.throws(() => createTaskFolder(root, { title: 'x', status: 'ready' }, 'agent'), /Only the user/)
  assert.throws(() => updateTaskFolder(root, '1', { status: 'in dev' }, 'user'), /set by the colony/)
  assert.equal(updateTaskFolder(root, '001', { status: 'shaping' }, 'agent').status, 'shaping')
  assert.equal(updateTaskFolder(root, '001-gate', { status: 'ready' }, 'user').status, 'ready')
})

test('[ and ] step through idea, shaping, ready and stop at both ends', () => {
  const root = project()
  createTaskFolder(root, { title: 'Steps' }, 'user')
  assert.equal(stepTaskStatus(root, '1', -1, 'user').status, 'idea')
  assert.equal(stepTaskStatus(root, '1', 1, 'user').status, 'shaping')
  assert.equal(stepTaskStatus(root, '1', 1, 'user').status, 'ready')
  assert.equal(stepTaskStatus(root, '1', 1, 'user').status, 'ready')
  // An agent can walk it back, never forward into ready.
  assert.equal(stepTaskStatus(root, '1', -1, 'agent').status, 'shaping')
  assert.throws(() => stepTaskStatus(root, '1', 1, 'agent'), /Only the user/)
})

test('files: designs, drawings and links are listed; task.md and plan.md are not', () => {
  const root = project()
  createTaskFolder(root, { title: 'Files' }, 'user')
  const plan = ensurePlan(root, '1')
  assert.equal(plan, '.floe/tasks/001-files/plan.md')
  assert.equal(ensurePlan(root, '1'), plan, 'a second p opens the same plan, it does not reset it')
  attachToTask(root, '1', { name: 'list.html', content: '<p>x</p>' })
  attachToTask(root, '1', { name: 'notes/research.md', content: '# r' })
  attachToTask(root, '1', { name: 'flow.excalidraw', content: '{}' })
  const detail = attachToTask(root, '1', { link: 'https://claude.ai/design/abc' })
  assert.deepEqual(
    detail.files.map((f) => `${f.type}:${f.path}`),
    ['html:list.html', 'drawing:flow.excalidraw', 'link:https://claude.ai/design/abc', 'markdown:notes/research.md']
  )
  assert.equal(detail.plan, '# Plan\n\n')
  assert.deepEqual(detail.counts, { html: 1, drawing: 1, link: 1, other: 1 })
  assert.equal(localDate(new Date(2026, 8, 27, 23, 30)), '2026-09-27')
  assert.throws(() => attachToTask(root, '1', { name: '../escape.txt', content: '' }), /outside the task folder/)
  assert.throws(() => attachToTask(root, '1', { link: 'not a url' }), /Not a URL/)
  assert.throws(() => attachToTask(root, '1', { name: 'task.md', content: '' }), /task_update/)

  detachFromTask(root, '1', 'list.html')
  detachFromTask(root, '1', 'https://claude.ai/design/abc')
  const now = readTaskFolder(root, '1', noCard)
  assert.deepEqual(now.files.map((f) => f.path), ['flow.excalidraw', 'notes/research.md'])
  assert.equal(existsSync(join(root, '.floe/tasks/001-files/list.html')), false)
})

test('file types pick the panel: html → browser, excalidraw → draw, url → browser, md → reader', () => {
  assert.equal(fileTypeOf('a/b.HTML'), 'html')
  assert.equal(fileTypeOf('x.excalidraw'), 'drawing')
  assert.equal(fileTypeOf('https://x.dev'), 'link')
  assert.equal(fileTypeOf('n.md'), 'markdown')
  assert.equal(fileTypeOf('shot.png'), 'file')
})

// A fake board, so send's own steps are what is under test.
function fakeBoard(): { cards: (TaskCard & { name: string; specDir: string; brief: string })[]; released: string[] } {
  return { cards: [], released: [] }
}

test('send moves the folder to specs/, commits both paths on main, then starts the card', async () => {
  const repo = makeGitRepo()
  try {
    repo.write('README.md', 'x')
    repo.commit('init')
    const root = repo.dir
    createTaskFolder(root, { title: 'Ship it', idea: 'the idea' }, 'user')
    attachToTask(root, '1', { name: 'design.html', content: '<p/>' })
    repo.commit('task 001')
    const board = fakeBoard()
    const deps = {
      mainBranch: defaultBranch,
      checkedOutBranch,
      isTracked,
      commitPaths,
      findCard: (_root: string, name: string) => board.cards.find((c) => c.name === name),
      startCard: async (card: { name: string; specDir: string; brief: string }) => {
        const made = { id: `c-${card.name}`, stage: 'specifier', status: 'working', merged: false, ...card }
        board.cards.push(made)
        return made
      },
      releaseCard: async (id: string) => {
        board.released.push(id)
        return board.cards.find((c) => c.id === id)!
      }
    }

    await assert.rejects(sendTaskFolder(root, '1', deps), /only a ready task can be sent/)
    updateTaskFolder(root, '1', { status: 'ready' }, 'user')
    const sent = await sendTaskFolder(root, '1', deps)

    assert.equal(sent.dir, 'specs/001-ship-it')
    assert.equal(sent.status, 'in dev')
    assert.equal(existsSync(join(root, '.floe/tasks/001-ship-it')), false)
    assert.match(readFileSync(join(root, 'specs/001-ship-it/task.md'), 'utf8'), /status: in dev/)
    // One commit carries the deletion AND the addition, and leaves nothing behind.
    assert.equal(repo.git('log', '-1', '--format=%s'), 'chore(tasks): start 001-ship-it')
    const touched = repo.git('show', '--no-renames', '--name-status', '--format=', 'HEAD').split('\n').sort()
    assert.deepEqual(touched, [
      'D\t.floe/tasks/001-ship-it/design.html',
      'D\t.floe/tasks/001-ship-it/task.md',
      'A\tspecs/001-ship-it/design.html',
      'A\tspecs/001-ship-it/task.md'
    ].sort())
    assert.equal(repo.git('status', '--porcelain'), '')

    assert.equal(board.cards.length, 1)
    assert.equal(board.cards[0].specDir, 'specs/001-ship-it/colony')
    assert.equal(board.cards[0].brief, briefFor('specs/001-ship-it', 'Ship it', false))
    assert.match(board.cards[0].brief, /no plan\.md/, 'the brief never promises a plan that is not there')
    assert.match(briefFor('specs/x', 'X', true), /plan\.md is the plan/)
    // Sent means read-only.
    assert.throws(() => updateTaskFolder(root, '1', { idea: 'late' }, 'user'), /read-only/)

    // Sending again is a no-op once the card exists and left the backlog…
    await sendTaskFolder(root, '1', deps)
    assert.equal(board.cards.length, 1)
    // …and the recovery when it never did.
    board.cards[0].stage = 'inbox'
    await sendTaskFolder(root, '1', deps)
    assert.deepEqual(board.released, ['c-001-ship-it'])
    // A merged card is what makes the task done — nothing is written for it.
    board.cards[0].merged = true
    assert.equal(readTaskFolder(root, '1', deps.findCard).status, 'done')
  } finally {
    repo.cleanup()
  }
})

test('send refuses when the main checkout is not on the main branch, and moves nothing', async () => {
  const repo = makeGitRepo()
  try {
    repo.write('README.md', 'x')
    repo.commit('init')
    repo.git('checkout', '-b', 'elsewhere')
    const root = repo.dir
    createTaskFolder(root, { title: 'Stay' }, 'user')
    updateTaskFolder(root, '1', { status: 'ready' }, 'user')
    const deps = {
      mainBranch: async () => 'main',
      checkedOutBranch,
      isTracked,
      commitPaths,
      findCard: noCard,
      startCard: async () => assert.fail('no card before the move'),
      releaseCard: async () => assert.fail('no release')
    }
    await assert.rejects(sendTaskFolder(root, '1', deps), /on elsewhere, not main/)
    assert.equal(existsSync(join(root, '.floe/tasks/001-stay/task.md')), true)
  } finally {
    repo.cleanup()
  }
})

test('an untracked task sends too: only the destination is committed', async () => {
  const repo = makeGitRepo()
  try {
    repo.write('README.md', 'x')
    repo.commit('init')
    const root = repo.dir
    createTaskFolder(root, { title: 'Fresh' }, 'user')
    updateTaskFolder(root, '1', { status: 'ready' }, 'user')
    // Somebody else's uncommitted work in the checkout stays exactly as it was.
    writeFileSync(join(root, 'README.md'), 'edited')
    const cards: string[] = []
    await sendTaskFolder(root, '1', {
      mainBranch: defaultBranch,
      checkedOutBranch,
      isTracked,
      commitPaths,
      findCard: noCard,
      startCard: async (c) => {
        cards.push(c.name)
        return { id: 'x', stage: 'specifier', status: 'working', merged: false }
      },
      releaseCard: async () => assert.fail('no release')
    })
    assert.deepEqual(cards, ['001-fresh'])
    assert.equal(repo.git('status', '--porcelain'), 'M README.md')
  } finally {
    repo.cleanup()
  }
})

test('the watcher tells the renderer when a task folder changes, once per burst, and stops with the window', async () => {
  const root = project()
  const sent: { root: string }[] = []
  let destroyed = false
  let onDestroyed: () => void = () => {}
  const wc = {
    isDestroyed: () => destroyed,
    send: (_channel: string, payload: { root: string }) => sent.push(payload),
    once: (_event: 'destroyed', fn: () => void) => {
      onDestroyed = fn
    }
  }
  watchTaskFolders(wc, root)
  watchTaskFolders(wc, root) // a second panel on the same project shares the watcher
  assert.equal(existsSync(join(root, '.floe/tasks')), true, 'the tasks dir exists so the watch is reliable')
  createTaskFolder(root, { title: 'Watched' }, 'user')
  attachToTask(root, '1', { name: 'a.html', content: 'x' })
  await new Promise((r) => setTimeout(r, 400))
  assert.ok(sent.length >= 1, 'a write is announced')
  assert.ok(sent.length <= 2, 'a burst of writes is one announcement, not one per fs event')
  assert.deepEqual(sent[0], { root })

  destroyed = true
  onDestroyed()
  const before = sent.length
  attachToTask(root, '1', { name: 'b.html', content: 'y' })
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(sent.length, before, 'a closed window hears nothing')
})

test('d deletes an unsent task and its files; a sent task cannot be deleted', () => {
  const root = project()
  createTaskFolder(root, { title: 'Gone soon' }, 'user')
  attachToTask(root, '1', { name: 'a.html', content: 'x' })
  assert.deepEqual(deleteTaskFolder(root, '1'), { deleted: '001-gone-soon' })
  assert.equal(existsSync(join(root, '.floe/tasks/001-gone-soon')), false)
  assert.throws(() => deleteTaskFolder(root, '1'), /No task 1/)
  // The number is not handed out again while nothing holds it — but a sent one is.
  mkdirSync(join(root, 'specs/002-sent'), { recursive: true })
  writeFileSync(join(root, 'specs/002-sent/task.md'), '# Sent\n')
  assert.throws(() => deleteTaskFolder(root, '2'), /read-only/)
  assert.equal(existsSync(join(root, 'specs/002-sent/task.md')), true)
})

test('c opens a chat that starts on the task: it points at the folder, and a sent task is discuss-only', () => {
  const shaping = taskChatOpener({ number: '017', title: 'Tasks', dir: '.floe/tasks/017-tasks', status: 'shaping' })
  assert.match(shaping, /task 017, "Tasks"/)
  assert.match(shaping, /\.floe\/tasks\/017-tasks\//)
  assert.match(shaping, /edit those files directly/)
  assert.match(shaping, /Never set `status: ready`/)
  const sent = taskChatOpener({ number: '017', title: 'Tasks', dir: 'specs/017-tasks', status: 'in dev' })
  assert.match(sent, /read-only: discuss it, do not edit it/)
  assert.doesNotMatch(sent, /edit those files directly/)
})
