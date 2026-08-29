// The right-click menu for a list row.
//
// Everything it offers already has a key — that is the rule, not a coincidence:
// the menu is a second route to commands the keyboard reaches directly, so it
// prints the binding beside every item and teaches its way out of itself.
//
// It is keyboard-operable too. A menu you can only leave with the mouse would
// strand the very hand that never left the keys: j/k and the arrows walk it,
// Enter runs, Escape closes, and closing hands focus back to the row it came
// from so the list continues exactly where it was.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export interface MenuAction {
  label: string
  /** The key that does the same thing, printed on the right. */
  keys?: string
  run: () => void
  /** Off right now — shown dimmed rather than hidden, so the list keeps its shape. */
  disabled?: boolean
}

export function RowMenu({
  at,
  items,
  onClose
}: {
  /** Where the click landed, in viewport coordinates. */
  at: { x: number; y: number }
  items: MenuAction[]
  onClose: () => void
}): ReactNode {
  const box = useRef<HTMLDivElement>(null)
  const first = items.findIndex((i) => !i.disabled)
  const [cursor, setCursor] = useState(first === -1 ? 0 : first)

  // Clamp inside the window: a menu opened near the bottom edge must not run
  // off it, and the pointer is already where it is — the box moves, not the
  // click.
  const [pos, setPos] = useState(at)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({
      x: Math.min(at.x, window.innerWidth - width - 8),
      y: Math.min(at.y, window.innerHeight - height - 8)
    })
  }, [at.x, at.y])

  // Anywhere else, and the menu is gone: a click meant for the app underneath
  // should not be spent on dismissing this. Capture, so it closes before the
  // panel below reacts to it.
  useEffect(() => {
    const away = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', away, true)
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('mousedown', away, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  // Focus the box itself, not an item: the cursor is drawn from `cursor`, and
  // moving DOM focus per item would fight the panel's own row-focus tracking.
  useEffect(() => {
    box.current?.focus()
  }, [])

  const step = (delta: number): void => {
    setCursor((now) => {
      for (let i = 1; i <= items.length; i++) {
        const next = (now + delta * i + items.length * items.length) % items.length
        if (!items[next].disabled) return next
      }
      return now
    })
  }

  return (
    <div
      ref={box}
      className="row-menu"
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      tabIndex={-1}
      // The menu owns the keyboard while it is up: nothing here may reach the
      // panel's own bindings, or `d` on "Delete…" would also delete the row.
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
          if (!item || item.disabled) return
          onClose()
          item.run()
        }
      }}
    >
      {items.map((item, i) => (
        <button
          key={item.label}
          className="row-menu-item"
          role="menuitem"
          disabled={item.disabled}
          data-at={i === cursor || undefined}
          onMouseEnter={() => !item.disabled && setCursor(i)}
          onClick={() => {
            onClose()
            item.run()
          }}
        >
          <span className="row-menu-label">{item.label}</span>
          {item.keys && <span className="row-menu-keys">{item.keys}</span>}
        </button>
      ))}
    </div>
  )
}
