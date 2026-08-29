import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
