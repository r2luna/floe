import { watch, type FSWatcher } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, sep } from 'node:path'
import type { WebContents } from 'electron'
import { isHomePath } from './projects'

const exec = promisify(execFile)

// Single live watcher set on the active worktree, so the changed-files list (and
// the Changes tab badge) refresh as files are edited — by Claude or in the user's
// own editor — without waiting for the agent turn to finish. Floe is a
// single-window app, so one set, retargeted as the user switches worktree, is
// enough. fs.watch fires several events per save, so each refresh is debounced.
let watchers: FSWatcher[] = []
let watchedPath: string | null = null
let debounce: ReturnType<typeof setTimeout> | null = null

// Git state files that DO alter what the Changes panel shows — the index
// (staging, `reset`, `git add`), HEAD/ORIG_HEAD (commit, checkout, `reset
// --hard`), and refs (commit, branch switch). An external `git reset --hard`,
// commit, or unstage from the user's terminal touches these but not the working
// tree in a way fs.watch reliably reports, so we must refresh on them. These
// names are relative to the git dir (no `.git/` prefix) — that's where they live
// for a linked worktree, whose `.git` is a file pointing elsewhere, not a dir.
function isGitState(f: string): boolean {
  return (
    f === 'index' ||
    f === 'HEAD' ||
    f === 'ORIG_HEAD' ||
    f === 'MERGE_HEAD' ||
    f === 'packed-refs' ||
    f.startsWith('refs/')
  )
}

// Paths whose changes never alter the review diff. Skipping them keeps a busy
// node_modules (an install) or the gitignored plans directory from triggering
// pointless git calls. The git dir is watched separately (see watchGitDir), so
// here we ignore the worktree's `.git` entry entirely. A null filename (the
// platform couldn't name the entry) refreshes to stay safe.
function isNoise(filename: string | null): boolean {
  if (!filename) return false
  const f = filename.split(sep).join('/')
  if (f === '.git' || f.startsWith('.git/')) return true
  return (
    f === 'node_modules' ||
    f.startsWith('node_modules/') ||
    f.includes('/node_modules/') ||
    f.startsWith('.floe/')
  )
}

export async function watchChanges(wc: WebContents, worktreePath: string): Promise<void> {
  // Never watch the synthetic Home workspace: its "worktree" is the user's whole
  // home directory and it has no git diff to review. On Linux (headless server)
  // `recursive: true` is emulated in JS — Node walks and stats EVERY entry on the
  // main thread — so arming this on ~ (300k+ files) blocks the event loop for
  // seconds on every page load. macOS FSEvents hides the cost, but it's waste there too.
  if (isHomePath(worktreePath)) return
  if (watchedPath === worktreePath && watchers.length) return
  for (const w of watchers) w.close()
  watchers = []
  watchedPath = null

  const fire = (): void => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      if (!wc.isDestroyed()) wc.send('review:event', { worktreePath })
    }, 250)
  }

  // The working tree — catches file edits from Claude or the user's editor.
  try {
    watchers.push(
      watch(worktreePath, { recursive: true }, (_event, filename) => {
        if (isNoise(filename)) return
        fire()
      })
    )
  } catch {
    /* worktree gone — leave the set empty */
  }
  watchedPath = worktreePath

  // The git dir — catches commits/staging/resets/checkouts done in the terminal.
  // For a linked worktree (Floe's whole purpose) `.git` is a file, and HEAD,
  // index, ORIG_HEAD live OUTSIDE the working tree under the main repo's
  // `.git/worktrees/<name>/`, which the recursive watcher above never sees. The
  // common dir (shared `packed-refs`, `refs/heads`) is separate again. Watch both
  // (deduped) so the committed/uncommitted split stays live.
  const gitDirs = new Set<string>()
  for (const flag of ['--git-dir', '--git-common-dir']) {
    try {
      const { stdout } = await exec('git', ['-C', worktreePath, 'rev-parse', flag])
      const dir = stdout.trim()
      // `--git-common-dir` can be relative (`.git`) on a main checkout — resolve
      // it against the worktree, not the process cwd.
      if (dir) gitDirs.add(resolve(worktreePath, dir))
    } catch {
      /* not a git dir / git missing — skip */
    }
  }
  // The worktree may have changed under us while we awaited; bail if so.
  if (watchedPath !== worktreePath) return
  for (const dir of gitDirs) {
    try {
      watchers.push(
        watch(dir, { recursive: true }, (_event, filename) => {
          if (!filename) return fire()
          if (isGitState(filename.split(sep).join('/'))) fire()
        })
      )
    } catch {
      /* git dir unwatchable — working-tree watcher still covers edits */
    }
  }
}
