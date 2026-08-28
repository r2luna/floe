import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
// REAL component, REAL CSS, REAL projection — only the data source (the live
// tasks.md poll) is scripted here to play out what ds-implement produces.
import { PipelineTrilho } from '../src/renderer/src/components/Sidebar'
import { toSidebarPipeline } from '../src/renderer/src/workflow/sidebarPipeline'
import { PIPELINE_STEPS } from '../src/renderer/src/workflow/Pipeline'
import type { RunnerState, StepStatus, PipelineStatus } from '../src/renderer/src/workflow/runner'
import type { ImplementPhase } from '../src/shared/types'
import '../src/renderer/src/index.css'

const PHASE_TITLES = [
  'Setup (Shared Schema & Model)',
  'User Story 1 — Offboard a user (P1)',
  'Polish & Cross-Cutting'
] as const
const TOTALS = [2, 3, 4] as const

// The scripted timeline: how many task boxes are ticked in each phase at each
// step, mirroring ds-implement landing one commit at a time. The last frame
// settles the whole pipeline.
const DONE_BY_STEP: number[][] = [
  [0, 0, 0],
  [1, 0, 0],
  [2, 0, 0],
  [2, 1, 0],
  [2, 2, 0],
  [2, 3, 0],
  [2, 3, 1],
  [2, 3, 2],
  [2, 3, 3],
  [2, 3, 4]
]

function runnerAt(implementStatus: StepStatus, pipelineStatus: PipelineStatus): RunnerState {
  const n = PIPELINE_STEPS.length
  return {
    steps: PIPELINE_STEPS,
    input: 'DOS-211 offboard a user',
    index: n - 1,
    phase: 'active',
    statuses: PIPELINE_STEPS.map((_, i) => (i < n - 1 ? 'done' : implementStatus)),
    status: pipelineStatus
  }
}

function App(): JSX.Element {
  const [step, setStep] = useState(0)
  useEffect(() => {
    if (step >= DONE_BY_STEP.length - 1) return
    const id = setTimeout(() => setStep((s) => s + 1), 750)
    return () => clearTimeout(id)
  }, [step])

  const done = DONE_BY_STEP[step]
  const finished = step >= DONE_BY_STEP.length - 1
  const phases: ImplementPhase[] = PHASE_TITLES.map((title, i) => ({
    title,
    done: done[i],
    total: TOTALS[i]
  }))
  const state = finished ? runnerAt('done', 'done') : runnerAt('running', 'running')
  const pipeline = toSidebarPipeline(state, phases)

  return (
    <div className="proof-shell">
      <div className="proof-session">
        <span className="proof-session__dot" />
        <span className="proof-session__title">feat/DOS-211 · offboard a user</span>
      </div>
      {pipeline && <PipelineTrilho pipeline={pipeline} />}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
