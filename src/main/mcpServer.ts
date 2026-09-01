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
  McpCommand,
  McpCommandResult,
  PermissionMode,
  Worktree
} from '../shared/types'
import { COMMAND_IDS } from '../shared/commandIds'
import { expandSkills } from '../shared/skills'
import { parseArtifactSpec } from '../shared/artifact'
import { listProjects } from './projects'
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
import { listPlans, readPlan } from './plans'
import { loadClaudeTranscript, sessionHasUnansweredQuestion } from './claudeSessions'
import {
  addCreatedSession,
  getAllCreatedSessions,
  getCreatedSessions,
  setCreatedSessionSpawnedBy,
  type CreatedSession
} from './sessionStore'
import { readSessionBuffer, sendToAgent, sessionRuntime, stopAgent, waitForTurn } from './agent'
import {
  createSkill,
  deleteSkill,
  listSkills,
  readSkill,
  readSkillFile,
  renameSkill,
  updateSkill
} from './config/skills'
import { projectFor } from './config/projectStore'
import { pluginTools } from './plugins/host'
import {
  addMcpServer,
  listMcpServers,
  removeMcpServer,
  updateMcpServer,
  type NewMcpServer
} from './config/mcpServers'
import { searchMcpServers } from './config/mcpDiscovery'

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

