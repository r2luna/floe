import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app, type BrowserWindow } from 'electron'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type {
  AgentRunOptions,
  Project,
  McpCommand,
  McpCommandResult,
  McpServerEntry,
  PermissionMode,
  Worktree
} from '../shared/types'
import { COMMAND_IDS } from '../shared/commandIds'
import { parseArtifactSpec } from '../shared/artifact'
import { listProjects } from './projects'
import { boardFor, pushBoard, releaseTask } from './colony/runner'
import { addTask, getTask, removeTask, TASK_KINDS, type TaskKind } from './colony/store'
import {
  changedFiles,
  createWorktree,
  fileDiff,
  listBranches,
  listWorktrees,
  mergeWorktree,
  removeWorktree,
  worktreeDiffStat
} from './git'
import { worktreeStatus } from './gitStatus'
import { provisionWorktree } from './provision'
import { PREMISE_REL, readPremise, writePremise } from './premise'
import { listPlans, readPlan } from './plans'
// `./draw/index`, not `./draw`: the MCP test loads this graph under a plain
// `node --test`, whose loader hook resolves a file specifier, not a directory.
import { applyDelta, createDrawing, listDrawings, promoteDrawing, readDrawing, summarize } from './draw/index'
import { eraseElements, expandSkeletons, moveElements } from './draw/skeleton'
import { loadClaudeTranscript, sessionHasUnansweredQuestion, type TranscriptItem } from './claudeSessions'
// Circular with codex (it emits through agent, which imports this file) — safe:
// every side only calls the others' functions at runtime, never at module top.
import { askCodex, MAX_EXCHANGES } from './codex'
import {
  addCreatedSession,
  getAllCreatedSessions,
  getCreatedSessions,
  setCreatedSessionSpawnedBy,
  type CreatedSession
} from './sessionStore'
import { readSessionBuffer, sessionRuntime, stopAgent, waitForTurn } from './agent'
// One turn, one door: the same dispatcher the composer's `agent:start` uses, so
// an agent gets the harness, the skills and the handle exactly as a person does.
import { dispatchTurn, optionsForRoute, routeOf } from './turn'
import {
  discardQuery,
  fanOut,
  mergeQuery,
  openQueryFor,
  peekQuery,
  queriesFor,
  refuseReason
} from './queries'
import type { Route } from '../shared/mentions'
import { installEverywhere, installMessage } from './mcpInstall'
import { log } from './log'
import { getClaudeInfo } from './claudeInfo'
import { startMcpAuth } from './mcpAuth'
import { existsSync, realpathSync, rmSync } from 'node:fs'
import {
  addProjectByPath,
  removeProject,
  renameProject,
  setProjectGroup,
  setProjectPinned,
  setProjectReadOnly
} from './projects'
import { listCommands, removeCommand, type ProjectCommand } from './commands'
import {
  commandOutput,
  commandRuns,
  isCommandRunning,
  restartCommand,
  startCommand,
  stopCommand
} from './commandRunner'
import { answerQuestion, pendingPrompts, respondPermission, type PendingPrompt } from './agent'
import { answerCodexQuestion, codexPendingQuestion } from './codexServer'
import {
  renameCreatedSession,
  setCreatedSessionChoice
} from './sessionStore'
import { closeSessionFully } from './sessionClose'
import { clearReview, commitFileDiff, hasReviewCheckpoint, restoreReview, reviewCommits } from './git'
import { localUsage } from './localAgents'
import { copyPlan, PLANS_DIR, readImplementPhases } from './plans'
import { claudeMcpConfig, clearHarnessConfigs, mcpUrlFor, serversFor, setMcpPort } from './mcpHarness'
import { HARNESSES, MODES, nearestMode } from '../shared/modes'
import { EFFORTS, type Effort } from '../shared/types'
import {
  createSkill,
  deleteSkill,
  listSkills,
  readSkillFile,
  renameSkill,
  updateSkill
} from './config/skills'
import { projectFor } from './config/projectStore'
import { defineCommand, projectCommands } from './commands'
import { NOTIFY_LEVELS } from './config/commandStore'
import { pluginTools } from './plugins/host'
import type { PluginToolParam } from './plugins/types'
import {
  addMcpServer,
  listMcpServers,
  removeMcpServer,
  updateMcpServer,
  type NewMcpServer
} from './config/mcpServers'

// The MCP control server runs inside the Electron main process so its tools have
// direct access to git / sessionStore / the agent conns AND to win.webContents
// to drive the renderer — no inter-process bridge needed. Each spawned `claude`
// session gets a per-session --mcp-config whose url carries the session's own key
// as a path token (/mcp/<key>), so a tool call always knows its caller.
//
// Every user-facing Floe action must be reachable here — either as a dedicated
// tool below, or through `run_command` for anything the renderer's command
// registry already dispatches. See docs/mcp.md before adding a command anywhere.

// A fixed preferred port so a GLOBAL Claude registration (claude mcp add) stays
// valid across app restarts — an ephemeral port would change every launch and
// leave the global config pointing at nothing. We still fall back to an ephemeral
// port if this one is taken (e.g. a second Floe instance); per-session configs
// are written fresh each spawn so they don't care, but the global install only
// stays durable when we hold the preferred port.
const PREFERRED_PORT = 41673

// The path token used by the global (non-Floe-spawned) Claude registration.
// In-app sessions carry their own session id as the token; external sessions all
// share this one, so tool calls attribute themselves to "global".
const GLOBAL_TOKEN = 'global'

let httpServer: Server | undefined
let serverPort = 0
let boundPreferred = false
let getWindowRef: (() => BrowserWindow | undefined) | undefined

export function port(): number {
  return serverPort
}

function getWindow(): BrowserWindow | undefined {
  return getWindowRef?.()
}

// Forward a UI command (select_session / open_plan / open_drawing / run_command /
// list_commands)
// to the renderer, which runs its existing lane/registry flows.
function pushCommand(command: McpCommand): void {
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send('mcp:command', command)
}

// Ask the renderer to run one of its own commands, and don't wait for it: the
// tool already did the work in main, this is only the repaint. `project.reload`
// is the one that matters — the sidebar's project list re-reads on nothing
// else, so a project added over MCP would otherwise not show up until the user
// asked for it themselves.
function pushRefresh(commandId: string): void {
  pushCommand({ kind: 'run_command', callerKey: 'refresh', requestId: randomUUID(), commandId })
}

// A raw renderer event (`sessions:changed`), for state main changed behind the
// UI's back that has a listener already.
function pushEvent(channel: string): void {
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send(channel)
}

/** The branch a worktree is on, as the project's worktree list reports it. */
async function branchOf(project: string, worktree: string): Promise<string> {
  const found = (await listWorktrees(project)).find((w) => w.path === worktree)
  return found?.branch ?? ''
}

// Tell the renderer a project's worktree set changed (e.g. via create_worktree),
// so the sidebar refreshes its list/count — the MCP path has no React state of
// its own, unlike the in-app create flow which updates it directly.
function pushWorktrees(project: string, worktrees: Worktree[]): void {
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send('worktrees:updated', { project, worktrees })
}

// --- renderer round-trips --------------------------------------------------
// run_command / list_commands live in the renderer (the registry closes over
// React state), so those tools push an mcp:command and park a resolver keyed by
// the requestId; index.ts calls resolveCommandResult when the renderer replies
// over mcp:command-result.
const pendingResults = new Map<string, (result: McpCommandResult) => void>()

export function resolveCommandResult(result: McpCommandResult): void {
  const resolve = pendingResults.get(result.requestId)
  if (resolve) {
    pendingResults.delete(result.requestId)
    resolve(result)
  }
}

function awaitCommand(command: McpCommand & { requestId: string }, timeoutMs = 10_000): Promise<McpCommandResult> {
  return new Promise((resolve) => {
    if (!getWindow()) {
      resolve({ requestId: command.requestId, ok: false, error: 'No Floe window is open to run UI commands.' })
      return
    }
    const timer = setTimeout(() => {
      pendingResults.delete(command.requestId)
      resolve({ requestId: command.requestId, ok: false, error: 'Timed out waiting for the Floe window to answer.' })
    }, timeoutMs)
    pendingResults.set(command.requestId, (result) => {
      clearTimeout(timer)
      resolve(result)
    })
    pushCommand(command)
  })
}

// --- session lookup --------------------------------------------------------

// A session id from a caller can be the Floe id, the current Claude id, or a
// past Claude id (resume forks a new one every respawn) — accept them all, the
// same way sessionStore's findByKey does.
function findSessionAny(id: string): CreatedSession | undefined {
  const created = getAllCreatedSessions()
  return (
    created.find((s) => s.id === id) ??
    created.find((s) => s.claudeId === id) ??
    created.find((s) => s.pastClaudeIds?.includes(id))
  )
}

// The key a session's live agent connection (and its open panel) is under. The
// renderer keys panels by `claudeId ?? id` for resumed sessions and by the Floe
// id for freshly-created ones, so prefer whichever key has a live conn and fall
// back to the resume convention.
export function connKeyFor(s: CreatedSession): string {
  for (const k of [s.id, s.claudeId, ...(s.pastClaudeIds ?? [])]) {
    if (k && sessionRuntime(k).live) return k
  }
  return s.claudeId ?? s.id
}

function runOptionsFor(s: CreatedSession): AgentRunOptions {
  return {
    // A session an agent drives has no human in front of it to answer prompts,
    // so default to skip unless the session was explicitly set stricter.
    permissionMode: nearestMode(s.permissionMode ?? 'skip', s.provider),
    model: s.model,
    effort: s.effort,
    // What the session answers AS. Without it every agent-sent message went to
    // Claude, whatever the chat was set to — an agent writing into a codex
    // session got a different harness than the person looking at it.
    provider: s.provider
  }
}

/**
 * Who answers this one message: what the caller named, else the handle at the
 * front of the prompt, else the session itself.
 *
 * Both spellings, because both are real. An agent that knows it wants codex
 * says so in the arguments; an agent relaying something a person wrote passes
 * `@codex …` through untouched and gets the same result the composer would
 * have given. Neither changes what the session answers as afterwards — one
 * message is not a switch, the same as in the UI.
 */
interface NamedOptions {
  harness?: string
  model?: string
  effort?: Effort
  mode?: PermissionMode
}

type Sent = { prompt: string; options: AgentRunOptions; route: Route | null }

// Nobody named a harness: the session answers as itself, with whatever the
// caller overrode on top.
function unroutedSend(target: CreatedSession, prompt: string, named: NamedOptions): Sent {
  const options = runOptionsFor(target)
  return {
    prompt,
    route: null,
    options: {
      ...options,
      model: named.model ?? options.model,
      effort: named.effort ?? options.effort,
      permissionMode: named.mode ?? options.permissionMode
    }
  }
}

// A harness WAS named, by argument or by handle: this is a ROUTE, and it opens a
// query exactly as the composer's would (D7). Handed back rather than consumed
// here — the decision is turn.ts's, for all five doors at once.
function routedSend(target: CreatedSession, prompt: string, named: NamedOptions, harness: string, handle: Route | null): Sent {
  const route = {
    harness,
    model: named.model ?? handle?.model,
    effort: named.effort ?? handle?.effort,
    prompt: handle?.prompt ?? prompt
  }
  const options = optionsForRoute(route, target.id)
  return {
    route,
    // Sent without the handle, shown with it — the same split the composer
    // makes, so a transcript read back says who the message was for.
    prompt: route.prompt,
    options: {
      ...options,
      permissionMode: named.mode ? nearestMode(named.mode, options.provider) : options.permissionMode,
      shown: handle ? prompt : undefined
    }
  }
}

export function sendOptions(target: CreatedSession, prompt: string, named: NamedOptions): Sent {
  const handle = named.harness ? null : routeOf(prompt)
  const harness = named.harness ?? handle?.harness
  return harness ? routedSend(target, prompt, named, harness, handle) : unroutedSend(target, prompt, named)
}

