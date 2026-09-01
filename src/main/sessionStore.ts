import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dataDir } from './dataDir'
import type { Effort, PermissionMode, ProjectUiState, ThreadComment, WorktreeUiState } from '../shared/types'
import { dropComment, isValidComment, stampSent, upsertComment } from '../shared/threadComments'

// Re-exported so existing importers (main/index.ts, preload) keep getting these
// from './sessionStore'; the source of truth lives in shared/types.
export type { ProjectUiState, TerminalSnapshot, WorktreeUiState } from '../shared/types'

// Floe-side persistence for sessions. The session list shown in the app is
// *only* the sessions the user has opened inside Floe — never the full history
// of `~/.claude/projects` — so it stays curated and a close actually sticks:
//   - `meta`: custom titles (from renames) keyed by Claude's session id.
//   - `created`: the sessions Floe knows about — opened with ⌘T, or pulled in
//     from disk via the Resume command (terminal or not). This is the source of
//     truth for the sidebar. Closing a session removes it here, for good.
export interface SessionMeta {
  title?: string
}

export interface CreatedSession {
  id: string // Floe's own stable session id (`claude:<id>` for resumed ones)
  worktreePath: string
  title: string
  createdAt: number
  claudeId?: string // Claude's session id, once the first prompt links it
  /**
   * Claude ids this session used to have. `claude --resume` forks into a fresh
   * id on every respawn, but an open panel keeps the key it was opened with —
   * so without this trail a lookup by that key stops matching the moment the
   * first fork happens, and the next respawn silently starts a blank session.
   */
  pastClaudeIds?: string[]
  /**
   * When a turn last ran here, for sessions that leave no transcript on disk.
   * Claude's own recency comes from its `.jsonl` mtime; a session answered by
   * codex, gemini or a local model writes no such file, so without this it
   * would keep the timestamp of its creation forever and sink down the list
   * every time a Claude session was touched.
   */
  usedAt?: number
  permissionMode?: PermissionMode // last permission mode chosen for this session
  model?: string // last model chosen for this session (e.g. 'opus', 'sonnet')
  effort?: Effort // last effort level chosen for this session
  /**
   * Which harness this session answers as. Absent means Claude, or a session
   * from before this was recorded — those are still read back off the
   * transcript, by whoever answered last.
   *
   * Recorded rather than inferred because inference cannot tell the two apart:
   * a message addressed to `@claude` from a codex chat leaves a Claude reply in
   * the transcript that looks exactly like the session having switched. One
   * turn is not a switch, and the only thing that knows the difference is the
   * moment it happened.
   */
  provider?: string
  // The session id of the agent that opened this one (MCP create_session). A
  // spawned session has no human in front of it — only the parent talks to the
  // user — so the agent answers its AskUserQuestion for it. See agent.ts.
  spawnedBy?: string
}

// Where the user last was, so reopening a project (now or after a restart) lands
// back on the same screen instead of always the first worktree/session:
//   - `worktreeByProject`: the worktree last active inside each project.
//   - `viewByWorktree`: what was open inside each worktree (which session /
//     terminal / command). Mirrors the renderer's in-memory `lastByWorktree`.
export type WorktreeView = { kind: 'agent' | 'terminal' | 'command'; key: string }

export interface ViewState {
  worktreeByProject: Record<string, string>
  viewByWorktree: Record<string, WorktreeView>
  // The last *agent* session opened in each worktree, kept separately from
  // `viewByWorktree` so a terminal/command view on top of it never erases it.
  // When the remembered view is a terminal/command that no longer exists (closed,
  // or its PTY died after a restart), the restore falls back to this session
  // instead of jumping to the worktree's first one.
  agentByWorktree: Record<string, string>
  projectUi: Record<string, ProjectUiState> // keyed by project path
  worktreeUi: Record<string, WorktreeUiState> // keyed by worktree path
}

// App-wide (not per-session) preferences. Kept small and flat; defaults live in
// the getters so a missing key just reads as "off".
export interface AppPrefs {
  vibrancy?: boolean // translucent window with a soft macOS background blur
  // The projects rail (leftmost) is shown by default; this records an explicit
  // hide so the choice survives restarts. Absent/true → visible.
  railVisible?: boolean
  // Project paths the user removed from the rail even though they had a session
  // today — so they stay off until brought back.
  hiddenProjects?: string[]
}

