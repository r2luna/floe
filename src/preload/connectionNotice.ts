// Transport-level UI for the attached window and the web client: the superseded
// overlay shown when another client takes the server. Plain DOM on purpose — it
// must render no matter what state React is in (App may be mid-teardown, or hung waiting on an invoke that
// can never arrive), and it's shared so both transports say the same thing.
import type { SocketStatus } from './socket'

// The preload typechecks under the node tsconfig (no DOM lib); module-scoped
// declarations shadow the real globals in the renderer build.
/* eslint-disable @typescript-eslint/no-explicit-any */
declare const document: any
declare const location: any
/* eslint-enable @typescript-eslint/no-explicit-any */

function withBody(fn: () => void): void {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn)
  else fn()
}

function showSuperseded(): void {
  withBody(() => {
    if (document.getElementById('rk-superseded')) return
    const el = document.createElement('div')
    el.id = 'rk-superseded'
    el.style.cssText =
      'position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;gap:14px;' +
      'align-items:center;justify-content:center;background:var(--bg,#0b0d10);color:var(--fg,#ccc);' +
      'font:13px system-ui,sans-serif;text-align:center'
    el.innerHTML =
      '<div>The server is being used by another window or tab.</div>' +
      '<button id="rk-resume" style="font:11px system-ui;padding:4px 10px;border-radius:1px;' +
      'border:1px solid var(--border,#333);background:var(--panel-2,#15181c);color:inherit;cursor:pointer">' +
      'Use here</button>'
    document.body.appendChild(el)
    document.getElementById('rk-resume')?.addEventListener('click', () => location.reload())
    document.getElementById('rk-resume')?.focus()
  })
}

/**
 * Drive the superseded overlay off the transport's status callback. A dropped
 * socket says nothing: it reconnects on its own, and the chip that used to
 * announce it was noise.
 */
export function showConnectionNotice(status: SocketStatus): void {
  if (status.superseded) showSuperseded()
}
