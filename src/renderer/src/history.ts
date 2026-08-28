// What you've already sent, oldest first — the ↑/↓ history in the composer.
//
// One list for the whole app, not per session: you reach for the last thing you
// typed, and where you typed it is rarely what you remember about it.

const KEY = 'rookery.history'

// ponytail: 100 entries in localStorage. Move it to the store if it ever has to
// survive a cleared browser profile.
const MAX = 100

export function readHistory(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/** Append, oldest first. Exported for the test; `pushHistory` is the real door. */
export function push(list: string[], text: string): string[] {
  const entry = text.trim()
  // Nothing to recall in an empty message, and repeating the last one only
  // makes you press ↑ twice to get past it.
  if (!entry || entry === list[list.length - 1]) return list
  return [...list, entry].slice(-MAX)
}

export function pushHistory(text: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(push(readHistory(), text)))
  } catch {
    /* quota or private mode — history is a convenience, never a requirement */
  }
}
