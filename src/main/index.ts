import {
  app,
  shell,
  BrowserWindow,
  dialog,
  Notification,
  nativeTheme,
  Menu,
  clipboard,
  nativeImage,
  protocol,
  type IpcMainInvokeEvent
} from 'electron'
import { join, basename } from 'path'
import { writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { userInfo } from 'node:os'
import {
  addGroup,
  deleteGroup,
  addProject,
  addProjectByPath,
  homeWorktree,
  isHomePath,
  listGroups,
  listProjects,
  probePath,
  removeProject,
  renameGroup,
  renameProject,
  setProjectEnv,
  setProjectGroup,
  setProjectPinned,
  setProjectReadOnly
} from './projects'
import { setSharedDataDir } from './dataDir'
import { log } from './log'
import { worktreeStatus } from './gitStatus'
import {
  changedFiles,
  lastCommit,
  clearReview,
  commitFileDiff,
  createWorktree,
  fileDiff,
  hasReviewCheckpoint,
  reviewCommits,
  restoreReview,
  listBranches,
  listRemoteBranches,
  listWorktrees,
  reorderWorktrees,
  setWorktreeBlocked,
  mergeWorktree,
  removeWorktree,
  removePreflight,
  removeWorktreeGuided,
  deleteBranch,
  mergePreflight,
  mergeStash,
  mergeBase,
  mergeResolveCheck,
  mergeCommit,
  mergeFastForward,
  worktreeDiffStat,
  type CreateWorktreeOptions
} from './git'
import { answerQuestion, respondPermission, stopAgent, isClaudeIdConnected, anyActiveTurn, activeTurnKeys, waitingKeys, startAgentWatchdog, replaySnapshot } from './agent'
import { codexModels, getCodexUsage } from './codex'
import { answerCodexQuestion, codexWaitingKeys } from './codexServer'
import { dispatchTurn } from './turn'
import {
  discardQuery,
  fanOut,
  mergeQuery,
  openQueryFor,
  peekQuery,
  queriesFor,
  refuse,
  refuseReason,
  reopenQuery
} from './queries'
import type { Route } from '../shared/mentions'
import { ensureAgentHookInstalled } from './hooks'
import { installGlobal as installMcpGlobal, mcpConfigFor, resolveCommandResult, shutdown as shutdownMcpServer, startMcpServer } from './mcpServer'
import { initAutoUpdate } from './autoUpdate'
import { getSystemPrompt, setSystemPrompt } from './appSettings'
import { listClaudeSessions, listResumableSessions, computeProjectActivity, readAiTitle, firstUserTitle, generateSessionTitle, generateWorktreeDesc, sessionHasUnansweredQuestion } from './claudeSessions'
import {
  setSessionTitle,
  getCreatedSession,
  findQuery,
  applyAiTitle,
  setCreatedSessionMode,
  setCreatedSessionModel,
  setCreatedSessionEffort,
  setCreatedSessionChoice,
  createdSessionChoice,
  addCreatedSession,
  normalizeSessionTitles,
  pruneMissingWorktrees,
  renameCreatedSession,
  linkCreatedSession,
  resumeSession,
  getViewState,
  setProjectWorktree,
  setWorktreeView,
  getVibrancy,
  setVibrancy,
  getRailVisible,
  setRailVisible,
  getHiddenProjects,
  setHiddenProjects,
  setWorktreeAgent,
  setProjectUi,
  setWorktreeUi,
  getThreadComments,
  addThreadComment,
  removeThreadComment,
  markThreadCommentsSent,
  type WorktreeView,
  type ProjectUiState,
  type WorktreeUiState
} from './sessionStore'
import { discoverSlashCommands } from './slashCommands'
import { getClaudeInfo, getContextUsage } from './claudeInfo'
import { sampleMemory, startMemoryStats, stopMemoryStats } from './systemStats'
import { lastUsage, refreshUsageNow, setUsageProbeCwd } from './usageMonitor'
import { startMcpAuth, cancelMcpAuth, pasteMcpAuth, killAllMcpAuths } from './mcpAuth'
import { authStatus, startLogin, pasteCode, cancelLogin, logout } from './claudeAuth'
import { claudeStats } from './claudeStats'
// Closing a session lives in its own module now — the MCP server closes one
// too (`close_session`), and it cannot import this file. Re-exported because
// this is still where the rest of the app (and index.test.ts) looks for it.
import { closeSessionFully, sessionKeys, type CloseSessionOptions } from './sessionClose'
export { closeSessionFully, sessionKeys }
export type { CloseSessionOptions }
import { localAgents, localStats, localUsage } from './localAgents'
import { sessionTranscript } from './handoff'
import { detectDevCommand, startDev, stopDev } from './devServer'
import {
  listCommands,
  addCommand,
  updateCommand,
  removeCommand,
  setCommandScope,
  type CommandScope,
  type CommandPatch
} from './commands'
import { buildAppMenu } from './menu'
import { loadKeybindings, rebindCommand, resetKeybindings, revealKeybindings } from './keybindings'
import { configErrors, configPaths, initConfig, watchConfig } from './config'
import { createSkill, deleteSkill, listSkills, renameSkill } from './config/skills'
import { projectFor, projectScan } from './config/projectStore'
import {
  addMcpServer,
  listMcpServers,
  removeMcpServer,
  updateMcpServer,
  type McpServerPatch,
  type NewMcpServer
} from './config/mcpServers'
import { setSandboxEnabled } from './sandbox'
import { floeConfig, setFloeValue } from './config/floe'
import { handle } from './plugins/handleMap'
import { loadPlugins, pluginWindowCreated, shutdownPlugins } from './plugins/host'
import { launchEditor } from './editors'
import type { TomlValue } from './config/toml'
import {
  openTerminal,
  openEditor,
  writeTerminal,
  resizeTerminal,
  killTerminal,
  killAllTerminals,
  killTerminalsForWorktree,
  listLiveTerminals,
  notifyTerminalsTheme
} from './terminal'
import {
  startCommand,
  stopCommand,
  restartCommand,
  attachCommand,
  resizeCommand,
  killAllCommands,
  killCommandsForWorktree,
  commandRuns,
  reapOrphanCommands,
  runShellCapture
} from './commandRunner'
import {
  applyFileOps,
  listDir,
  readFileContent,
  renderDocument,
  resolveWikiLink,
  safeResolve,
  searchableFiles
} from './files'
import { SCHEME as MEDIA_SCHEME, mediaResponse, probeMedia } from './media'
import { copyPlan, listPlans, readImplementPhases, readPlan, watchPlans } from './plans'
import { boardFor, nannyFor, nannyOpener, pushBoard, reconcileColony, releaseTask, tick } from './colony/runner'
import { addTask, removeTask, type NewTask } from './colony/store'
import { applyDelta, createDrawing, listDrawings, promoteDrawing, readDrawing, watchDraw } from './draw/index'
import { watchChanges } from './reviewWatch'
import { provisionWorktree, dropWorktreeDatabase, unlinkWorktreeSite, ensureContainerUp } from './provision'
import type { AgentRunOptions, DrawDelta, DrawScope, Effort, FileAttachment, FileOp, ImageAttachment, JumpSession, McpCommandResult, NeedsYouSession, PermissionMode, ProjectActivity, ProjectEnvConfig, ThreadComment, Worktree } from '../shared/types'

// Launched from Finder, a packaged app gets a minimal PATH — so claude/git/npm
// wouldn't be found. Prepend the usual locations.
// In dev we want one running instance per git worktree, side by side. They all
// derive the same `userData` dir from the appId, so they'd clobber each other's
// projects.json / screenshot. Give each worktree its own data dir, keyed by the
// worktree path. Packaged builds keep the shared, canonical userData.
function isolateUserDataPerWorktree(): void {
  if (app.isPackaged) return
  const root = process.cwd()
  const hash = createHash('sha1').update(root).digest('hex').slice(0, 8)
  const base = app.getPath('userData')
  // Electron's own state (locks, caches, screenshots) stays isolated per worktree
  // so side-by-side dev instances don't clobber each other — but the persistent
  // JSON stores (sessions, projects, …) share one dev dir, so relaunching from a
  // different worktree no longer loses your sessions. Kept separate from the
  // packaged store so a dev build's store changes can't corrupt real data.
  setSharedDataDir(`${base} (dev-shared)`)
  app.setPath('userData', `${base} (dev-${basename(root)}-${hash})`)
}

function fixPath(): void {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', `${process.env.HOME ?? ''}/.local/bin`, '/usr/bin', '/bin']
  const current = (process.env.PATH ?? '').split(':')
  process.env.PATH = [...new Set([...extra, ...current])].filter(Boolean).join(':')
}

// Worktrees whose Haiku description pass is currently in flight — so a burst of
// worktrees:list calls (the sidebar re-fetches often) doesn't spawn duplicate
// claude processes for the same worktree.
const descInFlight = new Set<string>()

// Refresh AI descriptions for a project's worktrees off the critical path. Each
// generateWorktreeDesc is a no-op unless the worktree's spec.md changed, so this
// is cheap on repeat calls; when any description actually lands, re-list and push
// worktrees:updated so the sidebar's onUpdated effect picks it up.
// ponytail: first load of a project with many un-described specs fires one Haiku
// call per worktree at once — fine at real worktree counts; add a small pool if a
// project ever has dozens of undescribed specs.
export async function refreshWorktreeDescs(win: BrowserWindow, repoPath: string, worktrees: Worktree[]): Promise<void> {
  const targets = worktrees.filter((w) => !w.isMain && !w.home && !descInFlight.has(w.path))
  if (targets.length === 0) return
  targets.forEach((w) => descInFlight.add(w.path))
  try {
    const results = await Promise.all(
      targets.map((w) => generateWorktreeDesc(w.path, w.branch).catch(() => null))
    )
    if (!results.some(Boolean)) return
    const fresh = await listWorktrees(repoPath)
    if (!win.isDestroyed()) win.webContents.send('worktrees:updated', { project: repoPath, worktrees: fresh })
  } finally {
    targets.forEach((w) => descInFlight.delete(w.path))
  }
}


// The worktrees of a project that can run sessions. Home isn't a git repo and a
// read-only project never runs one, so both come back empty — as does a project
// whose repo has moved or been removed, which just leaves it off the rail.
async function sessionWorktrees(project: { path: string; readOnly?: boolean; home?: boolean }): Promise<Worktree[]> {
  if (project.readOnly || project.home) return []
  try {
    return await listWorktrees(project.path)
  } catch {
    return []
  }
}

// Projects rail: a cross-project activity snapshot for every project worked
// today (sessions touched since midnight), each with a single status glyph.
export async function projectsActivity(): Promise<ProjectActivity[]> {
  const out: ProjectActivity[] = []
  for (const project of listProjects()) {
    const worktrees = await sessionWorktrees(project)
    const activity = computeProjectActivity(worktrees.map((w) => w.path), isClaudeIdConnected)
    if (activity) out.push({ path: project.path, ...activity })
  }
  return out
}

// The sessions in one worktree that are blocked on an unanswered question.
export function waitingSessions(worktreePath: string): ReturnType<typeof listClaudeSessions> {
  return listClaudeSessions(worktreePath).filter(
    (s) =>
      s.claudeId &&
      (s.active || isClaudeIdConnected(s.claudeId)) &&
      sessionHasUnansweredQuestion(worktreePath, s.claudeId)
  )
}

// Every session, across ALL projects, currently blocked on an unanswered
// question — feeds the ⌘/ switcher's "NEEDS YOU" list and the Home strip. Same
// on-disk scan as projectsActivity, but per-session and with the worktree's diff
// stat attached. Only worktrees that actually have a waiting session pay for the
// (cheap) `git diff --shortstat`.
export async function needsYouSessions(): Promise<NeedsYouSession[]> {
  const out: NeedsYouSession[] = []
  for (const project of listProjects()) {
    for (const wt of await sessionWorktrees(project)) {
      const waiting = waitingSessions(wt.path)
      if (!waiting.length) continue
      const stat = await worktreeDiffStat(wt.path)
      for (const s of waiting) {
        out.push({
          projectPath: project.path,
          projectName: project.name,
          worktreePath: wt.path,
          branch: wt.branch,
          sessionId: s.id,
          title: s.title,
          lastActivityAt: s.mtime,
          additions: stat.additions,
          deletions: stat.deletions
        })
      }
    }
  }
  return out
}

// Every session on disk, across ALL projects — the ⌘J palette's index. Same walk
// as needsYouSessions, without the question filter or the diff stat, so the
// palette can pull it on open instead of paying for a poll.
export async function allSessions(): Promise<JumpSession[]> {
  const out: JumpSession[] = []
  for (const project of listProjects()) {
    for (const wt of await sessionWorktrees(project)) {
      for (const s of listClaudeSessions(wt.path)) {
        out.push({
          projectPath: project.path,
          projectName: project.name,
          worktreePath: wt.path,
          branch: wt.branch,
          sessionId: s.id,
          title: s.title,
          lastActivityAt: s.mtime,
          // A turn in flight — NOT "the child is alive", which a session that
          // answered an hour ago still is: the CLI child is kept for the next
          // --resume, so that read left every session it had ever run marked as
          // working until the process was reaped.
          running: anyActiveTurn([s.id, s.claudeId])
        })
      }
    }
  }
  return out
}

// A worktree path resolved to the project it belongs to, for the config files
// scoped per project (skills, MCP servers). No path — or one under no known
// project — means global scope.
export function projectScope(worktreePath?: string): string | undefined {
  return worktreePath ? (projectFor(worktreePath) ?? undefined) : undefined
}

// Write one value through the surgical TOML writer, then re-zoom every window
// straight away rather than through the watcher: the font-size slider is
// dragged, and 120ms of watcher debounce between the handle and the app resizing
// is the difference between adjusting a size and guessing one. The watcher still
// fires after, on the same value — setZoomFactor is idempotent.
export function setConfigValue(table: string, key: string, value: TomlValue): ReturnType<typeof floeConfig> {
  setFloeValue(table, key, value)
  for (const win of BrowserWindow.getAllWindows()) applyZoom(win)
  return floeConfig()
}

/** Persist the translucency preference and flip the live window to match. */
export function toggleVibrancy(win: BrowserWindow | null, on: boolean): void {
  setVibrancy(on)
  if (win && !win.isDestroyed()) applyVibrancy(win, on)
}

// Who to greet on the launcher. `git config user.name` first — it's the name the
// user already chose to be known by on this machine, and it's set on any box
// that commits. `id -F` is the macOS full name; the login name is the last
// resort because "r2luna" reads like a handle, not a greeting. Cached: it can't
// change without a relaunch mattering, and the launcher asks on every mount.
let userName: string | null = null

export async function userDisplayName(): Promise<string> {
  // The config wins outright — it is the user saying what to call them — and is
  // read on every call rather than cached, so editing the file (or the Settings
  // row) changes the greeting without a relaunch.
  const chosen = floeConfig().user.name
  if (chosen) return chosen
  userName ??= firstName(await detectFullName())
  return userName
}

/** `git config` first, then the macOS full name, then the login name. */
async function detectFullName(): Promise<string> {
  return (
    (await runQuiet('git', ['config', '--global', 'user.name'])) ||
    (await runQuiet('id', ['-F'])) ||
    userInfo().username
  )
}

/** "Good evening, Rafael Lunardelli" reads like a form letter — first name only. */
export function firstName(full: string): string {
  return full.split(/\s+/)[0] ?? ''
}

/** A probe command's trimmed stdout, or '' if it is not installed / fails. */
async function runQuiet(cmd: string, args: string[]): Promise<string> {
  try {
    return (await promisify(execFile)(cmd, args)).stdout.trim()
  } catch {
    return ''
  }
}

/** The Claude CLI this machine has, for Settings → Advanced. */
export async function probeClaudeBinary(): Promise<{ claude: { path: string | null; version: string | null } }> {
  const path = (await runQuiet('which', ['claude'])) || null
  const version = path ? (await runQuiet('claude', ['--version'])) || null : null
  return { claude: { path, version } }
}

// The window a handler's sender belongs to, or null once it has been closed —
// every handler that needs one normalizes it the same way.
export const winOf = (event: IpcMainInvokeEvent): BrowserWindow | null =>
  BrowserWindow.fromWebContents(event.sender) ?? null

// Open a side conversation off a session. A harness that cannot take one is
// refused in the chat rather than thrown, so the composer stays usable.
export function openQuery(
  win: BrowserWindow | null,
  sessionKey: string,
  worktreePath: string,
  harness: string,
  model?: string,
  effort?: Effort
): { query: unknown } | { error: string } {
  const opened = openQueryFor(win, sessionKey, worktreePath, { harness, model, effort, openedBy: 'user' })
  if (opened) return { query: opened.query }
  const error = refuseReason(harness)
  refuse(win, sessionKey, error)
  return { error }
}

/** `@all` — the target list comes from the caller and is never inferred. */
export function openAllQueries(
  win: BrowserWindow | null,
  sessionKey: string,
  worktreePath: string,
  harnesses: string[],
  prompt: string,
  effort?: Effort
): ReturnType<typeof fanOut> | { error: string } {
  if (!Array.isArray(harnesses) || !harnesses.length) return { error: 'No harnesses given.' }
  return fanOut(win, sessionKey, worktreePath, { harnesses, prompt, effort })
}

// What a merged or discarded query actually said, for the fold in the chat to
// open. Read on demand rather than carried on the chip: a conversation is
// thousands of characters, the fold is closed by default (merging is about the
// model reading it, not you re-reading it), and most are never opened.
export function queryTranscript(qkey: string): ReturnType<typeof sessionTranscript> {
  const found = findQuery(qkey)
  const parent = found ? getCreatedSession(found.sessionId) : undefined
  if (!parent) return []
  return sessionTranscript(parent.worktreePath, qkey)
}

/** The way back from a discard. An unknown key is reported, never thrown. */
export function reopenQueryFor(win: BrowserWindow | null, qkey: string): { query: unknown } | { error: string } {
  const opened = reopenQuery(win, qkey)
  return opened ? { query: opened.query } : { error: `Unknown query: ${qkey}` }
}

export type NotifyPayload = { title: string; body: string; sessionId: string }

/** Only safe schemes reach the OS shell — this list is the authority. */
export function openExternalUrl(url: string): void {
  if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url)
}

