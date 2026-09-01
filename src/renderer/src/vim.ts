// Vim motions for the composer.
//
// A pure state machine over (text, selection, mode): every key in, a new text
// and selection out. No DOM, so the whole grammar is testable without a
// textarea — the Composer only feeds it keys and applies what comes back.
//
// This is the editing subset, not an editor: motions, operators, registers of
// one, and an undo stack. Deliberately absent are marks, macros, named
// registers, search and ex commands — a message box is not a buffer, and every
// one of those would be a key stolen from a chat that already uses it.

export type VimMode = 'insert' | 'normal' | 'visual'

/** A snapshot the undo stack can restore. */
interface Snap {
  text: string
  at: number
}

export interface VimState {
  mode: VimMode
  /** Keys typed toward a command that is not finished yet: `2d`, `f`, `g`. */
  pending: string
  /** Where visual mode started, where it now ends, and whether it takes whole
      lines. `head` is tracked rather than read back off the selection: a
      linewise selection has been widened to line edges and no longer says which
      end the cursor is on. */
  anchor: number
  head: number
  linewise: boolean
  /**
   * The column j and k are aiming for.
   *
   * Vim remembers the column you left, so walking down through a short line and
   * out the other side puts you back where you started — recomputing it from
   * the clamped position instead would drag the cursor left, one line at a time.
   */
  col: number | null
  /** The unnamed register — what `y`, `d` and `x` left for `p`. */
  clip: string
  clipLines: boolean
  undo: Snap[]
  redo: Snap[]
}

/** The text and where the caret (or selection) sits in it. */
export interface Doc {
  text: string
  start: number
  end: number
}

export interface VimResult extends Doc {
  state: VimState
}

