// What a .pptx says, without opening PowerPoint.
//
// Two ways to preview a deck, and the panel takes whichever it can get:
//
//  1. The text, read straight out of the file (`pptxSlides`). A .pptx is a zip
//     of XML (see zip.ts), so this needs nothing installed, runs in a few
//     milliseconds, and works in the browser build. It gives you the words —
//     title, bullets, speaker notes — not the layout.
//  2. The slides themselves (`convertToPdf`), when LibreOffice happens to be on
//     the machine. Then the file becomes a PDF and the panel shows the real
//     thing. An upgrade, never a requirement: nothing here fails when `soffice`
//     is missing, which is the common case.
//
// Electron-free, like media.ts, so the tests are plain node.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { Slide } from '../shared/types'
import { readZip } from './zip.ts'

const execFileAsync = promisify(execFile)

// --- text ------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
}

/** XML text as text: named entities, plus the numeric ones Office likes to emit. */
export function decodeXml(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body] ?? whole
  })
}

// A paragraph is `<a:p>…</a:p>`; its words are the `<a:t>` runs inside it, and a
// `<a:br/>` between them is a line the author pressed enter for.
function paragraphs(xml: string): string[] {
  const out: string[] = []
  for (const [, body] of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
    let line = ''
    for (const [, tag, text] of body.matchAll(/<a:(t|br)\b[^>]*(?:>([\s\S]*?)<\/a:\1>|\/>)/g)) {
      line += tag === 'br' ? '\n' : decodeXml(text ?? '')
    }
    for (const part of line.split('\n')) {
      const trimmed = part.trim()
      if (trimmed) out.push(trimmed)
    }
  }
  return out
}

// Chrome, not content: the slide number, the footer and the date are drawn on
// every page by the layout, and reading them back is noise — "Confidential / 3"
// is not something the slide says.
const CHROME_PH = /<p:ph\b[^>]*type="(?:sldNum|ftr|dt)"/

/**
 * A slide's shapes, split into its title and everything else.
 *
 * The shape is the unit because that is where the placeholder type lives — it
 * is what tells a heading from a bullet, and a bullet from a page number. What
 * is left over (`rest`) is the parts of the XML no `<p:sp>` covers: a table or
 * a chart's labels, which live in a `<p:graphicFrame>` and are still text on
 * the slide.
 */
function readShapes(xml: string): { title: string[]; lines: string[] } {
  const title: string[] = []
  const lines: string[] = []
  let rest = xml

  for (const [whole, shape] of xml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)) {
    rest = rest.replace(whole, '')
    if (CHROME_PH.test(shape)) continue
    const paras = paragraphs(shape)
    if (!paras.length) continue
    // Only the first title placeholder is a title; a deck with two is a deck
    // whose second one is a subtitle.
    if (!title.length && /<p:ph\b[^>]*type="(?:title|ctrTitle)"/.test(shape)) title.push(...paras)
    else lines.push(...paras)
  }
  lines.push(...paragraphs(rest))

  // Decks built by anything other than PowerPoint often carry no title
  // placeholder at all — Keynote exports and Google Slides among them. There the
  // first line IS the heading, and reading it as one is closer to the slide than
  // a list of bullets with no head.
  if (!title.length && lines.length) title.push(lines.shift()!)
  return { title, lines }
}

// Deck order is not file order: reordering slides in PowerPoint rewrites
// presentation.xml's `<p:sldIdLst>` and leaves slide7.xml named slide7.xml. So
// the list is read from there, through the relationship ids, and only falls
// back to sorting by number when that part is missing.
function slideParts(zip: Map<string, Buffer>): string[] {
  const rels = zip.get('ppt/_rels/presentation.xml.rels')?.toString('utf8')
  const deck = zip.get('ppt/presentation.xml')?.toString('utf8')
  if (rels && deck) {
    const target = new Map<string, string>()
    for (const [, id, path] of rels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
      target.set(id, `ppt/${path.replace(/^\.\.\//, '')}`)
    }
    const ordered: string[] = []
    for (const [, id] of deck.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)) {
      const path = target.get(id)
      if (path && zip.has(path)) ordered.push(path)
    }
    if (ordered.length) return ordered
  }
  return [...zip.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
}

