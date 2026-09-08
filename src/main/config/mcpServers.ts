// Floe's own MCP registry — the third-party servers every spawned harness gets.
//
// Same reason skills live here instead of in any harness's directory: the same
// server has to reach whichever CLI answers the turn, and copying one entry
// into ~/.claude.json, ~/.codex/config.toml and the next CLI's file is how they
// drift. Floe owns the list once and PROJECTS it per spawn (mcpServer.ts
// mcpConfigFor merges these into each session's --mcp-config).
//
// Two scopes, the same shape (mirrors skills):
//
//   ~/.config/floe/mcp.toml                    global — every project
//   ~/.config/floe/projects/<dir>/mcp.toml     this project only
//
// A project server wins over a global one of the same name.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDir } from '../dataDir'
import type { McpServerEntry } from '../../shared/types'
import { ErrorSink, type ConfigError } from './errors'
import { TableReader } from './read'
import { editToml, parseToml, type TomlEdit, type TomlValue } from './toml'
import { writeTomlFile } from './io'
import { MCP_TOML } from './template'
import { projectScan } from './projectStore'

export const TRANSPORTS = ['http', 'stdio'] as const

export const globalMcpPath = (): string => join(configDir(), 'mcp.toml')

export function projectMcpPath(projectPath: string): string | null {
  const dir = projectScan().byPath.get(projectPath)
  return dir ? join(dir, 'mcp.toml') : null
}

function parseServers(raw: string, file: string, scope: McpServerEntry['scope']): { servers: McpServerEntry[]; errors: ConfigError[] } {
  const sink = new ErrorSink(file, raw)
  const parsed = parseToml(raw)
  if (!parsed.ok) {
    sink.add(parsed.error.line, parsed.error.message)
    return { servers: [], errors: sink.errors }
  }
  const entries = (parsed.value as { server?: unknown }).server
  if (entries === undefined) return { servers: [], errors: sink.errors }
  if (!Array.isArray(entries)) {
    sink.add(1, 'server must be a list of [[server]] entries')
    return { servers: [], errors: sink.errors }
  }
  const servers: McpServerEntry[] = []
  entries.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) return
    const t = new TableReader(sink, raw, entry as Record<string, unknown>, 'server', index)
    const name = t.optStr('name')
    const transport = t.optOneOf('transport', TRANSPORTS)
    if (!name || !transport) {
      t.reject(name ? 'transport' : 'name', 'a server needs a name and a transport ("http" or "stdio")')
      return
    }
    const url = t.optStr('url')
    const command = t.optStr('command')
    if (transport === 'http' ? !url : !command) {
      t.reject(transport === 'http' ? 'url' : 'command', `a ${transport} server needs a ${transport === 'http' ? 'url' : 'command'}`)
      return
    }
    servers.push({
      name,
      scope,
      transport,
      url,
      command,
      args: t.strArray('args'),
      // Credentials, the reason a registered server can actually connect: an
      // API key for a stdio command, a bearer token for an http one.
      env: t.strTable('env'),
      headers: t.strTable('headers'),
      enabled: t.has('enabled') ? t.bool('enabled', true) : true,
      file,
      index
    })
  })
  return { servers, errors: sink.errors }
}

function readFile(path: string | null, scope: McpServerEntry['scope']): McpServerEntry[] {
  if (!path || !existsSync(path)) return []
  return parseServers(readFileSync(path, 'utf8'), path, scope).servers
}

/**
 * Every MCP server a project's sessions get: the global ones, then its own.
 * Project entries are collected second so they overwrite a global of the same
 * name — the narrower one is the one you meant. Disabled entries are listed
 * (the panel shows them dimmed); mcpConfigFor filters them out.
 */
