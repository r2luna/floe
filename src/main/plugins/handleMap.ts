// The recording wrapper around ipcMain.handle. Every core handler registers
// through here so a plugin can dispatch into ANY core channel via ctx.invoke —
// Electron itself offers no way to call a registered handler from the main
// process, so we keep the map ourselves. The renderer path is untouched:
// ipcMain.handle still gets the same function.

import { ipcMain, type IpcMainInvokeEvent, type BrowserWindow } from 'electron'

/* eslint-disable @typescript-eslint/no-explicit-any */
export type IpcHandler = (event: IpcMainInvokeEvent, ...args: any[]) => any

const handlers = new Map<string, IpcHandler>()

export function handle(channel: string, fn: IpcHandler): void {
  handlers.set(channel, fn)
  ipcMain.handle(channel, fn)
}

/** Every channel that went through handle() — for plugin discovery/debugging. */
export function registeredChannels(): string[] {
  return [...handlers.keys()]
}

/**
 * Call a core handler as if a renderer invoked it. The synthetic event carries
 * the local window's webContents as `sender`, so handlers that resolve their
 * window via BrowserWindow.fromWebContents land on the local window — which
 * means the serving machine's own UI also sees the activity, on purpose.
 */
export async function invokeHandler(
  channel: string,
  win: BrowserWindow | undefined,
  ...args: any[]
): Promise<any> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`no handler registered for channel "${channel}"`)
  const event = { sender: win?.webContents } as IpcMainInvokeEvent
  return fn(event, ...args)
}
