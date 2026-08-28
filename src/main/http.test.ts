import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// http.ts now imports ./projects, whose graph uses extensionless relative
// imports (and touches `electron`), which raw Node ESM doesn't resolve. Register
// the same in-memory hook git.test / mcpServer.test use: rewrite `./x` → `./x.ts`
// and stub `electron`.
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
    return { format: 'module', shortCircuit: true, source: "export const app = { getPath: () => '/tmp' }; export const dialog = {}; export default {};" }
  }
  return next(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

const { parseHttp, loadEnv, listHttpFiles, runResponseScript } = await import('./http.ts')

const SAMPLE = `### Get users
# a leading comment
GET {{host}}/api/users HTTP/1.1
Authorization: Bearer {{token}}
Accept: application/json

### @name Create user
POST {{host}}/api/users
Content-Type: application/json

{
  "name": "Ada"
}

### Delete user
DELETE {{host}}/api/users/1
`

test('parseHttp splits requests on ### and keeps method/url/headers', () => {
  const reqs = parseHttp(SAMPLE)
  assert.equal(reqs.length, 3)

  assert.equal(reqs[0].name, 'Get users')
  assert.equal(reqs[0].method, 'GET')
  assert.equal(reqs[0].url, '{{host}}/api/users') // HTTP/1.1 stripped, vars untouched
  assert.deepEqual(reqs[0].headers, [
    ['Authorization', 'Bearer {{token}}'],
    ['Accept', 'application/json']
  ])
  assert.equal(reqs[0].body, undefined)

  assert.equal(reqs[1].name, 'Create user') // from `### @name`
  assert.equal(reqs[1].method, 'POST')
  assert.equal(reqs[1].body, '{\n  "name": "Ada"\n}')

  assert.equal(reqs[2].method, 'DELETE')
})

test('parseHttp records 1-based startLine of each request', () => {
  const reqs = parseHttp(SAMPLE)
  assert.equal(reqs[0].startLine, 1) // "### Get users"
  assert.equal(reqs[1].startLine, 7) // "### @name Create user"
  assert.equal(reqs[2].startLine, 15) // "### Delete user"
})

test('parseHttp handles a first request with no ### and derives a name', () => {
  const reqs = parseHttp('GET https://example.com/health\n')
  assert.equal(reqs.length, 1)
  assert.equal(reqs[0].startLine, 1)
  assert.equal(reqs[0].name, 'GET https://example.com/health')
})

test('parseHttp does not swallow a response-handler script into the body', () => {
  const reqs = parseHttp(`POST https://x.test/a\n\n{"a":1}\n\n> {% client.log(1) %}\n`)
  assert.equal(reqs[0].body, '{"a":1}')
})

test('loadEnv merges the private env over the public one', () => {
  const root = mkdtempSync(join(tmpdir(), 'rookery-http-'))
  try {
    writeFileSync(join(root, 'http-client.env.json'), JSON.stringify({ dev: { host: 'http://pub', token: 'a' } }))
    writeFileSync(join(root, 'http-client.private.env.json'), JSON.stringify({ dev: { token: 'secret' } }))
    const env = loadEnv(root)
    assert.deepEqual(env.dev, { host: 'http://pub', token: 'secret' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('parseHttp captures an inline response-handler script', () => {
  const src = `POST https://x.test/login\n\n{"u":"a"}\n\n> {%\n  client.global.set("token", response.body.access_token)\n%}\n`
  const reqs = parseHttp(src)
  assert.equal(reqs[0].body, '{"u":"a"}')
  assert.match(reqs[0].script ?? '', /client\.global\.set\("token", response\.body\.access_token\)/)
})

test('runResponseScript persists client.global.set into the private env file', () => {
  const root = mkdtempSync(join(tmpdir(), 'rookery-http-'))
  try {
    mkdirSync(join(root, 'docs'), { recursive: true })
    const resp = {
      status: 200,
      statusText: 'OK',
      headers: [['content-type', 'application/json']] as [string, string][],
      body: JSON.stringify({ access_token: 'abc123' }),
      duration: 1,
      size: 1
    }
    const out = runResponseScript(
      'client.global.set("token", response.body.access_token)',
      resp,
      root,
      'docs/auth.http',
      'dev'
    )
    assert.deepEqual(out.savedVars, ['token'])
    // Written next to the .http, under the active env, and now resolvable.
    const saved = JSON.parse(readFileSync(join(root, 'docs', 'http-client.private.env.json'), 'utf8'))
    assert.equal(saved.dev.token, 'abc123')
    assert.equal(loadEnv(root, 'docs/auth.http').dev.token, 'abc123')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadEnv finds the env file next to the .http (deep folder overrides root)', () => {
  const root = mkdtempSync(join(tmpdir(), 'rookery-http-'))
  try {
    mkdirSync(join(root, 'docs', 'apis'), { recursive: true })
    writeFileSync(join(root, 'http-client.env.json'), JSON.stringify({ dev: { host: 'root', token: 'r' } }))
    writeFileSync(join(root, 'docs', 'apis', 'http-client.env.json'), JSON.stringify({ dev: { host: 'deep' } }))
    // No file context → root only.
    assert.deepEqual(loadEnv(root).dev, { host: 'root', token: 'r' })
    // With the request file deep in the tree, the nearby env wins per key.
    assert.deepEqual(loadEnv(root, 'docs/apis/auth.http').dev, { host: 'deep', token: 'r' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('listHttpFiles groups by top-level dir and flags env files', () => {
  const root = mkdtempSync(join(tmpdir(), 'rookery-http-'))
  try {
    mkdirSync(join(root, 'api'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(root, 'api', 'users.http'), 'GET http://x/users\n')
    writeFileSync(join(root, 'orders.http'), 'GET http://x/orders\n')
    writeFileSync(join(root, 'http-client.env.json'), '{}')
    writeFileSync(join(root, 'node_modules', 'pkg', 'ignore.http'), 'GET http://x\n') // skipped

    const files = listHttpFiles(root)
    const byPath = Object.fromEntries(files.map((f) => [f.relPath, f]))

    assert.ok(!('node_modules/pkg/ignore.http' in byPath), 'node_modules is skipped')
    assert.equal(byPath['api/users.http'].group, 'api')
    assert.equal(byPath['api/users.http'].name, 'users.http')
    assert.equal(byPath['orders.http'].group, undefined) // root file, no group
    assert.equal(byPath['http-client.env.json'].isEnv, true)
    // env files sort last
    assert.equal(files[files.length - 1].relPath, 'http-client.env.json')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
