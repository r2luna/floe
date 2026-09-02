import { useEffect, useRef, useState } from 'react'
import type { AgentEventEnvelope, SetupStep, SetupStepId } from '../../shared/types'
import { afterTurn, initialSteps, onTurnError, onTurnStart, patchStep, skipRest } from './setupSteps'

/**
 * A project's command setup, in flight.
 *
 * Keyed by project root like the merge and the removal, and for the same
 * reason: the agent carries on reading the repo while you are somewhere else,
 * and a checklist that vanished when you switched project would leave it
 * unobservable (D5).
 */
export interface SetupFlow {
  root: string
  /** The background session running `/setup-commands`. */
  sessionId?: string
  /** The id the CLI gave that session — the other name its events arrive under. */
  claudeId?: string
  steps: SetupStep[]
  /** How many commands the project had when the turn started. */
  count: number
  done: boolean
  cancelled: boolean
}

export interface ProjectSetup {
  /** The flow belonging to the open project, or null. */
  flow: SetupFlow | null
  /** Begin a setup. Returns why it refused, or null when it started. */
  start: (root?: string) => string | null
  /** Re-run the step that failed. */
  retry: () => void
  /** Drop the flow. The session it opened stays where it is. */
  cancel: () => void
  /** Put the setup session's chat on screen — the `choose` step's chip (D1). */
  openChat: () => void
}

/** The token turn.ts expands into the built-in skill on send. */
const SETUP_PROMPT = '/setup-commands'

/**
 * The guided project setup: does this project need commands, and if so, let the
 * agent work them out.
 *
 * The chain is short because most of the work is not ours — the
 * `setup-commands` skill reads the repo, asks, and registers. What this owns is
 * the checklist over it: whether to start at all (D2), a background session
 * with no one to answer permission prompts (D4), and the one transition rule —
 * a turn ended, so count the commands.
 */
