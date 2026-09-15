import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { COLONY_SKILLS } from './colonySkills.ts'

const LANES = ['colony-specify', 'colony-implement', 'colony-refactor', 'colony-architecture', 'colony-review', 'colony-verify']
const text = (name: string): string => {
  const skill = COLONY_SKILLS.find((s) => s.name === name)
  assert.ok(skill, `${name} ships`)
  return skill.text
}

test('colony-feature ships beside the lanes, the nanny and the interview', () => {
  assert.deepEqual(
    COLONY_SKILLS.map((s) => s.name),
    [...LANES, 'colony-nanny', 'colony-add-task', 'colony-feature']
  )
  assert.match(text('colony-feature'), /^---\nname: colony-feature\n/)
})

test('every lane inherits the contract, base and autonomy rules included', () => {
  for (const lane of LANES) {
    const body = text(lane)
    assert.match(body, /FRESH SESSION:/, lane)
    assert.match(body, /BASE: the prompt's `Base:` line/, lane)
    assert.match(body, /AUTONOMOUS BOARD: when the prompt carries that line/, lane)
    assert.doesNotMatch(body, /merge-base with the default branch/, `${lane} diffs against the task's base`)
  }
})

test('every Floe MCP tool a colony skill names is a tool the server registers', () => {
  const server = readFileSync(new URL('../mcpServer.ts', import.meta.url), 'utf8')
  for (const name of ['colony-nanny', 'colony-add-task', 'colony-feature']) {
    const named = new Set(text(name).match(/\b(?:colony_[a-z_]+|create_followup|list_followups|cancel_followup|open_browser|create_session|read_session_output|create_worktree)\b/g) ?? [])
    assert.ok(named.size > 0, `${name} names tools`)
    for (const tool of named) assert.ok(server.includes(`'${tool}',`), `${name} names ${tool}, which does not exist`)
  }
})

test('the specs drafts and the shipped skills say the same thing', () => {
  const draft = (file: string): string => readFileSync(new URL(`../../../specs/colony/skills/${file}`, import.meta.url), 'utf8')
  assert.equal(text('colony-feature'), draft('colony-feature.md'))
  assert.equal(text('colony-add-task').trimEnd(), draft('colony-add-task.md').trimEnd())
})