// Bring a window forward — even from behind other apps or minimized. On macOS
// the app itself has to be raised too, or `show()` lands behind whatever is in
// front. Returns whether a window was actually raised.
export function raiseWindow(win: BrowserWindow | null): boolean {
  if (!win || win.isDestroyed()) return false
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  if (process.platform === 'darwin') app.focus({ steal: true })
  return true
}

// Clicking the notification surfaces Floe and tells the renderer which session
// to open — a window that has since closed just gets the raise refused.
export function showNotification(win: BrowserWindow | null, payload: NotifyPayload): void {
  if (!Notification.isSupported()) return
  const note = new Notification({ title: payload.title, body: payload.body })
  note.on('click', () => {
    if (raiseWindow(win)) win?.webContents.send('notification:click', payload.sessionId)
  })
  note.show()
}

/** ⌘H hides the whole app on macOS; elsewhere there is only this window. */
export function hideWindow(win: BrowserWindow | null): void {
  if (process.platform === 'darwin') return app.hide()
  win?.hide()
}

// Give a session a short, smart title after a turn, unless manually renamed.
// Interactive sessions get Claude's own ai-title; the headless runs Floe drives
// have none, so we generate one with Haiku from the opening request — but only
// while the title is still an auto placeholder ("Session N" or the raw
// first-message fallback), so it's one Haiku call per session, not every turn.
// Returns the new title so the renderer can update in place, else null.
export async function adoptAiTitle(id: string): Promise<string | null> {
  const c = getCreatedSession(id)
  if (!c?.claudeId) return null
  const aiTitle = readAiTitle(c.worktreePath, c.claudeId)
  if (aiTitle) return applyTitle(c.claudeId, aiTitle)
  if (!isPlaceholderTitle(c.title, c.worktreePath, c.claudeId)) return null
  return applyTitle(c.claudeId, await generateSessionTitle(c.worktreePath, c.claudeId))
}

