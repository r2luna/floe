import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Same loader hook as sessionStore.test.ts: extensionless relative imports + an
// `electron` stub.
const hookSource = `
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
export async function resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: 'stub:electron', shortCircuit: true, format: 'module' }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\\.[a-z]+$/i.test(specifier)) {
    try {
      const base = context.parentURL ? new URL(specifier, context.parentURL) : pathToFileURL(specifier)
      const tsPath = fileURLToPath(base) + '.ts'
      if (existsSync(tsPath)) return next(specifier + '.ts', context)
    } catch {}
  }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (url === 'stub:electron') {
    return { format: 'module', shortCircuit: true, source: "export const app = { getPath: () => '/tmp' }; export default {};" }
  }
  return next(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

const { setSharedDataDir } = await import('./dataDir.ts')
const dataDir = mkdtempSync(join(tmpdir(), 'floe-identity-'))
setSharedDataDir(dataDir)

const { addCreatedSession } = await import('./sessionStore.ts')
const { agentIdentityNames, agentResumeId, linkAgentIdentity, resolveAgentIdentity } =
  await import('./identity.ts')

const wt = join(tmpdir(), 'floe-identity-wt')

test('a key nobody holds still answers to its own name', () => {
  assert.equal(resolveAgentIdentity('nowhere'), undefined)
  assert.equal(agentResumeId('nowhere'), undefined)
  assert.deepEqual(agentIdentityNames('nowhere'), ['nowhere'])
})

test("the first turn's claude id is what the next spawn resumes", () => {
  const id = 'sess-resume'
  addCreatedSession({ id, worktreePath: wt })
  assert.equal(agentResumeId(id), undefined)
  linkAgentIdentity(id, 'claude-1')
  assert.equal(agentResumeId(id), 'claude-1')
  // And under the CLI's own name too: after the first turn the panel keys
  // itself by the claudeId, and a respawn from THAT key must resume the same
  // session rather than starting a blank one.
  assert.equal(agentResumeId('claude-1'), 'claude-1')
})

test('a forked id keeps answering to the name it was opened under', () => {
  const id = 'sess-fork'
  addCreatedSession({ id, worktreePath: wt })
  linkAgentIdentity(id, 'claude-a')
  linkAgentIdentity(id, 'claude-b')
  // Every alias, from whichever of them is asked — this is what makes stop,
  // answer, permission and replay find the conn after a resume forked the id.
  for (const key of [id, 'claude-a', 'claude-b']) {
    const names = agentIdentityNames(key)
    assert.equal(names[0], key, 'the key asked for comes first')
    for (const n of [id, 'claude-a', 'claude-b']) assert.ok(names.includes(n), `${key} → ${n}`)
  }
  assert.equal(agentResumeId('claude-a'), 'claude-b')
})

test('identity is ids only — never the record behind them', () => {
  const id = 'sess-shape'
  addCreatedSession({ id, worktreePath: wt })
  linkAgentIdentity(id, 'claude-shape')
  // Deliberately exhaustive: a `spawnedBy` (or a provider, or a mode) leaking
  // through here is what would make a query inherit its parent's answers.
  assert.deepEqual(Object.keys(resolveAgentIdentity(id)!).sort(), [
    'claudeId',
    'id',
    'pastClaudeIds'
  ])
})
