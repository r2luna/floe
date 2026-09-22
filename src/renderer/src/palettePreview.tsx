import { useEffect, useState, type ReactNode } from 'react'
import type { Project, Worktree } from '../../shared/types'

/**
 * The palette's right-hand pane, and the add dialog's: the row under the cursor
 * explained, as a short column of facts.
 *
 * One vocabulary for all of them — a dim label, a value, and a last line for
 * what is about to happen — so moving between "switch project", "find a file"
 * and "add project" never means learning a second way to read the pane.
 */
export function Facts({ children }: { children: ReactNode }) {
  return <div className="palette-facts">{children}</div>
}

export function Fact({
  label,
  tone,
  children
}: {
  label: string
  /** `ok` for a fact that is settled, `warn` for one that is about to change. */
  tone?: 'ok' | 'warn'
  children: ReactNode
}) {
  return (
    <div className="palette-fact">
      <b>{label}</b>
      <span data-tone={tone}>{children}</span>
    </div>
  )
}

/** The pane's title — what the facts under it are about. */
export function PaneTitle({ children }: { children: ReactNode }) {
  return <h4 className="palette-pane-title">{children}</h4>
}

/** The closing line: a note about the row rather than another fact of it. */
export function PaneNote({ children }: { children: ReactNode }) {
  return <div className="palette-pane-note">{children}</div>
}

/** `/Users/me/code/floe` reads as `~/code/floe` — the way anyone would say it. */
export function tilde(path: string): string {
  const home = window.floe?.homeDir
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

/**
 * A project, before you switch to it: where it lives, whose machine it is on,
 * and how many worktrees are waiting.
 *
 * The worktrees are fetched per highlight and cached, because arrowing down a
 * list of twenty projects must not mean twenty `git worktree list` runs every
 * time you pass over them. A project on another machine is not fetched at all:
 * the call would run against THIS disk and answer for the wrong repo.
 */
export function ProjectPreview({ project, machine }: { project: Project; machine?: string }) {
  const trees = useWorktrees(project)
  return (
    <>
      <PaneTitle>{project.name}</PaneTitle>
      <Facts>
        <Fact label="path">{tilde(project.path)}</Fact>
        {machine && <Fact label="machine">{machine}</Fact>}
        <Fact label="group">{project.home ? 'home' : project.group}</Fact>
        {trees && trees.length > 0 && (
          <Fact label="worktrees">
            {trees.length} · {trees.map((w) => w.branch).slice(0, 3).join(', ')}
          </Fact>
        )}
      </Facts>
      {project.home && <PaneNote>The home workspace — a terminal, no git chrome.</PaneNote>}
    </>
  )
}

const treeCache = new Map<string, Worktree[]>()

function useWorktrees(project: Project): Worktree[] | null {
  const [trees, setTrees] = useState<Worktree[] | null>(treeCache.get(project.path) ?? null)
  useEffect(() => {
    setTrees(treeCache.get(project.path) ?? null)
    // Remote projects and the home workspace have nothing to list here.
    const remote = project.backend && project.backend !== window.floe.backends?.current()
    if (project.home || remote || treeCache.has(project.path)) return
    let live = true
    void window.floe.worktrees
      .list(project.path)
      .then((list) => {
        treeCache.set(project.path, list)
        if (live) setTrees(list)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [project.path, project.home, project.backend])
  return trees
}

/**
 * A file, before you open it: its head, which is the part that tells you
 * whether it is the file you meant. Text only — an image or a PDF says what it
 * is, because a data URL rendered as words is noise.
 */
export function FilePreview({ root, path }: { root: string; path: string }) {
  const [head, setHead] = useState<{ text: string; lines: number } | string | null>(null)
  useEffect(() => {
    setHead(null)
    let live = true
    void window.floe.files
      .read(root, path)
      .then((content) => {
        if (!live) return
        if (content.kind !== 'text') return setHead(content.kind)
        const all = content.text.split('\n')
        setHead({ text: all.slice(0, 14).join('\n'), lines: all.length })
      })
      .catch(() => live && setHead('unreadable'))
    return () => {
      live = false
    }
  }, [root, path])

  const name = path.slice(path.lastIndexOf('/') + 1)
  return (
    <>
      <PaneTitle>{name}</PaneTitle>
      {typeof head === 'string' ? (
        <Facts>
          <Fact label="kind">{head}</Fact>
        </Facts>
      ) : (
        head && (
          <>
            <pre className="palette-code">{head.text}</pre>
            <PaneNote>
              {head.lines} {head.lines === 1 ? 'line' : 'lines'} · {tilde(`${root}/${path}`)}
            </PaneNote>
          </>
        )
      )}
    </>
  )
}

/**
 * A chat, before you jump to it: which branch it is on, whether a turn is in
 * flight, and what it was last set to run as.
 *
 * Facts only — no transcript. Reading the tail of a session means opening its
 * JSONL, and arrowing down a list of chats would open one per row; the facts
 * come from the list that was already fetched, so the pane costs nothing.
 */
export function SessionPreview({
  title,
  project,
  branch,
  worktree,
  at,
  running,
  model,
  mode
}: {
  title: string
  /** Which repo it belongs to — the list spans every project, so the pane says. */
  project?: string
  branch: string
  worktree: string
  /** When the session was last written to — epoch ms. */
  at: string
  running?: boolean
  model?: string
  mode?: string
}) {
  return (
    <>
      <PaneTitle>{title}</PaneTitle>
      <Facts>
        {project && <Fact label="project">{project}</Fact>}
        <Fact label="branch">{branch}</Fact>
        <Fact label="worktree">{tilde(worktree)}</Fact>
        <Fact label="state" tone={running ? 'warn' : 'ok'}>
          {running ? `working · ${at}` : `idle · ${at}`}
        </Fact>
        {model && <Fact label="model">{model}</Fact>}
        {mode && <Fact label="mode">{mode}</Fact>}
      </Facts>
      <PaneNote>⏎ opens it in the lane, on the worktree it belongs to.</PaneNote>
    </>
  )
}

/**
 * A command, before you run it: which group it belongs to, what will fire it,
 * and — the reason this pane exists — why it is refusing right now. A dimmed
 * row can only say "no"; this says which condition is missing.
 */
export function CommandPreview({
  title,
  group,
  keys,
  unavailable
}: {
  title: string
  group: string
  keys?: string
  unavailable?: string
}) {
  return (
    <>
      <PaneTitle>{title}</PaneTitle>
      <Facts>
        <Fact label="group">{group}</Fact>
        <Fact label="key">{keys || 'not bound'}</Fact>
        <Fact label="runs" tone={unavailable ? 'warn' : 'ok'}>
          {unavailable ?? 'now'}
        </Fact>
      </Facts>
      <PaneNote>⌘⏎ records a new binding for it.</PaneNote>
    </>
  )
}
