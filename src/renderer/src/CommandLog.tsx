import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal as Xterm } from '@xterm/xterm'
import { loadRenderer } from './xtermRenderer'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'
import { onXtermTheme, xtermTheme } from './xtermTheme'

/**
 * A command's output, read-only.
 *
 * Mirrors the runner's PTY: attaching replays the scrollback main has kept, then
 * streams. It never sends input — a registered command is started, stopped and
 * restarted by name, from the row or a keybinding, so a cursor blinking here
 * would promise a prompt that does not exist.
 *
 * `cmdKey` is `<worktreePath>#<id>`, the same key the runner uses. The panel is
 * keyed on it too, so switching rows tears this down and builds a fresh one
 * rather than writing a second command's output into the first one's scrollback.
 */
export function CommandLog({ cmdKey }: { cmdKey: string }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const MONO = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim()

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Xterm({
      fontFamily: MONO,
      // Whole pixels, like Terminal.tsx — see the comment there: a fractional
      // size blurs every glyph the canvas/WebGL addons draw themselves.
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: false,
      disableStdin: true,
      theme: xtermTheme(),
      allowProposedApi: true,
      allowTransparency: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_e, uri) => void window.floe.openExternal(uri)))
    term.open(host)
    loadRenderer(term)
    fit.fit()

    const off = window.floe.commands.onEvent((event) => {
      if (event.key !== cmdKey) return
      if (event.kind === 'data') term.write(event.data)
      else if (event.kind === 'exit')
        // Dim, and on its own lines: the output above it is the program's, this
        // line is the app's, and they must not read as the same voice.
        term.write(`\r\n\x1b[90m[exited ${event.code}]\x1b[0m\r\n`)
    })

    // Replay whatever this command has already printed, then follow it. The
    // attach also tells main the size, so a long line wraps to this panel.
    void window.floe.commands.attach(cmdKey, term.cols, term.rows)

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        void window.floe.commands.resize(cmdKey, term.cols, term.rows)
      } catch {
        /* not laid out yet */
      }
    })
    ro.observe(host)
    const offTheme = onXtermTheme(() => (term.options.theme = xtermTheme()))

    return () => {
      off()
      offTheme()
      ro.disconnect()
      term.dispose()
    }
  }, [cmdKey, MONO])

  return (
    <div className="cmdlog">
      <div className="cmdlog-host" ref={hostRef} />
    </div>
  )
}
