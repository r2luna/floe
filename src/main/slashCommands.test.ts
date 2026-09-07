import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { discoverSlashCommands } from './slashCommands.ts'

// The personal half of the lookup is `~/.claude`, resolved per call, so a
// throwaway HOME keeps the developer's own commands out of every assertion.
const home = mkdtempSync(join(tmpdir(), 'floe-home-'))
process.env.HOME = home

function write(root: string, rel: string, body: string): string {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, body)
  return abs
}

function worktree(): string {
  return mkdtempSync(join(tmpdir(), 'floe-wt-'))
}

const byName = (name: string, source: string) => (c: { name: string; source: string }) =>
  c.name === name && c.source === source

test('a command file becomes a command named after its path, with its frontmatter read', () => {
  const wt = worktree()
  write(
    wt,
    '.claude/commands/deploy.md',
    '---\ndescription: Ship a release\nargument-hint: "[patch|minor|major]"\n---\n\nDo the deploy.\n'
  )
  const cmds = discoverSlashCommands(wt)
  const deploy = cmds.find(byName('deploy', 'command'))
  assert.ok(deploy, 'deploy should be discovered')
  assert.equal(deploy.description, 'Ship a release')
  assert.equal(deploy.argumentHint, '[patch|minor|major]') // quotes stripped
  assert.equal(deploy.scope, 'project')
})

test('nested command folders namespace with ":", the way the CLI spells them', () => {
  const wt = worktree()
  write(wt, '.claude/commands/git/review.md', '# no frontmatter at all\n')
  write(wt, '.claude/commands/README.txt', 'not a command')
  const cmds = discoverSlashCommands(wt)
  assert.ok(cmds.find(byName('git:review', 'command')))
  assert.equal(cmds.some((c) => c.name.includes('README')), false)
})

test('frontmatter reading survives the shapes it is not meant to handle', () => {
  const wt = worktree()
  // No frontmatter, an unterminated block, a list value, and an indented key —
  // each must degrade to "no description", never throw or swallow the command.
  write(wt, '.claude/commands/a.md', 'Just prose.\n')
  write(wt, '.claude/commands/b.md', '---\ndescription: never closed\n')
  write(wt, '.claude/commands/c.md', '---\ndescription:\n  - one\n  - two\nname: c\n---\nbody\n')
  const cmds = discoverSlashCommands(wt)
  assert.equal(cmds.find(byName('a', 'command'))?.description, undefined)
  assert.equal(cmds.find(byName('b', 'command'))?.description, undefined)
  assert.equal(cmds.find(byName('c', 'command'))?.description, '') // key present, value empty
})

test('a skill is a folder holding a SKILL.md, and its frontmatter name wins', () => {
  const wt = worktree()
  write(wt, '.claude/skills/deploy/SKILL.md', '---\nname: ship-it\ndescription: Cut a release\n---\n')
  write(wt, '.claude/skills/empty/notes.md', 'no SKILL.md here')
  const cmds = discoverSlashCommands(wt)
  const skill = cmds.find(byName('ship-it', 'skill'))
  assert.ok(skill, 'the frontmatter name is the skill name')
  assert.equal(skill.description, 'Cut a release')
  assert.equal(cmds.some((c) => c.source === 'skill' && c.name === 'empty'), false)
})

test('a skill folder with no name in its SKILL.md falls back to the folder name', () => {
  const wt = worktree()
  write(wt, '.claude/skills/dataviz/SKILL.md', '---\ndescription: Charts\n---\n')
  assert.ok(discoverSlashCommands(wt).find(byName('dataviz', 'skill')))
})

// Skills are routinely symlinked out of a shared .ai/skills tree, and a symlink
// reports isDirectory() === false — reading it as a plain file loses the skill.
test('a symlinked skill folder is discovered like a real one', () => {
  const wt = worktree()
  write(wt, '.ai/skills/linked/SKILL.md', '---\nname: linked\ndescription: Via symlink\n---\n')
  mkdirSync(join(wt, '.claude', 'skills'), { recursive: true })
  symlinkSync(join(wt, '.ai', 'skills', 'linked'), join(wt, '.claude', 'skills', 'linked'))
  const skill = discoverSlashCommands(wt).find(byName('linked', 'skill'))
  assert.equal(skill?.description, 'Via symlink')
})

test('a project entry overrides the personal one of the same name and source', () => {
  const wt = worktree()
  write(home, '.claude/commands/deploy.md', '---\ndescription: personal\n---\n')
  write(home, '.claude/skills/onlymine/SKILL.md', '---\ndescription: personal skill\n---\n')
  write(wt, '.claude/commands/deploy.md', '---\ndescription: project\n---\n')
  const cmds = discoverSlashCommands(wt)
  const deploy = cmds.filter(byName('deploy', 'command'))
  assert.equal(deploy.length, 1)
  assert.equal(deploy[0].description, 'project')
  assert.equal(deploy[0].scope, 'project')
  // The personal entries the project does not shadow are still there.
  assert.equal(cmds.find(byName('onlymine', 'skill'))?.scope, 'user')
})

// A gw worktree lives at <repo>/.worktrees/<branch> and usually carries no
// .claude of its own, so the repo root has to be scanned too.
test('a worktree inherits the main repo .claude', () => {
  const repo = worktree()
  write(repo, '.claude/commands/repo-only.md', '---\ndescription: from the repo root\n---\n')
  const wt = join(repo, '.worktrees', 'feat')
  mkdirSync(wt, { recursive: true })
  assert.equal(
    discoverSlashCommands(wt).find(byName('repo-only', 'command'))?.description,
    'from the repo root'
  )
})

test('a missing .claude is an empty list, and the result is sorted by name', () => {
  const wt = worktree()
  write(wt, '.claude/commands/zed.md', 'z')
  write(wt, '.claude/commands/alpha.md', 'a')
  const names = discoverSlashCommands(wt).map((c) => c.name)
  assert.deepEqual([...names].sort((a, b) => a.localeCompare(b)), names)

  process.env.HOME = mkdtempSync(join(tmpdir(), 'floe-home-'))
  assert.deepEqual(discoverSlashCommands(worktree()), [])
  process.env.HOME = home
})
