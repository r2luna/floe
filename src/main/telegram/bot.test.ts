import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installHook } from '../config/hook.test-helper.ts'
import type { BotApi, SendOptions, TgUpdate } from './api.ts'
import type { BotDeps, Prompt } from './bot.ts'
import type { SessionInfo } from './format.ts'

installHook()
const { createBot, runPoll } = await import('./bot.ts')
const { TelegramError } = await import('./api.ts')

const CHAT = 42
const A: SessionInfo = { id: 'a', title: 'Alpha', worktreePath: '/code/floe' }
const B: SessionInfo = { id: 'b', title: 'Beta', worktreePath: '/code/other' }

interface Sent {
  chatId: number
  text: string
  opts?: SendOptions
  id: number
}

function harness(over: Partial<BotDeps> = {}) {
  const sent: Sent[] = []
  const edits: string[] = []
  const callbacks: Array<string | undefined> = []
  const delivered: Array<{ id: string; text: string }> = []
  const allowed: Array<{ requestId: string; allow: boolean }> = []
  const answered: Array<{ requestId: string; text: string }> = []
  const state = { away: true, chatId: CHAT as number | undefined, prompts: [] as Prompt[], awayMarks: 0 }
  let nextId = 100
  const api: BotApi = {
    getMe: async () => ({ username: 'floe_bot' }),
    getUpdates: async () => [],
    sendMessage: async (chatId, text, opts) => {
      const id = nextId++
      sent.push({ chatId, text, opts, id })
      return { message_id: id, chat: { id: chatId }, text }
    },
    editMessageText: async (_c, _m, text) => edits.push(text),
    answerCallback: async (_id, text) => callbacks.push(text),
    setCommands: async () => true
  }
  const sessions = new Map([
    ['a', A],
    ['claude-a', A],
    ['b', B]
  ])
  const deps: BotDeps = {
    api,
    chatId: () => state.chatId,
    pair: (code, chatId) => {
      if (code !== '123456') return false
      state.chatId = chatId
      return true
    },
    away: () => state.away,
    markAway: () => {
      state.awayMarks++
    },
    resolve: (key) => sessions.get(key) ?? null,
    byId: (id) => sessions.get(id) ?? null,
    recent: async () => [A, B],
    send: (id, text) => {
      delivered.push({ id, text })
      return id === 'b' ? 'boom' : undefined
    },
    prompts: () => state.prompts,
    allow: (_key, requestId, allow) => allowed.push({ requestId, allow }),
    answer: (_key, requestId, text) => answered.push({ requestId, text }),
    log: () => {},
    ...over
  }
  const bot = createBot(deps)
  const flush = (): Promise<void> => new Promise((r) => setImmediate(r))
  const msg = (text: string, extra: Record<string, unknown> = {}): TgUpdate => ({
    update_id: 1,
    message: { message_id: 1, chat: { id: CHAT }, text, ...extra }
  })
  const tap = (data: string, messageId = 1, chat = CHAT): TgUpdate => ({
    update_id: 1,
    callback_query: { id: 'cb', data, message: { message_id: messageId, chat: { id: chat }, text: 'prompt' } }
  })
  return { bot, sent, edits, callbacks, delivered, allowed, answered, state, flush, msg, tap }
}

test('a finished turn while away sends its final message, labelled', async () => {
  const h = harness()
  h.bot.onEvent('claude-a', { kind: 'turn' })
  h.bot.onEvent('claude-a', { kind: 'text', text: 'Looking…' })
  h.bot.onEvent('claude-a', { kind: 'tool', name: 'Read' })
  h.bot.onEvent('claude-a', { kind: 'text', text: 'Done. ' })
  h.bot.onEvent('claude-a', { kind: 'text', text: 'All green.' })
  h.bot.onEvent('claude-a', { kind: 'done', ok: true })
  await h.flush()
  assert.deepEqual(h.sent.map((s) => s.text), ['✅ floe · Alpha\n\nDone. All green.'])
  assert.equal(h.bot.current(), 'a')
})