export function listMcpServers(projectPath?: string): McpServerEntry[] {
  const found = new Map<string, McpServerEntry>()
  for (const s of readFile(globalMcpPath(), 'global')) found.set(s.name, s)
  const own = projectPath ? projectMcpPath(projectPath) : null
  if (own) for (const s of readFile(own, 'project')) found.set(s.name, s)
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** The config errors of both files, for the Settings error surface. */
export function mcpConfigErrors(projectPath?: string): ConfigError[] {
  const out: ConfigError[] = []
  const g = globalMcpPath()
  if (existsSync(g)) out.push(...parseServers(readFileSync(g, 'utf8'), g, 'global').errors)
  const p = projectPath ? projectMcpPath(projectPath) : null
  if (p && existsSync(p)) out.push(...parseServers(readFileSync(p, 'utf8'), p, 'project').errors)
  return out
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

function checkName(name: string): string {
  const clean = name.trim()
  if (!NAME_RE.test(clean)) throw new Error(`"${name}" is not a server name — letters, digits, - _ only`)
  return clean
}

function fileFor(scope: McpServerEntry['scope'], projectPath?: string): string {
  if (scope === 'global') return globalMcpPath()
  const path = projectPath ? projectMcpPath(projectPath) : null
  if (!path) throw new Error('no project here to keep a project server in')
  return path
}

// 0600, unlike every other config Floe writes: this one holds `env` and
// `headers` — API keys and bearer tokens — and a default umask would leave them
// world-readable.
const SECRET = 0o600

function edit(path: string, edits: TomlEdit[]): void {
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : MCP_TOML
  writeTomlFile(path, editToml(raw, edits), SECRET)
}

export interface NewMcpServer {
  name: string
  transport: (typeof TRANSPORTS)[number]
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
  enabled?: boolean
}

const hasKeys = (o?: Record<string, string>): boolean => !!o && Object.keys(o).length > 0

export function addMcpServer(scope: McpServerEntry['scope'], server: NewMcpServer, projectPath?: string): McpServerEntry {
  const name = checkName(server.name)
  if (server.transport === 'http' ? !server.url : !server.command) {
    throw new Error(`a ${server.transport} server needs a ${server.transport === 'http' ? 'url' : 'command'}`)
  }
  const path = fileFor(scope, projectPath)
  if (readFile(path, scope).some((s) => s.name === name)) throw new Error(`"${name}" already exists in this scope`)
  const fields: Array<[string, TomlValue]> = [
    ['name', name],
    ['transport', server.transport]
  ]
  if (server.url) fields.push(['url', server.url])
  if (server.command) fields.push(['command', server.command])
  if (server.args?.length) fields.push(['args', server.args])
  if (hasKeys(server.env)) fields.push(['env', server.env as Record<string, string>])
  if (hasKeys(server.headers)) fields.push(['headers', server.headers as Record<string, string>])
  if (server.enabled === false) fields.push(['enabled', false])
  edit(path, [{ op: 'appendEntry', table: 'server', fields }])
  const made = readFile(path, scope).find((s) => s.name === name)
  if (!made) throw new Error(`"${name}" did not read back — check ${path}`)
  return made
}

export type McpServerPatch = Partial<Omit<NewMcpServer, 'name'>> & { name?: string }

/** Resolve by name through the same project-wins lookup the list uses. */
function find(name: string, projectPath?: string): McpServerEntry {
  const found = listMcpServers(projectPath).find((s) => s.name === name)
  if (!found) throw new Error(`no MCP server called "${name}"`)
  return found
}

export function updateMcpServer(name: string, patch: McpServerPatch, projectPath?: string): McpServerEntry {
  const found = find(name, projectPath)
  const edits: TomlEdit[] = []
  const set = (key: string, value: TomlValue): void => {
    edits.push({ op: 'setInEntry', table: 'server', index: found.index, key, value })
  }
  if (patch.name !== undefined) set('name', checkName(patch.name))
  if (patch.transport !== undefined) set('transport', patch.transport)
  if (patch.url !== undefined) {
    if (patch.url === '') edits.push({ op: 'unset', table: 'server', key: 'url', index: found.index })
    else set('url', patch.url)
  }
  if (patch.command !== undefined) {
    if (patch.command === '') edits.push({ op: 'unset', table: 'server', key: 'command', index: found.index })
    else set('command', patch.command)
  }
  if (patch.args !== undefined) {
    if (!patch.args.length) edits.push({ op: 'unset', table: 'server', key: 'args', index: found.index })
    else set('args', patch.args)
  }
  // An empty table is how a patch says "drop the credentials", the same way an
  // empty string drops a url.
  if (patch.env !== undefined) {
    if (!hasKeys(patch.env)) edits.push({ op: 'unset', table: 'server', key: 'env', index: found.index })
    else set('env', patch.env)
  }
  if (patch.headers !== undefined) {
    if (!hasKeys(patch.headers)) edits.push({ op: 'unset', table: 'server', key: 'headers', index: found.index })
    else set('headers', patch.headers)
  }
  if (patch.enabled !== undefined) set('enabled', patch.enabled)
  if (edits.length) edit(found.file, edits)
  const fresh = readFile(found.file, found.scope).find((s) => s.name === (patch.name ?? found.name))
  if (!fresh) throw new Error(`"${name}" did not read back after the edit — check ${found.file}`)
  return fresh
}

export function removeMcpServer(name: string, projectPath?: string): void {
  const found = find(name, projectPath)
  edit(found.file, [{ op: 'removeEntry', table: 'server', index: found.index }])
}
