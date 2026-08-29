import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'

// We replace Electron's default menu for two reasons, both about freeing up keys
// the renderer wants. The default Window menu binds ⌘W to "Close Window"
// (role: 'close') and ⌘M to "Minimize" (role: 'minimize'), each swallowing the
// key before the renderer sees it. We want ⌘W to close the active *session* and
// ⌘M to cycle the model (both handled in the renderer via keymap.ts), so those
// menu items keep their behavior via plain click handlers but drop the
// accelerators — leaving ⌘W and ⌘M free to reach the page. Every other standard
// shortcut (copy/paste/quit/reload/…) is preserved via roles.
export function buildAppMenu(openNewInstance: () => void): void {
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ] as MenuItemConstructorOptions[]
          }
        ]
      : []),
    {
      role: 'editMenu'
    },
    {
      // Custom View menu (not role:'viewMenu') so we can drop plain Reload — ⌘R
      // would wipe in-flight session state by accident. Force Reload (⌘⇧R) stays.
      label: 'View',
      submenu: [
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        // Open a separate, fully independent Floe process (its own IPC/PTYs/
        // stores) — a second window in this process is unsupported (single-renderer
        // IPC). See openNewInstance in index.ts.
        { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: openNewInstance },
        { type: 'separator' },
        // Deliberately NOT role:'minimize' — that role forces a CmdOrCtrl+M
        // accelerator that would swallow ⌘M before the renderer's keymap (cycle
        // model) sees it. A plain click handler keeps the item while leaving ⌘M free.
        { label: 'Minimize', click: () => BrowserWindow.getFocusedWindow()?.minimize() },
        { role: 'zoom' },
        // Deliberately NOT role:'close' — that role forces a CmdOrCtrl+W accelerator
        // that would swallow ⌘W before the renderer's keymap (close session) sees it.
        // A plain click handler keeps the menu item while leaving ⌘W free.
        { label: 'Close Window', click: () => BrowserWindow.getFocusedWindow()?.close() },
        ...(isMac
          ? ([{ type: 'separator' }, { role: 'front' }] as MenuItemConstructorOptions[])
          : [])
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
