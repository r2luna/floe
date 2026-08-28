// Replayable scrollback for a PTY.
//
// The buffer is a raw byte window of a *stateful* protocol, so a naive
// `(buffer + data).slice(-MAX)` eventually cuts an escape sequence in half. The
// damaging case is the alternate screen: a long nvim/lazygit session pushes its
// `\x1b[?1049h` out of the window, so the replay paints the TUI's absolutely
// positioned frames straight onto the normal screen — the prompt history and
// leftover editor rows jumbled together that the panel shows after a re-open.
//
// Fix at the source: a TUI's frames are worthless once it exits (the terminal
// restores the normal screen anyway), so drop each alternate-screen segment from
// the scrollback when it ends. Nothing to truncate mid-sequence, and the buffer
// stays small enough that truncation is rare in the first place.

export const MAX_BUFFER = 256 * 1024 // ~256 KB of replayable scrollback per terminal

export interface Scrollback {
  buffer: string
  // Nesting depth of the alternate screen (nvim can launch lazygit) and where in
  // `buffer` the outermost segment starts.
  altDepth: number
  altMark: number
}

export function newScrollback(): Scrollback {
  return { buffer: '', altDepth: 0, altMark: 0 }
}

// 1049 (xterm's save-cursor + alt screen), plus the older 47/1047 spellings.
const ALT_SCREEN = /\x1b\[\?(?:1049|1047|47)([hl])/g

export function appendScrollback(sb: Scrollback, data: string): void {
  const base = sb.buffer.length
  sb.buffer += data

  // How much the buffer has shrunk while handling this chunk, so later matches
  // still map to the right absolute offset.
  let dropped = 0
  ALT_SCREEN.lastIndex = 0
  for (let m = ALT_SCREEN.exec(data); m; m = ALT_SCREEN.exec(data)) {
    if (m[1] === 'h') {
      if (sb.altDepth === 0) sb.altMark = base + m.index - dropped
      sb.altDepth++
    } else if (sb.altDepth > 0 && --sb.altDepth === 0) {
      const end = base + m.index + m[0].length - dropped
      sb.buffer = sb.buffer.slice(0, sb.altMark) + sb.buffer.slice(end)
      dropped += end - sb.altMark
    }
    // A stray leave with no enter (its start scrolled out before we got here) is
    // ignored: there's nothing to cut.
  }

  if (sb.buffer.length > MAX_BUFFER) {
    const cut = sb.buffer.length - MAX_BUFFER
    sb.buffer = sb.buffer.slice(cut)
    sb.altMark = Math.max(0, sb.altMark - cut)
  }
}
