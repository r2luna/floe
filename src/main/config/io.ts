// Writing config files without losing them.
//
// These files are the user's — hand-edited, kept in a dotfiles repo, and now
// also written by the app and by agents. A half-written `projects/x/config.toml`
// is a project that vanishes from the sidebar, so every write lands atomically
// and is read back before the original is let go.

import { renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { parseToml } from './toml'

/**
 * Write `text` to `path`, atomically.
 *
 * Write-then-rename rather than write-in-place: a crash mid-write leaves the
 * previous file intact instead of a truncated one, since rename is atomic
 * within a filesystem.
 */
export function writeFileAtomic(path: string, text: string, mode?: number): void {
  const tmp = `${path}.tmp`
  try {
    // The mode goes on the temp file, because the rename is what the caller
    // ends up with: chmod-ing `path` afterwards would leave a window where the
    // new file is readable, and a later write would drop the mode again.
    writeFileSync(tmp, text, mode === undefined ? undefined : { mode })
    renameSync(tmp, path)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      /* nothing to clean up */
    }
    throw err
  }
}

/**
 * Write TOML, refusing to save anything that no longer parses.
 *
 * The surgical writer edits raw text, which is what preserves the comments —
 * and also what makes it possible, in principle, for a bad edit to produce a
 * broken document. Parsing the result before it replaces the original turns
 * that from "the user's config is gone" into "the save failed, nothing changed".
 */
export function writeTomlFile(path: string, text: string, mode?: number): void {
  const parsed = parseToml(text)
  if (!parsed.ok) {
    throw new Error(`refusing to write invalid TOML to ${path}: line ${parsed.error.line}: ${parsed.error.message}`)
  }
  writeFileAtomic(path, text, mode)
}
