// The draw panel's file layer: Excalidraw scenes as files in the worktree.
//
// Mirrors plans.ts — the same two sources (the gitignored `.floe/draw/` and the
// branch's `specs/<dir>/`), the same watcher shape — with one thing plans never
// needed: TWO writers. The user's canvas autosaves while an agent writes to the
// same file over MCP, so nobody is allowed to write a whole scene. Everyone
// sends a delta of complete elements and applyDelta merges them. See
// mergeElements for the rule, and the "Contrato de escrita" section of
// specs/draw/spec.md for why it has to be this way.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { WebContents } from 'electron'
import type { DrawDelta, DrawElement, DrawFile, DrawScene, DrawScope } from '../../shared/types'
// Explicit .ts extensions on the RUNTIME imports: draw.test.ts loads this module
// under a plain `node --test`, with no loader hook to guess them (the type-only
// imports above need none — they are erased).
import { slugifyBranch } from '../../shared/slug.ts'
import { listSpecFiles, specDirFor } from '../plans.ts'

// Scratch drawings: gitignored, alongside .floe/plans.
const DRAW_DIR = '.floe/draw'
// Versioned drawings: the same `specs/<branch>/` folder the spec docs live in,
// so a diagram lands in the commit with the spec it illustrates.
const SPECS_DIR = 'specs'
const EXT = '.excalidraw'

// What `source` says in a file Floe wrote. Excalidraw itself writes a URL here;
// anything is accepted on read, this is only what we stamp.
const SOURCE = 'floe'

// A deleted element stays in the file so a later merge can tell that the removal
// is newer than a concurrent edit of the same element. After a day no
// still-running canvas can be holding an older version of it, so it is dropped.
const TOMBSTONE_MS = 24 * 60 * 60 * 1000

// --- reading ---------------------------------------------------------------

/**
 * The drawings a worktree holds: the branch's `specs/<dir>/*.excalidraw` first
 * (grouped, like the plans panel), then the gitignored `.floe/draw/` ones,
 * newest first.
 *
 * Each row carries a live element count, which means parsing every file. The
 * lists are small (a handful of scenes per worktree) and the count is what makes
 * the row worth reading — "fluxo · 12 elements" against a name alone.
 */
export function listDrawings(worktreePath: string, branch?: string): DrawFile[] {
  const specs: DrawFile[] = (branch ? listSpecFiles(worktreePath, branch, EXT) : []).map((f) => ({
    ...f,
    elements: countElements(join(worktreePath, f.relPath))
  }))

  const dir = join(worktreePath, DRAW_DIR)
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return specs
  }

  const drafts: DrawFile[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(EXT)) continue
    const abs = join(dir, entry.name)
    let mtime = 0
    try {
      mtime = statSync(abs).mtimeMs
    } catch {
      continue
    }
    drafts.push({
      name: entry.name,
      relPath: `${DRAW_DIR}/${entry.name}`,
      mtime,
      elements: countElements(abs)
    })
  }

  drafts.sort((a, b) => b.mtime - a.mtime)
  return [...specs, ...drafts]
}

/** Live element count, or 0 for a file that will not parse — the list must not throw. */
function countElements(absPath: string): number {
  try {
    const scene = parseScene(readFileSync(absPath, 'utf8'))
    return scene.elements.filter((el) => !el.isDeleted).length
  } catch {
    return 0
  }
}

/**
 * Where a drawing may live, absolute. Anything outside is refused, the way
 * readPlan refuses a crafted path — the relPath reaches here from the renderer
 * and from an MCP tool, so neither can be trusted to stay inside the worktree.
 */
function resolveDrawing(worktreePath: string, relPath: string): string {
  const target = resolve(worktreePath, relPath)
  const allowed = [resolve(worktreePath, DRAW_DIR), resolve(worktreePath, SPECS_DIR)]
  if (!allowed.some((dir) => target.startsWith(dir + sep))) {
    throw new Error('refusing to touch a drawing outside .floe/draw/ or specs/')
  }
  if (!target.endsWith(EXT)) throw new Error(`not a drawing: ${relPath} (expected a ${EXT} file)`)
  return target
}

/**
 * Parse and validate a scene.
 *
 * A file that will not parse is an ERROR, never an empty scene: the panel would
 * load the empty scene, autosave it a moment later and overwrite a drawing that
 * was only ever unreadable to us.
 */
