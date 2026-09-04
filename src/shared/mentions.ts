// Reading a handle off the front of a message.
//
// `@codex revisa isso` hands that one message to codex instead of to the model
// the session is set to. The rule has to read the same everywhere a prompt can
// arrive — the composer, and the MCP `send_message` an agent calls — so it
// lives here rather than in either of them. See renderer/src/mentions.ts for
// the rest of what a handle does (the chips, the menu, the roster).

import { EFFORTS, type Effort } from './types.ts'

/** A message handed to a named harness instead of to the session's own model. */
export interface Route {
  /** Who answers this one message. */
  harness: string
  /** The model named in the handle, if it named one. */
  model?: string
  effort?: Effort
  /** The message with the handle taken off — what the harness actually reads. */
  prompt: string
}

/**
 * The handle a message opens with: `@harness`, `@harness:model`,
 * `@harness:model:effort`, `@harness:effort`.
 *
 * Read from the END, because a model slug can contain colons of its own —
 * Ollama names its models `llama3.2:latest`, and splitting on every colon would
 * hand it `llama3.2` and throw the tag away. So the LAST segment is the effort
 * if it is one of the five, and everything before it is the model, joined back
 * up exactly as the menu wrote it.
 *
 * `@codex:high` is codex at high effort and `@codex:gpt-5.6-sol` is codex on
 * that model, without either needing a marker character.
 *
 * The one ambiguity left: an Ollama tag named after an effort — `@ollama:qwen3:max`
 * reads as qwen3 at max effort, not as the tag `max`. Tags come from whatever
 * the user pulled, so this cannot be ruled out, only ranked: effort wins,
 * because five words are a closed set and a tag by those names is a thing
 * nobody has. Name the model in `[harness.ollama]` if you ever do.
 *
 * Only at the very start, and only for a harness we can actually run. Anywhere
 * else — mid-sentence, or a handle naming a subagent — this returns null and the
 * message goes to the session's own model with the handle left in the text.
 */
export function routeAt(text: string, harnesses: readonly string[]): Route | null {
  // The segments are slug-shaped, so the punctuation of the sentence is not
  // eaten into the model name: `@codex:high, revisa` addresses codex at high
  // effort, and does not send it to a model called "high,". A dot only counts
  // INSIDE a segment (`gpt-5.6-sol`, `llama3.2`) — one that ends it is the full
  // stop of the sentence, which is why the two are spelled apart.
  const m = /^\s*@([a-z0-9][a-z0-9-]*)((?::[\w/-]+(?:\.[\w/-]+)*)*)[,;.!?]*(\s|$)/.exec(text)
  if (!m || !harnesses.includes(m[1])) return null
  const parts = m[2] ? m[2].slice(1).split(':') : []
  const effort = EFFORTS.includes(parts[parts.length - 1] as Effort)
    ? (parts.pop() as Effort)
    : undefined
  return {
    harness: m[1],
    model: parts.length ? parts.join(':') : undefined,
    effort,
    // The handle is addressing, not content: codex is told what to do, not that
    // it is codex. The transcript still shows the line as typed.
    prompt: text.slice(m[0].length).trimStart()
  }
}

/**
 * `@all` — one message to several agents at once.
 *
 * Not a harness, and deliberately not spelled as one: `routeAt` reads a handle
 * that names WHO answers, and `all` names nobody. What it carries is the
 * message and, optionally, one effort for everybody (`@all:high`) — the targets
 * are the caller's to decide, because the right answer depends on what is
 * already open (R7): the queries you have, or a picker if you have none.
 *
 * Fanning out to every harness installed on the machine is the failure mode
 * this shape exists to make impossible. Four turns nobody asked for is not a
 * feature, and there is nowhere in this function to produce them.
 *
 * The same rule as a handle: only at the very start of the line. `@all` in the
 * middle of a sentence is a word.
 */
export function routeAll(text: string): { effort?: Effort; prompt: string } | null {
  const m = /^\s*@all(?::([\w-]+))?[,;.!?]*(\s|$)/.exec(text)
  if (!m) return null
  // Anything after the colon that is not one of the five is not an effort, and
  // guessing would send `@all:opus` out at a level nobody chose.
  const effort = EFFORTS.includes(m[1] as Effort) ? (m[1] as Effort) : undefined
  if (m[1] && !effort) return null
  return { effort, prompt: text.slice(m[0].length).trimStart() }
}
