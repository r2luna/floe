import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { collapseFloe, type TranscriptItem } from './claudeSessions'

// The conversation, for runtimes that keep none.
//
// Claude writes its own JSONL and Floe just reads it. Codex writes rollouts
// it will not let us resume by our own id, and gemini, opencode and LM Studio
// write nothing at all — so a session answered by any of them looked empty the
// moment you reopened it. This is the missing half: one line per message, in
// the app's own directory, keyed by the session it belongs to.
//
// Same file format as Claude's, one JSON object per line, appended: a crash
// mid-write costs the last line and nothing before it.
//
// ponytail: no pruning. A line is a few hundred bytes and a session is finite;
// when this needs a cap it wants the same treatment as the lane's snapshots.

const dir = (): string => {
  const path = join(app.getPath('userData'), 'runtime-transcripts')
  mkdirSync(path, { recursive: true })
  return path
}

/** One session's log. The id is Floe's own, which is what the panel has. */
const fileFor = (sessionId: string): string =>
  join(dir(), `${sessionId.replace(/[^\w.-]/g, '_')}.jsonl`)

export function logTurn(sessionId: string, item: TranscriptItem): void {
  if (!sessionId) return
  try {
    appendFileSync(fileFor(sessionId), JSON.stringify({ ...item, at: item.at ?? Date.now() }) + '\n')
  } catch {
    // A transcript that cannot be written is not worth failing a turn over —
    // the answer is already on screen.
  }
}

/**
 * Throw one conversation's log away.
 *
 * Discarding a query means the chat never sees a word of it — so leaving the
 * file behind would keep every thrown-away conversation on disk forever, each
 * one unreachable from the app that wrote it. The only caller is a discard, and
 * a discard is the one action that says "this did not happen".
 */
export function dropRuntimeTranscript(sessionId: string): void {
  if (!sessionId) return
  try {
    rmSync(fileFor(sessionId), { force: true })
  } catch {
    // Nothing to lose: the log is a convenience, and one that will not delete
    // is not worth failing the discard over.
  }
}

export function readRuntimeTranscript(sessionId: string): TranscriptItem[] {
  try {
    return readFileSync(fileFor(sessionId), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as TranscriptItem
        } catch {
          return null
        }
      })
      .filter((i): i is TranscriptItem => !!i)
      // Same collapse the Claude transcript does: the log holds what the model
      // was sent, and a skill went in full, a `#session` as an address. What you
      // typed was one token.
      .map((i) => (i.role === 'user' && i.text ? { ...i, text: collapseFloe(i.text) } : i))
  } catch {
    return []
  }
}
