// How a finished command run ended — surfaced in the Commands panel line 2 as
// `exit 1 · 3h ago · ran 2s`. In-memory only (does not survive an app restart).
// Kept free of electron/node-pty imports so it can be unit-tested directly.
export interface ExitInfo {
  code: number
  endedAt: number // epoch ms the process exited
  durationMs: number // endedAt − startedAt
}

// Build the exit record for a run that just ended.
export function exitRecord(startedAt: number, endedAt: number, code: number): ExitInfo {
  return { code, endedAt, durationMs: endedAt - startedAt }
}