test('nothing is sent while you are at Floe, unpaired, or for a chat the bot stays out of', async () => {
  const h = harness()
  h.state.away = false
  h.bot.onEvent('a', { kind: 'text', text: 'x' })
  h.bot.onEvent('a', { kind: 'done', ok: true })
  h.bot.onEvent('a', { kind: 'error', message: 'x' })
  h.bot.onEvent('a', { kind: 'permission', permission: { requestId: 'r', toolName: 'Bash' } })
  h.bot.onEvent('a', { kind: 'question', toolUseId: 't', questions: [] })
  h.state.away = true
  h.bot.onEvent('lane', { kind: 'done', ok: true })
  h.state.chatId = undefined
  h.bot.onEvent('a', { kind: 'done', ok: true })
  await h.flush()
  assert.deepEqual(h.sent, [])
})

test('an error is sent once, not again by the done that follows', async () => {
  const h = harness()
  h.bot.onEvent('a', { kind: 'error', message: 'rate limited' })
  h.bot.onEvent('a', { kind: 'done', ok: false })
  await h.flush()
  assert.deepEqual(h.sent.map((s) => s.text), ['⚠️ floe · Alpha\n\nrate limited'])
})

test('a permission gets Allow/Deny buttons, and a tap answers it and marks the message', async () => {
  const h = harness()
  h.state.prompts = [{ requestId: 'r1', kind: 'permission' }]
  h.bot.onEvent('a', { kind: 'permission', permission: { requestId: 'r1', toolName: 'Bash', summary: 'ls' } })
  await h.flush()
  const buttons = h.sent[0].opts?.buttons?.[0] ?? []
  assert.deepEqual(buttons.map((b) => b.text), ['Allow', 'Deny'])
  await h.bot.onUpdate(h.tap(buttons[0].callback_data))
  assert.deepEqual(h.allowed, [{ requestId: 'r1', allow: true }])
  assert.deepEqual(h.callbacks, ['Allowed'])
  assert.deepEqual(h.edits, ['prompt\n\n→ Allowed'])
  // A second tap on the same message finds nothing left to answer.
  await h.bot.onUpdate(h.tap(buttons[1].callback_data))
  assert.deepEqual(h.callbacks, ['Allowed', 'Already answered.'])
  assert.equal(h.allowed.length, 1)
})

test('a prompt answered at the computer is not answered again from the phone', async () => {
  const h = harness()
  h.state.prompts = [{ requestId: 'r1', kind: 'permission' }]
  h.bot.onEvent('a', { kind: 'permission', permission: { requestId: 'r1', toolName: 'Bash' } })
  await h.flush()
  h.state.prompts = []
  await h.bot.onUpdate(h.tap(h.sent[0].opts!.buttons![0][1].callback_data))
  assert.deepEqual(h.allowed, [])
  assert.deepEqual(h.callbacks, ['Already answered.'])
  assert.deepEqual(h.edits, [])
})

test('a question shows its options as buttons and a tap answers with that option', async () => {
  const h = harness()
  const questions = [{ question: 'Which?', options: [{ label: 'Red' }, { label: 'Blue' }] }]
  h.state.prompts = [{ requestId: 'q1', kind: 'question', questions }]
  h.bot.onEvent('a', { kind: 'question', toolUseId: 't', questions })
  await h.flush()
  const rows = h.sent[0].opts?.buttons ?? []
  assert.deepEqual(rows.map((r) => r[0].text), ['Red', 'Blue'])
  await h.bot.onUpdate(h.tap(rows[1][0].callback_data))
  assert.deepEqual(h.answered, [{ requestId: 'q1', text: 'Blue' }])
  assert.deepEqual(h.callbacks, ['Blue'])
})

test('a question tap with an option that does not exist answers nothing', async () => {
  const h = harness()
  const questions = [{ question: 'Which?', options: [{ label: 'Red' }] }]
  h.state.prompts = [{ requestId: 'q1', kind: 'question', questions }]
  h.bot.onEvent('a', { kind: 'question', toolUseId: 't', questions })
  await h.flush()
  const id = h.sent[0].opts!.buttons![0][0].callback_data.split(':')[1]
  await h.bot.onUpdate(h.tap(`q:${id}:9`))
  assert.deepEqual(h.answered, [])
})

