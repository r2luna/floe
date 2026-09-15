import { useEffect, useRef, useState } from 'react'
import type { BackendInfo } from '../../preload/api'
import { parseHostPath } from '../../shared/hostPath'
import { DEFAULT_GROUP, type PathProbe } from '../../shared/types'
import { backendForHost, backendState, LOCAL } from './backends'
import { Fact, Facts, PaneTitle, tilde } from './palettePreview'

/**
 * One dialog for the whole "add a project" question: which machine, which
 * group, which repo.
 *
 * The machine is part of what you type: `[host@]path`, where no host means this
 * machine. The MACHINE rows are `[projects] hosts` from floe.toml, and picking
 * one only rewrites that prefix. A host that is not paired yet gets paired on ⏎
 * — the server plugin reads its daemon token over ssh — and the add follows. A
 * host typed by hand is written to the list, so it is a row next time.
 *
 * It is the palette's box, not a dialog of its own: the head is where you type
 * the path, the machines and groups are rows under it, and the right pane checks the path
 * while you type — is it a repo, on which branch, is it already added.
 *
 * Keyboard-first throughout: the path takes focus on open, ↓ walks into the
 * rows and ⏎ picks one (landing you back on the path), ⏎ on the path adds,
 * ⌘O browses, Esc backs out one level at a time.
 */
export function AddProject({
  backends,
  current,
  groups,
  group,
  onBrowse,
  onPair,
  onAdd,
  onClose
}: {
  backends: BackendInfo[]
  /** The machine the window is attached to — the head starts with its host. */
  current: string
  groups: string[]
  /** The group to preselect — the one you were looking at. */
  group?: string
  /** Native folder picker. Absent in the web build, which has no local disk. */
  onBrowse: ((group: string) => void) | null
  /** Pair a host Floe has not met; resolves with its backend id. */
  onPair: (host: string) => Promise<string>
  onAdd: (backend: string, path: string, group: string) => void
  onClose: () => void
}) {
  // Attached to another machine, "Add project" means one there far more often
  // than one back home, so the head starts with that host already typed.
  const [text, setText] = useState(() => {
    const at = backends.find((b) => b.id === current && b.remote)
    return at ? `${at.label}@` : ''
  })
  const [picked, setPicked] = useState(group || groups[0] || DEFAULT_GROUP)
  // Naming a new group borrows the head rather than opening a second field:
  // there is one place you type in this box, and it is the line at the top.
  const [naming, setNaming] = useState(false)
  const [newGroup, setNewGroup] = useState('')
  const [pairing, setPairing] = useState(false)
  const [pairError, setPairError] = useState<string | null>(null)
  const [hosts, setHosts] = useState<string[]>([])
  // -1 is the path itself. The cursor only enters the groups when you ask it
  // to with ↓, which is what keeps ⏎ meaning "add" for the common case.
  const [at, setAt] = useState(-1)
  const input = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    requestAnimationFrame(() => input.current?.focus())
    void window.floe.projects
      .hosts()
      .then(setHosts)
      .catch(() => {})
  }, [])

  useEffect(() => {
    listRef.current?.querySelector('[data-at]')?.scrollIntoView({ block: 'nearest' })
  }, [at])

  const { host, path } = parseHostPath(text)
  // Undefined only for a host that is not paired yet: there is nothing to ask
  // about the path until there is a socket to ask over.
  const backend = host ? backendForHost(host) : LOCAL
  const local = !host
  const probe = useProbe(naming || !backend ? '' : path, backend ?? LOCAL)

  // A group typed but never confirmed still counts — nobody expects to lose
  // what they just wrote because they hit Add instead of Enter.
  const chosenGroup = (naming && newGroup.trim()) || picked
  const browsable = local && !!onBrowse

  // Listed hosts, then anything paired or typed that is not listed yet — so the
  // mark always has a row to sit on.
  const paired = backends.filter((b) => b.remote).map((b) => b.label)
  const machines = [...new Set([...hosts, ...paired, ...(host ? [host] : [])])]

  const rows: Answer[] = [
    { kind: 'machine' as const, id: LOCAL, label: 'this machine', section: 'machine', on: !host },
    ...machines.map((m) => ({
      kind: 'machine' as const,
      id: m,
      label: m,
      section: 'machine',
      on: m === host,
      detail: machineDetail(m, hosts)
    })),
    // A group you just named belongs in the list: it does not exist on disk
    // yet, and without a row of its own the mark has nowhere to sit.
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
    ...(browsable ? [{ kind: 'browse' as const, id: 'browse', label: 'Browse…', section: 'path', on: false }] : [])
  ]

  // A host that took an add belongs in the list, whichever way it was typed.
  const remember = (): void => {
    if (host && !hosts.includes(host)) void window.floe.projects.addHost(host).catch(() => {})
  }

  const commit = () => {
    if (!path || pairing) return
    if (backend) {
      remember()
      return onAdd(backend, path, chosenGroup)
    }
    if (!host) return
    setPairing(true)
    setPairError(null)
    onPair(host)
      .then((id) => {
        remember()
        onAdd(id, path, chosenGroup)
      })
      .catch((e: unknown) => {
        setPairing(false)
        setPairError(e instanceof Error ? e.message : String(e))
      })
  }

  const pick = (row: Answer) => {
    // Only the prefix changes: the path you typed is the same path on the next
    // machine more often than not.
    if (row.kind === 'machine') {
      setText(row.id === LOCAL ? path : `${row.id}@${path}`)
      setPairError(null)
    }
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
      // One level at a time: out of the group name, then out of the groups,
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
    if (e.key.toLowerCase() === 'o' && e.metaKey && browsable) {
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

  const verb = pairing ? 'pairing…' : pairError ? '⏎ retry' : host && !backend ? `⏎ pair ${host} and add` : '⏎ add'
  const foot = naming
    ? '⏎ name the group · esc back'
    : at >= 0
      ? '⏎ pick · ↑↓ move · esc back to the path'
      : `${verb} · ↓ machine & group${browsable ? ' · ⌘O browse' : ''} · esc cancel`

  let section = ''
  return (
    <div className="palette-scrim" onPointerDown={onClose}>
      <div className="palette" data-wide onPointerDown={(e) => e.stopPropagation()}>
        <div className="palette-head">
          <span className="palette-sigil">＋</span>
          <input
            ref={input}
            className="palette-input"
            placeholder={naming ? 'Group name…' : 'Path to a git repo, or host@path on another machine…'}
            value={naming ? newGroup : text}
            spellCheck={false}
            onChange={(e) => {
              if (naming) return setNewGroup(e.target.value)
              setText(e.target.value)
              setPairError(null)
            }}
            onKeyDown={onKeyDown}
          />
          {/* What the head is holding right now — it answers two questions in
              this box, and which one is not something to guess at. */}
          <span className="palette-count">{naming ? 'group' : (host ?? 'path')}</span>
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
                    {row.kind !== 'browse' && <i className="palette-mark" data-on={row.on || undefined} />}
                    <span className="palette-title">{row.label}</span>
                    {row.detail && (
                      <span className="palette-detail" data-tone={row.detail.tone}>
                        {row.detail.text}
                      </span>
                    )}
                  </button>
                </div>
              )
            })}
          </div>

          <div className="palette-side">
            <PathFacts
              text={text}
              host={host}
              path={path}
              backend={backend}
              probe={probe}
              pairing={pairing}
              pairError={pairError}
              group={chosenGroup}
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
const NEW = ' new'

