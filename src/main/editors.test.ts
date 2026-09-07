import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHook } from './config/hook.test-helper.ts'

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'floe-editor-cfg-'))
installHook()

// Finding and launching an editor is `which` plus a stat of half a dozen
// directories, and the answer differs on every machine — worse, getting it
// right means actually opening VS Code. So editors.ts (and only editors.ts,
// so the config reader keeps the real fs) gets a filesystem and a
// child_process this test writes.
const g = globalThis as typeof globalThis & {
  __floeEditorFiles?: Set<string>
  __floeWhich?: (bin: string) => string
  __floeLaunches?: { bin: string; args: string[]; cwd?: string }[]
}
g.__floeEditorFiles = new Set()
g.__floeWhich = () => {
  throw new Error('not on PATH')
}
g.__floeLaunches = []

const hookSource = `
const FS = 'export function existsSync(p) { return globalThis.__floeEditorFiles.has(String(p)) }\\nexport default { existsSync };'
const CHILD = [
  'export function execFileSync(cmd, args) { return globalThis.__floeWhich(args[0], cmd) }',
  'export function execFile(bin, args, opts, cb) {',
  '  globalThis.__floeLaunches.push({ bin, args, cwd: opts && opts.cwd })',
  '  if (cb) cb(null, "", "")',
  '  return {}',
  '}',
  'export default { execFile, execFileSync };'
].join('\\n')
export async function resolve(specifier, context, next) {
  if ((context.parentURL ?? '').endsWith('/editors.ts')) {
    if (specifier === 'node:fs') return { url: 'stub:editorFs', shortCircuit: true, format: 'module' }
    if (specifier === 'node:child_process') return { url: 'stub:editorChild', shortCircuit: true, format: 'module' }
  }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (url === 'stub:editorFs') return { format: 'module', shortCircuit: true, source: FS }
  if (url === 'stub:editorChild') return { format: 'module', shortCircuit: true, source: CHILD }
  return next(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

const {
  KNOWN_EDITORS,
  editKeys,
  editorSpec,
  invalidateEditorCache,
  launchEditor,
  resolveEditorBin,
  spawnArgs
} = await import('./editors.ts')
const { floeConfigPath, invalidateFloeConfig } = await import('./config/floe.ts')

// A machine with nothing installed, no editor resolved yet, and the configured
// editor of the test's choosing.
function machine(opts: { files?: string[]; which?: string; command?: string } = {}): void {
  g.__floeEditorFiles = new Set(opts.files ?? [])
  g.__floeWhich = opts.which
    ? () => opts.which as string
    : () => {
        throw new Error('not on PATH')
      }
  g.__floeLaunches = []
  invalidateEditorCache()
  writeFileSync(floeConfigPath(), `[editor]\ncommand = "${opts.command ?? 'nvim'}"\n`)
  invalidateFloeConfig()
}

test('a known id resolves to its spec, by id or by binary name', () => {
  assert.equal(editorSpec('vscode').bin, 'code')
  assert.equal(editorSpec('code').id, 'vscode')
  assert.equal(editorSpec(' nvim ').id, 'nvim')
})

test('an unknown command is a terminal editor by that name', () => {
  const spec = editorSpec('micro')
  assert.deepEqual({ id: spec.id, bin: spec.bin, terminal: spec.terminal }, {
    id: 'micro',
    bin: 'micro',
    terminal: true
  })
})

test('only the GUI editors are launched outside the panel', () => {
  const terminal = KNOWN_EDITORS.filter((e) => e.terminal).map((e) => e.id)
  const gui = KNOWN_EDITORS.filter((e) => !e.terminal).map((e) => e.id)
  assert.deepEqual(terminal, ['nvim', 'vim', 'helix'])
  assert.deepEqual(gui, ['vscode', 'zed', 'sublime'])
})

test('GUI editors are aimed at the file and its line', () => {
  const code = editorSpec('vscode')
  assert.deepEqual(code.args?.('src/a.ts', 12), ['--goto', 'src/a.ts:12'])
  assert.deepEqual(code.args?.('src/a.ts', null), ['--goto', 'src/a.ts'])
  assert.deepEqual(editorSpec('zed').args?.('src/a.ts', 12), ['src/a.ts:12'])
  assert.deepEqual(editorSpec('sublime').args?.('src/a.ts', null), ['src/a.ts'])
})

test('a fresh vim-like is spawned on the line, with -- ending the options', () => {
  assert.deepEqual(spawnArgs(editorSpec('nvim'), 'src/a.ts', 12), ['+12', '--', 'src/a.ts'])
  assert.deepEqual(spawnArgs(editorSpec('nvim'), 'src/a.ts', null), ['--', 'src/a.ts'])
  // A file named like a flag cannot become one.
  assert.deepEqual(spawnArgs(editorSpec('nvim'), '-c', null), ['--', '-c'])
  // helix has no +line; the line rides in the path.
  assert.deepEqual(spawnArgs(editorSpec('helix'), 'src/a.ts', 12), ['--', 'src/a.ts:12'])
  // No file: the editor opens on nothing rather than on a stray argument.
  assert.deepEqual(spawnArgs(editorSpec('nvim'), null, 12), [])
})

test('a running vim-like is told to edit the next file, escaping the path', () => {
  assert.equal(
    editKeys(editorSpec('nvim'), 'src/a.ts', 12),
    "\x1b:execute 'edit ' . fnameescape('src/a.ts')\r\x1b:12\r"
  )
  // A quote in the filename is doubled, so it cannot end the vimscript string.
  assert.equal(
    editKeys(editorSpec('vim'), "src/it's.ts", null),
    "\x1b:execute 'edit ' . fnameescape('src/it''s.ts')\r"
  )
})

test('an editor we have no command for is never typed into', () => {
  assert.equal(editKeys(editorSpec('micro'), 'src/a.ts', 12), null)
})

test('an editor given as a path is used when it is there, and only then', () => {
  machine({ files: ['/opt/my/bin/ed'] })
  const spec = { id: 'mine', bin: '/opt/my/bin/ed', terminal: true }

  assert.equal(resolveEditorBin(spec), '/opt/my/bin/ed')
  invalidateEditorCache()
  g.__floeEditorFiles = new Set()
  assert.equal(resolveEditorBin(spec), undefined)
})

test('a binary on PATH is taken from `which`, trimmed', () => {
  machine({ which: '/opt/homebrew/bin/nvim\n' })

  assert.equal(resolveEditorBin(editorSpec('nvim')), '/opt/homebrew/bin/nvim')
})

// A GUI launch inherits a minimal PATH, so `which` misses Homebrew and the
// editors' own shims — the reason the directory sweep exists at all.
test('off PATH, the usual bin dirs are swept in order', () => {
  machine({ files: ['/usr/local/bin/subl', '/usr/bin/subl'] })

  assert.equal(resolveEditorBin(editorSpec('sublime')), '/usr/local/bin/subl')
})

test('last resort is the editor\'s own app-bundle shim', () => {
  machine({ files: ['/Applications/Zed.app/Contents/MacOS/cli'] })

  assert.equal(resolveEditorBin(editorSpec('zed')), '/Applications/Zed.app/Contents/MacOS/cli')
})

test('an editor that is nowhere resolves to nothing', () => {
  machine()

  assert.equal(resolveEditorBin(editorSpec('vscode')), undefined)
})

// The answer is cached because an editor does not move while the app runs; the
// config watcher is what drops it.
test('the resolved path is cached until the cache is invalidated', () => {
  machine({ which: '/usr/bin/code\n' })
  let whichCalls = 0
  g.__floeWhich = () => {
    whichCalls++
    return '/usr/bin/code\n'
  }

  assert.equal(resolveEditorBin(editorSpec('vscode')), '/usr/bin/code')
  assert.equal(resolveEditorBin(editorSpec('vscode')), '/usr/bin/code')
  assert.equal(whichCalls, 1)

  invalidateEditorCache()
  assert.equal(resolveEditorBin(editorSpec('vscode')), '/usr/bin/code')
  assert.equal(whichCalls, 2)
})

// A terminal editor belongs in the panel's PTY — launching it here would draw
// into a terminal nobody can see.
test('a terminal editor is handed back to the panel, unlaunched', () => {
  machine({ command: 'nvim', files: ['/usr/bin/nvim'] })

  assert.deepEqual(launchEditor('/repo', 'src/a.ts', 12), { mode: 'panel' })
  assert.deepEqual(g.__floeLaunches, [])
})

test('a GUI editor is aimed at the file, on its line, in the worktree', () => {
  machine({ command: 'vscode', which: '/usr/bin/code\n' })

  assert.deepEqual(launchEditor('/repo', 'src/a.ts', 12), { mode: 'external' })
  assert.deepEqual(g.__floeLaunches, [
    { bin: '/usr/bin/code', args: ['--goto', 'src/a.ts:12'], cwd: '/repo' }
  ])
})

test('a line of 0 or none opens the file without one', () => {
  machine({ command: 'zed', which: '/usr/bin/zed\n' })

  launchEditor('/repo', 'src/a.ts', 0)
  launchEditor('/repo', 'src/a.ts')
  assert.deepEqual(
    g.__floeLaunches?.map((l) => l.args),
    [['src/a.ts'], ['src/a.ts']]
  )
})

// Nothing is spawned when the binary is missing: the caller shows the error.
test('a GUI editor that is not installed reports it instead of launching', () => {
  machine({ command: 'vscode' })

  const result = launchEditor('/repo', 'src/a.ts', 3)
  assert.equal(result.mode, 'external')
  assert.match(result.error ?? '', /vscode: could not find `code`/)
  assert.deepEqual(g.__floeLaunches, [])
})
