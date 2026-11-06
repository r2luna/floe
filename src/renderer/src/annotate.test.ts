import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserCapture, BrowserElement, ImageAttachment } from '../../shared/types.ts'
import {
  addAnnotation,
  annotationFileName,
  annotationSummary,
  badgeAt,
  createInbox,
  elementAround,
  elementAt,
  elementWithin,
  flatScale,
  hintLabels,
  markBounds,
  markLine,
  onAnnotateRequest,
  rectOf,
  requestAnnotate,
  targetOf,
  TOOL_KEYS,
  type Mark
} from './annotate.ts'

const el = (selector: string, x: number, y: number, width: number, height: number, label = ''): BrowserElement => ({
  selector,
  label,
  x,
  y,
  width,
  height,
  interactive: false
})

const form = el('form', 0, 0, 500, 500)
const pay = el('button.pay', 100, 100, 50, 20, 'Pay now')
const elements = [form, pay]

test('hints are unique and never open on a tool key', () => {
  const labels = hintLabels(180)
  assert.equal(new Set(labels).size, 180)
  for (const label of labels) assert.equal(TOOL_KEYS[label[0]], undefined, label)
  assert.equal(labels[0], 'sa')
})

test('hints stop at what the alphabet can spell', () => {
  assert.equal(hintLabels(0).length, 0)
  assert.equal(hintLabels(10_000).length, 180)
})

test('a point lands on the most specific element under it', () => {
  assert.equal(elementAt(elements, { x: 110, y: 110 }), pay)
  assert.equal(elementAt(elements, { x: 10, y: 10 }), form)
  assert.equal(elementAt(elements, { x: 900, y: 900 }), undefined)
})

test('a shape lands on the smallest element holding all of it', () => {
  assert.equal(elementAround(elements, { x: 105, y: 105, width: 10, height: 10 }), pay)
  assert.equal(elementAround(elements, { x: 90, y: 90, width: 100, height: 100 }), form)
  assert.equal(elementAround(elements, { x: 400, y: 400, width: 200, height: 200 }), undefined)
})

test('a circle that clips its element by a little still means that element', () => {
  assert.equal(elementWithin(elements, { x: 102, y: 98, width: 60, height: 30 }), pay)
  assert.equal(elementWithin(elements, { x: 100, y: 100, width: 20, height: 20 }), undefined)
})

test('a shape around elements means the largest one it encloses', () => {
  assert.equal(elementWithin(elements, { x: 90, y: 90, width: 100, height: 100 }), pay)
  assert.equal(elementWithin(elements, { x: 0, y: 0, width: 600, height: 600 }), form)
  assert.equal(elementWithin(elements, { x: 105, y: 105, width: 5, height: 5 }), undefined)
})

test('a drag makes the same rectangle in any direction', () => {
  const r = { x: 10, y: 20, width: 30, height: 40 }
  assert.deepEqual(rectOf({ x: 10, y: 20 }, { x: 40, y: 60 }), r)
  assert.deepEqual(rectOf({ x: 40, y: 60 }, { x: 10, y: 20 }), r)
})

test('every mark kind has bounds and a badge', () => {
  const pen: Mark = { kind: 'pen', note: '', points: [{ x: 5, y: 50 }, { x: 25, y: 10 }] }
  assert.deepEqual(markBounds(pen), { x: 5, y: 10, width: 20, height: 40 })
  assert.deepEqual(badgeAt(pen), { x: 5, y: 50 })
  const arrow: Mark = { kind: 'arrow', note: '', from: { x: 9, y: 9 }, to: { x: 1, y: 1 } }
  assert.deepEqual(badgeAt(arrow), { x: 9, y: 9 })
  const text: Mark = { kind: 'text', note: 'x', at: { x: 3, y: 4 } }
  assert.deepEqual(markBounds(text), { x: 3, y: 4, width: 0, height: 0 })
  assert.equal(badgeAt({ kind: 'element', note: '', element: pay }), pay)
  assert.deepEqual(badgeAt({ kind: 'box', note: '', rect: { x: 1, y: 2, width: 3, height: 4 } }), {
    x: 1,
    y: 2,
    width: 3,
    height: 4
  })
})

test('an arrow means its tip, a shape what it encloses', () => {
  const arrow: Mark = { kind: 'arrow', note: '', from: { x: 400, y: 400 }, to: { x: 110, y: 110 } }
  assert.equal(targetOf(arrow, elements), pay)
  const box: Mark = { kind: 'box', note: '', rect: { x: 101, y: 101, width: 5, height: 5 } }
  assert.equal(targetOf(box, elements), pay)
  const text: Mark = { kind: 'text', note: 'x', at: { x: 110, y: 110 } }
  assert.equal(targetOf(text, elements), pay)
  const pen: Mark = { kind: 'pen', note: '', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }
  assert.equal(targetOf(pen, elements), form)
  const circled: Mark = { kind: 'pen', note: '', points: [{ x: 90, y: 90 }, { x: 160, y: 90 }, { x: 160, y: 130 }, { x: 90, y: 130 }] }
  assert.equal(targetOf(circled, elements), pay)
})

