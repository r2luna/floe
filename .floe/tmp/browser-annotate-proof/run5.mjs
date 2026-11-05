// Descriptions: every row keeps an editable field, filled in any order, by mouse.
import { appendFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, FIXTURE, mcp, mcpPorts, targets, wait } from './cdp.mjs'
import { mainEval } from './main.mjs'

const DIR = dirname(fileURLToPath(import.meta.url))
const LOG = join(DIR, 'log-descriptions.txt')
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
const made = JSON.parse((await mcp(port, 'create_session', { worktree: process.cwd(), title: 'annotate descriptions', model: 'haiku', select: true })).content[0].text)
say('session ' + made.sessionId)
await wait(800)
const c = await app()
try {
  await mainEval(`(() => { const win = require('electron').BrowserWindow.getAllWindows()[0]; win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); win.setAlwaysOnTop(true, 'screen-saver'); win.showInactive(); win.moveTop(); return true })()`)
  await c.send('Page.bringToFront')
  await mcp(port, 'open_browser', { url: FIXTURE })
  const shown = `require('electron').BrowserWindow.getAllWindows()[0].contentView.children[0].webContents`
  const inPage = (js) => mainEval(`${shown}.executeJavaScript(${JSON.stringify(js)}, true)`)
  await until('page load', () => inPage(`!!document.querySelector('button.pay')`))
  await wait(800)
  const real = await mainEval(`${shown}.capturePage().then((i) => (i.isEmpty() ? 'empty' : 'real')).catch(() => 'no surface')`)
  say('idle seconds: ' + (await mainEval(`require('electron').powerMonitor.getSystemIdleTime()`)) + ', capture: ' + real)
  if (real !== 'real') {
    say('STAND-IN pixels for this run: the page has not been on screen')
    await mainEval(`(() => { const { nativeImage } = require('electron'); const w = ${shown}; const image = nativeImage.createFromPath(${JSON.stringify(join(DIR, 'fixture-pixels.png'))}); w.capturePage = async () => image; return true })()`)
  }

  const centre = (sel, text) => c.evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => ${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  const mouse = (type, at, buttons = 1) => c.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 })
  const click = async (at) => {
    await mouse('mouseMoved', at, 0)
    await mouse('mousePressed', at)
    await mouse('mouseReleased', at)
    await wait(80)
  }
  const stage = (x, y) => c.evaluate(`(() => { const m = document.querySelector('.annotate-stage').getScreenCTM(); return { x: m.a*${x}+m.e, y: m.d*${y}+m.f } })()`)
  const drag = async (points) => {
    const s = []
    for (const p of points) s.push(await stage(p.x, p.y))
    await mouse('mouseMoved', s[0], 0)
    await mouse('mousePressed', s[0])
    for (const p of s.slice(1)) await mouse('mouseMoved', p)
    await mouse('mouseReleased', s[s.length - 1])
    await wait(100)
  }
  const rows = () => c.evaluate(`[...document.querySelectorAll('.annotate-notes li')].map((li) => ({ el: li.querySelector('.annotate-note-el').innerText, input: !!li.querySelector('input'), value: li.querySelector('input')?.value, placeholder: li.querySelector('input')?.placeholder }))`)
  const focusedRow = () => c.evaluate(`[...document.querySelectorAll('.annotate-notes input')].indexOf(document.activeElement)`)
  const rowInput = (i) => c.evaluate(`(() => { const r = document.querySelectorAll('.annotate-notes input')[${i}].getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 } })()`)

  await click(await centre('.annotate-bar button', 'box'))
  await until('surface', () => c.evaluate(`!!document.querySelector('.browser-annotate')`), 5000)
  await wait(300)
  const pay = await inPage(`(() => { const r = document.querySelector('button.pay').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })()`)
  const card = await inPage(`(() => { const r = document.querySelector('#card').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })()`)

  // Three marks, drawn one after another without describing any of them.
  await drag([{ x: pay.x - 4, y: pay.y - 4 }, { x: pay.x + pay.w + 4, y: pay.y + pay.h + 4 }])
  check('a new mark puts the caret in its own description', (await focusedRow()) === 0)
  await drag([{ x: card.x - 4, y: card.y - 4 }, { x: card.x + card.w + 4, y: card.y + card.h + 4 }])
  check('drawing the next mark straight away works on the first click', (await rows()).length === 2, JSON.stringify((await rows()).length))
  await click(await centre('.annotate-tools button', 'arrow'))
  await drag([{ x: 330, y: 420 }, { x: card.x + 30, y: card.y + 18 }])
  await c.key('Escape', 'Escape', { vk: 27 })
  await wait(100)
  let list = await rows()
  say('rows: ' + JSON.stringify(list))
  check('every row has a description field', list.length === 3 && list.every((r) => r.input))
  check('an empty one says it can be filled in', list.every((r) => r.placeholder === 'Add a description…'))
  check('Esc on an empty description leaves the mark in place', list.length === 3)
  check('Esc returns to the drawing keys', await c.evaluate(`document.activeElement?.classList.contains('browser-annotate')`))

  // Back to row 2 first, then row 1: any order, any time.
  await click(await rowInput(1))
  check('clicking row 2 puts the caret there', (await focusedRow()) === 1)
  await c.type('Card brand icon goes here')
  await click(await rowInput(0))
  await c.type('Contrast fails AA')
  await c.key('Escape', 'Escape', { vk: 27 })
  await wait(100)
  list = await rows()
  check('Esc keeps what was typed', list[0].value === 'Contrast fails AA', list[0].value)
  check('moving to another row kept the first description', list[1].value === 'Card brand icon goes here', list[1].value)

  // Edit an existing description, then a text mark that stays empty.
  await click(await rowInput(1))
  await c.evaluate(`document.activeElement.select()`)
  await c.type('Show the card brand icon')
  await click(await centre('.annotate-tools button', 'text'))
  await click(await stage(420, 470))
  check('a text mark opens its own row', (await rows()).length === 4 && (await focusedRow()) === 3)
  await c.key('Escape', 'Escape', { vk: 27 })
  await wait(100)
  check('a text mark left empty goes away', (await rows()).length === 3)
  await c.shot(join(DIR, '16-descriptions.png'))

  await click(await centre('.annotate-foot button', 'send to composer'))
  await until('surface gone', async () => !(await c.evaluate(`!!document.querySelector('.browser-annotate')`)), 5000)
  await wait(300)
  const value = await c.evaluate(`document.activeElement?.value ?? ''`)
  say('--- composer ---\n' + value + '----------------')
  check('row 1 went with its description', /1\. button\.pay "Pay now": Contrast fails AA/.test(value))
  check('the edited description replaced the old one', /2\. #card "Card number": Show the card brand icon$/m.test(value))
  check('the undescribed arrow still went, without a description', /^3\. #card "Card number"$/m.test(value))
  await c.shot(join(DIR, '17-descriptions-composer.png'))
} finally {
  await mainEval(`(() => { const { app, BrowserWindow } = require('electron'); const w = BrowserWindow.getAllWindows()[0]; w.setAlwaysOnTop(false); w.setVisibleOnAllWorkspaces(false); app.hide(); return true })()`).catch(() => {})
  await mcp(port, 'close_session', { session_id: made.sessionId }).catch(() => {})
}
say(failed ? `\n${failed} FAILED` : '\nall description checks passed')
c.close()
process.exit(0)
