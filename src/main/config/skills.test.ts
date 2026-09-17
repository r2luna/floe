import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHook } from './hook.test-helper.ts'

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'floe-cfg-'))
installHook()

const skills = await import('./skills.ts')
const projects = await import('./projectStore.ts')
const floe = await import('./floe.ts')

function reset(): void {
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'floe-cfg-'))
  projects.invalidateProjects()
  floe.invalidateFloeConfig()
}

/** Write a skill the way a person would: a Markdown file with frontmatter. */
function skill(dir: string, name: string, body: string, fm = ''): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.md`), fm ? `---\n${fm}\n---\n\n${body}` : body)
}

test('a global skill is offered everywhere', () => {
  reset()
  skill(skills.globalSkillsDir(), 'deploy', 'Cut a release.', 'description: Ship it')
  const list = skills.listSkills()
  assert.equal(list.length, 1)
  assert.equal(list[0].name, 'deploy')
  assert.equal(list[0].description, 'Ship it')
  assert.equal(list[0].scope, 'global')
})

test('the body is what the harness gets — the frontmatter is ours', () => {
  reset()
  skill(skills.globalSkillsDir(), 'deploy', '# Deploy\n\nBump, sign, publish.', 'name: deploy\ndescription: x')
  const body = skills.readSkill('deploy')
  assert.equal(body, '# Deploy\n\nBump, sign, publish.')
  assert.ok(!body?.includes('description'), 'metadata never reaches the model')
})

test('a skill with no frontmatter is still a skill', () => {
  reset()
  skill(skills.globalSkillsDir(), 'plain', 'Just instructions.')
  assert.equal(skills.readSkill('plain'), 'Just instructions.')
  assert.equal(skills.listSkills()[0].description, undefined)
})

test('frontmatter can rename the skill, and the token follows', () => {
  reset()
  skill(skills.globalSkillsDir(), 'file-name', 'body', 'name: real-name')
  assert.deepEqual(skills.listSkills().map((s) => s.name), ['real-name'])
  assert.equal(skills.readSkill('real-name'), 'body')
  assert.equal(skills.readSkill('file-name'), null)
})

/** A real repository directory, since project skills live inside it. */
const repoDir = (): string => mkdtempSync(join(tmpdir(), 'floe-repo-'))

test('a project skill is offered only inside its project', () => {
  reset()
  const app = repoDir()
  skill(skills.projectSkillsDir(app), 'migrate', 'Run the migration.')
  assert.deepEqual(skills.listSkills(app).map((s) => s.name), ['migrate'])
  assert.deepEqual(skills.listSkills().map((s) => s.name), [], 'not global')
  assert.deepEqual(skills.listSkills(repoDir()).map((s) => s.name), [], 'not another project')
})

test('a project skill wins over a global one of the same name', () => {
  reset()
  const app = repoDir()
  skill(skills.globalSkillsDir(), 'deploy', 'The generic one.')
  skill(skills.projectSkillsDir(app), 'deploy', 'The one this repo needs.')
  assert.equal(skills.readSkill('deploy', app), 'The one this repo needs.')
  assert.equal(skills.readSkill('deploy'), 'The generic one.')
  assert.equal(skills.listSkills(app).length, 1, 'one token, one skill')
  assert.equal(skills.listSkills(app)[0].scope, 'project')
})

test('a skill can be a directory holding SKILL.md, for bundled files', () => {
  reset()
  const dir = join(skills.globalSkillsDir(), 'bundled')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), '---\ndescription: has friends\n---\n\nUse checklist.md.')
  writeFileSync(join(dir, 'checklist.md'), 'one\ntwo')
  const found = skills.listSkills()
  assert.deepEqual(found.map((s) => s.name), ['bundled'])
  assert.equal(found[0].dir, dir, 'the dir is reported so the reader can find its neighbours')
  assert.equal(skills.readSkill('bundled'), 'Use checklist.md.')
})

test('a non-markdown file is not a skill', () => {
  reset()
  mkdirSync(skills.globalSkillsDir(), { recursive: true })
  writeFileSync(join(skills.globalSkillsDir(), 'notes.txt'), 'not a skill')
  assert.deepEqual(skills.listSkills(), [])
})

test('no skills directory is no skills, not a crash', () => {
  reset()
  assert.deepEqual(skills.listSkills(), [])
  assert.equal(skills.readSkill('anything'), null)
})

test('skills are listed alphabetically, whatever order they were written', () => {
  reset()
  for (const name of ['zulu', 'alpha', 'mike']) skill(skills.globalSkillsDir(), name, 'x')
  assert.deepEqual(skills.listSkills().map((s) => s.name), ['alpha', 'mike', 'zulu'])
})

test('the generated example is a real skill, so the format explains itself', () => {
  reset()
  skills.ensureSkills()
  const list = skills.listSkills()
  assert.deepEqual(list.map((s) => s.name), ['example'])
  assert.ok(list[0].description, 'and it shows a description in the palette')
  assert.ok(skills.readSkill('example')?.includes('~/.config/floe/skills'))
})

test('ensureSkills never overwrites a directory you already have', () => {
  reset()
  skill(skills.globalSkillsDir(), 'mine', 'my instructions')
  skills.ensureSkills()
  assert.deepEqual(skills.listSkills().map((s) => s.name), ['mine'], 'no example dropped on top')
})

/* --- creating, renaming, deleting from the panel ------------------------- */

test('a new skill is created ready to edit, with its frontmatter filled in', () => {
  reset()
  const made = skills.createSkill('ship', 'global')
  assert.equal(made.file, join(skills.globalSkillsDir(), 'ship.md'))
  const [listed] = skills.listSkills()
  assert.equal(listed.name, 'ship')
  assert.ok(listed.description, 'a description the list can show')
  assert.ok(skills.readSkill('ship')?.includes('/ship'), 'the body names its own token')
})

test('a project skill is created inside that project', () => {
  reset()
  const app = repoDir()
  const made = skills.createSkill('migrate', 'project', app)
  assert.equal(made.file, join(app, '.floe', 'skills', 'migrate.md'))
  assert.deepEqual(skills.listSkills(app).map((s) => s.name), ['migrate'])
  assert.deepEqual(skills.listSkills().map((s) => s.name), [], 'and nowhere else')
})

test('a project skill needs a project', () => {
  reset()
  assert.throws(() => skills.createSkill('migrate', 'project'), /no project/)
})

test('names that could not be typed after a slash are refused', () => {
  reset()
  for (const bad of ['', 'two words', 'has/slash', '-leading', 'dot.name']) {
    assert.throws(() => skills.createSkill(bad, 'global'), /not a skill name/)
  }
  assert.deepEqual(skills.listSkills(), [])
})

test('creating a name that is taken is refused rather than overwriting it', () => {
  reset()
  skill(skills.globalSkillsDir(), 'deploy', 'mine, do not lose this')
  assert.throws(() => skills.createSkill('deploy', 'global'), /already exists/)
  assert.equal(skills.readSkill('deploy'), 'mine, do not lose this')
})

test('renaming moves the file and rewrites the frontmatter name', () => {
  reset()
  skill(skills.globalSkillsDir(), 'old', 'body', 'name: old\ndescription: Ship it')
  const renamed = skills.renameSkill('old', 'new')
  assert.equal(renamed.name, 'new')
  assert.equal(renamed.file, join(skills.globalSkillsDir(), 'new.md'))
  assert.deepEqual(skills.listSkills().map((s) => s.name), ['new'], 'the token follows the file')
  assert.equal(skills.listSkills()[0].description, 'Ship it', 'and nothing else changed')
  assert.equal(skills.readSkill('new'), 'body')
})

test('renaming a skill with no frontmatter just moves the file', () => {
  reset()
  skill(skills.globalSkillsDir(), 'old', 'body')
  skills.renameSkill('old', 'new')
  assert.deepEqual(skills.listSkills().map((s) => s.name), ['new'])
})

test('renaming a bundled skill carries its directory, reference files and all', () => {
  reset()
  const dir = join(skills.globalSkillsDir(), 'deploy')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: deploy\n---\n\nCut a release.')
  writeFileSync(join(dir, 'checklist.md'), 'sign it')
  const renamed = skills.renameSkill('deploy', 'release')
  assert.equal(renamed.file, join(skills.globalSkillsDir(), 'release', 'SKILL.md'))
  assert.deepEqual(skills.listSkills().map((s) => s.name), ['release'])
  assert.equal(readFileSync(join(skills.globalSkillsDir(), 'release', 'checklist.md'), 'utf8'), 'sign it')
})

test('renaming onto a name that exists is refused', () => {
  reset()
  skill(skills.globalSkillsDir(), 'a', 'first')
  skill(skills.globalSkillsDir(), 'b', 'second')
  assert.throws(() => skills.renameSkill('a', 'b'), /already exists/)
  assert.equal(skills.readSkill('b'), 'second')
})

test('deleting removes the file, and a bundled skill its whole directory', () => {
  reset()
  skill(skills.globalSkillsDir(), 'plain', 'x')
  const dir = join(skills.globalSkillsDir(), 'bundle')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), 'y')
  writeFileSync(join(dir, 'ref.md'), 'z')

  skills.deleteSkill('plain')
  assert.deepEqual(skills.listSkills().map((s) => s.name), ['bundle'])
  skills.deleteSkill('bundle')
  assert.deepEqual(skills.listSkills(), [])
  assert.ok(existsSync(skills.globalSkillsDir()), 'the skills directory itself stays')
})

test('the project copy is what a project-scoped delete removes', () => {
  reset()
  const app = repoDir()
  skill(skills.globalSkillsDir(), 'deploy', 'the generic one')
  skill(skills.projectSkillsDir(app), 'deploy', 'the local one')
  skills.deleteSkill('deploy', app)
  assert.equal(skills.readSkill('deploy', app), 'the generic one', 'the global one falls back in')
})

test('acting on a skill that is not there says so', () => {
  reset()
  assert.throws(() => skills.deleteSkill('ghost'), /no skill called/)
  assert.throws(() => skills.renameSkill('ghost', 'other'), /no skill called/)
})

/* --- built-ins ------------------------------------------------------------ */

test("Floe's own skills are written on boot and read back as builtin", () => {
  reset()
  skills.ensureBuiltinSkills()
  const list = skills.listSkills()
  assert.ok(list.length > 0, 'BUILTIN_SKILLS is not empty')
  assert.ok(list.every((s) => s.scope === 'builtin'))
  const setup = list.find((s) => s.name === 'setup-commands')
  assert.ok(setup, 'the commands skill ships')
  assert.ok(skills.readSkill('setup-commands')?.includes('add_project_command'))
})

test('rewriting on the next boot is a no-op when nothing changed', () => {
  reset()
  skills.ensureBuiltinSkills()
  const file = join(skills.builtinSkillsDir(), 'setup-commands.md')
  const before = statSync(file).mtimeMs
  skills.ensureBuiltinSkills()
  assert.equal(statSync(file).mtimeMs, before, 'an identical file is left alone — the watcher would repaint')
})

test('a hand-edited built-in is put back, because the directory is Floe\'s', () => {
  reset()
  skills.ensureBuiltinSkills()
  const file = join(skills.builtinSkillsDir(), 'setup-commands.md')
  writeFileSync(file, 'mine now')
  skills.ensureBuiltinSkills()
  assert.notEqual(readFileSync(file, 'utf8'), 'mine now')
})

test('a built-in Floe no longer ships is removed rather than left behind', () => {
  reset()
  skills.ensureBuiltinSkills()
  const stale = join(skills.builtinSkillsDir(), 'retired.md')
  writeFileSync(stale, 'from an older version')
  skills.ensureBuiltinSkills()
  assert.ok(!existsSync(stale))
})

test('a global skill of the same name shadows a built-in', () => {
  reset()
  skills.ensureBuiltinSkills()
  skill(skills.globalSkillsDir(), 'setup-commands', 'my own version')
  const found = skills.listSkills().find((s) => s.name === 'setup-commands')
  assert.equal(found?.scope, 'global')
  assert.equal(skills.readSkill('setup-commands'), 'my own version')
})

test('a built-in cannot be written to — the next boot would undo it', () => {
  reset()
  skills.ensureBuiltinSkills()
  assert.throws(() => skills.updateSkill('setup-commands', 'x'), /built-in/)
  assert.throws(() => skills.renameSkill('setup-commands', 'other'), /built-in/)
  assert.throws(() => skills.deleteSkill('setup-commands'), /built-in/)
  assert.ok(existsSync(join(skills.builtinSkillsDir(), 'setup-commands.md')))
})

test('shadowing a built-in is what writing to it means', () => {
  reset()
  skills.ensureBuiltinSkills()
  const made = skills.createSkill('setup-commands', 'global')
  assert.equal(made.file, join(skills.globalSkillsDir(), 'setup-commands.md'))
  skills.updateSkill('setup-commands', 'mine')
  assert.equal(skills.readSkill('setup-commands'), 'mine', 'the copy is what the write lands on')
})

/** A harness skill as Claude and Codex keep one: `<rel>/<name>/SKILL.md`. */
function bundle(repo: string, rel: string, name: string, body: string): void {
  const dir = join(repo, rel, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n\n${body}`)
}

