// One fold for every chat: it is how you like the strip, not a fact about a session.
const FOLD_KEY = 'floe.checklist.folded'
const listeners = new Set<() => void>()

export const isChecklistFolded = (): boolean => localStorage.getItem(FOLD_KEY) === '1'

export function toggleChecklistFold(): boolean {
  const folded = !isChecklistFolded()
  localStorage.setItem(FOLD_KEY, folded ? '1' : '0')
  for (const listener of listeners) listener()
  return folded
}

export function subscribeChecklistFold(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
