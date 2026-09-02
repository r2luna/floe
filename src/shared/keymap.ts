// The keymap, as DATA.
//
// It used to be a function: a chain of `if (e.meta) { if (key === 't') …`. That
// made the rules testable, which was the point, but it also meant the app could
// not print its own bindings — and `~/.config/floe/keybindings.toml` has to ship
// with every default written out, or "delete a line to unbind" is meaningless.
//
// So the rules are a list now, and `resolveIn` walks it. FIRST MATCH WINS, which
// is how one chord does two jobs: `⌃J` moves down a stack when there is one and
// scrolls when there isn't, as two entries whose order decides which is tried
// first. The user's file is the same list, read back — so anything the defaults
// can express, a rebind can too.

export interface Resolved {
  id: string
  arg?: string
}

export interface KeyInput {
  key: string
  meta?: boolean
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
}

export interface KeyContext {
  /** Focus is in a text field, so bare letters are text, not commands. */
  typing?: boolean
  /** ⌘K was pressed and this key completes the chord. */
  chord?: boolean
  /** The kind of the focused panel — some bare keys only apply in a few. */
  kind?: string
  /** A line selection is open, which changes what Escape means. */
  selecting?: boolean
  /** A project is being moved between groups, so j/k carry it instead of the cursor. */
  moving?: boolean
  /** The palette is open: it owns the keyboard until it closes. */
  palette?: boolean
  /** There is a panel to move to below the focused one. */
  stackDown?: boolean
  /** There is a panel to move to above the focused one. */
  stackUp?: boolean
  /**
   * Focus is inside a panel that owns the raw keyboard — the drawing canvas.
   *
   * Stronger than `typing`, and deliberately a third state rather than a reuse
   * of it. The canvas has its own full keymap (`r` `o` `d` `a` `t` `v`, `⌘Z`),
   * so Floe has to stop eating bare keys entirely — including Escape, which
   * `typing` explicitly lets through so the composer can be left. See the rule
   * in resolveIn.
   */
  raw?: boolean
}

export interface Keybind {
  /** A chord (`cmd+shift+p`), or a two-step sequence (`cmd+k g`). */
  key: string
  command: string
  arg?: string
  /** A condition from the mini-language below. Absent means "whenever it applies". */
  when?: string
}

// ---------------------------------------------------------------------------
// Chords
// ---------------------------------------------------------------------------

// `super` rather than `cmd` is the canonical name for the Command/Windows key,
// so a keybindings.toml written on a Mac reads and works unchanged on Linux —
// where the same physical key is Super, and `cmd` would be the odd word out.
// The Mac spellings stay as aliases, so a file (or a habit) that says `cmd`
// keeps working; it just normalizes to `super` on the way in.
const MODIFIER_ORDER: Array<[keyof KeyInput, string]> = [
  ['meta', 'super'],
  ['ctrl', 'ctrl'],
  ['alt', 'alt'],
  ['shift', 'shift']
]

const MODIFIER_ALIASES: Record<string, string> = {
  cmd: 'super',
  meta: 'super',
  command: 'super',
  win: 'super',
  '⌘': 'super',
  control: 'ctrl',
  '⌃': 'ctrl',
  option: 'alt',
  opt: 'alt',
  '⌥': 'alt',
  '⇧': 'shift'
}

const HELD_ALONE = new Set(['meta', 'control', 'shift', 'alt', 'dead'])

/**
 * The chord a key press makes, or null when it isn't one yet.
 *
 * Unlike the old renderer helper, a bare letter IS a chord here — `j` has to be
 * expressible in the file, since it is a real binding. What stops a letter from
 * firing mid-sentence is the implicit `not typing` on modifier-less bindings,
 * not a rule about what counts as a chord.
 */
export function chordFor(e: KeyInput): string | null {
  const key = e.key.toLowerCase()
  if (HELD_ALONE.has(key)) return null
  const mods = MODIFIER_ORDER.filter(([flag]) => e[flag]).map(([, name]) => name)
  return [...mods, key].join('+')
}

/** Normalize a chord written by hand: alias the modifiers, put them in our order. */
export function normalizeChord(chord: string): string {
  return chord
    .trim()
    .split(/\s+/)
    .map((step) => {
      const parts = step.split('+').filter(Boolean)
      const key = (parts.pop() ?? '').toLowerCase()
      const mods = new Set(parts.map((p) => MODIFIER_ALIASES[p.toLowerCase()] ?? p.toLowerCase()))
      const ordered = MODIFIER_ORDER.map(([, name]) => name).filter((m) => mods.has(m))
      return [...ordered, key].join('+')
    })
    .join(' ')
}

const GLYPH: Record<string, string> = {
  ctrl: '⌃',
  alt: '⌥',
  shift: '⇧',
  super: '⌘',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  enter: '↵',
  escape: 'Esc',
  ' ': 'Space',
  space: 'Space',
  backspace: '⌫',
  tab: '⇥'
}

