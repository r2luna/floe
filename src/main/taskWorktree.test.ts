import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHook } from './config/hook.test-helper.ts'
import { makeGitRepo, type GitFixture } from './gitFixture.test-helper.ts'
import { taskPremise, type TaskFileEntry } from '../shared/taskFolders.ts'

// The code under test spawns its own git, so the walls from git.test.ts go up here.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key]
const TMP = realpathSync(tmpdir())
process.env.GIT_CEILING_DIRECTORIES = TMP
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_SYSTEM = '/dev/null'
const data = mkdtempSync(join(TMP, 'floe-task-wt-data-'))
process.env.FLOE_TEST_USERDATA = data
process.on('exit', () => rmSync(data, { recursive: true, force: true }))

installHook()

const { createTaskFolder, updateTaskFolder } = await import('./taskFolders.ts')
const { createTaskWorktree } = await import('./taskWorktree.ts')

let repo: GitFixture

beforeEach(() => {
  repo = makeGitRepo()
  repo.write('a.txt', 'a\n')
  repo.commit('init')
})

afterEach(() => repo.cleanup())

const premiseOf = (path: string): string => readFileSync(join(path, '.floe', 'premise.md'), 'utf8')

test('a task gets a worktree on a branch named after its folder, with the task as its premise', async () => {
  const task = createTaskFolder(repo.dir, { title: 'Cycle time', idea: 'Include the totals.' }, 'user')
  const made = await createTaskWorktree(repo.dir, task.number)
  assert.equal(made.branch, task.name)
  assert.equal(made.existed, false)

  const tree = made.worktrees.find((w) => w.branch === task.name)
  assert.ok(tree)
  const premise = premiseOf(tree.path)
  assert.match(premise, new RegExp(`Deliver task ${task.number}, "Cycle time"`))
  assert.ok(premise.includes(`${repo.dir}/${task.dir}/task.md`), 'the path is absolute, into the main checkout')
  assert.match(premise, /- Plan: none yet/)
  assert.match(premise, /## Idea\nInclude the totals\./)
})

test('a long task name is cut for the branch, and the number stays', async () => {
  const task = createTaskFolder(
    repo.dir,
    { title: 'Include the totals for every squad on the cycle time page of the report' },
    'user'
  )
  const made = await createTaskWorktree(repo.dir, task.number)
  assert.ok(made.branch.startsWith(`${task.number}-`))
  assert.ok(made.branch.length <= 40, made.branch)
  assert.ok(!made.branch.endsWith('-'))
  assert.ok(made.worktrees.some((w) => w.branch === made.branch))
  assert.equal((await createTaskWorktree(repo.dir, task.number)).existed, true)
})

test('asking again goes to the same worktree and leaves its premise alone', async () => {
  const task = createTaskFolder(repo.dir, { title: 'Cycle time' }, 'user')
  const made = await createTaskWorktree(repo.dir, task.name)
  const tree = made.worktrees.find((w) => w.branch === task.name)
  assert.ok(tree)
  writeFileSync(join(tree.path, '.floe', 'premise.md'), 'edited by hand\n')

  const again = await createTaskWorktree(repo.dir, task.number)
  assert.equal(again.existed, true)
  assert.equal(again.worktrees.length, made.worktrees.length)
  assert.equal(premiseOf(tree.path), 'edited by hand\n')
})

test('the task is read at the moment of asking, so a later idea is the one quoted', async () => {
  const task = createTaskFolder(repo.dir, { title: 'Cycle time', idea: 'old' }, 'user')
  updateTaskFolder(repo.dir, task.name, { idea: 'new' }, 'user')
  const made = await createTaskWorktree(repo.dir, task.number)
  const tree = made.worktrees.find((w) => w.branch === task.name)
  assert.ok(tree)
  assert.match(premiseOf(tree.path), /## Idea\nnew/)
})

test('a task already with the colony is refused, by name', async () => {
  const dir = join(repo.dir, 'specs', '018-sent')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'task.md'), '---\ntitle: Sent\nstatus: ready\nkind: feat\n---\nIdea\n')
  await assert.rejects(createTaskWorktree(repo.dir, '018'), /Task 018 was sent to the colony/)
})

test('an unknown task says so', async () => {
  await assert.rejects(createTaskWorktree(repo.dir, '999'))
})

const task = {
  number: '017',
  title: 'Ship',
  kind: 'fix' as const,
  dir: '.floe/tasks/017-ship',
  idea: '',
  plan: null as string | null,
  files: [] as TaskFileEntry[]
}

test('the premise lists the plan and the files, with links as they are', () => {
  const premise = taskPremise(
    {
      ...task,
      files: [
        { type: 'html', path: 'mock.html' },
        { type: 'link', path: 'https://x.test/spec' }
      ],
      plan: 'the plan'
    },
    '/repo'
  )
  assert.match(premise, /Deliver task 017, "Ship" \(fix\)\./)
  assert.ok(premise.includes('- Plan: /repo/.floe/tasks/017-ship/plan.md'))
  assert.ok(premise.includes('- /repo/.floe/tasks/017-ship/mock.html'))
  assert.ok(premise.includes('- https://x.test/spec'))
  assert.ok(!premise.includes('## Idea'), 'no idea, no empty heading')
})

test('a long idea is clipped, because the plan and the file are one read away', () => {
  const premise = taskPremise({ ...task, idea: 'a'.repeat(2000) }, '/repo')
  assert.ok(premise.length < 1200)
  assert.ok(premise.endsWith('…'))
})
