// The bot's behaviour: which agent events go to Telegram, and what a message
// or a button tap from Telegram does to a chat.
//
// Everything it touches outside itself comes in through `BotDeps`, so the tests
// drive it with a fake Bot API and a fake session store. The wiring to the real
// ones — and the poll loop — is index.ts.

import type { AgentEvent, AgentPermission, AgentQuestion } from '../../shared/types'
import type { BotApi, InlineButton, TgCallback, TgMessage, TgUpdate } from './api'
import {
  HELP,
  doneMessages,
  errorMessage,
  parseCommand,
  permissionMessage,
  questionMessage,
  sessionLabel,
  type SessionInfo
} from './format'

export interface Prompt {
  requestId: string
  kind: 'question' | 'permission'
  questions?: AgentQuestion[]
}

export interface BotDeps {
  api: BotApi
  chatId(): number | undefined
  /** Pair this chat when `code` is the pending one. True when it was. */
  pair(code: string, chatId: number): boolean
  away(): boolean
  markAway(): void
  /** The chat an event key belongs to; null for one the bot stays out of (a query, a lane, an agent's session). */
  resolve(key: string): SessionInfo | null
  byId(id: string): SessionInfo | null
  recent(limit: number): Promise<SessionInfo[]>
  /** Send a message into a chat. Returns an error to show, or undefined when it went. */
  send(sessionId: string, text: string): string | undefined
  prompts(key: string): Prompt[]
  allow(key: string, requestId: string, allow: boolean): void
  answer(key: string, requestId: string, text: string): void
  log(event: string, data?: Record<string, unknown>): void
}

/** A question or permission the bot put on the phone, until it is answered. */
interface Pending {
  key: string
  sessionId: string
  requestId: string
  kind: Prompt['kind']
  label: string
  /** The option labels when there is exactly one question, in button order. */
  options: string[]
}

/** What a message the bot sent belongs to — the chat, and the prompt if it was one. */
interface Target {
  sessionId: string
  pending?: number
}

/** How many sent messages stay answerable by reply. Older ones fall back to the current chat. */
const KEEP = 500

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value)
  if (map.size > KEEP) map.delete(map.keys().next().value as K)
}

export interface Bot {
  onEvent(key: string, event: AgentEvent): void
  onUpdate(update: TgUpdate): Promise<void>
  /** The chat plain text goes to, for status. */
  current(): string | undefined
}

/** A class rather than a closure so each step is its own unit for CRAP — see docs/crap.md. */
class TelegramBot implements Bot {
  /** The final assistant message of each running turn, by event key. */
  private buffers = new Map<string, string>()
  private errored = new Set<string>()
  private byMessage = new Map<number, Target>()
  private pending = new Map<number, Pending>()
  private nextPending = 1
  private chat: string | undefined
  private listed: SessionInfo[] = []
  private deps: BotDeps

  constructor(deps: BotDeps) {
    this.deps = deps
  }

  current(): string | undefined {
    return this.chat
  }

  private async say(text: string, target?: Target, buttons?: InlineButton[][]): Promise<void> {
    const chatId = this.deps.chatId()
    if (chatId === undefined) return
    try {
      const sent = await this.deps.api.sendMessage(chatId, text, { buttons })
      if (target) remember(this.byMessage, sent.message_id, target)
    } catch (e) {
      this.deps.log('telegram:send-failed', { error: (e as Error).message })
    }
  }

  private async sayAll(texts: string[], target: Target): Promise<void> {
    for (const text of texts) await this.say(text, target)
  }

  // --- agent events → Telegram ---------------------------------------------

  onEvent(key: string, event: AgentEvent): void {
    if (this.deps.chatId() === undefined) return
    const s = this.deps.resolve(key)
    if (!s) return
    switch (event.kind) {
      case 'turn':
        this.buffers.set(key, '')
        this.errored.delete(key)
        return
      case 'text':
        this.buffers.set(key, (this.buffers.get(key) ?? '') + event.text)
        return
      // Only the last message is the answer; what came before a tool call was
      // the agent narrating its way there.
      case 'tool':
        this.buffers.set(key, '')
        return
      case 'done':
        return this.finish(key, s, event.ok)
      case 'error':
        return this.fail(key, s, event.message)
      case 'permission':
        return this.askPermission(key, s, event.permission)
      case 'question':
        return this.askQuestion(key, s, event.questions)
    }
  }

