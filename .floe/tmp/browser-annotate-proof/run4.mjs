// Mouse only: every step below is a real click or drag, no shortcut, no hint keys.
// The note is the one thing typed, because a note is words.
import { appendFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, FIXTURE, mcp, mcpPorts, targets, wait } from './cdp.mjs'
import { mainEval } from './main.mjs'

const DIR = dirname(fileURLToPath(import.meta.url))
const LOG = join(DIR, 'log-mouse.txt')
writeFileSync(LOG, '')
const say = (s) => {
  console.log(s)
  appendFileSync(LOG, s + '\n')
}
let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  say(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`)
}
const until = async (what, fn, ms = 15000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn().catch(() => null)
    if (v) return v
    await wait(100)
  }
  throw new Error('timed out waiting for ' + what)
}

for (let i = 0; i < 60; i++) {
  if (await targets().then((l) => l.some((t) => t.type === 'page')).catch(() => false)) break
  await wait(1000)
}
await wait(3000)
const port = mcpPorts()[0]
const made = JSON.parse((await mcp(port, 'create_session', { worktree: process.cwd(), title: 'annotate mouse', model: 'haiku', select: true })).content[0].text)
writeFileSync(join(DIR, 'session.txt'), made.sessionId)
await wait(800)
const c = await app()
const lower = () => mainEval(`(() => { const { app, BrowserWindow } = require('electron'); const w = BrowserWindow.getAllWindows()[0]; w.setAlwaysOnTop(false); w.setVisibleOnAllWorkspaces(false); app.hide(); return true })()`)
try {
  await mainEval(`(() => { const win = require('electron').BrowserWindow.getAllWindows()[0]; win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); win.setAlwaysOnTop(true, 'screen-saver'); win.showInactive(); win.moveTop(); return true })()`)
  await c.send('Page.bringToFront')
  await mcp(port, 'open_browser', { url: FIXTURE })
  const shown = `require('electron').BrowserWindow.getAllWindows()[0].contentView.children[0].webContents`
  const inPage = (js) => mainEval(`${shown}.executeJavaScript(${JSON.stringify(js)}, true)`)
  await until('page load', () => inPage(`!!document.querySelector('button.pay')`))
  await wait(800)
  say('idle seconds: ' + (await mainEval(`require('electron').powerMonitor.getSystemIdleTime()`)) + ', page: ' + (await inPage(`document.visibilityState`)))
  await c.shot(join(DIR, '10-bottom-bar.png'))

  const centre = (sel, text) => c.evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => ${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  const mouse = (type, at, buttons = 1) => c.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 })
  const click = async (at) => {
    await mouse('mouseMoved', at, 0)
    await mouse('mousePressed', at)
    await mouse('mouseReleased', at)
  }
  const clickChip = async (sel, text) => click(await until(text, () => centre(sel, text), 3000))
  const stage = (x, y) => c.evaluate(`(() => { const m = document.querySelector('.annotate-stage').getScreenCTM(); return { x: m.a*${x}+m.e, y: m.d*${y}+m.f } })()`)
  const drag = async (points) => {
    const s = []
    for (const p of points) s.push(await stage(p.x, p.y))
    await mouse('mouseMoved', s[0], 0)
    await mouse('mousePressed', s[0])
    for (const p of s.slice(1)) await mouse('mouseMoved', p)
    await mouse('mouseReleased', s[s.length - 1])
    await wait(80)
  }
  const surface = () => c.evaluate(`!!document.querySelector('.browser-annotate')`)
  const count = () => c.evaluate(`document.querySelectorAll('.annotate-notes li').length`)
  const activeTool = () => c.evaluate(`document.querySelector('.annotate-tools [data-on]')?.innerText.replace(/\\s+/g, ' ')`)

  check('the bar sits under the page, not over it', await c.evaluate(`(() => { const v = document.querySelector('.browser-viewport').getBoundingClientRect(); const b = document.querySelector('.annotate-bar').getBoundingClientRect(); return b.top >= v.bottom - 1 })()`))
  check('the page view was resized to leave room for the bar', true, await mainEval(`JSON.stringify(require('electron').BrowserWindow.getAllWindows()[0].contentView.children[0].getBounds())`))

  // Is the real capture available now that someone may be at the machine?
  const realCapture = await mainEval(`${shown}.capturePage().then((i) => (i.isEmpty() ? 'empty' : 'real ' + JSON.stringify(i.getSize()))).catch((e) => 'no surface')`)
  say('real capturePage right now: ' + realCapture)
  if (!realCapture.startsWith('real')) {
    say('STAND-IN pixels for this run: the page has not been on screen')
    const png = join(DIR, 'fixture-pixels.png')
    await mainEval(`(() => { const { nativeImage } = require('electron'); const w = ${shown}; const image = nativeImage.createFromPath(${JSON.stringify(png)}); w.capturePage = async () => image; return true })()`)
  }

  await clickChip('.annotate-bar button', 'pen')
  const opened = await until('surface', surface, 5000).catch(() => false)
  check('clicking pen in the bar opens the surface', !!opened, await c.evaluate(`[...document.querySelectorAll('.browser-error')].map((e) => e.innerText).join(' ')`))
  if (!opened) throw new Error('surface did not open')
  await wait(300)
  check('the surface starts on the tool that was clicked', /pen/.test(await activeTool()), await activeTool())
  check('the tools are below the page while drawing', await c.evaluate(`document.querySelector('.annotate-tools').getBoundingClientRect().top >= document.querySelector('.annotate-stage').getBoundingClientRect().bottom - 1`))

  await drag([{ x: 400, y: 190 }, { x: 650, y: 185 }, { x: 660, y: 250 }, { x: 400, y: 255 }, { x: 400, y: 190 }])
  await until('note', () => c.evaluate(`document.activeElement?.tagName === 'INPUT'`), 3000)
  check('a pen stroke by mouse makes a mark', (await count()) === 1)
  await c.type('Circled by mouse')
  await clickChip('.annotate-tools button', 'arrow')
  await wait(100)
  check('clicking another tool saves the open note', /Circled by mouse/.test(await c.evaluate(`document.querySelector('.annotate-notes').innerText`)))
  check('and switches to it', /arrow/.test(await activeTool()), await activeTool())

  await drag([{ x: 300, y: 300 }, { x: 150, y: 180 }])
  await until('note', () => c.evaluate(`document.activeElement?.tagName === 'INPUT'`), 3000)
  check('an arrow by mouse makes a second mark', (await count()) === 2)
  await clickChip('.annotate-tools button', 'undo')
  await wait(100)
  check('clicking undo during a note removes that mark and its note field', (await count()) === 1 && !(await c.evaluate(`!!document.querySelector('.annotate-notes input')`)))

  await clickChip('.annotate-tools button', 'box')
  await drag([{ x: 20, y: 100 }, { x: 350, y: 240 }])
  await until('note', () => c.evaluate(`document.activeElement?.tagName === 'INPUT'`), 3000)
  await c.type('Typed, never saved with Enter')
  await c.shot(join(DIR, '11-mouse-drawing.png'))
  await clickChip('.annotate-foot button', 'send to composer')
  await until('surface gone', async () => !(await surface()), 5000)
  await wait(300)
  check('one click on send closes the surface', true)
  const value = await c.evaluate(`document.activeElement?.value ?? ''`)
  say('--- composer ---\n' + value + '----------------')
  check('focus lands in the composer', (await c.evaluate(`document.activeElement?.tagName`)) === 'TEXTAREA')
  check('the note still open at send time went with it', /Typed, never saved with Enter/.test(value))
  check('the first note is there too', /Circled by mouse/.test(value))
  check('a sloppy circle around Pay now resolved to the button', /1\. button\.pay "Pay now": Circled by mouse/.test(value))
  check('the undone arrow is not', value.split('\n').filter((l) => /^\d\./.test(l)).length === 2)
  const src = await c.evaluate(`document.querySelector('.attachments img')?.src ?? ''`)
  check('an image chip is attached', !!src)
  if (src) writeFileSync(join(DIR, '12-mouse-image.png'), Buffer.from(src.slice(src.indexOf(',') + 1), 'base64'))
  await c.shot(join(DIR, '13-mouse-composer.png'))

  say('\n--- real pixels: the paths earlier runs could not reach ---')
  say('page: ' + (await inPage(`document.visibilityState`)))
  const pressN = () => mainEval(`(() => { const w = ${shown}; const m = ['meta', 'shift']; w.sendInputEvent({ type: 'keyDown', keyCode: 'N', modifiers: m }); w.sendInputEvent({ type: 'keyUp', keyCode: 'N', modifiers: m }); return true })()`)
  await pressN()
  check('super+shift+n inside the page opens it on a real capture', !!(await until('surface', surface, 5000).catch(() => false)))
  await wait(300)
  await c.shot(join(DIR, '14-real-capture-surface.png'))
  await c.evaluate(`document.querySelector('.browser-annotate').focus()`)
  await c.key('Escape', 'Escape', { vk: 27 })
  await until('surface gone', async () => !(await surface()), 4000)
  await wait(400)
  say('after Esc: webContents focused=' + (await mainEval(`${shown}.isFocused()`)) + ', renderer active=' + (await c.evaluate(`document.activeElement?.tagName`)))
  const tool = await mcp(port, 'browser_annotate', { marks: [{ target: 'button.pay', note: 'too green' }, { target: '#card', note: 'needs an icon' }] })
  const image = tool.content.find((x) => x.type === 'image')
  say(tool.content.find((x) => x.type === 'text')?.text ?? '')
  check('browser_annotate returns real pixels', !!image)
  if (image) writeFileSync(join(DIR, '15-agent-tool-real.png'), Buffer.from(image.data, 'base64'))
  check('its marks are gone from the page afterwards', (await inPage(`document.querySelectorAll('[data-floe-annotate]').length`)) === 0)
} finally {
  await lower().catch(() => {})
}
say(failed ? `\n${failed} FAILED` : '\nall mouse checks passed')
c.close()
process.exit(0)
