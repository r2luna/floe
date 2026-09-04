// Making the two harnesses in one chat actually talk.
//
// The policy — what is said and for how long — is shared/relay.ts. This is the
// wiring: it waits for the routed turn to end, starts the turn that answers it,
// and hands anything the model addresses back to the harness it named.
//
// It lives in main rather than in the panel because a relay is not something
// you can only have while looking at it: send `@codex revisa isso`, switch to
// another session, and the answer and the take on it must both still happen.
// Same reason turn.ts is where a turn begins — both doors, one behaviour.

import type { BrowserWindow } from 'electron'
import type { AgentRunOptions } from '../shared/types'
import { HARNESSES } from '../shared/modes'
import { relayBack, relayMark, relayPrompt } from '../shared/relay'
import { activeTurnKeys, onceTurnDone, sessionNames } from './agent'
// Circular with turn.ts (it arms the relay, the relay starts turns) — safe on
// the same terms as agent↔mcpServer: neither side runs the other at import.
import { dispatchTurn, optionsForRoute, startTurn } from './turn'
import { log } from './log'

/**
 * How long the relay waits before taking the turn.
 *
 * Not a pause for effect: the `done` that fires this reaches the panel in the
 * same breath, and the panel answers it — it drains whatever you typed while
 * the harness was working. That message is yours and goes first, so the relay
 * looks again after the round trip and steps aside if it finds a turn running.
 */
const YIELD_MS = 400

/** Nothing to relay into: something else is already answering this chat. */
const busy = (key: string): boolean => {
  const names = new Set(sessionNames(key))
  return activeTurnKeys().some((k) => names.has(k))
}

/**
 * Do it after the current turn's `done` has finished being delivered — and
 * after anything that `done` sets off has had its say.
 */
function later(fn: () => void): void {
  setTimeout(fn, YIELD_MS).unref?.()
}

/**
 * Exchanges already spent on this chat's relay, carried across the hop.
 *
 * Set by the relay just before it hands a message back to the harness, and
 * consumed by the arm that message triggers. A routed turn with nothing here is
 * one a person just sent, and starts the count at zero — which is what makes a
 * new `@codex …` a fresh conversation rather than the tail of the last one.
 */
const spent = new Map<string, number>()

/**
 * Which generation of relay a chat is on. Cancelling bumps it, and a callback
 * holding a stale number does nothing — a waiter already parked cannot be
 * unparked, so it has to be able to tell that it was called off.
 */
const epochs = new Map<string, number>()

/**
 * Chats whose next answer is already being watched, and by whom.
 *
 * Two watchers on one turn would hand the same line over twice. `backWaiting`
 * is the relay holding the answer to a turn it started itself; `addressed` is
 * armAddress on an ordinary turn. The relay's wins: it knows the hop it is on.
 */
const backWaiting = new Set<string>()
const addressed = new Set<string>()

/** Stop the relay for this chat: what `stop` means when a harness is answering. */
export function cancelRelay(key: string): void {
  epochs.set(key, (epochs.get(key) ?? 0) + 1)
  spent.delete(key)
  backWaiting.delete(key)
  addressed.delete(key)
}

/**
 * Answer this routed turn with a turn of your own.
 *
 * Armed from turn.ts, for every turn handed to a harness that is not the one
 * the session answers as. `back` is what the session itself runs on — the relay
 * turn is an ordinary turn for it, at its own model, effort and mode.
 */
