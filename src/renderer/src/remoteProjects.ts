// `$name@machine`, expanded where main cannot.
//
// Main resolves `$name` against its own project list, and a window is attached
// to one machine's main at a time. A project on another machine is known only
// to the renderer, which holds the union — so its references expand here, on
// the way out, into the same block main writes (shared/projectRefs.ts) with the
// machine named.

import { expandProjectRefs, type ProjectRef } from '../../shared/projectRefs.ts'

let remote = new Map<string, ProjectRef>()

/** Replace the projects that live on other machines, keyed by their token. */
export function setRemoteProjects(next: Map<string, ProjectRef>): void {
  remote = next
}

/** `prompt` with every `$name@machine` that names a known project expanded. */
export function expandRemoteProjects(prompt: string): string {
  return remote.size ? expandProjectRefs(prompt, (slug) => remote.get(slug) ?? null) : prompt
}