test('a question with no pending request is not sent', async () => {
  const h = harness()
  h.bot.onEvent('a', { kind: 'question', toolUseId: 't', questions: [{ question: '?', options: [] }] })
  await h.flush()
  assert.deepEqual(h.sent, [])
})

test('plain text answers the open question of the current chat', async () => {
  const h = harness()
  const questions = [{ question: 'Name?', options: [] }]
  h.state.prompts = [{ requestId: 'q1', kind: 'question', questions }]
  h.bot.onEvent('a', { kind: 'question', toolUseId: 't', questions })
  await h.flush()
  await h.bot.onUpdate(h.msg('Bolinha'))
  assert.deepEqual(h.answered, [{ requestId: 'q1', text: 'Bolinha' }])
  assert.deepEqual(h.delivered, [])
  assert.equal(h.state.awayMarks, 1)
})

test('replying "yes" to a permission allows it, anything else denies it', async () => {
  const h = harness()
  h.state.prompts = [
    { requestId: 'r1', kind: 'permission' },
    { requestId: 'r2', kind: 'permission' }
  ]
  h.bot.onEvent('a', { kind: 'permission', permission: { requestId: 'r1', toolName: 'Bash' } })
  h.bot.onEvent('a', { kind: 'permission', permission: { requestId: 'r2', toolName: 'Bash' } })
  await h.flush()
  await h.bot.onUpdate(h.msg('yes', { reply_to_message: { message_id: h.sent[0].id } }))
  await h.bot.onUpdate(h.msg('no, use git', { reply_to_message: { message_id: h.sent[1].id } }))
  assert.deepEqual(h.allowed, [
    { requestId: 'r1', allow: true },
    { requestId: 'r2', allow: false }
  ])
})

test('a reply goes to the chat that message came from; plain text to the current one', async () => {
  const h = harness()
  h.bot.onEvent('a', { kind: 'done', ok: true })
  await h.flush()
  await h.bot.onUpdate(h.msg('/sessions'))
  await h.bot.onUpdate(h.tap('use:1', h.sent[1].id))
  assert.equal(h.bot.current(), 'b')
  assert.deepEqual(h.callbacks, ['Talking to Beta'])
  await h.bot.onUpdate(h.msg('to alpha', { reply_to_message: { message_id: h.sent[0].id } }))
  assert.equal(h.bot.current(), 'a')
  await h.bot.onUpdate(h.msg('also alpha'))
  assert.deepEqual(h.delivered, [
    { id: 'a', text: 'to alpha' },
    { id: 'a', text: 'also alpha' }
  ])
})

test('a send that fails says why', async () => {
  const h = harness()
  await h.bot.onUpdate(h.msg('/sessions'))
  await h.bot.onUpdate(h.tap('use:1', h.sent[0].id))
  await h.bot.onUpdate(h.msg('hello'))
  assert.equal(h.sent.at(-1)?.text, 'Could not send to other · Beta: boom')
})

test('with no chat picked, plain text asks you to pick one', async () => {
  const h = harness()
  await h.bot.onUpdate(h.msg('hello'))
  assert.equal(h.sent.at(-1)?.text, 'No chat picked yet. /sessions to pick one.')
  await h.bot.onUpdate(h.tap('use:7'))
  assert.deepEqual(h.callbacks, ['That list is stale — /sessions again.'])
})

test('a chat that is gone says so', async () => {
  const h = harness({ byId: () => null })
  h.bot.onEvent('a', { kind: 'done', ok: true })
  await h.flush()
  await h.bot.onUpdate(h.msg('hi'))
  assert.equal(h.sent.at(-1)?.text, 'That chat is gone. /sessions to pick another.')
})

