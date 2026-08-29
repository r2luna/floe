// What an IPC rejection actually said.
//
// A handler in the main process throws a sentence written for the user —
// `"example" already exists`. Electron does not hand that sentence back: it
// rejects with `Error invoking remote method 'skills:create': Error: "example"
// already exists`, which names a channel the user has never heard of and says
// "Error" twice before getting to the point.
//
// So every place that shows an IPC failure to a person unwraps it here. The
// message the main process wrote is the message, and nothing else is.

/** Electron's wrapper, and the error class name inside it. */
const WRAPPER = /^Error invoking remote method '[^']*':\s*/
const CLASS = /^[A-Za-z]*Error:\s*/

export function reason(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  const inner = text.replace(WRAPPER, '')
  // Only after unwrapping: a message that legitimately starts with "Error: "
  // and never crossed IPC is the handler's own wording, and not ours to edit.
  const clean = (inner === text ? inner : inner.replace(CLASS, '')).trim()
  // Never empty: a failure with nothing to say still has to say something, or
  // the row reports a blank line and the user reads it as a bug in the panel.
  return clean || 'something went wrong'
}
