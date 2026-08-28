// Headless Electron shim.
//
// The server build aliases `electron` to this module (see build.mjs), so the real
// src/main/*.ts run under plain Node with no Electron. We reimplement only the ~handful
// of APIs the main process actually touches (enumerated by grep before writing):
//   app, BrowserWindow, ipcMain, shell, dialog, Notification, nativeTheme, Menu.
//
// The two seams that matter:
//   - ipcMain.handle(channel, fn)  -> collected in `registry.handlers`; the serverd
//     dispatches WebSocket requests through them.
//   - win.webContents.send(channel, ...args) -> `registry.events.emit('send', ...)`;
//     the serverd forwards these to every connected browser as push events.
// Everything else is a safe no-op/default so the unchanged main code never throws.

import { EventEmitter } from 'node:events'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

type Handler = (event: { sender: FakeWebContents }, ...args: unknown[]) => unknown

// Shared singletons — imported directly by the serverd. Because esbuild resolves both the
// `electron` alias and the serverd's relative import to THIS file, it's one module
// instance, so the registry is genuinely shared.
export const registry = {
  handlers: new Map<string, Handler>(),
  events: new EventEmitter(),
  windows: [] as FakeWindow[]
}
registry.events.setMaxListeners(0)

// ~/.rookery is the server's stable data dir (replaces Electron's per-app userData).
export const DATA_DIR = process.env.ROOKERY_DATA_DIR || join(homedir(), '.rookery')
try {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
} catch {
  /* ignore */
}

class FakeWebContents {
  send(channel: string, ...args: unknown[]): void {
    registry.events.emit('send', channel, args)
  }
  isDestroyed(): boolean {
    return false
  }
  on(): this {
    return this
  }
  setWindowOpenHandler(): void {}
  async capturePage(): Promise<{ toPNG: () => Buffer }> {
    return { toPNG: () => Buffer.alloc(0) }
  }
  // Embedded-browser surface (desktop-only). The headless server never opens a
  // browser pane — these exist so src/main/browserPane.ts bundles and boots.
  getURL(): string {
    return ''
  }
  getTitle(): string {
    return ''
  }
  navigationHistory = {
    canGoBack: (): boolean => false,
    canGoForward: (): boolean => false,
    goBack: (): void => {},
    goForward: (): void => {}
  }
  async loadURL(): Promise<void> {}
  reload(): void {}
  openDevTools(): void {}
  closeDevTools(): void {}
  isDevToolsOpened(): boolean {
    return false
  }
  sendInputEvent(): void {}
  close(): void {}
}

// Native embedded browser view — desktop-only; a no-op on the server.
export class WebContentsView {
  webContents = new FakeWebContents()
  setBounds(): void {}
  setVisible(): void {}
}

class FakeContentView {
  addChildView(): void {}
  removeChildView(): void {}
}

class FakeWindow {
  webContents = new FakeWebContents()
  contentView = new FakeContentView()
  isDestroyed(): boolean {
    return false
  }
  isMinimized(): boolean {
    return false
  }
  on(): this {
    return this
  }
  show(): void {}
  hide(): void {}
  restore(): void {}
  focus(): void {}
  minimize(): void {}
  close(): void {}
  setBackgroundColor(): void {}
  setWindowButtonVisibility(): void {}
  loadURL(): void {}
  loadFile(): void {}
}

export class BrowserWindow {
  webContents: FakeWebContents
  constructor() {
    const win = new FakeWindow()
    registry.windows.push(win)
    this.webContents = win.webContents
    // Return the plain FakeWindow so callers get the full instance surface.
    return win as unknown as BrowserWindow
  }
  static getAllWindows(): FakeWindow[] {
    return registry.windows
  }
  static getFocusedWindow(): FakeWindow | undefined {
    return registry.windows[0]
  }
  static fromWebContents(wc: FakeWebContents): FakeWindow | undefined {
    return registry.windows.find((w) => w.webContents === wc)
  }
}

