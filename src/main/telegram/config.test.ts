import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHook } from '../config/hook.test-helper.ts'

installHook()
const { applySetup, readTelegramConfig, statusOf, writeTelegramConfig, DEFAULT_AWAY_MINUTES } = await import('./config.ts')

const scratch = (): string => mkdtempSync(join(tmpdir(), 'floe-telegram-'))

test('a missing or broken file is an unconfigured bot', () => {
  const dir = scratch()
  try {
    const file = join(dir, 'telegram.json')
    assert.deepEqual(readTelegramConfig(file), { awayAfterMinutes: DEFAULT_AWAY_MINUTES, enabled: true })
    writeFileSync(file, '{not json')
    assert.deepEqual(readTelegramConfig(file), { awayAfterMinutes: DEFAULT_AWAY_MINUTES, enabled: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('bad values fall back, good ones round-trip, and the file is private', () => {
  const dir = scratch()
  try {
    const file = join(dir, 'telegram.json')
    writeFileSync(file, JSON.stringify({ token: '', chatId: 'x', awayAfterMinutes: -2, enabled: false }))
    assert.deepEqual(readTelegramConfig(file), { awayAfterMinutes: DEFAULT_AWAY_MINUTES, enabled: false })
    const cfg = { token: 't', chatId: 7, pairCode: '123456', awayAfterMinutes: 10, enabled: true }
    writeTelegramConfig(file, cfg)
    assert.deepEqual(readTelegramConfig(file), cfg)
    assert.equal(statSync(file).mode & 0o777, 0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a first token issues a pairing code', () => {
  const next = applySetup({ awayAfterMinutes: 3, enabled: true }, { token: 't' })
  assert.equal(next.token, 't')
  assert.match(next.pairCode ?? '', /^\d{6}$/)
  assert.equal(next.chatId, undefined)
})

test('a new token or an unpair forgets the chat and issues a fresh code', () => {
  const paired = { token: 't', chatId: 7, awayAfterMinutes: 3, enabled: true }
  const swapped = applySetup(paired, { token: 'u' })
  assert.equal(swapped.chatId, undefined)
  assert.match(swapped.pairCode ?? '', /^\d{6}$/)
  const unpaired = applySetup(paired, { unpair: true })
  assert.equal(unpaired.chatId, undefined)
  assert.match(unpaired.pairCode ?? '', /^\d{6}$/)
})

test('other settings leave the pairing alone', () => {
  const paired = { token: 't', chatId: 7, awayAfterMinutes: 3, enabled: true }
  assert.deepEqual(applySetup(paired, { awayAfterMinutes: -1, enabled: false, token: 't' }), {
    ...paired,
    awayAfterMinutes: 0,
    enabled: false
  })
  const waiting = { token: 't', pairCode: '111111', awayAfterMinutes: 3, enabled: true }
  assert.equal(applySetup(waiting, { awayAfterMinutes: 5 }).pairCode, '111111')
})

test('status shows the pairing code only until a chat is paired', () => {
  const rt = { running: true, away: false, lastSeenAt: 0 }
  assert.deepEqual(statusOf({ token: 't', pairCode: '111111', awayAfterMinutes: 3, enabled: true }, rt), {
    configured: true,
    enabled: true,
    running: true,
    paired: false,
    pairCode: '111111',
    awayAfterMinutes: 3,
    away: false
  })
  const full = { running: true, botName: 'floe_bot', away: true, lastSeenAt: 5, current: 'a', error: 'boom' }
  assert.deepEqual(statusOf({ token: 't', chatId: 7, pairCode: 'x', awayAfterMinutes: 3, enabled: true }, full), {
    configured: true,
    enabled: true,
    running: true,
    bot: '@floe_bot',
    paired: true,
    awayAfterMinutes: 3,
    away: true,
    lastSeenAt: 5,
    currentSession: 'a',
    error: 'boom'
  })
})
