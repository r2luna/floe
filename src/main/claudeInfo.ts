import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { unlink } from 'node:fs'
import type { ClaudeInfo, ClaudeMcpServer, ClaudePlugin, ContextUsage } from '../shared/types'

// Claude Code's built-in `/usage`, `/mcp`, `/skills`, `/plugins` are TUI-only:
// in headless stream-json mode `/mcp` & friends reply "isn't available in this
// environment". But everything they'd show is already in the `system`/`init`
// event the CLI emits at startup (mcp_servers + live status, skills, plugins,
// model), and `/usage` *does* work — it returns a synthetic text reply.
//
// So a single throwaway probe gives us all four panels: spawn `claude` like a
// real session, send `/usage`, harvest the init event + the usage text, then
// kill it. The probe writes a tiny session file to ~/.claude/projects; we delete
// it on exit so it never pollutes the Resume picker.

const PROBE_TIMEOUT_MS = 20_000

// What every probe runs with. /usage and /context are synthetic and use no
// tools, so default mode never prompts.
const PROBE_ARGS = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--permission-mode',
  'default'
]

// Mirror claudeSessions.ts: sessions live at ~/.claude/projects/<encoded-cwd>/.
const projectsDir = (): string => join(homedir(), '.claude', 'projects')
const encode = (p: string): string => p.replace(/[/.]/g, '-')

// Best-effort: drop a probe's throwaway session file so it never shows up in the
// Resume picker. Called after the process exits, so the file is fully flushed.
const removeSessionFile = (worktreePath: string, id: string): void => {
  unlink(join(projectsDir(), encode(worktreePath), `${id}.jsonl`), () => {})
}

type Spawned = { child: ChildProcess; error?: never } | { child?: never; error: string }

// spawn throws synchronously on a bad cwd, so both failure modes (throw here,
// 'error' event later) have to be handled; this is the first one.
function spawnProbe(args: string[], cwd: string): Spawned {
  try {
    return { child: spawn('claude', args, { cwd, env: process.env }) }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

const spawnError = (e: Error): string => (e.message.includes('ENOENT') ? 'claude CLI not found' : e.message)

const killQuiet = (child: ChildProcess): void => {
  try {
    child.kill('SIGTERM')
  } catch {
    /* already gone */
  }
}

/** stream-json is newline-delimited, and a chunk can split a line in half. */
function pipeLines(child: ChildProcess, onLine: (line: string) => void): void {
  let buffer = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line) onLine(line)
    }
  })
}

/** The CLI's own failure text, read only when nothing better came back. */
function collectStderr(child: ChildProcess): () => string {
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (c: string) => {
    stderr += c
  })
  return () => stderr
}

function parseJson(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
}

const ask = (child: ChildProcess, command: string): void => {
  child.stdin?.write(JSON.stringify({ type: 'user', message: { role: 'user', content: command } }) + '\n')
}

/** The init event carries everything the four panels show. */
function applyInit(info: ClaudeInfo, msg: Record<string, unknown>, sessionId?: string): void {
  if (typeof msg.model === 'string') info.model = msg.model
  if (typeof msg.claude_code_version === 'string') info.version = msg.claude_code_version
  if (typeof msg.cwd === 'string') info.cwd = msg.cwd
  if (typeof msg.permissionMode === 'string') info.permissionMode = msg.permissionMode
  if (typeof msg.apiKeySource === 'string') info.apiKeySource = msg.apiKeySource
  info.sessionId = sessionId
  info.mcpServers = parseMcp(msg.mcp_servers)
  info.skills = parseStrings(msg.skills)
  info.plugins = parsePlugins(msg.plugins)
}

/** The first text block of an assistant message — the /usage reply. */
function firstText(msg: Record<string, unknown>): string | undefined {
  const content = (msg.message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return undefined
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === 'text' && typeof block.text === 'string') return block.text
  }
  return undefined
}

interface Probe {
  info: ClaudeInfo
  sessionId?: string
}

/** Fold one stream-json line into the probe. True means the run is over. */
function foldLine(probe: Probe, line: string): boolean {
  const msg = parseJson(line)
  if (!msg) return false
  if (typeof msg.session_id === 'string') probe.sessionId = msg.session_id

  if (msg.type === 'system' && msg.subtype === 'init') {
    applyInit(probe.info, msg, probe.sessionId)
    return false
  }
  if (msg.type === 'assistant') {
    const text = firstText(msg)
    if (text !== undefined && !probe.info.usageText) probe.info.usageText = text
    return false
  }
  if (msg.type === 'result') {
    if (!probe.info.usageText && typeof msg.result === 'string') probe.info.usageText = msg.result
    return true
  }
  return false
}