test('import copies every harness skill into .floe/skills, bundled files included', () => {
  reset()
  const repo = mkdtempSync(join(tmpdir(), 'floe-repo-'))
  bundle(repo, '.claude/skills', 'deploy', 'Ship it.')
  writeFileSync(join(repo, '.claude/skills/deploy/checklist.md'), 'one')
  bundle(repo, '.codex/skills', 'review', 'Look closely.')
  const out = skills.importSkills(repo)
  assert.deepEqual(out.imported.map((s) => s.name).sort(), ['deploy', 'review'])
  assert.deepEqual(out.skipped, [])
  assert.ok(existsSync(join(skills.projectSkillsDir(repo), 'deploy', 'checklist.md')))
  assert.equal(skills.readSkill('review', repo), 'Look closely.')
})

test('import never overwrites a Floe skill, and the first harness keeps a shared name', () => {
  reset()
  const repo = mkdtempSync(join(tmpdir(), 'floe-repo-'))
  skill(skills.globalSkillsDir(), 'deploy', 'Floe version')
  bundle(repo, '.claude/skills', 'deploy', 'Claude version')
  bundle(repo, '.claude/skills', 'review', 'Claude review')
  bundle(repo, '.codex/skills', 'review', 'Codex review')
  const out = skills.importSkills(repo)
  assert.deepEqual(out.imported.map((s) => s.name), ['review'])
  assert.deepEqual(out.skipped.map((s) => s.name).sort(), ['deploy', 'review'])
  assert.equal(skills.readSkill('deploy', repo), 'Floe version')
  assert.equal(skills.readSkill('review', repo), 'Claude review')
  assert.equal(skills.importSkills(repo).imported.length, 0, 'a second import is a no-op')
})

