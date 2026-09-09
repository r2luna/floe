// The command registry: every action the UI can perform, as data.
//
// Its own module, not a constant inside App, because three callers must be able
// to enumerate it — the keymap (keys.ts resolves a key to an id), the command
// palette, and the MCP `run_command` tool. A registry that only React can see
// would make "one source of truth" a claim rather than a fact; this one is
// importable by a plain test, which is how the id list stays honest.
// Explicit .ts extensions: this module is imported by a plain `node --test`
// run as well as by Vite, and Node's ESM resolver does not guess extensions.
import {
  clearSize,
  close,
  closePanel,
  focusAt,
  focusDir,
  open,
  patchPanel,
  resizePanel,
  setCursor,
  toggleDock,
  toggleKind
} from './lane.ts'
import { READS_AS_PROSE } from './proseDiff.ts'
import { appendComment, fileRef, parseUnifiedDiff, quoteSelection, selRange } from './diff.ts'
import type { Command, CommandContext } from './commands.ts'
import type { Panel } from './lane.ts'
import { editSub } from './editorTarget.ts'
import { sendToTerminal } from './terminalBus.ts'
import { startSkillDraft } from './skillDraft.ts'
import { toggleSubagentDock } from './useSubagents.ts'
import { startMcpDraft } from './mcpDraft.ts'
import { isUnread, markRead, markUnread } from './unreadStore.ts'
import { reason } from './ipcError.ts'
import type { FileOp } from '../../shared/types.ts'

/** The chat the lane is showing — what a query is opened off. */
const chatOf = (c: CommandContext): Panel | undefined =>
  c.lane.panels.find((p) => p.kind === 'chat' && p.session)

/** Every query panel in the lane, left to right. */
const queryPanels = (c: CommandContext): number[] =>
  c.lane.panels.flatMap((p, i) => (p.kind === 'query' ? [i] : []))

/**
 * Where "go to the query" lands: the next one along, wrapping.
 *
 * Several can be on screen at once — asking two harnesses opens two panels —
 * so the binding walks them rather than naming one. From anywhere else it is
 * the leftmost, which with a single query open is the only behaviour there was.
 */
function queryIndex(c: CommandContext): number {
  const all = queryPanels(c)
  if (!all.length) return -1
  const at = all.indexOf(c.lane.focus)
  return at === -1 ? all[0] : all[(at + 1) % all.length]
}

/**
 * The query peek, merge and discard act on: the focused panel if it is one,
 * else the only one open.
 *
 * Both, because both are where you press the key from. You read the query in
 * its own panel and merge it from there; you also watch it from the chat and
 * merge it without moving. Falling back to "the only one open" is unambiguous
 * exactly when there is nothing to be ambiguous about — with two panels up,
 * merging whichever the lane lists first would be a coin toss that ends a
 * conversation.
 */
function queryTarget(c: CommandContext): Panel | undefined {
  const all = queryPanels(c)
  if (all.includes(c.lane.focus)) return c.lane.panels[c.lane.focus]
  return all.length === 1 ? c.lane.panels[all[0]] : undefined
}

/** Peek, merge or discard — one call, because they differ only in the verb. */
function runQuery(c: CommandContext, action: 'peek' | 'merge' | 'discard'): void {
  const key = queryTarget(c)?.session?.id
  // Enabled means a query is open, so no key here means more than one is and
  // none is focused. Say which key answers that rather than picking for them.
  if (!key)
    return queryPanels(c).length > 1
      ? c.say(`Several queries open — go to one first (⌘K “Go to the query”) to ${action} it.`)
      : undefined
  // The panel comes down (or stays up) on main's `query:closed` announcement,
  // never from here: an agent can merge a query too, and the panel must behave
  // the same way whoever asked.
  void window.floe.query[action](key)
    .then((r) => {
      if (r.error) return c.say(r.error)
      if (action === 'peek' && !r.entries) c.say('Nothing new in the query.')
    })
    .catch((e) => c.say(reason(e)))
}

/**
 * Scroll the focused panel's content.
 *
 * Which element scrolls is a DOM question — the chat scrolls its transcript,
 * the diff scrolls its body — so it finds the overflowing one rather than
 * naming them. A panel that fits needs no scrolling and gets none.
 *
 * The step is a fraction of what you can see, not a fixed number of pixels: on
 * a tall panel a fixed step crawls, and on a short one it jumps past the line
 * you were reading.
 */
function scrollPanel(c: CommandContext, dir: number): void {
  const panel = c.panelEl(c.lane.focus)
  if (!panel) return
  const scroller = [...panel.querySelectorAll<HTMLElement>('*')].find(
    (el) => el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== 'visible'
  )
  if (!scroller) return
  // Plain assignment, and deliberately NOT smooth — neither scrollBy's
  // behaviour option nor CSS scroll-behavior animates in this Chromium, and
  // asking for either leaves the element exactly where it was. Instant is also
  // the right feel for a key you hold down.
  scroller.scrollTop += dir * Math.max(80, scroller.clientHeight * 0.2)
}

/**
 * The composer `i` should land in: the one in the panel you are already in, or
 * failing that the only one open. Preferring the focused panel matters once two
 * are on screen — with a chat beside a branch launcher, `i` has to mean "write
 * here", not "write in whichever one the lane lists first".
 */
function findComposer(c: CommandContext): HTMLTextAreaElement | null {
  const here = c.panelEl(c.lane.focus)?.querySelector<HTMLTextAreaElement>('.composer-input')
  if (here) return here
  for (let i = 0; i < c.lane.panels.length; i++) {
    const box = c.panelEl(i)?.querySelector<HTMLTextAreaElement>('.composer-input')
    if (box) return box
  }
  return null
}

/**
 * Move the cursor inside the focused panel, and — while a selection is open —
 * drag its head along, so moving grows or shrinks the range instead of leaving
 * it behind.
 */
/**
 * Put the cursor on row `to`, clamped. The same tail every movement command
 * ends with: focus the row, remember the index, drag an open selection along.
 */
function landOn(c: CommandContext, rows: HTMLElement[], to: number): void {
  const row = rows[Math.max(0, Math.min(to, rows.length - 1))]
  if (!row) return
  row.focus()
  const at = rows.indexOf(row)
  c.setLane((l) => {
    const panel = l.panels[l.focus]
    const sel = panel?.selection ? { ...panel.selection, head: at } : panel?.selection
    return patchPanel(l, l.focus, { cursor: at, selection: sel })
  })
}

/** Half a screen of rows, so ⌃D/⌃U move by what you can actually see. */
function pageStep(c: CommandContext, rows: HTMLElement[]): number {
  const panel = c.panelEl(c.lane.focus)
  const rowHeight = rows[0]?.offsetHeight || 20
  return Math.max(1, Math.round((panel?.clientHeight ?? 400) / rowHeight / 2))
}

/** The file row the cursor is on, or null when it is somewhere else. */
function fileRow(c: CommandContext): HTMLElement | null {
  const active = document.activeElement as HTMLElement | null
  return active && c.panelEl(c.lane.focus)?.contains(active) ? active : null
}

/**
 * The session the worktrees cursor is on, or null when it is on a branch.
 *
 * Read off the row's own `data-session` rather than by counting rows, exactly
 * as `projectAtCursor` reads `data-project`: the list is grouped, and an index
 * into "sessions, ignoring branches" is the kind of arithmetic that ticks the
 * wrong chat the day a branch gets folded.
 *
 * The cursor rather than `document.activeElement`, unlike fileRow: the right-
 * click menu holds focus while it is up, and "Select" from that menu has to
 * mean the row it was opened on.
 */
function sessionOnRow(c: CommandContext): { id: string; worktreePath: string } | null {
  const panel = c.lane.panels[c.lane.focus]
  if (panel?.kind !== 'worktrees') return null
  const row = c.rowsOf(c.panelEl(c.lane.focus))[panel.cursor ?? -1]
  const id = row?.dataset.session
  const worktreePath = row?.dataset.worktree
  return id && worktreePath ? { id, worktreePath } : null
}

/**
 * What `session.unread` marks: the row the cursor is on, or — with the cursor
 * anywhere else — the chat the lane is showing.
 *
 * Both names, always. A session answers to Floe's id and to the claudeId, the
 * marks are keyed by whichever the events carried, and the sidebar row asks
 * about both — so a mark set under one name and looked for under the other is
 * a mark that never appears, or one that `u` cannot take off again.
 *
 * `open` says the target IS the chat on screen, which is what lets the mark
 * survive it (see unreadStore's hold) instead of being wiped by the very panel
 * you are looking at.
 */
function unreadTarget(c: CommandContext): { keys: string[]; open: boolean } | null {
  const openId = chatOf(c)?.session?.id
  const panel = c.lane.panels[c.lane.focus]
  const row =
    panel?.kind === 'worktrees'
      ? c.rowsOf(c.panelEl(c.lane.focus))[panel.cursor ?? -1]
      : undefined
  const id = row?.dataset.session
  if (id) {
    const keys = [id, row?.dataset.claude].filter((k): k is string => !!k)
    return { keys, open: !!openId && keys.includes(openId) }
  }
  return openId ? { keys: [openId], open: true } : null
}

/**
 * The tree row the cursor is on, as a worktree-relative path.
 *
 * Directories count: renaming, moving and deleting a directory are the same
 * three operations, and refusing them on a folder would be an arbitrary hole.
 */
function fileTarget(c: CommandContext): string | undefined {
  if (c.lane.panels[c.lane.focus]?.kind !== 'files') return undefined
  const row = fileRow(c)
  return row?.dataset.file ?? row?.dataset.dir
}

/**
 * The skill row the cursor is on, or null when the focus is somewhere else.
 *
 * Read from the DOM for the same reason `fileTarget` is: the row already knows
 * which skill it is, and lifting the list into the lane just so three commands
 * could ask would give the panel a second copy of itself to keep in step.
 */
function skillRow(c: CommandContext): HTMLElement | null {
  if (c.lane.panels[c.lane.focus]?.kind !== 'skills') return null
  const row = fileRow(c)
  return row?.dataset.skill ? row : null
}

/** The MCP server row under the cursor — same contract as skillRow. */
function mcpRow(c: CommandContext): HTMLElement | null {
  if (c.lane.panels[c.lane.focus]?.kind !== 'mcp') return null
  const row = fileRow(c)
  return row?.dataset.mcp ? row : null
}

/** The drawing row the cursor is on — same contract as skillRow. */
function drawRow(c: CommandContext): HTMLElement | null {
  if (c.lane.panels[c.lane.focus]?.kind !== 'draw') return null
  const row = fileRow(c)
  return row?.dataset.drawing ? row : null
}

