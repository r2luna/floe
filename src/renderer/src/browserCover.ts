import { useEffect, useSyncExternalStore } from 'react'

// Overlays that live deep in a panel (the image lightbox) and never reach App's
// state. The browser's native WebContentsView paints above all renderer HTML,
// so App hides it while any of these is up, same as for the palette.
let covers = 0
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Mark the browser view as covered for as long as the caller is mounted. */
export function useBrowserCover(): void {
  useEffect(() => {
    covers++
    emit()
    return () => {
      covers--
      emit()
    }
  }, [])
}

/** True while any `useBrowserCover` caller is mounted. */
export function useBrowserCovered(): boolean {
  return useSyncExternalStore(subscribe, () => covers > 0)
}
