// A session named in a message, and what the model actually receives.
//
// The `#` menu writes the session's TITLE — `#vamos-pensar-no-plugin` — because
// that is what you know it as. The model does not know it as anything: a slug
// names nothing it can call. Every floe MCP tool that reaches another session
// takes an id, and WHICH HARNESS answers there changes what asking it even
// means — a codex chat is not read, resumed or written to the way a Claude one
// is. Both have to travel, or the reference is a word the model can only guess
// at.
//
// So it expands on the way out, exactly as a skill does: the model is handed
// the id and the harness, and every reader collapses the block back to `#slug`.
// You see the name you typed; the model gets the address.
//
// Pure and shared, for the same reason skills.ts is: main expands, main and the
// renderer collapse, and a format only one side understood would drift the
// first time it changed.

export const SESSION_TAG = 'floe-session'

/** A session, as the model needs to be told about it. */
export interface SessionRef {
  /** The Floe session id — what every MCP tool that reaches a session takes. */
  id: string
  /** Who answers there: `claude`, `codex`, `gemini`, … */
  harness: string
  title: string
  worktreePath: string
}

/**
 * The token the `#` menu writes for a session title.
 *
 * Spaces only. The title is what you recognise the session by, so it survives
 * into the message as close to itself as a whitespace-delimited token allows.
 */
export function sessionSlug(title: string): string {
  return title.replace(/\s+/g, '-')
}

// The slug is a title, so it can hold anything a person types — including the
// quote that would end the attribute holding it. Escaped going in, unescaped
// coming out, and the round trip is what the collapse depends on.
const esc = (v: string): string => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
const unesc = (v: string): string => v.replace(/&quot;/g, '"').replace(/&amp;/g, '&')

/**
 * One reference, wrapped so it can be found again in an echoed prompt.
 *
 * The body is a sentence and not just attributes: a bare tag reads as markup to
 * skip, where the line says what the reference IS and what to do with it. The
 * id is stated in both places on purpose — the attribute is for the collapse,
 * the sentence is for the model.
 */
export function wrapSessionRef(slug: string, s: SessionRef): string {
  const line =
    `The user is pointing at the Floe session "${s.title}" — id ${s.id}, harness ${s.harness}, ` +
    `worktree ${s.worktreePath}. Reach it with the floe MCP tools using that id: ` +
    `read_session_output to read it, send_message to say something in it.`
  return `<${SESSION_TAG} ref="${esc(slug)}" id="${esc(s.id)}" harness="${esc(s.harness)}">\n${line}\n</${SESSION_TAG}>`
}

// Non-greedy, so two references in one message stay two blocks rather than one
// that swallows what was written between them.
const BLOCK = new RegExp(`<${SESSION_TAG} ref="([^"]*)"[^>]*>[\\s\\S]*?</${SESSION_TAG}>`, 'g')

/** True when the text carries an expansion — i.e. it needs collapsing to read. */
export function hasSessionRef(text: string): boolean {
  return text.includes(`<${SESSION_TAG} `)
}

/**
 * Put an expanded prompt back the way it was typed.
 *
 * Applied everywhere a user message is shown, so a message cannot look
 * different after a reload than it did when you sent it.
 */
export function collapseSessionRefs(text: string): string {
  return text.replace(BLOCK, (_all, ref: string) => `#${unesc(ref)}`)
}

// What could be a session reference: a `#` starting a word, then a run of
// non-space. Deliberately wide, because a title is whatever a person typed —
// quotes and all — and a token the menu can write but this cannot read back is
// a dead reference. The narrowing is done by `resolve`, which only answers for
// a slug that names a real session: `#src/main/turn.ts` and `## heading` name
// none, so they are left exactly as written.
const TOKEN = /(^|\s)#([^\s#<>]+)/g

/**
 * Replace every `#slug` that names a known session with its address.
 *
 * Exact match only. A token with the sentence's punctuation still on it
 * (`#deploy-work,`) resolves to nothing and stays text — as does every file
 * reference the same menu writes, which must reach the harness untouched.
 */
export function expandSessionRefs(text: string, resolve: (slug: string) => SessionRef | null): string {
  return text.replace(TOKEN, (all, lead: string, slug: string) => {
    const found = resolve(slug)
    return found ? `${lead}${wrapSessionRef(slug, found)}` : all
  })
}