/** The title, if it stuck — a manual rename landing first wins over it. */
export function applyTitle(claudeId: string, title: string | null): string | null {
  return title && applyAiTitle(claudeId, title) ? title : null
}

/** A title the user never chose: "Session 3", or the raw first message. */
export function isPlaceholderTitle(title: string, worktreePath: string, claudeId: string): boolean {
  return /^Session \d+$/.test(title) || title === firstUserTitle(worktreePath, claudeId)
}

/** The message an unknown throw carries, for a log line or an IPC reply. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// The Home workspace isn't a git repo — hand back its single synthetic worktree
// so the renderer can open a terminal in it like any worktree. Otherwise the
// cached list comes straight back and the AI descriptions refresh behind it:
// fire-and-forget, pushing an updated list once new descriptions land.
export async function listWorktreesFor(win: BrowserWindow | null, repoPath: string): Promise<Worktree[]> {
  if (isHomePath(repoPath)) return [homeWorktree()]
  const worktrees = await listWorktrees(repoPath)
  if (win) void refreshWorktreeDescs(win, repoPath, worktrees)
  return worktrees
}

// The sidebar's git dirt, asked for AFTER the list is on screen so a slow `git
// status` never delays landing on a session. One call for the whole project; the
// worktrees run in parallel, and a clean one is left out entirely.
export async function worktreeStatuses(paths: string[]): Promise<Record<string, unknown>> {
  const entries = await Promise.all(
    paths.filter((path) => !isHomePath(path)).map(async (path) => [path, await worktreeStatus(path)] as const)
  )
  return Object.fromEntries(entries.filter(([, status]) => status))
}

// Everything spawned inside a worktree, stopped — before it is removed. Agent
// sessions are stopped by the renderer beforehand.
export function stopWorktreeProcesses(target: string): void {
  stopDev(target)
  killCommandsForWorktree(target)
  killTerminalsForWorktree(target)
}

// Undo the `herd link` the Laravel recipe made. Runs while the directory is
// still there — `herd unlink` reads the site from the cwd it is called in.
export async function unlinkSite(target: string): Promise<Record<string, unknown>> {
  const lines: string[] = []
  try {
    const result = await unlinkWorktreeSite(target, (t) => lines.push(t))
    return { ok: true, unlinked: result === 'unlinked', detail: lines[lines.length - 1] }
  } catch (e) {
    return { ok: false, unlinked: false, message: errorText(e) }
  }
}

// Drop the worktree's per-branch database (MySQL/MariaDB/Postgres). Reads the
// worktree's .env, so the renderer runs this step before the worktree is torn
// down. Never touches the main checkout's database.
export async function dropDatabase(root: string, target: string): Promise<Record<string, unknown>> {
  const lines: string[] = []
  try {
    const result = await dropWorktreeDatabase(target, root, (t) => lines.push(t))
    return { ok: true, dropped: result === 'dropped', detail: lines[lines.length - 1] }
  } catch (e) {
    return { ok: false, dropped: false, message: errorText(e) }
  }
}

// The app's whole IPC surface. Every channel is registered by one of the domain
// registrars below, in this order — the renderer's preload expects to find them
// all after a single call.
export function registerIpc(): void {
  // One-shot: heal any colliding "Session N" titles left by older builds.
  normalizeSessionTitles()
  // One-shot: drop sessions/view state left behind by worktrees that are gone.
  pruneMissingWorktrees()
  registerProjectsIpc()
  registerAgentIpc()
  registerQueryIpc()
  registerMcpIpc()
  registerSessionIpc()
  registerViewStateIpc()
  registerStatusIpc()
  registerCommandIpc()
  registerEditorIpc()
  registerFileIpc()
  registerNotesIpc()
  registerColonyIpc()
  registerTerminalIpc()
  registerWorktreeIpc()
  registerWindowIpc()
  registerSettingsIpc()
  watchThemeChanges()
  watchConfigReload()
}


// Projects, groups and the cross-project activity rails.
export function registerProjectsIpc(): void {
  handle('projects:list', () => listProjects())
  handle('projects:groups', () => listGroups())
  handle('projects:addGroup', (_event, name: string) => addGroup(name))
  handle('projects:deleteGroup', (_event, name: string) => deleteGroup(name))
  handle('projects:renameGroup', (_event, oldName: string, newName: string) =>
    renameGroup(oldName, newName)
  )
  handle('projects:rename', (_event, path: string, newName: string) =>
    renameProject(path, newName)
  )
  handle('projects:add', (_event, group?: string) => addProject(group))
  // Web/headless has no native folder picker — the renderer collects a path and adds it.
  handle('projects:addByPath', (_event, path: string, group?: string) =>
    addProjectByPath(path, group)
  )
  // What the add dialog shows about the path while you type it — the same
  // checks the add itself runs, so the pane never promises what Add refuses.
  handle('projects:probe', (_event, path: string) => probePath(path))
  // Per-project containerized env (mode 'container' → Docker); null turns it off
  // (back to host-native provisioning). See provision.ts / compose.ts.
  handle('projects:setEnv', (_event, path: string, env: ProjectEnvConfig | null) =>
    setProjectEnv(path, env)
  )
  handle('projects:setGroup', (_event, path: string, group: string) => setProjectGroup(path, group))
  handle('projects:remove', (_event, path: string) => removeProject(path))
  handle('projects:setReadOnly', (_event, path: string, value: boolean) =>
    setProjectReadOnly(path, value)
  )
  handle('projects:setPinned', (_event, path: string, value: boolean) =>
    setProjectPinned(path, value)
  )

  handle('projects:activity', () => projectsActivity())
  handle('sessions:needsYou', () => needsYouSessions())
  handle('sessions:all', () => allSessions())

  // Rail visibility + the per-project hide list (both persisted in prefs).
  handle('rail:get', () => getRailVisible())
  handle('rail:set', (_event, on: boolean) => setRailVisible(on))
  handle('projects:getHidden', () => getHiddenProjects())
  handle('projects:setHidden', (_event, paths: string[]) => setHiddenProjects(paths))
  handle('codex:models', () => codexModels())
}

// Turns: starting, answering, stopping — plus the live-state reads.
export function registerAgentIpc(): void {
  handle(
    'agent:start',
    (
      event,
      key: string,
      worktreePath: string,
      prompt: string,
      options: AgentRunOptions,
      images: ImageAttachment[] = [],
      files: FileAttachment[] = [],
      route: Route | null = null
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return
      // The composer has already read any handle at the front and picked the
      // harness itself — it has the machine's installed list and the menu that
      // offered them. It passes that ROUTE on rather than throwing it away:
      // where a routed message goes is one decision for all five doors, and it
      // is made in turn.ts. See dispatchTurn.
      dispatchTurn({
        win,
        parentKey: key,
        worktreePath,
        prompt,
        route,
        origin: 'user',
        options,
        images,
        files
      })
    }
  )
  // Composer `!` shell mode: run a one-shot command in the worktree and return
  // its output, which the renderer then hands to the agent as a prompt.
  handle('shell:run', (_event, worktreePath: string, command: string) =>
    runShellCapture(worktreePath, command)
  )
  handle('agent:answer', (_event, key: string, requestId: string, answer: string, answers?: string[][]) => {
    // Codex questions resolve over the app-server's JSON-RPC (per-question-id
    // answers); everything else is Claude's control channel.
    if (answerCodexQuestion(key, answers ?? [[answer]])) return
    answerQuestion(key, requestId, answer)
  })
  handle('agent:permission', (_event, key: string, requestId: string, allow: boolean) =>
    respondPermission(key, requestId, allow)
  )
  // What a panel opening mid-turn missed: the streamed events since turn start.
  handle('agent:replay', (_event, key: string) => replaySnapshot(key))
  // The authoritative "who is working right now", for the renderer to reconcile
  // its live event set against. The set is built from `done` arriving; a `done`
  // that never lands (a crashed child, a window reloaded mid-turn) would leave a
  // session spinning forever with nothing to correct it.
  handle('agent:active', () => activeTurnKeys())
  // The same correction for "who is blocked on YOU": the `?` is set by a
  // `question`/`permission` event and cleared by the next event on that key, so
  // an event that lands under the session's other name — or a window that
  // reloaded while a card was up — left the mark on with nothing to turn it off.
  handle('agent:waiting', () => [...new Set([...waitingKeys(), ...codexWaitingKeys()])])
  handle('agent:stop', (event, key: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) stopAgent(win, key)
  })
}

// Queries: side conversations opened off a session.
export function registerQueryIpc(): void {
  handle('query:list', (_event, sessionKey: string) => queriesFor(sessionKey))
  handle(
    'query:open',
    (event, sessionKey: string, worktreePath: string, harness: string, model?: string, effort?: Effort) =>
      openQuery(winOf(event), sessionKey, worktreePath, harness, model, effort)
  )
  // The three actions that close the cycle, plus the way back from a discard.
  // Every one of them is main's: a query's transcript, its conn and the
  // watermark between it and the chat all live here, and an action that ran in
  // the renderer would be doing it with none of them.
  handle('query:peek', (event, qkey: string) => peekQuery(winOf(event), qkey))
  handle('query:merge', (event, qkey: string) => mergeQuery(winOf(event), qkey))
  handle('query:discard', (event, qkey: string) => discardQuery(winOf(event), qkey))
  // `@all`: one message to several, each in its own query, answers mirrored
  // back into the chat as a comparison. The TARGETS come from the caller and
  // are never inferred — see R7 in docs/queries.md.
  handle(
    'query:all',
    (event, sessionKey: string, worktreePath: string, harnesses: string[], prompt: string, effort?: Effort) =>
      openAllQueries(winOf(event), sessionKey, worktreePath, harnesses, prompt, effort)
  )
  handle('query:transcript', (_event, qkey: string) => queryTranscript(qkey))
  handle('query:reopen', (event, qkey: string) => reopenQueryFor(winOf(event), qkey))
}

// Floe's own MCP server and the registry panel's CRUD.
export function registerMcpIpc(): void {
  // The renderer's reply to a run_command/list_commands pushed by the MCP
  // server; resolves the waiting tool with the outcome.
  handle('mcp:command-result', (_event, result: McpCommandResult) => resolveCommandResult(result))
  // Register Floe's MCP server in the user's global Claude config — the ⌘K
  // "Install Floe MCP globally" command (also auto-run at boot when the server
  // holds its preferred port; see mcpServer.ts ensureGlobalRegistered).
  handle('mcp:installGlobal', () => installMcpGlobal())
  // Floe's own MCP registry (config/mcpServers.ts) — the panel's CRUD. The
  // worktree path resolves to its project for the project-scope file, same as
  // skills.
  handle('mcp:servers:list', (_event, worktreePath?: string) => listMcpServers(projectScope(worktreePath)))
  handle('mcp:servers:add', (_event, scope: 'global' | 'project', server: NewMcpServer, worktreePath?: string) =>
    addMcpServer(scope, server, projectScope(worktreePath))
  )
  handle('mcp:servers:update', (_event, name: string, patch: McpServerPatch, worktreePath?: string) =>
    updateMcpServer(name, patch, projectScope(worktreePath))
  )
  handle('mcp:servers:remove', (_event, name: string, worktreePath?: string) =>
    removeMcpServer(name, projectScope(worktreePath))
  )
}

// Sessions on disk: listing, resuming, titling, closing.
export function registerSessionIpc(): void {
  handle('claude:sessions', (_event, worktreePath: string) =>
    // Both names: the conn is filed under whichever the session last spawned
    // with, and `m.id` alone missed the turns that ran under the claudeId.
    listClaudeSessions(worktreePath).map((m) => ({ ...m, running: anyActiveTurn([m.id, m.claudeId]) }))
  )
  handle('claude:resumable', (_event, worktreePath: string) => listResumableSessions(worktreePath))
  handle('sessions:resume', (_event, s: { worktreePath: string; claudeId: string; title: string; mtime: number }) =>
    resumeSession(s)
  )
  // A session can have talked to several harnesses — Claude's own JSONL and our
  // log for whoever else answered — so the merge (and the stripping of the
  // handoff packets we injected) lives in main/handoff.ts, where the same view
  // is what decides who still needs to be told what.
  handle('claude:transcript', (_event, worktreePath: string, sessionId: string) =>
    sessionTranscript(worktreePath, sessionId)
  )
  handle('sessions:setTitle', (_event, claudeId: string, title: string) => setSessionTitle(claudeId, title))
  handle('sessions:setMode', (_event, id: string, mode: PermissionMode) => setCreatedSessionMode(id, mode))
  handle('sessions:setModel', (_event, id: string, model: string) => setCreatedSessionModel(id, model))
  handle('sessions:setEffort', (_event, id: string, effort: Effort) => setCreatedSessionEffort(id, effort))
  // The whole picker at once. What the composer writes when you change it, and
  // reads when the chat opens — see the note on `provider` in sessionStore.
  handle(
    'sessions:setChoice',
    (_event, id: string, choice: { provider?: string; model?: string; effort?: Effort; mode?: PermissionMode }) =>
      setCreatedSessionChoice(id, choice)
  )
  handle('sessions:choice', (_event, id: string) => createdSessionChoice(id))
  handle('sessions:create', (_event, s: { id: string; worktreePath: string; title?: string }) =>
    addCreatedSession(s)
  )
  handle('sessions:renameCreated', (_event, id: string, title: string) => renameCreatedSession(id, title))
  handle('sessions:adoptAiTitle', (_event, id: string) => adoptAiTitle(id))
  handle('sessions:link', (_event, id: string, claudeId: string) => linkCreatedSession(id, claudeId))
  handle('sessions:close', (event, opts: CloseSessionOptions) => closeSessionFully(winOf(event), opts))
}

// Persisted view state — what was open where.
export function registerViewStateIpc(): void {
  handle('viewState:get', () => getViewState())
  handle('viewState:setProjectWorktree', (_event, projectPath: string, worktreePath: string) =>
    setProjectWorktree(projectPath, worktreePath)
  )
  handle('viewState:setWorktreeView', (_event, worktreePath: string, view: WorktreeView) =>
    setWorktreeView(worktreePath, view)
  )
  handle('viewState:setWorktreeAgent', (_event, worktreePath: string, sessionId: string) =>
    setWorktreeAgent(worktreePath, sessionId)
  )
  handle('viewState:setProjectUi', (_event, projectPath: string, ui: ProjectUiState) =>
    setProjectUi(projectPath, ui)
  )
  handle('viewState:setWorktreeUi', (_event, worktreePath: string, ui: WorktreeUiState) =>
    setWorktreeUi(worktreePath, ui)
  )
}

// Read-only probes: slash commands, usage, auth, local runtimes.
export function registerStatusIpc(): void {
  handle('slash:list', (_event, worktreePath: string) => discoverSlashCommands(worktreePath))
  handle('claude:info', async (_event, worktreePath: string) => {
    const [info, codexUsage] = await Promise.all([
      // The merged --mcp-config makes the probe's /mcp report Floe's own
      // registry with live connection state — what the MCP panel shows.
      getClaudeInfo(worktreePath, mcpConfigFor('info-probe', worktreePath)),
      getCodexUsage()
    ])
    return { ...info, codexUsage }
  })
  handle('claude:contextUsage', (_event, worktreePath: string, claudeId?: string) =>
    getContextUsage(worktreePath, claudeId)
  )
  // Topbar stats: usage refresh is the only pull; memory + usage are pushed.
  handle('stats:getMemory', () => sampleMemory())
  handle('stats:refreshUsage', () => refreshUsageNow())
  // The probe spawns a `claude` and takes seconds. This is the instant answer
  // the account panel paints first, so the row is never blank while it waits.
  handle('stats:lastUsage', () => lastUsage())
  handle('stats:setUsageCwd', (_event, worktreePath: string) => setUsageProbeCwd(worktreePath))
  handle('mcp:auth:start', (event, worktreePath: string, serverName: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) startMcpAuth(win, worktreePath, serverName)
  })
  handle('mcp:auth:cancel', (_event, worktreePath: string, serverName: string) =>
    cancelMcpAuth(worktreePath, serverName)
  )
  handle('mcp:auth:paste', (_event, worktreePath: string, serverName: string, redirectUrl: string) =>
    pasteMcpAuth(worktreePath, serverName, redirectUrl)
  )

  // Signing in to the Claude account itself — see main/claudeAuth.ts.
  handle('claude:auth:status', () => authStatus())
  handle('claude:stats', () => claudeStats())
  // Every AI runtime this machine has, with the models each one can run.
  handle('agents:local', () => localAgents())
  // Separate from detection because this one spawns — only the account panel
  // asks, and only while it is open.
  handle('agents:usage', () => localUsage())
  handle('agents:stats', () => localStats())
  handle('claude:auth:login', (event, mode: 'claudeai' | 'console') => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) startLogin(win, mode)
  })
  handle('claude:auth:paste', (_event, code: string) => pasteCode(code))
  handle('claude:auth:cancel', () => cancelLogin())
  handle('claude:auth:logout', () => logout())
}

// Saved commands and the dev server.
export function registerCommandIpc(): void {
  handle('commands:list', (_event, projectPath: string, worktreePath: string) =>
    listCommands(projectPath, worktreePath)
  )
  handle(
    'commands:add',
    (_event, scope: CommandScope, projectPath: string, worktreePath: string, name: string, command: string) =>
      addCommand(scope, projectPath, worktreePath, name, command)
  )
  handle(
    'commands:update',
    (_event, projectPath: string, worktreePath: string, id: string, patch: CommandPatch) =>
      updateCommand(projectPath, worktreePath, id, patch)
  )
  handle('commands:remove', (_event, projectPath: string, worktreePath: string, id: string) =>
    removeCommand(projectPath, worktreePath, id)
  )
  handle(
    'commands:setScope',
    (_event, projectPath: string, worktreePath: string, id: string, scope: CommandScope) =>
      setCommandScope(projectPath, worktreePath, id, scope)
  )

  handle('dev:detect', (_event, worktreePath: string) => detectDevCommand(worktreePath))
  handle('dev:start', (event, worktreePath: string, branch: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win ? startDev(win, worktreePath, branch) : null
  })
  handle('dev:stop', (_event, worktreePath: string) => stopDev(worktreePath))
}

// Terminal- and editor-backed panels.
export function registerEditorIpc(): void {
  handle(
    'terminal:open',
    (event, id: string, cwd: string, branch: string, cols: number, rows: number) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      return win ? openTerminal(win, id, cwd, branch, cols, rows) : null
    }
  )
  handle(
    'editor:open',
    (
      event,
      id: string,
      cwd: string,
      branch: string,
      file: string | null,
      cols: number,
      rows: number,
      line?: number
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      return win ? openEditor(win, id, cwd, branch, file, cols, rows, line) : null
    }
  )
  // `e` on a file: a GUI editor is launched here and the renderer is told so;
  // a terminal editor reports `panel`, and the renderer opens the editor panel
  // (which runs it on the PTY) instead. One place decides which.
  handle('editor:launch', (_event, cwd: string, file: string, line?: number) =>
    launchEditor(cwd, file, line)
  )
}

// The file tree, media probes and the review diff.
export function registerFileIpc(): void {
  handle('files:list', (_event, worktreePath: string, relPath?: string) =>
    // The Home workspace's path is the user's home directory — not a git repo,
    // and it is terminal-only, with no file tree to fill. Hand back nothing.
    isHomePath(worktreePath) ? [] : listDir(worktreePath, relPath)
  )
  handle('files:all', (_event, worktreePath: string) =>
    // Same rule as the tree: Home is the user's home directory, not a repo.
    isHomePath(worktreePath) ? [] : searchableFiles(worktreePath)
  )
  handle('files:read', (_event, worktreePath: string, relPath: string) =>
    readFileContent(worktreePath, relPath)
  )
  // The slow half of an Office preview: LibreOffice drawing the real slides.
  // Asked for after the text is already on screen, and null whenever this
  // machine cannot do it.
  handle('files:renderDoc', (_event, worktreePath: string, relPath: string) =>
    renderDocument(worktreePath, relPath)
  )
  // A video the chat found named in a message: is it really there? The bytes
  // never come back through IPC — only the `floe-media://` URL that streams
  // them (see media.ts).
  handle('media:probe', (_event, path: string, cwd?: string) => probeMedia(path, cwd))
  // The lightbox's `c`: the same clipboard write the right-click menu does, but
  // driven from the keyboard, where the pointer's coordinates don't exist.
  handle('media:copyImage', (_event, dataUrl: string) => {
    const image = nativeImage.createFromDataURL(dataUrl)
    if (image.isEmpty()) return false
    clipboard.writeImage(image)
    return true
  })
  handle(
    'files:resolveLink',
    (_event, worktreePath: string, fromRelPath: string, target: string) =>
      resolveWikiLink(worktreePath, fromRelPath, target)
  )
  handle('files:apply', (_event, worktreePath: string, ops: FileOp[]) =>
    applyFileOps(worktreePath, ops)
  )
  // `o` on a file row: hand the path to the OS and let it pick the app — an
  // .html opens in the browser, a .xlsx in the spreadsheet. The reader beside
  // the list shows the bytes; this is for the files that only mean something
  // in the program that made them.
  handle('files:open', async (_event, worktreePath: string, relPath: string) => {
    const failure = await shell.openPath(safeResolve(worktreePath, relPath))
    // openPath resolves with the OS's complaint instead of rejecting, and a
    // silent no-op is the one thing a keybinding must never be.
    if (failure) throw new Error(failure)
  })
  handle('review:changedFiles', (_event, worktreePath: string) => changedFiles(worktreePath))
  handle('review:lastCommit', (_event, worktreePath: string) => lastCommit(worktreePath))
  handle('review:fileDiff', (_event, worktreePath: string, relPath: string, context?: number) =>
    fileDiff(worktreePath, relPath, context)
  )
  handle('review:commits', (_event, worktreePath: string) => reviewCommits(worktreePath))
  handle('review:commitDiff', (_event, worktreePath: string, hash: string, relPath: string) =>
    commitFileDiff(worktreePath, hash, relPath)
  )
  handle('review:clear', (_event, worktreePath: string) => clearReview(worktreePath))
  handle('review:restore', (_event, worktreePath: string) => restoreReview(worktreePath))
  handle('review:isCleared', (_event, worktreePath: string) => hasReviewCheckpoint(worktreePath))
}

// Thread comments, plans and drawings.
export function registerNotesIpc(): void {
  // Notes anchored to passages of a session's transcript.
  handle('threadComments:list', (_event, sessionKey: string) => getThreadComments(sessionKey))
  handle('threadComments:add', (_event, comment: ThreadComment) => addThreadComment(comment))
  handle('threadComments:remove', (_event, sessionKey: string, id: string) =>
    removeThreadComment(sessionKey, id)
  )
  handle('threadComments:markSent', (_event, sessionKey: string, ids: string[]) =>
    markThreadCommentsSent(sessionKey, ids)
  )
  handle('review:watch', (event, worktreePath: string) => watchChanges(event.sender, worktreePath))
  handle('plans:list', (_event, worktreePath: string, branch?: string) => listPlans(worktreePath, branch))
  handle('plans:read', (_event, worktreePath: string, relPath: string) => readPlan(worktreePath, relPath))
  handle('plans:watch', (event, worktreePath: string) => watchPlans(event.sender, worktreePath))
  handle('plans:copy', (_event, srcWorktreePath: string, relPath: string, destWorktreePath: string) =>
    copyPlan(srcWorktreePath, relPath, destWorktreePath)
  )
  // Drawings. `draw:apply` is the ONLY write: nobody sends a whole scene, because
  // the canvas and an agent write the same file concurrently. See draw/index.ts.
  handle('draw:list', (_event, worktreePath: string, branch?: string) => listDrawings(worktreePath, branch))
  handle('draw:read', (_event, worktreePath: string, relPath: string) => readDrawing(worktreePath, relPath))
  handle('draw:apply', (_event, worktreePath: string, relPath: string, delta: DrawDelta) =>
    applyDelta(worktreePath, relPath, delta)
  )
  handle('draw:create', (_event, worktreePath: string, name: string, scope?: DrawScope, branch?: string) =>
    createDrawing(worktreePath, name, scope, branch)
  )
  handle('draw:promote', (_event, worktreePath: string, relPath: string, branch?: string) =>
    promoteDrawing(worktreePath, relPath, branch)
  )
  handle('draw:watch', (event, worktreePath: string) => watchDraw(event.sender, worktreePath))
  // A drawing is a portable file — this is how it gets out of Floe and into
  // excalidraw.com or another tool.
  handle('draw:reveal', (_event, worktreePath: string, relPath: string) =>
    shell.showItemInFolder(join(worktreePath, relPath))
  )

  handle('plans:implementPhases', (_event, worktreePath: string, branch?: string) =>
    readImplementPhases(worktreePath, branch)
  )
}

// The colony board.
export function registerColonyIpc(): void {
  // `colony:board` is the only read — the panel repaints from one shape, so a
  // card and the column counting it can never disagree.
  handle('colony:board', (_event, project: string) => boardFor(project))
  handle('colony:add', (event, task: NewTask) => {
    const created = addTask(task)
    pushBoard(BrowserWindow.fromWebContents(event.sender) ?? undefined, task.project)
    return created
  })
  // Releasing cuts the worktree, which is why this one is async and `add` is not:
  // a backlog card costs nothing until somebody starts it.
  handle('colony:release', async (event, id: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('No window to run the lane in.')
    const task = await releaseTask(win, id)
    pushBoard(win, task.project)
    return task
  })
  handle('colony:remove', (event, id: string, project: string) => {
    removeTask(id)
    pushBoard(BrowserWindow.fromWebContents(event.sender) ?? undefined, project)
  })
  handle('colony:nanny', (_event, project: string) => ({
    ...nannyFor(project),
    // The renderer sends it as the chat's opening message rather than main
    // firing a turn here: a fresh nanny must not start talking to a panel that
    // is not on screen yet.
    opener: nannyOpener(project)
  }))
}

// Live PTYs: terminals and command runs.
export function registerTerminalIpc(): void {
  handle('terminal:write', (_event, id: string, data: string) => writeTerminal(id, data))
  handle('terminal:resize', (_event, id: string, cols: number, rows: number) =>
    resizeTerminal(id, cols, rows)
  )
  handle('terminal:kill', (_event, id: string) => killTerminal(id))
  handle('terminal:list', (_event, worktreePath: string) => listLiveTerminals(worktreePath))
  // The renderer owns the resolved appearance (themeMode pref + the BROWSER's
  // prefers-color-scheme on web — the host OS knows nothing about the viewer's
  // theme), so it tells us when it flips and we fan the standard color-scheme
  // report out to every shell that subscribed via DECSET 2031.
  handle('terminal:notifyTheme', (_event, dark: boolean) => notifyTerminalsTheme(dark))

  handle(
    'command:start',
    (
      event,
      key: string,
      cwd: string,
      branch: string,
      command: string,
      cols: number,
      rows: number,
      watch?: string[],
      autoRestart?: boolean
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win) startCommand(win, key, cwd, branch, command, cols, rows, watch, autoRestart)
    }
  )
  handle('command:stop', (event, key: string) =>
    stopCommand(BrowserWindow.fromWebContents(event.sender) ?? undefined, key)
  )
  handle(
    'command:restart',
    (
      event,
      key: string,
      cwd: string,
      branch: string,
      command: string,
      cols: number,
      rows: number,
      watch?: string[],
      autoRestart?: boolean
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win) restartCommand(win, key, cwd, branch, command, cols, rows, watch, autoRestart)
    }
  )
  // What main is tracking, for a renderer that just loaded and knows nothing.
  handle('command:runs', () => commandRuns())
  handle('command:attach', (event, key: string, cols: number, rows: number) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) attachCommand(win, key, cols, rows)
  })
  handle('command:resize', (_event, key: string, cols: number, rows: number) =>
    resizeCommand(key, cols, rows)
  )
}

// Worktrees: list, create, provision, merge, remove.
export function registerWorktreeIpc(): void {
  handle('worktrees:list', (event, repoPath: string) => listWorktreesFor(winOf(event), repoPath))
  // The sidebar's git dirt, asked for AFTER the list is on screen so a slow
  // `git status` never delays landing on a session. One call for the whole
  // project; the worktrees run in parallel.
  handle('worktrees:status', (_event, paths: string[]) => worktreeStatuses(paths))
  handle('branches:list', (_event, repoPath: string) => listBranches(repoPath))
  handle('branches:listRemote', (_event, repoPath: string) => listRemoteBranches(repoPath))
  handle('worktrees:create', (_event, root: string, branch: string, options: CreateWorktreeOptions) =>
    createWorktree(root, branch, options)
  )
  handle('worktrees:remove', (_event, root: string, target: string) => removeWorktree(root, target))
  handle('worktrees:reorder', (_event, root: string, orderedPaths: string[]) =>
    reorderWorktrees(root, orderedPaths)
  )
  handle('worktrees:setBlocked', (_event, root: string, target: string, blocked: boolean) =>
    setWorktreeBlocked(root, target, blocked)
  )
  handle('worktrees:merge', (_event, root: string, target: string) => mergeWorktree(root, target))

  // Setup checklist: run the per-stack provisioning for a freshly created
  // worktree, streaming progress back as `provision:event`.
  handle(
    'provision:run',
    (event, root: string, worktreePath: string, branch: string, opts?: { from?: string; skip?: string[] }) => {
      const win = winOf(event)
      if (win) void provisionWorktree(win, root, worktreePath, branch, opts)
    }
  )
  // Bring a container-mode worktree up (idempotent, no-op for host-native
  // projects). Fire-and-forget — the renderer doesn't wait.
  handle('provision:ensureUp', (_event, root: string, worktreePath: string, branch: string) => {
    void ensureContainerUp(root, worktreePath, branch).catch((e) => console.error('[provision:ensureUp]', errorText(e)))
  })

  // Guided merge — granular steps the renderer orchestrates with the panel.
  handle('merge:preflight', (_event, root: string, target: string) => mergePreflight(root, target))
  handle('merge:stash', (_event, target: string) => mergeStash(target))
  handle('merge:base', (_event, target: string, base: string) => mergeBase(target, base))
  handle('merge:resolveCheck', (_event, target: string) => mergeResolveCheck(target))
  handle('merge:commit', (_event, target: string) => mergeCommit(target))
  handle('merge:ff', (_event, root: string, base: string, branch: string) =>
    mergeFastForward(root, base, branch)
  )
  // Stop every process tied to a worktree (commands, dev server, terminals) and
  // remove the worktree. Agent sessions are stopped by the renderer beforehand.
  handle('worktree:teardown', (_event, root: string, target: string) => {
    stopWorktreeProcesses(target)
    return removeWorktree(root, target)
  })

  // Guided remove — granular steps the renderer orchestrates with the panel.
  handle('remove:preflight', (_event, root: string, target: string) => removePreflight(root, target))
  handle('remove:worktree', (_event, root: string, target: string, force: boolean) => {
    stopWorktreeProcesses(target)
    return removeWorktreeGuided(root, target, force)
  })
  handle('remove:branch', (_event, root: string, branch: string, force: boolean) =>
    deleteBranch(root, branch, force)
  )
  // Undo the `herd link` the Laravel recipe made. Runs while the directory is
  // still there — `herd unlink` reads the site from the cwd it is called in.
  handle('remove:unlinkSite', (_event, target: string) => unlinkSite(target))
  // Drop the worktree's per-branch database (MySQL/MariaDB/Postgres). Reads the
  // worktree's .env, so the renderer runs this step before the worktree is torn
  // down. Never touches the main checkout's database.
  handle('remove:dropDatabase', (_event, root: string, target: string) => dropDatabase(root, target))
}

// The window itself: capture, focus, notifications, external links.
export function registerWindowIpc(): void {
  // Dev aid: let the renderer ask for a fresh screenshot (e.g. when an overlay opens).
  handle('window:capture', (event) => {
    const win = winOf(event)
    if (win) void captureWindow(win)
  })
  handle('open:external', (_event, url: string) => openExternalUrl(url))
  // Fire a native OS notification (the renderer decides when, and owns the
  // session metadata).
  handle('notify:show', (event, payload: NotifyPayload) => showNotification(winOf(event), payload))
  // Bring this window forward. Returns whether a window was actually raised.
  handle('window:focus', (event) => raiseWindow(winOf(event)))
  // Send Floe to the background — mirrors the native ⌘H (role: 'hide') so the
  // command palette can do it too. A notification click brings it back.
  handle('window:hide', (event) => hideWindow(winOf(event)))
}

// Keybindings, skills, config and the settings panel.
export function registerSettingsIpc(): void {
  // The whole keymap, read from ~/.config/floe/keybindings.toml — which the app
  // generates with every default written out, so the file is the keymap rather
  // than a list of overrides on top of one. `reveal` opens it for editing
  // (keyboard-first: routed from the "Edit keybindings" command) and `rebind`
  // is what the command palette's rebind writes through.
  handle('keybindings:load', () => loadKeybindings())
  handle('keybindings:reveal', () => revealKeybindings())
  handle('keybindings:rebind', (_event, command: string, chord: string) =>
    rebindCommand(command, chord)
  )
  // Regenerate the file from the built-in table, keeping the old one as .bak.
  // The way out when an update ships a binding an existing file has no entry for.
  handle('keybindings:reset', () => resetKeybindings())

  // Settings. The panel reads and writes the same `floe.toml` the user edits by
  // hand — `set` goes through the surgical writer, so a toggle flipped in the UI
  // comes back as one changed value in a file whose comments are all still there.
  // Skills the composer's `/` menu and the skills palette read. Scoped to the
  // worktree's project, so a project skill only shows up where it applies.
  handle('skills:list', (_event, worktreePath?: string) => listSkills(projectScope(worktreePath)))
  // What the Skills panel writes through. A skill is addressed by NAME, never by
  // a path from the renderer: the name is what the row shows and what `/name`
  // sends, and resolving it here is what keeps the UI unable to write anywhere
  // but the two skills directories. Refusals throw, so the panel can say why.
  handle('skills:create', (_event, name: string, scope: 'global' | 'project', worktreePath?: string) =>
    createSkill(name, scope, projectScope(worktreePath))
  )
  handle('skills:rename', (_event, name: string, to: string, worktreePath?: string) =>
    renameSkill(name, to, projectScope(worktreePath))
  )
  handle('skills:delete', (_event, name: string, worktreePath?: string) =>
    deleteSkill(name, projectScope(worktreePath))
  )
  handle('config:get', () => floeConfig())
  handle('config:set', (_event, table: string, key: string, value: TomlValue) =>
    setConfigValue(table, key, value)
  )
  // Every problem across every config file, so Settings has one place to show
  // them instead of each file failing quietly on its own.
  handle('config:errors', () => configErrors())
  handle('config:paths', () => configPaths())
  handle('config:reveal', (_event, path?: string) => shell.openPath(path ?? configPaths().floe))

  // Whether the OS is currently in dark mode. The renderer reads this once at
  // mount for the initial xterm palette.
  handle('theme:get', () => nativeTheme.shouldUseDarkColors)

  // Translucent (vibrancy) window appearance. The renderer reads `get` at mount
  // to set the matching [data-vibrancy] CSS state, and calls `set` from the
  // "Toggle transparency" command to flip it live and persist the choice.
  handle('window:getVibrancy', () => getVibrancy())
  handle('window:setVibrancy', (event, on: boolean) => toggleVibrancy(winOf(event), on))

  // Open-at-login (Settings → General → Launch at login). Backed by the OS login
  // items list, so it survives reinstalls and shows up in System Settings.
  handle('app:getLoginItem', () => app.getLoginItemSettings().openAtLogin)
  handle('app:setLoginItem', (_event, on: boolean) => {
    app.setLoginItemSettings({ openAtLogin: on })
  })

  // Settings → Advanced/Integrations read-only detection: the Claude CLI binary +
  // version. Best-effort; anything missing comes back null so the UI shows a
  // "not detected" state.
  handle('user:name', () => userDisplayName())
  handle('settings:probe', () => probeClaudeBinary())

  // Settings → Advanced: system prompt appended to every spawned Claude session
  // (agent.ts reads it directly at spawn time — this is just the read/write UI seam).
  handle('settings:getSystemPrompt', () => getSystemPrompt())
  handle('settings:setSystemPrompt', (_event, value: string) => setSystemPrompt(value))
}

// Drive live light/dark switches from the main process. The renderer's
// `matchMedia('(prefers-color-scheme: dark)')` `change` event is unreliable in
// Electron on macOS — it misses OS-driven appearance changes (e.g. the "Auto"
// schedule at sunrise/sunset). `nativeTheme` catches them, so we broadcast.
export function watchThemeChanges(): void {
  nativeTheme.on('updated', () => broadcastTheme())
}

/** Tell every live window the OS appearance changed, and re-assert its fill. */
export function broadcastTheme(): void {
  const vibrancy = getVibrancy()
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send('theme:changed', nativeTheme.shouldUseDarkColors)
    // Re-assert the fill for the new appearance. With the preference on this is
    // a no-op (the window stays non-opaque and the CSS body toggles the blur);
    // with it off it just refreshes the solid color to the new theme's --bg.
    applyVibrancy(win, vibrancy)
  }
}