interface Answer {
  kind: 'machine' | 'group' | 'newGroup' | 'browse'
  id: string
  label: string
  section: string
  on: boolean
  detail?: { text: string; tone?: 'ok' }
}

/** What a machine row says about its host: reachable now, or what ⏎ will do. */
function machineDetail(host: string, listed: string[]): { text: string; tone?: 'ok' } {
  const id = backendForHost(host)
  if (id) {
    const state = backendState(id)
    if (!listed.includes(host)) return { text: 'saved on add' }
    return state === 'open' ? { text: 'connected', tone: 'ok' } : { text: state }
  }
  return listed.includes(host) ? { text: 'pairs on first add' } : { text: 'new · saved after pairing' }
}

/**
 * What the path is, while you type it — the whole reason the dialog has a pane.
 * Everything here comes from the same checks the add itself runs, so the pane
 * never promises what Add is about to refuse.
 */
function PathFacts({
  text,
  host,
  path,
  backend,
  probe,
  pairing,
  pairError,
  group
}: {
  text: string
  host: string | null
  path: string
  backend: string | undefined
  probe: PathProbe | null
  pairing: boolean
  pairError: string | null
  group: string
}) {
  const title = host ? `${host}@${path}` : tilde(probe?.root ?? path)
  return (
    <>
      <PaneTitle>{text.trim() ? title : 'Add a project'}</PaneTitle>
      <Facts>
        <MachineFact host={host} backend={backend} pairing={pairing} pairError={pairError} />
        {pairError ? (
          <Fact label="ssh" tone="warn">
            {pairError}
          </Fact>
        ) : host && !backend ? (
          <>
            <Fact label="pairs by">ssh {host} → daemon token</Fact>
            <Fact label="path">{path ? 'checked after pairing' : 'nothing typed yet'}</Fact>
          </>
        ) : (
          <ProbeFacts path={path} probe={probe} />
        )}
        {!pairError && <Fact label="goes to">{group}</Fact>}
      </Facts>
    </>
  )
}

function MachineFact({
  host,
  backend,
  pairing,
  pairError
}: {
  host: string | null
  backend: string | undefined
  pairing: boolean
  pairError: string | null
}) {
  if (!host) return <Fact label="machine">this machine</Fact>
  if (pairError)
    return (
      <Fact label="machine" tone="warn">
        {host} · pairing failed
      </Fact>
    )
  if (!backend)
    return (
      <Fact label="machine" tone="warn">
        {host} · {pairing ? 'pairing…' : 'not paired yet'}
      </Fact>
    )
  const state = backendState(backend)
  return (
    <Fact label="machine" tone={state === 'open' ? 'ok' : 'warn'}>
      {host} · {state === 'open' ? 'connected' : state}
    </Fact>
  )
}

function ProbeFacts({ path, probe }: { path: string; probe: PathProbe | null }) {
  if (!path) return <Fact label="path">nothing typed yet</Fact>
  if (!probe) return <Fact label="path">checking…</Fact>
  if (!probe.exists)
    return (
      <Fact label="path" tone="warn">
        nothing at that path
      </Fact>
    )
  if (!probe.isRepo)
    return (
      <Fact label="git" tone="warn">
        not a git repository
      </Fact>
    )
  return (
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
    setProbe(null)
    if (!typed) return
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
