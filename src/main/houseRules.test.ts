import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHook } from './config/hook.test-helper.ts'

installHook()

const config = mkdtempSync(join(tmpdir(), 'floe-rules-'))
process.env.XDG_CONFIG_HOME = config
process.env.FLOE_TEST_USERDATA = config
const promptFile = join(config, 'floe', 'system-prompt.md')
mkdirSync(join(config, 'floe'), { recursive: true })

const { houseRulesFor, forgetHouseRules } = await import('./houseRules.ts')

test('no prompt file means nothing is prepended', () => {
  rmSync(promptFile, { force: true })
  assert.equal(houseRulesFor('s1', 'codex'), '')
})

test('the rules go once per thread, and again after a reset', () => {
  writeFileSync(promptFile, 'Answer in Portuguese.\n')
  const first = houseRulesFor('s2', 'codex')
  assert.match(first, /^<!-- floe:house-rules:v1 -->/)
  assert.match(first, /Answer in Portuguese\./)
  assert.ok(first.endsWith('\n\n'), 'the block ends clear of whatever follows it')

  assert.equal(houseRulesFor('s2', 'codex'), '', 'the thread has them already')
  // Another harness in the same session is another thread: it has not seen them.
  assert.notEqual(houseRulesFor('s2', 'opencode'), '')

  forgetHouseRules('s2', 'codex')
  assert.notEqual(houseRulesFor('s2', 'codex'), '')
  forgetHouseRules('s2')
  assert.notEqual(houseRulesFor('s2', 'opencode'), '')
})

test('Claude gets nothing here — it takes the same text as a system prompt', () => {
  // agent.ts passes --append-system-prompt. Sending it as a message too would
  // be the instructions twice, once in a form Claude could read as the user
  // talking.
  writeFileSync(promptFile, 'Answer in Portuguese.\n')
  assert.equal(houseRulesFor('s3', 'claude'), '')
})
