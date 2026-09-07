import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LocalAgent } from '../shared/types.ts'
import { installHook } from './config/hook.test-helper.ts'

// Detection reads the runtimes' own files out of $HOME, and `home` is captured
// when the module loads — so the fixture home has to exist before the import.
const HOME = mkdtempSync(join(tmpdir(), 'floe-agents-home-'))
process.env.HOME = HOME
// PATH is the other half of detection. A dir we own at the front, with only
// /usr/bin behind it (`which` itself lives there), makes "installed" mean the
// fixture and not whatever this machine happens to have.
const BIN = join(HOME, 'bin')
const dir = (...parts: string[]): string => {
  const path = join(...parts)
  mkdirSync(path, { recursive: true })
  return path
}
const file = (path: string, body = ''): string => {
  writeFileSync(path, body)
  return path
}
const bin = (path: string): void => {
  file(path, '#!/bin/sh\nexit 0\n')
  chmodSync(path, 0o755)
}

dir(BIN)
process.env.PATH = `${BIN}:/usr/bin:/bin`

// lms: never on PATH — the installer drops it here, which is the whole reason
// the probe carries `paths` at all.
bin(join(dir(HOME, '.lmstudio', 'bin'), 'lms'))
bin(join(BIN, 'ollama'))
bin(join(BIN, 'gemini'))
bin(join(BIN, 'opencode'))
bin(join(dir(HOME, '.codex', 'bin'), 'codex'))

const models = dir(HOME, '.lmstudio', 'models')
dir(models, 'unsloth', 'Kimi-K2.7-Code-GGUF')
dir(models, 'qwen', 'Qwen3-4B-GGUF')
dir(models, 'qwen', '.partial-download') // a dot dir is not a model
dir(models, '.cache') // nor is a dot publisher
file(join(models, 'README.txt')) // nor is a file

const manifests = dir(HOME, '.ollama', 'models', 'manifests', 'registry.ollama.ai')
file(join(dir(manifests, 'library', 'llama3'), 'latest'))
file(join(manifests, 'library', 'llama3', '8b'))
file(join(dir(manifests, 'library', 'qwen'), 'latest'))
file(join(manifests, 'stray.txt')) // not a namespace

file(join(HOME, '.codex', 'auth.json'), JSON.stringify({ tokens: { id: 'x' }, auth_mode: 'chatgpt' }))
file(
  join(dir(HOME, '.gemini'), 'google_accounts.json'),
  JSON.stringify({ active: 'rafael@example.com' })
)
file(
  join(dir(HOME, '.local', 'share', 'opencode'), 'auth.json'),
  JSON.stringify({ anthropic: {}, openrouter: {} })
)

installHook()

const { localAgents, lmStudioServerModels } = await import('./localAgents.ts')

/** What the LM Studio server would answer, or a thrown fetch when it is down. */
let serving: { id?: string; type?: string; max_context_length?: number }[] | null = null
const realFetch = globalThis.fetch
globalThis.fetch = (async (url: string) => {
  assert.match(String(url), /^http:\/\/127\.0\.0\.1:1234\//) // nothing else may be called
  if (!serving) throw new Error('connection refused')
  return { ok: true, json: async () => ({ data: serving }) }
}) as unknown as typeof fetch

const by = (list: LocalAgent[], id: string): LocalAgent | undefined => list.find((a) => a.id === id)

test('the server, when up, is the source of the ids the API accepts', async () => {
  serving = [
    { id: 'kimi-k2.7-code', type: 'llm', max_context_length: 262_144 },
    { id: 'text-embedding-nomic', type: 'embeddings' },
    { id: undefined, type: 'llm' }
  ]
  const lms = by(await localAgents(), 'lmstudio')
  // The embedding model cannot hold a conversation, and a model with no id
  // cannot be sent anywhere — neither is offered.
  assert.deepEqual(lms?.models, [
    { slug: 'kimi-k2.7-code', label: 'kimi-k2.7-code', contextWindow: 262_144 }
  ])
})

test('lmStudioServerModels is silent when the server answers badly', async () => {
  const stub = globalThis.fetch
  globalThis.fetch = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch
  assert.deepEqual(await lmStudioServerModels(), [])
  globalThis.fetch = stub
  serving = null
  assert.deepEqual(await lmStudioServerModels(), []) // and when it is not there at all
})

test('with the server down, the models directory is what the picker shows', async () => {
  serving = null
  const lms = by(await localAgents(), 'lmstudio')
  // publisher/model, sorted by label, dot dirs and loose files ignored.
  assert.deepEqual(lms?.models, [
    { slug: 'unsloth/Kimi-K2.7-Code-GGUF', label: 'Kimi-K2.7-Code-GGUF' },
    { slug: 'qwen/Qwen3-4B-GGUF', label: 'Qwen3-4B-GGUF' }
  ])
  // Found by path, not PATH — the installer never touches PATH.
  assert.equal(lms?.bin, join(HOME, '.lmstudio', 'bin', 'lms'))
})

test('ollama lists one entry per manifest tag', async () => {
  serving = null
  const ollama = by(await localAgents(), 'ollama')
  assert.deepEqual(ollama?.models, [
    { slug: 'llama3:8b', label: 'llama3:8b' },
    { slug: 'llama3:latest', label: 'llama3:latest' },
    { slug: 'qwen:latest', label: 'qwen:latest' }
  ])
  assert.equal(ollama?.bin, join(BIN, 'ollama'))
})

test('credentials are read from each tool’s own files', async () => {
  serving = null
  const found = await localAgents()
  assert.deepEqual(by(found, 'codex')?.auth, {
    signedIn: true,
    detail: 'chatgpt',
    login: 'codex login'
  })
  assert.deepEqual(by(found, 'gemini')?.auth, {
    signedIn: true,
    detail: 'rafael@example.com',
    login: 'gemini'
  })
  assert.deepEqual(by(found, 'opencode')?.auth, {
    signedIn: true,
    detail: 'anthropic, openrouter',
    login: 'opencode auth login'
  })
})

test('a runtime that is not installed is not reported', async () => {
  serving = null
  const ids = (await localAgents()).map((a) => a.id)
  assert.deepEqual(ids.sort(), ['codex', 'gemini', 'lmstudio', 'ollama', 'opencode'])
})

after(() => {
  globalThis.fetch = realFetch
})
