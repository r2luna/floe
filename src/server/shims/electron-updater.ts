// electron-updater, faked for the headless daemon: updates come from redeploys
// (the plugin restarts the unit), never from Squirrel.
export default {
  autoUpdater: {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    on: (): void => {},
    checkForUpdates: (): Promise<null> => Promise.resolve(null),
    quitAndInstall: (): void => {}
  }
}
