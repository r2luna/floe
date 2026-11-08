/**
 * Say something into an open chat as if it had been typed there.
 *
 * For commands that speak for you (the top bar's commit): the chat that owns
 * the session sends it through its own `send`, so the message takes the
 * composer's model and mode and waits in the queue behind a busy turn, exactly
 * as a typed one would. A chat that is not open hears nothing; the caller opens
 * one with the message as its first prompt instead.
 */
const SAY = 'floe:say'

interface Said {
  sessionId: string
  text: string
}

export function sayTo(sessionId: string, text: string): void {
  window.dispatchEvent(new CustomEvent<Said>(SAY, { detail: { sessionId, text } }))
}

export function onSay(sessionId: string, fn: (text: string) => void): () => void {
  const hear = (e: Event): void => {
    const { detail } = e as CustomEvent<Said>
    if (detail.sessionId === sessionId) fn(detail.text)
  }
  window.addEventListener(SAY, hear)
  return () => window.removeEventListener(SAY, hear)
}
