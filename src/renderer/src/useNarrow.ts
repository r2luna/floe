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
  const query = `(max-width: ${WIDE_AT - 1}px)`
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches)

  useEffect(() => {
    const mq = window.matchMedia(query)
    const read = () => setNarrow(mq.matches)
    read()
    mq.addEventListener('change', read)
    return () => mq.removeEventListener('change', read)
  }, [query])

  useEffect(() => {
    if (narrow) document.documentElement.dataset.narrow = ''
    else delete document.documentElement.dataset.narrow
  }, [narrow])

  return narrow
}
