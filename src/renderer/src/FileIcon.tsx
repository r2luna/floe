// The file tree's type icons: an icon and a tone per kind from fileType.ts.
//
// The two halves are split because the rules are testable and this is not —
// `node --test` cannot load a .tsx, so the table that answers "what is this
// file" lives in a .ts next door and this one only draws the answer.

import {
  IconBook,
  IconBrackets,
  IconBrandDocker,
  IconBrandGit,
  IconBrandGolang,
  IconBrandPython,
  IconDatabase,
  IconFile,
  IconFileText,
  IconFileTypeCsv,
  IconFileTypeCss,
  IconFileTypeHtml,
  IconFileTypeJs,
  IconFileTypePdf,
  IconFileTypePhp,
  IconFileTypeRs,
  IconFileTypeSql,
  IconFileTypeTs,
  IconFileTypeVue,
  IconFileTypeXml,
  IconFileZip,
  IconJson,
  IconKey,
  IconLicense,
  IconLock,
  IconMarkdown,
  IconMusic,
  IconPackage,
  IconPhoto,
  IconSettings,
  IconTerminal2,
  IconToml,
  IconVideo,
  type Icon
} from './icons'
import type { ReactNode } from 'react'
import { fileType, type FileType } from './fileType.ts'

/** The tones in index.css — `.file-icon.tone-*`. Grey is the quiet default. */
type Tone = 'blue' | 'cyan' | 'green' | 'yellow' | 'orange' | 'red' | 'purple' | 'grey'

const DRAW: Record<FileType, [Icon, Tone]> = {
  ts: [IconFileTypeTs, 'blue'],
  js: [IconFileTypeJs, 'yellow'],
  vue: [IconFileTypeVue, 'green'],
  python: [IconBrandPython, 'blue'],
  rust: [IconFileTypeRs, 'orange'],
  go: [IconBrandGolang, 'cyan'],
  php: [IconFileTypePhp, 'purple'],
  shell: [IconTerminal2, 'green'],
  json: [IconJson, 'yellow'],
  yaml: [IconBrackets, 'purple'],
  toml: [IconToml, 'purple'],
  ini: [IconBrackets, 'red'],
  markdown: [IconMarkdown, 'cyan'],
  book: [IconBook, 'cyan'],
  html: [IconFileTypeHtml, 'orange'],
  css: [IconFileTypeCss, 'blue'],
  sql: [IconFileTypeSql, 'cyan'],
  xml: [IconFileTypeXml, 'orange'],
  csv: [IconFileTypeCsv, 'green'],
  image: [IconPhoto, 'purple'],
  video: [IconVideo, 'purple'],
  audio: [IconMusic, 'purple'],
  pdf: [IconFileTypePdf, 'red'],
  zip: [IconFileZip, 'grey'],
  db: [IconDatabase, 'cyan'],
  key: [IconKey, 'orange'],
  lock: [IconLock, 'grey'],
  license: [IconLicense, 'grey'],
  package: [IconPackage, 'red'],
  docker: [IconBrandDocker, 'blue'],
  git: [IconBrandGit, 'orange'],
  config: [IconSettings, 'yellow'],
  text: [IconFileText, 'grey'],
  file: [IconFile, 'grey']
}

/**
 * A file's type icon, drawn in the column a directory uses for its chevron —
 * so names stay in one column whichever kind of row they are on.
 */
export function FileIcon({ path }: { path: string }): ReactNode {
  const [Glyph, tone] = DRAW[fileType(path)]
  return <Glyph size={13} stroke={1.8} className={`file-mark file-icon tone-${tone}`} />
}
