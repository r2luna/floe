// The colour a nick is drawn in, wherever it is drawn.
//
// mIRC assigned every nick a colour by hashing it, so you learned to recognise
// people by colour before reading the name. Same trick — but the voices you most
// need to tell apart are a KNOWN set, so they are not left to a hash that can
// collide. It did: `you` and `codex` came out the same pink, in a chat whose
// whole point was seeing which of them answered.
//
// So the seven that are always in the channel — you, and each harness — get a
// colour each by name, and everyone else (subagents, other sessions) hashes over
// what is left. The fourteen are one ring of evenly spaced hues: the reserved
// seven take every other slot, which puts each of them a clear step from the
// next (ΔE 34 at the closest) rather than wherever a hash happened to land.
//
// The values live in the CSS, one variable per slot with a light-theme override
// — a mid-tone that reads on the dark background is nearly invisible on the
// light one. See `--nick-*` in index.css.
//
// Its own file rather than panels.tsx's, because the assistant's markdown body
// paints handles too (see rehypeMentions.ts) and MessageBody is lazy-loaded —
// reaching into panels.tsx for one function would pull the whole chat back into
// that chunk.

import { userNick } from './models.ts'

const NICK_HASH_SLOTS = 7

/** The voices that are always here. The user's nick is whatever floe.toml or the
    machine says, so it is matched at call time rather than listed. */
const RESERVED_NICKS = ['claude', 'codex', 'gemini', 'opencode', 'lmstudio', 'ollama']

export const nickColor = (nick: string): string => {
  if (nick === userNick()) return 'var(--nick-you)'
  if (RESERVED_NICKS.includes(nick)) return `var(--nick-${nick})`
  let h = 0
  for (const ch of nick) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return `var(--nick-${h % NICK_HASH_SLOTS})`
}
