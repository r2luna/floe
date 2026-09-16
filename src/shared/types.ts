// Types shared across the main, preload, and renderer processes.

import type { ArtifactSpec } from './artifact'
export type { ArtifactSpec } from './artifact'

/**
 * The group a project falls into when none was chosen. Always exists, always
 * sorts first, and can be neither renamed nor deleted — deleting a group has to
 * have somewhere to put its projects.
 */
export const DEFAULT_GROUP = 'Projects'

/**
 * The pinguim heads a user can pick as the app's mark, in the order Settings
 * shows them. Shared because `[appearance] penguin` is validated against this
 * list in main and drawn from it in the renderer — the art itself lives in
 * `renderer/src/PenguinHead.tsx` and `renderer/src/assets/penguins/`.
 */
export const PENGUIN_HEADS = [
  'classic',
  'sleepy',
  'surprised',
  'focused',
  'skeptical',
  'cool',
  'wink',
  'cute',
  'zen',
  'robot',
  'punk',
  'tired',
  'happy',
  'angry',
  'dizzy',
  'dreamer',
  'ninja',
  'scanner',
  'spark',
  'sad',
  'crown',
  'tuft',
  'antenna',
  'chipped'
] as const

export type PenguinHeadId = (typeof PENGUIN_HEADS)[number]

/**
 * The tones a pinguim head can be drawn in. Each one is a CSS variable with a
 * dark and a light value (see `--pen-*` in index.css), so a pick that reads well
 * at night still reads well when the OS flips at sunrise.
 */
export const PENGUIN_COLORS = [
  'accent',
  'ice',
  'green',
  'blue',
  'violet',
  'amber',
  'red',
  'plain'
] as const

export type PenguinColorId = (typeof PENGUIN_COLORS)[number]

/**
 * How the transcript arranges a turn — `[appearance] chat-layout`.
 *
 * Layout only: every one of these renders the same DOM, and the difference is
 * a block of rules in index.css keyed off `data-chat-layout` on <html>. Nothing
 * in the renderer branches on the value, which is why adding one is a stylesheet
 * change rather than a component change.
 *
 * `classic` is the IRC log the app shipped with — one column, no air between
 * turns. The other six each pull one lever on it: a nick gutter, a surface per
 * turn, a rule between turns, a timeline rail, work banded away from speech,
 * and the nick as a label line above the words.
 */
export const CHAT_LAYOUTS = [
  'classic',
  'gutter',
  'surfaces',
  'ruled',
  'rail',
  'split',
  'labels'
] as const

export type ChatLayoutId = (typeof CHAT_LAYOUTS)[number]

/**
 * Which themes get the translucent window — `[appearance] transparency`.
 *
 * Four values rather than a boolean because the glass is a different proposition
 * in each theme: dark tints a blur and stays legible, light washes it out. So
 * the choice is per theme — `dark` or `light` glasses that one and leaves the
 * other solid, `all` glasses both, `off` is the opaque app.
 *
 * Like CHAT_LAYOUTS this is a stylesheet switch: appearance.ts resolves it
 * against the theme in force and puts `data-vibrancy` on <html>. The window
 * itself is made non-opaque in main for anything but `off` — see windowOptions.
 */
export const TRANSPARENCY = ['off', 'dark', 'light', 'all'] as const

export type TransparencyId = (typeof TRANSPARENCY)[number]

/**
 * The sounds a finished turn can play, in the order Settings cycles them.
 * Shared because `[notifications] sound` is validated against this list in main
 * and synthesized from it in the renderer (`renderer/src/sounds.ts`) — the
 * sounds are Web Audio recipes, not files, so this list is all there is.
 */
export const NOTIFY_SOUNDS = ['off', 'chime', 'ping', 'pop', 'bell', 'marimba', 'tada'] as const

export type NotifySoundId = (typeof NOTIFY_SOUNDS)[number]

export interface Project {
  path: string
  name: string
  group: string
  // Read-only projects open files in the rendered reader (markdown/image/text)
  // instead of nvim — see FileReader in the renderer. Used for browsing vaults
  // (e.g. an Obsidian workspace) without dropping into an editor.
  readOnly?: boolean
  // Pinned projects stay on the projects rail even with no activity today — so a
  // project you want one click away (e.g. a read-only vault that never runs a
  // session) is always there. See the rail union in App's railItems.
  pinned?: boolean
  // Which machine this project lives on ('local', or an attach target). Stamped
  // by the renderer when it builds the rail's union — never persisted by main,
  // which only ever knows about its own projects. Absent = local.
  backend?: string
  // The synthetic "Home" workspace: not a git repo, not stored in projects.json.
  // It exists so the app can boot straight into a terminal in the user's home
  // directory and so "Switch project…" can return there. Terminal-only — git
  // chrome (worktrees/diffs/files) doesn't apply.
  home?: boolean
  // Containerized dev environment config. When set (mode 'container'),
  // provisioning brings each worktree up as a Docker container (serversideup PHP
  // image) wired to the shared support stack instead of the host-native recipe.
  // Absent = today's host-native behavior (Herd + host PHP/DB). See provision.ts.
  env?: ProjectEnvConfig
}

/**
 * What Floe can say about a path BEFORE it is added — the add-project dialog's
 * preview pane, answered while you type.
 *
 * Deliberately the same checks addProjectByPath runs, in the same order: a pane
 * that said "repo ✓" for a path the add then refuses would be worse than no
 * pane at all. No `~` expansion here for exactly that reason — the add does not
 * expand it either.
 */
export interface PathProbe {
  /** The path as asked about, so a stale answer can be dropped. */
  path: string
  exists: boolean
  isRepo: boolean
  /** The repo root, when the path points inside a repo rather than at its top. */
  root?: string
  /** What the project would be called — the root's basename. */
  name?: string
  /** The branch the main worktree is on. */
  branch?: string
  /** How many worktrees come with it: they are added along with the project. */
  worktrees?: number
  /** Already a Floe project — adding it again only re-opens the one you have. */
  added?: boolean
  /** The group it already sits in, when it is already added. */
  group?: string
}

// Per-project containerized environment. Only the fields you can't reliably infer
// live here — PHP version above all (the reason to containerize); package manager
// and DB engine carry sane defaults inferred elsewhere but can be pinned.
export interface ProjectEnvConfig {
  mode: 'container'
  runtime: 'laravel'
  php: '8.2' | '8.3' | '8.4' | '8.5'
  packageManager: 'bun' | 'pnpm' | 'yarn' | 'npm'
  db: 'mysql' | 'postgres'
  // Web DB admin (DBGate) is part of the shared support stack; this just notes
  // whether the project wants it surfaced. Defaults on.
  dbAdmin?: boolean
}