/**
 * The task the cursor is on, read off the row's own `data-task`.
 *
 * By attribute rather than by counting: a column is three bands with labels
 * between them, and an index into "cards, ignoring band tags" is exactly the
 * arithmetic that archives the wrong task the day a band is added.
 */
function taskRow(c: CommandContext): HTMLElement | null {
  if (c.lane.panels[c.lane.focus]?.kind !== 'colony') return null
  const row = fileRow(c)
  return row?.dataset.task ? row : null
}

/**
 * Move the cursor to the column `delta` steps sideways, keeping your row.
 *
 * Each column's body is a `data-nav-group`, so `j`/`k` already stay inside one;
 * this is the other axis. Empty columns are collapsed to a spine and hold no
 * rows, so they are skipped for free — stepping onto one would land the cursor
 * on nothing.
 */
function colonyStep(c: CommandContext, delta: 1 | -1): void {
  const panel = c.panelEl(c.lane.focus)
  const all = c.rowsOf(panel)
  if (!all.length) return
  const groups = [...(panel?.querySelectorAll<HTMLElement>('[data-nav-group]') ?? [])].filter(
    (g) => g.querySelector('button, [data-nav]')
  )
  const active = document.activeElement as HTMLElement | null
  const here = groups.findIndex((g) => g.contains(active))
  const from = here === -1 ? (delta > 0 ? -1 : groups.length) : here
  const group = groups[from + delta]
  if (!group) return
  const rows = [...group.querySelectorAll<HTMLElement>('button, [data-nav]')]
  // Keep your row where the column is tall enough, clamp where it is not —
  // leaving a five-card column for a one-card one must not overshoot.
  const at = here === -1 ? 0 : [...groups[here].querySelectorAll<HTMLElement>('button, [data-nav]')].indexOf(active as HTMLElement)
  const row = rows[Math.min(Math.max(at, 0), rows.length - 1)]
  if (!row) return
  row.focus()
  const to = all.indexOf(row)
  c.setLane((l) => patchPanel(l, l.focus, { cursor: to }))
}

/**
 * The command row the cursor is on, as its id.
 *
 * Read off the row's own `data-command` rather than by counting rows, for the
 * same reason `fileTarget` does: the row already knows which command it is, and
 * an index into a list that grows a header the day someone adds one is exactly
 * the arithmetic that starts the wrong process.
 */
function commandTarget(c: CommandContext): string | undefined {
  if (c.lane.panels[c.lane.focus]?.kind !== 'commands') return undefined
  return fileRow(c)?.dataset.command
}

/** Whether the command under the cursor has a live process. */
function commandLive(c: CommandContext): boolean {
  const id = commandTarget(c)
  const state = id ? c.commands.runOf(id)?.state : undefined
  return state === 'running' || state === 'starting'
}

/** Join a directory and a name, where the directory may be the root (''). */
function join(dir: string, name: string): string {
  const clean = name.replace(/^\/+|\/+$/g, '')
  const base = dir.replace(/^\/+|\/+$/g, '')
  return base ? `${base}/${clean}` : clean
}

/**
 * Run file operations and report what failed.
 *
 * Nothing here refreshes the tree: the panel already follows the worktree's
 * watcher, so the row disappears (or reappears under its new name) the same way
 * it would if an agent had done it.
 */
function applyOps(c: CommandContext, root: string, ops: FileOp[]): void {
  void window.floe.files.apply(root, ops).then((errors) => {
    if (errors.length) c.say(errors[0])
  })
}

/** The command on the shell row the cursor is on, if it is on one. */
function bashCommand(c: CommandContext): string | undefined {
  // The kind is checked first so this stays answerable without a DOM: the
  // palette and the MCP tool ask every command whether it is available, from
  // a node process with no document in sight.
  if (c.lane.panels[c.lane.focus]?.kind !== 'chat') return undefined
  const active = document.activeElement as HTMLElement | null
  if (!active || !c.panelEl(c.lane.focus)?.contains(active)) return undefined
  return active.closest<HTMLElement>('[data-cmd]')?.dataset.cmd
}

function moveCursor(c: CommandContext, delta: number): void {
  const panelEl = c.panelEl(c.lane.focus)
  const all = c.rowsOf(panelEl)
  if (!all.length) return

  const active = document.activeElement as HTMLElement | null
  // A panel with two lists (the diff's files and its hunks) marks each one a
  // `data-nav-group`; movement stays inside the group you're in. The index
  // stored is the flat one, so it still points at the right row afterwards.
  const scope = active?.closest('[data-nav-group]')
  const rows = scope ? [...scope.querySelectorAll<HTMLElement>('button, [data-nav]')] : all

  const cursor = c.lane.panels[c.lane.focus]?.cursor
  const fromActive = rows.indexOf(active as HTMLElement)
  const here = fromActive !== -1 ? fromActive : cursor != null ? rows.indexOf(all[cursor]) : -1
  // From nowhere, down enters at the top and up at the bottom.
  const next = here === -1 ? (delta > 0 ? 0 : rows.length - 1) : here + delta
  const row = rows[Math.max(0, Math.min(next, rows.length - 1))]
  if (!row) return

  row.focus()
  const to = all.indexOf(row)
  c.setLane((l) => {
    const panel = l.panels[l.focus]
    const sel = panel?.selection ? { ...panel.selection, head: to } : panel?.selection
    return patchPanel(l, l.focus, { cursor: to, selection: sel })
  })
}

/**
 * Put the selected lines into the chat composer, ready to say something about.
 *
 * What lands there depends on the panel. A diff is quoted in full — the patch
 * is not on disk, so the text is the only way the agent can see it. A file is
 * referenced by `path:from-to` instead: the agent can open it, and a pasted
 * copy would go stale the moment either of you edits the file.
 */
/**
 * The file `e` would open, and the line to land on.
 *
 * Four panels can answer: the tree and the plans list (the row under the
 * cursor), the reader (its own file, on the cursor's line) and a diff (the
 * file, on the line that row is in the NEW version — an editor has nothing to
 * say about the old one). Null when the focused panel is none of those, which
 * is what dims the command.
 */
/**
 * The file line a row stands for, when the panel says so on the row itself.
 *
 * The prose view cannot be counted through the patch: a rewritten line is ONE
 * row standing for two of the patch's, and a run of changes is reordered into
 * file order. So it writes the number it means onto the row, and the commands
 * that need a line read it there rather than re-deriving one that would be off.
 */
function lineOnRow(c: CommandContext, index: number): number | undefined {
  const line = Number(c.rowsOf(c.panelEl(c.lane.focus))[index]?.dataset.line)
  return Number.isFinite(line) && line > 0 ? line : undefined
}

/**
 * Move the cursor to the next change, treating a run of changed rows as one.
 *
 * A rewritten paragraph is a dozen rows; stepping into the middle of it would
 * mean pressing the key once per line of something you already read as a single
 * edit. So: walk out of the run you are in, then on to the next one.
 */
function stepChange(c: CommandContext, dir: number): void {
  const rows = c.rowsOf(c.panelEl(c.lane.focus))
  const at = c.lane.panels[c.lane.focus]?.cursor ?? 0
  const changed = (i: number): boolean => {
    const kind = rows[i]?.dataset.kind
    return kind === 'add' || kind === 'del' || kind === 'mod'
  }

  let i = at + dir
  if (changed(at)) while (i >= 0 && i < rows.length && changed(i)) i += dir
  while (i >= 0 && i < rows.length && !changed(i)) i += dir
  if (i < 0 || i >= rows.length) return
  c.setLane((l) => setCursor(l, l.focus, i))
}

function editTargetOf(c: CommandContext): { path: string; line?: number } | null {
  const panel = c.lane.panels[c.lane.focus]
  if (!panel) return null
  // A list whose rows name a file — the tree and the plans list. Both mark the
  // row with `data-file`, so one read covers them and a third list joins by
  // marking its rows the same way.
  if (panel.kind === 'files' || panel.kind === 'plans') {
    const path = fileRow(c)?.dataset.file
    return path ? { path } : null
  }
  if (panel.kind === 'file') return { path: panel.sub ?? '', line: (panel.cursor ?? 0) + 1 }
  if (panel.kind === 'diff') {
    const path = panel.sub ?? ''
    const marked = lineOnRow(c, panel.cursor ?? 0)
    if (marked !== undefined) return { path, line: marked }
    // The parse, not the DOM, for the same reason the quote uses it: the row the
    // cursor indexes has to be the row we read a line number off.
    const { rows } = parseUnifiedDiff(c.patchFor(path))
    const nav = c.rowsOf(c.panelEl(c.lane.focus))
    const row = rows[(panel.cursor ?? 0) - (nav.length - rows.length)]
    return { path, line: row?.newNo }
  }
  return null
}

/**
 * The file `o` hands to the OS: the row under the cursor in the tree or in the
 * changes list. A directory has no `data-file`, so the key stays unavailable on
 * one rather than opening the folder in a file manager.
 */
function openTargetOf(c: CommandContext): string | null {
  const kind = c.lane.panels[c.lane.focus]?.kind
  if (kind !== 'files' && kind !== 'changes') return null
  return fileRow(c)?.dataset.file ?? null
}

function commentOnSelection(c: CommandContext): void {
  const panel = c.lane.panels[c.lane.focus]
  const r = selRange(panel?.selection)
  if (!panel || !r) return

  // A prose row knows its own file line, and the patch's rows are not the rows
  // on screen there — so the selection is sent as a `path:12-30` reference, the
  // same shape a file panel sends, rather than as a quoted patch that would name
  // the wrong lines.
  const from = lineOnRow(c, r[0])
  const to = lineOnRow(c, r[1])
  if (panel.kind === 'diff' && from !== undefined && to !== undefined) {
    sendToComposer(c, fileRef(panel.sub ?? '', from, to).trim() + '\n\n')
    return
  }

  // Rows here must be the SAME list the cursor indexes: the parse, not the DOM,
  // so the quote cannot drift from what is highlighted.
  const quote =
    panel.kind === 'file'
      ? // A file panel reading its own root — a skill, which lives in Floe's
        // config — is not in the worktree, so a relative path would name
        // nothing the agent can open. The full path is what gets sent, and what
        // the composer shows.
        fileRef(panel.root ? `${panel.root}/${panel.sub ?? ''}` : (panel.sub ?? ''), r[0], r[1]).trim() + '\n\n'
      : (() => {
          const { rows } = parseUnifiedDiff(c.patchFor(panel.sub ?? ''))
          const nav = c.rowsOf(c.panelEl(c.lane.focus))
          const offset = nav.length - rows.length
          return quoteSelection(rows, r[0] - offset, r[1] - offset, panel.sub ?? '')
        })()
  if (!quote) return
  sendToComposer(c, quote)
}

