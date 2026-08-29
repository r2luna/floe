import test from 'node:test'
import assert from 'node:assert/strict'
import { editToml, formatValue, parseToml } from './toml.ts'

const DOC = `# ==============================================================================
#  Floe
# ==============================================================================

# ------------------------------------------------------------------------------
# | Appearance
# ------------------------------------------------------------------------------
# |
# | The interface font and theme.
# |
# ------------------------------------------------------------------------------

[appearance]
font-family = "CommitMonoPinguim"
font-size   = 13
theme       = "omarchy"

[sandbox]
enabled = true
`

test('set: replaces a value and leaves every comment and blank line alone', () => {
  const out = editToml(DOC, [{ op: 'set', table: 'appearance', key: 'font-size', value: 15 }])
  assert.match(out, /font-size {3}= 15/)
  assert.equal(out.split('\n').length, DOC.split('\n').length)
  assert.ok(out.includes('# | The interface font and theme.'))
  assert.ok(out.includes('font-family = "CommitMonoPinguim"'))
})

test('set: keeps the alignment padding of the line it rewrites', () => {
  const out = editToml(DOC, [{ op: 'set', table: 'appearance', key: 'theme', value: 'carbon' }])
  assert.ok(out.includes('theme       = "carbon"'))
})

test('set: a key the table lacks is appended, aligned with its neighbours', () => {
  const out = editToml(DOC, [{ op: 'set', table: 'sandbox', key: 'strict', value: false }])
  assert.match(out, /\[sandbox]\nenabled = true\nstrict {2}= false/)
})

test('set: a table the document lacks is appended whole', () => {
  const out = editToml(DOC, [{ op: 'set', table: 'update', key: 'check-interval-hours', value: 6 }])
  assert.match(out, /\[update]\ncheck-interval-hours = 6/)
  assert.ok(parseToml<{ update: { 'check-interval-hours': number } }>(out).ok)
})

test('set: writes to the root table when no table is named', () => {
  const doc = 'path  = "~/code/a"\ngroup = "DEV"\n\n[env]\nphp = "8.4"\n'
  const out = editToml(doc, [{ op: 'set', key: 'group', value: 'OPS' }])
  assert.ok(out.includes('group = "OPS"'))
  assert.ok(out.includes('php = "8.4"'))
})

test('set: a trailing comment survives the value it annotates being replaced', () => {
  const doc = '[a]\nkey = 1  # why this number\n'
  const out = editToml(doc, [{ op: 'set', table: 'a', key: 'key', value: 2 }])
  assert.equal(out, '[a]\nkey = 2  # why this number\n')
})

test('set: a `#` inside a string is not mistaken for a comment', () => {
  const doc = '[a]\ncommand = "grep \'#\' src"\nname = "x"\n'
  const out = editToml(doc, [{ op: 'set', table: 'a', key: 'name', value: 'y' }])
  assert.ok(out.includes(`command = "grep '#' src"`))
  assert.ok(out.includes('name = "y"'))
})

test('set: rewrites an array that spans several lines as one line', () => {
  const doc = '[a]\nwatch = [\n  "database/migrations",\n  "config"\n]\nname = "x"\n'
  const out = editToml(doc, [{ op: 'set', table: 'a', key: 'watch', value: ['app'] }])
  assert.equal(out, '[a]\nwatch = ["app"]\nname = "x"\n')
})

test('set: a key whose name is a prefix of another is not confused for it', () => {
  const doc = '[a]\nauto-start = true\nauto-restart = false\n'
  const out = editToml(doc, [{ op: 'set', table: 'a', key: 'auto-start', value: false }])
  assert.equal(out, '[a]\nauto-start = false\nauto-restart = false\n')
})

test('set: a `[header]` inside a multi-line string does not retarget the write', () => {
  const doc = '[a]\nnote = """\n[b]\nkey = "trap"\n"""\nkey = "real"\n'
  const out = editToml(doc, [{ op: 'set', table: 'a', key: 'key', value: 'set' }])
  assert.ok(out.includes('key = "trap"'), 'the string body is untouched')
  assert.ok(out.includes('key = "set"'))
})

test('unset: removes the line, and nothing else', () => {
  const out = editToml(DOC, [{ op: 'unset', table: 'appearance', key: 'theme' }])
  assert.ok(!/^theme\s*=/m.test(out))
  assert.ok(out.includes('font and theme.'), 'the comment that mentions it is not touched')
  assert.ok(out.includes('font-size   = 13'))
})

