import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TelegramError, createBotApi } from './api.ts'

interface Call {
  url: string
  body: Record<string, unknown>
}

function fakeFetch(reply: unknown, calls: Call[]): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) })
    return { status: 200, json: async () => reply }
  }) as unknown as typeof fetch
}

test('each method posts JSON to its Bot API url and returns the result', async () => {
  const calls: Call[] = []
  const api = createBotApi('TOKEN', fakeFetch({ ok: true, result: { message_id: 5, chat: { id: 1 } } }, calls))
  const sent = await api.sendMessage(1, 'hi', { replyTo: 3, buttons: [[{ text: 'A', callback_data: 'a' }]] })
  assert.equal(sent.message_id, 5)
  await api.sendMessage(1, 'plain')
  await api.getUpdates(9)
  await api.editMessageText(1, 5, 'edited')
  await api.answerCallback('cb')
  await api.answerCallback('cb', 'done')
  await api.setCommands([{ command: 'help', description: 'h' }])
  await api.getMe()
  assert.deepEqual(
    calls.map((c) => c.url.split('/').pop()),
    ['sendMessage', 'sendMessage', 'getUpdates', 'editMessageText', 'answerCallbackQuery', 'answerCallbackQuery', 'setMyCommands', 'getMe']
  )
  assert.equal(calls[0].url, 'https://api.telegram.org/botTOKEN/sendMessage')
  assert.deepEqual(calls[0].body, {
    chat_id: 1,
    text: 'hi',
    reply_parameters: { message_id: 3, allow_sending_without_reply: true },
    reply_markup: { inline_keyboard: [[{ text: 'A', callback_data: 'a' }]] }
  })
  assert.deepEqual(calls[1].body, { chat_id: 1, text: 'plain' })
  assert.equal(calls[2].body.offset, 9)
  assert.deepEqual(calls[4].body, { callback_query_id: 'cb' })
  assert.deepEqual(calls[5].body, { callback_query_id: 'cb', text: 'done' })
})

test('a refusal throws with Telegram’s code', async () => {
  const api = createBotApi('T', fakeFetch({ ok: false, error_code: 409, description: 'Conflict' }, []))
  await assert.rejects(api.getMe(), (e: unknown) => e instanceof TelegramError && e.code === 409 && e.message === 'Conflict')
  const bare = createBotApi('T', fakeFetch({ ok: false }, []))
  await assert.rejects(bare.getMe(), (e: unknown) => e instanceof TelegramError && e.code === 200 && e.message === 'getMe failed')
})
