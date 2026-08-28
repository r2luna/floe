import { CanvasAddon } from '@xterm/addon-canvas'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal as Xterm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'

// The panel's colours, as xterm wants them. Kept next to the terminal rather
// than derived from the CSS variables: xterm needs concrete values at
// construction, and reading computed styles at mount would tie the shell's
// palette to whatever had painted first.
const THEME = {
  background: '#00000000', // transparent — the panel's own fill shows through
  foreground: '#c9ccd2',
  cursor: '#c9ccd2',
  selectionBackground: '#35496e88',
  black: '#22252c',
  red: '#c07a72',
  green: '#6ea86e',
  yellow: '#c9a05f',
  blue: '#7f9fd8',
  magenta: '#c07fb8',
  cyan: '#6fc3c3',
  white: '#c9ccd2',
  brightBlack: '#6d7280',
  brightRed: '#d3948c',
  brightGreen: '#8cc48c',
  brightYellow: '#dcbb7f',
  brightBlue: '#9db8e4',
  brightMagenta: '#d29ac9',
  brightCyan: '#8fd6d6',
  brightWhite: '#e8eaee'
}

// The solid colour to answer OSC 11 with. The theme background above is
// transparent so the panel shows through, but a program asking "what colour is
// the background?" must not be told "none": xterm's own answer is the
// transparent fill, which every program reads as black.
const SOLID_BG = '#141519'

// xterm's OSC colour replies use 16-bit channels — `rgb:rrrr/gggg/bbbb`. A plain
// hex answer is not the format the query asks for and programs ignore it.
const rgbChannels = (hex: string): string =>
  [1, 3, 5]
    .map((i) => {
      const b = hex.slice(i, i + 2)
      return b + b
    })
    .join('/')

/**
 * Commands sent from outside the panel — the Run button on a shell code block.
 * A panel that is mounted and done repainting takes them straight away; anything
 * sent before that waits here, because bytes typed while the scrollback is being
 * replayed come out interleaved with the repaint.
 */
const sinks = new Map<string, (data: string) => void>()
const waiting = new Map<string, string[]>()

export function sendToTerminal(termId: string, command: string): void {
  const data = `${command}\r`
  const sink = sinks.get(termId)
  if (sink) sink(data)
  else waiting.set(termId, [...(waiting.get(termId) ?? []), data])
}

/**
 * A live shell. The PTY lives in the main process keyed by `termId`, so the
 * session and its scrollback survive this component unmounting — closing the
 * panel hides the terminal, it does not kill the shell. Reopening replays it.
 */
