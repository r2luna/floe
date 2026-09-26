import {
  IconArrowBackUp,
  IconGitCompare,
  IconGitMerge,
  IconMenu2,
  IconLayoutColumns,
  IconLayoutRows,
  IconPlus,
  IconTrash,
  IconX
} from './icons'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
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
  slotOf,
  toggleDock
} from './lane'
import { dragAnchor, selRange } from './diff'
import { pickDefinition } from './definition'
import { KINDS, RAIL, FileCrumbs, PanelBody, needsDesktop, needsProject, panelForFile, termIdOf, timeAgo, type PanelAction, type PanelKind } from './panels'
import { KeyBar, type AppKey } from './KeyBar'
import { editTarget } from './editorTarget'
import { resolveKey } from './keys'
import { useNarrow, useTouch } from './useNarrow'
import { RailMenu } from './RailMenu'
import { installPluginCommands, runCommand, type CommandContext, type CommandRow } from './commands'
import { keyHint } from './keyHints'
import { useNeedsYouNotifier } from './useNotify'
import { REGISTRY } from './registry'
import { ALL, Palette } from './Palette'
import {
  fileIntoSession,
  load as loadLane,
  projectRailOf,
  remember,
  rememberRail,
  rememberSession,
  rememberWorktree,
  save as saveLane,
  scopedOf,
  sessionKeyOf,
  withoutProject,
  withScoped
} from './laneStore'
import { setKeymap } from './keys'
import { useAppearance } from './appearance'
import { compileKeymap, formatChord, type Keybind } from '../../shared/keymap'
import { listCommands } from './commands'
import { KeysHelp } from './KeysHelp'
import { AddProject } from './AddProject'
import { reason } from './ipcError'
import {
  attach,
  backendLabel,
  backendOf,
  currentBackend,
  dropLanding,
  handOff,
  LOCAL,
  pairHost,
  peekLanding
} from './backends'
import {
  chatItems,
  finderChats,
  loadChats,
  mergeChats,
  type ChatRow,
  type FinderChat
} from './finderChats'
import type { NewWorktreeProps } from './NewWorktree'
import { diagnoseWorktreeFailure, type WorktreeFailure } from '../../shared/worktreeError'
import { useProjects } from './useProjects'
import { moveTargets, stepGroup } from './projectMove'
import { useWorktrees, type WorktreeRow } from './useWorktrees'
import { useChanges } from './useChanges'
import { useCommands } from './useCommands'
import { useMerge } from './useMerge'
import { useRemove } from './useRemove'
import { useProvision } from './useProvision'
import { useProjectSetup } from './useProjectSetup'
import { useMenuItems } from './useMenuItems'
import { usePendingUpdate } from './useUpdate'
import type { PaletteItem } from './fuzzy'
import { nickColor } from './nickColor'
import { useBrowserCovered } from './browserCover'
import { CommandPreview, FilePreview, ProjectPreview, SessionPreview } from './palettePreview'
import {
  DEFAULT_GROUP,
  type ActiveSession,
  type ContextUsage,
  type McpCommand,
  type Project,
  type Query
} from '../../shared/types'


/**
 * How long a session must sit untouched to count as stale — one hour, matching
 * what the command promises in the palette.
 */
const IDLE_MS = 60 * 60_000

/**
 * The marked-block chip's box, in CSS pixels, so it can be placed before it is
 * rendered. Measured rather than read back: the chip has one fixed label, and a
 * layout pass to learn a size that never changes would cost a frame of flicker
 * on every drag. Keep in step with `.sel-tip` in index.css.
 */
const TIP_W = 132
const TIP_H = 24

