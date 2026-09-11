// Marking what the find bar matched, in a ROW.
//
// Its own module because every panel that lists rows needs it — including the
// ones that do not live in panels.tsx — and reaching back into panels.tsx for
// it would make the panel registry import the panels that the registry imports.
import type { ReactNode } from 'react'
import { hitRanges } from './findHits.ts'

/**
 * Tint every occurrence of the find bar's query in a piece of text.
 *
 * The one marker for every panel. It used to be two — rows marked the FIRST
 * match in the palette's blue while code marked ALL of them in amber — which
 * meant the same search looked like two different features depending on which
 * panel you ran it in. Blue stays with the palette, where it means a fuzzy
 * match on something you are picking; the find bar is always amber, always
 * every occurrence.
 */
export function markAll(text: string, query?: string): ReactNode {
  const q = query?.trim().toLowerCase()
  if (!q) return text
  // Same range finder the code marker uses, so a row and a line of code cannot
  // disagree about what counts as a match.
  const hits = hitRanges(text, q)
  if (!hits.length) return text
  const out: ReactNode[] = []
  let at = 0
  hits.forEach(([from, to], i) => {
    if (from > at) out.push(text.slice(at, from))
    out.push(
      <span key={i} className="find-hit">
        {text.slice(from, to)}
      </span>
    )
    at = to
  })
  return [...out, text.slice(at)]
}
