import type {
  CreateWorktreeOptions,
  MergeResult,
  MergePreflight,
  MergeBaseResult,
  MergeResolveCheck,
  MergeCommitResult,
  MergeFfResult,
  LastCommit
} from '../main/git'
import type { ClaudeSessionMeta, ResumableSession, TranscriptItem } from '../main/claudeSessions'
import type { ViewState, WorktreeView, ProjectUiState, WorktreeUiState } from '../main/sessionStore'
import type { PersistedWorkflow } from '../main/workflowStore'
import type { DevCommand, DevEvent } from '../main/devServer'
import type { ProjectCommand, CommandScope, CommandPatch } from '../main/commands'
import type { ScheduleEntry } from '../main/schedules'
import type { CommandEvent } from '../main/commandRunner'
import type { TerminalEvent } from '../main/terminal'
import type { KeybindingsConfig } from '../main/keybindings'
import type {
  AgentEventEnvelope,
  AgentReplay,
  AgentRunOptions,
  ChangedFile,
  ClaudeInfo,
  ContextUsage,
  CodexModel,
  DbResult,
  DbTablesResult,
  Effort,
  FileAttachment,
  FileContent,
  FileNode,
  HttpEnv,
  HttpFile,
  HttpRequest,
  HttpResponse,
  ImageAttachment,
  ImplementPhase,
  McpActivity,
  JumpSession,
  McpAuthEnvelope,
  AuthStatus,
  ClaudeAuthEvent,
  ClaudeStats,
  HarnessUsage,
  LocalAgent,
  McpCommand,
  McpCommandResult,
  MemoryStats,
  PermissionMode,
  NeedsYouSession,
  PlanFile,
  ThreadComment,
  PrFile,
  Project,
  ProjectActivity,
  ProjectEnvConfig,
  ProvisionEvent,
  PrStatus,
  PullRequest,
  RemoteBranch,
  DropDatabaseResult,
  FileOp,
  RemoveBranchResult,
  RemovePreflight,
  ReviewCommit,
  SlashCommand,
  Task,
  TaskCloseResult,
  TasksStatus,
  UsageStats,
  Worktree,
  WorktreesUpdatedEvent
} from '../shared/types'

// The bridge the renderer talks to.

// Injected by the host (preload = electron, web-bridge = browser stubs).
export type IpcRendererEvent = unknown
export interface IpcLike {
  // `any` on purpose: the transport is untyped (Electron IPC or WebSocket); the
  // typed contract lives in each api method's signature below.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  invoke(channel: string, ...args: any[]): Promise<any>
  on(channel: string, listener: (...a: any[]) => void): void
  removeListener(channel: string, listener: (...a: any[]) => void): void
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
export interface RookeryHost {
  platform: string
  version: string
  appVersion: string
  homeDir: string
  worktreeTag: string | null
}

// A machine this window can run work on: the local one plus every attached
// server. Which backend a workspace call rides is a per-project choice made in
// the renderer (see BackendsApi.use) — the rail is the union of all of them.
export interface BackendInfo {
  id: string // 'local', or the attach target ('ssh://link:41600', 'https://…')
  label: string // short name for the chip: the hostname
  homeDir: string
  remote: boolean
}

export interface BackendsApi {
  list(): BackendInfo[]
  // The backend every non-pinned call currently rides.
  current(): string
  use(id: string): void
  // Run one call against a NAMED backend regardless of `current`. The rail needs
  // each backend's own projects to build the union, and a fan-out like that can't
  // wait on switching `current` back and forth. Channel strings stay confined to
  // the renderer's backends helper — everything else goes through the typed api.
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  invoke(id: string, channel: string, ...args: any[]): Promise<any>
}

// Live state of the embedded browser pane, pushed on every navigation.
export interface BrowserPaneState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
}

// An app chord forwarded out of the native browser view (see browser:key).
export interface BrowserKey {
  key: string
  code: string
  meta: boolean
  control: boolean
  shift: boolean
  alt: boolean
}