export interface Worktree {
  branch: string
  path: string
  isMain: boolean
  base?: string
  note?: string
  // A one-line AI summary of what this worktree is about, generated from its
  // spec.md with Haiku and cached in a `.gw-desc` marker file. Shown as a
  // subtitle under the branch name so a cryptic branch reads at a glance.
  desc?: string
  dirty?: boolean
  // Merge is blocked for this worktree (like the main worktree), configured via a
  // `.gw-nomerge` marker file in the worktree. Toggled from the command palette.
  blocked?: boolean
  // The single synthetic worktree of the Home workspace (see Project.home).
  home?: boolean
}

/**
 * A worktree's git dirt, for the sidebar row: `+2 ~5 −1 ⇡2 ⇣3`.
 *
 * Counted per file and by what happened to the file (new / edited / removed),
 * not by staged vs unstaged: the row answers "what do I still have to commit,
 * and what do I still have to push".
 */
export interface WorktreeStatus {
  added: number // new files — untracked or staged-new
  modified: number
  deleted: number
  ahead: number // commits to push
  behind: number // commits to pull
  upstream: boolean // has a tracking branch at all
}

// The live status the projects rail shows for a project the user worked today:
// `ask` — a session is waiting on the user (an unanswered question);
// `pending` — the agent is mid-turn (a session file was touched very recently);
// `done` — idle/finished. The most urgent status across the project's sessions
// wins. Computed in main (claudeSessions.computeProjectActivity) so the rail can
// stay live for projects the user is NOT currently inside.
export type ProjectActivityStatus = 'ask' | 'pending' | 'done'

export interface ProjectActivity {
  path: string // the project root path (matches Project.path)
  status: ProjectActivityStatus
  sessionsToday: number // sessions whose file was touched since the start of today
  activeCount: number // of those, how many are within the live "active" window
  askCount: number // of those, how many are blocked on an unanswered question
  lastActivityAt: number // most recent session mtime (epoch ms) — recency for the switcher
}

// A session, anywhere across all projects, currently blocked on an unanswered
// question — feeds the ⌘/ switcher's "NEEDS YOU" section and the Home strip.
// Detected from the on-disk transcript, so it's cross-project; permission-pending
// is a live renderer concept and is layered in only for the active project.
export interface NeedsYouSession {
  projectPath: string
  projectName: string
  worktreePath: string
  branch: string
  sessionId: string // Floe session id, so ⏎ can jump straight to it
  title: string
  lastActivityAt: number // session mtime (epoch ms) — "12m" ago
  additions: number // worktree diff vs its review base (`+310`)
  deletions: number // (`−64`)
}

// Every session on disk, anywhere — the ⌘J jump palette's index. Same walk as
// NEEDS YOU above, minus the unanswered-question filter and the per-worktree
// diff stat, so it stays cheap enough to fetch on demand when the palette opens.
// `running` is disk-inferred (a live agent connection); the renderer overrides it
// with the truth for the project it actually has loaded.
export interface JumpSession {
  projectPath: string
  projectName: string
  worktreePath: string
  branch: string
  sessionId: string
  // The CLI's own name for the session, when it has one. A session answers to
  // two ids for its whole life and the chat panel is keyed by `claudeId ?? id`
  // (see enterWorktree), so a caller that wants to OPEN the row needs both.
  claudeId?: string
  title: string
  lastActivityAt: number // session mtime (epoch ms) — drives "12m" and the sort
  running: boolean
}

// One row of the `active` panel: every machine's most recent sessions in one
// list, so "who is waiting on me" is a question you ask once instead of once
// per project. A JumpSession plus the one thing its index leaves out — whether
// the session is blocked on YOU — which costs a per-session transcript read and
// is therefore paid only for the handful of rows that survive the sort.
// `backend` is filled in by the renderer, which is the only side that knows
// which machine answered.
export interface ActiveSession extends JumpSession {
  needsYou: boolean
  /** The machine this row came from — `local`, or a paired backend's id. */
  backend?: string
}

// Pushed to the renderer when a project's worktree set changes outside the normal
// UI flow (e.g. the MCP `create_worktree` tool), so the sidebar can refresh its
// list/count without a manual project switch.
export interface WorktreesUpdatedEvent {
  /** Repo root path of the project whose worktrees changed. */
  project: string
  /** The fresh, full worktree list for that project. */
  worktrees: Worktree[]
}

// --- MCP control server (an agent drives Floe from inside a session) --------
// An MCP server runs in the main process (see main/mcpServer.ts). Each spawned
// `claude` session gets a per-session `--mcp-config` whose HTTP url carries the
// session's own key as a token (/mcp/<key>), so a tool call knows which session
// made it (the "caller"). Tools that mutate state or read data run in main;
// tools that drive the UI are forwarded to the renderer as an `mcp:command`.

// A command the main process asks the renderer to perform on the caller's
// behalf (over the `mcp:command` channel). Commands carrying a `requestId`
// expect an answer back over `mcp:command-result`; the rest are fire-and-forget.
export type McpCommand =
  // Bring a session on screen: select its project/worktree and open its chat
  // panel. `sessionId` is the renderer's session key (`claudeId ?? id`).
  | {
      kind: 'select_session'
      callerKey: string
      sessionId: string
      title: string
      worktreePath: string
      projectPath?: string
    }
  // Enter a project — the sidebar selection a `floe <path>` (or `open_project`)
  // asks for once the repo is registered. No worktree: the project's own
  // restore picks up where the user left it.
  | { kind: 'select_project'; callerKey: string; projectPath: string }
  // Open a plan file in the reader panel, rooted at its worktree.
  | { kind: 'open_plan'; callerKey: string; worktreePath: string; relPath: string }
  // Open an .excalidraw scene in the drawing panel, rooted at its worktree —
  // how an agent puts the diagram it just drew on screen.
  | { kind: 'open_drawing'; callerKey: string; worktreePath: string; relPath: string }
  // Start the guided merge for a worktree: navigate to its project if needed,
  // then bring the checklist panel up (useMerge.start). Answered once the flow
  // starts — or with the refusal reason (main worktree, blocked, no project).
  | {
      kind: 'start_merge'
      callerKey: string
      requestId: string
      worktreePath: string
      projectPath: string
    }
  // Open the browser panel in the CALLER's session, not the one on screen.
  // `sessionKeys` is every name that session answers to (identity.ts), empty
  // when the caller is no Floe session — then it opens where you are.
  | { kind: 'open_browser'; callerKey: string; sessionKeys: string[] }
  // Run a registry command (the same ids the palette and the keymap dispatch).
  | { kind: 'run_command'; callerKey: string; requestId: string; commandId: string; arg?: string }
  // List the registry's commands with their palette metadata and availability.
  | { kind: 'list_commands'; callerKey: string; requestId: string }

