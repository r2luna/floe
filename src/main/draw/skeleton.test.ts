import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eraseElements, expandSkeletons, moveElements, UnknownTargetError } from './skeleton.ts'
import type { DrawElement } from '../../shared/types.ts'

const byId = (els: DrawElement[], id: string): DrawElement => {
  const el = els.find((e) => e.id === id)
  assert.ok(el, `expected an element with id "${id}" in [${els.map((e) => e.id).join(', ')}]`)
  return el
}

test('a shape comes out complete enough to open outside Floe', () => {
  // The point of expanding in main: the file has to be valid on its own, not
  // valid-after-Excalidraw's-restore().
  const [rect] = expandSkeletons([{ id: 'db', type: 'rectangle', x: 10, y: 20, width: 200, height: 80 }], [])
  for (const field of [
    'id', 'type', 'x', 'y', 'width', 'height', 'angle', 'strokeColor', 'backgroundColor',
    'fillStyle', 'strokeWidth', 'strokeStyle', 'roughness', 'opacity', 'groupIds', 'frameId',
    'index', 'roundness', 'seed', 'version', 'versionNonce', 'isDeleted', 'boundElements',
    'updated', 'link', 'locked'
  ]) {
    assert.ok(field in rect, `missing ${field}`)
  }
  assert.equal(rect.version, 1)
  assert.equal(rect.isDeleted, false)
  assert.ok(rect.seed !== rect.versionNonce, 'seed and nonce are drawn separately')
})

test('a label becomes a bound text element, both sides of the binding', () => {
  const els = expandSkeletons([{ id: 'db', type: 'rectangle', width: 200, height: 80, label: 'Postgres' }], [])
  const rect = byId(els, 'db')
  const label = els.find((e) => e.type === 'text')
  assert.ok(label, 'a label makes a text element')
  assert.equal(label.containerId, 'db')
  assert.equal(label.text, 'Postgres')
  assert.deepEqual(rect.boundElements, [{ id: label.id, type: 'text' }])
  // A brand-new container is still at version 1: binding its own label is not
  // an edit that anyone else could have missed.
  assert.equal(rect.version, 1)
})

test('an arrow binds both shapes and points from edge to edge', () => {
  const els = expandSkeletons(
    [
      { id: 'api', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 },
      { id: 'db', type: 'rectangle', x: 300, y: 0, width: 100, height: 100 },
      { id: 'e1', type: 'arrow', start: 'api', end: 'db', label: 'query' }
    ],
    []
  )
  const arrow = byId(els, 'e1')
  assert.equal((arrow.startBinding as { elementId: string }).elementId, 'api')
  assert.equal((arrow.endBinding as { elementId: string }).elementId, 'db')
  assert.equal(arrow.endArrowhead, 'arrow')
  // Leaves api's right edge (+gap) and stops short of db's left edge.
  assert.equal(arrow.x, 104)
  assert.deepEqual(arrow.points, [[0, 0], [192, 0]])

  // The shapes list the arrow too, or dragging one leaves it behind.
  const kinds = (id: string): string[] =>
    ((byId(els, id).boundElements as Array<{ type: string }>) ?? []).map((b) => b.type)
  assert.deepEqual(kinds('api'), ['arrow'])
  assert.deepEqual(kinds('db'), ['arrow'])
  assert.ok(els.some((e) => e.containerId === 'e1' && e.text === 'query'), 'the arrow carries its own label')
})

test('an arrow can bind to a shape already on disk, which is bumped', () => {
  const scene: DrawElement[] = [
    { id: 'api', type: 'rectangle', x: 0, y: 0, width: 100, height: 100, version: 7, versionNonce: 1, updated: 0 }
  ]
  const els = expandSkeletons(
    [
      { id: 'db', type: 'rectangle', x: 300, y: 0, width: 100, height: 100 },
      { id: 'e1', type: 'arrow', start: 'api', end: 'db' }
    ],
    scene
  )
  const api = byId(els, 'api')
  // Bumped, because the change only reaches disk if it wins the merge.
  assert.equal(api.version, 8)
  assert.deepEqual(api.boundElements, [{ id: 'e1', type: 'arrow' }])
})

test('an arrow to a shape that is not there is refused, not drawn loose', () => {
  assert.throws(
    () => expandSkeletons([{ id: 'e1', type: 'arrow', start: 'api', end: 'nope' }], []),
    (err: Error) => err instanceof UnknownTargetError && err.missing === 'api'
  )
})

test('a standalone text carries its own content', () => {
  const [text] = expandSkeletons([{ id: 'n1', type: 'text', x: 5, y: 6, text: 'TODO: cache' }], [])
  assert.equal(text.type, 'text')
  assert.equal(text.text, 'TODO: cache')
  assert.equal(text.containerId, null)
  assert.ok(Number(text.width) > 0 && Number(text.height) > 0, 'sized from the content')
})

test("a frame's caption is its name, not a bound child", () => {
  const els = expandSkeletons([{ id: 'f1', type: 'frame', label: 'Deploy' }], [])
  assert.equal(els.length, 1)
  assert.equal(els[0].name, 'Deploy')
})

test('erasing is an upsert with isDeleted and a bumped version', () => {
  const scene: DrawElement[] = [
    { id: 'a', type: 'rectangle', version: 3, versionNonce: 1, updated: 0 },
    { id: 'b', type: 'rectangle', version: 1, versionNonce: 1, updated: 0, isDeleted: true }
  ]
  const out = eraseElements(scene, ['a', 'b', 'missing'])
  assert.equal(out.length, 1, 'already-gone and unknown ids are not errors')
  assert.equal(out[0].id, 'a')
  assert.equal(out[0].isDeleted, true)
  assert.equal(out[0].version, 4)
})

