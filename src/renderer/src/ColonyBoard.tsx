import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { IconAlertCircle, IconQuestionMark } from './icons'
import { useColony } from './useColony'
import { useTaskFolders } from './useTaskFolders'
import {
  COLONY_TABS,
  COLONY_TAB_LABEL,
  setColonyCounts,
  useColonyCounts,
  useColonyTab,
  type ColonyTab
} from './colonyTab'
import { busyOf, isFull, type Board, type BoardColumn, type BoardEvent, type ColonyTask } from '../../shared/colony'
import type { TaskFolder } from '../../shared/taskFolders'
import type { OpenFn } from './panels'

/**
 * The agent board: every column is an agent profile, every card is a task that
 * owns its own worktree. Project-scoped, because that is one level above the
 * worktree each card is handed.
 *
 * Three things about how it is drawn, all from specs/colony/spec.md:
 *
 *  - A COLUMN IS THREE BANDS, and the band carries the status — so no card
 *    prints a status word (D3). `needs you` ran and stopped on a question,
 *    the unlabelled middle is being worked, `holding` is waiting to ENTER this
 *    column. Only the first two take a spot (D4).
 *  - THE BORDER BELONGS TO THE CURSOR; a badge carries the status (D26). A card
 *    can be selected AND asking at once, so the two marks never share a surface.
 *  - AN EMPTY COLUMN COLLAPSES to a 30px spine (D2). Eight stages at full width
 *    is ~1700px and leaves no room for the chat beside it.
 *
 * Each column's body is a `data-nav-group`, which is what makes `j`/`k` stay
 * inside one column for free — the lane already scopes cursor movement to the
 * group the focused row is in. `h`/`l` cross groups; see `colony.left` in the
 * registry.
 */
export function ColonyBoard({
  project,
  onOpen,
  onCommand
}: {
  project?: string
  onOpen: OpenFn
  onCommand?: (id: string) => void
}) {
  const tab = useColonyTab(project)
  const { board, loading, error } = useColony(project)
  const { tasks } = useTaskFolders(project)
  const events = useBoardEvents(tab === 'overview' ? project : undefined)

  // The head's tab strip prints these. Written from here because this is the
  // one place that already has the board and the ideas loaded.
  useEffect(() => {
    if (!project || !board) return
    setColonyCounts(project, {
      asking: board.columns.reduce((n, c) => n + c.blocked.length, 0),
      ideas: tasks.filter((t) => t.status === 'idea' || t.status === 'shaping' || t.status === 'ready').length,
      cards: board.columns.reduce((n, c) => n + c.blocked.length + c.working.length + c.holding.length + c.settled.length, 0)
    })
  }, [project, board, tasks])

  // What sits right of the board follows the cursor, after a beat (D6). Held
  // `j` would otherwise load a transcript per keystroke, and the one you meant
  // to read is the one you stopped on.
  const follow = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(follow.current), [])
  const after = useCallback((go: () => void, force: boolean) => {
    clearTimeout(follow.current)
    if (force) go()
    else follow.current = setTimeout(go, 150)
  }, [])

  const openChat = useCallback(
    (task: ColonyTask, force: boolean) => {
      if (!task.sessionId || !task.worktreePath) return clearTimeout(follow.current)
      const session = { id: task.sessionId, worktreePath: task.worktreePath }
      // Forced, the chat takes focus — you pressed Enter to go and read it.
      // Followed, it does not: the board is still the panel you are driving.
      after(() => onOpen({ kind: 'chat', session, keepFocus: !force }), force)
    },
    [onOpen, after]
  )

  // An idea's cursor drives the task item the same way a card's drives its chat.
  const openTask = useCallback(
    (name: string, force: boolean) => after(() => onOpen({ kind: 'task', sub: name, root: project, keepFocus: !force }), force),
    [onOpen, after, project]
  )

  if (error) return <p className="empty error">{error}</p>
  if (!project) return <p className="empty">No project open.</p>
  if (loading && !board) return <p className="empty">Loading…</p>
  if (!board) return <p className="empty">No board.</p>

  return (
    <>
      {tab === 'overview' && <ColonyOverview board={board} tasks={tasks} events={events} onOpen={openChat} onCommand={onCommand} />}
      {tab === 'ideas' && <ColonyIdeas tasks={tasks} onOpen={openTask} />}
      {tab === 'board' && <Implementation board={board} onOpen={openChat} onCommand={onCommand} />}
      <ColonyKeys tab={tab} />
    </>
  )
}

