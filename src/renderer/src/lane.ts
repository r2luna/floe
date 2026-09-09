import type { Attached } from '../../shared/types'
import type { ModelChoice } from './models'

// The lane is the whole navigation model: panels side by side, in a fixed
// left-to-right order — projects, then its worktrees, then the session, then
// whatever that session opened. Position carries meaning here, so a panel goes
// where its `order` says rather than wherever it was opened from, and a second
// panel of the same kind replaces the first instead of stacking.
//
// Any panel can be closed, including the first; the lane may end up empty.

export type Panel = {
  /** Stable identity — reopening the same thing focuses it instead of duplicating. */
  id: string
  kind: string
  title: string
  /** Dimmed secondary label in the panel header (file path, chat topic, …). */
  sub?: string
  /**
   * The directory `sub` is relative to, when it is not the worktree.
   *
   * A file panel normally reads the tree you are working in. A skill does not
   * live there — it lives in Floe's config — and the reader is the same reader,
   * so it is given a different root rather than a second panel kind that would
   * duplicate it. Absent means "the worktree", which is every other case.
   */
  root?: string
  /**
   * Where this panel belongs in the lane, left to right. The lane reads the
   * number and knows nothing about kinds; the kind table assigns it.
   *
   * Position is part of what a panel MEANS here — projects, then its worktrees,
   * then the session, then whatever that session opened. A panel that reappears
   * wherever it happened to be reopened would break that reading.
   */
  order?: number
  /**
   * Panels sharing a slot replace each other, even across kinds. The branch
   * launcher and the chat are one slot: the launcher IS the empty state of a
   * session, so having both open would be showing a session and its own absence
   * side by side. Defaults to the kind, which is why most panels never set it.
   */
  slot?: string
  /**
   * A size the user dragged to, in px, overriding the kind's default. Which
   * dimension it means depends on how the panel sits: a docked panel is sized
   * by height (its column already fixes the width), everything else by width.
   */
  width?: number
  height?: number
  /**
   * Docked under the panel to its left instead of standing beside it — the
   * terminal below the chat rather than next to it. A property of the panel,
   * not of the lane, so it travels with the panel through save and restore.
   */
  dock?: 'below'
  /** For a chat panel: the session it shows. */
  session?: { id: string; worktreePath: string }
  /** A brand-new chat's opening message, sent once when it mounts. */
  firstPrompt?: string
  /** The model that opening message was addressed to. */
  firstChoice?: ModelChoice
  /** What was dropped or pasted into that opening message. */
  firstAttached?: Attached
  /**
   * Where the cursor sits inside this panel, as an index into its rows.
   *
   * The cursor has to be state, not DOM focus: focus belongs to one element in
   * the whole window, so leaving a panel would forget where you were and drop
   * you back at the top. Persisting it per panel is what makes moving away and
   * returning land you exactly where you left.
   *
   * ponytail: an index, so a row inserted above the cursor shifts it. Rows would
   * need stable ids to fix that, which every panel body would have to declare —
   * worth it once a list can change under you, not before.
   */
  cursor?: number
  /**
   * An open visual-line selection, in the same row indices as `cursor`. Panel
   * state rather than DOM state for the same reason the cursor is: it has to
   * survive leaving the panel and coming back.
   */
  selection?: { anchor: number; head: number } | null
  /**
   * Which view a diff panel is showing. Markdown opens as `prose` — a document
   * with the changed words marked inside it — and `code` is the line diff every
   * other file gets. Panel state, so flipping one file's view does not flip the
   * next one you open, and so it survives save and restore.
   */
  view?: 'prose' | 'code'
}

