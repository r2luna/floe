import assert from 'node:assert/strict'
import test from 'node:test'
import { classify, insertImageRef, renumberImageRefs } from './attachments.ts'

const f = (name: string, type = '') => ({ name, type })

test('images are recognised by mime type', () => {
  assert.equal(classify(f('shot.png', 'image/png')), 'image')
  assert.equal(classify(f('anim.gif', 'image/gif')), 'image')
})

test('pdfs are recognised by mime OR extension', () => {
  assert.equal(classify(f('spec.pdf', 'application/pdf')), 'pdf')
  // Some drags arrive with no mime type at all.
  assert.equal(classify(f('spec.pdf')), 'pdf')
})

test('text files are recognised by mime type', () => {
  assert.equal(classify(f('a.txt', 'text/plain')), 'text')
  assert.equal(classify(f('a.json', 'application/json')), 'text')
})

test('source files fall back to the extension when the mime is useless', () => {
  // The common real case: browsers report '' or octet-stream for source code.
  assert.equal(classify(f('index.tsx', '')), 'text')
  assert.equal(classify(f('main.rs', 'application/octet-stream')), 'text')
  assert.equal(classify(f('.gitignore', '')), 'text')
})

test('unsupported binaries are rejected rather than mangled', () => {
  assert.equal(classify(f('archive.zip', 'application/zip')), null)
  assert.equal(classify(f('report.docx', '')), null)
  assert.equal(classify(f('noextension', '')), null)
})

test('extension matching ignores case', () => {
  assert.equal(classify(f('README.MD', '')), 'text')
  assert.equal(classify(f('Spec.PDF', '')), 'pdf')
})

test('the reference lands at the caret, spaced off the words around it', () => {
  const out = insertImageRef('crop this', 4, 1)
  assert.equal(out.text, 'crop image 01 this')
  // Caret sits after the token, ready for the rest of the sentence.
  assert.equal(out.text.slice(0, out.caret), 'crop image 01')
})

test('a reference at the end of the text needs no trailing space', () => {
  assert.equal(insertImageRef('crop', 4, 2).text, 'crop image 02')
})

test('an empty composer takes the reference bare', () => {
  assert.equal(insertImageRef('', 0, 1).text, 'image 01')
})

test('removing an image drops its reference and renumbers the rest', () => {
  assert.equal(renumberImageRefs('a image 01 b image 02 c', 1), 'a b image 01 c')
})

test('removing the last image leaves the ones before it alone', () => {
  assert.equal(renumberImageRefs('a image 01 b image 02', 2), 'a image 01 b')

  // Tokens written in the older bracketed spelling still name their image.
  assert.equal(renumberImageRefs('a [Image #1] b [Image #2]', 1), 'a b image 01')
})

test('prose that merely says "image" is not a reference', () => {
  assert.equal(renumberImageRefs('see image 2 above', 1), 'see image 2 above')
  assert.equal(renumberImageRefs('reimage 01 it', 1), 'reimage 01 it')
})

test('text with no reference to the removed image is untouched', () => {
  assert.equal(renumberImageRefs('nothing here', 1), 'nothing here')
})