// One third-party MCP server in Floe's own registry (config/mcpServers.ts) —
// `~/.config/floe/mcp.toml` (global) or `<repo>/.floe/mcp.toml` (project, with its
// credentials merged in from the gitignored `.floe/local/mcp.toml`).
// Floe owns the list and projects it into each spawned harness's config
// (mcpConfigFor), the same way skills are owned once and expanded per turn.
export interface McpServerEntry {
  name: string
  scope: 'global' | 'project'
  transport: 'http' | 'stdio'
  /** http: the server url. */
  url?: string
  /** stdio: the command to run, with its args. */
  command?: string
  args?: string[]
  /** stdio: environment the server process needs — API keys, mostly. */
  env?: Record<string, string>
  /** http: headers every request carries — bearer tokens, mostly. */
  headers?: Record<string, string>
  enabled: boolean
  /** Absolute path of the mcp.toml the entry lives in, for opening it to edit. */
  file: string
  /** Position in that file's `[[server]]` run — what writes address. */
  index: number
}

// One registry command as `list_commands` reports it — the palette row's data.
export interface McpUiCommand {
  id: string
  /** Set on a row that stands for one argument of a parametrized command — pass it back as `run_command`'s `arg`. */
  arg?: string
  title: string
  group: string
  /** What presses it, read from the live keymap. Absent when nothing does. */
  keys?: string
  enabled: boolean
}

// The renderer's reply to a requestId-carrying `mcp:command`, sent back over
// `mcp:command-result` so the waiting tool can return a real answer.
export interface McpCommandResult {
  requestId: string
  ok: boolean
  error?: string
  /** `list_commands` answers with its `McpUiCommand[]` here. */
  commands?: McpUiCommand[]
}

// A remote branch not yet checked out locally, offered in the new-worktree
// picker. Picking one creates a local branch tracking `ref`.
export interface RemoteBranch {
  /** Short branch name, with the remote prefix stripped (e.g. "feature/foo"). */
  name: string
  /** Full remote-tracking ref to fork the local branch from (e.g. "origin/feature/foo"). */
  ref: string
}

// --- Terminals (split pane tree) -------------------------------------------

// The pane tree for one terminal item: a leaf is a single PTY, a split arranges
// children in a row (side by side) or column (stacked). Lives in shared so both
// the renderer (TerminalSplit / App) and main (sessionStore snapshots) agree.
export type PaneLeaf = { kind: 'leaf'; termId: string }
// `sizes` are flex-grow weights, one per child (px measured at drag time works
// fine — only the ratio matters). Absent = every child shares the space equally.
export type PaneSplit = { kind: 'split'; dir: 'row' | 'col'; children: PaneLayout[]; sizes?: number[] }
export type PaneLayout = PaneLeaf | PaneSplit

// --- Per-project / per-worktree window state (restore "o mundo do projeto") --
// Persisted by main/sessionStore (and re-exported there); lives in shared so the
// renderer can import it without reaching into main.

// The window chrome the user thinks of as "the world of this project" — panel
// visibility, the right-pane mode, the tasks filter, and which sidebar worktrees
// are collapsed. Kept per-project so switching back restores the same shell.
export interface ProjectUiState {
  leftVisible?: boolean
  rightVisible?: boolean
  rightMode?: 'files' | 'review' | 'plans' | 'tasks' | 'pr' | 'http' | 'database' | 'commands'
  tasksState?: 'open' | 'all'
  collapsedWorktrees?: Record<string, boolean> // keyed by worktree path
}

// One open terminal item, captured so it can be re-attached on return: its split
// tree, the focused pane, and the title. The PTYs themselves live in the main
// process (terminal.ts) and survive a project switch — this just records which
// ones were open and how they were arranged.
export interface TerminalSnapshot {
  id: string // term item id: term:<worktreePath>#<n>
  title: string
  layout: PaneLayout
  activePane: string // focused PTY id within this terminal
}

// The restorable interior of a worktree: its open terminals and composer drafts.
// Per-worktree (not per-project) because PTYs are keyed by worktree path and a
// draft belongs to a session/worktree regardless of which project opened it.
export interface WorktreeUiState {
  terminals?: TerminalSnapshot[]
  activeTerminalId?: string | null
  drafts?: Record<string, string> // draftKey -> text (key = sessionId ?? worktreePath)
  // Most-recently-opened files (worktree-relative paths, newest first). Backs the
  // "Recently opened" group the ⌘P finder floats to the top. Capped on write.
  recentFiles?: string[]
}

// --- Files (worktree directory tree) ---------------------------------------

// One node in the worktree's file tree. Directories carry their children; files
// don't. `relPath` is POSIX-style and relative to the worktree root — it's what
// we hand to nvim (`:edit <relPath>`) and what the fuzzy finder matches on.
export interface FileNode {
  name: string
  relPath: string
  type: 'file' | 'dir'
  children?: FileNode[]
}

// Where a symbol is defined, as go-to-definition finds it (main/definitions.ts).
// `line` is 1-based; `text` is the defining line, trimmed, for a picker to show.
export interface SymbolDefinition {
  path: string
  line: number
  text: string
}

// A staged filesystem mutation from the Files panel, applied as a batch when the
// user synchronizes (mini.files `=`). Paths are POSIX, worktree-relative; a
// `create` path ending in `/` makes a directory. `rename` covers both renaming
// in place and moving to another directory; `copy` duplicates.
export type FileOp =
  | { kind: 'create'; path: string }
  | { kind: 'delete'; path: string }
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'copy'; from: string; to: string }

/** Live state of the native browser preview hosted beside the renderer. */
export interface BrowserState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error?: string
}

/** The workspace machine whose network the local browser preview represents. */
export interface BrowserTarget {
  id: string
  /** Hostname of a remote backend. Omitted for the machine holding the window. */
  host?: string
}

/** The readable and interactive page surface returned to an agent. */
export interface BrowserSnapshot {
  url: string
  title: string
  text: string
  elements: Array<{
    ref: string
    tag: string
    role?: string
    name: string
    href?: string
    type?: string
  }>
}

// The content of a single file, read for the read-only reader. Text files come
// back as UTF-8 `text`; images as a `dataUrl` (base64) ready for an <img src>;
// anything too large or not displayable is `binary` (the reader shows a notice).
export type FileContent =
  | { kind: 'text'; text: string }
  | { kind: 'image'; dataUrl: string }
  | { kind: 'pdf'; dataUrl: string }
  // A deck read as words rather than as slides — see main/office.ts. The panel
  // shows this immediately and swaps in the rendered PDF if LibreOffice turns
  // out to be installed (files:renderDoc).
  | { kind: 'slides'; slides: Slide[] }
  | { kind: 'binary' }

// One slide of a .pptx, as text: its title placeholder, its other paragraphs,
// and the speaker notes attached to it.
export interface Slide {
  n: number
  title?: string
  lines: string[]
  notes?: string
}

// A video the chat found named in a message and can play: the file is there,
// and `url` is the `floe-media://` address that streams it (see main/media.ts).
// Never the bytes — a recording is tens of megabytes and is served, not carried.
export interface MediaFile {
  url: string
  mediaType: string
  size: number
  name: string
  path: string
}