export function useProjectSetup(deps: {
  /** The open project. Which flow the panel shows follows it. */
  root?: string
  /** Bring the setup panel up. Called when a flow starts. */
  show: () => void
  /** Open the setup session's chat — where the agent's question is answered. */
  openChat: (session: { id: string; worktreePath: string }) => void
}): ProjectSetup {
  const { root, show, openChat: openChatPanel } = deps

  const [flows, setFlows] = useState<Record<string, SetupFlow>>({})
  const flowsRef = useRef(flows)
  flowsRef.current = flows

  const flow = root ? (flows[root] ?? null) : null

  /**
   * Whether the chain for `target` should stop where it is.
   *
   * A MISSING flow counts, not just a cancelled one: `cancel` drops the flow to
   * take the panel down with it, so a guard that only asked `flow.cancelled`
   * read `undefined` and carried on — which meant pressing stop during
   * preflight still opened a session and let the agent write commands.toml.
   * Nobody is watching a flow that is not there; that is reason enough to stop.
   */
  const stopped = (target: string): boolean => {
    const f = flowsRef.current[target]
    return !f || f.cancelled
  }

  /**
   * Write to ONE project's flow, named at the call site.
   *
   * Deliberately not a pinned "current" ref: this chain waits on
   * `commands.list`, on a session being created, and then on whole agent turns,
   * and the user is free to switch project — or start a second setup — in any
   * of those gaps. A shared pointer would let A's continuation land in B's
   * checklist, which is how one project ends up wearing another's session.
   * Every step already knows the root it is running for, so it says so.
   */
  function patchFlow(
    target: string,
    arg: SetupFlow | null | ((f: SetupFlow | null) => SetupFlow | null)
  ): void {
    setFlows((all) => {
      const cur = all[target] ?? null
      const next = typeof arg === 'function' ? arg(cur) : arg
      const copy = { ...all }
      if (next) copy[target] = next
      else delete copy[target]
      return copy
    })
  }

  function step(target: string, id: SetupStepId, patch: Partial<SetupStep>): void {
    patchFlow(target, (f) => (f ? { ...f, steps: patchStep(f.steps, id, patch) } : f))
  }

  /**
   * Stop this flow's turn.
   *
   * By the id the session was SPAWNED under, never the CLI's `claudeId`:
   * `stopAgent` in main is a plain `conns.get(key)` with no alias resolution
   * (unlike `sessionNames`), and the conn is filed under whatever key
   * `agent.start` was called with. Ours is always `sessionId`, so asking by any
   * other name is a stop that silently does nothing.
   */
  function stopSession(sessionId: string): void {
    void window.floe.agent.stop(sessionId).catch(() => {})
  }

  /** The project's commands right now, by name. */
  async function commandNames(target: string): Promise<string[]> {
    // A project root is its own main worktree, so it is both arguments — the
    // flow runs before any worktree of this project has been opened.
    const list = await window.floe.commands.list(target, target)
    return list.map((c) => c.name)
  }

  // --- the chain -----------------------------------------------------------

  /**
   * Does this project already have commands?
   *
   * `commands.list` has answered the question the whole flow exists to ask, so
   * a project with rows ends here rather than spending a session's tokens
   * rediscovering them (D2).
   */
  async function runPreflight(target: string): Promise<void> {
    let names: string[]
    try {
      names = await commandNames(target)
    } catch (e) {
      step(target, 'preflight', { status: 'error', detail: e instanceof Error ? e.message : String(e) })
      return
    }
    if (stopped(target)) return
    if (names.length) {
      patchFlow(target, (f) =>
        // "registered", not "already": listing a project's commands is what
        // seeds a Laravel one with its defaults (main's seedDefaults), so this
        // step sometimes reports rows it created a moment ago. Ending the flow
        // is right either way — what it must not do is claim they predate it.
        f ? { ...f, steps: skipRest(f.steps, `all set — ${names.length} registered`), done: true } : f
      )
      finish(target)
      return
    }
    step(target, 'preflight', { status: 'done', detail: 'none yet' })
    await runSession(target)
  }

  /**
   * Open the session and hand it the skill token.
   *
   * `skip` because nothing is watching: with no chat on screen a permission
   * prompt has no one to answer it and the turn would hang with `discover`
   * running forever (D4). The skill only reads the repo and writes through
   * `add_project_command`.
   */
  async function runSession(target: string): Promise<void> {
    if (stopped(target)) return
    // A retry opens a NEW session (there is nothing in a failed one to resume),
    // so the one it replaces has to go first — two setup sessions on one
    // project would both be writing the same commands.toml, and the checklist
    // only ever follows the newer of them.
    const stale = flowsRef.current[target]?.sessionId
    if (stale) stopSession(stale)
    step(target, 'session', { status: 'running', detail: undefined })
    const id = crypto.randomUUID()
    try {
      await window.floe.claude.createSession({
        id,
        worktreePath: target,
        title: 'Set up commands'
      })
    } catch (e) {
      step(target, 'session', { status: 'error', detail: e instanceof Error ? e.message : String(e) })
      return
    }
    if (stopped(target)) return
    patchFlow(target, (f) =>
      f
        ? {
            ...f,
            sessionId: id,
            steps: patchStep(
              patchStep(f.steps, 'session', { status: 'done', detail: undefined }),
              'discover',
              { status: 'running', detail: undefined }
            )
          }
        : f
    )
    if (stopped(target)) return
    void window.floe.agent
      .start(id, target, SETUP_PROMPT, { permissionMode: 'skip' })
      .catch((e: Error) => step(target, 'discover', { status: 'error', detail: e.message }))
  }

  // The all-green checklist lingers, then goes. Named rather than pinned, so
  // the timer clears the flow it was started for whatever the user is looking
  // at when it fires.
  function finish(target: string): void {
    patchFlow(target, (f) => (f ? { ...f, done: true } : f))
    setTimeout(() => {
      setFlows((all) => {
        if (!all[target]?.done) return all
        const copy = { ...all }
        delete copy[target]
        return copy
      })
    }, 2600)
  }

  // --- the session's turns -------------------------------------------------

  /**
   * Follow every flow's session, not just the open project's: the setup whose
   * project you switched away from still has to finish (D5).
   *
   * One listener for all of them, keyed by the ids each session answers to —
   * Floe's own and the one the CLI stamps on it once it starts.
   */
  useEffect(() => {
    return window.floe.agent.onEvent((payload: AgentEventEnvelope) => {
      const { key, event } = payload
      const target = Object.values(flowsRef.current).find(
        (f) => !f.done && !f.cancelled && (f.sessionId === key || f.claudeId === key)
      )
      if (!target) return

      if (event.kind === 'session') {
        // The CLI's own id for the session: later events arrive under it, so a
        // flow that only knew its own key would go deaf mid-turn.
        const claudeId = event.sessionId
        setFlows((all) =>
          all[target.root] ? { ...all, [target.root]: { ...all[target.root], claudeId } } : all
        )
        return
      }

      if (event.kind === 'turn') {
        setFlows((all) => {
          const f = all[target.root]
          return f ? { ...all, [target.root]: { ...f, steps: onTurnStart(f.steps) } } : all
        })
        return
      }

      if (event.kind === 'error') {
        setFlows((all) => {
          const f = all[target.root]
          if (!f) return all
          return { ...all, [target.root]: { ...f, steps: onTurnError(f.steps, event.message) } }
        })
        return
      }

      // The one rule: a turn ended, so count the commands.
      if (event.kind === 'done') void settleTurn(target.root)
    })
  }, [])

  async function settleTurn(target: string): Promise<void> {
    let names: string[]
    try {
      names = await commandNames(target)
    } catch {
      // The count is the only thing this transition reads; a failed read is
      // worth nothing to report and the next turn asks again.
      return
    }
    // The transition is computed HERE, not inside the setter and not read back
    // from `flowsRef` afterwards. Reading back was the bug: that ref is assigned
    // during render, so straight after a setFlows it still holds the previous
    // map — the finished flow read as unfinished and its checklist never
    // cleared itself. Computing it inside the setter would answer that, but by
    // writing to a variable from an updater React is free to run twice.
    const before = flowsRef.current[target]
    if (!before || before.done || before.cancelled) return
    const { steps, done } = afterTurn(before.steps, {
      added: names.length - before.count,
      names
    })
    // The guard is repeated in the setter because this is where the write
    // actually lands: a cancel between the two would otherwise be overwritten.
    setFlows((all) => {
      const f = all[target]
      if (!f || f.done || f.cancelled) return all
      return { ...all, [target]: { ...f, steps, done } }
    })
    if (done) finish(target)
  }

  // --- entry points --------------------------------------------------------

  /**
   * Start a setup for `at`, or for the open project.
   *
   * Takes the root explicitly because the flow's first caller is the add — and
   * at that moment the project list has not reloaded yet, so `root` is still
   * whatever was open before.
   */
  function start(at?: string): string | null {
    const target = at ?? root
    if (!target) return 'no project open'
    const existing = flowsRef.current[target]
    if (existing && !existing.done) {
      // Already running: show it rather than opening a second session over the
      // same repository.
      show()
      return null
    }
    const steps = patchStep(initialSteps(), 'preflight', { status: 'running' })
    patchFlow(target, { root: target, steps, count: 0, done: false, cancelled: false })
    show()
    void runPreflight(target)
    return null
  }

  function retry(): void {
    if (!root) return
    const f = flowsRef.current[root]
    if (!f) return
    const errored = f.steps.find((s) => s.status === 'error')
    if (!errored) return
    step(f.root, errored.id, { status: 'running', detail: undefined })
    // Everything after preflight needs a session; a failed one is re-opened
    // rather than resumed, since nothing of it survived to resume.
    if (errored.id === 'preflight') void runPreflight(f.root)
    else void runSession(f.root)
  }

  /**
   * Stop the setup.
   *
   * The panel says "stop", so it stops the agent too, not just the checklist:
   * the turn in flight is the thing writing to commands.toml, and dropping the
   * panel while it carried on registering would be the opposite of what the key
   * says. What it already wrote stays — this is a stop, not an undo.
   */
  function cancel(): void {
    if (!root) return
    const f = flowsRef.current[root]
    // Marked cancelled first so a step already in flight drops its result
    // instead of writing into a flow the user has dismissed.
    patchFlow(root, (fl) => (fl ? { ...fl, cancelled: true } : fl))
    patchFlow(root, null)
    if (f?.sessionId) stopSession(f.sessionId)
  }

  /** The `choose` chip: the question is in the chat, so this opens it (D1). */
  function openChat(): void {
    const f = root ? flowsRef.current[root] : null
    if (!f?.sessionId) return
    openChatPanel({ id: f.claudeId ?? f.sessionId, worktreePath: f.root })
  }

  return { flow, start, retry, cancel, openChat }
}