// --- Followups: delegate a delayed send_message to Floe ---------------------
// An agent that would otherwise `sleep 3m` then poll another session (or itself)
// registers a followup instead; Floe's own timer fires the send_message so the
// calling turn can end immediately. In-memory only — a restart drops pending
// followups.
interface FollowupEntry {
  id: string
  fromToken: string
  sessionId: string
  message: string
  fireAt: number
  timer: NodeJS.Timeout
}

const followups = new Map<string, FollowupEntry>()

function deliverFollowup(sessionId: string, message: string): void {
  const target = findSessionAny(sessionId)
  const win = getWindow()
  if (!target || !win) return
  // create_followup says what it is: a send_message on a timer. So it goes out
  // as one — handle read, harness picked, relay armed — rather than straight at
  // Claude, which made `@codex …` mean one thing when sent and another when
  // scheduled.
  const sent = sendOptions(target, message, {})
  dispatchTurn({
    win,
    parentKey: connKeyFor(target),
    worktreePath: target.worktreePath,
    prompt: message,
    route: sent.route,
    origin: 'followup',
    options: sent.options
  })
}

function scheduleFollowup(fromToken: string, sessionId: string, delayMinutes: number, message: string): string {
  const id = randomUUID()
  const fireAt = Date.now() + delayMinutes * 60_000
  const timer = setTimeout(() => {
    followups.delete(id)
    deliverFollowup(sessionId, message)
  }, delayMinutes * 60_000)
  followups.set(id, { id, fromToken, sessionId, message, fireAt, timer })
  return id
}

function listFollowupsFor(fromToken: string): Array<{ id: string; sessionId: string; message: string; fireInMinutes: number }> {
  return [...followups.values()]
    .filter((f) => f.fromToken === fromToken)
    .map((f) => ({
      id: f.id,
      sessionId: f.sessionId,
      message: f.message,
      fireInMinutes: Math.max(0, Math.round((f.fireAt - Date.now()) / 60_000))
    }))
}

function cancelFollowupById(id: string): boolean {
  const entry = followups.get(id)
  if (!entry) return false
  clearTimeout(entry.timer)
  followups.delete(id)
  return true
}

function textResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return { content: [{ type: 'text' as const, text }] }
}

// What every tool answers with — tools never throw, they answer `{ error }`.
type ToolResult = ReturnType<typeof textResult>

/**
 * The registered project a caller means, whatever spelling it used.
 *
 * On macOS `/tmp` is a symlink to `/private/tmp`, so the path a project is
 * stored under is rarely the one an agent types. The project tools match on the
 * resolved form and then act on the STORED path — the store's own lookups are
 * exact, and a near-miss there is silent: `removeProject` on a path it does not
 * know answers with the full list, exactly as if it had worked.
 */
function registeredProject(path: string): Project | undefined {
  const projects = listProjects()
  const wanted = realPath(path)
  return projects.find((p) => p.path === path || realPath(p.path) === wanted)
}

/** realpath, or the path as given when it does not exist (yet). */
function realPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

// A project path, or a worktree inside one — callers pass either. Omitted means
// "global only", which is not the same as "this project".
//
// Resolved first, and resolved on the way out: the store keeps repo roots as
// `repoRoot()` reported them, so an agent that says `/tmp/x` where the project
// lives at `/private/tmp/x` must not be handed its own spelling back. It would
// be used to CREATE a second project directory for the same repo — which is
// exactly what `add_project_command` did before this.
export function projectRoot(project: string): string {
  const at = realPath(project)
  return projectFor(at) ?? projectFor(project) ?? at
}

function rootFor(project?: string): string | undefined {
  return project ? projectRoot(project) : undefined
}

const sessionSummary = (s: CreatedSession): Record<string, unknown> => ({
  id: s.id,
  title: s.title,
  worktreePath: s.worktreePath,
  claudeId: s.claudeId,
  running: sessionRuntime(connKeyFor(s)).running
})

// Register every floe tool on a fresh McpServer, with `token` (the caller's
// Floe session key) captured in each closure so a tool knows who called it.
// One registrar per domain below — a single function registering all ~57 tools
// is unreadable and untestable. See docs/mcp.md before adding a tool anywhere.
function registerTools(server: McpServer, token: string): void {
  registerWorktreeTools(server, token)
  registerSessionTools(server, token)
  registerQueryTools(server)
  registerSessionControlTools(server, token)
  registerPlanTools(server, token)
  registerDrawingTools(server, token)
  registerDecisionTools(server)
  registerColonyTools(server)
  registerSkillTools(server)
  registerMcpRegistryTools(server)
  registerProjectTools(server)
  registerCommandTools(server, token)
  registerCommandRunTools(server)
  registerSessionStateTools(server, token)
  registerSessionPickerTools(server)
  registerReviewTools(server)
  registerUsageTools(server)
  registerPlanExtraTools(server)
  registerPluginToolsOn(server)
}

// Which of the worktrees `createWorktree` reports back is the one just made:
// the branch it was asked for, else a path ending in it, else the newest.
export function createdWorktree(worktrees: Worktree[], branch: string): Worktree | undefined {
  return worktrees.find((w) => w.branch === branch || w.path.endsWith(branch)) ?? worktrees[worktrees.length - 1]
}

/**
 * The premise an agent supplied with the create, written before provisioning.
 *
 * Order matters: the setup checklist interviews a worktree that has no premise
 * (provision.ts), and an agent that already said what the branch is for has
 * answered the only question it would have been asked.
 */
function seedPremise(created: { path: string } | undefined, premise?: string): void {
  const text = premise?.trim()
  if (created && text) writePremise(created.path, text)
}

async function createWorktreeTool(
  project: string,
  branch: string,
  base?: string,
  note?: string,
  premise?: string
): Promise<ToolResult> {
  try {
    const worktrees = await createWorktree(project, branch, { base, note })
    pushWorktrees(project, worktrees)
    const created = createdWorktree(worktrees, branch)
    seedPremise(created, premise)
    // Run the per-stack setup the same way the in-app create flow does —
    // otherwise an MCP-created worktree lands with no environment.
    // Fire-and-forget; progress streams to the setup checklist.
    const win = getWindow()
    if (win && created) void provisionWorktree(win, project, created.path, created.branch)
    return textResult({ created, worktrees })
  } catch (e) {
    return textResult({ error: (e as Error).message })
  }
}

async function mergeWorktreeTool(project: string, worktree: string): Promise<ToolResult> {
  try {
    const result = await mergeWorktree(project, worktree)
    if (result.ok) pushWorktrees(project, await listWorktrees(project))
    return textResult(result)
  } catch (e) {
    return textResult({ error: (e as Error).message })
  }
}

async function startMergeTool(token: string, worktree: string): Promise<ToolResult> {
  try {
    const projectPath = projectFor(worktree)
    if (!projectPath) return textResult({ error: `No Floe project contains this worktree: ${worktree}` })
    const result = await awaitCommand({
      kind: 'start_merge',
      callerKey: token,
      requestId: randomUUID(),
      worktreePath: worktree,
      projectPath
    })
    if (!result.ok) return textResult({ error: result.error ?? 'The merge did not start.' })
    return textResult({
      ok: true,
      note: 'Guided merge panel is up. It pauses at the review checkpoint — the user approves with ⏎ (or via run_command merge.confirm). Track progress with worktree_status.'
    })
  } catch (e) {
    return textResult({ error: (e as Error).message })
  }
}