function parseScene(text: string): DrawScene {
  const data = JSON.parse(text) as Partial<DrawScene>
  if (data?.type !== 'excalidraw') throw new Error('not an Excalidraw scene (missing `"type": "excalidraw"`)')
  if (!Array.isArray(data.elements)) throw new Error('Excalidraw scene has no `elements` array')
  return {
    type: 'excalidraw',
    version: 2,
    source: data.source ?? SOURCE,
    elements: data.elements as DrawElement[],
    appState: data.appState ?? {},
    files: data.files ?? {}
  }
}

export function readDrawing(worktreePath: string, relPath: string): DrawScene {
  return parseScene(readFileSync(resolveDrawing(worktreePath, relPath), 'utf8'))
}

// --- merging ---------------------------------------------------------------

/**
 * Merge a delta into a scene. Pure, synchronous, and the only rule there is.
 *
 * Per element id, the higher `version` wins; a tie is broken by the higher
 * `versionNonce`. That is exactly the reconciliation Excalidraw's own
 * collaboration uses, which is the point — the numbers that decide already
 * arrive correct from the canvas, and Floe does not have to invent an ordering
 * of its own.
 *
 * `isDeleted` is not special here. An erase is an upsert carrying a bumped
 * version, so a removal and a concurrent edit are compared the same way any two
 * edits are. What IS special is the purge: a tombstone older than a day is
 * dropped, so the file stops growing while the reconciliation window stays far
 * wider than any live canvas.
 */
export function mergeElements(scene: DrawElement[], delta: DrawDelta, now: number = Date.now()): DrawElement[] {
  const order = new Map<string, number>()
  const merged: DrawElement[] = []
  for (const el of scene) {
    order.set(el.id, merged.length)
    merged.push(el)
  }

  for (const next of delta.upserts ?? []) {
    const at = order.get(next.id)
    if (at === undefined) {
      order.set(next.id, merged.length)
      merged.push(next)
      continue
    }
    const current = merged[at]
    if (next.version > current.version) merged[at] = next
    else if (next.version === current.version && next.versionNonce > current.versionNonce) merged[at] = next
  }

  return merged.filter((el) => !el.isDeleted || now - (el.updated ?? 0) < TOMBSTONE_MS)
}

// --- writing ---------------------------------------------------------------

/**
 * Merge `delta` into the drawing on disk and return the result.
 *
 * SYNCHRONOUS end to end — read, merge, write, rename, with no `await` between
 * them. That is what serializes the two writers: the renderer's autosave and an
 * MCP tool call both run on this one main-process event loop, so a function that
 * never yields cannot be interleaved with itself. Split the read from the write
 * with an await and both callers would read the same scene, and the second would
 * erase the first's elements.
 *
 * tmp + rename (the sessionStore pattern) is a separate concern: it stops a
 * crash mid-write from leaving half a JSON file. It does nothing about lost
 * updates — only the absence of an await does.
 *
 * Two Floe INSTANCES on one worktree are outside this contract, as they already
 * are for sessionStore and plans.
 */
export function applyDelta(worktreePath: string, relPath: string, delta: DrawDelta): DrawScene {
  const file = resolveDrawing(worktreePath, relPath)
  const scene = parseScene(readFileSync(file, 'utf8'))
  const next: DrawScene = { ...scene, elements: mergeElements(scene.elements, delta) }
  writeScene(file, next)
  return next
}

function writeScene(absPath: string, scene: DrawScene): void {
  const tmp = `${absPath}.tmp`
  writeFileSync(tmp, JSON.stringify(scene, null, 2))
  renameSync(tmp, absPath)
}

/**
 * The branch a worktree is on, read straight off `.git`.
 *
 * Not through git.ts: everything there is async, and this is called from
 * createDrawing/promoteDrawing, which are synchronous because the write contract
 * depends on them never yielding (see applyDelta). `.git` is a directory in the
 * main checkout and a one-line file pointing at the real gitdir in a linked
 * worktree; both keep HEAD in the same place. A detached HEAD has no branch and
 * yields '', which the callers treat as "no spec folder to match".
 */
function branchOf(worktreePath: string): string {
  const dotGit = join(worktreePath, '.git')
  let gitDir = dotGit
  try {
    if (statSync(dotGit).isFile()) {
      const pointer = readFileSync(dotGit, 'utf8').replace(/^gitdir:\s*/, '').trim()
      gitDir = resolve(worktreePath, pointer)
    }
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    return /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1] ?? ''
  } catch {
    return ''
  }
}

