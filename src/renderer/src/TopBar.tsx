import type { Worktree, WorktreeStatus } from '../../shared/types'
import { topBarState } from './topBarState'

/**
 * The strip across the top of the window: where you are on the left (project,
 * branch, the base it merges into, the machine when it is not this one), what
 * is left on the right (files to commit, commits to push, whether the branch is
 * ready to merge). Groups with nothing to say drop out. The rightmost chip is
 * the next step, and each runs the same command as its chord.
 *
 * It is also the window's drag handle: the window is frameless and had none.
 */
export function TopBar({
  project,
  machine,
  worktree,
  status,
  keys,
  onCommit,
  onMerge
}: {
  project?: string
  /** The machine the project lives on, shown only when it is not this one. */
  machine?: string
  worktree?: Worktree
  status?: WorktreeStatus
  keys: { commit?: string; merge?: string }
  onCommit: () => void
  onMerge: () => void
}) {
  const s = topBarState(worktree, status)
  const branch = worktree && !worktree.home ? worktree.branch : undefined
  const clean = status && !s.dirty
  return (
    <header className="topbar">
      <span className="topbar-where">
        <span className="topbar-project">{project ?? 'Floe'}</span>
        {branch && (
          <>
            <span className="topbar-faint">/</span>
            <span className="topbar-branch">{branch}</span>
            {s.base && <span className="topbar-faint">from {s.base.name}</span>}
            {worktree?.isMain && <span className="topbar-tag">main</span>}
          </>
        )}
        {machine && <span className="topbar-tag">{machine}</span>}
      </span>
      <span className="topbar-gap" />
      {s.dirty && (
        <span className="topbar-group">
          {s.dirty.added > 0 && <span className="wt-add">+{s.dirty.added}</span>}
          {s.dirty.modified > 0 && <span className="wt-mod">~{s.dirty.modified}</span>}
          {s.dirty.deleted > 0 && <span className="wt-del">−{s.dirty.deleted}</span>}
          <span className="topbar-faint">uncommitted</span>
          <Chip tone="commit" label="commit" chord={keys.commit} onClick={onCommit} />
        </span>
      )}
      {clean && s.merge !== 'nothing' && (
        <span className="topbar-group">
          <span className="topbar-ok">clean</span>
        </span>
      )}
      {s.push + s.pull > 0 && (
        <span className="topbar-group">
          {s.push > 0 && <span className="wt-sync">⇡{s.push}</span>}
          {s.pull > 0 && <span className="wt-sync">⇣{s.pull}</span>}
          <span className="topbar-faint">{s.push > 0 ? 'to push' : 'to pull'}</span>
        </span>
      )}
      {s.merge === 'commit-first' && (
        <span className="topbar-group">
          <span className="topbar-faint">merge after commit</span>
        </span>
      )}
      {s.merge === 'blocked' && (
        <span className="topbar-group">
          <span className="topbar-faint">merge blocked</span>
        </span>
      )}
      {s.merge === 'nothing' && (
        <span className="topbar-group">
          <span className="topbar-faint">clean · nothing to merge</span>
        </span>
      )}
      {s.merge === 'ready' && s.base && (
        <span className="topbar-group">
          {/* The base moved on since the branch forked: still mergeable, but
              the merge has the base's new commits to bring in first. */}
          {s.base.behind > 0 ? (
            <span className="topbar-warn">
              {s.base.name} ⇣{s.base.behind}
            </span>
          ) : (
            <span className="topbar-ok">ready to merge</span>
          )}
          <span className="topbar-faint">
            {s.base.ahead} commit{s.base.ahead === 1 ? '' : 's'}
          </span>
          <Chip tone="merge" label="merge" chord={keys.merge} onClick={onMerge} />
        </span>
      )}
    </header>
  )
}

function Chip({
  tone,
  label,
  chord,
  onClick
}: {
  tone: 'commit' | 'merge'
  label: string
  chord?: string
  onClick: () => void
}) {
  return (
    <button
      className="topbar-chip"
      data-tone={tone}
      title={chord ? `${label} (${chord})` : label}
      // The bar is not a place to stand: a click must leave focus where you
      // were typing, so the chord and the click land you in the same spot.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {label}
      {chord && <kbd>{chord}</kbd>}
    </button>
  )
}
