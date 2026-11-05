// Part 1: a real session, a real page, annotated with real key and mouse events.
import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, FIXTURE, mcp, mcpPorts, targets, wait } from './cdp.mjs'
import { mainEval, pressInPage } from './main.mjs'

const DIR = dirname(fileURLToPath(import.meta.url))
const LOG = join(DIR, 'log.txt')
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
const worktree = process.cwd()
const made = (await mcp(port, 'create_session', { worktree, title: 'annotate proof', model: 'haiku', select: true })).content[0].text
say('create_session ' + made.slice(0, 200))
const created = JSON.parse(made)
const sessionId = created.sessionId ?? created.id ?? created.session?.id
// Read-only on purpose: this session gets a real prompt below.
say('update_session ' + (await mcp(port, 'update_session', { session_id: sessionId, mode: 'plan' })).content[0].text.slice(0, 160))
writeFileSync(join(DIR, 'session.txt'), String(sessionId))
await wait(800)
say('open_browser ' + JSON.stringify((await mcp(port, 'open_browser', { url: FIXTURE })).content[0].text).slice(0, 120))

const c = await app()
// On top without taking the keyboard: a covered window never shows the page.
// Part 2 lowers it and hides the app again.
await mainEval(`(() => { const win = require('electron').BrowserWindow.getAllWindows()[0]; win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); win.setAlwaysOnTop(true, 'screen-saver'); win.showInactive(); win.moveTop(); return true })()`)
await wait(1000)
say('window: ' + JSON.stringify(await mainEval(`(() => { const w = require('electron').BrowserWindow.getAllWindows()[0]; return { visible: w.isVisible(), onTop: w.isAlwaysOnTop(), focused: w.isFocused() } })()`)))
await c.send('Page.bringToFront')
// Regenerates the throwaway config copy's keymap, so the shipped default is live.
say('keybindings.reset ' + (await mcp(port, 'run_command', { command_id: 'keybindings.reset' })).content[0].text.slice(0, 100))
await wait(400)
say('panel focus: ' + await c.evaluate(`document.activeElement?.tagName`))
// Always the page on screen: an older session's page has the same url.
const shown = `require('electron').BrowserWindow.getAllWindows()[0].contentView.children[0].webContents`
const p = { evaluate: (js) => mainEval(`${shown}.executeJavaScript(${JSON.stringify(js)}, true)`), close() {} }
await until('page load', () => p.evaluate(`document.readyState === 'complete' && !!document.querySelector('button.pay')`))
await wait(600)
await c.shot(join(DIR, '01-browser-open.png'))

const stage = (x, y) =>
  c.evaluate(`(() => { const m = document.querySelector('.annotate-stage').getScreenCTM(); return { x: m.a*${x}+m.e, y: m.d*${y}+m.f } })()`)
const mouse = (type, at, buttons = 1) =>
  c.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 })
