import { useEffect, useState } from 'react'

/**
 * The width at which the lane can hold more than one panel.
 *
 * A column is 380px and the rail is 40px more, so a 390px phone was always
 * showing a panel cut down the middle — the lane's axis is horizontal and a
 * phone has no horizontal room to spend. Below this width the lane shows
 * exactly one panel and snaps to it; at or above it, the desktop lane runs
 * unchanged.
 *
 * 1000 is chosen from the device that has to work both ways: a folded fold
 * (~344) and its inner screen in portrait (~904) get one panel, the same fold
 * unfolded in landscape (~1104) gets the desktop lane and fits two columns
 * beside the rail. A phone (390–430) and a tablet in portrait (820) are one
 * panel; anything a desktop window reaches is not.
 */
export const WIDE_AT = 1000

export const isNarrow = (width: number): boolean => width < WIDE_AT

/**
 * Whether the lane is in one-panel mode, and the same answer published to CSS.
 *
 * The breakpoint is defined ONCE, here, and mirrored onto <html> as
 * `data-narrow` — the same way the theme is. A media query in index.css would
 * be a second copy of the number, and the two would drift the first time one
 * of them moved.
 */
export function useNarrow(): boolean {
  return useFlag(`(max-width: ${WIDE_AT - 1}px)`, 'narrow')
}

/**
 * Whether the pointer is a finger.
 *
 * Narrow is about the WINDOW; this is about the hardware, and they are not the
 * same question. A desktop window dragged down to 700px is narrow and still has
 * a keyboard — it must not get the key bar, which exists only because an
 * on-screen keyboard has no Esc, Tab or Ctrl. `pointer: coarse` is the phone and
 * the tablet, and nothing that came with keys.
 */
export function useTouch(): boolean {
  return useFlag('(pointer: coarse)', 'touch')
}

/**
 * One media query, watched and mirrored onto <html> as `data-<flag>` — the same
 * way the theme is, so CSS reads the answer without owning a second copy of the
 * rule that produced it.
 */
function useFlag(query: string, flag: string): boolean {
  const [on, setOn] = useState(() => window.matchMedia(query).matches)

  useEffect(() => {
    const mq = window.matchMedia(query)
    const read = () => setOn(mq.matches)
    read()
    mq.addEventListener('change', read)
    return () => mq.removeEventListener('change', read)
  }, [query])

  useEffect(() => {
    if (on) document.documentElement.dataset[flag] = ''
    else delete document.documentElement.dataset[flag]
  }, [on, flag])

  return on
}
