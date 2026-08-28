// Composing the message a review turns into.
//
// Rookery has three review surfaces — a diff line range (ReviewComment), a plan
// block (PlanComment), and a passage of the conversation (ThreadComment) — and
// each one used to assemble its own markdown by hand. Four call sites, four
// slightly different shapes for the same idea, drifting apart with every edit.
// The anchors stay genuinely different; only this final assembly is shared.

// One note under a heading: the text it is about, plus what the user said.
export interface ReviewEntry {
  // Rendered verbatim above the body. A diff passes a fenced patch, the plan and
  // thread pass a blockquote — the caller decides, because only it knows whether
  // the quoted text is code or prose.
  quoted: string
  body: string
}

// The notes sharing one heading, e.g. a file path or a plan path.
export interface ReviewGroup {
  heading: string
  entries: ReviewEntry[]
}

// Quote text as a markdown blockquote so a multi-line passage still reads as a
// quotation rather than running into the note underneath it.
export function quoteBlock(s: string): string {
  return s
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n')
}

// Wrap text as a fenced block, for quoting code or a diff hunk.
export function fenceBlock(s: string, lang = ''): string {
  return `\`\`\`${lang}\n${s}\n\`\`\``
}

// Assemble the final message: an instruction line, then each group's heading
// followed by its notes. Groups with no entries are dropped rather than emitting
// a bare heading with nothing under it.
export function buildReviewMessage(header: string, groups: ReviewGroup[]): string {
  const out: string[] = [header, '']
  for (const g of groups) {
    if (g.entries.length === 0) continue
    out.push(`### ${g.heading}`)
    out.push('')
    for (const e of g.entries) {
      out.push(e.quoted)
      out.push(e.body)
      out.push('')
    }
  }
  return out.join('\n').trim()
}
