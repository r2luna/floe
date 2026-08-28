import test from 'node:test'
import assert from 'node:assert/strict'
import { parseContextUsage, parseTokenCount } from './claudeInfo.ts'

test('parseTokenCount: k/m suffixes, plain numbers, junk', () => {
  assert.equal(parseTokenCount('3.5k'), 3500)
  assert.equal(parseTokenCount(' 1m '), 1_000_000)
  assert.equal(parseTokenCount('632'), 632)
  assert.equal(parseTokenCount('< 20'), 20)
  assert.equal(parseTokenCount('—'), 0)
})

test('parseContextUsage: model, totals and the category table (free space dropped)', () => {
  const report = [
    '## Context Usage',
    '',
    '**Model:** claude-opus-5[1m]  ',
    '**Tokens:** 59.8k / 1m (6%)',
    '',
    '### Estimated usage by category',
    '',
    '| Category | Tokens | Percentage |',
    '|----------|--------|------------|',
    '| System prompt | 3.5k | 0.3% |',
    '| MCP tools (deferred) | 62k | 6.2% |',
    '| Messages | 38.3k | 3.8% |',
    '| Free space | 940k | 94.0% |',
    '',
    '### MCP Tools',
    '',
    '| Tool | Server | Tokens |',
    '| mcp__rookery__list_projects | rookery | 415 |'
  ].join('\n')

  const usage = parseContextUsage(report)
  assert.equal(usage.model, 'claude-opus-5')
  assert.equal(usage.used, 59_800)
  assert.equal(usage.window, 1_000_000)
  assert.deepEqual(usage.categories, [
    { label: 'System prompt', tokens: 3500 },
    { label: 'MCP tools (deferred)', tokens: 62_000 },
    { label: 'Messages', tokens: 38_300 }
  ])
})

test('parseContextUsage: garbage in, empty breakdown out', () => {
  assert.deepEqual(parseContextUsage('this command is not available').categories, [])
})
