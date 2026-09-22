// Closing a session, all the way down.
//
// Lived in index.ts until the MCP server needed the same call (`close_session`),
// and index.ts imports the MCP server — so the shared half moved here rather
// than being written twice and drifting.

import type { BrowserWindow } from 'electron'
import { closeSession } from './sessionStore'
import { stopAgentFor } from './agent'
import { forgetQueriesOf } from './queries'
import { forgetThread } from './runtimes'
import { forgetSeen } from './handoff'

export type CloseSessionOptions = { id: string; worktreePath: string; claudeId?: string }

// Its side conversations go first, while the store still says they exist:
// `closeSession` drops the records, and after that there is nothing left to find
// the running conns, threads and watermarks by. Each one is stopped and
// forgotten outright — a query whose session is gone has no panel to reopen it
// in and no chat to merge it into.
export function closeSessionFully(win: BrowserWindow | null, opts: CloseSessionOptions): void {
  forgetQueriesOf(win, opts.id)
  // Local-runtime chats (lmstudio/ollama/opencode) keep their whole message
  // history in memory, keyed by the session key the renderer used — either id. A
  // closed session's history is unreachable, so drop it here. And with the
  // thread goes the record of how much of the conversation each harness was
  // holding — the two are the same fact from opposite ends.
  for (const key of sessionKeys(opts)) {
    // The process first: the record is what everything else finds the conn
    // by, and a child left running after it is gone is invisible to every
    // sweep — it just sits there, 400 MB and its MCP connections, until the
    // app quits.
    stopAgentFor(key)
    forgetThread(key)
    forgetSeen(key)
  }
  closeSession(opts)
}

/** Both names a session answers to — the created id and Claude's own. */
export function sessionKeys(opts: CloseSessionOptions): string[] {
  return opts.claudeId ? [opts.id, opts.claudeId] : [opts.id]
}
