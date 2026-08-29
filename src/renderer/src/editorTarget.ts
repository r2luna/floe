// The edit panel's `sub`: which file the editor should show, and which line.
//
// Its own module rather than a helper inside panels.tsx because the registry
// writes what the panel reads, and the registry is imported by a plain
// `node --test` run that cannot load a .tsx file.

/** Pack a file and line into a panel `sub`. Line 1 is left implicit. */
export const editSub = (path: string, line?: number): string =>
  line && line > 1 ? `${path}:${line}` : path

/** Unpack what `editSub` wrote. A path ending in `:<digits>` is the only form. */
export function editTarget(sub = ''): { path: string; line?: number } {
  const at = /^(.*):(\d+)$/.exec(sub)
  return at ? { path: at[1], line: Number(at[2]) } : { path: sub }
}
