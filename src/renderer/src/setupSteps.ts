import type { SetupStep, SetupStepId } from '../../shared/types'

/**
 * The setup checklist's transitions, as plain functions over the step list.
 *
 * Here rather than inside the hook because there is exactly one rule worth
 * getting right — **end of turn → count the commands** — and it is the one thing
 * in this flow with no IPC in it. A test can state the rule directly; a test
 * that had to drive a session to reach it would be testing the harness.
 */

export const SETUP_STEP_IDS: SetupStepId[] = [
  'preflight',
  'session',
  'discover',
  'choose',
  'register'
]

/**
 * What each step says while you watch it.
 *
 * Written as what is happening to YOUR project rather than as the mechanism —
 * "Reading your project" is the same step as "agent.onEvent is running", and
 * only one of them is a sentence anybody wants to read while they wait.
 */
export const SETUP_STEP_TITLES: Record<SetupStepId, string> = {
  preflight: 'Looking for commands',
  session: 'Getting a helper ready',
  discover: 'Reading your project',
  choose: 'Your turn to pick',
  register: 'Saving your commands'
}

/** A fresh checklist, everything pending. */
export function initialSteps(): SetupStep[] {
  return SETUP_STEP_IDS.map((id) => ({ id, title: SETUP_STEP_TITLES[id], status: 'pending' }))
}

export function patchStep(steps: SetupStep[], id: SetupStepId, patch: Partial<SetupStep>): SetupStep[] {
  return steps.map((s) => (s.id === id ? { ...s, ...patch } : s))
}

/**
 * The project already has commands, so there is nothing to set up.
 *
 * `preflight` answers the question it asked and the rest are skipped rather
 * than left pending: a checklist frozen on "pending" reads as a flow that
 * stalled, and this one finished — it just had nothing to do. See D2.
 */
export function skipRest(steps: SetupStep[], detail: string): SetupStep[] {
  return steps.map((s) =>
    s.id === 'preflight'
      ? { ...s, status: 'done', detail }
      : { ...s, status: 'skipped', detail: undefined }
  )
}

/** `Saved 3: Dev, Queue, Scheduler` — what the register step reports. */
export function registered(names: string[]): string {
  return `saved ${names.length}: ${names.join(', ')}`
}

/**
 * A turn ended. Count the commands: that is the whole state machine.
 *
 * More than before means the agent registered the picks and the flow is done.
 * The same number means it is waiting on the `present_decision` it raised — the
 * only thing a finished turn with no new command can mean — so `choose` blocks
 * and the panel keeps listening to the turns after this one.
 */
export function afterTurn(
  steps: SetupStep[],
  opts: { added: number; names: string[] }
): { steps: SetupStep[]; done: boolean } {
  const discovered = patchStep(steps, 'discover', { status: 'done', detail: undefined })
  if (opts.added <= 0) {
    return {
      steps: patchStep(discovered, 'choose', {
        status: 'blocked',
        detail: 'The agent found some candidates and is waiting on you'
      }),
      done: false
    }
  }
  const chosen = patchStep(discovered, 'choose', { status: 'done', detail: undefined })
  return {
    steps: patchStep(chosen, 'register', { status: 'done', detail: registered(opts.names) }),
    done: true
  }
}

/**
 * A turn failed.
 *
 * The step that is RUNNING takes the failure. A step that is merely blocked
 * does not: `choose` blocked means the agent asked and the chat is holding the
 * question, and painting that red would offer `r try again` — which opens a
 * brand-new session and throws away the very conversation the answer belongs
 * in. So a failure while blocked is reported ON the block, and `⏎ open chat`
 * stays the thing to do.
 */
export function onTurnError(steps: SetupStep[], message: string): SetupStep[] {
  const running = steps.find((s) => s.status === 'running')
  if (running) return patchStep(steps, running.id, { status: 'error', detail: message })
  const blocked = steps.find((s) => s.status === 'blocked')
  if (!blocked) return steps
  return patchStep(steps, blocked.id, { detail: `${message} — answer in the chat` })
}

/**
 * A turn started. Only says something when the checklist was blocked on the
 * user: answering in the chat is what unblocks `choose`, and the panel has no
 * other way to see that it happened.
 */
export function onTurnStart(steps: SetupStep[]): SetupStep[] {
  const choose = steps.find((s) => s.id === 'choose')
  if (choose?.status !== 'blocked') return steps
  const answered = patchStep(steps, 'choose', { status: 'done', detail: 'thanks' })
  return patchStep(answered, 'register', { status: 'running', detail: undefined })
}