export const ipcMain = {
  handle(channel: string, fn: Handler): void {
    registry.handlers.set(channel, fn)
  },
  on(channel: string, fn: Handler): void {
    registry.handlers.set(channel, fn)
  },
  removeHandler(channel: string): void {
    registry.handlers.delete(channel)
  }
}

export const app = {
  name: 'Rookery',
  isPackaged: true, // skip the dev userData isolation; keep a stable ~/.rookery
  getPath(name: string): string {
    if (name === 'temp') return tmpdir()
    if (name === 'home') return homedir()
    if (name === 'userData') return DATA_DIR
    return join(DATA_DIR, name)
  },
  setPath(): void {},
  getName(): string {
    return 'Rookery'
  },
  getVersion(): string {
    return process.env.ROOKERY_VERSION || '0.0.0-server'
  },
  whenReady(): Promise<void> {
    return Promise.resolve()
  },
  on(): typeof app {
    return app
  },
  off(): typeof app {
    return app
  },
  quit(): void {
    process.exit(0)
  },
  focus(): void {},
  hide(): void {},
  getAppMetrics(): unknown[] {
    return []
  },
  setLoginItemSettings(): void {},
  getLoginItemSettings(): { openAtLogin: boolean } {
    return { openAtLogin: false }
  }
}

export const shell = {
  async openExternal(url: string): Promise<void> {
    // No OS browser on a headless server; the web client opens links itself.
    console.log('[shim] shell.openExternal', url)
  },
  async openPath(): Promise<string> {
    return ''
  }
}

export const dialog = {
  showMessageBoxSync(): number {
    return 0
  },
  async showMessageBox(): Promise<{ response: number }> {
    return { response: 0 }
  },
  async showOpenDialog(): Promise<{ canceled: boolean; filePaths: string[] }> {
    return { canceled: true, filePaths: [] }
  },
  async showSaveDialog(): Promise<{ canceled: boolean; filePath?: string }> {
    return { canceled: true }
  }
}

export class Notification {
  static isSupported(): boolean {
    return false
  }
  show(): void {}
  on(): this {
    return this
  }
  close(): void {}
}

export const nativeTheme = {
  shouldUseDarkColors: true,
  themeSource: 'system' as const,
  on(): typeof nativeTheme {
    return nativeTheme
  }
}

// No window, no context menu — clipboard is only reachable from createWindow.
export const clipboard = {
  writeText(): void {},
  readText(): string {
    return ''
  }
}

export const Menu = {
  buildFromTemplate(): unknown {
    return {}
  },
  setApplicationMenu(): void {}
}

// No OS keychain on a headless server. Passthrough so Jira/Bitbucket creds still persist.
// ponytail: plaintext-at-rest in ~/.rookery; upgrade to a server-side key (age/libsodium
// sealed with a key in the systemd unit) if the box is shared. Files are 0600 + tailnet-only.
console.warn(
  '[rookery-server] safeStorage is UNENCRYPTED on this host (no OS keychain). ' +
    `Integration creds are stored plaintext in ${DATA_DIR} (0700 dir, 0600 files). ` +
    'Keep the box tailnet-only; upgrade to a sealed key if shared.'
)
export const safeStorage = {
  // Reports true because encrypt/decrypt below DO round-trip (identity) — the data
  // is recoverable, which is what callers gate on (jiraConfig/bitbucketConfig refuse
  // to save when this is false). It is NOT OS-encrypted; the boot warning above is
  // the source of truth on at-rest plaintext. Reporting false here silently disabled
  // saving Jira/Bitbucket creds while `integrations.ts` base64-fell-back anyway.
  isEncryptionAvailable(): boolean {
    return true
  },
  encryptString(plain: string): Buffer {
    return Buffer.from(plain, 'utf8')
  },
  decryptString(buf: Buffer): string {
    return Buffer.from(buf).toString('utf8')
  }
}

export default { app, BrowserWindow, WebContentsView, ipcMain, shell, dialog, Notification, nativeTheme, Menu, safeStorage }
