// A subagent session reports to the chat that opened it, then closes itself.
//
// `create_session` records the caller on `spawnedBy` (mcpServer.ts), so Floe
// already knows which sessions are somebody's work rather than somebody's
// conversation. What it did NOT know is when that work is over: a lane ran its
// turn, went quiet, and sat in the sidebar forever. Sixteen of those is what a
// fan-out actually looks like on screen.
//
// So: when a spawned session goes idle, its final text is spoken into the
// parent's chat under its own nick and the row is closed. The transcript stays
// on disk (closeSession is non-destructive) — it simply stops being a session
// you have to look at.
//
// It lives in main, and is armed from turn.ts, for the same reason relay.ts is:
// a lane finishing is not something that may only happen while you are looking
// at it. Same file, same shape — arm on the turn, act on `onceTurnDone`.

import type { BrowserWindow } from 'electron'
import { onceTurnDone, sendAgentEvent } from './agent'
import {
  closeSession,
  getAllCreatedSessions,
  getCreatedSession,
  type CreatedSession
} from './sessionStore'
import { log } from './log'

/**
 * How long a spawned session must stay quiet before it is considered finished.
 *
 * A turn ending is not the work ending. The flow the block-native-agents hook
 * steers to is `create_session` → `send_message(wait)` → read the answer → ask
 * again, and closing on the first `done` would delete the lane out from under
 * the second message. So the close is armed on idle and cancelled by any new
 * turn: a lane lives exactly as long as its parent keeps talking to it, and a
 * one-shot lane (the common case — `create_session` with a prompt) is gone a
 * minute after it answers.
 *
 * Also the grace `send_message(wait)` needs: that call resolves off the same
 * `done` this arms on, and a session closed in the same tick would have it
 * reading a store record that no longer exists.
 */
const IDLE_MS = 60_000

/** Pending closes, by session key — so a new turn can call one off. */
const timers = new Map<string, ReturnType<typeof setTimeout>>()

/** The last thing each spawned session said, held until its close fires. */
const reports = new Map<string, string>()

/** Every id a session answers to, the same set sessionStore matches on. */
function namesOf(s: CreatedSession): string[] {
  return [s.id, s.claudeId, ...(s.pastClaudeIds ?? [])].filter((k): k is string => !!k)
}

/**
 * The parent's key: whichever of its ids the renderer has a panel under.
 *
 * `spawnedBy` holds the token the parent called MCP in with, which is only one
 * of its two names — and not necessarily the one its chat is keyed by. Sending
 * the report to the wrong one puts it in a panel nobody is looking at.
 */
function parentKeys(child: CreatedSession): string[] {
  if (!child.spawnedBy) return []
  const all = getAllCreatedSessions()
  const parent = all.find((s) => namesOf(s).includes(child.spawnedBy as string))
  return parent ? namesOf(parent) : [child.spawnedBy]
}

/** Cancel a pending close: this session is working again. */
export function cancelSpawnedClose(key: string): void {
  const t = timers.get(key)
  if (!t) return
  clearTimeout(t)
  timers.delete(key)
}

/**
 * Watch this turn, if it belongs to a subagent.
 *
 * Armed from startTurn for every turn, and a no-op for the sessions a person
 * actually talks to — which is the only test that matters here, and one only
 * the store can answer.
 */
export function armSpawnedClose(win: BrowserWindow, key: string): void {
  const child = getCreatedSession(key)
  if (!child?.spawnedBy) return
  // Working again: whatever close was pending is now wrong.
  cancelSpawnedClose(key)

  onceTurnDone(key, (text) => {
    // Nothing came back — stopped, crashed, or a harness that never started.
    // The row stays: a lane that produced no answer is exactly the one you
    // want to still be able to open.
    if (!text.trim()) return
    reports.set(key, text.trim())
    cancelSpawnedClose(key)
    const timer = setTimeout(() => {
      timers.delete(key)
      closeSpawned(win, key)
    }, IDLE_MS)
    timer.unref?.()
    timers.set(key, timer)
  })
}

/**
 * Hand the work back and take the row off the screen.
 *
 * The report is a `peer` message, not a prompt: it lands in the parent's
 * transcript under the lane's own nick, where the parent reads it on its next
 * turn. A prompt would start a turn in a chat that is very likely already
 * mid-`send_message(wait)` on this same lane — two turns in one session is the
 * one thing the queue exists to prevent (see relay.ts).
 */
function closeSpawned(win: BrowserWindow, key: string): void {
  const child = getCreatedSession(key)
  const text = reports.get(key)
  reports.delete(key)
  if (!child || !text) return
  const from = child.title || 'subagent'
  for (const parent of parentKeys(child)) {
    sendAgentEvent(win, parent, { kind: 'peer', from, text })
  }
  log('spawned-closed', { key, parent: child.spawnedBy, chars: text.length })
  closeSession({ id: child.id, worktreePath: child.worktreePath, claudeId: child.claudeId })
  // The sidebar is rebuilt from disk, and nothing else would tell it the row is
  // gone: the reload it already does runs 500ms after `done`, a minute before
  // this fires.
  win.webContents.send('sessions:changed')
}

/** Test seam — the idle window, so a test does not have to wait a minute. */
export const __idleMs = IDLE_MS