// Hot-reload the whole config directory. Saving keybindings.toml, editing a
// project's config.toml by hand, or an agent adding a command all land here:
// the caches are dropped and the renderer re-fetches, with no app restart.
let stopConfigWatch: (() => void) | null = null

export function watchConfigReload(): void {
  stopConfigWatch?.()
  stopConfigWatch = watchConfig((file) => onConfigChanged(file))
}

/** Close it — the one long-lived OS handle registerIpc opens. */
export function stopConfigWatcher(): void {
  stopConfigWatch?.()
  stopConfigWatch = null
}

// One channel for the keymap and one for everything else, because reloading
// bindings is cheap and constant while re-reading projects touches the
// sidebar — telling them apart keeps a keybinding save from repainting the app.
export function onConfigChanged(file: string): void {
  setSandboxEnabled(floeConfig().sandbox.enabled)
  const keymap = file.endsWith('keybindings.toml')
  if (!keymap) reconcileBoards()
  broadcastConfigChange(keymap)
}

// A board is its config file, so editing one is a move on the board: raising a
// cap frees a spot, and nothing else would notice. The stages are read fresh on
// every tick, so this only has to say "look again".
export function reconcileBoards(): void {
  const win = localWindow ?? BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return
  for (const project of projectScan().projects) {
    tick(win, project.path)
    pushBoard(win, project.path)
  }
}

