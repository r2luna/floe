import type { ProvisionStep } from '../../shared/types'
import type { ProvisionFlow } from './useProvision'
import { Spinner } from './Spinner'

/**
 * The worktree's setup, as a timeline.
 *
 * The same rail as the merge and the removal — a chain of steps you watch —
 * because it is the same kind of thing, and the point of all three is that a
 * long-running chain is never invisible. This one earns it the hardest: a
 * worktree whose setup silently did nothing looks exactly like one that
 * worked, right up until the site serves the wrong branch.
 *
 * Its buttons dispatch command ids rather than acting, so the chips and the
 * keys are the same commands. See the rule at the top of commands.ts.
 */
export function ProvisionPanel({
  flow,
  onCommand
}: {
  flow: ProvisionFlow | null
  onCommand: (id: string) => void
}) {
  if (!flow)
    return <p className="empty">No setup running. ⌘K W runs it again for this worktree.</p>

  const { steps, running, ok, branch, tail } = flow
  const failed = steps.find((s) => s.status === 'failed')
  const settled = steps.filter((s) => s.status !== 'pending' && s.status !== 'running').length

  const foot = running
    ? 'esc hide · runs in the background'
    : failed
      ? '⏎ retry from the failed step · esc hide'
      : ok
        ? '✓ ready · esc close'
        : '⏎ run again · esc close'

  return (
    <>
      <div className="merge-head">
        <span className="merge-branch">{branch}</span>
        <span className="merge-count">
          {settled}/{steps.length}
        </span>
      </div>

      {steps.length === 0 && <p className="empty">{tail ?? 'Working out what this project needs…'}</p>}

      <ul className="merge-track">
        {steps.map((s) => (
          <Step key={s.id} step={s} tail={tail} onCommand={onCommand} />
        ))}
      </ul>

      <div className="merge-foot">{foot}</div>
    </>
  )
}

/** Which tone the row and its dot carry. One word, so the CSS reads as states. */
function toneOf(step: ProvisionStep): string {
  if (step.status === 'failed') return ' merge-bad'
  if (step.status === 'running') return ' merge-run'
  if (step.status === 'done') return ' merge-ok'
  if (step.status === 'skipped') return ' merge-skip'
  return ''
}

function Step({
  step,
  tail,
  onCommand
}: {
  step: ProvisionStep
  tail?: string
  onCommand: (id: string) => void
}) {
  const failed = step.status === 'failed'
  const live = step.status === 'running'
  const aside =
    !live && !failed && (step.detail || (step.status === 'skipped' ? 'skipped' : undefined))

  return (
    <li className={`merge-node${toneOf(step)}`}>
      {live ? <Spinner className="merge-dot" /> : <i className="merge-dot" />}
      <div className="merge-row">
        <span className="merge-name">{step.label}</span>
        {aside && <span className="merge-aside">{aside}</span>}
      </div>

      {/* A composer install is minutes of silence otherwise. The running step
          shows the last line of its own output, which is the difference between
          "working" and "hung". */}
      {live && (tail || step.detail) && <div className="merge-sub">{tail ?? step.detail}</div>}
      {failed && step.detail && <div className="merge-sub">{step.detail}</div>}

      {failed && (
        <div className="merge-acts">
          <button className="merge-chip" onClick={() => onCommand('provision.confirm')}>
            ⏎ retry
          </button>
          <button className="merge-chip" onClick={() => onCommand('provision.cancel')}>
            esc hide
          </button>
        </div>
      )}
    </li>
  )
}
