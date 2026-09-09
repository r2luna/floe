// One MCP server list, projected into whatever the harness answering the turn
// can read.
//
// Floe owns the servers (its own control server plus the registry in
// config/mcpServers.ts) and every harness spells the same three facts —
// "http here", "run this command", "with these credentials" — in its own
// dialect:
//
//   claude    --mcp-config <file>            { mcpServers: { … } }
//   codex     thread/start `config`          per-thread config overrides
//   opencode  OPENCODE_CONFIG_CONTENT        JSON merged over the user's config
//   gemini    GEMINI_CLI_SYSTEM_SETTINGS_PATH  a settings file we generate
//
// Nothing here spawns anything: each function answers with argv, env or a file
// path, and agent.ts / codex.ts / runtimes.ts hand it to their own spawn. That
// is also why this module is testable without Electron running.
//
// Harnesses with no tools at all (lmstudio, ollama — see shared/modes.ts) get
// nothing, because there is nothing in them to call a tool with.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { McpServerEntry } from '../shared/types'
import { isQueryKey } from '../shared/queries'
import { listMcpServers } from './config/mcpServers'
import { projectFor } from './config/projectStore'

// The port the control server bound, published here rather than read back from
// mcpServer.ts: the runtimes import this module, mcpServer imports them, and a
// cycle between the three is a worse bargain than one setter.
let serverPort = 0

export function setMcpPort(value: number): void {
  serverPort = value
}

/** The url a session's tools answer on — the path carries the caller's token. */
export function mcpUrlFor(key: string): string {
  return `http://127.0.0.1:${serverPort}/mcp/${encodeURIComponent(key)}`
}

/**
 * Every MCP server a session in this worktree gets: Floe's own control server
 * plus the enabled registry entries, in the neutral shape the projections read.
 */
export function serversFor(key: string, worktreePath?: string): McpServerMap {
  return mcpServerMap(mcpUrlFor(key), worktreePath)
}

/**
 * A query gets no servers at all (D8): its key resolves to no session, so the
 * token would be one no tool can attribute, and a read-only side conversation
 * has no business opening panels or creating sessions either.
 *
 * Claude spells that with `--strict-mcp-config` and an empty file. Nobody else
 * has such a flag: codex, opencode and gemini all MERGE what Floe passes over
 * the user's own config, and Floe now registers itself globally in all three —
 * so "pass nothing" would leave a query inheriting the whole control plane.
 * Verified on codex-cli 0.150.1: `-c mcp_servers={}` leaves inherited servers
 * standing, `-c mcp_servers.<name>.enabled=false` takes one down. So the empty
 * config is not empty: it names every server Floe knows about and turns each
 * one off.
 *
 * The floe entry's url is a placeholder here, never the caller's token: a
 * disabled entry that still carries a live token is one config-merge bug away
 * from handing a query the tools.
 */
export function queryServers(worktreePath?: string): McpServerMap {
  // Every entry, including the ones disabled in Floe: "off here" and "off in the
  // harness" are different files, and only the second one is what a query
  // inherits. What this cannot reach is a server the user configured directly in
  // codex's or opencode's own config — Floe does not know its name to name it.
  const map = mcpServerMap('http://127.0.0.1:0/mcp/disabled', worktreePath, true)
  return Object.fromEntries(Object.entries(map).map(([name, s]) => [name, { ...s, enabled: false }]))
}

/**
 * The environment a non-Claude CLI harness spawns with — opencode and gemini
 * both take their servers that way. codex is the exception: it is driven over
 * the app-server protocol, so its servers ride in `thread/start` instead
 * (codexThreadConfig).
 */
export function harnessMcp(harness: string, key: string, worktreePath?: string): Record<string, string> {
  return harnessEnv(harness, key, mapFor(key, worktreePath))
}

/**
 * The env a PEER consult spawns with (peer.ts): every server switched off.
 *
 * Same reasoning as a query (D8), and the same danger: a peer answering inside
 * someone else's session must not be able to open panels, create sessions or
 * post messages as its caller. The token is never handed over, and the
 * inherited global registration is turned off by name.
 */
