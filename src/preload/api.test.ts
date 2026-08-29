import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFloeApi, type IpcLike, type FloeHost } from './api.ts'

const host: FloeHost = { platform: 'linux', version: 'web', appVersion: '0', homeDir: '/home/x', worktreeTag: null }

// Regression: the web "Add project…" flow calls window.floe.projects.addByPath.
// It was missing from the bridge builder, so on web it was `undefined` — the call
// threw a TypeError that surfaced as a silent unhandled rejection (project never
// added, no error shown). Guard that it exists and routes to the right IPC channel.
test('projects.addByPath routes to the projects:addByPath channel', async () => {
  const calls: Array<[string, unknown[]]> = []
  const ipc: IpcLike = {
    invoke: async (channel, ...args) => {
      calls.push([channel, args])
      return { project: { path: '/srv/repo', group: 'Projects', name: 'repo' } }
    },
    on: () => {},
    removeListener: () => {}
  }
  const api = buildFloeApi(ipc, host)

  assert.equal(typeof api.projects.addByPath, 'function')
  const res = await api.projects.addByPath('/srv/repo', 'Projects')
  assert.deepEqual(calls, [['projects:addByPath', ['/srv/repo', 'Projects']]])
  assert.equal(res.project?.path, '/srv/repo')
})
