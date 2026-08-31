import { spawn } from 'node:child_process'
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

// Mirror claudeSessions.ts: sessions live at ~/.claude/projects/<encoded-cwd>/.
const projectsDir = (): string => join(homedir(), '.claude', 'projects')
const encode = (p: string): string => p.replace(/[/.]/g, '-')

export function getClaudeInfo(worktreePath: string, mcpConfig?: string): Promise<ClaudeInfo> {
  return new Promise((resolve) => {
    const info: ClaudeInfo = { mcpServers: [], skills: [], plugins: [] }
    let sessionId: string | undefined
    let settled = false

    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      // /usage is synthetic and uses no tools, so default mode never prompts.
      '--permission-mode',
      'default'
    ]
    // The same merged config a real session gets (Floe's server + the registry,
    // mcpServer.ts mcpConfigFor) — passed in by the caller so this module stays
    // free of the mcpServer graph. Without it /mcp only reports the servers in
    // Claude's own config, and the MCP panel could not show the connection
    // state of anything registered in Floe.
    if (mcpConfig) args.push('--mcp-config', mcpConfig)

    let child: ReturnType<typeof spawn>
    try {
      child = spawn('claude', args, { cwd: worktreePath, env: process.env })
    } catch (e) {
      resolve({ ...info, error: e instanceof Error ? e.message : String(e) })
      return
    }

    const timer = setTimeout(() => finish(), PROBE_TIMEOUT_MS)

    function finish(): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
      resolve(info)
    }

    // Best-effort: remove the probe's throwaway session file so it doesn't show
    // up in the Resume picker. Runs after the process exits (file fully flushed).
    function cleanup(): void {
      if (!sessionId) return
      unlink(join(projectsDir(), encode(worktreePath), `${sessionId}.jsonl`), () => {})
    }

    let buffer = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line) handleLine(line)
      }
    })

    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (c: string) => {
      stderr += c
    })

    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...info, error: e.message.includes('ENOENT') ? 'claude CLI not found' : e.message })
    })
    child.on('close', () => {
      if (!settled && !info.error && stderr.trim()) info.error = stderr.trim()
      finish()
      cleanup()
    })

    function handleLine(line: string): void {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (typeof msg.session_id === 'string') sessionId = msg.session_id

      if (msg.type === 'system' && msg.subtype === 'init') {
        if (typeof msg.model === 'string') info.model = msg.model
        if (typeof msg.claude_code_version === 'string') info.version = msg.claude_code_version
        if (typeof msg.cwd === 'string') info.cwd = msg.cwd
        if (typeof msg.permissionMode === 'string') info.permissionMode = msg.permissionMode
        if (typeof msg.apiKeySource === 'string') info.apiKeySource = msg.apiKeySource
        info.sessionId = sessionId
        info.mcpServers = parseMcp(msg.mcp_servers)
        info.skills = parseStrings(msg.skills)
        info.plugins = parsePlugins(msg.plugins)
        return
      }
      if (msg.type === 'assistant' && msg.message && typeof msg.message === 'object') {
        const content = (msg.message as { content?: unknown }).content
        if (Array.isArray(content)) {
          for (const block of content as Array<Record<string, unknown>>) {
            if (block.type === 'text' && typeof block.text === 'string' && !info.usageText) info.usageText = block.text
          }
        }
        return
      }
      if (msg.type === 'result') {
        if (!info.usageText && typeof msg.result === 'string') info.usageText = msg.result
        finish()
      }
    }

    // Trigger a turn: /usage returns text, and the init event (which carries the
    // mcp/skills/plugins data) is emitted regardless.
    child.stdin?.write(JSON.stringify({ type: 'user', message: { role: 'user', content: '/usage' } }) + '\n')
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
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'default'
    ]
    if (claudeId) args.push('--resume', claudeId, '--fork-session')

    let child: ReturnType<typeof spawn>
    try {
      child = spawn('claude', args, { cwd: worktreePath, env: process.env })
    } catch (e) {
      resolve({ categories: [], error: e instanceof Error ? e.message : String(e) })
      return
    }

    let settled = false
    let forkId: string | undefined
    const finish = (result: ContextUsage): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
      resolve(result)
    }
    const timer = setTimeout(() => finish({ categories: [], error: 'timed out' }), PROBE_TIMEOUT_MS)

    let buffer = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        // The fork's own id — its session file is ours to clean up.
        if (claudeId && typeof msg.session_id === 'string') forkId = msg.session_id
        if (msg.type === 'result' && typeof msg.result === 'string') finish(parseContextUsage(msg.result))
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (c: string) => {
      stderr += c
    })
    child.on('error', (e) =>
      finish({ categories: [], error: e.message.includes('ENOENT') ? 'claude CLI not found' : e.message })
    )
    child.on('close', () => {
      finish({ categories: [], error: stderr.trim() || 'no context report' })
      if (forkId) unlink(join(projectsDir(), encode(worktreePath), `${forkId}.jsonl`), () => {})
    })

    child.stdin?.write(JSON.stringify({ type: 'user', message: { role: 'user', content: '/context' } }) + '\n')
  })
}