export function peerMcp(harness: string, key: string, worktreePath?: string): Record<string, string> {
  return harnessEnv(harness, key, queryServers(worktreePath))
}

/** What this caller gets: its own servers, or every server switched off. */
function mapFor(key: string, worktreePath?: string): McpServerMap {
  return isQueryKey(key) ? queryServers(worktreePath) : serversFor(key, worktreePath)
}

/** One server, harness-neutral: the shape every projection below reads. */
export interface McpServerSpec {
  transport: 'http' | 'stdio'
  url?: string
  command?: string
  args?: string[]
  /** stdio only: variables the server process needs (API keys, mostly). */
  env?: Record<string, string>
  /** http only: headers the request carries (bearer tokens, mostly). */
  headers?: Record<string, string>
  /** false = tell the harness to switch this one OFF (see queryServers). */
  enabled?: boolean
}

export type McpServerMap = Record<string, McpServerSpec>

/**
 * Where a harness that can only be reached through the filesystem gets its
 * file. Its own directory, 0700: these configs carry the session's Floe token
 * and whatever credentials the registry holds, and the system temp dir is
 * shared with every other process on the machine.
 */
function tempFile(name: string): string {
  const dir = join(tmpdir(), 'floe-mcp')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return join(dir, name)
}

/** Drop the generated configs on the way out — they are per-run, not per-user. */
export function clearHarnessConfigs(): void {
  try {
    rmSync(join(tmpdir(), 'floe-mcp'), { recursive: true, force: true })
  } catch {
    // best-effort: a leftover file is 0600 in a 0700 directory
  }
}

/**
 * Every server a session in this worktree should get: Floe's own control server
 * at `url`, then the enabled registry entries (global + the project's own).
 *
 * `url` null means "no Floe tools" — a query (D8), which still gets the registry
 * servers stripped too, so pass an empty map for it rather than calling this.
 */
export function mcpServerMap(url: string | null, worktreePath?: string, includeDisabled = false): McpServerMap {
  const map: McpServerMap = {}
  if (url) map.floe = { transport: 'http', url }
  // Best-effort: a broken mcp.toml costs its entries (Settings shows the parse
  // error), never the floe tools.
  try {
    const project = worktreePath ? (projectFor(worktreePath) ?? undefined) : undefined
    for (const s of listMcpServers(project)) {
      if ((!s.enabled && !includeDisabled) || s.name === 'floe') continue
      map[s.name] = specOf(s)
    }
  } catch {
    // ignore — the registry is additive
  }
  return map
}

/** A registry row as the neutral spec. */
export function specOf(s: McpServerEntry): McpServerSpec {
  return s.transport === 'http'
    ? { transport: 'http', url: s.url, headers: s.headers }
    : { transport: 'stdio', command: s.command, args: s.args ?? [], env: s.env }
}

const hasKeys = (o?: Record<string, string>): boolean => !!o && Object.keys(o).length > 0

// --- claude ----------------------------------------------------------------

/** The `--mcp-config` payload: Claude's own `mcpServers` object. */
export function claudeMcpConfig(map: McpServerMap): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {}
  for (const [name, s] of Object.entries(map)) {
    mcpServers[name] =
      s.transport === 'http'
        ? { type: 'http', url: s.url, ...(hasKeys(s.headers) ? { headers: s.headers } : {}) }
        : { command: s.command, args: s.args ?? [], ...(hasKeys(s.env) ? { env: s.env } : {}) }
  }
  return { mcpServers }
}

// --- codex -----------------------------------------------------------------

/**
 * The `config` object a codex `thread/start` takes: the same keys
 * `~/.codex/config.toml` has, scoped to this one thread — so each session's
 * servers carry that session's own token.
 *
 * `default_tools_approval_mode: 'approve'` is not optional. Floe starts codex
 * threads with `approvalPolicy: 'never'` (codexServer.ts: an approval request
 * arrives as a server→client call we decline flatly), and without this every
 * MCP call comes back "requires approval, but approval policy is never" —
 * verified against codex-cli 0.150.1.
 */