interface Store {
  meta: Record<string, SessionMeta>
  created: CreatedSession[]
  view: ViewState
  prefs: AppPrefs
  // A per-worktree review checkpoint: a commit SHA the Changes panel diffs
  // against instead of the branch base. Set by "Clear changes list" to the
  // current HEAD so everything committed so far drops out of the review,
  // letting the user start a fresh canvas — without touching any file.
  reviewCheckpoints: Record<string, string>
  // Notes anchored to passages of a session's transcript, keyed by session key.
  // The transcript itself is read back from Claude's JSONL; only the notes are
  // ours, so this is the one place they can survive a reload.
  threadComments: Record<string, ThreadComment[]>
}

const emptyView = (): ViewState => ({
  worktreeByProject: {},
  viewByWorktree: {},
  agentByWorktree: {},
  projectUi: {},
  worktreeUi: {}
})

const emptyStore = (): Store => ({
  meta: {},
  created: [],
  view: emptyView(),
  prefs: {},
  reviewCheckpoints: {},
  threadComments: {}
})

const storeFile = (): string => join(dataDir(), 'sessions.json')

// The parsed store, so the ~25 accessors below don't re-read and re-parse the
// whole file per call (getVibrancy alone runs on every window focus). Validated
// by mtime+size rather than trusted blindly: the tests — and a second Floe
// process — write sessions.json behind our back, and a stat is still ~free next
// to a full parse. Keyed by path because tests repoint dataDir mid-process.
let cached: { file: string; mtimeMs: number; size: number; store: Store } | undefined

function cacheStore(file: string, store: Store): Store {
  try {
    const stat = statSync(file)
    cached = { file, mtimeMs: stat.mtimeMs, size: stat.size, store }
  } catch {
    cached = undefined
  }
  return store
}

function read(): Store {
  const file = storeFile()
  if (!existsSync(file)) return emptyStore()
  if (cached && cached.file === file) {
    try {
      const stat = statSync(file)
      if (stat.mtimeMs === cached.mtimeMs && stat.size === cached.size) return cached.store
    } catch {
      /* fall through to a fresh parse */
    }
  }
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (!data || typeof data !== 'object') return emptyStore()
    // Migrate the old flat shape (Record<claudeId, { title }>) to the new store.
    if (!('meta' in data) && !('created' in data))
      return cacheStore(file, { ...emptyStore(), meta: data as Record<string, SessionMeta> })
    const view = (data.view as Partial<ViewState>) ?? {}
    return cacheStore(file, {
      meta: (data.meta as Record<string, SessionMeta>) ?? {},
      created: Array.isArray(data.created) ? (data.created as CreatedSession[]) : [],
      view: {
        worktreeByProject: view.worktreeByProject ?? {},
        viewByWorktree: view.viewByWorktree ?? {},
        agentByWorktree: view.agentByWorktree ?? {},
        projectUi: view.projectUi ?? {},
        worktreeUi: view.worktreeUi ?? {}
      },
      prefs: (data.prefs as AppPrefs) ?? {},
      reviewCheckpoints: (data.reviewCheckpoints as Record<string, string>) ?? {},
      threadComments: (data.threadComments as Record<string, ThreadComment[]>) ?? {}
    })
  } catch {
    return emptyStore()
  }
}

function write(store: Store): void {
  // Write through a temp file then rename: a crash/kill mid-write can only leave
  // the (untouched) old file or the (complete) new one — never a truncated file
  // that `read()` would parse as empty and silently wipe all of "where I was".
  const file = storeFile()
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2))
  renameSync(tmp, file)
  cacheStore(file, store)
}

export function getSessionMeta(): Record<string, SessionMeta> {
  return read().meta
}

export function setSessionTitle(claudeId: string, title: string): void {
  const t = title.trim()
  if (!claudeId || !t) return
  const store = read()
  store.meta[claudeId] = { ...store.meta[claudeId], title: t }
  // Keep the created-session title in sync so an unlinked rename and a linked one agree.
  const c = store.created.find((s) => s.claudeId === claudeId)
  if (c) c.title = t
  write(store)
}

export function getCreatedSessions(worktreePath: string): CreatedSession[] {
  return read().created.filter((s) => s.worktreePath === worktreePath)
}

