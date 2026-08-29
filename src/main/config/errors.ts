// One error shape for every config file.
//
// The keybindings parser already reported problems as (line, text, reason) so a
// typo could be shown to the user instead of silently dropping a binding. Now
// that there are five files that can be wrong — and agents editing them — that
// idea has to cover all of them, with the file named, and one list the Settings
// panel can render.

export interface ConfigError {
  /** Absolute path of the file the problem is in. */
  file: string
  /** 1-based. Points at the offending line when we can find it, else the file's first. */
  line: number
  /** The line's text, so the panel can show it without re-reading the file. */
  text: string
  reason: string
}

/**
 * Collects errors while a file is being read.
 *
 * Reading config NEVER throws: a bad value falls back to its default and lands
 * here instead. One typo in `floe.toml` must not cost the user their font, their
 * projects and their keybindings.
 */
export class ErrorSink {
  readonly errors: ConfigError[] = []
  // Written out longhand rather than as constructor parameter properties: the
  // tests run these files through Node's type stripping, which does not support
  // that syntax.
  private readonly file: string
  private readonly raw: string

  constructor(file: string, raw: string) {
    this.file = file
    this.raw = raw
  }

  add(line: number, reason: string): void {
    const text = this.raw.split(/\r?\n/)[line - 1] ?? ''
    this.errors.push({ file: this.file, line, text: text.trim(), reason })
  }
}

/** Format for the log, one line each: `floe.toml:14 — theme must be a string`. */
export function formatConfigError(err: ConfigError): string {
  return `${err.file}:${err.line} — ${err.reason}`
}
