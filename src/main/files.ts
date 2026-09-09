import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent
} from 'node:fs'
import { execFile } from 'node:child_process'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { FileContent, FileNode, FileOp } from '../shared/types'
import { convertToPdf, pdfDataUrl, pptxSlides } from './office.ts'

const execFileAsync = promisify(execFile)

// Reads a worktree's directories for the Files panel. One level at a time (see
// listDir) and straight off the filesystem, so freshly-created files show up.

// Directories first, then files; alphabetical within each, case-insensitive.
function sortNodes(nodes: FileNode[]): FileNode[] {
  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

/**
 * One directory's entries, without descending and without hiding anything.
 *
 * The tree asks for a level at a time, so nothing that isn't open costs
 * anything: `node_modules` and `vendor` are listed like any other directory and
 * only read when you expand them. That is also why gitignore doesn't apply
 * here — `.env`, `dist` and friends are things you go looking for in a file
 * tree, and the reason they were hidden was the cost of walking them eagerly,
 * which no longer exists. `.git` stays out: it is machinery, not your files.
 */
export function listDir(worktreePath: string, relPath = ''): FileNode[] {
  const dir = relPath ? safeResolve(worktreePath, relPath) : worktreePath
  let entries: Dirent<string>[]
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return []
  }

  const nodes: FileNode[] = []
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === '.worktrees') continue
    nodes.push({
      name: entry.name,
      relPath: relPath ? `${relPath}/${entry.name}` : entry.name,
      type: entry.isDirectory() ? 'dir' : 'file'
    })
  }
  return sortNodes(nodes)
}

// --- Reading a single file for the read-only reader -------------------------

// Image extensions we render inline (as a base64 data URL). svg is XML text but
// browsers display it from an <img src> data URL just the same.
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif'
}

// Files larger than this are reported as `binary` rather than slurped into an IPC
// payload — keeps a stray 200MB asset from freezing the renderer.
const MAX_READ_BYTES = 5 * 1024 * 1024

// PDFs are rendered by Chromium's built-in viewer, so they tend to be heavier
// than text/images; allow a larger ceiling before falling back to `binary`.
const MAX_PDF_BYTES = 50 * 1024 * 1024

// Resolve a worktree-relative path safely. Mirrors terminal.ts's safeEditorFile:
// the path comes from a filesystem walk (attacker-controllable in a cloned repo),
// so reject control characters and anything resolving outside the worktree.
//
// Exported because `o` hands a path to the OS (index.ts) rather than reading it
// here: the file never leaves the worktree either way, so it goes through the
// same check every read does.
export function safeResolve(worktreePath: string, relPath: string): string {
  if (/[\x00-\x1f\x7f]/.test(relPath)) {
    throw new Error('Refusing to read a file with control characters in its name')
  }
  const abs = resolve(worktreePath, relPath)
  const rel = relative(worktreePath, abs)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Refusing to read a file outside the worktree')
  }
  return abs
}

// Read a file's content for the reader: text (UTF-8), an inline image data URL,
// or `binary` when it's too big or not a known image type but looks non-text.
export function readFileContent(worktreePath: string, relPath: string): FileContent {
  const abs = safeResolve(worktreePath, relPath)
  const ext = (relPath.split('.').pop() ?? '').toLowerCase()

  let size = 0
  try {
    size = statSync(abs).size
  } catch {
    return { kind: 'binary' }
  }

  if (IMAGE_MIME[ext]) {
    if (size > MAX_READ_BYTES) return { kind: 'binary' }
    try {
      const b64 = readFileSync(abs).toString('base64')
      return { kind: 'image', dataUrl: `data:${IMAGE_MIME[ext]};base64,${b64}` }
    } catch {
      return { kind: 'binary' }
    }
  }

  if (ext === 'pdf') {
    if (size > MAX_PDF_BYTES) return { kind: 'binary' }
    try {
      const b64 = readFileSync(abs).toString('base64')
      return { kind: 'pdf', dataUrl: `data:application/pdf;base64,${b64}` }
    } catch {
      return { kind: 'binary' }
    }
  }

  // A deck's words, now. The slides themselves are a conversion away and are
  // asked for separately (renderDocument), because that one takes seconds and
  // may not be possible at all — the reader must not wait on it to show text.
  if (ext === 'pptx') {
    if (size > MAX_PDF_BYTES) return { kind: 'binary' }
    try {
      const slides = pptxSlides(readFileSync(abs))
      if (slides.length) return { kind: 'slides', slides }
    } catch {
      /* fall through: an unreadable zip is a binary as far as the panel cares */
    }
    return { kind: 'binary' }
  }

  if (size > MAX_READ_BYTES) return { kind: 'binary' }
  try {
    const buf = readFileSync(abs)
    // A NUL byte in the first chunk is a reliable "this is binary" signal — don't
    // dump raw bytes into the text reader.
    if (buf.subarray(0, 8000).includes(0)) return { kind: 'binary' }
    return { kind: 'text', text: buf.toString('utf8') }
  } catch {
    return { kind: 'binary' }
  }
}

// Formats LibreOffice is asked to draw for us when it is installed. `.ppt` and
// the other legacy binaries have no second path — for them this is the preview
// or there is none.
const CONVERTIBLE = new Set(['pptx', 'ppt', 'pptm', 'odp'])

/**
 * The document as PowerPoint would draw it: converted to a PDF, or null.
 *
 * Null is the ordinary answer — most machines have no LibreOffice — and the
 * panel already has the text preview up when it arrives, so nothing is lost.
 */