export function armRelay(
  win: BrowserWindow,
  key: string,
  worktreePath: string,
  harness: string,
  back: AgentRunOptions
): void {
  const hops = spent.get(key) ?? 0
  spent.delete(key)
  const epoch = epochs.get(key) ?? 0
  const live = (): boolean => (epochs.get(key) ?? 0) === epoch

  onceTurnDone(key, (answer) => {
    // Nothing came back — the harness is not installed, the turn was stopped,
    // it died on spawn. There is nothing to have an opinion about, and firing a
    // turn to say so would be the model reporting our own plumbing.
    if (!live() || !answer.trim()) return
    later(() => {
      // You typed while it worked, and your message went out at the same
      // boundary. It wins: the model reads what the harness said either way —
      // the handoff packet under your message carries it (see handoff.ts) —
      // and two turns into one session is the one thing the queue exists to
      // prevent.
      if (!live() || busy(key)) return
      log('relay', { key, from: harness, to: back.provider ?? 'claude', hops })
      // Marked before the turn starts, because starting it is what arms
      // armAddress — which must stand down for this one: the waiter below is
      // the same job, and it is the one that knows the hop.
      backWaiting.add(key)
      startTurn(win, key, worktreePath, relayPrompt(harness, hops), back)

      // And what the model says back. Only a handle that OPENS a line routes,
      // so an answer that merely mentions `@codex` mid-sentence stays in the
      // chat where it was said.
      onceTurnDone(key, (reply) => {
        backWaiting.delete(key)
        const route = live() ? relayBack(reply, HARNESSES, hops + 1) : null
        if (!route) return
        later(() => {
          if (!live() || busy(key)) return
          spent.set(key, hops + 1)
          startTurn(
            win,
            key,
            worktreePath,
            route.prompt,
            // Shown as nothing: the model's words are already in the chat, one
            // line above, under its own name. Printing them again as a user
            // message would say the person typed what the model just said.
            { ...optionsForRoute(route, key), shown: relayMark(back.provider ?? 'claude') }
          )
        })
      })
    })
  })
}

/**
 * A handle in the session's OWN answer, actually delivered.
 *
 * armRelay above only ever watched turns the relay itself started, so the two
 * harnesses could talk once YOU opened the thread with `@codex …`. Everything
 * else Claude wrote went nowhere: ask it a question, watch it decide the right
 * move is to check with codex, watch it write `@codex revisa isso` — and
 * nothing was sent. The handle read as a handle and was one, in a chat where
 * nobody was listening for it.
 *
 * So every turn a session answers in its own voice is watched too. The rule is
 * the same one everywhere else in the app (shared/relay.ts): a handle at the
 * start of a line addresses that harness, mid-sentence it is only a name.
 *
 * Where it goes is now a QUERY (D7): one rule for the handle, whichever door
 * wrote it, so a `@codex` the model wrote opens the same panel a `@codex` you
 * typed would. Handed to dispatchTurn explicitly rather than left to the
 * `provider !== own.provider` heuristic downstream — that test cannot tell a
 * query key from a session and would arm a relay INSIDE the query.
 *
 * Consequence to own: an agent can put a panel on your screen. That is the
 * "agent first" principle taken at its word, so the query wears the mark of who
 * opened it.
 *
 * The hop cap is unchanged and still counts: the two cannot talk forever just
 * because it was the model, not you, that started them off.
 */
export function armAddress(
  win: BrowserWindow,
  key: string,
  worktreePath: string,
  own: AgentRunOptions
): void {
  if (backWaiting.has(key) || addressed.has(key)) return
  addressed.add(key)
  const mine = own.provider ?? 'claude'
  const epoch = epochs.get(key) ?? 0
  const live = (): boolean => (epochs.get(key) ?? 0) === epoch

  onceTurnDone(key, (reply) => {
    addressed.delete(key)
    if (!live()) return
    const hops = spent.get(key) ?? 0
    const route = relayBack(reply, HARNESSES, hops + 1)
    // A session naming the harness that is already answering it is the model
    // saying its own name, not handing anything over.
    if (!route || route.harness === mine) return
    later(() => {
      if (!live()) return
      // Deliberately NOT gated on `busy(key)` any more. That guard existed
      // because the answer used to take a turn in THIS chat, and two turns in
      // one session is what the queue exists to prevent. A query runs beside
      // the session, so a message you typed while it worked is no longer a
      // reason to drop the handle the model wrote — dropping it silently is.
      log('address', { key, from: mine, to: route.harness, hops })
      // Carried, so the answer comes back on the next hop and not on the first:
      // by the time the harness replies, one exchange has already happened.
      spent.set(key, hops + 1)
      dispatchTurn({
        win,
        parentKey: key,
        worktreePath,
        prompt: route.prompt,
        route,
        origin: 'agent',
        options: { ...optionsForRoute(route, key), shown: relayMark(mine) }
      })
    })
  })
}
