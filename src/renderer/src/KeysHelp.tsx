import { useEffect, useMemo, useRef, useState } from 'react'
import { KEYMAP_SECTIONS } from '../../shared/defaultKeymap'
import { formatChord, type Keybind } from '../../shared/keymap'
import { describeWhen } from './keyHints'

interface Row {
  keys: string
  title: string
  /** Where it applies, when that is not everywhere. */
  where?: string
  here: boolean
}

/**
 * `?` — every binding on one screen.
 *
 * Built from the bindings in force, not from the defaults, so a rebind shows up
 * here the moment keybindings.toml changes. The sections are the defaults' own,
 * matched by command; a command the user bound that no section lists lands in
 * `Other`. The sections with keys for the focused panel come first and are
 * boxed, because those are the keys you are most likely looking for.
 */
export function KeysHelp({
  binds,
  kind,
  titleOf,
  onClose
}: {
  binds: readonly Keybind[]
  /** The focused panel's kind. */
  kind?: string
  /** A command's name, or null for one that is not offered (hidden or unknown). */
  titleOf: (command: string, arg?: string) => string | null
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])

  const sections = useMemo(() => {
    const sectionOf = new Map<string, string>()
    for (const s of KEYMAP_SECTIONS) for (const b of s.binds) if (!sectionOf.has(b.command)) sectionOf.set(b.command, s.title)

    const grouped = new Map<string, Row[]>()
    const seen = new Set<string>()
    for (const b of binds) {
      // `⌃1`…`⌃9` are one row: the first stands for the run, the rest are dropped.
      const digit = b.arg !== undefined && /^[1-8]$/.test(b.arg)
      if (digit) continue
      const run = b.arg === '0' && b.key.endsWith('+1')
      const title = run ? titleOf(b.command) : titleOf(b.command, b.arg)
      if (!title) continue
      const where = describeWhen(b.when)
      // `shift+?` reads as `?`: shift is how the key is typed, not a chord.
      const chord = /^shift\+[^a-z]$/.test(b.key) ? b.key.slice('shift+'.length) : b.key
      const keys = run ? formatChord(chord).replace(/1$/, '1–9') : formatChord(chord)
      const id = `${keys}|${title}|${where ?? ''}`
      if (seen.has(id)) continue
      seen.add(id)
      const section = sectionOf.get(b.command) ?? 'Other'
      const here = !!kind && !!b.when && new RegExp(`["']${kind}["']`).test(b.when)
      grouped.set(section, [...(grouped.get(section) ?? []), { keys, title, where, here }])
    }

    const q = query.trim().toLowerCase()
    return [...grouped.entries()]
      .map(([title, rows]) => ({
        title,
        here: rows.some((r) => r.here),
        rows: q
          ? rows.filter((r) => `${r.keys} ${r.title} ${r.where ?? ''} ${title}`.toLowerCase().includes(q))
          : rows
      }))
      .filter((s) => s.rows.length)
      .sort((a, b) => Number(b.here) - Number(a.here))
  }, [binds, kind, titleOf, query])

  return (
    <div className="palette-scrim" onPointerDown={onClose}>
      <div className="palette keys-help" onPointerDown={(e) => e.stopPropagation()}>
        <div className="palette-head">
          <span className="palette-sigil">?</span>
          <input
            ref={input}
            className="palette-input"
            placeholder="Filter keys…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' || e.key === '?') {
                e.preventDefault()
                onClose()
              }
            }}
          />
          {kind && <span className="keys-help-ctx">in {kind}</span>}
        </div>
        <div className="keys-help-grid">
          {sections.length === 0 && <div className="palette-empty">No keys match.</div>}
          {sections.map((s) => (
            <div key={s.title} className="keys-help-sec" data-here={s.here || undefined}>
              <div className="keys-help-label">{s.here ? `here · ${s.title}` : s.title}</div>
              {s.rows.map((r) => (
                <div key={`${r.keys}|${r.title}|${r.where ?? ''}`} className="keys-help-row">
                  <span className="keys-help-keys">{r.keys}</span>
                  <span className="keys-help-what">
                    {r.title}
                    {r.where && <span className="keys-help-where"> · {r.where}</span>}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="palette-foot">every binding lives in keybindings.toml · esc close</div>
      </div>
    </div>
  )
}
