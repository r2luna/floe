import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exitRecord } from './commandExit.ts'

// The line-2 exit readout (`exit 1 · 3h ago · ran 2s`) is built from this record.
// A re-run drops it because spawnProc creates a fresh Run with no `lastExit`, so
// the only thing worth pinning down is the computation itself.

test('exitRecord captures the code and elapsed duration', () => {
  assert.deepEqual(exitRecord(1000, 3000, 1), { code: 1, endedAt: 3000, durationMs: 2000 })
})

test('exitRecord preserves a zero (clean) exit code', () => {
  const r = exitRecord(5000, 5000, 0)
  assert.equal(r.code, 0)
  assert.equal(r.durationMs, 0) // instant exit is still a valid, non-negative duration
})