  private finish(key: string, s: SessionInfo, ok: boolean): void {
    const text = this.buffers.get(key) ?? ''
    this.buffers.delete(key)
    if (this.errored.delete(key) || !this.deps.away()) return
    this.chat = s.id
    void this.sayAll(doneMessages(sessionLabel(s), text, ok), { sessionId: s.id })
  }

  private fail(key: string, s: SessionInfo, message: string): void {
    this.buffers.delete(key)
    this.errored.add(key)
    if (!this.deps.away()) return
    this.chat = s.id
    void this.say(errorMessage(sessionLabel(s), message), { sessionId: s.id })
  }

  private track(key: string, s: SessionInfo, prompt: Prompt): number {
    const questions = prompt.questions ?? []
    const options = questions.length === 1 ? questions[0].options.map((o) => o.label) : []
    const id = this.nextPending++
    remember(this.pending, id, {
      key,
      sessionId: s.id,
      requestId: prompt.requestId,
      kind: prompt.kind,
      label: sessionLabel(s),
      options
    })
    return id
  }

  private askPermission(key: string, s: SessionInfo, p: AgentPermission): void {
    if (!this.deps.away()) return
    this.chat = s.id
    const id = this.track(key, s, { requestId: p.requestId, kind: 'permission' })
    const buttons = [[{ text: 'Allow', callback_data: `y:${id}` }, { text: 'Deny', callback_data: `n:${id}` }]]
    void this.say(permissionMessage(sessionLabel(s), p), { sessionId: s.id, pending: id }, buttons)
  }

  private askQuestion(key: string, s: SessionInfo, questions: AgentQuestion[]): void {
    if (!this.deps.away()) return
    // The event carries the questions but not the control request's id; the
    // conn's pending list has both. The newest question is this one.
    const prompt = this.deps.prompts(key).filter((p) => p.kind === 'question').pop()
    if (!prompt) return
    this.chat = s.id
    const id = this.track(key, s, { ...prompt, questions: prompt.questions ?? questions })
    const buttons = this.pending
      .get(id)!
      .options.map((label, i) => [{ text: label.slice(0, 60), callback_data: `q:${id}:${i}` }])
    void this.say(questionMessage(sessionLabel(s), questions), { sessionId: s.id, pending: id }, buttons)
  }

  // --- Telegram → chats ----------------------------------------------------

  async onUpdate(u: TgUpdate): Promise<void> {
    if (u.callback_query) await this.onCallback(u.callback_query)
    else if (u.message) await this.onMessage(u.message)
  }

  /** Answer a prompt, unless the computer already did. False when it was gone. */
  private settle(p: Pending, reply: { allow?: boolean; text?: string }): boolean {
    if (!this.deps.prompts(p.key).some((x) => x.requestId === p.requestId)) return false
    if (p.kind === 'permission') this.deps.allow(p.key, p.requestId, reply.allow === true)
    else this.deps.answer(p.key, p.requestId, reply.text ?? '')
    return true
  }

  private async onCallback(cb: TgCallback): Promise<void> {
    const msg = cb.message
    if (!msg || msg.chat.id !== this.deps.chatId()) return
    const [verb, rawId, rawOption] = (cb.data ?? '').split(':')
    if (verb === 'use') await this.pick(cb, Number(rawId))
    else await this.tap(cb, msg, verb, Number(rawId), Number(rawOption))
  }

  private async pick(cb: TgCallback, index: number): Promise<void> {
    const s = this.listed[index]
    if (s) this.chat = s.id
    await this.deps.api.answerCallback(cb.id, s ? `Talking to ${s.title}` : 'That list is stale — /sessions again.')
  }

  /** A button on a prompt: `y`/`n` on a permission, `q:<id>:<option>` on a question. */
  private async tap(cb: TgCallback, msg: TgMessage, verb: string, id: number, option: number): Promise<void> {
    const p = this.pending.get(id)
    const reply = verb === 'q' ? { text: p?.options[option] } : { allow: verb === 'y' }
    const ok = p !== undefined && (verb !== 'q' || reply.text !== undefined) && this.settle(p, reply)
    this.pending.delete(id)
    const result = !ok ? 'Already answered.' : (reply.text ?? (reply.allow ? 'Allowed' : 'Denied'))
    await this.deps.api.answerCallback(cb.id, result)
    if (!ok) return
    this.chat = p.sessionId
    await this.deps.api.editMessageText(msg.chat.id, msg.message_id, `${msg.text ?? p.label}\n\n→ ${result}`)
  }