// A slice of that same video, carried instead of served — the one case where
// the bytes DO come through the wire. A browser tab can only fetch from the
// daemon that served the page, so a recording that lives on another paired
// machine is pulled off it in chunks and re-served (see main/media.ts's
// `readMediaChunk` and the server plugin's `/media/<backend>/…`).
export interface MediaChunk {
  mediaType: string
  /** The whole file's size, so a range answer can name a total. */
  size: number
  start: number
  /** Inclusive, and `start - 1` when the slice came back empty. */
  end: number
  base64: string
}

// A slice of a file on its way to the machine the user is at — what `o` does
// when the file is on another machine (see main/files.ts `readFileChunk`).
export interface FileChunk {
  /** The file's own name, so the copy keeps it. */
  name: string
  /** The whole file's size, so the caller knows when it is done. */
  size: number
  start: number
  /** Inclusive, and `start - 1` when the slice came back empty. */
  end: number
  base64: string
}

// --- Review (changed files + diff comments) --------------------------------

// One entry in the changed-files review list — a file that differs from the
// worktree's base (committed, uncommitted, or untracked). `relPath` is POSIX,
// relative to the worktree root.
export interface ChangedFile {
  relPath: string
  status: 'added' | 'modified' | 'deleted' | 'untracked'
  additions: number
  deletions: number
  // A cheap content signature (size + mtime of the working file). A "viewed"
  // mark holds only while this matches what it was when marked — so the mark
  // clears itself the moment the file changes again, GitHub-style.
  fingerprint: string
  // True when the file's diff against the review base is already committed on
  // this branch (no working-tree/index change left). False when it still has
  // uncommitted edits or is untracked — the review list groups on this so a
  // commit moves files from "Not committed" to "Committed".
  committed: boolean
}

// One file touched by a single commit (from `git log --name-status --numstat`).
// Same status/counts shape as ChangedFile, minus the working-tree-only fields.
export interface CommitFileRef {
  relPath: string
  status: 'added' | 'modified' | 'deleted' | 'untracked'
  additions: number
  deletions: number
}

// One commit on this branch since the review base, with the files it touched.
// Powers the "Commit Story" timeline and the by-commit grouping of the Changes
// list — reading them top-to-bottom follows the reasoning line of the branch.
// Merge commits carry no per-file diff (git omits it), so `files` is empty and
// `isMerge` is set so the UI can render them as plain waypoints.
export interface ReviewCommit {
  hash: string // short hash (%h)
  subject: string
  author: string
  relDate: string // "2 hours ago" (%ar)
  isMerge: boolean
  additions: number // totals across files
  deletions: number
  files: CommitFileRef[]
}

// A pending review comment anchored to a line range in a file's diff. `side`
// says whether the anchor is the new ('+') or old ('-') side of the diff; the
// line numbers are 1-based in that side's file.
export interface ReviewComment {
  id: string
  relPath: string
  side: 'new' | 'old'
  startLine: number
  endLine: number
  // The diff text the comment is anchored to, kept so the submitted message can
  // quote it without re-reading the file.
  snippet: string
  body: string
  // Set for comments that came from an external source (e.g. existing GitHub PR
  // review comments) — the login that authored it. When present the diff view
  // renders it read-only (no "remove" affordance).
  author?: string
}

// --- Plans (Claude Code plan-mode files saved under .floe/plans/) --------

// A plan markdown file Claude saved while in plan mode (see the `plansDirectory`
// setting, pointed at `.floe/plans`). That directory is gitignored, so plans
// never appear in the normal file tree — this surfaces them for review. Like a
// FileNode, `relPath` is POSIX and relative to the worktree root, so it opens in
// nvim the same way (`:edit <relPath>`).
export interface PlanFile {
  name: string
  relPath: string
  mtime: number // epoch ms — newest-first ordering and the "time ago" label
  // Set for files coming from a spec-driven pipeline folder (`specs/<branch>/`):
  // the folder name, which drives a section header in the Plans panel so the
  // pipeline's docs read as a group. Absent for plain `.floe/plans/` plans.
  group?: string
}

// --- Draw (Excalidraw scenes under .floe/draw/ and specs/<branch>/) --------

// One `.excalidraw` scene file in a worktree, as the draw panel lists it. Like a
// PlanFile, `relPath` is POSIX and relative to the worktree root. `group` is set
// for scenes coming from a spec folder (`specs/<branch>/`), so the list headers
// them the way the plans list does.
export interface DrawFile {
  name: string
  relPath: string
  mtime: number // epoch ms — newest-first ordering and the "time ago" label
  elements: number // live (not isDeleted) element count, for the row's subtitle
  group?: string
}

/**
 * One Excalidraw element, as it sits in the file.
 *
 * Structurally typed rather than imported from `@excalidraw/excalidraw`: this
 * type is read by the MAIN process, which must never pull a React package into
 * its graph. The four fields named here are the ones Floe itself reasons about —
 * `id` to match, `version`/`versionNonce` to reconcile (see mergeElements), and
 * `isDeleted` because a removal is an upsert like any other. Everything else is
 * the Excalidraw model, carried through untouched.
 */
export interface DrawElement {
  id: string
  type: string
  version: number
  versionNonce: number
  /** Epoch ms of the last change — what the isDeleted purge ages out. */
  updated: number
  isDeleted?: boolean
  [key: string]: unknown
}

// A whole scene, in the on-disk `.excalidraw` shape (schema v2) so a file Floe
// wrote opens in excalidraw.com and in any other tool that reads the format.
export interface DrawScene {
  type: 'excalidraw'
  version: 2
  source: string
  elements: DrawElement[]
  appState: Record<string, unknown>
  files: Record<string, unknown>
}

/**
 * The only thing anyone is allowed to write: a set of complete elements to merge.
 *
 * There is deliberately no `deletedIds`. Erasing is `isDeleted: true` with a
 * bumped `version`, which is an upsert like any other — a list of bare ids would
 * carry no version, so the main process would have to invent one and a stale
 * removal could beat a newer edit. One field, one rule. See mergeElements.
 */
export interface DrawDelta {
  /** Created, changed or deleted elements. Complete, with version/versionNonce. */
  upserts: DrawElement[]
}

// What an agent writes through `draw_elements`: only the parts that carry
// meaning. src/main/draw/skeleton.ts expands one of these into a complete,
// valid Excalidraw element — defaults, seeds, bound label, arrow bindings.
export interface DrawSkeleton {
  id?: string
  type: 'rectangle' | 'ellipse' | 'diamond' | 'arrow' | 'line' | 'text' | 'frame'
  x?: number
  y?: number
  width?: number
  height?: number
  /** A caption bound inside a shape (or on an arrow) — becomes a text element. */
  label?: string
  /** The content of a standalone `text` element. */
  text?: string
  /** For an arrow/line: the id of the shape it starts at. */
  start?: string
  /** For an arrow/line: the id of the shape it ends at. */
  end?: string
  strokeColor?: string
  backgroundColor?: string
}

// Where a new scene is created. `draft` is the gitignored .floe/draw/; `spec`
// is specs/<branch>/, versioned alongside the spec it illustrates.
export type DrawScope = 'draft' | 'spec'

