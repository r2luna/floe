import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

/**
 * An image at full size, over everything.
 *
 * Portalled to `document.body` rather than rendered where it is opened: a
 * `position: fixed` box inside a panel is clipped and sized by that panel, and
 * a picture you opened to look at closer is the last thing that should be
 * squeezed into a column. Same reason the palette lives at the app root.
 *
 * It owns the keyboard while it is up — the keydown is stopped here, so `j`
 * cannot walk the cursor in the panel you can no longer see — and hands focus
 * back to whatever opened it on the way out.
 */
export function Lightbox({
  src,
  alt,
  onClose
}: {
  src: string
  alt?: string
  onClose: () => void
}): React.ReactPortal {
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const from = document.activeElement as HTMLElement | null
    box.current?.focus({ preventScroll: true })
    // The row that opened this is still there; leaving focus on a removed
    // overlay would strand the keyboard with nothing to type into.
    return () => from?.focus?.({ preventScroll: true })
  }, [])

  return createPortal(
    <div
      className="lightbox"
      ref={box}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={alt || 'Image'}
      onClick={onClose}
      onKeyDown={(e) => {
        e.stopPropagation()
        // Every key that means "I am done looking": the one that dismisses
        // anything else in the app, and the two that opened it from the row.
        if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClose()
        }
      }}
    >
      <img className="lightbox-image" src={src} alt={alt ?? ''} />
      <span className="lightbox-hint">esc to close</span>
    </div>,
    document.body
  )
}