// Every session in the store, one read. getCreatedSessions() re-parses the file
// per worktree, which is fine for a single lookup and quadratic for a fleet-wide
// walk (~600 sessions × every worktree, on a timer).
export function getAllCreatedSessions(): CreatedSession[] {
  return read().created
}

// A session key from the renderer is `claudeId ?? id` (see App.tsx), so every
// per-session lookup has to accept either. Missing this is what made an idle
// session come back empty: after a restart the key was the claudeId, the by-`id`
// lookup missed, and the agent respawned with no `--resume`.
function findByKey(created: CreatedSession[], key: string): CreatedSession | undefined {
  return (
    created.find((s) => s.id === key) ??
    created.find((s) => s.claudeId === key) ??
    created.find((s) => s.pastClaudeIds?.includes(key))
  )
}

export function getCreatedSession(id: string): CreatedSession | undefined {
  return findByKey(read().created, id)
}

// Adopt Claude's auto-generated ai-title as a session's title, and keep following
// it each turn — unless the user has manually renamed it. A manual rename lands in
// `meta[claudeId]` (directly when linked, or promoted there on link), and meta wins
// over `c.title` in the sidebar, so a meta title is the "don't auto-follow" lock.
// Returns true if the stored title changed.
// ponytail: meta-presence is the lock; a *resumed* session's ai-title also gets
// promoted to meta on first send, so it stops following — add a real titleLocked
// flag if resumed sessions must keep following too.
export function applyAiTitle(claudeId: string, title: string): boolean {
  const t = title.trim()
  if (!claudeId || !t) return false
  const store = read()
  if (store.meta[claudeId]?.title) return false // manually renamed → locked
  const c = store.created.find((s) => s.claudeId === claudeId)
  if (!c || c.title === t) return false
  c.title = t
  write(store)
  return true
}

// Claude's on-disk session id for a Floe session, if its first prompt linked
// one. Lets the agent --resume the right session after the process is gone (the
// machine slept, the app restarted) instead of silently starting a fresh one.
export function getCreatedSessionClaudeId(id: string): string | undefined {
  return findByKey(read().created, id)?.claudeId
}

