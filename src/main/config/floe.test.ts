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
  assert.equal(config.appearance.theme, 'system')
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
  const raw = '[appearance]\ntheme = "light"\nfont-size = "big"\n'
  const { config, errors } = parseFloeConfig(raw, 'floe.toml')
  assert.equal(config.appearance.fontSize, 13)
  assert.equal(config.appearance.theme, 'light', 'the good value next to it still applies')
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

test('theme takes only the two themes and system, and names them when it does not', () => {
  const { config, errors } = parseFloeConfig('[appearance]\ntheme = "omarchy"\n', 'floe.toml')
  assert.equal(config.appearance.theme, 'system', 'an unknown theme falls back to following the OS')
  assert.match(errors[0].reason, /system, dark, light/)
})

test('penguin picks one of the known heads, and defaults to the original', () => {
  const picked = parseFloeConfig('[appearance]\npenguin = "ninja"\n', 'floe.toml')
  assert.equal(picked.config.appearance.penguin, 'ninja')
  assert.equal(picked.errors.length, 0)

  const unknown = parseFloeConfig('[appearance]\npenguin = "pigeon"\n', 'floe.toml')
  assert.equal(unknown.config.appearance.penguin, 'classic', 'an unknown head falls back to the original')
  assert.match(unknown.errors[0].reason, /classic/)
})

test('penguin-color takes only the named tones', () => {
  const picked = parseFloeConfig('[appearance]\npenguin-color = "ice"\n', 'floe.toml')
  assert.equal(picked.config.appearance.penguinColor, 'ice')
  assert.equal(picked.errors.length, 0)

  const unknown = parseFloeConfig('[appearance]\npenguin-color = "chartreuse"\n', 'floe.toml')
  assert.equal(unknown.config.appearance.penguinColor, 'accent', 'an unknown tone falls back to the accent')
})

test('chat-layout takes only the known layouts, and defaults to classic', () => {
  const picked = parseFloeConfig('[appearance]\nchat-layout = "gutter"\n', 'floe.toml')
  assert.equal(picked.config.appearance.chatLayout, 'gutter')
  assert.equal(picked.errors.length, 0)

  // A layout the stylesheet has no rules for would render as `classic` anyway;
  // falling back to it explicitly is what puts the typo in Settings' error list
  // instead of leaving the user staring at a setting that did nothing.
  const unknown = parseFloeConfig('[appearance]\nchat-layout = "bubbles"\n', 'floe.toml')
  assert.equal(unknown.config.appearance.chatLayout, 'classic')
  assert.match(unknown.errors[0].reason, /classic/)

  const absent = parseFloeConfig('', 'floe.toml')
  assert.equal(absent.config.appearance.chatLayout, 'classic', 'an old file keeps the log it had')
})

test('transparency names the themes that get glass, and defaults to off', () => {
  const dark = parseFloeConfig('[appearance]\ntransparency = "dark"\n', 'floe.toml')
  assert.equal(dark.config.appearance.transparency, 'dark')
  assert.equal(dark.errors.length, 0)

  const both = parseFloeConfig('[appearance]\ntransparency = "all"\n', 'floe.toml')
  assert.equal(both.config.appearance.transparency, 'all')

  // `true` was never a value here — the choice is per theme, and a boolean that
  // silently meant "all" would glass a light theme nobody asked to glass.
  const bool = parseFloeConfig('[appearance]\ntransparency = true\n', 'floe.toml')
  assert.equal(bool.config.appearance.transparency, 'off')
  assert.equal(bool.errors.length, 1)

  const absent = parseFloeConfig('', 'floe.toml')
  assert.equal(absent.config.appearance.transparency, 'off', 'an existing app stays solid')
})

test('transparency-amount is clamped to what stays readable', () => {
  const set = parseFloeConfig('[appearance]\ntransparency-amount = 35\n', 'floe.toml')
  assert.equal(set.config.appearance.transparencyAmount, 35)
  assert.equal(set.errors.length, 0)

  // The slider stops at 60 and so does the file: past that the wallpaper reads
  // through the text, which is not a preference, it is an unusable window.
  const wild = parseFloeConfig('[appearance]\ntransparency-amount = 95\n', 'floe.toml')
  assert.equal(wild.config.appearance.transparencyAmount, 18)
  assert.equal(wild.errors.length, 1)
})

test('notification sound takes only the known sounds, off included', () => {
  const picked = parseFloeConfig('[notifications]\nsound = "tada"\n', 'floe.toml')
  assert.equal(picked.config.notifications.sound, 'tada')
  assert.equal(picked.errors.length, 0)

  const off = parseFloeConfig('[notifications]\nsound = "off"\n', 'floe.toml')
  assert.equal(off.config.notifications.sound, 'off')

  const unknown = parseFloeConfig('[notifications]\nsound = "airhorn"\n', 'floe.toml')
  assert.equal(unknown.config.notifications.sound, 'chime', 'an unknown sound falls back to the default')
  assert.match(unknown.errors[0].reason, /off, chime, ping/)
})

test('the greeting name is optional, and blank means "use the machine\'s"', () => {
  assert.equal(parseFloeConfig('', 'floe.toml').config.user.name, undefined)
  assert.equal(parseFloeConfig('[user]\nname = "Ada"\n', 'floe.toml').config.user.name, 'Ada')
  assert.equal(
    parseFloeConfig('[user]\nname = "   "\n', 'floe.toml').config.user.name,
    undefined,
    'an emptied box is the same as never having set one'
  )
})

test('a harness block says what that harness answers with', () => {
  const raw = '[harness.codex]\nmodel = "gpt-5.6-sol"\neffort = "xhigh"\n\n[harness.lmstudio]\nmodel = "qwen/qwen3.6-35b-a3b"\n'
  const { config, errors } = parseFloeConfig(raw, 'floe.toml')
  assert.deepEqual(errors, [])
  assert.deepEqual(config.harness, {
    codex: { model: 'gpt-5.6-sol', effort: 'xhigh' },
    lmstudio: { model: 'qwen/qwen3.6-35b-a3b', effort: undefined }
  })
})

test('a block for something Floe cannot run is left alone, not read', () => {
  const { config, errors } = parseFloeConfig('[harness.kimi]\nmodel = "k2"\n', 'floe.toml')
  assert.deepEqual(errors, [])
  assert.deepEqual(config.harness, {})
})

test('a bad effort under a harness points at its own dotted table', () => {
  const raw = '[agent]\nmodel = "opus"\n\n[harness.codex]\nmodel  = "gpt-5.6-sol"\neffort = "turbo"\n'
  const { config, errors } = parseFloeConfig(raw, 'floe.toml')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].line, 6)
  // The bad half falls back; the good half still stands.
  assert.deepEqual(config.harness.codex, { model: 'gpt-5.6-sol', effort: undefined })
})

test('an empty harness block is the same as no block', () => {
  const { config } = parseFloeConfig('[harness.codex]\n', 'floe.toml')
  assert.deepEqual(config.harness, {})
})

test('an emptied effort reads as unset, not as a bad value', () => {
  // How Settings says "go back to the picker's": it can write a value, never
  // delete a line.
  const { config, errors } = parseFloeConfig('[harness.codex]\nmodel  = "gpt-5.6-sol"\neffort = ""\n', 'floe.toml')
  assert.deepEqual(errors, [])
  assert.deepEqual(config.harness.codex, { model: 'gpt-5.6-sol', effort: undefined })
})
