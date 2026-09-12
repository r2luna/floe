// The wire shape of the worktree premise — what it looks like once it is inside
// a prompt, and how to get it back out.
//
// Composing and storing the premise is main/premise.ts's job; this module owns
// only the block, because three places that are not main need it: the harness
// transcript (the block is echoed back into Claude's JSONL and must not read as
// something the user typed), the handoff packet, and the chat panel.

/** Names the block. Anything between these tags is ours, not the user's. */
export const PREMISE_TAG = 'worktree-premise'

/**
 * The one line addressed to the model, kept out of the premise itself.
 *
 * The premise says what the branch is for; this says how to read it. Separate
 * so the panel can show the brief without the instruction we wrote around it.
 */
export const PREMISE_NOTE =
  'This is the standing brief for the worktree you are working in. It was ' +
  'written when the worktree was created and holds for the whole session — ' +
  'treat it as context you already have, not as the request. Do not ' +
  'acknowledge it; answer what is actually asked.'

// Non-greedy for the same reason every other block here is: a second premise in
// one text stays a second block rather than one that swallows what lies between.
const BLOCK = new RegExp(`<${PREMISE_TAG}>\\s*([\\s\\S]*?)\\s*</${PREMISE_TAG}>\\n*`, 'g')

/** The premise as it reaches a model: the note, then the brief, then the turn. */
export function wrapPremise(body: string): string {
  return `<${PREMISE_TAG}>\n${PREMISE_NOTE}\n\n${body.trim()}\n</${PREMISE_TAG}>\n\n`
}

/** True when this text carries a premise block. */
export function hasPremise(text: string): boolean {
  return text.includes(`<${PREMISE_TAG}>`)
}

/**
 * The brief inside the block, without the note we wrapped it in, or null.
 *
 * The note is sliced off by matching it, not by counting paragraphs: a block
 * written by an older build (or a reworded note) then comes back whole, which
 * reads oddly but never loses a line of the brief.
 */
export function premiseIn(text: string): string | null {
  const m = new RegExp(BLOCK.source).exec(text)
  if (!m) return null
  const inner = m[1].trim()
  const body = inner.startsWith(PREMISE_NOTE) ? inner.slice(PREMISE_NOTE.length).trim() : inner
  return body || null
}

/**
 * The text without the block — what the user actually typed.
 *
 * The premise is a prefix on a real prompt, so removing it leaves the message
 * and takes back the standing context we added to it.
 */
export function stripPremise(text: string): string {
  return text.replace(BLOCK, '').trim()
}
