import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import { readZip } from './zip.ts'
import { decodeXml, findSoffice, pptxSlides } from './office.ts'

// A zip, built here rather than checked in as a binary fixture: the point of
// zip.ts is that the format is a fixed-width record, and a test that writes one
// proves the reader against the spec instead of against one file PowerPoint
// happened to produce.
function zip(entries: Record<string, string>, deflate = false): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text, 'utf8')
    const data = deflate ? deflateRawSync(raw) : raw
    const nameBuf = Buffer.from(name, 'utf8')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(deflate ? 8 : 0, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, data)

    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(deflate ? 8 : 0, 10)
    dir.writeUInt32LE(data.length, 20)
    dir.writeUInt32LE(raw.length, 24)
    dir.writeUInt16LE(nameBuf.length, 28)
    dir.writeUInt32LE(offset, 42)
    central.push(dir, nameBuf)

    offset += 30 + nameBuf.length + data.length
  }

  const body = Buffer.concat(locals)
  const dirBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(entries).length, 8)
  eocd.writeUInt16LE(Object.keys(entries).length, 10)
  eocd.writeUInt32LE(dirBuf.length, 12)
  eocd.writeUInt32LE(body.length, 16)
  return Buffer.concat([body, dirBuf, eocd])
}

const slideXml = (title: string, bullets: string[]): string =>
  `<p:sld><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:txBody>${bullets
      .map((b) => `<a:p><a:r><a:t>${b}</a:t></a:r></a:p>`)
      .join('')}</p:txBody></p:sp>
  </p:spTree></p:cSld></p:sld>`

const notesXml = (text: string): string =>
  `<p:notes><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:notes>`

// slide1.xml is the SECOND slide of the deck here — reordering in PowerPoint
// rewrites presentation.xml and leaves the file names alone.
const deck = (): Buffer =>
  zip({
    'ppt/presentation.xml':
      '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId9"/><p:sldId id="257" r:id="rId8"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels':
      '<Relationships><Relationship Id="rId8" Target="slides/slide1.xml"/><Relationship Id="rId9" Target="slides/slide2.xml"/></Relationships>',
    'ppt/slides/slide1.xml': slideXml('Segundo', ['b &amp; b', 'dois']),
    'ppt/slides/slide2.xml': slideXml('Primeiro', ['um']),
    'ppt/slides/_rels/slide2.xml.rels':
      '<Relationships><Relationship Id="rId1" Target="../notesSlides/notesSlide1.xml"/></Relationships>',
    'ppt/notesSlides/notesSlide1.xml': notesXml('fala isso aqui')
  })

test('zip reads stored and deflated entries, and skips what it was not asked for', () => {
  for (const deflate of [false, true]) {
    const buf = zip({ 'a.xml': '<a/>', 'big.png': 'PNG' }, deflate)
    const all = readZip(buf)
    assert.equal(all.get('a.xml')?.toString(), '<a/>')
    assert.equal(all.get('big.png')?.toString(), 'PNG')

    const some = readZip(buf, (name) => name.endsWith('.xml'))
    assert.deepEqual([...some.keys()], ['a.xml'])
  }
})

test('a file that is not a zip reads as nothing rather than throwing', () => {
  assert.equal(readZip(Buffer.from('not a zip at all')).size, 0)
  assert.deepEqual(pptxSlides(Buffer.from('not a zip at all')), [])
})

test('slides come back in deck order, not file-name order', () => {
  const slides = pptxSlides(deck())
  assert.deepEqual(
    slides.map((s) => s.title),
    ['Primeiro', 'Segundo']
  )
  assert.deepEqual(
    slides.map((s) => s.n),
    [1, 2]
  )
})

test('the title heads the slide and is not repeated in its body', () => {
  const [first, second] = pptxSlides(deck())
  assert.deepEqual(first.lines, ['um'])
  assert.deepEqual(second.lines, ['b & b', 'dois'])
})

test('notes follow the relationship, not the slide number', () => {
  const [first, second] = pptxSlides(deck())
  // notesSlide1 belongs to slide2.xml, which the deck shows first.
  assert.equal(first.notes, 'fala isso aqui')
  assert.equal(second.notes, undefined)
})

test('a break inside a paragraph is a line, and entities are decoded', () => {
  const buf = zip({
    'ppt/slides/slide1.xml':
      '<p:sld><a:p><a:r><a:t>um</a:t></a:r><a:br/><a:r><a:t>dois &#233; &lt;isso&gt;</a:t></a:r></a:p></p:sld>'
  })
  const [slide] = pptxSlides(buf)
  // No title placeholder anywhere, so the first line is read as the heading.
  assert.equal(slide.title, 'um')
  assert.deepEqual(slide.lines, ['dois é <isso>'])
})

test('the page number and the footer are not what the slide says', () => {
  const buf = zip({
    'ppt/slides/slide1.xml': `<p:sld>
      <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:txBody><a:p><a:r><a:t>Objetivos</a:t></a:r></a:p></p:txBody></p:sp>
      <p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr>
        <p:txBody><a:p><a:r><a:t>3</a:t></a:r></a:p></p:txBody></p:sp>
      <p:sp><p:nvSpPr><p:nvPr><p:ph type="ftr"/></p:nvPr></p:nvSpPr>
        <p:txBody><a:p><a:r><a:t>Confidential</a:t></a:r></a:p></p:txBody></p:sp>
      <p:sp><p:txBody><a:p><a:r><a:t>o ponto</a:t></a:r></a:p></p:txBody></p:sp>
    </p:sld>`
  })
  const [slide] = pptxSlides(buf)
  assert.equal(slide.title, 'Objetivos')
  assert.deepEqual(slide.lines, ['o ponto'])
})

test('text outside a shape — a table, a chart label — is still on the slide', () => {
  const buf = zip({
    'ppt/slides/slide1.xml': `<p:sld>
      <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:txBody><a:p><a:r><a:t>Custos</a:t></a:r></a:p></p:txBody></p:sp>
      <p:graphicFrame><a:tbl><a:tr><a:tc><a:p><a:r><a:t>R$ 40k</a:t></a:r></a:p></a:tc></a:tr></a:tbl></p:graphicFrame>
    </p:sld>`
  })
  assert.deepEqual(pptxSlides(buf)[0].lines, ['R$ 40k'])
})

test('decodeXml leaves an unknown entity alone', () => {
  assert.equal(decodeXml('a &nope; b &amp; c'), 'a &nope; b & c')
})

test('soffice: the env override wins, and a path that is not there is ignored', () => {
  assert.equal(findSoffice({ PATH: '', FLOE_SOFFICE: process.execPath }), process.execPath)
  // A pointer at nothing falls through to the search rather than being returned;
  // whether the search finds LibreOffice depends on the machine, so only the
  // "did not return the bad path" half is asserted.
  assert.notEqual(findSoffice({ PATH: '', FLOE_SOFFICE: '/nope/soffice' }), '/nope/soffice')
})
