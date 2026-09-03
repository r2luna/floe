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

// Regression: the add dialog's Machine row was cosmetic — App dropped the chosen
// backend, so `addByPath` followed the window's pointer and a path on another
// machine got checked against local disk ("Path does not exist"). The path has to
// be read by the machine that was picked; without one, the pointer is still right.
test('projects.addByPath reads the path on the backend it names', async () => {
  const local: Array<[string, unknown[]]> = []
  const remote: Array<[string, string, unknown[]]> = []
  const ipc: IpcLike = {
    invoke: async (channel, ...args) => {
      local.push([channel, args])
      return { project: { path: '/here/repo' }, created: true }
    },
    on: () => {},
    removeListener: () => {}
  }
  const api = buildFloeApi(ipc, {
    ...host,
    backendsCtl: {
      list: () => [],
      current: () => 'local',
      use: () => true,
      state: () => 'open',
      invokeOn: async (id, channel, ...args) => {
        remote.push([id, channel, args])
        return { project: { path: '/home/r2luna/repo' }, created: true }
      }
    }
  })

  const there = await api.projects.addByPath('/home/r2luna/repo', 'Projects', 'link')
  assert.deepEqual(remote, [['link', 'projects:addByPath', ['/home/r2luna/repo', 'Projects']]])
  assert.deepEqual(local, [])
  assert.equal(there.project?.path, '/home/r2luna/repo')

  const here = await api.projects.addByPath('/here/repo', 'Projects')
  assert.deepEqual(local, [['projects:addByPath', ['/here/repo', 'Projects']]])
  assert.equal(remote.length, 1)
  assert.equal(here.project?.path, '/here/repo')
})
