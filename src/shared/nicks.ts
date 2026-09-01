// Nicks for the voices in the channel that are neither you nor the model
// answering you: the subagents. Shared because the same name has to come out of
// the live stream and out of a transcript read back from disk — a session that
// renamed its agents on reload would read as a different conversation.

/**
 * A subagent's nick: `explore-3f`.
 *
 * The type alone is not a nick. Two Explores launched together would both head
 * their report with "explore" and you could not tell which one answered. The
 * suffix is the tail of the tool_use id — stable (the CLI recorded it, so a
 * reload reproduces it) and different per agent, the same shape as Floe's own
 * session names.
 */
export function agentNick(agentType?: string, toolUseId?: string, harness?: string): string {
  const base =
    (agentType || 'agent')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'agent'
  // A bridged runtime is ONE peer per session, not one per call: Codex holds a
  // thread across exchanges, so it keeps a bare `codex` and stays addressable
  // as the same voice from the first exchange to the last. A suffix there would
  // rename it every time it answered.
  if (harness && harness !== 'claude') return base
  // Four characters, not two: two agents of the same type in one conversation
  // colliding on their last two id characters would merge into one speaker, and
  // a channel where two people share a nick is a channel that lies.
  const tail = (toolUseId ?? '').replace(/[^a-z0-9]/gi, '').slice(-4).toLowerCase()
  return tail ? `${base}-${tail}` : base
}
