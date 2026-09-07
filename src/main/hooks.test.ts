import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureAgentHookInstalled, mergeAgentHook } from './hooks.ts'

// ensureAgentHookInstalled writes to ~/.claude. homedir() is read per call, so a
// throwaway HOME keeps the install off the developer's real config.
const home = mkdtempSync(join(tmpdir(), 'floe-home-'))
process.env.HOME = home
const claudeDir = join(home, '.claude')

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
  assert.equal(pre.length, 3) // block-branch survives untouched, the other two appended
  const commands = pre.flatMap((e) => e.hooks.map((h) => h.command))
  assert.deepEqual(new Set(commands), new Set([
    '~/.claude/hooks/floe-block-branch.sh',
    '~/.claude/hooks/floe-confine-edits.sh',
    '~/.claude/hooks/floe-block-sleep-wait.sh'
  ]))
  assert.equal(out!.model, 'claude-fable-5') // unrelated fields untouched
})

test('mergeAgentHook: idempotent — no second append, returns null', () => {
  const settings: Record<string, unknown> = {}
  assert.ok(mergeAgentHook(settings)) // first call installs all three
  assert.equal(mergeAgentHook(settings), null) // second call is a no-op
  const pre = (settings.hooks as { PreToolUse: unknown[] }).PreToolUse
  assert.equal(pre.length, 3)
})

test('mergeAgentHook: creates hooks/PreToolUse when absent', () => {
  const out = mergeAgentHook({})
  const pre = (out!.hooks as { PreToolUse: Array<{ matcher: string }> }).PreToolUse
  assert.deepEqual(pre.map((e) => e.matcher), ['Bash', 'Edit|Write|MultiEdit|NotebookEdit', 'Bash'])
})

interface Settings {
  hooks: { PreToolUse: Array<{ matcher?: string; hooks: Array<{ command: string }> }> }
  [k: string]: unknown
}
const readSettings = (): Settings => JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'))

test('ensureAgentHookInstalled writes the scripts and registers them in settings.json', () => {
  ensureAgentHookInstalled()

  for (const name of ['floe-block-branch.sh', 'floe-confine-edits.sh', 'floe-block-sleep-wait.sh']) {
    const script = join(claudeDir, 'hooks', name)
    assert.ok(existsSync(script), `${name} should be written`)
    // A hook Claude Code cannot execute is a hook that silently does nothing.
    assert.equal(statSync(script).mode & 0o111, 0o111)
    assert.match(readFileSync(script, 'utf8'), /mcp__floe/) // the Floe-session guard
  }

  const commands = readSettings().hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command))
  assert.deepEqual(new Set(commands), new Set([
    '~/.claude/hooks/floe-block-branch.sh',
    '~/.claude/hooks/floe-confine-edits.sh',
    '~/.claude/hooks/floe-block-sleep-wait.sh'
  ]))
})

test('ensureAgentHookInstalled runs on every boot, so it must not append twice', () => {
  ensureAgentHookInstalled()
  const before = readFileSync(join(claudeDir, 'settings.json'), 'utf8')
  ensureAgentHookInstalled()
  assert.equal(readFileSync(join(claudeDir, 'settings.json'), 'utf8'), before)
  assert.equal(readSettings().hooks.PreToolUse.length, 3)
})

test('ensureAgentHookInstalled keeps unrelated settings and restores a deleted script', () => {
  const settingsPath = join(claudeDir, 'settings.json')
  const settings = readSettings()
  settings.model = 'claude-fable-5'
  settings.hooks.PreToolUse.push({ matcher: 'Read', hooks: [{ command: '~/mine.sh' }] })
  writeFileSync(settingsPath, JSON.stringify(settings))
  writeFileSync(join(claudeDir, 'hooks', 'floe-block-branch.sh'), 'stale\n')

  ensureAgentHookInstalled()

  const after = readSettings()
  assert.equal(after.model, 'claude-fable-5')
  assert.equal(after.hooks.PreToolUse.length, 4) // the hand-added entry survives
  assert.match(readFileSync(join(claudeDir, 'hooks', 'floe-block-branch.sh'), 'utf8'), /mcp__floe/)
})

test('an unparseable settings.json is rebuilt rather than left broken', () => {
  const settingsPath = join(claudeDir, 'settings.json')
  writeFileSync(settingsPath, '{ not json')
  ensureAgentHookInstalled()
  assert.equal(readSettings().hooks.PreToolUse.length, 3)
})
