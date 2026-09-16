import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHook } from './hook.test-helper.ts'

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'floe-cfg-'))
installHook()

const { migrateProjectsToRepo } = await import('./migrateRepo.ts')
const store = await import('./projectStore.ts')
const { readCommands } = await import('./commandStore.ts')
const { listMcpServers } = await import('./mcpServers.ts')
const { listSkills } = await import('./skills.ts')

/** A project in the old layout: everything under ~/.config/floe/projects/<dir>/. */
function legacyProject(): { app: string; dir: string } {
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'floe-cfg-'))
  store.invalidateProjects()
  const app = mkdtempSync(join(tmpdir(), 'floe-repo-'))
  const dir = join(store.projectsDir(), 'app')
  mkdirSync(join(dir, 'skills'), { recursive: true })
  writeFileSync(
    join(dir, 'config.toml'),
    `path = "${app}"\ngroup = "Work"\nseeded = true\n\n[env]\nphp = "8.3"\n\n[integrations]\njira-project = "APP"\n`
  )
  writeFileSync(
    join(dir, 'commands.toml'),
    '[[command]]\nname = "Dev"\ncommand = "pnpm dev"\n\n[[command]]\nname = "Tunnel"\ncommand = "ngrok"\nworktree = "/code/app-feat"\n'
  )
  writeFileSync(
    join(dir, 'mcp.toml'),
    '[[server]]\nname = "linear"\ntransport = "http"\nurl = "https://mcp.linear.app"\nheaders = { Authorization = "Bearer t" }\n'
  )
  writeFileSync(join(dir, 'skills', 'deploy.md'), 'Ship it.')
  store.invalidateProjects()
  return { app, dir }
}

test('boot moves settings, commands, MCP servers and skills into the repo', () => {
  const { app, dir } = legacyProject()
  migrateProjectsToRepo()

  const project = store.scanProjects().projects[0]
  assert.equal(project.group, 'Work', 'identity stays in ~/.config')
  assert.equal(project.env?.php, '8.3')
  assert.equal(project.jiraProject, 'APP')
  assert.equal(project.seeded, true)
  const global = readFileSync(join(dir, 'config.toml'), 'utf8')
  assert.ok(!/php|jira|seeded|\[env\]|\[integrations\]/.test(global), global)

  assert.deepEqual(readCommands(app).commands.map((c) => [c.name, c.worktree]), [
    ['Dev', undefined],
    ['Tunnel', '/code/app-feat']
  ])
  assert.ok(!readFileSync(join(app, '.floe', 'commands.toml'), 'utf8').includes('Tunnel'))

  const linear = listMcpServers(app).find((s) => s.name === 'linear')
  assert.equal(linear?.headers?.Authorization, 'Bearer t')
  assert.ok(!readFileSync(join(app, '.floe', 'mcp.toml'), 'utf8').includes('Bearer t'))

  assert.equal(listSkills(app).find((s) => s.name === 'deploy')?.file, join(app, '.floe', 'skills', 'deploy.md'))

  for (const name of ['commands.toml', 'mcp.toml', 'skills']) {
    assert.ok(existsSync(join(dir, `${name}.migrated`)), `${name} is kept as a backup`)
    assert.ok(!existsSync(join(dir, name)))
  }
})

test('a repo that already has its own file keeps it', () => {
  const { app, dir } = legacyProject()
  mkdirSync(join(app, '.floe'))
  writeFileSync(join(app, '.floe', 'commands.toml'), '[[command]]\nname = "Theirs"\ncommand = "x"\n')
  migrateProjectsToRepo()
  assert.deepEqual(readCommands(app).commands.map((c) => c.name), ['Theirs'])
  assert.ok(existsSync(join(dir, 'commands.toml')), 'the legacy file is left alone')
})

test('a migrated project is not migrated twice', () => {
  const { app } = legacyProject()
  migrateProjectsToRepo()
  migrateProjectsToRepo()
  assert.equal(readCommands(app).commands.length, 2)
})