export function codexMcpConfig(map: McpServerMap): { mcp_servers: Record<string, unknown> } {
  const mcp_servers: Record<string, unknown> = {}
  for (const [name, s] of Object.entries(map)) {
    // The transport is restated even when the entry is only being disabled:
    // codex refuses an override for a server it has never heard of ("invalid
    // transport"), which is exactly the case a query has to cover.
    const rest = s.enabled === false ? { enabled: false } : { default_tools_approval_mode: 'approve' }
    mcp_servers[name] =
      s.transport === 'http'
        ? { url: s.url, ...(hasKeys(s.headers) ? { http_headers: s.headers } : {}), ...rest }
        : { command: s.command, args: s.args ?? [], ...(hasKeys(s.env) ? { env: s.env } : {}), ...rest }
  }
  return { mcp_servers }
}

/** The same, for one session — what codexServer.ts hands to thread/start. */
export function codexThreadConfig(key: string, worktreePath?: string): { mcp_servers: Record<string, unknown> } {
  return codexMcpConfig(mapFor(key, worktreePath))
}

// --- opencode --------------------------------------------------------------

/**
 * `OPENCODE_CONFIG_CONTENT`: JSON merged over the user's own opencode config,
 * so Floe adds servers without touching (or replacing) their file.
 */
export function opencodeMcpConfig(map: McpServerMap): { mcp: Record<string, unknown> } {
  const mcp: Record<string, unknown> = {}
  for (const [name, s] of Object.entries(map)) {
    const enabled = s.enabled !== false
    mcp[name] =
      s.transport === 'http'
        ? { type: 'remote', url: s.url, enabled, ...(hasKeys(s.headers) ? { headers: s.headers } : {}) }
        : {
            type: 'local',
            command: [s.command ?? '', ...(s.args ?? [])],
            enabled,
            ...(hasKeys(s.env) ? { environment: s.env } : {})
          }
  }
  return { mcp }
}

// --- gemini ----------------------------------------------------------------

/**
 * gemini reads MCP servers out of settings files only, so this writes one and
 * points `GEMINI_CLI_SYSTEM_SETTINGS_PATH` at it — the enterprise override,
 * which merges without the user's own `~/.gemini/settings.json` being edited.
 *
 * ponytail: unverified against a real gemini install (it is not on this
 * machine). If the env var ever stops being read, the failure is a session with
 * no Floe tools — the same place gemini sessions were before this existed.
 */
export function geminiMcpConfig(map: McpServerMap): Record<string, unknown> {
  const mcpServers: Record<string, unknown> = {}
  for (const [name, s] of Object.entries(map)) {
    if (s.enabled === false) continue
    mcpServers[name] =
      s.transport === 'http'
        ? { httpUrl: s.url, ...(hasKeys(s.headers) ? { headers: s.headers } : {}) }
        : { command: s.command, args: s.args ?? [], ...(hasKeys(s.env) ? { env: s.env } : {}) }
  }
  // gemini has no per-server off switch, so a query says it the only other way
  // there is: an allow-list of nothing, which no inherited server can pass.
  // `mcp.allowed` is where current gemini keeps that list — and its settings
  // schema rejects unknown top-level keys, so the older `allowMCPServers`
  // spelling would cost the whole file rather than just the setting.
  const names = Object.keys(mcpServers)
  return names.length ? { mcpServers } : { mcpServers: {}, mcp: { allowed: [] } }
}

/**
 * The env a non-Claude harness spawns with. `key` is the caller's Floe token, so
 * every generated file is per session and one session's config can never be
 * handed to another.
 */
export function harnessEnv(
  harness: string,
  key: string,
  map: McpServerMap
): Record<string, string> {
  if (harness === 'opencode') {
    return { OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeMcpConfig(map)) }
  }
  if (harness === 'gemini') {
    const file = tempFile(`floe-mcp-gemini-${key}.json`)
    try {
      writeFileSync(file, JSON.stringify(geminiMcpConfig(map)), { mode: 0o600 })
    } catch {
      // Non-fatal: no file means gemini runs as it did before — without tools.
      return {}
    }
    return { GEMINI_CLI_SYSTEM_SETTINGS_PATH: file }
  }
  return {}
}