const dragPath = async (points) => {
  const screen = []
  for (const pt of points) screen.push(await stage(pt.x, pt.y))
  await mouse('mouseMoved', screen[0], 0)
  await mouse('mousePressed', screen[0])
  for (const pt of screen.slice(1)) await mouse('mouseMoved', pt)
  await mouse('mouseReleased', screen[screen.length - 1])
  await wait(60)
}
const Enter = () => c.key('Enter', 'Enter', { text: '\r', vk: 13 })
const rect = (sel) => p.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height } })()`)
const surface = () => c.evaluate(`!!document.querySelector('.browser-annotate')`)

// Electron 33 has setVisible but no getVisible, so record what the app asks for.
await mainEval(`(() => { const v = require('electron').BrowserWindow.getAllWindows()[0].contentView.children[0]; globalThis.__shown = []; const set = v.setVisible.bind(v); v.setVisible = (on) => { globalThis.__shown.push(on); set(on) }; return true })()`)
const viewShown = () => mainEval(`globalThis.__shown.at(-1)`)
check('the page view is mounted in the window', (await mainEval(`require('electron').BrowserWindow.getAllWindows()[0].contentView.children.length`)) === 1)

// The shortcut, pressed INSIDE the site's page, the hard path: the native view
// owns the keyboard there, and sendInputEvent goes through before-input-event
// exactly as a physical key does.
await p.evaluate(`window.__keys = []; addEventListener('keydown', (e) => window.__keys.push(e.key), true); 0`)
say('page visibility before the shortcut: ' + (await p.evaluate(`document.visibilityState`)))
// TEST DOUBLE, the only one in this run. This idle machine never shows the page,
// so capturePage has no surface (see the report). Only the pixels are replaced:
// Chrome renders the same URL at the page's own size. It also records what is on
// the page at the moment of capture, which is how browser_annotate's marks are
// checked below.
const waited = Date.now()
const [vw, vh] = await p.evaluate(`[innerWidth, innerHeight]`)
const pixels = join(DIR, 'fixture-pixels.png')
execFileSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2', `--screenshot=${pixels}`, `--window-size=${vw},${vh}`, FIXTURE], { stdio: 'ignore' })
say('stand-in pixels ' + JSON.stringify(await mainEval(`(() => { const { nativeImage } = require('electron'); const w = ${shown}; const image = nativeImage.createFromPath(${JSON.stringify(pixels)}); globalThis.__overlays = []; w.capturePage = async () => { globalThis.__overlays.push(await w.executeJavaScript("[...document.querySelectorAll('[data-floe-annotate] > div')].map((b) => ({ n: b.textContent, left: b.style.left, top: b.style.top }))", true)); return image }; return image.getSize() })()`)))
say(`page could be captured after waiting ${Date.now() - waited}ms`)
const t0 = Date.now()
await pressInPage('N', ['meta', 'shift'])
const opened = await until('surface', surface, 8000).catch(() => false)
say(`surface opened ${Date.now() - t0}ms after the key press`)
const err = await c.evaluate(`[...document.querySelectorAll('.browser-error')].map((e) => e.innerText)`)
check('super+shift+n pressed inside the page opens the surface', !!opened, err.join(' '))
check('the site never saw the shortcut', (await p.evaluate(`window.__keys.length`)) === 0)
if (!opened) process.exit(1)
await wait(300)
await c.send('Page.bringToFront')
check('the native page view is hidden while annotating', (await viewShown()) === false)
check('keyboard focus is on the surface', await c.evaluate(`document.activeElement?.classList.contains('browser-annotate')`))
const hints = await c.evaluate(`[...document.querySelectorAll('.annotate-hint')].map((h) => { const r = h.querySelector('rect'); return { hint: h.dataset.hint, x: +r.getAttribute('x'), y: +r.getAttribute('y') } })`)
say('hints ' + JSON.stringify(hints))
const pay = await rect('button.pay')
const payHint = hints.find((h) => Math.abs(h.x - pay.x) < 3 && Math.abs(h.y - pay.y) < 3)
check('the Pay button has a hint at its position', !!payHint, payHint?.hint)
await c.shot(join(DIR, '02-hints.png'))

// Mark 1, keyboard only.
await c.type(payHint.hint)
await until('note input', () => c.evaluate(`document.activeElement?.tagName === 'INPUT'`), 3000)
check('a hint places a mark and the note field takes focus', true)
await c.type('Too close to the total, and the green fails contrast')
await c.shot(join(DIR, '03-note.png'))
await Enter()
await wait(100)
check('Enter saves the note and returns to the surface', await c.evaluate(`document.activeElement?.classList.contains('browser-annotate')`))

// Mark 2, arrow with the mouse, tip on the card field.
const card = await rect('#card')
await c.type('a')
await dragPath([{ x: card.x + 200, y: card.y + 170 }, { x: card.x + 120, y: card.y + 80 }, { x: card.x + 40, y: card.y + 18 }])
await until('note input', () => c.evaluate(`document.activeElement?.tagName === 'INPUT'`), 3000)
await c.type('Add a card brand icon here')
await Enter()

// Mark 3, a box that gets undone, and a click-sized drag that must not count.
await c.type('b')
await dragPath([{ x: 40, y: 300 }, { x: 42, y: 301 }])
check('a tiny drag makes no mark', (await c.evaluate(`document.querySelectorAll('.annotate-notes li').length`)) === 2)
await dragPath([{ x: 30, y: 300 }, { x: 300, y: 380 }])
await until('note input', () => c.evaluate(`document.activeElement?.tagName === 'INPUT'`), 3000)
await Enter()
await wait(60)
check('a third mark exists before undo', (await c.evaluate(`document.querySelectorAll('.annotate-notes li').length`)) === 3)
await c.type('u')
await wait(60)
check('u removes the last mark', (await c.evaluate(`document.querySelectorAll('.annotate-notes li').length`)) === 2)

// Mark 3 for real: pen around the nav. Mark 4: text on the image.
const help = await rect('nav a:last-child')
await c.type('p')
await dragPath([
  { x: help.x - 8, y: help.y - 6 },
  { x: help.x + help.width + 8, y: help.y - 8 },
  { x: help.x + help.width + 10, y: help.y + help.height + 6 },
  { x: help.x - 8, y: help.y + help.height + 8 },
  { x: help.x - 8, y: help.y - 6 }
])
await until('note input', () => c.evaluate(`document.activeElement?.tagName === 'INPUT'`), 3000)
await c.type('Move this into the footer')
await Enter()
await c.type('t')
const at = await stage(120, 330)
await mouse('mouseMoved', at, 0)
await mouse('mousePressed', at)
await mouse('mouseReleased', at)
await until('note input', () => c.evaluate(`document.activeElement?.tagName === 'INPUT'`), 3000)
await c.type('Empty space')
await Enter()
await wait(100)
await c.shot(join(DIR, '04-all-marks.png'))
say('notes: ' + JSON.stringify(await c.evaluate(`[...document.querySelectorAll('.annotate-notes li')].map((l) => l.innerText.replace(/\\n/g, ' | '))`)))

// Send.
const before = await c.evaluate(`document.querySelector('textarea')?.value ?? null`)
await Enter()
await until('surface gone', async () => !(await surface()), 5000)
await wait(300)
check('Enter closes the surface', true)
check('the page view is back on screen', (await viewShown()) === true)
const focused = await c.evaluate(`document.activeElement?.tagName`)
check('focus lands in the composer', focused === 'TEXTAREA', focused)
const value = await c.evaluate(`document.activeElement?.value`)
say('--- composer text ---\n' + value + '---------------------')
check('the draft names image 01 and the page', value.startsWith((before ? before + '\n' : '') + 'image 01 ' + FIXTURE))
check('mark 1 is the Pay button with its note', /1\. .*pay.* "Pay now": Too close to the total/.test(value))
check('mark 2 resolved the arrow tip to the card field', /2\. .*#card "Card number": Add a card brand icon here/.test(value))
check('mark 3, a pen circle around Help, resolved to Help and not its parent', /3\. .*"Help": Move this into the footer/.test(value))
check('mark 4 is the text mark', /4\. .*Empty space/.test(value))
check('no field value leaked into the text', !value.includes('secret-field-value'))
const chips = await c.evaluate(`[...document.querySelectorAll('.attachments img')].map((i) => i.src)`)
check('one image chip is attached', chips.length === 1, `${chips.length}`)
if (chips[0]) {
  const b = Buffer.from(chips[0].slice(chips[0].indexOf(',') + 1), 'base64')
  writeFileSync(join(DIR, '06-attached-image.png'), b)
  say(`attached image: ${b.length} bytes`)
}
await c.shot(join(DIR, '05-composer.png'))
say(failed ? `\n${failed} FAILED` : '\nall part 1 checks passed')
c.close()
p.close()
process.exit(0)
