// The rail, as a drawer, for a screen with no edge to spare for a rail.
//
// Narrow only. On a desktop the rail is a column of icons against the window
// edge and costs 40px; on a phone that same strip lay along the bottom, ate a
// thumb's worth of height under the composer and scrolled sideways — twelve
// icons behind a swipe with no names on any of them. Here the same panels are a
// list you read: icon, name, and the key that opens it.
//
// Nothing new is reachable from it. Every row is a panel the rail already
// offered and a binding the app already has, which is why it registers no
// command and adds no MCP tool — the drawer is a second route, not a feature.
//
// Keyboard-operable like RowMenu, for the same reason: j/k and the arrows walk
// it, Enter opens, Escape closes and hands focus back to the button it came
// from.

import type { IconProps } from './icons'
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'

export interface RailMenuItem {
  kind: string
  label: string
  icon: ComponentType<IconProps>
  /** Needs something the app hasn't got yet — dimmed and inert, like the rail's. */
  off?: boolean
  /** Why not, shown in the label's place. */
  reason?: string
  /** The key that opens the same panel, printed on the right. */
  keys?: string
}

export function RailMenu({
  groups,
  onPick,
  onClose
}: {
  /** The rail's own grouping, kept: you aim at a block first and a row second. */
  groups: RailMenuItem[][]
  onPick: (kind: string) => void
  onClose: () => void
}): ReactNode {
  const box = useRef<HTMLDivElement>(null)
  // One flat list for the cursor: the groups are how it reads, not how it walks.
  const items = groups.flat()
  const first = items.findIndex((i) => !i.off)
  const [cursor, setCursor] = useState(first === -1 ? 0 : first)

  // The drawer itself, not a row: the highlight is drawn from `cursor`, and one
  // focused element is one place for Escape to be heard.
  useEffect(() => {
    box.current?.focus()
  }, [])

  const step = (delta: number): void => {
    setCursor((now) => {
      for (let i = 1; i <= items.length; i++) {
        const next = (now + delta * i + items.length * items.length) % items.length
        if (!items[next].off) return next
      }
      return now
    })
  }

  return (
    // The way out for a finger: a tap anywhere off the drawer closes it, which
    // is the gesture a phone already teaches.
    <div className="rail-sheet" onMouseDown={onClose}>
      <div
        ref={box}
        className="rail-drawer"
        role="menu"
        aria-label="panels"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        // The drawer owns the keyboard while it is up, or `k` aimed at a row
        // would also reach the panel underneath and move its cursor.
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') return onClose()
          if (e.key === 'ArrowDown' || e.key === 'j') {
            e.preventDefault()
            return step(1)
          }
          if (e.key === 'ArrowUp' || e.key === 'k') {
            e.preventDefault()
            return step(-1)
          }
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            const item = items[cursor]
            if (!item || item.off) return
            onClose()
            onPick(item.kind)
          }
        }}
      >
        {groups.map((group) => (
          <div className="rail-drawer-group" key={group.map((i) => i.kind).join()}>
            {group.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.kind}
                  className="rail-drawer-item"
                  role="menuitem"
                  disabled={item.off}
                  data-at={items[cursor]?.kind === item.kind || undefined}
                  onMouseEnter={() => !item.off && setCursor(items.indexOf(item))}
                  onClick={() => {
                    onClose()
                    onPick(item.kind)
                  }}
                >
                  <Icon size={17} stroke={1.5} />
                  {/* Why not, in the name's place: the row is dimmed either way,
                      and "needs a project" is the one thing worth saying here. */}
                  <span className="rail-drawer-label">{item.off ? item.reason : item.label}</span>
                  {!item.off && item.keys && <kbd>{item.keys}</kbd>}
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
