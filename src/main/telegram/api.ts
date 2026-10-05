// The slice of the Telegram Bot API the bot speaks. Plain `fetch`, no SDK: six
// methods over JSON POST is less code than the dependency, and it runs the same
// under Electron and the headless daemon.
//
// `fetchFn` is injectable so the bot's tests drive a fake server instead of the
// network.

export interface TgChat {
  id: number
}

export interface TgMessage {
  message_id: number
  chat: TgChat
  text?: string
  reply_to_message?: { message_id: number }
}

export interface TgCallback {
  id: string
  data?: string
  message?: TgMessage
}

export interface TgUpdate {
  update_id: number
  message?: TgMessage
  callback_query?: TgCallback
}

export interface InlineButton {
  text: string
  callback_data: string
}

export interface SendOptions {
  replyTo?: number
  buttons?: InlineButton[][]
}

/** What Telegram said when it refused. `code` 409 means another poller holds this token. */
export class TelegramError extends Error {
  readonly code: number
  constructor(message: string, code: number) {
    super(message)
    this.code = code
  }
}

export interface BotApi {
  getMe(): Promise<{ username: string }>
  getUpdates(offset: number, signal?: AbortSignal): Promise<TgUpdate[]>
  sendMessage(chatId: number, text: string, opts?: SendOptions): Promise<TgMessage>
  editMessageText(chatId: number, messageId: number, text: string): Promise<unknown>
  answerCallback(id: string, text?: string): Promise<unknown>
  setCommands(commands: Array<{ command: string; description: string }>): Promise<unknown>
}

/** How long one getUpdates call parks on Telegram's side, in seconds. */
export const POLL_SECONDS = 50

interface Reply<T> {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
}

export const TELEGRAM_API = 'https://api.telegram.org'

export function createBotApi(token: string, fetchFn: typeof fetch = fetch, base = TELEGRAM_API): BotApi {
  const call = async <T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
    const res = await fetchFn(`${base}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal
    })
    const json = (await res.json()) as Reply<T>
    if (!json.ok) throw new TelegramError(json.description ?? `${method} failed`, json.error_code ?? res.status)
    return json.result as T
  }
  return {
    getMe: () => call('getMe', {}),
    getUpdates: (offset, signal) =>
      call('getUpdates', { offset, timeout: POLL_SECONDS, allowed_updates: ['message', 'callback_query'] }, signal),
    sendMessage: (chatId, text, opts = {}) =>
      call('sendMessage', {
        chat_id: chatId,
        text,
        ...(opts.replyTo && { reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: true } }),
        ...(opts.buttons && { reply_markup: { inline_keyboard: opts.buttons } })
      }),
    editMessageText: (chatId, messageId, text) =>
      call('editMessageText', { chat_id: chatId, message_id: messageId, text }),
    answerCallback: (id, text) => call('answerCallbackQuery', { callback_query_id: id, ...(text && { text }) }),
    setCommands: (commands) => call('setMyCommands', { commands })
  }
}
