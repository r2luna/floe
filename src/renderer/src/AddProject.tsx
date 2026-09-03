import { useEffect, useRef, useState } from 'react'
import type { BackendInfo } from '../../preload/api'
import { DEFAULT_GROUP } from '../../shared/types'

/**
 * One dialog for the whole "add a project" question: which machine, which
 * group, which repo. Asking all three at once beats a chain of prompts that
 * each reveal only the next thing they want.
 *
 * Keyboard-first throughout: the path field takes focus on open, the chip rows
 * are native radio groups (so arrows move between them), ⏎ adds and Esc closes.
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
  // Naming a new group is a second question, so it only appears once you ask for
  // it — the dropdown's last entry — instead of a text box you must ignore.
  const [making, setMaking] = useState(false)
  const [newGroup, setNewGroup] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const groupInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    requestAnimationFrame(() => input.current?.focus())
  }, [])

  const machine = backends.find((b) => b.id === backend)
  const local = machine ? !machine.remote : true
  // A group typed but never confirmed still counts — nobody expects to lose what
  // they just wrote because they hit Add instead of Tab.
  const chosenGroup = (making && newGroup.trim()) || picked
  const commit = () => {
    const p = path.trim()
    if (p) onAdd(backend, p, chosenGroup)
  }

  return (
    <div className="palette-scrim" onPointerDown={onClose}>
      <div
        className="dialog"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          e.preventDefault()
          onClose()
        }}
      >
        <div className="dialog-head">Add project</div>
        <div className="dialog-body">
          {/* One machine is not a choice — the row would be noise. */}
          {backends.length > 1 && (
            <Chips label="Machine" name="add-backend" value={backend} onChange={setBackend}
              options={backends.map((b) => ({ id: b.id, label: b.label }))} />
          )}
          <div className="dialog-field">
            <label className="chips-label" htmlFor="add-group">
              Group
            </label>
            <div className="dialog-row">
              <select
                id="add-group"
                className="dialog-select"
                value={making ? NEW : picked}
                onChange={(e) => {
                  if (e.target.value === NEW) {
                    setMaking(true)
                    requestAnimationFrame(() => groupInput.current?.focus())
                    return
                  }
                  setMaking(false)
                  setPicked(e.target.value)
                }}
              >
                {groups.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
                <option value={NEW}>New group…</option>
              </select>
              {making && (
                <input
                  ref={groupInput}
                  className="dialog-input"
                  placeholder="Group name…"
                  value={newGroup}
                  spellCheck={false}
                  onChange={(e) => setNewGroup(e.target.value)}
                  onKeyDown={(e) => {
                    // Esc backs out of naming without closing the whole dialog —
                    // the outer handler would otherwise take the whole thing down.
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      e.stopPropagation()
                      setMaking(false)
                      setNewGroup('')
                      return
                    }
                    if (e.key !== 'Enter') return
                    e.preventDefault()
                    input.current?.focus()
                  }}
                />
              )}
            </div>
          </div>

          <div className="dialog-row">
            <input
              ref={input}
              className="dialog-input"
              placeholder={`Path to a git repo on ${machine?.label ?? 'this machine'}…`}
              value={path}
              spellCheck={false}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                commit()
              }}
            />
            {/* No picker for a remote machine: the dialog would browse THIS
                disk and hand back a path that doesn't exist over there. */}
            {local && onBrowse && (
              <button className="btn" onClick={() => onBrowse(picked)}>
                Browse…
              </button>
            )}
          </div>

          <div className="dialog-actions">
            <span className="dialog-hint">
              {local && onBrowse
                ? 'Type a path, or browse for the folder'
                : `The path is read on ${machine?.label}`}
            </span>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={!path.trim()} onClick={commit}>
              Add
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// The sentinel the group <select> uses for "not a group — ask me for a name".
// A value no group can have, since a blank name is rejected upstream.
const NEW = '\u0000new'

/** A row of choices as a native radio group, so the arrow keys already work. */
function Chips({
  label,
  name,
  value,
  options,
  onChange
}: {
  label: string
  name: string
  value: string
  options: { id: string; label: string }[]
  onChange: (id: string) => void
}) {
  return (
    <div className="chips">
      <div className="chips-label">{label}</div>
      <div className="chips-row">
        {options.map((o) => (
          <label className="chip" key={o.id} data-on={o.id === value || undefined}>
            <input
              type="radio"
              name={name}
              checked={o.id === value}
              onChange={() => onChange(o.id)}
            />
            {o.label}
          </label>
        ))}
      </div>
    </div>
  )
}
