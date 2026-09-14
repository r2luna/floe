// The electron module, faked for the headless daemon build (build:server).
// src/main boots unchanged against these: the window is an object whose
// webContents.send goes nowhere locally (the server-mode plugin's onSend patch
// mirrors it to remote clients), dialogs auto-answer, and everything
// desktop-only is a no-op. Modeled on rookery's src/server/shims/electron.ts —
// the shim list is exactly what a desktop has that a server doesn't.

import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

const appVersion = process.env.FLOE_SERVER_VERSION ?? '0.0.0'

// The daemon owns the same canonical stores the packaged desktop app uses —
// one machine, one state (the single-owner model: the local app attaches to
// the daemon rather than running a second backend against these files).
function userDataDir(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'floe')
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'floe')
}

type Handler = (...args: unknown[]) => void

export const app = {
  isPackaged: true,
  whenReady: (): Promise<void> => Promise.resolve(),
  getVersion: (): string => appVersion,
  getPath: (name: string): string => {
    if (name === 'userData') return userDataDir()
    if (name === 'temp') return tmpdir()
    if (name === 'home') return homedir()
    if (name === 'exe') return process.execPath
    return userDataDir()
  },
  setPath: (): void => {},
  on: (): void => {},
  once: (): void => {},
  quit: (): void => process.exit(0),
  exit: (code?: number): void => process.exit(code ?? 0),
  hide: (): void => {},
  focus: (): void => {},
  relaunch: (): void => {},
  commandLine: { appendSwitch: (): void => {} },
  getLoginItemSettings: (): { openAtLogin: boolean } => ({ openAtLogin: false }),
  setLoginItemSettings: (): void => {},
  getAppMetrics: (): unknown[] => [],
  getApplicationNameForProtocol: (): string => ''
}

class FakeWebContents {
  send(): void {
    // The plugin's onSend patch wraps this instance method and mirrors every
    // push to the connected remote clients; locally there is nobody to paint.
  }
  on(): void {}
  setZoomFactor(): void {}
  setWindowOpenHandler(): void {}
  capturePage(): Promise<{ toPNG: () => Buffer }> {
    return Promise.resolve({ toPNG: () => Buffer.alloc(0) })
  }
  reload(): void {}
  stop(): void {}
  focus(): void {}
  close(): void {}
  openDevTools(): void {}
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
  loadURL(): Promise<void> {
    return Promise.resolve()
  }
}

// Native embedded browser view (src/main/browser.ts) — desktop-only; the
// daemon has no compositor, so the view is a no-op that never mounts.
export class WebContentsView {
  webContents = new FakeWebContents()
  setBounds(): void {}
  setVisible(): void {}
  setBackgroundColor(): void {}
}

class FakeContentView {
  addChildView(): void {}
  removeChildView(): void {}
}

export class BrowserWindow {
  private static wins: BrowserWindow[] = []
  webContents = new FakeWebContents()
  contentView = new FakeContentView()
  constructor() {
    BrowserWindow.wins.push(this)
  }
  on(): void {}
  once(_event: string, cb?: Handler): void {
    // ready-to-show never fires from a real compositor; call it so show() runs.
    if (_event === 'ready-to-show') cb?.()
  }
  show(): void {}
  hide(): void {}
  focus(): void {}
  restore(): void {}
  isDestroyed(): boolean {
    return false
  }
  isMinimized(): boolean {
    return false
  }
  isFocused(): boolean {
    return false
  }
  isVisible(): boolean {
    return false
  }
  setBackgroundColor(): void {}
  setWindowButtonVisibility(): void {}
  loadURL(): Promise<void> {
    return Promise.resolve()
  }
  loadFile(): Promise<void> {
    return Promise.resolve()
  }
  static getAllWindows(): BrowserWindow[] {
    return BrowserWindow.wins
  }
  static getFocusedWindow(): BrowserWindow | null {
    return BrowserWindow.wins[0] ?? null
  }
  static fromWebContents(wc: unknown): BrowserWindow | null {
    // Synthetic events (handleMap invokeHandler) may carry undefined — the
    // daemon has exactly one "window", so every sender resolves to it.
    return BrowserWindow.wins.find((w) => w.webContents === wc) ?? BrowserWindow.wins[0] ?? null
  }
}

export const ipcMain = {
  handle: (): void => {
    // handleMap.ts records every handler itself; on the daemon the recorded map
    // IS the API (the plugin's WS server dispatches into it) and there is no
    // renderer to answer.
  },
  removeHandler: (): void => {},
  on: (): void => {}
}

export const dialog = {
  // Auto-answer: 1 is "Quit" in the only sync box the app shows.
  showMessageBoxSync: (): number => 1,
  showOpenDialog: (): Promise<{ canceled: boolean; filePaths: string[] }> =>
    Promise.resolve({ canceled: true, filePaths: [] })
}

export class Notification {
  static isSupported(): boolean {
    return false
  }
  on(): void {}
  show(): void {}
}

export const nativeTheme = { shouldUseDarkColors: true, on: (): void => {} }

export const Menu = {
  buildFromTemplate: (): { popup: () => void } => ({ popup: () => {} }),
  setApplicationMenu: (): void => {}
}

export const clipboard = { writeText: (): void => {}, writeImage: (): void => {} }

// A daemon has no pasteboard, so the only honest answer to "decode this data
// URL" is an empty image: `media:copyImage` checks isEmpty first and reports
// the copy as failed instead of throwing at the caller.
export const nativeImage = {
  createFromDataURL: (): { isEmpty: () => boolean } => ({ isEmpty: () => true }),
  createFromPath: (): { isEmpty: () => boolean } => ({ isEmpty: () => true })
}

export const shell = {
  openExternal: (): Promise<void> => Promise.resolve(),
  openPath: (): Promise<string> => Promise.resolve(''),
  showItemInFolder: (): void => {}
}

export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString: (s: string): Buffer => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer): string => b.toString('utf8')
}

export const protocol = {
  registerSchemesAsPrivileged: (): void => {},
  handle: (): void => {}
}

// Type-only names (IpcMainInvokeEvent, WebContents, MenuItemConstructorOptions)
// erase at compile time and need no runtime value.

export default { app, BrowserWindow, WebContentsView, ipcMain, dialog, Notification, nativeTheme, Menu, clipboard, nativeImage, shell, safeStorage, protocol }