test('status, help and an empty session list', async () => {
  const h = harness({ recent: async () => [] })
  await h.bot.onUpdate(h.msg('/status'))
  assert.equal(h.sent.at(-1)?.text, 'Away: yes\nCurrent chat: none — /sessions to pick one')
  h.bot.onEvent('a', { kind: 'done', ok: true })
  await h.flush()
  h.state.away = false
  await h.bot.onUpdate(h.msg('/status'))
  assert.equal(h.sent.at(-1)?.text, 'Away: no\nCurrent chat: floe · Alpha')
  await h.bot.onUpdate(h.msg('/help'))
  assert.match(h.sent.at(-1)?.text ?? '', /^Floe relays your chats/)
  await h.bot.onUpdate(h.msg('/sessions'))
  assert.equal(h.sent.at(-1)?.text, 'No chats yet.')
})

test('an unknown command is sent to the chat as text', async () => {
  const h = harness()
  h.bot.onEvent('a', { kind: 'done', ok: true })
  await h.flush()
  await h.bot.onUpdate(h.msg('/deploy patch'))
  assert.deepEqual(h.delivered, [{ id: 'a', text: '/deploy patch' }])
})

test('strangers are ignored unless they pair with the right code', async () => {
  const h = harness()
  h.state.chatId = undefined
  const stranger = (text: string): TgUpdate => ({ update_id: 1, message: { message_id: 1, chat: { id: 7 }, text } })
  await h.bot.onUpdate(stranger('hello'))
  await h.bot.onUpdate(stranger('/pair 000000'))
  assert.equal(h.sent.length, 0)
  await h.bot.onUpdate(stranger('/pair 123456'))
  assert.equal(h.state.chatId, 7)
  assert.match(h.sent[0].text, /^Paired\./)
  // Taps from another chat do nothing either.
  await h.bot.onUpdate(h.tap('use:0', 1, 99))
  await h.bot.onUpdate({ update_id: 2, callback_query: { id: 'x', data: 'use:0' } })
  await h.bot.onUpdate({ update_id: 3, message: { message_id: 1, chat: { id: 7 } } })
  assert.deepEqual(h.callbacks, [])
})

test('a send that Telegram refuses is logged, not thrown', async () => {
  const logged: string[] = []
  const failing = harness({
    log: (e) => logged.push(e),
    api: {
      ...({} as BotApi),
      sendMessage: async () => {
        throw new Error('blocked')
      }
    }
  })
  failing.bot.onEvent('a', { kind: 'done', ok: true })
  await failing.flush()
  assert.deepEqual(logged, ['telegram:send-failed'])
})

test('the poll loop consumes updates, backs off on failure, and stops on abort', async () => {
  const abort = new AbortController()
  const seen: number[] = []
  const errors: string[] = []
  const waits: number[] = []
  const offsets: number[] = []
  const script: Array<() => TgUpdate[]> = [
    () => [{ update_id: 5 }, { update_id: 6 }],
    () => {
      throw new TelegramError('Conflict', 409)
    },
    () => {
      throw new Error('net down')
    },
    () => {
      abort.abort()
      return []
    }
  ]
  const api = {
    getUpdates: async (offset: number) => {
      offsets.push(offset)
      return script.shift()!()
    }
  } as unknown as BotApi
  await runPoll(
    api,
    {
      onUpdate: async (u) => {
        seen.push(u.update_id)
        if (u.update_id === 6) throw new Error('bad update')
      }
    },
    abort.signal,
    {
      onOk: () => errors.push('ok'),
      onError: (e) => errors.push(e.message),
      wait: async (ms) => {
        waits.push(ms)
      }
    }
  )
  assert.deepEqual(seen, [5, 6])
  assert.deepEqual(offsets, [0, 7, 7, 7])
  assert.deepEqual(errors, ['ok', 'bad update', 'Conflict', 'net down', 'ok'])
  assert.deepEqual(waits, [1000, 2000])
})

test('an abort during a failing poll ends the loop without reporting', async () => {
  const abort = new AbortController()
  const errors: string[] = []
  const api = {
    getUpdates: async () => {
      abort.abort()
      throw new Error('aborted')
    }
  } as unknown as BotApi
  await runPoll(api, { onUpdate: async () => {} }, abort.signal, {
    onOk: () => {},
    onError: (e) => errors.push(e.message),
    wait: async () => {}
  })
  assert.deepEqual(errors, [])
})
