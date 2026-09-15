import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addCumulative, addUsage, resetUsageLedger, totalTokens, usageOf } from './usageLedger.ts'

test('per-call reports add up', () => {
  resetUsageLedger()
  addUsage('s', { input: 10, output: 5 })
  addUsage('s', { input: 1, cacheRead: 100 })
  assert.deepEqual(usageOf(['s']), { input: 11, output: 5, cacheRead: 100, cacheWrite: 0 })
})

test('a running total adds only what it grew by', () => {
  resetUsageLedger()
  addCumulative('s', 'claude', { input: 10, output: 100, cacheRead: 1000, cacheWrite: 50, costUsd: 0.5 })
  addCumulative('s', 'claude', { input: 20, output: 150, cacheRead: 2500, cacheWrite: 60, costUsd: 0.7 })
  const u = usageOf(['s'])
  assert.deepEqual({ ...u, costUsd: Number(u.costUsd?.toFixed(4)) }, { input: 20, output: 150, cacheRead: 2500, cacheWrite: 60, costUsd: 0.7 })
})

test('a running total that went down is a restarted process, so all of it is new', () => {
  resetUsageLedger()
  addCumulative('s', 'claude', { input: 10, output: 100, cacheRead: 0, cacheWrite: 0, costUsd: 0.5 })
  addCumulative('s', 'claude', { input: 3, output: 30, cacheRead: 0, cacheWrite: 0, costUsd: 0.1 })
  assert.equal(usageOf(['s']).output, 130)
  assert.equal(Number(usageOf(['s']).costUsd?.toFixed(4)), 0.6)
})

test('the keys of one session are summed, and an unknown key adds nothing', () => {
  resetUsageLedger()
  addUsage('id', { output: 4 })
  addUsage('claude-id', { output: 6 })
  assert.equal(totalTokens(usageOf(['id', 'claude-id', 'nobody', 'id'])), 10)
  assert.equal(usageOf(['id']).costUsd, undefined)
})

test('claude: modelUsage summed across models, with the cost', async () => {
  const { claudeRunningUsage } = await import('./usageLedger.ts')
  const u = claudeRunningUsage({
    total_cost_usd: 0.02,
    modelUsage: {
      opus: { inputTokens: 20, outputTokens: 176, cacheReadInputTokens: 41498, cacheCreationInputTokens: 6492 },
      haiku: { inputTokens: 900, outputTokens: 10 }
    }
  })
  assert.deepEqual(u, { input: 920, output: 186, cacheRead: 41498, cacheWrite: 6492, costUsd: 0.02 })
  assert.equal(claudeRunningUsage({ usage: {} }), undefined)
})

test('codex: cached input is taken back out of input', async () => {
  const { codexRunningUsage } = await import('./usageLedger.ts')
  assert.deepEqual(codexRunningUsage({ total: { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 50 }, last: {} }), {
    input: 200,
    output: 50,
    cacheRead: 800,
    cacheWrite: 0
  })
  assert.equal(codexRunningUsage({ last: {} }), undefined)
})

test('opencode step-finish parts and gemini stats both read', async () => {
  const { cliRunUsage } = await import('./usageLedger.ts')
  const opencode = [
    '{"type":"text","part":{"type":"text","text":"hi"}}',
    '{"type":"step_finish","part":{"type":"step-finish","tokens":{"input":10,"output":5,"reasoning":2,"cache":{"read":100,"write":7}},"cost":0.01}}',
    '{"type":"step_finish","part":{"type":"step-finish","tokens":{"input":1,"output":1,"cache":{"read":0,"write":0}},"cost":0.02}}'
  ].join('\n')
  const o = cliRunUsage(opencode)
  assert.deepEqual({ ...o, costUsd: Number(o?.costUsd?.toFixed(3)) }, { input: 11, output: 8, cacheRead: 100, cacheWrite: 7, costUsd: 0.03 })
  const gemini = JSON.stringify({ response: 'hi', stats: { models: { 'gemini-2.5-pro': { tokens: { prompt: 500, candidates: 40, cached: 300, thoughts: 10 } } } } })
  assert.deepEqual(cliRunUsage(gemini), { input: 200, output: 50, cacheRead: 300, cacheWrite: 0 })
  assert.equal(cliRunUsage('{"response":"hi"}\nplain'), undefined)
})