test('moving keeps everything but the geometry', () => {
  const scene: DrawElement[] = [
    { id: 'a', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, version: 2, versionNonce: 1, updated: 0, strokeColor: '#f00' }
  ]
  const [moved] = moveElements(scene, [{ id: 'a', x: 50, y: 60 }])
  assert.equal(moved.x, 50)
  assert.equal(moved.y, 60)
  assert.equal(moved.width, 10, 'omitted size is kept, not reset')
  assert.equal(moved.strokeColor, '#f00')
  assert.equal(moved.version, 3)
  assert.throws(() => moveElements(scene, [{ id: 'nope', x: 0, y: 0 }]), UnknownTargetError)
})

test("an arrow's label is sized by its text and sits on its midpoint", () => {
  // A mostly-vertical arrow has a tiny `width`; clamping the caption to it is
  // what turned "enqueue" into "que" the first time this ran in the app. And
  // the midpoint has to come off the points — an arrow's x/y is where it
  // STARTS, so a right-to-left one would otherwise label itself off to the side.
  const els = expandSkeletons(
    [
      { id: 'a', type: 'rectangle', x: 400, y: 0, width: 100, height: 100 },
      { id: 'b', type: 'rectangle', x: 0, y: 400, width: 100, height: 100 },
      { id: 'e1', type: 'arrow', start: 'a', end: 'b', label: 'enqueue' }
    ],
    []
  )
  const arrow = byId(els, 'e1')
  const label = byId(els, `${arrow.id}-label`)
  assert.ok(Number(label.width) > 80, `"enqueue" needs room, got ${label.width}`)
  const points = arrow.points as Array<[number, number]>
  assert.equal(Number(label.x) + Number(label.width) / 2, Number(arrow.x) + points[1][0] / 2)
  assert.equal(Number(label.y) + Number(label.height) / 2, Number(arrow.y) + points[1][1] / 2)
})

test("a shape's label still stays inside the shape", () => {
  const els = expandSkeletons(
    [{ id: 'a', type: 'rectangle', x: 0, y: 0, width: 120, height: 60, label: 'a very long caption indeed' }],
    []
  )
  const label = byId(els, 'a-label')
  assert.ok(Number(label.width) <= 104, `capped by the container, got ${label.width}`)
})

test("a label too wide for its box is wrapped, not clipped", () => {
  // What the drawing looked like before: one line, drawn past both edges of the
  // box and clipped there, so the caption opened missing its first and last word.
  const caption = 'spawnSession(projectPath, harness, argv)'
  const els = expandSkeletons([{ id: 'a', type: 'rectangle', x: 0, y: 0, width: 240, height: 80, label: caption }], [])
  const label = byId(els, 'a-label')
  const lines = String(label.text).split('\n')
  assert.ok(lines.length > 1, `expected a wrap, got ${JSON.stringify(label.text)}`)
  for (const line of lines) {
    assert.ok(line.length * 13.6 <= 230, `"${line}" is wider than the box`)
  }
  // The caption as written survives — it is what Excalidraw re-wraps from.
  assert.equal(label.originalText, caption)
})

test('a wrapped label grows the box down, never sideways', () => {
  const els = expandSkeletons(
    [{ id: 'a', type: 'rectangle', x: 0, y: 0, width: 200, height: 40, label: 'six calls sites across the main process' }],
    []
  )
  const rect = byId(els, 'a')
  const label = byId(els, 'a-label')
  assert.equal(Number(rect.width), 200, 'the width the skeleton asked for is kept')
  assert.ok(Number(rect.height) >= Number(label.height) + 10, `the box fits its lines, got ${rect.height}`)
  // Still centred vertically after the growth.
  assert.equal(Number(label.y) + Number(label.height) / 2, Number(rect.y) + Number(rect.height) / 2)
})

test('a word too long for the box is broken rather than left hanging out', () => {
  const els = expandSkeletons([{ id: 'a', type: 'rectangle', width: 100, height: 60, label: 'claudeInfo.ts:50/230' }], [])
  const label = byId(els, 'a-label')
  const lines = String(label.text).split('\n')
  assert.ok(lines.length > 1, 'the word is broken')
  assert.equal(lines.join(''), 'claudeInfo.ts:50/230')
})

test("an arrow's label is never wrapped", () => {
  // An arrow's width is the span between two boxes, not room for its caption.
  const els = expandSkeletons(
    [
      { id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 },
      { id: 'b', type: 'rectangle', x: 0, y: 300, width: 100, height: 100 },
      { id: 'e1', type: 'arrow', start: 'a', end: 'b', label: 'enqueue the job' }
    ],
    []
  )
  const label = byId(els, 'e1-label')
  assert.equal(label.text, 'enqueue the job')
})

test('a diamond wraps into the half-width its slanted sides leave', () => {
  // Excalidraw gives a diamond's caption half the box; wrapping to the whole box
  // draws the first and last line outside the shape.
  const els = expandSkeletons(
    [{ id: 'd', type: 'diamond', x: 0, y: 0, width: 260, height: 120, label: 'jail habilitado neste projeto?' }],
    []
  )
  const diamond = byId(els, 'd')
  const label = byId(els, 'd-label')
  for (const line of String(label.text).split('\n')) {
    assert.ok(line.length * 13.6 <= 130, `"${line}" is wider than the diamond has room for`)
  }
  // And the box that fits those lines is twice as tall as the text.
  assert.ok(Number(diamond.height) >= 2 * Number(label.height), `got ${diamond.height} for ${label.height} of text`)
})
