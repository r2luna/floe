// The wire format for a Floe skill, and how it collapses back for reading.
//
// A skill lives in Floe's config, not in any one harness's directory, because
// the same skill has to work whichever CLI answers the turn. So Floe expands it
// itself: `/deploy` in the composer becomes the skill's whole text in the prompt
// the harness receives.
//
// That leaves one problem. The harness echoes the prompt back — into Claude's
// JSONL, into a runtime log — and a transcript reloaded tomorrow would show
// four hundred lines of instructions where you typed one word. So the expansion
// is WRAPPED in a marker Floe owns, and every reader collapses it back to
// `/deploy`. The model sees the instructions; you see what you typed.
//
// Pure and shared: main expands, main and the renderer both collapse, and a
// format that only one side understood would drift the first time it changed.

export const SKILL_TAG = 'floe-skill'

/** A skill's text, wrapped so it can be found again in an echoed prompt. */
export function wrapSkill(name: string, body: string): string {
  return `<${SKILL_TAG} name="${name}">\n${body.trim()}\n</${SKILL_TAG}>`
}

// Non-greedy, so two skills in one message stay two blocks rather than one that
// swallows whatever was written between them.
const BLOCK = new RegExp(`<${SKILL_TAG} name="([^"]*)">[\\s\\S]*?</${SKILL_TAG}>`, 'g')

/** True when the text carries an expansion — i.e. it needs collapsing to read. */
export function hasSkill(text: string): boolean {
  return text.includes(`<${SKILL_TAG} `)
}

/**
 * Put an expanded prompt back the way it was typed.
 *
 * Applied everywhere a user message is shown: the optimistic echo in the panel,
 * and the transcript rebuilt from the harness's own log. Both go through here so
 * a message cannot look different after a reload than it did when you sent it.
 */
export function collapseSkills(text: string): string {
  return text.replace(BLOCK, (_all, name: string) => `/${name}`).replace(/\n{3,}/g, '\n\n').trim()
}

/** The names a text expands, in order. */
export function skillsIn(text: string): string[] {
  return [...text.matchAll(BLOCK)].map((m) => m[1])
}

/**
 * Replace every `/name` that names a known skill with its text.
 *
 * A token counts only at the start of the message or after whitespace, and only
 * when the name matches a skill exactly — otherwise `/usr/bin` or `read/write`
 * would be rewritten by a skill that happens to share a word. Anything not
 * matched is left alone: an unknown `/thing` is the harness's own command and
 * must reach it untouched.
 */
export function expandSkills(text: string, body: (name: string) => string | null): string {
  return text.replace(/(^|\s)\/([A-Za-z0-9][A-Za-z0-9:_-]*)/g, (all, lead: string, name: string) => {
    const found = body(name)
    return found === null ? all : `${lead}${wrapSkill(name, found)}`
  })
}
