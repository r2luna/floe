import test from 'node:test'
import assert from 'node:assert/strict'
import {
  collapseSkills,
  expandSkills,
  hasSkill,
  skillsIn,
  splitSkills,
  wrapSkill
} from './skills.ts'

const bodies: Record<string, string> = {
  deploy: 'Cut a release.\nBump, sign, publish.',
  'code-review': 'Review the diff.'
}
const body = (name: string): string | null => bodies[name] ?? null

test('a known token expands to the skill text', () => {
  const out = expandSkills('/deploy', body)
  assert.ok(out.includes('Cut a release.'))
  assert.ok(out.startsWith('<floe-skill name="deploy">'))
})

test('an unknown token is left alone — it belongs to the harness', () => {
  // `/usage`, `/mcp`, `/login` are the CLI's own. Rewriting them would break
  // every command Floe does not know about.
  assert.equal(expandSkills('/usage', body), '/usage')
  assert.equal(expandSkills('run /login now', body), 'run /login now')
})

test('a path is not a token', () => {
  // The name has to match a skill exactly, or a project with a `bin` skill
  // would rewrite every `/usr/bin` anyone typed.
  assert.equal(expandSkills('see /usr/deploy for it', body), 'see /usr/deploy for it')
  assert.equal(expandSkills('read/deploy', body), 'read/deploy')
})

test('the words around a token survive', () => {
  const out = expandSkills('please /deploy the app', body)
  assert.ok(out.startsWith('please '))
  assert.ok(out.endsWith(' the app'))
})

test('two skills in one message stay two blocks', () => {
  const out = expandSkills('/deploy then /code-review', body)
  assert.deepEqual(skillsIn(out), ['deploy', 'code-review'])
  assert.ok(out.includes('Review the diff.'))
})

test('collapsing is the exact inverse of expanding, for reading', () => {
  for (const text of ['/deploy', 'please /deploy the app', '/deploy then /code-review']) {
    assert.equal(collapseSkills(expandSkills(text, body)), text, text)
  }
})

test('collapsing leaves a message that never held a skill untouched', () => {
  assert.equal(collapseSkills('just a message'), 'just a message')
  assert.equal(hasSkill('just a message'), false)
})

test('hasSkill spots an expansion, so a reader can skip the work', () => {
  assert.equal(hasSkill(wrapSkill('deploy', 'x')), true)
})

test('a body containing the closing tag cannot end the block early', () => {
  // Non-greedy matching stops at the FIRST close, so a skill that talks about
  // the marker would truncate. The name is what identifies the block, and the
  // collapse still yields the token — the failure is contained to that body.
  const out = collapseSkills(wrapSkill('deploy', 'text') + '\nafter')
  assert.equal(out, '/deploy\nafter')
})

test('an expansion with a multi-line body collapses to one token', () => {
  const out = expandSkills('/deploy', body)
  assert.ok(out.includes('\n'), 'the body really is multi-line')
  assert.equal(collapseSkills(out), '/deploy')
})

test('an expansion tells the model it was invoked, not merely handed text', () => {
  // Without this line the model reads a block of instructions as material it
  // was given and answers "I don't see a request here" — which is what a bare
  // `/setup-commands` did before the head existed.
  const out = expandSkills('/deploy', body)
  assert.ok(out.includes('The user invoked the /deploy skill'))
  assert.ok(out.includes('carry them out now'))
  assert.ok(out.includes('Cut a release.'))
})

const known = (name: string): boolean => name in bodies

test('a skill token splits out of the line around it', () => {
  assert.deepEqual(splitSkills('please /deploy the app', known), [
    { text: 'please ' },
    { skill: 'deploy' },
    { text: ' the app' }
  ])
})

test('splitting matches what expanding would have rewritten', () => {
  // Anything the expander left alone is not a skill and must not be drawn as
  // one: the harness's own commands, a path, a word with a slash in it.
  for (const text of ['/usage', 'see /usr/deploy for it', 'read/deploy', 'just a message'])
    assert.deepEqual(splitSkills(text, known), [{ text }], text)
})

test('two tokens in one line split into two pills', () => {
  assert.deepEqual(splitSkills('/deploy then /code-review', known), [
    { skill: 'deploy' },
    { text: ' then ' },
    { skill: 'code-review' }
  ])
})

test('a token alone is the whole message', () => {
  assert.deepEqual(splitSkills('/deploy', known), [{ skill: 'deploy' }])
})
