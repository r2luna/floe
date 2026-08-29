import { mkdirSync, readFileSync, readdirSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { WebContents } from 'electron'
import type { ImplementPhase, PlanFile } from '../shared/types'

// Lists the plan files Claude Code writes under a worktree's .floe/plans/
// directory (configured via the `plansDirectory` setting). Those plans are
// gitignored, so listFiles() never surfaces them — this reads the directory
// directly so the Plans tab can show them. Newest first; a missing directory
// (no plans written yet) just yields an empty list.

const PLANS_DIR = '.floe/plans'
// Spec-driven pipelines (e.g. the "ds" pipeline) write their docs — spec.md,
// plan.md, tasks.md, contracts/*, … — under `specs/<branch-ish>/` in the repo
// itself (tracked, not gitignored). The Plans panel surfaces the folder matching
// the active branch alongside the gitignored .floe/plans/ plans.
const SPECS_DIR = 'specs'

// The plans the Plans panel shows for a worktree: the spec-pipeline docs for the
// active `branch` (if any match), followed by the gitignored .floe/plans/
// plans. `branch` is optional so callers that only care about the latter (the
// "a new plan was written → reveal Plans" baseline) can omit it.
export function listPlans(worktreePath: string, branch?: string): PlanFile[] {
  const specs = branch ? listSpecPlans(worktreePath, branch) : []

  const dir = join(worktreePath, PLANS_DIR)
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return specs
  }

  const plans: PlanFile[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    let mtime = 0
    try {
      mtime = statSync(join(dir, entry.name)).mtimeMs
    } catch {
      continue
    }
    plans.push({ name: entry.name, relPath: `${PLANS_DIR}/${entry.name}`, mtime })
  }

  plans.sort((a, b) => b.mtime - a.mtime)
  return [...specs, ...plans]
}

// Normalize a name to a comparable token (lowercase, accents and punctuation
// stripped) so "feature/dos-202" and "feat-DOS-202" can be compared despite the
// formatting drift spec pipelines introduce when naming their folders.
function normalizeToken(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

// Sørensen–Dice similarity over character bigrams (0..1) — a forgiving fuzzy
// match for "is this folder the one for this branch?" without a heavy dep.
function dice(a: string, b: string): number {
  if (a === b) return a ? 1 : 0
  if (a.length < 2 || b.length < 2) return 0
  const counts = new Map<string, number>()
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2)
    counts.set(g, (counts.get(g) ?? 0) + 1)
  }
  let overlap = 0
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2)
    const n = counts.get(g) ?? 0
    if (n > 0) {
      overlap++
      counts.set(g, n - 1)
    }
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1))
}

// How well a `specs/` folder name matches a branch: exact token match wins, then
// substring containment (branch "dos-202" lives inside folder "feat-DOS-202"),
// then fuzzy similarity against the whole branch and its last path segment.
function scoreDir(dirName: string, branch: string): number {
  const d = normalizeToken(dirName)
  if (!d) return 0
  const full = normalizeToken(branch)
  const last = normalizeToken(branch.split('/').pop() ?? branch)
  if (d === full || d === last) return 1
  let s = Math.max(dice(d, full), dice(d, last))
  if (last.length >= 3 && (d.includes(last) || last.includes(d))) s = Math.max(s, 0.85)
  if (full.length >= 3 && (d.includes(full) || full.includes(d))) s = Math.max(s, 0.8)
  return s
}

// Pick the spec folder for a branch. One folder → it's the only candidate, use
// it. Otherwise the best-scoring folder, but only if it clears a bar and clearly
// beats the runner-up; on a weak or ambiguous match return null so the caller
// falls back to showing every folder (a picker).
function matchSpecDir(branch: string, dirNames: string[]): string | null {
  if (dirNames.length === 0) return null
  if (dirNames.length === 1) return dirNames[0]
  const scored = dirNames.map((name) => ({ name, score: scoreDir(name, branch) }))
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  const second = scored[1]
  if (best.score >= 0.5 && best.score - (second?.score ?? 0) >= 0.1) return best.name
  return null
}

