import { useEffect, useRef, useState } from 'react'
import type { ProvisionAsk, ProvisionStep } from '../../shared/types'
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
  onCommand,
  onAnswer
}: {
  flow: ProvisionFlow | null
  onCommand: (id: string) => void
  onAnswer: (requestId: string, text: string | null) => void
}) {
  if (!flow)
    return <p className="empty">No setup running. ⌘K W runs it again for this worktree.</p>

  const { steps, running, ok, branch, tail, tailId, ask } = flow
  const failed = steps.find((s) => s.status === 'failed')
  const settled = steps.filter((s) => s.status !== 'pending' && s.status !== 'running').length

  const foot = ask
    ? 'answering writes .floe/premise.md — every new chat here starts with it'
    : running
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
          <Step
            key={s.id}
            step={s}
            tail={tailId === s.id ? tail : undefined}
            ask={ask?.stepId === s.id ? ask : null}
            onCommand={onCommand}
            onAnswer={onAnswer}
          />
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
  ask,
  onCommand,
  onAnswer
}: {
  step: ProvisionStep
  tail?: string
  ask?: ProvisionAsk | null
  onCommand: (id: string) => void
  onAnswer: (requestId: string, text: string | null) => void
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
      {live && !ask && (tail || step.detail) && <div className="merge-sub">{tail ?? step.detail}</div>}
      {failed && step.detail && <div className="merge-sub">{step.detail}</div>}

      {ask && <Ask ask={ask} onAnswer={onAnswer} />}

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

/**
 * The premise interview's current question, inline in the checklist.
 *
 * Two shapes, because the two kinds of question want opposite defaults. A
 * question with options is a pick: the chips are numbered and 1-9 answer it
 * outright, which is the whole reason the model was asked to offer options at
 * all. A question without them is prose, so it opens as a focused text box.
 * `t` moves from the first to the second, for the pick whose real answer is
 * none of the four.
 *
 * `s` ends the interview. Not Escape: Escape hides the panel everywhere in the
 * app, and a key that means "hide this" in every other panel cannot mean
 * "answer nothing, forever" in this one.
 */
function Ask({
  ask,
  onAnswer
}: {
  ask: ProvisionAsk
  onAnswer: (requestId: string, text: string | null) => void
}) {
  const [typing, setTyping] = useState(!ask.options?.length)
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLDivElement>(null)

  // A new question resets the box — and takes focus, because the panel it is in
  // was opened by the same action that asked it.
  useEffect(() => {
    setTyping(!ask.options?.length)
    setText('')
    requestAnimationFrame(() => (input.current ?? box.current)?.focus({ preventScroll: true }))
  }, [ask.requestId, ask.options])

  const send = (value: string | null): void => onAnswer(ask.requestId, value)

  return (
    <div
      className="ask"
      ref={box}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && typing) {
          e.preventDefault()
          // An empty box moves past THIS question rather than ending the
          // interview — the difference between "no answer to that one" and
          // "stop asking me".
          return send(text.trim())
        }
        if (typing) return
        if (e.key === 't') {
          e.preventDefault()
          return setTyping(true)
        }
        if (e.key === 's') {
          e.preventDefault()
          return send(null)
        }
        const n = Number(e.key)
        const pick = ask.options?.[n - 1]
        if (pick) {
          e.preventDefault()
          send(pick)
        }
      }}
    >
      <div className="ask-q">
        {ask.question}
        {ask.total > 1 && (
          <span className="ask-count">
            {ask.index}/{ask.total}
          </span>
        )}
      </div>

      {!typing && (
        <div className="ask-opts">
          {ask.options?.map((o, i) => (
            <button key={o} className="merge-chip" onClick={() => send(o)}>
              {i + 1} · {o}
            </button>
          ))}
        </div>
      )}

      {typing && (
        <input
          ref={input}
          className="dialog-input"
          placeholder="one line is enough…"
          value={text}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setText(e.target.value)}
        />
      )}

      <div className="ask-acts">
        {!typing && <span className="ask-key">1-9 pick · t type</span>}
        {typing && <span className="ask-key">⏎ answer</span>}
        <button className="merge-chip" onClick={() => send(null)}>
          s skip
        </button>
      </div>
    </div>
  )
}
