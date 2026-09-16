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
//   ~/.config/floe/mcp.toml          global — every project
//   <repo>/.floe/mcp.toml            this project only, committed
//   <repo>/.floe/local/mcp.toml      that project's credentials, gitignored
//
// A project server wins over a global one of the same name. A project server's
// env and headers are secrets, so they never go in the committed file: the
// local file holds them per server name and they are merged on read.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDir } from '../dataDir'
import type { McpServerEntry } from '../../shared/types'
import { ErrorSink, type ConfigError } from './errors'
import { TableReader } from './read'
import { editToml, parseToml, type TomlEdit, type TomlValue } from './toml'
import { writeTomlFile } from './io'
import { LOCAL_MCP_TOML, MCP_TOML } from './template'
import { projectScan } from './projectStore'
import { ensureRepoDir, repoFloeDir, repoLocalDir } from './repoConfig'

export const TRANSPORTS = ['http', 'stdio'] as const

export const globalMcpPath = (): string => join(configDir(), 'mcp.toml')

export function projectMcpPath(projectPath: string): string | null {
  return projectScan().byPath.has(projectPath) ? join(repoFloeDir(projectPath), 'mcp.toml') : null
}

export function localMcpPath(projectPath: string): string | null {
  return projectScan().byPath.has(projectPath) ? join(repoLocalDir(projectPath), 'mcp.toml') : null
}

type Credentials = Pick<McpServerEntry, 'env' | 'headers'> & { index: number }

/** The local file: `[[server]]` entries holding only a name, env and headers. */
function parseCredentials(raw: string, file: string): { byName: Map<string, Credentials>; errors: ConfigError[] } {
  const sink = new ErrorSink(file, raw)
  const byName = new Map<string, Credentials>()
  const parsed = parseToml(raw)
  if (!parsed.ok) {
    sink.add(parsed.error.line, parsed.error.message)
    return { byName, errors: sink.errors }
  }
  const entries = (parsed.value as { server?: unknown }).server
  if (!Array.isArray(entries)) return { byName, errors: sink.errors }
  entries.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) return
    const t = new TableReader(sink, raw, entry as Record<string, unknown>, 'server', index)
    const name = t.optStr('name')
    if (!name) return t.reject('name', 'a credentials entry needs the name of the server it is for')
    byName.set(name, { env: t.strTable('env'), headers: t.strTable('headers'), index })
  })
  return { byName, errors: sink.errors }
}

function readCredentials(projectPath: string): Map<string, Credentials> {
  const path = localMcpPath(projectPath)
  if (!path || !existsSync(path)) return new Map()
  return parseCredentials(readFileSync(path, 'utf8'), path).byName
}

