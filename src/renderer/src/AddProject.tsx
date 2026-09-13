import { useEffect, useRef, useState } from 'react'
import type { BackendInfo } from '../../preload/api'
import { DEFAULT_GROUP, type PathProbe } from '../../shared/types'
import { Fact, Facts, PaneNote, PaneTitle, tilde } from './palettePreview'

/**
 * One dialog for the whole "add a project" question: which machine, which
 * group, which repo. Asking all three at once beats a chain of prompts that
 * each reveal only the next thing they want.
 *
 * It is the palette's box, not a dialog of its own: the head is where you type
 * the path, the answers it still needs are rows under it, and the right pane
 * checks the path while you type — is it a repo, on which branch, is it already
 * added. Switching a project and adding one are then the same surface in two
 * states, which matters because ⌘K is how you get here.
 *
 * Keyboard-first throughout: the path takes focus on open, ↓ walks into the
 * answers and ⏎ picks one (landing you back on the path), ⏎ on the path adds,
 * ⌘O browses, Esc backs out one level at a time.
 */
export function AddProject({
  backends,
  current,
  groups,
  group,
  onBrowse,
  onAdd,
  onClose
}: {
  backends: BackendInfo[]
  /** The machine the window is attached to — where the dialog starts. */
  current: string
  groups: string[]
  /** The group to preselect — the one you were looking at. */
  group?: string
  /** Native folder picker. Absent in the web build, which has no local disk. */
  onBrowse: ((group: string) => void) | null
  onAdd: (backend: string, path: string, group: string) => void
  onClose: () => void
}) {
  // Where you already are, not the first row: attached to another machine,
  // "Add project" means one there far more often than one back home.
  const [backend, setBackend] = useState(
    backends.some((b) => b.id === current) ? current : (backends[0]?.id ?? 'local')
  )
  const [path, setPath] = useState('')
  const [picked, setPicked] = useState(group || groups[0] || DEFAULT_GROUP)
  // Naming a new group borrows the head rather than opening a second field:
  // there is one place you type in this box, and it is the line at the top.
  const [naming, setNaming] = useState(false)
  const [newGroup, setNewGroup] = useState('')
  // -1 is the path itself. The cursor only enters the answers when you ask it
  // to with ↓, which is what keeps ⏎ meaning "add" for the common case.
  const [at, setAt] = useState(-1)
  const input = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    requestAnimationFrame(() => input.current?.focus())
  }, [])

  useEffect(() => {
    listRef.current?.querySelector('[data-at]')?.scrollIntoView({ block: 'nearest' })
  }, [at])

  const machine = backends.find((b) => b.id === backend)
  const local = machine ? !machine.remote : true
  const probe = useProbe(naming ? '' : path, backend)

  // A group typed but never confirmed still counts — nobody expects to lose
  // what they just wrote because they hit Add instead of Enter.
  const chosenGroup = (naming && newGroup.trim()) || picked

  const rows: Answer[] = [
    // One machine is not a choice — the section would be noise.
    ...(backends.length > 1
      ? backends.map((b) => ({
          kind: 'backend' as const,
          id: b.id,
          label: b.label,
          section: 'machine',
          on: b.id === backend
        }))
      : []),
    // A group you just named belongs in the list: it does not exist on disk
    // yet, and without a row of its own the mark has nowhere to sit — the
    // section would read as "no group chosen" right after you chose one.
    ...[...groups, ...(groups.includes(picked) ? [] : [picked])].map((g) => ({
      kind: 'group' as const,
      id: g,
      label: g,
      section: 'group',
      on: !naming && g === picked
    })),
    { kind: 'newGroup' as const, id: NEW, label: 'New group…', section: 'group', on: naming },
    // A row rather than a button beside the field: everything you can do in
    // this box is a row, and a picker hidden behind ⌘O alone would be a mouse
    // action with no home.
    ...(local && onBrowse
      ? [{ kind: 'browse' as const, id: 'browse', label: 'Browse…', section: 'path', on: false }]
      : [])
  ]

  const commit = () => {
    const p = path.trim()
    if (p) onAdd(backend, p, chosenGroup)
  }

  const pick = (row: Answer) => {
    if (row.kind === 'backend') setBackend(row.id)
    if (row.kind === 'group') {
      setPicked(row.id)
      setNaming(false)
      setNewGroup('')
    }
    if (row.kind === 'newGroup') {
      setNaming(true)
      setNewGroup('')
    }
    if (row.kind === 'browse') return onBrowse?.(chosenGroup)
    // Back to the path, so the next ⏎ adds rather than picking again.
    setAt(-1)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Claimed, not only prevented: closing hands focus back to the lane while
    // this press is still travelling to the window, where the app's keymap
    // would read it again against the element that just got focus. Same rule
    // as Palette.
    const claim = (): void => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (e.key === 'Escape') {
      claim()
      // One level at a time: out of the group name, then out of the answers,
      // then out of the dialog.
      if (naming) {
        setNaming(false)
        setNewGroup('')
        return
      }
      if (at >= 0) return setAt(-1)
      return onClose()
    }
    if (e.key === 'Enter') {
      claim()
      // Naming: ⏎ settles the name and hands the head back to the path.
      if (naming) {
        if (!newGroup.trim()) return
        setPicked(newGroup.trim())
        setNaming(false)
        return
      }
      if (at >= 0 && rows[at]) return pick(rows[at])
      return commit()
    }
    // ⌘O is the picker, from anywhere in the box.
    if (e.key.toLowerCase() === 'o' && e.metaKey && local && onBrowse) {
      claim()
      return onBrowse(chosenGroup)
    }
    const down = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')
    const up = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')
    if (!down && !up) return
    claim()
    if (!rows.length) return
    // Stops at both ends rather than wrapping: the top of this list is the path
    // you are typing, and wrapping past it would take the caret somewhere you
    // did not ask to go.
    setAt((i) => Math.min(rows.length - 1, Math.max(-1, i + (down ? 1 : -1))))
  }

  const foot = naming
    ? '⏎ name the group · esc back'
    : at >= 0
      ? '⏎ pick · ↑↓ move · esc back to the path'
      : `⏎ add · ↓ machine & group${local && onBrowse ? ' · ⌘O browse' : ''} · esc cancel`

  let section = ''
  return (
    <div className="palette-scrim" onPointerDown={onClose}>
      <div className="palette" data-wide onPointerDown={(e) => e.stopPropagation()}>
        <div className="palette-head">
          <span className="palette-sigil">＋</span>
          <input
            ref={input}
            className="palette-input"
            placeholder={
              naming
                ? 'Group name…'
                : `Path to a git repo on ${machine?.label ?? 'this machine'}…`
            }
            value={naming ? newGroup : path}
            spellCheck={false}
            onChange={(e) => (naming ? setNewGroup(e.target.value) : setPath(e.target.value))}
            onKeyDown={onKeyDown}
          />
          {/* What the head is holding right now — it answers two questions in
              this box, and which one is not something to guess at. */}
          <span className="palette-count">{naming ? 'group' : 'path'}</span>
        </div>

        <div className="palette-split">
          <div className="palette-list" ref={listRef}>
            {rows.map((row, i) => {
              const head = row.section !== section && (section = row.section)
              return (
                <div key={`${row.kind}:${row.id}`}>
                  {head && <div className="palette-group">{row.section.toUpperCase()}</div>}
                  <button
                    className="palette-row"
                    data-at={i === at || undefined}
                    // Pointer, not click: the head must keep focus, and mousedown
                    // would blur it before the click landed.
                    onPointerDown={(e) => {
                      e.preventDefault()
                      pick(row)
                    }}
                    onPointerEnter={() => setAt(i)}
                  >
                    {row.kind !== 'browse' && (
                      <i className="palette-mark" data-on={row.on || undefined} />
                    )}
                    <span className="palette-title">{row.label}</span>
                  </button>
                </div>
              )
            })}
          </div>

          <div className="palette-side">
            <PathFacts
              path={path}
              probe={probe}
              machine={machine?.label ?? 'this machine'}
              group={chosenGroup}
              browsable={!!(local && onBrowse)}
            />
          </div>
        </div>

        <div className="palette-foot">{foot}</div>
      </div>
    </div>
  )
}

