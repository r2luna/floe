import { contextBridge, ipcRenderer } from 'electron'
import { homedir } from 'node:os'
import pkg from '../../package.json'
import { buildFloeApi, type FloeHost } from './api'

// The worktree this app instance runs in: explicit env, else the segment after
// `.worktrees/` in the launch path. Null on the main checkout.
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
  // The user's home is the cwd of the synthetic "Home" workspace the app boots into.
  homeDir: homedir(),
  // Names the worktree THIS WINDOW was launched from, so side-by-side dev builds
  // are tellable apart.
  worktreeTag: worktreeTag()
}

contextBridge.exposeInMainWorld('floe', buildFloeApi(ipcRenderer, host))

export type { FloeApi } from './api'
