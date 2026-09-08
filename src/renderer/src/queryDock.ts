import type { Query } from '../../shared/types'

// What the dock in the corner of the chat lists: the queries this session has
// OPEN, whether or not their panel is on screen.
//
// The panel and the conversation are two different things — ⌘W closes a panel
// and deliberately does not discard the query (docs/queries.md) — and until
// this existed, closing one to reclaim lane width was a one-way door: the
// conversation went on running with nothing on screen naming it, and the only
// ways back were the palette or asking the harness a second thing. So the dock
// answers "what is open" rather than "what is visible", which is why a query
// that is idle is still a row.

/** One query in the dock, as it is right now. */
export interface QueryRow {
  /** The query's agent key — what its panel is opened under. */
  key: string
  harness: string
  /** A turn is in flight in it. Unlike a lane, an idle query still gets a row. */
  running: boolean
  /** What it is on, from its last `tool` event, while it runs. */
  tool?: string
  /** The row's clock: when the running turn started, else when it was opened. */
  since: number
}

/**
 * Every name a query answers to — its key, and the CLI ids it has held.
 *
 * The same pair `agentIdentityNames` resolves in main, resolved here off the
 * record the renderer already has: a turn in a Claude query runs under the id
 * the CLI minted, so matching the key alone would show a working query as idle.
 */
export function namesOf(query: Query): string[] {
  return [query.id, query.claudeId, ...(query.pastClaudeIds ?? [])].filter(
    (n): n is string => !!n
  )
}

/**
 * The dock's rows, from what main knows (the query list, the active keys) and
 * what the event stream has said since (which tool, since when).
 *
 * Oldest first, and never re-sorted by activity: these are the same
 * conversations the lane shows left to right in the order they were asked, and
 * a list that reorders itself as turns start and stop is a list you cannot
 * click.
 */
export function dockRows(
  queries: Query[],
  active: ReadonlySet<string>,
  live: ReadonlyMap<string, { tool?: string; at: number }>
): QueryRow[] {
  return queries
    // A merged or discarded query is over. Its line in the chat is what
    // remembers it, and `reopen` is what brings it back — listing it here would
    // be the dock offering a conversation the transcript has already closed.
    .filter((q) => !q.outcome)
    .sort((a, b) => a.openedAt - b.openedAt)
    .map((q): QueryRow => {
      const names = namesOf(q)
      const at = names.map((n) => live.get(n)).find(Boolean)
      const running = names.some((n) => active.has(n)) || !!at
      return {
        key: q.id,
        harness: q.harness,
        running,
        tool: running ? at?.tool : undefined,
        since: running ? (at?.at ?? q.openedAt) : q.openedAt
      }
    })
}