/**
 * Create an empty, valid scene and return its row.
 *
 * `spec` — the default — lands in the branch's `specs/<dir>/`, the same folder
 * plans.ts matched for the spec docs, so a diagram files itself next to the spec
 * it illustrates and travels with the branch. With no such folder yet, the
 * branch's own slug names one. `draft` is the escape hatch: the gitignored
 * `.floe/draw/`, for a scribble that should not reach a commit.
 *
 * The branch is discovered when the caller does not name one, so `spec` is a
 * scope an agent can ask for without first having to look up where it is.
 */
export function createDrawing(
  worktreePath: string,
  name: string,
  scope: DrawScope = 'spec',
  branch?: string
): DrawFile {
  const file = name.endsWith(EXT) ? name : `${name}${EXT}`
  const relPath = scope === 'spec' ? `${SPECS_DIR}/${specFolder(worktreePath, branch)}/${file}` : `${DRAW_DIR}/${file}`
  const abs = resolveDrawing(worktreePath, relPath)
  mkdirSync(dirname(abs), { recursive: true })

  const scene: DrawScene = {
    type: 'excalidraw',
    version: 2,
    source: SOURCE,
    elements: [],
    appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
    files: {}
  }
  writeScene(abs, scene)
  const group = scope === 'spec' ? relPath.split('/')[1] : undefined
  return { name: file, relPath, mtime: Date.now(), elements: 0, ...(group ? { group } : {}) }
}

/** The spec folder a `spec`-scoped drawing goes in: the branch's, else a new one named after it. */
function specFolder(worktreePath: string, branch?: string): string {
  const on = branch || branchOf(worktreePath)
  const matched = on ? specDirFor(worktreePath, on) : null
  if (matched) return matched
  const slug = slugifyBranch(on).split('/').pop()
  // With no branch to name it after, "draw" is at least a folder a human can
  // find again — better than refusing a create the user just asked for.
  return slug || 'draw'
}

/**
 * Move a draft into the project: `.floe/draw/x.excalidraw` → `specs/<dir>/x.excalidraw`.
 *
 * A move, not a copy. The drawing has one home; leaving a second copy behind in
 * the gitignored directory is how the version in the commit and the version you
 * keep editing quietly drift apart.
 *
 * Already inside `specs/` is not an error — it is the state you asked for, so
 * the row comes back unchanged. A name already taken in the destination IS an
 * error: silently overwriting someone else's diagram is not a promotion.
 */
export function promoteDrawing(worktreePath: string, relPath: string, branch?: string): DrawFile {
  const from = resolveDrawing(worktreePath, relPath)
  if (relPath.startsWith(`${SPECS_DIR}/`)) {
    return { name: relPath.split('/').pop() ?? relPath, relPath, mtime: statSync(from).mtimeMs, elements: countElements(from), group: relPath.split('/')[1] }
  }

  const file = relPath.split('/').pop() ?? relPath
  const dir = specFolder(worktreePath, branch)
  const toRel = `${SPECS_DIR}/${dir}/${file}`
  const to = resolveDrawing(worktreePath, toRel)
  if (existsSync(to)) throw new Error(`specs/${dir}/${file} already exists — rename the drawing first`)

  mkdirSync(dirname(to), { recursive: true })
  renameSync(from, to)
  return { name: file, relPath: toRel, mtime: Date.now(), elements: countElements(to), group: dir }
}

// --- summarizing -----------------------------------------------------------

// The short names the summary uses. Anything not listed prints its own type.
const SHORT: Record<string, string> = {
  rectangle: 'rect',
  ellipse: 'oval',
  diamond: 'rhomb',
  freedraw: 'draw',
  magicframe: 'frame'
}

/**
 * The scene, as an agent should read it.
 *
 * A forty-element drawing is ~60KB of JSON and ~40 lines of this. The JSON says
 * nothing the agent needs — seeds, nonces, roughness — and drowns the two things
 * it does need: where each shape is, and what points at what. `raw: true` on the
 * tool is the escape hatch for the rare case the JSON really is the question.
 *
 * Bound text is not a row: it is its container's caption, printed on the
 * container's line. A bound arrow is not a row either — it prints on the line of
 * the shape it leaves, which is what makes the graph readable top to bottom.
 */