/** Zoom is re-applied on every non-keymap reload; the keymap save is cheap. */
export function broadcastConfigChange(keymap: boolean): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    if (!keymap) applyZoom(win)
    win.webContents.send(keymap ? 'keybindings:changed' : 'config:changed')
  }
}


// Dev aid: save a screenshot of our own window so it can be inspected while
// iterating on the layout. Captures on load and whenever the window is focused.
// Skipped while vibrancy is on: capturePage() forces an opaque raster of the web
// layer, which on macOS knocks out the live blur (the window goes solid a beat
// after load or after switching apps) — the classic "vibrancy stops working"
// symptom. The dev screenshot isn't worth losing the effect.
export async function captureWindow(win: BrowserWindow): Promise<void> {
  if (app.isPackaged) return
  if (process.platform === 'darwin' && getVibrancy()) return
  try {
    const image = await win.webContents.capturePage()
    writeFileSync(join(app.getPath('userData'), 'floe-shot.png'), image.toPNG())
  } catch {
    /* ignore capture failures */
  }
}

// The opaque window background for the current OS appearance — mirrors --bg in
// index.css for each theme.
const solidBg = (): string => (nativeTheme.shouldUseDarkColors ? '#131315' : '#fcfdfe')

// Toggle the translucent macOS vibrancy. The native blur view is created up
// front (see createWindow) so the NSWindow is non-opaque; here we just reveal or
// hide it. Two backings have to be cleared for the blur to actually show: the
// window's own fill AND the webContents backing — a transparent window over an
// opaque web layer still reads as solid (the web layer composites onto its own
// backing, not onto the vibrancy view behind it). So we clear the fill to
// '#00000000' whenever the preference is on and let the renderer's
// [data-vibrancy] surfaces clear (or keep) the web backing per appearance.
//
// Crucially this does NOT gate on the OS being dark. Glass is still a dark-only
// *look*, but that's enforced entirely in CSS (the tints are scoped to
// [data-theme='dark']; light keeps fully-opaque surfaces that cover the blur).
// Re-opaquing the window in light would relock it: a window constructed (or
// later set) opaque won't reliably flip back to non-opaque on macOS, so the next
// light→dark switch would leave the blur half-dead until an app restart. Keeping
// the window perpetually non-opaque while the preference is on means the dark
// glass can appear and disappear purely by the CSS body toggling transparent.
// No-op off macOS, where vibrancy isn't supported.
function applyVibrancy(win: BrowserWindow, on: boolean): void {
  if (process.platform !== 'darwin') return
  win.setBackgroundColor(on ? '#00000000' : solidBg())
}

