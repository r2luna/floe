import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  dialog,
  Notification,
  nativeTheme,
  Menu,
  clipboard
} from 'electron'
import { join, basename } from 'path'
import { writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { userInfo } from 'node:os'
import { githubAuth } from './pr/github'
import { getJira, setJira, testJira } from './integrations'
import {
  addGroup,
  deleteGroup,
  addProject,
  addProjectByPath,
  homeWorktree,
  isHomePath,
  listGroups,
  listProjects,
  removeProject,
  renameGroup,
  renameProject,
  setProjectEnv,
  setProjectGroup,
  setProjectPinned,
  setProjectReadOnly
} from './projects'
import { setSharedDataDir } from './dataDir'
import {
  openBrowser,
  openBrowserFile,
  navigateBrowser,
  browserBack,
  browserForward,
  browserReload,
  browserDevtools,
  setBrowserBounds,
  setBrowserVisible,
  closeBrowser,
  startCdpRelay
} from './browserPane'
import { log } from './log'
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
import { sendToAgent, answerQuestion, respondPermission, stopAgent, isClaudeIdConnected, hasActiveTurn, startAgentWatchdog, replaySnapshot } from './agent'
import { codexModels, getCodexUsage } from './codex'
import { answerCodexQuestion } from './codexServer'
import { isCodexModel } from '../shared/types'
import { ensureAgentHookInstalled } from './hooks'
import { initScheduler, readSchedules } from './schedules'
import { initAutoUpdate } from './autoUpdate'
import { getSystemPrompt, setSystemPrompt } from './appSettings'
import { listClaudeSessions, listResumableSessions, loadClaudeTranscript, computeProjectActivity, readAiTitle, firstUserTitle, generateSessionTitle, generateWorktreeDesc, sessionHasUnansweredQuestion } from './claudeSessions'
import {
  setSessionTitle,
  getCreatedSession,
  applyAiTitle,
  setCreatedSessionMode,
  setCreatedSessionModel,
  setCreatedSessionEffort,
  addCreatedSession,
  normalizeSessionTitles,
  pruneMissingWorktrees,
  renameCreatedSession,
  linkCreatedSession,
  getCreatedSessionClaudeId,
  resumeSession,
  closeSession,
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
import { saveWorkflow, loadWorkflow, clearWorkflow, type PersistedWorkflow } from './workflowStore'
import { discoverSlashCommands } from './slashCommands'
import { getClaudeInfo, getContextUsage } from './claudeInfo'
import { sampleMemory, startMemoryStats, stopMemoryStats } from './systemStats'
import { refreshUsageNow, setUsageProbeCwd } from './usageMonitor'
import { startMcpAuth, cancelMcpAuth, pasteMcpAuth, killAllMcpAuths } from './mcpAuth'
import { authStatus, startLogin, pasteCode, cancelLogin, logout } from './claudeAuth'
import { claudeStats } from './claudeStats'
import { runRuntime } from './runtimes'
import { localAgents, localStats, localUsage } from './localAgents'
import { readRuntimeTranscript } from './runtimeLog'
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
import { setSandboxEnabled } from './sandbox'
import { floeConfig, setFloeValue } from './config/floe'
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
  reapOrphanCommands,
  runShellCapture
} from './commandRunner'
import { applyFileOps, listDir, readFileContent, resolveWikiLink, searchableFiles } from './files'
import { copyPlan, listPlans, readImplementPhases, readPlan, watchPlans } from './plans'
import { executeHttp, listHttpFiles, loadEnv, readHttp, watchHttp } from './http'
import { dbQuery, dbTables, watchDatabase } from './database'
import { tasksCloseForBranch, tasksList, tasksStatus } from './tasks'
import { addPrComment, approvePr, listPrs, mergePr, prFiles, prStatus } from './pr'
import {
  getJiraConnection,
  setJiraCreds,
  clearJiraCreds,
  getProjectKey,
  setProjectKey
} from './tasks/jiraConfig'
import { jiraTestCreds } from './tasks/jira'
import {
  getBitbucketConnection,
  setBitbucketCreds,
  clearBitbucketCreds
} from './pr/bitbucketConfig'
import { bitbucketTestCreds } from './pr/bitbucket'
import { watchChanges } from './reviewWatch'
import { provisionWorktree, dropWorktreeDatabase, ensureContainerUp, getAppUrl } from './provision'
import type { AgentRunOptions, Effort, FileAttachment, FileOp, ImageAttachment, JumpSession, NeedsYouSession, PermissionMode, ProjectActivity, ProjectEnvConfig, ThreadComment, Worktree } from '../shared/types'

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
async function refreshWorktreeDescs(win: BrowserWindow, repoPath: string, worktrees: Worktree[]): Promise<void> {
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

function registerIpc(): void {
  // One-shot: heal any colliding "Session N" titles left by older builds.
  normalizeSessionTitles()
  // One-shot: drop sessions/view state left behind by worktrees that are gone.
  pruneMissingWorktrees()
  ipcMain.handle('projects:list', () => listProjects())
  ipcMain.handle('projects:groups', () => listGroups())
  ipcMain.handle('projects:addGroup', (_event, name: string) => addGroup(name))
  ipcMain.handle('projects:deleteGroup', (_event, name: string) => deleteGroup(name))
  ipcMain.handle('projects:renameGroup', (_event, oldName: string, newName: string) =>
    renameGroup(oldName, newName)
  )
  ipcMain.handle('projects:rename', (_event, path: string, newName: string) =>
    renameProject(path, newName)
  )
  ipcMain.handle('projects:add', (_event, group?: string) => addProject(group))
  // Web/headless has no native folder picker — the renderer collects a path and adds it.
  ipcMain.handle('projects:addByPath', (_event, path: string, group?: string) =>
    addProjectByPath(path, group)
  )
  // Per-project containerized env (mode 'container' → Docker); null turns it off
  // (back to host-native provisioning). See provision.ts / compose.ts.
  ipcMain.handle('projects:setEnv', (_event, path: string, env: ProjectEnvConfig | null) =>
    setProjectEnv(path, env)
  )
  ipcMain.handle('projects:setGroup', (_event, path: string, group: string) => setProjectGroup(path, group))
  ipcMain.handle('projects:remove', (_event, path: string) => removeProject(path))
  ipcMain.handle('projects:setReadOnly', (_event, path: string, value: boolean) =>
    setProjectReadOnly(path, value)
  )
  ipcMain.handle('projects:setPinned', (_event, path: string, value: boolean) =>
    setProjectPinned(path, value)
  )

  // Projects rail: a cross-project activity snapshot for every project worked
  // today (sessions touched since midnight), each with a single status glyph.
  // Home isn't a git repo and read-only projects don't run sessions — both skip.
  ipcMain.handle('projects:activity', async () => {
    const out: ProjectActivity[] = []
    for (const project of listProjects()) {
      if (project.readOnly || project.home) continue
      let worktrees
      try {
        worktrees = await listWorktrees(project.path)
      } catch {
        continue // a moved/removed repo — just leave it off the rail
      }
      const activity = computeProjectActivity(worktrees.map((w) => w.path), isClaudeIdConnected)
      if (activity) out.push({ path: project.path, ...activity })
    }
    return out
  })

  // Every session, across ALL projects, currently blocked on an unanswered
  // question — feeds the ⌘/ switcher's "NEEDS YOU" list and the Home strip. Same
  // on-disk scan as projects:activity, but per-session and with the worktree's
  // diff stat attached. Only worktrees that actually have a waiting session pay
  // for the (cheap) `git diff --shortstat`.
  ipcMain.handle('sessions:needsYou', async () => {
    const out: NeedsYouSession[] = []
    for (const project of listProjects()) {
      if (project.readOnly || project.home) continue
      let worktrees
      try {
        worktrees = await listWorktrees(project.path)
      } catch {
        continue
      }
      for (const wt of worktrees) {
        const waiting = listClaudeSessions(wt.path).filter(
          (s) =>
            s.claudeId &&
            (s.active || isClaudeIdConnected(s.claudeId)) &&
            sessionHasUnansweredQuestion(wt.path, s.claudeId)
        )
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
  })

  // Every session on disk, across ALL projects — the ⌘J palette's index. Same
  // walk as sessions:needsYou, without the question filter or the diff stat, so
  // the palette can pull it on open instead of paying for a poll.
  ipcMain.handle('sessions:all', async () => {
    const out: JumpSession[] = []
    for (const project of listProjects()) {
      if (project.readOnly || project.home) continue
      let worktrees
      try {
        worktrees = await listWorktrees(project.path)
      } catch {
        continue
      }
      for (const wt of worktrees) {
        for (const s of listClaudeSessions(wt.path)) {
          out.push({
            projectPath: project.path,
            projectName: project.name,
            worktreePath: wt.path,
            branch: wt.branch,
            sessionId: s.id,
            title: s.title,
            lastActivityAt: s.mtime,
            running: !!s.claudeId && isClaudeIdConnected(s.claudeId)
          })
        }
      }
    }
    return out
  })

  // Rail visibility + the per-project hide list (both persisted in prefs).
  ipcMain.handle('rail:get', () => getRailVisible())
  ipcMain.handle('rail:set', (_event, on: boolean) => setRailVisible(on))
  ipcMain.handle('projects:getHidden', () => getHiddenProjects())
  ipcMain.handle('projects:setHidden', (_event, paths: string[]) => setHiddenProjects(paths))
  ipcMain.handle('codex:models', () => codexModels())

  ipcMain.handle(
    'agent:start',
    (
      event,
      key: string,
      worktreePath: string,
      prompt: string,
      options: AgentRunOptions,
      images: ImageAttachment[] = [],
      files: FileAttachment[] = []
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return
      // Anything but Claude runs on the machine's own runtime and answers over
      // the same agent:event channel. The provider is stated by the picker;
      // `isCodexModel` stays only as the fallback for a choice made before
      // providers existed (a persisted model with no provider beside it).
      const provider = options.provider ?? (isCodexModel(options.model) ? 'codex' : 'claude')
      if (provider !== 'claude') {
        void runRuntime(
          win,
          key,
          worktreePath,
          prompt,
          provider,
          options.model,
          options.effort,
          options.permissionMode
        )
        return
      }
      sendToAgent(win, key, worktreePath, prompt, options, images, files)
    }
  )
  // Composer `!` shell mode: run a one-shot command in the worktree and return
  // its output, which the renderer then hands to the agent as a prompt.
  ipcMain.handle('shell:run', (_event, worktreePath: string, command: string) =>
    runShellCapture(worktreePath, command)
  )
  ipcMain.handle('agent:answer', (_event, key: string, requestId: string, answer: string, answers?: string[][]) => {
    // Codex questions resolve over the app-server's JSON-RPC (per-question-id
    // answers); everything else is Claude's control channel.
    if (answerCodexQuestion(key, answers ?? [[answer]])) return
    answerQuestion(key, requestId, answer)
  })
  ipcMain.handle('agent:permission', (_event, key: string, requestId: string, allow: boolean) =>
    respondPermission(key, requestId, allow)
  )
  // What a panel opening mid-turn missed: the streamed events since turn start.
  ipcMain.handle('agent:replay', (_event, key: string) => replaySnapshot(key))
  ipcMain.handle('agent:stop', (event, key: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) stopAgent(win, key)
  })

  // The renderer's reply to a create_session command from the MCP server; resolves
  // the waiting tool with the new session id (or an error).


  ipcMain.handle('claude:sessions', (_event, worktreePath: string) =>
    listClaudeSessions(worktreePath).map((m) => ({ ...m, running: hasActiveTurn(m.id) }))
  )
  ipcMain.handle('claude:resumable', (_event, worktreePath: string) => listResumableSessions(worktreePath))
  ipcMain.handle('sessions:resume', (_event, s: { worktreePath: string; claudeId: string; title: string; mtime: number }) =>
    resumeSession(s)
  )
  // The JSONL is named after CLAUDE's session id, not Floe's. Callers pass
  // the Floe id, so resolve it here — one place, rather than making every
  // caller carry both ids.
  ipcMain.handle('claude:transcript', (_event, worktreePath: string, sessionId: string) => {
    const claude = loadClaudeTranscript(worktreePath, getCreatedSessionClaudeId(sessionId) ?? sessionId)
    const runtime = readRuntimeTranscript(sessionId)
    if (!runtime.length) return claude
    // A session can have talked to both — Claude's own file and our log for
    // whoever else answered. Merge on time so the conversation reads in the
    // order it happened rather than one source after the other.
    return [...claude, ...runtime].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
  })
  ipcMain.handle('sessions:setTitle', (_event, claudeId: string, title: string) => setSessionTitle(claudeId, title))
  ipcMain.handle('sessions:setMode', (_event, id: string, mode: PermissionMode) => setCreatedSessionMode(id, mode))
  ipcMain.handle('sessions:setModel', (_event, id: string, model: string) => setCreatedSessionModel(id, model))
  ipcMain.handle('sessions:setEffort', (_event, id: string, effort: Effort) => setCreatedSessionEffort(id, effort))
  ipcMain.handle('sessions:create', (_event, s: { id: string; worktreePath: string; title?: string }) =>
    addCreatedSession(s)
  )
  ipcMain.handle('sessions:renameCreated', (_event, id: string, title: string) => renameCreatedSession(id, title))
  // Give a session a short, smart title after a turn, unless manually renamed.
  // Interactive sessions get Claude's own ai-title; the headless runs Floe
  // drives have none, so we generate one with Haiku from the opening request —
  // but only while the title is still an auto placeholder ("Session N" or the raw
  // first-message fallback), so it's one Haiku call per session, not every turn.
  // Returns the new title so the renderer can update in place, else null.
  ipcMain.handle('sessions:adoptAiTitle', async (_event, id: string) => {
    const c = getCreatedSession(id)
    if (!c?.claudeId) return null
    const aiTitle = readAiTitle(c.worktreePath, c.claudeId)
    if (aiTitle) return applyAiTitle(c.claudeId, aiTitle) ? aiTitle : null
    const isPlaceholder = /^Session \d+$/.test(c.title) || c.title === firstUserTitle(c.worktreePath, c.claudeId)
    if (!isPlaceholder) return null
    const title = await generateSessionTitle(c.worktreePath, c.claudeId)
    return title && applyAiTitle(c.claudeId, title) ? title : null
  })
  ipcMain.handle('sessions:link', (_event, id: string, claudeId: string) => linkCreatedSession(id, claudeId))
  ipcMain.handle('sessions:close', (_event, opts: { id: string; worktreePath: string; claudeId?: string }) =>
    closeSession(opts)
  )

  ipcMain.handle('viewState:get', () => getViewState())
  ipcMain.handle('viewState:setProjectWorktree', (_event, projectPath: string, worktreePath: string) =>
    setProjectWorktree(projectPath, worktreePath)
  )
  ipcMain.handle('viewState:setWorktreeView', (_event, worktreePath: string, view: WorktreeView) =>
    setWorktreeView(worktreePath, view)
  )
  ipcMain.handle('viewState:setWorktreeAgent', (_event, worktreePath: string, sessionId: string) =>
    setWorktreeAgent(worktreePath, sessionId)
  )
  ipcMain.handle('viewState:setProjectUi', (_event, projectPath: string, ui: ProjectUiState) =>
    setProjectUi(projectPath, ui)
  )
  ipcMain.handle('viewState:setWorktreeUi', (_event, worktreePath: string, ui: WorktreeUiState) =>
    setWorktreeUi(worktreePath, ui)
  )

  // Pipeline persistence — survive an app restart and reattach the trilho.
  ipcMain.handle('workflow:save', (_event, worktreePath: string, wf: PersistedWorkflow) =>
    saveWorkflow(worktreePath, wf)
  )
  ipcMain.handle('workflow:load', (_event, worktreePath: string) => loadWorkflow(worktreePath))
  ipcMain.handle('workflow:clear', (_event, worktreePath: string) => clearWorkflow(worktreePath))

  ipcMain.handle('slash:list', (_event, worktreePath: string) => discoverSlashCommands(worktreePath))
  ipcMain.handle('claude:info', async (_event, worktreePath: string) => {
    const [info, codexUsage] = await Promise.all([getClaudeInfo(worktreePath), getCodexUsage()])
    return { ...info, codexUsage }
  })
  ipcMain.handle('claude:contextUsage', (_event, worktreePath: string, claudeId?: string) =>
    getContextUsage(worktreePath, claudeId)
  )
  // Topbar stats: usage refresh is the only pull; memory + usage are pushed.
  ipcMain.handle('stats:getMemory', () => sampleMemory())
  ipcMain.handle('stats:refreshUsage', () => refreshUsageNow())
  ipcMain.handle('stats:setUsageCwd', (_event, worktreePath: string) => setUsageProbeCwd(worktreePath))
  ipcMain.handle('mcp:auth:start', (event, worktreePath: string, serverName: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) startMcpAuth(win, worktreePath, serverName)
  })
  ipcMain.handle('mcp:auth:cancel', (_event, worktreePath: string, serverName: string) =>
    cancelMcpAuth(worktreePath, serverName)
  )
  ipcMain.handle('mcp:auth:paste', (_event, worktreePath: string, serverName: string, redirectUrl: string) =>
    pasteMcpAuth(worktreePath, serverName, redirectUrl)
  )

  // Signing in to the Claude account itself — see main/claudeAuth.ts.
  ipcMain.handle('claude:auth:status', () => authStatus())
  ipcMain.handle('claude:stats', () => claudeStats())
  // Every AI runtime this machine has, with the models each one can run.
  ipcMain.handle('agents:local', () => localAgents())
  // Separate from detection because this one spawns — only the account panel
  // asks, and only while it is open.
  ipcMain.handle('agents:usage', () => localUsage())
  ipcMain.handle('agents:stats', () => localStats())
  ipcMain.handle('claude:auth:login', (event, mode: 'claudeai' | 'console') => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) startLogin(win, mode)
  })
  ipcMain.handle('claude:auth:paste', (_event, code: string) => pasteCode(code))
  ipcMain.handle('claude:auth:cancel', () => cancelLogin())
  ipcMain.handle('claude:auth:logout', () => logout())

  ipcMain.handle('commands:list', (_event, projectPath: string, worktreePath: string) =>
    listCommands(projectPath, worktreePath)
  )
  ipcMain.handle(
    'commands:add',
    (_event, scope: CommandScope, projectPath: string, worktreePath: string, name: string, command: string) =>
      addCommand(scope, projectPath, worktreePath, name, command)
  )
  ipcMain.handle(
    'commands:update',
    (_event, projectPath: string, worktreePath: string, id: string, patch: CommandPatch) =>
      updateCommand(projectPath, worktreePath, id, patch)
  )
  ipcMain.handle('commands:remove', (_event, projectPath: string, worktreePath: string, id: string) =>
    removeCommand(projectPath, worktreePath, id)
  )
  ipcMain.handle(
    'commands:setScope',
    (_event, projectPath: string, worktreePath: string, id: string, scope: CommandScope) =>
      setCommandScope(projectPath, worktreePath, id, scope)
  )

  ipcMain.handle('schedules:list', (_event, projectPath: string) => readSchedules(projectPath))

  ipcMain.handle('dev:detect', (_event, worktreePath: string) => detectDevCommand(worktreePath))
  ipcMain.handle('dev:start', (event, worktreePath: string, branch: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win ? startDev(win, worktreePath, branch) : null
  })
  ipcMain.handle('dev:stop', (_event, worktreePath: string) => stopDev(worktreePath))

  ipcMain.handle(
    'terminal:open',
    (event, id: string, cwd: string, branch: string, cols: number, rows: number) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      return win ? openTerminal(win, id, cwd, branch, cols, rows) : null
    }
  )
  ipcMain.handle(
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
  ipcMain.handle('editor:launch', (_event, cwd: string, file: string, line?: number) =>
    launchEditor(cwd, file, line)
  )
  ipcMain.handle('files:list', (_event, worktreePath: string, relPath?: string) =>
    // The Home workspace's path is the user's home directory — not a git repo,
    // and it is terminal-only, with no file tree to fill. Hand back nothing.
    isHomePath(worktreePath) ? [] : listDir(worktreePath, relPath)
  )
  ipcMain.handle('files:all', (_event, worktreePath: string) =>
    // Same rule as the tree: Home is the user's home directory, not a repo.
    isHomePath(worktreePath) ? [] : searchableFiles(worktreePath)
  )
  ipcMain.handle('files:read', (_event, worktreePath: string, relPath: string) =>
    readFileContent(worktreePath, relPath)
  )
  ipcMain.handle(
    'files:resolveLink',
    (_event, worktreePath: string, fromRelPath: string, target: string) =>
      resolveWikiLink(worktreePath, fromRelPath, target)
  )
  ipcMain.handle('files:apply', (_event, worktreePath: string, ops: FileOp[]) =>
    applyFileOps(worktreePath, ops)
  )
  ipcMain.handle('review:changedFiles', (_event, worktreePath: string) => changedFiles(worktreePath))
  ipcMain.handle('review:lastCommit', (_event, worktreePath: string) => lastCommit(worktreePath))
  ipcMain.handle('review:fileDiff', (_event, worktreePath: string, relPath: string) => fileDiff(worktreePath, relPath))
  ipcMain.handle('review:commits', (_event, worktreePath: string) => reviewCommits(worktreePath))
  ipcMain.handle('review:commitDiff', (_event, worktreePath: string, hash: string, relPath: string) =>
    commitFileDiff(worktreePath, hash, relPath)
  )
  ipcMain.handle('review:clear', (_event, worktreePath: string) => clearReview(worktreePath))
  ipcMain.handle('review:restore', (_event, worktreePath: string) => restoreReview(worktreePath))
  ipcMain.handle('review:isCleared', (_event, worktreePath: string) => hasReviewCheckpoint(worktreePath))

  // Notes anchored to passages of a session's transcript.
  ipcMain.handle('threadComments:list', (_event, sessionKey: string) => getThreadComments(sessionKey))
  ipcMain.handle('threadComments:add', (_event, comment: ThreadComment) => addThreadComment(comment))
  ipcMain.handle('threadComments:remove', (_event, sessionKey: string, id: string) =>
    removeThreadComment(sessionKey, id)
  )
  ipcMain.handle('threadComments:markSent', (_event, sessionKey: string, ids: string[]) =>
    markThreadCommentsSent(sessionKey, ids)
  )
  ipcMain.handle('review:watch', (event, worktreePath: string) => watchChanges(event.sender, worktreePath))
  ipcMain.handle('plans:list', (_event, worktreePath: string, branch?: string) => listPlans(worktreePath, branch))
  ipcMain.handle('plans:read', (_event, worktreePath: string, relPath: string) => readPlan(worktreePath, relPath))
  ipcMain.handle('plans:watch', (event, worktreePath: string) => watchPlans(event.sender, worktreePath))
  ipcMain.handle('plans:copy', (_event, srcWorktreePath: string, relPath: string, destWorktreePath: string) =>
    copyPlan(srcWorktreePath, relPath, destWorktreePath)
  )
  ipcMain.handle('plans:implementPhases', (_event, worktreePath: string, branch?: string) =>
    readImplementPhases(worktreePath, branch)
  )
  ipcMain.handle('http:list', (_event, worktreePath: string) => listHttpFiles(worktreePath))
  ipcMain.handle('http:parse', (_event, worktreePath: string, relPath: string) => readHttp(worktreePath, relPath))
  ipcMain.handle('http:env', (_event, worktreePath: string, relPath?: string) => loadEnv(worktreePath, relPath))
  ipcMain.handle('http:execute', (_event, worktreePath: string, relPath: string, index: number, envName?: string) =>
    executeHttp(worktreePath, relPath, index, envName)
  )
  ipcMain.handle('http:watch', (event, worktreePath: string) => watchHttp(event.sender, worktreePath))

  // Database viewer — read-only: detect the connection + list tables, run a
  // single read-only query, watch .env/sqlite for changes.
  ipcMain.handle('db:tables', (_event, worktreePath: string) => dbTables(worktreePath))
  ipcMain.handle('db:query', (_event, worktreePath: string, sql: string, limit?: number) =>
    dbQuery(worktreePath, sql, limit)
  )
  ipcMain.handle('db:watch', (event, worktreePath: string) => watchDatabase(event.sender, worktreePath))

  // Tasks — external tracker work items (GitHub Issues today; provider-agnostic).
  ipcMain.handle('tasks:status', (_event, root: string) => tasksStatus(root))
  ipcMain.handle('tasks:list', (_event, root: string, opts: { state: 'open' | 'all' }) => tasksList(root, opts))
  // Merge flow: mark the worktree's linked Jira issue / GitHub issue done.
  ipcMain.handle('tasks:closeForBranch', (_event, root: string, branch: string) =>
    tasksCloseForBranch(root, branch)
  )
  // Jira connection + per-repo project key. The token is encrypted main-side and
  // never returned to the renderer; `jiraGetConnection` only reports identity.
  ipcMain.handle('tasks:jiraGetConnection', () => getJiraConnection())
  ipcMain.handle('tasks:jiraSetCreds', (_event, c: { site: string; email: string; token: string }) =>
    setJiraCreds(c)
  )
  ipcMain.handle('tasks:jiraClearCreds', () => clearJiraCreds())
  ipcMain.handle('tasks:jiraTestCreds', (_event, c: { site: string; email: string; token: string }) =>
    jiraTestCreds(c)
  )
  ipcMain.handle('tasks:getProjectKey', (_event, root: string) => getProjectKey(root))
  ipcMain.handle('tasks:setProjectKey', (_event, root: string, key: string) => setProjectKey(root, key))

  // Pull requests — GitHub PRs via the `gh` CLI. Repo-level, so keyed by project
  // root like tasks. `status` reports usability; `files` carries each file's diff.
  ipcMain.handle('pr:status', (_event, root: string) => prStatus(root))
  ipcMain.handle('pr:list', (_event, root: string) => listPrs(root))
  ipcMain.handle('pr:files', (_event, root: string, number: number) => prFiles(root, number))
  ipcMain.handle(
    'pr:addComment',
    (_event, root: string, number: number, c: { relPath: string; side: 'new' | 'old'; startLine: number; endLine: number; body: string }) =>
      addPrComment(root, number, c)
  )
  ipcMain.handle('pr:approve', (_event, root: string, number: number, body?: string) => approvePr(root, number, body))
  ipcMain.handle('pr:merge', (_event, root: string, number: number, method: 'merge' | 'squash' | 'rebase') =>
    mergePr(root, number, method)
  )
  // Bitbucket connection (global API token). Encrypted main-side and never
  // returned to the renderer; `getConnection` only reports the email.
  ipcMain.handle('pr:bitbucketGetConnection', () => getBitbucketConnection())
  ipcMain.handle('pr:bitbucketSetCreds', (_event, c: { email: string; token: string }) => setBitbucketCreds(c))
  ipcMain.handle('pr:bitbucketClearCreds', () => clearBitbucketCreds())
  ipcMain.handle('pr:bitbucketTestCreds', (_event, c: { email: string; token: string }) => bitbucketTestCreds(c))

  ipcMain.handle('terminal:write', (_event, id: string, data: string) => writeTerminal(id, data))
  ipcMain.handle('terminal:resize', (_event, id: string, cols: number, rows: number) =>
    resizeTerminal(id, cols, rows)
  )
  ipcMain.handle('terminal:kill', (_event, id: string) => killTerminal(id))
  ipcMain.handle('terminal:list', (_event, worktreePath: string) => listLiveTerminals(worktreePath))
  // The renderer owns the resolved appearance (themeMode pref + the BROWSER's
  // prefers-color-scheme on web — the host OS knows nothing about the viewer's
  // theme), so it tells us when it flips and we fan the standard color-scheme
  // report out to every shell that subscribed via DECSET 2031.
  ipcMain.handle('terminal:notifyTheme', (_event, dark: boolean) => notifyTerminalsTheme(dark))

  ipcMain.handle(
    'command:start',
    (event, key: string, cwd: string, branch: string, command: string, cols: number, rows: number, watch?: string[]) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win) startCommand(win, key, cwd, branch, command, cols, rows, watch)
    }
  )
  ipcMain.handle('command:stop', (_event, key: string) => stopCommand(key))
  ipcMain.handle(
    'command:restart',
    (event, key: string, cwd: string, branch: string, command: string, cols: number, rows: number, watch?: string[]) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win) restartCommand(win, key, cwd, branch, command, cols, rows, watch)
    }
  )
  ipcMain.handle('command:attach', (event, key: string, cols: number, rows: number) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) attachCommand(win, key, cols, rows)
  })
  ipcMain.handle('command:resize', (_event, key: string, cols: number, rows: number) =>
    resizeCommand(key, cols, rows)
  )

  ipcMain.handle('worktrees:list', async (event, repoPath: string) => {
    // The Home workspace isn't a git repo — hand back its single synthetic
    // worktree so the renderer can open a terminal in it like any worktree.
    if (isHomePath(repoPath)) return [homeWorktree()]
    const worktrees = await listWorktrees(repoPath)
    // Fire-and-forget: refresh AI descriptions for any worktree whose spec.md has
    // changed (or never had one). Returns immediately with the cached list; the
    // Haiku pass pushes an updated list once new descriptions land.
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) void refreshWorktreeDescs(win, repoPath, worktrees)
    return worktrees
  })
  ipcMain.handle('branches:list', (_event, repoPath: string) => listBranches(repoPath))
  ipcMain.handle('branches:listRemote', (_event, repoPath: string) => listRemoteBranches(repoPath))
  ipcMain.handle('worktrees:create', (_event, root: string, branch: string, options: CreateWorktreeOptions) =>
    createWorktree(root, branch, options)
  )
  ipcMain.handle('worktrees:remove', (_event, root: string, target: string) => removeWorktree(root, target))
  ipcMain.handle('worktrees:reorder', (_event, root: string, orderedPaths: string[]) =>
    reorderWorktrees(root, orderedPaths)
  )
  ipcMain.handle('worktrees:setBlocked', (_event, root: string, target: string, blocked: boolean) =>
    setWorktreeBlocked(root, target, blocked)
  )
  ipcMain.handle('worktrees:merge', (_event, root: string, target: string) => mergeWorktree(root, target))

  // Setup checklist: run the per-stack provisioning for a freshly created
  // worktree, streaming progress back as `provision:event`.
  ipcMain.handle(
    'provision:run',
    (event, root: string, worktreePath: string, branch: string, opts?: { from?: string; skip?: string[] }) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win) void provisionWorktree(win, root, worktreePath, branch, opts)
    }
  )
  // Bring a container-mode worktree up (idempotent, no-op for host-native
  // projects). Fire-and-forget — the renderer doesn't wait.
  ipcMain.handle('provision:ensureUp', (_event, root: string, worktreePath: string, branch: string) => {
    void ensureContainerUp(root, worktreePath, branch).catch((e) =>
      console.error('[provision:ensureUp]', e instanceof Error ? e.message : e)
    )
  })

  // Guided merge — granular steps the renderer orchestrates with the panel.
  ipcMain.handle('merge:preflight', (_event, root: string, target: string) => mergePreflight(root, target))
  ipcMain.handle('merge:stash', (_event, target: string) => mergeStash(target))
  ipcMain.handle('merge:base', (_event, target: string, base: string) => mergeBase(target, base))
  ipcMain.handle('merge:resolveCheck', (_event, target: string) => mergeResolveCheck(target))
  ipcMain.handle('merge:commit', (_event, target: string) => mergeCommit(target))
  ipcMain.handle('merge:ff', (_event, root: string, base: string, branch: string) =>
    mergeFastForward(root, base, branch)
  )
  // Stop every process tied to a worktree (commands, dev server, terminals) and
  // remove the worktree. Agent sessions are stopped by the renderer beforehand.
  ipcMain.handle('worktree:teardown', (_event, root: string, target: string) => {
    stopDev(target)
    killCommandsForWorktree(target)
    killTerminalsForWorktree(target)
    return removeWorktree(root, target)
  })

  // Guided remove — granular steps the renderer orchestrates with the panel.
  ipcMain.handle('remove:preflight', (_event, root: string, target: string) => removePreflight(root, target))
  ipcMain.handle('remove:worktree', (_event, root: string, target: string, force: boolean) => {
    stopDev(target)
    killCommandsForWorktree(target)
    killTerminalsForWorktree(target)
    return removeWorktreeGuided(root, target, force)
  })
  ipcMain.handle('remove:branch', (_event, root: string, branch: string, force: boolean) =>
    deleteBranch(root, branch, force)
  )
  // Drop the worktree's per-branch database (MySQL/MariaDB/Postgres). Reads the
  // worktree's .env, so the renderer runs this step before the worktree is torn
  // down. Never touches the main checkout's database.
  ipcMain.handle('remove:dropDatabase', async (_event, root: string, target: string) => {
    const lines: string[] = []
    try {
      const result = await dropWorktreeDatabase(target, root, (t) => lines.push(t))
      return { ok: true, dropped: result === 'dropped', detail: lines[lines.length - 1] }
    } catch (e) {
      return { ok: false, dropped: false, message: e instanceof Error ? e.message : String(e) }
    }
  })

  // Dev aid: let the renderer ask for a fresh screenshot (e.g. when an overlay opens).
  ipcMain.handle('window:capture', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) void captureWindow(win)
  })

  ipcMain.handle('open:external', (_event, url: string) => {
    // Authoritative allowlist — only safe schemes reach the OS shell.
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url)
  })

  // Fire a native OS notification (the renderer decides when, and owns the
  // session metadata). Clicking it surfaces Floe — even from behind other
  // apps or minimized — and tells the renderer which session to open.
  ipcMain.handle('notify:show', (event, payload: { title: string; body: string; sessionId: string }) => {
    if (!Notification.isSupported()) return
    const win = BrowserWindow.fromWebContents(event.sender)
    const note = new Notification({ title: payload.title, body: payload.body })
    note.on('click', () => {
      if (!win || win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      if (process.platform === 'darwin') app.focus({ steal: true })
      win.webContents.send('notification:click', payload.sessionId)
    })
    note.show()
  })

  // Bring this window forward. Returns whether a window was actually raised.
  ipcMain.handle('window:focus', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return false
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    if (process.platform === 'darwin') app.focus({ steal: true })
    return true
  })

  // Send Floe to the background — mirrors the native ⌘H (role: 'hide') so the
  // command palette can do it too. A notification click brings it back.
  ipcMain.handle('window:hide', (event) => {
    if (process.platform === 'darwin') return app.hide()
    BrowserWindow.fromWebContents(event.sender)?.hide()
  })

  // The whole keymap, read from ~/.config/floe/keybindings.toml — which the app
  // generates with every default written out, so the file is the keymap rather
  // than a list of overrides on top of one. `reveal` opens it for editing
  // (keyboard-first: routed from the "Edit keybindings" command) and `rebind`
  // is what the command palette's rebind writes through.
  ipcMain.handle('keybindings:load', () => loadKeybindings())
  ipcMain.handle('keybindings:reveal', () => revealKeybindings())
  ipcMain.handle('keybindings:rebind', (_event, command: string, chord: string) =>
    rebindCommand(command, chord)
  )
  // Regenerate the file from the built-in table, keeping the old one as .bak.
  // The way out when an update ships a binding an existing file has no entry for.
  ipcMain.handle('keybindings:reset', () => resetKeybindings())

  // Settings. The panel reads and writes the same `floe.toml` the user edits by
  // hand — `set` goes through the surgical writer, so a toggle flipped in the UI
  // comes back as one changed value in a file whose comments are all still there.
  ipcMain.handle('config:get', () => floeConfig())
  ipcMain.handle('config:set', (_event, table: string, key: string, value: TomlValue) => {
    setFloeValue(table, key, value)
    return floeConfig()
  })
  // Every problem across every config file, so Settings has one place to show
  // them instead of each file failing quietly on its own.
  ipcMain.handle('config:errors', () => configErrors())
  ipcMain.handle('config:paths', () => configPaths())
  ipcMain.handle('config:reveal', (_event, path?: string) => shell.openPath(path ?? configPaths().floe))

  // Whether the OS is currently in dark mode. The renderer reads this once at
  // mount for the initial xterm palette.
  ipcMain.handle('theme:get', () => nativeTheme.shouldUseDarkColors)

  // Translucent (vibrancy) window appearance. The renderer reads `get` at mount
  // to set the matching [data-vibrancy] CSS state, and calls `set` from the
  // "Toggle transparency" command to flip it live and persist the choice.
  ipcMain.handle('window:getVibrancy', () => getVibrancy())
  ipcMain.handle('window:setVibrancy', (event, on: boolean) => {
    setVibrancy(on)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) applyVibrancy(win, on)
  })

  // Embedded browser pane (WebContentsView over the renderer's browser area):
  // the view lives in THIS window.
  ipcMain.handle('browser:open', (event, url: string) => openBrowser(event, url))
  ipcMain.handle('browser:openFile', (event, absPath: string) => openBrowserFile(event, absPath))
  ipcMain.handle('browser:navigate', (event, url: string) => navigateBrowser(event, url))
  ipcMain.handle('browser:back', (event) => browserBack(event))
  ipcMain.handle('browser:forward', (event) => browserForward(event))
  ipcMain.handle('browser:reload', (event) => browserReload(event))
  ipcMain.handle('browser:devtools', (event) => browserDevtools(event))
  ipcMain.handle('browser:setBounds', (event, b: { x: number; y: number; width: number; height: number }) =>
    setBrowserBounds(event, b)
  )
  ipcMain.handle('browser:setVisible', (event, visible: boolean) => setBrowserVisible(event, visible))
  ipcMain.handle('browser:close', (event) => closeBrowser(event))
  ipcMain.handle('browser:defaultUrl', (_event, worktreePath: string) => getAppUrl(worktreePath))

  // Open-at-login (Settings → General → Launch at login). Backed by the OS login
  // items list, so it survives reinstalls and shows up in System Settings.
  ipcMain.handle('app:getLoginItem', () => app.getLoginItemSettings().openAtLogin)
  ipcMain.handle('app:setLoginItem', (_event, on: boolean) => {
    app.setLoginItemSettings({ openAtLogin: on })
  })

  // Settings → Advanced/Integrations read-only detection: the Claude CLI binary +
  // version and the current `gh` auth state. Best-effort; anything missing comes
  // back null so the UI shows a "not detected / not connected" state.
  // Who to greet on the launcher. `git config user.name` first — it's the name
  // the user already chose to be known by on this machine, and it's set on any
  // box that commits. `id -F` is the macOS full name; the login name is the
  // last resort because "r2luna" reads like a handle, not a greeting. Cached:
  // it can't change without a relaunch mattering, and the launcher asks on every
  // mount.
  let userName: string | null = null
  ipcMain.handle('user:name', async () => {
    if (userName !== null) return userName
    const pexec = promisify(execFile)
    const tryRun = async (cmd: string, args: string[]): Promise<string> => {
      try {
        return (await pexec(cmd, args)).stdout.trim()
      } catch {
        return ''
      }
    }
    const full =
      (await tryRun('git', ['config', '--global', 'user.name'])) ||
      (await tryRun('id', ['-F'])) ||
      userInfo().username
    // First name only: "Good evening, Rafael Lunardelli" reads like a form letter.
    userName = full.split(/\s+/)[0] ?? ''
    return userName
  })

  ipcMain.handle('settings:probe', async () => {
    const pexec = promisify(execFile)
    let claude: { path: string | null; version: string | null } = { path: null, version: null }
    try {
      const path = (await pexec('which', ['claude'])).stdout.trim() || null
      let version: string | null = null
      try {
        version = (await pexec('claude', ['--version'])).stdout.trim() || null
      } catch {
        version = null
      }
      claude = { path, version }
    } catch {
      claude = { path: null, version: null }
    }
    let github = { authed: false, user: null as string | null }
    try {
      github = await githubAuth()
    } catch {
      github = { authed: false, user: null }
    }
    return { claude, github }
  })

  // Settings → Advanced: system prompt appended to every spawned Claude session
  // (agent.ts reads it directly at spawn time — this is just the read/write UI seam).
  ipcMain.handle('settings:getSystemPrompt', () => getSystemPrompt())
  ipcMain.handle('settings:setSystemPrompt', (_event, value: string) => setSystemPrompt(value))

  // Settings → Integrations: Jira credential store (token encrypted at rest).
  ipcMain.handle('integrations:getJira', () => getJira())
  ipcMain.handle('integrations:setJira', (_event, input: { baseUrl: string; email: string; token?: string }) =>
    setJira(input)
  )
  ipcMain.handle('integrations:testJira', () => testJira())

  // Drive live light/dark switches from the main process. The renderer's
  // `matchMedia('(prefers-color-scheme: dark)')` `change` event is unreliable in
  // Electron on macOS — it misses OS-driven appearance changes (e.g. the "Auto"
  // schedule at sunrise/sunset). `nativeTheme` catches them, so we broadcast.
  nativeTheme.on('updated', () => {
    const vibrancy = getVibrancy()
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      win.webContents.send('theme:changed', nativeTheme.shouldUseDarkColors)
      // Re-assert the fill for the new appearance. With the preference on this is
      // a no-op (the window stays non-opaque and the CSS body toggles the blur);
      // with it off it just refreshes the solid color to the new theme's --bg.
      applyVibrancy(win, vibrancy)
    }
  })

  // Hot-reload the whole config directory. Saving keybindings.toml, editing a
  // project's config.toml by hand, or an agent adding a command all land here:
  // the caches are dropped and the renderer re-fetches, with no app restart.
  //
  // One channel for the keymap and one for everything else, because reloading
  // bindings is cheap and constant while re-reading projects touches the
  // sidebar — telling them apart keeps a keybinding save from repainting the app.
  watchConfig((file) => {
    setSandboxEnabled(floeConfig().sandbox.enabled)
    const keymap = file.endsWith('keybindings.toml')
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      if (!keymap) applyZoom(win)
      win.webContents.send(keymap ? 'keybindings:changed' : 'config:changed')
    }
  })
}