test('import with no harness skills imports nothing', () => {
  reset()
  const repo = mkdtempSync(join(tmpdir(), 'floe-repo-'))
  assert.deepEqual(skills.importSkills(repo), { imported: [], skipped: [] })
  assert.ok(!existsSync(skills.projectSkillsDir(repo)), 'no empty directory left behind')
})

test('a global skill is starred in floe.toml, and unstarred back out of it', () => {
  reset()
  skill(skills.globalSkillsDir(), 'deploy', 'Cut a release.')
  skill(skills.globalSkillsDir(), 'review', 'Read the branch.')

  const starred = skills.setSkillFavorite('deploy', true)
  assert.deepEqual(starred.filter((s) => s.favorite).map((s) => s.name), ['deploy'])
  assert.ok(readFileSync(floe.floeConfigPath(), 'utf8').includes('deploy'))

  const off = skills.setSkillFavorite('deploy', false)
  assert.deepEqual(off.filter((s) => s.favorite).map((s) => s.name), [], 'the star is gone')
})

test("a project skill is starred in the repository's own config, not the global one", () => {
  reset()
  const app = repoDir()
  projects.createProject(app)
  skill(skills.projectSkillsDir(app), 'migrate', 'Run the migration.')

  const list = skills.setSkillFavorite('migrate', true, app)
  assert.deepEqual(list.filter((s) => s.favorite).map((s) => s.name), ['migrate'])
  const repoConfig = readFileSync(join(app, '.floe', 'config.toml'), 'utf8')
  assert.ok(repoConfig.includes('migrate'), 'the star travels with the repository')
  // The global file is either absent or has nothing to say about this name.
  const global = existsSync(floe.floeConfigPath()) ? readFileSync(floe.floeConfigPath(), 'utf8') : ''
  assert.ok(!global.includes('migrate'))

  assert.deepEqual(skills.listSkills().map((s) => s.name), [], 'and only inside that project')
})

test('both files are read at once — a global star and a project star are one list', () => {
  reset()
  const app = repoDir()
  projects.createProject(app)
  skill(skills.globalSkillsDir(), 'deploy', 'Cut a release.')
  skill(skills.projectSkillsDir(app), 'migrate', 'Run the migration.')
  skills.setSkillFavorite('deploy', true, app)
  skills.setSkillFavorite('migrate', true, app)
  assert.deepEqual(
    skills.listSkills(app).filter((s) => s.favorite).map((s) => s.name),
    ['deploy', 'migrate']
  )
})

test('starring a name that is not a skill is refused', () => {
  reset()
  assert.throws(() => skills.setSkillFavorite('nope', true), /nope/)
})