test('a mark reads as selector, label and note, or as an area when nothing is under it', () => {
  assert.equal(markLine({ kind: 'element', note: 'too green', element: pay }, 1, elements), '1. button.pay "Pay now": too green')
  assert.equal(markLine({ kind: 'element', note: '', element: form }, 2, elements), '2. form')
  const out: Mark = { kind: 'box', note: 'off page', rect: { x: 600.4, y: 10, width: 20.2, height: 30 } }
  assert.equal(markLine(out, 3, elements), '3. area 600,10 20×30: off page')
  const point: Mark = { kind: 'text', note: 'here', at: { x: 700, y: 700 } }
  assert.equal(markLine(point, 4, elements), '4. area 700,700: here')
})

test('the summary names the page and every mark in order', () => {
  const capture: BrowserCapture = {
    data: '',
    mimeType: 'image/png',
    url: 'http://localhost:5173/checkout',
    title: '',
    width: 1280,
    height: 800,
    capturedAt: 0,
    elements
  }
  const marks: Mark[] = [
    { kind: 'element', note: 'too green', element: pay },
    { kind: 'arrow', note: '', from: { x: 400, y: 400 }, to: { x: 110, y: 110 } }
  ]
  assert.equal(
    annotationSummary(capture, marks),
    'http://localhost:5173/checkout at 1280×800\n1. button.pay "Pay now": too green\n2. button.pay "Pay now"'
  )
})

test('an annotation starts its own line, names its image and leaves the caret after it', () => {
  const empty = addAnnotation('', 1, 'http://x at 1×1')
  assert.equal(empty.text, 'image 01 http://x at 1×1\n')
  assert.equal(empty.caret, empty.text.length)
  assert.equal(addAnnotation('fix this', 2, 'http://x at 1×1').text, 'fix this\nimage 02 http://x at 1×1\n')
  assert.equal(addAnnotation('fix this\n', 1, 'u').text, 'fix this\nimage 01 u\n')
})

test('the file is named after the page', () => {
  assert.equal(annotationFileName('http://localhost:5173/checkout'), 'localhost-5173-checkout.png')
  assert.equal(annotationFileName('https://example.com/'), 'example.com.png')
  assert.equal(annotationFileName('about:blank'), 'page.png')
  assert.equal(annotationFileName('not a url'), 'page.png')
})

test('the flat image keeps the capture sharp up to the ceiling', () => {
  assert.equal(flatScale({ width: 800, height: 600 }, 800), 1)
  assert.equal(flatScale({ width: 700, height: 500 }, 1400), 2)
  assert.equal(flatScale({ width: 1568, height: 800 }, 3136), 1)
})

test('an annotate request reaches the panel until it leaves', () => {
  let asked = 0
  const off = onAnnotateRequest(() => asked++)
  requestAnnotate()
  off()
  requestAnnotate()
  assert.equal(asked, 1)
})

test('an annotate request can name the tool to start with', () => {
  const asked: unknown[] = []
  const off = onAnnotateRequest((tool) => asked.push(tool))
  requestAnnotate('pen')
  requestAnnotate()
  off()
  assert.deepEqual(asked, ['pen', undefined])
})

const delivery = (id: string) => ({
  image: { id, mediaType: 'image/png', data: '' } as ImageAttachment,
  summary: id
})

test('a delivery reaches the composer filed under its session', () => {
  const inbox = createInbox()
  const got: string[] = []
  inbox.open('chat-a', (d) => got.push(`a:${d.summary}`))
  inbox.open('chat-b', (d) => got.push(`b:${d.summary}`))
  assert.equal(inbox.deliver('chat-b', delivery('one')), 'composer')
  assert.deepEqual(got, ['b:one'])
})

test('a chat off screen keeps its delivery rather than showing it to another chat', () => {
  const inbox = createInbox()
  const other: string[] = []
  inbox.open('chat-b', (d) => other.push(d.summary))
  assert.equal(inbox.deliver('chat-a', delivery('one')), 'waiting')
  assert.deepEqual(other, [])
  const got: string[] = []
  inbox.open('chat-a', (d) => got.push(d.summary))
  assert.deepEqual(got, ['one'])
  // Only once: reopening the same chat must not attach it a second time.
  const again: string[] = []
  inbox.open('chat-a', (d) => again.push(d.summary))
  assert.deepEqual(again, [])
})

test('with no session the launcher takes it, and with no launcher nothing does', () => {
  const inbox = createInbox()
  assert.equal(inbox.deliver('', delivery('one')), 'nowhere')
  const got: string[] = []
  inbox.open('branch:/repo', (d) => got.push(d.summary))
  assert.equal(inbox.deliver('', delivery('two')), 'composer')
  assert.deepEqual(got, ['two'])
})

test('a closed door only closes itself', () => {
  const inbox = createInbox()
  const got: string[] = []
  const closeOld = inbox.open('chat-a', (d) => got.push(`old:${d.summary}`))
  inbox.open('chat-a', (d) => got.push(`new:${d.summary}`))
  closeOld()
  assert.equal(inbox.deliver('chat-a', delivery('one')), 'composer')
  assert.deepEqual(got, ['new:one'])
})
