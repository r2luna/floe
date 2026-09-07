import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentEventEnvelope } from '../../shared/types'
import type { ClaudeSessionMeta } from '../../main/claudeSessions'
import { isQueryKey } from '../../shared/queries.ts'

/** One lane in the dock: a session this chat set running, as it is right now. */
export interface Subagent {
  /** The renderer's session key — what a panel is opened under. */
  key: string
  /** Floe's own id, for the row's identity across a rename. */
  id: string
  title: string
  worktreePath: string
  /** A turn is in flight. A lane that is not working is not in the dock at all. */
  running: boolean
  /** What it is on right now, from its last `tool` event. */
  tool?: string
  /** When the current turn started — the row's clock. */
  since: number
}

/** Every id a session answers to, the same pair the sidebar matches on. */
function namesOf(s: ClaudeSessionMeta): string[] {
  return s.claudeId && s.claudeId !== s.id ? [s.id, s.claudeId] : [s.id]
}

/**
 * The subagents this chat has working, live.
 *
 * Deliberately its own subscription rather than a field on `useSessionActivity`.
 * That hook owns the unread marks and persists them, and a second instance of it
 * would be a second writer to one localStorage key with a different idea of
 * which session is open. What the dock needs is smaller and keeps nothing: who
 * is working, on what, since when.
 *
 * The list of children is re-read from disk rather than kept in memory, because
 * a lane can be added by an agent (`create_session`) or removed by itself
 * (main/spawned.ts) with no user action in between — the same two events the
 * sidebar reloads on.
 */
export function useSubagents(parent?: { id: string; worktreePath: string }): Subagent[] {
  const [kids, setKids] = useState<ClaudeSessionMeta[]>([])
  const [live, setLive] = useState<Map<string, { tool?: string; at: number }>>(() => new Map())

  const parentId = parent?.id
  const worktreePath = parent?.worktreePath

  // Who this chat's children are. `spawnedBy` holds whichever id the parent
  // called MCP in with, so a row matches on either of the open session's names —
  // and the open session is identified here by the one the panel is keyed by,
  // which is why the list itself has to resolve the other.
  useEffect(() => {
    if (!parentId || !worktreePath) {
      setKids([])
      return
    }
    let alive = true
    const load = (): void => {
      void window.floe.claude
        .sessions(worktreePath)
        .catch(() => [] as ClaudeSessionMeta[])
        .then((all) => {
          if (!alive) return
          const me = all.find((s) => namesOf(s).includes(parentId))
          const mine = new Set(me ? namesOf(me) : [parentId])
          setKids(all.filter((s) => s.spawnedBy && mine.has(s.spawnedBy)))
        })
    }
    load()
    // A lane appearing and a lane closing itself are both invisible to this
    // panel otherwise: neither is a turn of the chat's own.
    const offChanged = window.floe.claude.onSessionsChanged(load)
    const timer = setInterval(load, 5_000)
    return () => {
      alive = false
      clearInterval(timer)
      offChanged()
    }
  }, [parentId, worktreePath])

  // What each of them is doing. Only tool calls move the row, so a lane
  // streaming a long answer does not re-render the dock on every token; the
  // turn's start is carried across tools so the clock does not restart.
  const seen = useRef(new Set<string>())
  seen.current = useMemo(() => new Set(kids.flatMap(namesOf)), [kids])
  useEffect(
    () =>
      window.floe.agent.onEvent(({ key, event }: AgentEventEnvelope) => {
        if (isQueryKey(key) || !seen.current.has(key)) return
        const done = event.kind === 'done' || event.kind === 'error'
        setLive((prev) => {
          if (done) {
            if (!prev.has(key)) return prev
            const next = new Map(prev)
            next.delete(key)
            return next
          }
          const was = prev.get(key)
          const tool = event.kind === 'tool' ? event.name : was?.tool
          if (was && was.tool === tool) return prev
          return new Map(prev).set(key, { tool, at: was?.at ?? Date.now() })
        })
      }),
    []
  )

  return useMemo(
    () =>
      kids
        .map((s): Subagent => {
          const key = s.claudeId ?? s.id
          const at = namesOf(s)
            .map((n) => live.get(n))
            .find(Boolean)
          return {
            key,
            id: s.id,
            title: s.title,
            worktreePath: worktreePath ?? '',
            running: !!at,
            tool: at?.tool,
            since: at?.at ?? s.mtime
          }
        })
        // Only what is moving. A lane that finished reports to this very chat
        // and closes itself a minute later (main/spawned.ts) — listing it as a
        // dead row in between would be the dock disagreeing with the message
        // sitting right above it.
        .filter((s) => s.running)
        // Longest-running first: the one you are waiting on is the one that has
        // been at it the longest, and a list that reorders as tools change is
        // unclickable.
        .sort((a, b) => a.since - b.since),
    [kids, live, worktreePath]
  )
}

/**
 * Fold or unfold the subagent dock, from anywhere.
 *
 * A module event rather than a prop or a keydown handler in the dock, for the
 * rule at the top of commands.ts: a key resolves to a command id, and the
 * command is what does the work. The dock listens; `subagents.toggle` fires.
 * That is also what makes it reachable from the palette and from an agent over
 * `run_command`, which a keydown in the component never would be.
 */
export const DOCK_TOGGLE = 'floe:subagent-dock-toggle'

export function toggleSubagentDock(): void {
  window.dispatchEvent(new CustomEvent(DOCK_TOGGLE))
}