// One implementation phase parsed from a spec pipeline's `specs/<branch>/tasks.md`
// — a `## Phase N: …` heading and the tally of its `- [ ]` / `- [x]` task
// checkboxes. ds-implement ticks those boxes as it lands each task, so polling
// this file drives the live sub-checklist nested under the trilho's `implement`
// step. Sections with no checkboxes (Dependencies, Parallel Example, …) are not
// phases and are dropped by the parser.
export interface ImplementPhase {
  title: string // the heading text after "Phase N:", e.g. "Setup (Shared Schema & Model)"
  done: number // checked task boxes
  total: number // total task boxes (always > 0 for a returned phase)
}

// A pending review note on a rendered plan. Unlike a ReviewComment (anchored to a
// diff line range) a plan note is anchored to a top-level markdown block by its
// index in render order; `quote` is the text the user is commenting on (the whole
// block, or a finer mouse selection within it) and is kept so the message sent to
// Claude can quote it.
export interface PlanComment {
  id: string
  planPath: string
  blockIndex: number
  quote: string
  body: string
}

// A note anchored to a passage of the conversation itself — the third shape of
// review comment, after ReviewComment (a diff line range) and PlanComment (a
// markdown block). This one is finer than both: the anchor is a character span,
// so a note can sit on half a sentence of an assistant reply.
//
// Why the anchor is `itemIndex` and not a block id: `Block.id` comes from
// `nextId()`, a runtime counter, and `itemToBlock()` re-mints every id on
// reload — a note pinned to one would land on the wrong text (or nowhere) the
// second time the session opens. The persisted transcript is append-only and
// never reorders, so a position in it is stable across reloads.
//
// `quote` is both the text sent to the agent and a drift check: if the block's
// text no longer matches at [start, end), the anchor moved and the note renders
// unattached rather than highlighting the wrong passage.
export interface ThreadComment {
  id: string
  sessionKey: string
  itemIndex: number // position in the persisted transcript, not Block.id
  start: number // character offset into the rendered block's flattened text
  end: number
  quote: string
  body: string
  // Set once the note has gone to the agent. Sent notes are kept and stay
  // visible — the thread doubles as the record of the review, so unlike
  // submitReview()/submitPlanReview() this list is never drained.
  sentAt?: number
}

// --- Queries (a side conversation opened off a session) ---------------------

// `@codex analisa isso` with Claude mid-turn opens a QUERY: its own panel, its
// own transcript, running in parallel instead of queueing behind the turn in
// flight. It is read-only by construction, and three actions close the cycle —
// merge (the conversation becomes the session's context), peek (the session
// reads it with nothing closing) and discard.
//
// The registry is small on purpose. Everything a query needs to RUN it already
// has by being an agent key (`sessionId~harness`, see shared/queries.ts); this
// only records the things a key cannot carry: that it is open, what it is
// running on, and — after a restart — which Claude session on disk is its own.
/**
 * The stamp a query leaves on the CHAT's transcript.
 *
 * The conversation itself belongs to the query's own panel — merging is about
 * the model reading it, not about you re-reading it — so what the chat keeps is
 * one line: which query, what became of it, and how much went over. Structured
 * rather than parsed back out of the summary text, because the fold that draws
 * it needs the key to fetch the conversation and the outcome to know whether to
 * offer `reopen`.
 */
export interface QueryMark {
  /** The query's agent key — what `query:transcript` and `reopen` are given. */
  key: string
  harness: string
  outcome?: 'merged' | 'discarded'
  /** How many entries went to the chat. Absent for "opened"; 0 for a discard. */
  entries?: number
}

export interface Query {
  /** The agent key it runs under: `queryKey(sessionId, harness)`. */
  id: string
  sessionId: string
  harness: string
  model?: string
  effort?: Effort
  mode: PermissionMode
  openedAt: number
  closedAt?: number
  outcome?: 'merged' | 'discarded'
  /**
   * Who opened it. A query is not only a thing a person opens: an agent can
   * open one over `send_message`, on a followup timer, or by writing `@codex`
   * into its own answer — so the panel says which, rather than letting a window
   * appear with nobody's name on it.
   */
  openedBy?: 'user' | 'agent'
  /**
   * The CLI's session id for THIS query, and the ones it has forked away from.
   *
   * A query key is not a session, so the session table cannot answer "what does
   * this resume into". Without these a query answered by Claude loses its own
   * history the moment the app restarts — and merge and peek then find nothing
   * to build a packet out of. Same trail, and the same reason, as
   * CreatedSession.claudeId / pastClaudeIds.
   */
  claudeId?: string
  pastClaudeIds?: string[]
}

// --- Attachments (images pasted or dropped into the composer) --------------

export interface ImageAttachment {
  id: string
  mediaType: string // e.g. "image/png"
  data: string // base64-encoded bytes, without the data: URL prefix
  name?: string
}

// A document (PDF or text-based file) dropped/pasted into the composer and sent
// as context, mirroring ImageAttachment. PDFs go to the API as base64 `document`
// blocks; text-based files as `document` blocks with a decoded text source.
export interface FileAttachment {
  id: string
  // 'pdf' → base64 document block; 'text' → text document block (decoded).
  kind: 'pdf' | 'text'
  mediaType: string // e.g. "application/pdf", "text/markdown"
  data: string // base64-encoded bytes, without the data: URL prefix
  name: string // file name — shown as a chip and used as the document title
}

/** What rode along with one message: the chips shown above the composer. */
export interface Attached {
  images: ImageAttachment[]
  files: FileAttachment[]
}

// A message the user lined up while the agent was busy. Queued messages drain
// one-per-turn into the same session, and can be edited or removed until sent.
export interface QueuedMessage {
  id: string
  text: string
  images?: ImageAttachment[]
  files?: FileAttachment[]
  // Force a specific model for this one message (e.g. commit on Sonnet),
  // overriding the session's current model when it fires. Omitted = session model.
  modelOverride?: string
  // Ride along in the same turn as the item directly above instead of waiting
  // for its own turn boundary. Off by default; the queue otherwise drains one
  // message per turn. A contiguous run of linked items merges into one send.
  linked?: boolean
}

// --- Agent (Claude Code) streaming ----------------------------------------

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'skip'

// Reasoning-effort level for the session, passed to `claude --effort`. Ordered
// lightest → heaviest; higher levels think longer before answering.
/**
 * How hard the harness is told to think, lightest first.
 *
 * The list, not just the type: main reads it out of floe.toml, the renderer
 * offers it in two menus, and `@codex:high` is told apart from a model name by
 * membership in it. One array, so those three can never disagree.
 */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export type Effort = (typeof EFFORTS)[number]

