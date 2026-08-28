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
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { FileContent, FileNode, FileOp } from '../shared/types'

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
function safeResolve(worktreePath: string, relPath: string): string {
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
