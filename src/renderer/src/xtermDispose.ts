import type { Terminal } from '@xterm/xterm'

/**
 * `term.dispose()`, and the GPU memory with it.
 *
 * The WebGL addon drops its canvas but never loses the context, so the canvas's
 * buffers stay allocated until a garbage collection happens to reach them —
 * five of them, each the size of the panel. Losing the context frees them now.
 * It comes after the dispose so the addon's context-loss fallback has stopped
 * listening. The other canvases hold 2D contexts, for which this asks nothing.
 */
export function disposeTerminal(term: Terminal): void {
  const canvases = [...(term.element?.querySelectorAll('canvas') ?? [])]
  term.dispose()
  for (const canvas of canvases) {
    canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