/**
 * The slot a panel takes, when its kind does not name one.
 *
 * Only queries need this, and they need it here rather than in the kind table:
 * a query takes a slot of its OWN (`query:codex` beside `query:claude`) because
 * two side conversations opened out of one chat are two conversations, and
 * asking two harnesses is asking to compare them. Sharing the kind's slot, the
 * second panel replaced the first while its query went on running underneath.
 *
 * In `lane.ts` because `open` is the only reader of a slot and because the rule
 * has to be the same for every door that builds a panel — the chat, the dock in
 * the corner, and `query.showAll` all put the same panel in the same place.
 */
export function slotOf(kind: string, sub?: string, kindSlot?: string): string | undefined {
  return kind === 'query' ? `${kind}:${sub ?? ''}` : kindSlot
}

export type Lane = {
  panels: Panel[]
  focus: number
}

const clamp = (n: number, max: number) => Math.min(Math.max(n, 0), max)

export function laneOf(root: Panel): Lane {
  return { panels: [root], focus: 0 }
}

/**
 * The parts of a panel that describe its box rather than its contents: how wide
 * or tall you dragged it, and whether you stacked it. These survive a change of
 * content; the cursor and the selection do not, because they are indexes into a
 * list that is about to be a different list.
 */
function layoutOf(panel: Panel): Partial<Panel> {
  const layout: Partial<Panel> = {}
  if (panel.width !== undefined) layout.width = panel.width
  if (panel.height !== undefined) layout.height = panel.height
  if (panel.dock !== undefined) layout.dock = panel.dock
  return layout
}

/**
 * Panels married to another one, dependent → the kind it belongs to.
 *
 * The diff is only ever a row of the changes list — nothing else opens one — so
 * the two are one thing in two columns: the diff lands immediately right of the
 * list whatever else is open, and closing the list takes the diff with it. A
 * diff sitting three panels away from the rows that drive it, or left behind
 * with no way to pick the next file, is the list broken in half.
 *
 * The file reader is deliberately not here: the tree opens it, and the tree is
 * not the only door.
 */
const MARRIED_TO: Record<string, string> = { diff: 'changes' }

/** Where a married panel goes — right of its partner, or null if it is closed. */
function besidePartner(panels: Panel[], kind: string): number | null {
  const partner = MARRIED_TO[kind]
  if (!partner) return null
  const at = panels.findIndex((p) => p.kind === partner)
  return at === -1 ? null : at + 1
}

/**
 * Put `panel` in the lane and focus it.
 *
 * Three rules, all about keeping the lane readable rather than merely correct:
 *
 *  - It lands at its `order`, not at the end. The lane reads left to right as
 *    projects → worktrees → chat → what the session opened, and reopening a
 *    panel must restore that reading, not append to it.
 *  - Unless it is married to a panel that is open, which overrides the order:
 *    it lands right of its partner (see MARRIED_TO).
 *  - A panel taking the same SLOT is replaced. Usually that means the same kind
 *    — picking a second session swaps the chat instead of stacking two, which
 *    is what stops the lane growing a column per click — but two kinds can
 *    share a slot when they are two states of one thing (see Panel.slot).
 *
 * A replacement inherits the OUTGOING panel's layout. Panels are identified by
 * what they show (`kind:sub`), so switching project hands the worktrees slot a
 * different panel object — and without this it would arrive at its kind's
 * default width, undocked, throwing away a layout you arranged by hand. What
 * changes is the content; where it sits and how big it is are yours.
 *
 * Already open, same id: just focus it.
 */
export function open(lane: Lane, panel: Panel): Lane {
  const existing = lane.panels.findIndex((p) => p.id === panel.id)
  if (existing !== -1) return { ...lane, focus: existing }

  const panels = [...lane.panels]
  const slot = panel.slot ?? panel.kind
  const taken = panels.findIndex((p) => (p.slot ?? p.kind) === slot)
  if (taken !== -1) {
    // Lifted out rather than overwritten in place, so a married panel taking a
    // slot held elsewhere in the lane — the diff replacing the file reader the
    // tree opened — still lands beside its partner. `taken` is where it goes
    // back when it has none: in the shortened list that is the same position.
    const landing = { ...panel, ...layoutOf(panels[taken]) }
    panels.splice(taken, 1)
    const at = besidePartner(panels, landing.kind) ?? taken
    panels.splice(at, 0, landing)
    return { panels, focus: at }
  }

  const rank = panel.order ?? 0
  const before = panels.findIndex((p) => (p.order ?? 0) > rank)
  const at = besidePartner(panels, panel.kind) ?? (before === -1 ? panels.length : before)
  panels.splice(at, 0, panel)
  return { panels, focus: at }
}

