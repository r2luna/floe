import {
  IconGitCompare,
  IconLayoutColumns,
  IconLayoutRows,
  IconX
} from '@tabler/icons-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { loadChoice, type ModelChoice } from './models'
import type { Lane, Panel } from './lane'
import {
  clearSize,
  close,
  closePanel,
  columnsOf,
  focusAt,
  laneOf,
  open,
  patchPanel,
  resizePanel,
  setCursor,
  toggleDock,
  toggleKind
} from './lane'
import { quoteSelection, parseUnifiedDiff, selRange } from './diff'
import { KINDS, RAIL, PanelBody, needsProject, panelForFile, type PanelKind } from './panels'
import { editTarget } from './editorTarget'
import { resolveKey } from './keys'
import { installPluginCommands, runCommand, type CommandContext } from './commands'
import { REGISTRY } from './registry'
import { Palette } from './Palette'
import {
  load as loadLane,
  remember,
  rememberSession,
  rememberWorktree,
  save as saveLane,
  scopedOf,
  sessionKeyOf,
  withScoped
} from './laneStore'
import { setKeymap } from './keys'
import { useAppearance } from './appearance'
import { compileKeymap, formatChord, type Keybind } from '../../shared/keymap'
import { listCommands } from './commands'
import { AddProject } from './AddProject'
import type { NewWorktreeProps } from './NewWorktree'
import { useProjects } from './useProjects'
import { moveTargets, stepGroup } from './projectMove'
import { useWorktrees } from './useWorktrees'
import { useChanges } from './useChanges'
import { useCommands } from './useCommands'
import { useMerge } from './useMerge'
import { useMenuItems } from './useMenuItems'
import { usePendingUpdate } from './useUpdate'
import type { PaletteItem } from './fuzzy'
import { DEFAULT_GROUP, type ContextUsage, type McpCommand, type Project } from '../../shared/types'


/**
 * The rows a query matches, by index.
 *
 * Matching is on the row's TEXT, and on its content where the row has a
 * separate part for it: a file line renders its number beside it, so a search
 * for `2` would otherwise hit every twentieth line before the first match.
 */
function matchingRows(rows: HTMLElement[], q: string): number[] {
  const text = (row: HTMLElement): string =>
    ((row.querySelector('.diff-code, .md-text, .row-name') ?? row).textContent ?? '').toLowerCase()
  return rows.flatMap((row, i) => (text(row).includes(q) ? [i] : []))
}

const panelOf = (
  kind: PanelKind,
  sub?: string,
  session?: { id: string; worktreePath: string },
  firstPrompt?: string,
  firstChoice?: ModelChoice
): Panel => ({
  // The session id, not the title, makes a chat panel unique — two sessions can
  // share a title and would otherwise collapse into one panel.
  id: session ? `chat:${session.id}` : `${kind}:${sub ?? ''}`,
  kind,
  title: KINDS[kind].title,
  sub,
  session,
  firstPrompt,
  firstChoice,
  order: KINDS[kind].order,
  slot: 'slot' in KINDS[kind] ? (KINDS[kind] as { slot?: string }).slot : undefined
})

