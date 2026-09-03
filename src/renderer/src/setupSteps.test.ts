import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  afterTurn,
  initialSteps,
  onTurnError,
  onTurnStart,
  patchStep,
  registered,
  skipRest
} from './setupSteps.ts'
import type { SetupStep, SetupStepId } from '../../shared/types.ts'

const statusOf = (steps: SetupStep[], id: SetupStepId): string =>
  steps.find((s) => s.id === id)?.status ?? 'missing'

const detailOf = (steps: SetupStep[], id: SetupStepId): string | undefined =>
  steps.find((s) => s.id === id)?.detail

/** The checklist as it is once the session's first turn is under way. */
function discovering(): SetupStep[] {
  return patchStep(
    patchStep(patchStep(initialSteps(), 'preflight', { status: 'done' }), 'session', {
      status: 'done'
    }),
    'discover',
    { status: 'running' }
  )
}

test('a fresh checklist is five pending steps in order', () => {
  const steps = initialSteps()
  assert.deepEqual(
    steps.map((s) => s.id),
    ['preflight', 'session', 'discover', 'choose', 'register']
  )
  assert.ok(steps.every((s) => s.status === 'pending'))
})

// D2: commands.list has already answered the question the flow exists to ask,
// so a project that has them ends here rather than spending a session on it.
test('a project that already has commands skips the rest', () => {
  const steps = skipRest(initialSteps(), 'all set — 3 registered')
  assert.equal(statusOf(steps, 'preflight'), 'done')
  assert.equal(detailOf(steps, 'preflight'), 'all set — 3 registered')
  for (const id of ['session', 'discover', 'choose', 'register'] as SetupStepId[])
    assert.equal(statusOf(steps, id), 'skipped', `${id} should be skipped, not left pending`)
})

// The one transition rule, both ways.
test('a turn that registered commands closes the flow', () => {
  const { steps, done } = afterTurn(discovering(), {
    added: 3,
    names: ['Dev', 'Queue', 'Scheduler']
  })
  assert.equal(done, true)
  assert.equal(statusOf(steps, 'discover'), 'done')
  assert.equal(statusOf(steps, 'choose'), 'done')
  assert.equal(statusOf(steps, 'register'), 'done')
  assert.equal(detailOf(steps, 'register'), 'saved 3: Dev, Queue, Scheduler')
})

test('a turn that registered nothing blocks on the user instead', () => {
  const { steps, done } = afterTurn(discovering(), { added: 0, names: [] })
  assert.equal(done, false, 'the panel keeps listening to the turns after this one')
  assert.equal(statusOf(steps, 'discover'), 'done')
  assert.equal(statusOf(steps, 'choose'), 'blocked')
  assert.equal(statusOf(steps, 'register'), 'pending')
})

test('the count is what decides, not whether the project has commands at all', () => {
  // A project that already had one and gained none is still waiting: counting
  // the list rather than the delta would call this finished.
  const { done, steps } = afterTurn(discovering(), { added: 0, names: ['Dev'] })
  assert.equal(done, false)
  assert.equal(statusOf(steps, 'choose'), 'blocked')
})

test('answering unblocks choose when the next turn starts', () => {
  const blocked = afterTurn(discovering(), { added: 0, names: [] }).steps
  const next = onTurnStart(blocked)
  assert.equal(statusOf(next, 'choose'), 'done')
  assert.equal(statusOf(next, 'register'), 'running')
})

test('a turn starting on a checklist nobody is blocking changes nothing', () => {
  const steps = discovering()
  assert.equal(onTurnStart(steps), steps)
})

test('a blocked choose closes on the turn that finally registers', () => {
  const blocked = afterTurn(discovering(), { added: 0, names: [] }).steps
  const answering = onTurnStart(blocked)
  const { steps, done } = afterTurn(answering, { added: 2, names: ['Dev', 'Queue'] })
  assert.equal(done, true)
  assert.equal(statusOf(steps, 'register'), 'done')
  assert.equal(detailOf(steps, 'register'), 'saved 2: Dev, Queue')
})

test('the register step names what it saved', () => {
  assert.equal(registered(['Dev']), 'saved 1: Dev')
})

test('a failed turn lands on the step that was running', () => {
  const steps = onTurnError(discovering(), 'the CLI died')
  assert.equal(statusOf(steps, 'discover'), 'error')
  assert.equal(detailOf(steps, 'discover'), 'the CLI died')
})

// Blocked is not failed: `r try again` opens a NEW session, so painting the
// waiting step red would offer to throw away the chat holding the question.
test('a failed turn while waiting on you keeps the step blocked', () => {
  const blocked = afterTurn(discovering(), { added: 0, names: [] }).steps
  const steps = onTurnError(blocked, 'the CLI died')
  assert.equal(statusOf(steps, 'choose'), 'blocked')
  assert.match(detailOf(steps, 'choose') ?? '', /the CLI died — answer in the chat/)
})

test('a failure with nothing in flight changes nothing', () => {
  const settled = afterTurn(discovering(), { added: 1, names: ['Dev'] }).steps
  assert.equal(onTurnError(settled, 'late error'), settled)
})