export async function renderDocument(worktreePath: string, relPath: string): Promise<FileContent | null> {
  const abs = safeResolve(worktreePath, relPath)
  const ext = (relPath.split('.').pop() ?? '').toLowerCase()
  if (!CONVERTIBLE.has(ext)) return null

  const pdf = await convertToPdf(abs)
  if (!pdf) return null
  const dataUrl = pdfDataUrl(pdf, MAX_PDF_BYTES)
  return dataUrl ? { kind: 'pdf', dataUrl } : null
}

// --- Applying staged file operations (mini.files synchronize) ---------------

// Apply a batch of staged operations in order, returning a human-readable error
// per op that failed (empty array = all applied). Each path is validated to stay
// inside the worktree; parent directories are created as needed. mkdir for a
// `create` path ending in `/`, an empty file otherwise. rename covers move;
// copy/delete recurse into directories. We don't clobber existing destinations.
export function applyFileOps(worktreePath: string, ops: FileOp[]): string[] {
  const errors: string[] = []
  for (const op of ops) {
    try {
      if (op.kind === 'create') {
        const isDir = op.path.endsWith('/')
        const abs = safeResolve(worktreePath, isDir ? op.path.slice(0, -1) : op.path)
        if (existsSync(abs)) throw new Error('already exists')
        if (isDir) {
          mkdirSync(abs, { recursive: true })
        } else {
          mkdirSync(dirname(abs), { recursive: true })
          writeFileSync(abs, '', { flag: 'wx' })
        }
      } else if (op.kind === 'delete') {
        rmSync(safeResolve(worktreePath, op.path), { recursive: true, force: false })
      } else if (op.kind === 'rename' || op.kind === 'copy') {
        const from = safeResolve(worktreePath, op.from)
        const to = safeResolve(worktreePath, op.to)
        if (existsSync(to)) throw new Error('destination already exists')
        mkdirSync(dirname(to), { recursive: true })
        if (op.kind === 'rename') renameSync(from, to)
        else cpSync(from, to, { recursive: true, errorOnExist: true, force: false })
      }
    } catch (e) {
      const what = op.kind === 'rename' || op.kind === 'copy' ? `${op.from} → ${op.to}` : op.path
      errors.push(`${op.kind} ${what}: ${(e as Error).message}`)
    }
  }
  return errors
}

// --- Resolving Obsidian wikilinks -------------------------------------------

// Markdown extensions a bare wikilink target may omit (Obsidian links by name).
const MD_EXT = ['md', 'markdown', 'mdx']

// Resolve an Obsidian wikilink target to a worktree-relative file path, or null.
// `target` is the raw decoded link body (the renderer strips the `wikilink:` url
// and decodes it before calling); `fromRelPath` is the note the link lives in.
// Targets are vault-root-relative (root = worktreePath). We try the target with
// `.md` appended first, then verbatim, and return the first that resolves to an
// existing file. Never throws — any failure yields null.
export function resolveWikiLink(
  worktreePath: string,
  fromRelPath: string,
  target: string
): string | null {
  try {
    // Strip a trailing `#heading` or `^block` anchor; a pure anchor (empty after
    // stripping) is a link within the current note.
    const stripped = target.replace(/[#^].*$/, '').trim()
    if (!stripped) return fromRelPath

    const ext = (stripped.split('.').pop() ?? '').toLowerCase()
    const hasMdExt = stripped.includes('.') && MD_EXT.includes(ext)
    const candidates = hasMdExt ? [stripped] : [`${stripped}.md`, stripped]

    for (const candidate of candidates) {
      try {
        const abs = safeResolve(worktreePath, candidate)
        if (statSync(abs).isFile()) return candidate.split(sep).join('/')
      } catch {
        // Outside the worktree, missing, or a control-char name — try the next.
      }
    }
    // v2: fall back to a vault-wide basename search when no path-relative hit.
    return null
  } catch {
    return null
  }
}

// --- Every file in the worktree, for the file palette -----------------------

// Enough to hold a large repo, small enough that the payload stays an IPC
// message rather than a transfer. A repo past this is one where you type a few
// letters anyway, so the tail is not what you were reaching for.
const MAX_SEARCH_FILES = 20000

// Directories a fallback walk never descends into. Unlike the tree — which
// lists everything, because you go looking for `dist` in a file tree — a search
// over them returns thousands of rows nobody typed a query for.
const SKIP_DIRS = new Set(['.git', '.worktrees', 'node_modules', '.venv', 'vendor', 'dist', 'build', 'target'])

/**
 * Every file in the worktree, worktree-relative, for the file palette.
 *
 * `git ls-files` when the tree is a repo: it already answers "the files that
 * are mine" — tracked plus untracked, minus everything .gitignore names — which
 * is the list you want to fuzzy-match against. Outside a repo it walks instead,
 * skipping the directories a walk would otherwise drown in.
 */
export async function searchableFiles(worktreePath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', worktreePath, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { maxBuffer: 64 * 1024 * 1024 }
    )
    const files = stdout.split('\0').filter(Boolean)
    // Deduped: a path can be both cached and modified-untracked in a repo with
    // an assume-unchanged entry, and a doubled row in a palette is a misclick.
    return [...new Set(files)].slice(0, MAX_SEARCH_FILES)
  } catch {
    return walkFiles(worktreePath)
  }
}

function walkFiles(root: string): string[] {
  const out: string[] = []
  const queue = ['']
  while (queue.length && out.length < MAX_SEARCH_FILES) {
    const rel = queue.shift()!
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(rel ? join(root, rel) : root, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name
      // Symlinked directories are not followed: a link back up the tree turns
      // the walk into a loop.
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(path)
      } else if (entry.isFile()) {
        if (out.length >= MAX_SEARCH_FILES) break
        out.push(path)
      }
    }
  }
  return out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}
