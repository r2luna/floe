import assert from 'node:assert/strict'
import test from 'node:test'
import { folderMentions, projectMentions, remoteProjectRefs, sessionMentions, taskMentions } from './useMenuItems.ts'
import type { TaskFolder } from '../../shared/taskFolders.ts'
import type { WorktreeRow } from './useWorktrees.ts'

const row = (branch: string, titles: string[]): WorktreeRow =>
  ({
    worktree: { path: `/w/${branch}`, branch },
    sessions: titles.map((title, i) => ({ id: `s${branch}${i}`, title, mtime: 0, active: false }))
  }) as WorktreeRow

test('sessions of the same name are one row', () => {
  const rows = [row('master', ['Release new Floe version', 'Release new Floe version'])]
  assert.deepEqual(
    sessionMentions(rows).map((m) => m.id),
    ['#Release-new-Floe-version']
  )
})

test('the same title in two worktrees is still one row', () => {
  const rows = [row('master', ['Ship it']), row('feature', ['Ship it', 'Other'])]
  assert.deepEqual(
    sessionMentions(rows).map((m) => m.id),
    ['#Ship-it', '#Other']
  )
})

test('a row carries the title and the branch it lives on', () => {
  assert.deepEqual(sessionMentions([row('master', ['Ship it'])]), [
    { id: '#Ship-it', title: 'Ship it', detail: 'master', group: 'sessions' }
  ])
})

test('every folder above a file is one row, with a trailing slash', () => {
  assert.deepEqual(
    folderMentions(['src/main/a.ts', 'src/main/b.ts', 'src/renderer/src/c.tsx', 'README.md']).map((m) => m.id),
    ['#src/', '#src/main/', '#src/renderer/', '#src/renderer/src/']
  )
})

test('a task is offered by its number', () => {
  const [item] = taskMentions([{ number: '001', title: 'sidebar', status: 'idea' } as TaskFolder])
  assert.equal(item.id, '#001')
  assert.equal(item.title, '001 sidebar')
  assert.equal(item.group, 'tasks')
})

const here = { current: 'local', label: (id: string) => (id === 'link' ? 'Link' : id) }
const projects = [
  { path: '/p/floe', name: 'floe', group: '' },
  { path: '/p/my app', name: 'my app', group: '' },
  { path: '/p/floe2', name: 'floe', group: '' },
  { path: '/r/floe', name: 'floe', group: '', backend: 'link' },
  { path: '/home', name: 'Home', group: '', home: true }
]

test('projects are offered as $name, naming the machine when it is another one', () => {
  assert.deepEqual(
    projectMentions(projects, here).map((m) => m.id),
    ['$floe', '$my-app', '$floe@Link']
  )
})

test('seen from another machine, the roles swap', () => {
  const at = { ...here, current: 'link' }
  assert.deepEqual(
    projectMentions(projects, at).map((m) => m.id),
    ['$floe@local', '$my-app@local', '$floe']
  )
})

test('only the projects main cannot resolve are expanded by the renderer', () => {
  assert.deepEqual([...remoteProjectRefs(projects, here)], [
    ['floe@Link', { name: 'floe', path: '/r/floe', machine: 'Link' }]
  ])
})