// Dev aid: save a screenshot of our own window so it can be inspected while
// iterating on the layout. Captures on load and whenever the window is focused.
// Skipped while vibrancy is on: capturePage() forces an opaque raster of the web
// layer, which on macOS knocks out the live blur (the window goes solid a beat
// after load or after switching apps) — the classic "vibrancy stops working"
// symptom. The dev screenshot isn't worth losing the effect.
async function captureWindow(win: BrowserWindow): Promise<void> {
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

function createWindow(): void {
  const darwin = process.platform === 'darwin'
  // Non-opaque whenever the glass preference is on — NOT gated on the launch
  // theme. Constructing opaque in light would relock the window so a later
  // light→dark switch couldn't reveal the blur without a restart. Light still
  // reads solid because its CSS surfaces are opaque and cover the blur.
  const vibrancyOn = darwin && getVibrancy()
  // Cascade a second window slightly so it doesn't stack invisibly on the first.
  const cascade = BrowserWindow.getAllWindows().length * 28
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
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
    // No chrome at all. The window is driven from the keyboard (⌘W / ⌘M / ⌘Q
    // still work through the app menu).
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // Enable Chromium's built-in PDF viewer (PDFium) so the file reader can
      // render PDFs inline in an <iframe>; off by default in Electron.
      plugins: true
    }
  })

  // Hide the macOS traffic-light buttons — the app is keyboard-first.
  if (process.platform === 'darwin') mainWindow.setWindowButtonVisibility(false)

  mainWindow.on('ready-to-show', () => mainWindow.show())

  // Feed the topbar's memory widget. Claude usage is deliberately on-demand:
  // probing it starts a real `claude` process and can request Keychain access,
  // so opening a Floe window must not trigger it.
  localWindow = mainWindow
  startMemoryStats(mainWindow)
  mainWindow.on('closed', () => {
    if (localWindow === mainWindow) localWindow = null
    stopMemoryStats()
  })

  // A boot that lands on a broken/half-written bundle (see autoUpdate.ts) shows
  // up here first. Log it, and retry the load once before leaving a dead window.
  let reloadedOnce = false
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    console.error(`[window] load failed ${code} ${desc} ${url}`)
    if (!isMainFrame || reloadedOnce || code === -3) return // -3 = aborted (navigation superseded)
    reloadedOnce = true
    setTimeout(() => mainWindow.webContents.reload(), 500)
  })

  mainWindow.webContents.on('did-finish-load', () => {
    applyZoom(mainWindow)
    setTimeout(() => void captureWindow(mainWindow), 400)
  })
  mainWindow.on('focus', () => {
    setTimeout(() => void captureWindow(mainWindow), 200)
  })

  // Right-click → native Copy/Paste. Electron ships no default context menu, so
  // without this there's no mouse way to copy a message out of the transcript.
  // Built from the click's own params, so only what applies shows up.
  mainWindow.webContents.on('context-menu', (_e, params) => {
    const items: Electron.MenuItemConstructorOptions[] = []
    if (params.linkURL) {
      items.push({ label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) })
    }
    if (params.selectionText) items.push({ role: 'copy' })
    if (params.isEditable) {
      if (params.selectionText) items.push({ role: 'cut' })
      items.push({ role: 'paste' }, { type: 'separator' }, { role: 'selectAll' })
    }
    if (!items.length) return
    Menu.buildFromTemplate(items).popup({ window: mainWindow })
  })

  // Open external links in the user's browser, not inside the app.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // electron-vite injects ELECTRON_RENDERER_URL in dev; load the built file otherwise.
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    // Launching right after an update can catch the .app mid-copy: reads from a
    // half-written app.asar come back as another file's bytes, so the window
    // paints binary garbage (or some random chunk's source) instead of the UI —
    // and only a couple of relaunches later, once the copy finished, does it
    // work. Wait for index.html to read back intact before loading it.
    const indexFile = join(__dirname, '../renderer/index.html')
    void (async () => {
      for (let attempt = 1; attempt <= 20; attempt++) {
        const html = await readFile(indexFile, 'utf8').catch(() => '')
        if (html.includes('<div id="root">')) break
        console.error(`[window] renderer index.html not readable yet (attempt ${attempt}) — bundle still being written?`)
        await new Promise((r) => setTimeout(r, 500))
      }
      if (!mainWindow.isDestroyed()) mainWindow.loadFile(indexFile)
    })()
  }
}

