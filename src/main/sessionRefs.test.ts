import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

// The loader hook the other main-process tests use. Two stubs: `./sessionStore`
// is the store this reads (and the one claudeSessions reads its titles from),
// `./config/projectStore` decides which project a worktree is in. Everything
// else is the real code — the title rule in particular, because a slug that
// matched a title the sidebar does not show is the exact bug this guards.
const hookSource = `
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
export async function resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: 'stub:electron', shortCircuit: true, format: 'module' }
  const parent = context.parentURL ?? ''
  if (specifier === './sessionStore' && (parent.endsWith('/sessionRefs.ts') || parent.endsWith('/claudeSessions.ts')))
    return { url: 'stub:store', shortCircuit: true, format: 'module' }
  if (specifier === './config/projectStore' && parent.endsWith('/sessionRefs.ts'))
    return { url: 'stub:projects', shortCircuit: true, format: 'module' }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\\.[a-z]+$/i.test(specifier)) {
    try {
      const base = context.parentURL ? new URL(specifier, context.parentURL) : pathToFileURL(specifier)
      const tsPath = fileURLToPath(base) + '.ts'
      if (existsSync(tsPath)) return next(specifier + '.ts', context)
    } catch {}
  }
  return next(specifier, context)
}
const SOURCE = {
  'stub:electron': "export class BrowserWindow {}; export const app = { getPath: () => '/tmp' }; export default {};",
  'stub:store':
    "export function getAllCreatedSessions() { return globalThis.__refSessions }" +
    "\\nexport function getSessionMeta() { return globalThis.__refMeta }" +
    "\\nexport function getCreatedSessions(wt) { return globalThis.__refSessions.filter((s) => s.worktreePath === wt) }",
  'stub:projects':
    "export function projectFor(path) { return path.startsWith('/repo-a') ? '/repo-a' : path.startsWith('/repo-b') ? '/repo-b' : null }"
}
export async function load(url, context, next) {
  if (SOURCE[url]) return { format: 'module', shortCircuit: true, source: SOURCE[url] }
  return next(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

// Named apart from the other main tests' globals: `declare global` is one
// namespace across the whole typecheck, and two `__sessions` of different
// shapes is an error even though the tests never meet at runtime.
interface RefSession {
  id: string
  worktreePath: string
  title: string
  createdAt: number
  usedAt?: number
  claudeId?: string
  provider?: string
}
declare global {
  // eslint-disable-next-line no-var
  var __refSessions: RefSession[]
  // eslint-disable-next-line no-var
  var __refMeta: Record<string, { title?: string }>
}

const { resolveSessionRef } = await import('./sessionRefs.ts')

function store(sessions: RefSession[], meta: Record<string, { title?: string }> = {}): void {
  globalThis.__refSessions = sessions
  globalThis.__refMeta = meta
}

const PLUGINS: RefSession = {
  id: 'uuid-plugins',
  worktreePath: '/repo-a/wt/plugins',
  title: 'plugin system v2',
  createdAt: 1,
  provider: 'codex'
}

test('a slug resolves to the id and the harness the session answers as', () => {
  store([PLUGINS])
  assert.deepEqual(resolveSessionRef('plugin-system-v2', '/repo-a/wt/main'), {
    id: 'uuid-plugins',
    harness: 'codex',
    title: 'plugin system v2',
    worktreePath: '/repo-a/wt/plugins'
  })
})

test('a session with no harness recorded is Claude', () => {
  store([{ ...PLUGINS, provider: undefined }])
  assert.equal(resolveSessionRef('plugin-system-v2', '/repo-a/wt/main')?.harness, 'claude')
})

test('a slug naming nothing resolves to nothing', () => {
  store([PLUGINS])
  assert.equal(resolveSessionRef('some-other-thing', '/repo-a/wt/main'), null)
})

test('a rename is what the slug is matched against', () => {
  // The menu writes the title the sidebar shows, which for a renamed session is
  // the stored one — matching on the original would write a dead token.
  store([{ ...PLUGINS, claudeId: 'cid' }], { cid: { title: 'the plugin work' } })
  assert.equal(resolveSessionRef('the-plugin-work', '/repo-a/wt/main')?.id, 'uuid-plugins')
  assert.equal(resolveSessionRef('plugin-system-v2', '/repo-a/wt/main'), null)
})

test('sessions in another worktree of the same project still resolve', () => {
  store([PLUGINS])
  assert.equal(resolveSessionRef('plugin-system-v2', '/repo-a/wt/other')?.id, 'uuid-plugins')
})

test('a shared title resolves in this project before another one', () => {
  store([
    { ...PLUGINS, id: 'far', worktreePath: '/repo-b/wt/x', usedAt: 99 },
    { ...PLUGINS, id: 'near', usedAt: 2 }
  ])
  assert.equal(resolveSessionRef('plugin-system-v2', '/repo-a/wt/main')?.id, 'near')
})

test('a shared title inside one project resolves to the one used last', () => {
  store([
    { ...PLUGINS, id: 'stale', usedAt: 2 },
    { ...PLUGINS, id: 'fresh', worktreePath: '/repo-a/wt/two', usedAt: 50 }
  ])
  assert.equal(resolveSessionRef('plugin-system-v2', '/repo-a/wt/main')?.id, 'fresh')
})
