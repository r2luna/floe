// Reading and — the harder half — WRITING the user's TOML config.
//
// Every config file Floe owns is documented in place: each block carries a
// Laravel-style comment explaining what it does, because the file is meant to be
// read and edited by hand (and by agents). That makes serialization the wrong
// tool for saving a change. Round-tripping a parsed document through a
// stringifier would emit correct TOML and throw away every comment, every blank
// line and the key order the moment the user flips one toggle in Settings.
//
// So writes here are SURGICAL: find the line the key is on, replace the value
// token, leave the rest of the bytes exactly as they were. Full serialization
// happens only when a file is generated from scratch.

import { parse as parseTomlRaw } from 'smol-toml'

export type TomlScalar = string | number | boolean
/** An inline table — `{ key = "value" }`, one line, so surgical writes still work. */
export type TomlTable = Record<string, TomlScalar>
export type TomlValue = TomlScalar | TomlScalar[] | TomlTable

export interface TomlParseError {
  line: number
  column: number
  message: string
}

/**
 * Parse, without throwing.
 *
 * Config parsing is never allowed to take the app down — a typo in
 * `keybindings.toml` must degrade to "defaults, plus an error in Settings", so
 * every caller gets a result it has to look at rather than an exception it can
 * forget to catch.
 */
export function parseToml<T = Record<string, unknown>>(
  raw: string
): { ok: true; value: T } | { ok: false; error: TomlParseError } {
  try {
    return { ok: true, value: parseTomlRaw(raw) as T }
  } catch (err) {
    const e = err as { line?: number; column?: number; message?: string }
    return {
      ok: false,
      error: {
        line: typeof e.line === 'number' ? e.line : 1,
        column: typeof e.column === 'number' ? e.column : 1,
        message: e.message ?? String(err)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Formatting values
// ---------------------------------------------------------------------------

function formatString(s: string): string {
  // Basic strings only. A literal string ('…') can't express an escape, and
  // guessing which form the user "meant" is not worth the branch.
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}

/** A bare key where TOML allows one, quoted where it does not. */
const formatKey = (key: string): string => (/^[A-Za-z0-9_-]+$/.test(key) ? key : formatString(key))

export function formatValue(value: TomlValue): string {
  if (Array.isArray(value)) return `[${value.map((v) => formatValue(v)).join(', ')}]`
  if (value !== null && typeof value === 'object') {
    const body = Object.entries(value)
      .map(([k, v]) => `${formatKey(k)} = ${formatValue(v)}`)
      .join(', ')
    return `{ ${body} }`
  }
  if (typeof value === 'string') return formatString(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (!Number.isFinite(value)) throw new Error(`cannot write non-finite number to TOML: ${value}`)
  return String(value)
}

// ---------------------------------------------------------------------------
// Scanning the raw document
// ---------------------------------------------------------------------------

/**
 * One table in the document, located by line.
 *
 * `end` is exclusive and stops at the next header, so a section owns the blank
 * lines and comments that trail it — which is what makes "append a key at the
 * end of this table" land in the right place.
 */
interface Section {
  /** Dotted header name; null for the document's root table. */
  header: string | null
  /** `[[array]]` rather than `[table]`. */
  isArray: boolean
  /** Which `[[array]]` entry this is, counting from 0. Always 0 for a table. */
  index: number
  /** Line the header is on; -1 for the root table. */
  headerLine: number
  start: number
  end: number
}

const HEADER = /^\s*(\[\[?)\s*([^\]]+?)\s*(\]\]?)\s*(?:#.*)?$/

/**
 * Split the document into sections.
 *
 * Multi-line basic strings are tracked because a `[header]` sitting inside one
 * is text, not a header, and mistaking it would silently retarget every write
 * after it.
 */
function scanSections(lines: string[]): Section[] {
  const out: Section[] = []
  const counts = new Map<string, number>()
  let current: Section = { header: null, isArray: false, index: 0, headerLine: -1, start: 0, end: lines.length }
  let inMultiline: '"""' | "'''" | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (inMultiline) {
      if (line.includes(inMultiline)) inMultiline = null
      continue
    }
    const opened = openedMultiline(line)
    if (opened) {
      inMultiline = opened
      continue
    }
    const m = HEADER.exec(line)
    if (!m) continue
    const isArray = m[1] === '[[' && m[3] === ']]'
    if (m[1].length !== m[3].length) continue // `[foo]]` — malformed, let the parser complain
    current.end = i
    out.push(current)
    const header = m[2]
    const key = (isArray ? '[[' : '[') + header
    const index = isArray ? counts.get(key) ?? 0 : 0
    counts.set(key, index + 1)
    current = { header, isArray, index, headerLine: i, start: i + 1, end: lines.length }
  }
  out.push(current)
  return out
}

/** Which multi-line delimiter this line leaves open, if any. */
function openedMultiline(line: string): '"""' | "'''" | null {
  for (const delim of ['"""', "'''"] as const) {
    const first = line.indexOf(delim)
    if (first === -1) continue
    // An odd number of delimiters leaves the string open across the line break.
    const count = line.split(delim).length - 1
    if (count % 2 === 1) return delim
  }
  return null
}

const KEY_LINE = /^(\s*)((?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*)(\s*)=(\s*)/

interface KeyLocation {
  line: number
  /** Column where the value starts on `line`. */
  valueStart: number
  /** Line the value ends on — different from `line` for a multi-line array. */
  endLine: number
  /** Column just past the value on `endLine`. */
  valueEnd: number
}

/** Strip TOML quoting from a bare/quoted key so `"font-size"` matches `font-size`. */
function unquoteKey(key: string): string {
  const k = key.trim()
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) return k.slice(1, -1)
  return k
}

/**
 * Where a value ends, respecting strings and nesting.
 *
 * The naive version — cut the line at the first `#` — corrupts any value that
 * contains one, and `command = "grep '#' src"` is exactly the kind of line this
 * file is full of.
 */
function valueSpan(lines: string[], line: number, col: number): { endLine: number; endCol: number } {
  let depth = 0
  let i = line
  let j = col
  let inString: '"' | "'" | null = null

  while (i < lines.length) {
    const text = lines[i]
    if (j >= text.length) {
      // Only an unclosed bracket carries a value onto the next line.
      if (depth === 0 && !inString) return { endLine: i, endCol: trimEnd(text, text.length) }
      i++
      j = 0
      continue
    }
    const ch = text[j]
    if (inString) {
      if (inString === '"' && ch === '\\') {
        j += 2
        continue
      }
      if (ch === inString) inString = null
      j++
      continue
    }
    if (ch === '"' || ch === "'") {
      // A triple quote opens a multi-line string, whose body can contain
      // anything at all — including a line that looks like a `[header]`.
      const triple = ch.repeat(3)
      if (text.startsWith(triple, j)) {
        const close = findClosing(lines, i, j + 3, triple)
        i = close.line
        j = close.col
        continue
      }
      inString = ch
      j++
      continue
    }
    if (ch === '[' || ch === '{') {
      depth++
      j++
      continue
    }
    if (ch === ']' || ch === '}') {
      depth--
      j++
      if (depth === 0) return { endLine: i, endCol: j }
      continue
    }
    // Outside any bracket, a comment ends the value.
    if (depth === 0 && ch === '#') return { endLine: i, endCol: trimEnd(text, j) }
    j++
  }
  return { endLine: lines.length - 1, endCol: lines[lines.length - 1]?.length ?? 0 }
}

/** Walk forward to just past `delim`, across lines. */
function findClosing(lines: string[], line: number, col: number, delim: string): { line: number; col: number } {
  let i = line
  let j = col
  while (i < lines.length) {
    const at = lines[i].indexOf(delim, j)
    if (at !== -1) return { line: i, col: at + delim.length }
    i++
    j = 0
  }
  return { line: lines.length - 1, col: lines[lines.length - 1]?.length ?? 0 }
}

/** Back up over trailing whitespace, so a replaced value doesn't leave a gap before its comment. */
function trimEnd(text: string, end: number): number {
  let e = end
  while (e > 0 && /\s/.test(text[e - 1])) e--
  return e
}

/** Find `key` inside `section`, skipping comments, blanks and nested values. */
function findKey(lines: string[], section: Section, key: string): KeyLocation | null {
  let i = section.start
  while (i < section.end) {
    const text = lines[i]
    const trimmed = text.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      i++
      continue
    }
    const m = KEY_LINE.exec(text)
    if (!m) {
      i++
      continue
    }
    const valueStart = m[0].length
    const span = valueSpan(lines, i, valueStart)
    if (unquoteKey(m[2]) === key) {
      return { line: i, valueStart, endLine: span.endLine, valueEnd: span.endCol }
    }
    i = span.endLine + 1
  }
  return null
}

/** The column the section's `=` signs line up on, when they already line up. */
function alignColumn(lines: string[], section: Section): number | null {
  const columns: number[] = []
  for (let i = section.start; i < section.end; i++) {
    const m = KEY_LINE.exec(lines[i])
    if (!m) continue
    columns.push(m[1].length + m[2].length + m[3].length)
  }
  if (columns.length === 0) return null
  return Math.max(...columns)
}

/** Last line of real content in the section — where a new key goes. */
function lastContentLine(lines: string[], section: Section): number {
  let last = section.start - 1
  for (let i = section.start; i < section.end; i++) {
    if (lines[i].trim()) last = i
  }
  return last
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

export type TomlEdit =
  /** Set a key in `[table]` (or the root table when `table` is omitted). */
  | { op: 'set'; table?: string; key: string; value: TomlValue }
  /** Delete a key, and the line it sits on. `index` selects a `[[table]]` entry. */
  | { op: 'unset'; table?: string; key: string; index?: number }
  /** Add a `[[table]]` entry at the end of the existing run. */
  | { op: 'appendEntry'; table: string; fields: Array<[string, TomlValue]>; comment?: string }
  /** Set a key inside the nth `[[table]]` entry. */
  | { op: 'setInEntry'; table: string; index: number; key: string; value: TomlValue }
  /** Delete the nth `[[table]]` entry, header and all. */
  | { op: 'removeEntry'; table: string; index: number }

function findSection(sections: Section[], header: string | undefined, index = 0): Section | undefined {
  if (header === undefined) return sections.find((s) => s.header === null)
  return sections.find((s) => s.header === header && s.index === index)
}

/**
 * Apply edits to the raw document text, preserving everything not edited.
 *
 * Edits are applied one at a time and the document is re-scanned between them:
 * an edit can move every line after it, and batching the scan would make the
 * second edit in a list write to the wrong place.
 */
export function editToml(raw: string, edits: TomlEdit[]): string {
  let text = raw
  for (const edit of edits) text = applyEdit(text, edit)
  return text
}

function applyEdit(raw: string, edit: TomlEdit): string {
  const newline = raw.includes('\r\n') ? '\r\n' : '\n'
  const lines = raw.split(/\r?\n/)
  const sections = scanSections(lines)
  const join = (ls: string[]): string => ls.join(newline)

  if (edit.op === 'set' || edit.op === 'unset') {
    const section = findSection(sections, edit.table, edit.op === 'unset' ? edit.index ?? 0 : 0)
    if (!section) {
      if (edit.op === 'unset') return raw
      return join(appendSection(lines, edit.table!, [[edit.key, edit.value]]))
    }
    const found = findKey(lines, section, edit.key)
    if (!found) {
      if (edit.op === 'unset') return raw
      return join(insertKey(lines, section, edit.key, edit.value))
    }
    if (edit.op === 'unset') {
      lines.splice(found.line, found.endLine - found.line + 1)
      return join(lines)
    }
    return join(replaceValue(lines, found, edit.value))
  }

  if (edit.op === 'setInEntry') {
    const section = findSection(sections, edit.table, edit.index)
    if (!section) return raw
    const found = findKey(lines, section, edit.key)
    if (!found) return join(insertKey(lines, section, edit.key, edit.value))
    return join(replaceValue(lines, found, edit.value))
  }

  if (edit.op === 'removeEntry') {
    const section = findSection(sections, edit.table, edit.index)
    if (!section || section.headerLine < 0) return raw
    // Stop at the last real content: the blank lines after an entry belong to
    // the gap between entries, and eating them collapses the file.
    const last = lastContentLine(lines, section)
    lines.splice(section.headerLine, last - section.headerLine + 1)
    // One blank line is left behind by the removal; drop it if it doubles up.
    while (
      section.headerLine > 0 &&
      section.headerLine < lines.length &&
      !lines[section.headerLine].trim() &&
      !lines[section.headerLine - 1].trim()
    ) {
      lines.splice(section.headerLine, 1)
    }
    return join(lines)
  }

  // appendEntry
  const existing = sections.filter((s) => s.header === edit.table && s.isArray)
  const block = renderEntry(`[[${edit.table}]]`, edit.fields, edit.comment)
  if (existing.length === 0) {
    if (lines.length && lines[lines.length - 1].trim()) lines.push('')
    lines.push(...block, '')
    return join(lines)
  }
  const last = existing[existing.length - 1]
  const at = lastContentLine(lines, last) + 1
  lines.splice(at, 0, '', ...block)
  return join(lines)
}

/** Swap a value in place, keeping indentation, alignment and any trailing comment. */
function replaceValue(lines: string[], at: KeyLocation, value: TomlValue): string[] {
  const formatted = formatValue(value)
  const head = lines[at.line].slice(0, at.valueStart)
  const tail = lines[at.endLine].slice(at.valueEnd)
  lines.splice(at.line, at.endLine - at.line + 1, head + formatted + tail)
  return lines
}

/** Add a key to a table that exists but doesn't have it, matching its alignment. */
function insertKey(lines: string[], section: Section, key: string, value: TomlValue): string[] {
  // `column` is the index the section's `=` sits on, so the key is padded to
  // one less than that — the space before the `=` is part of the separator.
  const column = alignColumn(lines, section)
  const padded = column !== null && column - 1 > key.length ? key.padEnd(column - 1) : key
  lines.splice(lastContentLine(lines, section) + 1, 0, `${padded} = ${formatValue(value)}`)
  return lines
}

/** Add a `[table]` that isn't in the document at all. */
function appendSection(lines: string[], header: string, fields: Array<[string, TomlValue]>): string[] {
  if (lines.length && lines[lines.length - 1].trim()) lines.push('')
  lines.push(...renderEntry(`[${header}]`, fields), '')
  return lines
}

/** A header plus its keys, `=` aligned the way the generated files write them. */
function renderEntry(header: string, fields: Array<[string, TomlValue]>, comment?: string): string[] {
  const width = fields.reduce((w, [k]) => Math.max(w, k.length), 0)
  const out = comment ? comment.split('\n').map((l) => `# ${l}`) : []
  out.push(header)
  for (const [k, v] of fields) out.push(`${k.padEnd(width)} = ${formatValue(v)}`)
  return out
}

/**
 * The 1-based line a key sits on, for error reporting.
 *
 * Validation happens on the parsed value, which has no idea where it came from.
 * This walks the raw text so "php must be one of 8.2, 8.3, 8.4, 8.5" can point
 * at the line the user has to fix instead of just naming the file.
 */
export function keyLine(raw: string, table: string | undefined, key: string, index = 0): number {
  const lines = raw.split(/\r?\n/)
  const section = findSection(scanSections(lines), table, index)
  if (!section) return 1
  const found = findKey(lines, section, key)
  return (found ? found.line : Math.max(section.headerLine, 0)) + 1
}
