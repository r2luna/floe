import { useEffect, useState } from 'react'

/**
 * The version an auto-update has already downloaded and is waiting to install,
 * or null while there is nothing pending. `download` is the macOS case: the
 * update is not installed in place, the banner sends you to the release page.
 *
 * The main process never swaps the bundle on quit (see `autoUpdate.ts`), so a
 * downloaded update only lands when the user asks for it. That makes this the
 * one thing the UI has to say out loud — without it the new version sits in
 * `~/Library/Caches` and nobody ever restarts into it.
 */
export function usePendingUpdate(): { version: string; download: boolean } | null {
  const [update, setUpdate] = useState<{ version: string; download: boolean } | null>(null)
  // The event fires once per download, minutes or hours into the session, so
  // the subscription lives as long as the window does.
  useEffect(() => window.floe.onUpdateDownloaded(setUpdate), [])
  return update
}
