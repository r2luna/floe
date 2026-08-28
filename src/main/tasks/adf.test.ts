import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adfToMarkdown } from './adf.ts'

test('adfToMarkdown: empty / non-ADF inputs', () => {
  assert.equal(adfToMarkdown(null), '')
  assert.equal(adfToMarkdown(undefined), '')
  assert.equal(adfToMarkdown('plain'), 'plain')
  assert.equal(adfToMarkdown({ type: 'doc', version: 1 }), '')
})

test('adfToMarkdown: paragraphs, marks and links', () => {
  const adf = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
          { type: 'text', text: ' and ' },
          { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://x.io' } }] }
        ]
      }
    ]
  }
  assert.equal(adfToMarkdown(adf), 'Hello **bold** and [link](https://x.io)')
})

test('adfToMarkdown: heading, bullet list and code block', () => {
  const adf = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] }
        ]
      },
      { type: 'codeBlock', content: [{ type: 'text', text: 'const x = 1' }] }
    ]
  }
  assert.equal(adfToMarkdown(adf), '## Title\n\n- one\n- two\n\n```\nconst x = 1\n```')
})