/**
 * Close one panel, and whatever was married to it (see MARRIED_TO). Not its
 * neighbours: every panel in the lane is a thing you asked for, and closing the
 * leftmost to reclaim room must not take the work to its right with it.
 * Accumulation is prevented in `open`, by replacing a panel of the same kind —
 * not here.
 *
 * The lane may end up empty; the rail and the goto bindings are how you get
 * back, so it is a state you can leave, not a dead end.
 */
export function close(lane: Lane, index: number): Lane {
  if (index < 0 || index >= lane.panels.length) return lane
  const closing = lane.panels[index].kind
  const gone = new Set(
    lane.panels.flatMap((p, i) => (i === index || MARRIED_TO[p.kind] === closing ? [i] : []))
  )
  const panels = lane.panels.filter((_, i) => !gone.has(i))
  // Closing a panel to the LEFT of the focused one shifts every index after it,
  // so the focus has to follow or it would silently jump to a different panel.
  const focus = lane.focus - [...gone].filter((i) => i < lane.focus).length
  // max(0, …) because an emptied lane has no last index to clamp against.
  return { panels, focus: clamp(focus, Math.max(0, panels.length - 1)) }
}

/**
 * What a "go to this kind" binding does, in one place:
 *   closed        → open it and focus it
 *   open, elsewhere → focus it
 *   open, focused → close it
 *
 * The third case is what makes the binding a toggle: the same keystroke that
 * summoned a panel dismisses it, so you never need a second one to put it away.
 */
export function toggleKind(lane: Lane, kind: string, create: () => Panel): Lane {
  const at = lane.panels.findIndex((p) => p.kind === kind)
  if (at === -1) return open(lane, create())
  return at === lane.focus ? close(lane, at) : focusAt(lane, at)
}

/**
 * Close panel `index`, or — when it holds a session — swap in `emptyState`.
 *
 * The chat and the launcher share the session slot, and the launcher is defined
 * as the chat's empty state. So closing a conversation should leave that column
 * standing and offering a new one, not tear it out and drop you on whatever
 * happened to be beside it (or on nothing at all). Every other panel closes
 * plainly — closing the file tree must not conjure a launcher.
 */
export function closePanel(lane: Lane, index: number, emptyState: () => Panel): Lane {
  const panel = lane.panels[index]
  // Only the panel in the SESSION slot leaves an empty state behind: closing
  // the chat means the branch is showing no conversation, which is what the
  // launcher says. A query panel carries a session too — its own key — and
  // carries no such meaning: closing one leaves the lane one panel shorter, not
  // a second launcher beside the first.
  if (!panel?.session || (panel.slot ?? panel.kind) !== 'session') return close(lane, index)
  const panels = [...lane.panels]
  // A fresh panel, not a patch: the old one carries a session id, a first
  // prompt and a width the launcher must not inherit.
  panels[index] = emptyState()
  return { ...lane, panels }
}

/** Replace one panel, keeping the rest of the lane identical. */
export function patchPanel(lane: Lane, index: number, patch: Partial<Panel>): Lane {
  const panel = lane.panels[index]
  if (!panel) return lane
  const panels = [...lane.panels]
  panels[index] = { ...panel, ...patch }
  return { ...lane, panels }
}