/** Put a quote or a reference in the composer, and hand the keyboard over. */
function sendToComposer(c: CommandContext, quote: string): void {
  // Any composer, not only the chat's: the launcher has one too, and a comment
  // that silently does nothing because the session hasn't started yet is worse
  // than one that lands where you can see it.
  const box = findComposer(c)
  if (!box) return

  // Write through the native setter so React's onChange sees it — the composer
  // is controlled, and assigning .value alone would be reverted on next render.
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  const next = appendComment(box.value, quote)
  setValue?.call(box, next)
  box.dispatchEvent(new Event('input', { bubbles: true }))
  // Drop the selection: it has been said, and leaving it highlighted invites
  // commenting on the same lines twice.
  c.setLane((l) => patchPanel(l, l.focus, { selection: null }))
  box.focus()
  // Caret at the very end: the next thing you do is write about the block that
  // just arrived, and a caret left mid-message would put that note in the
  // middle of the previous one.
  box.setSelectionRange(next.length, next.length)
  box.scrollTop = box.scrollHeight
}

/**
 * The registry. Defined at module scope, not inside the component: the palette
 * and the MCP tool need to enumerate it without a render, and a command that
 * captured React state would go stale the moment the lane changed. State
 * arrives through the context instead.
 */
/**
 * Resize the focused panel by a step, measuring from what it is on screen.
 *
 * The current size is read from the DOM rather than from the lane, because most
 * panels have no size recorded — they are whatever their kind's default and the
 * leftover width worked out to. Growing from the number you can see is the only
 * way the first keypress does not jump.
 */
function nudgeSize(c: CommandContext, step: number): void {
  const el = c.panelEl(c.lane.focus)
  if (!el) return
  const docked = c.lane.panels[c.lane.focus]?.dock === 'below'
  const now = docked ? el.offsetHeight : el.offsetWidth
  c.setLane((l) => resizePanel(l, l.focus, now + step, docked ? 120 : 180))
}

