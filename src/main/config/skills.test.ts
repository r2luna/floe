import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHook } from './hook.test-helper.ts'

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'floe-cfg-'))
installHook()

const skills = await import('./skills.ts')
const projects = await import('./projectStore.ts')

function reset(): void {
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'floe-cfg-'))
  projects.invalidateProjects()
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

test('a project skill is offered only inside its project', () => {
  reset()
  const project = projects.createProject('/code/app')
  skill(join(project.dir, 'skills'), 'migrate', 'Run the migration.')
  assert.deepEqual(skills.listSkills('/code/app').map((s) => s.name), ['migrate'])
  assert.deepEqual(skills.listSkills().map((s) => s.name), [], 'not global')
  assert.deepEqual(skills.listSkills('/code/other').map((s) => s.name), [], 'not another project')
})

test('a project skill wins over a global one of the same name', () => {
  reset()
  const project = projects.createProject('/code/app')
  skill(skills.globalSkillsDir(), 'deploy', 'The generic one.')
  skill(join(project.dir, 'skills'), 'deploy', 'The one this repo needs.')
  assert.equal(skills.readSkill('deploy', '/code/app'), 'The one this repo needs.')
  assert.equal(skills.readSkill('deploy'), 'The generic one.')
  assert.equal(skills.listSkills('/code/app').length, 1, 'one token, one skill')
  assert.equal(skills.listSkills('/code/app')[0].scope, 'project')
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
  const project = projects.createProject('/code/app')
  const made = skills.createSkill('migrate', 'project', '/code/app')
  assert.equal(made.file, join(project.dir, 'skills', 'migrate.md'))
  assert.deepEqual(skills.listSkills('/code/app').map((s) => s.name), ['migrate'])
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
  const project = projects.createProject('/code/app')
  skill(skills.globalSkillsDir(), 'deploy', 'the generic one')
  skill(join(project.dir, 'skills'), 'deploy', 'the local one')
  skills.deleteSkill('deploy', '/code/app')
  assert.equal(skills.readSkill('deploy', '/code/app'), 'the generic one', 'the global one falls back in')
})

test('acting on a skill that is not there says so', () => {
  reset()
  assert.throws(() => skills.deleteSkill('ghost'), /no skill called/)
  assert.throws(() => skills.renameSkill('ghost', 'other'), /no skill called/)
})
