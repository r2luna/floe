// `<dataDir>/telegram.json` — the bot's token and the one chat it answers.
//
// Not floe.toml: the token is a secret bound to this machine, and floe.toml is
// meant to travel in a dotfiles repo. Each machine runs its OWN bot — Telegram
// hands a token's updates to one poller at a time, so two machines sharing a
// token would steal each other's messages.

import { existsSync, readFileSync } from 'node:fs'
import { randomInt } from 'node:crypto'
import { writeFileAtomic } from '../config/io'

export interface TelegramConfig {
  token?: string
  /** The paired chat. Messages from any other chat are ignored. */
  chatId?: number
  /** What `/pair <code>` must say before a chat is paired. Cleared once it is. */
  pairCode?: string
  /** How long without input before the user counts as away. */
  awayAfterMinutes: number
  enabled: boolean
}

export const DEFAULT_AWAY_MINUTES = 3

const defaults = (): TelegramConfig => ({ awayAfterMinutes: DEFAULT_AWAY_MINUTES, enabled: true })

/** Never throws: a missing or broken file is an unconfigured bot. */
export function readTelegramConfig(file: string): TelegramConfig {
  if (!existsSync(file)) return defaults()
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<TelegramConfig>
    const minutes = Number(raw.awayAfterMinutes)
    return {
      ...(typeof raw.token === 'string' && raw.token && { token: raw.token }),
      ...(typeof raw.chatId === 'number' && { chatId: raw.chatId }),
      ...(typeof raw.pairCode === 'string' && { pairCode: raw.pairCode }),
      awayAfterMinutes: Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_AWAY_MINUTES,
      enabled: raw.enabled !== false
    }
  } catch {
    return defaults()
  }
}

export function writeTelegramConfig(file: string, cfg: TelegramConfig): void {
  writeFileAtomic(file, JSON.stringify(cfg, null, 2) + '\n', 0o600)
}

export function newPairCode(): string {
  return String(randomInt(100_000, 1_000_000))
}

export interface SetupInput {
  token?: string
  awayAfterMinutes?: number
  enabled?: boolean
  unpair?: boolean
}

/**
 * Apply a setup call. A new token, or an explicit unpair, forgets the chat and
 * issues a fresh pairing code — the old chat was paired to a different bot.
 */
export function applySetup(cfg: TelegramConfig, input: SetupInput): TelegramConfig {
  const next = { ...cfg }
  if (input.awayAfterMinutes !== undefined) next.awayAfterMinutes = Math.max(0, input.awayAfterMinutes)
  if (input.enabled !== undefined) next.enabled = input.enabled
  const rebind = (input.token !== undefined && input.token !== cfg.token) || input.unpair === true
  if (input.token !== undefined) next.token = input.token
  if (rebind) delete next.chatId
  if (next.token && next.chatId === undefined && (rebind || !next.pairCode)) next.pairCode = newPairCode()
  if (next.chatId !== undefined) delete next.pairCode
  return next
}

export interface TelegramStatus {
  configured: boolean
  enabled: boolean
  running: boolean
  bot?: string
  paired: boolean
  /** Send `/pair <code>` to the bot from the chat that should receive your sessions. */
  pairCode?: string
  awayAfterMinutes: number
  away: boolean
  lastSeenAt?: number
  currentSession?: string
  error?: string
}

/** What the running bot knows that the file does not. */
export interface BotRuntime {
  running: boolean
  botName?: string
  away: boolean
  /** 0 for never. */
  lastSeenAt: number
  current?: string
  error?: string
}

export function statusOf(cfg: TelegramConfig, rt: BotRuntime): TelegramStatus {
  const paired = cfg.chatId !== undefined
  return {
    configured: Boolean(cfg.token),
    enabled: cfg.enabled,
    running: rt.running,
    ...(rt.botName && { bot: `@${rt.botName}` }),
    paired,
    ...(!paired && cfg.pairCode && { pairCode: cfg.pairCode }),
    awayAfterMinutes: cfg.awayAfterMinutes,
    away: rt.away,
    ...(rt.lastSeenAt > 0 && { lastSeenAt: rt.lastSeenAt }),
    ...(rt.current && { currentSession: rt.current }),
    ...(rt.error && { error: rt.error })
  }
}
