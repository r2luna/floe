import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { installMacUpdate, appBundlePath, bundleInside, macZipUrl, swapScript, type Tools } from './macUpdate.ts'

const run = promisify(execFile)

test('macZipUrl names the release asset electron-builder uploads', () => {
  assert.equal(
    macZipUrl('0.31.1', 'arm64'),
    'https://github.com/r2luna/floe/releases/download/v0.31.1/Floe-0.31.1-arm64-mac.zip'
  )
  assert.equal(
    macZipUrl('0.31.1', 'x64'),
    'https://github.com/r2luna/floe/releases/download/v0.31.1/Floe-0.31.1-mac.zip'
  )
})

test('appBundlePath finds the bundle, and answers null outside one', () => {
  assert.equal(appBundlePath('/Applications/Floe.app/Contents/MacOS/Floe'), '/Applications/Floe.app')
  assert.equal(appBundlePath('/Users/x/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    '/Users/x/node_modules/electron/dist/Electron.app')
  assert.equal(appBundlePath('/usr/local/bin/floe'), null)
})

const dirent = (name: string, directory = true) =>
  ({ name, isDirectory: () => directory }) as unknown as import('node:fs').Dirent

test('bundleInside picks the .app out of an unpacked archive', () => {
  assert.equal(bundleInside([dirent('__MACOSX'), dirent('Floe.app')]), 'Floe.app')
  assert.equal(bundleInside([dirent('Floe.app', false)]), null)
  assert.equal(bundleInside([]), null)
})

test('swapScript refuses a path that is not a bundle', () => {
  assert.throws(() => swapScript({ bundle: '/Applications', staged: '/tmp/Floe.app', pid: 1 }), /not an .app bundle/)
})

/**
 * The swap for real, on fake bundles: the script is the part that runs after
 * the app is gone, where a mistake costs the user their installed copy. `open`
 * and `xattr` are shadowed by a stub PATH so nothing launches.
 */
test('swapScript replaces the installed bundle and launches the new one', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'floe-swap-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  for (const name of ['open', 'xattr']) {
    writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> ${JSON.stringify(join(dir, 'calls.log'))}\n`, {
      mode: 0o755
    })
  }
  const bundle = join(dir, 'Floe.app')
  mkdirSync(join(bundle, 'Contents'), { recursive: true })
  writeFileSync(join(bundle, 'Contents', 'version'), 'old')
  const staged = join(dir, 'staged', 'Floe.app')
  mkdirSync(join(staged, 'Contents'), { recursive: true })
  writeFileSync(join(staged, 'Contents', 'version'), 'new')

  const script = join(dir, 'swap.sh')
  // pid 1 never exits, so the wait loop would spin: the exited pid of a process
  // that is really gone is what the app's own quit looks like from here.
  const gone = await run('bash', ['-c', 'exit 0 & echo $!']).then((r) => Number(r.stdout.trim()))
  writeFileSync(script, swapScript({ bundle, staged, pid: gone }), { mode: 0o755 })
  await run('bash', [script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` } })

  assert.equal(readFileSync(join(bundle, 'Contents', 'version'), 'utf8'), 'new')
  assert.equal((await readdir(dir)).includes('Floe.app.old'), false)
  const calls = readFileSync(join(dir, 'calls.log'), 'utf8')
  assert.match(calls, /xattr -dr com.apple.quarantine/)
  assert.match(calls, new RegExp(`open -n ${bundle}`))
})

function fakeTools(over: Partial<Tools> = {}): { tools: Tools; steps: string[] } {
  const steps: string[] = []
  const tools: Tools = {
    arch: 'arm64',
    execPath: '/Applications/Floe.app/Contents/MacOS/Floe',
    pid: 42,
    tempDir: '/tmp',
    download: async (url, file) => void steps.push(`download ${url} → ${file}`),
    unzip: async (zip, dir) => void steps.push(`unzip ${zip} → ${dir}`),
    readDir: async () => [dirent('Floe.app')],
    writable: async () => true,
    writeScript: async (file) => void steps.push(`script ${file}`),
    spawnDetached: (file) => steps.push(`spawn ${file}`),
    quit: () => steps.push('quit'),
    ...over
  }
  return { tools, steps }
}

test('installMacUpdate fetches, stages, then hands the swap over and quits', async () => {
  const { tools, steps } = fakeTools()
  await installMacUpdate('0.31.2', tools)
  assert.deepEqual(steps, [
    'download https://github.com/r2luna/floe/releases/download/v0.31.2/Floe-0.31.2-arm64-mac.zip → /tmp/Floe-0.31.2.zip',
    'unzip /tmp/Floe-0.31.2.zip → /tmp/Floe-0.31.2',
    'script /tmp/floe-swap-0.31.2.sh',
    'spawn /tmp/floe-swap-0.31.2.sh',
    'quit'
  ])
})

test('installMacUpdate refuses rather than half-swapping', async () => {
  const outside = fakeTools({ execPath: '/usr/local/bin/floe' })
  await assert.rejects(installMacUpdate('1.0.0', outside.tools), /not running from an .app bundle/)

  const readOnly = fakeTools({ writable: async () => false })
  await assert.rejects(installMacUpdate('1.0.0', readOnly.tools), /\/Applications is not writable/)
  assert.deepEqual(readOnly.steps, [])

  const empty = fakeTools({ readDir: async () => [] })
  await assert.rejects(installMacUpdate('1.0.0', empty.tools), /no .app bundle/)
  assert.equal(empty.steps.includes('quit'), false)
})
