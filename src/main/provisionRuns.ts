// Which worktrees are being provisioned right now, and how to stop one.
//
// Its own module because both sides need it and neither may import the other:
// provision.ts registers a run and its child processes, and git.ts cancels the
// run before it removes the tree. Without the cancel, an install still writing
// `vendor/` or `node_modules/` makes `git worktree remove` leave a folder
// behind, and the next worktree cut at that path fails as "already exists".

import type { ChildProcess } from 'node:child_process'

interface Run {
  controller: AbortController
  children: Set<ChildProcess>
  done: Promise<void>
  end: () => void
}

const runs = new Map<string, Run>()

/**
 * Start tracking a provisioning run. Call the returned `end` when it finishes,
 * whichever way — it is what a cancel is waiting for.
 *
 * A second run for the same tree replaces the first, which is cancelled: two
 * installs in one tree is never what anybody wanted.
 */
export function beginProvision(worktreePath: string): { signal: AbortSignal; end: () => void } {
  const previous = runs.get(worktreePath)
  if (previous) abort(previous)
  let resolve: () => void = () => undefined
  const done = new Promise<void>((r) => (resolve = r))
  const run: Run = {
    controller: new AbortController(),
    children: new Set(),
    done,
    end: () => {
      if (runs.get(worktreePath) === run) runs.delete(worktreePath)
      resolve()
    }
  }
  runs.set(worktreePath, run)
  return { signal: run.controller.signal, end: run.end }
}

/** The run whose tree contains `cwd`, if any. Steps run in the tree or below it. */
function runFor(cwd: string): Run | undefined {
  for (const [path, run] of runs) if (cwd === path || cwd.startsWith(`${path}/`)) return run
  return undefined
}

/**
 * Tie a spawned step to the run of the tree it runs in, so a cancel kills it.
 * A process spawned outside any run is left alone.
 */
export function trackChild(cwd: string, child: ChildProcess): void {
  const run = runFor(cwd)
  if (!run) return
  run.children.add(child)
  child.once('exit', () => run.children.delete(child))
  if (run.controller.signal.aborted) kill(child)
}

/** Whether the run for this tree has been cancelled. */
export function provisionCancelled(worktreePath: string): boolean {
  return runs.get(worktreePath)?.controller.signal.aborted ?? false
}

function kill(child: ChildProcess): void {
  if (!child.pid) return
  try {
    // The whole group where there is one: the step is a login shell, and the
    // install it started is its child, not the shell itself.
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM')
    else child.kill('SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
}

function abort(run: Run): void {
  run.controller.abort()
  for (const child of run.children) kill(child)
}

/**
 * Stop the provisioning of a tree and wait for it to wind down, bounded. A tree
 * with no run is a no-op.
 */
export async function cancelProvision(worktreePath: string, timeoutMs = 10_000): Promise<void> {
  const run = runs.get(worktreePath)
  if (!run) return
  abort(run)
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([run.done, new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))])
  if (timer) clearTimeout(timer)
}