// Projects, worktrees and the review pair: everything that runs straight
// against git in main.
function registerWorktreeTools(server: McpServer, token: string): void {
  // --- Projects & worktrees (run directly in main) --------------------------

  server.tool('list_projects', 'List the git projects registered in Floe.', {}, async () => {
    try {
      return textResult(listProjects())
    } catch (e) {
      return textResult({ error: (e as Error).message })
    }
  })

  server.tool(
    'list_worktrees',
    'List the worktrees of a project (the project is its repo root path).',
    { project: z.string().describe('The repo root path of the project.') },
    async ({ project }) => {
      try {
        return textResult(await listWorktrees(project))
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'list_branches',
    'List the local branches of a project.',
    { project: z.string().describe('The repo root path of the project.') },
    async ({ project }) => {
      try {
        return textResult(await listBranches(project))
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'create_worktree',
    'Create a new git worktree (and branch) in a project. The per-stack provisioning (.env copy, deps, database, containers) runs automatically after creation, the same as the in-app flow.',
    {
      project: z.string().describe('The repo root path of the project.'),
      branch: z.string().describe('The branch name to create or reuse.'),
      base: z.string().optional().describe('The base branch to fork from (defaults to the main branch).'),
      note: z.string().optional().describe('An optional short note/label for the worktree.'),
      premise: z
        .string()
        .optional()
        .describe(
          "The worktree's standing brief (Markdown: ## Goal / ## Scope / ## Out of scope / ## Constraints / ## Done when, under 200 words). Every session started in this worktree opens with it. Passing one also skips the interview the setup checklist would otherwise run."
        )
    },
    async (a) => createWorktreeTool(a.project, a.branch, a.base, a.note, a.premise)
  )

  server.tool(
    'worktree_premise',
    "Read or replace a worktree's premise — the standing brief handed to the FIRST turn of every session started there (.floe/premise.md). Omit `premise` to read the current one. Keep it under 200 words: it is prepended to a real prompt, not stored for reference.",
    {
      worktree: z.string().describe('The worktree path.'),
      premise: z
        .string()
        .optional()
        .describe('The new brief, in Markdown. Replaces what is there. Omit to read.')
    },
    async ({ worktree, premise }) => {
      try {
        if (premise === undefined) {
          return textResult({ worktree, premise: readPremise(worktree) ?? null, path: PREMISE_REL })
        }
        writePremise(worktree, premise)
        return textResult({ worktree, written: PREMISE_REL, premise: readPremise(worktree) ?? null })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'remove_worktree',
    'Remove a worktree from a project. Refuses when the worktree has uncommitted changes.',
    {
      project: z.string().describe('The repo root path of the project.'),
      worktree: z.string().describe('The worktree path to remove.')
    },
    async ({ project, worktree }) => {
      try {
        const worktrees = await removeWorktree(project, worktree)
        pushWorktrees(project, worktrees)
        return textResult({ ok: true, worktrees })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'merge_worktree',
    'Merge a worktree branch back into its base branch (the safe one-shot merge: refuses on dirty trees or conflicts).',
    {
      project: z.string().describe('The repo root path of the project.'),
      worktree: z.string().describe('The worktree path to merge.')
    },
    async (a) => mergeWorktreeTool(a.project, a.worktree)
  )

  server.tool(
    'start_merge',
    "Open Floe's GUIDED merge for a worktree: the step-by-step checklist panel (preflight → merge → resolve → review → commit → fast-forward → teardown) that pauses at the review checkpoint for the user to approve. Prefer this over merge_worktree when a human is around — merge_worktree is the headless one-shot with no review stop. Navigates the UI to the worktree's project if needed.",
    { worktree: z.string().describe('The worktree path to merge into its base.') },
    async (a) => startMergeTool(token, a.worktree)
  )

  server.tool(
    'worktree_status',
    'Git status of a worktree: dirty files plus the diff stat against its review base.',
    { worktree: z.string().describe('The worktree path.') },
    async ({ worktree }) => {
      try {
        const [status, stat] = await Promise.all([worktreeStatus(worktree), worktreeDiffStat(worktree)])
        return textResult({ status, diffStat: stat })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  // --- Review ---------------------------------------------------------------

  server.tool(
    'changed_files',
    "List a worktree's changed files against its review base — what the Changes panel shows.",
    { worktree: z.string().describe('The worktree path.') },
    async ({ worktree }) => {
      try {
        return textResult(await changedFiles(worktree))
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'file_diff',
    'The unified diff of one changed file in a worktree (relative path, as listed by changed_files).',
    {
      worktree: z.string().describe('The worktree path.'),
      path: z.string().describe('The file path relative to the worktree.')
    },
    async ({ worktree, path }) => {
      try {
        return textResult(await fileDiff(worktree, path))
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )
}

function listSessionsTool(worktree?: string): ToolResult {
  try {
    // needsYou reads each session's on-disk JSONL — fine for one worktree,
    // too hot for a store-wide walk, so the unfiltered list skips it.
    if (worktree) {
      return textResult(
        getCreatedSessions(worktree).map((s) => ({
          ...sessionSummary(s),
          // Two authorities, because neither sees the whole thing: the
          // live conn knows about a prompt the CLI has not written to the
          // JSONL yet (and about permission prompts, which never land
          // there), the transcript knows about one raised before this app
          // run.
          needsYou:
            sessionRuntime(connKeyFor(s)).waiting ||
            (s.claudeId ? sessionHasUnansweredQuestion(s.worktreePath, s.claudeId) : false)
        }))
      )
    }
    return textResult(getAllCreatedSessions().map(sessionSummary))
  } catch (e) {
    return textResult({ error: (e as Error).message })
  }
}

interface CreateSessionArgs {
  worktree: string
  prompt?: string
  title?: string
  select?: boolean
  model?: string
  mode?: PermissionMode
}

// A new session's first prompt, sent through the same door as send_message
// rather than straight at Claude. It is a prompt like any other: it can open
// with `@codex`, and before it went through here that handle was read by nobody
// — the session opened, Claude answered a message addressed to codex, and codex
// never heard of it. See turn.ts: both doors, one behaviour.
function openingTurn(win: BrowserWindow, id: string, a: CreateSessionArgs, prompt: string): void {
  const stored = findSessionAny(id)
  // `a.model` is a CLAUDE alias for the session to run on, which is not a thing
  // to hand another harness as its own slug — `opus` means nothing to codex. A
  // prompt that opens with a handle names its model in the handle, or takes
  // that harness's default.
  const named = routeOf(prompt) ? { mode: a.mode } : { model: a.model, mode: a.mode }
  const sent = stored
    ? sendOptions(stored, prompt, named)
    : { prompt, route: routeOf(prompt), options: { permissionMode: a.mode ?? 'skip', model: a.model } }
  dispatchTurn({
    win,
    parentKey: id,
    worktreePath: a.worktree,
    prompt,
    route: sent.route,
    origin: 'mcp',
    options: sent.options
  })
}

function createSessionTool(token: string, a: CreateSessionArgs): ToolResult {
  try {
    const id = randomUUID()
    const storedTitle = addCreatedSession({ id, worktreePath: a.worktree, title: a.title ?? a.prompt?.slice(0, 60) })
    // No human sits in front of a session an agent opened: mark it so the
    // parent (not the user) is responsible for its questions.
    setCreatedSessionSpawnedBy(id, token)
    if (a.prompt) {
      const win = getWindow()
      if (!win) return textResult({ error: 'No window available to run the session.' })
      openingTurn(win, id, a, a.prompt)
    }
    if (a.select === true) {
      pushCommand({
        kind: 'select_session',
        callerKey: token,
        sessionId: id,
        title: storedTitle,
        worktreePath: a.worktree,
        projectPath: projectFor(a.worktree) ?? undefined
      })
    }
    return textResult({ sessionId: id, title: storedTitle })
  } catch (e) {
    return textResult({ error: (e as Error).message })
  }
}

interface SendMessageArgs {
  session_id: string
  prompt: string
  wait?: boolean
  harness?: string
  model?: string
  effort?: Effort
  mode?: PermissionMode
}

// What send_message answers once the turn is under way. `wait` is the only fork:
// the reply, or the ack that the turn started.
async function sendResult(
  target: CreatedSession,
  sent: { options: AgentRunOptions },
  ran: { key: string; query?: unknown },
  wait?: boolean
): Promise<Record<string, unknown>> {
  const sessionId = target.id
  const queryKey = ran.query ? ran.key : undefined
  const answeredBy = sent.options.provider ?? 'claude'
  // The key the turn actually started under — the QUERY's when one opened, or
  // waiting would park on a session that is not answering.
  if (wait) return { sessionId, queryKey, reply: await waitForTurn(ran.key), answeredBy }
  return { sessionId, queryKey, ack: true, answeredBy }
}

async function sendMessageTool(a: SendMessageArgs): Promise<ToolResult> {
  try {
    const target = findSessionAny(a.session_id)
    if (!target) return textResult({ error: `Unknown session: ${a.session_id}` })
    const win = getWindow()
    if (!win) return textResult({ error: 'No window available to run the session.' })
    const sent = sendOptions(target, a.prompt, a)
    // Spawn the conn (if needed) BEFORE waiting, so a brand-new session has a
    // live process for waitForTurn to resolve against.
    //
    // Through dispatchTurn, so `@codex …` sent by an agent opens the very same
    // query the composer's would. If the two doors diverge here, "could an agent
    // do this without the UI?" stops being answerable.
    const ran = dispatchTurn({
      win,
      parentKey: connKeyFor(target),
      worktreePath: target.worktreePath,
      prompt: a.prompt,
      route: sent.route,
      origin: 'mcp',
      options: sent.options
    })
    if (ran.error) return textResult({ error: ran.error })
    return textResult(await sendResult(target, sent, ran, a.wait))
  } catch (e) {
    return textResult({ error: (e as Error).message })
  }
}

async function askCodexTool(token: string, prompt: string, newTopic: boolean): Promise<ToolResult> {
  try {
    // The caller's own session: Codex answers into THIS chat (that is what
    // makes it a participant), and runs in the worktree being talked about.
    const caller = findSessionAny(token)
    if (!caller) return textResult({ error: 'ask_codex must be called from a Floe session.' })
    const win = getWindow()
    if (!win) return textResult({ error: 'No window available to run Codex.' })
    const result = await askCodex(win, connKeyFor(caller), caller.worktreePath, prompt, newTopic)
    if (result.capped)
      return textResult({
        capped: true,
        note: `${MAX_EXCHANGES} exchanges used — check in with your user before continuing this thread.`
      })
    if (result.error) return textResult({ error: result.error })
    return textResult({ reply: result.reply, exchange: result.exchange })
  } catch (e) {
    return textResult({ error: (e as Error).message })
  }
}

/**
 * One transcript entry as a line of text.
 *
 * A line another session or a subagent said is labelled with who said it.
 * Reading it back as `user:`/`assistant:` is how an agent watching this session
 * ends up quoting a peer's words as its user's instructions.
 */
export function transcriptLine(it: TranscriptItem): string {
  if (it.role === 'image') return '[image]'
  if (it.role === 'tool') return `[tool ${it.name ?? ''}] ${it.summary ?? ''}`.trim()
  return `${it.from ?? it.role}: ${it.text ?? ''}`
}

function readSessionOutputTool(sessionId: string, limit?: number): ToolResult {
  try {
    const target = findSessionAny(sessionId)
    const cap = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : 50
    const live = target ? readSessionBuffer(connKeyFor(target)) : readSessionBuffer(sessionId)
    let disk = ''
    if (target?.claudeId) {
      const lines = loadClaudeTranscript(target.worktreePath, target.claudeId).map(transcriptLine).filter(Boolean)
      disk = lines.slice(-cap).join('\n')
    }
    const combined = [disk, live].filter(Boolean).join('\n').trim()
    if (!combined) return textResult({ output: '', note: 'No output yet for this session.' })
    return textResult({ output: combined })
  } catch (e) {
    return textResult({ error: (e as Error).message })
  }
}

function registerSessionTools(server: McpServer, token: string): void {
  // --- Sessions + communication --------------------------------------------

  server.tool(
    'list_sessions',
    'List the sessions Floe knows about, optionally filtered to one worktree. `running` means a turn is in flight right now; `needsYou` (only computed when `worktree` is given) means the session is blocked on you — an unanswered question or a tool-permission prompt.',
    { worktree: z.string().optional().describe('Limit to sessions in this worktree path.') },
    async (a) => listSessionsTool(a.worktree)
  )

  server.tool(
    'create_session',
    'Create a new Floe session in a worktree, optionally sending a first prompt and bringing it on screen.',
    {
      worktree: z.string().describe('The worktree path to create the session in.'),
      prompt: z.string().optional().describe('An optional first prompt, sent as the session opens.'),
      title: z.string().optional().describe('An optional session title.'),
      select: z
        .boolean()
        .optional()
        .describe(
          "Bring the session on screen. Default false — an agent creating sessions for background work must not steal the user's screen. Only pass true when the user asked to see it."
        ),
      model: z.string().optional().describe('Claude alias (opus, sonnet, haiku, fable) to run the session with.'),
      mode: z
        .enum(['default', 'acceptEdits', 'plan', 'skip'])
        .optional()
        .describe('Permission mode for the session. Defaults to skip — an agent-driven session has no human to answer prompts.')
    },
    async (a) => createSessionTool(token, a)
  )

  server.tool(
    'send_message',
    'Send a prompt to another Floe session. With wait=true, block until that session finishes its turn and return its final assistant text.',
    {
      session_id: z.string().describe('The Floe session id to send to.'),
      prompt: z
        .string()
        .describe(
          'The message to send. Opening it with a handle — `@codex revisa isso` — hands that one message to that harness, exactly as it would in the composer.'
        ),
      wait: z.boolean().optional().describe('Wait for the turn to complete and return the assistant reply.'),
      harness: z
        .enum(HARNESSES as [string, ...string[]])
        .optional()
        .describe('Who answers this one message. Overrides a handle in the prompt. The session keeps answering as whatever it did before.'),
      model: z.string().optional().describe("That harness's own slug. Empty means whatever it is configured for."),
      effort: z.enum(EFFORTS).optional().describe('How hard to think.'),
      mode: z
        .enum(MODES.map((m) => m.id) as [PermissionMode, ...PermissionMode[]])
        .optional()
        .describe('How much it may do: plan, default (ask), acceptEdits (auto) or skip (bypass).')
    },
    async (a) => sendMessageTool(a)
  )

  server.tool(
    'ask_codex',
    'Ask the local Codex CLI, as a second pair of eyes on the code. Codex runs read-only in this session\'s worktree, joins the chat as @codex (a subagent row plus its answer in the channel), and keeps one thread across calls — call it again to continue the same conversation.',
    {
      prompt: z.string().describe('What to ask Codex. It is another model, not a human: lead with the delta, use file:line, skip the pleasantries.'),
      new_topic: z.boolean().optional().describe('Start a fresh Codex thread instead of continuing the current one.')
    },
    async (a) => askCodexTool(token, a.prompt, a.new_topic === true)
  )

  server.tool(
    'read_session_output',
    'Read recent output from a session: the live in-memory buffer plus, if linked, the tail of its on-disk transcript.',
    {
      session_id: z.string().describe('The Floe session id to read.'),
      limit: z.number().optional().describe('Max number of transcript lines to include (default 50).')
    },
    async (a) => readSessionOutputTool(a.session_id, a.limit)
  )
}

interface OpenQueryArgs {
  session_id: string
  harness: string
  prompt?: string
  model?: string
  effort?: Effort
}

function openQueryTool(a: OpenQueryArgs): ToolResult {
  try {
    const target = findSessionAny(a.session_id)
    if (!target) return textResult({ error: `Unknown session: ${a.session_id}` })
    const win = getWindow()
    if (!win) return textResult({ error: 'No window available.' })
    const { harness, model, effort, prompt } = a
    // Through dispatchTurn when there is something to say, so an agent's query
    // is opened by exactly the code the composer's is. Without a prompt there is
    // no turn to dispatch, only a panel to raise.
    if (prompt) {
      const ran = dispatchTurn({
        win,
        parentKey: connKeyFor(target),
        worktreePath: target.worktreePath,
        prompt,
        route: { harness, model, effort, prompt },
        origin: 'mcp'
      })
      return ran.error ? textResult({ error: ran.error }) : textResult({ queryKey: ran.key })
    }
    const opened = openQueryFor(win, connKeyFor(target), target.worktreePath, {
      harness,
      model,
      effort,
      openedBy: 'agent'
    })
    return opened ? textResult({ queryKey: opened.key }) : textResult({ error: refuseReason(harness) })
  } catch (e) {
    return textResult({ error: (e as Error).message })
  }
}

function askAllTool(sessionId: string, harnesses: string[], prompt: string, effort?: Effort): ToolResult {
  try {
    const target = findSessionAny(sessionId)
    if (!target) return textResult({ error: `Unknown session: ${sessionId}` })
    const win = getWindow()
    if (!win) return textResult({ error: 'No window available.' })
    return textResult(fanOut(win, connKeyFor(target), target.worktreePath, { harnesses, prompt, effort, openedBy: 'agent' }))
  } catch (e) {
    return textResult({ error: (e as Error).message })
  }
}

function listQueriesTool(sessionId: string): ToolResult {
  try {
    const target = findSessionAny(sessionId)
    if (!target) return textResult({ error: `Unknown session: ${sessionId}` })
    return textResult(queriesFor(target.id))
  } catch (e) {
    return textResult({ error: (e as Error).message })
  }
}

function registerQueryTools(server: McpServer): void {
  // --- Queries -------------------------------------------------------------
  // A query is a side conversation running beside a session, read-only, in its
  // own panel. An agent gets the same five verbs a person does — see
  // docs/queries.md. (An agent running INSIDE a query has no Floe token at all
  // and reaches none of this; that is D8.)
  server.tool(
    'open_query',
    'Open a read-only side conversation with another harness beside a session, in its own panel, running in parallel. The same thing typing `@codex …` in the composer does.',
    {
      session_id: z.string().describe('The Floe session to open it beside.'),
      harness: z
        .enum(HARNESSES as [string, ...string[]])
        .describe('Who answers in it. Must be a harness with a read-only mode — codex, claude or opencode.'),
      prompt: z.string().optional().describe('An optional first message, sent as the query opens.'),
      model: z.string().optional().describe("That harness's own slug."),
      effort: z.enum(EFFORTS).optional().describe('How hard to think.')
    },
    async (a) => openQueryTool(a)
  )

  server.tool(
    'ask_all',
    'Ask several harnesses the same thing at once. Each answers in its own read-only query, and the replies come back into the session side by side for comparison. The harnesses are the ones you name — this never fans out to everything installed.',
    {
      session_id: z.string().describe('The Floe session to ask from.'),
      harnesses: z
        .array(z.enum(HARNESSES as [string, ...string[]]))
        .min(1)
        .describe('Who to ask. Only harnesses with a read-only mode can hold a query.'),
      prompt: z.string().describe('The message every one of them gets.'),
      effort: z.enum(EFFORTS).optional().describe('One effort for all of them.')
    },
    async (a) => askAllTool(a.session_id, a.harnesses, a.prompt, a.effort)
  )

  server.tool(
    'list_queries',
    "List a session's side conversations — open ones and the ones already merged or discarded.",
    { session_id: z.string().describe('The Floe session id.') },
    async (a) => listQueriesTool(a.session_id)
  )

  server.tool(
    'peek_query',
    "Hand the session what it has not yet read of a query, and let it take a turn on it. The query stays open.",
    { query_key: z.string().describe('The query key, as `open_query`/`list_queries` report it.') },
    async ({ query_key }) => {
      const out = peekQuery(getWindow() ?? null, query_key)
      return textResult(out.error ? { error: out.error } : { entries: out.entries })
    }
  )

  server.tool(
    'merge_query',
    'Hand the session the rest of a query and close it. What was already peeked at is not sent twice.',
    { query_key: z.string().describe('The query key to merge.') },
    async ({ query_key }) => {
      const out = mergeQuery(getWindow() ?? null, query_key)
      return textResult(out.error ? { error: out.error } : { entries: out.entries, merged: true })
    }
  )

  server.tool(
    'discard_query',
    'Close a query without the session ever seeing a word of it.',
    { query_key: z.string().describe('The query key to discard.') },
    async ({ query_key }) => {
      const out = discardQuery(getWindow() ?? null, query_key)
      return textResult(out.error ? { error: out.error } : { discarded: true })
    }
  )
}

// Driving a session from outside it: stop its turn, put it on screen, or hand
// Floe a message to deliver later.
function registerSessionControlTools(server: McpServer, token: string): void {
  server.tool(
    'stop_session',
    "Stop a session's in-flight turn (the composer's stop button).",
    { session_id: z.string().describe('The Floe session id to stop.') },
    async ({ session_id }) => {
      try {
        const target = findSessionAny(session_id)
        if (!target) return textResult({ error: `Unknown session: ${session_id}` })
        const win = getWindow()
        if (!win) return textResult({ error: 'No window available.' })
        stopAgent(win, connKeyFor(target))
        return textResult({ ok: true })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'select_session',
    'Bring a session on screen in Floe: select its project/worktree and open its chat panel.',
    { session_id: z.string().describe('The Floe session id to select.') },
    async ({ session_id }) => {
      try {
        const target = findSessionAny(session_id)
        if (!target) return textResult({ error: `Unknown session: ${session_id}` })
        pushCommand({
          kind: 'select_session',
          callerKey: token,
          sessionId: connKeyFor(target),
          title: target.title,
          worktreePath: target.worktreePath,
          projectPath: projectFor(target.worktreePath) ?? undefined
        })
        return textResult({ ok: true })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'create_followup',
    'Delegate a delayed check-in to Floe instead of sleeping/polling yourself: after delay_minutes, Floe sends `message` to the target session (default: this session) via send_message. Use this any time you would otherwise wait and follow up on another session or on yourself.',
    {
      session_id: z.string().optional().describe('The session to follow up on. Defaults to the calling session.'),
      delay_minutes: z.number().positive().describe('Minutes to wait before sending the message.'),
      message: z.string().describe('The message to send when the delay elapses.')
    },
    async ({ session_id, delay_minutes, message }) => {
      const targetId = session_id ?? token
      const id = scheduleFollowup(token, targetId, delay_minutes, message)
      return textResult({ id, sessionId: targetId, fireInMinutes: delay_minutes })
    }
  )

  server.tool('list_followups', "List this session's pending followups (created via create_followup).", {}, async () => {
    return textResult(listFollowupsFor(token))
  })

  server.tool(
    'cancel_followup',
    'Cancel a pending followup by id (from create_followup/list_followups).',
    { id: z.string().describe('The followup id.') },
    async ({ id }) => {
      return textResult({ cancelled: cancelFollowupById(id) })
    }
  )
}

function registerPlanTools(server: McpServer, token: string): void {
  // --- Plans ----------------------------------------------------------------

  server.tool(
    'list_plans',
    'List the plan files in a worktree.',
    {
      worktree: z.string().describe('The worktree path.'),
      branch: z.string().optional().describe('Optional branch to scope plans to.')
    },
    async ({ worktree, branch }) => {
      try {
        return textResult(listPlans(worktree, branch))
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'read_plan',
    'Read a plan file from a worktree.',
    {
      worktree: z.string().describe('The worktree path.'),
      path: z.string().describe('The plan file path relative to the worktree (from list_plans).')
    },
    async ({ worktree, path }) => {
      try {
        return textResult(readPlan(worktree, path))
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'open_plan',
    'Open a plan file in the Floe reader so the user sees it.',
    {
      worktree: z.string().describe('The worktree path.'),
      path: z.string().describe('The plan file path relative to the worktree.')
    },
    async ({ worktree, path }) => {
      try {
        pushCommand({ kind: 'open_plan', callerKey: token, worktreePath: worktree, relPath: path })
        return textResult({ ok: true })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )
}

function registerPlanExtraTools(server: McpServer): void {
  server.tool(
    'plan_phases',
    "A spec's implementation phases, as the Plans tab lists them: what each phase is called and whether it is done. The shape `/implement` walks.",
    {
      worktree: z.string().describe('The worktree path.'),
      branch: z.string().optional().describe("Which branch's specs/ folder. Defaults to the worktree's own branch.")
    },
    async ({ worktree, branch }) => {
      try {
        return textResult(readImplementPhases(worktree, branch))
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'copy_plan',
    'Copy a plan into another worktree, so a worktree cut for a plan carries its own copy (plans do not travel with the branch). Refuses to overwrite a plan of the same name.',
    {
      worktree: z.string().describe('The worktree the plan is in now.'),
      path: z.string().describe('The plan path relative to that worktree, from list_plans.'),
      destination: z.string().describe('The worktree path to copy it into.')
    },
    async ({ worktree, path, destination }) => {
      try {
        const name = path.split('/').pop() ?? path
        if (existsSync(join(destination, PLANS_DIR, name))) {
          return textResult({ error: `${name} already exists in ${destination} — rename it or delete it first.` })
        }
        return textResult(copyPlan(worktree, path, destination))
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )
}

function registerDrawingTools(server: McpServer, token: string): void {
  // --- Drawings -------------------------------------------------------------
  //
  // Every one of these writes THROUGH applyDelta, which merges by element
  // version — so a tool call and the user's open canvas can both be writing the
  // same file without either erasing the other. See src/main/draw/index.ts.

  const DRAW_TYPES = ['rectangle', 'ellipse', 'diamond', 'arrow', 'line', 'text', 'frame'] as const

  /**
   * Drawings already on screen, as `<worktree>|<relPath>`.
   *
   * Drawing is meant to be WATCHED — the panel follows the file, so the user
   * sees each shape land. Waiting for the agent to remember `open_drawing`
   * would make that a coin flip, so the first write to a drawing opens it
   * itself. Only the first: `open` re-focuses a panel that is already there,
   * and stealing focus on every stroke would make the chat unusable while a
   * diagram is being drawn.
   *
   * Per app run, not persisted. Closing the panel and having the next write
   * bring it back is the behaviour you want anyway.
   */
  const shown = new Set<string>()

  const reveal = (worktree: string, relPath: string): void => {
    const key = `${worktree}|${relPath}`
    if (shown.has(key)) return
    shown.add(key)
    pushCommand({ kind: 'open_drawing', callerKey: token, worktreePath: worktree, relPath })
  }

  const SKELETON = z.object({
    id: z.string().optional().describe('Stable id. Reuse it to edit this element later; omitted means a new one.'),
    type: z.enum(DRAW_TYPES),
    x: z.number().optional().describe('Left edge, in scene coordinates.'),
    y: z.number().optional().describe('Top edge, in scene coordinates.'),
    width: z.number().optional(),
    height: z.number().optional(),
    label: z.string().optional().describe('Caption drawn inside the shape (or on the arrow); a frame\'s title.'),
    text: z.string().optional().describe('The content of a `text` element.'),
    start: z.string().optional().describe('For an arrow/line: the id of the shape it leaves. Must already exist.'),
    end: z.string().optional().describe('For an arrow/line: the id of the shape it points at. Must already exist.'),
    strokeColor: z.string().optional().describe('Hex, e.g. "#1971c2".'),
    backgroundColor: z.string().optional().describe('Hex fill, e.g. "#a5d8ff". Default: transparent.')
  })

  server.tool(
    'list_drawings',
    'List the Excalidraw drawings in a worktree (.floe/draw/ drafts and the branch\'s specs/ scenes).',
    {
      worktree: z.string().describe('The worktree path.'),
      branch: z.string().optional().describe('Optional branch, to pick the matching specs/ folder.')
    },
    async ({ worktree, branch }) => {
      try {
        return textResult(listDrawings(worktree, branch))
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'read_drawing',
    'Read a drawing as a semantic summary — one line per element, with positions, labels and what points at what. Use this to see what is already on the canvas before adding to it.',
    {
      worktree: z.string().describe('The worktree path.'),
      path: z.string().describe('The drawing path relative to the worktree (from list_drawings).'),
      raw: z.boolean().optional().describe('Return the raw .excalidraw JSON instead. Large — only when you need a field the summary omits.')
    },
    async ({ worktree, path, raw }) => {
      try {
        const scene = readDrawing(worktree, path)
        return textResult(raw ? scene : summarize(scene))
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'create_drawing',
    [
      'Create an empty drawing and open it on screen. It lands in the branch\'s specs/ folder by default,',
      'where it is committed alongside the spec it illustrates; pass scope=draft for a scribble that should',
      'not reach a commit, in the gitignored .floe/draw/.',
      'Start here whenever the user asks for a diagram, a flow, an architecture sketch or a whiteboard —',
      'draw it on the canvas, not as ASCII art or a Mermaid block.'
    ].join(' '),
    {
      worktree: z.string().describe('The worktree path.'),
      name: z.string().describe('File name, with or without the .excalidraw extension.'),
      scope: z.enum(['draft', 'spec']).optional().describe('Default: spec.'),
      branch: z
        .string()
        .optional()
        .describe('Which specs/ folder to write into. Omitted, the worktree\'s own branch decides.')
    },
    async ({ worktree, name, scope, branch }) => {
      try {
        const file = createDrawing(worktree, name, scope, branch)
        // Straight onto the screen: the user asked to be shown a diagram, and
        // the empty canvas is where they watch it get drawn.
        reveal(worktree, file.relPath)
        return textResult(file)
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'draw_elements',
    [
      'Add or replace elements in a drawing. Give only what carries meaning — position, size, label, colour —',
      'and Floe fills in the rest of the Excalidraw model.',
      'An arrow takes `start`/`end` as the ids of the shapes it connects and is really bound to them, so',
      'moving a shape moves the arrow with it; both shapes must already exist, or be created in this same call.',
      'Reusing an id edits that element instead of adding a second one.',
      'A `label` is drawn INSIDE the shape and is wrapped to fit it: text is ~13px per character at the',
      'default 20px font, so a box needs `width` >= 13 x the longest line, and it grows taller by 25px per',
      'wrapped line. A diamond only gets HALF its width for the caption and an ellipse about 70% of it, so',
      'size those wider. A box left too narrow comes out as several cramped lines, and a word too long for',
      'the line is broken mid-word.',
      'The panel is live and opens itself on the first write, so prefer SEVERAL calls — one per part of',
      'the diagram — over one big one: the user watches it take shape, and can say "no, not like that"',
      'before you have drawn all of it.'
    ].join(' '),
    {
      worktree: z.string().describe('The worktree path.'),
      path: z.string().describe('The drawing path relative to the worktree.'),
      elements: z.array(SKELETON).min(1).describe('The elements to draw.')
    },
    async ({ worktree, path, elements }) => {
      try {
        const scene = readDrawing(worktree, path)
        const upserts = expandSkeletons(elements, scene.elements)
        const merged = applyDelta(worktree, path, { upserts })
        // The summary back, not just an ok: the agent's next call almost always
        // needs the ids and boxes it just made.
        // A drawing being written to is a drawing worth looking at.
        reveal(worktree, path)
        return textResult({ wrote: upserts.length, drawing: summarize(merged) })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'erase_elements',
    'Remove elements from a drawing by id. Ids that are not there (or already gone) are skipped, not refused.',
    {
      worktree: z.string().describe('The worktree path.'),
      path: z.string().describe('The drawing path relative to the worktree.'),
      ids: z.array(z.string()).min(1).describe('Element ids, from read_drawing.')
    },
    async ({ worktree, path, ids }) => {
      try {
        const scene = readDrawing(worktree, path)
        const upserts = eraseElements(scene.elements, ids)
        const merged = applyDelta(worktree, path, { upserts })
        // A drawing being written to is a drawing worth looking at.
        reveal(worktree, path)
        return textResult({ erased: upserts.length, drawing: summarize(merged) })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'move_elements',
    'Reposition (and optionally resize) elements by id, keeping everything else about them. Use this to lay a diagram out; redrawing an element would throw away edits the user made to it.',
    {
      worktree: z.string().describe('The worktree path.'),
      path: z.string().describe('The drawing path relative to the worktree.'),
      moves: z
        .array(
          z.object({
            id: z.string(),
            x: z.number(),
            y: z.number(),
            width: z.number().optional(),
            height: z.number().optional()
          })
        )
        .min(1)
    },
    async ({ worktree, path, moves }) => {
      try {
        const scene = readDrawing(worktree, path)
        const upserts = moveElements(scene.elements, moves)
        const merged = applyDelta(worktree, path, { upserts })
        // A drawing being written to is a drawing worth looking at.
        reveal(worktree, path)
        return textResult({ moved: upserts.length, drawing: summarize(merged) })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'promote_drawing',
    'Move a draft out of the gitignored .floe/draw/ and into the branch\'s specs/ folder, so the drawing is committed with the work. A drawing already there is left alone.',
    {
      worktree: z.string().describe('The worktree path.'),
      path: z.string().describe('The drawing path relative to the worktree.'),
      branch: z.string().optional().describe('Which specs/ folder. Omitted, the worktree\'s own branch decides.')
    },
    async ({ worktree, path, branch }) => {
      try {
        const file = promoteDrawing(worktree, path, branch)
        // The canvas was showing the old path, which no longer exists — send it
        // after the drawing rather than leaving it on a missing file.
        shown.delete(`${worktree}|${path}`)
        reveal(worktree, file.relPath)
        return textResult(file)
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'open_drawing',
    'Open a drawing on the canvas in Floe so the user sees it. The panel follows the file, so anything you draw after this appears live.',
    {
      worktree: z.string().describe('The worktree path.'),
      path: z.string().describe('The drawing path relative to the worktree.')
    },
    async ({ worktree, path }) => {
      try {
        // Unconditional, unlike `reveal`: asking for it explicitly is also how
        // you bring back a panel the user closed, or move focus onto it.
        shown.add(`${worktree}|${path}`)
        pushCommand({ kind: 'open_drawing', callerKey: token, worktreePath: worktree, relPath: path })
        return textResult({ ok: true })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )
}

function registerDecisionTools(server: McpServer): void {
  // --- Decision artifacts ---------------------------------------------------

  server.tool(
    'present_decision',
    [
      'Show the user an interactive decision panel inline in the chat and let them choose.',
      'Use this INSTEAD of a long prose list when you want the user to pick among options —',
      'e.g. compare design treatments, toggle variants (Wide/Narrow, Light/Dark), or shortlist',
      'and pick a favorite. It renders as native keyboard-first chips, not text.',
      'Each `group` is a single- or multi-select set of option chips. Optional `items` are',
      "candidates the user can shortlist (toggle) and pick one favorite from (radio).",
      "After you call it, STOP and wait — the user's selection arrives as a normal follow-up",
      'message; continue from there.'
    ].join(' '),
    {
      title: z.string().describe('Panel heading, e.g. the decision being made.'),
      subtitle: z.string().optional().describe('Optional one-line context under the title.'),
      groups: z
        .array(
          z.object({
            id: z.string().describe('Stable group id.'),
            label: z.string().describe('Group label shown to the user.'),
            select: z.enum(['single', 'multi']).describe('single = one choice, multi = many.'),
            options: z
              .array(z.object({ id: z.string(), label: z.string() }))
              .min(1)
              .describe('The selectable chips.'),
            default: z
              .union([z.string(), z.array(z.string())])
              .optional()
              .describe('Option id(s) selected initially.')
          })
        )
        .min(1)
        .describe('One or more choice groups (each a set of option chips).'),
      items: z
        .array(
          z.object({
            id: z.string(),
            title: z.string(),
            note: z.string().optional().describe('Short supporting detail.'),
            recommended: z.boolean().optional().describe('Pre-picks + shortlists this item.')
          })
        )
        .optional()
        .describe('Optional shortlist/pick candidates (e.g. the treatments being compared).'),
      submitLabel: z.string().optional().describe('Optional submit-button label.')
    },
    async ({ title, subtitle, groups, items, submitLabel }) => {
      // Validate through the same gate the renderer trusts. The panel itself is
      // emitted from the live stream handler (agent.ts sees this tool_use) —
      // here we only confirm the shape so a bad spec fails loudly, not silently.
      const spec = parseArtifactSpec({ type: 'decision', title, subtitle, groups, items, submitLabel })
      if (!spec) return textResult({ error: 'Invalid decision spec — check the field shapes and try again.' })
      return textResult({
        ok: true,
        note: "Decision panel shown. Wait for the user's follow-up message with their selection before continuing."
      })
    }
  )
}

function registerColonyTools(server: McpServer): void {
  // --- Colony (the agent board — one column per profile, one worktree per card)

  server.tool(
    'colony_board',
    "The project's colony board: every column with its skill, model and cap, and every task in it. Read this before answering anything about the board — the lanes move cards while you are idle, so a remembered board is a wrong one.",
    { project: z.string().describe('The repo root path of the project (a worktree path works too).') },
    async ({ project }) => {
      try {
        return textResult(boardFor(projectRoot(project)))
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'colony_add_task',
    'Put a task on the board. With start=true it is released straight away: its worktree and branch are cut, its brief is written to specs/<branch>/task.md, and it goes to the first stage. Without it, it waits in the backlog and costs nothing.',
    {
      project: z.string().describe('The repo root path of the project.'),
      name: z
        .string()
        .describe("Short kebab-case name — the branch's last segment. What the change IS, not what it fixes."),
      brief: z.string().describe('What the first lane reads. The request in the user\'s own words, plus the file, symbol or reproduction you can see.'),
      kind: z.enum(TASK_KINDS as [string, ...string[]]).optional().describe('feat, fix or chore. Defaults to feat.'),
      start: z.boolean().optional().describe('Release it now — this is what cuts the worktree. Default false.')
    },
    async ({ project, name, brief, kind, start }) => {
      try {
        const root = projectRoot(project)
        const task = addTask({ project: root, name, brief, kind: kind as TaskKind | undefined })
        const win = getWindow()
        if (start && win) {
          const released = await releaseTask(win, task.id)
          pushBoard(win, root)
          return textResult(released)
        }
        pushBoard(win, root)
        return textResult(task)
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'colony_start_task',
    'Release a task from the backlog: cut its worktree and branch, write its brief where the first lane looks for it, and put it at that stage\'s door. A no-op for a task that already left the backlog.',
    { task: z.string().describe('The task id, from colony_board.') },
    async ({ task }) => {
      try {
        const win = getWindow()
        if (!win) return textResult({ error: 'No window available to cut a worktree in.' })
        const released = await releaseTask(win, task)
        pushBoard(win, released.project)
        return textResult(released)
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'colony_remove_task',
    'Take a task off the board. Its worktree and branch are left standing — a card leaving the board is bookkeeping, and deleting work is a different question, asked by remove_worktree.',
    { task: z.string().describe('The task id, from colony_board.') },
    async ({ task }) => {
      try {
        const found = getTask(task)
        if (!found) return textResult({ error: `Unknown task: ${task}` })
        removeTask(task)
        pushBoard(getWindow(), found.project)
        return textResult({ ok: true, removed: found.name })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )
}

function registerSkillTools(server: McpServer): void {
  // --- Skills (Floe-owned, global or per project — config/skills.ts) --------
  // Administration only. To USE a skill, put `/name` in a send_message /
  // create_session prompt — expansion happens on send, same as the composer.

  server.tool(
    'list_skills',
    'List the skills available to a project: the global ones plus its own (a project skill wins over a global of the same name). Use a skill by putting /name in a prompt.',
    {
      project: z
        .string()
        .optional()
        .describe('The repo root path (a worktree path works too). Omit for the global skills only.')
    },
    async ({ project }) => {
      try {
        const root = rootFor(project)
        return textResult(listSkills(root).map(({ name, description, scope, file }) => ({ name, description, scope, file })))
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'read_skill',
    "A skill's raw markdown, frontmatter included — the editing view for update_skill.",
    {
      name: z.string().describe('The skill name, from list_skills.'),
      project: z.string().optional().describe('The repo root path (or a worktree path), for project skills.')
    },
    async ({ name, project }) => {
      try {
        const root = rootFor(project)
        const { skill, raw } = readSkillFile(name, root)
        return textResult({ name: skill.name, scope: skill.scope, file: skill.file, content: raw })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'create_skill',
    'Create a new Floe skill (global, or scoped to one project). It starts from the standard template; follow with update_skill to write the real content.',
    {
      name: z.string().describe('The skill name — letters, digits, - _ : only. This is what /name types.'),
      scope: z.enum(['global', 'project']).describe('global = every project; project = only the given one.'),
      project: z.string().optional().describe('The repo root path (or a worktree path). Required for scope=project.')
    },
    async ({ name, scope, project }) => {
      try {
        const root = rootFor(project)
        const skill = createSkill(name, scope, root)
        return textResult({ name: skill.name, scope: skill.scope, file: skill.file })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'update_skill',
    "Replace a skill's markdown wholesale. Keep the frontmatter (--- name/description ---) — `name:` is the token the composer matches, `description:` is shown in the list.",
    {
      name: z.string().describe('The skill name, from list_skills.'),
      content: z.string().describe('The full new markdown, frontmatter included.'),
      project: z.string().optional().describe('The repo root path (or a worktree path), for project skills.')
    },
    async ({ name, content, project }) => {
      try {
        const root = rootFor(project)
        const skill = updateSkill(name, content, root)
        return textResult({ ok: true, name: skill.name, file: skill.file })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'rename_skill',
    'Rename a skill — the file moves and the frontmatter `name:` follows, so /old stops working and /new starts.',
    {
      name: z.string().describe('The current skill name.'),
      to: z.string().describe('The new name — letters, digits, - _ : only.'),
      project: z.string().optional().describe('The repo root path (or a worktree path), for project skills.')
    },
    async ({ name, to, project }) => {
      try {
        const root = rootFor(project)
        const skill = renameSkill(name, to, root)
        return textResult({ ok: true, name: skill.name, file: skill.file })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'delete_skill',
    'Delete a skill: the file, or the whole directory a bundled one owns. Destructive — only on explicit intent.',
    {
      name: z.string().describe('The skill name, from list_skills.'),
      project: z.string().optional().describe('The repo root path (or a worktree path), for project skills.')
    },
    async ({ name, project }) => {
      try {
        const root = rootFor(project)
        deleteSkill(name, root)
        return textResult({ ok: true })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )
}

function registerMcpRegistryTools(server: McpServer): void {
  // --- MCP registry (Floe-owned third-party servers — config/mcpServers.ts) -
  // Floe projects these into every spawned session's --mcp-config, so an entry
  // registered here reaches whichever harness answers the turn. Changes apply
  // to sessions spawned AFTER the edit (the config is written per spawn).

  server.tool(
    'list_mcp_servers',
    "List the third-party MCP servers in Floe's registry (global + a project's own; project wins on a name clash). Disabled entries are included with enabled=false.",
    {
      project: z
        .string()
        .optional()
        .describe('The repo root path (a worktree path works too). Omit for the global registry only.')
    },
    async ({ project }) => {
      try {
        const root = rootFor(project)
        return textResult(listMcpServers(root).map(redactServer))
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'add_mcp_server',
    "Register a third-party MCP server in Floe's registry. It reaches every session spawned after this (merged into the per-session --mcp-config).",
    {
      name: z.string().describe('The server name — letters, digits, - _ only.'),
      scope: z.enum(['global', 'project']).describe('global = every project; project = only the given one.'),
      transport: z.enum(['http', 'stdio']).describe('http = a url; stdio = a command Floe-spawned CLIs run.'),
      url: z.string().optional().describe('The server url (http transport).'),
      command: z.string().optional().describe('The command to run (stdio transport).'),
      args: z.array(z.string()).optional().describe('Arguments for the stdio command.'),
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe('stdio only: environment the server needs, e.g. { API_KEY: "…" }. Stored in plain text in mcp.toml.'),
      headers: z
        .record(z.string(), z.string())
        .optional()
        .describe('http only: headers every request carries, e.g. { Authorization: "Bearer …" }. Stored in plain text in mcp.toml.'),
      enabled: z.boolean().optional().describe('Defaults to true.'),
      project: z.string().optional().describe('The repo root path (or a worktree path). Required for scope=project.')
    },
    async ({ name, scope, transport, url, command, args, env, headers, enabled, project }) => {
      try {
        const root = rootFor(project)
        const server_ = addMcpServer(scope, { name, transport, url, command, args, env, headers, enabled } as NewMcpServer, root)
        return textResult(redactServer(server_))
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'update_mcp_server',
    "Update an MCP server in Floe's registry (partial patch — only pass the fields to change). enabled=false turns it off without losing the entry.",
    {
      name: z.string().describe('The server name, from list_mcp_servers.'),
      new_name: z.string().optional(),
      transport: z.enum(['http', 'stdio']).optional(),
      url: z.string().optional().describe('Empty string removes the field.'),
      command: z.string().optional().describe('Empty string removes the field.'),
      args: z.array(z.string()).optional().describe('Empty array removes the field.'),
      env: z.record(z.string(), z.string()).optional().describe('stdio credentials. An empty object removes them.'),
      headers: z.record(z.string(), z.string()).optional().describe('http credentials. An empty object removes them.'),
      enabled: z.boolean().optional(),
      project: z.string().optional().describe('The repo root path (or a worktree path), for project entries.')
    },
    async ({ name, new_name, transport, url, command, args, env, headers, enabled, project }) => {
      try {
        const root = rootFor(project)
        return textResult(
          redactServer(updateMcpServer(name, { name: new_name, transport, url, command, args, env, headers, enabled }, root))
        )
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'remove_mcp_server',
    "Remove an MCP server from Floe's registry. Destructive — only on explicit intent (prefer update_mcp_server enabled=false to turn one off).",
    {
      name: z.string().describe('The server name, from list_mcp_servers.'),
      project: z.string().optional().describe('The repo root path (or a worktree path), for project entries.')
    },
    async ({ name, project }) => {
      try {
        const root = rootFor(project)
        removeMcpServer(name, root)
        return textResult({ ok: true })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'mcp_server_status',
    "Whether the registry's servers actually connect, as a session in this worktree sees them: connected, needs-auth or failed. This is the `claude:info` probe the MCP panel's chips come from, so it answers for Claude — the other harnesses report their own state in their own CLIs.",
    { worktree: z.string().describe('The worktree path a session would run in.') },
    async ({ worktree }) => {
      try {
        const info = await getClaudeInfo(worktree, mcpConfigFor('info-probe', worktree))
        return textResult(info.mcpServers)
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'authenticate_mcp_server',
    "Start the OAuth flow for a registry server that reports needs-auth. Floe runs `claude mcp login <name>` in a PTY and opens the consent page: a person has to approve it in the browser, so call this, tell the user to finish it, and read the outcome from mcp_server_status — this answers as soon as the flow is under way, not when it succeeds. The server must be one Claude can see (Floe's registry reaches spawned sessions; `claude mcp login` reads Claude's own config). Never returns a token.",
    {
      name: z.string().describe('The server name, from list_mcp_servers.'),
      worktree: z.string().describe('The worktree whose session the login is for.')
    },
    async ({ name, worktree }) => {
      try {
        const win = getWindow()
        if (!win) return textResult({ error: 'No window available — the consent page needs one.' })
        startMcpAuth(win, worktree, name)
        return textResult({ started: true, waitingOn: 'the user approving the consent page in the browser' })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )
}

/**
 * An entry as a tool may report it: names of the credentials, never values.
 *
 * The registry holds API keys and bearer tokens now, and every caller of
 * `list_mcp_servers` is an agent — including one running in a session the user
 * did not open. The panel (a person, at their own machine) still shows the file.
 */
export function redactServer(s: McpServerEntry): McpServerEntry {
  const mask = (o?: Record<string, string>): Record<string, string> | undefined =>
    o && Object.fromEntries(Object.keys(o).map((k) => [k, '***']))
  return { ...s, env: mask(s.env), headers: mask(s.headers) }
}

// --- Projects (the sidebar's own list — projects.ts) ------------------------
// Registering a repo is the one thing an agent could not do at all: the
// palette's `project.add` opens an input a person types into, so there was no
// headless way in.

function registerProjectTools(server: McpServer): void {
  server.tool(
    'add_project',
    'Register a git repository with Floe, the way "Add project…" does. The path must be a git repo, and it is resolved to the repo root first. Adding one Floe already has is not an error — it answers with the project it had, and `created: false`.',
    {
      path: z.string().describe('Absolute path of the repository root.'),
      group: z.string().optional().describe('Which sidebar group to put it in. Defaults to the first one.')
    },
    async ({ path, group }) => {
      try {
        const added = await addProjectByPath(path, group)
        if (added.error) return textResult({ error: added.error })
        pushRefresh('project.reload')
        return textResult(added)
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'remove_project',
    "Forget a project. Destructive in Floe only — the repository and its worktrees stay on disk, but Floe's record of them (and the sessions listed under them) goes. Only on explicit intent.",
    { path: z.string().describe('The repo root path, from list_projects.') },
    async ({ path }) => {
      try {
        const found = registeredProject(path)
        if (!found) return textResult({ error: `not a registered project: ${path}` })
        const projects = removeProject(found.path)
        pushRefresh('project.reload')
        return textResult({ removed: found.path, projects })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'update_project',
    "A project's own settings: what it is called, which group it sits in, whether it is pinned to the top, and whether it is read-only (a read-only project refuses worktree creation and edits).",
    {
      path: z.string().describe('The repo root path, from list_projects.'),
      name: z.string().optional().describe('Rename it in the sidebar.'),
      group: z.string().optional().describe('Move it to this group.'),
      pinned: z.boolean().optional().describe('Pin it to the top of the list.'),
      read_only: z.boolean().optional().describe('Refuse changes in this project.')
    },
    async ({ path, name, group, pinned, read_only }) => {
      try {
        const found = registeredProject(path)
        if (!found) return textResult({ error: `not a registered project: ${path}` })
        const at = found.path
        let projects = listProjects()
        if (name !== undefined) projects = renameProject(at, name)
        if (group !== undefined) projects = setProjectGroup(at, group)
        if (pinned !== undefined) projects = setProjectPinned(at, pinned)
        if (read_only !== undefined) projects = setProjectReadOnly(at, read_only)
        pushRefresh('project.reload')
        return textResult(projects.find((p) => p.path === at))
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )
}

// --- The worktree's registered processes, running (commandRunner.ts) --------
// `list_project_commands` / `add_project_command` write the definitions; these
// four are the buttons: run, stop, read the log, drop the row. The UI's own
// `command.run` acts on whatever the cursor is on, which is no use to an agent.

/** One command row, resolved from a name or an id, in the worktree it runs in. */
function commandRow(
  worktree: string,
  command: string
): { row: ProjectCommand; key: string; project: string; at: string } | { error: string } {
  // Resolved once, then used for everything below. `projectFor` prefix-matches
  // stored paths, so `/tmp/x` finds nothing when the project lives at
  // `/private/tmp/x` — and a run key built from the caller's spelling would be a
  // SECOND key for a command the UI is already running under its own.
  const at = realPath(worktree)
  const project = projectFor(at)
  if (!project) return { error: `no registered project owns ${worktree}` }
  const rows = listCommands(project, at)
  const row = rows.find((c) => c.id === command || c.name.toLowerCase() === command.toLowerCase())
  if (!row) return { error: `no command "${command}" here — this worktree has: ${rows.map((c) => c.name).join(', ') || 'none'}` }
  // The key the renderer uses, so main is tracking ONE run per command whether
  // it was started from a keybinding or from here.
  return { row, key: `${at}#${row.id}`, project, at }
}

function registerCommandRunTools(server: McpServer): void {
  server.tool(
    'run_project_command',
    "Start (or restart) one of the worktree's registered processes — the command pane's `r`. Only a command already in commands.toml: this runs a stored definition, never arbitrary shell.",
    {
      worktree: z.string().describe('The worktree path to run it in.'),
      command: z.string().describe('The command name or id, from list_project_commands.')
    },
    async ({ worktree, command }) => {
      try {
        const found = commandRow(worktree, command)
        if ('error' in found) return textResult(found)
        const win = getWindow()
        if (!win) return textResult({ error: 'No window available to run a command in.' })
        const { row, key, at } = found
        const branch = await branchOf(found.project, at)
        // 0×0: the log panel resizes the PTY when it attaches, exactly as it
        // does for a command started from a keybinding.
        const start = isCommandRunning(key) ? restartCommand : startCommand
        start(win, key, row.cwd || at, branch, row.command, 0, 0, row.watch, row.autoRestart)
        return textResult({ started: row.name, key })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'stop_project_command',
    'Stop a running registered process (and its file watcher, so it does not come straight back).',
    {
      worktree: z.string().describe('The worktree path.'),
      command: z.string().describe('The command name or id.')
    },
    async ({ worktree, command }) => {
      try {
        const found = commandRow(worktree, command)
        if ('error' in found) return textResult(found)
        stopCommand(getWindow(), found.key)
        return textResult({ stopped: found.row.name })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'read_command_output',
    "The tail of a running command's output — what the log panel shows, for a caller with no panel. Also reports whether it is still running.",
    {
      worktree: z.string().describe('The worktree path.'),
      command: z.string().describe('The command name or id.'),
      limit: z.number().optional().describe('How many lines from the end (default 200).')
    },
    async ({ worktree, command, limit }) => {
      try {
        const found = commandRow(worktree, command)
        if ('error' in found) return textResult(found)
        const run = commandRuns().find((r) => r.key === found.key)
        return textResult({
          name: found.row.name,
          running: isCommandRunning(found.key),
          state: run?.state,
          exitCode: run?.exitCode,
          output: commandOutput(found.key, limit ?? 200)
        })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'remove_project_command',
    'Delete a registered process from commands.toml. Stops it first if it is running — a row can be removed, its process cannot be orphaned.',
    {
      worktree: z.string().describe('The worktree path (the entry may be scoped to it).'),
      command: z.string().describe('The command name or id.')
    },
    async ({ worktree, command }) => {
      try {
        const found = commandRow(worktree, command)
        if ('error' in found) return textResult(found)
        // Unconditionally, not `if running`: during an auto-restart backoff the
        // run reads as stopped while its timer is still armed, and a removed row
        // whose process respawns has nothing left to stop it with.
        stopCommand(getWindow(), found.key)
        return textResult(removeCommand(found.project, found.at, found.row.id))
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )
}

// --- Unblocking and steering a session --------------------------------------

/**
 * What a session is parked on, whichever runtime asked. Claude's prompts live on
 * its conn (permissions and questions both); codex keeps its questions on the
 * app-server thread, and nothing else can ask at all.
 */
function promptsFor(key: string): PendingPrompt[] {
  const codex = codexPendingQuestion(key)
  return codex
    ? [{ requestId: codex.requestId, kind: 'question', questions: codex.texts.map((q) => ({ question: q, options: [] })) }]
    : pendingPrompts(key)
}

function registerSessionStateTools(server: McpServer, token: string): void {
  server.tool(
    'session_prompts',
    "What a session is blocked on: the AskUserQuestion prompts and tool-permission requests it raised and nobody has answered. `list_sessions` reports THAT one is waiting (needsYou); this reports what it is waiting for.",
    { session_id: z.string().describe('The Floe session id.') },
    async ({ session_id }) => {
      const target = findSessionAny(session_id)
      if (!target) return textResult({ error: `Unknown session: ${session_id}` })
      return textResult(promptsFor(connKeyFor(target)))
    }
  )

  server.tool(
    'answer_session_prompt',
    [
      'Answer a prompt from session_prompts: `answer` for a question, `allow` for a tool permission.',
      'Only for a session THIS caller created (create_session) — a session the user is sitting in front of is theirs to answer,',
      'and quietly approving its tool permissions from another agent is not something Floe will do.'
    ].join(' '),
    {
      session_id: z.string().describe('The Floe session id, from session_prompts.'),
      request_id: z.string().describe('The prompt id, from session_prompts.'),
      answer: z.string().optional().describe('The reply to a question.'),
      allow: z.boolean().optional().describe('For a permission: true runs the tool, false refuses it.')
    },
    async ({ session_id, request_id, answer, allow }) => {
      try {
        const target = findSessionAny(session_id)
        if (!target) return textResult({ error: `Unknown session: ${session_id}` })
        if (target.spawnedBy !== token) {
          return textResult({ error: 'That session was not created by this one — only its owner may answer for it.' })
        }
        const key = connKeyFor(target)
        // The request has to still be pending, and be the kind being answered:
        // the responders below take an unknown id without complaint (they send
        // a control response for `{}`), so an agent answering a stale prompt
        // would be told it worked.
        const prompt = promptsFor(key).find((p) => p.requestId === request_id)
        if (!prompt) {
          return textResult({ error: `Nothing is waiting on ${request_id} — call session_prompts for what is.` })
        }
        if (allow !== undefined) {
          if (prompt.kind !== 'permission') return textResult({ error: 'That one is a question — answer it with `answer`.' })
          respondPermission(key, request_id, allow)
          return textResult({ answered: request_id, allowed: allow })
        }
        if (answer === undefined) return textResult({ error: 'Pass `answer` for a question or `allow` for a permission.' })
        if (prompt.kind !== 'question') return textResult({ error: 'That one is a tool permission — answer it with `allow`.' })
        // Codex questions travel the app-server's own JSON-RPC, Claude's the
        // control channel. Same order index.ts answers them in.
        if (!answerCodexQuestion(key, [[answer]])) answerQuestion(key, request_id, answer)
        return textResult({ answered: request_id })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

}

// Steering one from outside: the composer's picker, and the close button.
function registerSessionPickerTools(server: McpServer): void {
  server.tool(
    'update_session',
    "Change what a session answers as, without sending it anything: harness, model, effort, permission mode, title. The picker in the composer, for an agent. Takes effect on its next turn.",
    {
      session_id: z.string().describe('The Floe session id.'),
      harness: z.enum(HARNESSES as [string, ...string[]]).optional().describe('Who answers from now on.'),
      model: z.string().optional().describe("That harness's own model slug."),
      effort: z.enum(EFFORTS).optional().describe('How hard to think.'),
      mode: z
        .enum(MODES.map((m) => m.id) as [PermissionMode, ...PermissionMode[]])
        .optional()
        .describe('plan, default (ask), acceptEdits (auto) or skip (bypass). Snapped to the nearest mode the harness can do.'),
      title: z.string().optional().describe('Rename it in the sidebar.')
    },
    async ({ session_id, harness, model, effort, mode, title }) => {
      try {
        const target = findSessionAny(session_id)
        if (!target) return textResult({ error: `Unknown session: ${session_id}` })
        if (title !== undefined) renameCreatedSession(target.id, title)
        if (harness || model || effort || mode) {
          // One write, because these four are one choice: a mode the new
          // harness cannot do is snapped here rather than failing the turn, and
          // a model belongs to the harness that offered it — switching harness
          // without naming one clears it back to that harness's own default
          // rather than handing codex an `opus`.
          const provider = harness ?? target.provider
          const switched = harness !== undefined && harness !== (target.provider ?? 'claude')
          setCreatedSessionChoice(target.id, {
            provider,
            model: model ?? (switched ? '' : undefined),
            effort,
            mode: mode ? nearestMode(mode, provider) : undefined
          })
        }
        pushEvent('sessions:changed')
        return textResult(sessionSummary(findSessionAny(session_id) ?? target))
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'close_session',
    'Close a session for good: its turn is stopped, its side conversations are dropped and it leaves the sidebar. The transcript on disk stays. Destructive — only on explicit intent.',
    { session_id: z.string().describe('The Floe session id.') },
    async ({ session_id }) => {
      try {
        const target = findSessionAny(session_id)
        if (!target) return textResult({ error: `Unknown session: ${session_id}` })
        const win = getWindow()
        if (win) stopAgent(win, connKeyFor(target))
        closeSessionFully(win ?? null, {
          id: target.id,
          worktreePath: target.worktreePath,
          claudeId: target.claudeId
        })
        pushEvent('sessions:changed')
        return textResult({ closed: target.id })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )
}

// --- Review: the commits, not just the working tree -------------------------

function registerReviewTools(server: McpServer): void {
  server.tool(
    'list_commits',
    "The commits on this branch since its review base — what the Changes panel lists above the working diff, newest first.",
    {
      worktree: z.string().describe('The worktree path.'),
      limit: z.number().optional().describe('How many to return (default 50).')
    },
    async ({ worktree, limit }) => {
      try {
        const commits = await reviewCommits(worktree)
        return textResult(commits.slice(0, limit ?? 50))
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'commit_diff',
    'The diff one commit made to one file (paths come from list_commits). For the uncommitted work, use file_diff.',
    {
      worktree: z.string().describe('The worktree path.'),
      commit: z.string().describe('The commit hash, from list_commits.'),
      path: z.string().describe('The file path relative to the worktree.')
    },
    async ({ worktree, commit, path }) => {
      try {
        return textResult(await commitFileDiff(worktree, commit, path))
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'set_review_base',
    "Move the line the Changes panel measures from. `clear` marks everything up to now as reviewed (the diff goes empty and rebuilds as new work lands); `restore` puts the base back where the branch started. `status` just reports which of the two it is on.",
    {
      worktree: z.string().describe('The worktree path.'),
      action: z.enum(['clear', 'restore', 'status']).describe('What to do with the review base.')
    },
    async ({ worktree, action }) => {
      try {
        if (action === 'clear') return textResult({ cleared: await clearReview(worktree) })
        if (action === 'restore') {
          restoreReview(worktree)
          return textResult({ restored: true })
        }
        return textResult({ cleared: hasReviewCheckpoint(worktree) })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )
}

function registerUsageTools(server: McpServer): void {
  server.tool(
    'harness_usage',
    "Every harness's own account state: which plan window is open, how much of it is spent, when it resets. What the topbar gauge reads, for an agent deciding whether to hand work to another harness.",
    {},
    async () => {
      try {
        return textResult(await localUsage())
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )
}

function registerCommandTools(server: McpServer, token: string): void {
  // --- UI commands (the renderer's registry) --------------------------------

  // --- Project commands (a project's named processes — commands.ts) ---------
  // Not to be confused with list_commands/run_command below, which are the UI's
  // palette commands. These write the project's own commands.toml: the dev
  // server, queue worker or watcher Floe runs in a worktree's command pane.

  server.tool(
    'list_project_commands',
    "The named processes Floe runs for a project (its commands.toml): dev server, queue worker, watcher. Not the UI's palette commands — those are list_commands.",
    {
      project: z.string().describe('The repo root path (a worktree path works too).')
    },
    async ({ project }) => {
      try {
        return textResult(projectCommands(projectRoot(project)))
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'add_project_command',
    'Register a process Floe can run for this project — it shows up in every worktree\'s command pane. For long-running things (servers, workers, watchers), not one-shot tasks like tests. Refuses a name already in use.',
    {
      project: z.string().describe('The repo root path (a worktree path works too).'),
      name: z.string().describe('What the row is called, e.g. "Dev" or "Queue".'),
      command: z.string().describe('The shell command, run in the worktree root.'),
      cwd: z.string().optional().describe('Working directory override — relative to the worktree.'),
      auto_start: z.boolean().optional().describe('Start it when a worktree is provisioned. Only for processes that are safe to run unattended.'),
      auto_restart: z.boolean().optional().describe('Bring it back when it exits.'),
      watch: z.array(z.string()).optional().describe('Globs that restart the command when they change.'),
      notify: z.enum(NOTIFY_LEVELS).optional().describe('How loudly its output notifies: all, important or none.'),
      worktree: z.string().optional().describe('Scope it to this one worktree path. Omit for every worktree of the project.')
    },
    async ({ project, name, command, cwd, auto_start, auto_restart, watch, notify, worktree }) => {
      try {
        const root = projectRoot(project)
        const commands = defineCommand(root, {
          name,
          command,
          cwd,
          autoStart: auto_start,
          autoRestart: auto_restart,
          watch,
          notify,
          worktree
        })
        return textResult({ ok: true, commands })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'list_commands',
    "List Floe's UI commands — everything the palette (⌘K) and the keymap can dispatch — with availability right now. Run one with run_command.",
    {},
    async () => {
      const result = await awaitCommand({ kind: 'list_commands', callerKey: token, requestId: randomUUID() })
      if (!result.ok) {
        // No window to ask — the shared id list still answers "what exists".
        return textResult({ note: result.error, ids: COMMAND_IDS })
      }
      return textResult(result.commands ?? [])
    }
  )

  server.tool(
    'run_command',
    'Run one of Floe\'s UI commands by id (from list_commands) — the same dispatch a keybinding or the palette uses. Commands act on what is currently on screen, e.g. `panel.goto` takes the panel kind as `arg`.',
    {
      command_id: z.string().describe('The command id, e.g. "panel.goto" or "session.new".'),
      arg: z.string().optional().describe('The argument some commands take (panel kind, index…).')
    },
    async ({ command_id, arg }) => {
      const result = await awaitCommand({
        kind: 'run_command',
        callerKey: token,
        requestId: randomUUID(),
        commandId: command_id,
        arg
      })
      if (!result.ok) return textResult({ error: result.error ?? 'The command did not run.' })
      return textResult({ ok: true })
    }
  )
}

/** A plugin's declared params as the zod raw shape `server.tool` wants. */
export function pluginShape(params?: Record<string, PluginToolParam>): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [key, p] of Object.entries(params ?? {})) {
    let s: z.ZodTypeAny = p.type === 'number' ? z.number() : p.type === 'boolean' ? z.boolean() : z.string()
    if (p.description) s = s.describe(p.description)
    if (p.optional) s = s.optional()
    shape[key] = s
  }
  return shape
}

function registerPluginToolsOn(server: McpServer): void {
  // --- Plugin tools (plugins/host.ts) ---------------------------------------
  // Registered after the built-ins so a plugin can never shadow one: a name
  // collision throws inside server.tool and costs only that plugin's tool.
  for (const t of pluginTools()) {
    try {
      server.tool(t.name, t.description, pluginShape(t.params), async (args: Record<string, unknown>) => {
        try {
          return textResult(await t.run(args))
        } catch (e) {
          return textResult({ error: (e as Error).message })
        }
      })
    } catch {
      // duplicate tool name — the built-in (or an earlier plugin) wins
    }
  }
}


// Parse the caller token out of a /mcp/<token> path. Returns '' if it doesn't match.
function tokenFromUrl(url: string | undefined): string {
  if (!url) return ''
  const path = url.split('?')[0]
  const m = /^\/mcp\/([^/]+)\/?$/.exec(path)
  return m ? decodeURIComponent(m[1]) : ''
}

// Read the full request body (the MCP JSON-RPC POST payload).
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (!chunks.length) return resolve(undefined)
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => resolve(undefined))
  })
}

// Handle one request statelessly: a fresh McpServer + transport per request,
// tools registered with the URL token as the caller identity. This keeps
// identity-by-URL trivial and avoids any session-state bookkeeping.
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // CSRF / DNS-rebinding guard, per the MCP spec's advice for HTTP servers: an
  // MCP client (the claude CLI) never sends an Origin header, while a browser
  // page attacking this loopback route always does — and a rebinding attack
  // arrives with a non-loopback Host. Reject both; the bind stays the primary
  // protection.
  const host = (req.headers.host ?? '').split(':')[0]
  if (req.headers.origin || (host !== '127.0.0.1' && host !== 'localhost')) {
    res.statusCode = 403
    res.end('Forbidden')
    return
  }

  const token = tokenFromUrl(req.url)
  if (!token) {
    res.statusCode = 404
    res.end('Not found')
    return
  }

  const server = new McpServer({ name: 'floe', version: '1.0.0' })
  registerTools(server, token)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

  res.on('close', () => {
    void transport.close()
    void server.close()
  })

  try {
    await server.connect(transport)
    const body = req.method === 'POST' ? await readBody(req) : undefined
    await transport.handleRequest(req, res, body)
  } catch (e) {
    if (!res.headersSent) {
      res.statusCode = 500
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: (e as Error).message }, id: null }))
    }
  }
}

// Start the loopback-only HTTP server once at boot. Prefers the fixed port; if
// it's taken (a second Floe instance), retries once on an ephemeral port so the
// app still works — per-session configs are rewritten each spawn, only the
// global registration wants the fixed port.
export function startMcpServer(getWindow: () => BrowserWindow | undefined): void {
  getWindowRef = getWindow
  if (httpServer) return
  httpServer = createServer((req, res) => {
    void handle(req, res)
  })
  const onListening = (): void => {
    const addr = httpServer?.address()
    if (addr && typeof addr === 'object') serverPort = addr.port
    // Publish it where the non-Claude harnesses read it (mcpHarness.ts).
    setMcpPort(serverPort)
    boundPreferred = serverPort === PREFERRED_PORT
    // Auto-register in the user's global Claude config on boot, so a fresh
    // install guarantees the floe tools exist in every claude session with no
    // manual step. Only when we hold the preferred port — otherwise we'd persist
    // a registration pointing at an ephemeral port that won't survive the next
    // launch. Idempotent + best-effort; the ⌘K "Install Floe MCP globally"
    // command stays as the manual fallback. FLOE_MCP_NO_REGISTER keeps the
    // hermetic test from shelling `claude mcp add` on every `pnpm test`.
    if (boundPreferred && !process.env.FLOE_MCP_NO_REGISTER) void ensureGlobalRegistered()
  }
  httpServer.once('error', () => {
    httpServer?.listen(0, '127.0.0.1', onListening)
  })
  httpServer.listen(PREFERRED_PORT, '127.0.0.1', onListening)
}

// Register Floe's MCP server in the user's GLOBAL Claude config (`-s user`),
// so any `claude` session — inside Floe or in a plain terminal — gets the floe
// tools. Replaces any prior entry first so re-running is idempotent.
function runClaude(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('claude', args, { timeout: 15_000 }, (err, stdout, stderr) => {
      resolve({
        code: err ? (((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) as number) : 0,
        out: `${stdout}${stderr}`.trim()
      })
    })
  })
}

export async function installGlobal(): Promise<{ ok: boolean; message: string }> {
  if (!serverPort) return { ok: false, message: 'The MCP server is not running yet — try again in a moment.' }
  const url = mcpUrlFor(GLOBAL_TOKEN)
  // Every harness the user might open a terminal with, not just Claude — the
  // same reason a spawned session gets the config whichever CLI answers it.
  const results = await installEverywhere(url)
  return { ok: results.some((r) => r.ok), message: installMessage(results, url, boundPreferred) }
}

// Boot-time idempotent wrapper around installGlobal(): if Claude already has the
// exact registration we'd write, do nothing; otherwise (re)install it. Never
// throws — a missing `claude` CLI just leaves the manual command as fallback.
async function ensureGlobalRegistered(): Promise<void> {
  const url = mcpUrlFor(GLOBAL_TOKEN)
  try {
    const current = await new Promise<string>((resolve) => {
      execFile('claude', ['mcp', 'get', 'floe'], { timeout: 15_000 }, (_err, stdout, stderr) =>
        resolve(`${stdout}${stderr}`)
      )
    })
    if (current.includes(url)) return // already registered at the right URL
  } catch {
    // fall through and (re)install
  }
  // Claude only, and deliberately: it has a CLI that owns its own config, so
  // this is not Floe editing a file the user hand-wrote. The other harnesses
  // are registered when the user asks for it (installGlobal).
  await runClaude(['mcp', 'remove', '-s', 'user', 'floe'])
  const add = await runClaude(['mcp', 'add', '-s', 'user', '-t', 'http', 'floe', url])
  if (add.code !== 0) log('mcp-global-register-failed', { out: add.out })
}

// Every per-session config written this run. They carry the registry's
// credentials, and the filename is fixed by the managed hooks' ps-ancestry walk
// (hooks.ts DETECT_FLOE), so they cannot move into the 0700 directory the other
// harnesses' configs use — they are deleted on the way out instead.
const written = new Set<string>()

function clearSessionConfigs(): void {
  for (const file of written) {
    try {
      rmSync(file, { force: true })
    } catch {
      /* best-effort — the file is 0600 either way */
    }
  }
  written.clear()
}

// Write (or rewrite) the per-session --mcp-config file and return its path.
// agent.ts passes this to `claude --mcp-config <path>`. Written lazily so a call
// before the server's listen callback still produces a valid file once the port
// is known (the server starts at boot, well before any session spawns). The
// `floe-mcp-` filename is also what the managed hooks' ps-ancestry walk detects
// (see hooks.ts DETECT_FLOE) — renaming it breaks them.
export function mcpConfigFor(key: string, worktreePath?: string): string {
  const file = join(app.getPath('temp'), `floe-mcp-${key}.json`)
  written.add(file)
  written.add(file)
  try {
    writeFileSync(file, JSON.stringify(claudeMcpConfig(serversFor(key, worktreePath))), { mode: 0o600 })
  } catch {
    // Non-fatal: agent.ts will still pass the path; a missing file just means no
    // floe tools for that session.
  }
  return file
}

/**
 * The config a QUERY spawns with: no servers at all.
 *
 * A query gets no Floe token (D8). The token IS the session id (`/mcp/<key>`),
 * and a query key resolves to no session — so a query would carry a token
 * `findSessionAny` cannot resolve and every tool that depends on it would break
 * in silence. Mating that with the read-only promise, the honest answer is that
 * a conversation which only reads should not be opening panels, creating
 * sessions or running commands in the app either.
 *
 * But not minting the token is not enough on its own: without a config of its
 * own the CLI falls back to the Floe server registered GLOBALLY and comes back
 * as `/mcp/global` — the same tools under the wrong identity. So the query is
 * handed an empty config, and `--strict-mcp-config` alongside it (agent.ts) to
 * ignore the global and project ones.
 */
export function emptyMcpConfigFor(key: string): string {
  const file = join(app.getPath('temp'), `floe-mcp-none-${key}.json`)
  written.add(file)
  try {
    writeFileSync(file, JSON.stringify({ mcpServers: {} }))
  } catch {
    // Non-fatal, exactly as above: the path is still passed, and a missing file
    // means no servers — which is what this asked for anyway.
  }
  return file
}

export function shutdown(): void {
  for (const f of followups.values()) clearTimeout(f.timer)
  followups.clear()
  httpServer?.close()
  httpServer = undefined
  serverPort = 0
  setMcpPort(0)
  clearHarnessConfigs()
  clearSessionConfigs()
}
