import { IconPlayerPlay, IconPlayerStop, IconRefresh } from './icons'
import type { OpenFn } from './panels'
import type { ProjectCommand } from '../../main/commands'
import type { CommandRunState, Commands } from './useCommands'
import { Spinner } from './Spinner'

function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  return `${Math.round(n / 1024 ** 2)} MB`
}

/** "3h ago" — re-read on render, which is precise enough for a finished run. */
function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

function dur(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

/**
 * Line two's right-hand note: the memory while it runs, how it ended once it
 * has, and the breaker's reason when auto-restart gave up — which outranks the
 * exit code, because "exit 1" is the symptom and the loop is the story.
 */
function note(run?: CommandRunState): { text: string; err?: true } | undefined {
  if (!run) return undefined
  if (run.state === 'crash-looping') return { text: run.reason ?? 'crash looping', err: true }
  if (run.state === 'running') return run.rss ? { text: bytes(run.rss) } : undefined
  if (run.state === 'starting') return { text: 'starting…' }
  if (run.state === 'stopping') return { text: 'stopping…' }
  if (run.exitCode == null) return undefined
  const parts = [`exit ${run.exitCode}`]
  if (run.endedAt != null) parts.push(ago(run.endedAt))
  if (run.durationMs != null) parts.push(`ran ${dur(run.durationMs)}`)
  return { text: parts.join(' · '), err: run.exitCode === 0 ? undefined : true }
}

const LABEL: Record<CommandRunState['state'], string> = {
  idle: 'stopped',
  starting: 'starting',
  running: 'running',
  stopping: 'stopping',
  exited: 'stopped',
  'crash-looping': 'stopped'
}

/**
 * The worktree's processes, as dense two-line rows: state on top, the command
 * it runs below.
 *
 * Rows are plain buttons so the lane's own cursor walks them (see rowsOf in
 * App) — the pane has no keyboard handling of its own. The ▶/■/↻ beside each
 * row are spans with a button role rather than nested buttons: a real button
 * would enter the cursor's row list, and every command would then own three
 * stops the cursor had to walk past.
 */
export function CommandsPane({
  commands,
  worktreePath,
  onOpen,
  onCommand
}: {
  commands: Commands
  worktreePath?: string
  onOpen: OpenFn
  onCommand?: (id: string) => void
}): JSX.Element {
  const { list, runOf } = commands

  if (commands.error) return <p className="empty error">{commands.error}</p>
  if (commands.loading && !list.length) return <p className="empty">Loading…</p>
  if (!list.length)
    return <p className="empty">No commands yet — press a, or edit commands.toml.</p>

  const running = list.filter((c) => runOf(c.id)?.state === 'running').length

  /* Up first, then everything else, with a heading before each block.
     Flattened into ONE list — a heading is an entry like any row — because the
     alternative nests a map inside a map and pushes the row markup two levels
     further in for nothing.
     Grouped on the same predicate the row uses to pick its spinner, so the
     block a command lands in and the mark it carries cannot disagree.
     `stopping` sits with the stopped and says so on the row: it is on its way. */
  const isLive = (c: ProjectCommand): boolean => {
    const s = runOf(c.id)?.state ?? 'idle'
    return s === 'running' || s === 'starting'
  }
  type Item = { head: string } | { cmd: ProjectCommand; group: string }
  const rows: Item[] = []
  for (const group of ['running', 'stopped']) {
    const block = list.filter((c) => isLive(c) === (group === 'running'))
    if (!block.length) continue
    rows.push({ head: group })
    for (const cmd of block) rows.push({ cmd, group })
  }

  return (
    <>
      <div className="changes-head">
        <span>
          {running}/{list.length} running
        </span>
        <span className="cmd-headacts">
          {running > 0 && (
            <span
              className="cmd-runall"
              role="button"
              tabIndex={-1}
              title="Stop every running command"
              onMouseDown={(e) => {
                e.preventDefault() // keep the focus (and the cursor) where it is
                onCommand?.('command.stopAll')
              }}
            >
              Stop all
            </span>
          )}
          {running < list.length && (
            <span
              className="cmd-runall"
              role="button"
              tabIndex={-1}
              title="Run every stopped command"
              onMouseDown={(e) => {
                e.preventDefault() // keep the focus (and the cursor) where it is
                onCommand?.('command.runAll')
              }}
            >
              Run all
            </span>
          )}
        </span>
      </div>
      {rows.map((r) => {
        if ('head' in r)
          return (
            <div className="group-label" key={`head:${r.head}`}>
              {r.head.toUpperCase()}
            </div>
          )
        const c = r.cmd
        const run = runOf(c.id)
        const state = run?.state ?? 'idle'
        const live = state === 'running' || state === 'starting'
        const n = note(run)
        return (
          <button
            key={c.id}
            className="row cmd-row"
            data-command={c.id}
            data-live={live || undefined}
            title={c.command}
            onClick={() => onOpen({ kind: 'cmdlog', sub: `${worktreePath ?? ''}#${c.id}` })}
          >
            <span className="cmd-l1">
              {/* Running turns; anything else is a still dot coloured by how it
                  ended. It used to be green either way, so a command that had
                  died and one still serving looked the same. */}
              {live ? (
                <Spinner />
              ) : (
                <span
                  className={
                    'dot' +
                    (state === 'crash-looping' || (run?.exitCode ?? 0) !== 0 ? ' dot-err' : '')
                  }
                />
              )}
              <span className="row-name">{c.name}</span>
              {c.scope === 'project' && <span className="cmd-scope">project</span>}
              {/* Only a state the heading above does NOT already say. That
                  leaves `starting` under RUNNING and `stopping` under STOPPED —
                  the two transitions worth seeing. A crash loop loses nothing:
                  LABEL calls it `stopped` and the reason is in the note, in the
                  error tone. */}
              {LABEL[state] !== r.group && (
                <span className="cmd-state" data-run={live ? '' : undefined}>
                  {LABEL[state]}
                </span>
              )}
            </span>
            <span className="cmd-l2">
              <span className="cmd-cmd">{c.command}</span>
              {n && (
                <span className="cmd-note" data-err={n.err}>
                  {n.text}
                </span>
              )}
            </span>
            {/* The row's own second column, not part of the command line: inside
                it the buttons sat after a note whose width changes per row, so
                they landed at a different x on every one. */}
            <span className="cmd-acts">
              {live ? (
                <>
                  <span
                    className="cmd-act"
                    role="button"
                    title="Restart"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      commands.restart(c.id)
                    }}
                  >
                    <IconRefresh size={13} stroke={1.7} />
                  </span>
                  <span
                    className="cmd-act"
                    role="button"
                    title="Stop (s)"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      commands.stop(c.id)
                    }}
                  >
                    <IconPlayerStop size={13} stroke={1.7} />
                  </span>
                </>
              ) : (
                <span
                  className="cmd-act"
                  role="button"
                  title="Run (r)"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    commands.start(c.id)
                  }}
                >
                  <IconPlayerPlay size={13} stroke={1.7} />
                </span>
              )}
            </span>
          </button>
        )
      })}
    </>
  )
}
