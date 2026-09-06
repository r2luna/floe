// Who a conversation IS, whichever registry holds it.
//
// A key that reaches the agent is a *conversation*, not necessarily a session:
// the panel's key, Floe's own id, the id the CLI minted, or one it has since
// forked away from. Five places used to resolve that themselves — the resume on
// spawn, the replay's names, the conn behind a stop/answer/permission, the
// alias keys a settled prompt is pruned under, and the transcript reader — each
// reaching into `getCreatedSession` on its own and each getting `undefined` for
// anything that is not a session in the store.
//
// That was fine while sessions were the only conversations. It stops being fine
// the moment a second registry holds one (queries — see queries.ts): a lookup
// that only knows the session table degrades in SILENCE. Stop finds no conn,
// answer finds no conn, replay finds no transcript, and nothing anywhere says
// why. So the resolution lives here, once, and every one of those five asks it.
//
// It deliberately resolves IDS ONLY, never the record behind them. A query is
// opened from a session, and handing back the parent's `CreatedSession` would
// make the parent's `spawnedBy` apply to the query — which is exactly what
// makes the child auto-answerer swallow a query's questions (agent.ts). Names
// travel; the record does not.

import {
  findQuery,
  getCreatedSession,
  getCreatedSessionClaudeId,
  linkCreatedSession,
  linkQueryClaudeId
} from './sessionStore'
import { isQueryKey } from '../shared/queries'

/** Every id one conversation answers to, and the one to `--resume`. */
export interface AgentIdentity {
  /** Floe's own id for it, when the registry has one. */
  id?: string
  /** The CLI's current session id, once a turn has linked one. */
  claudeId?: string
  /** Ids it used to have — `claude --resume` forks a new one every respawn. */
  pastClaudeIds: string[]
}

/**
 * The identity behind a key: a session first, then a query.
 *
 * Sessions first because they are the common case and the older one — a key
 * that is both would be a bug in whoever minted it, and reading it as the
 * session is the reading that preserves today's behaviour.
 */
export function resolveAgentIdentity(key: string): AgentIdentity | undefined {
  const session = getCreatedSession(key)
  if (session)
    return {
      id: session.id,
      claudeId: session.claudeId,
      pastClaudeIds: session.pastClaudeIds ?? []
    }
  const query = findQuery(key)
  if (query)
    return { id: query.id, claudeId: query.claudeId, pastClaudeIds: query.pastClaudeIds ?? [] }
  return undefined
}

/**
 * Every name this conversation is known by, the key included.
 *
 * The key comes first and is always present: a conversation no registry holds
 * yet — a brand-new panel whose first turn has not landed — still answers to
 * the name it was opened with.
 */
export function agentIdentityNames(key: string): string[] {
  const found = resolveAgentIdentity(key)
  const names = new Set([key])
  if (found) for (const n of [found.id, found.claudeId, ...found.pastClaudeIds]) if (n) names.add(n)
  return [...names]
}

/** The CLI session id to `--resume` into, if this conversation has one. */
export function agentResumeId(key: string): string | undefined {
  return resolveAgentIdentity(key)?.claudeId
}

/** Record the id the CLI just reported, in whichever registry holds this key. */
export function linkAgentIdentity(key: string, claudeId: string): void {
  // The key shape decides, not a failed lookup: a query's FIRST turn is exactly
  // when there is nothing to find, and writing that id into the session table
  // would give the parent the child's history.
  if (isQueryKey(key)) linkQueryClaudeId(key, claudeId)
  else linkCreatedSession(key, claudeId)
}

// Kept so the store's own callers (and its tests) keep the name they had. The
// session-only lookup is the primitive this file is built on, not a rival to
// it — anything that runs on an agent key should ask `agentResumeId` instead.
export { getCreatedSessionClaudeId }
