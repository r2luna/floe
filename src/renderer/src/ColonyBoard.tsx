import { useCallback, useEffect, useRef } from 'react'
import { IconAlertCircle, IconQuestionMark } from './icons'
import { useColony } from './useColony'
import { busyOf, isFull, type BoardColumn, type ColonyTask } from '../../shared/colony'
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
  const { board, loading, error } = useColony(project)

  // The card's chat follows the cursor, after a beat (D6). Held `j` would
  // otherwise load a transcript per keystroke, and the one you meant to read is
  // the one you stopped on.
  const follow = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(follow.current), [])

  const openChat = useCallback(
    (task: ColonyTask, force: boolean) => {
      clearTimeout(follow.current)
      if (!task.sessionId || !task.worktreePath) return
      const session = { id: task.sessionId, worktreePath: task.worktreePath }
      // Forced, the chat takes focus — you pressed Enter to go and read it.
      // Followed, it does not: the board is still the panel you are driving.
      const go = (): void => onOpen({ kind: 'chat', session, keepFocus: !force })
      if (force) go()
      else follow.current = setTimeout(go, 150)
    },
    [onOpen]
  )

  if (error) return <p className="empty error">{error}</p>
  if (!project) return <p className="empty">No project open.</p>
  if (loading && !board) return <p className="empty">Loading…</p>
  if (!board) return <p className="empty">No board.</p>

  const asking = board.columns.flatMap((c) => c.blocked)

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
      </div>

      {/* The one thing on this board that costs you something: tasks that
          stopped on a question. Accent is reserved for exactly this (D25). */}
      {asking.length > 0 && (
        <div className="fatt">
          <span className="fatt-tag">ATTENTION</span>
          <span className="fatt-item">
            <b>{asking[0].name}</b>
            {asking[0].line ? ` — ${asking[0].line}` : ''}
          </span>
          <span className="fatt-key">⏎ answer · {asking.length} waiting</span>
        </div>
      )}

      <div className="board">
        {board.columns.map((column, ci) => (
          <Column key={column.name} column={column} index={ci} onOpen={openChat} onCommand={onCommand} />
        ))}
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

/** Elapsed, at the resolution the card prints it. */
function since(at: number): string {
  const t = Math.max(0, Math.floor((Date.now() - at) / 1000))
  const m = Math.floor(t / 60)
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
      <span className="fq-pos">#{at + 1}</span>
    </button>
  )
}
