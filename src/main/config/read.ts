// Typed reads off a parsed TOML table, with the wrong ones reported rather than
// thrown.
//
// Every config file needs the same four moves — read a string, a number, a
// boolean, one of a fixed set — and the same policy for each: a value of the
// wrong type is not a crash and not a silent coercion. It falls back to the
// default and adds an error pointing at the line, so the user sees `php must be
// one of 8.2, 8.3, 8.4, 8.5` next to the line they typed `8.1` on.

import type { ErrorSink } from './errors'
import { keyLine } from './toml'

export class TableReader {
  // Longhand fields: Node's type stripping (which the tests run on) rejects
  // constructor parameter properties.
  private readonly sink: ErrorSink
  private readonly raw: string
  private readonly obj: Record<string, unknown>
  private readonly table?: string
  private readonly index: number

  constructor(
    sink: ErrorSink,
    raw: string,
    obj: Record<string, unknown>,
    table?: string,
    index = 0
  ) {
    this.sink = sink
    this.raw = raw
    this.obj = obj
    this.table = table
    this.index = index
  }

  private bad(key: string, reason: string): void {
    this.sink.add(keyLine(this.raw, this.table, key, this.index), reason)
  }

  has(key: string): boolean {
    return this.obj[key] !== undefined
  }

  /** The raw value, for callers doing their own shape check (nested tables). */
  raw_(key: string): unknown {
    return this.obj[key]
  }

  optStr(key: string): string | undefined {
    const v = this.obj[key]
    if (v === undefined) return undefined
    if (typeof v !== 'string') {
      this.bad(key, `${key} must be a string`)
      return undefined
    }
    return v
  }

  str(key: string, fallback: string): string {
    return this.optStr(key) ?? fallback
  }

  num(key: string, fallback: number, range?: { min?: number; max?: number }): number {
    const v = this.obj[key]
    if (v === undefined) return fallback
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.bad(key, `${key} must be a number`)
      return fallback
    }
    if (range?.min !== undefined && v < range.min) {
      this.bad(key, `${key} must be at least ${range.min}`)
      return fallback
    }
    if (range?.max !== undefined && v > range.max) {
      this.bad(key, `${key} must be at most ${range.max}`)
      return fallback
    }
    return v
  }

  bool(key: string, fallback: boolean): boolean {
    const v = this.obj[key]
    if (v === undefined) return fallback
    if (typeof v !== 'boolean') {
      this.bad(key, `${key} must be true or false`)
      return fallback
    }
    return v
  }

  /**
   * One of a fixed set.
   *
   * The error names every allowed value, because the whole point of a closed set
   * is that the user can be told what the options are instead of guessing.
   */
  oneOf<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
    const v = this.obj[key]
    if (v === undefined) return fallback
    if (typeof v !== 'string' || !allowed.includes(v as T)) {
      this.bad(key, `${key} must be one of ${allowed.join(', ')}`)
      return fallback
    }
    return v as T
  }

  optOneOf<T extends string>(key: string, allowed: readonly T[]): T | undefined {
    if (this.obj[key] === undefined) return undefined
    const v = this.obj[key]
    if (typeof v !== 'string' || !allowed.includes(v as T)) {
      this.bad(key, `${key} must be one of ${allowed.join(', ')}`)
      return undefined
    }
    return v as T
  }

  strArray(key: string): string[] | undefined {
    const v = this.obj[key]
    if (v === undefined) return undefined
    if (!Array.isArray(v) || v.some((e) => typeof e !== 'string')) {
      this.bad(key, `${key} must be a list of strings`)
      return undefined
    }
    return v as string[]
  }

  /** Report a problem the caller found itself, on this table's line. */
  reject(key: string, reason: string): void {
    this.bad(key, reason)
  }
}

/** A parsed sub-table, or an error if the key is present but isn't one. */
export function subTable(
  sink: ErrorSink,
  raw: string,
  obj: Record<string, unknown>,
  key: string
): TableReader | null {
  const v = obj[key]
  if (v === undefined) return null
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    sink.add(keyLine(raw, undefined, key), `${key} must be a table`)
    return null
  }
  return new TableReader(sink, raw, v as Record<string, unknown>, key)
}
