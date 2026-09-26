import { listResumableSessions } from './claudeSessions'
import { findCodexRollout, listCodexRollouts, loadCodexRollout } from './codexSessions'
import { getCreatedSessions, resumeCodexSession, resumeSession } from './sessionStore'
import { logTurn } from './runtimeLog'

// `/resume`: a conversation a harness kept on its own disk, brought into Floe
// as a chat. Claude's JSONL is read in place, so adopting one is only a record.
// Codex's rollout is not something the chat reads, so its messages are copied
// into the runtime log once, and the thread id is kept so the next turn resumes
// that same thread rather than starting a stranger.
//
// ponytail: claude and codex only. opencode keeps its sessions in a SQLite
// database and gemini has no thread to resume — add them when someone needs to.

export type HistoryHarness = 'claude' | 'codex'

export interface HarnessSession {
  harness: HistoryHarness
  /** The harness's own id: Claude's session id, codex's thread id. */
  id: string
  title: string
  mtime: number
  active: boolean
}

/** Every conversation either harness has for this worktree and Floe does not, newest first. */
export function listHarnessSessions(worktreePath: string, codexRoot?: string): HarnessSession[] {
  const adoptedThreads = new Set(
    getCreatedSessions(worktreePath)
      .map((c) => c.threads?.codex)
      .filter((id): id is string => !!id)
  )
  const claude = listResumableSessions(worktreePath).map(
    (s): HarnessSession => ({ harness: 'claude', id: s.claudeId, title: s.title, mtime: s.mtime, active: s.active })
  )
  const codex = listCodexRollouts(worktreePath, adoptedThreads, codexRoot).map(
    (s): HarnessSession => ({ harness: 'codex', id: s.threadId, title: s.title, mtime: s.mtime, active: s.active })
  )
  return [...claude, ...codex].sort((a, b) => b.mtime - a.mtime)
}

/**
 * Adopt one of them as a Floe session. Returns its Floe id — the same one on a
 * second call, so picking twice opens the chat instead of cloning it.
 */
export function resumeHarnessSession(
  worktreePath: string,
  harness: HistoryHarness,
  id: string,
  codexRoot?: string
): { sessionId: string; title: string } {
  const found = listHarnessSessions(worktreePath, codexRoot).find((s) => s.harness === harness && s.id === id)
  if (harness === 'claude') {
    const existing = getCreatedSessions(worktreePath).find((c) => c.claudeId === id)
    if (existing) return { sessionId: existing.id, title: existing.title }
    if (!found) throw new Error(`No Claude session ${id} in ${worktreePath}.`)
    return { sessionId: resumeSession({ worktreePath, claudeId: id, title: found.title, mtime: found.mtime }), title: found.title }
  }
  const existing = getCreatedSessions(worktreePath).find((c) => c.threads?.codex === id)
  if (existing) return { sessionId: existing.id, title: existing.title }
  const file = found && findCodexRollout(worktreePath, id, codexRoot)
  if (!found || !file) throw new Error(`No codex thread ${id} in ${worktreePath}.`)
  const adopted = resumeCodexSession({ worktreePath, threadId: id, title: found.title, mtime: found.mtime })
  if (adopted.created) for (const item of loadCodexRollout(file)) logTurn(adopted.id, item)
  return { sessionId: adopted.id, title: found.title }
}