export interface VimKey {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

export const vimStart = (mode: VimMode = 'insert'): VimState => ({
  mode,
  pending: '',
  anchor: 0,
  head: 0,
  linewise: false,
  col: null,
  clip: '',
  clipLines: false,
  undo: [],
  redo: []
})

/** How deep the undo stack goes. A composer draft is short; this is plenty. */
const UNDOS = 100

const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n'
const isWord = (c: string): boolean => /[A-Za-z0-9_]/.test(c)

/** 0 whitespace, 1 word, 2 punctuation — and for WORDs, everything is 1. */
const klass = (c: string, big: boolean): number =>
  isSpace(c) ? 0 : big || isWord(c) ? 1 : 2

export const lineStart = (text: string, i: number): number => text.lastIndexOf('\n', i - 1) + 1
export const lineEnd = (text: string, i: number): number => {
  const at = text.indexOf('\n', i)
  return at === -1 ? text.length : at
}

const firstNonBlank = (text: string, i: number): number => {
  const s = lineStart(text, i)
  const e = lineEnd(text, i)
  let at = s
  while (at < e && (text[at] === ' ' || text[at] === '\t')) at++
  return at
}

/**
 * Normal mode sits ON a character, never past the end of the line.
 *
 * The one exception is an empty line, which has no character to sit on — there
 * the caret rests on the newline itself, exactly as vim does.
 */
export function clampNormal(text: string, i: number): number {
  const s = lineStart(text, i)
  const e = lineEnd(text, i)
  return Math.max(s, Math.min(i, Math.max(s, e - 1)))
}

function wordFwd(text: string, i: number, big: boolean): number {
  const n = text.length
  if (i >= n) return n
  const k = klass(text[i], big)
  let at = i
  if (k !== 0) while (at < n && klass(text[at], big) === k) at++
  while (at < n && isSpace(text[at])) at++
  return at
}

function wordBack(text: string, i: number, big: boolean): number {
  let at = i - 1
  while (at > 0 && isSpace(text[at])) at--
  if (at <= 0) return 0
  const k = klass(text[at], big)
  while (at > 0 && klass(text[at - 1], big) === k) at--
  return Math.max(0, at)
}

/** `e`: the last character of the word ahead — an inclusive target. */
function wordEndFwd(text: string, i: number, big: boolean): number {
  const n = text.length
  let at = i + 1
  while (at < n && isSpace(text[at])) at++
  if (at >= n) return n - 1
  const k = klass(text[at], big)
  while (at + 1 < n && klass(text[at + 1], big) === k) at++
  return at
}

/** `}` / `{`: the next or previous blank line. */
function para(text: string, i: number, back: boolean): number {
  let at = back ? lineStart(text, i) : lineEnd(text, i)
  for (;;) {
    const nextLine = back ? lineStart(text, at - 1) : at + 1
    if (back ? at <= 0 : at >= text.length) return back ? 0 : text.length
    at = nextLine
    const s = lineStart(text, at)
    if (s === lineEnd(text, at)) return s
    if (!back) at = lineEnd(text, at)
    else at = s
  }
}

/** A resolved motion: where it lands, and how an operator spans it. */
interface Motion {
  to: number
  /** The target character is part of the span (`e`, `f`, `G`). */
  inclusive?: boolean
  /** Whole lines, however the columns fall (`dd`, `G`, `gg`). */
  lines?: boolean
  /** The column to keep aiming for — j and k only. */
  col?: number
}

/**
 * Resolve one motion key against the document.
 *
 * `arg` carries the character a two-key motion is waiting on — the target of
 * `f`, `F`, `t`, `T`, or the second `g` of `gg`.
 */
function motion(
  key: string,
  count: number,
  doc: Doc,
  at: number,
  arg?: string,
  want?: number | null
): Motion | null {
  const { text } = doc
  const n = text.length
  const rep = <T>(f: (i: number) => T, i: number): T => {
    let out = i as unknown as T
    for (let k = 0; k < count; k++) out = f(out as unknown as number)
    return out
  }

  switch (key) {
    case 'h':
    case 'ArrowLeft':
      return { to: Math.max(lineStart(text, at), at - count) }
    case 'l':
    case ' ':
    case 'ArrowRight':
      return { to: Math.min(lineEnd(text, at), at + count) }
    case 'w':
    case 'W':
      return { to: rep((i) => wordFwd(text, i, key === 'W'), at) }
    case 'b':
    case 'B':
      return { to: rep((i) => wordBack(text, i, key === 'B'), at) }
    case 'e':
    case 'E':
      return { to: rep((i) => wordEndFwd(text, i, key === 'E'), at), inclusive: true }
    case '0':
      return { to: lineStart(text, at) }
    case '^':
      return { to: firstNonBlank(text, at) }
    case '$': {
      let i = at
      for (let k = 1; k < count; k++) i = Math.min(n, lineEnd(text, i) + 1)
      return { to: lineEnd(text, i), inclusive: false }
    }
    case 'j':
    case 'k':
    case 'ArrowDown':
    case 'ArrowUp': {
      // Column-preserving, the way j/k are supposed to be: the offset into the
      // line travels, and lands clamped on a shorter one.
      const back = key === 'k' || key === 'ArrowUp'
      const col = want ?? at - lineStart(text, at)
      let i = at
      for (let k = 0; k < count; k++) {
        if (back) {
          const s = lineStart(text, i)
          if (s === 0) break
          i = lineStart(text, s - 1)
        } else {
          const e = lineEnd(text, i)
          if (e >= n) break
          i = e + 1
        }
      }
      const s = lineStart(text, i)
      return { to: Math.min(s + col, lineEnd(text, i)), lines: true, col }
    }
    case 'G': {
      const to = count > 1 ? nthLine(text, count) : lineStart(text, n)
      return { to: firstNonBlank(text, to), lines: true }
    }
    case 'g':
      if (arg !== 'g') return null
      return { to: firstNonBlank(text, nthLine(text, count > 1 ? count : 1)), lines: true }
    case '{':
    case '}':
      return { to: para(text, at, key === '{'), lines: false }
    case 'f':
    case 'F':
    case 't':
    case 'T': {
      if (!arg) return null
      const back = key === 'F' || key === 'T'
      const till = key === 't' || key === 'T'
      let i = at
      for (let k = 0; k < count; k++) {
        const found = back ? text.lastIndexOf(arg, Math.max(0, i - 1)) : text.indexOf(arg, i + 1)
        // A find never crosses the line it started on.
        if (found === -1 || found < lineStart(text, at) || found > lineEnd(text, at)) return null
        i = found
      }
      if (till) i += back ? 1 : -1
      return { to: i, inclusive: !back }
    }
    default:
      return null
  }
}

/** The start of line `n`, counting from 1. */
function nthLine(text: string, n: number): number {
  let at = 0
  for (let k = 1; k < n; k++) {
    const e = lineEnd(text, at)
    if (e >= text.length) return at
    at = e + 1
  }
  return at
}

/** Widen a span to the whole lines it touches, newline included. */
function toLines(text: string, from: number, to: number): [number, number] {
  const s = lineStart(text, Math.min(from, to))
  const e = lineEnd(text, Math.max(from, to))
  return [s, Math.min(text.length, e + 1)]
}

const push = (stack: Snap[], snap: Snap): Snap[] => [...stack, snap].slice(-UNDOS)

/** The pairs `i(`, `a[`, `i"` … understand, by either of their names. */
const PAIRS: Record<string, [string, string]> = {
  '(': ['(', ')'],
  ')': ['(', ')'],
  b: ['(', ')'],
  '[': ['[', ']'],
  ']': ['[', ']'],
  '{': ['{', '}'],
  '}': ['{', '}'],
  B: ['{', '}'],
  '<': ['<', '>'],
  '>': ['<', '>']
}
const QUOTES = ['"', "'", '`']

/**
 * `iw`, `aw`, `i"`, `a(` … — the span a text object covers.
 *
 * These are the reason vim is worth having in a message box: `ciw` on the word
 * you mistyped and `ci"` inside the string you pasted are two keys where a
 * plain textarea is a hunt with the arrows.
 */
function textObject(kind: 'i' | 'a', key: string, text: string, at: number): [number, number] | null {
  if (key === 'w' || key === 'W') {
    const big = key === 'W'
    if (at >= text.length) return null
    const k = klass(text[at], big)
    let s = at
    let e = at
    while (s > 0 && klass(text[s - 1], big) === k && text[s - 1] !== '\n') s--
    while (e + 1 < text.length && klass(text[e + 1], big) === k && text[e + 1] !== '\n') e++
    e += 1
    if (kind === 'a') {
      let after = e
      while (after < text.length && (text[after] === ' ' || text[after] === '\t')) after++
      if (after > e) return [s, after]
      // No trailing space to take, so take the leading one instead — vim's rule.
      while (s > 0 && (text[s - 1] === ' ' || text[s - 1] === '\t')) s--
    }
    return [s, e]
  }

  const ls = lineStart(text, at)
  const le = lineEnd(text, at)

  if (QUOTES.includes(key)) {
    // Quotes have no nesting to count: pair them off from the start of the line
    // and take the pair the cursor is inside of, or the next one along.
    const marks: number[] = []
    for (let i = ls; i < le; i++) if (text[i] === key && text[i - 1] !== '\\') marks.push(i)
    for (let i = 0; i + 1 < marks.length; i += 2) {
      const [open, close] = [marks[i], marks[i + 1]]
      if (at <= close) return kind === 'i' ? [open + 1, close] : [open, close + 1]
    }
    return null
  }

  const pair = PAIRS[key]
  if (!pair) return null
  const [open, close] = pair
  // Count depth outwards, so the inner pair wins when they nest.
  let depth = 0
  let from = -1
  for (let i = at; i >= 0; i--) {
    if (text[i] === close && i !== at) depth++
    else if (text[i] === open) {
      if (depth === 0) {
        from = i
        break
      }
      depth--
    }
  }
  if (from === -1) return null
  depth = 0
  let to = -1
  for (let i = from + 1; i < text.length; i++) {
    if (text[i] === open) depth++
    else if (text[i] === close) {
      if (depth === 0) {
        to = i
        break
      }
      depth--
    }
  }
  if (to === -1) return null
  return kind === 'i' ? [from + 1, to] : [from, to + 1]
}

/**
 * One key, one step of the machine.
 *
 * `null` means "not mine" — the composer then does whatever it would have done
 * without vim: Enter still sends, ⌘L still links, ↑ still walks the history.
 */
export function vimKey(ev: VimKey, doc: Doc, state: VimState): VimResult | null {
  const { text } = doc
  const chord = ev.metaKey || ev.altKey || ev.ctrlKey
  const redoKey = ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key.toLowerCase() === 'r'
  const key = ev.key

  // Insert mode is a plain textarea with one key attached to it.
  if (state.mode === 'insert') {
    if (key !== 'Escape' || chord) return null
    const back = clampNormal(text, Math.max(0, doc.start - 1))
    return place(text, back, { ...state, mode: 'normal', pending: '', linewise: false })
  }

  if (chord && !redoKey) return null
  // Modifier keys on their own, and the named keys we have no answer for.
  const NAMED = ['Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Backspace']
  if (key.length > 1 && !NAMED.includes(key)) return null

  const visual = state.mode === 'visual'
  const cursor = visual ? state.head : clampNormal(text, doc.start)
  const parts = state.pending.match(/^(\d*)([dcy]?)(.*)$/)
  const count = Math.max(1, Number(parts?.[1] || 1))
  const op = parts?.[2] ?? ''
  const tail = parts?.[3] ?? ''
  const stay = (pending: string): VimResult => place(text, cursor, { ...state, pending })
  const clear = (over: Partial<VimState> = {}): VimResult =>
    place(text, cursor, { ...state, pending: '', ...over })

  // ---- a key an unfinished command was waiting on -------------------------
  if (tail === 'r' && key.length === 1) {
    if (cursor >= text.length || text[cursor] === '\n') return clear()
    const out = text.slice(0, cursor) + key + text.slice(cursor + 1)
    return place(out, cursor, {
      ...state,
      pending: '',
      undo: push(state.undo, { text, at: cursor }),
      redo: []
    })
  }
  if ('fFtT'.includes(tail) && tail.length === 1 && key.length === 1) {
    const m = motion(tail, count, doc, cursor, key)
    if (!m) return clear()
    return move(m, doc, { ...state, pending: '' }, cursor, op)
  }
  if ((tail === 'i' || tail === 'a') && key.length === 1) {
    const span = textObject(tail, key, text, cursor)
    if (!span) return clear()
    if (visual) return place(text, span[1] - 1, { ...state, anchor: span[0], pending: '', linewise: false })
    return apply(op || 'd', text, span[0], span[1], false, { ...state, pending: '' }, cursor)
  }
  if (tail && key === 'Escape') return clear()

  // ---- counts -------------------------------------------------------------
  if (/[1-9]/.test(key) || (key === '0' && parts?.[1])) return stay(state.pending + key)

  if (key === 'Escape') {
    if (visual) return place(text, clampNormal(text, cursor), { ...state, mode: 'normal', pending: '', linewise: false })
    // A half-typed command is what Escape cancels here. With nothing pending it
    // is not ours: Escape still belongs to whatever panel or menu is open.
    return state.pending ? clear() : null
  }

  // ---- operators, text objects, and the second `g` ------------------------
  if (key === 'g' && tail !== 'g') {
    if (tail === '') return stay(state.pending + 'g')
  }
  if (tail === 'g' && key === 'g') {
    const m = motion('g', count, doc, cursor, 'g')
    if (!m) return clear()
    return move(m, doc, { ...state, pending: '' }, cursor, op)
  }
  if (!visual && !op && 'dcy'.includes(key) && !tail) return stay(state.pending + key)
  if (!visual && op && key === op && !tail) {
    // dd / cc / yy — this line and the count-1 below it, whole.
    const [s, e] = toLines(text, cursor, downN(text, cursor, count - 1))
    return apply(op, text, s, e, true, { ...state, pending: '' }, cursor)
  }
  if ((op || visual) && (key === 'i' || key === 'a') && !tail) return stay(state.pending + key)

  // ---- undo and redo ------------------------------------------------------
  if (!visual && !op && key === 'u') {
    const last = state.undo[state.undo.length - 1]
    if (!last) return clear()
    return place(last.text, clampNormal(last.text, last.at), {
      ...state,
      pending: '',
      mode: 'normal',
      undo: state.undo.slice(0, -1),
      redo: push(state.redo, { text, at: cursor })
    })
  }
  if (redoKey) {
    const next = state.redo[state.redo.length - 1]
    if (!next) return clear()
    return place(next.text, clampNormal(next.text, next.at), {
      ...state,
      pending: '',
      mode: 'normal',
      undo: push(state.undo, { text, at: cursor }),
      redo: state.redo.slice(0, -1)
    })
  }

  // ---- whole commands of one key -----------------------------------------
  if (!op) {
    const done = single(key, count, doc, { ...state, pending: '' }, cursor, visual)
    if (done) return done
  }

  // ---- motions ------------------------------------------------------------
  if ('fFtT'.includes(key)) return stay(state.pending + key)
  // `cw` on a word changes to the END of it, not to the start of the next —
  // vim's own exception, and the reason cw does not eat the space after it.
  const asEnd = op === 'c' && (key === 'w' || key === 'W') && !!text[cursor] && !isSpace(text[cursor])
  const m = motion(asEnd ? (key === 'w' ? 'e' : 'E') : key, count, doc, cursor, undefined, state.col)
  if (!m) return state.pending ? clear() : null
  return move(m, doc, { ...state, pending: '' }, cursor, op)
}

/** `count` lines down from here, clamped to the last one. */
function downN(text: string, at: number, count: number): number {
  let i = at
  for (let k = 0; k < count; k++) {
    const e = lineEnd(text, i)
    if (e >= text.length) break
    i = e + 1
  }
  return i
}

/**
 * Where normal mode's block sits for a caret at `at` — the character it is on.
 *
 * Normal mode shows its cursor by SELECTING that character: a textarea has no
 * block caret, and a one-character selection is the only thing that reads as
 * "you are ON this letter" rather than between two of them. Exported because
 * the composer needs it after a click, too.
 */
export function blockAt(text: string, at: number): { start: number; end: number } {
  const c = clampNormal(text, Math.max(0, Math.min(text.length, at)))
  const wide = c < text.length && text[c] !== '\n'
  return { start: c, end: wide ? c + 1 : c }
}

/** Put the cursor down in whatever mode we ended in. */
function place(text: string, at: number, state: VimState): VimResult {
  if (state.mode === 'insert') {
    const i = Math.max(0, Math.min(text.length, at))
    return { text, start: i, end: i, state }
  }
  if (state.mode === 'visual') {
    state = { ...state, head: at }
    const [s, e] = state.linewise
      ? toLines(text, state.anchor, at)
      : [Math.min(state.anchor, at), Math.max(state.anchor, at) + 1]
    return { text, start: Math.max(0, s), end: Math.min(text.length, e), state }
  }
  const block = blockAt(text, at)
  return { text, ...block, state }
}

/** Run a motion — to move, or as the span of the operator waiting on it. */
function move(m: Motion, doc: Doc, state: VimState, cursor: number, op: string): VimResult {
  const { text } = doc
  state = { ...state, col: m.col ?? null }
  if (!op) return place(text, m.to, state)
  let from = Math.min(cursor, m.to)
  let to = Math.max(cursor, m.to)
  if (m.inclusive) to += 1
  let lines = false
  if (m.lines) {
    ;[from, to] = toLines(text, from, to)
    lines = true
  }
  return apply(op, text, from, to, lines, state, cursor)
}

/** Cut, copy or change a span, and land where vim lands afterwards. */
function apply(
  op: string,
  text: string,
  from: number,
  to: number,
  lines: boolean,
  state: VimState,
  cursor: number
): VimResult {
  const taken = text.slice(from, to)
  const next: VimState = {
    ...state,
    pending: '',
    mode: 'normal',
    linewise: false,
    col: null,
    clip: taken,
    clipLines: lines
  }
  // Yank leaves the text alone and the cursor at the start of what it took.
  if (op === 'y') return place(text, Math.min(cursor, from), next)

  // Undo lands at the START of what was taken, not at the end the cursor
  // happened to be on — that is where the text comes back.
  const edited: VimState = {
    ...next,
    undo: push(state.undo, { text, at: Math.min(cursor, from) }),
    redo: []
  }
  if (op === 'c' && lines) {
    // `cc` empties the line and keeps it — changing a line is not deleting it.
    const kept = text.slice(0, from) + '\n' + text.slice(to)
    return place(kept, from, { ...edited, mode: 'insert' })
  }
  const out = text.slice(0, from) + text.slice(to)
  if (op === 'c') return place(out, from, { ...edited, mode: 'insert' })
  return place(out, from, edited)
}

/**
 * The keys that are a whole command by themselves.
 *
 * `null` for anything that is not one, so the caller can try it as a motion.
 */
function single(
  key: string,
  count: number,
  doc: Doc,
  state: VimState,
  cursor: number,
  visual: boolean
): VimResult | null {
  const { text } = doc
  const snap = { text, at: cursor }
  const writing = (over: Partial<VimState>): VimState => ({
    ...state,
    linewise: false,
    col: null,
    ...over,
    undo: push(state.undo, snap),
    redo: []
  })
  /** The visual selection as a span — what every operator below works on. */
  const span = (): [number, number] =>
    state.linewise ? toLines(text, state.anchor, cursor) : [doc.start, doc.end]

  if (visual) {
    switch (key) {
      case 'v':
        return place(text, cursor, { ...state, mode: 'normal', linewise: false })
      case 'V':
        return place(text, cursor, { ...state, linewise: !state.linewise })
      case 'd':
      case 'x':
      case 'y':
      case 'c':
      case 's': {
        const [s, e] = span()
        const as = key === 'x' ? 'd' : key === 's' ? 'c' : key
        return apply(as, text, s, e, state.linewise, state, cursor)
      }
      case 'p': {
        if (!state.clip) return place(text, cursor, state)
        const [s, e] = span()
        const out = text.slice(0, s) + state.clip + text.slice(e)
        return place(out, s + Math.max(0, state.clip.length - 1), writing({ mode: 'normal' }))
      }
      default:
        return null
    }
  }

  const intoInsert = (at: number): VimResult =>
    place(text, at, writing({ mode: 'insert' }))

  switch (key) {
    case 'i':
      return intoInsert(cursor)
    case 'a':
      return intoInsert(Math.min(lineEnd(text, cursor), cursor + 1))
    case 'I':
      return intoInsert(firstNonBlank(text, cursor))
    case 'A':
      return intoInsert(lineEnd(text, cursor))
    case 'o':
    case 'O': {
      const at = key === 'o' ? lineEnd(text, cursor) : lineStart(text, cursor)
      const out = text.slice(0, at) + '\n' + text.slice(at)
      return place(out, at + (key === 'o' ? 1 : 0), writing({ mode: 'insert' }))
    }
    case 'v':
      return place(text, cursor, { ...state, mode: 'visual', anchor: cursor, head: cursor, linewise: false })
    case 'V':
      return place(text, cursor, { ...state, mode: 'visual', anchor: cursor, head: cursor, linewise: true })
    case 'x':
    case 'Backspace': {
      if (cursor >= text.length || text[cursor] === '\n') return place(text, cursor, state)
      return apply('d', text, cursor, Math.min(lineEnd(text, cursor), cursor + count), false, state, cursor)
    }
    case 'X': {
      const from = Math.max(lineStart(text, cursor), cursor - count)
      if (from === cursor) return place(text, cursor, state)
      return apply('d', text, from, cursor, false, state, cursor)
    }
    case 'D':
      return apply('d', text, cursor, lineEnd(text, cursor), false, state, cursor)
    case 'C':
      return apply('c', text, cursor, lineEnd(text, cursor), false, state, cursor)
    case 'Y': {
      const [s, e] = toLines(text, cursor, downN(text, cursor, count - 1))
      return apply('y', text, s, e, true, state, cursor)
    }
    case 's':
      return apply('c', text, cursor, Math.min(lineEnd(text, cursor), cursor + count), false, state, cursor)
    case 'S': {
      const [s, e] = toLines(text, cursor, downN(text, cursor, count - 1))
      return apply('c', text, s, e, true, state, cursor)
    }
    case 'r':
      return place(text, cursor, { ...state, pending: `${count > 1 ? count : ''}r` })
    case 'J': {
      // Join the next line onto this one, with the single space vim leaves.
      const e = lineEnd(text, cursor)
      if (e >= text.length) return place(text, cursor, state)
      let cut = e + 1
      while (cut < text.length && (text[cut] === ' ' || text[cut] === '\t')) cut++
      const out = text.slice(0, e) + ' ' + text.slice(cut)
      return place(out, e, writing({}))
    }
    case 'p':
    case 'P': {
      if (!state.clip) return null
      if (state.clipLines) {
        const body = state.clip.endsWith('\n') ? state.clip : `${state.clip}\n`
        const end = lineEnd(text, cursor)
        if (key === 'p' && end >= text.length) {
          // The last line has no newline to paste after, so the newline goes in
          // FRONT of the copy — otherwise the line lands glued to this one.
          const out = `${text.slice(0, end)}\n${body.slice(0, -1)}`
          return place(out, end + 1, writing({}))
        }
        const at = key === 'p' ? end + 1 : lineStart(text, cursor)
        const out = text.slice(0, at) + body + text.slice(at)
        return place(out, at, writing({}))
      }
      const at = key === 'p' ? Math.min(lineEnd(text, cursor) + 1, cursor + 1) : cursor
      const out = text.slice(0, at) + state.clip + text.slice(at)
      return place(out, at + Math.max(0, state.clip.length - 1), writing({}))
    }
    default:
      return null
  }
}
