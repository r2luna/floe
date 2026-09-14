// The wire protocol between a Floe window and a remote Floe backend (the
// server-mode plugin's WS server, and later the headless daemon). JSON text
// frames over one WebSocket. The client speaks first with `hello`; nothing
// else is answered until the token checks out.
//
// The serve side lives in the plugin repo and implements this file's shapes —
// keep the two in sync (the plugin copies this file).

export interface HelloMsg {
  kind: 'hello'
  token: string
  /** The client app's version, for the skew warning — never a hard refusal. */
  version: string
}

export interface InvokeMsg {
  kind: 'invoke'
  id: number
  channel: string
  args: unknown[]
}

export type ClientMsg = HelloMsg | InvokeMsg

export type ServerMsg =
  | { kind: 'hello-ok'; version: string }
  | { kind: 'hello-err'; error: string }
  | { kind: 'result'; id: number; ok: boolean; value?: unknown; error?: string }
  | { kind: 'event'; channel: string; args: unknown[] }

/** Parse one frame; null for anything that isn't a well-formed message. */
export function parseServerMsg(raw: unknown): ServerMsg | null {
  if (typeof raw !== 'string') return null
  try {
    const msg = JSON.parse(raw) as ServerMsg
    return typeof msg === 'object' && msg !== null && 'kind' in msg ? msg : null
  } catch {
    return null
  }
}

export function parseClientMsg(raw: unknown): ClientMsg | null {
  if (typeof raw !== 'string') return null
  try {
    const msg = JSON.parse(raw) as ClientMsg
    return typeof msg === 'object' && msg !== null && 'kind' in msg ? msg : null
  } catch {
    return null
  }
}

/**
 * Channels that always run on the machine the WINDOW is on, whatever backend
 * the pointer names: the window itself, OS notifications, the local theme,
 * updating the local app, the local keymap/config/plugins, and the backend
 * switch itself. Everything else is workspace-kind and follows the pointer.
 * (The list is rookery's attached-mode allowlist, adapted — see docs/plugins.md.)
 */
export const PINNED_CHANNELS = new Set([
  'window:capture',
  'window:focus',
  'window:hide',
  'app:getLoginItem',
  'app:setLoginItem',
  'open:external',
  'browser:mount',
  'browser:bounds',
  'browser:visible',
  'browser:unmount',
  'browser:state',
  'browser:navigate',
  'browser:back',
  'browser:forward',
  'browser:reload',
  'browser:stop',
  'browser:focus',
  'browser:devtools',
  // A file pulled off another machine has to land on the desk the WINDOW is at
  // — opening the copy on the backend would be the bug this exists to fix.
  'files:openDownload',
  'notify:show',
  'theme:get',
  'omarchy:get',
  'update:install',
  'update:check',
  'user:name',
  'keybindings:load',
  'keybindings:reveal',
  'keybindings:rebind',
  'keybindings:reset',
  'config:get',
  'config:set',
  'config:errors',
  'config:paths',
  'config:reveal',
  'plugins:commands',
  'plugins:run',
  'plugins:list',
  'plugins:panel',
  'backends:get'
])
