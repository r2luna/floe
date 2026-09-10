import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSessionMeta, getCreatedSessions, type CreatedSession, type SessionMeta } from './sessionStore'
import { findSpecSummarySource } from './plans'

import { contextTokens } from '../shared/types'
import { collapseSkills, hasSkill } from '../shared/skills'
import { collapseSessionRefs, hasSessionRef } from '../shared/sessionRefs'
import { agentNick } from '../shared/nicks'
import type { Effort, PermissionMode, ProjectActivity, ProjectActivityStatus } from '../shared/types'
import { parseArtifactSpec, type ArtifactSpec } from '../shared/artifact'
import type { QueryMark } from '../shared/types'

// Claude Code stores each session as ~/.claude/projects/<encoded-cwd>/<id>.jsonl,
// where the cwd path has every NON-ALPHANUMERIC character replaced with "-". We
// read those to surface real sessions per worktree — including ones started in
// the terminal.
//
// Not just "/" and ".": a worktree under a directory with an underscore in its
// name (`__.macs`) encoded to a directory the CLI never writes, so every read
// missed and the chat opened on "Nothing said yet." with its whole transcript
// sitting on disk. Same rule as cliSessionJsonl in agent.ts.

const projectsDir = (): string => join(homedir(), '.claude', 'projects')
const encode = (p: string): string => p.replace(/[^a-zA-Z0-9]/g, '-')
const ACTIVE_WINDOW_MS = 2 * 60 * 1000

export interface ClaudeSessionMeta {
  // Floe's stable session id: the created-session id for sessions opened in
  // the app, or `claude:<claudeId>` for ones discovered straight off disk.
  id: string
  claudeId?: string
  title: string
  mtime: number
  active: boolean
  // A turn is in flight on the backend right now (set by the claude:sessions
  // handler from the live agent conns) — for callers that read the list and
  // nothing else, the MCP tools among them.
  //
  // NOT what the sidebar's spinner is drawn from: this is true as of whenever
  // the list was last read, and a row that ORed it with the live set kept
  // spinning long after the turn had ended. The renderer asks main directly
  // instead (agent.active, reconciled every few seconds — see useRunning).
  running?: boolean
  permissionMode?: PermissionMode
  model?: string
  effort?: Effort
  // The session that opened this one over MCP create_session — a subagent's
  // parent. Carried to the renderer so the sidebar can nest the row under the
  // chat that spawned it instead of listing seventeen flat siblings. Holds
  // whichever id the parent called in with (Floe's or the claudeId), so a
  // lookup has to try both — see namesOf in panels.tsx.
  spawnedBy?: string
}

export interface TranscriptItem {
  role: 'user' | 'assistant' | 'tool' | 'image' | 'artifact' | 'subagent'
  text?: string
  name?: string
  summary?: string
  mediaType?: string // for role 'image'
  data?: string // base64, for role 'image'
  spec?: ArtifactSpec // for role 'artifact' — the decision panel, rebuilt on reload
  at?: number // epoch ms — the claude JSONL line's `timestamp`, for the "time ago" stamp
  /**
   * Set on a `tool` row the USER caused — a slash command they typed, which
   * reloads as a chip rather than as the raw `<command-name>` markers. Every
   * other tool row is the agent working, and the Log heads a run of those with
   * the agent's nick: without this flag a command you ran yourself would be
   * attributed to the model.
   */
  by?: 'user'
  /**
   * Set on the `query` tool rows this app writes into a chat: a side
   * conversation opened, peeked at, merged or discarded. See QueryMark — it is
   * what the fold in the transcript is drawn from.
   */
  query?: QueryMark
  /**
   * Which `@all` fan-out this answer belongs to. Items sharing one render as a
   * single comparison block rather than as N replies in a row — the whole point
   * of asking several at once is reading them against each other.
   */
  fanoutId?: string
  /**
   * Who spoke, when it was neither you nor the model answering you: another
   * voice in the channel. Two of them exist — another Claude session whose
   * message the CLI injected here as a user turn (role 'user', see
   * parsePeerMessage), and a subagent coming back with its report (role
   * 'assistant', see agentReply). The transcript heads the line with this nick
   * instead of the user's or the model's: neither of them said it.
   */
  from?: string
  /**
   * Which model wrote this, as the API named it. Per message rather than per
   * session: you can change model mid-conversation, and a transcript that
   * labelled every line with the CURRENT pick would rewrite its own history.
   */
  model?: string
  /**
   * How hard it was told to think. The CLI records this on the JSONL LINE, not
   * inside the message — same level as the timestamp — so it is read from there.
   */
  effort?: string
  /**
   * Which runtime answered, when it was not Claude. Live-only: a transcript on
   * disk is Claude's own JSONL, so its absence means Claude.
   */
  provider?: string
  /**
   * How full the context was when this message was written — the same sum the
   * live gauge shows (see agent.contextTokens). Carried on the message so
   * reopening an old chat can show its fill without replaying the turn.
   */
  contextTokens?: number
  /**
   * How long the turn that produced this message took, in ms. Stamped on the
   * assistant messages of a turn (from the user message's timestamp to this
   * one) so the LAST message of a run can print what the turn cost.
   */
  ms?: number
  // --- role 'subagent' only -------------------------------------------------
  // A subagent speaks in the transcript as a participant of its own: nick =
  // `agentType`, badge = `harness`, body = what it is doing (live) or what it
  // answered (`text`, which only the Codex bridge carries). `summary` holds the
  // task description it was launched with.
  //
  // These fields never mix with the message ones above: `agentTokens` is the
  // subagent's OWN context fill, deliberately not `contextTokens` — that one is
  // the parent turn's gauge and stamping a child's number on it would move the
  // status bar to a window it does not describe.
  toolUseId?: string
  agentType?: string
  harness?: string
  running?: boolean
  lastTool?: string
  agentTokens?: number
}

