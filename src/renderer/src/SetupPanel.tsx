import type { SetupStep } from '../../shared/types'
import type { SetupFlow } from './useProjectSetup'
import { Spinner } from './Spinner'

/**
 * The project setup, as a timeline.
 *
 * The same rail as the merge and the removal, deliberately: it is the same kind
 * of thing — a chain of steps you watch — and a shape of its own would say they
 * are unrelated. Nothing here is destructive, so unlike the removal there is no
 * warning to carry; what it has instead is one place where the agent needs you,
 * and the chip on that step is the way in (D1).
 *
 * Its buttons dispatch command ids rather than acting, so the chips and the
 * keys are the same commands — `⏎` open the chat, `esc` cancel — and cannot
 * drift. See the rule at the top of commands.ts.
 */
export function SetupPanel({
  flow,
  onCommand
}: {
  flow: SetupFlow | null
  onCommand: (id: string) => void
}) {
  if (!flow)
    return (
      <p className="empty">
        Nothing being set up. Add a project and Floe works out its commands — ⌘K runs it again for
        one you already have.
      </p>
    )

  const { steps, done } = flow
  const errored = steps.find((s) => s.status === 'error')
  const waiting = steps.some((s) => s.status === 'blocked')
  const settled = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length

  const foot = done
    ? '✓ all done · esc close'
    : errored
      ? 'r try again · esc stop · picks up from the step that failed'
      : waiting
        ? '⏎ open chat · esc stop · the agent needs an answer from you'
        : 'esc stop · this carries on while you work'

  return (
    <>
      <div className="merge-head">
        <span className="merge-branch">commands</span>
        <span className="merge-count">
          {settled}/{steps.length}
        </span>
      </div>

      <ul className="merge-track">
        {steps.map((s) => (
          <Step key={s.id} step={s} onCommand={onCommand} />
        ))}
      </ul>

      <div className="merge-foot">{foot}</div>
    </>
  )
}

/** Which tone the row and its dot carry. One word, so the CSS reads as states. */
function toneOf(step: SetupStep): string {
  if (step.status === 'error') return ' merge-bad'
  if (step.status === 'blocked') return ' merge-wait'
  if (step.status === 'running') return ' merge-run'
  if (step.status === 'done') return ' merge-ok'
  if (step.status === 'skipped') return ' merge-skip'
  return ''
}

function Step({ step, onCommand }: { step: SetupStep; onCommand: (id: string) => void }) {
  const failed = step.status === 'error'
  const live = step.status === 'running' || step.status === 'blocked'
  const aside =
    !live && !failed && (step.detail || (step.status === 'skipped' ? 'skipped' : undefined))

  return (
    <li className={`merge-node${toneOf(step)}`}>
      {step.status === 'running' ? <Spinner className="merge-dot" /> : <i className="merge-dot" />}
      <div className="merge-row">
        <span className="merge-name">{step.title}</span>
        {aside && <span className="merge-aside">{aside}</span>}
      </div>

      {(live || failed) && step.detail && <div className="merge-sub">{step.detail}</div>}

      {failed && (
        <div className="merge-acts">
          <button className="merge-chip" onClick={() => onCommand('setup.retry')}>
            r try again
          </button>
          <button className="merge-chip" onClick={() => onCommand('setup.cancel')}>
            esc stop
          </button>
        </div>
      )}

      {/* The one place the flow needs a person: the agent asked, and the answer
          lives in a chat that was deliberately not opened alongside the panel.
          This is the way to it. */}
      {step.status === 'blocked' && (
        <div className="merge-acts">
          <button className="merge-chip" onClick={() => onCommand('setup.chat')}>
            ⏎ open chat
          </button>
          <button className="merge-chip" onClick={() => onCommand('setup.cancel')}>
            esc stop
          </button>
        </div>
      )}
    </li>
  )
}
