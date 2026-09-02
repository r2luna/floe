// A URL in the chat is an address you want to open, not a word you want to
// read. The model's side already gets this for free — remark-gfm autolinks
// literals inside markdown — but your own messages and the tool lines are not
// markdown (rendering them as markdown would reformat what you typed), so the
// same job is done here, on plain text.

/**
 * What counts as a link: an explicit scheme, or the `www.` that stands for one.
 *
 * Deliberately the same shape GFM autolinks, so a URL reads the same on both
 * sides of the conversation. A bare `example.com` is NOT a link: half the
 * tokens in a transcript are file names, and `notes.md` must not turn into an
 * address because `.md` looks like a TLD.
 */
const URL = /(?:https?:\/\/|mailto:)[^\s<>"'`]+|(?:^|[\s(<])(www\.[^\s<>"'`]+)/gi

// Sentence punctuation that happens to sit against the end of a URL. A link at
// the end of a line almost always has a full stop after it, and swallowing it
// gives you an address that 404s.
const TRAILING = /[.,;:!?'"]+$/

/**
 * Drop what belongs to the sentence rather than to the address.
 *
 * Parentheses are counted rather than stripped: `…/Foo_(bar)` is a real
 * Wikipedia URL, and `(see https://x.dev/a)` is a URL inside a parenthesis.
 * The difference is whether the closer has an opener inside the match.
 */
function trimTail(url: string): string {
  let out = url.replace(TRAILING, '')
  while (out.endsWith(')') || out.endsWith(']')) {
    const [open, close] = out.endsWith(')') ? ['(', ')'] : ['[', ']']
    const opens = out.split(open).length - 1
    const closes = out.split(close).length - 1
    if (opens >= closes) break
    out = out.slice(0, -1).replace(TRAILING, '')
  }
  return out
}

/** A run of plain text, or a URL the chat draws as a link. */
export type LinkPart = { text: string; url?: undefined } | { url: string; text?: undefined }

/** Cut `text` into plain runs and the links between them, in order. */
export function splitLinks(text: string): LinkPart[] {
  const out: LinkPart[] = []
  let last = 0
  for (const m of text.matchAll(URL)) {
    // The `www.` branch has to claim the character before it to prove the token
    // starts a word — `foo.www.bar` is not a link — so the match can begin one
    // character early.
    const at = m.index + (m[1] ? m[0].length - m[1].length : 0)
    const url = trimTail(m[1] ?? m[0])
    if (!url) continue
    if (at > last) out.push({ text: text.slice(last, at) })
    out.push({ url })
    last = at + url.length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

/**
 * What to actually open. `www.floe.dev` is written without a scheme and cannot
 * be handed to the shell that way; everything else already says what it is.
 */
export function hrefOf(url: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`
}
