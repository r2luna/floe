// Splitting a syntax-highlighted line around what the find bar matched.
//
// Marking a match in a ROW is one string slice. Marking one in a line of CODE is
// not: the line is already a list of Shiki tokens, each with its own colour, and
// a match ignores those boundaries — searching `log` in `$logger->log()` lands
// inside a variable token and straddles a punctuation one. So the tokens get cut
// at the match edges and both halves keep the SAME syntax style.
//
// Pure and separate from the component because it is index arithmetic over two
// interleaved sequences, which is the kind of code that breaks silently and
// off-by-one — it should be testable without a DOM.

export interface Piece<S> {
  content: string
  style: S
  /** Part of a match, so the caller draws the highlight behind it. */
  hit: boolean
}

/** Every occurrence of `query` in `text`, as [from, to) pairs. Case-insensitive. */
export function hitRanges(text: string, query: string): Array<[number, number]> {
  const q = query.toLowerCase()
  if (!q) return []
  const lower = text.toLowerCase()
  const out: Array<[number, number]> = []
  // Advance by the query's length, so `aa` in `aaaa` is two matches and not
  // three overlapping ones — overlapping marks would render as one blur anyway.
  for (let at = lower.indexOf(q); at !== -1; at = lower.indexOf(q, at + q.length)) {
    out.push([at, at + q.length])
  }
  return out
}

/**
 * Cut `tokens` wherever a match starts or ends.
 *
 * Returns the same text in the same order — only the boundaries change. With no
 * query, or no match, the tokens come back untouched, so the caller can render
 * one way regardless of whether a search is running.
 */
export function splitByHits<S>(
  tokens: ReadonlyArray<{ content: string; style: S }>,
  query: string | undefined
): Array<Piece<S>> {
  const q = query?.trim()
  if (!q) return splitByRanges(tokens, [])
  return splitByRanges(tokens, hitRanges(tokens.map((t) => t.content).join(''), q))
}

/**
 * The same cut, against ranges the caller already has.
 *
 * The find bar computes its ranges from a query; the markdown review computes
 * them from a word-level diff. Both need the identical thing afterwards — a
 * token list cut at arbitrary boundaries with every piece keeping its own
 * style — and that is the part worth having in one place.
 *
 * Ranges are [from, to) over the tokens' concatenated text, in order and
 * non-overlapping.
 */
export function splitByRanges<S>(
  tokens: ReadonlyArray<{ content: string; style: S }>,
  hits: ReadonlyArray<[number, number]>
): Array<Piece<S>> {
  if (!hits.length) return tokens.map((t) => ({ ...t, hit: false }))

  const out: Array<Piece<S>> = []
  // Zero-length pieces are dropped rather than emitted: a token can be empty, and
  // a match boundary can land exactly on a seam, both of which would otherwise
  // put an empty <span> in every line for nothing.
  const push = (content: string, style: S, hit: boolean): void => {
    if (content) out.push({ content, style, hit })
  }
  let col = 0
  for (const token of tokens) {
    const start = col
    const end = col + token.content.length
    col = end
    let cursor = start
    for (const [from, to] of hits) {
      if (to <= cursor || from >= end) continue
      const hitFrom = Math.max(from, cursor)
      const hitTo = Math.min(to, end)
      push(token.content.slice(cursor - start, hitFrom - start), token.style, false)
      push(token.content.slice(hitFrom - start, hitTo - start), token.style, true)
      cursor = hitTo
    }
    push(token.content.slice(cursor - start), token.style, false)
  }
  return out
}
