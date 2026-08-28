import { ipcMain, Notification, app, type BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

// Re-check this often while the app stays open, so a machine that's left running
// still picks up releases without a relaunch.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6h

export function initAutoUpdate(getWindow: () => BrowserWindow | undefined): void {
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
  ipcMain.handle('update:install', () => autoUpdater.quitAndInstall())

  autoUpdater.on('error', (err) => {
    console.error('[auto-update] error:', err?.message ?? err)
  })
  autoUpdater.on('update-available', (info) => {
    console.log(`[auto-update] downloading ${info.version}…`)
  })
  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[auto-update] ${info.version} ready — installs on next restart.`)
    getWindow()?.webContents.send('update:downloaded', { version: info.version })
    if (Notification.isSupported()) {
      const note = new Notification({
        title: 'Rookery atualizado',
        body: `A versão ${info.version} está pronta — clique para reiniciar e aplicar agora.`
      })
      note.on('click', () => autoUpdater.quitAndInstall())
      note.show()
    }
  })

  void autoUpdater.checkForUpdates()
  setInterval(() => void autoUpdater.checkForUpdates(), CHECK_INTERVAL_MS)
}