// The sentinel the "New group…" row uses. A value no group can have, since a
// blank name is rejected upstream.
const NEW = ' new'

interface Answer {
  kind: 'backend' | 'group' | 'newGroup' | 'browse'
  id: string
  label: string
  section: string
  on: boolean
}

/**
 * What the path is, while you type it — the whole reason the dialog has a pane.
 * Everything here comes from the same checks the add itself runs, so the pane
 * never promises what Add is about to refuse.
 */
function PathFacts({
  path,
  probe,
  machine,
  group,
  browsable
}: {
  path: string
  probe: PathProbe | null
  machine: string
  group: string
  browsable: boolean
}) {
  const typed = path.trim()
  return (
    <>
      <PaneTitle>{typed ? tilde(probe?.root ?? typed) : 'Add a project'}</PaneTitle>
      <Facts>
        {!typed ? (
          <Fact label="path">nothing typed yet</Fact>
        ) : !probe ? (
          <Fact label="path">checking…</Fact>
        ) : !probe.exists ? (
          <Fact label="path" tone="warn">
            nothing at that path
          </Fact>
        ) : !probe.isRepo ? (
          <Fact label="git" tone="warn">
            not a git repository
          </Fact>
        ) : (
          <>
            <Fact label="git" tone="ok">
              repo
            </Fact>
            {probe.branch && <Fact label="branch">{probe.branch}</Fact>}
            {probe.worktrees !== undefined && probe.worktrees > 1 && (
              <Fact label="worktrees">{probe.worktrees} · they come with it</Fact>
            )}
            <Fact label="added" tone={probe.added ? undefined : 'warn'}>
              {probe.added ? `already in ${probe.group}` : 'not yet — it will be new'}
            </Fact>
          </>
        )}
        <Fact label="goes to">
          {group}, on {machine}
        </Fact>
      </Facts>
      {browsable && <PaneNote>⌘O opens the folder picker on {machine}.</PaneNote>}
    </>
  )
}

/**
 * The path, checked on the machine that would hold it.
 *
 * Debounced, because this runs `git` on the other end and a keystroke is not a
 * question yet. Answers for a path that has since changed are dropped rather
 * than shown: the pane must describe what is in the head right now.
 */
function useProbe(path: string, backend: string): PathProbe | null {
  const [probe, setProbe] = useState<PathProbe | null>(null)
  useEffect(() => {
    const typed = path.trim()
    if (!typed) {
      setProbe(null)
      return
    }
    let live = true
    const timer = setTimeout(() => {
      void window.floe.projects
        .probe(typed, backend)
        .then((res) => live && res.path === typed && setProbe(res))
        .catch(() => live && setProbe({ path: typed, exists: false, isRepo: false }))
    }, 180)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [path, backend])
  return probe
}