/** A session the bulk delete is about to forget, and the worktree it lives in. */
type Target = { s: WorktreeRow['sessions'][number]; path: string }

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
  //
  // A QUERY panel is identified by its harness instead (`query:codex`), even
  // though it carries a session too: asking codex a second thing is the same
  // side conversation, so it must focus the panel that is already open rather
  // than stack a second one beside it.
  // The NANNY is identified by her kind for the same reason a query is: there is
  // one of her per project and she is replaced by slot, so borrowing the chat's
  // `chat:<session>` id would collapse her into the card chat the moment
  // somebody opened her session from the session list.
  id: session && kind !== 'query' && kind !== 'nanny' ? `chat:${session.id}` : `${kind}:${sub ?? ''}`,
  kind,
  // A query is titled by who answers in it — the panel head reads `codex`, in
  // that harness's own nick colour, not the word "query" four times over.
  title: kind === 'query' ? (sub ?? KINDS[kind].title) : KINDS[kind].title,
  sub,
  session,
  firstPrompt,
  firstChoice,
  order: KINDS[kind].order,
  // Which panels replace which — see slotOf. A query takes one of its own, so
  // two harnesses stand side by side instead of one swapping out the other.
  slot: slotOf(kind, sub, 'slot' in KINDS[kind] ? (KINDS[kind] as { slot?: string }).slot : undefined)
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
  // And which project-bound rail panels it had up — today, the colony board.
  // The board belongs to a repo root, so it is remembered next to the branch
  // rather than left standing when you walk into another project.
  const railByProject = useRef(restored.current?.railByProject ?? {})
  const byWorktree = useRef(restored.current?.byWorktree ?? {})
  // The chat panel you were on before this one (vim's ⌃^). The whole panel, not
  // just an id: it carries the worktree the session lives in, so the jump works
  // even when that chat belongs to another branch than the one selected.
  //
  // With the project and machine it was on, because the `active` panel crosses
  // both: going back has to re-enter them the way jumpToSession does, or ⌃W
  // would open a chat under whatever repo happens to be current.
  const alternate = useRef<{ panel: Panel; projectPath?: string; backend: string } | null>(null)
  // The project the last render was on, read inside setLane — which runs before
  // this render's assignment, so it is the project being LEFT.
  const projectPath = useRef<string | undefined>(undefined)

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
      if (leaving)
        alternate.current = {
          panel: leaving,
          projectPath: projectPath.current,
          backend: currentBackend()
        }
      const by = before ? remember(bySession.current, before, scopedOf(l)) : bySession.current
      bySession.current = by
      return withScoped(next, after ? (by[after] ?? []) : [])
    })
  }, [])
  // This mount's identity, for the landing handoff: a remount makes a new one,
  // which is exactly the difference the handoff has to tell apart.
  const self = useRef({}).current
  const projects = useProjects(self)
  projectPath.current = projects.current?.path
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
  // Whether a setup checklist is running, for the handover below. A ref because
  // the handover is about `stranded` changing and must not re-run when a step
  // of the setup does.
  const setupRunning = useRef(false)
  useEffect(() => {
    const before = wasStranded.current
    wasStranded.current = stranded
    if (before === null) {
      if (stranded) setLane(() => laneOf(panelOf('branch')))
      return
    }
    if (before === stranded) return
    setLane(() => {
      const handover = laneOf(panelOf(stranded ? 'branch' : 'worktrees'))
      // Adding the FIRST project crosses back here and starts that project's
      // setup in the same breath — so the handover would replace the checklist
      // it just opened, on the one add that most needs it. The worktrees panel
      // still leads; the setup keeps its place beside it.
      return !stranded && setupRunning.current ? open(handover, panelOf('setup')) : handover
    })
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
  // A row that left without a turn of its own ending: a subagent closing itself
  // once its work is done (main/spawned.ts). The `done` reload above already
  // ran a minute earlier, on the turn that finished the work.
  useEffect(() => window.floe.claude.onSessionsChanged(() => worktrees.reload()), [worktrees.reload])
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
    /** Escape, or a click outside. A yes/no question resolves "no" here. */
    onClose?: () => void
  } | null>(null)
  const [commandsOpen, setCommandsOpen] = useState(false)
  // `?` — every binding, see KeysHelp.
  const [keysOpen, setKeysOpen] = useState(false)
  // ⌘P's files, or null while it is closed — which is also what says the
  // palette is up. The list is fetched when it opens rather than kept in sync:
  // files appear and vanish behind the app all day, and a list read at the
  // moment you ask for it cannot be stale.
  const [finderFiles, setFinderFiles] = useState<string[] | null>(null)
  // Every machine's sessions, every project — the chat half, which the open
  // project's worktree list cannot answer for. Kept between opens rather than
  // cleared: the palette paints the last answer at once and the load in flight
  // updates it in place, the way the `active` panel does.
  const [chatIndex, setChatIndex] = useState<ChatRow[]>([])
  // What ⌘P offers, rebuilt when either half moves. Null while it is closed:
  // the same state says whether the palette is up and what is in it.
  const finder = useMemo(() => {
    if (finderFiles === null) return null
    const project = projects.current
    const chats = finderChats(
      chatIndex,
      worktrees.rows,
      project && worktrees.repo === project.path
        ? {
            backend: currentBackend(),
            projectPath: project.path,
            projectName: project.name
          }
        : undefined
    )
    const { items, map } = chatItems(chats, timeAgo, backendLabel)
    for (const path of finderFiles) items.push({ id: path, title: path, group: 'files' })
    return { items, chats: map }
  }, [finderFiles, chatIndex, worktrees.rows, worktrees.repo, projects.current])
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

  /**
   * The sessions ticked in the worktrees list, by Floe's own session id.
   *
   * Component state rather than panel state, unlike the cursor and the line
   * selection: those are indexes into a panel and have to survive leaving it,
   * while a tick is a list of things you are ABOUT to delete. The lane is
   * written to localStorage on every change, so putting the ticks there would
   * restore them after a relaunch — a red "delete 4" button waiting for you on
   * a list you ticked yesterday.
   */
  const [marks, setMarks] = useState<ReadonlySet<string>>(() => new Set())
  // Where a ⇧-click measures from: the last row you ticked by hand.
  const markAnchor = useRef<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [newWt, setNewWt] = useState(false)
  // Why the last create was refused, and whether one is in flight — both belong
  // to the form, which stays open across a failure so it can show them.
  const [newWtError, setNewWtError] = useState<WorktreeFailure | null>(null)
  const [newWtBusy, setNewWtBusy] = useState(false)
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

  // One panel per screen, or the desktop lane. Everything narrow mode changes
  // is CSS keyed off <html data-narrow>; what the hook is read for here is the
  // one thing CSS cannot do — listing the open panels, which only the lane
  // knows.
  const narrow = useNarrow()
  // Whether a finger is driving, which is a different question from how wide
  // the window is: a desktop window dragged narrow still has a keyboard.
  const touch = useTouch()
  // The rail's drawer. Narrow only — there the rail is one button, not a strip.
  const [railMenu, setRailMenu] = useState(false)
  // Unfolding the phone brings the rail itself back, so the drawer standing for
  // it is over: left open, it would spring back the next time you folded.
  useEffect(() => {
    if (!narrow) setRailMenu(false)
  }, [narrow])

  // A native WebContentsView sits above renderer HTML. Hide it while one of
  // Floe's overlays is open, or it would cover the palette instead of yielding
  // to it like every DOM-backed panel does.
  const browserCovered = useBrowserCovered()
  useEffect(() => {
    if (window.floe.version === 'web' || !lane.panels.some((panel) => panel.kind === 'browser')) return
    const overlay =
      browserCovered ||
      paletteOpen ||
      commandsOpen ||
      keysOpen ||
      finderFiles !== null ||
      adding ||
      newWt ||
      finding !== null ||
      picker !== null ||
      (narrow && railMenu)
    void window.floe.browser.visible(!overlay)
  }, [lane.panels, browserCovered, paletteOpen, commandsOpen, keysOpen, finderFiles, adding, newWt, finding, picker, narrow, railMenu])

  const laneRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<HTMLElement>(null)
  const menuRef = useRef<HTMLButtonElement>(null)
  // Column elements, for the splitters: a drag writes the new width here
  // directly and only tells the lane about it when the mouse comes up.
  const colRefs = useRef(new Map<string, HTMLElement>())

  // Every change is written, so quitting needs no goodbye: the last change IS
  // the saved state. The current session's panels are filed on the way out too,
  // or the set you are looking at right now would be the one never saved.
  const sessionKey = sessionKeyOf(lane)
  // The browser's toolbar, keymap and preview calls act on this session's page.
  useEffect(() => {
    void window.floe.browser.session(sessionKey ?? '')
  }, [sessionKey])
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
    // Same guard, same reason: filed only while the lane on screen is this
    // project's, or a switch would tell the project you just left that it holds
    // the board you are about to open in the new one.
    if (project) railByProject.current = rememberRail(railByProject.current, project, projectRailOf(lane))
    // Which chat this branch is showing — `null` when it is showing none, which
    // is a thing to remember rather than an absence of one. Keyed off the OPEN
    // CHAT's own worktree, not the sidebar selection: for one render after a
    // switch the two disagree, and that render would file a session under the
    // wrong branch.
    const chat = lane.panels.find((p) => p.session)?.session
    // A chat names its own branch, so it is always safe to file. Without one,
    // the selection is only trustworthy while the lists agree: a project switch
    // closes the chat a render before the worktree selection catches up, and
    // filing then would tell the branch you just left that it holds no chat.
    const worktree = chat?.worktreePath ?? worktrees.currentPath
    if (worktree && (chat || project))
      byWorktree.current = rememberSession(byWorktree.current, worktree, chat?.id ?? null)
    saveLane({
      lane,
      bySession: by,
      byProject: byProject.current,
      railByProject: railByProject.current,
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
  // A remote machine's list lands after this one's. Settling as soon as local
  // answered sent every reload of a project on another machine back to the
  // first local project, so the wait holds until each remote answers or is
  // given up on.
  const remotesLoading = projects.remotes.some((r) => r.state === 'loading')
  useEffect(() => {
    if (landedProject.current || projects.loading) return
    // A landing is waiting: this instance was brought up to be somewhere, and
    // the saved project can live on the machine we just left — selecting it
    // would point the window straight back and throw the landing away.
    if (peekLanding(self)) {
      landedProject.current = true
      return
    }
    const want = restored.current?.project
    const found = !!want && projects.all.some((p) => p.path === want)
    if (want && !found && remotesLoading) return
    landedProject.current = true
    if (found) projects.select(want)
    else if (pending.current) pending.current = { ...pending.current, project: undefined }
  }, [projects.loading, projects.all, remotesLoading])

  // Delete the session the lane is showing. "Delete" is Floe's record of it:
  // the Claude transcript stays on disk and `claude --resume` still finds it,
  // which is why the confirm says so rather than implying the words are gone.
  // Some panels list a project's branches; others read the checked-out tree — git
  // status, the file list, a patch. Without the thing they read there is nothing
  // to show, so they can't be opened at all: better than opening one onto an
  // empty list or an error.
  const canOpen = (kind: string): boolean =>
    (!needsProject(kind) || !!projects.current) &&
    (!needsDesktop(kind) || window.floe.version !== 'web')

  /**
   * The same sentence the rail puts in its tooltip, for the keyboard.
   *
   * One function so the two cannot drift: a mouse user hovering a dimmed icon
   * and a keyboard user pressing its chord are asking the identical question and
   * deserve the identical answer.
   */
  const whyCannotOpen = (kind: string): string =>
    needsDesktop(kind) && window.floe.version === 'web'
      ? `${kind} — available in the desktop app`
      : needsProject(kind) && !projects.current
        ? `${kind} — open a project first`
        : `${kind} is not available right now`

  /**
   * Every session in the project, in the order the list draws them.
   *
   * What a ⇧-click measures a range against. Branch rows are not in it: a range
   * is a run of sessions, and a fold in the middle of one must not tick the
   * branch heading it crossed.
   */
  const sessionOrder = (): Target[] =>
    worktrees.rows.flatMap((r) => r.sessions.map((s) => ({ s, path: r.worktree.path })))

  const markSession = (
    target: { id: string; worktreePath: string },
    mode: 'toggle' | 'range'
  ): void => {
    const all = sessionOrder()
    const to = all.findIndex((t) => t.s.id === target.id)
    if (to === -1) return
    // ⇧-click with nothing ticked yet has no span to draw, so it behaves as the
    // first tick — which is also what it does in every file list there is.
    const from = mode === 'range' ? all.findIndex((t) => t.s.id === markAnchor.current) : -1
    markAnchor.current = target.id
    setMarks((now) => {
      const next = new Set(now)
      if (from === -1) {
        if (!next.delete(target.id)) next.add(target.id)
        return next
      }
      // A range only ADDS. Dragging back over rows you already ticked to untick
      // them is the gesture nobody means, and it silently undoes the first half
      // of a selection.
      const [lo, hi] = from < to ? [from, to] : [to, from]
      for (let i = lo; i <= hi; i++) next.add(all[i].s.id)
      return next
    })
  }

  const clearMarks = (): void => {
    markAnchor.current = null
    setMarks((now) => (now.size ? new Set() : now))
  }

  // Ticks name sessions, so a session that stopped existing — deleted here,
  // deleted from another window, or on a branch that was just removed — has to
  // let go of its tick. Otherwise the header keeps offering to delete four
  // things when only three are left, and `d` would ask about a phantom.
  const liveIds = worktrees.rows.flatMap((r) => r.sessions.map((s) => s.id)).join('\n')
  useEffect(() => {
    const live = new Set(liveIds ? liveIds.split('\n') : [])
    setMarks((now) => {
      if (!now.size) return now
      const next = new Set([...now].filter((id) => live.has(id)))
      return next.size === now.size ? now : next
    })
  }, [liveIds])

  // Switching project empties the list the ticks point into, the same way it
  // invalidates the worktree selection (see useWorktrees).
  useEffect(clearMarks, [projects.current?.path])

  /**
   * Give a session a name of your own.
   *
   * The row the cursor is on in the worktrees list, else the chat you have
   * open — the same rule `session.unread` follows, so `r` on a row and the
   * palette entry from the composer both rename the session you are looking at.
   *
   * The rename is also what stops Claude's own ai-title from following along
   * (see sessionStore.renameCreatedSession): once you have named it, it keeps
   * the name. Ticks are ignored on purpose — a name is one session's, and
   * renaming four chats to the same thing is not a thing anyone means.
   */
  const renameSession = (): void => {
    const at = cursorSession() ?? lane.panels.find((p) => p.session)?.session
    if (!at) return say('put the cursor on a session, or open a chat')
    // A panel's key is `claudeId ?? id` and a row's is the store id, so the two
    // names for one session have to be collected before either can be matched
    // against the other. The store resolves either on its own; the lane and the
    // current title do not.
    const found = worktrees.rows
      .flatMap((r) => r.sessions)
      .find((s) => s.id === at.id || s.claudeId === at.id)
    const keys = new Set([at.id, found?.id, found?.claudeId].filter((k): k is string => !!k))
    askText({
      placeholder: 'Name…',
      value: found?.title,
      verb: 'Call it',
      onDone: (title) => {
        const name = title.trim()
        if (!name) return
        void window.floe.claude.renameCreated(at.id, name).then(() => {
          worktrees.reload()
          // The chat header carries the name it was opened under, so renaming
          // the session you are IN has to repaint it — reloading the sidebar
          // never touches the lane.
          setLane((l) => {
            const i = l.panels.findIndex((p) => p.session && keys.has(p.session.id))
            return i === -1 ? l : patchPanel(l, i, { sub: name })
          })
        })
      }
    })
  }

  const deleteSession = (
    scope: 'one' | 'others' | 'all' | 'idle' | 'marked' | 'unmarked' = 'one'
  ) => {
    const at = lane.panels.findIndex((p) => p.session)
    const panel = lane.panels[at]
    const openId = panel?.session?.id

    // Forget a batch of sessions, then close whatever panel was showing one.
    // Each target carries its own worktree because the idle sweep crosses them;
    // the other bulk scopes just pass the same path for every session.
    //
    // Returns whether it went ahead, so a caller with its own state to tidy —
    // the ticks — can tell "deleted" from "you said no" and leave a cancelled
    // selection exactly as it was.
    const forget = async (targets: Target[], question: string): Promise<boolean> => {
      const n = targets.length
      const yes = await askConfirm({
        question,
        verb: n === 1 ? 'Delete session' : `Delete ${n} sessions`,
        detail: `Floe forgets ${n === 1 ? 'it' : 'them'} — the Claude ${n === 1 ? 'transcript stays' : 'transcripts stay'} on disk`
      })
      if (!yes) return false
      const gone = new Set(
        targets.flatMap(({ s }) => [s.id, s.claudeId].filter(Boolean) as string[])
      )
      await Promise.all(
        targets.map(({ s, path }) =>
          window.floe.claude.closeSession({ id: s.id, worktreePath: path, claudeId: s.claudeId })
        )
      )
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
      return true
    }

    // What you ticked in the worktrees list, wherever it sits — the ticks cross
    // branches, so this scope does too. With nothing ticked the row the cursor
    // is on IS the selection of one, which is what keeps `d` from being a dead
    // key on a list you have not ticked anything in yet.
    if (scope === 'marked') {
      const all = sessionOrder()
      const targets = marks.size
        ? all.filter((t) => marks.has(t.s.id))
        : all.filter((t) => t.s.id === cursorSession()?.id)
      if (!targets.length) return say('no session selected')
      const what =
        targets.length === 1
          ? `"${targets[0].s.title}"`
          : `${targets.length} selected sessions`
      // Only once it actually deleted. Answering "no" and finding the selection
      // gone would make the cancel cost as much as the delete.
      void forget(targets, `Delete ${what}?`).then((went) => went && clearMarks())
      return
    }

    // The other way round: keep what you ticked, throw away the rest. Same pool
    // as `marked` — the whole open project, across worktrees — because the two
    // scopes are one question asked from either end, and a "keep these" that
    // only cleared the current branch would leave the copies next door behind.
    //
    // A selection is required. With nothing ticked this would mean "delete
    // every session in the project", which is a different command with a
    // different confirm, and not one you should be able to reach by pressing a
    // key on a list you have not ticked anything in.
    if (scope === 'unmarked') {
      if (!marks.size) return say('select the sessions to keep first')
      const targets = sessionOrder().filter((t) => !marks.has(t.s.id))
      if (!targets.length) return say('every session is selected — nothing else to delete')
      void forget(
        targets,
        `Delete the other ${targets.length} session${targets.length > 1 ? 's' : ''}, keeping the ${marks.size} selected?`
      ).then((went) => went && clearMarks())
      return
    }

    // The housekeeping sweep: every session in the project that has not been
    // touched for an hour, across worktrees — a chat goes stale wherever it
    // sits, and clearing one branch at a time is not a clear-out. A turn in
    // flight keeps writing its transcript, so `mtime` already excludes it;
    // `running` is only the second lock on that door.
    if (scope === 'idle') {
      const cutoff = Date.now() - IDLE_MS
      const targets = worktrees.rows.flatMap((r) =>
        r.sessions
          .filter((s) => !s.running && s.mtime < cutoff)
          .map((s) => ({ s, path: r.worktree.path }))
      )
      if (!targets.length) return say('no session has been idle for an hour')
      void forget(targets, `Delete ${targets.length} session${targets.length > 1 ? 's' : ''} idle for over an hour?`)
      return
    }

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
      void askConfirm({
        question: `Delete "${name}"?`,
        verb: 'Delete session',
        detail: 'Floe forgets it — the Claude transcript stays on disk'
      }).then((yes) => {
        if (!yes) return
        void window.floe.claude.closeSession({ id, worktreePath, claudeId }).then(() => {
          setLane((l) => closePanel(l, at, () => panelOf('branch')))
          worktrees.reload()
        })
      })
      return
    }

    const picked = scope === 'others' ? sessions.filter((s) => !isOpen(s)) : sessions
    if (!picked.length) return
    const what =
      scope === 'others'
        ? `the other ${picked.length} session${picked.length > 1 ? 's' : ''}`
        : `all ${picked.length} session${picked.length > 1 ? 's' : ''}`
    void forget(
      picked.map((s) => ({ s, path })),
      `Delete ${what} on this worktree?`
    )
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

  /**
   * Go to one session named by the `active` panel — any project, any machine.
   *
   * Three cases, narrowing: another machine hands the target to the instance the
   * attach mounts (there is nothing to open on this one); another project files
   * the target under the memory refs and enters, because its worktree list is a
   * fetch away; the open project opens the chat panel straight away.
   *
   * Deliberately not enterWorktree: that lands on whatever chat the branch was
   * last left showing, which is right for a branch row and wrong for a row that
   * names a conversation.
   */
  const jumpToSession = (s: ActiveSession): void => {
    const key = s.claudeId ?? s.sessionId
    const backend = s.backend ?? LOCAL
    if (backend !== currentBackend()) {
      handOff({ path: s.projectPath, session: { worktreePath: s.worktreePath, sessionKey: key } }, self)
      // Refused: the machine went away since the list was built. Stay put rather
      // than land nowhere.
      if (!attach(backend)) {
        dropLanding()
        say(`${backendLabel(backend)} is not reachable.`)
      }
      return
    }
    byProject.current[s.projectPath] = s.worktreePath
    byWorktree.current[s.worktreePath] = key
    if (projects.current?.path !== s.projectPath) return enterProject(s.projectPath, false)
    worktrees.select(s.worktreePath)
    setLane((l) => open(l, mkPanel('chat', s.title, { id: key, worktreePath: s.worktreePath })))
  }

  /**
   * Open a chat picked in ⌘P — which may be in another project, or on another
   * machine, now that the list spans every one of them.
   *
   * The open project takes the short path: `openChat` puts the panel up without
   * re-entering anything, which is what a pick inside the project you are
   * already in should do. Everything else is the jump the `active` panel makes.
   */
  const openFinderChat = (chat: FinderChat): void => {
    if (chat.backend === currentBackend() && chat.projectPath === projects.current?.path)
      return ctxRef.current.openChat({ id: chat.id, worktreePath: chat.worktreePath })
    jumpToSession({
      projectPath: chat.projectPath,
      projectName: chat.projectName,
      worktreePath: chat.worktreePath,
      branch: chat.branch,
      sessionId: chat.sessionId,
      // The key the panel is filed under, which is `claudeId ?? id` — already
      // resolved into `chat.id`, so handing it over as the claudeId gives
      // jumpToSession the same key it would have computed.
      claudeId: chat.id,
      title: chat.title,
      lastActivityAt: chat.mtime,
      running: !!chat.running,
      needsYou: false,
      backend: chat.backend
    })
  }

  /**
   * Go to a project, then on to the branch it was left on — see enterWorktree.
   *
   * `list` is whether the worktree list comes with you. It does by default,
   * because picking a project IS a step towards picking a branch — but not when
   * the caller already knows which conversation it is headed for (the `active`
   * panel's rows do), where the list would be a panel you asked for on the way
   * to somewhere else, opened over and over.
   */
  const enterProject = (path: string, list = true): void => {
    // Another project means another repo, so what is on screen stops applying:
    // the panels the old project opened close and the new one's chat brings its
    // own back (withoutProject). Re-entering the project you are already in is
    // not a switch and takes nothing away.
    const leaving = !!projects.current && projects.current.path !== path
    // Going somewhere on purpose ends the boot restore, which may still be
    // waiting on a remote list and would pull the selection back when it lands.
    landedProject.current = true
    projects.select(path)
    // Its worktrees are a fetch away, so the rest of the restore happens when
    // they arrive.
    pending.current = { project: path, boot: false }
    const name = projects.all.find((p) => p.path === path)?.name
    const panel = list ? panelOf('worktrees', name) : null
    setLane((l) => {
      const base = panel ? open(leaving ? withoutProject(l) : l, panel) : leaving ? withoutProject(l) : l
      if (!leaving) return base
      // The board went out with the old project; the new one gets its own back,
      // open or closed as it was left. Focus stays on the worktree list — the
      // switch is a step towards a branch, and a restored panel is not where you
      // were headed. With no list, focus is left where it is: the panel that
      // sent you here is still on screen, and the chat takes it when it opens.
      const back = (railByProject.current[path] ?? []).reduce(
        (acc, kind) => open(acc, panelOf(kind as PanelKind)),
        base
      )
      return panel ? focusAt(back, back.panels.findIndex((p) => p.id === panel.id)) : back
    })
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
   * The guided merge, one flow per worktree.
   *
   * Everything the chain needs from the app is passed in rather than reached
   * for: it opens a chat for the conflict-resolution turn, stops the turns
   * running in a worktree it is about to tear down, and clears what that
   * worktree had on screen once it is gone. The hook owns the git steps and
   * nothing else.
   *
   * `here` decides which checklist is on screen, like every other worktree
   * command: branches merge independently, so a flow stuck on a failed step is
   * left where it is instead of standing in front of the next merge.
   */
  const merge = useMerge({
    root: projects.current?.path,
    worktreePath: here,
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

  /**
   * The guided removal, one flow per project.
   *
   * Given the same two seams the merge's teardown uses — stop the turns running
   * in the worktree, then clear what it had on screen — because it is the same
   * teardown, reached without the merge in front of it.
   */
  const remove = useRemove({
    root: projects.current?.path,
    stopAgents: (worktreePath) => {
      const row = worktrees.rows.find((r) => r.worktree.path === worktreePath)
      for (const s of row?.sessions ?? []) void window.floe.agent.stop(s.claudeId ?? s.id)
    },
    onWorktreeGone: (worktreePath) => {
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
    show: () => setLane((l) => open(l, panelOf('remove')))
  })

  /**
   * The worktree's environment, one checklist per worktree.
   *
   * Runs on create — the whole reason it is wired here rather than left to the
   * MCP path: a worktree handed over without its `.env`, its dependencies, its
   * site and its own database is one you test against the WRONG branch, and
   * nothing on screen says so.
   */
  const provision = useProvision({
    here,
    show: () => setLane((l) => open(l, panelOf('provision'))),
    // The recipe writes the worktree's `.env` and can register commands, so
    // what reads those has to look again.
    onDone: (worktreePath) => {
      if (worktreePath === here) commands.reload()
      worktrees.reload()
    }
  })

  /**
   * The project setup, one flow per project.
   *
   * The session it opens is deliberately NOT put on screen (D1): the panel is
   * what you watch, and the chat only matters at the one step where the agent
   * asks — which is why `openChat` is a seam of its own rather than something
   * the flow does on its way past.
   */
  const setup = useProjectSetup({
    root: projects.current?.path,
    show: () => setLane((l) => open(l, panelOf('setup'))),
    // The checklist comes with you. Going to the chat is one step of the setup,
    // not the end of it: you answer the agent's question and then watch the
    // last step close. It survives the session switch on its own (see
    // PROJECT_PANELS in laneStore); opening it here as well is for the case
    // where it was closed — the command puts back what it is talking about.
    // The chat opens LAST, which is what leaves the focus in the composer.
    openChat: (session) =>
      setLane((l) =>
        open(open(l, panelOf('setup')), mkPanel('chat', 'set up commands', session))
      )
  })

  /**
   * What happens after an add: report the refusal, or set the project up.
   *
   * Only for a project Floe has never seen (D6). A re-add lands you on a
   * project that has been in the list for months, and opening a checklist over
   * it would answer a question nobody asked — `setup.start` in the palette is
   * the way to run it deliberately.
   */
  setupRunning.current = !!setup.flow

  const afterAdd = (res: { error?: string; path?: string; created?: boolean }): void => {
    if (res.error) return say(res.error)
    if (res.created && res.path) setup.start(res.path)
  }

  // Pick up the landing left by whatever moved the window here — opening a
  // project on another machine, or adding one there. Claimed as it is applied,
  // so the instance the move brought up is the only one that lands it.
  useEffect(() => {
    const handoff = peekLanding(self)
    // Not before the union has loaded: entering a project reads its row for the
    // panel's name, and an empty list would open a nameless one.
    if (!handoff || projects.loading) return
    dropLanding()
    // A landing that names a session (the `active` panel's rows do) files it
    // under the same memory refs a local jump uses, so the restore that runs
    // when this project's worktrees arrive lands on the conversation rather
    // than on the branch's last one.
    if (handoff.session) {
      byProject.current[handoff.path] = handoff.session.worktreePath
      byWorktree.current[handoff.session.worktreePath] = handoff.session.sessionKey
    }
    // The same entry a project on this machine gets — select it, bring its
    // worktrees, let the branch and chat follow. Crossing a machine to get here
    // is the only difference, and it is not one the landing should show. A
    // landing that names a session skips the list for jumpToSession's reason.
    enterProject(handoff.path, !handoff.session)
    // The saved-project restore must not pull the selection back once the list
    // arrives: landing on what we came here for IS this mount's restore, and
    // both machines can hold a project at the same path.
    landedProject.current = true
    if (handoff.created) setup.start(handoff.path)
  }, [projects.loading])

  // Every name the open session answers to — Floe's id and the claudeId — so
  // a question in the chat you are reading is never announced as elsewhere.
  const openNames = useMemo(() => {
    if (!sessionKey) return []
    for (const r of worktrees.rows) {
      const s = r.sessions.find((s) => s.id === sessionKey || s.claudeId === sessionKey)
      if (s) return s.claudeId ? [s.id, s.claudeId] : [s.id]
    }
    return [sessionKey]
  }, [sessionKey, worktrees.rows])

  // A session blocked on you, somewhere you are not looking: the OS says so.
  // The sound already covers "a turn ended"; this is the one event that goes
  // nowhere until you act, which is why it gets the notification.
  useNeedsYouNotifier({
    openKeys: openNames,
    describe: (key) => {
      for (const r of worktrees.rows) {
        const s = r.sessions.find((s) => s.id === key || s.claudeId === key)
        if (s) return { title: s.title, where: whereOf(r.worktree.path) }
      }
      return undefined
    }
  })

  // Clicking the notification opens the session it named — in this project
  // straight away, in another through the same landing the active panel uses.
  const openByKeyRef = useRef<(key: string) => void>(() => {})
  useEffect(() => window.floe.onNotificationClick((key) => openByKeyRef.current(key)), [])
  openByKeyRef.current = (key: string): void => {
    for (const r of worktrees.rows) {
      const s = r.sessions.find((s) => s.id === key || s.claudeId === key)
      if (!s) continue
      worktrees.select(r.worktree.path)
      setLane((l) => open(l, mkPanel('chat', s.title, { id: s.claudeId ?? s.id, worktreePath: r.worktree.path })))
      return
    }
    void window.floe.projects.allSessions().then((all) => {
      const s = all.find((x) => x.sessionId === key || x.claudeId === key)
      if (s) jumpToSession({ ...s, needsYou: true })
      else say('that session is gone')
    })
  }

  // ⌃W: back to the chat you came from — in this project, or in the one the
  // `active` panel took you out of. Crossing a project or a machine is
  // jumpToSession's job, so ⌃W hands it the row it would have built: the panel
  // already carries `claudeId ?? id`, which is the key that opens the chat.
  const alternateSession = () => {
    const a = alternate.current
    const s = a?.panel.session
    if (!a || !s) return
    if (a.backend !== currentBackend() || (a.projectPath && a.projectPath !== projects.current?.path)) {
      jumpToSession({
        projectPath: a.projectPath ?? '',
        projectName: '',
        worktreePath: s.worktreePath,
        branch: '',
        sessionId: s.id,
        title: a.panel.sub ?? '',
        lastActivityAt: 0,
        running: false,
        needsYou: false,
        backend: a.backend
      })
      return
    }
    setLane((l) => open(l, mkPanel('chat', a.panel.sub, s)))
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
   * Where focus goes in a panel with no rows to land on, when the panel itself
   * is the wrong answer. The terminal marks its xterm textarea: focusing the
   * panel shell instead hands you a terminal you cannot type into, which is
   * what ⌃L back into an open one used to do.
   */
  const focusSink = (panel: HTMLElement | null | undefined): HTMLElement | null =>
    panel?.querySelector<HTMLElement>('[data-focus-sink]') ?? null

  /* --- marking lines with the mouse ---------------------------------------
   *
   * The same selection `v` opens, made by dragging. The grab handle is the
   * GUTTER — the line-number column — and only the gutter: dragging across the
   * code still selects text, which is how a line gets copied out of a diff.
   * One press marks one line, a drag marks the range, shift extends what is
   * already open; `c` then comments it, exactly as after `v`.
   */
  // The drag carries the panel's ELEMENT, not just its index: the window
  // listeners below are installed once, so anything they read off this render's
  // `lane` — `panelAt` included — would be the lane as it was at boot.
  const dragSel = useRef<{ panel: number; el: HTMLElement; anchor: number } | null>(null)

  /**
   * The chip that floats over a marked block: `c` for the hand already on the
   * mouse. The keyboard never needs it — which is why it is a second route to
   * one command, not a second way of commenting — but a block marked by
   * dragging has to say what it can do next, on screen, where the drag ended.
   */
  const [selTip, setSelTip] = useState<{ x: number; y: number } | null>(null)

  // In a ref because the drag's window listeners are installed once: they call
  // the CURRENT placement, not the one from the render that installed them.
  const placeSelTip = useRef<() => void>(() => {})
  placeSelTip.current = () => {
    const panel = lane.panels[lane.focus]
    const el = panelAt(lane.focus)
    const body = el?.querySelector('.panel-body')?.getBoundingClientRect()
    const head = panel?.selection ? rowsOf(el)[panel.selection.head]?.getBoundingClientRect() : undefined
    const live = panel?.kind === 'diff' || panel?.kind === 'file'
    // Scrolled out of sight, and it is pointing at nothing: an offer that hangs
    // at the edge of the panel over rows it does not act on is worse than none.
    const seen =
      head && body && head.bottom > body.top && head.top < body.bottom && body.left < window.innerWidth
    if (!live || !body || !head || !seen || dragSel.current) {
      setSelTip((now) => (now === null ? now : null))
      return
    }
    // On the head row, at the right edge — where a drag ends, and the one part
    // of a line of code that is reliably empty. Anywhere over the gutter would
    // cover the numbers you are selecting by.
    //
    // The edge is the WINDOW's when the panel runs past it: the lane scrolls
    // sideways, so a panel's own right edge is regularly off screen, and a chip
    // pinned to it would be an offer nobody can see.
    const next = {
      x: Math.round(Math.max(body.left + 8, Math.min(body.right, window.innerWidth) - TIP_W - 10)),
      y: Math.round(
        Math.min(Math.max(head.top + (head.height - TIP_H) / 2, body.top + 2), body.bottom - TIP_H - 2)
      )
    }
    setSelTip((now) => (now && now.x === next.x && now.y === next.y ? now : next))
  }

  // Every render: the selection, the panel and the scroll position all move it,
  // and the guard above means an unchanged position costs nothing. Scrolling
  // the body is the one mover React never re-renders for, hence the listener.
  useEffect(() => {
    placeSelTip.current()
  })
  useEffect(() => {
    const replace = (): void => placeSelTip.current()
    window.addEventListener('scroll', replace, true)
    window.addEventListener('resize', replace)
    return () => {
      window.removeEventListener('scroll', replace, true)
      window.removeEventListener('resize', replace)
    }
  }, [])

  /** The index of the row under `target`, in the same list the cursor indexes. */
  const rowIndexAt = (panel: HTMLElement | undefined, target: EventTarget | null): number => {
    const row = (target as HTMLElement | null)?.closest?.<HTMLElement>('[data-nav], button')
    return row ? rowsOf(panel).indexOf(row) : -1
  }

  const startLineDrag = (e: ReactMouseEvent, panelIndex: number): void => {
    const panel = lane.panels[panelIndex]
    const el = panelAt(panelIndex)
    if (!panel || (panel.kind !== 'diff' && panel.kind !== 'file') || e.button !== 0) return
    // The gutter is "the row, minus its text column" rather than the number
    // spans themselves: an added line's old-number cell is empty, and an empty
    // grid item on a baseline row is zero pixels tall — a handle you cannot hit.
    const hit = e.target as HTMLElement | null
    if (!hit?.closest('.diff-row, .diff-hunk') || hit.closest('.diff-code, .md-text')) return
    const at = rowIndexAt(el, e.target)
    if (at === -1 || !el) return
    // The gutter drags lines, not text — and the row is focused by hand because
    // the default that would have done it is exactly what we just cancelled.
    e.preventDefault()
    rowsOf(el)[at]?.focus({ preventScroll: true })
    const anchor = dragAnchor(panel.selection, panel.cursor, at, e.shiftKey)
    dragSel.current = { panel: panelIndex, el, anchor }
    setLane((l) => patchPanel(focusAt(l, panelIndex), panelIndex, { cursor: at, selection: { anchor, head: at } }))
  }

  // On the window, not the panel: a drag that runs off the bottom of the panel
  // is still the same drag, and it has to end wherever the button comes up.
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const drag = dragSel.current
      if (!drag) return
      const at = rowIndexAt(drag.el, e.target)
      if (at === -1) return
      rowsOf(drag.el)[at]?.focus({ preventScroll: true })
      setLane((l) => {
        const panel = l.panels[drag.panel]
        if (!panel || (panel.cursor === at && panel.selection?.head === at)) return l
        return patchPanel(l, drag.panel, { cursor: at, selection: { anchor: drag.anchor, head: at } })
      })
    }
    const up = () => {
      dragSel.current = null
      // The chip is hidden for the length of the drag — it would sit under the
      // pointer, over the very lines being marked — so releasing is what brings
      // it back, and no lane change follows a release to do it for us.
      placeSelTip.current()
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [])

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
   * The session the worktrees cursor is on, or undefined when it is on a branch.
   *
   * Off the row's own `data-session`, for the same reason `projectAtCursor`
   * reads `data-project`: the list is grouped and foldable, so an index into
   * "sessions, ignoring branches" would tick the wrong chat the first time
   * somebody collapsed one.
   */
  const cursorSession = (): { id: string; worktreePath: string } | undefined => {
    if (lane.panels[lane.focus]?.kind !== 'worktrees') return undefined
    const row = rowsOf(panelAt(lane.focus))[lane.panels[lane.focus]?.cursor ?? -1]
    const id = row?.dataset.session
    const worktreePath = row?.dataset.worktree
    return id && worktreePath ? { id, worktreePath } : undefined
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
   * Where each go-to-definition left from, newest last — what `-` walks back.
   *
   * The panel as it was, cursor included, so going back lands on the line you
   * jumped from. State rather than a ref: the header's back button shows only
   * while there is somewhere to go. Cleared on a worktree switch, where the
   * paths it holds would name files in a tree you are no longer in.
   */
  const [jumps, setJumps] = useState<Panel[]>([])
  useEffect(() => setJumps([]), [cwd])

  // Mark the document while ⌘/ctrl is down, so names in a code view underline
  // as links (index.css). Cleared on blur too: a ⌘-tab away never sends keyup.
  useEffect(() => {
    const mark = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey) document.documentElement.dataset.jumpKey = ''
      else delete document.documentElement.dataset.jumpKey
    }
    const clear = (): void => void delete document.documentElement.dataset.jumpKey
    window.addEventListener('keydown', mark)
    window.addEventListener('keyup', mark)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', mark)
      window.removeEventListener('keyup', mark)
      window.removeEventListener('blur', clear)
    }
  }, [])

  /**
   * Focus and centre row `index` of the panel `id` once it shows `path`.
   *
   * A jump opens a file that is not read yet, and the row it aims at does not
   * exist until the read lands — so this waits for the viewer to mark itself
   * with the path (`data-path`), which also keeps it off the rows of the file
   * that is still on screen for the frame before the swap.
   */
  const revealRow = (id: string, path: string, index: number): void => {
    const until = Date.now() + 3000
    const step = (): void => {
      const el = refs.current.get(id)
      const rows = el?.querySelector(`[data-path="${CSS.escape(path)}"]`) ? rowsOf(el) : []
      const row = rows[Math.min(index, rows.length - 1)]
      if (!row) {
        if (Date.now() < until) requestAnimationFrame(step)
        return
      }
      // Focusing the row is what moves the cursor (onFocusCapture).
      row.focus({ preventScroll: true })
      row.scrollIntoView({ block: 'center' })
      // The cursor already says this row, so the focus changes no state and
      // nothing re-renders to paint the mark on rows that arrived late.
      setLane((l) => ({ ...l }))
    }
    requestAnimationFrame(step)
  }

  /**
   * Open the file defining the first of `names` that has a definition, on its
   * line, and remember where this left from. Always the file reader, even out
   * of a diff: the definition is usually in code the branch did not touch.
   */
  const goToDefinition = async (from: Panel, names: string[], line?: number): Promise<void> => {
    const root = from.root ?? cwd
    const path = from.sub
    if (!root || !path || (from.kind !== 'file' && from.kind !== 'diff')) return
    for (const name of names) {
      const defs = await window.floe.files.definition(root, name, path).catch(() => [])
      const target = pickDefinition(defs, { path, line })
      if (!target) continue
      const panel = mkPanel('file', target.path, undefined, undefined, undefined, from.root)
      const at = target.line - 1
      setJumps((prev) => [...prev.slice(-49), from])
      setLane((l) => {
        const next = open(l, panel)
        return patchPanel(next, next.focus, { cursor: at, selection: null })
      })
      revealRow(panel.id, target.path, at)
      return
    }
    say(names.length === 1 ? `no definition found for ${names[0]}` : 'no definition found on this line')
  }

  /** Put back the panel the last jump left from, on the line it left from. */
  const jumpBack = (): void => {
    const spot = jumps[jumps.length - 1]
    if (!spot) return
    setJumps((prev) => prev.slice(0, -1))
    // Rebuilt from what it showed, not reinserted as it was: its old width and
    // dock belong to a box the lane may have rearranged since.
    const panel = { ...mkPanel(spot.kind as PanelKind, spot.sub, undefined, undefined, undefined, spot.root), view: spot.view }
    const at = spot.cursor ?? 0
    setLane((l) => {
      const next = open(l, panel)
      return patchPanel(next, next.focus, { cursor: at, selection: null, view: spot.view })
    })
    revealRow(panel.id, spot.sub ?? '', at)
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
   * Open this worktree's premise in the editor, creating the scaffold first.
   *
   * Same editor path as a skill's Markdown — main answers with the relative
   * path so the launch is rooted at the worktree, like every other file.
   */
  const editPremise = (): void => {
    const dir = current?.worktree.path
    if (!dir) return
    void window.floe.premise.ensure(dir).then((rel) => editSkill(dir, rel))
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

  // The tab of the panel you are on follows it into view. With more panels open
  // than fit the strip, swiping to the last one otherwise leaves the row parked
  // where it was and the tab that matters off the end of it.
  useEffect(() => {
    if (!narrow) return
    tabsRef.current
      ?.querySelector('[data-on]')
      ?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [lane.focus, narrow])

  // Rotating the phone — or unfolding it — changes what one column is worth,
  // and the lane keeps the scroll offset it had: it comes to rest between two
  // panels. Snapping only governs the NEXT gesture, so the focused panel is put
  // back by hand. Instant, not smooth: this is a correction, not a move.
  useEffect(() => {
    const settle = (): void => {
      panelAt(lane.focus)?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
    }
    window.addEventListener('resize', settle)
    return () => window.removeEventListener('resize', settle)
  }, [lane.focus])

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
      // Narrow has no pinning — the chat is a screen wide, so it is scrolled
      // past like everything else. Reserving its width here would reserve the
      // whole viewport and park every panel one screen off the right edge.
      // Narrow has no pinning — the chat is a screen wide, so it is scrolled
      // past like everything else. Reserving its width would reserve the whole
      // viewport; even the desktop's +16 is wrong here, since it lands the
      // panel 8px short of the gutter and leaves a stripe of its neighbour
      // showing. The lane's own padding is where a panel comes to rest.
      const pinned = narrow ? null : laneEl.querySelector<HTMLElement>('[data-sticky]')
      const reserve = narrow ? 8 : (pinned?.offsetWidth ?? 0) + 16
      laneEl.style.scrollPaddingInlineStart = `${reserve}px`
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
      ;(row ?? focusSink(el) ?? el).focus({ preventScroll: true })
      // Record the default as the cursor, rather than leaving it implicit in
      // DOM focus. Otherwise the row is focused but unmarked, and the next j
      // would start counting from nowhere instead of from where you are.
      if (at == null && idx != null) setLane((l) => setCursor(l, lane.focus, idx))
    }
  }, [lane.focus, lane.panels.length, narrow])

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

  // Each panel's cursor and the `data-key` of every row at the last paint.
  const cursorRows = useRef(new Map<string, { cursor: number; keys: (string | undefined)[] }>())

  // Paint the cursor. It's an attribute rather than a class passed down because
  // no panel body knows it has a cursor — the lane owns that, for every panel
  // that exists now or later. A row keeps its mark while the panel is unfocused,
  // which is what makes "where was I" answerable at a glance.
  //
  // The cursor is an index, so a list that changes under it — a merge tearing
  // down a worktree above it — would leave the mark on whichever row inherited
  // the position. Rows that carry a `data-key` keep the cursor on the same row
  // instead; a row that is gone hands it to the next row that survived.
  useEffect(() => {
    lane.panels.forEach((panel, i) => {
      const rows = rowsOf(panelAt(i))
      const sel = selRange(panel.selection)
      const keys = rows.map((r) => r.dataset.key)
      let cursor = panel.cursor
      const last = cursorRows.current.get(panel.id)
      const was = cursor != null && last?.cursor === cursor ? last.keys[cursor] : undefined
      if (cursor != null && was && rows.length && keys[cursor] !== was) {
        const old = last!.keys
        const survivors = [...old.slice(cursor), ...old.slice(0, cursor).reverse()]
        const heir = survivors.find((k) => k && keys.includes(k))
        cursor = heir ? keys.indexOf(heir) : Math.min(cursor, rows.length - 1)
        const moved = cursor
        setLane((l) => setCursor(l, i, moved))
        // The focused row went with its worktree: focus fell to the body, and
        // the next j would have nowhere to start from.
        if (i === lane.focus && document.activeElement === document.body)
          rows[cursor]?.focus({ preventScroll: true })
      }
      // An empty list is a panel still loading, not a list that lost its rows.
      if (cursor != null && rows.length) cursorRows.current.set(panel.id, { cursor, keys })
      rows.forEach((row: HTMLElement, j: number) => {
        if (cursor === j) row.setAttribute('data-cursor', '')
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
    editPremise,
    panelEl: panelAt,
    rowsOf,
    project: projects.current?.path,
    openChat: (session, firstPrompt) => setLane((l) => open(l, mkPanel('chat', undefined, session, firstPrompt))),
    openNanny: (session, firstPrompt) =>
      setLane((l) =>
        open(l, {
          ...mkPanel('nanny', undefined, session, firstPrompt),
          // Docked by default, and only by default: `open` hands a replacement
          // the OUTGOING panel's layout, so once you have undocked her or
          // dragged her height, that is what comes back — this is the first
          // impression, not a rule.
          dock: 'below'
        })
      ),
    makePanel: (kind, sub, root) => mkPanel(kind as PanelKind, sub, undefined, undefined, undefined, root),
    canOpen,
    whyCannotOpen,
    browser: {
      address: () => {
        const input = document.querySelector<HTMLInputElement>('.browser-address input')
        // select() too: pressing it again while the field already has focus
        // must still select the whole URL, and onFocus will not fire twice.
        input?.focus()
        input?.select()
      },
      back: () => void window.floe.browser.back(),
      forward: () => void window.floe.browser.forward(),
      reload: () => void window.floe.browser.reload(),
      stop: () => void window.floe.browser.stop(),
      focus: () => void window.floe.browser.focus(),
      devtools: () => void window.floe.browser.devtools(),
      screenshot: () => void window.floe.browser.screenshot().catch((e) => console.error('browser screenshot', e))
    },
    commands,
    // The registry quotes from the same patch the panel is showing; reading it
    // here rather than re-fetching keeps the quote and the highlight in step.
    patchFor: () => lastPatch.current,
    openPalette: () => setPaletteOpen(true),
    openCommands: () => setCommandsOpen(true),
    openKeys: () => setKeysOpen(true),
    openFiles: () => {
      // Opens empty and fills: reading a large repo takes a moment, and a
      // palette that waits for it looks like the key did nothing. The chats are
      // in the box from the first frame either way — the last answer is still
      // held, and they are the rows you are most likely to have opened it for.
      setFinderFiles([])
      // Re-asked on every open rather than polled: this is the one moment the
      // list is read, and a session created behind the app has to be in it.
      loadChats((slice, backend) => setChatIndex((prev) => mergeChats(prev, slice, backend)))
      // No worktree — no files, and the chats are the whole list. ⌘P still
      // opens, because "where was that conversation" is asked from anywhere.
      if (here) void window.floe.files.all(here).then(setFinderFiles)
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
    confirm: (opts) => askConfirm(opts),
    createGroup: () => pickGroup('New group…', { create: true, onPick: (g) => void projects.addGroup(g) }),
    reloadProjects: () => projects.reload(),
    // Floe's label only: the folder keeps its name on disk, which is the whole
    // point — a repo cloned into a cryptic directory reads as what you call it.
    renameProject: () => {
      const renameTo = (project: Project): void =>
        askText({
          placeholder: `Rename "${project.name}" to…`,
          value: project.name,
          verb: 'Rename project',
          onDone: (name) => void projects.rename(project.path, name)
        })
      const project = projectAtCursor()
      if (project) return renameTo(project)
      // From the palette there is no row to read: ask which one, the way
      // `project.delete` does.
      setPicker({
        placeholder: 'Rename which project?',
        items: projects.all.map((p) => ({ id: p.path, title: p.name, detail: p.group })),
        onPick: (path) => {
          const picked = projects.all.find((p) => p.path === path)
          if (picked) renameTo(picked)
        }
      })
    },
    deleteProject: () => {
      // What is being removed is Floe's record of the project, not the code:
      // say so, because "delete" over a folder full of work reads much worse
      // than what this does.
      const confirmRemoval = (project: Project): void => {
        void askConfirm({
          question: `Remove "${project.name}" from Floe?`,
          verb: 'Remove project',
          detail: 'the folder stays on disk'
        }).then((yes) => {
          if (yes) void projects.remove(project.path)
        })
      }
      const project = projectAtCursor()
      if (project) return confirmRemoval(project)
      // From the palette, or with the cursor off the list, there is no row to
      // read: ask which one, the way `project.move` does.
      setPicker({
        placeholder: 'Remove which project?',
        items: projects.all.map((p) => ({ id: p.path, title: p.name, detail: p.group })),
        onPick: (path) => {
          const picked = projects.all.find((p) => p.path === path)
          if (picked) confirmRemoval(picked)
        }
      })
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
          void askConfirm({ question: `Delete the group "${g}"?`, verb: 'Delete group', detail: moved.trim() || undefined }).then(
            (yes) => {
              if (yes) void projects.deleteGroup(g)
            }
          )
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
    // Same flattening as the merge's, and `here` for the same reason: the
    // branch you are in is the one ⌘K X means, whether you got there from the
    // sidebar or from a chat.
    remove: {
      active: !!remove.flow,
      failed: !!remove.flow?.steps.some((s) => s.status === 'error'),
      awaiting: !!remove.flow?.awaiting,
      start: () => {
        const wt = worktrees.rows.find((r) => r.worktree.path === here)?.worktree
        if (!wt) return say('no worktree to remove')
        const why = remove.start(wt)
        if (why) say(why)
      },
      force: remove.force,
      retry: remove.retry,
      cancel: remove.cancel
    },
    provision: {
      active: !!provision.flow,
      idle: !!provision.flow && !provision.flow.running,
      start: () => {
        const wt = worktrees.rows.find((r) => r.worktree.path === here)?.worktree
        if (!wt || !projects.current) return say('no worktree to set up')
        if (wt.isMain) return say('the main checkout is not provisioned — open a worktree')
        provision.start({
          root: projects.current.path,
          worktreePath: wt.path,
          branch: wt.branch
        })
      },
      retry: provision.retry,
      dismiss: provision.dismiss
    },
    // The checklist's state, flattened the way the merge's and the removal's
    // are: the commands ask what the setup is waiting for, never what step it
    // is on.
    setup: {
      active: !!setup.flow,
      failed: !!setup.flow?.steps.some((s) => s.status === 'error'),
      awaitingChoice: !!setup.flow?.steps.some((s) => s.status === 'blocked'),
      canStart: !!projects.current,
      start: () => {
        const why = setup.start()
        if (why) say(why)
      },
      retry: setup.retry,
      cancel: setup.cancel,
      openChat: setup.openChat
    },
    renameSession,
    resumeSession: () => {
      const worktreePath = here
      if (!worktreePath) return
      void window.floe.claude
        .harnessHistory(worktreePath)
        .then((found) => {
          if (!found.length) return say('no claude or codex sessions to resume here')
          setPicker({
            placeholder: 'Resume which session?',
            items: found.map((s) => ({
              id: `${s.harness}:${s.id}`,
              title: s.title,
              detail: `${s.harness} · ${timeAgo(s.mtime)}${s.active ? ' · active' : ''}`
            })),
            onPick: (picked) => {
              const s = found.find((f) => `${f.harness}:${f.id}` === picked)
              if (!s) return
              void window.floe.claude
                .resumeHarness(worktreePath, s.harness, s.id)
                .then(({ sessionId, title }) => {
                  setLane((l) => open(l, mkPanel('chat', title, { id: sessionId, worktreePath })))
                  worktrees.reload()
                })
                .catch((e: unknown) => say(`could not resume: ${(e as Error).message}`))
            }
          })
        })
        .catch((e: unknown) => say(`could not read session history: ${(e as Error).message}`))
    },
    deleteSession,
    markedSessions: [...marks],
    markSession,
    clearMarkedSessions: clearMarks,
    cycleSession,
    // Undefined until there IS one, which is also how the command knows to dim
    // itself: on the first chat of a session there is nowhere to go back to.
    alternateSession: alternate.current?.panel.session ? alternateSession : undefined,
    goToDefinition: (names, line) => {
      const from = lane.panels[lane.focus]
      if (from) void goToDefinition(from, names, line)
    },
    jumpBack: jumps.length ? jumpBack : undefined,
    pendingUpdate: pendingUpdate?.version,
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
      setNewWtError(null)
      setNewWtBusy(false)
      setNewWt(true)
      // The form lives at the top of the worktrees panel, so the panel has to
      // be up — and focused, so the input's own focus lands inside the panel
      // the lane already calls current.
      setLane((l) => open(l, panelOf('worktrees')))
    },
    worktreeNames: worktrees.rows.map((r) => r.worktree.branch),
    // Every kind the rail offers, in its order — what "Go to …" lists.
    gotoTargets: RAIL.flat(),
    // ⌘1–9. The row order is the sidebar's, so the number matches what is on
    // screen, and enterWorktree is the same landing a click gets.
    enterWorktreeAt: (index: number) => {
      const row = worktrees.rows[index]
      if (row) enterWorktree(row.worktree.path)
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

  // --- Queries -----------------------------------------------------------------
  // A query is born on any of four doors — the composer, an agent's
  // `send_message`, a scheduled followup, or the model writing `@codex` into
  // its own answer — and only the first of them has a panel in front of it. So
  // the panel appears by being TOLD, not by whoever typed opening it: main
  // announces, and every door lands in the same place.
  //
  // Behind a ref for the same reason the MCP listener is: one subscription,
  // mounted once, always calling this render's closure.
  const openQueryRef = useRef<
    (p: { query: Query; worktreePath: string; parentKeys: string[] }) => void
  >(() => {})
  useEffect(() => window.floe.query.onOpened((p) => openQueryRef.current(p)), [])
  openQueryRef.current = ({ query, worktreePath, parentKeys }): void => {
    const session = { id: query.id, worktreePath }
    setLane((l) => {
      // Only into the chat it belongs to. An agent can open a query off ANY
      // session — over `send_message`, on a followup timer — and the lane is
      // showing whichever chat you are reading: dropped in unconditionally, the
      // panel for another session's query appeared beside yours and was then
      // saved as part of YOUR chat's panel set, coming back every time you
      // opened it. The panel for a session you are not looking at arrives when
      // you go there, from the store, like everything else that chat owns.
      // Every name the parent answers to, resolved in main — the panel keys
      // itself `claudeId ?? id` and the query is named after the stable id.
      const shown = sessionKeyOf(l)
      if (!shown || !parentKeys.includes(shown)) return l
      const next = open(l, mkPanel('query', query.harness, session))
      // A query panel is identified by its HARNESS (`query:codex`), so asking
      // codex a second thing focuses the panel already open instead of stacking
      // another. `open` focuses an existing id without touching what it shows —
      // right for every other panel, wrong here: the codex panel left over from
      // another session would come back still keyed to that session's query,
      // streaming a conversation nobody is having. So it is pointed at this one.
      return patchPanel(next, next.focus, { session })
    })
  }

  // And down again when it ends. Merge and discard both close the panel; what
  // stays behind is the fold in the chat, which the transcript draws from the
  // chip main wrote — not from anything held here.
  const closeQueryRef = useRef<(p: { key: string }) => void>(() => {})
  useEffect(() => window.floe.query.onClosed((p) => closeQueryRef.current(p)), [])
  closeQueryRef.current = ({ key }): void => {
    // Out of the remembered sets too, not only out of the lane on screen. A
    // query merged over MCP while you are reading another chat closes a panel
    // that is not mounted — and the copy saved under its own session came back
    // as an orphan the next time you opened that chat, streaming a conversation
    // that had already ended.
    bySession.current = Object.fromEntries(
      Object.entries(bySession.current).map(([id, panels]) => [
        id,
        panels.filter((p) => !(p.kind === 'query' && p.session?.id === key))
      ])
    )
    setLane((l) => {
      const at = l.panels.findIndex((p) => p.kind === 'query' && p.session?.id === key)
      return at === -1 ? l : closePanel(l, at, () => panelOf('branch'))
    })
  }

  // --- MCP control server -----------------------------------------------------
  // Commands an agent's tool pushed from main over mcp:command. run_command and
  // list_commands go through the SAME registry the keymap and the palette use —
  // that is the whole contract: one command written once behaves the same for
  // all three callers. Kept behind a ref so the one subscription (mounted once
  // below) always calls the render's current closure.
  const handleMcpCommandRef = useRef<(command: McpCommand) => void>(() => {})
  useEffect(() => window.floe.mcp.onCommand((c) => handleMcpCommandRef.current(c)), [])
  // A `floe <path>` that had to start the app: main registered the project
  // before this window existed and holds it until someone claims it. Asked for
  // here rather than pushed from main, which would race this very subscription.
  useEffect(() => {
    void window.floe.cli.pending().then((path) => {
      if (path) handleMcpCommandRef.current({ kind: 'select_project', callerKey: 'cli', projectPath: path })
    })
  }, [])
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
          commands: listCommands(REGISTRY, ctxRef.current, (id, arg) => keyHint(binds, id, arg)?.all)
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
      case 'select_project': {
        // The list on screen is a beat behind whoever asked: `floe <path>` may
        // have registered this repo a millisecond ago, and entering a project
        // the renderer has never heard of lands on a rail with no row. Re-read
        // first, then enter — the selection survives the list arriving.
        projects.reload()
        if (projects.current?.path !== command.projectPath) enterProject(command.projectPath)
        return
      }
      case 'open_browser': {
        // Into the chat that asked. An agent keeps working after you move to
        // another project, and opening into the lane on screen put its preview
        // beside a chat that never asked for it. Off screen, the panel is filed
        // with that chat's set and comes up when you go back — the same rule a
        // query panel follows.
        const keys = command.sessionKeys
        const shown = sessionKeyOf(ctxRef.current.lane)
        if (!keys.length || (shown && keys.includes(shown))) {
          runCommand(REGISTRY, ctxRef.current, 'browser.open')
          // Open, then hand the page over — the order bash.preview and
          // previewInBrowser already use. This is also the only navigation a
          // headless caller gets: that Floe has no view, so the url rides the
          // command here and OUR browser loads it.
          if (command.url) void window.floe.browser.navigate(command.url)
          return
        }
        // Filed for a chat that is not on screen. It must NOT navigate now —
        // `browser.navigate` drives whichever page is ACTIVE, and that is the
        // one you are reading. So the url rides on the panel instead and the
        // panel loads it when it mounts (BrowserPanel), which is the first
        // moment a page exists that belongs to the chat that asked.
        //
        // Dropping the url here is what made `open_browser` from a chat you had
        // left answer "opened" and show nothing, ever.
        bySession.current = fileIntoSession(bySession.current, keys, mkPanel('browser', command.url))
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
        // (the panel shows the flow of the tree the app is in). On the right
        // project with the row loaded it starts now; otherwise park and navigate
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
      // bindings, or ⌘↵ inside the palette would fire a command behind it. The
      // picker counts: without it Escape on a question ALSO ran composer.leave
      // through here, and the focus the palette had just handed back moved on.
      // The new-worktree form is not one: it is inline in a panel, so `typing`
      // already keeps bare letters out of its input and the form stops its own
      // Escape and ⌥⏎ before they get here.
      const blocked =
        paletteOpen || commandsOpen || keysOpen || finderFiles !== null || adding || finding !== null || picker !== null
      const action =
        resolveKey(input, {
          typing,
          raw,
          chord: chord.current,
          kind: lane.panels[lane.focus]?.kind,
          selecting: !!lane.panels[lane.focus]?.selection,
          moving: moving !== null,
          marked: marks.size > 0,
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
  }, [lane, paletteOpen, commandsOpen, keysOpen, finderFiles, adding, finding, moving, picker])

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
    ;(rows[Math.min(at ?? 0, rows.length - 1)] ?? focusSink(el) ?? el).focus({ preventScroll: true })
  }

  // The element in the lane that held focus when an overlay went up, so the
  // overlay can hand it back. Two sources, because neither alone is enough:
  //
  //  - `focusin` at the document, which follows focus around the lane all day —
  //    but a window that is not the frontmost one gets no focus events at all,
  //    only a silently moving activeElement.
  //  - a layout effect on the overlay's first render, which reads activeElement
  //    before the palette's own effect has moved it — but AddProject focuses
  //    its input on mount, earlier than any parent effect, so it is too late
  //    there.
  //
  // Neither cares where the overlay was opened from: palettes open from a
  // dozen call sites — keys, the rail, MCP — and every one of them would have
  // to remember to write the element down.
  const lastFocus = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const onFocusIn = (e: FocusEvent): void => {
      const el = e.target as HTMLElement | null
      if (el && laneRef.current?.contains(el)) lastFocus.current = el
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [])
  const overlayUp = paletteOpen || commandsOpen || keysOpen || finderFiles !== null || adding || picker !== null
  useLayoutEffect(() => {
    if (!overlayUp) {
      // Closed: what was captured has been handed back (or could not be). A
      // stale element must not answer for the next overlay.
      lastFocus.current = null
      return
    }
    const el = document.activeElement as HTMLElement | null
    if (el && laneRef.current?.contains(el)) lastFocus.current = el
  }, [overlayUp])

  /**
   * What an overlay owes on the way out: the keyboard back where it was taken
   * from — mid-sentence in the composer, on the row in a list — and only failing
   * that the cursor row of the focused panel. Focus left on a dismissed palette
   * is focus on `body`, where typing goes nowhere and every panel key has lost
   * its place. Called BEFORE the action a pick runs, so a pick that moves the
   * lane gets the last word on where focus ends up.
   */
  const restoreFocus = (): void => {
    const el = lastFocus.current
    if (el && el.isConnected && laneRef.current?.contains(el)) el.focus({ preventScroll: true })
    else backToLane()
  }

  /**
   * A yes/no question, as the palette: two rows, Enter takes the one under the
   * cursor, Escape is no. The verb is what Enter does, in the user's words, so
   * the row reads "Delete session" rather than "OK".
   */
  const askConfirm = (opts: { question: string; verb: string; detail?: string }): Promise<boolean> =>
    new Promise((resolve) => {
      setPicker({
        placeholder: opts.question,
        items: [
          { id: 'yes', title: opts.verb, detail: opts.detail, flat: true },
          { id: 'no', title: 'Cancel', flat: true }
        ],
        onPick: (id) => resolve(id === 'yes'),
        onClose: () => resolve(false)
      })
    })

  // The inline new-worktree form's wiring, handed to the worktrees panel while
  // ⌘N has one open — the flow that used to be a modal.
  const newWorktreeProps: NewWorktreeProps | undefined =
    newWt && projects.current
      ? {
          branches,
          mainBase: worktrees.rows.find((r) => r.worktree.isMain)?.worktree.branch,
          defaultBase: current?.worktree.branch,
          // The only other bases offered: branches Floe already has a worktree
          // for. Everything else is a branch you were not working in.
          worktreeBases: worktrees.rows.map((r) => r.worktree.branch),
          error: newWtError,
          busy: newWtBusy,
          onClearError: () => setNewWtError(null),
          onCancel: () => {
            setNewWt(false)
            setNewWtError(null)
            // After the re-render that removes the form — reading the rows now
            // would hand focus to a button about to disappear.
            requestAnimationFrame(backToLane)
          },
          onCreate: ({ branch, base, resetBranch, premise }) => {
            // The form stays up until git agrees. Closing it first is what used
            // to send a refusal to the console and leave the panel looking as
            // if nothing had been asked for.
            setNewWtError(null)
            setNewWtBusy(true)
            void window.floe.worktrees
              .create(projects.current!.path, branch, { base, resetBranch })
              .then((list) => {
                setNewWtBusy(false)
                setNewWt(false)
                worktrees.reload()
                // Land in what you just made — creating a worktree and then
                // having to go find it is a step the app can take for you. The
                // path comes from what create returned, not from guessing where
                // git put it.
                const made = list.find((wt) => wt.branch === branch)
                if (made) worktrees.select(made.path)
                setLane((l) => open(l, panelOf('branch', branch)))
                // The environment, right after the tree: `.env`, dependencies,
                // the site and this branch's own database. Without it the
                // worktree is a checkout you cannot run, and the site you open
                // is still serving the main checkout.
                if (made)
                  provision.start(
                    { root: projects.current!.path, worktreePath: made.path, branch: made.branch },
                    premise ? { premiseAnswer: premise } : undefined
                  )
              })
              .catch((e: Error) => {
                setNewWtBusy(false)
                setNewWtError(diagnoseWorktreeFailure(branch, e.message))
              })
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
      attach(target)
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

  // What the key bar's command chip should be CALLED — the same first-match
  // rule the palette's own chips use, so the two never disagree about which
  // binding is the one that fires.
  const chordLabels: Record<string, string> = {}
  for (const b of binds) if (!(b.command in chordLabels)) chordLabels[b.command] = formatChord(b.key)

  // Summed once per render for the chat header's badge, not per panel.
  const changeStat = changes.files.reduce(
    (acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }),
    { add: 0, del: 0 }
  )

  // A tapped chip is the key arriving where the key would have arrived: the
  // event goes to whatever holds focus, so the composer's own handler and the
  // global keymap both see it exactly as they see a real press.
  const runChord = (chord: AppKey): void => {
    // A command chip runs the command, not an imitation of the key that would
    // have run it. See APP_KEYS.
    if (chord.command) {
      const res = runCommand(REGISTRY, ctxRef.current, chord.command)
      if (!res.ok) say(res.error)
      return
    }
    const el = (document.activeElement as HTMLElement | null) ?? document.body
    // Except this one. Shift+Enter in a textarea is a NEWLINE, and a synthetic
    // event carries no default action to insert one — the character has to be
    // written. Through the prototype's setter, or React never learns the value
    // changed and the next render puts the old text back.
    if (chord.key === 'Enter' && chord.shift && el instanceof HTMLTextAreaElement) {
      const from = el.selectionStart ?? el.value.length
      const to = el.selectionEnd ?? from
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setValue?.call(el, `${el.value.slice(0, from)}\n${el.value.slice(to)}`)
      el.selectionStart = el.selectionEnd = from + 1
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return
    }
    if (!chord.key) return
    const init = {
      key: chord.key,
      bubbles: true,
      cancelable: true,
      shiftKey: !!chord.shift
    }
    el.dispatchEvent(new KeyboardEvent('keydown', init))
    el.dispatchEvent(new KeyboardEvent('keyup', init))
  }

  const openFromRail = (kind: PanelKind) => {
    if (!canOpen(kind)) return
    setLane((l) => open(l, mkPanel(kind)))
  }

  // The palette's rows, only while it is up: the list reads the context (which
  // panels are open, which branches exist) and would be stale if memoised.
  const commands$ = commandsOpen ? commandItems(binds, ctxRef.current) : { items: [], rows: new Map<string, CommandRow>() }

  return (
    <div className="app">
      {/* Narrow only: the lane is a screen wide, so everything open but the
          panel you are on is off-screen. What is open is listed in lane order —
          the row is the map of a lane you cannot see — after the two buttons
          that are always there. Tapping a tab is ⌘[ / ⌘] arriving at that
          panel, and the ✕ is the header's own close.

          The bar navigates, with one exception: starting a chat. ⌘T is how that
          is asked for everywhere else, and a phone has no ⌘ — leaving the
          palette as the only way in, which is not a way anyone finds. */}
      {narrow && (
        <div className="lane-bar">
          {/* The rail, folded into one button — see RailMenu. Outside the tab
              row rather than in it: the tabs scroll, and the way to every panel
              the app has must not be able to scroll off the screen. */}
          <button
            ref={menuRef}
            className="lane-menu"
            aria-label="Panels"
            aria-expanded={railMenu}
            onClick={() => setRailMenu((up) => !up)}
          >
            <IconMenu2 size={17} stroke={1.5} />
          </button>
          {/* ⌘T, as a button. Runs the same command the palette offers rather
              than opening the launcher itself — a second create flow here would
              be free to drift from the one the keyboard uses. Beside the
              hamburger for the same reason it is: the tabs scroll, and the way
              to a new chat must not be able to scroll off the screen.

              Disabled with no worktree, matching `session.new`'s own guard: a
              chat has to start somewhere, and the launcher would have no branch
              to name. */}
          <button
            className="lane-new"
            aria-label="New chat"
            title="New chat"
            disabled={!here}
            onClick={() => runCommand(REGISTRY, ctxRef.current, 'session.new')}
          >
            <IconPlus size={17} stroke={1.6} />
          </button>
          {columns.length > 0 && (
            <nav className="lane-tabs" ref={tabsRef} aria-label="open panels">
              {columns.map((column) => {
                const [{ panel: head, index }] = column
                const on = column.some((p) => p.index === lane.focus)
                return (
                  <span key={head.id} className="lane-tab" data-on={on || undefined}>
                    <button
                      className="lane-tab-go"
                      onClick={() => setLane((l) => focusAt(l, index))}
                    >
                      {head.title}
                    </button>
                    {on && index > 0 && (
                      <button
                        className="lane-tab-x"
                        aria-label={`Close ${head.title}`}
                        onClick={() =>
                          setLane((l) => closePanel(l, index, () => panelOf('branch')))
                        }
                      >
                        <IconX size={11} stroke={1.8} />
                      </button>
                    )}
                  </span>
                )
              })}
            </nav>
          )}
        </div>
      )}
      {narrow && railMenu && (
        <RailMenu
          groups={RAIL.map((group) =>
            group.map((kind) => ({
              kind,
              label: KINDS[kind].title,
              icon: KINDS[kind].icon,
              off: !canOpen(kind),
              reason: whyCannotOpen(kind),
              keys: railKeys.get(kind)
            }))
          )}
          onPick={(kind) => openFromRail(kind as PanelKind)}
          // Never leave focus on something that just closed: it goes back to the
          // button that opened the drawer, which is where the tab order is.
          onClose={() => {
            setRailMenu(false)
            menuRef.current?.focus()
          }}
        />
      )}
      <div className="workspace">
        <div className="lane" ref={laneRef}>
          {/* Columns, not panels: a docked panel shares its neighbour's column
              instead of taking one of its own. The column carries the width and
              the pinning, so a stacked pair is sized and pinned as one thing. */}
          {columns.map((column) => {
            const [{ panel: head }] = column
            const headSpec = KINDS[head.kind as PanelKind]
            // A growing column grows wherever it sits, not only at the lane's
            // end: with a query or a lane panel open beside the chat, stopping
            // the chat from growing left a strip of empty lane on the right.
            // Growing only spends what is LEFT OVER, so the neighbour keeps its
            // own width either way — and the split is weighted by base width
            // below, so the chat stays the widest thing on screen.
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
                    }px`,
                    // Leftover lane width is split in proportion to base width,
                    // not evenly: a chat and a query sharing the room evenly
                    // would end up nearly the same size, and the chat is the
                    // panel the extra pixels are for.
                    '--panel-grow': `${headSpec.width / 100}`
                  } as React.CSSProperties
                }
                // A width you dragged to is a width you asked for: it wins over
                // growing, or the lane would take it straight back.
                data-sized={head.width !== undefined || undefined}
                data-grow={
                  (head.width === undefined && 'grow' in headSpec && headSpec.grow) || undefined
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
            // switch. The file tree is the exception: its path is clickable, so
            // it draws its own (FileCrumbs) rather than handing over a string.
            const sub =
              kind === 'worktrees'
                ? projects.current?.name
                : kind === 'chat'
                  ? whereOf(panel.session?.worktreePath, panel.sub)
                  // A query's sub IS its title (the harness), so printing it
                  // would say `codex` twice across one header.
                  : kind === 'query'
                    ? undefined
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
                style={
                  panel.dock
                    ? {
                        // A height you dragged wins; otherwise the kind's own
                        // share, and 40% for a kind with no opinion.
                        flexBasis:
                          panel.height ??
                          ('dockHeight' in KINDS[panel.kind as PanelKind]
                            ? (KINDS[panel.kind as PanelKind] as { dockHeight?: string }).dockHeight
                            : undefined) ??
                          '40%'
                      }
                    : undefined
                }
                tabIndex={-1}
                data-focused={i === lane.focus || undefined}
                data-bare={bare || undefined}
                data-docked={panel.dock || undefined}
                onMouseDown={(e) => {
                  setLane((l) => focusAt(l, i))
                  startLineDrag(e, i)
                }}
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
                    {/* A query is titled by who answers in it, in that
                        harness's own nick colour — the same colour its lines
                        carry in the transcript, so the panel and the voice
                        inside it read as one thing. */}
                    <span
                      className="panel-name"
                      style={kind === 'query' ? { color: nickColor(panel.title) } : undefined}
                    >
                      {panel.title}
                    </span>
                    {/* Read-only, said out loud. A query never writes (D1/R5),
                        and a panel that looks exactly like the chat beside it
                        has to say how it differs. */}
                    {kind === 'query' && (
                      <span className="badge" title="Read-only — a query never writes">
                        ro
                      </span>
                    )}
                    {/* The tree can be pointed at a directory inside the worktree
                        (`.` on a row), and the header is where that is said and
                        undone — clicking a segment roots there. */}
                    {kind === 'files' && (
                      <FileCrumbs
                        where={whereOf(here)}
                        scope={panel.sub}
                        onPick={(next) => setLane((l) => patchPanel(l, i, { sub: next, cursor: 0 }))}
                      />
                    )}
                    {kind !== 'files' && sub && (
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
                    {/* Which machine's tree this is. The projects panel badges
                        the row you picked; without this the list you land on
                        reads exactly like a local one, and every branch here
                        belongs to another disk. Local gets none — naming this
                        machine on its own worktrees answers nothing. */}
                    {kind === 'worktrees' && backendOf(projects.current) !== LOCAL && (
                      <span className="badge">{backendLabel(backendOf(projects.current))}</span>
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
                    {/* What `d` is about to throw away, on screen the whole
                        time there is something to throw away. The worktrees
                        list can be taller than the window and the ticks are
                        scattered down it, so the count is the only place the
                        SIZE of the selection is visible at all — and a delete
                        you can't see the scope of is one you press once and
                        regret. Red because it is the one destructive thing in
                        any panel header; it runs the same command `d` does, so
                        this adds no mouse-only path. */}
                    {kind === 'worktrees' && marks.size > 0 && (
                      <button
                        className="head-danger"
                        title={`Delete ${marks.size} selected session${
                          marks.size === 1 ? '' : 's'
                        } (d) · Esc to unselect`}
                        onClick={() =>
                          runCommand(REGISTRY, ctxRef.current, 'session.deleteMarked')
                        }
                      >
                        <IconTrash size={12} stroke={1.8} />
                        {marks.size}
                      </button>
                    )}
                    {usage[panel.id]?.used > 0 && <ContextMeter usage={usage[panel.id]} />}
                    {/* The merge lives on the chat, not the rail: it merges the
                        branch this chat works on. Only on the chat that defines
                        `here`, because that is the branch the command merges,
                        and never on the main worktree, which has no base. Runs
                        the same command as its chord, so no mouse-only path. */}
                    {kind === 'chat' &&
                      panel.session?.worktreePath === here &&
                      worktrees.rows.some((r) => r.worktree.path === here && !r.worktree.isMain) && (
                        <button
                          className="panel-act"
                          title={`Merge into base${
                            chordLabels['worktree.merge'] ? ` (${chordLabels['worktree.merge']})` : ''
                          }`}
                          onClick={() => runCommand(REGISTRY, ctxRef.current, 'worktree.merge')}
                        >
                          <IconGitMerge size={14} stroke={1.8} />
                        </button>
                      )}
                    {(kind === 'file' || kind === 'diff') && jumps.length > 0 && (
                      <button
                        className="panel-act"
                        title="Back to where you jumped from (-)"
                        onClick={() => runCommand(REGISTRY, ctxRef.current, 'code.back')}
                      >
                        <IconArrowBackUp size={14} stroke={1.8} />
                      </button>
                    )}
                    {'action' in spec &&
                      spec.action &&
                      ([spec.action] as PanelAction[][]).flat().map((act) => (
                        <button
                          key={act.command}
                          className="panel-act"
                          title={act.title}
                          onClick={() => runCommand(REGISTRY, ctxRef.current, act.command)}
                        >
                          <act.icon size={14} stroke={1.8} />
                        </button>
                      ))}
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
                    view={panel.view}
                    projects={projects}
                    movingProject={moving}
                    worktrees={worktrees}
                    marks={marks}
                    onMark={markSession}
                    changes={changes}
                    commands={commands}
                    merge={merge}
                    remove={remove}
                    provision={provision}
                    setup={setup}
                    // Picking a project or a branch is never just a selection:
                    // it restores everything that place was left showing.
                    onEnterProject={enterProject}
                    onEnterWorktree={enterWorktree}
                    // A row of the `active` panel names a conversation, not a
                    // place — see jumpToSession.
                    onJumpSession={jumpToSession}
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
                    // Read from the lane at click time, not from this render's
                    // `panel`: the mousedown that precedes the click moved the
                    // cursor, and the way back should land on that line.
                    onDefinition={(name, line) => {
                      const from = ctxRef.current.lane.panels.find((p) => p.id === panel.id) ?? panel
                      void goToDefinition(from, [name], line)
                    }}
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
                      setLane((l) => {
                        const next = open(l, {
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
                        // Two ways to say "do not take the focus": a preview
                        // (`focus: false`), and a panel that FOLLOWS something
                        // — the colony's board swapping the card's chat in as
                        // the cursor moves, or every `j` would drop you out of
                        // the panel you are driving. Either way the focus goes
                        // back by id, not by index: the panel that opened may
                        // have shifted right to make room for the one it
                        // opened.
                        if (child.focus !== false && !child.keepFocus) return next
                        const back = next.panels.findIndex((p) => p.id === panel.id)
                        return back === -1 ? next : focusAt(next, back)
                      })
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
        {/* Only because the hardware forces it — so it asks about the hardware
            and not the width: no on-screen keyboard has Esc, Tab or Ctrl, which
            is most of how a shell is driven, but a desktop window dragged
            narrow has all three and wants none of this. At the bottom, so the
            on-screen keyboard pushes it up as one strip. */}
        {narrow && touch && (
          <KeyBar
            termId={termIdOf(
              lane.panels[lane.focus]?.kind ?? '',
              lane.panels[lane.focus]?.sub,
              lane.panels[lane.focus]?.root,
              cwd
            )}
            onChord={runChord}
            chordLabels={chordLabels}
          />
        )}
        {/* The rail is the wide layout's. Narrow, the same panels live in the
            drawer behind the hamburger: a strip of icons along the bottom cost
            a thumb's worth of height and named none of them. */}
        {!narrow && (
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
        )}
      </div>

      {adding && (
        <AddProject
          backends={window.floe.backends?.list() ?? []}
          current={window.floe.backends?.current() ?? 'local'}
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
                  restoreFocus()
                  void projects.add(group).then(afterAdd)
                }
          }
          onPair={pairHost}
          onAdd={(backend, path, group) => {
            setAdding(false)
            restoreFocus()
            // Where the window was when the dialog was answered. Read now rather
            // than when the add resolves: whether this is a move is the user's
            // choice in the dialog, not wherever the pointer drifted meanwhile.
            const from = window.floe.backends.current()
            void projects
              .addByPath(path, group, backend)
              .then((res) => {
                if (res.error) return say(res.error)
                // Only the machine that holds the project lists it, so an add
                // somewhere else takes the window with it and hands that
                // instance the landing.
                if (backend !== from) {
                  if (res.path) handOff({ path: res.path, created: res.created }, self)
                  if (attach(backend)) return
                  // Refused — the machine went away between the add and now. The
                  // project is on it either way, so say so and drop the handoff
                  // rather than leave it for an unrelated switch to pick up.
                  dropLanding()
                  return say(`Added on ${backendLabel(backend)}, which is no longer attached.`)
                }
                afterAdd(res)
              })
              // A remote add fails over a socket, not just in a handler: the
              // machine dropped, a bad token, a channel it doesn't know. The
              // dialog is already closed, so this is the only place left to say it.
              .catch((e) => say(reason(e)))
          }}
          onClose={() => {
            setAdding(false)
            restoreFocus()
          }}
        />
      )}

      {picker && (
        <Palette
          // One step, one instance: a pick that opens the next question swaps
          // the picker in the same render, and an unkeyed Palette would carry
          // the previous step's typed filter into it — "Remove project" behind
          // a query of "stale" is an empty list, and Enter picks nothing.
          key={picker.placeholder}
          placeholder={picker.placeholder}
          items={picker.items}
          value={picker.value}
          dynamic={picker.dynamic}
          sigil="›"
          hints="⏎ pick · ↑↓ move · esc cancel"
          onClose={() => {
            setPicker(null)
            picker.onClose?.()
            restoreFocus()
          }}
          onPick={(id) => {
            // Cleared first: onPick may open the next step, and clearing after
            // would close the one it just put up.
            setPicker(null)
            picker.onPick(id)
            // After the answer, back to where you asked from — so `r`, a new
            // name, Enter leaves you where `j` still works. A step that opened
            // another palette takes the focus back on mount, after this.
            restoreFocus()
          }}
        />
      )}
      {commandsOpen && (
        <Palette
          placeholder="Execute a command…"
          items={commands$.items}
          sigil="⌘"
          hints="⏎ run · ⌘⏎ rebind · ↑↓ move · esc close"
          // The pane says what a dimmed row cannot: which condition is missing.
          preview={(item) => {
            const row = commands$.rows.get(item.id)
            const cmd = row && REGISTRY.get(row.id)
            if (!row || !cmd) return null
            return (
              <CommandPreview
                title={row.title}
                group={cmd.group}
                // Every binding, not only the chip's: this is the pane with room.
                keys={keyHint(binds, row.id, row.arg)?.all}
                unavailable={
                  cmd.enabled && !cmd.enabled(ctxRef.current, row.arg)
                    ? (cmd.unavailable?.(ctxRef.current, row.arg) ?? 'not available here')
                    : undefined
                }
              />
            )
          }}
          onClose={() => {
            setCommandsOpen(false)
            restoreFocus()
          }}
          onPick={(id) => {
            setCommandsOpen(false)
            // Before the command, so one that moves the lane has the last word.
            restoreFocus()
            const row = commands$.rows.get(id)
            const res = runCommand(REGISTRY, ctxRef.current, row?.id ?? id, row?.arg)
            if (!res.ok) say(res.error)
          }}
          onRebind={(id, chord) => {
            // Written through to the file, which is the keymap — so the change
            // is in the same place the user would have made it by hand, and
            // survives a restart without a second store to keep in sync. The
            // watcher below reloads and repaints once the write lands. An
            // argument row rebinds its own entry: `panel.goto files`, not the
            // first `panel.goto` in the file.
            const row = commands$.rows.get(id)
            void window.floe.keybindings.rebind(row?.id ?? id, chord, row?.arg)
          }}
        />
      )}

      {finder && (
        <Palette
          placeholder="Find a chat or a file…"
          items={finder.items}
          // A repo has thousands of files and nobody reads past the fold of a
          // fuzzy list — they type another letter.
          limit={200}
          // Five chats, so the files are on screen from the first frame however
          // many sessions the project has. Narrowing to `chats` lifts it.
          caps={{ chats: 5 }}
          sections
          scopes={FINDER_SCOPES}
          sigil="⌕"
          hints="⏎ open · ⇥ filter · ↑↓ move · esc close"
          preview={(item) => {
            const chat = finder.chats.get(item.id)
            if (chat) {
              return (
                <SessionPreview
                  title={chat.title}
                  project={chat.projectName}
                  branch={chat.branch}
                  worktree={chat.worktreePath}
                  at={timeAgo(chat.mtime)}
                  running={chat.running}
                  model={chat.model}
                  mode={chat.mode}
                />
              )
            }
            // The head of the file, which is what tells you whether it is the
            // one you meant — two files named index.ts differ by nothing else.
            return here && <FilePreview root={here} path={item.title} />
          }}
          onClose={() => {
            setFinderFiles(null)
            restoreFocus()
          }}
          onPick={(id) => {
            setFinderFiles(null)
            restoreFocus()
            const chat = finder.chats.get(id)
            // A chat carries its own worktree: picking one on another branch
            // takes you there, the same as clicking its row in the sidebar.
            // Another project or another machine is jumpToSession's job — the
            // `active` panel's rows already cross both, and picking one here
            // means the same thing it means there.
            if (chat) return openFinderChat(chat)
            // Not a chat, so the id is the path itself.
            setLane((l) => open(l, panelOf(panelForFile(id), id)))
          }}
        />
      )}

      {keysOpen && (
        <KeysHelp
          binds={binds}
          kind={lane.panels[lane.focus]?.kind}
          titleOf={keyTitle}
          onClose={() => {
            setKeysOpen(false)
            restoreFocus()
          }}
        />
      )}

      {paletteOpen && (
        <Palette
          placeholder="Switch project…"
          items={paletteItems(projects)}
          sigil="◆"
          hints="⏎ open · ↑↓ move · esc close"
          preview={(item) => {
            const project = projects.all.find((p) => p.path === item.id)
            if (!project) return null
            return (
              <ProjectPreview
                project={project}
                // Same rule as the row's badge: local is the default and says
                // nothing, so the machine only appears where it answers something.
                machine={
                  project.backend && project.backend !== LOCAL
                    ? backendLabel(project.backend)
                    : undefined
                }
              />
            )
          }}
          onClose={() => {
            setPaletteOpen(false)
            restoreFocus()
          }}
          onPick={(id) => {
            setPaletteOpen(false)
            restoreFocus()
            if (id === 'project.add') return ctxRef.current.addProject()
            // Same move as clicking the project row: it hands you over to the
            // worktree list and on to the branch that project was left on.
            enterProject(id)
          }}
        />
      )}

      {/* The mouse's route to `c`. It floats over the block rather than sitting
          in the panel header because what it acts on is the block — and after a
          drag the pointer is already there. The key is printed on it, which is
          how the keyboard route gets taught to the hand that used the mouse. */}
      {selTip && (
        <button
          type="button"
          className="sel-tip"
          style={{ left: selTip.x, top: selTip.y }}
          // The selection would be dropped by the panel taking focus back
          // before the click ever ran.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => runCommand(REGISTRY, ctxRef.current, 'selection.comment')}
        >
          Send to composer
          <kbd>c</kbd>
        </button>
      )}

      {/* An update is downloaded and waiting. Nothing else in the app applies
          it — the main process never swaps the bundle on quit — so this sits
          there until the restart happens. The button only dispatches the id, so
          the palette row and the click are the same one action. */}
      {pendingUpdate && (
        <div className="update-banner" role="status">
          <span>Floe {pendingUpdate.version} {pendingUpdate.download ? 'is out' : 'is ready'}</span>
          <button
            type="button"
            className="update-restart"
            onClick={() => runCommand(REGISTRY, ctxRef.current, 'update.install')}
          >
            {pendingUpdate.download ? 'Install' : 'Restart'}
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
 * ⌘P's filter, and it opens on the first of them: the chats.
 *
 * The key is most often a way back to something you were doing, and a session
 * is a place you left rather than a name you remember exactly — so the list
 * starts as the chats alone, with the file count sitting beside it saying how
 * many are one ⇥ away.
 */
const FINDER_SCOPES = [
  { id: 'chats', label: 'chats' },
  { id: 'files', label: 'files' },
  { id: ALL, label: 'all' }
]

/**
 * What the palette offers: every project, plus the one action that belongs
 * beside them. "Add project" lives in the same list rather than behind its own
 * binding — you reach for the palette when the project you want isn't open, and
 * sometimes that is because it isn't added yet.
 */
/**
 * A binding's name in the keys help: the registry's title, or null for a command
 * the palette does not offer either. `panel.goto` and the position jumps take an
 * argument, so they are named by it.
 */
function keyTitle(command: string, arg?: string): string | null {
  const cmd = REGISTRY.get(command)
  if (!cmd || cmd.hidden) return null
  if (command === 'panel.goto' && arg) return `Go to ${arg}`
  if (command === 'panel.focusAt') return 'Panel by position'
  if (command === 'worktree.focusAt') return 'Worktree by position'
  return cmd.title
}

function paletteItems(projects: ReturnType<typeof useProjects>): PaletteItem[] {
  return [
    ...projects.all.map((p) => ({
      id: p.path,
      title: p.name,
      detail: p.home ? 'home' : p.group,
      // The machine the project is on, same rule as the projects panel: local
      // is the default and gets no badge, so the tag only appears where it
      // answers something.
      badge: p.backend && p.backend !== LOCAL ? backendLabel(p.backend) : undefined,
      group: p.group
    })),
    // Pinned: it must be there exactly when the search finds nothing, because
    // that is the moment you learn the project isn't added yet.
    { id: 'project.add', title: 'Add project…', detail: 'new', pinned: true }
  ]
}

/**
 * Every command, named the way the palette reads best: `group: title`, so
 * typing either half finds it. A parametrized command is one row per argument
 * ("Go to files", "Go to plans"), and the key chip is read from the live keymap
 * — the binding that will actually fire, the user's if they rebound it.
 *
 * The rows come back beside the items because a palette hands back an id and
 * nothing else: running the pick needs the command AND its argument, and an
 * argument can be anything, so it is not folded into the id string.
 */
function commandItems(
  binds: Keybind[],
  ctx: CommandContext
): { items: PaletteItem[]; rows: Map<string, CommandRow> } {
  const rows = new Map<string, CommandRow>()
  const items = listCommands(REGISTRY, ctx, (id, arg) => keyHint(binds, id, arg)?.chip).map((c, i) => {
    const id = c.arg === undefined ? c.id : `${c.id}#${i}`
    rows.set(id, c)
    return {
      id,
      title: `${c.group.toLowerCase()}: ${c.title.replace(/…$/, '').toLowerCase()}`,
      // A command is named in prose, not in path segments: `mcp: enable/disable
      // mcp server` split at its slash reads as a file `disable mcp server` in a
      // directory `enable/`. Flat also gives the title the row's slack, so a long
      // name ellipsises at the key chip instead of running off the column.
      flat: true,
      keys: c.keys
    }
  })
  return { items, rows }
}
