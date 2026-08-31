// The one-way channel from the `mcp.new` command to the MCP panel — the same
// held-request bridge skillDraft.ts is, for the same reason: creating happens
// IN the list (scope menu under the `+`, name typed on the row), the panel owns
// that flow, and the command that starts it must not close over React state.

export type McpDraftRequest = { kind: 'new' }

let sink: ((req: McpDraftRequest) => void) | null = null
let waiting: McpDraftRequest | null = null

/** The panel takes over while it is mounted. Returns its unsubscribe. */
export function onMcpDraft(fn: (req: McpDraftRequest) => void): () => void {
  sink = fn
  if (waiting) {
    const held = waiting
    waiting = null
    fn(held)
  }
  return () => {
    if (sink === fn) sink = null
  }
}

/** Ask the panel to start a draft — from the `n` key, the header `+`, or the menu. */
export function startMcpDraft(req: McpDraftRequest): void {
  if (sink) sink(req)
  else waiting = req
}