// The notes page belongs to the slide by relationship, not by matching numbers,
// so slide3 can carry notesSlide1.
function notesPart(zip: Map<string, Buffer>, slidePart: string): string | undefined {
  const rels = zip.get(slidePart.replace(/([^/]+)$/, '_rels/$1.rels'))?.toString('utf8')
  const hit = rels?.match(/Target="[^"]*(notesSlides\/notesSlide\d+\.xml)"/)
  return hit ? `ppt/${hit[1]}` : undefined
}

/** Every slide's words, in deck order. Empty when the file is not a .pptx. */
export function pptxSlides(buf: Buffer): Slide[] {
  const zip = readZip(buf, (name) => name.endsWith('.xml') || name.endsWith('.rels'))
  const slides: Slide[] = []
  for (const [i, part] of slideParts(zip).entries()) {
    const { title, lines } = readShapes(zip.get(part)?.toString('utf8') ?? '')
    const notesXml = notesPart(zip, part)
    // Notes have no heading — they are one block of prose — so the split
    // readShapes makes is undone here, in the order it found them.
    const notesShapes = notesXml ? readShapes(zip.get(notesXml)?.toString('utf8') ?? '') : null
    const notes = notesShapes ? [...notesShapes.title, ...notesShapes.lines] : []
    slides.push({
      n: i + 1,
      title: title.length ? title.join(' ') : undefined,
      lines,
      notes: notes.length ? notes.join('\n') : undefined
    })
  }
  return slides
}

// --- LibreOffice -----------------------------------------------------------

// Where `soffice` is when it is installed at all. `which` is not enough on the
// Mac: the app bundle is not on anyone's PATH.
const SOFFICE_PATHS = [
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  '/usr/bin/soffice',
  '/usr/bin/libreoffice',
  '/usr/local/bin/soffice',
  '/opt/homebrew/bin/soffice',
  '/snap/bin/libreoffice'
]

/** The LibreOffice binary, or null when this machine has none. */
export function findSoffice(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.FLOE_SOFFICE
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  for (const path of SOFFICE_PATHS) if (existsSync(path)) return path
  for (const dir of (env.PATH ?? '').split(':')) {
    if (!dir) continue
    for (const name of ['soffice', 'libreoffice']) {
      if (existsSync(join(dir, name))) return join(dir, name)
    }
  }
  return null
}

// Converting a deck takes seconds, so the result is kept: keyed by path, size
// and mtime, which is enough to notice the file changed under us.
function cacheDir(abs: string): string {
  const stat = statSync(abs)
  const key = createHash('sha256').update(`${abs}:${stat.size}:${stat.mtimeMs}`).digest('hex').slice(0, 16)
  return join(tmpdir(), 'floe-preview', key)
}

/**
 * The document as a PDF, or null when LibreOffice is missing or refuses it.
 *
 * Never throws: this is the optional half of the preview, and the text one is
 * already on screen when it runs.
 */
export async function convertToPdf(abs: string, timeoutMs = 30_000): Promise<string | null> {
  const soffice = findSoffice()
  if (!soffice) return null

  let out: string
  try {
    out = cacheDir(abs)
  } catch {
    return null
  }
  const pdf = join(out, basename(abs).replace(/\.[^.]*$/, '') + '.pdf')
  if (existsSync(pdf)) return pdf

  try {
    mkdirSync(out, { recursive: true })
    await execFileAsync(
      soffice,
      [
        '--headless',
        // Its own profile: a running LibreOffice window otherwise owns the only
        // one, and the headless call exits without converting anything.
        `-env:UserInstallation=file://${join(out, 'profile')}`,
        '--convert-to',
        'pdf',
        '--outdir',
        out,
        abs
      ],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }
    )
  } catch {
    return null
  }
  return existsSync(pdf) ? pdf : null
}

/** The converted PDF as a data URL, or null. Size-capped by the caller. */
export function pdfDataUrl(path: string, maxBytes: number): string | null {
  try {
    if (statSync(path).size > maxBytes) return null
    return `data:application/pdf;base64,${readFileSync(path).toString('base64')}`
  } catch {
    return null
  }
}