export interface AgentRunOptions {
  permissionMode: PermissionMode
  model?: string
  effort?: Effort
  /**
   * Which runtime answers: 'claude' (or absent), 'codex', 'gemini', 'opencode',
   * 'lmstudio', 'ollama'. Stated rather than inferred from the model name —
   * `isCodexModel` guesses by exclusion, which was fine when Codex was the only
   * other runtime and sends an LM Studio model to `codex exec` now that it is
   * not.
   */
  provider?: string
  /**
   * The line as the user typed it, when that is not what was sent.
   *
   * A message addressed to `@codex` sends the rest — the handle is who it is
   * for, not part of the errand — and the transcript has to keep the whole
   * line, or reopening the session shows an answer from codex under a question
   * that never named it.
   */
  shown?: string
  /**
   * The panel that typed this message, so it can ignore the echo of its own
   * line while every OTHER viewer of the session renders it.
   *
   * A session is not watched in one place: a second window, and — since the
   * server plugin — a whole other machine, are reading the same chat. The
   * sender shows its line optimistically (useTranscript's `deliver`), so
   * without this id it would show it twice.
   */
  panel?: string
}

export interface AgentQuestionOption {
  label: string
  description?: string
}

export interface AgentQuestion {
  question: string
  header?: string
  multiSelect?: boolean
  options: AgentQuestionOption[]
}

// A tool-use permission request the CLI raised over the stdio control channel
// (enabled by `--permission-prompt-tool stdio`). The user answers allow/deny and
// we reply on the same channel so the tool runs (or is refused) — see main/agent.ts.
export interface AgentPermission {
  requestId: string // echo back in the control_response
  toolName: string
  summary?: string // a short, human-readable target (file path, command, …)
  remember?: boolean // the CLI offered a rule to save, so "don't ask again" can be honoured
}

// A subagent the session spawned via the Task/Agent tool. Claude Code runs these
// inside the same `claude` process (not separate OS processes), and streams their
// internal activity inline tagged with `parent_tool_use_id` — so we attribute each
// Claude model aliases (the Anthropic backend). Everything else the picker
// offers is a Codex model slug routed to the local `codex` CLI, so the
// claude/codex split — backend routing (main/index.ts), sidebar grouping, token
// gauge — is just "is it one of these aliases?". Keep in sync with the Claude
// group in the composer picker.
export const CLAUDE_MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const

// True when a session's model runs on the Codex backend (a gpt-* slug, or the
// legacy 'codex' value) rather than a Claude alias.
/**
 * How much of the context window a turn consumed, from an assistant message's
 * `usage`. Input, both cache figures and output — everything the model had in
 * front of it plus what it wrote.
 *
 * Lives in shared because two very different readers need the SAME arithmetic:
 * the live stream (main/agent.ts) and the on-disk transcript
 * (main/claudeSessions.ts). A second copy would drift, and the gauge would
 * jump the moment a reopened chat started a turn.
 */
export function contextTokens(usage: unknown): number {
  if (!usage || typeof usage !== 'object') return 0
  const u = usage as Record<string, unknown>
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return (
    n(u.input_tokens) +
    n(u.cache_creation_input_tokens) +
    n(u.cache_read_input_tokens) +
    n(u.output_tokens)
  )
}

export function isCodexModel(model?: string): boolean {
  return !!model && !(CLAUDE_MODELS as readonly string[]).includes(model)
}

// A Codex model as offered in the picker, read from codex's own model cache
// (~/.codex/models_cache.json) by main/codex.ts.
export interface CodexModel {
  slug: string // the `-m` value, e.g. "gpt-5.5"
  label: string // display name, e.g. "GPT-5.5"
  contextWindow: number // tokens — the Nk/Xk gauge denominator for this model
}

// Fallback context window when a Codex model's own is unknown (272k = current
// gpt-5.x family); the real value comes from the model cache per slug.
export const CODEX_CONTEXT_WINDOW = 272_000

// Context window per Claude model (tokens), for the "how full is the context"
// gauge. Codex models carry their own window in the model cache. Lives here
// because both the composer and the status bar read it.
export const CONTEXT_WINDOW: Record<string, number> = {
  opus: 1_000_000,
  sonnet: 1_000_000,
  haiku: 200_000,
  fable: 1_000_000
}

