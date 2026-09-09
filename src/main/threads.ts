import {
  clearSessionThreads,
  getCreatedSession,
  getSessionThread,
  setSessionThread
} from './sessionStore'

// Where a harness's conversation id lives between turns.
//
// Claude never needed this: it writes its own JSONL and Floe stores the
// `claudeId` beside the session, so `--resume` picks the thread back up after a
// restart. Every other harness minted an id we kept in a Map — codex's thread,
// opencode's session — and a Map dies with the process. Quit Floe, come back,
// and codex answered your next message having read none of the conversation it
// still had on disk.
//
// Two homes, one door:
//
//   a real session  → sessions.json, beside the claudeId (survives a restart)
//   anything else   → memory (a query key names no created session, and a
//                     query is closed by the same restart anyway)
//
// The key is whatever the caller holds — a Floe id, a claudeId, a query key —
// because that is what the runtimes have; `getCreatedSession` resolves the
// first two to one record, so a session that forked its claudeId keeps one
// thread rather than growing a second.

const memory = new Map<string, string>()

const memKey = (key: string, harness: string): string => `${key} ${harness}`

/** The id this harness last used for this conversation, if we know one. */
export function threadFor(key: string, harness: string): string | undefined {
  const session = getCreatedSession(key)
  if (session) return getSessionThread(session.id, harness)
  return memory.get(memKey(key, harness))
}

/** Write down the id a harness just minted (or re-confirmed). */
export function rememberThread(key: string, harness: string, threadId: string): void {
  if (!threadId) return
  const session = getCreatedSession(key)
  if (session) setSessionThread(session.id, harness, threadId)
  else memory.set(memKey(key, harness), threadId)
}

/**
 * Drop what we hold for this conversation — one harness, or all of them.
 *
 * Called when the thread is known to be gone (a resume the harness refused) or
 * deliberately abandoned (a new topic, a closed query). Not on a plain session
 * close: reopening a session should still be the same conversation.
 */
export function forgetThreads(key: string, harness?: string): void {
  const session = getCreatedSession(key)
  if (session) {
    clearSessionThreads(session.id, harness)
    return
  }
  if (harness) memory.delete(memKey(key, harness))
  else for (const k of memory.keys()) if (k.startsWith(`${key} `)) memory.delete(k)
}