  private async listSessions(): Promise<void> {
    this.listed = await this.deps.recent(10)
    if (!this.listed.length) return this.say('No chats yet.')
    const buttons = this.listed.map((s, i) => [{ text: sessionLabel(s).slice(0, 60), callback_data: `use:${i}` }])
    await this.say('Pick a chat — plain text then goes to it:', undefined, buttons)
  }

  private async status(): Promise<void> {
    const s = this.chat ? this.deps.byId(this.chat) : null
    const where = s ? sessionLabel(s) : 'none — /sessions to pick one'
    await this.say(`Away: ${this.deps.away() ? 'yes' : 'no'}\nCurrent chat: ${where}`)
  }

  private async command(name: string): Promise<boolean> {
    if (name === 'sessions') await this.listSessions()
    else if (name === 'status') await this.status()
    else if (name === 'help' || name === 'start') await this.say(HELP)
    else return false
    return true
  }

  /** The newest question this chat asked over Telegram, by its pending id. */
  private openQuestion(sessionId: string): number | undefined {
    return [...this.pending].reverse().find(([, p]) => p.sessionId === sessionId && p.kind === 'question')?.[0]
  }

  /**
   * Text to a chat. A reply to a prompt answers it (`yes`/`allow`/`ok` allows a
   * permission, anything else denies it); plain text answers the chat's open
   * question; otherwise it is a new message.
   */
  private async deliver(target: Target, text: string): Promise<void> {
    const id = target.pending ?? this.openQuestion(target.sessionId)
    const p = id !== undefined ? this.pending.get(id) : undefined
    if (p && this.settle(p, { text, allow: /^(y|yes|allow|ok)$/i.test(text) })) {
      this.pending.delete(id!)
      this.chat = p.sessionId
      return
    }
    const s = this.deps.byId(target.sessionId)
    if (!s) return this.say('That chat is gone. /sessions to pick another.')
    this.chat = s.id
    const error = this.deps.send(s.id, text)
    if (error) await this.say(`Could not send to ${sessionLabel(s)}: ${error}`)
  }

  /** Strangers get nothing back — a bot that answers announces itself. Only the right code pairs. */
  private async stranger(text: string, chatId: number): Promise<void> {
    const cmd = parseCommand(text)
    if (cmd && (cmd.name === 'pair' || cmd.name === 'start') && this.deps.pair(cmd.arg, chatId)) {
      await this.say(`Paired. ${HELP}`)
    }
  }

  private async onMessage(msg: TgMessage): Promise<void> {
    const text = msg.text?.trim()
    if (!text) return
    if (msg.chat.id !== this.deps.chatId()) return this.stranger(text, msg.chat.id)
    // You are on your phone: whatever this sets off has to come back here.
    this.deps.markAway()
    const cmd = parseCommand(text)
    if (cmd && (await this.command(cmd.name))) return
    const replied = msg.reply_to_message && this.byMessage.get(msg.reply_to_message.message_id)
    const target = replied || (this.chat ? { sessionId: this.chat } : undefined)
    if (!target) return this.say('No chat picked yet. /sessions to pick one.')
    await this.deliver(target, text)
  }
}

export function createBot(deps: BotDeps): Bot {
  return new TelegramBot(deps)
}

export interface PollHooks {
  onOk(): void
  onError(e: Error): void
  wait(ms: number, signal: AbortSignal): Promise<void>
}

const FIRST_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 60_000

/**
 * Long-poll getUpdates until `signal` aborts. A failed poll backs off, doubling
 * to a minute — a 409 (another machine polling this token) or a network drop
 * must not spin. A failed handler is logged and the update is still consumed:
 * one bad message must not be redelivered forever.
 */
export async function runPoll(
  api: BotApi,
  bot: Pick<Bot, 'onUpdate'>,
  signal: AbortSignal,
  hooks: PollHooks
): Promise<void> {
  let offset = 0
  let backoff = FIRST_BACKOFF_MS
  while (!signal.aborted) {
    try {
      const updates = await api.getUpdates(offset, signal)
      hooks.onOk()
      backoff = FIRST_BACKOFF_MS
      for (const u of updates) {
        offset = u.update_id + 1
        await bot.onUpdate(u).catch((e: Error) => hooks.onError(e))
      }
    } catch (e) {
      if (signal.aborted) return
      hooks.onError(e as Error)
      await hooks.wait(backoff, signal)
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
    }
  }
}
