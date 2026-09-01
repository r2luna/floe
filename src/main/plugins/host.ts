// The plugin host: discover ~/.config/floe/plugins/<name>/, load each plugin's
// CJS bundle in the main process and hand it a FloePluginContext. A broken
// plugin logs and is skipped — boot never dies for one. See docs/plugins.md.

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { configDir } from '../dataDir'
import { log } from '../log'
import { handle, invokeHandler } from './handleMap'
import type {
  BackendEntry,
  FloePlugin,
  FloePluginContext,
  PluginCommandSpec,
  PluginManifest,
  PluginPanelSection,
  PluginPanelSpec,
  PluginToolSpec
} from './types'

export interface PluginInfo {
  name: string
  version: string
  dir: string
  error?: string
}

export interface PluginCommandMeta {
  id: string
  title: string
  group: string
  /** Set on the auto command that opens a panel: the panel's `sub`. The
   *  renderer runs these locally (opening panels is a renderer act); they have
   *  no `run` in main. */
  panel?: string
}

interface RegisteredCommand extends PluginCommandMeta {
  run: (arg?: string) => void | Promise<void>
}

interface RegisteredPanel {
  /** `<plugin-name>:<panel-id>` — the panel kind's `sub`. */
  sub: string
  title: string
  pluginName: string
  body: PluginPanelSpec['body']
}

const loaded: PluginInfo[] = []
const commands = new Map<string, RegisteredCommand>()
const panels = new Map<string, RegisteredPanel>()
const tools: PluginToolSpec[] = []
const sendHooks: Array<(channel: string, args: unknown[]) => void> = []
const deactivators: Array<() => void | Promise<void>> = []
let backends: BackendEntry[] = []
let getWindowRef: (() => BrowserWindow | undefined) | undefined

export const pluginsDir = (): string => join(configDir(), 'plugins')

function getWindow(): BrowserWindow | undefined {
  return getWindowRef?.()
}

// --- send mirroring ---------------------------------------------------------
// A serve-side plugin needs to see every event the main process pushes to the
// renderer, to mirror it to remote clients. There is no core-wide push helper —
// modules call win.webContents.send directly — so we wrap the method on each
// window once. Fragile to core refactors by design; concentrating pushes in a
// helper is a follow-up, not a prerequisite.
const patched = new WeakSet<object>()

function patchSend(win: BrowserWindow): void {
  const wc = win.webContents
  if (patched.has(wc)) return
  patched.add(wc)
  const original = wc.send.bind(wc)
  wc.send = (channel: string, ...args: unknown[]): void => {
    original(channel, ...args)
    for (const cb of sendHooks) {
      try {
        cb(channel, args)
      } catch (e) {
        log('plugin:sendHookFailed', { error: (e as Error).message })
      }
    }
  }
}

/** index.ts calls this from createWindow so hooks survive window recreation. */
export function pluginWindowCreated(win: BrowserWindow): void {
  if (sendHooks.length) patchSend(win)
}

// --- context ----------------------------------------------------------------

function buildContext(manifest: PluginManifest, dir: string, floeVersion: string): FloePluginContext {
  const prefix = `plugin:${manifest.name}:`
  return {
    name: manifest.name,
    floeVersion,
    dir,
    log: (message, data) => log(`plugin:${manifest.name}:${message}`, data),
    getWindow,
    registerIpc: (channel, handler) => {
      handle(prefix + channel, (_event, ...args) => handler(...args))
    },
    invoke: (channel, ...args) => invokeHandler(channel, getWindow(), ...args),
    send: (channel, ...args) => {
      const win = getWindow()
      if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
    },
    onSend: (cb) => {
      sendHooks.push(cb)
      const win = getWindow()
      if (win) patchSend(win)
    },
    registerCommands: (specs: PluginCommandSpec[]) => {
      for (const spec of specs) {
        commands.set(prefix + spec.id, {
          id: prefix + spec.id,
          title: spec.title,
          group: spec.group ?? manifest.name,
          run: spec.run
        })
      }
    },
    registerTool: (tool) => {
      tools.push(tool)
    },
    registerPanel: (panel) => {
      const sub = `${manifest.name}:${panel.id}`
      panels.set(sub, { sub, title: panel.title, pluginName: manifest.name, body: panel.body })
    },
    refreshPanel: (id) => {
      const win = getWindow()
      if (win && !win.isDestroyed()) win.webContents.send('plugins:panel-changed', `${manifest.name}:${id}`)
    },
    backends: {
      set: (list) => {
        backends = list
      },
      get: () => backends
    }
  }
}

// --- loading ----------------------------------------------------------------

function readManifest(dir: string): PluginManifest {
  const raw = readFileSync(join(dir, 'manifest.json'), 'utf8')
  const m = JSON.parse(raw) as Partial<PluginManifest>
  if (!m.name || !/^[a-z0-9-]+$/.test(m.name)) throw new Error('manifest.name must be a kebab-case slug')
  if (!m.main) throw new Error('manifest.main is missing')
  return { name: m.name, version: m.version ?? '0.0.0', main: m.main, minFloeVersion: m.minFloeVersion }
}