// Forward a UI command (select_session / open_plan / run_command / list_commands)
// to the renderer, which runs its existing lane/registry flows.
function pushCommand(command: McpCommand): void {
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send('mcp:command', command)
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
function connKeyFor(s: CreatedSession): string {
  for (const k of [s.id, s.claudeId, ...(s.pastClaudeIds ?? [])]) {
    if (k && sessionRuntime(k).live) return k
  }
  return s.claudeId ?? s.id
}

function runOptionsFor(s: CreatedSession): AgentRunOptions {
  return {
    // A session an agent drives has no human in front of it to answer prompts,
    // so default to skip unless the session was explicitly set stricter.
    permissionMode: s.permissionMode ?? 'skip',
    model: s.model,
    effort: s.effort
  }
}

// Skills expand on the MCP path exactly like agent:start's — `/deploy` has to
// mean the same thing whichever door the prompt came in through.
function expandPrompt(worktreePath: string, prompt: string): string {
  return expandSkills(prompt, (name) => readSkill(name, projectFor(worktreePath) ?? undefined))
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
  sendToAgent(win, connKeyFor(target), target.worktreePath, expandPrompt(target.worktreePath, message), runOptionsFor(target))
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

const sessionSummary = (s: CreatedSession): Record<string, unknown> => ({
  id: s.id,
  title: s.title,
  worktreePath: s.worktreePath,
  claudeId: s.claudeId,
  running: sessionRuntime(connKeyFor(s)).running
})

// Register every floe tool on a fresh McpServer, with `token` (the caller's
// Floe session key) captured in each closure so a tool knows who called it.
function registerTools(server: McpServer, token: string): void {
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
      note: z.string().optional().describe('An optional short note/label for the worktree.')
    },
    async ({ project, branch, base, note }) => {
      try {
        const worktrees = await createWorktree(project, branch, { base, note })
        pushWorktrees(project, worktrees)
        const created =
          worktrees.find((w) => w.branch === branch || w.path.endsWith(branch)) ?? worktrees[worktrees.length - 1]
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
    async ({ project, worktree }) => {
      try {
        const result = await mergeWorktree(project, worktree)
        if (result.ok) pushWorktrees(project, await listWorktrees(project))
        return textResult(result)
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'start_merge',
    "Open Floe's GUIDED merge for a worktree: the step-by-step checklist panel (preflight → merge → resolve → review → commit → fast-forward → teardown) that pauses at the review checkpoint for the user to approve. Prefer this over merge_worktree when a human is around — merge_worktree is the headless one-shot with no review stop. Navigates the UI to the worktree's project if needed.",
    { worktree: z.string().describe('The worktree path to merge into its base.') },
    async ({ worktree }) => {
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

  // --- Sessions + communication --------------------------------------------

  server.tool(
    'list_sessions',
    'List the sessions Floe knows about, optionally filtered to one worktree. `running` means a turn is in flight right now; `needsYou` (only computed when `worktree` is given) means the session is blocked on you — an unanswered question or a tool-permission prompt.',
    { worktree: z.string().optional().describe('Limit to sessions in this worktree path.') },
    async ({ worktree }) => {
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
    async ({ worktree, prompt, title, select, model, mode }) => {
      try {
        const id = randomUUID()
        const storedTitle = addCreatedSession({ id, worktreePath: worktree, title: title ?? prompt?.slice(0, 60) })
        // No human sits in front of a session an agent opened: mark it so the
        // parent (not the user) is responsible for its questions.
        setCreatedSessionSpawnedBy(id, token)
        if (prompt) {
          const win = getWindow()
          if (!win) return textResult({ error: 'No window available to run the session.' })
          const options: AgentRunOptions = { permissionMode: (mode as PermissionMode) ?? 'skip', model }
          sendToAgent(win, id, worktree, expandPrompt(worktree, prompt), options)
        }
        if (select === true) {
          pushCommand({
            kind: 'select_session',
            callerKey: token,
            sessionId: id,
            title: storedTitle,
            worktreePath: worktree,
            projectPath: projectFor(worktree) ?? undefined
          })
        }
        return textResult({ sessionId: id, title: storedTitle })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'send_message',
    'Send a prompt to another Floe session. With wait=true, block until that session finishes its turn and return its final assistant text.',
    {
      session_id: z.string().describe('The Floe session id to send to.'),
      prompt: z.string().describe('The message to send.'),
      wait: z.boolean().optional().describe('Wait for the turn to complete and return the assistant reply.')
    },
    async ({ session_id, prompt, wait }) => {
      try {
        const target = findSessionAny(session_id)
        if (!target) return textResult({ error: `Unknown session: ${session_id}` })
        const win = getWindow()
        if (!win) return textResult({ error: 'No window available to run the session.' })
        const key = connKeyFor(target)
        // Spawn the conn (if needed) BEFORE waiting, so a brand-new session has a
        // live process for waitForTurn to resolve against.
        sendToAgent(win, key, target.worktreePath, expandPrompt(target.worktreePath, prompt), runOptionsFor(target))
        if (wait) {
          const text = await waitForTurn(key)
          return textResult({ sessionId: target.id, reply: text })
        }
        return textResult({ sessionId: target.id, ack: true })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'read_session_output',
    'Read recent output from a session: the live in-memory buffer plus, if linked, the tail of its on-disk transcript.',
    {
      session_id: z.string().describe('The Floe session id to read.'),
      limit: z.number().optional().describe('Max number of transcript lines to include (default 50).')
    },
    async ({ session_id, limit }) => {
      try {
        const target = findSessionAny(session_id)
        const cap = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : 50
        const live = target ? readSessionBuffer(connKeyFor(target)) : readSessionBuffer(session_id)
        let disk = ''
        if (target?.claudeId) {
          const items = loadClaudeTranscript(target.worktreePath, target.claudeId)
          const lines = items
            .map((it) => {
              if (it.role === 'image') return '[image]'
              if (it.role === 'tool') return `[tool ${it.name ?? ''}] ${it.summary ?? ''}`.trim()
              return `${it.role}: ${it.text ?? ''}`
            })
            .filter(Boolean)
          disk = lines.slice(-cap).join('\n')
        }
        const combined = [disk, live].filter(Boolean).join('\n').trim()
        if (!combined) return textResult({ output: '', note: 'No output yet for this session.' })
        return textResult({ output: combined })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

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
        const root = project ? (projectFor(project) ?? project) : undefined
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
        const root = project ? (projectFor(project) ?? project) : undefined
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
        const root = project ? (projectFor(project) ?? project) : undefined
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
        const root = project ? (projectFor(project) ?? project) : undefined
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
        const root = project ? (projectFor(project) ?? project) : undefined
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
        const root = project ? (projectFor(project) ?? project) : undefined
        deleteSkill(name, root)
        return textResult({ ok: true })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

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
        const root = project ? (projectFor(project) ?? project) : undefined
        return textResult(listMcpServers(root))
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'search_mcp_servers',
    "Look a third-party MCP server up in the public registry (registry.modelcontextprotocol.io) and get its published config — transport, url or command/args, and any secrets it still needs. Feed the chosen one straight to add_mcp_server instead of guessing an install line.",
    {
      query: z.string().describe('What to look for — a server name like "context7" or "playwright".')
    },
    async ({ query }) => {
      try {
        return textResult(await searchMcpServers(query))
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
      enabled: z.boolean().optional().describe('Defaults to true.'),
      project: z.string().optional().describe('The repo root path (or a worktree path). Required for scope=project.')
    },
    async ({ name, scope, transport, url, command, args, enabled, project }) => {
      try {
        const root = project ? (projectFor(project) ?? project) : undefined
        const server_ = addMcpServer(scope, { name, transport, url, command, args, enabled } as NewMcpServer, root)
        return textResult(server_)
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
      enabled: z.boolean().optional(),
      project: z.string().optional().describe('The repo root path (or a worktree path), for project entries.')
    },
    async ({ name, new_name, transport, url, command, args, enabled, project }) => {
      try {
        const root = project ? (projectFor(project) ?? project) : undefined
        return textResult(updateMcpServer(name, { name: new_name, transport, url, command, args, enabled }, root))
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
        const root = project ? (projectFor(project) ?? project) : undefined
        removeMcpServer(name, root)
        return textResult({ ok: true })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  // --- UI commands (the renderer's registry) --------------------------------

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

  // --- Plugin tools (plugins/host.ts) ---------------------------------------
  // Registered after the built-ins so a plugin can never shadow one: a name
  // collision throws inside server.tool and costs only that plugin's tool.
  for (const t of pluginTools()) {
    const shape: Record<string, z.ZodTypeAny> = {}
    for (const [key, p] of Object.entries(t.params ?? {})) {
      let s: z.ZodTypeAny = p.type === 'number' ? z.number() : p.type === 'boolean' ? z.boolean() : z.string()
      if (p.description) s = s.describe(p.description)
      if (p.optional) s = s.optional()
      shape[key] = s
    }
    try {
      server.tool(t.name, t.description, shape, async (args: Record<string, unknown>) => {
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
export function installGlobal(): Promise<{ ok: boolean; message: string }> {
  const url = `http://127.0.0.1:${serverPort}/mcp/${GLOBAL_TOKEN}`
  const run = (args: string[]): Promise<{ code: number; out: string }> =>
    new Promise((resolve) => {
      execFile('claude', args, { timeout: 15_000 }, (err, stdout, stderr) => {
        resolve({
          code: err ? (((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) as number) : 0,
          out: `${stdout}${stderr}`.trim()
        })
      })
    })
  return (async () => {
    if (!serverPort) return { ok: false, message: 'The MCP server is not running yet — try again in a moment.' }
    // Best-effort remove of a stale entry; ignore "not found".
    await run(['mcp', 'remove', '-s', 'user', 'floe'])
    const add = await run(['mcp', 'add', '-s', 'user', '-t', 'http', 'floe', url])
    if (add.code !== 0) {
      const hint = /ENOENT|not found/i.test(add.out) ? ' (is the `claude` CLI on PATH?)' : ''
      return { ok: false, message: `Failed to register Floe MCP${hint}: ${add.out || 'unknown error'}` }
    }
    const warn = boundPreferred
      ? ''
      : ' Note: Floe is on a fallback port this run, so restart it once to make the registration durable.'
    return { ok: true, message: `Floe MCP registered globally at ${url}. Any claude session can now drive Floe.${warn}` }
  })()
}

// Boot-time idempotent wrapper around installGlobal(): if Claude already has the
// exact registration we'd write, do nothing; otherwise (re)install it. Never
// throws — a missing `claude` CLI just leaves the manual command as fallback.
async function ensureGlobalRegistered(): Promise<void> {
  const url = `http://127.0.0.1:${serverPort}/mcp/${GLOBAL_TOKEN}`
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
  await installGlobal()
}

// Write (or rewrite) the per-session --mcp-config file and return its path.
// agent.ts passes this to `claude --mcp-config <path>`. Written lazily so a call
// before the server's listen callback still produces a valid file once the port
// is known (the server starts at boot, well before any session spawns). The
// `floe-mcp-` filename is also what the managed hooks' ps-ancestry walk detects
// (see hooks.ts DETECT_FLOE) — renaming it breaks them.
export function mcpConfigFor(key: string, worktreePath?: string): string {
  const file = join(app.getPath('temp'), `floe-mcp-${key}.json`)
  const mcpServers: Record<string, unknown> = {
    floe: {
      type: 'http',
      url: `http://127.0.0.1:${serverPort}/mcp/${encodeURIComponent(key)}`
    }
  }
  // Merge Floe's own MCP registry (global + this worktree's project) so a
  // server registered once in the panel reaches every session — the skills
  // model applied to MCP config. Best-effort: a broken mcp.toml costs its
  // entries (Settings shows the parse error), never the floe tools.
  try {
    const project = worktreePath ? (projectFor(worktreePath) ?? undefined) : undefined
    for (const s of listMcpServers(project)) {
      if (!s.enabled || s.name === 'floe') continue
      mcpServers[s.name] =
        s.transport === 'http' ? { type: 'http', url: s.url } : { command: s.command, args: s.args ?? [] }
    }
  } catch {
    // ignore — the registry is additive
  }
  try {
    writeFileSync(file, JSON.stringify({ mcpServers }))
  } catch {
    // Non-fatal: agent.ts will still pass the path; a missing file just means no
    // floe tools for that session.
  }
  return file
}

export function shutdown(): void {
  for (const f of followups.values()) clearTimeout(f.timer)
  followups.clear()
  httpServer?.close()
  httpServer = undefined
  serverPort = 0
}
