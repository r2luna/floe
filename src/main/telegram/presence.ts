// Is the user at Floe on this machine right now?
//
// The bot only speaks when the answer is no: a turn finishing while you are
// looking at it already reached you, and the same text on your phone is noise.
//
// "At Floe" is read from the windows, not from the OS: every Floe window — this
// machine's own, a browser tab on the daemon, another Mac attached to this one —
// pings every backend it shows while it has focus and you type, click or
// scroll (renderer/src/usePresence.ts). Nobody pinging for `awayAfterMs` means
// nobody is here. A message arriving FROM Telegram is the other signal: you
// are on your phone, so the answer to it has to go there too.
//
// Module state on purpose: the pings arrive over IPC and the bot reads them
// from its own event hook, and the two never otherwise meet.

// -Infinity rather than 0: "never" has to be away under any clock, including
// a test's.
let lastSeen = -Infinity

/** A window reported input. */
export function markSeen(now = Date.now()): void {
  lastSeen = now
}

/** The user spoke from Telegram: away until a window says otherwise. */
export function markAway(): void {
  lastSeen = -Infinity
}

export function isAway(awayAfterMs: number, now = Date.now()): boolean {
  return now - lastSeen >= awayAfterMs
}

/** When a window last reported input, 0 for never (or since a Telegram message). */
export function lastSeenAt(): number {
  return Number.isFinite(lastSeen) ? lastSeen : 0
}
