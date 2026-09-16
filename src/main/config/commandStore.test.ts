import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHook } from './hook.test-helper.ts'

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'floe-cfg-'))
installHook()

const store = await import('./commandStore.ts')
const projects = await import('./projectStore.ts')

// The repository the commands belong to. Real, since they are written inside it.
let app = ''

function reset(): void {
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'floe-cfg-'))
  projects.invalidateProjects()
  app = mkdtempSync(join(tmpdir(), 'floe-repo-'))
}

test('a command added to an untracked project creates the project too', () => {
  reset()
  store.addCommand(app, { name: 'Queue', command: 'php artisan queue:work', autoStart: true })
  const { commands, path } = store.readCommands(app)
  assert.equal(commands.length, 1)
  assert.equal(commands[0].name, 'Queue')
  assert.equal(commands[0].autoStart, true)
  assert.ok(path?.endsWith('commands.toml'))
  assert.equal(projects.scanProjects().projects.length, 1)
})

test('the generated file keeps its documentation after an app write', () => {
  reset()
  store.addCommand(app, { name: 'Dev', command: 'pnpm run dev' })
  const raw = readFileSync(store.readCommands(app).path!, 'utf8')
  assert.ok(raw.includes('#  Floe — project commands'))
  assert.ok(raw.includes('name    = "Dev"'))
})

test('ids come from the name and are numbered when two names collide', () => {
  reset()
  store.addCommand(app, { name: 'Migrate on change', command: 'a' })
  store.addCommand(app, { name: 'Migrate on change', command: 'b' })
  assert.deepEqual(
    store.readCommands(app).commands.map((c) => c.id),
    ['migrate-on-change', 'migrate-on-change-2']
  )
})

test('scope is a field: a worktree command names its worktree', () => {
  reset()
  store.addCommand(app, { name: 'Shared', command: 'a' })
  store.addCommand(app, { name: 'Local', command: 'b', worktree: '/code/app-feat' })
  const commands = store.readCommands(app).commands
  assert.equal(commands[0].worktree, undefined)
  assert.equal(commands[1].worktree, '/code/app-feat')
})

test('setCommandWorktree moves a command between scopes both ways', () => {
  reset()
  store.addCommand(app, { name: 'Queue', command: 'q' })
  store.setCommandWorktree(app, 'queue', '/code/app-feat')
  assert.equal(store.readCommands(app).commands[0].worktree, '/code/app-feat')
  store.setCommandWorktree(app, 'queue', null)
  assert.equal(store.readCommands(app).commands[0].worktree, undefined)
})

test('updateCommand edits the right entry when several exist', () => {
  reset()
  store.addCommand(app, { name: 'One', command: 'a' })
  store.addCommand(app, { name: 'Two', command: 'b' })
  store.addCommand(app, { name: 'Three', command: 'c' })
  store.updateCommand(app, 'two', { command: 'changed', autoRestart: true })
  const commands = store.readCommands(app).commands
  assert.deepEqual(commands.map((c) => c.command), ['a', 'changed', 'c'])
  assert.equal(commands[1].autoRestart, true)
  assert.equal(commands[0].autoRestart, undefined, 'its neighbours are untouched')
})

test('clearing a field removes the key instead of writing an empty string', () => {
  reset()
  store.addCommand(app, { name: 'One', command: 'a', cwd: '/tmp' })
  store.updateCommand(app, 'one', { cwd: '' })
  const raw = readFileSync(store.readCommands(app).path!, 'utf8')
  assert.ok(!/^cwd\s*=/m.test(raw), 'the key is gone, though the comment explaining it stays')
  assert.equal(store.readCommands(app).commands[0].cwd, undefined)
})

test('removeCommand drops one entry and leaves the rest addressable', () => {
  reset()
  store.addCommand(app, { name: 'One', command: 'a' })
  store.addCommand(app, { name: 'Two', command: 'b' })
  store.addCommand(app, { name: 'Three', command: 'c' })
  store.removeCommand(app, 'two')
  assert.deepEqual(store.readCommands(app).commands.map((c) => c.name), ['One', 'Three'])
  store.updateCommand(app, 'three', { command: 'still works' })
  assert.equal(store.readCommands(app).commands[1].command, 'still works')
})

test('watch globs round-trip as a list', () => {
  reset()
  store.addCommand(app, { name: 'W', command: 'x', watch: ['database/migrations', 'config'] })
  assert.deepEqual(store.readCommands(app).commands[0].watch, ['database/migrations', 'config'])
})

test('an entry missing its command is reported, and its siblings still load', () => {
  reset()
  store.addCommand(app, { name: 'Good', command: 'a' })
  const { commands, errors } = store.parseCommands(
    '[[command]]\nname = "Broken"\n\n[[command]]\nname = "Good"\ncommand = "a"\n',
    'commands.toml'
  )
  assert.deepEqual(commands.map((c) => c.name), ['Good'])
  assert.equal(errors.length, 1)
  assert.match(errors[0].reason, /needs both a name and a command/)
})

test('a project with no commands file reads as no commands', () => {
  reset()
  projects.createProject(app)
  assert.deepEqual(store.readCommands(app).commands, [])
})

test('notify only accepts the documented levels', () => {
  const { commands, errors } = store.parseCommands(
    '[[command]]\nname = "A"\ncommand = "a"\nnotify = "loud"\n',
    'commands.toml'
  )
  assert.equal(commands[0].notify, undefined)
  assert.match(errors[0].reason, /all, important, none/)
})

test('shared commands are committed in .floe, worktree commands stay in the ignored local file', () => {
  reset()
  store.addCommand(app, { name: 'Dev', command: 'pnpm dev' })
  store.addCommand(app, { name: 'Tunnel', command: 'ngrok', worktree: '/code/app-feat' })
  assert.equal(store.readCommands(app).path, join(app, '.floe', 'commands.toml'))
  assert.ok(!readFileSync(join(app, '.floe', 'commands.toml'), 'utf8').includes('Tunnel'))
  assert.ok(readFileSync(join(app, '.floe', 'local', 'commands.toml'), 'utf8').includes('/code/app-feat'))
  assert.equal(readFileSync(join(app, '.floe', '.gitignore'), 'utf8'), 'local/\n')
  assert.ok(!existsSync(join(projects.projectScan().byPath.get(app)!, 'commands.toml')), 'nothing in ~/.config')
})

test('ids stay unique across the shared and local files', () => {
  reset()
  store.addCommand(app, { name: 'Dev', command: 'a' })
  store.addCommand(app, { name: 'Dev', command: 'b', worktree: '/code/app-feat' })
  assert.deepEqual(store.readCommands(app).commands.map((c) => c.id), ['dev', 'dev-2'])
  store.removeCommand(app, 'dev-2')
  assert.deepEqual(store.readCommands(app).commands.map((c) => c.command), ['a'])
})
