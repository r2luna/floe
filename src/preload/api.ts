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
import type { Board, ColonyTask, TaskKind } from '../shared/colony'
import type { Route } from '../shared/mentions'
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
  MediaFile,
  AuthStatus,
  ClaudeAuthEvent,
  ClaudeStats,
  HarnessUsage,
  LocalAgent,
  MemoryStats,
  PathProbe,
  PermissionMode,
  NeedsYouSession,
  PlanFile,
  DrawDelta,
  DrawFile,
  DrawScene,
  DrawScope,
  ThreadComment,
  Project,
  ProjectActivity,
  ProjectEnvConfig,
  ProvisionEvent,
  Query,
  RemoteBranch,
  DropDatabaseResult,
  UnlinkSiteResult,
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
  /** The preload's multi-backend router controls; absent means local-only. */
  backendsCtl?: BackendsCtl
}

/** How the api layer steers the preload's backend router (see preload/index.ts). */
export interface BackendsCtl {
  list: () => BackendInfo[]
  current: () => string
  /** Point workspace calls at this backend. False when the id names none. */
  use: (id: string) => boolean
  state: (id: string) => 'connecting' | 'open' | 'closed'
  /**
   * Run ONE workspace call on the backend `id` names, leaving the pointer where
   * it is. The add-project dialog needs it: you pick the machine there, and the
   * path has to be read on that machine before the window has any reason to
   * move. Rejects when the id names no backend — rerouting to this machine
   * would check a remote path against local disk, which is the bug it exists to
   * fix. A PINNED channel stays local whatever id it is given: naming a machine
   * asks where the WORK runs, not where this window's own state lives.
   */
  invokeOn: (id: string, channel: string, ...args: unknown[]) => Promise<unknown>
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
    // The machines this window can run on. Workspace calls follow `use`'s
    // pointer; PINNED channels always stay on this machine (remoteProtocol.ts).
    backends: {
      list: (): BackendInfo[] =>
        host.backendsCtl?.list() ?? [
          { id: 'local', label: host.homeDir.split('/').pop() || 'local', homeDir: host.homeDir, remote: false }
        ],
      current: (): string => host.backendsCtl?.current() ?? 'local',
      use: (id: string): boolean => host.backendsCtl?.use(id) ?? id === 'local',
      state: (id: string): 'connecting' | 'open' | 'closed' =>
        host.backendsCtl?.state(id) ?? (id === 'local' ? 'open' : 'closed'),
      // One call on a named machine, pointer untouched — what the projects union
      // is built from (renderer/src/backends.ts fans it out over every id).
      // Untyped by nature: it is the one seam where a channel name is a string,
      // so it stays wrapped in typed helpers rather than called from panels.
      invokeOn: (id: string, channel: string, ...args: unknown[]): Promise<unknown> =>
        host.backendsCtl
          ? host.backendsCtl.invokeOn(id, channel, ...args)
          : ipcRenderer.invoke(channel, ...args)
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
    // Poll the release feed now rather than waiting out the hours-long interval.
    // Resolves to the line to show the user — up to date, downloading, or why it
    // failed — so the caller never has to interpret an updater result itself.
    checkForUpdate: (): Promise<string> => ipcRenderer.invoke('update:check'),
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
      // `created` is false for a re-add: main answers with the project it
      // already had, and only a project Floe has never seen starts the setup
      // flow. See addProjectByPath.
      add: (group?: string): Promise<{ project?: Project; created?: boolean; error?: string }> =>
        ipcRenderer.invoke('projects:add', group),
      // Web/headless has no native folder picker — add by an explicit server-side path.
      // `backend` names the machine that reads the path (the dialog's Machine
      // row). Without it the call follows the pointer, which is right for every
      // other caller — the CLI and the browse flow are already on the machine
      // they mean.
      addByPath: (
        path: string,
        group?: string,
        backend?: string
      ): Promise<{ project?: Project; created?: boolean; error?: string }> =>
        backend && host.backendsCtl
          ? (host.backendsCtl.invokeOn(backend, 'projects:addByPath', path, group) as Promise<{
              project?: Project
              created?: boolean
              error?: string
            }>)
          : ipcRenderer.invoke('projects:addByPath', path, group),
      // What the path IS, without adding it — the dialog's preview pane. Reads
      // on the same machine the add would, so a remote path is checked over
      // there rather than against this disk.
      probe: (path: string, backend?: string): Promise<PathProbe> =>
        backend && host.backendsCtl
          ? (host.backendsCtl.invokeOn(backend, 'projects:probe', path) as Promise<PathProbe>)
          : ipcRenderer.invoke('projects:probe', path),
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
        ipcRenderer.invoke('remove:dropDatabase', root, target),
      // Undo the Herd site the Laravel recipe linked, before the directory goes.
      unlinkSite: (target: string): Promise<UnlinkSiteResult> =>
        ipcRenderer.invoke('remove:unlinkSite', target)
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
        files: FileAttachment[] = [],
        /**
         * The handle this message opened with, already read by the composer.
         * Passed on rather than dropped: where a routed message goes is one
         * decision for all five doors into a turn, and it is made in main's
         * turn.ts — see dispatchTurn.
         */
        route: Route | null = null
      ): Promise<void> =>
        ipcRenderer.invoke('agent:start', key, worktreePath, prompt, options, images, files, route),
      answer: (key: string, toolUseId: string, answer: string, answers?: string[][]): Promise<void> =>
        ipcRenderer.invoke('agent:answer', key, toolUseId, answer, answers),
      permission: (key: string, requestId: string, allow: boolean): Promise<void> =>
        ipcRenderer.invoke('agent:permission', key, requestId, allow),
      stop: (key: string): Promise<void> => ipcRenderer.invoke('agent:stop', key),
      // The turn in flight, for a panel that mounts mid-turn (see AgentReplay).
      replay: (key: string): Promise<AgentReplay> => ipcRenderer.invoke('agent:replay', key),
      // Every session working right now, for useSessionActivity to reconcile
      // its event-driven set against.
      active: (): Promise<string[]> => ipcRenderer.invoke('agent:active'),
      // Every session blocked on an unanswered question or permission prompt,
      // for the same reconcile — see agent:waiting.
      waiting: (): Promise<string[]> => ipcRenderer.invoke('agent:waiting'),
      onEvent: (cb: (payload: AgentEventEnvelope) => void): (() => void) => {
        const listener = (_event: IpcRendererEvent, payload: AgentEventEnvelope): void => cb(payload)
        ipcRenderer.on('agent:event', listener)
        return () => ipcRenderer.removeListener('agent:event', listener)
      }
    },
    // Side conversations opened off a session — see docs/queries.md.
    query: {
      /** Every query this session has, open or closed, oldest first. */
      list: (sessionKey: string): Promise<Query[]> => ipcRenderer.invoke('query:list', sessionKey),
      /** Open (or refocus) the query for one harness, without sending anything. */
      open: (
        sessionKey: string,
        worktreePath: string,
        harness: string,
        model?: string,
        effort?: Effort
      ): Promise<{ query?: Query; error?: string }> =>
        ipcRenderer.invoke('query:open', sessionKey, worktreePath, harness, model, effort),
      /** The chat reads what it has not read. The query stays open. */
      peek: (qkey: string): Promise<{ entries: number; error?: string }> =>
        ipcRenderer.invoke('query:peek', qkey),
      /** The chat reads the rest, and the query closes. */
      merge: (qkey: string): Promise<{ entries: number; error?: string }> =>
        ipcRenderer.invoke('query:merge', qkey),
      /** The query closes and the chat never sees a word of it. */
      discard: (qkey: string): Promise<{ entries: number; error?: string }> =>
        ipcRenderer.invoke('query:discard', qkey),
      /**
       * `@all` — one message to several harnesses at once, each in its own
       * query, the answers mirrored back into the chat side by side.
       *
       * The targets are passed in and never inferred: fanning out to every
       * harness on the machine is four turns nobody asked for (R7).
       */
      all: (
        sessionKey: string,
        worktreePath: string,
        harnesses: string[],
        prompt: string,
        effort?: Effort
      ): Promise<{ fanoutId?: string; keys?: string[]; refused?: string[]; error?: string }> =>
        ipcRenderer.invoke('query:all', sessionKey, worktreePath, harnesses, prompt, effort),
      /** What a closed query said — read on demand by the fold in the chat. */
      transcript: (qkey: string): Promise<TranscriptItem[]> =>
        ipcRenderer.invoke('query:transcript', qkey),
      /** Bring a closed one back — its transcript is still its own. */
      reopen: (qkey: string): Promise<{ query?: Query; error?: string }> =>
        ipcRenderer.invoke('query:reopen', qkey),
      /** A query ended, and how. The panel comes down where it is showing. */
      onClosed: (
        cb: (payload: { key: string; outcome: 'merged' | 'discarded'; entries: number }) => void
      ): (() => void) => {
        const listener = (
          _event: IpcRendererEvent,
          payload: { key: string; outcome: 'merged' | 'discarded'; entries: number }
        ): void => cb(payload)
        ipcRenderer.on('query:closed', listener)
        return () => ipcRenderer.removeListener('query:closed', listener)
      },
      /**
       * A query is born on any of four doors, only one of which is the composer
       * in front of you — so the panel appears by being told, not by being
       * asked. See main/queries.ts.
       */
      onOpened: (
        cb: (payload: { query: Query; worktreePath: string; parentKeys: string[] }) => void
      ): (() => void) => {
        const listener = (
          _event: IpcRendererEvent,
          payload: { query: Query; worktreePath: string; parentKeys: string[] }
        ): void => cb(payload)
        ipcRenderer.on('query:opened', listener)
        return () => ipcRenderer.removeListener('query:opened', listener)
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
      /** The whole picker for one session — what it answers as, and how. */
      setChoice: (
        id: string,
        choice: { provider?: string; model?: string; effort?: Effort; mode?: PermissionMode }
      ): Promise<void> => ipcRenderer.invoke('sessions:setChoice', id, choice),
      choice: (
        id: string
      ): Promise<{ provider?: string; model?: string; effort?: Effort; mode?: PermissionMode } | null> =>
        ipcRenderer.invoke('sessions:choice', id),
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
      // The reading from the last probe, with no spawn — what to show while
      // refreshUsage is still out.
      lastUsage: (): Promise<UsageStats> => ipcRenderer.invoke('stats:lastUsage'),
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
    media: {
      /**
       * Can this path be played, and at what address? Null when the file the
       * message named is not there (or is not a video), which is what keeps a
       * mention of a deleted recording from drawing a dead player.
       */
      probe: (path: string, cwd?: string): Promise<MediaFile | null> =>
        ipcRenderer.invoke('media:probe', path, cwd),
      /**
       * Put a picture on the system clipboard from its data URL — the keyboard
       * half of the right-click "Copy Image". False when the URL decoded to
       * nothing (so the caller can say it failed instead of lying).
       */
      copyImage: (dataUrl: string): Promise<boolean> =>
        ipcRenderer.invoke('media:copyImage', dataUrl)
    },
    files: {
      /** One directory's entries — omit `relPath` for the worktree root. */
      list: (worktreePath: string, relPath?: string): Promise<FileNode[]> =>
        ipcRenderer.invoke('files:list', worktreePath, relPath),
      /** Every file in the worktree, worktree-relative — the file palette's list. */
      all: (worktreePath: string): Promise<string[]> => ipcRenderer.invoke('files:all', worktreePath),
      read: (worktreePath: string, relPath: string): Promise<FileContent> =>
        ipcRenderer.invoke('files:read', worktreePath, relPath),
      /** A document as LibreOffice draws it (a PDF), or null when it can't. */
      renderDoc: (worktreePath: string, relPath: string): Promise<FileContent | null> =>
        ipcRenderer.invoke('files:renderDoc', worktreePath, relPath),
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
      fileDiff: (worktreePath: string, relPath: string, context?: number): Promise<string> =>
        ipcRenderer.invoke('review:fileDiff', worktreePath, relPath, context),
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
    // The colony board. One read, so the panel repaints from a single shape.
    colony: {
      board: (project: string): Promise<Board> => ipcRenderer.invoke('colony:board', project),
      add: (task: { project: string; name: string; kind?: TaskKind; brief: string }): Promise<ColonyTask> =>
        ipcRenderer.invoke('colony:add', task),
      // Cuts the worktree and puts the card at the first stage's door.
      release: (id: string): Promise<ColonyTask> => ipcRenderer.invoke('colony:release', id),
      remove: (id: string, project: string): Promise<void> => ipcRenderer.invoke('colony:remove', id, project),
      // `fresh` says she was just minted, so the caller opens her with `opener`
      // as the chat's first message — a nanny who has not read her own skill is
      // just a chat in the project root.
      nanny: (
        project: string
      ): Promise<{ sessionId: string; worktreePath: string; fresh: boolean; opener: string }> =>
        ipcRenderer.invoke('colony:nanny', project),
      onEvent: (cb: (event: { project: string }) => void): (() => void) => {
        const listener = (_event: IpcRendererEvent, event: { project: string }): void => cb(event)
        ipcRenderer.on('colony:event', listener)
        return () => ipcRenderer.removeListener('colony:event', listener)
      }
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
    // Drawings. `apply` is the only write there is — see draw/index.ts for why
    // nobody, canvas included, is allowed to send a whole scene.
    draw: {
      list: (worktreePath: string, branch?: string): Promise<DrawFile[]> =>
        ipcRenderer.invoke('draw:list', worktreePath, branch),
      read: (worktreePath: string, relPath: string): Promise<DrawScene> =>
        ipcRenderer.invoke('draw:read', worktreePath, relPath),
      // Answers with the MERGED scene, which is what the panel keeps as its new
      // baseline: what it sent is not necessarily what landed.
      apply: (worktreePath: string, relPath: string, delta: DrawDelta): Promise<DrawScene> =>
        ipcRenderer.invoke('draw:apply', worktreePath, relPath, delta),
      create: (worktreePath: string, name: string, scope?: DrawScope, branch?: string): Promise<DrawFile> =>
        ipcRenderer.invoke('draw:create', worktreePath, name, scope, branch),
      // Move a draft into the project — .floe/draw/ → specs/<branch>/. Answers
      // with the drawing's new row, so the caller can open it where it landed.
      promote: (worktreePath: string, relPath: string, branch?: string): Promise<DrawFile> =>
        ipcRenderer.invoke('draw:promote', worktreePath, relPath, branch),
      watch: (worktreePath: string): Promise<void> => ipcRenderer.invoke('draw:watch', worktreePath),
      // Show the .excalidraw in the OS file manager — a drawing is a portable
      // file, and this is how it leaves Floe for another tool.
      reveal: (worktreePath: string, relPath: string): Promise<void> =>
        ipcRenderer.invoke('draw:reveal', worktreePath, relPath),
      onEvent: (cb: (event: { worktreePath: string }) => void): (() => void) => {
        const listener = (_event: IpcRendererEvent, event: { worktreePath: string }): void => cb(event)
        ipcRenderer.on('draw:changed', listener)
        return () => ipcRenderer.removeListener('draw:changed', listener)
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