isolateUserDataPerWorktree()

// Dev-only escape hatch for GUI verification: opt in with FLOE_CDP_PORT to
// expose Chromium's own debugger and keyboard-drive the app over CDP. Never on
// by default (the scoped relay in browserPane is what Claude sessions get, so a
// session still can't reach this window).
if (!app.isPackaged && process.env.FLOE_CDP_PORT)
  app.commandLine.appendSwitch('remote-debugging-port', process.env.FLOE_CDP_PORT)

// "Claude drives the browser": each concurrently-running instance (⌘⇧N "New
// Window" is a genuinely separate process, see openNewInstance) needs its own
// CDP relay port — see browserPane.startCdpRelay for why this is a hand-built
// relay and not Chromium's own --remote-debugging-port switch (that would
// expose the app's own privileged window, not just the browser pane).
let cdpPort = 0

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
  registerIpc()
  ensureAgentHookInstalled()
  // Same lazy-getter pattern, for the cron-triggered scheduler (see schedules.ts).
  initScheduler(() => localWindow ?? BrowserWindow.getAllWindows()[0])
  // Start the scoped CDP relay so Claude sessions can drive the embedded browser
  // pane — never the app's own window. Non-critical: a port race (see
  // startCdpRelay) must never block the window, so guard it and carry on.
  try {
    cdpPort = await startCdpRelay(() => localWindow ?? BrowserWindow.getAllWindows()[0])
  } catch (err) {
    log('cdp:relay-failed', { error: err instanceof Error ? err.message : String(err) })
  }
  createWindow()
  // Background auto-update: polls the GitHub release feed, installs on next quit.
  initAutoUpdate(() => localWindow ?? BrowserWindow.getAllWindows()[0])
  // Watchdog: log any turn that gets stuck "Thinking…" (never emits done) so a
  // 40-min hang can be diagnosed from <userData>/logs/agent.log after the fact.
  startAgentWatchdog()

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
let quitConfirmed = false

app.on('before-quit', (event) => {
  if (quitConfirmed) return // confirmed pass — let the quit through
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
  killAllTerminals()
  killAllCommands()
  killAllMcpAuths()
  cancelLogin()
  app.quit()
})
