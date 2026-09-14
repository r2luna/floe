import { Notification, app, shell, type BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

import { floeConfig } from './config/floe'
import { handle } from './plugins/handleMap'

// Re-check this often while the app stays open, so a machine that's left running
// still picks up releases without a relaunch. `[update] check-interval-hours` in
// floe.toml, read once when the updater starts — changing it takes a relaunch,
// which is fine for a knob measured in hours.
const checkIntervalMs = (): number => floeConfig().update.checkIntervalHours * 60 * 60 * 1000

// The version already downloaded and waiting for a restart, so a repeat check
// says "restart to apply" instead of claiming it's downloading all over again.
let downloadedVersion: string | null = null

/** Where a version's downloads live. */
export const releaseUrl = (version: string): string => `https://github.com/r2luna/floe/releases/tag/v${version}`

/**
 * `selfInstall` false is the macOS path. The public builds are unsigned, and
 * Squirrel.Mac only swaps in an update signed by the installed app's identity,
 * so there the updater only finds the release and the user downloads it. The
 * Linux AppImage has no such check and updates itself.
 */
export function initAutoUpdate(
  getWindow: () => BrowserWindow | undefined,
  { selfInstall = process.platform !== 'darwin' }: { selfInstall?: boolean } = {}
): void {
  // ⌘K "Check for updates now" — the only way to pull a release in before the
  // next scheduled poll, which is hours away. Registered above the isPackaged
  // bail-out so the command answers in dev instead of rejecting the invoke with
  // "no handler registered".
  handle('update:check', async (): Promise<string> => {
    if (!app.isPackaged) return 'Updates only apply to a packaged build.'
    if (downloadedVersion)
      return selfInstall
        ? `Floe ${downloadedVersion} is downloaded — run "Install update" to apply it.`
        : `Floe ${downloadedVersion} is out — run "Install update" to download it.`
    try {
      const result = await autoUpdater.checkForUpdates()
      if (!result?.isUpdateAvailable) return `Floe ${app.getVersion()} is up to date.`
      if (!selfInstall) return `Floe ${result.updateInfo.version} is out — run "Install update" to download it.`
      return `Floe ${result.updateInfo.version} found — downloading; you'll get a restart prompt when it's ready.`
    } catch (err) {
      return `Update check failed: ${err instanceof Error ? err.message : String(err)}`
    }
  })

  // Squirrel can only swap a real, signed, packaged bundle — there's nothing to
  // update in `electron-vite dev`, and checking would just error.
  if (!app.isPackaged) return

  // Releases live on GitHub Releases (see electron-builder.yml `publish`); the
  // updater reads the feed from the bundled app-update.yml, no token needed.

  // Download in the background, but NEVER swap the bundle on quit: on macOS that
  // hands the .app replacement to ShipIt *after* our process exits, so quitting
  // and immediately reopening launches a half-swapped bundle (garbage renderer,
  // "works on the 2nd or 3rd try"). The update applies only through the explicit
  // Restart (banner / notification / ⌘K), whose quitAndInstall lets ShipIt finish
  // the swap and relaunch us itself.
  autoUpdater.autoDownload = selfInstall
  autoUpdater.autoInstallOnAppQuit = false

  // "Restart now" from the renderer banner / ⌘K command: relaunch into the
  // downloaded version immediately instead of waiting for the next quit. On
  // macOS it opens the release page instead.
  const install = (): void => {
    if (selfInstall) autoUpdater.quitAndInstall()
    else if (downloadedVersion) void shell.openExternal(releaseUrl(downloadedVersion))
  }
  handle('update:install', install)

  autoUpdater.on('error', (err) => {
    console.error('[auto-update] error:', err?.message ?? err)
  })
  const ready = (version: string): void => {
    downloadedVersion = version
    const window = getWindow()
    window?.webContents.send('update:downloaded', { version, download: !selfInstall })
    // The in-app banner is the primary surface, so the OS notification is only
    // for the case it can't cover: Floe in the background, where the banner is
    // behind another window and would go unseen until the next time you look.
    if (!window?.isFocused() && Notification.isSupported()) {
      const note = new Notification({
        title: selfInstall ? 'Floe updated' : 'Floe update available',
        body: selfInstall
          ? `Version ${version} is ready. Click to restart and apply it now.`
          : `Version ${version} is out. Click to open the download page.`
      })
      note.on('click', install)
      note.show()
    }
  }
  autoUpdater.on('update-available', (info) => {
    if (!selfInstall) {
      console.log(`[auto-update] ${info.version} is out — download it from the release page.`)
      ready(info.version)
      return
    }
    console.log(`[auto-update] downloading ${info.version}…`)
  })
  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[auto-update] ${info.version} ready — installs on next restart.`)
    ready(info.version)
  })

  void autoUpdater.checkForUpdates()
  setInterval(() => void autoUpdater.checkForUpdates(), checkIntervalMs())
}
