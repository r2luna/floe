import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeAgentHook } from './hooks.ts'

test('mergeAgentHook: appends only the missing managed hooks, preserving existing entries', () => {
  const settings = {
    model: 'claude-fable-5',
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '~/.claude/hooks/floe-block-branch.sh' }] }]
    }
  }
  const out = mergeAgentHook(settings)
  assert.ok(out, 'should signal a change')
  const pre = (out!.hooks as { PreToolUse: Array<{ hooks: Array<{ command: string }> }> }).PreToolUse
  assert.equal(pre.length, 4) // block-branch survives untouched, the other three appended
  const commands = pre.flatMap((e) => e.hooks.map((h) => h.command))
  assert.deepEqual(new Set(commands), new Set([
    '~/.claude/hooks/floe-block-branch.sh',
    '~/.claude/hooks/floe-confine-edits.sh',
    '~/.claude/hooks/floe-block-native-agents.sh',
    '~/.claude/hooks/floe-block-sleep-wait.sh'
  ]))
  assert.equal(out!.model, 'claude-fable-5') // unrelated fields untouched
})

test('mergeAgentHook: idempotent — no second append, returns null', () => {
  const settings: Record<string, unknown> = {}
  assert.ok(mergeAgentHook(settings)) // first call installs all four
  assert.equal(mergeAgentHook(settings), null) // second call is a no-op
  const pre = (settings.hooks as { PreToolUse: unknown[] }).PreToolUse
  assert.equal(pre.length, 4)
})

test('mergeAgentHook: creates hooks/PreToolUse when absent', () => {
  const out = mergeAgentHook({})
  const pre = (out!.hooks as { PreToolUse: Array<{ matcher: string }> }).PreToolUse
  assert.deepEqual(pre.map((e) => e.matcher), ['Bash', 'Edit|Write|MultiEdit|NotebookEdit', 'Task|Agent', 'Bash'])
})