// The (single) local-renderer window, when one is open. Attached windows don't
// count: they have no preload, so local IPC events (MCP, auto-update, stats)
// must land on this one. Kept to one — the local IPC layer assumes a single
// renderer driving the stores/PTYs.
let localWindow: BrowserWindow | null = null

// ⌘⇧N (Window → New Window): open a genuinely separate Floe *process* — a
// second, fully independent app with its own IPC/PTYs/stores — rather than a
// second window (the local IPC layer assumes a single renderer; see localWindow).
// macOS packaged: `open -n` the .app bundle (LaunchServices would otherwise reuse
// the running one). Everywhere else, relaunch the current argv detached.
function openNewInstance(): void {
  if (process.platform === 'darwin' && app.isPackaged) {
    const bundle = app.getPath('exe').replace(/\/Contents\/MacOS\/[^/]+$/, '')
    spawn('open', ['-n', bundle], { detached: true, stdio: 'ignore' }).unref()
    return
  }
  // Dev (electron argv[1] = app entry) and non-mac: re-run our own launch args.
  const args = app.isPackaged ? [] : process.argv.slice(1)
  spawn(process.execPath, args, { detached: true, stdio: 'ignore' }).unref()
}

/**
 * `[appearance] font-size`, applied as a window zoom.
 *
 * The stylesheet spells every size in px, so a CSS variable would scale nothing
 * short of rewriting the sheet in rem. Zoom scales the whole surface — text,
 * padding and rules together — which is what "font size" means in a terminal and
 * in every app shaped like this one. 13 is the baseline the sheet is written at,
 * so it is the 1.0 point.
 */