/**
 * The colony's tabs, in the panel head. Clicking runs the command `[`/`]` and
 * the palette reach, so there is no mouse-only path; the counts come from the
 * body (see setColonyCounts), so the head does not poll the board a second time.
 */
export function ColonyTabs({ project, onCommand }: { project?: string; onCommand: (id: string) => void }) {
  const tab = useColonyTab(project)
  const counts = useColonyCounts(project)
  const badge: Record<ColonyTab, string | undefined> = {
    overview: counts?.asking ? `${counts.asking} need you` : undefined,
    ideas: counts?.ideas ? String(counts.ideas) : undefined,
    board: counts?.cards ? String(counts.cards) : undefined
  }
  return (
    <nav className="cv-tabs" aria-label="colony tabs">
      {COLONY_TABS.map((t) => (
        <button
          key={t}
          className="cv-tab"
          data-on={t === tab || undefined}
          title={`${COLONY_TAB_LABEL[t]} — [ and ] step through the tabs`}
          onClick={() => onCommand(`colony.${t}`)}
        >
          {COLONY_TAB_LABEL[t]}
          {badge[t] && (
            <span className="cv-tab-n" data-tone={t === 'overview' ? 'ask' : undefined}>
              {badge[t]}
            </span>
          )}
        </button>
      ))}
      <span className="cv-tab-keys">[ ]</span>
    </nav>
  )
}

/** The keys of the tab on screen. Text, not buttons: a hint must not be a cursor stop. */
const KEYS: Record<ColonyTab, [string, string][]> = {
  overview: [
    ['[ ]', 'tab'],
    ['j k', 'row'],
    ['⏎', 'open chat'],
    ['s', 'start'],
    ['x', 'archive'],
    ['n', 'new task'],
    ['esc', 'nanny']
  ],
  ideas: [
    ['[ ]', 'tab'],
    ['h l', 'column'],
    ['j k', 'idea'],
    ['< >', 'move'],
    ['⏎', 'open'],
    ['c', 'chat'],
    ['e', 'edit'],
    ['p', 'plan'],
    ['t', 'kind'],
    ['n', 'new idea'],
    ['⌘⏎', 'send'],
    ['esc', 'nanny']
  ],
  board: [
    ['[ ]', 'tab'],
    ['h l', 'column'],
    ['j k', 'card'],
    ['⏎', 'open chat'],
    ['s', 'start'],
    ['x', 'archive'],
    ['m', 'report'],
    ['r', 'open report'],
    ['n', 'new task'],
    ['esc', 'nanny']
  ]
}

function ColonyKeys({ tab }: { tab: ColonyTab }) {
  return (
    <div className="cv-keys">
      {KEYS[tab].map(([k, what]) => (
        <span key={k + what}>
          <b>{k}</b> {what}
        </span>
      ))}
    </div>
  )
}

/** The board's log, for the overview's "landed today". Only loaded while that tab is up. */
function useBoardEvents(project?: string): BoardEvent[] {
  const [events, setEvents] = useState<BoardEvent[]>([])
  useEffect(() => {
    if (!project) return setEvents([])
    const load = (): void => {
      window.floe.colony
        .events(project)
        .then(setEvents)
        .catch(() => setEvents([]))
    }
    load()
    return window.floe.colony.onEvent((e) => {
      if (e.project === project) load()
    })
  }, [project])
  return events
}

/** The stuck-on-you strip. Accent is reserved for exactly this (D25). */
function Attention({ board }: { board: Board }) {
  const asking = board.columns.flatMap((c) => c.blocked)
  if (!asking.length) return null
  return (
    <div className="fatt">
      <span className="fatt-tag">ATTENTION</span>
      <span className="fatt-item">
        <b>{asking[0].name}</b>
        {asking[0].line ? ` — ${asking[0].line}` : ''}
      </span>
      <span className="fatt-key">⏎ answer · {asking.length} waiting</span>
    </div>
  )
}

