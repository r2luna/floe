// Auto-update is meaningless for a self-hosted server (you `git pull` + restart), so the
// server build aliases `electron-updater` to this no-op. initAutoUpdate() runs but does
// nothing.
export const autoUpdater = {
  autoDownload: false,
  logger: null as unknown,
  on(): typeof autoUpdater {
    return autoUpdater
  },
  checkForUpdates(): Promise<null> {
    return Promise.resolve(null)
  },
  checkForUpdatesAndNotify(): Promise<null> {
    return Promise.resolve(null)
  },
  quitAndInstall(): void {}
}

export default { autoUpdater }