export function TerminalPanel({ termId, cwd, branch }: { termId: string; cwd: string; branch: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const MONO = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim()

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Xterm({
      // The same stack as the rest of the app, read from --mono so there is one
      // definition rather than two that drift. xterm needs a concrete string —
      // it cannot take a CSS variable.
      fontFamily: MONO,
      fontSize: 12.5,
      // 1.25 is the most air we can give without TUIs (nvim, lazygit) showing
      // gaps between box-drawing characters.
      lineHeight: 1.25,
      cursorBlink: true,
      theme: THEME,
      allowProposedApi: true,
      // A TUI with mouse reporting on (claude, nvim, lazygit) eats drag —
      // ⌥-drag forces a local selection anyway.
      macOptionClickForcesSelection: true,
      allowTransparency: true
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_e, uri) => void window.rookery.openExternal(uri)))

    // Copy explicitly rather than relying on the browser's copy event: there is
    // no Electron edit menu behind this window to fire it, so ⌘C over a
    // selection did nothing. ⌃C stays SIGINT. Paste is deliberately NOT handled
    // — the native paste event already reaches xterm's textarea, and doing both
    // pasted the text twice.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !navigator.clipboard) return true
      if (!(e.metaKey || (e.ctrlKey && e.shiftKey))) return true
      if (e.code === 'KeyC' && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection())
        return false
      }
      return true
    })

    // OSC 52 — the only way a program on a remote box (nvim yank, tmux) can
    // reach this machine's clipboard. xterm ships no handler. Reads (`?`) are
    // ignored on purpose: we don't hand the clipboard back to a remote program.
    term.parser.registerOscHandler(52, (payload) => {
      const b64 = payload.slice(payload.indexOf(';') + 1)
      if (!b64 || b64 === '?' || !navigator.clipboard) return true
      try {
        const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
        void navigator.clipboard.writeText(new TextDecoder().decode(bytes))
      } catch {
        /* malformed payload — drop it */
      }
      return true
    })

    // Answer OSC 10/11 colour queries so programs detect a dark terminal.
    //
    // The reply goes through `term.input`, NOT straight to the PTY: that routes
    // it into onData, where the replay gate below can drop it. Writing directly
    // would answer the live shell with a query buried in replayed scrollback —
    // the stale reply lands as typed input at the prompt.
    const reply = (osc: number, hex: string): boolean => {
      term.input(`\x1b]${osc};rgb:${rgbChannels(hex)}\x07`, false)
      return true
    }
    term.parser.registerOscHandler(10, (d) => (d === '?' ? reply(10, THEME.foreground) : false))
    term.parser.registerOscHandler(11, (d) => (d === '?' ? reply(11, SOLID_BG) : false))

    term.open(host)
    try {
      term.loadAddon(new CanvasAddon())
    } catch {
      /* no WebGL/canvas — the DOM renderer still works */
    }
    fit.fit()
    term.focus()

    // Ask for the fallback face explicitly. A web font is only fetched when
    // something asks for it, and nothing ever does: CommitMonoPinguim leads the
    // stack and satisfies every ordinary character, so Maple Mono NF stays
    // unloaded and the Nerd Font glyphs it exists for — fish's prompt, eza's
    // icons — draw as tofu. Both weights, because the prompt is bold.
    const nerd = Promise.all([
      document.fonts.load('400 12.5px "Maple Mono NF"'),
      document.fonts.load('700 12.5px "Maple Mono NF"')
    ])

    // Re-fit once the fonts are in: measuring against the fallback gives shorter
    // cells and over-counts rows, which clips the prompt off the bottom as soon
    // as the real glyphs paint.
    void Promise.all([document.fonts.ready, nerd]).then(() => {
      try {
        fit.fit()
        void window.rookery.terminal.resize(termId, term.cols, term.rows)
        // The canvas renderer caches glyph bitmaps; a face arriving after the
        // first paint needs the atlas thrown away or the tofu stays on screen.
        term.clearTextureAtlas()
        term.scrollToBottom()
      } catch {
        /* host gone */
      }
    })

    // While the scrollback is repainted on reopen, xterm answers any query
    // sequences buried in the replayed bytes (OSC 11, DA, DSR). Those replies
    // surface through onData exactly like keystrokes, so forwarding is gated
    // until the replay write flushes — otherwise they get typed into the prompt.
    let replaying = false

    // Live output that arrived before the scrollback did. Re-attaching resizes
    // the PTY, and the shell answers with a prompt redraw written relative to
    // the cursor — painting it on an empty screen leaves a stray prompt above
    // the replayed one. Held until the replay is queued, then released in order.
    let held: string[] | null = []

    const off = window.rookery.terminal.onEvent((event) => {
      if (event.id !== termId) return
      if (event.kind === 'data') {
        if (held) held.push(event.data)
        else term.write(event.data)
      } else if (event.kind === 'exit') {
        term.write(`\r\n\x1b[90m[process exited (${event.code})]\x1b[0m\r\n`)
      }
    })

    let gone = false

    // Repaint the scrollback (when re-attaching), then let the held live output
    // through. The catch matters: an open that fails must still release the
    // queue, or the panel sits blank forever with the shell talking to nobody.
    const release = (scrollback: string | null): void => {
      if (gone) return // panel closed while the reply was in flight
      if (scrollback) {
        replaying = true
        term.write(scrollback, () => {
          replaying = false
          arm()
        })
      }
      const queued = held ?? []
      held = null
      for (const data of queued) term.write(data)
      if (!scrollback) arm()
    }

    // Ready to be typed into: from here a command from the chat lands at a
    // settled prompt rather than mid-replay.
    const arm = () => {
      if (gone) return
      const sink = (data: string) => void window.rookery.terminal.write(termId, data)
      sinks.set(termId, sink)
      for (const data of waiting.get(termId) ?? []) sink(data)
      waiting.delete(termId)
    }

    void window.rookery.terminal
      .open(termId, cwd, branch, term.cols, term.rows)
      .then(release, () => release(null))

    const input = term.onData((data) => {
      if (replaying) return
      void window.rookery.terminal.write(termId, data)
    })

    const resize = new ResizeObserver(() => {
      try {
        fit.fit()
        void window.rookery.terminal.resize(termId, term.cols, term.rows)
      } catch {
        /* not laid out yet */
      }
    })
    resize.observe(host)

    return () => {
      gone = true
      sinks.delete(termId)
      off()
      input.dispose()
      resize.disconnect()
      term.dispose()
      // The PTY is deliberately left running in the main process.
    }
  }, [termId, cwd, branch])

  return (
    <div className="terminal-panel">
      <div className="terminal-host" ref={hostRef} />
    </div>
  )
}