/** The implementation board — the colony as it was before it had tabs. */
function Implementation({
  board,
  onOpen,
  onCommand
}: {
  board: Board
  onOpen: (task: ColonyTask, force: boolean) => void
  onCommand?: (id: string) => void
}) {
  return (
    <>
      {/* Config that does not parse is drawn where the board would be, not
          swallowed: a stage naming a skill nobody has starts nothing (D19), and
          a board doing nothing has to say why. */}
      {board.errors.map((e, i) => (
        <p className="col-err" key={i}>
          <IconAlertCircle size={13} stroke={1.6} />
          {e.file.split('/').pop()}:{e.line} — {e.reason}
        </p>
      ))}

      {/* WHAT THIS BOARD DOES WITHOUT ASKING. A line of prose rather than an icon
          in the header: "automerge" as a toggle glyph tells you nothing, and the
          thing worth knowing is that cards are landing on your base branch by
          themselves. The switch is here because this is where you find that out. */}
      <div className="fpolicy">
        <span className="fpolicy-text">
          {board.automerge
            ? 'a card that reaches done merges itself into base'
            : 'a card that reaches done waits for you to merge it'}
        </span>
        <button
          className="fpolicy-act"
          data-on={board.automerge || undefined}
          // Disabled for an untracked project: there is no colony.toml to write,
          // and a switch that silently does nothing is worse than no switch.
          disabled={!board.configPath}
          title={
            board.configPath
              ? `automerge is ${board.automerge ? 'on' : 'off'} — writes ${board.configPath}`
              : 'this project has no colony.toml to write'
          }
          onClick={() => onCommand?.('colony.automerge')}
        >
          automerge: {board.automerge ? 'on' : 'off'}
        </button>
        {/* The step report: measures every card that enters the first stage from
            here on. Beside automerge because both are the board's own policy,
            and the one place on screen that says what the board is doing. */}
        <button
          className="fpolicy-act"
          data-on={board.report || undefined}
          disabled={!board.configPath}
          title={
            board.configPath
              ? `step report is ${board.report ? 'on' : 'off'} — tokens, findings and diff per step (m) · r opens a card's report`
              : 'this project has no colony.toml to write'
          }
          onClick={() => onCommand?.('colony.report')}
        >
          report: {board.report ? 'on' : 'off'}
        </button>
      </div>

      <Attention board={board} />

      <div className="board">
        {board.columns.map((column, ci) => (
          <Column key={column.name} column={column} index={ci} onOpen={onOpen} onCommand={onCommand} />
        ))}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Ideas — the tasks list, drawn as the board it feeds
// ---------------------------------------------------------------------------

const IDEA_COLUMNS: { status: TaskFolder['status']; hint: string }[] = [
  { status: 'idea', hint: 'a line, in your words' },
  { status: 'shaping', hint: 'talked through · plan.md' },
  { status: 'ready', hint: 'has a plan · you said ready' }
]

/** "plan · 2 html · 1 draw" — what an idea holds, at a glance. */
function holds(t: TaskFolder): string {
  return [
    t.counts.html && `${t.counts.html} html`,
    t.counts.drawing && `${t.counts.drawing} draw`,
    t.counts.link && `${t.counts.link} link${t.counts.link > 1 ? 's' : ''}`,
    t.counts.other && `${t.counts.other} file${t.counts.other > 1 ? 's' : ''}`
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Age at the resolution a card prints it: 5m, 3h, 2d, 1w. */
function age(at: number): string {
  const m = Math.max(0, Math.floor((Date.now() - at) / 60000))
  if (m < 60) return `${m}m`
  if (m < 60 * 24) return `${Math.floor(m / 60)}h`
  if (m < 60 * 24 * 7) return `${Math.floor(m / 1440)}d`
  return `${Math.floor(m / 10080)}w`
}

/**
 * Ideas as columns: idea → shaping → ready, then a narrow `sent` column with
 * what already went to the implementation board and where it is now.
 *
 * Same `.fcol`/`.fcard` as the implementation board, so the two tabs read as one
 * machine, and each column body is a nav group so `h`/`l` and `j`/`k` work the
 * way they do there. The cards carry the tasks list's own `data-task-ref`,
 * which is all the tasks commands need (see taskFolderAt).
 */
function ColonyIdeas({ tasks, onOpen }: { tasks: TaskFolder[]; onOpen: (name: string, force: boolean) => void }) {
  const sent = tasks.filter((t) => t.status === 'in dev')
  return (
    <>
      <div className="fpolicy">
        <span className="fpolicy-text">ideas live in .floe/tasks/ on the main branch · ⌘⏎ sends a ready one to the implementation board</span>
      </div>
      <div className="board">
        {IDEA_COLUMNS.map(({ status, hint }) => {
          const list = tasks.filter((t) => t.status === status).sort((a, b) => b.mtime - a.mtime)
          return (
            <section className="fcol" key={status} data-live={list.length > 0 || undefined}>
              <header className="fcol-head">
                <span className="fcol-name">{status}</span>
                <span className="fcol-n">{list.length || ''}</span>
                <div className="fcol-def">
                  <span className="fcol-skill">{hint}</span>
                </div>
              </header>
              <div className="fcol-body" data-nav-group>
                {list.map((t) => (
                  <button
                    className="fcard"
                    key={t.name}
                    title={t.dir}
                    data-task-ref={t.name}
                    onFocus={() => onOpen(t.name, false)}
                    onClick={() => onOpen(t.name, true)}
                  >
                    <div className="fcard-top">
                      <span className="fkind">{t.kind}</span>
                      <span className="cv-num">{t.number}</span>
                    </div>
                    <div className="fcard-name">{t.title}</div>
                    {t.depends.length > 0 && (
                      <div className="fcard-line">
                        ⤷ after {t.depends.join(', ')}
                      </div>
                    )}
                    <div className="cv-imeta">
                      {status !== 'idea' && (
                        <span className="cv-plan" data-none={!t.hasPlan || undefined}>
                          plan
                        </span>
                      )}
                      {holds(t) && <span>{holds(t)}</span>}
                      <span className="cv-age">{age(t.mtime)}</span>
                    </div>
                  </button>
                ))}
                {status === 'idea' && !list.length && <p className="cv-empty">n captures an idea</p>}
                {status === 'ready' && list.length > 0 && (
                  <p className="cv-send">
                    <b>⌘⏎</b> sends the idea to the implementation board — it lands in <b>inbox</b>, its folder moved to
                    specs/
                  </p>
                )}
              </div>
            </section>
          )
        })}
        <section className="fcol cv-sent" data-empty={!sent.length || undefined}>
          <header className="fcol-head">
            <span className="fcol-name">sent</span>
            <span className="fcol-n">{sent.length || ''}</span>
          </header>
          <div className="fcol-body">
            {sent.map((t) => (
              <div className="cv-sent-row" key={t.name} title={t.title}>
                <b>{t.number}</b> {t.card?.stage ?? 'not on the board'}
              </div>
            ))}
            {sent.length > 0 && <p className="cv-empty">] to follow them</p>}
          </div>
        </section>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Overview — what is running, what needs you, what is about to land
// ---------------------------------------------------------------------------

const ENDS = new Set(['inbox', 'done'])
const DAY = 86_400_000

const startOfDay = (at: number): number => {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const clock = (at: number): string => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

function tokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${Math.round(n / 1000)}k`
  return String(n)
}

/** One count per stage, in board order: "specifier 4 · coder 1". */
function split(columns: BoardColumn[], pick: (c: BoardColumn) => number): string {
  return columns
    .map((c) => [c.name, pick(c)] as const)
    .filter(([, n]) => n > 0)
    .map(([name, n]) => `${name} ${n}`)
    .join(' · ')
}

/** Merges per day, oldest first, for the last `days` days ending today. */
function mergesPerDay(events: BoardEvent[], days: number): number[] {
  const today = startOfDay(Date.now())
  const out = Array.from({ length: days }, () => 0)
  for (const e of events) {
    if (e.kind !== 'merged') continue
    const ago = Math.round((today - startOfDay(e.at)) / DAY)
    if (ago >= 0 && ago < days) out[days - 1 - ago]++
  }
  return out
}

function Spark({ values }: { values: number[] }) {
  const w = 64
  const h = 18
  const max = Math.max(1, ...values)
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 2 - (v / max) * (h - 4)] as const)
  const last = pts[pts.length - 1]
  return (
    <svg className="cv-spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img">
      <title>{`merged per day, last ${values.length} days: ${values.join(' ')}`}</title>
      <polyline points={pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')} />
      <circle cx={last[0]} cy={last[1]} r={2} />
    </svg>
  )
}

function Tile({ label, tone, n, sub, children }: { label: string; tone?: 'work' | 'ask' | 'land'; n: string; sub: string; children?: ReactNode }) {
  return (
    <div className="cv-tile">
      <span className="cv-tile-l">
        <i className="cv-dot" data-s={tone} />
        {label}
      </span>
      <span className="cv-tile-n">
        {n}
        {children}
      </span>
      <span className="cv-tile-s" title={sub}>
        {sub}
      </span>
    </div>
  )
}

/** How full a capped stage is, one tick per spot: blue working, accent asking. */
function Meter({ column }: { column: BoardColumn }) {
  if (column.cap === undefined) return null
  const ticks = [
    ...column.blocked.map(() => 'ask'),
    ...column.working.map(() => 'work')
  ]
  return (
    <span className="cv-meter">
      {Array.from({ length: column.cap }, (_, i) => (
        <i key={i} data-s={ticks[i]} />
      ))}
    </span>
  )
}

/** Idea → landed in one line: the ideas ladder, the send, then every stage. */
function Pipeline({ board, tasks }: { board: Board; tasks: TaskFolder[] }) {
  return (
    <div className="cv-pipe">
      <div className="cv-pipe-grp">
        <span className="cv-pipe-l">ideas</span>
        <div className="cv-pipe-row">
          {IDEA_COLUMNS.map(({ status }, i) => (
            <span className="cv-pipe-step" key={status}>
              {i > 0 && <span className="cv-arrow">›</span>}
              <span className="cv-node">
                <span className="cv-node-n">{status}</span>
                <span className="cv-node-c">{tasks.filter((t) => t.status === status).length}</span>
              </span>
            </span>
          ))}
        </div>
      </div>
      <span className="cv-handoff">
        <b>⇒</b>⌘⏎ send
      </span>
      <div className="cv-pipe-grp" data-grow>
        <span className="cv-pipe-l">implementation</span>
        <div className="cv-pipe-row">
          {board.columns.map((c, i) => {
            const busy = busyOf(c)
            const door = c.holding.length
            const full = isFull(c)
            return (
              <span className="cv-pipe-step" key={c.name}>
                {i > 0 && <span className="cv-arrow">›</span>}
                <span
                  className="cv-node"
                  data-live={c.working.length > 0 || undefined}
                  data-jam={(full && door > 0) || undefined}
                  data-retired={c.retired || undefined}
                >
                  <span className="cv-node-n">{c.name}</span>
                  <Meter column={c} />
                  <span className="cv-node-c">
                    {c.cap !== undefined ? (
                      <span className="cv-cap" data-full={full || undefined}>
                        {busy}/{c.cap}
                      </span>
                    ) : (
                      <span>{busy + door + c.settled.length}</span>
                    )}
                    {c.cap !== undefined && door > 0 && <span className="cv-door">+{door} door</span>}
                  </span>
                </span>
              </span>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** The lanes a card has been through: grey passed, blue here, accent asking, ↩ sent back. */
function Road({ task, lanes, asking }: { task: ColonyTask; lanes: string[]; asking: boolean }) {
  const at = lanes.indexOf(task.stage)
  return (
    <span className="cv-road">
      {lanes.map((lane, i) => {
        const passed = task.visits.some((v) => v.stage === lane && v.verdict === 'pass')
        const back = i !== at && task.visits.some((v) => v.stage === lane && v.verdict === 'return')
        const s = i === at ? (asking ? 'ask' : 'work') : passed ? 'pass' : undefined
        return <i key={lane} title={lane} data-s={s} data-back={back || undefined} />
      })}
    </span>
  )
}

function ColonyOverview({
  board,
  tasks,
  events,
  onOpen,
  onCommand
}: {
  board: Board
  tasks: TaskFolder[]
  events: BoardEvent[]
  onOpen: (task: ColonyTask, force: boolean) => void
  onCommand?: (id: string) => void
}) {
  const lanes = board.columns.filter((c) => !ENDS.has(c.name)).map((c) => c.name)
  const asking = board.columns.flatMap((c) => c.blocked)
  const running = board.columns.flatMap((c) => c.working)
  const done = board.columns.find((c) => c.name === 'done')
  const ending = (done?.settled ?? []).filter((t) => !t.mergedAt)
  const today = startOfDay(Date.now())
  const landed = events.filter((e) => e.kind === 'merged' && e.at >= today).sort((a, b) => b.at - a.at)
  const perDay = mergesPerDay(events, 14)
  const ideas = tasks.filter((t) => t.status === 'idea' || t.status === 'shaping' || t.status === 'ready')

  // What every measured step that ENDED today spent. Only cards the step report
  // tracks have usage, which the tile says rather than printing a zero.
  let spent = 0
  let steps = 0
  for (const c of board.columns)
    for (const t of [...c.blocked, ...c.working, ...c.holding, ...c.settled])
      for (const v of t.visits) {
        const step = v.step
        if (!step || step.endedAt < today) continue
        spent += step.usage.input + step.usage.output + step.usage.cacheRead + step.usage.cacheWrite
        steps++
      }

  // Waiting, and why: a full stage, a dependency, or the backlog.
  const upNext = board.columns.flatMap((c) =>
    c.holding.map((task) => {
      const why = ENDS.has(c.name)
        ? task.dependsOn?.length
          ? 'after a dependency merges'
          : 'in the backlog · s starts it'
        : isFull(c)
          ? `${c.name} is full ${busyOf(c)}/${c.cap}`
          : `next into ${c.name}`
      return { task, why }
    })
  )
  const oldest = asking.reduce<number | undefined>((m, t) => (m === undefined || t.updatedAt < m ? t.updatedAt : m), undefined)

  const row = (task: ColonyTask, tone?: 'ask') => (
    <button
      className="cv-row"
      key={task.id}
      title={task.brief}
      data-task={task.id}
      data-tone={tone}
      onFocus={() => onOpen(task, false)}
      onClick={() => onOpen(task, true)}
      onContextMenu={() => onCommand?.('colony.archive')}
    >
      <span className="cv-k">{task.kind}</span>
      <span className="cv-nm">
        <b>{task.name}</b>
        <small>{task.line ?? task.warn ?? ''}</small>
      </span>
      <span className="cv-st">{task.stage}</span>
      <Road task={task} lanes={lanes} asking={tone === 'ask'} />
      <span className="cv-r" data-s={tone ? undefined : 'work'}>
        {since(task.updatedAt)}
      </span>
      <span className="cv-r">{task.report ? tokensSoFar(task).replace(' tok', '') : '—'}</span>
    </button>
  )

  return (
    <>
      <Attention board={board} />
      <div className="cv-ov">
        <div className="cv-tiles">
          <Tile label="running" tone="work" n={String(running.length)} sub={split(board.columns, (c) => c.working.length) || 'nothing running'} />
          <Tile label="needs you" tone="ask" n={String(asking.length)} sub={oldest !== undefined ? `oldest waiting ${since(oldest)}` : 'nothing waiting'} />
          <Tile label="ending" n={String(ending.length)} sub={board.automerge ? 'done · merging on its own' : 'done · waits for you to merge'} />
          <Tile label="landed today" tone="land" n={String(landed.length)} sub={`${perDay.reduce((a, b) => a + b, 0)} in 14 days`}>
            <Spark values={perDay} />
          </Tile>
          <Tile
            label="ideas"
            n={String(ideas.length)}
            sub={IDEA_COLUMNS.map(({ status }) => `${status} ${tasks.filter((t) => t.status === status).length}`).join(' · ')}
          />
          <Tile label="spent today" n={tokens(spent)} sub={board.report ? `${steps} measured steps` : 'step report off — m turns it on'} />
        </div>

        <div>
          <div className="cv-sec">
            pipeline <span className="cv-sec-k">idea → landed, where everything is now</span>
          </div>
          <Pipeline board={board} tasks={tasks} />
        </div>

        {/* One table for the two lists that cost something now, so a card's
            stage, road and clock line up whichever list it is in. Two lines a
            row: the second is the sentence, and it gets the full width. */}
        <div className="cv-box">
          <div className="cv-thead">
            <span />
            <span>task</span>
            <span>stage</span>
            <span>road so far</span>
            <span className="cv-r">elapsed</span>
            <span className="cv-r">tokens</span>
          </div>
          <div className="cv-sec" data-tone="ask">
            needs you {asking.length}
            <span className="cv-sec-k">⏎ answer</span>
          </div>
          {asking.length ? asking.map((t) => row(t, 'ask')) : <p className="cv-none">nothing is waiting on you</p>}
          <div className="cv-sec">
            running {running.length}
            <span className="cv-sec-k">⏎ open chat</span>
          </div>
          {running.length ? running.map((t) => row(t)) : <p className="cv-none">no lane is working</p>}
        </div>

        {/* The short lists, in the order a card meets them. */}
        <div className="cv-trio">
          <div className="cv-box">
            <div className="cv-sec">
              up next {upNext.length}
              <span className="cv-sec-k">why it is not moving</span>
            </div>
            {upNext.map(({ task, why }) => (
              <button className="cv-row2" key={task.id} data-task={task.id} title={task.brief} onClick={() => onCommand?.('colony.start')}>
                <span className="cv-k">{task.kind}</span>
                <span className="cv-nm">
                  <b>{task.name}</b>
                  <small>{why}</small>
                </span>
              </button>
            ))}
            {!upNext.length && <p className="cv-none">nothing queued</p>}
          </div>
          <div className="cv-box">
            <div className="cv-sec">
              ending {ending.length}
              <span className="cv-sec-k">reached done</span>
            </div>
            {ending.map((task) => (
              <button
                className="cv-row2"
                key={task.id}
                data-task={task.id}
                title={task.brief}
                onFocus={() => onOpen(task, false)}
                onClick={() => onOpen(task, true)}
              >
                <span className="cv-k">{task.kind}</span>
                <span className="cv-nm">
                  <b>{task.name}</b>
                  <small>
                    passed {task.passes} · {board.automerge ? 'merging' : 'waits for you to merge'}
                  </small>
                </span>
                <span className="cv-r">{since(task.updatedAt)}</span>
              </button>
            ))}
            {!ending.length && <p className="cv-none">nothing about to land</p>}
          </div>
          <div className="cv-box">
            <div className="cv-sec">
              landed today {landed.length}
              <span className="cv-sec-k">undo is in the nanny's log</span>
            </div>
            {landed.map((e) => (
              <div className="cv-row2" data-one key={e.id}>
                <span className="cv-nm">
                  <b>{e.taskName}</b>
                  <small>→ {e.base ?? 'base'}</small>
                </span>
                <span className="cv-r">{clock(e.at)}</span>
              </div>
            ))}
            {!landed.length && <p className="cv-none">nothing merged yet today</p>}
          </div>
        </div>
      </div>
    </>
  )
}

function Column({
  column,
  index,
  onOpen,
  onCommand
}: {
  column: BoardColumn
  index: number
  onOpen: (task: ColonyTask, force: boolean) => void
  onCommand?: (id: string) => void
}) {
  const held = [...column.holding, ...column.settled]
  const empty = column.blocked.length + column.working.length + held.length === 0
  const total = column.blocked.length + column.working.length + held.length

  return (
    <section
      className="fcol"
      data-empty={empty || undefined}
      data-collapsed={empty || undefined}
      data-retired={column.retired || undefined}
      data-live={column.working.length > 0 || undefined}
    >
      <header className="fcol-head">
        <span className="fcol-name">{column.name}</span>
        <span className="fcol-n">{total || ''}</span>
        {column.cap !== undefined && (
          <span className="fcol-cap" data-full={isFull(column) || undefined}>
            {busyOf(column)}/{column.cap}
          </span>
        )}
        {/* What the column IS: the skill it runs and the model it runs it on.
            The name is only a label — these three are the behaviour. */}
        {column.skill && (
          <div className="fcol-def">
            <span className="fcol-skill">{column.skill}</span>
            <span className="fcol-model" data-alt={column.harness ? '' : undefined}>
              {column.harness ? `${column.harness}:` : ''}
              {column.model ?? 'default'}
            </span>
          </div>
        )}
      </header>

      {/* One nav group per column, so j/k walks this column and stops at its
          end instead of falling into the next one's top card. */}
      <div className="fcol-body" data-nav-group>
        {column.blocked.length > 0 && (
          <div className="fband">
            <span className="fband-tag" data-tone="ask">
              needs you {column.blocked.length}
            </span>
            {column.blocked.map((task) => (
              <Card key={task.id} task={task} col={index} asking onOpen={onOpen} onCommand={onCommand} />
            ))}
          </div>
        )}
        {column.working.map((task) => (
          <Card key={task.id} task={task} col={index} onOpen={onOpen} onCommand={onCommand} />
        ))}
        {held.length > 0 && (
          <div className="fband" data-hold data-pin={column.cap !== undefined || undefined}>
            <span className="fband-tag">
              {column.cap === undefined
                ? `${column.name === 'done' ? 'landed' : 'backlog'} ${held.length}`
                : `holding ${held.length}${isFull(column) ? ' · no spot' : ''}`}
            </span>
            {held.map((task, i) => (
              <Held key={task.id} task={task} col={index} at={i} onCommand={onCommand} />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

/** What a measured card's finished steps have spent, as the card prints it. */
function tokensSoFar(task: ColonyTask): string {
  let n = 0
  for (const v of task.visits) {
    const u = v.step?.usage
    if (u) n += u.input + u.output + u.cacheRead + u.cacheWrite
  }
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M tok` : `${Math.round(n / 1000)}k tok`
}

/** Elapsed, at the resolution the card prints it: seconds while it is fresh, days once it is old. */
function since(at: number): string {
  const t = Math.max(0, Math.floor((Date.now() - at) / 1000))
  const m = Math.floor(t / 60)
  const h = Math.floor(m / 60)
  if (h >= 24) return `${Math.floor(h / 24)}d`
  if (h) return `${h}h ${String(m % 60).padStart(2, '0')}m`
  return m ? `${m}m ${String(t % 60).padStart(2, '0')}s` : `${t}s`
}

function Card({
  task,
  col,
  asking,
  onOpen,
  onCommand
}: {
  task: ColonyTask
  col: number
  asking?: boolean
  onOpen: (task: ColonyTask, force: boolean) => void
  onCommand?: (id: string) => void
}) {
  const sent = task.visits.filter((v) => v.verdict === 'return')
  const returns = sent.length
  const lastReturn = sent.length ? `${sent[sent.length - 1].stage}: ${sent[sent.length - 1].why ?? ''}` : undefined
  return (
    <button
      className="fcard"
      title={task.brief}
      // Read by the colony commands off the focused row — the same trick the
      // skills list plays with `data-skill`, so a key and a click cannot drift.
      data-task={task.id}
      data-col={col}
      // Landed on base. The card is finished in a way `settled` does not say on
      // its own: `done` means every lane passed it, merged means it is out of
      // the repo's future tense.
      data-merged={task.mergedAt ? '' : undefined}
      // Queued behind a dependency, so it has NO WORKTREE yet. Drawn dashed
      // because that is literally the difference from every other card, and it
      // is the whole point of the state — two dependent trees never co-exist.
      data-queued={task.queued && !task.worktreePath ? '' : undefined}
      onFocus={() => onOpen(task, false)}
      onClick={() => onOpen(task, true)}
      onContextMenu={() => onCommand?.('colony.archive')}
    >
      <div className="fcard-top">
        {/* Needs you as a BADGE, never as a border: the border is the cursor's,
            and a card can be selected while asking. */}
        {asking && (
          <span className="hmark">
            <IconQuestionMark size={9} stroke={2.4} />
          </span>
        )}
        <span className="fkind">{task.kind}</span>
        {/* Passes, and — only when there have been any — the times a lane
            handed this card back. A task bouncing between two lanes twice is
            the signal that something is wrong with the TASK rather than with
            the lane (D23), and it is only a signal if the board draws it. */}
        {returns > 0 && (
          <span className="freturn" title={lastReturn}>
            ↩{returns}
          </span>
        )}
        <span className="fpass">✓{task.passes}</span>
      </div>
      <div className="fcard-name">{task.name}</div>
      {task.line && <div className="fcard-line">{task.line}</div>}
      {task.warn && <div className="fcard-warn">{task.warn}</div>}
      <div className="fcard-foot">
        <span>{since(task.updatedAt)}</span>
        {/* Measured by the step report: what its steps have spent so far. */}
        {task.report && (
          <span className="fcard-report" title="step report — r writes and opens it">
            report · {tokensSoFar(task)}
          </span>
        )}
      </div>
    </button>
  )
}

/**
 * A holding row is one line (D5): nothing is running, so there is no elapsed
 * and no token count to print. What it keeps is its place in the queue.
 */
function Held({
  task,
  col,
  at,
  onCommand
}: {
  task: ColonyTask
  col: number
  at: number
  onCommand?: (id: string) => void
}) {
  return (
    <button
      className="fq"
      // A holding row is one line (D5), so the reason a lane parked it — and the
      // brief, for a card straight out of the backlog — is the one thing that has
      // nowhere to go on it.
      title={task.line ? `${task.line}\n\n${task.brief}` : task.brief}
      data-task={task.id}
      data-col={col}
      onClick={() => onCommand?.('colony.start')}
      onContextMenu={() => onCommand?.('colony.archive')}
    >
      <span className="fkind">{task.kind}</span>
      <span className="fq-name">{task.name}</span>
      {/* A finished card's report is the thing you came to `done` for. */}
      {task.report?.file && (
        <span className="fq-report" title="step report — r opens it">
          report
        </span>
      )}
      <span className="fq-pos">#{at + 1}</span>
    </button>
  )
}
