import assert from 'node:assert/strict'
import test from 'node:test'
import { classify } from './attachments.ts'

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