const compact = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(n >= 100_000 ? 1 : 0)}K`
      : String(n)

/** What a chat panel reports about its own context. */
export interface Usage {
  used: number
  /** The model's window. Absent when the runtime does not state one. */
  max?: number
  /** Which model these numbers belong to. */
  label: string
  /**
   * Where the context went, fetched on demand. Only Claude can answer — it is
   * `/context`, its own report — so the gauge opens for it and stays a plain
   * number for everyone else rather than inventing categories.
   */
  breakdown?: () => Promise<ContextUsage>
}

/**
 * Context usage in the panel header.
 *
 * The bar answers the question the number can't at a glance — how close to the
 * wall am I — and it warms up as it fills, because "800k/1000k" and
 * "116k/1000k" read identically in a dim mono font.
 *
 * The denominator belongs to whoever is answering: a 262k local model is not
 * measured against Claude's million. When the runtime states no window there is
 * no bar and no fraction — just the count, because a percentage of an unknown
 * total is a made-up number.
 */
function ContextMeter({ usage }: { usage: Usage }) {
  const pct = usage.max ? Math.min(usage.used / usage.max, 1) : 0
  const level = pct >= 0.9 ? 'high' : pct >= 0.7 ? 'warn' : undefined
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<ContextUsage | null>(null)

  // Asked for only when opened, and re-asked each time: the answer is about
  // the conversation as it is now, and it costs a probe to get.
  useEffect(() => {
    if (!open || !usage.breakdown) return
    let live = true
    setDetail(null)
    void usage
      .breakdown()
      .then((d) => live && setDetail(d))
      .catch(() => live && setDetail({ categories: [], error: 'could not read /context' }))
    return () => {
      live = false
    }
  }, [open, usage.breakdown])

  // Escape closes, and a click anywhere else does too — a panel that can only
  // be dismissed by hitting the same small target again is a trap.
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', close)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', close)
    }
  }, [open])

  const bar = (
    <>
      {usage.max && (
        <span className="ctx-bar">
          <span className="ctx-fill" style={{ width: `${pct * 100}%` }} />
        </span>
      )}
      {compact(usage.used)}
      {usage.max ? `/${compact(usage.max)}` : ''}
    </>
  )

  // Nothing to open is not a button: a control that does nothing when pressed
  // is worse than plain text saying the same thing.
  if (!usage.breakdown) {
    return (
      <span className="ctx-wrap">
        <span className="ctx-meter" data-level={level} title={`Context — ${usage.label}`}>
          {bar}
        </span>
      </span>
    )
  }

  return (
    <span className="ctx-wrap" onPointerDown={(e) => e.stopPropagation()}>
      <button
        className="ctx-meter"
        data-level={level}
        data-open={open || undefined}
        title={`Context — ${usage.label}`}
        onClick={() => setOpen(!open)}
      >
        {bar}
      </button>

      {open && (
        <div className="ctx-pop">
          <div className="ctx-pop-head">
            <span className="ctx-pct">{Math.round(pct * 100)}% full</span>
            <span className="ctx-total">{usage.label}</span>
          </div>
          {!detail && <p className="ctx-empty">Reading /context…</p>}
          {detail?.error && <p className="ctx-empty">{detail.error}</p>}
          {detail && !detail.error && (
            <ul className="ctx-list">
              {detail.categories.map((c) => (
                <li key={c.label}>
                  <span className="ctx-label">{c.label}</span>
                  <span className="ctx-count">{compact(c.tokens)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </span>
  )
}

/**
 * Whether ⌃J/⌃K have a stacked panel to move to from `focus` — the same
 * question the keymap asks before deciding between moving and scrolling.
 * A plain array lookup rather than a lane-side helper: this is a DOM-facing
 * concern (what the keymap needs), not a fact about the lane itself.
 */
function stackNeighbours(
  columns: { panel: Panel; index: number }[][],
  focus: number
): { stackDown: boolean; stackUp: boolean } {
  const col = columns.find((c) => c.some((p) => p.index === focus))
  const row = col?.findIndex((p) => p.index === focus) ?? -1
  return { stackDown: !!col && row < col.length - 1, stackUp: row > 0 }
}

/**
 * The grab handle between two panels.
 *
 * It sits on the edge as an overlay rather than as a flex child, so adding one
 * changes no layout — a lane with handles and a lane without lay out identically.
 *
 * The size is written straight to the DOM while you drag and only committed to
 * the lane when you let go. Putting every mouse move through React state would
 * mean a re-render and a localStorage write per frame to animate something the
 * browser can do by itself.
 */
function Splitter({
  axis,
  size,
  apply,
  invert
}: {
  axis: 'x' | 'y'
  /** The size to measure from, read once when the drag starts. */
  size: () => number
  apply: (next: number, done: boolean) => void
  /**
   * The handle is on the far edge of what it resizes — the top of a panel that
   * grows downward. Dragging down then means SHORTER, so the delta flips.
   */
  invert?: boolean
}) {
  const base = useRef(0)
  const from = useRef(0)
  const at = (e: React.PointerEvent) => (axis === 'x' ? e.clientX : e.clientY)
  const next = (e: React.PointerEvent) =>
    base.current + (at(e) - from.current) * (invert ? -1 : 1)

  return (
    <div
      className="splitter"
      data-axis={axis}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      onPointerDown={(e) => {
        // Capture, so the drag survives the pointer leaving the 8px strip —
        // which it does immediately, on the first fast move.
        e.currentTarget.setPointerCapture(e.pointerId)
        base.current = size()
        from.current = at(e)
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
        apply(next(e), false)
      }}
      onPointerUp={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
        e.currentTarget.releasePointerCapture(e.pointerId)
        apply(next(e), true)
      }}
      // Back to the kind's own size. A drag is easy to overdo, and hunting for
      // the pixel that used to be the default is not a repair.
      onDoubleClick={() => apply(0, true)}
    />
  )
}

export default function App() {
  // The lane the app was last left in. A first run (or a lane that no longer
  // parses) starts at the worktrees of the current project — the projects panel
  // is one ⌘⇧E away and does not need to be in the way every launch.
  const restored = useRef(loadLane())
  const [lane, setLaneRaw] = useState(() => restored.current?.lane ?? laneOf(panelOf('worktrees')))

  // --- lane memory ---------------------------------------------------------
  // What each session had open. See laneStore.ts.
  const bySession = useRef(restored.current?.bySession ?? {})
  // The two levels above it: which branch each project was left on, and which
  // chat each branch was left showing. Refs rather than state — nothing renders
  // from them, they are read at the moment a switch happens.
  const byProject = useRef(restored.current?.byProject ?? {})
  const byWorktree = useRef(restored.current?.byWorktree ?? {})
  // The chat panel you were on before this one (vim's ⌃^). The whole panel, not
  // just an id: it carries the worktree the session lives in, so the jump works
  // even when that chat belongs to another branch than the one selected.
  const alternate = useRef<Panel | null>(null)

  /**
   * Every lane change goes through here, and a change of SESSION carries its
   * panels with it: the outgoing session's are filed away and the incoming
   * one's take their place.
   *
   * It happens inside the update rather than in an effect watching the session
   * id, because an effect sees the lane AFTER the switch — the moment when the
   * new session is already current but is still wearing the old one's panels.
   * Anything else reacting to the lane in that render would file those panels
   * under the wrong session, which is exactly the bug this shape rules out.
   */
  const setLane = useCallback((update: (lane: Lane) => Lane) => {
    setLaneRaw((l) => {
      const next = update(l)
      const before = sessionKeyOf(l)
      const after = sessionKeyOf(next)
      if (before === after) return next
      // ⌃W's other chat, captured on the way out — this is the one place that
      // sees both sides of a session switch. Landing on the alternate records
      // the one you just left, which is what makes the two ping-pong.
      const leaving = l.panels.find((p) => p.session)
      if (leaving) alternate.current = leaving
      const by = before ? remember(bySession.current, before, scopedOf(l)) : bySession.current
      bySession.current = by
      return withScoped(next, after ? (by[after] ?? []) : [])
    })
  }, [])
  const projects = useProjects()
  // The worktrees of whichever project is current — switching project reloads
  // them, so the panel never shows a list belonging to somewhere else.
  const worktrees = useWorktrees(projects.current?.path)
  // Nothing to work on. useProjects lands on the first project by itself, so
  // this is only ever true on an empty install — no project has been added, or
  // the last one was removed. A worktrees panel there is an empty list under a
  // title; the launcher reads as an invitation instead, and its chat runs in the
  // home directory, which is the right cwd for a question about no project.
  const stranded = !projects.loading && !projects.current
  // Only on a CHANGE, so a restored lane survives boot untouched: the mount pass
  // strands if there is nothing (there is no lane worth keeping then) and
  // otherwise leaves the lane exactly as it was saved. Crossing back — the first
  // project gets added — hands over to its worktrees, or adding a project would
  // leave you sitting on the launcher wondering where it went.
  const wasStranded = useRef<boolean | null>(null)
  useEffect(() => {
    const before = wasStranded.current
    wasStranded.current = stranded
    if (before === null) {
      if (stranded) setLane(() => laneOf(panelOf('branch')))
      return
    }
    if (before === stranded) return
    setLane(() => laneOf(panelOf(stranded ? 'branch' : 'worktrees')))
  }, [stranded])
  const current = worktrees.rows.find((r) => r.worktree.path === worktrees.currentPath)
  /**
   * Where the app currently IS.
   *
   * The worktree of the open chat first — a session is the most specific answer
   * to "which tree" there is — then the one picked in the sidebar, and finally
   * the PROJECT ROOT. That last fallback is the point: the root is the project's
   * main worktree, not the absence of one, so a project with nothing selected
   * still has a tree to read. Everything that asks "here" reads this, so the
   * file list, git status and the terminal cannot disagree.
   */
  const here =
    lane.panels.find((p) => p.session)?.session?.worktreePath ??
    worktrees.currentPath ??
    projects.current?.path
  // What that tree has changed, watched so an agent editing behind the UI shows
  // up without a click.
  const changes = useChanges(here)
  // Tracks `here` like `changes` does, and for the same reason: the commands a
  // worktree runs belong to the tree the app is in, not to whichever panel was
  // opened first.
  const commands = useCommands(projects.current?.path, here, current?.worktree.branch ?? '')
  // A log panel's `sub` is the runner key; its header wants the command's name.
  const commandTitle = (key?: string): string | undefined => {
    const id = key?.slice(key.indexOf('#') + 1)
    return commands.list.find((c) => c.id === id)?.name ?? id
  }
  // `here`, not the sidebar's selection: at the launcher nothing is selected
  // yet, and a `#` menu that offered sessions but no files was reading a
  // worktree the app already knew how to name.
  const menuItems = useMenuItems(here, worktrees)
  // After a turn ends, adopt Claude's auto-generated title (or a Haiku-written
  // one for headless runs) so a session stops reading "Session N". The main
  // process only applies it while the title is still a placeholder and the
  // user hasn't renamed it — reload just picks up whatever it decided.
  //
  // The list is re-read either way, and not only when a title changed: it also
  // carries when each session was last touched and in which order the rows go,
  // and a turn that ends is exactly the moment both of those move. Debounced,
  // because several sessions finishing together would otherwise each pay for a
  // worktree walk.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = window.floe.agent.onEvent(({ key, event }) => {
      if (event.kind !== 'done') return
      void window.floe.claude.adoptAiTitle(key).finally(() => {
        clearTimeout(timer)
        timer = setTimeout(() => worktrees.reload(), 500)
      })
    })
    return () => {
      clearTimeout(timer)
      off()
    }
  }, [worktrees.reload])
  // The find bar: the query being typed, or null when it is closed. The query
  // survives closing (`n` repeats the last search, vim's way), which is why the
  // bar's visibility is `null` rather than a second boolean.
  const [finding, setFinding] = useState<string | null>(null)
  const lastFind = useRef('')
  // "3 of 12", shown in the bar. Without it a search that wraps looks identical
  // to one that is stuck, and you can't tell how much is left to walk.
  const [findPos, setFindPos] = useState<{ at: number; total: number } | null>(null)

  const [paletteOpen, setPaletteOpen] = useState(false)
  // A one-off palette the group commands drive. Same component as the project
  // and command lists — it already does filtering, keyboard nav and the "create
  // what you typed" row — so a picker is a piece of state, not a new overlay.
  // `onPick` may open the next one, which is how the two-step move works.
  const [picker, setPicker] = useState<{
    placeholder: string
    items: PaletteItem[]
    value?: string
    dynamic?: (query: string) => PaletteItem | null
    onPick: (id: string) => void
  } | null>(null)
  const [commandsOpen, setCommandsOpen] = useState(false)
  // The file palette (⌘P): the worktree's files, or null while it is closed.
  // The list is fetched when it opens rather than kept in sync — files appear
  // and vanish behind the app all day, and a list read at the moment you ask
  // for it cannot be stale.
  const [fileList, setFileList] = useState<string[] | null>(null)
  // The keymap, read from ~/.config/floe/keybindings.toml. It is the whole map,
  // not a set of overrides — the main process generates the file with every
  // default in it — so installing it REPLACES what resolveKey walks rather than
  // layering onto it. Kept in state as well so the palette's key chips repaint
  // when a rebind (or an edit to the file) changes them.
  // The font from floe.toml, live. The size is a window zoom applied in main.
  useAppearance()
  // The one line the app can say to a keyboard user. A key press has no row to
  // dim and no tooltip to hover, so a refused command would otherwise be
  // indistinguishable from a broken binding — which is exactly how ⌘K F read
  // before this existed.
  const [notice, setNotice] = useState<string | null>(null)
  // Stays on screen until it is acted on: the update installs on no other
  // path, so a message that faded would strand the user on the old version.
  const pendingUpdate = usePendingUpdate()
  const noticeTimer = useRef<number | null>(null)
  const say = useCallback((text: string) => {
    setNotice(text)
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    // Long enough to read, short enough that it never becomes furniture.
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2200)
  }, [])
  const [binds, setBinds] = useState<Keybind[]>([])
  useEffect(() => {
    const load = (): void => {
      void window.floe.keybindings.load().then((config) => {
        // `usingDefaults` means the file could not be trusted (a typo, an unknown
        // command, a `when` that does not compile) and the main process fell back
        // to the built-in table for ALL of it. Installing what it sends is right
        // either way — it sends the defaults in that case.
        setKeymap(compileKeymap(config.binds))
        setBinds(config.binds)
      })
    }
    load()
    // Saving the file — by hand, from an agent, or through a rebind — reloads it,
    // so a new binding works on the next key press without a restart.
    return window.floe.keybindings.onChange(load)
  }, [])
  // A project picked up with `m`: which one, and the group it is hovering over.
  // The panel draws the preview from this and nothing is written until Enter, so
  // Escape really does put the project back where it was.
  const [moving, setMoving] = useState<{ path: string; group: string } | null>(null)
  const [adding, setAdding] = useState(false)
  const [newWt, setNewWt] = useState(false)
  const [branches, setBranches] = useState<string[]>([])
  // The patch currently rendered in the diff panel, so `c` can quote from
  // exactly what is on screen.
  const lastPatch = useRef('')
  // What each chat reports about its context, keyed by panel id — the header
  // draws it, the chat knows it.
  const [usage, setUsage] = useState<Record<string, Usage>>({})
  // Keyed by panel id, not by position. With an array, closing a panel shifts
  // every index after it while React is still calling the old ref callbacks
  // with null — leaving stale holes, and a panel whose element the app can no
  // longer find silently loses its cursor and its keyboard navigation.
  const refs = useRef(new Map<string, HTMLElement>())
  const panelAt = (i: number): HTMLElement | undefined => {
    const id = lane.panels[i]?.id
    return id ? refs.current.get(id) : undefined
  }
  /**
   * How wide a column is, widened while it is being searched.
   *
   * The file panel is narrow because a tree of names is narrow. Its search is
   * not: it lists whole paths, and reading `src/Actions/Middleware/…` in 300px
   * means reading an ellipsis. So a searched panel gets room, and only while the
   * bar is up — nothing is written down, so closing the search puts the column
   * straight back where the user had it.
   *
   * `max`, never a fixed number: a column you dragged wider stays wider.
   */
  const SEARCH_WIDTH = 520
  const isSearched = (head: Panel): boolean =>
    finding !== null && head.id === lane.panels[lane.focus]?.id
  const searchWidth = (head: Panel, spec: { width: number }): number => {
    const base = head.width ?? spec.width
    return isSearched(head) ? Math.max(base, SEARCH_WIDTH) : base
  }

  const laneRef = useRef<HTMLDivElement>(null)
  // Column elements, for the splitters: a drag writes the new width here
  // directly and only tells the lane about it when the mouse comes up.
  const colRefs = useRef(new Map<string, HTMLElement>())

  // Every change is written, so quitting needs no goodbye: the last change IS
  // the saved state. The current session's panels are filed on the way out too,
  // or the set you are looking at right now would be the one never saved.
  const sessionKey = sessionKeyOf(lane)
  // How the lane is laid out: one entry per column, docked panels folded in.
  const columns = columnsOf(lane)
  useEffect(() => {
    const by = sessionKey ? remember(bySession.current, sessionKey, scopedOf(lane)) : bySession.current
    bySession.current = by
    // Only while the list on screen belongs to the project on screen: during a
    // switch they disagree for a render, and writing then would file the old
    // project's branch under the new project.
    const project = worktrees.repo === projects.current?.path ? projects.current?.path : undefined
    if (project && worktrees.currentPath)
      byProject.current = rememberWorktree(byProject.current, project, worktrees.currentPath)
    // Which chat this branch is showing — `null` when it is showing none, which
    // is a thing to remember rather than an absence of one. Keyed off the OPEN
    // CHAT's own worktree, not the sidebar selection: for one render after a
    // switch the two disagree, and that render would file a session under the
    // wrong branch.
    const chat = lane.panels.find((p) => p.session)?.session
    const worktree = chat?.worktreePath ?? worktrees.currentPath
    if (worktree)
      byWorktree.current = rememberSession(byWorktree.current, worktree, chat?.id ?? null)
    saveLane({
      lane,
      bySession: by,
      byProject: byProject.current,
      byWorktree: byWorktree.current,
      project,
      worktree: worktrees.currentPath
    })
  }, [lane, sessionKey, projects.current?.path, worktrees.currentPath])

  /**
   * A project whose worktree list has not arrived yet, and why we are waiting.
   *
   * Set on boot (put the app back where it was) and on every project switch
   * (put that project back where IT was). The list is a fetch, so the intent has
   * to outlive the wait somewhere; the effect below is where it lands.
   *
   * `boot` separates the two cases. On boot the saved lane already holds the
   * chat and the panels it opened, so landing must only re-select the branch
   * underneath it — reopening anything would fight the lane it just restored. A
   * switch has no lane to inherit and opens the branch's chat itself.
   */
  const pending = useRef<{ project?: string; boot: boolean } | null>({
    project: restored.current?.project,
    boot: true
  })

  // The saved project, once the list actually contains it — selecting it blind
  // would race the load. A project that is gone, or a first run with none saved,
  // releases the wait instead of holding it open forever.
  const landedProject = useRef(false)
  useEffect(() => {
    if (landedProject.current || projects.loading) return
    landedProject.current = true
    const want = restored.current?.project
    if (want && projects.all.some((p) => p.path === want)) projects.select(want)
    else if (pending.current) pending.current = { ...pending.current, project: undefined }
  }, [projects.loading, projects.all])

  // Delete the session the lane is showing. "Delete" is Floe's record of it:
  // the Claude transcript stays on disk and `claude --resume` still finds it,
  // which is why the confirm says so rather than implying the words are gone.
  // Some panels list a project's branches; others read the checked-out tree — git
  // status, the file list, a patch. Without the thing they read there is nothing
  // to show, so they can't be opened at all: better than opening one onto an
  // empty list or an error.
  const canOpen = (kind: string): boolean => !needsProject(kind) || !!projects.current

  /**
   * The same sentence the rail puts in its tooltip, for the keyboard.
   *
   * One function so the two cannot drift: a mouse user hovering a dimmed icon
   * and a keyboard user pressing its chord are asking the identical question and
   * deserve the identical answer.
   */
  const whyCannotOpen = (kind: string): string =>
    needsProject(kind) && !projects.current
      ? `${kind} — open a project first`
      : `${kind} is not available right now`

  const deleteSession = (scope: 'one' | 'others' | 'all' = 'one') => {
    const at = lane.panels.findIndex((p) => p.session)
    const panel = lane.panels[at]
    const openId = panel?.session?.id
    // The branch the open chat belongs to, else the selected one — same rule
    // cycleSession uses, so "this worktree" means the same thing everywhere.
    const path = panel?.session?.worktreePath ?? worktrees.currentPath
    if (!path) return
    const sessions = worktrees.rows.find((r) => r.worktree.path === path)?.sessions ?? []
    // A panel's session id is either the store id or the claudeId (cycleSession
    // opens with the latter), so a match has to accept both.
    const isOpen = (s: (typeof sessions)[number]): boolean =>
      !!openId && (s.id === openId || s.claudeId === openId)

    if (scope === 'one') {
      if (!panel?.session) return
      const { id, worktreePath } = panel.session
      // The store keys transcript metadata by claudeId, so closing without it
      // would leave that half behind. The sidebar already knows it.
      const claudeId = worktrees.rows.flatMap((r) => r.sessions).find((s) => s.id === id)?.claudeId
      const name = panel.sub ?? 'this session'
      if (
        !window.confirm(`Delete "${name}"? Floe forgets it — the Claude transcript stays on disk.`)
      )
        return
      void window.floe.claude.closeSession({ id, worktreePath, claudeId }).then(() => {
        setLane((l) => closePanel(l, at, () => panelOf('branch')))
        worktrees.reload()
      })
      return
    }

    const targets = scope === 'others' ? sessions.filter((s) => !isOpen(s)) : sessions
    if (!targets.length) return
    const what =
      scope === 'others'
        ? `the other ${targets.length} session${targets.length > 1 ? 's' : ''}`
        : `all ${targets.length} session${targets.length > 1 ? 's' : ''}`
    if (
      !window.confirm(
        `Delete ${what} on this worktree? Floe forgets them — the Claude transcripts stay on disk.`
      )
    )
      return
    const gone = new Set(targets.flatMap((s) => [s.id, s.claudeId].filter(Boolean) as string[]))
    void Promise.all(
      targets.map((s) =>
        window.floe.claude.closeSession({ id: s.id, worktreePath: path, claudeId: s.claudeId })
      )
    ).then(() => {
      // Close every panel showing one of them — indices shift as we go, so
      // resolve the next victim against the lane we just produced.
      setLane((l) => {
        let next = l
        for (;;) {
          const i = next.panels.findIndex((p) => p.session && gone.has(p.session.id))
          if (i === -1) return next
          next = closePanel(next, i, () => panelOf('branch'))
        }
      })
      worktrees.reload()
    })
  }

  // A terminal opens where you are: the worktree of the session you have open,
  // the worktree you have selected, or home when you are nowhere in particular.
  // Every way a panel gets created goes through here, so the rail, the palette
  // and a panel opening another one all land in the same directory — and the
  // shell's identity (`term:<cwd>`) stays tied to it, so two worktrees get two
  // shells and returning to one finds it as you left it.
  const cwd = here

  const mkPanel = (
    kind: PanelKind,
    sub?: string,
    session?: { id: string; worktreePath: string },
    firstPrompt?: string,
    firstChoice?: ModelChoice,
    root?: string
  ): Panel => {
    const panel = panelOf(
      kind,
      kind === 'terminal' ? (sub ?? cwd ?? '~') : sub,
      session,
      firstPrompt,
      firstChoice
    )
    // Set after the fact rather than threaded through panelOf: only a file
    // opened from outside the worktree has one, and every other caller would
    // have to pass undefined past four arguments to reach it.
    return root ? { ...panel, root } : panel
  }

  /**
   * Go to a worktree and put back what it was showing.
   *
   * A branch is where conversations live, so arriving at one means arriving at
   * its conversation: the chat you left it in comes back, and with it — through
   * setLane — the panels that chat had open and the text you never sent. A
   * branch nobody has opened yet gets the launcher instead, because the greeting
   * IS its empty state; guessing at its newest session would drop the user into
   * a conversation they did not ask for.
   *
   * `launcher` is how the caller says whether that empty state is wanted here.
   * The sidebar turns it off for a branch that has sessions to fold: the
   * launcher autofocuses its composer, and a fold that threw the caret into a
   * new chat would make the list unusable.
   *
   * Returns what it did, so a caller can fall back to its own behaviour.
   */
  const enterWorktree = (path: string, launcher = true): 'chat' | 'launcher' | 'none' => {
    worktrees.select(path)
    const row = worktrees.rows.find((r) => r.worktree.path === path)
    const want = byWorktree.current[path]
    // Only a session that is still there: a transcript deleted behind the app
    // would otherwise restore a chat with nothing in it.
    const session = want ? row?.sessions.find((s) => (s.claudeId ?? s.id) === want) : undefined
    if (session) {
      const id = session.claudeId ?? session.id
      setLane((l) => open(l, mkPanel('chat', session.title, { id, worktreePath: path })))
      return 'chat'
    }
    if (!launcher) return 'none'
    setLane((l) => open(l, panelOf('branch', row?.worktree.branch)))
    return 'launcher'
  }

  /** Go to a project, then on to the branch it was left on — see enterWorktree. */
  const enterProject = (path: string): void => {
    projects.select(path)
    // Its worktrees are a fetch away, so the rest of the restore happens when
    // they arrive.
    pending.current = { project: path, boot: false }
    // Switching project is only ever a step towards a worktree, so the list
    // comes with you rather than leaving you on whatever was on screen.
    setLane((l) => open(l, panelOf('worktrees', projects.all.find((p) => p.path === path)?.name)))
  }

  // The wait `pending` describes, resolved: the worktrees are here, so land on
  // the branch this project was left on — or on its first one, which is what a
  // project with no memory should open on rather than an empty lane.
  useEffect(() => {
    const want = pending.current
    const project = projects.current?.path
    if (!want || !project || worktrees.loading || !worktrees.rows.length) return
    // The rows have to be THIS project's. For one render after a switch they are
    // still the previous project's — loading has not been set yet — and landing
    // then would select a branch belonging to where you just left.
    if (worktrees.repo !== project) return
    if (want.project && want.project !== project) return // a different list is still coming
    pending.current = null
    const saved = want.boot ? restored.current?.worktree : byProject.current[project]
    const row = worktrees.rows.find((r) => r.worktree.path === saved)
    if (want.boot) {
      // The saved lane is the authority on boot. Its chat names the branch when
      // the saved selection is gone, so a restored conversation is never left
      // sitting over the wrong sidebar row.
      const chat = restored.current?.lane.panels.find((p) => p.session)?.session?.worktreePath
      const path =
        row?.worktree.path ??
        worktrees.rows.find((r) => r.worktree.path === chat)?.worktree.path
      if (path) return worktrees.select(path)
    }
    enterWorktree((row ?? worktrees.rows[0]).worktree.path)
  }, [worktrees.rows, worktrees.repo, worktrees.loading, projects.current?.path])

  // ⌃I / ⌃O walk every session in the sidebar, in the order it lists them:
  // down a branch's chats, then on into the next branch's. The list you see is
  // the list you walk, so a worktree boundary is not a wall — holding the key
  // gets you anywhere without going back to the sidebar. It wraps, because a
  // list you can walk off the end of needs a second key to get back.
  const cycleSession = (delta: number) => {
    // The sidebar flattened: same rows, same per-branch order, collapsed or not.
    // Branches with no sessions simply contribute nothing to walk through.
    const all = worktrees.rows.flatMap((r) =>
      r.sessions.map((s) => ({ path: r.worktree.path, id: s.claudeId ?? s.id, title: s.title }))
    )
    if (!all.length) return
    // Where we are is the OPEN CHAT, not the sidebar selection: those differ
    // once you cycle across a branch, and the chat is what the keys move.
    const here = lane.panels.find((p) => p.session)?.session
    const at = all.findIndex(
      (s) => s.id === sessionKey && (!here?.worktreePath || s.path === here.worktreePath)
    )
    // Nothing open yet: either key lands on the newest rather than nowhere.
    const next = all[at === -1 ? 0 : (at + delta + all.length) % all.length]
    // Crossing into another branch takes the sidebar with it — an open chat
    // whose worktree is not the selected one leaves the rest of the app (diffs,
    // terminal, merge) pointing somewhere the user is no longer looking.
    if (next.path !== worktrees.currentPath) worktrees.select(next.path)
    setLane((l) =>
      open(l, mkPanel('chat', next.title, { id: next.id, worktreePath: next.path }))
    )
  }

  /**
   * The guided merge, one flow per project.
   *
   * Everything the chain needs from the app is passed in rather than reached
   * for: it opens a chat for the conflict-resolution turn, stops the turns
   * running in a worktree it is about to tear down, and clears what that
   * worktree had on screen once it is gone. The hook owns the git steps and
   * nothing else.
   */
  const merge = useMerge({
    root: projects.current?.path,
    // A merge session is an ordinary chat — same panel, same transcript — that
    // is handed its opening message and pinned to `full`: it has to edit files
    // and `git add` without a prompt per tool, whatever the composer was set to.
    openResolve: (session, prompt) =>
      setLane((l) =>
        open(l, mkPanel('chat', 'resolve conflicts', session, prompt, { ...loadChoice(), mode: 'skip' }))
      ),
    stopAgents: (worktreePath) => {
      const row = worktrees.rows.find((r) => r.worktree.path === worktreePath)
      for (const s of row?.sessions ?? []) void window.floe.agent.stop(s.claudeId ?? s.id)
    },
    onWorktreeGone: (worktreePath) => {
      // Close every panel that was showing it — a chat in a worktree that no
      // longer exists is a dead transcript over a missing tree.
      setLane((l) => {
        let next = l
        for (;;) {
          const i = next.panels.findIndex(
            (p) =>
              p.session?.worktreePath === worktreePath ||
              (p.kind === 'terminal' && p.sub === worktreePath)
          )
          if (i === -1) return next
          next = closePanel(next, i, () => panelOf('branch'))
        }
      })
      worktrees.reload()
    },
    show: () => setLane((l) => open(l, panelOf('merge')))
  })

  // ⌃W: back to the chat you came from.
  const alternateSession = () => {
    const p = alternate.current
    if (p?.session) setLane((l) => open(l, mkPanel('chat', p.sub, p.session)))
  }

  // Every row a panel offers the cursor, in document order. The cursor is an
  // index into THIS list, so it stays meaningful when movement is scoped to one
  // nav-group inside the panel.
  //
  // A panel that owns the raw keyboard has none: the drawing canvas is thirty
  // toolbar buttons, and counting them as rows would make the focus effect land
  // on "rectangle" instead of on the drawing.
  const rowsOf = (panel: HTMLElement | null | undefined): HTMLElement[] =>
    panel && !panel.querySelector('[data-raw-keys]')
      ? [...panel.querySelectorAll<HTMLElement>('.panel-body button, .panel-body [data-nav]')]
      : []

  /**
   * The project the cursor is sitting on, for `d` and `m`.
   *
   * Read off the row's own `data-project` rather than by counting rows: the list
   * is grouped, and an index into "projects, ignoring headings" is exactly the
   * kind of arithmetic that files the wrong project the day a group is added.
   */
  const projectAtCursor = (): Project | undefined => {
    if (lane.panels[lane.focus]?.kind !== 'projects') return undefined
    const rows = rowsOf(panelAt(lane.focus))
    const path = rows[lane.panels[lane.focus]?.cursor ?? 0]?.dataset.project
    return path ? projects.all.find((p) => p.path === path) : undefined
  }

  /**
   * Move the cursor to the next row matching `query`, wrapping around the end,
   * and record where you are in the matches so the bar can say "3/12".
   *
   * Matching is on the row's TEXT, and on its content where the row has a
   * separate part for it: a file line renders its number beside it, so a search
   * for `2` would otherwise hit every twentieth line before the first match.
   */
  const findFrom = (query: string, dir: 1 | -1, inclusive = false): HTMLElement | undefined => {
    const q = query.trim().toLowerCase()
    if (!q) {
      setFindPos(null)
      return
    }
    const rows = rowsOf(panelAt(lane.focus))
    const matches = matchingRows(rows, q)
    setFindPos({ at: 0, total: matches.length })
    if (!matches.length) return

    // Where to start looking. Typing another letter searches from the row you
    // are ON (the match you already have usually still matches), while Enter
    // searches from the one AFTER it — otherwise it would find itself and the
    // key would appear dead.
    const cursor = lane.panels[lane.focus]?.cursor ?? -1
    const at =
      dir === 1
        ? (matches.find((i) => (inclusive ? i >= cursor : i > cursor)) ?? matches[0])
        : ([...matches].reverse().find((i) => i < cursor) ?? matches[matches.length - 1])

    setFindPos({ at: matches.indexOf(at) + 1, total: matches.length })
    rows[at].scrollIntoView({ block: 'center', behavior: 'smooth' })
    setLane((l) => setCursor(l, l.focus, at))
    // The caller decides about focus, and while the bar is open the answer is
    // no: searching as you type must not pull the caret out of the field you
    // are typing in.
    return rows[at]
  }

  /**
   * Open a skill's Markdown in your editor.
   *
   * Rooted at the skill's own directory, exactly as Settings roots the config
   * files at ~/.config/floe: a skill lives outside every worktree, and one
   * editor session per skill directory is what puts a bundled skill's reference
   * files in reach of the editor already on screen.
   */
  const editSkill = (dir: string, rel: string): void => {
    void window.floe.editor.launch(dir, rel).then(
      (result) => {
        if (result.mode === 'panel') setLane((l) => open(l, mkPanel('edit', rel, undefined, undefined, undefined, dir)))
        // No editor on this machine is not a dead key: show the file instead.
        else if (result.error) setLane((l) => open(l, mkPanel('file', rel, undefined, undefined, undefined, dir)))
      },
      () => setLane((l) => open(l, mkPanel('file', rel, undefined, undefined, undefined, dir)))
    )
  }

  /**
   * Keep the "3/12" honest when the rows arrive after the query does.
   *
   * The count used to be a snapshot taken the moment you typed, which was fine
   * while every row was already in the DOM. The file panel's search is not: it
   * fetches the whole tree, so the first count landed against the rows that were
   * there before and the bar said 1/2 next to a hundred results.
   *
   * An effect alone cannot fix that — the rows appear when the PANEL re-renders
   * from its own state, which never re-renders this component. So the DOM is
   * watched instead: any change to the focused panel's rows recounts. It only
   * writes when the number actually moved, so it settles rather than looping.
   */
  useEffect(() => {
    const q = finding?.trim().toLowerCase()
    const panel = panelAt(lane.focus)
    if (!q || !panel) return
    // Once per query: the rows can settle in several mutations and jumping the
    // cursor on each one would fight whatever the user did in between.
    let landed = false
    const recount = (): void => {
      const total = matchingRows(rowsOf(panel), q).length
      setFindPos((prev) => (prev && prev.total !== total ? { ...prev, total } : prev))
      // Rows that arrive after the query leave the cursor on nothing, which
      // leaves Enter with no file to open. Step onto the first match the moment
      // there is one — what typing would have done had the list been there.
      if (total > 0 && !landed) {
        landed = true
        findFrom(q, 1, true)
      }
    }
    recount()
    const observer = new MutationObserver(recount)
    observer.observe(panel, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [finding, lane])

  // The focused panel is always scrolled into view and always holds DOM focus.
  // A panel you can see but can't type into is worse than no panel at all.
  useEffect(() => {
    const el = panelAt(lane.focus)
    if (!el) return

    // A pinned panel sits ON TOP of the lane, so scrolling a panel flush to the
    // left edge would park it underneath and hide it. Reserve the pinned
    // panel's actual width as scroll padding, and panels come to rest beside it
    // instead of behind it.
    const laneEl = laneRef.current
    if (laneEl) {
      const pinned = laneEl.querySelector<HTMLElement>('[data-sticky]')
      laneEl.style.scrollPaddingInlineStart = `${(pinned?.offsetWidth ?? 0) + 16}px`
    }
    // 'nearest' scrolls the minimum needed, which lands the focused panel at
    // the right edge — so the panel you opened it FROM stays visible beside it
    // whenever the two fit. A drill-down that hides its own source would make
    // you scroll back every time you wanted the next item.
    el.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' })
    // Only claim focus when it isn't already inside this panel. Without the
    // guard, focusing a row makes the panel active, which re-runs this effect
    // and yanks focus off the row and back onto the panel shell — arrow keys
    // would appear to do nothing.
    if (!el.contains(document.activeElement)) {
      // Land back on the row you left, not on the panel shell. This is the
      // whole point of storing the cursor.
      const rows = rowsOf(el)
      const at = lane.panels[lane.focus]?.cursor
      // With nothing remembered yet, land on the row the panel calls current —
      // the project you're actually in, not the first one alphabetically. Once
      // you move, the remembered cursor wins and this never runs again.
      const fallback = rows.findIndex((r) => r.hasAttribute('data-active'))
      const idx = at ?? (fallback === -1 ? undefined : fallback)
      const row = idx != null ? rows[Math.min(idx, rows.length - 1)] : undefined
      ;(row ?? el).focus({ preventScroll: true })
      // Record the default as the cursor, rather than leaving it implicit in
      // DOM focus. Otherwise the row is focused but unmarked, and the next j
      // would start counting from nowhere instead of from where you are.
      if (at == null && idx != null) setLane((l) => setCursor(l, lane.focus, idx))
    }
  }, [lane.focus, lane.panels.length])

  // Switching session with ⌃I/⌃O moves the sidebar's cursor with it. The list
  // already marks the open session (`data-active`); without this the cursor
  // mark stays on the row you last clicked, so two highlights claim to be
  // "where you are" and they point at different sessions.
  //
  // Only when the OPEN session changes, though. The effect has to re-run on
  // `lane.panels` to find the row once it's rendered, and moving the cursor
  // changes `lane.panels` — so without this guard every j/k dragged the cursor
  // straight back onto the open session and navigating was impossible.
  const syncedSession = useRef(sessionKey)
  useEffect(() => {
    if (syncedSession.current === sessionKey) return
    const at = lane.panels.findIndex((p) => p.kind === 'worktrees')
    if (at === -1 || !sessionKey) return
    const rows = rowsOf(panelAt(at))
    const row = rows.findIndex(
      (r) => r.classList.contains('row-session') && r.hasAttribute('data-active')
    )
    // Not rendered yet: leave the mark unclaimed and try again on the next
    // render, rather than declaring this session synced to nothing.
    if (row === -1) return
    syncedSession.current = sessionKey
    setLane((l) => setCursor(l, at, row))
  }, [sessionKey, lane.panels, worktrees.rows])

  // Paint the cursor. It's an attribute rather than a class passed down because
  // no panel body knows it has a cursor — the lane owns that, for every panel
  // that exists now or later. A row keeps its mark while the panel is unfocused,
  // which is what makes "where was I" answerable at a glance.
  useEffect(() => {
    lane.panels.forEach((panel, i) => {
      const rows = rowsOf(panelAt(i))
      const sel = selRange(panel.selection)
      rows.forEach((row: HTMLElement, j: number) => {
        if (panel.cursor === j) row.setAttribute('data-cursor', '')
        else row.removeAttribute('data-cursor')
        if (sel && j >= sel[0] && j <= sel[1]) row.setAttribute('data-sel', '')
        else row.removeAttribute('data-sel')
      })
    })
  })

  // A held project is only held while you are looking at the list: focus another
  // panel and the move is off. Otherwise `j` would still be carrying a project
  // three panels away, where nothing shows it.
  useEffect(() => {
    if (moving && lane.panels[lane.focus]?.kind !== 'projects') setMoving(null)
  }, [moving, lane.focus, lane.panels])

  // The cursor rides along with the project it picked up. The row keeps its DOM
  // focus across the re-render (React keys it by path), but its INDEX changes
  // when it lands in another group — so without this the mark is left behind on
  // whatever row inherited the old position.
  useEffect(() => {
    if (!moving) return
    const rows = rowsOf(panelAt(lane.focus))
    const at = rows.findIndex((row) => row.dataset.project === moving.path)
    if (at !== -1) setLane((l) => setCursor(l, lane.focus, at))
  }, [moving, lane.focus])

  // One dispatcher for the whole keymap. It lives on the window rather than on
  // each panel so a binding behaves the same wherever focus happens to be —
  // which is the only way ⌃L can mean "next panel" while you are mid-sentence
  // in the composer. What each key MEANS is decided by resolveKey (keys.ts);
  // this only carries the intent out.
  const chord = useRef(false)

  // The registry reads state through this, so a command written once works the
  // same whether a key, the palette or an MCP tool called it.
  const ctxRef = useRef<CommandContext>(null as unknown as CommandContext)
  ctxRef.current = {
    lane,
    setLane,
    editSkill,
    panelEl: panelAt,
    rowsOf,
    makePanel: (kind, sub, root) => mkPanel(kind as PanelKind, sub, undefined, undefined, undefined, root),
    canOpen,
    whyCannotOpen,
    commands,
    // The registry quotes from the same patch the panel is showing; reading it
    // here rather than re-fetching keeps the quote and the highlight in step.
    patchFor: () => lastPatch.current,
    openPalette: () => setPaletteOpen(true),
    openCommands: () => setCommandsOpen(true),
    openFiles: () => {
      if (!here) return
      // Opens empty and fills: reading a large repo takes a moment, and a
      // palette that waits for it looks like the key did nothing.
      setFileList([])
      void window.floe.files.all(here).then(setFileList)
    },
    // Opens on the last query, selected, so `/` then typing replaces it and `/`
    // then Enter repeats it.
    openFind: () => setFinding(lastFind.current),
    findNext: (dir) => findFrom(lastFind.current, dir)?.focus(),
    addProject: () => setAdding(true),
    // Wrapped rather than passed: both are declared below this object, and the
    // command that calls them only runs long after the render that built it.
    askText: (opts) => askText(opts),
    say,
    createGroup: () => pickGroup('New group…', { create: true, onPick: (g) => void projects.addGroup(g) }),
    deleteProject: () => {
      const project = projectAtCursor()
      if (!project) return
      // What is being removed is Floe's record of the project, not the code:
      // say so, because "delete" over a folder full of work reads much worse
      // than what this does.
      if (window.confirm(`Remove "${project.name}" from Floe? The folder stays on disk.`)) {
        void projects.remove(project.path)
      }
    },
    startMoveProject: () => {
      const project = projectAtCursor()
      if (project) setMoving({ path: project.path, group: project.group || DEFAULT_GROUP })
    },
    stepMoveProject: (delta) =>
      setMoving((m) =>
        m ? { ...m, group: stepGroup(moveTargets(projects.groups, projects.groupNames), m.group, delta) } : m
      ),
    endMoveProject: (commit) => {
      const held = moving
      setMoving(null)
      if (!held || !commit) return
      const from = projects.all.find((p) => p.path === held.path)
      // Dropping a project back in its own group is a move that changes nothing
      // — no write, so the list does not repaint for a no-op.
      if (from && (from.group || DEFAULT_GROUP) !== held.group) {
        void projects.setGroup(held.path, held.group)
      }
    },
    movingProject: moving !== null,
    // Two steps, deliberately: which project, then where to. Reading the project
    // off "whatever is current" would file the wrong one whenever the rail and
    // the lane disagree.
    moveProject: () =>
      setPicker({
        placeholder: 'Move which project?',
        items: projects.all.map((p) => ({ id: p.path, title: p.name, detail: p.group })),
        onPick: (path) =>
          pickGroup('Move to which group?', {
            create: true,
            onPick: (g) => void projects.setGroup(path, g)
          })
      }),
    deleteGroup: () =>
      pickGroup('Delete which group?', {
        // The default is where deleted groups send their projects, so it can't
        // be one of the things you delete.
        omitDefault: true,
        onPick: (g) => {
          const count = projects.all.filter((p) => p.group === g).length
          const moved = count
            ? ` Its ${count === 1 ? 'project moves' : `${count} projects move`} to ${DEFAULT_GROUP}.`
            : ''
          if (window.confirm(`Delete the group "${g}"?${moved}`)) void projects.deleteGroup(g)
        }
      }),
    // `here`, not the sidebar selection. A project opened with no row clicked
    // still HAS a tree — its root, which is what the files panel is already
    // listing — and reading the selection instead left `e`, `r`, `m` and `d`
    // silently refusing on a tree the user can see. Same answer as `here`, so
    // the commands and the panels cannot disagree about which tree they mean.
    worktree: here
      ? {
          path: here,
          branch: worktrees.rows.find((r) => r.worktree.path === here)?.worktree.branch ?? ''
        }
      : undefined,
    // The checklist's state, flattened for the registry: the commands ask what
    // the merge is waiting for, never what step it is on.
    merge: {
      active: !!merge.flow,
      failed: !!merge.flow?.steps.some((s) => s.status === 'error'),
      awaitingReview: merge.flow?.awaiting === 'review',
      canStash: /uncommitted changes/i.test(
        merge.flow?.steps.find((s) => s.status === 'error')?.detail ?? ''
      ),
      // `here`, like every other worktree command: the branch you are in is the
      // one ⌘K M means, whether you got there from the sidebar or from a chat.
      start: () => {
        const wt = worktrees.rows.find((r) => r.worktree.path === here)?.worktree
        if (!wt) return say('no worktree to merge')
        const why = merge.start(wt)
        if (why) say(why)
      },
      approve: merge.approve,
      retry: merge.retry,
      stashRetry: merge.stashRetry,
      cancel: merge.cancel
    },
    deleteSession,
    cycleSession,
    // Undefined until there IS one, which is also how the command knows to dim
    // itself: on the first chat of a session there is nowhere to go back to.
    alternateSession: alternate.current?.session ? alternateSession : undefined,
    pendingUpdate: pendingUpdate ?? undefined,
    newWorktree: () => {
      if (!projects.current) return
      // Branches with no worktree yet: checking one out is a valid answer, and
      // offering one that is already open would create a worktree git refuses.
      void window.floe.worktrees
        .branches(projects.current.path)
        .then((all) => {
          const taken = new Set(worktrees.rows.map((r) => r.worktree.branch))
          setBranches(all.filter((b) => !taken.has(b)))
        })
        .catch(() => setBranches([]))
      setNewWt(true)
      // The form lives at the top of the worktrees panel, so the panel has to
      // be up — and focused, so the input's own focus lands inside the panel
      // the lane already calls current.
      setLane((l) => open(l, panelOf('worktrees')))
    },
    // Lazy wrapper: switchBackend is declared further down, after the picker
    // helpers it uses; the property only needs it at call time.
    useBackend: (id?: string) => switchBackend(id)
  }

  // --- Plugin commands ---------------------------------------------------------
  // Overlay the runtime plugins' commands onto the registry at mount, so the
  // palette, the keymap and MCP run_command all reach them through the same
  // dispatch as any built-in. The run goes back to main, where the plugin lives.
  useEffect(() => {
    let cancelled = false
    void window.floe.plugins.commands().then((cmds) => {
      if (cancelled || !cmds.length) return
      installPluginCommands(REGISTRY, cmds, (id, arg) => void window.floe.plugins.run(id, arg))
    })
    return () => {
      cancelled = true
    }
  }, [])

  // --- MCP control server -----------------------------------------------------
  // Commands an agent's tool pushed from main over mcp:command. run_command and
  // list_commands go through the SAME registry the keymap and the palette use —
  // that is the whole contract: one command written once behaves the same for
  // all three callers. Kept behind a ref so the one subscription (mounted once
  // below) always calls the render's current closure.
  const handleMcpCommandRef = useRef<(command: McpCommand) => void>(() => {})
  useEffect(() => window.floe.mcp.onCommand((c) => handleMcpCommandRef.current(c)), [])
  handleMcpCommandRef.current = (command: McpCommand): void => {
    switch (command.kind) {
      case 'run_command': {
        const res = runCommand(REGISTRY, ctxRef.current, command.commandId, command.arg)
        void window.floe.mcp.commandResult({
          requestId: command.requestId,
          ok: res.ok,
          error: res.ok ? undefined : res.error
        })
        return
      }
      case 'list_commands': {
        void window.floe.mcp.commandResult({
          requestId: command.requestId,
          ok: true,
          commands: listCommands(REGISTRY, ctxRef.current)
        })
        return
      }
      case 'select_session': {
        // Same restore machinery a project/worktree switch uses: file the target
        // under the memory refs and enter. A cross-project target lands via
        // enterProject's pending restore (its worktree list is a fetch away);
        // the current project's opens the chat panel directly — the just-created
        // session may not be in the sidebar rows yet, and the panel doesn't
        // need it to be.
        byWorktree.current[command.worktreePath] = command.sessionId
        const current = projects.current?.path
        if (command.projectPath && command.projectPath !== current) {
          byProject.current[command.projectPath] = command.worktreePath
          enterProject(command.projectPath)
          return
        }
        worktrees.select(command.worktreePath)
        setLane((l) =>
          open(l, mkPanel('chat', command.title, { id: command.sessionId, worktreePath: command.worktreePath }))
        )
        worktrees.reload()
        return
      }
      case 'open_plan': {
        // The same reader every file gets, rooted at the plan's worktree so it
        // opens correctly even when a different worktree is on screen.
        setLane((l) =>
          open(l, mkPanel('file', command.relPath, undefined, undefined, undefined, command.worktreePath))
        )
        return
      }
      case 'open_drawing': {
        // Same shape as open_plan, onto the canvas instead of the reader: the
        // agent has just drawn something and this is it putting it on screen.
        setLane((l) =>
          open(l, mkPanel('drawing', command.relPath, undefined, undefined, undefined, command.worktreePath))
        )
        return
      }
      case 'start_merge': {
        // The guided merge starts from a Worktree row of the OPEN project
        // (useMerge keys flows by projects.current). On the right project with
        // the row loaded it starts now; otherwise park the request and navigate
        // — the effect below fires it once the rows arrive. The tool's timeout
        // answers the caller if they never do.
        const row = worktrees.rows.find((r) => r.worktree.path === command.worktreePath)
        if (row && projects.current?.path === command.projectPath && worktrees.repo === command.projectPath) {
          worktrees.select(command.worktreePath)
          const why = merge.start(row.worktree)
          void window.floe.mcp.commandResult({ requestId: command.requestId, ok: !why, error: why ?? undefined })
          return
        }
        pendingMerge.current = { worktreePath: command.worktreePath, requestId: command.requestId }
        if (projects.current?.path !== command.projectPath) {
          byProject.current[command.projectPath] = command.worktreePath
          enterProject(command.projectPath)
        } else {
          worktrees.reload()
        }
        return
      }
    }
  }

  // A start_merge whose project/worktree list wasn't on screen yet: fires once
  // the target project's rows are loaded, then answers the waiting tool.
  const pendingMerge = useRef<{ worktreePath: string; requestId: string } | null>(null)
  useEffect(() => {
    const p = pendingMerge.current
    if (!p) return
    const row = worktrees.rows.find((r) => r.worktree.path === p.worktreePath)
    if (!row || worktrees.repo !== projects.current?.path) return // still loading
    pendingMerge.current = null
    worktrees.select(p.worktreePath)
    const why = merge.start(row.worktree)
    void window.floe.mcp.commandResult({ requestId: p.requestId, ok: !why, error: why ?? undefined })
  }, [worktrees.rows, worktrees.repo])

  useEffect(() => {
    const onKey = (e: KeyboardEvent, capturing = false) => {
      // Resolved already, in the capture pass below. Both listeners are on
      // window and see the same press, and the lane has not re-rendered in
      // between — so without this the command would run twice.
      const marked = e as KeyboardEvent & { __floeHandled?: true }
      if (marked.__floeHandled) return
      const active = document.activeElement as HTMLElement | null
      const typing =
        active?.tagName === 'TEXTAREA' ||
        active?.tagName === 'INPUT' ||
        active?.isContentEditable === true
      // A panel that owns the raw keyboard — the drawing canvas, which has its
      // own full keymap. Marked in the DOM rather than by panel kind so the
      // panel itself decides, and so focus LEAVING it (into the composer beside
      // it) turns the state off without anything having to notice. Under `raw`
      // only chords with a modifier resolve — see shared/keymap.ts.
      const raw = !!active?.closest('[data-raw-keys]')

      // Floe goes FIRST only for a raw panel. Excalidraw's own key handler
      // stops propagation on some of the chords it claims — ⌃H among them —
      // so a window listener that only ran on the way back up would never see
      // the press, and ⌃H is half of how you leave the canvas. Everywhere else
      // the capture pass stands down and the bubble one below does the work, so
      // components that handle their own keys keep seeing them first.
      //
      // Safe to go first here because `raw` already narrows resolution to
      // chords holding a modifier: a letter, or text being typed into the
      // canvas, resolves to nothing and falls through untouched.
      if (capturing !== raw) return

      // The DOM spells its modifiers metaKey/ctrlKey; keys.ts is DOM-free and
      // spells them meta/ctrl. Adapt here, at the one seam between them.
      const input = {
        key: e.key,
        meta: e.metaKey,
        ctrl: e.ctrlKey,
        shift: e.shiftKey,
        alt: e.altKey
      }
      // An overlay owns the keyboard while it is up — including the user's own
      // bindings, or ⌘↵ inside the palette would fire a command behind it.
      const blocked = paletteOpen || commandsOpen || fileList !== null || adding || newWt || finding !== null
      const action =
        resolveKey(input, {
          typing,
          raw,
          chord: chord.current,
          kind: lane.panels[lane.focus]?.kind,
          selecting: !!lane.panels[lane.focus]?.selection,
          moving: moving !== null,
          palette: blocked,
          ...stackNeighbours(columns, lane.focus)
        })
      // Any resolution ends the chord — a miss included, which is what makes an
      // unmapped second key cancel rather than do something else.
      const wasChord = chord.current
      chord.current = action?.id === 'palette.chord'
      if (!action) {
        if (wasChord) e.preventDefault()
        return
      }
      e.preventDefault()
      marked.__floeHandled = true

      const res = runCommand(REGISTRY, ctxRef.current, action.id, action.arg)
      // Said out loud, not only to the console: the whole point is that the user
      // learns why nothing happened.
      if (!res.ok) say(res.error)
    }

    const onKeyCapture = (e: KeyboardEvent): void => onKey(e, true)
    window.addEventListener('keydown', onKeyCapture, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKeyCapture, true)
      window.removeEventListener('keydown', onKey)
    }
    // No keymap dependency: resolveKey reads the installed bindings at call
    // time, so a reload takes effect on the next press without rebinding this
    // listener.
  }, [lane, paletteOpen, commandsOpen, fileList, adding, newWt, finding, moving])

  // Every group command asks the same question, so they ask it the same way.
  // `create` adds the "New group <name>" row built from the query — the one row
  // that cannot come from the list, because it IS what you typed.
  const pickGroup = (
    placeholder: string,
    opts: { create?: boolean; omitDefault?: boolean; onPick: (group: string) => void }
  ): void => {
    const names = projects.groupNames.filter((g) => !opts.omitDefault || g !== DEFAULT_GROUP)
    setPicker({
      placeholder,
      items: names.map((g) => ({ id: g, title: g })),
      dynamic: opts.create
        ? (query) => {
            const name = query.trim()
            // Nothing typed, or it already exists — the plain row covers it.
            return name && !names.includes(name)
              ? { id: name, title: `New group “${name}”`, detail: 'create' }
              : null
          }
        : undefined,
      onPick: opts.onPick
    })
  }

  /**
   * Put the keyboard back in the lane: the row the focused panel's cursor is on,
   * or the panel itself if it has no rows. What an overlay owes on the way out —
   * focus left on a dismissed element is focus nobody can type into.
   */
  const backToLane = (): void => {
    const el = panelAt(lane.focus)
    if (!el) return
    const rows = rowsOf(el)
    const at = lane.panels[lane.focus]?.cursor
    ;(rows[Math.min(at ?? 0, rows.length - 1)] ?? el).focus({ preventScroll: true })
  }

  // The inline new-worktree form's wiring, handed to the worktrees panel while
  // ⌘N has one open — the flow that used to be a modal.
  const newWorktreeProps: NewWorktreeProps | undefined =
    newWt && projects.current
      ? {
          branches,
          mainBase: worktrees.rows.find((r) => r.worktree.isMain)?.worktree.branch,
          defaultBase: current?.worktree.branch,
          onCancel: () => {
            setNewWt(false)
            // After the re-render that removes the form — reading the rows now
            // would hand focus to a button about to disappear.
            requestAnimationFrame(backToLane)
          },
          onCreate: ({ branch, base, resetBranch }) => {
            setNewWt(false)
            void window.floe.worktrees
              .create(projects.current!.path, branch, { base, resetBranch })
              .then((list) => {
                worktrees.reload()
                // Land in what you just made — creating a worktree and then
                // having to go find it is a step the app can take for you. The
                // path comes from what create returned, not from guessing where
                // git put it.
                const made = list.find((wt) => wt.branch === branch)
                if (made) worktrees.select(made.path)
                setLane((l) => open(l, panelOf('branch', branch)))
              })
              .catch((e: Error) => console.warn('[worktree.new]', e.message))
          }
        }
      : undefined

  /**
   * Ask for a line of text — a new name, a destination directory.
   *
   * The palette again, not a new overlay: it already focuses itself, closes on
   * Escape, and turns what you typed into the row Enter takes. `items` is empty
   * because there is nothing to pick from here; the answer IS the query.
   */
  const askText = (opts: {
    placeholder: string
    value?: string
    verb: string
    onDone: (text: string) => void
  }): void =>
    setPicker({
      placeholder: opts.placeholder,
      value: opts.value,
      items: [],
      dynamic: (query) => {
        const text = query.trim()
        // Nothing typed, or nothing changed — neither is an action to offer.
        return text && text !== opts.value ? { id: text, title: `${opts.verb} ${text}` } : null
      },
      onPick: opts.onDone
    })

  /**
   * Point the window at another machine's backend. Bare, it offers the picker;
   * with an id it switches directly (the MCP path). Switching dispatches
   * floe:backend-switched, which remounts <App> (see main.tsx) — every hook
   * refetches from the new backend, while PINNED channels stay on this machine.
   */
  const switchBackend = (id?: string): void => {
    const doUse = (target: string): void => {
      if (!window.floe.backends.use(target)) return
      window.dispatchEvent(new Event('floe:backend-switched'))
    }
    if (id) return doUse(id)
    const currentId = window.floe.backends.current()
    setPicker({
      placeholder: 'Attach backend…',
      items: window.floe.backends.list().map((b) => ({
        id: b.id,
        title: b.label,
        detail: b.id === currentId ? 'current' : b.remote ? window.floe.backends.state(b.id) : 'this machine'
      })),
      onPick: doUse
    })
  }

  /**
   * "project/branch[/rest]" for a panel header — the answer to "where am I".
   * The branch is looked up by path in the live list, so a worktree renamed or
   * removed behind the app's back stops claiming a name it no longer has.
   */
  const whereOf = (worktreePath?: string, rest?: string): string =>
    [
      projects.current?.name,
      worktrees.rows.find((r) => r.worktree.path === worktreePath)?.worktree.branch,
      rest
    ]
      .filter(Boolean)
      .join('/')

  // The rail opens a tool; the lane decides where it sits.
  /**
   * The key that opens each panel, for the rail's tooltip.
   *
   * Read from the live keymap rather than written down here, so a rebind shows
   * up in the tooltip instead of leaving the rail teaching a key that no longer
   * works. Only context-free bindings: `h` and `l` also run `panel.goto`, but
   * only from inside the two list panels, and a rail promising `h` everywhere
   * would be teaching a key that does something else where you are standing.
   */
  const railKeys = new Map<string, string>()
  for (const b of binds) {
    if (b.command !== 'panel.goto' || !b.arg || b.when) continue
    if (!railKeys.has(b.arg)) railKeys.set(b.arg, formatChord(b.key))
  }

  // Summed once per render for the chat header's badge, not per panel.
  const changeStat = changes.files.reduce(
    (acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }),
    { add: 0, del: 0 }
  )

  const openFromRail = (kind: PanelKind) => {
    if (!canOpen(kind)) return
    setLane((l) => open(l, mkPanel(kind)))
  }

  return (
    <div className="app">
      <div className="workspace">
        <div className="lane" ref={laneRef}>
          {/* Columns, not panels: a docked panel shares its neighbour's column
              instead of taking one of its own. The column carries the width and
              the pinning, so a stacked pair is sized and pinned as one thing. */}
          {columns.map((column, c) => {
            const [{ panel: head }] = column
            const headSpec = KINDS[head.kind as PanelKind]
            // A growing column only grows while nothing follows it. Once it has
            // a neighbour, stretching would come out of that neighbour's width
            // — and a pinned chat would swallow the whole lane.
            const lastColumn = c === columns.length - 1
            return (
              <div
                key={head.id}
                className="lane-col"
                ref={(el) => {
                  if (el) colRefs.current.set(head.id, el)
                  else colRefs.current.delete(head.id)
                }}
                style={
                  {
                    '--panel-w': `${searchWidth(head, headSpec)}px`,
                    // The MINIMUM moves with it while searching, or the column
                    // is still shrinkable and a grow panel beside it takes the
                    // room straight back — which is exactly what happened when
                    // only the width was raised.
                    '--panel-min': `${
                      isSearched(head)
                        ? searchWidth(head, headSpec)
                        : 'min' in headSpec
                          ? headSpec.min
                          : headSpec.width
                    }px`
                  } as React.CSSProperties
                }
                // A width you dragged to is a width you asked for: it wins over
                // growing, or the lane would take it straight back.
                data-sized={head.width !== undefined || undefined}
                data-grow={
                  (head.width === undefined &&
                    'grow' in headSpec &&
                    headSpec.grow &&
                    lastColumn) ||
                  undefined
                }
                data-sticky={('sticky' in headSpec && headSpec.sticky) || undefined}
              >
                <Splitter
                  axis="x"
                  size={() => colRefs.current.get(head.id)?.offsetWidth ?? headSpec.width}
                  apply={(next, done) => {
                    const el = colRefs.current.get(head.id)
                    // Live: straight to the element. Committed: into the lane,
                    // which is what gets saved — see laneStore.
                    if (!done) return el?.style.setProperty('--panel-w', `${Math.round(next)}px`)
                    el?.style.removeProperty('--panel-w')
                    setLane((l) =>
                      next === 0
                        ? clearSize(l, column[0].index)
                        : resizePanel(l, column[0].index, next, 'min' in headSpec ? headSpec.min : 180)
                    )
                  }}
                />
                {column.map(({ panel, index: i }) => {
            const kind = panel.kind as PanelKind
            const spec = KINDS[kind]
            const Icon = spec.icon
            const bare = 'bare' in spec && spec.bare
            // Where this panel is pointed, spelled out in its header: a panel
            // that shows one worktree's contents looks the same whichever
            // worktree it is. Read from the live selection, never from a sub
            // captured when the panel opened, which goes stale on the next
            // switch.
            const sub =
              kind === 'worktrees'
                ? projects.current?.name
                : kind === 'chat'
                  ? whereOf(panel.session?.worktreePath, panel.sub)
                  : kind === 'files'
                    ? whereOf(here)
                    : kind === 'edit'
                      ? editTarget(panel.sub).path
                      // A cmdlog's sub is the runner key — machine text. The
                      // header says which command it is, and the command it runs.
                      : kind === 'cmdlog'
                        ? commandTitle(panel.sub)
                        : panel.sub
            return (
              <section
                key={panel.id}
                ref={(el) => {
                  if (el) refs.current.set(panel.id, el)
                  else refs.current.delete(panel.id)
                }}
                className="panel"
                data-kind={panel.kind}
                style={panel.dock ? { flexBasis: panel.height ?? '40%' } : undefined}
                tabIndex={-1}
                data-focused={i === lane.focus || undefined}
                data-bare={bare || undefined}
                data-docked={panel.dock || undefined}
                onMouseDown={() => setLane((l) => focusAt(l, i))}
                onFocus={() => setLane((l) => (l.focus === i ? l : focusAt(l, i)))}
                // Clicking or tabbing to a row moves the cursor too, so mouse
                // and keyboard never disagree about where you are. setCursor
                // returns the same lane when it already matches, so the focus
                // effect restoring a row can't loop back through here.
                onFocusCapture={(e) => {
                  const rows = rowsOf(panelAt(i))
                  const at = rows.indexOf(e.target as HTMLElement)
                  if (at !== -1) setLane((l) => setCursor(l, i, at))
                }}
              >
                {panel.dock === 'below' && (
                  <Splitter
                    axis="y"
                    invert
                    size={() => panelAt(i)?.offsetHeight ?? 240}
                    apply={(next, done) => {
                      const el = panelAt(i)
                      if (!done) {
                        if (el) el.style.flexBasis = `${Math.round(next)}px`
                        return
                      }
                      if (el) el.style.removeProperty('flex-basis')
                      setLane((l) => (next === 0 ? clearSize(l, i) : resizePanel(l, i, next, 120)))
                    }}
                  />
                )}
                {!bare && (
                  <header className="panel-head">
                    <Icon size={14} stroke={1.6} className="panel-icon" />
                    <span className="panel-name">{panel.title}</span>
                    {sub && (
                      <span className="panel-sub" title={sub}>
                        {/* A terminal's sub is an absolute path — too wide for a header,
                            and the last segment is the part you read anyway. A drawing's
                            is a relPath whose extension the icon already says; both keep
                            the whole thing in the tooltip. */}
                        {panel.kind === 'terminal'
                          ? sub.split('/').pop()
                          : panel.kind === 'drawing'
                            ? sub.split('/').pop()?.replace(/\.excalidraw$/, '')
                            : sub}
                      </span>
                    )}
                    {/* The chat is where you watch an agent work, so it is
                        where "the tree moved" has to show up — otherwise you
                        only learn there are edits by opening the changes panel
                        to look. Only on the chat: `changes` tracks `here`,
                        which the open session defines, so hanging the count on
                        any other panel would be reporting a different tree's
                        edits under this one's title. Clicking opens the list;
                        the same panel has its own key (see the rail), so this
                        adds no mouse-only path. */}
                    {kind === 'chat' && changes.files.length > 0 && (
                      <button
                        className="head-changes"
                        title={`${changes.files.length} changed ${
                          changes.files.length === 1 ? 'file' : 'files'
                        } — open changes${
                          railKeys.has('changes') ? ` (${railKeys.get('changes')})` : ''
                        }`}
                        onClick={() => openFromRail('changes')}
                      >
                        <IconGitCompare size={12} stroke={1.8} />
                        {changes.files.length}
                        {changeStat.add > 0 && <span className="stat-add">+{changeStat.add}</span>}
                        {changeStat.del > 0 && <span className="stat-del">−{changeStat.del}</span>}
                      </button>
                    )}
                    {usage[panel.id]?.used > 0 && <ContextMeter usage={usage[panel.id]} />}
                    {'action' in spec && spec.action && (
                      <button
                        className="panel-act"
                        title={spec.action.title}
                        onClick={() =>
                          runCommand(REGISTRY, ctxRef.current, (spec.action as { command: string }).command)
                        }
                      >
                        <spec.action.icon size={14} stroke={1.8} />
                      </button>
                    )}
                    {/* Every panel can stack, so every panel offers it — the
                        icon shows the shape you would GET, not the one you are
                        in. The first panel has nothing to go under. */}
                    {i > 0 && (
                      <button
                        className="panel-act"
                        title={panel.dock ? 'Put beside (⌘K /)' : 'Put below (⌘K /)'}
                        onClick={() => setLane((l) => toggleDock(l, i))}
                      >
                        {panel.dock ? (
                          <IconLayoutColumns size={14} stroke={1.8} />
                        ) : (
                          <IconLayoutRows size={14} stroke={1.8} />
                        )}
                      </button>
                    )}
                    {i > 0 && (
                      <button
                        className="panel-act"
                        title="Close (⌘W)"
                        onClick={() => setLane((l) => closePanel(l, i, () => panelOf('branch')))}
                      >
                        <IconX size={13} stroke={1.6} />
                      </button>
                    )}
                  </header>
                )}
                <div className="panel-body">
                  <PanelBody
                    kind={kind}
                    sub={panel.sub}
                    projects={projects}
                    movingProject={moving}
                    worktrees={worktrees}
                    changes={changes}
                    commands={commands}
                    merge={merge}
                    // Picking a project or a branch is never just a selection:
                    // it restores everything that place was left showing.
                    onEnterProject={enterProject}
                    onEnterWorktree={enterWorktree}
                    newWorktree={newWorktreeProps}
                    cwd={cwd}
                    root={panel.root}
                    onPatch={(patch) => (lastPatch.current = patch)}
                    onUsage={(u) =>
                      setUsage((prev) =>
                        prev[panel.id]?.used === u.used &&
                        prev[panel.id]?.max === u.max &&
                        prev[panel.id]?.label === u.label
                          ? prev
                          : { ...prev, [panel.id]: u }
                      )
                    }
                    menuItems={menuItems}
                    // Same command the palette and the projects panel's header
                    // button run — the launcher's empty state is one more way in,
                    // not a second add flow.
                    onAddProject={() => runCommand(REGISTRY, ctxRef.current, 'project.add')}
                    // Quitting the editor closes its panel, so `:q` lands you
                    // back on the file tree instead of on a dead terminal you
                    // then have to close by hand. Located by id, not by `i`:
                    // the editor can quit long after this render, by which time
                    // a panel opened to its left has shifted every index.
                    onEditorExit={() =>
                      setLane((l) => close(l, l.panels.findIndex((p) => p.id === panel.id)))
                    }
                    // A panel's own mouse affordances run command ids, the same
                    // way the header button and the keymap do — see onCommand
                    // in PanelBody.
                    onCommand={(id) => runCommand(REGISTRY, ctxRef.current, id)}
                    onEditSkill={editSkill}
                    session={panel.session}
                    openSession={sessionKey}
                    // Only the panel the bar is searching: a query tinting rows
                    // in a panel `/` never looked at would be a lie.
                    find={i === lane.focus && finding !== null ? finding : undefined}
                    firstPrompt={panel.firstPrompt}
                    firstChoice={panel.firstChoice}
                    firstAttached={panel.firstAttached}
                    // Where it lands is the lane's business, not the opener's:
                    // every panel has an order, so nothing needs to say "after
                    // me".
                    onOpen={(child) =>
                      setLane((l) =>
                        open(l, {
                          ...mkPanel(
                            child.kind,
                            child.sub,
                            child.session,
                            child.firstPrompt,
                            child.firstChoice,
                            child.root
                          ),
                          // Set beside mkPanel rather than through it: only a
                          // chat started from the launcher has attachments, and
                          // every other caller would have to pass undefined
                          // past five arguments to skip it.
                          firstAttached: child.firstAttached
                        })
                      )
                    }
                  />
                </div>
                {/* The find bar belongs to the panel it searches, not to the
                    window: what `/` means is "in here", and a bar floating over
                    the lane would have to say which panel it meant. */}
                {i === lane.focus && finding !== null && (
                  <div className="find">
                    <span className="find-mark">/</span>
                    <input
                      autoFocus
                      className="find-input"
                      value={finding}
                      placeholder="search this panel"
                      onChange={(e) => {
                        setFinding(e.target.value)
                        lastFind.current = e.target.value
                        // Search as you type, from the row you are on, so the
                        // match you already have survives the next letter.
                        findFrom(e.target.value, 1, true)
                      }}
                      onKeyDown={(e) => {
                        // The bar owns the keyboard while it is up (see
                        // `blocked`), so these are handled here rather than
                        // through the keymap.
                        // ↑/↓ walk the matches and the bar STAYS UP — stepping
                        // through hits is the whole point of a find bar, and
                        // closing on the first one made you reopen it to see the
                        // second. Escape is how you leave.
                        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                          e.preventDefault()
                          findFrom(finding, e.key === 'ArrowDown' ? 1 : -1)
                          return
                        }
                        if (e.key === 'Enter') {
                          // Enter OPENS what the cursor is on. Once the bar
                          // searches whole trees it is a picker as much as a
                          // find, and in a picker Enter is how you take the
                          // thing — walking is what the arrows are for.
                          e.preventDefault()
                          const rows = rowsOf(panelAt(lane.focus))
                          const at = lane.panels[lane.focus]?.cursor
                          // Not on a match yet (the rows arrived after the
                          // query): step onto the first one instead of opening
                          // whatever happens to be under the cursor.
                          if (at === undefined || !findPos?.at) findFrom(finding, 1)
                          else rows[at]?.click()
                          return
                        }
                        if (e.key === 'Escape') {
                          e.preventDefault()
                          setFinding(null)
                          setFindPos(null)
                          // Never leave focus on a field that just closed: land
                          // on the row the cursor is on, which is the last match.
                          const rows = rowsOf(panelAt(lane.focus))
                          rows[lane.panels[lane.focus]?.cursor ?? 0]?.focus()
                        }
                      }}
                    />
                    {/* Position, not just a count: "0/0" is how you learn the
                        query matches nothing without the list going blank. */}
                    {!!finding.trim() && findPos && (
                      <span className="find-count" data-empty={!findPos.total || undefined}>
                        {findPos.at}/{findPos.total}
                      </span>
                    )}
                  </div>
                )}
              </section>
            )
                })}
              </div>
            )
          })}
        </div>
        <nav className="rail">
          {RAIL.map((group) => (
            // Grouped so related panels read as one block — see RAIL in panels.
            <div className="rail-group" key={group.join()}>
              {group.map((kind) => {
                const Icon = KINDS[kind].icon
                const off = !canOpen(kind)
                return (
                  <button
                    key={kind}
                    className="rail-btn"
                    // Dimmed and inert rather than hidden: the rail's shape is how
                    // you learn what the app has, and a row that reshuffles as you
                    // move around is harder to aim at than one that greys out.
                    data-off={off || undefined}
                    disabled={off}
                    aria-label={off ? whyCannotOpen(kind) : KINDS[kind].title}
                    onClick={() => openFromRail(kind)}
                  >
                    <Icon size={17} stroke={1.5} />
                    {/* The app's own tooltip rather than the OS `title`, for two
                        reasons: it can carry the key that opens the panel — which
                        is the thing a keyboard-first app most wants to teach, and
                        the one moment the user is already asking "what is this" —
                        and it opens inward, so it is not clipped by the window edge
                        the native one sat against. aria-hidden: the button's own
                        label already says all of this to a screen reader. */}
                    <span className="rail-tip" aria-hidden="true">
                      {off ? whyCannotOpen(kind) : KINDS[kind].title}
                      {!off && railKeys.has(kind) && <kbd>{railKeys.get(kind)}</kbd>}
                    </span>
                  </button>
                )
              })}
            </div>
          ))}
        </nav>
      </div>

      {adding && (
        <AddProject
          backends={window.floe.backends?.list() ?? []}
          groups={projects.groupNames}
          group={projects.current?.group}
          // No native picker in the web build: the headless backend's dialog is
          // a stub that always cancels, so offering Browse there would be a
          // button that does nothing. `version` is 'web' only in that build.
          onBrowse={
            window.floe.version === 'web'
              ? null
              : (group) => {
                  setAdding(false)
                  void projects.add(group).then((err) => err && console.warn('[add]', err))
                }
          }
          onAdd={(_backend, path, group) => {
            setAdding(false)
            void projects.addByPath(path, group).then((err) => err && console.warn('[add]', err))
          }}
          onClose={() => setAdding(false)}
        />
      )}

      {picker && (
        <Palette
          placeholder={picker.placeholder}
          items={picker.items}
          value={picker.value}
          dynamic={picker.dynamic}
          onClose={() => {
            setPicker(null)
            backToLane()
          }}
          onPick={(id) => {
            // Cleared first: onPick may open the next step, and clearing after
            // would close the one it just put up.
            setPicker(null)
            picker.onPick(id)
            // After the answer, back to the row you asked from — so `r`, a new
            // name, Enter leaves you where `j` still works. A step that opened
            // another palette takes the focus back on mount, after this.
            backToLane()
          }}
        />
      )}
      {commandsOpen && (
        <Palette
          placeholder="Execute a command…"
          items={commandItems(binds)}
          onClose={() => setCommandsOpen(false)}
          onPick={(id) => {
            setCommandsOpen(false)
            const res = runCommand(REGISTRY, ctxRef.current, id)
            if (!res.ok) console.debug('[command]', res.error)
          }}
          onRebind={(id, chord) => {
            // Written through to the file, which is the keymap — so the change
            // is in the same place the user would have made it by hand, and
            // survives a restart without a second store to keep in sync. The
            // watcher below reloads and repaints once the write lands.
            void window.floe.keybindings.rebind(id, chord)
          }}
        />
      )}

      {fileList && (
        <Palette
          placeholder="Find a file…"
          // The whole path is the title, so `srcapp` finds src/App.tsx: the
          // fuzzy match runs on the title alone, and a bare filename would make
          // the directory unsearchable.
          items={fileList.map((path) => ({ id: path, title: path }))}
          // A repo has thousands of files and nobody reads past the fold of a
          // fuzzy list — they type another letter.
          limit={200}
          onClose={() => setFileList(null)}
          onPick={(path) => {
            setFileList(null)
            setLane((l) => open(l, panelOf(panelForFile(path), path)))
          }}
        />
      )}

      {paletteOpen && (
        <Palette
          placeholder="Switch project…"
          items={paletteItems(projects)}
          onClose={() => setPaletteOpen(false)}
          onPick={(id) => {
            setPaletteOpen(false)
            if (id === 'project.add') return ctxRef.current.addProject()
            // Same move as clicking the project row: it hands you over to the
            // worktree list and on to the branch that project was left on.
            enterProject(id)
          }}
        />
      )}

      {/* An update is downloaded and waiting. Nothing else in the app applies
          it — the main process never swaps the bundle on quit — so this sits
          there until the restart happens. The button only dispatches the id, so
          the palette row and the click are the same one action. */}
      {pendingUpdate && (
        <div className="update-banner" role="status">
          <span>Floe {pendingUpdate} is ready</span>
          <button
            type="button"
            className="update-restart"
            onClick={() => runCommand(REGISTRY, ctxRef.current, 'update.install')}
          >
            Restart
          </button>
        </div>
      )}

      {/* One line, bottom centre, gone in two seconds. Deliberately not a
          dismissible toast: there is nothing to act on, only something to know,
          and a thing you have to close would cost more than it tells. */}
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
    </div>
  )
}