export function summarize(scene: DrawScene): string {
  const live = scene.elements.filter((el) => !el.isDeleted)
  if (live.length === 0) return '(empty drawing)'

  const byId = new Map(live.map((el) => [el.id, el]))
  const captionOf = (el: DrawElement): string => {
    if (el.type === 'frame') return String(el.name ?? '')
    const bound = (el.boundElements as Array<{ id: string; type: string }> | null) ?? []
    for (const b of bound) {
      if (b.type !== 'text') continue
      const text = byId.get(b.id)
      if (text) return String(text.text ?? '')
    }
    return ''
  }

  // Arrows that leave a shape hang off that shape's row; the rest stand alone.
  const outgoing = new Map<string, DrawElement[]>()
  const hidden = new Set<string>()
  for (const el of live) {
    // A caption belongs to its container's line, not to one of its own.
    if (el.type === 'text' && el.containerId) hidden.add(el.id)
    if (el.type !== 'arrow' && el.type !== 'line') continue
    const from = (el.startBinding as { elementId: string } | null)?.elementId
    if (!from || !byId.has(from)) continue
    const list = outgoing.get(from) ?? []
    list.push(el)
    outgoing.set(from, list)
    hidden.add(el.id)
  }

  const num = (n: unknown): number => Math.round(Number(n ?? 0))
  const rowFor = (el: DrawElement): string[] => {
    const kind = SHORT[el.type] ?? el.type
    const size = el.type === 'text' ? '' : ` ${num(el.width)}×${num(el.height)}`
    const where = `(${num(el.x)},${num(el.y)}${size})`
    const caption = el.type === 'text' ? String(el.text ?? '') : captionOf(el)
    const links = (outgoing.get(el.id) ?? [])
      .map((a) => {
        const to = (a.endBinding as { elementId: string } | null)?.elementId
        const label = captionOf(a)
        return `→ ${a.id}${label ? ` "${label}"` : ''} → ${to ?? '(loose)'}`
      })
      .join('  ')
    return [kind, el.id, where, caption ? `"${caption}"` : '', links]
  }

  // Frames own the elements whose frameId names them, and print them indented.
  const frames = live.filter((el) => el.type === 'frame' || el.type === 'magicframe')
  const rows: Array<{ cells: string[]; depth: number }> = []
  const placed = new Set(hidden)
  for (const frame of frames) {
    rows.push({ cells: rowFor(frame), depth: 0 })
    placed.add(frame.id)
    for (const el of live) {
      if (placed.has(el.id) || el.frameId !== frame.id) continue
      rows.push({ cells: rowFor(el), depth: 1 })
      placed.add(el.id)
    }
  }
  for (const el of live) {
    if (placed.has(el.id)) continue
    rows.push({ cells: rowFor(el), depth: 0 })
  }

  // Columns, so ids and coordinates line up and the shape of the drawing reads
  // off the left edge.
  const widths = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => (r.depth ? 2 : 0) + r.cells[i].length)))
  return rows
    .map((r) => {
      const indent = r.depth ? '  ' : ''
      const cells = r.cells.map((cell, i) => (i === 0 ? indent + cell : cell))
      return cells
        .map((cell, i) => (i < 4 ? cell.padEnd(widths[i]) : cell))
        .join('  ')
        .trimEnd()
    })
    .join('\n')
}

// --- watching --------------------------------------------------------------

// One live watcher on the active worktree, retargeted as the user switches —
// the same single-window assumption watchPlans makes. Two directories, because
// drawings live in two places; each fire is debounced, since fs.watch emits
// several events per write (and applyDelta's tmp+rename is two of them).
let watchers: FSWatcher[] = []
let watchedPath: string | null = null
let debounce: ReturnType<typeof setTimeout> | null = null

export function watchDraw(wc: WebContents, worktreePath: string): void {
  if (watchedPath === worktreePath && watchers.length) return
  for (const w of watchers) w.close()
  watchers = []
  watchedPath = null

  const fire = (): void => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      if (!wc.isDestroyed()) wc.send('draw:changed', { worktreePath })
    }, 150)
  }

  // Pre-create the draft directory so the watch is reliable before the first
  // drawing exists. It is gitignored, so this is harmless. `specs/` is watched
  // recursively but never created — it is a tracked directory, and conjuring an
  // empty one into the repo would be a change nobody asked for.
  try {
    mkdirSync(join(worktreePath, DRAW_DIR), { recursive: true })
  } catch {
    return
  }
  for (const [dir, recursive] of [
    [join(worktreePath, DRAW_DIR), false],
    [join(worktreePath, SPECS_DIR), true]
  ] as Array<[string, boolean]>) {
    try {
      watchers.push(watch(dir, { recursive }, fire))
    } catch {
      /* no such directory (no specs/ yet) — the other watcher still covers drafts */
    }
  }
  watchedPath = watchers.length ? worktreePath : null
}
