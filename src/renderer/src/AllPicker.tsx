import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocalAgents } from './useLocalAgents'
import { nickColor } from './nickColor'

// Who `@all` goes to, when there is nothing open to answer that already.
//
// R7: `@all` never fans out to every harness installed. With queries already
// open it goes to those plus the chat itself — you have already said who you
// are talking to. With none, it asks, and this is the asking. Four turns nobody
// ordered is the failure mode; a list you confirm is the fix.
//
// It borrows the model menu's own rows (`.model-head`, `.model-option`) rather
// than inventing a second picker: this appears in the same place, over the same
// composer, and reading as a different thing would be the surprise.

export interface AllTarget {
  harness: string
  /** Already installed and runnable on this machine. */
  ready: boolean
  /** Cannot hold a query at all — no read-only mode (R2). */
  blocked?: boolean
  note?: string
}

/**
 * The harnesses that can actually hold a query, in menu order.
 *
 * `plan` is the gate and it is the real one: gemini has no read-only setting,
 * so it is listed and struck rather than quietly missing — "why is gemini not
 * here" is a worse question than an answer to it. See docs/queries.md.
 */
export function allTargets(
  installed: Array<{ id: string; label: string }>,
  canHold: (harness: string) => boolean
): AllTarget[] {
  const seen = new Set<string>()
  const rows: AllTarget[] = []
  for (const id of ['claude', ...installed.map((a) => a.id)]) {
    if (seen.has(id)) continue
    seen.add(id)
    rows.push({
      harness: id,
      ready: true,
      blocked: !canHold(id),
      note: canHold(id) ? undefined : 'no read-only mode'
    })
  }
  return rows
}

export function AllPicker({
  own,
  canHold,
  onPick,
  onCancel
}: {
  /** The harness this chat answers as — preselected, and deselectable (Q6). */
  own?: string
  canHold: (harness: string) => boolean
  onPick: (harnesses: string[]) => void
  onCancel: () => void
}): JSX.Element {
  const agents = useLocalAgents()
  const rows = useMemo(() => allTargets(agents, canHold), [agents, canHold])
  const pickable = useMemo(() => rows.filter((r) => !r.blocked), [rows])
  // The chat's own harness starts on, because asking the others AND the one in
  // front of you is the common shape — and it comes off with one keystroke,
  // because asking only the others is a real case too (Q6).
  const [picked, setPicked] = useState<string[]>(() => (own ? [own] : []))
  const [at, setAt] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  // Keyboard-first: it opens with focus in it, and never needs the mouse.
  useEffect(() => ref.current?.focus(), [])

  const toggle = (harness: string): void =>
    setPicked((p) => (p.includes(harness) ? p.filter((x) => x !== harness) : [...p, harness]))

  return (
    <div
      className="model-menu all-picker"
      ref={ref}
      tabIndex={-1}
      role="listbox"
      aria-multiselectable
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          // Focus goes back where it came from. The picker took it on open, so
          // dismissing it without handing it back leaves the caret on a removed
          // element and the next keystroke goes nowhere — the one thing a
          // keyboard-first app must never do (AGENTS.md).
          const composer = ref.current
            ?.closest('.chat-panel, .query-panel')
            ?.querySelector<HTMLTextAreaElement>('.composer-input')
          onCancel()
          composer?.focus()
          return
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          // Nothing picked is not a send: `@all` to nobody is a message that
          // goes nowhere, and silently doing nothing would read as a bug.
          if (picked.length) onPick(picked)
          return
        }
        if (e.key === ' ') {
          e.preventDefault()
          const row = pickable[at]
          if (row) toggle(row.harness)
          return
        }
        const step = e.key === 'ArrowDown' || e.key === 'j' ? 1 : e.key === 'ArrowUp' || e.key === 'k' ? -1 : 0
        if (!step) return
        e.preventDefault()
        setAt((n) => (n + step + pickable.length) % pickable.length)
      }}
    >
      <div className="model-list">
        <div className="model-group">
          <div className="model-head">
            ask <span className="model-agent-note">space toggles · ⏎ sends · esc cancels</span>
          </div>
          {rows.map((row) => {
            const n = pickable.indexOf(row)
            return (
              <button
                key={row.harness}
                className="model-option"
                role="option"
                aria-selected={picked.includes(row.harness)}
                disabled={row.blocked}
                data-at={(n !== -1 && n === at) || undefined}
                data-on={picked.includes(row.harness) || undefined}
                onPointerDown={(e) => {
                  e.preventDefault()
                  if (!row.blocked) toggle(row.harness)
                }}
                onPointerEnter={() => n !== -1 && setAt(n)}
              >
                <span style={{ color: nickColor(row.harness) }}>{row.harness}</span>
                {row.harness === own && <span className="model-agent-note">in the chat</span>}
                {row.note && <span className="model-agent-note">{row.note}</span>}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