function extractText(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } => !!b && (b as { type?: string }).type === 'text')
      .map((b) => b.text)
      .join(' ')
  }
  return ''
}

// Turn a raw first-message into a readable title: strip Claude's internal
// command wrappers, image placeholders, stray tags, and leading markdown.
function cleanTitle(raw: string): string {
  return raw
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, '')
    .replace(/<command-name>([\s\S]*?)<\/command-name>/gi, '$1')
    .replace(/<command-message>[\s\S]*?<\/command-message>/gi, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/gi, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, '')
    .replace(/<\/?[a-z][^>]*>/gi, ' ') // any other angle-bracket tags
    .replace(/\[image #?\d+\]|\bimage \d\d+\b/gi, '') // pasted-image placeholders
    .replace(/^[#>\s-]+/, '') // leading markdown heading/quote/bullet
    .replace(/\s+/g, ' ')
    .trim()
}

interface HeadInfo {
  title: string
  // Interactive Claude Code (TUI) sessions open with setup entries (`mode`,
  // `permission-mode`, `last-prompt`) and/or a `bridge-session` marker. Headless
  // runs (SDK, subagents, security reviews, agents spawned by an app) open with
  // `queue-operation`. The `claude --resume` picker only lists the interactive
  // ones, so we match it and hide the rest.
  interactive: boolean
  // Kept separate so callers can tell a REAL Claude-generated `ai-title` (only
  // interactive TUI sessions write one) from the raw first-message fallback that
  // `title` collapses them into. Headless sessions have `aiTitle === ''`, which is
  // the signal to generate a smart title ourselves (see generateSessionTitle).
  aiTitle: string
  firstUser: string
}

// Read the head of the file (cheap) to find a title: prefer Claude's ai-title,
// else the first user message — and whether it's an interactive session.
function readHead(file: string): HeadInfo {
  const buf = Buffer.alloc(131072)
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const n = readSync(fd, buf, 0, buf.length, 0)
    const text = buf.toString('utf8', 0, n)
    let aiTitle = ''
    let firstUser = ''
    let firstType = ''
    let hasBridge = false
    for (const line of text.split('\n')) {
      const s = line.trim()
      if (!s) continue
      let m: Record<string, unknown>
      try {
        m = JSON.parse(s)
      } catch {
        continue // last line in the chunk may be truncated
      }
      if (!firstType && typeof m.type === 'string') firstType = m.type
      if (m.type === 'bridge-session') hasBridge = true
      else if (m.type === 'ai-title' && typeof m.title === 'string') aiTitle = m.title
      else if (m.type === 'user' && !firstUser) firstUser = extractText(m.message)
    }
    // Headless/SDK sessions lead with `queue-operation`; interactive ones don't.
    const interactive = hasBridge || (firstType !== '' && firstType !== 'queue-operation')
    return { title: cleanTitle(aiTitle || firstUser).slice(0, 72), interactive, aiTitle, firstUser }
  } catch {
    return { title: '', interactive: false, aiTitle: '', firstUser: '' }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// Claude's own auto-generated title for a session — only interactive TUI sessions
// write an `ai-title` line, so this is empty for the headless runs Floe drives.
// Empty is the cue to generate one ourselves (generateSessionTitle).
export function readAiTitle(worktreePath: string, claudeId: string): string {
  return cleanTitle(readHead(join(projectsDir(), encode(worktreePath), `${claudeId}.jsonl`)).aiTitle).slice(0, 72)
}

// The raw-first-message fallback title, i.e. the auto-title an un-summarised
// session carries. Used to detect a session still on its placeholder title so we
// generate a smart one exactly once (never over a rename or an already-smart one).
export function firstUserTitle(worktreePath: string, claudeId: string): string {
  return cleanTitle(readHead(join(projectsDir(), encode(worktreePath), `${claudeId}.jsonl`)).firstUser).slice(0, 72)
}

// Generate a short, descriptive session title with a cheap model (Haiku) from the
// session's opening request. Returns '' on any failure so the caller keeps the
// existing placeholder. Falls back to a trimmed first message if the CLI is absent.
// ponytail: one prompt, first message only — no transcript summarisation; feed the
// last assistant turn too if titles need to reflect where the session ended up.
export function generateSessionTitle(worktreePath: string, claudeId: string): Promise<string> {
  const first = firstUserTitle(worktreePath, claudeId)
  if (!first) return Promise.resolve('')
  const heuristic = shortLabel(first)
  const prompt =
    'Write a 3-5 word title (max 40 chars) naming what this coding session is about. ' +
    'Reply with ONLY the title — no quotes, no trailing punctuation.\n\nRequest:\n' +
    first.slice(0, 800)
  return new Promise((resolve) => {
    // No MCP config and a tight timeout: a plain title prompt needs no tools, so it
    // can't hang on a permission prompt. Heuristic fallback on error/empty.
    execFile(
      'claude',
      ['-p', prompt, '--model', 'haiku'],
      { cwd: worktreePath, env: process.env, timeout: 20_000, maxBuffer: 1 << 20 },
      (err, stdout) => {
        const t = cleanTitle((stdout || '').replace(/^["'`]+|["'`]+$/g, '')).slice(0, 48)
        resolve(err || !t ? heuristic : t)
      }
    )
  })
}

// Generate (and cache) a one-line description of what a worktree is about, from
// its spec.md, so a cryptic branch name reads at a glance in the sidebar. Mirrors
// generateSessionTitle: a tight-timeout Haiku print-mode call, no tools/MCP so it
// can't hang on a permission prompt. Cached in a `.gw-desc` marker; regenerated
// only when spec.md is newer than the marker. Returns the new text when it wrote
// one, else null (no spec, already fresh, or the call failed — keep what's there).
// ponytail: mtime staleness, one Haiku call per spec change — no diffing.
export function generateWorktreeDesc(worktreePath: string, branch: string): Promise<string | null> {
  const marker = join(worktreePath, '.gw-desc')
  const source = findSpecSummarySource(worktreePath, branch)
  if (!source) {
    // No spec matches this branch → any existing `.gw-desc` was borrowed from
    // another worktree by the old fallback; drop it so the stale text clears.
    try {
      if (existsSync(marker)) unlinkSync(marker)
    } catch {
      /* best-effort */
    }
    return Promise.resolve(null)
  }

  try {
    // Fresh if the marker is newer than the spec it was generated from.
    if (existsSync(marker) && statSync(marker).mtimeMs >= source.mtime) return Promise.resolve(null)
  } catch {
    /* fall through and regenerate */
  }

  let spec: string
  try {
    spec = readFileSync(source.path, 'utf8')
  } catch {
    return Promise.resolve(null)
  }
  if (!spec.trim()) return Promise.resolve(null)

  const prompt =
    'From this feature spec, write ONE plain-language sentence (max 120 chars) ' +
    'describing what this branch/worktree is about, so someone scanning a list ' +
    'knows what it does. Reply with ONLY the sentence — no quotes, no preamble.\n\nSpec:\n' +
    spec.slice(0, 4000)

  return new Promise((resolve) => {
    execFile(
      'claude',
      ['-p', prompt, '--model', 'haiku'],
      { cwd: worktreePath, env: process.env, timeout: 20_000, maxBuffer: 1 << 20 },
      (err, stdout) => {
        const desc = (stdout || '')
          .replace(/^["'`]+|["'`]+$/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 160)
        if (err || !desc) return resolve(null)
        try {
          writeFileSync(marker, desc + '\n')
        } catch {
          return resolve(null)
        }
        resolve(desc)
      }
    )
  })
}

// Trim a raw request to a short label at a word boundary — the no-LLM fallback.
function shortLabel(raw: string): string {
  const s = cleanTitle(raw)
  if (s.length <= 40) return s
  const cut = s.slice(0, 40)
  const sp = cut.lastIndexOf(' ')
  return (sp > 20 ? cut.slice(0, sp) : cut) + '…'
}

/**
 * What a session is CALLED: its rename, then the title it was opened with, then
 * a shortened id. The sidebar reads it, and so does the `#` reference resolver
 * — a slug is matched against this title, so the two have to be the same rule
 * or the name you picked out of the menu would resolve to nothing.
 */
export function sessionTitle(c: CreatedSession, meta: Record<string, SessionMeta> = getSessionMeta()): string {
  return (c.claudeId ? meta[c.claudeId]?.title : undefined) || c.title || c.claudeId?.slice(0, 8) || 'Session'
}

// The sidebar's session list: *only* the sessions Floe knows about (opened
// with ⌘T, or pulled in via Resume) — never the full on-disk history. Enriched
// with each session's real mtime / active state and any stored rename.
export function listClaudeSessions(worktreePath: string): ClaudeSessionMeta[] {
  const now = Date.now()
  const meta = getSessionMeta()
  const dir = join(projectsDir(), encode(worktreePath))
  // Stable creation order: never reorder the sidebar by mtime — a session that
  // just received activity would otherwise jump around on its own.
  const created = getCreatedSessions(worktreePath)
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt)
  const sessions = created.map((c): ClaudeSessionMeta => {
    // Recency, in order of trust: the transcript's mtime when there is one,
    // otherwise the last turn we ran ourselves, otherwise creation.
    let mtime = c.usedAt ?? c.createdAt
    let active = false
    if (c.claudeId) {
      try {
        const st = statSync(join(dir, `${c.claudeId}.jsonl`))
        mtime = Math.max(st.mtimeMs, c.usedAt ?? 0)
        active = now - mtime < ACTIVE_WINDOW_MS
      } catch {
        // No `.jsonl` yet (never sent) — keep createdAt and treat as inactive.
      }
    }
    return {
      id: c.id,
      claudeId: c.claudeId,
      title: sessionTitle(c, meta),
      mtime,
      active,
      permissionMode: c.permissionMode,
      model: c.model,
      effort: c.effort,
      spawnedBy: c.spawnedBy
    }
  })
  return sessions
}

// --- Projects rail: cross-project activity ---------------------------------
// The rail shows every project worked *today* with a single status glyph, even
// for projects the user isn't currently inside. We can't lean on the renderer's
// in-memory transcript blocks there (those load only for the active project), so
// the status is derived straight from the session files on disk.

const STATUS_RANK: Record<ProjectActivityStatus, number> = { done: 0, pending: 1, ask: 2 }

function startOfTodayMs(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// Read just the last `maxBytes` of a file — enough to spot a still-open question
// near the end of a transcript without parsing the whole thing.
function readTail(file: string, maxBytes = 65536): string {
  let fd: number | undefined
  try {
    const size = statSync(file).size
    const len = Math.min(maxBytes, size)
    if (len <= 0) return ''
    const buf = Buffer.alloc(len)
    fd = openSync(file, 'r')
    readSync(fd, buf, 0, len, size - len)
    return buf.toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// True when the transcript tail holds an `AskUserQuestion` tool_use with no
// matching tool_result after it — i.e. the agent is blocked waiting on the user.
// (A partially-cut first line just fails to parse and is skipped.)
function hasUnansweredQuestion(file: string): boolean {
  const text = readTail(file)
  if (!text) return false
  const asked: string[] = []
  const answered = new Set<string>()
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s || s[0] !== '{') continue
    let m: Record<string, unknown>
    try {
      m = JSON.parse(s)
    } catch {
      continue
    }
    const content = (m.message as { content?: unknown } | null)?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_use' && block.name === 'AskUserQuestion' && typeof block.id === 'string') {
        asked.push(block.id)
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        answered.add(block.tool_use_id)
      }
    }
  }
  return asked.some((id) => !answered.has(id))
}

// Public form keyed by worktree + Claude session id, so callers (the cross-project
// "NEEDS YOU" scan) don't need to know the on-disk path encoding.
export function sessionHasUnansweredQuestion(worktreePath: string, claudeId: string): boolean {
  return hasUnansweredQuestion(join(projectsDir(), encode(worktreePath), `${claudeId}.jsonl`))
}

// Aggregate one project's activity for the rail: walk its worktrees' Floe
// sessions, keep the ones touched since the start of today, and return the most
// urgent status across them (ask > pending > done). Returns null when nothing was
// worked today, so the caller can drop the project off the rail.
//
// `isConnected` tells a real pending question apart from an orphaned one: if the
// CLI process is killed (or crashes) while blocked on AskUserQuestion, it never
// gets to write the answering tool_result, so the question sits unanswered at
// the transcript's tail forever. Without a liveness check that stale block would
// mark the project 'ask' permanently. A session still `m.active` (touched in the
// last couple minutes) is trusted even if its conn already dropped — the kill
// races the next poll tick.
export function computeProjectActivity(
  worktreePaths: string[],
  isConnected: (claudeId: string) => boolean = () => true
): Omit<ProjectActivity, 'path'> | null {
  const dayStart = startOfTodayMs()
  let sessionsToday = 0
  let activeCount = 0
  let askCount = 0
  let lastActivityAt = 0
  let worst: ProjectActivityStatus = 'done'
  for (const wt of worktreePaths) {
    const dir = join(projectsDir(), encode(wt))
    for (const m of listClaudeSessions(wt)) {
      if (m.mtime < dayStart) continue
      sessionsToday++
      if (m.mtime > lastActivityAt) lastActivityAt = m.mtime
      if (m.active) activeCount++
      let status: ProjectActivityStatus = m.active ? 'pending' : 'done'
      if (
        m.claudeId &&
        (m.active || isConnected(m.claudeId)) &&
        hasUnansweredQuestion(join(dir, `${m.claudeId}.jsonl`))
      )
        status = 'ask'
      if (status === 'ask') askCount++
      if (STATUS_RANK[status] > STATUS_RANK[worst]) worst = status
    }
  }
  if (sessionsToday === 0) return null
  return { status: worst, sessionsToday, activeCount, askCount, lastActivityAt }
}

export interface ResumableSession {
  claudeId: string
  title: string
  mtime: number
  active: boolean
  interactive: boolean // terminal (TUI) session vs a headless/SDK one
}

// Every real on-disk Claude session for a worktree — terminal or not — minus the
// ones already pulled into Floe. Powers the Resume picker so the user can
// bring any past session (hybrid: terminal or app) into the app.
export function listResumableSessions(worktreePath: string): ResumableSession[] {
  const dir = join(projectsDir(), encode(worktreePath))
  if (!existsSync(dir)) return []
  const now = Date.now()
  const meta = getSessionMeta()
  const adopted = new Set(
    getCreatedSessions(worktreePath)
      .map((c) => c.claudeId)
      .filter((id): id is string => !!id)
  )
  const out: ResumableSession[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.jsonl')) continue
    const claudeId = file.slice(0, -'.jsonl'.length)
    if (adopted.has(claudeId)) continue // already in the app
    const full = join(dir, file)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.size === 0) continue
    const head = readHead(full)
    const title = meta[claudeId]?.title || head.title
    if (!title) continue // no readable first message → subagent/system noise, skip
    out.push({ claudeId, title, mtime: st.mtimeMs, active: now - st.mtimeMs < ACTIVE_WINDOW_MS, interactive: head.interactive })
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

/** AskUserQuestion's questions as one readable block: `Header — question?`. */
function questionText(input: unknown): string | undefined {
  const raw = (input as { questions?: unknown } | null)?.questions
  if (!Array.isArray(raw)) return undefined
  const lines = (raw as Array<Record<string, unknown>>)
    .map((q) => {
      const question = typeof q.question === 'string' ? q.question : ''
      const header = typeof q.header === 'string' ? q.header : ''
      if (header && header !== question) return question ? `${header} — ${question}` : header
      return question
    })
    .filter(Boolean)
  return lines.length ? lines.join('\n') : undefined
}

/** The text of a tool_result, whether the CLI wrote it as a string or blocks. */
export function resultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim() || undefined
  if (!Array.isArray(content)) return undefined
  const text = (content as Array<Record<string, unknown>>)
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => (p.text as string).trim())
    .filter(Boolean)
    .join('\n')
  return text || undefined
}

function summarizeTool(input: unknown): string | undefined {
  const obj = (input ?? {}) as Record<string, unknown>
  for (const key of ['file_path', 'command', 'pattern', 'path', 'url', 'description']) {
    const v = obj[key]
    if (typeof v === 'string') return v
  }
  return undefined
}

// When a background agent finishes, the CLI resumes the turn by injecting a
// `<task-notification>` — the agent's whole report — as a plain user message.
// Nobody typed it: reloading it as a user line pastes that report into the chat
// under your name. The live stream already discards it (see agent.ts).
export function isTaskNotification(text: string): boolean {
  return !text.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '').trim()
}

// What a notification says: which agent finished (the id of the Task call that
// launched it) and, when it is an agent rather than a background command, the
// report it came back with. That report is the agent talking to the session
// that sent it — the only place its words exist.
export function parseTaskNotifications(text: string): Array<{ toolUseId: string; result?: string }> {
  const out: Array<{ toolUseId: string; result?: string }> = []
  // Per block, never over the whole string: two agents finishing at once are
  // delivered as adjacent blocks, and matching across them would hand the first
  // agent's id the second agent's report.
  for (const [, block] of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const toolUseId = block.match(/<tool-use-id>([^<]+)<\/tool-use-id>/)?.[1]?.trim()
    if (!toolUseId) continue
    const result = block.match(/<result>([\s\S]*?)<\/result>/)?.[1]?.trim()
    out.push({ toolUseId, result: result || undefined })
  }
  return out
}

// The Agent tool's async launch returns this the moment the agent starts, long
// before it has anything to say: it closes nothing and is not a report. Takes
// the RESULT TEXT (see resultText) rather than the raw content: the CLI writes
// a tool_result as a string or as blocks, and a check that only understood one
// of them let the ack through as if it were the agent's answer.
export function isAsyncLaunchAck(text: string | undefined): boolean {
  return !!text && text.includes('Async agent launched')
}

// Another Claude session's message: the CLI delivers it as a plain user turn —
// a preamble, the `<cross-session-message from-name="…">` block, and a trailer
// of instructions about how to treat it. Nobody in this window typed any of it.
// Only the block's body is a message; the rest is addressed to the model.
export function parsePeerMessage(text: string): { from: string; body: string } | null {
  // The harness's own preamble, required and required FIRST: without it any
  // user who quotes an envelope (asking about this very feature, say) would
  // have their own words reloaded under someone else's nick.
  if (!text.trimStart().startsWith('Another Claude session sent a message:')) return null
  const m = text.match(/<cross-session-message\b([^>]*)>([\s\S]*?)<\/cross-session-message>/)
  if (!m) return null
  // The harness heads the envelope with one line: "Another Claude session sent
  // a message:". Anything else in front of it means somebody QUOTED an envelope
  // inside a message of their own — and their words are the message, not the
  // name in the quote. Without this, a line typed by the user could speak as
  // anyone. If the harness ever rewords that line the check stops matching and
  // the envelope prints as raw text: visibly wrong, but under the nick of
  // whoever really sent it, which is the half that matters.
  const before = text.slice(0, m.index).trim()
  if (before && !/(^|\n)[^\n]*sent a message:$/.test(before)) return null
  const name = m[1].match(/from-name="([^"]*)"/)?.[1]?.trim()
  // A nick is required to head the entry: an unnamed peer is still not you.
  return { from: name || 'peer', body: m[2].trim() }
}

/**
 * Undo whatever Floe expanded into this prompt before it was sent.
 *
 * One function because both kinds arrive the same way — echoed back by the
 * harness in its own log — and a reader that knew about one of them would print
 * the other as raw markup.
 */
export function collapseFloe(text: string): string {
  let out = text
  if (hasSkill(out)) out = collapseSkills(out)
  if (hasSessionRef(out)) out = collapseSessionRefs(out)
  return out
}

// Prettify Claude Code's local slash-command markers that show up in user
// messages: drop the internal caveat, render the command as a chip, and the
// command output as a code block.
function expandUserText(text: string): TranscriptItem[] {
  const stripped = text.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '').trim()
  if (!stripped) return []
  if (isTaskNotification(stripped)) return []

  const peer = parsePeerMessage(stripped)
  if (peer) return peer.body ? [{ role: 'user', from: peer.from, text: peer.body }] : []

  const nameMatch = stripped.match(/<command-name>([\s\S]*?)<\/command-name>/)
  if (nameMatch) {
    const argsMatch = stripped.match(/<command-args>([\s\S]*?)<\/command-args>/)
    const args = (argsMatch?.[1] ?? '').trim()
    // `by: 'user'` — you typed this one. It is the only tool row that is not
    // the agent working, and the Log reads that flag to keep it in your run.
    return [
      { role: 'tool', name: nameMatch[1].trim() || 'command', summary: args || undefined, by: 'user' }
    ]
  }

  const stdoutMatch = stripped.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/)
  if (stdoutMatch) {
    const out = stdoutMatch[1].trim()
    return out ? [{ role: 'assistant', text: '```\n' + out + '\n```' }] : []
  }

  // A Floe expansion the harness echoed back — a skill's instructions, or the
  // address of a session you named with `#`. Collapsed to the token that was
  // typed, so a transcript reopened tomorrow reads the way it did when it was
  // written: the expansion went to the model, not to you.
  const collapsed = collapseFloe(stripped)
  return collapsed ? [{ role: 'user', text: collapsed }] : []
}

/**
 * A subagent's report, as its own line in the channel.
 *
 * It reads as `assistant` because that is what wrote it — the body is markdown
 * and belongs rendered as such — and it carries `from` because it was NOT the
 * model you are talking to: it is the agent that model sent out, coming back
 * with what it found.
 */
function agentReply(row: TranscriptItem, text: string): TranscriptItem {
  return { role: 'assistant', from: agentNick(row.agentType, row.toolUseId, row.harness), text }
}

// A notification closes the row of the agent it names and, when it carries a
// <result>, lets that agent speak — the report exists nowhere else. Two agents
// can finish into one message; each closes its own row, in delivery order.
// Returns whether any row here was ours: a notification for an agent this
// transcript never opened is plumbing, and must not print.
function closeAgentRows(
  items: TranscriptItem[],
  agentRows: Map<string, number>,
  notices: Array<{ toolUseId: string; result?: string }>,
  at: number | undefined
): boolean {
  const mine = notices.filter((n) => agentRows.has(n.toolUseId))
  for (const notice of mine) {
    const row = items[agentRows.get(notice.toolUseId) as number]
    row.running = false
    if (at && row.at && at >= row.at) row.ms = at - row.at
    agentRows.delete(notice.toolUseId)
    if (notice.result) items.push(agentReply(row, notice.result))
  }
  return mine.length > 0
}

// --- the JSONL walk ---------------------------------------------------------
// One line of a transcript can produce several transcript items, and the blocks
// inside it need the same three pieces of state: what has been pushed so far,
// which AskUserQuestion ids are still open, and which subagent rows are still
// running. They travel together as a context rather than as four parameters.
interface TranscriptCtx {
  items: TranscriptItem[]
  // AskUserQuestion tool_use ids: their tool_result carries the user's answer,
  // which reloads as a user line so the exchange survives — a bare tool chip
  // would strand tomorrow's reader with an answer to an invisible question.
  askIds: Set<string>
  // Task/Agent tool_use id → the index of the subagent row it opened, so its
  // tool_result (arriving lines later) can close the row it belongs to.
  agentRows: Map<string, number>
}

// The claude CLI stamps each line with an ISO `timestamp`; carry it onto every
// item the line produces so the transcript can show a "time ago" per message.
function lineAt(m: Record<string, unknown>): number | undefined {
  return typeof m.timestamp === 'string' ? Date.parse(m.timestamp) || undefined : undefined
}

function parseLine(line: string): Record<string, unknown> | null {
  const s = line.trim()
  if (!s) return null
  try {
    return JSON.parse(s) as Record<string, unknown>
  } catch {
    return null
  }
}

// What the whole LINE says about the items it produces, as opposed to what the
// message says: the model that answered, how hard it was told to think (recorded
// on the line, not inside the message) and how full the window was.
interface LineMeta {
  at?: number
  model?: string
  effort?: string
  used: number
}

function readLineMeta(m: Record<string, unknown>, role: 'user' | 'assistant'): LineMeta {
  const rawModel = (m.message as { model?: unknown } | null)?.model
  const rawEffort = (m as { effort?: unknown }).effort
  return {
    at: lineAt(m),
    model: role === 'assistant' && typeof rawModel === 'string' ? rawModel : undefined,
    effort: role === 'assistant' && typeof rawEffort === 'string' ? rawEffort : undefined,
    // The same arithmetic the live stream uses, so a reopened chat and a
    // running one never disagree about how full the window is.
    used: role === 'assistant' ? contextTokens((m.message as { usage?: unknown } | null)?.usage) : 0
  }
}

// A turn is started by a REAL user message only — a tool_result also arrives as
// `user` and would restart the clock in the middle of the turn it is part of,
// and so would a resumed turn's notification, which nobody sent.
function startsTurn(role: 'user' | 'assistant', at: number | undefined, content: unknown): boolean {
  if (role !== 'user' || !at) return false
  if (typeof content === 'string') return !isTaskNotification(content)
  return Array.isArray(content) && (content as Array<Record<string, unknown>>).some((b) => b.type === 'text')
}

// Stamped on every assistant message of the turn; the LAST one is the one the
// footer prints, and it is the one that holds the full elapsed.
function turnMs(
  role: 'user' | 'assistant',
  at: number | undefined,
  turnStartedAt: number | undefined
): number | undefined {
  return role === 'assistant' && at && turnStartedAt !== undefined && at >= turnStartedAt
    ? at - turnStartedAt
    : undefined
}

// Carry the line's numbers onto everything it pushed. A subagent row is skipped:
// it keeps its own clock and its own fill, and the turn's numbers belong to the
// parent that launched it.
function stampItems(items: TranscriptItem[], from: number, meta: LineMeta, ms: number | undefined): void {
  for (let i = from; i < items.length; i++) {
    if (items[i].role === 'subagent') continue
    items[i].at = meta.at
    if (meta.model) items[i].model = meta.model
    if (meta.effort) items[i].effort = meta.effort
    if (meta.used > 0) items[i].contextTokens = meta.used
    if (ms !== undefined) items[i].ms = ms
  }
}

// A message typed while the turn was running. The CLI does NOT echo it as a user
// line — it queues it, folds it into the turn in flight, and records what it
// absorbed as this one `attachment` line. Skipping it is how a steer vanished
// from the chat the moment the panel was reopened: the only copy was the one the
// renderer had pushed locally.
function handleAttachment(ctx: TranscriptCtx, m: Record<string, unknown>): void {
  const a = m.attachment as { type?: string; prompt?: string } | undefined
  if (a?.type !== 'queued_command' || typeof a.prompt !== 'string' || !a.prompt.trim()) return
  // `at` is the line's own timestamp — when it was TYPED, not when the turn got
  // round to it. It also must not move `turnStartedAt`: a steer joins the turn
  // in flight rather than starting one.
  const at = lineAt(m)
  const prompt = a.prompt.trim()
  // A task that finishes while the turn is running is QUEUED, and the queued
  // copy is the ONLY one the transcript keeps — no `user` line ever follows it.
  // Reloading it verbatim pasted the notification into the chat under your nick;
  // it still has to close the row it belongs to.
  if (isTaskNotification(prompt)) {
    closeAgentRows(ctx.items, ctx.agentRows, parseTaskNotifications(prompt), at)
    return
  }
  ctx.items.push({ role: 'user', text: prompt, at })
}

// A whole message written as one string rather than as blocks.
function pushStringContent(
  ctx: TranscriptCtx,
  role: 'user' | 'assistant',
  content: string,
  at: number | undefined
): void {
  // An async agent finishing: the CLI injects the notification as a user
  // message, and its <result> is the agent's report — the only copy of it.
  // Everything else about the notification is plumbing (see expandUserText,
  // which drops it).
  const notices = role === 'user' && isTaskNotification(content) ? parseTaskNotifications(content) : []
  if (closeAgentRows(ctx.items, ctx.agentRows, notices, at)) return // the rows spoke for themselves
  if (role === 'user') ctx.items.push(...expandUserText(content))
  else if (content.trim()) ctx.items.push({ role, text: content })
}

// The base64 payload of an `image` block, in the shape the transcript renders.
function base64Image(source: unknown): TranscriptItem | undefined {
  const src = source as { type?: string; media_type?: string; data?: string } | undefined
  if (src?.type !== 'base64' || typeof src.data !== 'string' || !src.data) return undefined
  return { role: 'image', mediaType: src.media_type ?? 'image/png', data: src.data }
}

function pushTextBlock(ctx: TranscriptCtx, block: Record<string, unknown>, role: 'user' | 'assistant'): void {
  const text = block.text
  if (typeof text !== 'string' || !text.trim()) return
  if (role === 'user') ctx.items.push(...expandUserText(text))
  else ctx.items.push({ role, text })
}

// A Task/Agent call rebuilds as the subagent's own line in the channel, the same
// shape the live stream pushes — so a reopened chat still shows who was called
// and what for. What cannot come back is the live part (tokens, the tool it was
// on): those existed only while it ran.
function openAgentRow(ctx: TranscriptCtx, block: Record<string, unknown>, at: number | undefined): void {
  const id = block.id as string
  const input = (block.input ?? {}) as Record<string, unknown>
  ctx.agentRows.set(id, ctx.items.length)
  ctx.items.push({
    role: 'subagent',
    toolUseId: id,
    agentType: typeof input.subagent_type === 'string' ? input.subagent_type : 'agent',
    summary: typeof input.description === 'string' ? input.description : '',
    harness: 'claude',
    // Still open until its tool_result shows up below. A session that was killed
    // mid-Task keeps a running row, which is the truth: it never finished.
    running: true,
    at
  })
}

function pushToolUse(ctx: TranscriptCtx, block: Record<string, unknown>, at: number | undefined): void {
  // A present_decision call rebuilds as the inline artifact panel (not a tool
  // row), mirroring the live stream — so reload round-trips it.
  if (block.name === 'mcp__floe__present_decision') {
    // Same injection as the live stream (agent.ts): the tool input has no `type`
    // field — the tool name is the discriminant.
    const spec = parseArtifactSpec({ type: 'decision', ...(block.input as Record<string, unknown>) })
    if (spec) {
      ctx.items.push({ role: 'artifact', spec })
      return
    }
  }
  // A question round-trips as the conversation it was: the questions as the
  // model's line, the tool_result (the user's answer) as theirs.
  if (block.name === 'AskUserQuestion') {
    const text = questionText(block.input)
    if (text) {
      if (typeof block.id === 'string') ctx.askIds.add(block.id)
      ctx.items.push({ role: 'assistant', text })
      return
    }
  }
  if ((block.name === 'Task' || block.name === 'Agent') && typeof block.id === 'string') {
    openAgentRow(ctx, block, at)
    return
  }
  ctx.items.push({ role: 'tool', name: String(block.name ?? 'tool'), summary: summarizeTool(block.input) })
}

// The tool_result of a Task/Agent call: it closes the row that call opened.
function closeAgentRowFromResult(
  ctx: TranscriptCtx,
  block: Record<string, unknown>,
  id: string,
  at: number | undefined
): void {
  const row = ctx.items[ctx.agentRows.get(id) as number]
  const reply = resultText(block.content)
  // An async agent answers this call immediately with a launch ack and keeps
  // working: the row stays open, and its real report arrives later as a
  // <task-notification> (handled elsewhere, by the same id).
  if (isAsyncLaunchAck(reply)) return
  // A result the harness marked as an error is the tool failing, not the agent
  // talking: the row closes, but nothing is said in its name.
  const spoke = block.is_error !== true
  row.running = false
  if (at && row.at && at >= row.at) row.ms = at - row.at
  ctx.agentRows.delete(id)
  // What it came back to say, as its own line in the channel — the same shape
  // the live stream pushes.
  if (reply && spoke) ctx.items.push(agentReply(row, reply))
}

function pushToolResult(ctx: TranscriptCtx, block: Record<string, unknown>, at: number | undefined): void {
  const id = block.tool_use_id
  if (typeof id === 'string' && ctx.askIds.has(id)) {
    const text = resultText(block.content)
    if (text) ctx.items.push({ role: 'user', text })
    return
  }
  if (typeof id === 'string' && ctx.agentRows.has(id)) {
    closeAgentRowFromResult(ctx, block, id, at)
    return
  }
  // Images returned by a tool (e.g. Read of a PNG) — show what Claude saw.
  if (!Array.isArray(block.content)) return
  for (const part of block.content as Array<Record<string, unknown>>) {
    if (part.type !== 'image') continue
    const img = base64Image(part.source)
    if (img) ctx.items.push(img)
  }
}

function pushBlock(
  ctx: TranscriptCtx,
  block: Record<string, unknown>,
  role: 'user' | 'assistant',
  at: number | undefined,
  attached: TranscriptItem[]
): void {
  if (block.type === 'text') return pushTextBlock(ctx, block, role)
  if (block.type === 'tool_use') return pushToolUse(ctx, block, at)
  if (block.type === 'tool_result') return pushToolResult(ctx, block, at)
  // An image you attached, echoed back into the JSONL by the CLI. Without this
  // it reloads as a bare "image 01" pointing at nothing.
  if (block.type !== 'image' || role !== 'user') return
  const img = base64Image(block.source)
  if (img) attached.push(img)
}

function pushBlocks(
  ctx: TranscriptCtx,
  content: unknown[],
  role: 'user' | 'assistant',
  at: number | undefined
): void {
  // Images you attached ride in the same message as the text, but ahead of it
  // (see buildContent in agent.ts). Held back and appended after the blocks so a
  // reopened chat shows what the live stream showed: your line, then the
  // thumbnails under it — instead of the picture floating above the sentence.
  const attached: TranscriptItem[] = []
  for (const block of content as Array<Record<string, unknown>>) pushBlock(ctx, block, role, at, attached)
  ctx.items.push(...attached)
}

export function loadClaudeTranscript(worktreePath: string, sessionId: string): TranscriptItem[] {
  const file = join(projectsDir(), encode(worktreePath), `${sessionId}.jsonl`)
  if (!existsSync(file)) return []
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const ctx: TranscriptCtx = { items: [], askIds: new Set<string>(), agentRows: new Map<string, number>() }
  // When the turn being read started, so an assistant message can carry how long
  // it took.
  let turnStartedAt: number | undefined
  for (const line of raw.split('\n')) {
    const m = parseLine(line)
    if (!m) continue
    if (m.type === 'attachment') {
      handleAttachment(ctx, m)
      continue
    }
    if (m.type !== 'user' && m.type !== 'assistant') continue
    // A subagent's own steps are written into the SAME file, flagged as a
    // sidechain. They are the child's transcript, not the parent's: replaying
    // them here would paste another agent's whole session into this one.
    if (m.isSidechain === true) continue
    const role = m.type as 'user' | 'assistant'
    const meta = readLineMeta(m, role)
    const content = (m.message as { content?: unknown } | null)?.content
    if (startsTurn(role, meta.at, content)) turnStartedAt = meta.at
    const ms = turnMs(role, meta.at, turnStartedAt)
    const before = ctx.items.length
    if (typeof content === 'string') pushStringContent(ctx, role, content, meta.at)
    else if (Array.isArray(content)) pushBlocks(ctx, content, role, meta.at)
    else continue
    stampItems(ctx.items, before, meta, ms)
  }
  return ctx.items
}
