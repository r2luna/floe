import test from 'node:test'
import assert from 'node:assert/strict'
import { hrefOf, splitLinks } from './links.ts'

test('a url is split out of the sentence around it', () => {
  assert.deepEqual(splitLinks('veja https://floe.dev/docs e volta'), [
    { text: 'veja ' },
    { url: 'https://floe.dev/docs' },
    { text: ' e volta' }
  ])
})

test('the full stop after a link is not part of it', () => {
  assert.deepEqual(splitLinks('ta em https://floe.dev/docs.'), [
    { text: 'ta em ' },
    { url: 'https://floe.dev/docs' },
    { text: '.' }
  ])
})

test('a link inside parentheses keeps the parenthesis out', () => {
  assert.deepEqual(splitLinks('(https://floe.dev/a)'), [
    { text: '(' },
    { url: 'https://floe.dev/a' },
    { text: ')' }
  ])
})

test('parentheses that belong to the url stay in it', () => {
  assert.deepEqual(splitLinks('https://en.wikipedia.org/wiki/Fjord_(landform)'), [
    { url: 'https://en.wikipedia.org/wiki/Fjord_(landform)' }
  ])
})

test('www is a link, and the character before it is not swallowed', () => {
  assert.deepEqual(splitLinks('abre www.floe.dev ai'), [
    { text: 'abre ' },
    { url: 'www.floe.dev' },
    { text: ' ai' }
  ])
})

test('www mid-word is not a link', () => {
  assert.deepEqual(splitLinks('foo.www.bar'), [{ text: 'foo.www.bar' }])
})

test('mailto is a link', () => {
  assert.deepEqual(splitLinks('manda pra mailto:rafael@lunardelli.me'), [
    { text: 'manda pra ' },
    { url: 'mailto:rafael@lunardelli.me' }
  ])
})

test('a bare domain and a file name are left alone', () => {
  assert.deepEqual(splitLinks('olha example.com e panels.tsx'), [
    { text: 'olha example.com e panels.tsx' }
  ])
})

test('two links in one line are two parts', () => {
  assert.deepEqual(
    splitLinks('https://a.dev/1 e https://b.dev/2').filter((p) => p.url),
    [{ url: 'https://a.dev/1' }, { url: 'https://b.dev/2' }]
  )
})

test('text with no link is one run', () => {
  assert.deepEqual(splitLinks('nada aqui'), [{ text: 'nada aqui' }])
})

test('a scheme-less link is opened over https', () => {
  assert.equal(hrefOf('www.floe.dev'), 'https://www.floe.dev')
  assert.equal(hrefOf('https://floe.dev'), 'https://floe.dev')
  assert.equal(hrefOf('mailto:rafael@lunardelli.me'), 'mailto:rafael@lunardelli.me')
})
