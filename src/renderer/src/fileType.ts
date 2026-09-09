// Which icon a file gets in the tree.
//
// One table from filename to a key, and the key is the whole answer: the icon
// and its colour both hang off it in FileIcon.tsx. Extensions alone can't
// settle it — `.env`, `Dockerfile` and `pnpm-lock.yaml` are names, not
// extensions — so full names are asked first and the extension is the fallback.

import { extOf } from './previewKind.ts'

/** What a file is, as far as its icon is concerned. `file` is the fallback. */
export type FileType =
  | 'ts'
  | 'js'
  | 'vue'
  | 'python'
  | 'rust'
  | 'go'
  | 'php'
  | 'shell'
  | 'json'
  | 'yaml'
  | 'toml'
  | 'ini'
  | 'markdown'
  | 'book'
  | 'html'
  | 'css'
  | 'sql'
  | 'xml'
  | 'csv'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'zip'
  | 'db'
  | 'key'
  | 'lock'
  | 'license'
  | 'package'
  | 'docker'
  | 'git'
  | 'config'
  | 'text'
  | 'file'

// Whole names, asked first. A dotfile is all extension as far as `extOf` is
// concerned, so this is the only place it can be answered.
const BY_NAME: Record<string, FileType> = {
  '.env': 'config',
  '.editorconfig': 'config',
  '.npmrc': 'config',
  '.nvmrc': 'config',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  dockerfile: 'docker',
  '.dockerignore': 'docker',
  license: 'license',
  'license.md': 'license',
  licence: 'license',
  makefile: 'shell',
  'package.json': 'package',
  'package-lock.json': 'lock',
  'pnpm-lock.yaml': 'lock',
  'yarn.lock': 'lock',
  'bun.lockb': 'lock',
  'cargo.lock': 'lock',
  'poetry.lock': 'lock',
  'uv.lock': 'lock'
}

const BY_EXT: Record<string, FileType> = {
  ts: 'ts',
  mts: 'ts',
  cts: 'ts',
  tsx: 'ts',
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'js',
  vue: 'vue',
  py: 'python',
  pyi: 'python',
  rs: 'rust',
  go: 'go',
  php: 'php',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'css',
  sass: 'css',
  less: 'css',
  sql: 'sql',
  xml: 'xml',
  svg: 'image',
  csv: 'csv',
  tsv: 'csv',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  bmp: 'image',
  ico: 'image',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  mkv: 'video',
  mp3: 'audio',
  wav: 'audio',
  flac: 'audio',
  m4a: 'audio',
  ogg: 'audio',
  pdf: 'pdf',
  zip: 'zip',
  tar: 'zip',
  gz: 'zip',
  tgz: 'zip',
  bz2: 'zip',
  xz: 'zip',
  rar: 'zip',
  '7z': 'zip',
  db: 'db',
  sqlite: 'db',
  sqlite3: 'db',
  pem: 'key',
  key: 'key',
  crt: 'key',
  cer: 'key',
  lock: 'lock',
  txt: 'text',
  log: 'text'
}

/**
 * What kind of file a path is.
 *
 * README is a name-prefix rather than an entry per suffix: `README`,
 * `README.md` and `README.rst` are all the same book.
 */
export function fileType(path: string): FileType {
  const name = (path.split('/').pop() ?? '').toLowerCase()
  if (name.startsWith('readme')) return 'book'
  // `.env.local`, `.env.production` — the suffix is the environment, not a type.
  if (name.startsWith('.env')) return 'config'
  return BY_NAME[name] ?? BY_EXT[extOf(name)] ?? 'file'
}