/** newer-or-equal semver compare, loose on purpose (missing parts read as 0). */
function versionAtLeast(version: string, min: string): boolean {
  const a = version.split('.').map((n) => parseInt(n, 10) || 0)
  const b = min.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return true
}

export async function loadPlugins(floeVersion: string, getWin: () => BrowserWindow | undefined): Promise<void> {
  getWindowRef = getWin
  const dir = pluginsDir()
  // Generated like the rest of the config dir: a directory you can see is one
  // you know you can drop a plugin into.
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return
  }
  const entries = readdirSync(dir, { withFileTypes: true }).filter(
    (e) => e.isDirectory() || e.isSymbolicLink()
  )
  for (const entry of entries) {
    const pluginDir = join(dir, entry.name)
    if (!existsSync(join(pluginDir, 'manifest.json'))) continue
    let info: PluginInfo = { name: entry.name, version: '?', dir: pluginDir }
    try {
      const manifest = readManifest(pluginDir)
      info = { name: manifest.name, version: manifest.version, dir: pluginDir }
      if (manifest.minFloeVersion && !versionAtLeast(floeVersion, manifest.minFloeVersion)) {
        throw new Error(`needs Floe >= ${manifest.minFloeVersion} (running ${floeVersion})`)
      }
      const entryPath = join(pluginDir, manifest.main)
      // createRequire keyed on the entry itself: loads the CJS bundle the same
      // way under the packaged CJS main bundle and under `node --test`, and an
      // unbundled plugin resolves its node_modules from its own directory.
      const mod = createRequire(entryPath)(entryPath) as FloePlugin | { default: FloePlugin }
      const plugin = 'activate' in mod ? mod : (mod as { default: FloePlugin }).default
      if (typeof plugin?.activate !== 'function') throw new Error('bundle exports no activate()')
      await plugin.activate(buildContext(manifest, pluginDir, floeVersion))
      if (plugin.deactivate) deactivators.push(plugin.deactivate)
      log('plugin:loaded', { name: manifest.name, version: manifest.version })
    } catch (e) {
      info.error = e instanceof Error ? e.message : String(e)
      log('plugin:failed', { name: info.name, error: info.error })
    }
    loaded.push(info)
  }
  registerHostIpc()
}

// The renderer's window into the host: the command list the palette merges, the
// dispatcher those rows run through, and the load report for Settings/debugging.
let hostIpcRegistered = false
function registerHostIpc(): void {
  if (hostIpcRegistered) return
  hostIpcRegistered = true
  handle('plugins:commands', () => pluginCommands())
  handle('plugins:run', (_event, id: string, arg?: string) => runPluginCommand(id, arg))
  handle('plugins:list', () => loaded)
  handle('plugins:panel', (_event, sub: string) => panelBody(sub))
  handle('backends:get', () => backends)
}

/**
 * A panel's current body, with every section's command id fully qualified —
 * the plugin writes short ids, the renderer dispatches full ones.
 */
export async function panelBody(sub: string): Promise<{ title: string; sections: PluginPanelSection[] } | null> {
  const panel = panels.get(sub)
  if (!panel) return null
  const full = (id: string): string => `plugin:${panel.pluginName}:${id}`
  const sections = (await panel.body()).map((s): PluginPanelSection => {
    if (s.kind === 'toggle' || s.kind === 'action') return { ...s, id: full(s.id) }
    if (s.kind === 'list') return { ...s, rowActions: s.rowActions?.map((a) => ({ ...a, id: full(a.id) })) }
    return s
  })
  return { title: panel.title, sections }
}

// --- queries the rest of the app asks ---------------------------------------

export function pluginCommands(): PluginCommandMeta[] {
  return [
    ...[...commands.values()].map(({ id, title, group }) => ({ id, title, group })),
    // One auto command per panel. The renderer overlay runs these locally —
    // opening a panel is a renderer act — so they carry `panel` and no run here.
    ...[...panels.values()].map((p) => ({
      id: `plugin:${p.pluginName}:panel.${p.sub.slice(p.pluginName.length + 1)}`,
      title: p.title,
      group: p.pluginName,
      panel: p.sub
    }))
  ]
}

export async function runPluginCommand(
  id: string,
  arg?: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const cmd = commands.get(id)
  if (!cmd) return { ok: false, error: `unknown plugin command: ${id}` }
  try {
    await cmd.run(arg)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function pluginTools(): PluginToolSpec[] {
  return tools
}

export function loadedPlugins(): PluginInfo[] {
  return loaded
}

export function shutdownPlugins(): void {
  for (const deactivate of deactivators) {
    try {
      void deactivate()
    } catch {
      // shutting down — nothing left to report to
    }
  }
  deactivators.length = 0
}
