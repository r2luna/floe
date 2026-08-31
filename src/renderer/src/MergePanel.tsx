import type { MergeStep } from '../../shared/types'
import type { MergeFlow } from './useMerge'
import { Spinner } from './Spinner'

/**
 * Steps that throw work away. Flagged from the first paint, not at the moment
 * they run: someone watching a checklist should be able to see what is coming
 * while there is still time to cancel.
 */
const DESTRUCTIVE = new Set<string>(['database', 'cleanup', 'closebranch'])

/**
 * The guided merge, as a timeline.
 *
 * A rail down the left with one dot per step, filled behind you and hollow
 * ahead — the shape carries the progress, so there is no second progress bar
 * saying the same thing twice. The step in flight grows in place rather than
 * becoming a card: the merge is one sequence, and lifting the active step out
 * of it would break the only line the eye has to follow.
 *
 * Its buttons dispatch command ids rather than acting, so the chips and the
 * keys are the same commands — `⏎` confirm, `r` review, `s` stash — and cannot
 * drift. See the rule at the top of commands.ts.
 */
export function MergePanel({
  flow,
  onCommand
}: {
  flow: MergeFlow | null
  onCommand: (id: string) => void
}) {
  if (!flow) return <p className="empty">No merge running. ⌘K M merges this worktree.</p>

  const { steps, awaiting, done, branch, base } = flow
  const errored = steps.find((s) => s.status === 'error')
  const settled = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length
  // "Stash & retry" only answers one blocker — a tree with uncommitted work.
  const canStash = !!errored && /uncommitted changes/i.test(errored.detail ?? '')

  const foot = done
    ? '✓ merged · esc close'
    : errored
      ? '⏎ retry · esc cancel · re-runs from the failed step'
      : awaiting === 'review'
        ? '⏎ approve · r review · esc cancel'
        : 'esc cancel · runs in the background'

  return (
    <>
      <div className="merge-head">
        <span className="merge-branch">{branch}</span>
        {base && <span className="merge-base">→ {base}</span>}
        <span className="merge-count">
          {settled}/{steps.length}
        </span>
      </div>

      <ul className="merge-track">
        {steps.map((s) => (
          <Step
            key={s.id}
            step={s}
            awaiting={awaiting}
            canStash={canStash}
            onCommand={onCommand}
          />
        ))}
      </ul>

      <div className="merge-foot">{foot}</div>
    </>
  )
}

/** Which tone the row and its dot carry. One word, so the CSS reads as states. */
function toneOf(step: MergeStep): string {
  if (step.status === 'error') return ' merge-bad'
  if (step.status === 'blocked') return ' merge-wait'
  if (step.status === 'running') return ' merge-run'
  if (step.status === 'done') return ' merge-ok'
  if (step.status === 'skipped') return ' merge-skip'
  return ''
}

function Step({
  step,
  awaiting,
  canStash,
  onCommand
}: {
  step: MergeStep
  awaiting: 'review' | null
  canStash: boolean
  onCommand: (id: string) => void
}) {
  const failed = step.status === 'error'
  const live = step.status === 'running' || step.status === 'blocked'
  // The detail belongs beside the name while the step is settled — a commit
  // hash, a conflict count — and under it while the step is live, where it is a
  // sentence about what is happening rather than a label.
  //
  // A skipped step says so even when it has no detail: its dot is hollow, which
  // on its own reads as "not there yet" rather than "not needed".
  const aside =
    !live && !failed && (step.detail || (step.status === 'skipped' ? 'skipped' : undefined))

  return (
    <li className={`merge-node${toneOf(step)}`}>
      {/* The step in flight turns, like every in-flight mark in the app; every
          other status is a still dot, coloured by how it ended. `blocked` is a
          still one on purpose — it is not working, it is waiting on you, and
          the whole point of the rail is that those never look alike. */}
      {step.status === 'running' ? <Spinner className="merge-dot" /> : <i className="merge-dot" />}
      <div className="merge-row">
        <span className="merge-name">{step.title}</span>
        {aside && <span className="merge-aside">{aside}</span>}
        {DESTRUCTIVE.has(step.id) && step.status !== 'skipped' && !aside && (
          <span className="merge-destructive">destructive</span>
        )}
      </div>

      {(live || failed) && step.detail && <div className="merge-sub">{step.detail}</div>}

      {failed && (
        <div className="merge-acts">
          {canStash && (
            <button className="merge-chip merge-chip-danger" onClick={() => onCommand('merge.stash')}>
              s stash &amp; retry
            </button>
          )}
          <button className="merge-chip" onClick={() => onCommand('merge.confirm')}>
            ⏎ retry
          </button>
          <button className="merge-chip" onClick={() => onCommand('merge.cancel')}>
            esc cancel
          </button>
        </div>
      )}

      {step.status === 'blocked' && awaiting === 'review' && (
        <div className="merge-acts">
          <button className="merge-chip" onClick={() => onCommand('merge.confirm')}>
            ⏎ approve
          </button>
          <button className="merge-chip" onClick={() => onCommand('merge.review')}>
            r review
          </button>
          <button className="merge-chip" onClick={() => onCommand('merge.cancel')}>
            esc cancel
          </button>
        </div>
      )}
    </li>
  )
}
