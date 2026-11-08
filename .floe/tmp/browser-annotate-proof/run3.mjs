// Part 3: the panel's own failure line, with the real capturePage on a never-shown page.
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, mcp, mcpPorts, wait } from './cdp.mjs'
import { mainEval } from './main.mjs'

const DIR = dirname(fileURLToPath(import.meta.url))
const say = (s) => {
  console.log(s)
  appendFileSync(join(DIR, 'log.txt'), s + '\n')
}
const port = mcpPorts()[0]
const c = await app()
try {
  await c.evaluate(`document.querySelector('.browser-address input').focus()`)
  await wait(200)
  say('run_command: ' + (await mcp(port, 'run_command', { command_id: 'browser.annotate' })).content[0].text.slice(0, 200))
  let line = ''
  for (let i = 0; i < 40 && !line; i++) {
    await wait(150)
    line = (await c.evaluate(`document.querySelector('.browser-annotate') ? 'surface' : [...document.querySelectorAll('.browser-error')].map((e) => e.innerText).join(' ')`))
  }
  say('from the panel: ' + line)
  say(`${line === 'surface' || /Could not capture this page/.test(line) ? 'PASS' : 'FAIL'}  the panel either opens or says it could not capture`)
  await c.shot(join(DIR, '09-capture-failure.png'))
} finally {
  await mainEval(`(() => { const { app, BrowserWindow } = require('electron'); const w = BrowserWindow.getAllWindows()[0]; w.setAlwaysOnTop(false); w.setVisibleOnAllWorkspaces(false); app.hide(); return true })()`)
  say('window lowered and hidden')
  c.close()
}
process.exit(0)
