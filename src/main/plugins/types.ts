// The public contract a Floe plugin is written against. A plugin is a directory
// under ~/.config/floe/plugins/<name>/ holding a manifest.json and a CJS bundle
// that exports `activate(ctx)` (and optionally `deactivate()`). Plugin authors
// copy this file as their .d.ts — keep it free of app internals.

import type { BrowserWindow } from 'electron'

export interface PluginManifest {
  name: string
  version: string
  /** Entry bundle, relative to the plugin directory (e.g. "dist/main.cjs"). */
  main: string
  /** Oldest Floe version the plugin works with; newer Floe refuses to load below it. */
  minFloeVersion?: string
}

export interface PluginCommandSpec {
  /** Short id — exposed everywhere as `plugin:<plugin-name>:<id>`. */
  id: string
  title: string
  /** Palette group label; defaults to the plugin name. */
  group?: string
  run: (arg?: string) => void | Promise<void>
}

/** Declarative param schema — converted to zod by the host, so plugins don't bundle zod. */
export interface PluginToolParam {
  type: 'string' | 'number' | 'boolean'
  description?: string
  optional?: boolean
}

export interface PluginToolSpec {
  name: string
  description: string
  params?: Record<string, PluginToolParam>
  /** Return value is serialized as the tool result (string passes through as-is). */
  run: (args: Record<string, unknown>) => unknown | Promise<unknown>
}

/** A remote Floe backend this machine can attach to (consumed by the multi-backend seam). */
export interface BackendEntry {
  id: string
  /** Short name for the UI chip — usually the remote hostname. */
  label: string
  /** WebSocket URL of the remote Floe server, e.g. ws://100.x.y.z:41680. */
  url: string
  token: string
}

// --- Declarative panels ------------------------------------------------------
// A plugin panel is data, not code: the plugin describes sections and the core
// renders them with the app's own rows, theme and keyboard model. Every id in a
// section names one of the plugin's OWN commands (short form — the host
// prefixes `plugin:<name>:` when serving the spec), so a panel interaction and
// its palette/MCP equivalent are the same dispatch.

export interface PluginPanelRow {
  id: string
  title: string
  detail?: string
  /** Short status chip on the right ("connected", "off", …). */
  state?: string
}

export type PluginPanelSection =
  | { kind: 'text'; text: string }
  | { kind: 'toggle'; id: string; label: string; value: boolean; detail?: string }
  | {
      kind: 'action'
      id: string
      label: string
      detail?: string
      /** Ask for one line of text first; it becomes the command's arg. */
      input?: { placeholder: string; verb: string }
    }
  | {
      kind: 'list'
      title?: string
      /** Shown when rows is empty. */
      empty?: string
      rows: PluginPanelRow[]
      /** Offered on each row; the row id becomes the command's arg. Enter runs the first. */
      rowActions?: Array<{ id: string; label: string }>
    }

export interface PluginPanelSpec {
  /** Short id; the panel's `sub` becomes `<plugin-name>:<id>`. */
  id: string
  /** Palette command title and the panel's heading. */
  title: string
  /** Recomputed on every fetch — return the panel's current sections. */
  body: () => PluginPanelSection[] | Promise<PluginPanelSection[]>
}

export interface FloePluginContext {
  /** The plugin's manifest name. */
  name: string
  floeVersion: string
  /** The plugin's own directory — keep plugin state/config in here. */
  dir: string
  log: (message: string, data?: Record<string, unknown>) => void
  /** The local Floe window, when one is open. Lazy — never capture the result. */
  getWindow: () => BrowserWindow | undefined
  /** Register an IPC handler; the channel is auto-prefixed `plugin:<name>:`. */
  registerIpc: (channel: string, handler: (...args: unknown[]) => unknown) => void
  /** Dispatch into any core IPC handler, as if a renderer invoked it. */
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  /** Push an event to the local renderer. */
  send: (channel: string, ...args: unknown[]) => void
  /** Observe every event the main process pushes to the local renderer (serve-side mirror). */
  onSend: (cb: (channel: string, args: unknown[]) => void) => void
  /** Palette/keymap/MCP-visible commands, ids namespaced `plugin:<name>:<id>`. */
  registerCommands: (commands: PluginCommandSpec[]) => void
  /** A tool on Floe's MCP control server, alongside the built-ins. */
  registerTool: (tool: PluginToolSpec) => void
  /**
   * A declarative panel. The host auto-registers the palette command
   * `plugin:<name>:panel.<id>` ("<title>") that opens it. A panel is UI —
   * expose its actions' equivalents as MCP tools too (agent-first).
   */
  registerPanel: (panel: PluginPanelSpec) => void
  /** Tell an open panel its data changed, so the renderer refetches the body. */
  refreshPanel: (id: string) => void
  /** The remote backends the multi-backend seam offers the preload at window load. */
  backends: { set: (list: BackendEntry[]) => void; get: () => BackendEntry[] }
}

export interface FloePlugin {
  activate: (ctx: FloePluginContext) => void | Promise<void>
  deactivate?: () => void | Promise<void>
}
