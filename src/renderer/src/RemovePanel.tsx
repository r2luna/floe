import type { RemoveStep } from '../../shared/types'
import type { RemoveFlow } from './useRemove'
import { Spinner } from './Spinner'

/**
 * Every step here throws something away, so unlike the merge there is nothing
 * to flag — the panel is the warning. `preflight` is the one exception: it only
 * looks.
 */
const DESTRUCTIVE = new Set<string>(['database', 'worktree', 'branch'])

/**
 * The guided removal, as a timeline.
 *
 * The same rail as the merge, deliberately: it is the same kind of thing —
 * a chain of git steps you watch — and giving it a shape of its own would say
 * they are unrelated. What differs is where it stops. A dirty tree pauses the
 * chain and lists what is about to be destroyed, because that is the last
 * moment the answer can still be no.
 *
 * Its buttons dispatch command ids rather than acting, so the chips and the
 * keys are the same commands — `⏎` confirm, `esc` cancel — and cannot drift.
 * See the rule at the top of commands.ts.
 */
export function RemovePanel({
  flow,
  onCommand
}: {
  flow: RemoveFlow | null
  onCommand: (id: string) => void
}) {
  if (!flow) return <p className="empty">No removal running. ⌘K X removes this worktree.</p>

  const { steps, awaiting, done, branch, changes } = flow
  const errored = steps.find((s) => s.status === 'error')
  const settled = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length

  const foot = done
    ? '✓ removed · esc close'
    : errored
      ? '⏎ retry · esc cancel · re-runs from the failed step'
      : awaiting === 'force'
        ? '⏎ force · esc cancel · the changes are not recoverable'
        : 'esc cancel · runs in the background'

  return (
    <>
      <div className="merge-head">
        <span className="merge-branch">{branch}</span>
        <span className="merge-count">
          {settled}/{steps.length}
        </span>
      </div>

      <ul className="merge-track">
        {steps.map((s) => (
          <Step key={s.id} step={s} awaiting={awaiting} changes={changes} onCommand={onCommand} />
        ))}
      </ul>

      <div className="merge-foot">{foot}</div>
    </>
  )
}

/** Which tone the row and its dot carry. One word, so the CSS reads as states. */
function toneOf(step: RemoveStep): string {
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
  changes,
  onCommand
}: {
  step: RemoveStep
  awaiting: 'force' | null
  changes: string[]
  onCommand: (id: string) => void
}) {
  const failed = step.status === 'error'
  const live = step.status === 'running' || step.status === 'blocked'
  const aside =
    !live && !failed && (step.detail || (step.status === 'skipped' ? 'skipped' : undefined))
  // What is about to be destroyed, listed at the checkpoint that is asking
  // about it — "3 uncommitted changes" is not something anyone can answer yes
  // to without seeing which three.
  const showChanges = step.status === 'blocked' && awaiting === 'force' && changes.length > 0

  return (
    <li className={`merge-node${toneOf(step)}`}>
      {step.status === 'running' ? <Spinner className="merge-dot" /> : <i className="merge-dot" />}
      <div className="merge-row">
        <span className="merge-name">{step.title}</span>
        {aside && <span className="merge-aside">{aside}</span>}
        {DESTRUCTIVE.has(step.id) && step.status !== 'skipped' && !aside && (
          <span className="merge-destructive">destructive</span>
        )}
      </div>

      {(live || failed) && step.detail && <div className="merge-sub">{step.detail}</div>}

      {showChanges && (
        <ul className="remove-changes">
          {changes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}

      {failed && (
        <div className="merge-acts">
          <button className="merge-chip" onClick={() => onCommand('remove.confirm')}>
            ⏎ retry
          </button>
          <button className="merge-chip" onClick={() => onCommand('remove.cancel')}>
            esc cancel
          </button>
        </div>
      )}

      {step.status === 'blocked' && awaiting === 'force' && (
        <div className="merge-acts">
          <button
            className="merge-chip merge-chip-danger"
            onClick={() => onCommand('remove.confirm')}
          >
            ⏎ force remove
          </button>
          <button className="merge-chip" onClick={() => onCommand('remove.cancel')}>
            esc cancel
          </button>
        </div>
      )}
    </li>
  )
}
