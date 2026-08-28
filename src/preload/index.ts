import { contextBridge, ipcRenderer } from 'electron'
import { homedir, hostname } from 'node:os'
import pkg from '../../package.json'
import { buildRookeryApi, type BackendInfo, type BackendsApi, type IpcLike, type RookeryHost } from './api'
import { createSocketIpc } from './socket'
import { showConnectionNotice } from './connectionNotice'

// Attach handshake (main's `attach:info`): one entry per remote Rookery server
// this window is attached to, empty when local-only. Synchronous on purpose —
// the transports must exist before the page loads.
interface AttachInfo {
  id: string
  wsUrl: string
  host: { platform: string; homeDir: string; appVersion: string } | null
}
const attached = (ipcRenderer.sendSync('attach:info') as AttachInfo[] | null) ?? []

// UI-kind channels — pinned to this machine even when attached, because they
// act on the window/OS in front of the user, not on the workspace. Everything
// else follows the attach target. When detached there is no target, so the
// split collapses onto plain ipcRenderer — master's behavior exactly.
// (docs/attached.md has the full rationale.)
const PINNED_INVOKE = new Set([
  'window:capture',
  'window:hide',
  'window:focus',
  'window:getVibrancy',
  'window:setVibrancy',
  'app:getLoginItem',
  'app:setLoginItem',
  'open:external',
  'notify:show',
  'theme:get',
  'update:install',
  // The attach machinery itself: attaching elsewhere / detaching acts on THIS
  // window, never on the workspace.
  'server:getUrl',
  'server:getAttached',
  'server:getAttachFallback',
  'server:attach',
  'server:detach',
  // The embedded browser pane is a native view in THIS window; its remote
  // reach (SSH forwards to the server's app ports) is handled inside main.
  'browser:open',
  'browser:openFile',
  'browser:navigate',
  'browser:back',
  'browser:forward',
  'browser:reload',
  'browser:devtools',
  'browser:setBounds',
  'browser:setVisible',
  'browser:close'
])
const PINNED_EVENTS = new Set([
  'notification:click',
  'theme:changed',
  'update:downloaded',
  'browser:event',
  'browser:key'
])

const LOCAL = 'local'

// One transport per machine, and a pointer at the one workspace calls currently
// ride. The renderer moves that pointer when you select a project (a project
// belongs to whichever backend served it), so the same window runs some projects
// here and others on the server.
//
// Events fan IN from every backend at once — a session finishing on the server
// must still notify while you're looking at a local project. Safe because every
// event is scoped by a session/terminal id or an absolute path, and those don't
// collide across machines.
function router(sockets: Map<string, IpcLike>): { ipc: IpcLike; backends: BackendsApi } {
  const transports = new Map<string, IpcLike>([[LOCAL, ipcRenderer], ...sockets])
  let current = LOCAL
  const workspace = (): IpcLike => transports.get(current) ?? ipcRenderer

  const ipc: IpcLike = {
    invoke: (channel, ...args) =>
      PINNED_INVOKE.has(channel) ? ipcRenderer.invoke(channel, ...args) : workspace().invoke(channel, ...args),
    on: (channel, listener) => {
      if (PINNED_EVENTS.has(channel)) return void ipcRenderer.on(channel, listener)
      for (const t of transports.values()) t.on(channel, listener)
    },
    removeListener: (channel, listener) => {
      if (PINNED_EVENTS.has(channel)) return void ipcRenderer.removeListener(channel, listener)
      for (const t of transports.values()) t.removeListener(channel, listener)
    }
  }

  const label = (id: string): string => {
    if (id === LOCAL) return hostname().replace(/\.local$/, '')
    const ssh = /^ssh:\/\//i.test(id)
    try {
      return ssh ? id.replace(/^ssh:\/\//i, '').split(':')[0] : new URL(id).hostname
    } catch {
      return id
    }
  }
  const list = (): BackendInfo[] => [
    { id: LOCAL, label: label(LOCAL), homeDir: homedir(), remote: false },
    ...attached.map((a) => ({ id: a.id, label: label(a.id), homeDir: a.host?.homeDir ?? '', remote: true }))
  ]

  return {
    ipc,
    backends: {
      list,
      current: () => current,
      use: (id: string) => {
        if (transports.has(id)) current = id
      },
      invoke: (id: string, channel: string, ...args: unknown[]) =>
        (transports.get(id) ?? ipcRenderer).invoke(channel, ...args)
    }
  }
}

// The worktree this app instance runs in: explicit env, else the segment after
// `.worktrees/` in the launch path. Null on the main checkout.
function worktreeTag(): string | null {
  const env = process.env.ROOKERY_WORKTREE
  if (env) return env
  const match = process.cwd().split('/.worktrees/')[1]
  return match ? match.split('/')[0] : null
}

const host: RookeryHost = {
  // The window is native either way — keep the local platform so ⌘ bindings,
  // fonts and window chrome behave like the Mac app they are.
  platform: process.platform,
  version: process.versions.electron,
  appVersion: pkg.version as string,
  // The Home workspace is this machine's home, always: with per-project
  // backends the window is local first and only individual projects live
  // elsewhere, so Home is the one workspace that can't be remote.
  homeDir: homedir(),
  // Same reasoning: the tag names the worktree THIS WINDOW was launched from, so
  // side-by-side dev builds are tellable apart. That's a fact about the local
  // build, not about where a project's sessions run — so attached backends no
  // longer blank it (they did under the old whole-window attach model).
  worktreeTag: worktreeTag()
}

// Superseded overlay + "not connected" chip (see connectionNotice) — plain DOM
// so they render no matter what state the React app is in.
const sockets = new Map<string, IpcLike>(
  attached.map((a) => [a.id, createSocketIpc(a.wsUrl, showConnectionNotice)])
)
const { ipc, backends } = router(sockets)

contextBridge.exposeInMainWorld('rookery', buildRookeryApi(ipc, host, backends))

export type { RookeryApi } from './api'
