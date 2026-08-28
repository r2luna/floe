import { useEffect, useRef, useState } from 'react'
import type { BackendInfo } from '../../preload/api'

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
  groups,
  group,
  onBrowse,
  onAdd,
  onClose
}: {
  backends: BackendInfo[]
  groups: string[]
  /** The group to preselect — the one you were looking at. */
  group?: string
  /** Native folder picker. Absent in the web build, which has no local disk. */
  onBrowse: ((group: string) => void) | null
  onAdd: (backend: string, path: string, group: string) => void
  onClose: () => void
}) {
  const [backend, setBackend] = useState(backends[0]?.id ?? 'local')
  const [path, setPath] = useState('')
  const [picked, setPicked] = useState(group || groups[0] || 'Projects')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    requestAnimationFrame(() => input.current?.focus())
  }, [])

  const machine = backends.find((b) => b.id === backend)
  const local = machine ? !machine.remote : true
  const commit = () => {
    const p = path.trim()
    if (p) onAdd(backend, p, picked)
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
          {groups.length > 1 && (
            <Chips label="Group" name="add-group" value={picked} onChange={setPicked}
              options={groups.map((g) => ({ id: g, label: g }))} />
          )}

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
