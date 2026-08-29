import test from 'node:test'
import assert from 'node:assert/strict'
import { installHook } from './hook.test-helper.ts'

installHook()

const { parseFloeConfig, DEFAULTS } = await import('./floe.ts')
const { FLOE_TOML } = await import('./template.ts')

test('the generated template parses to exactly the documented defaults', () => {
  const { config, errors } = parseFloeConfig(FLOE_TOML, 'floe.toml')
  assert.deepEqual(errors, [])
  assert.equal(config.appearance.fontSize, 13)
  assert.equal(config.appearance.theme, 'omarchy')
  assert.equal(config.agent.model, 'opus')
  assert.equal(config.agent.effort, 'high')
  assert.equal(config.agent.provider, 'claude')
  assert.equal(config.sandbox.enabled, true)
  assert.equal(config.update.checkIntervalHours, 6)
  // Commented out in the template on purpose — absence means "use the login shell".
  assert.equal(config.terminal.shell, undefined)
})

test('an empty file is every default, and not an error', () => {
  const { config, errors } = parseFloeConfig('', 'floe.toml')
  assert.deepEqual(errors, [])
  assert.deepEqual(config, DEFAULTS)
})

test('a value outside the allowed set falls back and names the options', () => {
  const { config, errors } = parseFloeConfig('[agent]\nmodel = "gpt-4"\n', 'floe.toml')
  assert.equal(config.agent.model, 'opus')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].line, 2)
  assert.match(errors[0].reason, /fable, opus, sonnet, haiku/)
})

test('a value of the wrong type falls back and points at its line', () => {
  const raw = '[appearance]\ntheme = "carbon"\nfont-size = "big"\n'
  const { config, errors } = parseFloeConfig(raw, 'floe.toml')
  assert.equal(config.appearance.fontSize, 13)
  assert.equal(config.appearance.theme, 'carbon', 'the good value next to it still applies')
  assert.equal(errors[0].line, 3)
  assert.equal(errors[0].text, 'font-size = "big"')
})

test('a number out of range is rejected rather than clamped', () => {
  const { config, errors } = parseFloeConfig('[appearance]\nfont-size = 400\n', 'floe.toml')
  assert.equal(config.appearance.fontSize, 13)
  assert.match(errors[0].reason, /at most 48/)
})

test('a file that does not parse gives defaults and one error, not a throw', () => {
  const { config, errors } = parseFloeConfig('[agent\nmodel = "opus"\n', 'floe.toml')
  assert.deepEqual(config, DEFAULTS)
  assert.equal(errors.length, 1)
})

test('integrations read the non-secret half only', () => {
  const raw = '[integrations.jira]\nsite = "https://x.atlassian.net"\nemail = "a@b.c"\n'
  const { config } = parseFloeConfig(raw, 'floe.toml')
  assert.equal(config.integrations.jira.site, 'https://x.atlassian.net')
  assert.equal(config.integrations.jira.email, 'a@b.c')
})

test('several bad values are all reported, not just the first', () => {
  const raw = '[agent]\nmodel = "x"\neffort = "y"\nprovider = "z"\n'
  const { errors } = parseFloeConfig(raw, 'floe.toml')
  assert.equal(errors.length, 3)
  assert.deepEqual(errors.map((e) => e.line), [2, 3, 4])
})
