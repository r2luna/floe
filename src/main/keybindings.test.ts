import test from 'node:test'
import assert from 'node:assert/strict'
import { installHook } from './config/hook.test-helper.ts'

installHook()

const { generateKeybindings, parseKeybindings } = await import('./keybindings.ts')
const { DEFAULT_KEYMAP } = await import('../shared/defaultKeymap.ts')
const { compileKeymap, resolveIn } = await import('../shared/keymap.ts')

test('the generated file parses back into exactly the default keymap', () => {
  const { binds, errors } = parseKeybindings(generateKeybindings())
  assert.deepEqual(errors, [])
  assert.equal(binds.length, DEFAULT_KEYMAP.length)
  assert.deepEqual(
    binds.map((b) => `${b.key}|${b.command}|${b.arg ?? ''}|${b.when ?? ''}`),
    DEFAULT_KEYMAP.map((b) => `${b.key}|${b.command}|${b.arg ?? ''}|${b.when ?? ''}`)
  )
})

test('a keymap round-tripped through the file resolves keys identically', () => {
  const { binds } = parseKeybindings(generateKeybindings())
  const fromFile = compileKeymap(binds)
  const fromCode = compileKeymap(DEFAULT_KEYMAP)
  const presses = [
    [{ key: 'j', ctrl: true }, {}],
    [{ key: 'j', ctrl: true }, { stackDown: true }],
    [{ key: 'Escape' }, { typing: true }],
    [{ key: 'Escape' }, { selecting: true }],
    [{ key: 'c' }, { kind: 'diff', selecting: true }],
    [{ key: 'h' }, { kind: 'projects' }],
    [{ key: 'h' }, { kind: 'chat' }],
    [{ key: '3', meta: true }, {}],
    [{ key: 'g' }, { chord: true }],
    [{ key: 'G', shift: true }, {}]
  ] as const
  for (const [press, ctx] of presses) {
    assert.deepEqual(resolveIn(fromFile, press, ctx), resolveIn(fromCode, press, ctx), JSON.stringify(press))
  }
})

test('the unbound suggestions are commented out, not active', () => {
  const { binds } = parseKeybindings(generateKeybindings())
  assert.ok(!binds.some((b) => b.command === 'session.deleteAll'))
  assert.ok(generateKeybindings().includes('# command = "session.deleteAll"'))
})

test('an unknown command is reported with the line its key is on', () => {
  const { binds, errors } = parseKeybindings('[[keybind]]\nkey = "super+j"\ncommand = "not.a.command"\n')
  assert.deepEqual(binds, [])
  assert.equal(errors.length, 1)
  assert.equal(errors[0].line, 2)
  assert.match(errors[0].reason, /unknown command "not\.a\.command"/)
})

test('a when that does not compile is reported, naming what went wrong', () => {
  const { errors } = parseKeybindings('[[keybind]]\nkey = "v"\ncommand = "cursor.up"\nwhen = "panel is diff"\n')
  assert.equal(errors.length, 1)
  assert.match(errors[0].reason, /panel expects ==, != or in/)
})

test('a file that is not valid TOML reports the line, not a throw', () => {
  const { binds, errors } = parseKeybindings('[[keybind]\nkey = "j"\n')
  assert.deepEqual(binds, [])
  assert.equal(errors.length, 1)
})

test('chords are normalized, so shift+cmd+p and cmd+shift+p are one binding', () => {
  const { binds } = parseKeybindings('[[keybind]]\nkey = "shift+command+p"\ncommand = "palette.commands"\n')
  assert.equal(binds[0].key, 'super+shift+p')
})

test('an empty file is no bindings and no complaint', () => {
  assert.deepEqual(parseKeybindings('# just comments\n'), { binds: [], errors: [] })
})

test('every command id in the generated file is one the app can dispatch', async () => {
  const { COMMAND_ID_SET } = await import('../shared/commandIds.ts')
  for (const bind of DEFAULT_KEYMAP) {
    assert.ok(COMMAND_ID_SET.has(bind.command), `${bind.command} is bound but not registered`)
  }
})