// The next auto-title for a worktree: one past the highest existing "Session N".
// Authoritative because it reads the persisted store (not React state), so it's
// immune to the stale-closure / discovery-race that used to mint colliding names.
// Custom titles (renames, "Merge …") don't match the pattern, so they're skipped.
function nextSessionTitle(created: CreatedSession[], worktreePath: string): string {
  let max = 0
  for (const c of created) {
    if (c.worktreePath !== worktreePath) continue
    const m = /^Session (\d+)$/.exec(c.title)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `Session ${max + 1}`
}

// Register a session Floe owns. Returns the title it was stored under: when the
// caller omits one (a plain ⌘T / first-send session) the main process assigns the
// next "Session N" itself, so two quick creates can never collide. Idempotent on id.
export function addCreatedSession(s: { id: string; worktreePath: string; title?: string }): string {
  const store = read()
  const existing = store.created.find((x) => x.id === s.id)
  if (existing) return existing.title
  const title = s.title?.trim() || nextSessionTitle(store.created, s.worktreePath)
  store.created.push({ id: s.id, worktreePath: s.worktreePath, title, createdAt: Date.now() })
  write(store)
  return title
}

// One-shot cleanup for stores written by older builds, which numbered new sessions
// by the *count* of in-memory sessions — so a close (or creating before discovery
// had populated the list) produced colliding titles ("Session 1" twice) and skipped
// numbers. Renumber each worktree's auto-titled sessions into a clean 1..k sequence
// in creation order; custom titles are left untouched and don't consume a number.
export function normalizeSessionTitles(): void {
  const store = read()
  const byWt = new Map<string, CreatedSession[]>()
  for (const c of store.created) {
    const arr = byWt.get(c.worktreePath) ?? []
    arr.push(c)
    byWt.set(c.worktreePath, arr)
  }
  let changed = false
  for (const arr of byWt.values()) {
    const auto = arr.filter((c) => /^Session \d+$/.test(c.title)).sort((a, b) => a.createdAt - b.createdAt)
    auto.forEach((c, i) => {
      const title = `Session ${i + 1}`
      if (c.title !== title) {
        c.title = title
        changed = true
      }
    })
  }
  if (changed) write(store)
}

export function renameCreatedSession(id: string, title: string): void {
  const t = title.trim()
  if (!t) return
  const store = read()
  const c = findByKey(store.created, id)
  if (!c) return
  c.title = t
  write(store)
}

/** Stamp a session as used now — see CreatedSession.usedAt. */
export function touchCreatedSession(id: string): void {
  const store = read()
  const c = findByKey(store.created, id)
  if (!c) return
  c.usedAt = Date.now()
  write(store)
}

// Remember the permission mode the user picked for a session, so switching back
// to it (now or after a restart) restores that mode instead of a global default.
export function setCreatedSessionMode(id: string, mode: PermissionMode): void {
  const store = read()
  const c = findByKey(store.created, id)
  if (!c) return
  c.permissionMode = mode
  write(store)
}

// Same idea for the model: remember the model picked for a session so switching
// back to it (now or after a restart) restores it instead of a global default.
export function setCreatedSessionModel(id: string, model: string): void {
  const store = read()
  const c = findByKey(store.created, id)
  if (!c) return
  c.model = model
  write(store)
}

// Same idea for effort: remember the effort level picked for a session so
// switching back to it (now or after a restart) restores it.
export function setCreatedSessionEffort(id: string, effort: Effort): void {
  const store = read()
  const c = findByKey(store.created, id)
  if (!c) return
  c.effort = effort
  write(store)
}

/**
 * The whole choice at once — what the picker is set to for this session.
 *
 * One write rather than four: the four parts are one answer to one question,
 * and saving them separately would put the store through four reads, four
 * writes and three intermediate states that never existed.
 *
 * Only what is passed is set. An unset key is left alone rather than cleared,
 * so a caller that knows the harness but not the mode does not erase the mode.
 */
export function setCreatedSessionChoice(
  id: string,
  choice: { provider?: string; model?: string; effort?: Effort; mode?: PermissionMode }
): void {
  const store = read()
  const c = findByKey(store.created, id)
  if (!c) return
  // Claude is the absence of a provider everywhere else in the app; keep that
  // true here rather than storing the word and having two spellings of it.
  if (choice.provider !== undefined) c.provider = choice.provider === 'claude' ? undefined : choice.provider
  if (choice.model !== undefined) c.model = choice.model
  if (choice.effort !== undefined) c.effort = choice.effort
  if (choice.mode !== undefined) c.permissionMode = choice.mode
  write(store)
}

/** What this session answers as, for the composer to restore on open. */
export function createdSessionChoice(
  id: string
): { provider?: string; model?: string; effort?: Effort; mode?: PermissionMode } | null {
  const c = findByKey(read().created, id)
  // A record with nothing chosen is not an answer — the transcript still is.
  if (!c || (!c.provider && !c.model && !c.effort && !c.permissionMode)) return null
  return { provider: c.provider, model: c.model, effort: c.effort, mode: c.permissionMode }
}

// Record that an agent (not the user) opened this session, so the questions it
// raises are answered by that agent instead of surfacing to the user.
export function setCreatedSessionSpawnedBy(id: string, parentSessionId: string): void {
  const store = read()
  const c = findByKey(store.created, id)
  if (!c) return
  c.spawnedBy = parentSessionId
  write(store)
}

// How many superseded Claude ids to remember per session (see pastClaudeIds).
const PAST_IDS_CAP = 20

// Link a Floe session to Claude's real on-disk session once its first prompt
// has produced one, so on reload the two are recognised as the same session.
// The id it replaces is kept in `pastClaudeIds`, because a panel opened under
// that id goes on using it as its key.
export function linkCreatedSession(id: string, claudeId: string): void {
  const store = read()
  const c = findByKey(store.created, id)
  if (!c) return
  if (c.claudeId && c.claudeId !== claudeId) {
    const past = (c.pastClaudeIds ?? []).filter((x) => x !== c.claudeId)
    past.push(c.claudeId)
    c.pastClaudeIds = past.slice(-PAST_IDS_CAP)
  }
  c.claudeId = claudeId
  write(store)
}

// Pull an existing on-disk session into Floe (the Resume command). Keyed by
// Claude's id so it's deduped against an already-adopted one; uses the session's
// real mtime so it sorts naturally among the rest. Returns the stable Floe id.
export function resumeSession(s: {
  worktreePath: string
  claudeId: string
  title: string
  mtime: number
}): string {
  const store = read()
  const existing = store.created.find((x) => x.claudeId === s.claudeId)
  if (existing) return existing.id
  const id = `claude:${s.claudeId}`
  store.created.push({ id, worktreePath: s.worktreePath, title: s.title, createdAt: s.mtime, claudeId: s.claudeId })
  write(store)
  return id
}

// The saved "where I was" state, restored on launch so the renderer can land the
// user back on their last worktree/session per project.
export function getViewState(): ViewState {
  return read().view
}

// Remember which worktree was active in a project, so switching back to it (now
// or after a restart) reopens that worktree instead of the first one.
export function setProjectWorktree(projectPath: string, worktreePath: string): void {
  if (!projectPath || !worktreePath) return
  const store = read()
  store.view.worktreeByProject[projectPath] = worktreePath
  write(store)
}

// Remember what was open inside a worktree (which session / terminal / command),
// so re-entering it restores that exact selection.
export function setWorktreeView(worktreePath: string, view: WorktreeView): void {
  if (!worktreePath || !view?.key) return
  const store = read()
  store.view.viewByWorktree[worktreePath] = view
  write(store)
}

// Whether the translucent (vibrancy) window appearance is enabled. Off by
// default so the app stays solid until the user opts in.
export function getVibrancy(): boolean {
  return read().prefs.vibrancy === true
}

export function setVibrancy(on: boolean): void {
  const store = read()
  store.prefs.vibrancy = on
  write(store)
}

// Projects rail visibility — visible by default (only an explicit hide persists),
// so the rail appears on its own once a project has activity today.
export function getRailVisible(): boolean {
  return read().prefs.railVisible !== false
}

export function setRailVisible(on: boolean): void {
  const store = read()
  store.prefs.railVisible = on
  write(store)
}

// Projects the user hid from the rail (by path).
export function getHiddenProjects(): string[] {
  return read().prefs.hiddenProjects ?? []
}

export function setHiddenProjects(paths: string[]): void {
  const store = read()
  store.prefs.hiddenProjects = paths
  write(store)
}

// Remember the last agent session opened in a worktree, kept apart from the
// active view so a terminal/command never overwrites it. Used as the restore
// fallback when the remembered view is a terminal/command that's gone.
export function setWorktreeAgent(worktreePath: string, sessionId: string): void {
  if (!worktreePath || !sessionId) return
  const store = read()
  store.view.agentByWorktree[worktreePath] = sessionId
  write(store)
}

// Remember a project's window chrome (panels, right-pane mode, tasks filter,
// collapsed sidebar), so switching back restores the same shell. The renderer
// sends the whole snapshot, so this replaces the project's entry wholesale.
export function setProjectUi(projectPath: string, ui: ProjectUiState): void {
  if (!projectPath) return
  const store = read()
  store.view.projectUi[projectPath] = ui
  write(store)
}

// Remember a worktree's interior (open terminals + composer drafts), so
// re-entering it can re-attach the terminals and restore the drafts. Whole
// snapshot replace, same as setProjectUi.
export function setWorktreeUi(worktreePath: string, ui: WorktreeUiState): void {
  if (!worktreePath) return
  const store = read()
  store.view.worktreeUi[worktreePath] = ui
  write(store)
}

// The commit the worktree's Changes panel diffs against instead of the branch
// base (undefined = none, fall back to the base). Read by main/git.ts.
export function getReviewCheckpoint(worktreePath: string): string | undefined {
  if (!worktreePath) return undefined
  return read().reviewCheckpoints[worktreePath]
}

// Set or clear (sha === undefined) the worktree's review checkpoint.
export function setReviewCheckpoint(worktreePath: string, sha: string | undefined): void {
  if (!worktreePath) return
  const store = read()
  if (sha) store.reviewCheckpoints[worktreePath] = sha
  else delete store.reviewCheckpoints[worktreePath]
  write(store)
}

// --- Thread comments (notes anchored to a passage of the transcript) --------

// Every note on a session, in the order they were added. Ordering by anchor is
// the renderer's job — it knows which transcript items are actually on screen.
export function getThreadComments(sessionKey: string): ThreadComment[] {
  if (!sessionKey) return []
  return read().threadComments[sessionKey] ?? []
}

export function addThreadComment(c: ThreadComment): void {
  if (!isValidComment(c)) return
  const store = read()
  store.threadComments[c.sessionKey] = upsertComment(store.threadComments[c.sessionKey] ?? [], c)
  write(store)
}

export function removeThreadComment(sessionKey: string, id: string): void {
  if (!sessionKey || !id) return
  const store = read()
  const list = store.threadComments[sessionKey]
  if (!list) return
  const next = dropComment(list, id)
  // Drop the key entirely once the last note goes, so sessions.json doesn't
  // accumulate an empty array for every session that ever held one.
  if (next.length) store.threadComments[sessionKey] = next
  else delete store.threadComments[sessionKey]
  write(store)
}

// Stamp notes as sent, in one write. Sent notes are kept, not drained — the
// thread is the record of the review (see ThreadComment.sentAt).
export function markThreadCommentsSent(sessionKey: string, ids: string[], at = Date.now()): void {
  // `ids` crosses IPC, so `ids.length` on a non-array would throw in the handler.
  if (!sessionKey || !Array.isArray(ids) || ids.length === 0) return
  const store = read()
  const list = store.threadComments[sessionKey]
  if (!list) return
  store.threadComments[sessionKey] = stampSent(list, ids, at)
  write(store)
}

// Close a session for good: forget Floe's record of it. Non-destructive — the
// Claude `.jsonl` is left on disk (still resumable via `claude --resume`); it
// simply no longer shows in Floe, and stays gone across reloads.
export function closeSession(opts: { id: string; worktreePath: string; claudeId?: string }): void {
  const store = read()
  store.created = store.created.filter((s) => s.id !== opts.id && s.claudeId !== opts.id)
  if (opts.claudeId) delete store.meta[opts.claudeId]
  // Notes are keyed by the session id, and sent ones are deliberately never
  // drained — so without this the file only grows: every closed session leaves
  // its whole review behind, unreachable and unreadable.
  delete store.threadComments[opts.id]
  write(store)
}

// Drop every trace of a worktree from the store. Called when a worktree is
// removed (see git.ts): without this its sessions, remembered view and review
// checkpoint outlive it, and recreating the same branch resurrects the old
// history on what should be a clean worktree.
function forget(store: Store, worktreePath: string): boolean {
  const mine = store.created.filter((s) => s.worktreePath === worktreePath)
  const had =
    mine.length > 0 ||
    worktreePath in store.view.viewByWorktree ||
    worktreePath in store.view.agentByWorktree ||
    worktreePath in store.view.worktreeUi ||
    worktreePath in store.reviewCheckpoints
  if (!had) return false
  for (const s of mine) if (s.claudeId) delete store.meta[s.claudeId]
  store.created = store.created.filter((s) => s.worktreePath !== worktreePath)
  delete store.view.viewByWorktree[worktreePath]
  delete store.view.agentByWorktree[worktreePath]
  delete store.view.worktreeUi[worktreePath]
  delete store.reviewCheckpoints[worktreePath]
  for (const [project, path] of Object.entries(store.view.worktreeByProject))
    if (path === worktreePath) delete store.view.worktreeByProject[project]
  return true
}

export function forgetWorktree(worktreePath: string): void {
  if (!worktreePath) return
  const store = read()
  if (forget(store, worktreePath)) write(store)
}

// One-shot sweep for worktrees removed before forgetWorktree existed (or removed
// outside the app). Only prunes a path whose `.worktrees` parent still exists, so
// a repo that moved or lives on an unmounted volume keeps its history.
export function pruneMissingWorktrees(): void {
  const store = read()
  const paths = new Set<string>([
    ...store.created.map((s) => s.worktreePath),
    ...Object.keys(store.view.viewByWorktree),
    ...Object.keys(store.view.agentByWorktree),
    ...Object.keys(store.view.worktreeUi),
    ...Object.keys(store.reviewCheckpoints)
  ])
  let changed = false
  for (const p of paths) {
    if (!p || existsSync(p) || !existsSync(dirname(p))) continue
    changed = forget(store, p) || changed
  }
  if (changed) write(store)
}