// Recursively gather .md files under a spec folder (contracts/ and friends are
// nested), each with its path relative to that folder so the panel can show
// "contracts/atlassian-create-issue.md" rather than a bare, ambiguous filename.
function collectMd(absDir: string, relPrefix: string, out: { rel: string; mtime: number }[]): void {
  let entries
  try {
    entries = readdirSync(absDir, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return
  }
  for (const e of entries) {
    const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name
    if (e.isDirectory()) {
      collectMd(join(absDir, e.name), rel, out)
    } else if (e.isFile() && e.name.endsWith('.md')) {
      try {
        out.push({ rel, mtime: statSync(join(absDir, e.name)).mtimeMs })
      } catch {
        /* skip unreadable */
      }
    }
  }
}

// The spec-pipeline docs to show for a branch: the matching `specs/<dir>/`
// folder's .md files, or — when no folder clearly matches — every folder's
// files (so the user can pick). Grouped by folder (most-recently-touched first),
// newest file first within each, with `group` set so the panel headers them.
export function listSpecPlans(worktreePath: string, branch: string): PlanFile[] {
  const specsRoot = join(worktreePath, SPECS_DIR)
  let entries
  try {
    entries = readdirSync(specsRoot, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return []
  }
  const dirNames = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  if (dirNames.length === 0) return []

  const matched = branch ? matchSpecDir(branch, dirNames) : null
  const targets = matched ? [matched] : dirNames

  const groups: { files: PlanFile[]; mtime: number }[] = []
  for (const dir of targets) {
    const collected: { rel: string; mtime: number }[] = []
    collectMd(join(specsRoot, dir), '', collected)
    if (collected.length === 0) continue
    collected.sort((a, b) => b.mtime - a.mtime)
    const files = collected.map((c) => ({
      name: c.rel,
      relPath: `${SPECS_DIR}/${dir}/${c.rel}`,
      mtime: c.mtime,
      group: dir
    }))
    groups.push({ files, mtime: collected[0].mtime })
  }
  groups.sort((a, b) => b.mtime - a.mtime)
  return groups.flatMap((g) => g.files)
}

// The spec doc that best describes a worktree — the `spec.md` (falling back to
// the most-recent .md) of the `specs/<dir>/` folder matching `branch`. Used to
// feed the Haiku description pass; returns the abs path + mtime (for the marker's
// staleness check) or null when the worktree has no spec folder yet.
export function findSpecSummarySource(
  worktreePath: string,
  branch: string
): { path: string; mtime: number } | null {
  // A desc must describe THIS worktree — so unlike the Plans panel, require a
  // spec folder that actually matches the branch. The panel's fallback (show
  // every folder when nothing matches) would otherwise borrow an unrelated
  // worktree's spec.md and label this branch with someone else's feature.
  if (!branch) return null
  const specsRoot = join(worktreePath, SPECS_DIR)
  let entries
  try {
    entries = readdirSync(specsRoot, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return null
  }
  const dirNames = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  const matched = matchSpecDir(branch, dirNames)
  if (!matched) return null
  const collected: { rel: string; mtime: number }[] = []
  collectMd(join(specsRoot, matched), '', collected)
  if (collected.length === 0) return null
  collected.sort((a, b) => b.mtime - a.mtime)
  const pick = collected.find((c) => c.rel.endsWith('spec.md')) ?? collected[0]
  return { path: join(specsRoot, matched, pick.rel), mtime: pick.mtime }
}

// Locate the `tasks.md` for the spec folder matching `branch`. Reuses the same
// fuzzy branch→folder match as the Plans panel; when no folder confidently
// matches (ambiguous) it falls back to the most-recently-modified folder that
// actually has a tasks.md. Returns null when there are no spec folders, or none
// has a tasks.md yet (the implement step hasn't produced one).
function findTasksFile(worktreePath: string, branch?: string): string | null {
  const specsRoot = join(worktreePath, SPECS_DIR)
  let entries
  try {
    entries = readdirSync(specsRoot, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return null
  }
  const dirNames = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  if (dirNames.length === 0) return null

  const tasksPath = (dir: string): string => join(specsRoot, dir, 'tasks.md')
  const mtimeOf = (dir: string): number => {
    try {
      const s = statSync(tasksPath(dir))
      return s.isFile() ? s.mtimeMs : -1
    } catch {
      return -1
    }
  }

  const matched = branch ? matchSpecDir(branch, dirNames) : null
  if (matched && mtimeOf(matched) >= 0) return tasksPath(matched)

  // No confident branch match (or it has no tasks.md): the newest tasks.md wins.
  const withTasks = dirNames.map((dir) => ({ dir, mtime: mtimeOf(dir) })).filter((d) => d.mtime >= 0)
  if (withTasks.length === 0) return null
  withTasks.sort((a, b) => b.mtime - a.mtime)
  return tasksPath(withTasks[0].dir)
}

// Parse the implementation phases out of the matching spec `tasks.md`: each `## `
// heading whose body holds task checkboxes becomes a phase, tallied by ticked vs
// total boxes. `### ` subheadings (Tests / Implementation) stay inside their
// phase. Headings with no checkboxes — the Format/Conventions preamble and the
// trailing Dependencies / Parallel-Example notes — are not phases and drop out.
// A missing or unreadable tasks.md yields an empty list (no sub-checklist drawn).
export function readImplementPhases(worktreePath: string, branch?: string): ImplementPhase[] {
  const file = findTasksFile(worktreePath, branch)
  if (!file) return []
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }

  const phases: ImplementPhase[] = []
  let current: ImplementPhase | null = null
  for (const line of text.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) {
      // A candidate phase — only kept (pushed) once its first checkbox appears.
      const stripped = heading[1].replace(/^Phase\s+[\dA-Za-z]+\s*[:.—-]\s*/i, '').trim()
      current = { title: stripped || heading[1].trim(), done: 0, total: 0 }
      continue
    }
    const box = /^\s*-\s*\[([ xX])\]/.exec(line)
    if (box && current) {
      if (current.total === 0) phases.push(current) // promote candidate on first box
      current.total++
      if (box[1] !== ' ') current.done++
    }
  }
  return phases.filter((p) => p.total > 0)
}

// Read one plan's markdown so the in-app reader can render it (the Plans tab used
// to only open plans in nvim). `relPath` comes straight from listPlans(), but we
// resolve it and refuse anything that escapes the worktree's plans directory so a
// crafted path can't read arbitrary files.
export function readPlan(worktreePath: string, relPath: string): string {
  const target = resolve(worktreePath, relPath)
  // Plans live under .floe/plans/; spec-pipeline docs under specs/. Allow both,
  // and refuse anything that escapes them so a crafted path can't read arbitrary files.
  const allowed = [resolve(worktreePath, PLANS_DIR), resolve(worktreePath, SPECS_DIR)]
  if (!allowed.some((dir) => target === dir || target.startsWith(dir + sep))) {
    throw new Error('refusing to read a plan outside the plans directories')
  }
  return readFileSync(target, 'utf8')
}

// Copy a plan into another worktree's .floe/plans/ so a worktree spun up from a
// plan carries its own copy (plans are gitignored, so they never come across with
// the branch). Reads through readPlan() — which refuses anything outside the source
// worktree's plans directory — then writes the same filename under the destination's
// plans dir, creating it if needed. Returns the destination relPath and the content
// so the caller can also kick off a session with the plan in hand.
export function copyPlan(
  srcWorktreePath: string,
  relPath: string,
  destWorktreePath: string
): { name: string; relPath: string; content: string } {
  const content = readPlan(srcWorktreePath, relPath)
  const name = relPath.split('/').pop() ?? relPath
  const destDir = join(destWorktreePath, PLANS_DIR)
  mkdirSync(destDir, { recursive: true })
  writeFileSync(join(destDir, name), content, 'utf8')
  return { name, relPath: `${PLANS_DIR}/${name}`, content }
}

// Single live watcher on the active worktree's plans directory, so a plan Claude
// writes shows up in the Plans tab immediately (no refocus needed). Floe is a
// single-window app, so one watcher — retargeted as the user switches worktree —
// is enough. Each fire is debounced (fs.watch emits several events per write).
let watcher: FSWatcher | null = null
let watchedPath: string | null = null
let debounce: ReturnType<typeof setTimeout> | null = null

export function watchPlans(wc: WebContents, worktreePath: string): void {
  if (watchedPath === worktreePath && watcher) return
  watcher?.close()
  watcher = null
  watchedPath = null

  const dir = join(worktreePath, PLANS_DIR)
  // Pre-create the configured plans directory so the watch is reliable even
  // before the first plan is written. It's gitignored, so this is harmless.
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return
  }

  try {
    watcher = watch(dir, () => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        if (!wc.isDestroyed()) wc.send('plans:event', { worktreePath })
      }, 150)
    })
    watchedPath = worktreePath
  } catch {
    watcher = null
    watchedPath = null
  }
}
