import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installHook } from './config/hook.test-helper.ts'

installHook()

const { browserShortcut, normalizeBrowserUrl } = await import('./browser.ts')

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
  assert.equal(browserShortcut(input('w', { meta: true })), 'panel.close')
  assert.equal(browserShortcut(input('h', { control: true })), 'panel.left')
  assert.equal(browserShortcut(input('l', { control: true })), 'panel.right')
  assert.equal(browserShortcut(input('a')), undefined)
})
