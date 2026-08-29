// One-shot refactor: split src/preload/index.ts into
//   - src/preload/api.ts   : buildFloeApi(ipcRenderer, host) — pure, no electron/node
//   - src/preload/index.ts : thin electron entry that calls it and exposes via contextBridge
// so the browser web-bridge can reuse the identical api over WebSocket.
import { readFileSync, writeFileSync } from 'node:fs'

const path = 'src/preload/index.ts'
const src = readFileSync(path, 'utf8')

const apiStart = src.indexOf('const api = {')
const exposeIdx = src.indexOf("contextBridge.exposeInMainWorld('floe', api)")
if (apiStart < 0 || exposeIdx < 0) throw new Error('markers not found')

const beforeApi = src.slice(0, apiStart)
const bodyRegion = src.slice(apiStart, exposeIdx)

// Type imports = everything in the header except the 3 runtime imports.
const typeImports = beforeApi
  .split('\n')
  .filter((l) => !l.startsWith("import { contextBridge") && !l.startsWith("import { homedir") && !l.startsWith('import pkg '))
  .join('\n')
  .trim()

// Separate the api object from the trailing worktreeTag() helper.
const wtIdx = bodyRegion.indexOf('function worktreeTag')
let apiObj = wtIdx >= 0 ? bodyRegion.slice(0, bodyRegion.lastIndexOf('function worktreeTag')) : bodyRegion
// The worktreeTag func may be preceded by a comment block; trim trailing comment lines.
apiObj = apiObj.replace(/\n\/\/[^\n]*(\n\/\/[^\n]*)*\s*$/,'\n').trimEnd()

// Swap node/electron host bits for injected host.* values.
apiObj = apiObj
  .replace('platform: process.platform,', 'platform: host.platform,')
  .replace('version: process.versions.electron,', 'version: host.version,')
  .replace('appVersion: pkg.version as string,', 'appVersion: host.appVersion,')
  .replace('homeDir: homedir(),', 'homeDir: host.homeDir,')
  .replace('tag: worktreeTag()', 'tag: host.worktreeTag')

const apiFile = `${typeImports}

// Injected by the host (preload = electron, web-bridge = browser stubs).
export type IpcRendererEvent = unknown
export interface IpcLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (...a: never[]) => void): void
  removeListener(channel: string, listener: (...a: never[]) => void): void
}
export interface FloeHost {
  platform: string
  version: string
  appVersion: string
  homeDir: string
  worktreeTag: string | null
}

// The bridge the renderer talks to. Identical shape for Electron IPC and WebSocket.
export function buildFloeApi(ipcRenderer: IpcLike, host: FloeHost) {
  ${apiObj.replace(/\n/g, '\n  ')}
  return api
}

export type FloeApi = ReturnType<typeof buildFloeApi>
`

writeFileSync('src/preload/api.ts', apiFile)

const indexFile = `import { contextBridge, ipcRenderer } from 'electron'
import { homedir } from 'node:os'
import pkg from '../../package.json'
import { buildFloeApi, type FloeHost } from './api'

// The worktree this app instance runs in: explicit env, else the segment after
// \`.worktrees/\` in the launch path. Null on the main checkout.
function worktreeTag(): string | null {
  const env = process.env.FLOE_WORKTREE
  if (env) return env
  const match = process.cwd().split('/.worktrees/')[1]
  return match ? match.split('/')[0] : null
}

const host: FloeHost = {
  platform: process.platform,
  version: process.versions.electron,
  appVersion: pkg.version as string,
  homeDir: homedir(),
  worktreeTag: worktreeTag()
}

contextBridge.exposeInMainWorld('floe', buildFloeApi(ipcRenderer, host))

export type { FloeApi } from './api'
`

writeFileSync(path, indexFile)
console.log('wrote src/preload/api.ts and rewrote src/preload/index.ts')
console.log('api.ts lines:', apiFile.split('\n').length, '| index.ts lines:', indexFile.split('\n').length)
