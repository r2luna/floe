import { useCallback, useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { FileAttachment, ImageAttachment } from '../../shared/types'

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

/* --- what was pasted into the draft -------------------------------------- */

// Attachments belong to the draft the same way the text does: pasting a
// screenshot, stepping into another panel and coming back has to find it still
// there. They stay in memory rather than joining the text in localStorage —
// one screenshot is megabytes of base64, and it would evict every text draft
// in the store on its way to blowing the quota. Living for the run of the app
// is the whole bug; a relaunch losing them is the same deal a queued turn gets.

export type Pending = { images: ImageAttachment[]; files: FileAttachment[] }

const NONE: Pending = { images: [], files: [] }

// ponytail: 10 drafts holding attachments, newest kept. Bigger than anyone
// pastes into in one sitting, small enough that abandoned images are not held
// for the life of the process.
const MAX_PENDING = 10

const pending = new Map<string, Pending>()

/** Exported for the test; the hook is the real door. */
export function keep(store: Map<string, Pending>, key: string, next: Pending): void {
  store.delete(key)
  // Nothing attached is not a draft — same rule as the text, so a sent message
  // leaves no empty entry behind.
  if (!next.images.length && !next.files.length) return
  store.set(key, next)
  for (const old of [...store.keys()].slice(0, Math.max(0, store.size - MAX_PENDING)))
    store.delete(old)
}

/**
 * The images and files waiting under `key`, with `useState`'s setters.
 *
 * Without a key it is plain local state, for the same reason `useDraft` is:
 * there is nowhere to file them, and picking somewhere would hand them to
 * whichever composer opened next.
 */
export function usePending(key?: string): {
  images: ImageAttachment[]
  files: FileAttachment[]
  setImages: Dispatch<SetStateAction<ImageAttachment[]>>
  setFiles: Dispatch<SetStateAction<FileAttachment[]>>
} {
  const [state, setState] = useState<Pending>(() => (key ? (pending.get(key) ?? NONE) : NONE))

  useEffect(() => {
    setState(key ? (pending.get(key) ?? NONE) : NONE)
  }, [key])

  // The store is written from inside the updater so it can never disagree with
  // what the composer is showing: both come out of the same `prev`.
  const setImages = useCallback<Dispatch<SetStateAction<ImageAttachment[]>>>(
    (action) =>
      setState((prev) => {
        const images = typeof action === 'function' ? action(prev.images) : action
        const next = { ...prev, images }
        if (key) keep(pending, key, next)
        return next
      }),
    [key]
  )

  const setFiles = useCallback<Dispatch<SetStateAction<FileAttachment[]>>>(
    (action) =>
      setState((prev) => {
        const files = typeof action === 'function' ? action(prev.files) : action
        const next = { ...prev, files }
        if (key) keep(pending, key, next)
        return next
      }),
    [key]
  )

  return { images: state.images, files: state.files, setImages, setFiles }
}
