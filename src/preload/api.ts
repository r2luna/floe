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
import type { DevCommand, DevEvent } from '../main/devServer'
import type { ProjectCommand, CommandScope, CommandPatch } from '../main/commands'
import type { CommandEvent, CommandRun } from '../main/commandRunner'
import type { TerminalEvent } from '../main/terminal'
import type { KeybindingsConfig } from '../main/keybindings'
import type { Skill } from '../main/config/skills'
import type { FloeConfig } from '../main/config/floe'
import type { PluginCommandMeta, PluginInfo } from '../main/plugins/host'
import type { PluginPanelSection } from '../main/plugins/types'
import type { ConfigError } from '../main/config/errors'
import type { TomlValue } from '../main/config/toml'
import type {
  AgentEventEnvelope,
  AgentReplay,
  AgentRunOptions,
  ChangedFile,
  ClaudeInfo,
  ContextUsage,
  CodexModel,
  Effort,
  FileAttachment,
  FileContent,
  FileNode,
  ImageAttachment,
  ImplementPhase,
  JumpSession,
  McpAuthEnvelope,
  McpCommand,
  McpCommandResult,
  McpServerEntry,
  AuthStatus,
  ClaudeAuthEvent,
  ClaudeStats,
  HarnessUsage,
  LocalAgent,
  MemoryStats,
  PermissionMode,
  NeedsYouSession,
  PlanFile,
  ThreadComment,
  Project,
  ProjectActivity,
  ProjectEnvConfig,
  ProvisionEvent,
  RemoteBranch,
  DropDatabaseResult,
  FileOp,
  RemoveBranchResult,
  RemovePreflight,
  ReviewCommit,
  SlashCommand,
  UsageStats,
  Worktree,
  WorktreesUpdatedEvent,
  WorktreeStatus
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
export interface FloeHost {
  platform: string
  version: string
  appVersion: string
  homeDir: string
  worktreeTag: string | null
}

// A machine this window can run work on. Single-entry today (this one) — the
// shape is what the rail and AddProject read.
export interface BackendInfo {
  id: string
  label: string // short name for the chip: the hostname
  homeDir: string
  remote: boolean
}


// The bridge the renderer talks to.
export function buildFloeApi(ipcRenderer: IpcLike, host: FloeHost) {
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
    // Resolves false when there's no window to raise.
    focus: (): Promise<boolean> => ipcRenderer.invoke('window:focus'),
    // Translucent (vibrancy) window appearance — macOS only. `get` is the snapshot
    // for the initial [data-vibrancy] CSS state; `set` flips it live and persists.
    vibrancy: {
      get: (): Promise<boolean> => ipcRenderer.invoke('window:getVibrancy'),
      set: (on: boolean): Promise<void> => ipcRenderer.invoke('window:setVibrancy', on)
    },
    // The machines this window can run on.
    backends: {
      list: (): BackendInfo[] => [
        { id: 'local', label: host.homeDir.split('/').pop() || 'local', homeDir: host.homeDir, remote: false }
      ]
    },
    // Runtime plugins (main/plugins/host.ts): the palette merges `commands`
    // into the registry as `plugin:<name>:<id>` rows whose run dispatches back
    // through `run`; `list` is the load report (name, version, error).
    plugins: {
      commands: (): Promise<PluginCommandMeta[]> => ipcRenderer.invoke('plugins:commands'),
      run: (id: string, arg?: string): Promise<{ ok: true } | { ok: false; error: string }> =>
        ipcRenderer.invoke('plugins:run', id, arg),
      list: (): Promise<PluginInfo[]> => ipcRenderer.invoke('plugins:list'),
      // A declarative plugin panel's current body (null when the sub names no
      // panel — e.g. the plugin was removed since the lane was saved).
      panel: (sub: string): Promise<{ title: string; sections: PluginPanelSection[] } | null> =>
        ipcRenderer.invoke('plugins:panel', sub),
      onPanelChanged: (cb: (sub: string) => void): (() => void) => {
        const listener = (_event: IpcRendererEvent, sub: string): void => cb(sub)
        ipcRenderer.on('plugins:panel-changed', listener)
        return () => ipcRenderer.removeListener('plugins:panel-changed', listener)
      }
    },
    // Open Floe at login — OS login-item list (Settings → General).
    loginItem: {
      get: (): Promise<boolean> => ipcRenderer.invoke('app:getLoginItem'),
      set: (on: boolean): Promise<void> => ipcRenderer.invoke('app:setLoginItem', on)
    },
    // First name to greet the user by on the launcher (see main's `user:name`).
    userName: (): Promise<string> => ipcRenderer.invoke('user:name'),
    // Settings read-only detection (Claude CLI binary/version, gh auth state).
    settingsProbe: (): Promise<{
      claude: { path: string | null; version: string | null }
    }> => ipcRenderer.invoke('settings:probe'),
    // System prompt appended to every spawned Claude session (agent.ts, --append-system-prompt).
    getSystemPrompt: (): Promise<string> => ipcRenderer.invoke('settings:getSystemPrompt'),
    setSystemPrompt: (value: string): Promise<void> => ipcRenderer.invoke('settings:setSystemPrompt', value),
    notify: (payload: { title: string; body: string; sessionId: string }): Promise<void> =>
      ipcRenderer.invoke('notify:show', payload),
    onNotificationClick: (cb: (sessionId: string) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, sessionId: string): void => cb(sessionId)
      ipcRenderer.on('notification:click', listener)
      return () => ipcRenderer.removeListener('notification:click', listener)
    },
    // An auto-update has been downloaded and will install on next restart; the
    // payload carries the version that's waiting. Drives the in-app update
    // banner and the `update.install` command.
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
      rebind: (command: string, chord: string): Promise<void> =>
        ipcRenderer.invoke('keybindings:rebind', command, chord),
      reset: (): Promise<string> => ipcRenderer.invoke('keybindings:reset'),
      onChange: (cb: () => void): (() => void) => {
        const listener = (): void => cb()
        ipcRenderer.on('keybindings:changed', listener)
        return () => ipcRenderer.removeListener('keybindings:changed', listener)
      }
    },
    // Settings, backed by ~/.config/floe/floe.toml. `set` writes through the
    // surgical TOML editor, so a change made here comes back as one changed value
    // in a file whose comments and layout are untouched — the same file the user
    // (or an agent) edits by hand. `errors` is every config file's problems in one
    // list, and `onChange` fires when anything under the config dir is saved.
    config: {
      get: (): Promise<FloeConfig> => ipcRenderer.invoke('config:get'),
      set: (table: string, key: string, value: TomlValue): Promise<FloeConfig> =>
        ipcRenderer.invoke('config:set', table, key, value),
      errors: (): Promise<ConfigError[]> => ipcRenderer.invoke('config:errors'),
      paths: (): Promise<{ dir: string; floe: string; projects: string; systemPrompt: string }> =>
        ipcRenderer.invoke('config:paths'),
      reveal: (path?: string): Promise<string> => ipcRenderer.invoke('config:reveal', path),
      onChange: (cb: () => void): (() => void) => {
        const listener = (): void => cb()
        ipcRenderer.on('config:changed', listener)
        return () => ipcRenderer.removeListener('config:changed', listener)
      }
    },
    projects: {
      list: (): Promise<Project[]> => ipcRenderer.invoke('projects:list'),
      groups: (): Promise<string[]> => ipcRenderer.invoke('projects:groups'),
      addGroup: (name: string): Promise<string[]> => ipcRenderer.invoke('projects:addGroup', name),
      renameGroup: (oldName: string, newName: string): Promise<{ groups: string[]; projects: Project[] }> =>
        ipcRenderer.invoke('projects:renameGroup', oldName, newName),
      // Its projects fall back to the default group rather than going with it.
      deleteGroup: (name: string): Promise<{ groups: string[]; projects: Project[] }> =>
        ipcRenderer.invoke('projects:deleteGroup', name),
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
      // The git dirt of each path, keyed by path. A worktree that isn't a repo
      // (or is gone) is simply absent from the map.
      status: (paths: string[]): Promise<Record<string, WorktreeStatus>> =>
        ipcRenderer.invoke('worktrees:status', paths),
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
    // Floe's own MCP control server (main/mcpServer.ts) — agents drive Floe.
    // UI-driving tools arrive here as an `mcp:command`; commands that carry a
    // requestId (run_command / list_commands) are answered back over
    // `mcp:command-result` so the waiting tool gets a real result.
    mcp: {
      onCommand: (cb: (command: McpCommand) => void): (() => void) => {
        const listener = (_event: IpcRendererEvent, command: McpCommand): void => cb(command)
        ipcRenderer.on('mcp:command', listener)
        return () => ipcRenderer.removeListener('mcp:command', listener)
      },
      commandResult: (result: McpCommandResult): Promise<void> =>
        ipcRenderer.invoke('mcp:command-result', result),
      // Register Floe's MCP server in the user's global Claude config so any
      // claude session (in-app or a plain terminal) gets the floe tools.
      installGlobal: (): Promise<{ ok: boolean; message: string }> =>
        ipcRenderer.invoke('mcp:installGlobal'),
      // Floe's own MCP registry — the third-party servers projected into every
      // spawned session (config/mcpServers.ts). The MCP panel's CRUD.
      servers: {
        list: (worktreePath?: string): Promise<McpServerEntry[]> =>
          ipcRenderer.invoke('mcp:servers:list', worktreePath),
        add: (
          scope: 'global' | 'project',
          server: { name: string; transport: 'http' | 'stdio'; url?: string; command?: string; args?: string[]; enabled?: boolean },
          worktreePath?: string
        ): Promise<McpServerEntry> => ipcRenderer.invoke('mcp:servers:add', scope, server, worktreePath),
        update: (
          name: string,
          patch: { name?: string; transport?: 'http' | 'stdio'; url?: string; command?: string; args?: string[]; enabled?: boolean },
          worktreePath?: string
        ): Promise<McpServerEntry> => ipcRenderer.invoke('mcp:servers:update', name, patch, worktreePath),
        remove: (name: string, worktreePath?: string): Promise<void> =>
          ipcRenderer.invoke('mcp:servers:remove', name, worktreePath)
      }
    },
    // Floe's own skills — Markdown in ~/.config/floe, global or per project.
    // The renderer only ever needs the LIST: the text itself is expanded in the
    // main process at the moment a turn is sent, so a skill never has to travel
    // through the UI or sit in a message the chat would then have to hide.
    skills: {
      list: (worktreePath?: string): Promise<Skill[]> => ipcRenderer.invoke('skills:list', worktreePath),
      // The Skills panel's three writes. Each one rejects with the reason —
      // a taken name, a name that could not be typed after a slash — so the
      // panel reports it instead of failing quietly.
      create: (name: string, scope: 'global' | 'project', worktreePath?: string): Promise<Skill> =>
        ipcRenderer.invoke('skills:create', name, scope, worktreePath),
      rename: (name: string, to: string, worktreePath?: string): Promise<Skill> =>
        ipcRenderer.invoke('skills:rename', name, to, worktreePath),
      remove: (name: string, worktreePath?: string): Promise<void> =>
        ipcRenderer.invoke('skills:delete', name, worktreePath)
    },
    slash: {
      list: (worktreePath: string): Promise<SlashCommand[]> => ipcRenderer.invoke('slash:list', worktreePath)
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
        watch?: string[],
        autoRestart?: boolean
      ): Promise<void> =>
        ipcRenderer.invoke('command:start', key, cwd, branch, command, cols, rows, watch, autoRestart),
      stop: (key: string): Promise<void> => ipcRenderer.invoke('command:stop', key),
      restart: (
        key: string,
        cwd: string,
        branch: string,
        command: string,
        cols: number,
        rows: number,
        watch?: string[],
        autoRestart?: boolean
      ): Promise<void> =>
        ipcRenderer.invoke('command:restart', key, cwd, branch, command, cols, rows, watch, autoRestart),
      attach: (key: string, cols: number, rows: number): Promise<void> =>
        ipcRenderer.invoke('command:attach', key, cols, rows),
      // What main is tracking right now. A window reload empties the renderer's
      // own map, and without this every live process renders as stopped.
      runs: (): Promise<CommandRun[]> => ipcRenderer.invoke('command:runs'),
      resize: (key: string, cols: number, rows: number): Promise<void> =>
        ipcRenderer.invoke('command:resize', key, cols, rows),
      onEvent: (cb: (event: CommandEvent) => void): (() => void) => {
        const listener = (_event: IpcRendererEvent, event: CommandEvent): void => cb(event)
        ipcRenderer.on('command:event', listener)
        return () => ipcRenderer.removeListener('command:event', listener)
      }
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
      /** Every file in the worktree, worktree-relative — the file palette's list. */
      all: (worktreePath: string): Promise<string[]> => ipcRenderer.invoke('files:all', worktreePath),
      read: (worktreePath: string, relPath: string): Promise<FileContent> =>
        ipcRenderer.invoke('files:read', worktreePath, relPath),
      resolveLink: (worktreePath: string, fromRelPath: string, target: string): Promise<string | null> =>
        ipcRenderer.invoke('files:resolveLink', worktreePath, fromRelPath, target),
      apply: (worktreePath: string, ops: FileOp[]): Promise<string[]> =>
        ipcRenderer.invoke('files:apply', worktreePath, ops),
      /**
       * Fires when anything in the worktree lands on disk — including the
       * gitignored files (`.floe/plans/…`) the review event skips, because the
       * tree lists those too. Armed by `review.watch`: one watcher in main
       * feeds both. See watchChanges.
       */
      onChanged: (cb: (event: { worktreePath: string }) => void): (() => void) => {
        const listener = (_event: IpcRendererEvent, event: { worktreePath: string }): void => cb(event)
        ipcRenderer.on('files:changed', listener)
        return () => ipcRenderer.removeListener('files:changed', listener)
      }
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
        ipcRenderer.invoke('editor:open', id, cwd, branch, file, cols, rows, line),
      /**
       * Open a file in the configured editor.
       *
       * `mode: 'panel'` means the editor is a terminal one and nothing was
       * launched — open the editor panel, which runs it on the PTY. `external`
       * means a GUI editor was started (or `error` says why it wasn't).
       */
      launch: (
        cwd: string,
        file: string,
        line?: number
      ): Promise<{ mode: 'panel' | 'external'; error?: string }> =>
        ipcRenderer.invoke('editor:launch', cwd, file, line)
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
    // Floe's dev runner; otherwise derive it from the launch path — the segment
    // after `.worktrees/`. Stays null on the main checkout, so the badge only shows
    // when this really is a worktree.
    tag: host.worktreeTag
  }
  return api
}

export type FloeApi = ReturnType<typeof buildFloeApi>
