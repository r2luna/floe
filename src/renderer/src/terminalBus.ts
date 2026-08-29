// The seam between "something asked for a command to be run" and the terminal
// panel that runs it.
//
// Its own module, and deliberately not part of Terminal.tsx: the command
// registry sends commands here, and the registry is imported by node tests that
// cannot load a .tsx file. Nothing here touches the DOM.

/**
 * Terminals ready to be typed into, by id. A panel that is mounted and done
 * repainting registers a sink; anything sent before that waits below, because
 * bytes typed while the scrollback is being replayed come out interleaved with
 * the repaint.
 */
const sinks = new Map<string, (data: string) => void>()
const waiting = new Map<string, string[]>()

/** Type a command into a terminal, now or as soon as it can take it. */
export function sendToTerminal(termId: string, command: string): void {
  const data = `${command}\r`
  const sink = sinks.get(termId)
  if (sink) sink(data)
  else waiting.set(termId, [...(waiting.get(termId) ?? []), data])
}

/** A terminal announcing it can take input, and draining what waited for it. */
export function attachTerminal(termId: string, sink: (data: string) => void): void {
  sinks.set(termId, sink)
  for (const data of waiting.get(termId) ?? []) sink(data)
  waiting.delete(termId)
}

export function detachTerminal(termId: string): void {
  sinks.delete(termId)
}
