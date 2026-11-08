// The dev app's MAIN process, over the node inspector: the only place that can
// send input the way a keyboard does (sendInputEvent runs before-input-event).
export const INSPECT = 9472

export async function mainEval(expression) {
  const list = await (await fetch(`http://127.0.0.1:${INSPECT}/json`)).json()
  const ws = new WebSocket(list[0].webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  const result = await new Promise((resolve) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data)
      if (msg.id === 1) resolve(msg.result)
    }
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true } }))
  })
  ws.close()
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}

const ELECTRON = `require('electron')`
const PAGE = `${ELECTRON}.BrowserWindow.getAllWindows()[0].contentView.children[0].webContents`

/** A real key press into the site's page, modifiers and all. */
export const pressInPage = (keyCode, modifiers = []) =>
  mainEval(`(() => { const w = ${PAGE}; const m = ${JSON.stringify(modifiers)};
    w.sendInputEvent({ type: 'keyDown', keyCode: ${JSON.stringify(keyCode)}, modifiers: m });
    w.sendInputEvent({ type: 'keyUp', keyCode: ${JSON.stringify(keyCode)}, modifiers: m });
    return true })()`)

export const pageFacts = () =>
  mainEval(`(() => { const { BaseWindow, BrowserWindow } = ${ELECTRON}; const win = BrowserWindow.getAllWindows()[0]; const w = ${PAGE};
    return { windowVisible: win.isVisible(), windowFocused: win.isFocused(), minimized: win.isMinimized(), childViews: win.contentView.children.length, pageFocused: w?.isFocused(), pageHidden: w ? w.getOSProcessId() > 0 : null } })()`)
