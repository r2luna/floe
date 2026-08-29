import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHook } from './config/hook.test-helper.ts'

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'floe-cfg-'))
installHook()

const prompt = await import('./appSettings.ts')
const floe = await import('./config/floe.ts')
const { configDir } = await import('./dataDir.ts')

function reset(): void {
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'floe-cfg-'))
  floe.invalidateFloeConfig()
}

test('the generated file appends nothing — its header is comments only', () => {
  reset()
  prompt.ensureSystemPrompt()
  assert.ok(existsSync(prompt.systemPromptPath()))
  assert.equal(prompt.getSystemPrompt(), '')
})

test('prose below the header is what every session gets', () => {
  reset()
  prompt.ensureSystemPrompt()
  const file = prompt.systemPromptPath()
  writeFileSync(file, readFileSync(file, 'utf8') + '\nAnswer in Portuguese.\n')
  assert.equal(prompt.getSystemPrompt(), 'Answer in Portuguese.')
})

test('no file means no prompt, not a throw', () => {
  reset()
  assert.equal(prompt.getSystemPrompt(), '')
})

test('the file follows `[agent] system-prompt`', () => {
  reset()
  writeFileSync(floe.floeConfigPath(), '[agent]\nsystem-prompt = "shared.md"\n')
  floe.invalidateFloeConfig()
  prompt.setSystemPrompt('Be terse.')
  assert.ok(prompt.systemPromptPath().endsWith('shared.md'))
  assert.equal(prompt.getSystemPrompt(), 'Be terse.')
})

test('a path pointing outside the config dir falls back to the default', () => {
  reset()
  const elsewhere = join(mkdtempSync(join(tmpdir(), 'floe-prompt-')), 'mine.md')
  writeFileSync(floe.floeConfigPath(), `[agent]\nsystem-prompt = "${elsewhere}"\n`)
  floe.invalidateFloeConfig()
  prompt.ensureSystemPrompt()
  assert.equal(existsSync(elsewhere), false)
  assert.equal(prompt.systemPromptPath(), join(configDir(), 'system-prompt.md'))
})

test('`../` cannot climb out of the config dir either', () => {
  reset()
  writeFileSync(floe.floeConfigPath(), '[agent]\nsystem-prompt = "../../escaped.md"\n')
  floe.invalidateFloeConfig()
  assert.equal(prompt.systemPromptPath(), join(configDir(), 'system-prompt.md'))
})

test('a subdirectory inside the config dir is honoured', () => {
  reset()
  writeFileSync(floe.floeConfigPath(), '[agent]\nsystem-prompt = "prompts/mine.md"\n')
  floe.invalidateFloeConfig()
  prompt.setSystemPrompt('Be terse.')
  assert.equal(prompt.systemPromptPath(), join(configDir(), 'prompts', 'mine.md'))
  assert.equal(prompt.getSystemPrompt(), 'Be terse.')
})
