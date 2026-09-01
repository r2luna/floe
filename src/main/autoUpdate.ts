import { Notification, app, type BrowserWindow } from 'electron'
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

export function initAutoUpdate(getWindow: () => BrowserWindow | undefined): void {
  // ⌘K "Check for updates now" — the only way to pull a release in before the
  // next scheduled poll, which is hours away. Registered above the isPackaged
  // bail-out so the command answers in dev instead of rejecting the invoke with
  // "no handler registered".
  handle('update:check', async (): Promise<string> => {
    if (!app.isPackaged) return 'Updates only apply to a packaged build.'
    if (downloadedVersion)
      return `Floe ${downloadedVersion} is downloaded — run "Restart to update" to apply it.`
    try {
      const result = await autoUpdater.checkForUpdates()
      if (!result?.isUpdateAvailable) return `Floe ${app.getVersion()} is up to date.`
      return `Floe ${result.updateInfo.version} found — downloading; you'll get a restart prompt when it's ready.`
    } catch (err) {
      return `Update check failed: ${err instanceof Error ? err.message : String(err)}`
    }
  })

  // Squirrel can only swap a real, signed, packaged bundle — there's nothing to
  // update in `electron-vite dev`, and checking would just error.
  if (!app.isPackaged) return

  // Releases live in the public homelab Forgejo generic package registry (see
  // electron-builder.yml `publish`); the updater reads the feed URL from the
  // bundled app-update.yml and downloads anonymously — no token needed.

  // Download in the background, but NEVER swap the bundle on quit: on macOS that
  // hands the .app replacement to ShipIt *after* our process exits, so quitting
  // and immediately reopening launches a half-swapped bundle (garbage renderer,
  // "works on the 2nd or 3rd try"). The update applies only through the explicit
  // Restart (banner / notification / ⌘K), whose quitAndInstall lets ShipIt finish
  // the swap and relaunch us itself.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false

  // "Restart now" from the renderer banner / ⌘K command: relaunch into the
  // downloaded version immediately instead of waiting for the next quit.
  handle('update:install', () => autoUpdater.quitAndInstall())

  autoUpdater.on('error', (err) => {
    console.error('[auto-update] error:', err?.message ?? err)
  })
  autoUpdater.on('update-available', (info) => {
    console.log(`[auto-update] downloading ${info.version}…`)
  })
  autoUpdater.on('update-downloaded', (info) => {
    downloadedVersion = info.version
    console.log(`[auto-update] ${info.version} ready — installs on next restart.`)
    const window = getWindow()
    window?.webContents.send('update:downloaded', { version: info.version })
    // The in-app banner is the primary surface, so the OS notification is only
    // for the case it can't cover: Floe in the background, where the banner is
    // behind another window and would go unseen until the next time you look.
    if (!window?.isFocused() && Notification.isSupported()) {
      const note = new Notification({
        title: 'Floe atualizado',
        body: `A versão ${info.version} está pronta — clique para reiniciar e aplicar agora.`
      })
      note.on('click', () => autoUpdater.quitAndInstall())
      note.show()
    }
  })

  void autoUpdater.checkForUpdates()
  setInterval(() => void autoUpdater.checkForUpdates(), checkIntervalMs())
}
