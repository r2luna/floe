import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export type GalleryImage = { src: string; alt?: string }

/**
 * The transcript's images at full size, over everything, as a gallery: the one
 * you opened is showing and the arrows walk the rest, because looking at a
 * screenshot usually means comparing it to the one before it.
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
  images,
  start = 0,
  onClose
}: {
  images: GalleryImage[]
  start?: number
  onClose: () => void
}): React.ReactPortal {
  const box = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState(start)

  useEffect(() => {
    const from = document.activeElement as HTMLElement | null
    box.current?.focus({ preventScroll: true })
    // The row that opened this is still there; leaving focus on a removed
    // overlay would strand the keyboard with nothing to type into.
    return () => from?.focus?.({ preventScroll: true })
  }, [])

  const many = images.length > 1
  const now = images[Math.min(at, images.length - 1)]
  // Wrapping, not stopping: the gallery is a ring, so holding one arrow always
  // gets you to the picture you half-remember without changing hands.
  const step = (d: number): void => setAt((i) => (i + d + images.length) % images.length)

  if (!now) return createPortal(null, document.body)

  return createPortal(
    <div
      className="lightbox"
      ref={box}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={now.alt || 'Image'}
      onClick={onClose}
      onKeyDown={(e) => {
        e.stopPropagation()
        // Every key that means "I am done looking": the one that dismisses
        // anything else in the app, and the two that opened it from the row.
        if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClose()
          return
        }
        // Arrows and the vi pair, so the hand that walks the transcript with
        // h/l walks the gallery the same way.
        const d = e.key === 'ArrowRight' || e.key === 'l' ? 1 : e.key === 'ArrowLeft' || e.key === 'h' ? -1 : 0
        if (d && many) {
          e.preventDefault()
          step(d)
        }
      }}
    >
      {many && (
        <button
          className="lightbox-nav lightbox-prev"
          title="Previous image"
          aria-label="Previous image"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation()
            step(-1)
          }}
        >
          ‹
        </button>
      )}
      {/* Clicking the picture itself does nothing: the backdrop is what
          dismisses, so a mis-aimed click while browsing does not close it. */}
      <img
        className="lightbox-image"
        src={now.src}
        alt={now.alt ?? ''}
        onClick={(e) => e.stopPropagation()}
      />
      {many && (
        <button
          className="lightbox-nav lightbox-next"
          title="Next image"
          aria-label="Next image"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation()
            step(1)
          }}
        >
          ›
        </button>
      )}
      <span className="lightbox-hint">
        {many && (
          <>
            <b className="lightbox-count">
              {at + 1}/{images.length}
            </b>
            {' · ← → to browse · '}
          </>
        )}
        esc to close
      </span>
    </div>,
    document.body
  )
}
