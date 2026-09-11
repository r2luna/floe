// The cross-project session index: what every panel that looks at MORE than the
// open project reads — the projects rail's activity glyphs, the `active` panel's
// list of recent sessions, and the sessions blocked on an answer.
//
// Its own module rather than index.ts's, because mcpServer.ts serves the same
// reads to agents and index.ts imports mcpServer — one of these two directions
// has to not be a cycle, and this is the one with no Electron in it.
import { listWorktrees, worktreeDiffStat } from './git'
import { listProjects } from './projects'
import {
  ACTIVE_WINDOW_MS,
  computeProjectActivity,
  listClaudeSessions,
  sessionHasUnansweredQuestion
} from './claudeSessions'
import { anyActiveTurn, isClaudeIdConnected, waitingKeys } from './agent'
import type {
  ActiveSession,
  JumpSession,
  NeedsYouSession,
  ProjectActivity,
  Worktree
} from '../shared/types'

// The worktrees of a project that can run sessions. Home isn't a git repo and a
// read-only project never runs one, so both come back empty — as does a project
// whose repo has moved or been removed, which just leaves it off the rail.
async function sessionWorktrees(project: { path: string; readOnly?: boolean; home?: boolean }): Promise<Worktree[]> {
  if (project.readOnly || project.home) return []
  try {
    return await listWorktrees(project.path)
  } catch {
    return []
  }
}

// Projects rail: a cross-project activity snapshot for every project worked
// today (sessions touched since midnight), each with a single status glyph.
export async function projectsActivity(): Promise<ProjectActivity[]> {
  const out: ProjectActivity[] = []
  for (const project of listProjects()) {
    const worktrees = await sessionWorktrees(project)
    const activity = computeProjectActivity(worktrees.map((w) => w.path), isClaudeIdConnected)
    if (activity) out.push({ path: project.path, ...activity })
  }
  return out
}

// The sessions in one worktree that are blocked on an unanswered question.
export function waitingSessions(worktreePath: string): ReturnType<typeof listClaudeSessions> {
  return listClaudeSessions(worktreePath).filter(
    (s) =>
      s.claudeId &&
      (s.active || isClaudeIdConnected(s.claudeId)) &&
      sessionHasUnansweredQuestion(worktreePath, s.claudeId)
  )
}

// Every session, across ALL projects, currently blocked on an unanswered
// question — feeds the ⌘/ switcher's "NEEDS YOU" list and the Home strip. Same
// on-disk scan as projectsActivity, but per-session and with the worktree's diff
// stat attached. Only worktrees that actually have a waiting session pay for the
// (cheap) `git diff --shortstat`.
export async function needsYouSessions(): Promise<NeedsYouSession[]> {
  const out: NeedsYouSession[] = []
  for (const project of listProjects()) {
    for (const wt of await sessionWorktrees(project)) {
      const waiting = waitingSessions(wt.path)
      if (!waiting.length) continue
      const stat = await worktreeDiffStat(wt.path)
      for (const s of waiting) {
        out.push({
          projectPath: project.path,
          projectName: project.name,
          worktreePath: wt.path,
          branch: wt.branch,
          sessionId: s.id,
          title: s.title,
          lastActivityAt: s.mtime,
          additions: stat.additions,
          deletions: stat.deletions
        })
      }
    }
  }
  return out
}

// Every session on disk, across ALL projects — the ⌘J palette's index. Same walk
// as needsYouSessions, without the question filter or the diff stat, so the
// palette can pull it on open instead of paying for a poll.
export async function allSessions(): Promise<JumpSession[]> {
  const out: JumpSession[] = []
  for (const project of listProjects()) {
    for (const wt of await sessionWorktrees(project)) {
      for (const s of listClaudeSessions(wt.path)) {
        out.push({
          projectPath: project.path,
          projectName: project.name,
          worktreePath: wt.path,
          branch: wt.branch,
          sessionId: s.id,
          claudeId: s.claudeId,
          title: s.title,
          lastActivityAt: s.mtime,
          // A turn in flight — NOT "the child is alive", which a session that
          // answered an hour ago still is: the CLI child is kept for the next
          // --resume, so that read left every session it had ever run marked as
          // working until the process was reaped.
          running: anyActiveTurn([s.id, s.claudeId])
        })
      }
    }
  }
  return out
}

/**
 * Is this session blocked on the user?
 *
 * Two authorities, because neither sees the whole thing — the same split
 * `list_sessions` makes (mcpServer.ts): the live conn knows about a
 * tool-permission prompt, which never lands in the transcript at all, and the
 * transcript knows about a question raised before this app run.
 *
 * The liveness guard is computeProjectActivity's, for its reason: a CLI killed
 * while blocked on AskUserQuestion never writes the answering tool_result, so
 * the question sits unanswered at the tail forever. A session touched within the
 * active window is trusted even with no conn — the kill races the next poll.
 */
function sessionNeedsYou(s: JumpSession, waiting: ReadonlySet<string>): boolean {
  if (waiting.has(s.sessionId) || (s.claudeId && waiting.has(s.claudeId))) return true
  if (!s.claudeId) return false
  const live = Date.now() - s.lastActivityAt < ACTIVE_WINDOW_MS || isClaudeIdConnected(s.claudeId)
  return live && sessionHasUnansweredQuestion(s.worktreePath, s.claudeId)
}

/**
 * The `limit` most recently touched sessions on this machine, whatever project
 * they belong to — the `active` panel's slice of one backend.
 *
 * Sort first, enrich second, and deliberately so: `needsYou` reads each
 * session's JSONL off disk, which is fine for ten rows and too hot for a
 * store-wide walk (it is why `list_sessions` skips it when unfiltered). Ten of
 * them is ten reads no matter how many sessions the store holds.
 *
 * The panel unions several machines' answers and re-slices, which is correct
 * without any coordination: a machine's own top ten is always a superset of
 * whatever it contributes to the global top ten.
 */
export async function recentSessions(limit = 10): Promise<ActiveSession[]> {
  const waiting = new Set(waitingKeys())
  return (await allSessions())
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, Math.max(0, limit))
    .map((s) => ({ ...s, needsYou: sessionNeedsYou(s, waiting) }))
}
