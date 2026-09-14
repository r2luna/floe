import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal as Xterm } from '@xterm/xterm'
import { loadRenderer } from './xtermRenderer'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'
import { resolveKey } from './keys'
import { onXtermTheme, rgbChannels, xtermSolidBg, xtermTheme } from './xtermTheme'
import { attachTerminal, detachTerminal, noteTerminalOutput } from './terminalBus'

/**
 * The commands a press is allowed to leave the terminal for. Kept deliberately
 * short: every chord listed here is one the shell stops receiving (⌃L no longer
 * clears, ⌃H no longer backspaces), and moving between columns is worth that
 * where killing a line or sending EOF is not.
 */
const LEAVES_TERMINAL = new Set<string>(['panel.left', 'panel.right'])

/**
 * A live shell. The PTY lives in the main process keyed by `termId`, so the
 * session and its scrollback survive this component unmounting — closing the
 * panel hides the terminal, it does not kill the shell. Reopening replays it.
 */
export function TerminalPanel({
  termId,
  cwd,
  branch,
  // 'editor' runs the configured terminal editor on this PTY instead of a
  // shell, on the requested file. Same machinery either way — an editor is a
  // program in a terminal, and the panel should not learn two ways to host one.
  mode = 'shell',
  file,
  line,
  onExit
}: {
  termId: string
  cwd: string
  branch: string
  mode?: 'shell' | 'editor'
  file?: string
  line?: number
  /**
   * The program on this PTY quit. Given, it replaces the exit notice: the
   * editor panel IS the editor, so a dead one has nothing left to show.
   */
  onExit?: () => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  // Through a ref, like `onOpen` elsewhere: this is a fresh arrow on every
  // parent render, and naming it as an effect dependency would tear the
  // terminal down and rebuild it on each one.
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit
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
      theme: xtermTheme(),
      allowProposedApi: true,
      // A TUI with mouse reporting on (claude, nvim, lazygit) eats drag —
      // ⌥-drag forces a local selection anyway.
      macOptionClickForcesSelection: true,
      allowTransparency: true
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_e, uri) => void window.floe.openExternal(uri)))

    // Copy explicitly rather than relying on the browser's copy event: there is
    // no Electron edit menu behind this window to fire it, so ⌘C over a
    // selection did nothing. ⌃C stays SIGINT. Paste is deliberately NOT handled
    // — the native paste event already reaches xterm's textarea, and doing both
    // pasted the text twice.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      // Hand the lane's own chords back to the window keymap. xterm listens in
      // CAPTURE on its textarea and stopPropagation()s every ctrl chord it turns
      // into a byte, so App's listener never saw ⌃H/⌃L — you could enter the
      // terminal from the keyboard but not leave it. Returning false makes xterm
      // ignore the press entirely: nothing goes to the PTY and the event bubbles
      // out untouched. Asked of the keymap rather than hardcoded, so rebinding
      // panel.left/right moves this with it.
      const action = resolveKey({
        key: e.key,
        meta: e.metaKey,
        ctrl: e.ctrlKey,
        shift: e.shiftKey,
        alt: e.altKey
      })
      if (action && LEAVES_TERMINAL.has(action.id)) return false
      if (!navigator.clipboard) return true
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
    term.parser.registerOscHandler(10, (d) => (d === '?' ? reply(10, xtermTheme().foreground) : false))
    term.parser.registerOscHandler(11, (d) => (d === '?' ? reply(11, xtermSolidBg()) : false))

    term.open(host)
    // The panel has no rows, so the lane would otherwise land focus on its
    // shell — where the keyboard reaches the app but not the shell. Marks the
    // one element worth focusing; see `focusSink` in App.tsx.
    term.textarea?.setAttribute('data-focus-sink', '')
    loadRenderer(term)
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
        void window.floe.terminal.resize(termId, term.cols, term.rows)
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

    const off = window.floe.terminal.onEvent((event) => {
      if (event.id !== termId) return
      if (event.kind === 'data') {
        // Restarts the quiet window a played command waits for — while the
        // shell is still talking, its terminal queries are still round-tripping.
        noteTerminalOutput(termId)
        if (held) held.push(event.data)
        else term.write(event.data)
      } else if (event.kind === 'exit') {
        // A shell keeps the notice — its scrollback is still worth reading, and
        // the panel is where you left it. An editor's caller closes the panel
        // instead, which is what puts the keyboard back on the file tree.
        if (onExitRef.current) onExitRef.current()
        else term.write(`\r\n\x1b[90m[process exited (${event.code})]\x1b[0m\r\n`)
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
      const sink = (data: string) => void window.floe.terminal.write(termId, data)
      attachTerminal(termId, sink)
    }

    void (mode === 'editor'
      ? window.floe.editor.open(termId, cwd, branch, file ?? null, term.cols, term.rows, line)
      : window.floe.terminal.open(termId, cwd, branch, term.cols, term.rows)
    ).then(release, () => release(null))

    const input = term.onData((data) => {
      if (replaying) return
      void window.floe.terminal.write(termId, data)
    })

    const resize = new ResizeObserver(() => {
      try {
        fit.fit()
        void window.floe.terminal.resize(termId, term.cols, term.rows)
      } catch {
        /* not laid out yet */
      }
    })
    resize.observe(host)
    const offTheme = onXtermTheme(() => (term.options.theme = xtermTheme()))

    return () => {
      gone = true
      detachTerminal(termId)
      off()
      offTheme()
      input.dispose()
      resize.disconnect()
      term.dispose()
      // The PTY is deliberately left running in the main process.
    }
    // `file` is a dependency: opening another file re-runs this, which re-attaches
    // to the same PTY and tells the editor to open it (see openEditor in main).
  }, [termId, cwd, branch, mode, file, line])

  return (
    <div className="terminal-panel">
      <div className="terminal-host" ref={hostRef} />
    </div>
  )
}