/**
 * `super+shift+p` → `⌘⇧P`.
 *
 * ponytail: the glyphs are the Mac ones. On Linux the Super key is not ⌘, so
 * this reads wrong there — the FILE is portable now, the display is the next
 * step, and it wants a platform check rather than a second glyph table here.
 */
export function formatChord(chord: string): string {
  // Normalized first, so a caller passing the Mac spelling out of habit still
  // gets a glyph instead of a silently dropped modifier.
  return normalizeChord(chord)
    .split(' ')
    .map((step) => {
      const parts = step.split('+')
      const key = parts[parts.length - 1]
      const mods = parts.slice(0, -1)
      const order = ['ctrl', 'alt', 'shift', 'super']
      return order.filter((m) => mods.includes(m)).map((m) => GLYPH[m]).join('') + (GLYPH[key] ?? key.toUpperCase())
    })
    .join(' ')
}

// Shift does NOT count. It is not a modifier you reach for, it is how you type
// a capital letter — so `shift+n` is still a bare letter, and still has to hold
// its fire while you are writing a message.
const hasModifier = (chord: string): boolean =>
  chord
    .split(' ')[0]
    .split('+')
    .slice(0, -1)
    .some((m) => m !== 'shift')

// ---------------------------------------------------------------------------
// `when`
// ---------------------------------------------------------------------------

export type WhenPredicate = (ctx: KeyContext) => boolean

const FLAGS: Record<string, (ctx: KeyContext) => boolean> = {
  typing: (ctx) => ctx.typing === true,
  selecting: (ctx) => ctx.selecting === true,
  moving: (ctx) => ctx.moving === true,
  'stack-below': (ctx) => ctx.stackDown === true,
  'stack-above': (ctx) => ctx.stackUp === true
}

export const WHEN_FLAGS = Object.keys(FLAGS)

/**
 * Compile a `when` expression.
 *
 * Deliberately small: flags, `panel ==` / `!=` / `in`, joined by `and`/`or` with
 * `not`, and `and` binding tighter. No parentheses — the moment a condition needs
 * them it is clearer as two entries, and a grammar with no nesting is one whose
 * error messages can stay specific.
 */
export function parseWhen(expr: string): { ok: true; predicate: WhenPredicate } | { ok: false; reason: string } {
  const tokens = tokenize(expr)
  if (!tokens) return { ok: false, reason: `unbalanced quotes in "${expr}"` }
  let i = 0

  const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })

  function primary(): WhenPredicate | string {
    if (tokens![i] === 'not') {
      i++
      const inner = primary()
      if (typeof inner === 'string') return inner
      return (ctx) => !inner(ctx)
    }
    const token = tokens![i++]
    if (token === undefined) return 'expected a condition'
    if (token === 'panel') {
      const op = tokens![i++]
      if (op === '==' || op === '!=') {
        const value = unquote(tokens![i++])
        if (value === null) return 'panel == expects a quoted panel kind'
        return (ctx) => (op === '==' ? ctx.kind === value : ctx.kind !== value)
      }
      if (op === 'in') {
        const values: string[] = []
        if (tokens![i++] !== '[') return 'panel in expects a list, like ["projects", "worktrees"]'
        while (tokens![i] !== ']') {
          if (i >= tokens!.length) return 'panel in expects a list, like ["projects", "worktrees"]'
          const value = unquote(tokens![i++])
          if (value !== null) values.push(value)
        }
        i++
        return (ctx) => values.includes(ctx.kind ?? '')
      }
      return 'panel expects ==, != or in'
    }
    const flag = FLAGS[token]
    if (!flag) return `unknown condition "${token}" — try ${WHEN_FLAGS.join(', ')} or panel`
    return flag
  }

  function andChain(): WhenPredicate | string {
    let left = primary()
    if (typeof left === 'string') return left
    while (tokens![i] === 'and') {
      i++
      const right = primary()
      if (typeof right === 'string') return right
      const l = left as WhenPredicate
      left = (ctx) => l(ctx) && right(ctx)
    }
    return left
  }

  let result = andChain()
  if (typeof result === 'string') return fail(result)
  while (tokens[i] === 'or') {
    i++
    const right = andChain()
    if (typeof right === 'string') return fail(right)
    const l = result as WhenPredicate
    result = (ctx) => l(ctx) || right(ctx)
  }
  if (i < tokens.length) return fail(`unexpected "${tokens[i]}"`)
  return { ok: true, predicate: result as WhenPredicate }
}

