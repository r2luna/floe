// Types shared across the main, preload, and renderer processes.

import type { ArtifactSpec } from './artifact'
export type { ArtifactSpec } from './artifact'

/**
 * The group a project falls into when none was chosen. Always exists, always
 * sorts first, and can be neither renamed nor deleted — deleting a group has to
 * have somewhere to put its projects.
 */
export const DEFAULT_GROUP = 'Projects'

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
  title: string
  lastActivityAt: number // session mtime (epoch ms) — drives "12m" and the sort
  running: boolean
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

// A staged filesystem mutation from the Files panel, applied as a batch when the
// user synchronizes (mini.files `=`). Paths are POSIX, worktree-relative; a
// `create` path ending in `/` makes a directory. `rename` covers both renaming
// in place and moving to another directory; `copy` duplicates.
export type FileOp =
  | { kind: 'create'; path: string }
  | { kind: 'delete'; path: string }
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'copy'; from: string; to: string }

// The content of a single file, read for the read-only reader. Text files come
// back as UTF-8 `text`; images as a `dataUrl` (base64) ready for an <img src>;
// anything too large or not displayable is `binary` (the reader shows a notice).
export type FileContent =
  | { kind: 'text'; text: string }
  | { kind: 'image'; dataUrl: string }
  | { kind: 'pdf'; dataUrl: string }
  | { kind: 'binary' }

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

// --- Pull requests (GitHub via `gh`, or Bitbucket Cloud via REST) -----------

// Which host backs the PR panel for a project — picked by the origin remote
// (github.com vs bitbucket.org). See main/pr/ for the provider registry.
export type PrProviderName = 'github' | 'bitbucket'

// One open PR in the PR review panel, normalized across providers. Some fields
// are GitHub-shaped and inert on Bitbucket Cloud: `isDraft` is always false and
// `mergeable` always null there (no cheap equivalents), and `reviewDecision` is
// derived from Bitbucket's per-participant approvals into the same string set.
export interface PullRequest {
  number: number
  title: string
  author: string
  headRefName: string
  baseRefName: string
  isDraft: boolean
  // GitHub's overall review decision: APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED
  // (or null when none applies). Surfaced as a chip in the list.
  reviewDecision: string | null
  // MERGEABLE / CONFLICTING / UNKNOWN — gates whether merge is worth offering.
  mergeable: string | null
  updatedAt: string
  url: string
  additions: number
  deletions: number
  changedFiles: number
  // Viewer-relative flags that drive the panel's review-queue grouping. Both are
  // false when the viewer can't be identified (e.g. a Bitbucket token without the
  // `read:account` scope) — then the panel falls back to a flat list.
  isAuthor: boolean // the viewer opened this PR
  needsMyReview: boolean // the viewer is a requested reviewer who hasn't reviewed yet
}

// One changed file in a PR, carrying its unified-diff `patch` so the diff view
// can render it without a checkout. `status` is GitHub's
// (added/modified/removed/renamed), mapped to the ChangedFile status set.
export interface PrFile {
  relPath: string
  status: 'added' | 'modified' | 'deleted' | 'untracked'
  additions: number
  deletions: number
  // The unified diff hunks for this file (the REST API's `patch` field). Starts
  // at the first `@@` — parseUnifiedDiff skips the file-header preamble anyway.
  patch: string
}

