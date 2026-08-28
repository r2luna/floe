// Finding the `/` or `#` you are typing right now.
//
// Both menus hang on the same question: is the caret inside a token that starts
// with a trigger character? Getting it wrong in either direction is bad — a menu
// that opens on the slash in a path is noise, and one that misses the slash you
// just typed is a feature you cannot reach.

export interface Trigger {
  /** Which menu: '/' for skills, '#' for sessions and files. */
  char: '/' | '#'
  /** What you have typed after it, for filtering. */
  query: string
  /** Where the trigger character sits, so a pick can replace from there. */
  start: number
}

/**
 * The trigger at `caret`, or null.
 *
 * A trigger only counts at the start of a word — after a space, a newline, or
 * at the very beginning. That is what keeps `src/main` and `user@host` from
 * opening a menu: their `/` and `#` follow a letter, so they are part of a word
 * you are writing rather than the start of a command.
 */
export function triggerAt(text: string, caret: number): Trigger | null {
  // Walk back from the caret to the start of the current word.
  let i = caret
  while (i > 0 && !/\s/.test(text[i - 1])) i--

  const char = text[i]
  if (char !== '/' && char !== '#') return null

  const query = text.slice(i + 1, caret)
  // A space closes the menu: once you have typed past the token you are writing
  // prose again, and a menu still filtering on it would be stale.
  if (/\s/.test(query)) return null

  return { char, query, start: i }
}

/**
 * Replace the trigger token with `value`, leaving a trailing space so you can
 * keep typing without reaching for one.
 */
export function applyTrigger(
  text: string,
  trigger: Trigger,
  caret: number,
  value: string
): { text: string; caret: number } {
  const insert = value + ' '
  return {
    text: text.slice(0, trigger.start) + insert + text.slice(caret),
    caret: trigger.start + insert.length
  }
}
