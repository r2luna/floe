// Matching for the command palette.
//
// Subsequence matching, not substring: "rkr" should find "floe-rust" the way
// every palette you have used does. Typing the letters of a name in order is how
// people search when they already know what they want.

export interface PaletteItem {
  id: string
  title: string
  /** Shown dim beside the title — a path, a group, a key hint. */
  detail?: string
  /** The chord that runs this, drawn as key chips on the right. */
  keys?: string
  /**
   * A short tag drawn in a box at the right edge — the machine a project is on.
   * Separate from `detail` because it is a fact about where the row lives
   * rather than more of its description, and the projects panel already draws
   * that fact this way.
   */
  badge?: string
  group?: string
  /**
   * Always offered, whatever the query. "Add project…" has to be there
   * precisely when the search finds nothing — that is the moment you learn the
   * project you wanted isn't added yet.
   */
  pinned?: boolean
  /**
   * What to actually insert when this is picked, if it differs from `id`.
   *
   * A function, not a string: a file mention registers its full path the moment
   * it is chosen (see fileRefs.ts), and doing that for every row of a tree the
   * menu merely offered would fill the map with paths nobody asked for.
   */
  insert?: () => string
  /**
   * A narrower version of this row, reached with → and left with ←.
   *
   * What `@codex` offers once you want to say more than its name: its models,
   * and under each of those the efforts. Every level is pickable on its own, so
   * the drill is optional detail rather than a path you have to walk.
   */
  variants?: PaletteItem[]
}

export interface Scored<T> {
  item: T
  /** Character positions in `title` that matched, for highlighting. */
  hits: number[]
  score: number
}

/**
 * Match `query` against `text` as a subsequence, returning the matched indices.
 * Null when a character can't be found in order.
 */
export function subsequence(text: string, query: string): number[] | null {
  if (!query) return []
  const hay = text.toLowerCase()
  const needle = query.toLowerCase()
  const hits: number[] = []
  let at = 0
  for (const ch of needle) {
    const found = hay.indexOf(ch, at)
    if (found === -1) return null
    hits.push(found)
    at = found + 1
  }
  return hits
}

/**
 * Rank a match. Lower is better.
 *
 * Two things decide it: how early the match starts, and how tightly the letters
 * sit together. "rkr" should rank `floe-rust` above a project whose name
 * merely contains those letters spread across it.
 */
function score(hits: number[]): number {
  if (!hits.length) return 0
  const spread = hits[hits.length - 1] - hits[0] - (hits.length - 1)
  return hits[0] + spread * 2
}

/**
 * Only the title is matched. `detail` is for reading, not for searching:
 * matching it too meant "ro" found every project, because they all sit in a
 * group called "Projects" and subsequence matching is generous enough to say
 * yes. A filter that answers "everything" has stopped filtering.
 */
export function filterItems<T extends PaletteItem>(items: T[], query: string): Scored<T>[] {
  const q = query.trim()
  const out: Scored<T>[] = []
  for (const item of items) {
    if (item.pinned) continue
    const hits = subsequence(item.title, q)
    if (hits) out.push({ item, hits, score: score(hits) })
  }
  // Stable: equal scores keep the order they were given, which is the caller's
  // own (projects stay in the user's arrangement).
  out.sort((a, b) => a.score - b.score)
  // Pinned actions go last, after whatever matched — they are what you do when
  // none of the results was the one.
  for (const item of items) if (item.pinned) out.push({ item, hits: [], score: Infinity })
  return out
}

/**
 * At most `n` rows per group, in the order given.
 *
 * A bare `#` offers every session and every file: without a cap the files sit
 * hundreds of rows below the fold, which reads as "there are no files". Ten of
 * each shows both blocks at once, and typing narrows from the full list.
 */
export function capGroups<T extends PaletteItem>(rows: Scored<T>[], n: number): Scored<T>[] {
  const seen = new Map<string | undefined, number>()
  return rows.filter((row) => {
    const count = (seen.get(row.item.group) ?? 0) + 1
    seen.set(row.item.group, count)
    return count <= n
  })
}

/**
 * Split a row's title into the dim context and the name the eye lands on.
 *
 * A file row is a whole path, and the part you are scanning for is the last
 * segment — drawn at full strength, with everything above it dim. The match
 * indices are split along with the text, or the highlight would slide off the
 * name the moment a row had a directory.
 *
 * A title with no `/` is all name: a command or a project has no context half,
 * and inventing one would put an empty span in front of every row.
 */
export function splitTitle(
  title: string,
  hits: number[]
): { dir: string; name: string; dirHits: number[]; nameHits: number[] } {
  const cut = title.lastIndexOf('/') + 1
  if (cut <= 0) return { dir: '', name: title, dirHits: [], nameHits: hits }
  return {
    dir: title.slice(0, cut),
    name: title.slice(cut),
    dirHits: hits.filter((i) => i < cut),
    nameHits: hits.filter((i) => i >= cut).map((i) => i - cut)
  }
}
