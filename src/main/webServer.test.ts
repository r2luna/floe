import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mediaUrl } from './media.ts'
import {
  bootScript,
  injectBoot,
  mediaUrlFromRequest,
  resolveAsset,
  startWebServer,
  type WebBoot
} from './webServer.ts'

const root = mkdtempSync(join(tmpdir(), 'floe-web-'))
mkdirSync(join(root, 'assets'))
writeFileSync(join(root, 'index.html'), '<html><head><title>Floe</title></head><body></body></html>')
writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)')

const video = join(mkdtempSync(join(tmpdir(), 'floe-web-media-')), 'demo.mp4')
writeFileSync(video, Buffer.from('0123456789'))

const boot: WebBoot = {
  token: 'tok',
  homeDir: '/home/r2luna',
  platform: 'linux',
  version: '0.12.0',
  wsUrl: ''
}

test('the boot payload cannot close its own script tag', () => {
  const script = bootScript({ ...boot, homeDir: '/home/</script><script>alert(1)' })
  assert.ok(!script.includes('</script><script>'))
  assert.ok(script.includes('\\u003c/script'))
})

test('the page carries the boot payload into the head', () => {
  const html = injectBoot('<html><head><title>Floe</title></head><body></body></html>', boot)
  assert.ok(html.includes('window.__FLOE_BOOT__'))
  assert.ok(html.indexOf('window.__FLOE_BOOT__') < html.indexOf('</head>'))
})

test('a media request rebuilds exactly the url the renderer was given', () => {
  const path = '/tmp/my demo #2.mp4'
  const url = mediaUrl(path)
  const pathname = new URL(url).pathname
  assert.equal(mediaUrlFromRequest(`/media${pathname}`), url)
})

test('only /media/ is a media request', () => {
  assert.equal(mediaUrlFromRequest('/assets/app.js'), null)
})

test('an asset path may not escape the web root', () => {
  assert.equal(resolveAsset(root, '/../../etc/passwd'), null)
  assert.equal(resolveAsset(root, '/%2e%2e/%2e%2e/etc/passwd'), null)
  assert.equal(resolveAsset(root, '/assets/app.js'), join(root, 'assets', 'app.js'))
})

test('the server answers assets, deep links and byte ranges', async () => {
  const server = await startWebServer({ root, port: 0, boot })
  const { port } = server.address() as { port: number }
  const base = `http://127.0.0.1:${port}`
  try {
    const asset = await fetch(`${base}/assets/app.js`)
    assert.equal(asset.status, 200)
    assert.equal(await asset.text(), 'console.log(1)')

    // A path with no file behind it is a route the SPA owns.
    const deep = await fetch(`${base}/some/session/id`)
    assert.equal(deep.status, 200)
    assert.ok((await deep.text()).includes('window.__FLOE_BOOT__'))

    const range = await fetch(`${base}/media${new URL(mediaUrl(video)).pathname}`, {
      headers: { Range: 'bytes=2-4' }
    })
    assert.equal(range.status, 206)
    assert.equal(await range.text(), '234')
  } finally {
    server.close()
  }
})
