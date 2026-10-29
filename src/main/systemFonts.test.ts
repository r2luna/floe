import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listSystemFonts, parseFcList, parseMacFonts, sortFonts } from './systemFonts.ts'

test('parseMacFonts reads the M/P mark and skips blank lines', () => {
  assert.deepEqual(parseMacFonts('M\tMenlo\nP\tHelvetica\n\nP\t \n'), [
    { family: 'Menlo', mono: true },
    { family: 'Helvetica', mono: false }
  ])
})

test('parseFcList folds faces into families and counts dual width as mono', () => {
  const out = 'DejaVu Sans\t\nDejaVu Sans Mono\t100\nDejaVu Sans Mono\t100\nNoto Sans Mono CJK\t90\nFoo\t\nFoo\t100\n\n'
  assert.deepEqual(parseFcList(out), [
    { family: 'DejaVu Sans', mono: false },
    { family: 'DejaVu Sans Mono', mono: true },
    { family: 'Noto Sans Mono CJK', mono: true },
    { family: 'Foo', mono: true }
  ])
})

test('sortFonts puts mono first, trusts mono-sounding names and drops duplicates', () => {
  const sorted = sortFonts([
    { family: 'Helvetica', mono: false },
    { family: 'Menlo', mono: true },
    { family: 'Dank Mono', mono: false },
    { family: 'FiraCode Nerd Font', mono: false },
    { family: 'Arial', mono: false },
    { family: 'Arial Unicode MS', mono: false },
    { family: 'FiraCode Nerd Font Propo', mono: false },
    { family: 'Menlo', mono: true }
  ])
  assert.deepEqual(
    sorted.map((f) => `${f.mono ? 'M' : 'P'} ${f.family}`),
    [
      'M Dank Mono',
      'M FiraCode Nerd Font',
      'M Menlo',
      'P Arial',
      'P Arial Unicode MS',
      'P FiraCode Nerd Font Propo',
      'P Helvetica'
    ]
  )
})

test('listSystemFonts asks the right tool per platform', async () => {
  const calls: string[] = []
  const exec = async (cmd: string): Promise<string> => {
    calls.push(cmd)
    return cmd === 'osascript' ? 'P\tArial\nM\tMenlo' : 'Arial\t\nHack\t100\n'
  }
  assert.deepEqual(await listSystemFonts('darwin', exec), [
    { family: 'Menlo', mono: true },
    { family: 'Arial', mono: false }
  ])
  assert.deepEqual(await listSystemFonts('linux', exec), [
    { family: 'Hack', mono: true },
    { family: 'Arial', mono: false }
  ])
  assert.deepEqual(await listSystemFonts('win32', exec), [])
  assert.deepEqual(calls, ['osascript', 'fc-list'])
})

test('listSystemFonts is empty when the tool fails', async () => {
  const exec = async (): Promise<string> => {
    throw new Error('fc-list: not found')
  }
  assert.deepEqual(await listSystemFonts('linux', exec), [])
})