export function parseServers(raw: string, file: string, scope: McpServerEntry['scope']): { servers: McpServerEntry[]; errors: ConfigError[] } {
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

/** A project's servers, with the credentials from its local file merged in. */
function readProject(projectPath: string): McpServerEntry[] {
  const creds = readCredentials(projectPath)
  return readFile(projectMcpPath(projectPath), 'project').map((s) => {
    const c = creds.get(s.name)
    return c ? { ...s, env: c.env ?? s.env, headers: c.headers ?? s.headers } : s
  })
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
  if (projectPath) for (const s of readProject(projectPath)) found.set(s.name, s)
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** The config errors of both files, for the Settings error surface. */
export function mcpConfigErrors(projectPath?: string): ConfigError[] {
  const out: ConfigError[] = []
  const g = globalMcpPath()
  if (existsSync(g)) out.push(...parseServers(readFileSync(g, 'utf8'), g, 'global').errors)
  const p = projectPath ? projectMcpPath(projectPath) : null
  if (p && existsSync(p)) out.push(...parseServers(readFileSync(p, 'utf8'), p, 'project').errors)
  const l = projectPath ? localMcpPath(projectPath) : null
  if (l && existsSync(l)) out.push(...parseCredentials(readFileSync(l, 'utf8'), l).errors)
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

// 0600, unlike every other config Floe writes: the global and local files hold
// `env` and `headers` — API keys and bearer tokens — and a default umask would
// leave them world-readable.
const SECRET = 0o600

function edit(path: string, edits: TomlEdit[]): void {
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : MCP_TOML
  writeTomlFile(path, editToml(raw, edits), SECRET)
}

/** Where a project scope write lands: the repo's `.floe/`, created on first use. */
function projectFile(projectPath: string, local: boolean): string {
  ensureRepoDir(projectPath, local)
  return join(local ? repoLocalDir(projectPath) : repoFloeDir(projectPath), 'mcp.toml')
}

/**
 * Set, clear or drop a project server's credentials in the local file.
 *
 * `undefined` leaves a field alone and an empty table clears it. An entry left
 * with neither is removed, so the file never lists a server with nothing in it.
 */
function writeCredentials(projectPath: string, name: string, patch: Pick<McpServerEntry, 'env' | 'headers'>, rename?: string): void {
  const current = readCredentials(projectPath).get(name)
  const next = {
    env: patch.env === undefined ? current?.env : hasKeys(patch.env) ? patch.env : undefined,
    headers: patch.headers === undefined ? current?.headers : hasKeys(patch.headers) ? patch.headers : undefined
  }
  const fields: Array<[string, TomlValue]> = [['name', rename ?? name]]
  if (next.env) fields.push(['env', next.env])
  if (next.headers) fields.push(['headers', next.headers])
  const edits: TomlEdit[] = current ? [{ op: 'removeEntry', table: 'server', index: current.index }] : []
  if (fields.length > 1) edits.push({ op: 'appendEntry', table: 'server', fields })
  if (!edits.length) return
  const path = projectFile(projectPath, true)
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : LOCAL_MCP_TOML
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
  const path = scope === 'project' && projectPath && projectMcpPath(projectPath) ? projectFile(projectPath, false) : fileFor(scope, projectPath)
  if (readFile(path, scope).some((s) => s.name === name)) throw new Error(`"${name}" already exists in this scope`)
  const project = scope === 'project' ? projectPath : undefined
  const fields: Array<[string, TomlValue]> = [
    ['name', name],
    ['transport', server.transport]
  ]
  if (server.url) fields.push(['url', server.url])
  if (server.command) fields.push(['command', server.command])
  if (server.args?.length) fields.push(['args', server.args])
  if (!project && hasKeys(server.env)) fields.push(['env', server.env as Record<string, string>])
  if (!project && hasKeys(server.headers)) fields.push(['headers', server.headers as Record<string, string>])
  if (server.enabled === false) fields.push(['enabled', false])
  edit(path, [{ op: 'appendEntry', table: 'server', fields }])
  if (project) writeCredentials(project, name, { env: server.env, headers: server.headers })
  const made = (project ? readProject(project) : readFile(path, scope)).find((s) => s.name === name)
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

/**
 * The edits for one entry in the file it lives in. An empty value clears the
 * key: an empty string drops a url, an empty list drops args, and an empty table
 * drops credentials. `withCredentials` is false for a project server, whose
 * env and headers live in the local file instead.
 */
function entryEdits(index: number, patch: McpServerPatch, withCredentials: boolean): TomlEdit[] {
  const values: Array<[string, TomlValue | undefined, boolean]> = [
    ['name', patch.name === undefined ? undefined : checkName(patch.name), false],
    ['transport', patch.transport, false],
    ['url', patch.url, patch.url === ''],
    ['command', patch.command, patch.command === ''],
    ['args', patch.args, !!patch.args && !patch.args.length],
    ['enabled', patch.enabled, false]
  ]
  if (withCredentials) {
    values.push(['env', patch.env, !!patch.env && !hasKeys(patch.env)])
    values.push(['headers', patch.headers, !!patch.headers && !hasKeys(patch.headers)])
  }
  return values
    .filter(([, value]) => value !== undefined)
    .map(([key, value, clear]): TomlEdit =>
      clear
        ? { op: 'unset', table: 'server', key, index }
        : { op: 'setInEntry', table: 'server', index, key, value: value as TomlValue }
    )
}

export function updateMcpServer(name: string, patch: McpServerPatch, projectPath?: string): McpServerEntry {
  const found = find(name, projectPath)
  const local = found.scope === 'project' ? projectPath : undefined
  const edits = entryEdits(found.index, patch, !local)
  if (local && (patch.env !== undefined || patch.headers !== undefined || patch.name !== undefined)) {
    writeCredentials(local, found.name, { env: patch.env, headers: patch.headers }, patch.name && checkName(patch.name))
  }
  if (edits.length) edit(found.file, edits)
  const next = patch.name ?? found.name
  const fresh = (local ? readProject(local) : readFile(found.file, found.scope)).find((s) => s.name === next)
  if (!fresh) throw new Error(`"${name}" did not read back after the edit — check ${found.file}`)
  return fresh
}

export function removeMcpServer(name: string, projectPath?: string): void {
  const found = find(name, projectPath)
  edit(found.file, [{ op: 'removeEntry', table: 'server', index: found.index }])
  if (found.scope === 'project' && projectPath) writeCredentials(projectPath, found.name, { env: {}, headers: {} })
}
