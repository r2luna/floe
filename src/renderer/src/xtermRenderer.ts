import { CanvasAddon } from '@xterm/addon-canvas'
import { WebglAddon } from '@xterm/addon-webgl'
import type { Terminal } from '@xterm/xterm'

/**
 * The fastest renderer this machine offers, after `term.open()`.
 *
 * WebGL first: it is the maintained xterm renderer and paints heavy output
 * (a build log, a TUI redraw) at a fraction of the canvas addon's cost. The
 * canvas addon is deprecated but still ships, so it is the fallback when a
 * WebGL context cannot be created — and again when one is lost later, which
 * happens on a GPU reset or when too many contexts are open at once; without
 * that hand-off the pane would just stop painting. Neither is required: the
 * DOM renderer still works with no addon at all.
 */
export function loadRenderer(term: Terminal): void {
  try {
    const webgl = new WebglAddon()
    webgl.onContextLoss(() => {
      webgl.dispose()
      loadCanvas(term)
    })
    term.loadAddon(webgl)
  } catch {
    loadCanvas(term)
  }
}

function loadCanvas(term: Terminal): void {
  try {
    term.loadAddon(new CanvasAddon())
  } catch {
    /* no canvas either — the DOM renderer still works */
  }
}
