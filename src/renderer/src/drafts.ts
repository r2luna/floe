import { useCallback, useEffect, useState } from 'react'

// Unsent text, kept per place you were typing.
//
// A draft belongs to its session, not to the composer: switching sessions and
// coming back must find the half-written message still there, and so must
// quitting and relaunching. Same store and same ceiling as the lane — see the
// note in laneStore.ts about localStorage and SIGKILL.

const KEY = 'floe.drafts'

// ponytail: 50 drafts, newest kept. Empty ones are dropped on write, so this
// only bites if you leave real text in 50 different sessions.
const MAX = 50

type Drafts = Record<string, string>

function read(): Drafts {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    // Only string values survive: anything else would be handed to a textarea.
    return parsed && typeof parsed === 'object'
      ? Object.fromEntries(
          Object.entries(parsed as Drafts).filter(([, v]) => typeof v === 'string')
        )
      : {}
  } catch {
    return {}
  }
}

/** Set (or clear) one draft. Exported for the test; the hook is the real door. */
export function put(drafts: Drafts, key: string, text: string): Drafts {
  const next = { ...drafts }
  // An empty draft is not a draft. Deleting rather than storing "" is what
  // keeps a sent message from lingering as a blank entry forever.
  delete next[key]
  if (text) next[key] = text
  const keys = Object.keys(next)
  if (keys.length <= MAX) return next
  return Object.fromEntries(keys.slice(keys.length - MAX).map((k) => [k, next[k]]))
}

function write(drafts: Drafts): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(drafts))
  } catch {
    /* quota or private mode — a draft is a convenience, never a requirement */
  }
}

/**
 * `useState` for a composer, with the value kept under `key`.
 *
 * Without a key (a composer with nowhere to belong yet) it behaves as plain
 * local state — there is no meaningful place to file the text, and inventing
 * one would leak it into whichever session opened next.
 */
export function useDraft(key?: string): [string, (text: string) => void] {
  const [text, setText] = useState(() => (key ? (read()[key] ?? '') : ''))

  // A composer that outlives a key change (the launcher, when you pick another
  // branch) reloads rather than carrying the old branch's text across.
  useEffect(() => {
    setText(key ? (read()[key] ?? '') : '')
  }, [key])

  const set = useCallback(
    (next: string) => {
      setText(next)
      if (key) write(put(read(), key, next))
    },
    [key]
  )

  return [text, set]
}