/** Remember where the cursor is inside panel `index`. */
export function setCursor(lane: Lane, index: number, cursor: number): Lane {
  const panel = lane.panels[index]
  if (!panel || panel.cursor === cursor) return lane
  const panels = [...lane.panels]
  panels[index] = { ...panel, cursor }
  return { ...lane, panels }
}

export function focusAt(lane: Lane, index: number): Lane {
  return { ...lane, focus: clamp(index, lane.panels.length - 1) }
}

export function focusBy(lane: Lane, delta: number): Lane {
  return focusAt(lane, lane.focus + delta)
}

/**
 * Move focus by grid position rather than by flat panel index.
 *
 * Stacking means the lane is no longer one line — a column can hold two panels
 * standing on top of each other. ⌃H/⌃L cross columns (left/right); ⌃J/⌃K move
 * within one (down/up). Neither ever does the other's job: ⌃L from the top of a
 * stack must land beside it, not on the panel docked underneath, or the two axes
 * would tangle into a single ambiguous "next".
 *
 * Crossing INTO a column keeps your row when the column is tall enough, and
 * clamps to its last panel when it isn't — so leaving a two-tall stack for a
 * single panel doesn't overshoot into nothing.
 */
export function focusDir(lane: Lane, dx: -1 | 0 | 1, dy: -1 | 0 | 1): Lane {
  const columns = columnsOf(lane)
  const at = lane.panels[lane.focus]
  if (!at) return lane
  const c = columns.findIndex((col) => col.some((p) => p.index === lane.focus))
  if (c === -1) return lane
  const r = columns[c].findIndex((p) => p.index === lane.focus)

  if (dx !== 0) {
    const col = columns[c + dx]
    if (!col) return lane // already the edge column — no wrap
    return focusAt(lane, col[Math.min(r, col.length - 1)].index)
  }

  const row = columns[c][r + dy]
  return row ? focusAt(lane, row.index) : lane // already the edge of the stack
}

/**
 * Put a panel under its left-hand neighbour, or back beside it.
 *
 * The leftmost panel has nothing to go under, so it stays where it is: the
 * alternative would be a panel docked to the edge of the window, which is just
 * the lane again with extra rules.
 */
export function toggleDock(lane: Lane, index: number): Lane {
  const panel = lane.panels[index]
  if (!panel || index === 0) return lane
  return patchPanel(lane, index, { dock: panel.dock === 'below' ? undefined : 'below' })
}

/**
 * The lane as columns: each panel starts one, and a docked panel joins the
 * column on its left instead of opening its own.
 *
 * Rendering reads this rather than the flat list, so "below" and "beside" are
 * the same lane in two shapes — nothing is moved, reordered or reparented when
 * you flip one.
 */
export function columnsOf(lane: Lane): { panel: Panel; index: number }[][] {
  const columns: { panel: Panel; index: number }[][] = []
  lane.panels.forEach((panel, index) => {
    const last = columns[columns.length - 1]
    if (panel.dock === 'below' && last) last.push({ panel, index })
    else columns.push([{ panel, index }])
  })
  return columns
}

/**
 * Record a size the user dragged to.
 *
 * One function for both axes because a panel only ever has one to give: docked,
 * it shares its column's width and can only change height; otherwise it sets
 * the width of the column it heads. The floor is passed in — how narrow a
 * particular kind may get is the kind table's business, not the lane's.
 */
export function resizePanel(lane: Lane, index: number, size: number, min = 120): Lane {
  const panel = lane.panels[index]
  if (!panel) return lane
  const value = Math.max(min, Math.round(size))
  return patchPanel(lane, index, panel.dock === 'below' ? { height: value } : { width: value })
}

/** Give a panel its default size back — the undo for a drag that went wrong. */
export function clearSize(lane: Lane, index: number): Lane {
  const panel = lane.panels[index]
  if (!panel || (panel.width === undefined && panel.height === undefined)) return lane
  return patchPanel(lane, index, { width: undefined, height: undefined })
}
