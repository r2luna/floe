import { useEffect } from 'react'

// Tell every backend someone is at this window — the Telegram bot on each one
// stays quiet while that is true (main/telegram/presence.ts). Only with the
// window focused: a Floe behind other apps is not one you are using.
//
// Throttled, because the away threshold is minutes and pointermove fires per
// pixel.
const EVERY_MS = 20_000
const EVENTS = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'focus'] as const

export function usePresence(): void {
  useEffect(() => {
    let last = 0
    const ping = (): void => {
      const now = Date.now()
      if (now - last < EVERY_MS || !document.hasFocus()) return
      last = now
      window.floe.presence()
    }
    for (const e of EVENTS) window.addEventListener(e, ping, { capture: true, passive: true })
    ping()
    return () => {
      for (const e of EVENTS) window.removeEventListener(e, ping, { capture: true })
    }
  }, [])
}
