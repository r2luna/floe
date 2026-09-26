import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ACTIVE_WINDOW_MS, type TranscriptItem } from './claudeSessions'
import { stripPremise } from '../shared/premise'

// Codex's own history, read so `/resume` can pull a codex conversation into a
// chat the way Claude's JSONL already can.
//
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl
//
// The first line is `session_meta` (thread id, cwd, who started it). What was
// SAID is the `item_completed` events carrying a UserMessage or AgentMessage —
// the lines the TUI itself draws. The `response_item` lines beside them are the
// model's input, full of developer prompts and injected context nobody typed.

const SESSIONS = (): string => join(homedir(), '.codex', 'sessions')

/** Enough of the head for `session_meta`'s cwd, which sits before its big instructions. */
const HEAD_BYTES = 16_384

/** How far into a rollout to look for its first message before giving up on a title. */
const TITLE_SCAN_BYTES = 8 * 1024 * 1024

/** Probes Floe and Rookery run to check codex is alive — never a conversation. */
const PROBES = new Set(['floe-probe', 'rookery-probe'])

export interface CodexRollout {
  threadId: string
  file: string
  title: string
  mtime: number
  active: boolean
}

/** Every rollout file under ~/.codex/sessions, oldest day first. */
function rolloutFiles(root = SESSIONS()): string[] {
  const dirs = (p: string): string[] => {
    try {
      return readdirSync(p, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(p, d.name))
    } catch {
      return []
    }
  }
  const out: string[] = []
  for (const day of dirs(root).flatMap(dirs).flatMap(dirs)) {
    try {
      for (const name of readdirSync(day)) if (name.endsWith('.jsonl')) out.push(join(day, name))
    } catch {
      // A day directory that vanished mid-walk has nothing to offer.
    }
  }
  return out
}

function readHead(file: string, bytes: number): string {
  const buf = Buffer.alloc(bytes)
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    return buf.toString('utf8', 0, readSync(fd, buf, 0, bytes, 0))
  } catch {
    return ''
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

interface RolloutMeta {
  threadId: string
  cwd: string
  /** A subagent spawned inside another thread: its parent is the conversation. */
  subagent: boolean
  originator: string
}

/**
 * The thread id, cwd and origin, read off the head with regexes: the first line
 * carries the whole base prompt and is routinely longer than any head worth
 * reading, so it cannot be parsed as JSON.
 */
export function rolloutMeta(head: string): RolloutMeta | null {
  const first = head.slice(0, head.indexOf('\n') >= 0 ? head.indexOf('\n') : head.length)
  if (!first.includes('"session_meta"')) return null
  const str = (key: string): string | undefined => {
    const m = new RegExp(`"${key}":("(?:[^"\\\\]|\\\\.)*")`).exec(first)
    if (!m) return undefined
    try {
      return JSON.parse(m[1]) as string
    } catch {
      return undefined
    }
  }
  const threadId = str('id')
  const cwd = str('cwd')
  if (!threadId || !cwd) return null
  return {
    threadId,
    cwd,
    subagent: /"source":\{"subagent"/.test(first),
    originator: str('originator') ?? ''
  }
}

/** Floe's own framing — house rules, the worktree premise — is not something anyone said. */
function stripFloeBlocks(text: string): string {
  return stripPremise(text.replace(/<!-- floe:([\w-]+)(?::v\d+)? -->[\s\S]*?<!-- \/floe:\1(?::v\d+)? -->/g, '')).trim()
}

/** One `item_completed` line as a transcript message, or null for anything else. */
export function rolloutMessage(line: string): TranscriptItem | null {
  if (!line.includes('"item_completed"')) return null
  let m: { timestamp?: string; payload?: { type?: string; item?: { type?: string; content?: unknown } } }
  try {
    m = JSON.parse(line)
  } catch {
    return null
  }
  const item = m.payload?.type === 'item_completed' ? m.payload.item : undefined
  const role = item?.type === 'UserMessage' ? 'user' : item?.type === 'AgentMessage' ? 'assistant' : null
  if (!role || !Array.isArray(item?.content)) return null
  const raw = item.content
    .map((b) => (b && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
    .filter(Boolean)
    .join('\n')
  const text = stripFloeBlocks(raw)
  if (!text) return null
  const at = m.timestamp ? Date.parse(m.timestamp) : undefined
  return {
    role,
    text,
    ...(Number.isFinite(at) ? { at } : {}),
    ...(role === 'assistant' ? { provider: 'codex' } : {})
  }
}

/** The first thing the user said, scanning in chunks so a long rollout is not read whole. */
function firstUserText(file: string): string {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(262_144)
    let pos = 0
    let rest = ''
    while (pos < TITLE_SCAN_BYTES) {
      const n = readSync(fd, buf, 0, buf.length, pos)
      if (n <= 0) break
      pos += n
      const lines = (rest + buf.toString('utf8', 0, n)).split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.includes('"UserMessage"')) continue
        const msg = rolloutMessage(line)
        if (msg?.role === 'user' && msg.text) return msg.text
      }
    }
    return ''
  } catch {
    return ''
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function titleOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 72)
}

/**
 * Every codex conversation started in this worktree, newest first, minus the
 * threads Floe already holds. A rollout nobody spoke in (a probe, a subagent, a
 * thread that died before its first message) is left out — there is nothing to
 * bring back.
 */
export function listCodexRollouts(worktreePath: string, adopted: Set<string>, root?: string): CodexRollout[] {
  const now = Date.now()
  const out: CodexRollout[] = []
  for (const file of rolloutFiles(root)) {
    const meta = rolloutMeta(readHead(file, HEAD_BYTES))
    if (!meta || meta.cwd !== worktreePath || meta.subagent || PROBES.has(meta.originator)) continue
    if (adopted.has(meta.threadId)) continue
    let mtime: number
    try {
      mtime = statSync(file).mtimeMs
    } catch {
      continue
    }
    const title = titleOf(firstUserText(file))
    if (!title) continue
    out.push({ threadId: meta.threadId, file, title, mtime, active: now - mtime < ACTIVE_WINDOW_MS })
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

/** The rollout for one thread, when it belongs to this worktree. */
export function findCodexRollout(worktreePath: string, threadId: string, root?: string): string | undefined {
  // The file name ends in the thread id, so only one head is ever read.
  return rolloutFiles(root)
    .filter((f) => f.endsWith(`-${threadId}.jsonl`))
    .find((f) => rolloutMeta(readHead(f, HEAD_BYTES))?.cwd === worktreePath)
}

/** What was said in a rollout, in order. */
export function loadCodexRollout(file: string): TranscriptItem[] {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  return raw
    .split('\n')
    .map(rolloutMessage)
    .filter((i): i is TranscriptItem => !!i)
}
