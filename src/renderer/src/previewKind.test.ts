import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FileContent } from '../../shared/types'
import { extOf, isConvertible, previewKind } from './previewKind.ts'

const text: FileContent = { kind: 'text', text: 'x' }

test('extOf ignores directories and dotfiles', () => {
  assert.equal(extOf('a/b/deck.PPTX'), 'pptx')
  assert.equal(extOf('src/main/index.ts'), 'ts')
  assert.equal(extOf('Makefile'), '')
  // A leading dot is the name, not an extension: `.gitignore` is not a file of
  // type "gitignore".
  assert.equal(extOf('.gitignore'), '')
})

test('markdown is markdown only when it also came back as text', () => {
  assert.equal(previewKind('notes.md', text), 'markdown')
  assert.equal(previewKind('notes.mdx', text), 'markdown')
  assert.equal(previewKind('notes.md', { kind: 'image', dataUrl: 'data:,' }), 'image')
})

test('anything else that is text reads as code', () => {
  assert.equal(previewKind('src/index.ts', text), 'code')
  assert.equal(previewKind('LICENSE', text), 'code')
})

test('a deck is slides whether or not its text could be read', () => {
  assert.equal(previewKind('deck.pptx', { kind: 'slides', slides: [] }), 'slides')
  // .ppt has no text half — it comes back binary and still gets the slides view,
  // which is what asks LibreOffice to draw it.
  assert.equal(previewKind('deck.ppt', { kind: 'binary' }), 'slides')
  assert.equal(previewKind('photo.zip', { kind: 'binary' }), 'none')
})

test('convertible is the deck formats, and nothing else', () => {
  assert.ok(isConvertible('a.pptx'))
  assert.ok(isConvertible('a.ppt'))
  assert.ok(isConvertible('a.odp'))
  assert.equal(isConvertible('a.pdf'), false)
  assert.equal(isConvertible('a.md'), false)
})

test('a pdf is the viewer', () => {
  assert.equal(previewKind('spec.pdf', { kind: 'pdf', dataUrl: 'data:,' }), 'pdf')
})
