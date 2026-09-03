// How a file is shown in the reader.
//
// One table, so adding a format is one line here plus its component in
// panels.tsx — the alternative was a growing chain of `if (/\.pdf$/)` inside
// FileView, each with its own idea of what "this is a spreadsheet" means.
//
// The extension decides the presentation; the bytes decide what is possible.
// A `.md` is markdown only because it also came back as text: a file named
// `notes.md` that is really a JPEG is an image, not a heading.

import type { FileContent } from '../../shared/types'

export type PreviewKind =
  /** Prose, with its headings and lists drawn. */
  | 'markdown'
  /** Lines with numbers, highlighted when Shiki knows the grammar. */
  | 'code'
  /** Chromium's PDF viewer. */
  | 'pdf'
  /** The picture itself. */
  | 'image'
  /** A deck's words, and its slides once LibreOffice has drawn them. */
  | 'slides'
  /** Nothing to show. */
  | 'none'

// Extension → presentation, for the cases the extension alone settles.
const BY_EXT: Record<string, PreviewKind> = {
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  pdf: 'pdf',
  pptx: 'slides',
  pptm: 'slides',
  ppt: 'slides',
  odp: 'slides'
}

/** A path's extension, lowercased, without the dot. `''` when it has none. */
export function extOf(path: string): string {
  const name = path.split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/**
 * Documents LibreOffice may be able to draw for us.
 *
 * Asked before the conversion is requested, so a `.ppt` — which has no text
 * preview, being a binary from 1997 — still gets its one chance at a preview.
 */
export function isConvertible(path: string): boolean {
  return BY_EXT[extOf(path)] === 'slides'
}

/** Which view draws this file. */
export function previewKind(path: string, content: FileContent): PreviewKind {
  // What came back rules out most of the table: only text can be markdown, and
  // an image is an image whatever it is called.
  if (content.kind === 'image') return 'image'
  if (content.kind === 'pdf') return 'pdf'
  if (content.kind === 'slides') return 'slides'
  if (content.kind === 'binary') return isConvertible(path) ? 'slides' : 'none'
  return BY_EXT[extOf(path)] === 'markdown' ? 'markdown' : 'code'
}
