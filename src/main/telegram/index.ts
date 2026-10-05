// The Telegram bot, wired to the real app: the agent event stream in, the same
// door as send_message out, and the poll loop that keeps it listening.
//
// One bot per machine (see config.ts). It runs in the desktop app and in the
// headless daemon alike — nothing here needs a window.

import { join } from 'node:path'
import { dataDir } from '../dataDir'
import { log } from '../log'
import { answerQuestion, respondPermission, tapAgentEvents } from '../agent'
import { answerCodexQuestion } from '../codexServer'
import { colonySessionIds } from '../colony/store'
import { sessionTitle } from '../claudeSessions'
import { recentSessions } from '../sessionIndex'
import { findSessionAny, promptsFor, sendAsUser } from '../mcpServer'
import { isQueryKey } from '../../shared/queries'
import type { CreatedSession } from '../sessionStore'
import { TelegramError, createBotApi, type BotApi } from './api'
import { createBot, runPoll, type BotDeps } from './bot'
import { COMMANDS, type SessionInfo } from './format'
import {
  applySetup,
  readTelegramConfig,
  statusOf,
  writeTelegramConfig,
  type SetupInput,
  type TelegramConfig,
  type TelegramStatus
} from './config'
import { isAway, lastSeenAt, markAway } from './presence'

const configPath = (): string => join(dataDir(), 'telegram.json')

// Points the bot at a stand-in for Telegram — how the bot is driven end to end
// without a real token.
const apiFor = (token: string): BotApi => createBotApi(token, fetch, process.env.FLOE_TELEGRAM_API || undefined)

let cfg: TelegramConfig = { awayAfterMinutes: 0, enabled: false }
let running: { stop: () => void; current: () => string | undefined } | undefined
let botName: string | undefined
let lastError: string | undefined

const info = (s: CreatedSession): SessionInfo => ({ id: s.id, title: sessionTitle(s), worktreePath: s.worktreePath })

/** The chats the bot speaks for: yours, not a query, a colony lane or a session an agent opened. */
function resolve(key: string): SessionInfo | null {
  if (isQueryKey(key)) return null
  const s = findSessionAny(key)
  if (!s || s.spawnedBy || colonySessionIds().has(s.id)) return null
  return info(s)
}

function pair(code: string, chatId: number): boolean {
  if (!cfg.pairCode || code !== cfg.pairCode) return false
  cfg = { ...cfg, chatId }
  delete cfg.pairCode
  writeTelegramConfig(configPath(), cfg)
  log('telegram:paired', { chatId })
  return true
}

function deps(api: BotApi): BotDeps {
  return {
    api,
    chatId: () => cfg.chatId,
    pair,
    away: () => isAway(cfg.awayAfterMinutes * 60_000),
    markAway,
    resolve,
    byId: (id) => {
      const s = findSessionAny(id)
      return s ? info(s) : null
    },
    recent: async (limit) =>
      (await recentSessions(limit)).flatMap((a) => {
        const s = findSessionAny(a.sessionId)
        return s ? [info(s)] : []
      }),
    send: sendAsUser,
    prompts: promptsFor,
    allow: (key, requestId, allow) => respondPermission(key, requestId, allow),
    // Codex questions travel the app-server's JSON-RPC, Claude's the control
    // channel — the same order answer_session_prompt tries them in.
    answer: (key, requestId, text) => {
      if (!answerCodexQuestion(key, [[text]])) answerQuestion(key, requestId, text)
    },
    log
  }
}

const wait = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })

function describe(e: Error): string {
  if (e instanceof TelegramError && e.code === 409)
    return 'Another process is polling this bot token. Each machine needs its own bot.'
  return e.message
}

export function stopTelegram(): void {
  running?.stop()
  running = undefined
}

/** (Re)start from the stored config. A bot with no token, or switched off, just stays down. */
export function startTelegram(): void {
  stopTelegram()
  cfg = readTelegramConfig(configPath())
  if (!cfg.token || !cfg.enabled) return
  const api = apiFor(cfg.token)
  const bot = createBot(deps(api))
  const abort = new AbortController()
  const untap = tapAgentEvents((key, event) => bot.onEvent(key, event))
  running = {
    stop: () => {
      abort.abort()
      untap()
    },
    current: () => bot.current()
  }
  void api.setCommands(COMMANDS).catch(() => {})
  void api
    .getMe()
    .then((me) => {
      botName = me.username
    })
    .catch(() => {})
  void runPoll(api, bot, abort.signal, {
    onOk: () => {
      lastError = undefined
    },
    onError: (e) => {
      lastError = describe(e)
      log('telegram:error', { error: e.message })
    },
    wait
  })
  log('telegram:started', { paired: cfg.chatId !== undefined })
}

export function telegramStatus(): TelegramStatus {
  return statusOf(cfg, {
    running: running !== undefined,
    botName,
    away: isAway(cfg.awayAfterMinutes * 60_000),
    lastSeenAt: lastSeenAt(),
    current: running?.current(),
    error: lastError
  })
}

/** Save a setup change and restart. A new token is checked with Telegram before it is kept. */
export async function setupTelegram(input: SetupInput): Promise<TelegramStatus> {
  const stored = readTelegramConfig(configPath())
  const next = applySetup(stored, input)
  if (next.token && (input.token !== undefined || !botName)) {
    botName = (await apiFor(next.token).getMe()).username
  }
  writeTelegramConfig(configPath(), next)
  startTelegram()
  return telegramStatus()
}
