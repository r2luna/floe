import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarize } from './index.ts'
import { expandSkeletons } from './skeleton.ts'
import type { DrawElement, DrawScene } from '../../shared/types.ts'

const scene = (elements: DrawElement[]): DrawScene => ({
  type: 'excalidraw',
  version: 2,
  source: 'test',
  elements,
  appState: {},
  files: {}
})

test('an empty drawing says so rather than printing nothing', () => {
  assert.equal(summarize(scene([])), '(empty drawing)')
})

test('a three-element scene reads as three lines, not 60KB of JSON', () => {
  const els = expandSkeletons(
    [
      { id: 'api', type: 'rectangle', x: 100, y: 100, width: 200, height: 80, label: 'API' },
      { id: 'db', type: 'rectangle', x: 400, y: 100, width: 200, height: 80, label: 'Postgres' },
      { id: 'e1', type: 'arrow', start: 'api', end: 'db', label: 'query' },
      { id: 'n1', type: 'text', x: 100, y: 220, text: 'TODO: cache' }
    ],
    []
  )
  const out = summarize(scene(els))
  const lines = out.split('\n')
  // Three rows: the two shapes and the note. The arrow rides its source's line
  // and every caption rides its container's, so neither gets a row of its own.
  assert.equal(lines.length, 3, out)
  assert.match(lines[0], /^rect\s+api\s+\(100,100 200×80\)\s+"API"\s+→ e1 "query" → db$/)
  assert.match(lines[1], /^rect\s+db\s+\(400,100 200×80\)\s+"Postgres"$/)
  assert.match(lines[2], /^text\s+n1\s+\(100,220\)\s+"TODO: cache"$/)
})

test('a frame heads its own contents, indented', () => {
  const els = expandSkeletons([{ id: 'f1', type: 'frame', x: 0, y: 0, width: 600, height: 400, label: 'Deploy' }], [])
  els.push({
    id: 'box',
    type: 'rectangle',
    x: 20,
    y: 20,
    width: 100,
    height: 50,
    version: 1,
    versionNonce: 1,
    updated: 0,
    frameId: 'f1'
  })
  const lines = summarize(scene(els)).split('\n')
  assert.match(lines[0], /^frame\s+f1\s+\(0,0 600×400\)\s+"Deploy"$/)
  assert.match(lines[1], /^ {2}rect\s+box/)
})

test('a deleted element is not in the summary', () => {
  const els = expandSkeletons([{ id: 'a', type: 'rectangle' }, { id: 'b', type: 'rectangle' }], [])
  els[1].isDeleted = true
  const out = summarize(scene(els))
  assert.ok(out.includes(' a '), out)
  assert.ok(!out.includes(' b '), out)
})

test('an arrow with no start binding still gets a row', () => {
  // Otherwise a loose connector would be invisible to the agent that drew it.
  const els = expandSkeletons([{ id: 'e1', type: 'arrow', x: 0, y: 0, width: 100 }], [])
  assert.match(summarize(scene(els)), /^arrow\s+e1/)
})
