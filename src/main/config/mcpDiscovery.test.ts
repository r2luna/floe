import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rankCandidates, searchMcpServers, PLACEHOLDER, type RegistryEntry } from './mcpDiscovery.ts'

// Registry records, trimmed to the fields the mapping reads. The shapes are
// real ones from registry.modelcontextprotocol.io — the padding, the repeated
// versions and the re-hosts below are all things it actually returns.
const latest = { 'io.modelcontextprotocol.registry/official': { isLatest: true } }
const older = { 'io.modelcontextprotocol.registry/official': { isLatest: false } }

const remote = (name: string, url: string, description = 'docs'): RegistryEntry => ({
  server: { name, description, version: '1.0.0', remotes: [{ type: 'streamable-http', url }] },
  _meta: latest
})

test('a remote server maps to an http entry', () => {
  const [found] = rankCandidates([remote('io.github.upstash/context7', 'https://mcp.context7.com/mcp')], 'context7')
  assert.equal(found.transport, 'http')
  assert.equal(found.url, 'https://mcp.context7.com/mcp')
  assert.deepEqual(found.needs, [])
})

test('an npm package maps to npx -y with the version pinned', () => {
  const [found] = rankCandidates(
    [
      {
        server: {
          name: 'io.github.microsoft/playwright-mcp',
          description: 'browser automation',
          version: '0.1.0',
          packages: [
            {
              registryType: 'npm',
              identifier: '@playwright/mcp',
              version: '0.1.0',
              transport: { type: 'stdio' },
              packageArguments: [{ type: 'named', name: '--headless', value: 'true' }]
            }
          ]
        },
        _meta: latest
      }
    ],
    'playwright'
  )
  assert.equal(found.transport, 'stdio')
  assert.equal(found.command, 'npx')
  assert.deepEqual(found.args, ['-y', '@playwright/mcp@0.1.0', '--headless', 'true'])
})

test('required env vars become an env wrapper and are reported as needs', () => {
  const [found] = rankCandidates(
    [
      {
        server: {
          name: 'io.github.acme/thing',
          description: 'a thing',
          packages: [
            {
              registryType: 'npm',
              identifier: 'acme-mcp',
              transport: { type: 'stdio' },
              environmentVariables: [
                { name: 'ACME_KEY', isSecret: true },
                { name: 'ACME_REGION' }
              ]
            }
          ]
        },
        _meta: latest
      }
    ],
    'thing'
  )
  // The optional var is left out: only what the server cannot start without.
  assert.equal(found.command, 'env')
  assert.deepEqual(found.args, [`ACME_KEY=${PLACEHOLDER}`, 'npx', '-y', 'acme-mcp'])
  assert.deepEqual(found.needs, ['ACME_KEY'])
})

test('a templated auth header is a secret Floe cannot fill', () => {
  const found = rankCandidates(
    [
      {
        server: {
          name: 'ai.smithery/context7fork',
          description: 'a fork',
          remotes: [
            {
              type: 'streamable-http',
              url: 'https://server.smithery.ai/mcp',
              headers: [{ name: 'Authorization', value: 'Bearer {smithery_api_key}' }]
            }
          ]
        },
        _meta: latest
      }
    ],
    'context7'
  )
  assert.deepEqual(found[0].needs, ['Authorization header'])
})

test('padding is dropped, versions collapse to the latest, and the vendor outranks a re-host', () => {
  const ranked = rankCandidates(
    [
      remote('ai.smithery/smithery-ai-github', 'https://server.smithery.ai/github/mcp', 'github tools'),
      { server: { name: 'io.github.github/github-mcp-server', description: 'GitHub', version: '0.9.0', remotes: [{ url: 'https://api.githubcopilot.com/mcp/' }] }, _meta: older },
      { server: { name: 'io.github.github/github-mcp-server', description: 'GitHub', version: '1.2.0', remotes: [{ url: 'https://api.githubcopilot.com/mcp/' }] }, _meta: latest },
      remote('io.github.someone/weather', 'https://weather.example/mcp', 'the forecast')
    ],
    'github'
  )
  assert.deepEqual(
    ranked.map((c) => `${c.id}@${c.version}`),
    ['io.github.github/github-mcp-server@1.2.0', 'ai.smithery/smithery-ai-github@1.0.0']
  )
})

test('a record with neither a remote nor a runnable package is not offered', () => {
  const ranked = rankCandidates(
    [{ server: { name: 'io.github.acme/mystery', description: 'mystery', packages: [{ registryType: 'unknown-thing', identifier: 'x' }] }, _meta: latest }],
    'mystery'
  )
  assert.deepEqual(ranked, [])
})

test('a registry that cannot answer says so rather than failing silently', async () => {
  await assert.rejects(
    () => searchMcpServers('context7', async () => new Response('nope', { status: 503 })),
    /answered 503/
  )
  await assert.rejects(
    () =>
      searchMcpServers('context7', () => {
        throw new Error('getaddrinfo ENOTFOUND')
      }),
    /could not reach/
  )
})

test('an empty query never leaves the machine', async () => {
  assert.deepEqual(
    await searchMcpServers('   ', () => {
      throw new Error('should not be called')
    }),
    []
  )
})