function tokenize(expr: string): string[] | null {
  const out: string[] = []
  let i = 0
  while (i < expr.length) {
    const ch = expr[i]
    if (/\s/.test(ch) || ch === ',') {
      i++
      continue
    }
    if (ch === '[' || ch === ']') {
      out.push(ch)
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      const end = expr.indexOf(ch, i + 1)
      if (end === -1) return null
      out.push(expr.slice(i, end + 1))
      i = end + 1
      continue
    }
    if (ch === '=' || ch === '!') {
      out.push(expr.slice(i, i + 2))
      i += 2
      continue
    }
    let j = i
    while (j < expr.length && !/[\s,[\]"'=!]/.test(expr[j])) j++
    out.push(expr.slice(i, j))
    i = j
  }
  return out
}

function unquote(token: string | undefined): string | null {
  if (!token) return null
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    return token.slice(1, -1)
  }
  return null
}

// ---------------------------------------------------------------------------
// Resolving
// ---------------------------------------------------------------------------

export interface CompiledBind {
  chord: string
  /** The tail of a sequence (`g` of `super+k g`), or null for a plain chord. */
  chordTail: string | null
  /**
   * The modifiers the sequence's FIRST step held, e.g. `super` for `super+k g`.
   *
   * They are allowed to still be down when the tail is pressed: nobody lets go
   * of Command between `⌘K` and `⌘G`, and every editor with chords accepts it.
   * Only these are forgiven — a `shift` the prefix never held still changes the
   * key, so `⌘K ⇧G` is not `⌘K G`.
   */
  holdable: string[]
  command: string
  arg?: string
  predicate: WhenPredicate | null
  /**
   * The chord (its first step, for a sequence) holds a modifier.
   *
   * What survives `raw`: a panel that owns the keyboard gets every bare key,
   * and Floe keeps the chords that get you back out (`⌃H`/`⌃L`, `⌘K`, `⌘1`–`⌘9`,
   * `⌘W`). Positional, so no existing binding had to be edited to say so.
   */
  modified: boolean
}

/**
 * Turn bindings into something a key press can be matched against.
 *
 * The implicit `not typing` on modifier-less bindings is applied here, once, so
 * neither the default table nor the user's file has to spell it out on every
 * bare letter — and so a binding that DOES want to fire while typing (Escape)
 * gets it by naming `typing` itself.
 */
export function compileKeymap(binds: Keybind[]): CompiledBind[] {
  const out: CompiledBind[] = []
  for (const bind of binds) {
    const chord = normalizeChord(bind.key)
    const steps = chord.split(' ')
    let predicate: WhenPredicate | null = null
    if (bind.when) {
      const parsed = parseWhen(bind.when)
      if (parsed.ok) predicate = parsed.predicate
      else continue // validated before it gets here; a bad one is dropped, not guessed at
    }
    if (!hasModifier(chord) && !/\btyping\b/.test(bind.when ?? '')) {
      const inner = predicate
      predicate = inner ? (ctx) => !ctx.typing && inner(ctx) : (ctx) => !ctx.typing
    }
    out.push({
      chord,
      chordTail: steps.length > 1 ? steps[steps.length - 1] : null,
      holdable: steps.length > 1 ? steps[0].split('+').slice(0, -1) : [],
      command: bind.command,
      arg: bind.arg,
      predicate,
      modified: hasModifier(chord)
    })
  }
  return out
}

/** Drop `mods` from a chord, so a still-held Command does not spoil the match. */
function withoutMods(chord: string, mods: string[]): string {
  if (!mods.length) return chord
  const parts = chord.split('+')
  const key = parts.pop() ?? ''
  return [...parts.filter((m) => !mods.includes(m)), key].join('+')
}

/**
 * What this press means under these bindings, or null.
 *
 * Three rules live here rather than in the table, because none is the user's to
 * change: an open palette owns the keyboard; a pending chord swallows the next
 * key whatever it is — an unmapped one cancels rather than leaking through as a
 * normal binding; and under `raw` only chords with a modifier resolve.
 *
 * That last one is positional on purpose. A `not raw` written onto each bare
 * letter would leave the one binding that names `typing` — Escape, which is
 * `activeElement.blur()` — still firing, and inside a canvas's text editor
 * `typing` and `raw` are true at once, so Escape would blur you mid-word. Read
 * off the chord instead, it cannot be escaped by naming a flag.
 */
export function resolveIn(keymap: CompiledBind[], e: KeyInput, ctx: KeyContext = {}): Resolved | null {
  if (ctx.palette) return null
  const chord = chordFor(e)
  if (chord === null) return null
  for (const bind of keymap) {
    if (ctx.raw && !bind.modified) continue
    const hit = ctx.chord
      ? bind.chordTail !== null && withoutMods(chord, bind.holdable) === bind.chordTail
      : bind.chordTail === null && bind.chord === chord
    if (!hit) continue
    if (bind.predicate && !bind.predicate(ctx)) continue
    return bind.arg === undefined ? { id: bind.command } : { id: bind.command, arg: bind.arg }
  }
  return null
}