// Whether a PR workflow applies to a project root and is usable. Mirrors
// TasksStatus so the panel can show the same actionable empty states.
export interface PrStatus {
  available: boolean
  provider?: PrProviderName // which host resolved (absent when none applies)
  source?: string // "owner/repo" or "workspace/repo"
  reason?: string // why it's unavailable (no remote, not authed, …)
  // The resolved viewer's display name. Present only when the panel could
  // identify "you" — its presence switches the list into review-queue grouping
  // (needs-your-review → your-PRs → other). Absent → flat list.
  viewer?: string
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

// --- HTTP client (.http files, PhpStorm-style) ------------------------------

// One .http file discovered under the worktree. Like PlanFile, `relPath` is
// POSIX and worktree-relative. `group` is the top-level directory (e.g. "api"
// for api/users.http; absent for files sitting at the worktree root), which the
// HTTP list headers on. `isEnv` marks the http-client.env.json /
// http-client.private.env.json environment files so the list can badge them.
export interface HttpFile {
  name: string
  relPath: string
  mtime: number
  group?: string
  isEnv?: boolean
}

// One request parsed out of a .http file (requests are separated by a `###`
// line). `startLine` is 1-based — the line the request begins on — so pressing
// E can drop the nvim cursor straight onto the selected request.
export interface HttpRequest {
  name: string
  method: string
  url: string
  headers: [string, string][]
  body?: string
  startLine: number
  // The inline response-handler script (`> {% … %}` after the request), if any.
  // Runs after the response arrives; `client.global.set(name, value)` there
  // persists a variable back into the environment (e.g. capture an auth token).
  script?: string
}

// The result of sending an HttpRequest. `size` is the response body's byte
// length and `duration` the round-trip in ms. `error` is set (with status 0)
// when the request never completed (DNS/connection/timeout).
export interface HttpResponse {
  status: number
  statusText: string
  headers: [string, string][]
  body: string
  duration: number
  size: number
  error?: string
  // Output of the response-handler script, when the request had one: names of
  // variables it saved (client.global.set) and any client.log() lines.
  savedVars?: string[]
  log?: string[]
}

// Environments loaded from http-client.env.json (with .private.env.json merged
// over it): environment name → variable map. `{{var}}` references in a request
// resolve against the selected environment's map.
export type HttpEnv = Record<string, Record<string, string>>

// --- Database viewer (read-only, per-worktree) ------------------------------

// The connection detected from the worktree's Laravel `.env`, minus the password
// (which stays in the main process). `via` records how the last query reached it:
// 'direct' = an in-process driver to host:port; 'docker' = the DB's CLI inside a
// `docker compose exec` container (the fallback when the host isn't reachable).
export interface DbConfig {
  driver: 'mysql' | 'postgres' | 'sqlite'
  host?: string
  port?: number
  database: string
  username?: string
  via?: 'direct' | 'docker'
}

// One table in the connected database.
export interface DbTable {
  name: string
}

// The connection info + table list for the right-pane panel. `config` is null
// when the worktree has no recognizable DB config; `error` explains a reachable-
// but-failing connection (auth, unreachable host) with an empty table list.
export interface DbTablesResult {
  config: DbConfig | null
  tables: DbTable[]
  error?: string
}

// One cell value, normalized for the grid (Dates → ISO, Buffers → hex, etc.).
export type DbCell = string | number | boolean | null

// The result of a read-only query. `rowCount` is the total the query produced;
// `rows` may be shorter (capped) with `truncated` set. `error` is set (with empty
// columns/rows) when the guard rejected it or the query/connection failed.
export interface DbResult {
  columns: string[]
  rows: DbCell[][]
  rowCount: number
  duration: number
  truncated?: boolean
  error?: string
}

// --- Tasks (external tracker work items: GitHub Issues, Jira, …) ------------

// The normalized work item the renderer and the worktree flow ever see. Each
// tracker is a TaskProvider (see main/tasks/provider.ts) that maps its own issue
// shape into this — so GitHub Issues today and Jira tomorrow share one UI.
export interface Task {
  id: string // stable provider id, e.g. "gh:123" or "jira:PROJ-45"
  key: string // display key, e.g. "#123" or "PROJ-45"
  title: string
  state: 'open' | 'closed'
  labels: TaskLabel[]
  assignees: string[]
  author?: string
  updatedAt: string // ISO timestamp — newest-first ordering + "time ago"
  url: string // opened in the browser with `o`/Enter
  body: string
  provider: TaskProviderName
  // Optional, richer fields some trackers (Jira) carry. GitHub leaves them unset.
  epic?: TaskEpic | null // the parent epic, when the issue belongs to one
  type?: string // issue type display name (Story, Bug, Task, Epic, …)
  status?: string // human status name (To Do, In Progress, Done, …)
}

// The epic an issue rolls up to — used to group/filter the Tasks list.
export interface TaskEpic {
  key: string // e.g. "PROJ-12"
  name: string // the epic's summary/title
}

export interface TaskLabel {
  name: string
  color?: string // 6-hex (no '#'); providers without colors leave it unset
}

export type TaskProviderName = 'github' | 'jira'

// Outcome of marking a worktree's linked task done/closed during the merge flow
// (the `closetask` step). `skipped` = nothing to do (no linked task, or the
// provider can't close); `ok:false` = we tried and failed. `detail` is a short
// human label for the merge panel ("DOS-219 → Done", "Closed #123", or an error).
export interface TaskCloseResult {
  ok: boolean
  skipped?: boolean
  detail?: string
}

// What resolveProvider learned about the active project: whether a tracker
// applies and is usable, and if not, why (shown verbatim in the empty state).
export interface TasksStatus {
  available: boolean
  provider?: TaskProviderName
  source?: string // human label, e.g. "owner/repo" or a Jira project key
  reason?: string // why unavailable: no remote / cli missing / not authed / …
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
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

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
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string } // extended-thinking delta (streams before the text answer)
  | { kind: 'tool'; name: string; summary?: string }
  | { kind: 'image'; mediaType: string; data: string } // a tool returned an image (e.g. Read of a PNG)
  | { kind: 'question'; toolUseId: string; questions: AgentQuestion[] }
  | { kind: 'artifact'; spec: ArtifactSpec } // an inline decision panel (see shared/artifact.ts)
  | { kind: 'permission'; permission: AgentPermission }
  | { kind: 'tokens'; tokens: number }
  // Parallel subagent lifecycle — start (launched), progress (live tokens / current
  // tool), done (its result returned). Multiple may run concurrently in one turn.
  | { kind: 'subagent-start'; toolUseId: string; agentType: string; description: string }
  | { kind: 'subagent-progress'; toolUseId: string; tokens: number; tool?: string }
  // `reply`/`ms` are carried only by the Codex bridge: unlike a Task subagent
  // (whose work lands in the transcript as the parent's own tool calls), a Codex
  // exchange has no other trace, so the answer has to ride the done event or it
  // is lost when the turn ends.
  | { kind: 'subagent-done'; toolUseId: string; reply?: string; ms?: number }
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
  model?: string // concrete model id the CLI resolved for this turn
  events: AgentEvent[]
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
  | { worktreePath: string; kind: 'done'; ok: boolean }

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

export type RemoveStepId = 'preflight' | 'database' | 'worktree' | 'branch'

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
