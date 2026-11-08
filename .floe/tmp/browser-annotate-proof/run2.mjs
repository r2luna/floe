// Part 2: the rest of the surface area, on the session part 1 left on screen.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, mcp, mcpPorts, wait } from './cdp.mjs'
import { mainEval } from './main.mjs'

const DIR = dirname(fileURLToPath(import.meta.url))
const LOG = join(DIR, 'log.txt')
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
    await wait(150)
  }
  throw new Error('timed out waiting for ' + what)
}
const port = mcpPorts()[0]
const sessionId = readFileSync(join(DIR, 'session.txt'), 'utf8').trim()
const c = await app()
const shown = `require('electron').BrowserWindow.getAllWindows()[0].contentView.children[0].webContents`
const inPage = (js) => mainEval(`${shown}.executeJavaScript(${JSON.stringify(js)}, true)`)
const surface = () => c.evaluate(`!!document.querySelector('.browser-annotate')`)
const composer = () => c.evaluate(`[...document.querySelectorAll('textarea')].map((t) => t.value).join('')`)
const chips = () => c.evaluate(`document.querySelectorAll('.attachments img').length`)
const Esc = () => c.key('Escape', 'Escape', { vk: 27 })
const run = async (id) => (await mcp(port, 'run_command', { command_id: id })).content[0].text
const focusBrowserPanel = () => c.evaluate(`document.querySelector('.browser-address input').focus()`)

say('\n--- the agent reads what was sent ---')
const question = 'In one short paragraph: what do you see marked on image 01, and which CSS selector does mark 2 point at? Do not use any tools.'
await c.evaluate(`document.querySelector('textarea').focus()`)
const draft = await composer()
await c.type(question)
await c.key('Enter', 'Enter', { text: '\r', vk: 13 })
await until('send', async () => (await chips()) === 0 && !(await composer()).includes('Do not use any tools'), 8000)
check('sending clears the draft and the chip', true)
const running = async () => JSON.parse((await mcp(port, 'list_sessions')).content[0].text).find((s) => s.id === sessionId)
await until('turn to start', async () => (await running())?.running, 20000).catch(() => say('never saw running=true'))
await until('turn to finish', async () => !(await running())?.running, 170000)
await wait(600)
const output = (await mcp(port, 'read_session_output', { session_id: sessionId })).content[0].text
writeFileSync(join(DIR, 'agent-output.txt'), output)
say('--- agent output ---\n' + output.slice(-1400) + '\n--------------------')
await c.shot(join(DIR, '07-agent-reply.png'))
check('the reply names the Pay button', /pay/i.test(output))
check('the reply names the card selector', /#card/.test(output))

say('\n--- Esc discards and returns to the page ---')
await focusBrowserPanel()
await run('browser.annotate')
await until('surface', surface, 8000)
check('the command opens the surface (agent path: run_command)', true)
const beforeDiscard = await composer()
await c.evaluate(`document.querySelector('.browser-annotate').focus()`)
await Esc()
await until('surface gone', async () => !(await surface()), 4000)
check('Esc closes the surface', true)
check('discarding leaves the composer alone', (await composer()) === beforeDiscard && (await chips()) === 0)

say('\n--- super+shift+n from the toolbar focus, through the keymap ---')
await focusBrowserPanel()
await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'N', code: 'KeyN', modifiers: 4 | 8, windowsVirtualKeyCode: 78 })
await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'N', code: 'KeyN', modifiers: 4 | 8, windowsVirtualKeyCode: 78 })
await until('surface', surface, 8000)
check('the chord opens it with focus on the address field', true)
await c.evaluate(`document.querySelector('.browser-annotate').focus()`)
await Esc()
await until('surface gone', async () => !(await surface()), 4000)

say('\n--- the toolbar pencil ---')
await c.evaluate(`document.querySelector('.browser-toolbar button[aria-label="Annotate page"]').click()`)
await until('surface', surface, 8000)
check('the pencil button opens it', true)

say('\n--- sending with no marks attaches the plain capture ---')
await c.evaluate(`document.querySelector('.browser-annotate').focus()`)
await c.key('Enter', 'Enter', { text: '\r', vk: 13 })
await until('surface gone', async () => !(await surface()), 5000)
await wait(200)
check('a plain capture lands in the composer', (await chips()) === 1 && /image 01 http/.test(await composer()), JSON.stringify((await composer()).slice(0, 70)))
await c.evaluate(`document.querySelector('.attachments button')?.click()`)
await wait(100)
check('removing the chip takes its token too', (await chips()) === 0 && !/image 01/.test(await composer()), JSON.stringify((await composer()).slice(0, 80)))
await c.evaluate(`(() => { const t = document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })) })()`)

say('\n--- browser_annotate, the agent tool ---')
const tool = await mcp(port, 'browser_annotate', {
  marks: [
    { target: 'button.pay', note: 'too green' },
    { target: '#card', note: 'needs an icon' },
    { target: '.does-not-exist', note: 'should say so' }
  ]
})
const image = tool.content.find((x) => x.type === 'image')
const text = tool.content.find((x) => x.type === 'text')
say(text?.text ?? JSON.stringify(tool).slice(0, 300))
check('it returns an image', !!image)
if (image) writeFileSync(join(DIR, '08-agent-tool-image.png'), Buffer.from(image.data, 'base64'))
check('the list says what each mark landed on', /1\. button\.pay "Pay now": too green/.test(text?.text ?? '') && /2\. #card "Card number": needs an icon/.test(text?.text ?? ''))
check('a missing target is reported, not hidden', /3\. not found: \.does-not-exist: should say so/.test(text?.text ?? ''))
const overlay = (await mainEval(`globalThis.__overlays.at(-1)`)) ?? []
say('on the page at the moment of capture: ' + JSON.stringify(overlay))
check('the two found marks were drawn on the page during the capture', overlay.length === 2 && overlay[0].n === '1' && overlay[1].n === '2')
check('the marks are gone from the page afterwards', (await inPage(`document.querySelectorAll('[data-floe-annotate]').length`)) === 0)
check('the page kept its field value', (await inPage(`document.querySelector('#email').value`)) === 'secret-field-value@acme.test')

say('\n--- the real capturePage, on this never-shown page: an honest failure ---')
await mainEval(`delete ${shown}.capturePage`)
const real = await mcp(port, 'browser_annotate', { marks: [{ target: 'button.pay', note: 'x' }] })
say('browser_annotate: ' + (real.content.find((x) => x.type === 'text')?.text ?? '').slice(0, 160))
check('a failed capture still takes its marks off the page', (await inPage(`document.querySelectorAll('[data-floe-annotate]').length`)) === 0)
await run('browser.annotate')
const line = await until('an outcome', async () => {
  if (await surface()) return 'surface'
  return c.evaluate(`[...document.querySelectorAll('.browser-error')].map((e) => e.innerText).join(' ')`)
}, 6000)
say('from the panel: ' + line)
check('the panel either opens or says it could not capture', line === 'surface' || /Could not capture this page/.test(line))

await mainEval(`(() => { const { app, BrowserWindow } = require('electron'); const w = BrowserWindow.getAllWindows()[0]; w.setAlwaysOnTop(false); w.setVisibleOnAllWorkspaces(false); app.hide(); return true })()`)
say(failed ? `\n${failed} FAILED in part 2` : '\nall part 2 checks passed')
c.close()
process.exit(0)
