import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OmarchyPalette } from '../shared/omarchyPalette.ts'
import { installHook } from './config/hook.test-helper.ts'
import { settle, waitFor } from './watch.test-helper.ts'

installHook()
const { followOmarchy, omarchyCurrentDir, readOmarchyPalette, watchOmarchyTheme } = await import('./omarchyTheme.ts')

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function fakeHome(): string {
  return mkdtempSync(join(tmpdir(), 'floe-omarchy-'))
}

function writeTheme(dir: string, colors: string, lightMode = false): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'colors.toml'), colors)
  if (lightMode) writeFileSync(join(dir, 'light.mode'), '')
}

const DARK = 'background = "#111111"\nforeground = "#eeeeee"\n'
const NEXT = 'background = "#222222"\nforeground = "#dddddd"\naccent = "#ff8800"\n'

const palette = (bg: string): OmarchyPalette =>
  ({ mode: 'dark', colors: { background: bg } }) as unknown as OmarchyPalette

test('no Omarchy install reads as no palette', () => {
  const home = fakeHome()
  assert.equal(readOmarchyPalette(home), null)
  rmSync(home, { recursive: true, force: true })
})

test('reads current/theme/colors.toml, honouring light.mode', () => {
  const home = fakeHome()
  const dir = join(omarchyCurrentDir(home), 'theme')
  writeTheme(dir, DARK, true)
  const p = readOmarchyPalette(home)
  assert.equal(p?.colors.background, '#111111')
  assert.equal(p?.mode, 'light')
  rmSync(home, { recursive: true, force: true })
})

test('a colors.toml that does not parse is no palette', () => {
  const home = fakeHome()
  writeTheme(join(omarchyCurrentDir(home), 'theme'), 'background = "#111111\n')
  assert.equal(readOmarchyPalette(home), null)
  rmSync(home, { recursive: true, force: true })
})

test('the remove-then-move gap is not reported as a removal', async () => {
  const reads: Array<OmarchyPalette | null> = [palette('#111111'), null, null, palette('#222222')]
  const seen: Array<OmarchyPalette | null> = []
  const f = followOmarchy(() => (reads.length > 1 ? reads.shift()! : reads[0]), (p) => seen.push(p), {
    debounceMs: 1,
    retries: 3,
    retryMs: 1
  })
  f.poke()
  await waitFor(() => seen.length > 0)
  await settle(() => seen.length)
  assert.deepEqual(seen, [palette('#222222')])
})

test('a file still missing after the retries is reported gone, once', async () => {
  let current: OmarchyPalette | null = palette('#111111')
  const seen: Array<OmarchyPalette | null> = []
  const f = followOmarchy(() => current, (p) => seen.push(p), { debounceMs: 1, retries: 2, retryMs: 1 })
  current = null
  f.poke()
  await waitFor(() => seen.length > 0)
  f.poke()
  await settle(() => seen.length, 100)
  assert.deepEqual(seen, [null])
})

test('an unchanged palette is not reported', async () => {
  const seen: Array<OmarchyPalette | null> = []
  const f = followOmarchy(() => palette('#111111'), (p) => seen.push(p), { debounceMs: 1 })
  f.poke()
  await wait(20)
  f.stop()
  assert.deepEqual(seen, [])
})

test('stop cancels a pending read', async () => {
  let reads = 0
  const f = followOmarchy(
    () => {
      reads++
      return palette(`#${String(reads).padStart(6, '0')}`)
    },
    () => assert.fail('reported after stop'),
    { debounceMs: 10 }
  )
  f.poke()
  f.stop()
  await wait(30)
  assert.equal(reads, 1)
})

test('without Omarchy there is nothing to watch', () => {
  const home = fakeHome()
  const stop = watchOmarchyTheme(() => assert.fail('no install, no change'), home)
  stop()
  rmSync(home, { recursive: true, force: true })
})

test('follows a real Omarchy-style swap of the theme directory', async () => {
  const home = fakeHome()
  const current = omarchyCurrentDir(home)
  writeTheme(join(current, 'theme'), DARK)
  const seen: Array<OmarchyPalette | null> = []
  const stop = watchOmarchyTheme((p) => seen.push(p), home, { debounceMs: 30, retries: 5, retryMs: 30 })
  await wait(50)

  writeTheme(join(current, 'next-theme'), NEXT)
  rmSync(join(current, 'theme'), { recursive: true, force: true })
  renameSync(join(current, 'next-theme'), join(current, 'theme'))

  await waitFor(() => seen.length > 0, 5_000, 'the swap to be reported')
  assert.equal(await settle(() => seen.length), 1)
  stop()
  assert.equal(seen[0]?.colors.accent, '#ff8800')
  rmSync(home, { recursive: true, force: true })
})