function applyZoom(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  win.webContents.setZoomFactor(floeConfig().appearance.fontSize / 13)
}

// The BrowserWindow shape: no chrome at all (the window is driven from the
// keyboard — ⌘W / ⌘M / ⌘Q still work through the app menu), and hidden until
// ready-to-show so there is no flash before the renderer paints.
export function windowOptions(darwin: boolean, vibrancyOn: boolean, cascade: number): Electron.BrowserWindowConstructorOptions {
  return {
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    // Cascade a second window slightly so it doesn't stack invisibly on the first.
    ...(cascade ? { x: 60 + cascade, y: 60 + cascade } : {}),
    show: false,
    // Match the OS appearance so there's no flash before the renderer paints.
    // With vibrancy on, start transparent so the blur shows immediately.
    backgroundColor: vibrancyOn ? '#00000000' : solidBg(),
    // Always wire up the vibrancy view on macOS — even when the preference is
    // off — so the NSWindow is created non-opaque and the blur can be toggled
    // live just by swapping the background fill. When off, the solid fill above
    // and the opaque [data-vibrancy='off'] surfaces keep it hidden.
    ...(darwin ? { vibrancy: 'fullscreen-ui' as const, visualEffectState: 'active' as const } : {}),
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // Enable Chromium's built-in PDF viewer (PDFium) so the file reader can
      // render PDFs inline in an <iframe>; off by default in Electron.
      plugins: true
    }
  }
}