// Compact token counts: 412k, 1M, 1.2M.
export function fmtK(n: number): string {
  return n >= 1_000_000
    ? `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
    : `${Math.round(n / 1000)}k`
}

// event to its parent Task by the tool-use id and surface a live nested row. See
// main/agent.ts (detection) and the Sidebar (nested rendering).
export interface SubagentInfo {
  toolUseId: string // the Task/Agent tool_use id — the join key for its stream events
  agentType: string // the subagent type, e.g. "Explore", "general-purpose"
  description: string // the short task description from the Task input
  running: boolean // true between launch and its tool_result returning
  tokens: number // live context-token count from the subagent's own usage
  lastTool?: string // the tool the subagent is currently running (live subtitle)
}

export type AgentEvent =
  | { kind: 'session'; sessionId: string; model?: string } // model = concrete id the CLI resolved, e.g. "claude-opus-4-8"
  // Who is answering the turn that just started. Emitted by whoever starts it,
  // because a panel does not always start its own: an agent's `send_message`
  // can address `@codex` into a chat a person is watching, and without this the
  // reply is stamped with whatever that panel's picker last said.
  | { kind: 'turn'; provider?: string; model?: string; effort?: string; mode?: PermissionMode }
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string } // extended-thinking delta (streams before the text answer)
  // `query` is set only on the chat's own query chips — see QueryMark. It is
  // what lets the transcript draw a merged conversation as a fold you can open
  // and a discarded one as a line you can bring back, instead of prose.
  | { kind: 'tool'; name: string; summary?: string; query?: QueryMark }
  | { kind: 'image'; mediaType: string; data: string } // a tool returned an image (e.g. Read of a PNG)
  | { kind: 'question'; toolUseId: string; questions: AgentQuestion[] }
  | { kind: 'artifact'; spec: ArtifactSpec } // an inline decision panel (see shared/artifact.ts)
  | { kind: 'permission'; permission: AgentPermission }
  // Another Claude session spoke into this one (the CLI injects it as a user
  // turn). `from` is its nick — the transcript heads the line with it rather
  // than with the user's, because the user did not say this.
  | { kind: 'peer'; from: string; text: string }
  // What the USER said — the line that opened the turn, or one typed into it
  // while it ran (a steer).
  //
  // Broadcast, because a session has more than one viewer: another window, or
  // another machine over the server plugin's gate. Only the panel that typed it
  // is already showing it, and `panel` is how that one drops its own echo.
  //
  // Kept in the replay too: the CLI only writes a steer to the JSONL when it
  // absorbs it, which can be a whole tool call later, and until then this is
  // the only copy a panel mounting mid-turn can get.
  | { kind: 'steer'; text: string; at: number; panel?: string }
  | { kind: 'tokens'; tokens: number }
  // Parallel subagent lifecycle — start (launched), progress (live tokens / current
  // tool), done (its result returned). Multiple may run concurrently in one turn.
  // `harness` names the runtime that actually runs it — 'claude' for a Task
  // subagent, 'codex' for the bridge. Stated by the emitter rather than guessed
  // from the type: the transcript badges it, and a wrong badge is a lie about
  // where the work happened.
  | {
      kind: 'subagent-start'
      toolUseId: string
      agentType: string
      description: string
      harness?: string
    }
  | { kind: 'subagent-progress'; toolUseId: string; tokens: number; tool?: string }
  // `reply` is what the agent came back to say — the Task's tool_result, an
  // async agent's <task-notification> result, or the Codex bridge's answer. It
  // rides the done event because that is the only moment it exists in the
  // stream; the panel prints it as the agent's own line in the channel. `ms` is
  // the Codex bridge's alone: a Task row times itself from when it opened.
  | { kind: 'subagent-done'; toolUseId: string; reply?: string; ms?: number }
  // One answer from an `@all` fan-out, mirrored into the CHAT so the replies
  // can be read side by side. The conversation itself still belongs to that
  // harness's own query panel — this is the comparison, not the transcript.
  // Items sharing a `fanoutId` render as one block; see the Log.
  | {
      kind: 'fanout'
      fanoutId: string
      provider: string
      model?: string
      text: string
      /** The query it came from — what `follow` and `open` on that column act on. */
      query: QueryMark
    }
  | { kind: 'done'; ok: boolean }
  | { kind: 'error'; message: string }

export interface AgentEventEnvelope {
  key: string // session key the event belongs to
  event: AgentEvent
  // Per-session monotonic counter. A panel that mounts mid-turn fetches the
  // replay snapshot and uses this to drop the live events the snapshot already
  // contains (see agent.replay / useTranscript).
  seq: number
}

// What a panel opening mid-turn missed: the turn in flight, replayed. Text and
// reasoning deltas arrive pre-coalesced (one event per run), tools verbatim.
// Empty and not-running once the turn ends — the JSONL is the record then.
export interface AgentReplay {
  running: boolean
  lastSeq: number // seq of the last event folded into `events`
  startedAt?: number // epoch ms the turn began — a panel opening mid-turn times from here
  model?: string // concrete model id the CLI resolved for this turn
  /**
   * What this turn went out on, when it is not the session's own choice — a
   * message addressed to `@codex` in a Claude chat. A panel that opens
   * mid-turn has no other way to know: the picker says claude, and stamping
   * the replayed text with it would put codex's answer under Claude's name.
   */
  choice?: { provider?: string; model?: string; effort?: string; mode?: PermissionMode }
  events: AgentEvent[]
  /**
   * Every id this session answers to — Floe's own and the claudeId the CLI gave
   * it. A panel is keyed by ONE of them while the live conn is filed under
   * whichever it last spawned with, so a panel that only listens for its own
   * key goes deaf mid-turn: no text, and no `done` to take "is typing" back off.
   */
  names?: string[]
}

// --- Provisioning (setup checklist for a freshly created worktree) ---------

// A worktree comes out of git with only the tracked files — no .env, no
// vendor/, no node_modules. Provisioning runs the per-stack setup that makes it
// ready to work (copy .env, install deps, link Herd, start commands) and streams
// each step's progress to the checklist UI.
export type ProvisionStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface ProvisionStep {
  id: string // 'copy-env' | 'env-vars' | 'composer' | 'herd' | 'node-install' | 'commands' | 'start'
  label: string
  status: ProvisionStatus
  detail?: string // the command being run, or the error message on failure
}

export type ProvisionEvent =
  | { worktreePath: string; kind: 'plan'; branch: string; steps: ProvisionStep[] } // the full step list, all pending
  | { worktreePath: string; kind: 'step'; id: string; status: ProvisionStatus; detail?: string }
  | { worktreePath: string; kind: 'log'; id: string; text: string } // live output of a running step
  // The premise interview needs an answer before it can go on. The only event
  // that travels the other way too: the panel replies over `provision:answer`
  // with the requestId, which is how main knows which question was answered
  // when two worktrees are provisioning at once.
  | { worktreePath: string; kind: 'ask'; ask: ProvisionAsk | null }
  | { worktreePath: string; kind: 'done'; ok: boolean }

/**
 * A question a step is holding on, as the checklist draws it.
 *
 * `options` present makes it a pick (numbered 1-9, `t` to type instead);
 * absent makes it a text box. Answering with null skips the rest of the
 * interview — a premise nobody wanted to write is better than a half-written
 * one, and the file simply isn't created.
 */
export interface ProvisionAsk {
  /** The step holding on it — the row the question is drawn under. */
  stepId: string
  requestId: string
  question: string
  options?: string[]
  index: number // 1-based, for "2/3"
  total: number
}

// --- Slash commands (Claude Code commands + skills) ------------------------

export interface SlashCommand {
  name: string // the token inserted after "/", e.g. "code-review" or "git:commit"
  description?: string
  source: 'command' | 'skill'
  scope: 'user' | 'project'
  argumentHint?: string
}

// --- Claude Code built-in info panels (/usage, /mcp, /skills, /plugins) -----
// Surfaced by probing a headless `claude` process: /usage returns text, while
// MCP/skills/plugins come from the startup `init` event (the slash commands
// themselves are TUI-only). See main/claudeInfo.ts.

export interface ClaudeMcpServer {
  name: string
  status: string // e.g. "connected", "needs-auth", "failed", "pending"
}

export interface ClaudePlugin {
  name: string
  source?: string
}

// Codex rate limits, read from `codex app-server` (account/rateLimits/read).
// Two rolling windows: `primary` (~5h) and `secondary` (~weekly). See
// main/codex.ts getCodexUsage.
export interface CodexUsageWindow {
  usedPercent: number
  resetsAt?: number // unix seconds
  windowMins?: number // window length, e.g. 300 (5h) or 10080 (weekly)
}

export interface CodexUsage {
  planType?: string // e.g. "plus", "pro"
  primary?: CodexUsageWindow
  secondary?: CodexUsageWindow
}

export interface ClaudeInfo {
  model?: string
  version?: string // claude_code_version from the init event
  sessionId?: string
  cwd?: string
  permissionMode?: string
  apiKeySource?: string
  usageText?: string // text returned by the synthetic /usage command
  codexUsage?: CodexUsage // Codex rate limits, when the codex CLI is installed
  mcpServers: ClaudeMcpServer[]
  skills: string[]
  plugins: ClaudePlugin[]
  error?: string
}

// Context-window breakdown for a session, parsed from the built-in `/context`
// report (see main/claudeInfo.ts getContextUsage). "Free space" is excluded from
// `categories` — the bar renders it as empty track.
export interface ContextUsage {
  model?: string
  used?: number
  window?: number
  categories: { label: string; tokens: number }[]
  error?: string
}

// --- Topbar stats: AI usage % + combined memory -----------------------------
// AI usage is parsed from the /usage probe (see main/usageMonitor.ts); memory is
// sampled from app.getAppMetrics() + the RSS of spawned process trees (see
// main/systemStats.ts). Both are pushed to the renderer for the topbar widget.

export interface UsageWindow {
  pct: number // 0–100, percentage of the limit used
  resetsAt?: string // human reset hint, e.g. "Jun 13 at 1am (America/Denver)"
}

export interface UsageStats {
  session?: UsageWindow // the 5-hour rolling window ("Current session")
  week?: UsageWindow // "Current week (all models)"
  month?: UsageWindow // present only on plans that report a monthly limit
}

export interface MemoryStats {
  totalBytes: number // app processes + spawned Claude/terminal/command trees
}

// Signing in to the Claude account itself — the CLI's `/login`. See
// main/claudeAuth.ts. The shape is `claude auth status --json` verbatim, plus
// `error` for the cases where the CLI could not be asked at all.
export interface AuthStatus {
  loggedIn: boolean
  authMethod?: string // "claude.ai" | "console" | …
  apiProvider?: string
  email?: string
  orgId?: string
  orgName?: string
  subscriptionType?: string // "max" | "pro" | …
  error?: string
}

/**
 * What a runtime says about how much of your allowance is gone.
 *
 * Windows, not totals: the number that decides whether you can work right now
 * is "how close to the wall", and every runtime that has a limit expresses it
 * as one or more rolling windows.
 */
export interface HarnessUsage {
  /** The plan the numbers are against, when the runtime names one. */
  plan?: string
  windows: { label: string; usedPercent: number; resetsAt?: number }[]
}

// An AI runtime found on this machine, and what it can run. See
// main/localAgents.ts — everything is read from what the tool wrote to disk.
export interface LocalAgent {
  id: string
  label: string
  /** Where it was found, so the UI can say why it thinks you have it. */
  bin: string
  /**
   * Empty when the tool is installed but we cannot enumerate its models.
   *
   * `contextWindow` is the model's own limit, when the runtime states it — it
   * is what the chat's gauge counts against, so a 262k local model is not
   * measured against Claude's million.
   */
  models: { slug: string; label: string; contextWindow?: number }[]
  /**
   * Whether this runtime holds a working credential, read from what it wrote
   * to disk — absent for runtimes with nothing to sign in to (LM Studio).
   * `login` is the command that fixes a `signedIn: false`, run in the app's
   * own terminal because every one of these flows is interactive.
   */
  auth?: { signedIn: boolean; detail?: string; login: string }
}

// Lifetime stats for the signed-in account — the CLI's own `/stats` view,
// rolled up from ~/.claude/stats-cache.json. See main/claudeStats.ts.
export interface ClaudeStats {
  /** Active days only, oldest first. The renderer fills the empty ones in. */
  days: { date: string; messages: number }[]
  activeDays: number
  spanDays: number // days since the first session, active or not
  sessions: number
  messages: number
  longestSessionMs: number
  longestStreak: number
  currentStreak: number
  busiestDay?: { date: string; messages: number }
  favoriteModel?: string
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
  error?: string
}

export type ClaudeAuthEvent =
  | { kind: 'url'; url: string } // consent URL — the CLI opened it, this is the copy
  | { kind: 'signed-in' } // the CLI accepted the code and stored the token
  | { kind: 'timeout' } // gave up waiting for the paste
  | { kind: 'error'; message: string }

// Authenticating an OAuth MCP server from the info panel. See main/mcpAuth.ts.
export type McpAuthEvent =
  | { kind: 'url'; url: string } // authorization URL opened in the browser
  | { kind: 'connected' } // server flipped to Connected
  | { kind: 'timeout' } // gave up waiting for the user to finish
  | { kind: 'error'; message: string }

export interface McpAuthEnvelope {
  serverName: string
  // The worktree the login was started from — carried back so a listener can
  // paste the redirect to the right flow without assuming the user is still
  // looking at that worktree by the time consent finishes.
  worktreePath: string
  event: McpAuthEvent
}

export type MergeStepId = 'preflight' | 'merge' | 'resolve' | 'review' | 'commit' | 'fastforward' | 'database' | 'cleanup' | 'closebranch' | 'closetask'

// pending → running → done | error; 'blocked' = waiting on the user (review /
// confirm cleanup); 'skipped' = not needed (e.g. resolve on a clean merge).
export type MergeStepStatus = 'pending' | 'running' | 'done' | 'error' | 'blocked' | 'skipped'

export interface MergeStep {
  id: MergeStepId
  title: string
  status: MergeStepStatus
  detail?: string // conflict count, commit hash+subject, error message, …
}

// --- Guided worktree removal (step-by-step panel) --------------------------
// Mirrors the merge panel: a keyboard-driven right-pane checklist with two
// yes/no checkpoints — force-remove a dirty tree, then optionally delete the
// branch. Reuses the merge step status vocabulary.

export type RemoveStepId = 'preflight' | 'database' | 'site' | 'worktree' | 'branch'

export type RemoveStepStatus = MergeStepStatus

export interface RemoveStep {
  id: RemoveStepId
  title: string
  status: RemoveStepStatus
  detail?: string // change count, deleted-branch sha, error message, …
}

// What removePreflight learned about the worktree before we touch anything.
export interface RemovePreflight {
  ok: boolean
  branch?: string // the worktree's branch (undefined when detached)
  dirty: boolean // has uncommitted/untracked changes
  changes: string[] // porcelain lines (e.g. " M src/app.ts"), for display
  hasBranch: boolean // a real branch exists → we can offer to delete it
  merged: boolean // branch already merged into base → safe `-d` vs force `-D`
  /** Commits on the branch that base does not have — what `-D` would throw away. 0 when merged or unknown. */
  ahead: number
  /** The base those commits are counted against, when there is a branch. */
  base?: string
  message?: string // why ok is false
}

// Result of unlinking the worktree's Herd site. `unlinked` is false when the
// step was a safe no-op — no Herd, no Laravel, or nothing linked to begin with.
export interface UnlinkSiteResult {
  ok: boolean
  unlinked: boolean
  detail?: string
  message?: string // why ok is false
}

export interface RemoveBranchResult {
  ok: boolean
  message?: string
}

// Result of dropping a worktree's per-branch database (MySQL/MariaDB/Postgres).
// `dropped` is false when the step was a safe no-op — no DB configured, an
// unsupported engine, or the .env still points at the main checkout's database.
export interface DropDatabaseResult {
  ok: boolean
  dropped: boolean
  detail?: string
  message?: string // why ok is false
}

// --- Guided project setup (register a new project's commands) ---------------
// The checklist that runs when a project is added: does it already have
// commands, open a background session, watch the agent read the repo, wait for
// the user's pick, confirm what landed in commands.toml. Same shape and the
// same status vocabulary as the removal above — it is the same kind of thing,
// a chain of steps you watch — and the session it drives is the `setup-commands`
// built-in skill (config/builtinSkills.ts).

export type SetupStepId = 'preflight' | 'session' | 'discover' | 'choose' | 'register'

export type SetupStepStatus = MergeStepStatus

export interface SetupStep {
  id: SetupStepId
  title: string
  status: SetupStepStatus
  detail?: string // command count, the failure message, …
}