// The bridge the renderer talks to. Identical shape for Electron IPC and WebSocket.
// `backends` is injected by the attached-mode preload (which owns one transport
// per machine); everywhere else there is exactly one backend — this one.
export function buildRookeryApi(ipcRenderer: IpcLike, host: RookeryHost, backends?: BackendsApi) {
  const api = {
    platform: host.platform,
    version: host.version,
    appVersion: host.appVersion,
    // The user's home directory — the cwd of the synthetic "Home" workspace the
    // app boots into. Read once here so the renderer can build the Home project
    // without a round-trip.
    homeDir: host.homeDir,
    capture: (): Promise<void> => ipcRenderer.invoke('window:capture'),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('open:external', url),
    hide: (): Promise<void> => ipcRenderer.invoke('window:hide'),
    // Bring THIS window forward. Pinned to the local machine (see PINNED_INVOKE),
    // so an attached window raises itself on the user's desk even when the command
    // came from a remote backend that has no window to raise (docs/fleet.md).
    // Resolves false when there's no window to raise (a plain browser tab).
    focus: (): Promise<boolean> => ipcRenderer.invoke('window:focus'),
    // Fires when the transport socket RE-connects (attached/web only): device
    // handoff, network blip, or server restart. While disconnected the live
    // event tail is missed, so the in-memory transcript is stale — the renderer
    // uses this to re-pull the active session and reconcile. Never fires in
    // local Electron (no socket, IPC never drops).
    onReconnect: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('transport:connected', listener)
      return () => ipcRenderer.removeListener('transport:connected', listener)
    },
    // Translucent (vibrancy) window appearance — macOS only. `get` is the snapshot
    // for the initial [data-vibrancy] CSS state; `set` flips it live and persists.
    vibrancy: {
      get: (): Promise<boolean> => ipcRenderer.invoke('window:getVibrancy'),
      set: (on: boolean): Promise<void> => ipcRenderer.invoke('window:setVibrancy', on)
    },
    // Attach this window to a remote Rookery server — the UI stays native, but
    // every workspace channel (projects, sessions, terminals, files) rides a
    // WebSocket to the server until "Detach from server" (⌘⌥D / palette / chip).
    // `getUrl` prefills the attach prompt with the last server used;
    // `getAttached` is the current target (null when running locally).
    // The machines this window can run on. Single-entry (this one) unless the
    // preload attached to remote backends.
    backends: backends ?? {
      list: (): BackendInfo[] => [
        { id: 'local', label: host.homeDir.split('/').pop() || 'local', homeDir: host.homeDir, remote: false }
      ],
      current: (): string => 'local',
      use: (): void => {},
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      invoke: (_id: string, channel: string, ...args: any[]): Promise<any> => ipcRenderer.invoke(channel, ...args)
    },
    server: {
      getUrl: (): Promise<string> => ipcRenderer.invoke('server:getUrl'),
      getAttached: (): Promise<string | null> => ipcRenderer.invoke('server:getAttached'),
      attach: (url: string): Promise<void> => ipcRenderer.invoke('server:attach', url),
      // No target = detach every backend; a target detaches just that one.
      detach: (target?: string): Promise<void> => ipcRenderer.invoke('server:detach', target),
      // Pulled once on mount: if boot-time attach fell back to local (SSH tunnel
      // failed) this returns a message to toast (then null), so the local project
      // list isn't silently mistaken for the server's.
      getAttachFallback: (): Promise<string | null> => ipcRenderer.invoke('server:getAttachFallback')
    },
    // Open Rookery at login — OS login-item list (Settings → General).
    loginItem: {
      get: (): Promise<boolean> => ipcRenderer.invoke('app:getLoginItem'),
      set: (on: boolean): Promise<void> => ipcRenderer.invoke('app:setLoginItem', on)
    },
    // Settings read-only detection (Claude CLI binary/version, gh auth state).
    settingsProbe: (): Promise<{
      claude: { path: string | null; version: string | null }
      github: { authed: boolean; user: string | null }
    }> => ipcRenderer.invoke('settings:probe'),
    // System prompt appended to every spawned Claude session (agent.ts, --append-system-prompt).
    getSystemPrompt: (): Promise<string> => ipcRenderer.invoke('settings:getSystemPrompt'),
    setSystemPrompt: (value: string): Promise<void> => ipcRenderer.invoke('settings:setSystemPrompt', value),
    // Jira integration — token encrypted at rest in the main process (safeStorage).
    // `get` never returns the token, only whether one is stored.
    jira: {
      get: (): Promise<{ baseUrl: string; email: string; hasToken: boolean }> =>
        ipcRenderer.invoke('integrations:getJira'),
      set: (input: { baseUrl: string; email: string; token?: string }): Promise<void> =>
        ipcRenderer.invoke('integrations:setJira', input),
      test: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('integrations:testJira')
    },
    notify: (payload: { title: string; body: string; sessionId: string }): Promise<void> =>
      ipcRenderer.invoke('notify:show', payload),
    onNotificationClick: (cb: (sessionId: string) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, sessionId: string): void => cb(sessionId)
      ipcRenderer.on('notification:click', listener)
      return () => ipcRenderer.removeListener('notification:click', listener)
    },
    // An auto-update has been downloaded and will install on next restart; the
    // payload carries the version that's waiting. Used to surface "vX available"
    // in the titlebar logo hover.
    onUpdateDownloaded: (cb: (version: string) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, payload: { version: string }): void => cb(payload.version)
      ipcRenderer.on('update:downloaded', listener)
      return () => ipcRenderer.removeListener('update:downloaded', listener)
    },
    // Relaunch into the downloaded update right now (quitAndInstall).
    installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install'),
    // OS light/dark appearance. `isDark` is the snapshot for the initial render;
    // `onChange` fires on every live switch (driven by nativeTheme in the main
    // process, which is more reliable than the renderer's matchMedia change event).
    theme: {
      isDark: (): Promise<boolean> => ipcRenderer.invoke('theme:get'),
      onChange: (cb: (isDark: boolean) => void): (() => void) => {
        const listener = (_event: IpcRendererEvent, isDark: boolean): void => cb(isDark)
        ipcRenderer.on('theme:changed', listener)
        return () => ipcRenderer.removeListener('theme:changed', listener)
      }
    },
    // User keybinding overrides. `load` returns the parsed config (overrides +
    // any parse errors); `reveal` opens the file to edit; `onChange` fires when
    // the file is saved so the renderer can hot-reload the merged keymap.
    keybindings: {
      load: (): Promise<KeybindingsConfig> => ipcRenderer.invoke('keybindings:load'),
      reveal: (): Promise<void> => ipcRenderer.invoke('keybindings:reveal'),
      onChange: (cb: () => void): (() => void) => {
        const listener = (): void => cb()
        ipcRenderer.on('keybindings:changed', listener)
        return () => ipcRenderer.removeListener('keybindings:changed', listener)
      }
    },
    projects: {
      list: (): Promise<Project[]> => ipcRenderer.invoke('projects:list'),
      groups: (): Promise<string[]> => ipcRenderer.invoke('projects:groups'),
      addGroup: (name: string): Promise<string[]> => ipcRenderer.invoke('projects:addGroup', name),
      renameGroup: (oldName: string, newName: string): Promise<{ groups: string[]; projects: Project[] }> =>
        ipcRenderer.invoke('projects:renameGroup', oldName, newName),
      rename: (path: string, newName: string): Promise<Project[]> =>
        ipcRenderer.invoke('projects:rename', path, newName),
      add: (group?: string): Promise<{ project?: Project; error?: string }> =>
        ipcRenderer.invoke('projects:add', group),
      // Web/headless has no native folder picker — add by an explicit server-side path.
      addByPath: (path: string, group?: string): Promise<{ project?: Project; error?: string }> =>
        ipcRenderer.invoke('projects:addByPath', path, group),
      // Set (or clear, with null) a project's containerized-env config.
      setEnv: (path: string, env: ProjectEnvConfig | null): Promise<Project[]> =>
        ipcRenderer.invoke('projects:setEnv', path, env),
      setGroup: (path: string, group: string): Promise<Project[]> =>
        ipcRenderer.invoke('projects:setGroup', path, group),
      remove: (path: string): Promise<Project[]> => ipcRenderer.invoke('projects:remove', path),
      setReadOnly: (path: string, value: boolean): Promise<Project[]> =>
        ipcRenderer.invoke('projects:setReadOnly', path, value),
      // Pin/unpin a project so it stays on the rail even with no activity today.
      setPinned: (path: string, value: boolean): Promise<Project[]> =>
        ipcRenderer.invoke('projects:setPinned', path, value),
      // Cross-project activity for the rail: one entry per project worked today.
      activity: (): Promise<ProjectActivity[]> => ipcRenderer.invoke('projects:activity'),
      // Every session, across all projects, blocked on an unanswered question.
      needsYou: (): Promise<NeedsYouSession[]> => ipcRenderer.invoke('sessions:needsYou'),
      // Every session on disk, across all projects — the ⌘J palette's index.
      allSessions: (): Promise<JumpSession[]> => ipcRenderer.invoke('sessions:all'),
      // Projects the user hid from the rail (by path).
      getHidden: (): Promise<string[]> => ipcRenderer.invoke('projects:getHidden'),
      setHidden: (paths: string[]): Promise<void> => ipcRenderer.invoke('projects:setHidden', paths)
    },
    // The projects rail (leftmost). `get` is the persisted visibility snapshot read
    // at mount; `set` records an explicit hide/show.
    rail: {
      get: (): Promise<boolean> => ipcRenderer.invoke('rail:get'),
      set: (on: boolean): Promise<void> => ipcRenderer.invoke('rail:set', on)
    },
    // Codex models offered in the picker, read from codex's own model cache.
    codex: {
      models: (): Promise<CodexModel[]> => ipcRenderer.invoke('codex:models')
    },
    worktrees: {
      list: (repoPath: string): Promise<Worktree[]> => ipcRenderer.invoke('worktrees:list', repoPath),
      branches: (repoPath: string): Promise<string[]> => ipcRenderer.invoke('branches:list', repoPath),
      remoteBranches: (repoPath: string): Promise<RemoteBranch[]> =>
        ipcRenderer.invoke('branches:listRemote', repoPath),
      create: (root: string, branch: string, options: CreateWorktreeOptions = {}): Promise<Worktree[]> =>
        ipcRenderer.invoke('worktrees:create', root, branch, options),
      remove: (root: string, target: string): Promise<Worktree[]> =>
        ipcRenderer.invoke('worktrees:remove', root, target),
      // Persist a drag-and-drop reorder; `orderedPaths` are the non-main worktree
      // paths in their new order. Returns the freshly-sorted list.
      reorder: (root: string, orderedPaths: string[]): Promise<Worktree[]> =>
        ipcRenderer.invoke('worktrees:reorder', root, orderedPaths),
      // Toggle whether this worktree is blocked from the guided merge. Returns the
      // freshly-listed worktrees.
      setBlocked: (root: string, target: string, blocked: boolean): Promise<Worktree[]> =>
        ipcRenderer.invoke('worktrees:setBlocked', root, target, blocked),
      merge: (root: string, target: string): Promise<MergeResult> =>
        ipcRenderer.invoke('worktrees:merge', root, target),
      // Stop the worktree's processes (commands, dev, terminals) and remove it.
      teardown: (root: string, target: string): Promise<Worktree[]> =>
        ipcRenderer.invoke('worktree:teardown', root, target),
      // Fired when a project's worktree set changes outside the UI flow (the MCP
      // create_worktree tool), so the sidebar can refresh list/count.
      onUpdated: (cb: (event: WorktreesUpdatedEvent) => void): (() => void) => {
        const listener = (_event: IpcRendererEvent, event: WorktreesUpdatedEvent): void => cb(event)
        ipcRenderer.on('worktrees:updated', listener)
        return () => ipcRenderer.removeListener('worktrees:updated', listener)
      }
    },
    // Guided merge — granular steps driven by the merge panel.
    merge: {
      preflight: (root: string, target: string): Promise<MergePreflight> =>
        ipcRenderer.invoke('merge:preflight', root, target),
      stash: (target: string): Promise<{ ok: boolean; message?: string }> =>
        ipcRenderer.invoke('merge:stash', target),
      base: (target: string, base: string): Promise<MergeBaseResult> =>
        ipcRenderer.invoke('merge:base', target, base),
      resolveCheck: (target: string): Promise<MergeResolveCheck> =>
        ipcRenderer.invoke('merge:resolveCheck', target),
      commit: (target: string): Promise<MergeCommitResult> => ipcRenderer.invoke('merge:commit', target),
      ff: (root: string, base: string, branch: string): Promise<MergeFfResult> =>
        ipcRenderer.invoke('merge:ff', root, base, branch)
    },
    // Guided remove — granular steps driven by the remove panel.
    remove: {
      preflight: (root: string, target: string): Promise<RemovePreflight> =>
        ipcRenderer.invoke('remove:preflight', root, target),
      worktree: (root: string, target: string, force: boolean): Promise<Worktree[]> =>
        ipcRenderer.invoke('remove:worktree', root, target, force),
      branch: (root: string, branch: string, force: boolean): Promise<RemoveBranchResult> =>
        ipcRenderer.invoke('remove:branch', root, branch, force),
      dropDatabase: (root: string, target: string): Promise<DropDatabaseResult> =>
        ipcRenderer.invoke('remove:dropDatabase', root, target)
    },
    provision: {
      run: (
        root: string,
        worktreePath: string,
        branch: string,
        opts?: { from?: string; skip?: string[] }
      ): Promise<void> => ipcRenderer.invoke('provision:run', root, worktreePath, branch, opts),
      // Bring a worktree's containerized env up (idempotent) without re-running the
      // full provision recipe — used when reopening a container-mode worktree.
      ensureUp: (root: string, worktreePath: string, branch: string): Promise<void> =>
        ipcRenderer.invoke('provision:ensureUp', root, worktreePath, branch),
      onEvent: (cb: (event: ProvisionEvent) => void): (() => void) => {
        const listener = (_event: IpcRendererEvent, event: ProvisionEvent): void => cb(event)
        ipcRenderer.on('provision:event', listener)
        return () => ipcRenderer.removeListener('provision:event', listener)
      }
    },
    agent: {
      start: (
        key: string,
        worktreePath: string,
        prompt: string,
        options: AgentRunOptions,
        images: ImageAttachment[] = [],
        files: FileAttachment[] = []
      ): Promise<void> => ipcRenderer.invoke('agent:start', key, worktreePath, prompt, options, images, files),
      answer: (key: string, toolUseId: string, answer: string, answers?: string[][]): Promise<void> =>
        ipcRenderer.invoke('agent:answer', key, toolUseId, answer, answers),
      permission: (key: string, requestId: string, allow: boolean): Promise<void> =>
        ipcRenderer.invoke('agent:permission', key, requestId, allow),
      stop: (key: string): Promise<void> => ipcRenderer.invoke('agent:stop', key),
      // The turn in flight, for a panel that mounts mid-turn (see AgentReplay).
      replay: (key: string): Promise<AgentReplay> => ipcRenderer.invoke('agent:replay', key),
      onEvent: (cb: (payload: AgentEventEnvelope) => void): (() => void) => {
        const listener = (_event: IpcRendererEvent, payload: AgentEventEnvelope): void => cb(payload)
        ipcRenderer.on('agent:event', listener)
        return () => ipcRenderer.removeListener('agent:event', listener)
      }
    },
    shell: {
      // Run `command` in the worktree and get back its combined output (`!` mode).
      run: (worktreePath: string, command: string): Promise<{ output: string; code: number }> =>
        ipcRenderer.invoke('shell:run', worktreePath, command)
    },
    claude: {
      sessions: (worktreePath: string): Promise<ClaudeSessionMeta[]> =>
        ipcRenderer.invoke('claude:sessions', worktreePath),
      resumable: (worktreePath: string): Promise<ResumableSession[]> =>
        ipcRenderer.invoke('claude:resumable', worktreePath),
      resume: (s: { worktreePath: string; claudeId: string; title: string; mtime: number }): Promise<string> =>
        ipcRenderer.invoke('sessions:resume', s),
      transcript: (worktreePath: string, sessionId: string): Promise<TranscriptItem[]> =>
        ipcRenderer.invoke('claude:transcript', worktreePath, sessionId),
      setTitle: (claudeId: string, title: string): Promise<void> =>
        ipcRenderer.invoke('sessions:setTitle', claudeId, title),
      setMode: (id: string, mode: PermissionMode): Promise<void> =>
        ipcRenderer.invoke('sessions:setMode', id, mode),
      setModel: (id: string, model: string): Promise<void> =>
        ipcRenderer.invoke('sessions:setModel', id, model),
      setEffort: (id: string, effort: Effort): Promise<void> =>
        ipcRenderer.invoke('sessions:setEffort', id, effort),
      createSession: (s: { id: string; worktreePath: string; title?: string }): Promise<string> =>
        ipcRenderer.invoke('sessions:create', s),
      renameCreated: (id: string, title: string): Promise<void> =>
        ipcRenderer.invoke('sessions:renameCreated', id, title),
      adoptAiTitle: (id: string): Promise<string | null> =>
        ipcRenderer.invoke('sessions:adoptAiTitle', id),
      linkSession: (id: string, claudeId: string): Promise<void> =>
        ipcRenderer.invoke('sessions:link', id, claudeId),
      closeSession: (opts: { id: string; worktreePath: string; claudeId?: string }): Promise<void> =>
        ipcRenderer.invoke('sessions:close', opts),
      // Probe Claude Code's built-in /usage, /mcp, /skills, /plugins for this worktree.
      info: (worktreePath: string): Promise<ClaudeInfo> => ipcRenderer.invoke('claude:info', worktreePath),
      contextUsage: (worktreePath: string, claudeId?: string): Promise<ContextUsage> =>
        ipcRenderer.invoke('claude:contextUsage', worktreePath, claudeId),
      // Start/cancel the OAuth flow for a "needs-auth" MCP server, and listen for
      // its progress (url opened → connected / timeout / error).
      authMcp: (worktreePath: string, serverName: string): Promise<void> =>
        ipcRenderer.invoke('mcp:auth:start', worktreePath, serverName),
      cancelMcpAuth: (worktreePath: string, serverName: string): Promise<void> =>
        ipcRenderer.invoke('mcp:auth:cancel', worktreePath, serverName),
      // Hand the provider's redirect (captured in the embedded browser) to the
      // waiting CLI — see main/mcpAuth.ts pasteMcpAuth.
      pasteMcpAuth: (worktreePath: string, serverName: string, redirectUrl: string): Promise<void> =>
        ipcRenderer.invoke('mcp:auth:paste', worktreePath, serverName, redirectUrl),
      onMcpAuthEvent: (cb: (payload: McpAuthEnvelope) => void): (() => void) => {
        const listener = (_event: IpcRendererEvent, payload: McpAuthEnvelope): void => cb(payload)
        ipcRenderer.on('mcp:auth:event', listener)
        return () => ipcRenderer.removeListener('mcp:auth:event', listener)
      },
      // Signing in to the Claude ACCOUNT — the CLI's own /login, not an MCP
      // server's. There is no loopback callback in this flow: the consent page
      // shows a code and `paste` hands it to the waiting CLI.
      authStatus: (): Promise<AuthStatus> => ipcRenderer.invoke('claude:auth:status'),
      // Lifetime stats for the account — the CLI's `/stats`, read from its cache.
      stats: (): Promise<ClaudeStats> => ipcRenderer.invoke('claude:stats'),
      // Other AI runtimes installed here — codex, gemini, LM Studio, Ollama…
      localAgents: (): Promise<LocalAgent[]> => ipcRenderer.invoke('agents:local'),
      // How much of each runtime's allowance is spent, keyed by runtime id.
      localUsage: (): Promise<Record<string, HarnessUsage>> => ipcRenderer.invoke('agents:usage'),
      // Lifetime history per runtime, in the same shape as Claude's own stats.
      localStats: (): Promise<Record<string, ClaudeStats>> => ipcRenderer.invoke('agents:stats'),
      login: (mode: 'claudeai' | 'console' = 'claudeai'): Promise<void> =>
        ipcRenderer.invoke('claude:auth:login', mode),
      pasteLoginCode: (code: string): Promise<void> => ipcRenderer.invoke('claude:auth:paste', code),
      cancelLogin: (): Promise<void> => ipcRenderer.invoke('claude:auth:cancel'),
      logout: (): Promise<void> => ipcRenderer.invoke('claude:auth:logout'),
      onAuthEvent: (cb: (event: ClaudeAuthEvent) => void): (() => void) => {
        const listener = (_event: IpcRendererEvent, payload: ClaudeAuthEvent): void => cb(payload)
        ipcRenderer.on('claude:auth:event', listener)
        return () => ipcRenderer.removeListener('claude:auth:event', listener)
      }
    },
    // Internal MCP control server (Claude drives Rookery from inside a session).
    // Tools that mutate state run in main; UI-driving tools are pushed here as a
    // `mcp:command`, and every tool fires an `mcp:activity` for the visible chip.
    // `create_session` is the only command that needs a reply, sent back over
    // `mcp:command-result` so the waiting tool learns the new session id.
    mcp: {
      onCommand: (cb: (command: McpCommand) => void): (() => void) => {
        const listener = (_event: IpcRendererEvent, command: McpCommand): void => cb(command)
        ipcRenderer.on('mcp:command', listener)
        return () => ipcRenderer.removeListener('mcp:command', listener)
      },
      onActivity: (cb: (activity: McpActivity) => void): (() => void) => {
        const listener = (_event: IpcRendererEvent, activity: McpActivity): void => cb(activity)
        ipcRenderer.on('mcp:activity', listener)
        return () => ipcRenderer.removeListener('mcp:activity', listener)
      },
      commandResult: (result: McpCommandResult): Promise<void> =>
        ipcRenderer.invoke('mcp:command-result', result),
      // Register Rookery's MCP server in the user's global Claude config so any
      // claude session (in-app or a plain terminal) gets the rookery tools.
      installGlobal: (): Promise<{ ok: boolean; message: string }> =>
        ipcRenderer.invoke('mcp:installGlobal'),
      // The Fleet dashboard's read token for THIS backend (docs/fleet.md). Not
      // pinned: when attached, the token you need is the remote one, because
      // that's the instance whose agents Fleet is reading.
      fleetToken: (): Promise<{ token: string; port: number }> => ipcRenderer.invoke('fleet:token')
    },
    // Embedded browser pane — a native WebContentsView the renderer positions
    // over its browser area. UI-kind (always this window); remote worktree app
    // ports are transparently SSH-forwarded by the main process when attached.
    browser: {
      open: (url: string): Promise<BrowserPaneState> => ipcRenderer.invoke('browser:open', url),
      // Render a local file (absolute path on whichever machine backs the
      // workspace) — file:// detached, the server's /rk-file over SSH attached.
      openFile: (absPath: string): Promise<BrowserPaneState> => ipcRenderer.invoke('browser:openFile', absPath),
      navigate: (url: string): Promise<void> => ipcRenderer.invoke('browser:navigate', url),
      back: (): Promise<void> => ipcRenderer.invoke('browser:back'),
      forward: (): Promise<void> => ipcRenderer.invoke('browser:forward'),
      reload: (): Promise<void> => ipcRenderer.invoke('browser:reload'),
      devtools: (): Promise<void> => ipcRenderer.invoke('browser:devtools'),
      setBounds: (b: { x: number; y: number; width: number; height: number }): Promise<void> =>
        ipcRenderer.invoke('browser:setBounds', b),
      setVisible: (visible: boolean): Promise<void> => ipcRenderer.invoke('browser:setVisible', visible),
      close: (): Promise<void> => ipcRenderer.invoke('browser:close'),
      // The worktree's own APP_URL from its .env, if any — not UI-kind, follows
      // the attach target since that's where the worktree's files actually live.
      defaultUrl: (worktreePath: string): Promise<string | null> =>
        ipcRenderer.invoke('browser:defaultUrl', worktreePath),
      onEvent: (cb: (state: BrowserPaneState) => void): (() => void) => {
        const listener = (_event: IpcRendererEvent, state: BrowserPaneState): void => cb(state)
        ipcRenderer.on('browser:event', listener)
        return () => ipcRenderer.removeListener('browser:event', listener)
      },
      // App chords the native page view would otherwise swallow (⌘Y, ⌘K, Esc, …),
      // forwarded from main so the renderer's global key handler can run.
      onKey: (cb: (k: BrowserKey) => void): (() => void) => {
        const listener = (_event: IpcRendererEvent, k: BrowserKey): void => cb(k)
        ipcRenderer.on('browser:key', listener)
        return () => ipcRenderer.removeListener('browser:key', listener)
      }
    },
    // Install the `rookery` shell CLI so `rookery .` opens a folder in the app.
    cli: {
      install: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('cli:install')
    },
    slash: {
      list: (worktreePath: string): Promise<SlashCommand[]> => ipcRenderer.invoke('slash:list', worktreePath)
    },
    // Pipeline persistence: save the runner's progress per worktree so a relaunch
    // can reattach the trilho at the right step.
    workflow: {
      save: (worktreePath: string, wf: PersistedWorkflow): Promise<void> =>
        ipcRenderer.invoke('workflow:save', worktreePath, wf),
      load: (worktreePath: string): Promise<PersistedWorkflow | null> =>
        ipcRenderer.invoke('workflow:load', worktreePath),
      clear: (worktreePath: string): Promise<void> => ipcRenderer.invoke('workflow:clear', worktreePath)
    },
    // Topbar memory is pushed every ~2s. Claude usage is only probed through an
    // explicit refresh; setUsageCwd chooses where that throwaway process runs.
    stats: {
      onMemory: (cb: (stats: MemoryStats) => void): (() => void) => {
        const listener = (_event: IpcRendererEvent, stats: MemoryStats): void => cb(stats)
        ipcRenderer.on('stats:memory', listener)
        return () => ipcRenderer.removeListener('stats:memory', listener)
      },
      onUsage: (cb: (stats: UsageStats) => void): (() => void) => {
        const listener = (_event: IpcRendererEvent, stats: UsageStats): void => cb(stats)
        ipcRenderer.on('stats:usage', listener)
        return () => ipcRenderer.removeListener('stats:usage', listener)
      },
      // Memory is only PUSHED on change, so a renderer that mounts mid-session
      // has nothing to show until the number moves — it pulls the current value.
      getMemory: (): Promise<MemoryStats> => ipcRenderer.invoke('stats:getMemory'),
      refreshUsage: (): Promise<UsageStats> => ipcRenderer.invoke('stats:refreshUsage'),
      setUsageCwd: (worktreePath: string): Promise<void> => ipcRenderer.invoke('stats:setUsageCwd', worktreePath)
    },
    // "Where I was" persistence: the last worktree per project and the last view
    // (session/terminal/command) per worktree, so a project switch — or a relaunch
    // — lands the user back on the same screen.
    viewState: {
      get: (): Promise<ViewState> => ipcRenderer.invoke('viewState:get'),
      setProjectWorktree: (projectPath: string, worktreePath: string): Promise<void> =>
        ipcRenderer.invoke('viewState:setProjectWorktree', projectPath, worktreePath),
      setWorktreeView: (worktreePath: string, view: WorktreeView): Promise<void> =>
        ipcRenderer.invoke('viewState:setWorktreeView', worktreePath, view),
      setWorktreeAgent: (worktreePath: string, sessionId: string): Promise<void> =>
        ipcRenderer.invoke('viewState:setWorktreeAgent', worktreePath, sessionId),
      setProjectUi: (projectPath: string, ui: ProjectUiState): Promise<void> =>
        ipcRenderer.invoke('viewState:setProjectUi', projectPath, ui),
      setWorktreeUi: (worktreePath: string, ui: WorktreeUiState): Promise<void> =>
        ipcRenderer.invoke('viewState:setWorktreeUi', worktreePath, ui)
    },
    commands: {
      list: (projectPath: string, worktreePath: string): Promise<ProjectCommand[]> =>
        ipcRenderer.invoke('commands:list', projectPath, worktreePath),
      add: (
        scope: CommandScope,
        projectPath: string,
        worktreePath: string,
        name: string,
        command: string
      ): Promise<ProjectCommand[]> =>
        ipcRenderer.invoke('commands:add', scope, projectPath, worktreePath, name, command),
      update: (projectPath: string, worktreePath: string, id: string, patch: CommandPatch): Promise<ProjectCommand[]> =>
        ipcRenderer.invoke('commands:update', projectPath, worktreePath, id, patch),
      remove: (projectPath: string, worktreePath: string, id: string): Promise<ProjectCommand[]> =>
        ipcRenderer.invoke('commands:remove', projectPath, worktreePath, id),
      setScope: (
        projectPath: string,
        worktreePath: string,
        id: string,
        scope: CommandScope
      ): Promise<ProjectCommand[]> => ipcRenderer.invoke('commands:setScope', projectPath, worktreePath, id, scope),
      // The process runner for a registered command.
      start: (
        key: string,
        cwd: string,
        branch: string,
        command: string,
        cols: number,
        rows: number,
        watch?: string[]
      ): Promise<void> => ipcRenderer.invoke('command:start', key, cwd, branch, command, cols, rows, watch),
      stop: (key: string): Promise<void> => ipcRenderer.invoke('command:stop', key),
      restart: (
        key: string,
        cwd: string,
        branch: string,
        command: string,
        cols: number,
        rows: number,
        watch?: string[]
      ): Promise<void> => ipcRenderer.invoke('command:restart', key, cwd, branch, command, cols, rows, watch),
      attach: (key: string, cols: number, rows: number): Promise<void> =>
        ipcRenderer.invoke('command:attach', key, cols, rows),
      resize: (key: string, cols: number, rows: number): Promise<void> =>
        ipcRenderer.invoke('command:resize', key, cols, rows),
      onEvent: (cb: (event: CommandEvent) => void): (() => void) => {
        const listener = (_event: IpcRendererEvent, event: CommandEvent): void => cb(event)
        ipcRenderer.on('command:event', listener)
        return () => ipcRenderer.removeListener('command:event', listener)
      }
    },
    schedules: {
      list: (projectPath: string): Promise<ScheduleEntry[]> => ipcRenderer.invoke('schedules:list', projectPath)
    },
    dev: {
      detect: (worktreePath: string): Promise<DevCommand | null> => ipcRenderer.invoke('dev:detect', worktreePath),
      start: (worktreePath: string, branch: string): Promise<DevCommand | null> =>
        ipcRenderer.invoke('dev:start', worktreePath, branch),
      stop: (worktreePath: string): Promise<void> => ipcRenderer.invoke('dev:stop', worktreePath),
      onEvent: (cb: (event: DevEvent) => void): (() => void) => {
        const listener = (_event: IpcRendererEvent, event: DevEvent): void => cb(event)
        ipcRenderer.on('dev:event', listener)
        return () => ipcRenderer.removeListener('dev:event', listener)
      }
    },
    files: {
      /** One directory's entries — omit `relPath` for the worktree root. */
      list: (worktreePath: string, relPath?: string): Promise<FileNode[]> =>
        ipcRenderer.invoke('files:list', worktreePath, relPath),
      read: (worktreePath: string, relPath: string): Promise<FileContent> =>
        ipcRenderer.invoke('files:read', worktreePath, relPath),
      resolveLink: (worktreePath: string, fromRelPath: string, target: string): Promise<string | null> =>
        ipcRenderer.invoke('files:resolveLink', worktreePath, fromRelPath, target),
      apply: (worktreePath: string, ops: FileOp[]): Promise<string[]> =>
        ipcRenderer.invoke('files:apply', worktreePath, ops)
    },
    review: {
      changedFiles: (worktreePath: string): Promise<ChangedFile[]> =>
        ipcRenderer.invoke('review:changedFiles', worktreePath),
      lastCommit: (worktreePath: string): Promise<LastCommit | null> =>
        ipcRenderer.invoke('review:lastCommit', worktreePath),
      fileDiff: (worktreePath: string, relPath: string): Promise<string> =>
        ipcRenderer.invoke('review:fileDiff', worktreePath, relPath),
      // The commits this branch added since its base, each with the files it
      // touched (Commit Story timeline); commitDiff = one commit's patch for a file.
      commits: (worktreePath: string): Promise<ReviewCommit[]> =>
        ipcRenderer.invoke('review:commits', worktreePath),
      commitDiff: (worktreePath: string, hash: string, relPath: string): Promise<string> =>
        ipcRenderer.invoke('review:commitDiff', worktreePath, hash, relPath),
      // Pin the review to HEAD so committed work leaves the Changes list (no files
      // touched); restore drops the pin; isCleared reports whether one is set.
      clear: (worktreePath: string): Promise<boolean> =>
        ipcRenderer.invoke('review:clear', worktreePath),
      restore: (worktreePath: string): Promise<void> =>
        ipcRenderer.invoke('review:restore', worktreePath),
      isCleared: (worktreePath: string): Promise<boolean> =>
        ipcRenderer.invoke('review:isCleared', worktreePath),
      watch: (worktreePath: string): Promise<void> => ipcRenderer.invoke('review:watch', worktreePath),
      onEvent: (cb: (event: { worktreePath: string }) => void): (() => void) => {
        const listener = (_event: IpcRendererEvent, event: { worktreePath: string }): void => cb(event)
        ipcRenderer.on('review:event', listener)
        return () => ipcRenderer.removeListener('review:event', listener)
      }
    },
    // Notes anchored to passages of a session's transcript. The transcript
    // itself comes back from Claude's JSONL; only the notes are ours to keep.
    threadComments: {
      list: (sessionKey: string): Promise<ThreadComment[]> =>
        ipcRenderer.invoke('threadComments:list', sessionKey),
      add: (comment: ThreadComment): Promise<void> =>
        ipcRenderer.invoke('threadComments:add', comment),
      remove: (sessionKey: string, id: string): Promise<void> =>
        ipcRenderer.invoke('threadComments:remove', sessionKey, id),
      // Stamp notes as sent. They stay in the list — the thread is the record.
      markSent: (sessionKey: string, ids: string[]): Promise<void> =>
        ipcRenderer.invoke('threadComments:markSent', sessionKey, ids)
    },
    plans: {
      list: (worktreePath: string, branch?: string): Promise<PlanFile[]> =>
        ipcRenderer.invoke('plans:list', worktreePath, branch),
      read: (worktreePath: string, relPath: string): Promise<string> =>
        ipcRenderer.invoke('plans:read', worktreePath, relPath),
      watch: (worktreePath: string): Promise<void> => ipcRenderer.invoke('plans:watch', worktreePath),
      // Copy a plan into another worktree's plans dir; returns the dest relPath + content.
      copy: (
        srcWorktreePath: string,
        relPath: string,
        destWorktreePath: string
      ): Promise<{ name: string; relPath: string; content: string }> =>
        ipcRenderer.invoke('plans:copy', srcWorktreePath, relPath, destWorktreePath),
      // Implementation phases parsed live from the matching `specs/<branch>/tasks.md`
      // — drives the sub-checklist nested under the trilho's `implement` step.
      implementPhases: (worktreePath: string, branch?: string): Promise<ImplementPhase[]> =>
        ipcRenderer.invoke('plans:implementPhases', worktreePath, branch),
      onEvent: (cb: (event: { worktreePath: string }) => void): (() => void) => {
        const listener = (_event: IpcRendererEvent, event: { worktreePath: string }): void => cb(event)
        ipcRenderer.on('plans:event', listener)
        return () => ipcRenderer.removeListener('plans:event', listener)
      }
    },
    // External tracker work items (GitHub Issues today; Jira later). `status` says
    // whether a tracker applies to the project root and is usable; `list` pulls the
    // normalized tasks. Both take the project root (issues are repo-level).
    tasks: {
      status: (root: string): Promise<TasksStatus> => ipcRenderer.invoke('tasks:status', root),
      list: (root: string, opts: { state: 'open' | 'all' }): Promise<Task[]> =>
        ipcRenderer.invoke('tasks:list', root, opts),
      // Merge flow: mark the branch's linked task done (Jira "Done" / GitHub close).
      closeForBranch: (root: string, branch: string): Promise<TaskCloseResult> =>
        ipcRenderer.invoke('tasks:closeForBranch', root, branch),
      // Jira connection (global token) + per-repo project key. The token is set
      // here but only ever read back as "connected" — it never leaves the main process.
      jiraGetConnection: (): Promise<{ connected: boolean; site?: string; email?: string }> =>
        ipcRenderer.invoke('tasks:jiraGetConnection'),
      jiraSetCreds: (c: { site: string; email: string; token: string }): Promise<void> =>
        ipcRenderer.invoke('tasks:jiraSetCreds', c),
      jiraClearCreds: (): Promise<void> => ipcRenderer.invoke('tasks:jiraClearCreds'),
      jiraTestCreds: (c: {
        site: string
        email: string
        token: string
      }): Promise<{ ok: boolean; displayName?: string; reason?: string }> =>
        ipcRenderer.invoke('tasks:jiraTestCreds', c),
      getProjectKey: (root: string): Promise<string | undefined> =>
        ipcRenderer.invoke('tasks:getProjectKey', root),
      setProjectKey: (root: string, key: string): Promise<void> =>
        ipcRenderer.invoke('tasks:setProjectKey', root, key)
    },
    // Pull requests (GitHub via `gh`, or Bitbucket Cloud via REST — picked by the
    // origin remote). Repo-level like tasks: every call takes the project root.
    // `status` reports whether the PR workflow is usable; `list`/`files` read;
    // `approve`/`merge` act; `bitbucket*` manage the global Bitbucket connection.
    pr: {
      status: (root: string): Promise<PrStatus> => ipcRenderer.invoke('pr:status', root),
      list: (root: string): Promise<PullRequest[]> => ipcRenderer.invoke('pr:list', root),
      files: (root: string, number: number): Promise<PrFile[]> => ipcRenderer.invoke('pr:files', root, number),
      addComment: (
        root: string,
        number: number,
        c: { relPath: string; side: 'new' | 'old'; startLine: number; endLine: number; body: string }
      ): Promise<void> => ipcRenderer.invoke('pr:addComment', root, number, c),
      approve: (root: string, number: number, body?: string): Promise<void> =>
        ipcRenderer.invoke('pr:approve', root, number, body),
      merge: (root: string, number: number, method: 'merge' | 'squash' | 'rebase'): Promise<void> =>
        ipcRenderer.invoke('pr:merge', root, number, method),
      bitbucketGetConnection: (): Promise<{ connected: boolean; email?: string }> =>
        ipcRenderer.invoke('pr:bitbucketGetConnection'),
      bitbucketSetCreds: (c: { email: string; token: string }): Promise<void> =>
        ipcRenderer.invoke('pr:bitbucketSetCreds', c),
      bitbucketClearCreds: (): Promise<void> => ipcRenderer.invoke('pr:bitbucketClearCreds'),
      bitbucketTestCreds: (c: {
        email: string
        token: string
      }): Promise<{ ok: boolean; displayName?: string; reason?: string }> =>
        ipcRenderer.invoke('pr:bitbucketTestCreds', c)
    },
    editor: {
      open: (
        id: string,
        cwd: string,
        branch: string,
        file: string | null,
        cols: number,
        rows: number,
        // 1-based line to place the nvim cursor on (e.g. the selected .http request).
        line?: number
      ): Promise<string | null> =>
        ipcRenderer.invoke('editor:open', id, cwd, branch, file, cols, rows, line)
    },
    // The `.http` client: discover files for the right-pane list, parse one file's
    // requests for the center view, load the environments (http-client.env.json),
    // and send a request (built-in fetch, in the main process). `onChanged` fires
    // when a .http/env file changes on disk so the list can refresh.
    http: {
      list: (worktreePath: string): Promise<HttpFile[]> => ipcRenderer.invoke('http:list', worktreePath),
      parse: (worktreePath: string, relPath: string): Promise<HttpRequest[]> =>
        ipcRenderer.invoke('http:parse', worktreePath, relPath),
      env: (worktreePath: string, relPath?: string): Promise<HttpEnv> =>
        ipcRenderer.invoke('http:env', worktreePath, relPath),
      execute: (worktreePath: string, relPath: string, index: number, envName?: string): Promise<HttpResponse> =>
        ipcRenderer.invoke('http:execute', worktreePath, relPath, index, envName),
      watch: (worktreePath: string): Promise<void> => ipcRenderer.invoke('http:watch', worktreePath),
      onChanged: (cb: (event: { worktreePath: string }) => void): (() => void) => {
        const listener = (_event: IpcRendererEvent, event: { worktreePath: string }): void => cb(event)
        ipcRenderer.on('http:changed', listener)
        return () => ipcRenderer.removeListener('http:changed', listener)
      }
    },
    // The read-only database viewer: detect the connection + list the worktree's
    // tables, run a read-only query, and watch .env/sqlite so the view refreshes
    // when the connection or data changes on disk.
    database: {
      tables: (worktreePath: string): Promise<DbTablesResult> => ipcRenderer.invoke('db:tables', worktreePath),
      query: (worktreePath: string, sql: string, limit?: number): Promise<DbResult> =>
        ipcRenderer.invoke('db:query', worktreePath, sql, limit),
      watch: (worktreePath: string): Promise<void> => ipcRenderer.invoke('db:watch', worktreePath),
      onChanged: (cb: (event: { worktreePath: string }) => void): (() => void) => {
        const listener = (_event: IpcRendererEvent, event: { worktreePath: string }): void => cb(event)
        ipcRenderer.on('db:changed', listener)
        return () => ipcRenderer.removeListener('db:changed', listener)
      }
    },
    terminal: {
      // Resolves with the scrollback to repaint when re-attaching to a live PTY
      // (null for a fresh shell) — see replay() in main/terminal.ts for why it
      // rides the reply instead of an event.
      open: (
        id: string,
        cwd: string,
        branch: string,
        cols: number,
        rows: number
      ): Promise<string | null> => ipcRenderer.invoke('terminal:open', id, cwd, branch, cols, rows),
      write: (id: string, data: string): Promise<void> => ipcRenderer.invoke('terminal:write', id, data),
      resize: (id: string, cols: number, rows: number): Promise<void> =>
        ipcRenderer.invoke('terminal:resize', id, cols, rows),
      kill: (id: string): Promise<void> => ipcRenderer.invoke('terminal:kill', id),
      list: (worktreePath: string): Promise<{ id: string; cwd: string }[]> =>
        ipcRenderer.invoke('terminal:list', worktreePath),
      // Broadcast a light/dark flip to every shell that subscribed via DECSET
      // 2031 (fish 4, nvim) — they re-query OSC 10/11 and recolor live.
      notifyTheme: (dark: boolean): Promise<void> => ipcRenderer.invoke('terminal:notifyTheme', dark),
      onEvent: (cb: (event: TerminalEvent) => void): (() => void) => {
        const listener = (_event: IpcRendererEvent, event: TerminalEvent): void => cb(event)
        ipcRenderer.on('terminal:event', listener)
        return () => ipcRenderer.removeListener('terminal:event', listener)
      }
    },
    // The worktree this app instance is running in. Prefer the explicit env set by
    // Rookery's dev runner; otherwise derive it from the launch path — the segment
    // after `.worktrees/`. Stays null on the main checkout, so the badge only shows
    // when this really is a worktree.
    tag: host.worktreeTag
  }
  return api
}

export type RookeryApi = ReturnType<typeof buildRookeryApi>
