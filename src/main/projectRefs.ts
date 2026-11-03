// Turning `$floe` into the project it names. See shared/projectRefs.ts for the
// block it feeds. Only this machine's projects: main knows no others.

import { projectSlug, type ProjectRef } from '../shared/projectRefs'
import { displayName, projectScan } from './config/projectStore'

/** The project a slug names, or null. The first by sidebar order wins a tie. */
export function resolveProjectRef(slug: string): ProjectRef | null {
  for (const p of projectScan().projects) {
    const name = displayName(p)
    if (projectSlug(name) === slug) return { name, path: p.path }
  }
  return null
}