test('unset: a key that was never there is a no-op', () => {
  assert.equal(editToml(DOC, [{ op: 'unset', table: 'appearance', key: 'nope' }]), DOC)
})

const COMMANDS = `# Commands for this project.

[[command]]
name       = "Scheduler"
command    = "php artisan schedule:work"
auto-start = true

[[command]]
name    = "Queue"
command = "php artisan queue:work"
`

test('appendEntry: adds an entry after the last one, keeping the blank line between', () => {
  const out = editToml(COMMANDS, [
    { op: 'appendEntry', table: 'command', fields: [['name', 'Dev'], ['command', 'pnpm run dev']] }
  ])
  const parsed = parseToml<{ command: { name: string }[] }>(out)
  assert.ok(parsed.ok)
  assert.deepEqual(parsed.ok && parsed.value.command.map((c) => c.name), ['Scheduler', 'Queue', 'Dev'])
  assert.ok(out.includes('name    = "Dev"'))
})

test('appendEntry: the first entry of a table that has none', () => {
  const out = editToml('# header only\n', [
    { op: 'appendEntry', table: 'command', fields: [['name', 'Dev']] }
  ])
  const parsed = parseToml<{ command: { name: string }[] }>(out)
  assert.ok(parsed.ok && parsed.value.command.length === 1)
  assert.ok(out.startsWith('# header only'))
})

test('setInEntry: edits one entry and leaves its siblings alone', () => {
  const out = editToml(COMMANDS, [{ op: 'setInEntry', table: 'command', index: 1, key: 'command', value: 'php artisan horizon' }])
  assert.ok(out.includes('command = "php artisan horizon"'))
  assert.ok(out.includes('command    = "php artisan schedule:work"'))
})

test('setInEntry: adds a missing key to that entry only', () => {
  const out = editToml(COMMANDS, [{ op: 'setInEntry', table: 'command', index: 1, key: 'auto-start', value: true }])
  const parsed = parseToml<{ command: Array<Record<string, unknown>> }>(out)
  assert.ok(parsed.ok)
  const cmds = parsed.ok ? (parsed.value.command as Array<Record<string, unknown>>) : []
  assert.equal(cmds[1]['auto-start'], true)
  assert.equal(cmds[0]['auto-start'], true) // its own, untouched
})

test('removeEntry: drops the entry with its header and does not eat the file', () => {
  const out = editToml(COMMANDS, [{ op: 'removeEntry', table: 'command', index: 0 }])
  const parsed = parseToml<{ command: { name: string }[] }>(out)
  assert.ok(parsed.ok)
  assert.deepEqual(parsed.ok && parsed.value.command.map((c) => c.name), ['Queue'])
  assert.ok(out.startsWith('# Commands for this project.'), 'the file comment survives')
})

test('several edits in one call all land', () => {
  const out = editToml(DOC, [
    { op: 'set', table: 'appearance', key: 'font-size', value: 15 },
    { op: 'set', table: 'sandbox', key: 'enabled', value: false },
    { op: 'set', table: 'terminal', key: 'shell', value: '/bin/fish' }
  ])
  const parsed = parseToml<{ appearance: { 'font-size': number }; sandbox: { enabled: boolean }; terminal: { shell: string } }>(out)
  assert.ok(parsed.ok)
  if (!parsed.ok) return
  assert.equal(parsed.value.appearance['font-size'], 15)
  assert.equal(parsed.value.sandbox.enabled, false)
  assert.equal(parsed.value.terminal.shell, '/bin/fish')
})

test('CRLF files stay CRLF', () => {
  const out = editToml('[a]\r\nkey = 1\r\n', [{ op: 'set', table: 'a', key: 'key', value: 2 }])
  assert.equal(out, '[a]\r\nkey = 2\r\n')
})

test('parseToml: a broken file reports the line instead of throwing', () => {
  const res = parseToml('[a]\nkey = \n')
  assert.equal(res.ok, false)
  if (!res.ok) assert.equal(typeof res.error.line, 'number')
})

test('formatValue: strings are escaped, not concatenated blindly', () => {
  assert.equal(formatValue('say "hi"'), '"say \\"hi\\""')
  assert.equal(formatValue(['a', 'b']), '["a", "b"]')
  assert.equal(formatValue(true), 'true')
})
