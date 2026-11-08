// A project named in a message, and what the model actually receives.
//
// The `$` menu writes the project's NAME — `$floe` — because that is what the
// sidebar calls it. The name opens nothing for the model: a project is a repo
// root somewhere on this machine, usually not the worktree the session is in.
// So it expands on the way out, exactly as a session or task reference does
// (see sessionRefs.ts, taskRefs.ts), and every reader collapses the block back
// to `$floe`.

import { sessionSlug } from './sessionRefs.ts'

export const PROJECT_TAG = 'floe-project'

/** A project, as the model needs to be told about it. */
export interface ProjectRef {
  name: string
  /** Absolute path of the repo root. */
  path: string
  /** The machine it lives on, when that is not the one answering the turn. */
  machine?: string
}

/** The token the `$` menu writes for a project name: spaces only, like a session. */
export const projectSlug = sessionSlug

const esc = (v: string): string => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
const unesc = (v: string): string => v.replace(/&quot;/g, '"').replace(/&amp;/g, '&')

/** One reference, wrapped so it can be found again in an echoed prompt. */
export function wrapProjectRef(slug: string, p: ProjectRef): string {
  const line = p.machine
    ? `The user is pointing at the Floe project "${p.name}" on the machine "${p.machine}", repo root ${p.path}. ` +
      `That path is on ${p.machine}, not on this machine, so its files are not readable from this session.`
    : `The user is pointing at the Floe project "${p.name}", repo root ${p.path}. ` +
      `Read its files there, or use the floe MCP tools with project ${p.path} ` +
      `(list_worktrees to see its worktrees).`
  return `<${PROJECT_TAG} ref="${esc(slug)}" path="${esc(p.path)}">\n${line}\n</${PROJECT_TAG}>`
}

const BLOCK = new RegExp(`<${PROJECT_TAG} ref="([^"]*)"[^>]*>[\\s\\S]*?</${PROJECT_TAG}>`, 'g')

/** True when the text carries an expansion — i.e. it needs collapsing to read. */
export function hasProjectRef(text: string): boolean {
  return text.includes(`<${PROJECT_TAG} `)
}

/** Put an expanded prompt back the way it was typed. */
export function collapseProjectRefs(text: string): string {
  return text.replace(BLOCK, (_all, ref: string) => `$${unesc(ref)}`)
}

// A `$` starting a word, then a run of non-space. Wide on purpose, like the
// session token: the narrowing is `resolve`, which only answers for a real
// project name, so `$HOME`, `$5` and `${x}` are left exactly as written.
const TOKEN = /(^|\s)\$([^\s$<>{}]+)/g

/** Replace every `$name` that names a known project with its address. */
export function expandProjectRefs(text: string, resolve: (slug: string) => ProjectRef | null): string {
  return text.replace(TOKEN, (all, lead: string, slug: string) => {
    const found = resolve(slug)
    return found ? `${lead}${wrapProjectRef(slug, found)}` : all
  })
}