export const REGISTRY: Map<string, Command> = new Map(
  (
    [
      {
        id: 'panel.right',
        title: 'Focus panel to the right',
        group: 'Panels',
        keys: '⌃L',
        run: (c) => c.setLane((l) => focusDir(l, 1, 0))
      },
      {
        id: 'panel.left',
        title: 'Focus panel to the left',
        group: 'Panels',
        keys: '⌃H',
        run: (c) => c.setLane((l) => focusDir(l, -1, 0))
      },
      {
        // Only reachable where there is something to move between — a stack.
        // Plain ⌃J/⌃K keep scrolling everywhere else (see scroll.down/up).
        id: 'panel.down',
        title: 'Focus panel below (in a stack)',
        group: 'Panels',
        keys: '⌃J',
        run: (c) => c.setLane((l) => focusDir(l, 0, 1))
      },
      {
        id: 'panel.up',
        title: 'Focus panel above (in a stack)',
        group: 'Panels',
        keys: '⌃K',
        run: (c) => c.setLane((l) => focusDir(l, 0, -1))
      },
      {
        id: 'panel.focusAt',
        title: 'Focus panel by position',
        group: 'Panels',
        keys: '⌘1–9',
        run: (c, arg) => c.setLane((l) => focusAt(l, Number(arg ?? 0)))
      },
      {
        // "Below" and "beside" are the same panel in two shapes — one command,
        // so the header button and the palette can never drift apart.
        id: 'panel.dock',
        title: 'Dock panel below its neighbour',
        group: 'Panels',
        keys: '⌘K /',
        enabled: (c) => c.lane.focus > 0 && !!c.lane.panels[c.lane.focus],
        run: (c) => c.setLane((l) => toggleDock(l, l.focus))
      },
      {
        // The keyboard half of dragging a splitter. Same lane field, so a drag
        // and a keypress cannot disagree about how wide a panel is.
        id: 'panel.grow',
        title: 'Make panel bigger',
        group: 'Panels',
        run: (c) => nudgeSize(c, 60)
      },
      {
        id: 'panel.shrink',
        title: 'Make panel smaller',
        group: 'Panels',
        run: (c) => nudgeSize(c, -60)
      },
      {
        id: 'panel.resetSize',
        title: 'Reset panel size',
        group: 'Panels',
        enabled: (c) => {
          const panel = c.lane.panels[c.lane.focus]
          return !!panel && (panel.width !== undefined || panel.height !== undefined)
        },
        run: (c) => c.setLane((l) => clearSize(l, l.focus))
      },
      {
        id: 'panel.close',
        title: 'Close panel',
        group: 'Panels',
        keys: '⌘W',
        enabled: (c) => c.lane.panels.length > 0,
        // Closing the chat lands on the launcher — see closePanel.
        run: (c) => c.setLane((l) => closePanel(l, l.focus, () => c.makePanel('branch')))
      },
      {
        id: 'panel.goto',
        title: 'Go to panel',
        group: 'Panels',
        keys: '⌘E / ⌘⇧E / ⌘K G',
        // Some panels read the checked-out tree — git status, the file list, a
        // patch — so without a worktree there is nothing for them to show. That
        // is a refusal with a reason, not a no-op: this used to return silently,
        // which made ⌘K F look like a broken binding.
        enabled: (c, arg) => c.canOpen(arg ?? 'projects'),
        unavailable: (c, arg) => c.whyCannotOpen(arg ?? 'projects'),
        // Open it, focus it, or — if it is already the focused one — put it away.
        run: (c, arg) => {
          const kind = arg ?? 'projects'
          c.setLane((l) => toggleKind(l, kind, () => c.makePanel(kind)))
        }
      },
      {
        id: 'cursor.down',
        title: 'Move cursor down',
        group: 'Cursor',
        keys: 'j / ↓',
        run: (c) => moveCursor(c, 1)
      },
      {
        id: 'cursor.up',
        title: 'Move cursor up',
        group: 'Cursor',
        keys: 'k / ↑',
        run: (c) => moveCursor(c, -1)
      },
      // gg and G are two presses in vim because `g` is a prefix there. Here it
      // is not: nothing else starts with it, so the first press already means
      // "top" and a second one would be a key you press for nothing.
      {
        id: 'cursor.top',
        title: 'Move cursor to the top',
        group: 'Cursor',
        keys: 'g',
        run: (c) => landOn(c, c.rowsOf(c.panelEl(c.lane.focus)), 0)
      },
      {
        id: 'cursor.bottom',
        title: 'Move cursor to the bottom',
        group: 'Cursor',
        run: (c) => {
          const rows = c.rowsOf(c.panelEl(c.lane.focus))
          landOn(c, rows, rows.length - 1)
        }
      },
      {
        id: 'cursor.halfDown',
        title: 'Move cursor half a screen down',
        group: 'Cursor',
        keys: '⌃D',
        run: (c) => moveCursor(c, pageStep(c, c.rowsOf(c.panelEl(c.lane.focus))))
      },
      {
        id: 'cursor.halfUp',
        title: 'Move cursor half a screen up',
        group: 'Cursor',
        keys: '⌃U',
        run: (c) => moveCursor(c, -pageStep(c, c.rowsOf(c.panelEl(c.lane.focus))))
      },
      {
        id: 'find.open',
        title: 'Search this panel',
        group: 'Cursor',
        keys: '/',
        run: (c) => c.openFind()
      },
      {
        id: 'find.next',
        title: 'Next match',
        group: 'Cursor',
        keys: 'n',
        run: (c) => c.findNext(1)
      },
      {
        id: 'find.prev',
        title: 'Previous match',
        group: 'Cursor',
        run: (c) => c.findNext(-1)
      },
      {
        id: 'scroll.down',
        title: 'Scroll down',
        group: 'Cursor',
        keys: '⌃J',
        run: (c) => scrollPanel(c, 1)
      },
      {
        id: 'scroll.up',
        title: 'Scroll up',
        group: 'Cursor',
        keys: '⌃K',
        run: (c) => scrollPanel(c, -1)
      },
      {
        id: 'composer.focus',
        title: 'Write a message',
        group: 'Chat',
        keys: 'i',
        // Which panels have a composer is a DOM question, not a list of kinds:
        // the chat has one and so does the branch launcher, and the next panel
        // that grows one would otherwise have to be remembered here too.
        enabled: (c) => !!findComposer(c),
        run: (c) => findComposer(c)?.focus()
      },
      {
        id: 'composer.leave',
        title: 'Leave the composer',
        group: 'Chat',
        keys: 'Esc',
        run: () => (document.activeElement as HTMLElement | null)?.blur()
      },
      {
        id: 'selection.toggle',
        title: 'Start or end line selection',
        group: 'Selection',
        keys: 'v',
        enabled: (c) => {
          const kind = c.lane.panels[c.lane.focus]?.kind
          return kind === 'diff' || kind === 'file'
        },
        run: (c) =>
          c.setLane((l) => {
            const panel = l.panels[l.focus]
            if (!panel) return l
            const at = panel.cursor ?? 0
            return patchPanel(l, l.focus, {
              selection: panel.selection ? null : { anchor: at, head: at }
            })
          })
      },
      {
        // Markdown only: every other file IS its source, so there is no second
        // way to read it and the chip would toggle between one thing and itself.
        id: 'diff.view',
        title: 'Read markdown as prose, or as a patch',
        group: 'Diff',
        keys: 'p',
        enabled: (c) => {
          const panel = c.lane.panels[c.lane.focus]
          return panel?.kind === 'diff' && READS_AS_PROSE.test(panel.sub ?? '')
        },
        run: (c) =>
          c.setLane((l) =>
            patchPanel(l, l.focus, {
              view: l.panels[l.focus]?.view === 'code' ? 'prose' : 'code',
              // The two views have different rows, so an index into one means
              // nothing in the other.
              cursor: 0,
              selection: null
            })
          )
      },
      {
        id: 'diff.nextChange',
        title: 'Go to the next change',
        group: 'Diff',
        keys: ']',
        run: (c) => stepChange(c, 1)
      },
      {
        id: 'diff.prevChange',
        title: 'Go to the previous change',
        group: 'Diff',
        keys: '[',
        run: (c) => stepChange(c, -1)
      },
      {
        id: 'selection.cancel',
        title: 'Cancel line selection',
        group: 'Selection',
        keys: 'Esc',
        run: (c) => c.setLane((l) => patchPanel(l, l.focus, { selection: null }))
      },
      {
        id: 'selection.comment',
        title: 'Send selected lines to the composer',
        group: 'Selection',
        keys: 'c',
        enabled: (c) => !!c.lane.panels[c.lane.focus]?.selection,
        run: (c) => commentOnSelection(c)
      },
      {
        id: 'palette.open',
        title: 'Switch project…',
        group: 'App',
        keys: '⌘/',
        run: (c) => c.openPalette()
      },
      {
        id: 'palette.commands',
        title: 'Show all commands',
        group: 'App',
        keys: '⌘⇧P',
        run: (c) => c.openCommands()
      },
      {
        id: 'palette.files',
        title: 'Find a chat or a file…',
        group: 'App',
        keys: '⌘P',
        // The list is the checked-out tree's, so it needs one — same refusal,
        // and the same sentence, as opening the Files panel. The chats would
        // survive without a worktree, but half a palette is not worth a second
        // set of rules for when the key works.
        enabled: (c) => c.canOpen('file'),
        unavailable: (c) => c.whyCannotOpen('file'),
        run: (c) => c.openFiles()
      },
      {
        // The account panel IS the login flow, so "sign in" and "who am I"
        // are the same command — there is nothing to run behind your back.
        id: 'auth.account',
        title: 'Sign in to Claude…',
        group: 'App',
        run: (c) => c.setLane((l) => toggleKind(l, 'account', () => c.makePanel('account')))
      },
      {
        // The scheduled poll is hours apart, so right after a release the machine
        // that published it would otherwise sit on the old version — or get the
        // new one hand-copied over a running bundle, which corrupts the asar
        // reads. This is the way to pull a release in on demand.
        id: 'update.check',
        title: 'Check for updates now',
        group: 'App',
        run: (c) => {
          void window.floe.checkForUpdate().then((message) => c.say(message))
        }
      },
      {
        // The only way a downloaded update ever gets applied: the main process
        // refuses to swap the bundle on quit, so quitting and reopening keeps
        // you on the old version. The banner's button dispatches this id.
        id: 'update.install',
        title: 'Restart to update…',
        group: 'App',
        enabled: (c) => !!c.pendingUpdate,
        unavailable: () => 'no update downloaded yet',
        run: () => {
          void window.floe.installUpdate()
        }
      },
      {
        // Manual fallback for the boot-time auto-registration (mcpServer.ts):
        // needed when Floe came up on a fallback port, or the `claude` CLI
        // appeared on PATH after launch.
        id: 'mcp.install',
        title: 'Install Floe MCP globally',
        group: 'App',
        run: (c) => {
          void window.floe.mcp.installGlobal().then((r) => c.say(r.message))
        }
      },
      {
        // The file is the setting's home; this is the way to flip it without
        // leaving the keyboard — and the way an agent flips it too, since every
        // registry command is an MCP `run_command`.
        id: 'composer.vim',
        title: 'Toggle vim motions in the composer',
        group: 'App',
        run: (c) => {
          void window.floe.config
            .get()
            .then((config) => window.floe.config.set('composer', 'vim', !config.composer.vim))
            .then((config) => c.say(config.composer.vim ? 'Vim motions on' : 'Vim motions off'))
            .catch((err: unknown) => c.say(reason(err)))
        }
      },
      {
        id: 'keybindings.reset',
        title: 'Reset keybindings to defaults…',
        group: 'App',
        run: () => {
          void window.floe.keybindings.reset()
        }
      },
      {
        id: 'editor.open',
        title: 'Edit in your editor',
        group: 'Files',
        keys: 'e',
        enabled: (c) => !!editTargetOf(c) && !!c.worktree,
        run: (c) => {
          const target = editTargetOf(c)
          const cwd = c.worktree?.path
          if (!target?.path || !cwd) return
          // The main process owns the choice: a terminal editor answers `panel`
          // and runs in the editor panel's PTY, a GUI one is already launching
          // by the time this resolves. The renderer must not keep its own list
          // of which editors are which.
          void window.floe.editor.launch(cwd, target.path, target.line).then((result) => {
            if (result.mode !== 'panel') return
            c.setLane((l) => open(l, c.makePanel('edit', editSub(target.path, target.line))))
          })
        }
      },
      {
        // `e` opens a file in your editor; this opens it in whatever the OS
        // thinks it is FOR — the browser for .html, the image viewer for a
        // .png, the spreadsheet for a .xlsx. Both lists mark their rows with
        // `data-file`, so the tree and the changes list share one command.
        id: 'file.open',
        title: 'Open in the default app',
        group: 'Files',
        keys: 'o',
        enabled: (c) => !!c.worktree && !!openTargetOf(c),
        unavailable: () => 'put the cursor on a file first',
        run: (c) => {
          const path = openTargetOf(c)
          const root = c.worktree?.path
          if (!path || !root) return
          void window.floe.files.open(root, path).catch((err: unknown) => c.say(reason(err)))
        }
      },
      {
        id: 'files.expand',
        title: 'Open directory',
        group: 'Cursor',
        keys: 'l',
        enabled: (c) => c.lane.panels[c.lane.focus]?.kind === 'files',
        run: (c) => {
          // The row already draws whether it is open, so the DOM answers this —
          // no need to lift a tree's expansion state into the lane just so a
          // key can read it. Clicking is what a mouse does here too, so both
          // routes go through exactly one toggle.
          const row = fileRow(c)
          if (row?.dataset.dir !== undefined && row.dataset.open === undefined) row.click()
        }
      },
      {
        id: 'files.root',
        title: 'Open folder here',
        group: 'Files',
        keys: '.',
        enabled: (c) =>
          c.lane.panels[c.lane.focus]?.kind === 'files' && fileRow(c)?.dataset.dir !== undefined,
        unavailable: () => 'put the cursor on a directory first',
        // The scope is the panel's `sub` — what every panel already uses for
        // "where this one is pointed", so the lane remembers it with the rest
        // of the session and the header can draw the path without being told.
        run: (c) => {
          const dir = fileRow(c)?.dataset.dir
          if (dir === undefined) return
          c.setLane((l) => patchPanel(l, l.focus, { sub: dir, cursor: 0 }))
        }
      },
      {
        id: 'files.unroot',
        title: 'Leave folder',
        group: 'Files',
        keys: '-',
        enabled: (c) => {
          const panel = c.lane.panels[c.lane.focus]
          return panel?.kind === 'files' && !!panel.sub
        },
        unavailable: () => 'the tree is already at the worktree',
        // One level out per press, so the way back mirrors the way in: `L` three
        // times deep is `H` three times back, and the last one lands on the
        // worktree rather than skipping the levels between.
        run: (c) => {
          const sub = c.lane.panels[c.lane.focus]?.sub ?? ''
          const cut = sub.lastIndexOf('/')
          c.setLane((l) =>
            patchPanel(l, l.focus, { sub: cut === -1 ? undefined : sub.slice(0, cut), cursor: 0 })
          )
        }
      },
      {
        id: 'files.collapse',
        title: 'Close directory',
        group: 'Cursor',
        keys: 'h',
        enabled: (c) => c.lane.panels[c.lane.focus]?.kind === 'files',
        run: (c) => {
          const row = fileRow(c)
          if (!row) return
          if (row.dataset.dir !== undefined && row.dataset.open !== undefined) return row.click()
          // Not on an open directory: go up to the one that contains this row.
          // `h` should never be a no-op — walking out of a directory is the
          // other half of walking into it.
          const parent = row.dataset.parent
          if (!parent) return
          const up = c.panelEl(c.lane.focus)?.querySelector<HTMLElement>(`[data-dir="${CSS.escape(parent)}"]`)
          up?.focus()
        }
      },
      {
        id: 'bash.copy',
        title: 'Copy this command',
        group: 'Chat',
        keys: 'y',
        enabled: (c) => !!bashCommand(c),
        run: (c) => {
          const command = bashCommand(c)
          if (!command) return
          void navigator.clipboard.writeText(command)
          c.say('Command copied.')
        }
      },
      {
        id: 'bash.run',
        title: 'Run this command in the terminal',
        group: 'Chat',
        keys: 'x',
        enabled: (c) => !!bashCommand(c) && !!c.worktree,
        // The same thing the ▶ on the row does, and the same thing a shell block
        // in a message does: open this worktree's terminal and type it in. The
        // terminal queues it if it is still attaching, so the panel opening and
        // the command arriving cannot race.
        run: (c) => {
          const command = bashCommand(c)
          const cwd = c.worktree?.path
          if (!command || !cwd) return
          c.setLane((l) => open(l, c.makePanel('terminal', cwd)))
          sendToTerminal(`term:${cwd}`, command)
        }
      },
      {
        id: 'files.rename',
        title: 'Rename file…',
        group: 'Files',
        keys: 'r',
        enabled: (c) => !!fileTarget(c) && !!c.worktree,
        run: (c) => {
          const path = fileTarget(c)
          const root = c.worktree?.path
          if (!path || !root) return
          const cut = path.lastIndexOf('/')
          const dir = cut === -1 ? '' : path.slice(0, cut)
          c.askText({
            placeholder: 'New name…',
            value: path.slice(cut + 1),
            verb: 'Rename to',
            // A name, not a path: this renames in place. Moving somewhere else
            // is `m`, and keeping the two apart is what makes `r` safe to press.
            onDone: (name) => applyOps(c, root, [{ kind: 'rename', from: path, to: join(dir, name) }])
          })
        }
      },
      {
        id: 'files.move',
        title: 'Move file…',
        group: 'Files',
        keys: 'm',
        enabled: (c) => !!fileTarget(c) && !!c.worktree,
        run: (c) => {
          const path = fileTarget(c)
          const root = c.worktree?.path
          if (!path || !root) return
          const cut = path.lastIndexOf('/')
          c.askText({
            placeholder: 'Destination directory…',
            value: cut === -1 ? '' : path.slice(0, cut),
            verb: 'Move to',
            // The directory, and the file keeps its name — the common move. A
            // rename on the way is `r` afterwards, or a path with a new last
            // segment, which `join` handles either way.
            onDone: (dest) =>
              applyOps(c, root, [{ kind: 'rename', from: path, to: join(dest, path.slice(cut + 1)) }])
          })
        }
      },
      {
        id: 'files.delete',
        title: 'Delete file…',
        group: 'Files',
        keys: 'd',
        enabled: (c) => !!fileTarget(c) && !!c.worktree,
        run: (c) => {
          const path = fileTarget(c)
          const root = c.worktree?.path
          if (!path || !root) return
          // This one really does delete from disk, so it says so — unlike
          // removing a project, which only forgets it.
          if (!window.confirm(`Delete "${path}" from the worktree? This removes it from disk.`)) return
          applyOps(c, root, [{ kind: 'delete', path }])
        }
      },
      {
        id: 'commands.open',
        title: 'Commands…',
        group: 'App',
        keys: '⌘K C',
        enabled: (c) => c.canOpen('commands'),
        unavailable: (c) => c.whyCannotOpen('commands'),
        run: (c) => c.setLane((l) => toggleKind(l, 'commands', () => c.makePanel('commands')))
      },
      {
        // The panel, not a palette: skills are things you keep, so the list has
        // to be somewhere you can act on it, not somewhere that closes the
        // moment you pick a row.
        id: 'skills.open',
        title: 'Skills…',
        group: 'App',
        run: (c) => c.setLane((l) => toggleKind(l, 'skills', () => c.makePanel('skills')))
      },
      {
        // Opens the panel if it is not up, then asks it for a draft row. The
        // naming happens in the list — see skillDraft.ts for why the command
        // only starts the flow.
        id: 'skill.new',
        title: 'New skill…',
        group: 'Skills',
        keys: 'n',
        run: (c) => {
          if (!c.lane.panels.some((p) => p.kind === 'skills')) {
            c.setLane((l) => open(l, c.makePanel('skills')))
          }
          startSkillDraft({ kind: 'new' })
        }
      },
      {
        id: 'skill.rename',
        title: 'Rename skill…',
        group: 'Skills',
        keys: 'r',
        enabled: (c) => !!skillRow(c),
        run: (c) => {
          const name = skillRow(c)?.dataset.skill
          // The row itself becomes the box. Renaming a skill renames the token
          // you type, and the main process moves the file and rewrites its
          // frontmatter so the two cannot disagree.
          if (name) startSkillDraft({ kind: 'rename', name })
        }
      },
      {
        id: 'skill.delete',
        title: 'Delete skill…',
        group: 'Skills',
        keys: 'd',
        enabled: (c) => !!skillRow(c),
        run: (c) => {
          const name = skillRow(c)?.dataset.skill
          if (!name) return
          // Like a file and unlike a project: this one really does remove from
          // disk, so it says the word.
          if (!window.confirm(`Delete the skill "${name}"? This removes the file from disk.`)) return
          void window.floe.skills.remove(name, c.worktree?.path).catch((err: unknown) => c.say(reason(err)))
        }
      },
      {
        id: 'skill.edit',
        title: 'Edit skill in your editor',
        group: 'Skills',
        keys: 'e',
        enabled: (c) => !!skillRow(c),
        run: (c) => {
          const row = skillRow(c)
          const root = row?.dataset.skillRoot
          const file = row?.dataset.skillFile
          if (root && file) c.editSkill(root, file)
        }
      },
      {
        // The panel, not a palette, for the reason skills got one: a drawing is
        // something you keep coming back to, and the list is where you name,
        // rename and throw one away.
        id: 'draw.open',
        title: 'Drawings…',
        group: 'App',
        keys: '⏎ / ⌘K D',
        enabled: (c) => c.canOpen('draw'),
        unavailable: (c) => c.whyCannotOpen('draw'),
        // On a row, open THAT drawing — the same thing ⏎ does, so the palette
        // and the key cannot mean two things. Otherwise open the list.
        run: (c) => {
          const row = drawRow(c)
          if (row) row.click()
          else c.setLane((l) => toggleKind(l, 'draw', () => c.makePanel('draw')))
        }
      },
      {
        // Opens the panel if it is not up, then asks for the name. It lands in
        // the branch's `specs/` folder — a drawing is part of the work, so it
        // travels with the branch and shows up in the commit rather than
        // sitting in a gitignored scratch directory nobody reviews. The verb on
        // the prompt names the folder, so where it goes is visible before you
        // type. `draw.promote` is how an older draft catches up.
        id: 'draw.new',
        title: 'New drawing…',
        group: 'Draw',
        keys: 'n',
        enabled: (c) => !!c.worktree,
        unavailable: () => 'draw — open a project first',
        run: (c) => {
          const worktree = c.worktree
          if (!worktree) return
          if (!c.lane.panels.some((p) => p.kind === 'draw')) {
            c.setLane((l) => open(l, c.makePanel('draw')))
          }
          c.askText({
            placeholder: 'Drawing name',
            verb: 'New drawing in specs/',
            onDone: (name) => {
              const clean = name.trim()
              if (!clean) return
              void window.floe.draw
                .create(worktree.path, clean, 'spec', worktree.branch)
                // Straight onto the canvas: you asked for a drawing, not for a
                // row that you then have to press Enter on.
                .then((file) => c.setLane((l) => open(l, c.makePanel('drawing', file.relPath))))
                .catch((err: unknown) => c.say(reason(err)))
            }
          })
        }
      },
      {
        id: 'draw.rename',
        title: 'Rename drawing…',
        group: 'Draw',
        keys: 'r',
        enabled: (c) => !!drawRow(c),
        run: (c) => {
          const rel = drawRow(c)?.dataset.drawing
          const root = c.worktree?.path
          if (!rel || !root) return
          const slash = rel.lastIndexOf('/')
          const dir = rel.slice(0, slash)
          const file = rel.slice(slash + 1)
          c.askText({
            placeholder: 'Drawing name',
            value: file.replace(/\.excalidraw$/, ''),
            verb: 'Rename to',
            onDone: (name) => {
              const clean = name.trim()
              if (!clean) return
              const to = `${dir}/${clean.endsWith('.excalidraw') ? clean : `${clean}.excalidraw`}`
              if (to !== rel) applyOps(c, root, [{ kind: 'rename', from: rel, to }])
            }
          })
        }
      },
      {
        id: 'draw.delete',
        title: 'Delete drawing…',
        group: 'Draw',
        keys: 'd',
        enabled: (c) => !!drawRow(c),
        run: (c) => {
          const rel = drawRow(c)?.dataset.drawing
          const root = c.worktree?.path
          if (!rel || !root) return
          // Like a file and unlike a project: this one really does remove from
          // disk, so it says the word.
          if (!window.confirm(`Delete "${rel}"? This removes the file from disk.`)) return
          applyOps(c, root, [{ kind: 'delete', path: rel }])
        }
      },
      {
        // The one drawing action that is not about this file but about where it
        // lives. Only offered on a draft, because a drawing already in specs/ is
        // where this would put it.
        id: 'draw.promote',
        title: 'Save drawing into the project',
        group: 'Draw',
        keys: 's',
        enabled: (c) => !!drawRow(c) && !drawRow(c)?.dataset.drawingGroup,
        unavailable: (c) => (drawRow(c) ? 'already in the project' : 'no drawing selected'),
        run: (c) => {
          const rel = drawRow(c)?.dataset.drawing
          const worktree = c.worktree
          if (!rel || !worktree) return
          void window.floe.draw
            .promote(worktree.path, rel, worktree.branch)
            // Follow it: the canvas showing the old path would be pointed at a
            // file that no longer exists, and you asked to keep working on this
            // drawing, not to close it.
            .then((file) => c.setLane((l) => open(l, c.makePanel('drawing', file.relPath))))
            .catch((err: unknown) => c.say(reason(err)))
        }
      },
      {
        // A .excalidraw is a portable file. This is how it gets to
        // excalidraw.com, or into a message, without Floe in the way.
        id: 'draw.reveal',
        title: 'Reveal drawing on disk',
        group: 'Draw',
        keys: 'o',
        enabled: (c) => !!drawRow(c),
        run: (c) => {
          const rel = drawRow(c)?.dataset.drawing
          const root = c.worktree?.path
          if (rel && root) void window.floe.draw.reveal(root, rel).catch((err: unknown) => c.say(reason(err)))
        }
      },
      {
        // The board's own session, in the same slot the card chats use (D7) —
        // never a second chat beside the first.
        id: 'colony.nanny',
        title: 'Ask the nanny',
        group: 'Colony',
        keys: 'Escape',
        enabled: (c) => !!c.project,
        unavailable: () => 'the nanny belongs to a project — open one first',
        run: (c) => {
          const project = c.project
          if (!project) return
          void window.floe.colony
            .nanny(project)
            .then((n) =>
              c.openChat({ id: n.sessionId, worktreePath: n.worktreePath }, n.fresh ? n.opener : undefined)
            )
            .catch((err: unknown) => c.say(reason(err)))
        }
      },
      {
        // There is deliberately no "new task" dialog (D8). `n` is the keyboard
        // path to the same place the header button goes: the nanny, with the
        // composer ready — she already knows the base branch, which stage is
        // full and what is queued ahead of it.
        id: 'colony.new',
        title: 'New task…',
        group: 'Colony',
        keys: 'n',
        enabled: (c) => !!c.project,
        unavailable: () => 'a task belongs to a project — open one first',
        run: (c) => {
          const project = c.project
          if (!project) return
          void window.floe.colony
            .nanny(project)
            .then((n) => {
              c.openChat({ id: n.sessionId, worktreePath: n.worktreePath }, n.fresh ? n.opener : undefined)
              // After the panel has mounted: the composer does not exist on the
              // frame the chat is opened in.
              setTimeout(() => findComposer(c)?.focus(), 60)
            })
            .catch((err: unknown) => c.say(reason(err)))
        }
      },
      {
        id: 'colony.left',
        title: 'Previous column',
        group: 'Colony',
        keys: 'h',
        run: (c) => colonyStep(c, -1)
      },
      {
        id: 'colony.right',
        title: 'Next column',
        group: 'Colony',
        keys: 'l',
        run: (c) => colonyStep(c, 1)
      },
      {
        // Two jobs, one intent — run this. On a backlog card it cuts the
        // worktree (which is why releasing is a key and not automatic: a card
        // nobody started has not paid for one). On a card a lane parked with a
        // reason, it puts it back at its stage's door.
        id: 'colony.start',
        title: 'Start this task',
        group: 'Colony',
        keys: 's',
        enabled: (c) => !!taskRow(c),
        unavailable: () => 'put the cursor on a task first',
        run: (c) => {
          const id = taskRow(c)?.dataset.task
          if (id) void window.floe.colony.release(id).catch((err: unknown) => c.say(reason(err)))
        }
      },
      {
        id: 'colony.archive',
        title: 'Archive this task',
        group: 'Colony',
        keys: 'x',
        enabled: (c) => !!taskRow(c),
        unavailable: () => 'put the cursor on a task first',
        run: (c) => {
          const id = taskRow(c)?.dataset.task
          const project = c.project
          if (!id || !project) return
          // The worktree is deliberately left standing. A card leaving the board
          // is a bookkeeping change; deleting a branch with work on it is not,
          // and the removal flow is where that question gets asked properly.
          void window.floe.colony.remove(id, project).catch((err: unknown) => c.say(reason(err)))
        }
      },
      {
        // The board IS its config file, so "edit stages" is the file — opened in
        // the reader every other file gets, rooted at the config dir.
        id: 'colony.stages',
        title: 'Edit the board\u2019s stages…',
        group: 'Colony',
        run: (c) => {
          void window.floe.config
            .paths()
            .then((paths) => c.setLane((l) => open(l, c.makePanel('edit', 'floe.toml', paths.dir))))
            .catch((err: unknown) => c.say(reason(err)))
        }
      },
      {
        // The panel, not a palette, for the reason skills got one: servers are
        // things you keep, and the list is where their state (connected /
        // needs-auth / off) is worth watching.
        id: 'mcp.open',
        title: 'MCP servers…',
        group: 'App',
        run: (c) => c.setLane((l) => toggleKind(l, 'mcp', () => c.makePanel('mcp')))
      },
      {
        // Opens the panel if it is not up, then asks it for a draft row — the
        // scope and the name happen in the list, see mcpDraft.ts.
        id: 'mcp.new',
        title: 'Add MCP server…',
        group: 'MCP',
        keys: 'n',
        run: (c) => {
          if (!c.lane.panels.some((p) => p.kind === 'mcp')) {
            c.setLane((l) => open(l, c.makePanel('mcp')))
          }
          startMcpDraft({ kind: 'new' })
        }
      },
      {
        // The row IS the file entry: editing a server is editing its mcp.toml,
        // opened in your editor rooted at the config directory it lives in.
        id: 'mcp.edit',
        title: 'Edit MCP server in your editor',
        group: 'MCP',
        keys: 'e',
        enabled: (c) => !!mcpRow(c),
        run: (c) => {
          const file = mcpRow(c)?.dataset.mcpFile
          if (!file) return
          const slash = file.lastIndexOf('/')
          c.editSkill(file.slice(0, slash), file.slice(slash + 1))
        }
      },
      {
        id: 'mcp.toggle',
        title: 'Enable/disable MCP server',
        group: 'MCP',
        keys: 't',
        enabled: (c) => !!mcpRow(c),
        run: (c) => {
          const row = mcpRow(c)
          const name = row?.dataset.mcp
          if (!name) return
          const enabled = row?.dataset.mcpEnabled === '1'
          void window.floe.mcp.servers
            .update(name, { enabled: !enabled }, c.worktree?.path)
            .catch((err: unknown) => c.say(reason(err)))
        }
      },
      {
        // `claude mcp login <name>` in a PTY (main/mcpAuth.ts): the consent URL
        // comes back over mcp:auth:event and the panel opens it in the browser.
        id: 'mcp.auth',
        title: 'Authenticate MCP server…',
        group: 'MCP',
        keys: 'a',
        enabled: (c) => !!mcpRow(c),
        run: (c) => {
          const name = mcpRow(c)?.dataset.mcp
          if (!name) return
          void window.floe.claude.authMcp(c.worktree?.path ?? window.floe.homeDir, name)
        }
      },
      {
        id: 'mcp.delete',
        title: 'Delete MCP server…',
        group: 'MCP',
        keys: 'd',
        enabled: (c) => !!mcpRow(c),
        run: (c) => {
          const name = mcpRow(c)?.dataset.mcp
          if (!name) return
          // Removes the entry from mcp.toml — the server itself is untouched,
          // but every future session loses it, so it still asks.
          if (!window.confirm(`Remove "${name}" from Floe's MCP registry?`)) return
          void window.floe.mcp.servers.remove(name, c.worktree?.path).catch((err: unknown) => c.say(reason(err)))
        }
      },
      {
        id: 'settings.open',
        title: 'Settings…',
        group: 'App',
        keys: '⌘,',
        run: (c) => c.setLane((l) => toggleKind(l, 'settings', () => c.makePanel('settings')))
      },
      {
        id: 'project.add',
        title: 'Add project…',
        group: 'App',
        keys: 'n',
        run: (c) => c.addProject()
      },
      {
        // The union is loaded per machine and a remote that is unreachable is
        // simply left out of it, so this is the way back once the network is
        // there again — without it the only retry was restarting the app.
        id: 'project.reload',
        title: 'Reload projects',
        group: 'App',
        keys: 'r',
        enabled: (c) => c.lane.panels[c.lane.focus]?.kind === 'projects',
        run: (c) => c.reloadProjects()
      },
      {
        id: 'group.create',
        title: 'New project group…',
        group: 'App',
        run: (c) => c.createGroup()
      },
      {
        id: 'project.move',
        title: 'Move project to group…',
        group: 'App',
        run: (c) => c.moveProject()
      },
      {
        // The row the cursor is on, not the current project: `d` acts on what
        // you are looking at, which is the only reading that matches the list.
        id: 'project.delete',
        title: 'Remove project from Floe…',
        group: 'App',
        keys: 'd',
        enabled: (c) => c.lane.panels[c.lane.focus]?.kind === 'projects',
        run: (c) => c.deleteProject()
      },
      {
        id: 'project.move.start',
        title: 'Move project between groups',
        group: 'App',
        keys: 'm',
        enabled: (c) => c.lane.panels[c.lane.focus]?.kind === 'projects',
        run: (c) => c.startMoveProject()
      },
      {
        id: 'project.move.down',
        title: 'Carry the held project down a group',
        group: 'App',
        keys: 'j',
        enabled: (c) => c.movingProject,
        run: (c) => c.stepMoveProject(1)
      },
      {
        id: 'project.move.up',
        title: 'Carry the held project up a group',
        group: 'App',
        keys: 'k',
        enabled: (c) => c.movingProject,
        run: (c) => c.stepMoveProject(-1)
      },
      {
        id: 'project.move.commit',
        title: 'Drop the held project in this group',
        group: 'App',
        keys: '↵',
        enabled: (c) => c.movingProject,
        run: (c) => c.endMoveProject(true)
      },
      {
        id: 'project.move.cancel',
        title: 'Put the held project back',
        group: 'App',
        keys: 'Esc',
        enabled: (c) => c.movingProject,
        run: (c) => c.endMoveProject(false)
      },
      {
        id: 'group.delete',
        title: 'Delete project group…',
        group: 'App',
        run: (c) => c.deleteGroup()
      },
      {
        id: 'session.new',
        title: 'New session',
        group: 'Sessions',
        keys: '⌘T',
        // A session with nothing said yet IS the launcher, so this opens it
        // rather than creating a record: an empty session persisted before you
        // type anything would litter the list with things you abandoned.
        enabled: (c) => !!c.worktree,
        run: (c) =>
          c.setLane((l) =>
            open(l, c.makePanel('branch', c.worktree?.branch))
          )
      },
      {
        // Newer and older, in the sidebar's own order — across every branch in
        // it, not just the open one. Ctrl, not a bare letter, for the same
        // reason ⌃H/⌃L are: this has to work mid-sentence in the composer,
        // which is where you are when you want the other session.
        id: 'session.prev',
        title: 'Newer session',
        group: 'Sessions',
        keys: '⌃I',
        enabled: (c) => !!c.worktree,
        run: (c) => c.cycleSession(-1)
      },
      {
        // vim's ⌃^: two chats, one key, back and forth. Not a history stack —
        // just the last one, which is the jump you actually make.
        id: 'session.alternate',
        title: 'Back to the last chat',
        group: 'Sessions',
        keys: '⌃W',
        enabled: (c) => !!c.alternateSession,
        run: (c) => c.alternateSession?.()
      },
      {
        id: 'session.next',
        title: 'Older session',
        group: 'Sessions',
        keys: '⌃O',
        enabled: (c) => !!c.worktree,
        run: (c) => c.cycleSession(1)
      },
      {
        // Read it later. The dot the sidebar already draws for an answer that
        // arrived while you were elsewhere is the same dot — this just lets you
        // put it back by hand, on a chat you opened, skimmed and cannot deal
        // with yet.
        //
        // A toggle, because the mark has exactly two states and one key for
        // both is how `x` behaves two rows down. Marking the chat that is OPEN
        // is the common case, and it survives being open — see unreadStore's
        // hold — until you go somewhere else.
        id: 'session.unread',
        title: 'Mark this chat unread, or read',
        group: 'Sessions',
        keys: 'u / ⌘⇧U',
        enabled: (c) => !!unreadTarget(c),
        unavailable: () => 'put the cursor on a session, or open a chat',
        run: (c) => {
          const at = unreadTarget(c)
          if (!at) return
          if (isUnread(at.keys)) return markRead(at.keys)
          markUnread(at.keys, { open: at.open })
          // Only for the chat you are IN: there the dot lands on a row you are
          // not looking at, and may not even be on screen. Marking a row in the
          // list needs no toast — the dot appears under the cursor.
          if (at.open) c.say('marked unread — read it later')
        }
      },
      {
        // "Delete" is Floe's record of the session, not the conversation:
        // the Claude transcript stays on disk and `claude --resume` still finds
        // it. Same call the sidebar's close uses — one way to forget a session.
        id: 'session.delete',
        title: 'Delete session…',
        group: 'Sessions',
        keys: '⌘⇧W',
        enabled: (c) => c.lane.panels.some((p) => p.session),
        run: (c) => c.deleteSession()
      },
      {
        // The same forget, in bulk, over the sessions of the worktree the open
        // chat belongs to — the sidebar's list, not every session in the app.
        id: 'session.deleteOthers',
        title: 'Delete other sessions on this worktree…',
        group: 'Sessions',
        enabled: (c) => c.lane.panels.some((p) => p.session),
        run: (c) => c.deleteSession('others')
      },
      {
        id: 'session.deleteAll',
        title: 'Delete all sessions on this worktree…',
        group: 'Sessions',
        enabled: (c) => !!c.worktree || c.lane.panels.some((p) => p.session),
        run: (c) => c.deleteSession('all')
      },
      // --- queries ---------------------------------------------------------
      // A query is a conversation running beside this one. Every one of these
      // acts on the query panel the lane is focused on, falling back to the
      // only one open — so the keys work whether you are typing in the query or
      // watching from the chat, which is the whole point of it being parallel.
      {
        id: 'query.open',
        title: 'Ask another harness…',
        group: 'Queries',
        enabled: (c) => !!chatOf(c),
        run: (c) => {
          const chat = chatOf(c)
          if (!chat?.session) return
          c.askText({
            placeholder: 'harness — codex, claude, opencode',
            verb: 'Open query with',
            onDone: (harness) => {
              const name = harness.trim().replace(/^@/, '')
              if (!name) return
              void window.floe.query
                .open(chat.session!.id, chat.session!.worktreePath, name)
                // The panel arrives on the `query:opened` announcement, not
                // from here: a query is born on four doors and only one of them
                // has a person in front of it.
                .then((r) => r.error && c.say(r.error))
                .catch((e) => c.say(reason(e)))
            }
          })
        }
      },
      {
        id: 'query.focus',
        title: 'Go to the query',
        group: 'Queries',
        enabled: (c) => queryIndex(c) !== -1,
        run: (c) => {
          const at = queryIndex(c)
          if (at !== -1) c.setLane((l) => focusAt(l, at))
        }
      },
      {
        // The chat reads what it has not read of the query. Nothing closes —
        // that is what makes peek different from merge, and why it has its own
        // key rather than being merge with a modifier.
        id: 'query.peek',
        title: 'Peek: let the chat read the query',
        group: 'Queries',
        keys: '⌘⇧G',
        enabled: (c) => queryPanels(c).length > 0,
        run: (c) => runQuery(c, 'peek')
      },
      {
        id: 'query.merge',
        title: 'Merge the query into the chat',
        group: 'Queries',
        keys: '⌘⇧M',
        enabled: (c) => queryPanels(c).length > 0,
        run: (c) => runQuery(c, 'merge')
      },
      {
        // Its own binding, deliberately NOT ⌘W. Closing a panel and throwing a
        // conversation away are different things, and one key for both would
        // make the safe habit destructive.
        id: 'query.discard',
        title: 'Discard the query',
        group: 'Queries',
        keys: '⌘⇧D',
        enabled: (c) => queryPanels(c).length > 0,
        run: (c) => runQuery(c, 'discard')
      },
      {
        // The way back from ⌘W, for all of them at once — the dock row is the
        // same move for one. Closing a query's panel does not end the query
        // (that is what merge and discard are for), so a conversation can be
        // running with nothing on screen naming it; this puts every one of them
        // back beside the chat.
        id: 'query.showAll',
        title: 'Show every open query',
        group: 'Queries',
        enabled: (c) => !!chatOf(c),
        run: (c) => {
          const chat = chatOf(c)
          if (!chat?.session) return
          const { id, worktreePath } = chat.session
          void window.floe.query
            .list(id)
            .then((all) => {
              // Open ones only: a merged or discarded query is over, and
              // `reopen` is the door back to one of those.
              const live = all.filter((q) => !q.outcome)
              if (!live.length) return c.say('No queries open here.')
              c.setLane((l) =>
                live.reduce(
                  (lane, q) =>
                    open(lane, {
                      ...c.makePanel('query', q.harness),
                      session: { id: q.id, worktreePath }
                    }),
                  l
                )
              )
            })
            .catch((e) => c.say(reason(e)))
        }
      },
      {
        // Both docks in the corner — the queries and the lanes — because ⌥A
        // means "get the corner out of the way" and one key for one corner is
        // the whole of it. Enabled unconditionally: each dock draws itself only
        // when it has rows, so there is nothing to check that it has not
        // already decided, and a greyed-out row would be answering a question
        // about a panel the user cannot see.
        id: 'subagents.toggle',
        title: 'Fold / unfold the dock',
        group: 'Queries',
        keys: '⌥A',
        run: () => toggleSubagentDock()
      },
      {
        // The way back from a discard. The conversation is still on disk under
        // its own key — the dead line in the chat is what remembers it.
        id: 'query.reopen',
        title: 'Reopen a discarded query…',
        group: 'Queries',
        enabled: (c) => !!chatOf(c),
        run: (c) => {
          const chat = chatOf(c)
          if (!chat?.session) return
          void window.floe.query
            .list(chat.session.id)
            .then((all) => {
              const closed = all.filter((q) => q.outcome)
              if (!closed.length) return c.say('No closed queries here.')
              c.askText({
                placeholder: closed.map((q) => q.harness).join(', '),
                verb: 'Reopen query with',
                onDone: (harness) => {
                  const found = closed.find((q) => q.harness === harness.trim().replace(/^@/, ''))
                  if (!found) return c.say(`No closed query with ${harness}.`)
                  void window.floe.query
                    .reopen(found.id)
                    .then((r) => r.error && c.say(r.error))
                    .catch((e) => c.say(reason(e)))
                }
              })
            })
            .catch((e) => c.say(reason(e)))
        }
      },
      {
        // `@all` without typing it. The message is whatever is in the composer
        // — this only puts the handle in front of it, so the one rule that
        // reads it stays the one in mentions.ts.
        id: 'chat.all',
        title: 'Ask several harnesses at once (@all)',
        group: 'Queries',
        enabled: (c) => !!chatOf(c),
        run: (c) => {
          const el = findComposer(c)
          if (!el) return
          el.focus()
          // Typed through the DOM rather than through React state, because the
          // registry has no handle on the draft — and `input` is what the
          // composer already listens to, so the mirror and the trigger menu
          // update exactly as they would if you had typed it.
          const at = el.selectionStart ?? 0
          el.setRangeText('@all ', 0, at === 0 ? 0 : 0, 'end')
          el.dispatchEvent(new Event('input', { bubbles: true }))
        }
      },
      {
        // The housekeeping one, and the only session command that is not about
        // the worktree you are in: it sweeps the whole open project, because a
        // chat you abandoned an hour ago is just as dead on the branch next
        // door. Nothing to sweep says so rather than opening a confirm.
        id: 'session.deleteIdle',
        title: 'Delete sessions idle for over an hour…',
        group: 'Sessions',
        run: (c) => c.deleteSession('idle')
      },
      {
        // A tick, not a range. The sessions worth clearing out are scattered
        // down the list and across branches, so `v`'s contiguous selection —
        // which is what `selection.toggle` offers a diff — would be the wrong
        // shape: you would have to tick the ones in between and then untick
        // them again.
        id: 'session.mark',
        title: 'Select or unselect this session',
        group: 'Sessions',
        keys: 'x',
        // A DOM question, like `project.delete`'s: the branch rows are cursor
        // rows too, and there is nothing on one to tick.
        enabled: (c) => !!sessionOnRow(c),
        unavailable: () => 'put the cursor on a session — a branch has nothing to select',
        run: (c) => {
          const at = sessionOnRow(c)
          if (at) c.markSession(at, 'toggle')
        }
      },
      {
        id: 'session.markClear',
        title: 'Unselect every session',
        group: 'Sessions',
        keys: 'Esc',
        enabled: (c) => c.markedSessions.length > 0,
        unavailable: () => 'no session is selected',
        run: (c) => c.clearMarkedSessions()
      },
      {
        // One key for both, because they are one question: `d` deletes what is
        // ticked, and with nothing ticked the row you are on IS the selection
        // of one. Splitting them would leave `d` dead on a list you had not
        // ticked anything in yet, which is the common case.
        id: 'session.deleteMarked',
        title: 'Delete the selected sessions…',
        group: 'Sessions',
        keys: 'd',
        enabled: (c) => c.markedSessions.length > 0 || !!sessionOnRow(c),
        unavailable: () => 'select a session first, or put the cursor on one',
        run: (c) => c.deleteSession('marked')
      },
      {
        id: 'worktree.new',
        title: 'New worktree',
        group: 'Worktrees',
        keys: '⌘N',
        run: (c) => c.newWorktree()
      },
      // --- guided merge ---------------------------------------------------
      // Everything the checklist offers is a command: its chips dispatch these
      // ids, and so do ⏎ / r / s / esc over the panel.
      {
        id: 'worktree.merge',
        title: 'Merge worktree into its base',
        group: 'Worktrees',
        keys: '⌘K M',
        enabled: (c) => !!c.worktree,
        unavailable: () => 'no worktree to merge — open one first',
        run: (c) => c.merge.start()
      },
      {
        id: 'merge.confirm',
        // One key for the one thing the checklist is waiting for: it stops
        // either at the review checkpoint or on a failed step, never both.
        title: 'Merge: approve, or retry the failed step',
        group: 'Worktrees',
        keys: '⏎',
        enabled: (c) => c.merge.awaitingReview || c.merge.failed,
        unavailable: () => 'the merge is not waiting on you',
        run: (c) => (c.merge.failed ? c.merge.retry() : c.merge.approve())
      },
      {
        id: 'merge.review',
        title: 'Merge: review the changes',
        group: 'Worktrees',
        keys: 'r',
        // The flow stays paused at the checkpoint — this only puts the diff on
        // screen, so approving is still a deliberate second key.
        enabled: (c) => c.merge.awaitingReview && c.canOpen('changes'),
        unavailable: (c) =>
          c.merge.awaitingReview ? c.whyCannotOpen('changes') : 'the merge is not waiting on a review',
        run: (c) => c.setLane((l) => toggleKind(l, 'changes', () => c.makePanel('changes')))
      },
      {
        id: 'merge.stash',
        title: 'Merge: stash the uncommitted changes and retry',
        group: 'Worktrees',
        keys: 's',
        enabled: (c) => c.merge.canStash,
        unavailable: () => 'nothing to stash — the merge is not blocked on a dirty tree',
        run: (c) => c.merge.stashRetry()
      },
      {
        id: 'merge.cancel',
        title: 'Merge: cancel',
        group: 'Worktrees',
        keys: 'esc',
        enabled: (c) => c.merge.active,
        unavailable: () => 'no merge running',
        // What git has already done stays done — this drops the checklist, it
        // does not roll the merge back.
        //
        // The panel goes with it: a dismissed merge leaves an empty checklist
        // holding the focus, which is exactly the stranded focus the
        // keyboard-first rule is about.
        run: (c) => {
          c.merge.cancel()
          c.setLane((l) => {
            const at = l.panels.findIndex((p) => p.kind === 'merge')
            return at === -1 ? l : close(l, at)
          })
        }
      },
      // --- guided remove --------------------------------------------------
      // Same rule as the merge above: the panel's chips dispatch these ids, and
      // so do ⏎ / esc over it.
      {
        id: 'worktree.remove',
        title: 'Remove worktree and delete its branch',
        group: 'Worktrees',
        keys: '⌘K X',
        enabled: (c) => !!c.worktree,
        unavailable: () => 'no worktree to remove — open one first',
        run: (c) => c.remove.start()
      },
      {
        id: 'remove.confirm',
        // One key for the one thing the checklist is waiting for: it stops
        // either at the force checkpoint or on a failed step, never both.
        title: 'Remove: force past the dirty tree, or retry the failed step',
        group: 'Worktrees',
        keys: '⏎',
        enabled: (c) => c.remove.awaitingForce || c.remove.failed,
        unavailable: () => 'the removal is not waiting on you',
        run: (c) => (c.remove.failed ? c.remove.retry() : c.remove.force())
      },
      {
        id: 'remove.cancel',
        title: 'Remove: cancel',
        group: 'Worktrees',
        keys: 'esc',
        enabled: (c) => c.remove.active,
        unavailable: () => 'no removal running',
        // What git has already removed stays removed — this drops the checklist,
        // it does not put the worktree back.
        //
        // The panel goes with it, like the merge's: a dismissed checklist
        // holding the focus is the stranded focus the keyboard-first rule is
        // about.
        run: (c) => {
          c.remove.cancel()
          c.setLane((l) => {
            const at = l.panels.findIndex((p) => p.kind === 'remove')
            return at === -1 ? l : close(l, at)
          })
        }
      },
      // --- worktree provisioning ------------------------------------------
      // The environment a worktree needs to run: .env, dependencies, site,
      // database. Runs itself on create; these are the ways back to it.
      {
        id: 'worktree.provision',
        title: 'Set up this worktree’s environment',
        group: 'Worktrees',
        keys: '⌘K W',
        enabled: (c) => !!c.worktree,
        unavailable: () => 'no worktree to set up — open one first',
        // Every step is idempotent, so this is also the repair: run it on a
        // worktree that was created before the app provisioned anything, or one
        // whose install died halfway.
        run: (c) => c.provision.start()
      },
      {
        id: 'provision.confirm',
        title: 'Provision: retry from the failed step',
        group: 'Worktrees',
        keys: '⏎',
        enabled: (c) => c.provision.idle,
        unavailable: () => 'the setup is still running',
        run: (c) => c.provision.retry()
      },
      {
        id: 'provision.cancel',
        title: 'Provision: hide the checklist',
        group: 'Worktrees',
        keys: 'esc',
        enabled: (c) => c.provision.active,
        unavailable: () => 'no setup to hide',
        // Only the checklist goes. The steps run in main and carry on — this is
        // "stop showing me", not "stop".
        run: (c) => {
          c.provision.dismiss()
          c.setLane((l) => {
            const at = l.panels.findIndex((p) => p.kind === 'provision')
            return at === -1 ? l : close(l, at)
          })
        }
      },
      // --- project setup --------------------------------------------------
      // The setup checklist, same rule again: its chips dispatch these ids, and
      // so do ⏎ / esc over the panel.
      {
        id: 'setup.start',
        title: 'Set up this project\u2019s commands',
        group: 'Projects',
        enabled: (c) => c.setup.canStart,
        unavailable: () => 'no project open',
        // Also the way in for a project added before this flow existed: the
        // preflight ends it right away when the commands are already there.
        run: (c) => c.setup.start()
      },
      {
        id: 'setup.retry',
        title: 'Setup: retry the failed step',
        group: 'Projects',
        keys: 'r',
        enabled: (c) => c.setup.failed,
        unavailable: () => 'the setup has not failed',
        run: (c) => c.setup.retry()
      },
      {
        id: 'setup.chat',
        title: 'Setup: open the session\u2019s chat',
        group: 'Projects',
        keys: '\u23ce',
        // The session runs in the background (D1), so this is the only way to
        // the question it is waiting on.
        enabled: (c) => c.setup.awaitingChoice,
        unavailable: () => 'the setup is not waiting on you',
        run: (c) => c.setup.openChat()
      },
      {
        id: 'setup.cancel',
        title: 'Setup: cancel',
        group: 'Projects',
        keys: 'esc',
        enabled: (c) => c.setup.active,
        unavailable: () => 'no setup running',
        // The session stays where it is — this drops the checklist, it does not
        // stop the agent. The panel goes with it, like the merge's and the
        // removal's: a dismissed checklist holding the focus is the stranded
        // focus the keyboard-first rule is about.
        run: (c) => {
          c.setup.cancel()
          c.setLane((l) => {
            const at = l.panels.findIndex((p) => p.kind === 'setup')
            return at === -1 ? l : close(l, at)
          })
        }
      },
      {
        id: 'command.run',
        title: 'Run command',
        group: 'Commands',
        keys: 'r',
        enabled: (c) => !!commandTarget(c),
        unavailable: () => 'no command under the cursor',
        // One key for both, because the question you are answering is "run
        // this" either way — a running command restarts, a stopped one starts.
        run: (c) => {
          const id = commandTarget(c)
          if (!id) return
          if (commandLive(c)) c.commands.restart(id)
          else c.commands.start(id)
        }
      },
      {
        id: 'command.stop',
        title: 'Stop command',
        group: 'Commands',
        keys: 's',
        enabled: (c) => commandLive(c),
        unavailable: (c) => (commandTarget(c) ? 'that command is not running' : 'no command under the cursor'),
        run: (c) => {
          const id = commandTarget(c)
          if (id) c.commands.stop(id)
        }
      },
      {
        id: 'command.restart',
        title: 'Restart command',
        group: 'Commands',
        enabled: (c) => !!commandTarget(c),
        unavailable: () => 'no command under the cursor',
        run: (c) => {
          const id = commandTarget(c)
          if (id) c.commands.restart(id)
        }
      },
      {
        id: 'command.logs',
        title: 'Show command output',
        group: 'Commands',
        keys: '⏎',
        enabled: (c) => !!commandTarget(c) && !!c.worktree,
        unavailable: () => 'no command under the cursor',
        run: (c) => {
          const id = commandTarget(c)
          if (!id || !c.worktree) return
          c.setLane((l) => open(l, c.makePanel('cmdlog', `${c.worktree?.path}#${id}`)))
        }
      },
      {
        id: 'command.runAll',
        title: 'Run every stopped command',
        group: 'Commands',
        enabled: (c) => c.commands.list.length > 0,
        unavailable: () => 'this worktree has no commands',
        run: (c) => c.commands.startAll()
      },
      {
        id: 'command.stopAll',
        title: 'Stop every running command',
        group: 'Commands',
        enabled: (c) => c.commands.list.some((x) => c.commands.runOf(x.id)?.state === 'running'),
        unavailable: () => 'nothing running in this worktree',
        run: (c) => {
          for (const x of c.commands.list) c.commands.stop(x.id)
        }
      },
      {
        id: 'command.add',
        title: 'Add command…',
        group: 'Commands',
        keys: 'a',
        enabled: (c) => !!c.worktree,
        unavailable: () => 'no worktree open',
        // Two prompts rather than a form: the palette is what the app already
        // uses to ask for one line, and a name and a command line are two.
        run: (c) => {
          c.askText({
            placeholder: 'Name…',
            verb: 'Call it',
            onDone: (name) => {
              if (!name.trim()) return
              c.askText({
                placeholder: 'Command to run…',
                verb: 'Run',
                onDone: (command) => {
                  if (!command.trim()) return
                  void c.commands.add(name, command)
                }
              })
            }
          })
        }
      },
      {
        id: 'command.edit',
        title: 'Edit command…',
        group: 'Commands',
        keys: 'e',
        enabled: (c) => !!commandTarget(c),
        unavailable: () => 'no command under the cursor',
        run: (c) => {
          const id = commandTarget(c)
          const cmd = c.commands.list.find((x) => x.id === id)
          if (!id || !cmd) return
          c.askText({
            placeholder: 'Command to run…',
            value: cmd.command,
            verb: 'Run',
            onDone: (command) => {
              if (command.trim()) void c.commands.update(id, { command })
            }
          })
        }
      },
      {
        id: 'command.rename',
        title: 'Rename command…',
        group: 'Commands',
        // Deliberately refused while it runs: the id is the slug of the name
        // (see commandStore), so renaming re-keys the command and the output
        // panel loses the process it was showing — which keeps running, and
        // which you can then no longer stop by name.
        enabled: (c) => !!commandTarget(c) && !commandLive(c),
        unavailable: (c) =>
          commandLive(c) ? 'stop it first — renaming a running command orphans its output' : 'no command under the cursor',
        run: (c) => {
          const id = commandTarget(c)
          const cmd = c.commands.list.find((x) => x.id === id)
          if (!id || !cmd) return
          c.askText({
            placeholder: 'Name…',
            value: cmd.name,
            verb: 'Call it',
            onDone: (name) => {
              if (name.trim()) void c.commands.update(id, { name })
            }
          })
        }
      },
      {
        id: 'command.scope',
        title: 'Move command between project and this worktree',
        group: 'Commands',
        enabled: (c) => !!commandTarget(c),
        unavailable: () => 'no command under the cursor',
        // A toggle, not two commands: "shared by the project" and "only here"
        // are the two halves of one question.
        run: (c) => {
          const id = commandTarget(c)
          const cmd = c.commands.list.find((x) => x.id === id)
          if (!id || !cmd) return
          void c.commands.setScope(id, cmd.scope === 'project' ? 'local' : 'project')
        }
      },
      {
        id: 'command.delete',
        title: 'Delete command…',
        group: 'Commands',
        keys: 'd',
        enabled: (c) => !!commandTarget(c),
        unavailable: () => 'no command under the cursor',
        // Stopped first: deleting the row while the process runs would leave it
        // running with nothing left in the UI that can name it.
        run: (c) => {
          const id = commandTarget(c)
          const cmd = c.commands.list.find((x) => x.id === id)
          if (!id || !cmd) return
          c.askText({
            placeholder: `Delete "${cmd.name}"? Type y to confirm`,
            verb: 'Delete',
            onDone: (answer) => {
              if (answer.trim().toLowerCase() !== 'y') return
              c.commands.stop(id)
              void c.commands.remove(id)
            }
          })
        }
      },
      {
        id: 'backend.use',
        title: 'Attach backend…',
        group: 'Backends',
        // With an id (the MCP path) it switches directly; bare, App offers the
        // picker. Switching remounts the tree so every panel refetches from the
        // new machine — how is App's business, not the registry's.
        run: (c, arg) => c.useBackend(arg)
      },
      {
        id: 'palette.chord',
        title: 'Command palette',
        group: 'App',
        keys: '⌘K',
        // ponytail: the chord is handled in the key dispatcher today. When the
        // palette exists this opens it, and ⌘K G stays a shortcut through it.
        run: () => {}
      }
    ] satisfies Command[]
  ).map((c) => [c.id, c])
)

