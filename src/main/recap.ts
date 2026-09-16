/**
 * The recap, main's half: ask the CLI what happened, put one line in the chat.
 *
 * Claude Code already writes this summary — `/recap` is its own command, with
 * its own prompt, tuned by the people who ship it. Floe asks for that rather
 * than writing a competing summariser, so the sentence you read here is the
 * sentence the CLI would have greeted you with.
 *
 * `--fork-session` is what makes it safe to run behind your back. Without it,
 * `--resume` appends the `/recap` turn to the session's own transcript, and the
 * next real turn would open with Floe talking to itself in the model's context.
 * Forked, the CLI copies the history into a throwaway id and leaves the
 * original file untouched.
 *
 * The line itself is NOT written to any transcript — it goes out as an event
 * and nothing else. A recap answers "what did I miss", which is a question with
 * an expiry: once read it is the transcript's own first lines restated, and a
 * log that accumulated one of these per coffee break would be answering a
 * question nobody is asking any more. Come back again and you get a fresh one.
 *
 * When it fires is shared/recap.ts's decision, and the renderer's to ask for —
 * only the panel knows when you stopped looking.
 */
import { spawn } from 'node:child_process'
import type { BrowserWindow } from 'electron'
import { recapLine } from '../shared/recap'
import { sendAgentEvent } from './agent'
import { agentResumeId } from './identity'

/**
 * A recap that has not arrived in a minute is not worth having — you are
 * already reading the transcript yourself by then.
 */
const TIMEOUT_MS = 60_000

/** The name the Log heads the line with: `* recap (18m away) — …`. */
const NICK = 'recap'

export function recapArgs(resumeId: string): string[] {
  return [
    '-p',
    '--resume',
    resumeId,
    // The whole reason this is safe to run unasked — see the note above.
    '--fork-session',
    '--output-format',
    'stream-json',
    '--verbose',
    // A recap reads one transcript and writes one sentence. It has no business
    // touching the repo, and no MCP server has anything to add to it.
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}'
  ]
}

/**
 * The summary out of a stream-json run.
 *
 * The `result` line is the whole answer in one field, so there is nothing to
 * stitch together — but the stream carries init, hooks and tool lines around
 * it, and a line that fails to parse is normal (stderr interleaves).
 */
export function parseRecapResult(stdout: string): string {
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (!msg || typeof msg !== 'object') continue
    const record = msg as { type?: unknown; subtype?: unknown; result?: unknown }
    if (record.type !== 'result') continue
    // `subtype` is 'success' on an answer and an error kind otherwise, where
    // `result` holds the failure text — which is not a recap.
    if (record.subtype !== 'success') continue
    if (typeof record.result === 'string') return record.result
  }
  return ''
}

function runCli(worktreePath: string, resumeId: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('claude', recapArgs(resumeId), { cwd: worktreePath, env: process.env })
    let out = ''
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve('')
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve(out)
    })
    // The prompt is the command, and the CLI waits on stdin until it closes.
    child.stdin.end('/recap\n')
  })
}

/**
 * Ask for a recap of `key` and, if there is one, put it in the chat.
 *
 * Returns the line it wrote, or null — no claude session to resume, the CLI
 * failed, or it had nothing to say. Every one of those is a silent no: a recap
 * is a courtesy, and a courtesy that reports its own failure is worse than one
 * that does not arrive.
 */
export async function recapSession(
  win: BrowserWindow,
  key: string,
  worktreePath: string,
  awayMs: number
): Promise<string | null> {
  // No claude id means this chat has never run claude — a codex or gemini
  // session has no `/recap` to ask for, and gets none until it grows one.
  const resumeId = agentResumeId(key)
  if (!resumeId) return null
  const line = recapLine(parseRecapResult(await runCli(worktreePath, resumeId)), awayMs)
  if (!line) return null
  sendAgentEvent(win, key, { kind: 'tool', name: NICK, summary: line })
  return line
}
