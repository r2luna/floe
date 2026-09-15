import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installHook } from './config/hook.test-helper.ts'

installHook()

const { browserKeyFor, browserShortcut, captureFullPage, handOffScreenshot, normalizeBrowserUrl, screenshotFileName, selectBrowserSession } =
  await import('./browser.ts')

test('normalizeBrowserUrl accepts local dev servers without forcing HTTPS', () => {
  assert.equal(normalizeBrowserUrl('localhost:5173'), 'http://localhost:5173')
  assert.equal(normalizeBrowserUrl('127.0.0.1:3000/app'), 'http://127.0.0.1:3000/app')
  assert.equal(normalizeBrowserUrl('0.0.0.0:4173'), 'http://0.0.0.0:4173')
  assert.equal(normalizeBrowserUrl('localhost:5173?mode=preview'), 'http://localhost:5173?mode=preview')
  assert.equal(normalizeBrowserUrl('localhost:5173#preview'), 'http://localhost:5173#preview')
  assert.equal(normalizeBrowserUrl('[::1]:8080'), 'http://[::1]:8080')
})

test('normalizeBrowserUrl preserves schemes and defaults public hosts to HTTPS', () => {
  assert.equal(normalizeBrowserUrl('http://example.test'), 'http://example.test')
  assert.equal(normalizeBrowserUrl('file:///tmp/demo.html'), 'file:///tmp/demo.html')
  assert.equal(normalizeBrowserUrl('example.com/demo'), 'https://example.com/demo')
  assert.equal(normalizeBrowserUrl('  '), 'about:blank')
})

const input = (key: string, extra: Partial<Electron.Input> = {}): Electron.Input =>
  ({ key, type: 'keyDown', ...extra }) as Electron.Input

test('browserShortcut preserves browser and Floe navigation while the page owns focus', () => {
  assert.equal(browserShortcut(input('l', { meta: true })), 'browser.address')
  assert.equal(browserShortcut(input('r', { meta: true })), 'browser.reload')
  assert.equal(browserShortcut(input('[', { meta: true })), 'browser.back')
  assert.equal(browserShortcut(input(']', { meta: true })), 'browser.forward')
  assert.equal(browserShortcut(input('i', { meta: true, alt: true })), 'browser.devtools')
  assert.equal(browserShortcut(input('S', { meta: true, shift: true })), 'browser.screenshot')
  assert.equal(browserShortcut(input('s', { meta: true })), undefined)
  assert.equal(browserShortcut(input('w', { meta: true })), 'panel.close')
  assert.equal(browserShortcut(input('h', { control: true })), 'panel.left')
  assert.equal(browserShortcut(input('l', { control: true })), 'panel.right')
  assert.equal(browserShortcut(input('a')), undefined)
})

test('screenshotFileName names the shot after the host and the local time', () => {
  const at = new Date(2026, 8, 14, 15, 30, 12)
  assert.equal(screenshotFileName('http://localhost:5173/app', at), 'localhost-5173-2026-09-14-153012.png')
  assert.equal(screenshotFileName('https://example.com', at), 'example.com-2026-09-14-153012.png')
  assert.equal(screenshotFileName('about:blank', at), 'page-2026-09-14-153012.png')
  assert.equal(screenshotFileName('not a url', at), 'page-2026-09-14-153012.png')
})

function fakeDesk(platform: NodeJS.Platform, cleanShot: boolean) {
  const calls: string[] = []
  return {
    calls,
    desk: {
      platform,
      hasCleanShot: () => cleanShot,
      openUrl: async (url: string) => void calls.push(`url ${url}`),
      copyImage: (file: string) => void calls.push(`copy ${file}`),
      openInPreview: async (file: string) => void calls.push(`preview ${file}`)
    }
  }
}

test('handOffScreenshot opens CleanShot annotate when it is installed', async () => {
  const { calls, desk } = fakeDesk('darwin', true)
  const result = await handOffScreenshot('/tmp/a b.png', desk)
  assert.deepEqual(result, { path: '/tmp/a b.png', openedIn: 'cleanshot' })
  assert.deepEqual(calls, ['url cleanshot://open-annotate?filepath=%2Ftmp%2Fa%20b.png'])
})

test('handOffScreenshot copies and opens Preview without CleanShot', async () => {
  const { calls, desk } = fakeDesk('darwin', false)
  assert.equal((await handOffScreenshot('/tmp/a.png', desk)).openedIn, 'preview')
  assert.deepEqual(calls, ['copy /tmp/a.png', 'preview /tmp/a.png'])
})

test('handOffScreenshot never asks for CleanShot off macOS', async () => {
  const { calls, desk } = fakeDesk('linux', true)
  assert.equal((await handOffScreenshot('/tmp/a.png', desk)).openedIn, 'preview')
  assert.deepEqual(calls, ['copy /tmp/a.png', 'preview /tmp/a.png'])
})

function fakeContents(opts: { attached?: boolean; attachThrows?: boolean }) {
  const log: string[] = []
  let attached = opts.attached ?? false
  const contents = {
    debugger: {
      isAttached: () => attached,
      attach: () => {
        if (opts.attachThrows) throw new Error('Another debugger is already attached')
        attached = true
        log.push('attach')
      },
      detach: () => {
        attached = false
        log.push('detach')
      },
      sendCommand: async (method: string, params?: { clip?: { height: number } }) => {
        log.push(params?.clip ? `${method} ${params.clip.height}` : method)
        if (method === 'Page.getLayoutMetrics') return { cssContentSize: { width: 800, height: 4000.5 } }
        return { data: Buffer.from('full').toString('base64') }
      }
    },
    capturePage: async () => ({ toPNG: () => Buffer.from('viewport') })
  }
  return { log, contents: contents as unknown as Electron.WebContents }
}

test('captureFullPage renders the whole document and detaches what it attached', async () => {
  const { log, contents } = fakeContents({})
  assert.equal((await captureFullPage(contents)).toString(), 'full')
  assert.deepEqual(log, ['attach', 'Page.getLayoutMetrics', 'Page.captureScreenshot 4001', 'detach'])
})

test('captureFullPage leaves an existing debugger attached', async () => {
  const { log, contents } = fakeContents({ attached: true })
  assert.equal((await captureFullPage(contents)).toString(), 'full')
  assert.ok(!log.includes('detach'))
})

test('captureFullPage falls back to the viewport when the debugger is taken', async () => {
  const { contents } = fakeContents({ attachThrows: true })
  assert.equal((await captureFullPage(contents)).toString(), 'viewport')
})

let nextWindowId = 1
const fakeWindow = () =>
  ({ webContents: { id: nextWindowId++ }, on: () => {}, isDestroyed: () => false }) as unknown as Electron.BrowserWindow

test('browserKeyFor gives each agent its own session page', () => {
  const win = fakeWindow()
  selectBrowserSession(win, 'chat-a')
  assert.equal(browserKeyFor(win, ['chat-a', 'claude-a']), 'chat-a')
  assert.equal(browserKeyFor(win, ['chat-b', 'claude-b']), 'chat-b')
  assert.equal(browserKeyFor(win, []), undefined)
})

test('browserKeyFor prefers the on-screen name when the lane keys the chat by another id', () => {
  const win = fakeWindow()
  selectBrowserSession(win, 'claude-a')
  assert.equal(browserKeyFor(win, ['chat-a', 'claude-a']), 'claude-a')
})