export function getClaudeInfo(worktreePath: string, mcpConfig?: string): Promise<ClaudeInfo> {
  return new Promise((resolve) => {
    const probe: Probe = { info: { mcpServers: [], skills: [], plugins: [] } }
    const info = probe.info
    let settled = false

    // The same merged config a real session gets (Floe's server + the registry,
    // mcpServer.ts mcpConfigFor) — passed in by the caller so this module stays
    // free of the mcpServer graph. Without it /mcp only reports the servers in
    // Claude's own config, and the MCP panel could not show the connection
    // state of anything registered in Floe.
    const args = mcpConfig ? [...PROBE_ARGS, '--mcp-config', mcpConfig] : [...PROBE_ARGS]

    const spawned = spawnProbe(args, worktreePath)
    if (!spawned.child) {
      resolve({ ...info, error: spawned.error })
      return
    }
    const child = spawned.child

    const timer = setTimeout(() => finish(), PROBE_TIMEOUT_MS)

    function finish(): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killQuiet(child)
      resolve(info)
    }

    const stderr = collectStderr(child)
    pipeLines(child, (line) => {
      if (foldLine(probe, line)) finish()
    })

    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...info, error: spawnError(e) })
    })
    child.on('close', () => {
      if (!settled && !info.error && stderr().trim()) info.error = stderr().trim()
      finish()
      if (probe.sessionId) removeSessionFile(worktreePath, probe.sessionId)
    })

    // Trigger a turn: /usage returns text, and the init event (which carries the
    // mcp/skills/plugins data) is emitted regardless.
    ask(child, '/usage')
  })
}

function parseMcp(raw: unknown): ClaudeMcpServer[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((s): ClaudeMcpServer => {
      const o = (s ?? {}) as Record<string, unknown>
      return { name: String(o.name ?? ''), status: String(o.status ?? 'unknown') }
    })
    .filter((s) => s.name)
}

function parseStrings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === 'string')
}

function parsePlugins(raw: unknown): ClaudePlugin[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((p): ClaudePlugin => {
      const o = (p ?? {}) as Record<string, unknown>
      return { name: String(o.name ?? ''), source: typeof o.source === 'string' ? o.source : undefined }
    })
    .filter((p) => p.name)
}

// --- /context ---------------------------------------------------------------
// `/context` also works headless (synthetic text reply, a markdown report). To
// get the REAL numbers for a live session we resume it — `--fork-session` so the
// probe writes a brand-new session file instead of appending to the user's, and
// that fork is deleted on exit like the /usage probe's. Without a claudeId
// (session never prompted) the numbers still cover the static half of the
// context: system prompt, tools, MCP, memory, skills, agents.

// "3.5k" → 3500, "1m" → 1000000, "632" → 632, "< 20" → 20.
export function parseTokenCount(raw: string): number {
  const m = /([\d.]+)\s*([km])?/i.exec(raw.trim())
  if (!m) return 0
  const n = Number(m[1])
  if (!Number.isFinite(n)) return 0
  const unit = m[2]?.toLowerCase()
  return Math.round(n * (unit === 'm' ? 1_000_000 : unit === 'k' ? 1000 : 1))
}

// Pull the model, the totals line and the "usage by category" table out of the
// /context report. Free space is dropped — the bar shows it as empty track.
export function parseContextUsage(text: string): ContextUsage {
  const usage: ContextUsage = { categories: [] }
  const model = /\*\*Model:\*\*\s*([^\s*[]+)/.exec(text)
  if (model) usage.model = model[1]
  const totals = /\*\*Tokens:\*\*\s*([\d.]+\s*[km]?)\s*\/\s*([\d.]+\s*[km]?)/i.exec(text)
  if (totals) {
    usage.used = parseTokenCount(totals[1])
    usage.window = parseTokenCount(totals[2])
  }
  const table = /### Estimated usage by category([\s\S]*?)(?:\n###|$)/.exec(text)
  for (const line of (table?.[1] ?? '').split('\n')) {
    const cells = line.split('|').map((c) => c.trim())
    if (cells.length < 4) continue
    const [, label, tokens] = cells
    if (!label || /^-+$/.test(label) || label === 'Category' || label === 'Free space') continue
    usage.categories.push({ label, tokens: parseTokenCount(tokens) })
  }
  return usage
}

export function getContextUsage(worktreePath: string, claudeId?: string): Promise<ContextUsage> {
  return new Promise((resolve) => {
    const args = claudeId ? [...PROBE_ARGS, '--resume', claudeId, '--fork-session'] : [...PROBE_ARGS]

    const { child, error } = spawnProbe(args, worktreePath)
    if (!child) {
      resolve({ categories: [], error })
      return
    }

    let settled = false
    let forkId: string | undefined
    const finish = (result: ContextUsage): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killQuiet(child)
      resolve(result)
    }
    const timer = setTimeout(() => finish({ categories: [], error: 'timed out' }), PROBE_TIMEOUT_MS)

    const stderr = collectStderr(child)
    pipeLines(child, (line) => {
      const msg = parseJson(line)
      if (!msg) return
      // The fork's own id — its session file is ours to clean up.
      if (claudeId && typeof msg.session_id === 'string') forkId = msg.session_id
      if (msg.type === 'result' && typeof msg.result === 'string') finish(parseContextUsage(msg.result))
    })
    child.on('error', (e) => finish({ categories: [], error: spawnError(e) }))
    child.on('close', () => {
      finish({ categories: [], error: stderr().trim() || 'no context report' })
      if (forkId) removeSessionFile(worktreePath, forkId)
    })

    ask(child, '/context')
  })
}