/**
 * What the palette offers: every project, plus the one action that belongs
 * beside them. "Add project" lives in the same list rather than behind its own
 * binding — you reach for the palette when the project you want isn't open, and
 * sometimes that is because it isn't added yet.
 */
function paletteItems(projects: ReturnType<typeof useProjects>): PaletteItem[] {
  return [
    ...projects.all.map((p) => ({
      id: p.path,
      title: p.name,
      detail: p.home ? 'home' : p.group,
      group: p.group
    })),
    // Pinned: it must be there exactly when the search finds nothing, because
    // that is the moment you learn the project isn't added yet.
    { id: 'project.add', title: 'Add project…', detail: 'new', pinned: true }
  ]
}

/**
 * Every command, named the way the palette reads best: `group: title`, so
 * typing either half finds it. The key chip shows the user's binding when they
 * have set one, because that is the one that will fire.
 */
function commandItems(binds: Keybind[]): PaletteItem[] {
  // The chip shows the binding that will actually fire: the FIRST entry for the
  // command, since resolution is first-match-wins.
  const bound = new Map<string, string>()
  for (const b of binds) if (!bound.has(b.command)) bound.set(b.command, b.key)
  return listCommands(REGISTRY).map((c) => ({
    id: c.id,
    title: `${c.group.toLowerCase()}: ${c.title.replace(/…$/, '').toLowerCase()}`,
    keys: bound.has(c.id) ? formatChord(bound.get(c.id)!) : c.keys
  }))
}