// A boot that lands on a broken/half-written bundle (see autoUpdate.ts) shows up
// here first. Log it, and retry the load once before leaving a dead window.
export function attachReloadRetry(win: BrowserWindow): void {
  let reloadedOnce = false
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    console.error(`[window] load failed ${code} ${desc} ${url}`)
    if (!isMainFrame || reloadedOnce || code === -3) return // -3 = aborted (navigation superseded)
    reloadedOnce = true
    setTimeout(() => win.webContents.reload(), 500)
  })
}

// Right-click → native Copy/Paste. Electron ships no default context menu, so
// without this there's no mouse way to copy a message out of the transcript.
// Built from the click's own params, so only what applies shows up.
export function contextMenuItems(win: BrowserWindow, params: Electron.ContextMenuParams): Electron.MenuItemConstructorOptions[] {
  const items: Electron.MenuItemConstructorOptions[] = []
  if (params.linkURL) items.push({ label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) })
  // A screenshot in the transcript (or blown up in the lightbox) is a data URL,
  // so there is nothing to save a link to: copyImageAt lifts the decoded bitmap
  // straight off the page and onto the clipboard.
  if (params.mediaType === 'image') {
    items.push({ label: 'Copy Image', click: () => win.webContents.copyImageAt(params.x, params.y) })
  }
  if (params.selectionText) items.push({ role: 'copy' })
  if (params.isEditable) {
    if (params.selectionText) items.push({ role: 'cut' })
    items.push({ role: 'paste' }, { type: 'separator' }, { role: 'selectAll' })
  }
  return items
}

/** A click nothing applies to gets no menu at all, rather than an empty one. */
export function popupContextMenu(win: BrowserWindow, params: Electron.ContextMenuParams): void {
  const items = contextMenuItems(win, params)
  if (items.length) Menu.buildFromTemplate(items).popup({ window: win })
}

// Launching right after an update can catch the .app mid-copy: reads from a
// half-written app.asar come back as another file's bytes, so the window paints
// binary garbage (or some random chunk's source) instead of the UI — and only a
// couple of relaunches later, once the copy finished, does it work. Wait for
// index.html to read back intact before loading it.
export async function waitForBundle(indexFile: string, attempts = 20): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const html = await readFile(indexFile, 'utf8').catch(() => '')
    if (html.includes('<div id="root">')) return
    console.error(`[window] renderer index.html not readable yet (attempt ${attempt}) — bundle still being written?`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

// electron-vite injects ELECTRON_RENDERER_URL in dev; load the built file otherwise.
function loadRenderer(win: BrowserWindow): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
    return
  }
  const indexFile = join(__dirname, '../renderer/index.html')
  void waitForBundle(indexFile).then(() => {
    if (!win.isDestroyed()) win.loadFile(indexFile)
  })
}

function createWindow(): void {
  const darwin = process.platform === 'darwin'
  // Non-opaque whenever the glass preference is on — NOT gated on the launch
  // theme. Constructing opaque in light would relock the window so a later
  // light→dark switch couldn't reveal the blur without a restart. Light still
  // reads solid because its CSS surfaces are opaque and cover the blur.
  const vibrancyOn = darwin && getVibrancy()
  const cascade = BrowserWindow.getAllWindows().length * 28
  const mainWindow = new BrowserWindow(windowOptions(darwin, vibrancyOn, cascade))

  // Hide the macOS traffic-light buttons — the app is keyboard-first.
  if (darwin) mainWindow.setWindowButtonVisibility(false)

  mainWindow.on('ready-to-show', () => mainWindow.show())

  // Feed the topbar's memory widget. Claude usage is deliberately on-demand:
  // probing it starts a real `claude` process and can request Keychain access,
  // so opening a Floe window must not trigger it.
  localWindow = mainWindow
  // Re-apply the plugins' send mirror on a recreated window (see plugins/host.ts).
  pluginWindowCreated(mainWindow)
  startMemoryStats(mainWindow)
  mainWindow.on('closed', () => {
    if (localWindow === mainWindow) localWindow = null
    stopMemoryStats()
  })

  attachReloadRetry(mainWindow)

  mainWindow.webContents.on('did-finish-load', () => {
    applyZoom(mainWindow)
    setTimeout(() => void captureWindow(mainWindow), 400)
  })
  mainWindow.on('focus', () => {
    setTimeout(() => void captureWindow(mainWindow), 200)
  })

  mainWindow.webContents.on('context-menu', (_e, params) => popupContextMenu(mainWindow, params))

  // Open external links in the user's browser, not inside the app.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  loadRenderer(mainWindow)
}

isolateUserDataPerWorktree()

// Dev-only escape hatch for GUI verification: opt in with FLOE_CDP_PORT to
// expose Chromium's own debugger and keyboard-drive the app over CDP. Never on
// by default — it exposes the app's own privileged window.
if (!app.isPackaged && process.env.FLOE_CDP_PORT)
  app.commandLine.appendSwitch('remote-debugging-port', process.env.FLOE_CDP_PORT)

// The chat's video player loads `floe-media://…`. Registered before ready
// because that is the only moment Chromium accepts a new scheme's privileges,
// and it needs all three: fetch/stream so <video> can request byte ranges, and
// `secure` so a page served over http in dev may load it at all.
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true }
  }
])

void app.whenReady().then(async () => {
  fixPath()
  // Generate anything missing under ~/.config/floe before anything reads it, so
  // the user (and any agent) has the documented files in front of them on the
  // very first launch rather than after they go looking for a setting.
  initConfig()
  // sandbox.ts stays electron-free so its tests can load it directly, so the
  // setting is pushed in rather than read there.
  setSandboxEnabled(floeConfig().sandbox.enabled)
  // Kill any command groups orphaned by a previous unclean quit before we spawn anew.
  reapOrphanCommands()
  buildAppMenu(openNewInstance)
  protocol.handle(MEDIA_SCHEME, (req) => mediaResponse(req.url, req.headers.get('Range')))
  registerIpc()
  ensureAgentHookInstalled()
  // Runtime plugins from ~/.config/floe/plugins — loaded BEFORE the window so
  // the backends a plugin registers are already there when the preload asks
  // (backends:get runs at window load). A broken plugin logs and is skipped;
  // boot never dies for one.
  await loadPlugins(app.getVersion(), () => localWindow ?? BrowserWindow.getAllWindows()[0])
  createWindow()
  // The in-app MCP control server: agents drive Floe over /mcp/<token>. Lazy
  // window getter so ordering vs. createWindow doesn't matter.
  startMcpServer(() => localWindow ?? BrowserWindow.getAllWindows()[0])
  // Background auto-update: polls the GitHub release feed, installs on next quit.
  initAutoUpdate(() => localWindow ?? BrowserWindow.getAllWindows()[0])
  // Watchdog: log any turn that gets stuck "Thinking…" (never emits done) so a
  // 40-min hang can be diagnosed from <userData>/logs/agent.log after the fact.
  startAgentWatchdog()
  // A colony task that was mid-lane when the app went away has nobody left to
  // read its hand-off line. Put it back at its stage's door so the scheduler
  // runs it again — see reconcileColony.
  const colonyWin = localWindow ?? BrowserWindow.getAllWindows()[0]
  if (colonyWin) reconcileColony(colonyWin)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((err) => {
  // Any boot-step failure that slips past the guards above lands here instead of
  // silently dying with no window ("trava após update"). Log it and, if the app
  // came up windowless, still open one so the user isn't staring at nothing.
  log('boot:failed', { error: err instanceof Error ? err.stack ?? err.message : String(err) })
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

// Main-process crashes were invisible: no DiagnosticReport, nothing in agent.log.
// Log them so the next "quebrado após update" is diagnosable after the fact.
process.on('uncaughtException', (err) => log('main:uncaughtException', { error: err.stack ?? err.message }))
process.on('unhandledRejection', (reason) =>
  log('main:unhandledRejection', { error: reason instanceof Error ? reason.stack ?? reason.message : String(reason) })
)

app.on('window-all-closed', () => {
  killAllTerminals()
  killAllCommands()
  killAllMcpAuths()
  cancelLogin()
  if (process.platform !== 'darwin') app.quit()
})

// Confirm before quitting (⌘Q), then tear down every shell/command so nothing
// (dev servers, queues, watchers) is left running after the app exits.
//
// The prompt is for the INSTALLED app, where ⌘Q lands on a day's work by
// accident. A dev run is restarted every few minutes on purpose, and a dialog
// in the way of that is only ever an extra keystroke — so it asks nothing and
// tears down just the same.
let quitConfirmed = !app.isPackaged

app.on('before-quit', (event) => {
  if (quitConfirmed) {
    // Dev quits skip the dialog, not the cleanup: a PTY left behind outlives
    // the app either way.
    if (!app.isPackaged) stopEverything()
    return
  }
  event.preventDefault()
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const opts = {
    type: 'question' as const,
    buttons: ['Cancel', 'Quit'],
    defaultId: 1,
    cancelId: 0,
    message: 'Quit Floe?',
    detail: 'Running terminals and commands will be stopped.'
  }
  const choice = win ? dialog.showMessageBoxSync(win, opts) : dialog.showMessageBoxSync(opts)
  if (choice !== 1) return // cancelled — stay open
  quitConfirmed = true
  stopEverything()
  app.quit()
})

/** Everything spawned on this app's behalf, stopped. */
function stopEverything(): void {
  killAllTerminals()
  killAllCommands()
  killAllMcpAuths()
  cancelLogin()
  shutdownMcpServer()
  shutdownPlugins()
}
