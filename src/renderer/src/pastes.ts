// A paste too big to read, kept out of the way of the message it belongs to.
//
// Dropping 900 lines of crash log into the composer turns the bar into a wall:
// the message you were writing is somewhere in the middle of it, and there is
// nothing left to read. So a big paste never enters the text as itself. It is
// held here and named in the message by a two-line RAIL — a quoted block with
// its size and its first line — which is what you see, edit around, and erase.
// The full text goes out on send, verbatim, in the rail's place.
//
// Everything in this file is a pure function over the draft string, for the
// same reason markdown.ts is: the mirror behind the textarea paints the rail
// glyph for glyph, so the rail has to BE characters in the textarea. That is
// why it is drawn with a literal `│` rather than a border — a border has no
// width in the text, and anything that did would slide the caret off the line.

/** A pasted run held back from the text. Numbered by position, like images. */
export type PastedText = { id: string; text: string }

/**
 * When a paste is big enough to collapse.
 *
 * Two numbers rather than one: a stack trace is long and thin (lines, few
 * characters) and a pasted page of prose is short and fat (one line that wraps
 * over half the panel). Both of them bury the message, so either one collapses.
 */
export const PASTE_MIN_LINES = 24
export const PASTE_MIN_CHARS = 2000

/** The rail's left edge — one glyph, on both of its lines. */
const BAR = '│ '

/** A rail: its header line, and the preview line under it if it has one. */
const RAIL = /^│ paste (\d\d) · [^\n]*(?:\n│ [^\n]*)?/gm

/** The rail AND the line break after it — what erasing one takes with it, so
    the block does not leave an empty row behind where it was. */
const CUT = /^│ paste (\d\d) · [^\n]*(?:\n│ [^\n]*)?\n?/gm

/** The header alone — what carries the number. */
const HEAD = /^│ paste (\d\d) · [^\n]*/

/** How much of the first line the rail shows before it gives up. */
const PREVIEW = 72

export function isBigPaste(text: string): boolean {
  return text.length >= PASTE_MIN_CHARS || countLines(text) >= PASTE_MIN_LINES
}

const countLines = (text: string): number => text.split('\n').length

/** Its position among the pastes on the message, two digits so rails line up. */
export const pasteNum = (n: number): string => String(n).padStart(2, '0')

function size(text: string): string {
  const bytes = new TextEncoder().encode(text).length
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`
}

/** What the rail says a paste is: `912 lines · 41 KB`. */
export const describePaste = (text: string): string =>
  `${countLines(text)} lines · ${size(text)}`

/**
 * The first line worth showing, flattened onto one row.
 *
 * Tabs become spaces because the rail is one line of a mirror that has to
 * measure the same as the textarea under it, and a tab's width depends on
 * where in the line it lands — which the preview has just moved.
 */
function preview(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? ''
  const flat = line.replace(/\t/g, '  ').trimEnd()
  return flat.length > PREVIEW ? `${flat.slice(0, PREVIEW - 1)}…` : flat
}

/** The two lines the nth paste writes into the message. */
export const pasteRail = (n: number, body: string): string =>
  `${BAR}paste ${pasteNum(n)} · ${describePaste(body)}\n${BAR}${preview(body)}`

/**
 * Where the rail goes: on lines of its own, whatever the caret was sitting in
 * the middle of. A rail welded to the end of a sentence would read as part of
 * it, and its second line would carry that sentence's tail off into the
 * preview — so both sides get their newline.
 */
export function insertPasteRail(
  text: string,
  at: number,
  n: number,
  body: string
): { text: string; caret: number } {
  const before = text.slice(0, at)
  const after = text.slice(at)
  const lead = before && !before.endsWith('\n') ? '\n' : ''
  const trail = after && !after.startsWith('\n') ? '\n' : ''
  const rail = lead + pasteRail(n, body) + '\n' + trail
  return { text: before + rail + after, caret: at + rail.length }
}

/** Every rail in the text, in the order they appear. */
function rails(text: string): { start: number; end: number; n: number }[] {
  RAIL.lastIndex = 0
  return [...text.matchAll(RAIL)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
    n: Number(m[1])
  }))
}

/**
 * The rail the caret is in, if it is in one — what opens the peek.
 *
 * Both edges count: arriving at a rail from either side is arriving at it, and
 * a caret that has to land strictly inside would make the first line of a
 * two-line block unreachable from above.
 */
export function pasteRailAt(
  text: string,
  caret: number
): { start: number; end: number; n: number } | null {
  return rails(text).find((r) => caret >= r.start && caret <= r.end) ?? null
}

/** The rail that ends exactly at the caret — what Backspace erases whole. */
export function pasteRailBefore(
  text: string,
  caret: number
): { start: number; end: number; n: number } | null {
  return rails(text).find((r) => r.end === caret) ?? null
}

/**
 * Drop a removed paste's rail and close the gap in the numbering, so `paste 02`
 * always names the second paste still held. The same contract as the image
 * tokens (see renumberImageRefs): the message and what is sent with it have to
 * agree on which is which, and only the numbers a paste actually claims move —
 * anything past `count` is something the user typed.
 */
export function renumberPasteRails(text: string, removed: number, count = Infinity): string {
  return text.replace(CUT, (rail, num: string) => {
    const n = Number(num)
    if (!(n >= 1) || n > count) return rail
    if (n === removed) return ''
    if (n < removed) return rail
    return rail.replace(HEAD, (head) =>
      head.replace(`paste ${pasteNum(n)}`, `paste ${pasteNum(n - 1)}`)
    )
  })
}

/**
 * The message as it actually goes out: every rail back to the text it stands
 * for. A rail whose paste is gone is left exactly as it reads — visible in the
 * transcript rather than silently sending nothing where 900 lines should be.
 */
export function expandPastes(text: string, pastes: PastedText[]): string {
  return text.replace(RAIL, (rail) => {
    const n = Number(HEAD.exec(rail)?.[1])
    const body = pastes[n - 1]?.text
    return body ?? rail
  })
}

/** Where the nth paste's rail sits in the text, if it is still written there. */
export function pasteRailOf(
  text: string,
  n: number
): { start: number; end: number; n: number } | null {
  return rails(text).find((r) => r.n === n) ?? null
}
