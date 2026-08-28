import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createConnection } from 'node:net'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app, type BrowserWindow } from 'electron'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { COMMAND_IDS } from '../shared/commandIds'
import type { McpActivity, McpCommand, McpCommandResult, McpView, Worktree } from '../shared/types'
import { addProjectByPath, listProjects } from './projects'
import { createWorktree, listWorktrees } from './git'
import { provisionWorktree } from './provision'
import { listPlans } from './plans'
import { parseArtifactSpec } from '../shared/artifact'
import { loadClaudeTranscript } from './claudeSessions'
import { getCreatedSession, getCreatedSessions, setCreatedSessionSpawnedBy } from './sessionStore'
import { handleFleet, locateSession, publishPort, recordEdge, type FocusResult } from './fleet'
import { readSessionBuffer, sendToAgent, waitForTurn } from './agent'
import { askCodex, MAX_EXCHANGES } from './codex'
import { dbQuery, dbTables } from './database'
import { createSchedule, deleteSchedule, readSchedules, updateSchedule } from './schedules'
import { ensurePinentry, isUnlocked, pollUnlocked, unlockCommand } from './unlock'
import type { AgentRunOptions, Effort, PermissionMode } from '../shared/types'

// The MCP control server runs inside the Electron main process so its tools have
// direct access to git / sessionStore / the agent conns AND to win.webContents
// to drive the renderer — no inter-process bridge needed. Each spawned `claude`
// session gets a per-session --mcp-config whose url carries the session's own key
// as a path token (/mcp/<key>), so a tool call always knows its caller.

// A fixed preferred port so a GLOBAL Claude registration (claude mcp add) stays
// valid across app restarts — an ephemeral port would change every launch and
// leave the global config pointing at nothing. We still fall back to an ephemeral
// port if this one is taken (e.g. a second Rookery instance); per-session configs
// are written fresh each spawn so they don't care, but the global install only
// stays durable when we hold the preferred port.
const PREFERRED_PORT = 41573

// The path token used by the global (non-Rookery-spawned) Claude registration.
// In-app sessions carry their own session id as the token; external sessions all
// share this one, so tool calls attribute their activity to "global".
const GLOBAL_TOKEN = 'global'

// The callerKey on a command pushed by the Fleet dashboard. The renderer keys off
// it to raise its own window (docs/fleet.md).
export const FLEET_TOKEN = 'fleet'

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

// Push the transient "Claude is acting on Rookery" signal so the renderer can
// show its non-blocking outline-chip banner. Auto-permitido, mas nunca silencioso.
function pushActivity(activity: McpActivity): void {
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send('mcp:activity', activity)
}

// Forward a UI command (switch_view / select_session / open_plan / create_session)
// to the renderer, which runs its existing dispatch()/selectSession/openPlan flows.
function pushCommand(command: McpCommand): void {
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send('mcp:command', command)
}

// Tell the renderer a project's worktree set changed (e.g. via create_worktree),
// so the sidebar refreshes its list/count — the MCP path has no React state of its
// own, unlike the in-app create flow which updates it directly.
function pushWorktrees(project: string, worktrees: Worktree[]): void {
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send('worktrees:updated', { project, worktrees })
}

// --- create_session round-trip -------------------------------------------
// The renderer owns session creation (the live Session object lives there), so a
// create_session tool sends an mcp:command and parks a resolver keyed by the
// requestId; index.ts calls resolveCommandResult when the renderer replies over
// mcp:command-result.
const pendingResults = new Map<string, (result: McpCommandResult) => void>()

export function resolveCommandResult(result: McpCommandResult): void {
  const resolve = pendingResults.get(result.requestId)
  if (resolve) {
    pendingResults.delete(result.requestId)
    resolve(result)
  }
}

function awaitCreateSession(command: Extract<McpCommand, { kind: 'create_session' }>, timeoutMs = 30_000): Promise<McpCommandResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingResults.delete(command.requestId)
      resolve({ requestId: command.requestId, ok: false, error: 'Timed out waiting for the renderer to create the session.' })
    }, timeoutMs)
    pendingResults.set(command.requestId, (result) => {
      clearTimeout(timer)
      resolve(result)
    })
    pushCommand(command)
  })
}

// The persisted CreatedSession shape a tool needs (worktreePath + run options).
type SessionRecord = {
  id: string
  worktreePath: string
  title: string
  claudeId?: string
  permissionMode?: PermissionMode
  model?: string
  effort?: Effort
}

// Robust session lookup: scan all worktrees of all projects for the id.
// CreatedSession.worktreePath is the worktree dir (not the project root), and
// sessionStore filters by worktree, so we enumerate every worktree to find it.
async function findSessionAny(id: string): Promise<SessionRecord | undefined> {
  for (const project of listProjects()) {
    let worktrees: Awaited<ReturnType<typeof listWorktrees>>
    try {
      worktrees = await listWorktrees(project.path)
    } catch {
      continue
    }
    for (const wt of worktrees) {
      const match = getCreatedSessions(wt.path).find((s) => s.id === id)
      if (match) return match
    }
  }
  return undefined
}

// --- Followups: delegate a delayed send_message to Rookery ----------------
// An agent that would otherwise `sleep 3m` then poll another session (or itself)
// registers a followup instead; Rookery's own timer fires the send_message so the
// calling turn can end immediately. In-memory only — a restart drops pending
// followups.
// ponytail: no disk persistence; if followups need to survive an app restart,
// persist {sessionId, message, fireAt} and reschedule leftover ones on boot.
interface FollowupEntry {
  id: string
  fromToken: string
  sessionId: string
  message: string
  fireAt: number
  timer: NodeJS.Timeout
}

const followups = new Map<string, FollowupEntry>()

async function deliverFollowup(fromToken: string, sessionId: string, message: string): Promise<void> {
  const target = await findSessionAny(sessionId)
  const win = getWindow()
  if (!target || !win) return
  recordEdge({ from: fromToken, to: sessionId, kind: 'send_message', preview: message, waited: false })
  sendToAgent(win, sessionId, target.worktreePath, message, {
    permissionMode: target.permissionMode ?? 'skip',
    model: target.model,
    effort: target.effort
  })
}

function scheduleFollowup(fromToken: string, sessionId: string, delayMinutes: number, message: string): string {
  const id = randomUUID()
  const fireAt = Date.now() + delayMinutes * 60_000
  const timer = setTimeout(() => {
    followups.delete(id)
    void deliverFollowup(fromToken, sessionId, message)
  }, delayMinutes * 60_000)
  followups.set(id, { id, fromToken, sessionId, message, fireAt, timer })
  return id
}

function listFollowupsFor(fromToken: string): Array<{ id: string; sessionId: string; message: string; fireInMinutes: number }> {
  return [...followups.values()]
    .filter((f) => f.fromToken === fromToken)
    .map((f) => ({ id: f.id, sessionId: f.sessionId, message: f.message, fireInMinutes: Math.max(0, Math.round((f.fireAt - Date.now()) / 60_000)) }))
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

// Register every rookery tool on a fresh McpServer, with `token` (the caller's
// Rookery session key) captured in each closure so a tool knows who called it.
function registerTools(server: McpServer, token: string): void {
  const activity = (tool: string, target?: string): void => pushActivity({ callerKey: token, tool, target })

  // --- Worktrees (run directly in main) ------------------------------------

  server.tool('list_projects', 'List the git projects registered in Rookery.', {}, async () => {
    activity('list_projects')
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
      activity('list_worktrees', project)
      try {
        return textResult(await listWorktrees(project))
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'create_worktree',
    'Create a new git worktree (and branch) in a project. When you create a worktree on your own initiative (scratch/agent work the user did not explicitly ask for), name the branch `worktree-agent-<random hex>` (e.g. `worktree-agent-a73b9f`) — these are hidden from the Rookery UI. Only use a normal, meaningful branch name when the user asked for the worktree.',
    {
      project: z.string().describe('The repo root path of the project.'),
      branch: z
        .string()
        .describe(
          'The branch name to create or reuse. For self-initiated/scratch worktrees the user did not ask for, use `worktree-agent-<random hex>`.'
        ),
      base: z.string().optional().describe('The base branch to fork from (defaults to the main branch).'),
      note: z.string().optional().describe('An optional short note/label for the worktree.')
    },
    async ({ project, branch, base, note }) => {
      activity('create_worktree', branch)
      try {
        const worktrees = await createWorktree(project, branch, { base, note })
        pushWorktrees(project, worktrees)
        const created = worktrees.find((w) => w.branch === branch || w.path.endsWith(branch)) ?? worktrees[worktrees.length - 1]
        // Run the per-stack setup (copy .env, install deps, DB, containers, …) the
        // same way the in-app create flow does — otherwise an MCP-created worktree
        // lands with no environment. Fire-and-forget; progress streams to the panel.
        const win = getWindow()
        if (win && created) void provisionWorktree(win, project, created.path, created.branch)
        return textResult({ created, worktrees })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'start_pipeline',
    "Run Rookery's own visual pipeline in a worktree — the tracked rail shown in the sidebar (specify → clarify → plan → review → tasks → implement → refactor for a feature; bugfix → clarify → fix → refactor for a defect), NOT hand-typed /ds-* prompts. Use this instead of sending /ds-specify etc. as chat messages — those skip the rail entirely and leave the UI with no visible progress. Fire-and-forget: the pipeline runs to completion (or pauses on AskUserQuestion) in the renderer.",
    {
      worktree: z.string().describe('The worktree path to run the pipeline in.'),
      input: z.string().describe('The seed for the run — a Jira issue code or a free-text description.'),
      kind: z
        .enum(['implement', 'bugfix'])
        .optional()
        .describe('implement = full feature flow; bugfix = lighter defect flow. Defaults to implement.'),
      session_id: z.string().optional().describe('Attach to this existing Rookery session instead of opening a new one.')
    },
    async ({ worktree, input, kind, session_id }) => {
      activity('start_pipeline', worktree)
      try {
        pushCommand({
          kind: 'start_pipeline',
          callerKey: token,
          worktreePath: worktree,
          input,
          pipelineKind: kind ?? 'implement',
          sessionId: session_id
        })
        return textResult({ ok: true })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  // --- Schedules (cron-triggered headless runs) ----------------------------

  server.tool(
    'list_schedules',
    'List the scheduled cron jobs for a project. Each fires a headless Claude session with its prompt on a schedule — no human is present to answer AskUserQuestion, so prefer prompts/skills that run to completion unattended.',
    { project: z.string().describe('The repo root path of the project.') },
    async ({ project }) => {
      activity('list_schedules', project)
      try {
        return textResult(readSchedules(project))
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'create_schedule',
    'Create a scheduled cron job for a project. Fires a headless Claude session (no human present — avoid prompts that call AskUserQuestion) in the project\'s root worktree when the cron expression is due.',
    {
      project: z.string().describe('The repo root path of the project.'),
      name: z.string().describe('A short label for the schedule.'),
      cron: z.string().describe('A standard 5-field cron expression (minute hour day-of-month month day-of-week), e.g. "0 3 * * *".'),
      prompt: z.string().describe('The first message sent to the headless session, e.g. "/deploy patch".'),
      model: z.string().optional().describe('Claude alias (opus, sonnet, haiku, fable) to run the session with.'),
      enabled: z.boolean().optional().describe('Defaults to true.')
    },
    async ({ project, name, cron, prompt, model, enabled }) => {
      activity('create_schedule', name)
      try {
        return textResult(createSchedule(project, { name, cron, prompt, model, enabled }))
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'update_schedule',
    'Update a scheduled cron job (partial patch — only pass the fields to change).',
    {
      project: z.string().describe('The repo root path of the project.'),
      id: z.string().describe('The schedule id, from list_schedules/create_schedule.'),
      name: z.string().optional(),
      cron: z.string().optional().describe('A standard 5-field cron expression.'),
      prompt: z.string().optional(),
      model: z.string().optional(),
      enabled: z.boolean().optional()
    },
    async ({ project, id, name, cron, prompt, model, enabled }) => {
      activity('update_schedule', id)
      try {
        return textResult(updateSchedule(project, id, { name, cron, prompt, model, enabled }))
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'delete_schedule',
    'Delete a scheduled cron job.',
    {
      project: z.string().describe('The repo root path of the project.'),
      id: z.string().describe('The schedule id, from list_schedules/create_schedule.')
    },
    async ({ project, id }) => {
      activity('delete_schedule', id)
      try {
        deleteSchedule(project, id)
        return textResult({ ok: true })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  // --- Sessions + communication --------------------------------------------

  server.tool(
    'list_sessions',
    'List the Claude sessions Rookery knows about, optionally filtered to one worktree.',
    { worktree: z.string().optional().describe('Limit to sessions in this worktree path.') },
    async ({ worktree }) => {
      activity('list_sessions', worktree)
      try {
        const sessions: Array<{ id: string; title: string; worktreePath: string; claudeId?: string }> = []
        if (worktree) {
          for (const s of getCreatedSessions(worktree)) sessions.push({ id: s.id, title: s.title, worktreePath: s.worktreePath, claudeId: s.claudeId })
        } else {
          for (const project of listProjects()) {
            let worktrees: Awaited<ReturnType<typeof listWorktrees>>
            try {
              worktrees = await listWorktrees(project.path)
            } catch {
              continue
            }
            for (const wt of worktrees) {
              for (const s of getCreatedSessions(wt.path)) sessions.push({ id: s.id, title: s.title, worktreePath: s.worktreePath, claudeId: s.claudeId })
            }
          }
        }
        return textResult(sessions)
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'create_session',
    'Create a new Claude session in a worktree, optionally sending a first prompt and selecting it.',
    {
      worktree: z.string().describe('The worktree path to create the session in.'),
      prompt: z.string().optional().describe('An optional first prompt to send as the session opens.'),
      title: z.string().optional().describe('An optional session title.'),
      select: z.boolean().optional().describe('Whether to make this the active session.'),
      model: z
        .string()
        .optional()
        .describe('Which model to open the session with: a Claude alias (opus, sonnet, haiku, fable) or a Codex model slug. Defaults to the composer\'s current model.')
    },
    async ({ worktree, prompt, title, select, model }) => {
      activity('create_session', title ?? worktree)
      try {
        const requestId = randomUUID()
        const result = await awaitCreateSession({
          kind: 'create_session',
          callerKey: token,
          requestId,
          worktreePath: worktree,
          prompt,
          title,
          select,
          model
        })
        if (!result.ok) return textResult({ error: result.error ?? 'Failed to create the session.' })
        // Spawning IS the edge. An agent that opens a session and hands it the first
        // prompt inline never calls send_message, so without this the pair sits on the
        // board with no wire between them.
        if (result.sessionId) {
          recordEdge({ from: token, to: result.sessionId, kind: 'create_session', preview: prompt ?? title ?? '', waited: false })
          // No human sits in front of a session an agent opened: mark it so its
          // AskUserQuestion is answered here instead of interrupting the user.
          setCreatedSessionSpawnedBy(result.sessionId, token)
        }
        return textResult({ sessionId: result.sessionId })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'send_message',
    'Send a prompt to another Rookery session. With wait=true, block until that session finishes its turn and return its final assistant text.',
    {
      session_id: z.string().describe('The Rookery session id to send to.'),
      prompt: z.string().describe('The message to send.'),
      wait: z.boolean().optional().describe('Wait for the turn to complete and return the assistant reply.')
    },
    async ({ session_id, prompt, wait }) => {
      activity('send_message', session_id)
      try {
        const target = await findSessionAny(session_id)
        if (!target) return textResult({ error: `Unknown session: ${session_id}` })
        const win = getWindow()
        if (!win) return textResult({ error: 'No window available to run the session.' })
        const options: AgentRunOptions = {
          permissionMode: target.permissionMode ?? 'skip',
          model: target.model,
          effort: target.effort
        }
        // Persist the agent→agent edge. This is the only funnel cross-talk goes
        // through (the block-native-agents hook turns every subagent into a real
        // session), so recording it here needs no instrumentation in the agents.
        recordEdge({ from: token, to: session_id, kind: 'send_message', preview: prompt, waited: wait === true })
        // Spawn the conn (if needed) BEFORE waiting, so a brand-new session has a
        // live process for waitForTurn to resolve against.
        sendToAgent(win, session_id, target.worktreePath, prompt, options)
        if (wait) {
          const text = await waitForTurn(session_id)
          return textResult({ sessionId: session_id, reply: text })
        }
        return textResult({ sessionId: session_id, ack: true })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'create_followup',
    'Delegate a delayed check-in to Rookery instead of sleeping/polling yourself: after delay_minutes, Rookery sends `message` to the target session (default: this session) via send_message. Use this any time you would otherwise wait and follow up on another session or on yourself.',
    {
      session_id: z.string().optional().describe('The session to follow up on. Defaults to the calling session.'),
      delay_minutes: z.number().positive().describe('Minutes to wait before sending the message.'),
      message: z.string().describe('The message to send when the delay elapses.')
    },
    async ({ session_id, delay_minutes, message }) => {
      const target = session_id ?? token
      activity('create_followup', target)
      const id = scheduleFollowup(token, target, delay_minutes, message)
      return textResult({ id, sessionId: target, fireInMinutes: delay_minutes })
    }
  )

  server.tool(
    'list_followups',
    'List this session\'s pending followups (created via create_followup).',
    {},
    async () => {
      activity('list_followups')
      return textResult(listFollowupsFor(token))
    }
  )

  server.tool(
    'cancel_followup',
    'Cancel a pending followup by id (from create_followup/list_followups).',
    {
      id: z.string().describe('The followup id.')
    },
    async ({ id }) => {
      activity('cancel_followup', id)
      return textResult({ cancelled: cancelFollowupById(id) })
    }
  )

  server.tool(
    'read_session_output',
    'Read recent output from a session: the live in-memory buffer plus, if linked, the tail of its on-disk transcript.',
    {
      session_id: z.string().describe('The Rookery session id to read.'),
      limit: z.number().optional().describe('Max number of transcript lines to include (default 50).')
    },
    async ({ session_id, limit }) => {
      activity('read_session_output', session_id)
      try {
        const target = await findSessionAny(session_id)
        const cap = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : 50
        const live = readSessionBuffer(session_id)
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
    'ask_codex',
    [
      'Pair-program with the local Codex CLI: send it a message and get its reply.',
      'Use this to get a second opinion or have Codex analyze code alongside you.',
      'Codex runs read-only in this session\'s worktree and shows up as a subagent in the tree.',
      'Call it repeatedly to hold a back-and-forth: each call continues the same Codex thread.',
      'MACHINE-TO-MACHINE: this channel is you⇄Codex, not for a human to read. Write your `prompt` at maximum signal density — terse fragments, technical shorthand, file:line/symbol references instead of re-explaining shared context, no pleasantries or hedging, lead with the delta. Reserve human-readable prose for the FINAL summary you give the user once you and Codex have converged.',
      `Keep going until you and Codex reach a shared conclusion, but after ${MAX_EXCHANGES} exchanges you MUST stop and use AskUserQuestion to ask the user how to proceed — the tool will refuse further calls until then.`,
      'Set new_topic=true to start a fresh discussion from scratch.'
    ].join(' '),
    {
      prompt: z.string().describe('Your message to Codex.'),
      new_topic: z.boolean().optional().describe('Start a new Codex thread and reset the exchange count.')
    },
    async ({ prompt, new_topic }) => {
      activity('ask_codex', prompt.slice(0, 40))
      try {
        const session = await findSessionAny(token)
        if (!session) return textResult({ error: 'ask_codex must be called from within a Rookery session.' })
        const win = getWindow()
        if (!win) return textResult({ error: 'No window available to run Codex.' })
        // A SELF-edge: Codex has no session of its own. askCodex spawns `codex
        // exec` as an inline subagent of THIS session (codex.ts emits
        // subagent-start/progress on the caller's key), so there is no second
        // card to draw a wire to — the caller is talking to its own sidecar.
        // Always `waited`: askCodex is awaited, the caller is blocked on the reply.
        recordEdge({ from: token, to: token, kind: 'ask_codex', preview: prompt, waited: true })
        const result = await askCodex(win, token, session.worktreePath, prompt, new_topic === true)
        if (result.capped) {
          return textResult({
            status: 'paused',
            exchanges_used: MAX_EXCHANGES,
            note: `You have exchanged ${MAX_EXCHANGES} messages with Codex without a firm conclusion. Do NOT call ask_codex again yet. Summarize the discussion so far and use AskUserQuestion to ask the user how they want to proceed. If they say to continue, call ask_codex again and a fresh round will start.`
          })
        }
        if (result.error) return textResult({ error: result.error })
        const last = result.exchange === MAX_EXCHANGES
        return textResult({
          reply: result.reply,
          exchange: `${result.exchange}/${MAX_EXCHANGES}`,
          note: last
            ? 'This was the final exchange in this round. If you have reached a conclusion, summarize it for the user; otherwise stop and use AskUserQuestion to check in — the next ask_codex call will be refused until you do.'
            : 'If the discussion has reached a shared conclusion, summarize it for the user. Otherwise reply to Codex by calling ask_codex again with your response.'
        })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  // --- Passphrase unlock (GPG/SSH) -----------------------------------------

  server.tool(
    'request_unlock',
    [
      'Unlock a passphrase-protected signing key when a git action needs it — call this',
      'the moment a `git commit` fails with "gpg: signing failed: Inappropriate ioctl for',
      'device" (or ssh-add / SSH_ASKPASS errors). It opens a small terminal in Rookery where',
      'the user types the passphrase into pinentry directly; Rookery never sees the secret.',
      'If the key is already unlocked it returns instantly without bothering anyone. After',
      '{ ok: true } comes back, RETRY the git operation. On { ok: false } tell the user why.'
    ].join(' '),
    {
      kind: z.enum(['gpg', 'ssh']).describe('gpg = signing passphrase (commit.gpgsign); ssh = ssh-add a key.'),
      reason: z.string().optional().describe('Optional short reason shown to the user, e.g. "signing commit".')
    },
    async ({ kind, reason }) => {
      activity('request_unlock', reason ?? kind)
      try {
        const session = await findSessionAny(token)
        if (!session) return textResult({ error: 'request_unlock must be called from within a Rookery session.' })
        const cwd = session.worktreePath

        // Cache quente? Retorna na hora, sem abrir nada.
        if (await isUnlocked(kind, cwd)) return textResult({ ok: true, note: 'Already unlocked.' })

        // gpg headless precisa de um pinentry de TTY — garante antes de abrir o PTY.
        let pinentryNote: string | undefined
        if (kind === 'gpg') {
          const p = ensurePinentry()
          if (!p.ok) return textResult({ ok: false, error: p.error })
          pinentryNote = p.note
        }

        const command = await unlockCommand(kind, cwd) // throws if gpg has no signingkey

        // PTY efêmero: `#unlock-` faz o snapshot da worktree pular este terminal.
        const terminalId = `term:${cwd}#unlock-${randomUUID().slice(0, 8)}`
        pushCommand({ kind: 'unlock_open', callerKey: token, worktreePath: cwd, terminalId, command })

        // 120s: melhor devolver "usuário não respondeu" do que pendurar o agente.
        const ok = await pollUnlocked(kind, cwd, 120_000)
        pushCommand({ kind: 'unlock_close', callerKey: token, terminalId })

        if (ok) return textResult({ ok: true, note: pinentryNote })
        return textResult({ ok: false, error: 'Timed out waiting for the passphrase (120s). Try request_unlock again.' })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  // --- Navigation (forward to renderer) ------------------------------------

  server.tool(
    'run_command',
    [
      "Run any command from Rookery's UI command registry by id.",
      'This is the same registry the keyboard and the command palette use, so anything',
      'the user can do with a key, you can do here. Call list_commands first to see the',
      'ids and what each one does.'
    ].join(' '),
    {
      command: z.string().describe('The command id, e.g. "panel.goto" or "cursor.down".'),
      arg: z.string().optional().describe('The command argument, when it takes one (e.g. the panel kind).')
    },
    async ({ command, arg }) => {
      activity('run_command', command)
      try {
        pushCommand({ kind: 'run_command', callerKey: token, commandId: command, arg })
        return textResult({ ok: true })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'list_commands',
    "List the UI commands run_command accepts, with their titles and groups.",
    {},
    async () => {
      activity('list_commands', '')
      return textResult({ commands: COMMAND_IDS })
    }
  )

  server.tool(
    'switch_view',
    'Switch the active view in Rookery.',
    {
      view: z.enum(['files', 'review', 'plans', 'tasks', 'pr', 'database']).describe('Which view to switch to.'),
      worktree: z.string().optional().describe('Optionally switch in the context of this worktree.')
    },
    async ({ view, worktree }) => {
      activity('switch_view', view)
      try {
        pushCommand({ kind: 'switch_view', callerKey: token, view: view as McpView, worktreePath: worktree })
        return textResult({ ok: true })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  // --- Database (read-only, shown live in Rookery's database view) ----------

  server.tool(
    'list_tables',
    [
      "List the tables in this session's worktree database.",
      'The connection is detected from the worktree .env (MySQL / Postgres / SQLite); read-only.',
      'Also opens the database view in Rookery so the user sees the tables. Use this to discover',
      'what you can query before calling run_query.'
    ].join(' '),
    {},
    async () => {
      activity('list_tables')
      try {
        const session = await findSessionAny(token)
        if (!session) return textResult({ error: 'list_tables must be called from within a Rookery session.' })
        const res = await dbTables(session.worktreePath)
        pushCommand({ kind: 'switch_view', callerKey: token, view: 'database', worktreePath: session.worktreePath })
        if (res.error) return textResult({ error: res.error, config: res.config })
        return textResult({ config: res.config, tables: res.tables.map((t) => t.name) })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'run_query',
    [
      "Run a read-only SQL query against this session's worktree database. The query and its rows",
      'render LIVE in Rookery\'s database view for the user, and the rows are also returned to you.',
      'ALWAYS use this — never `mysql`/`psql`/`php artisan`/tinker in Bash — whenever the user asks to',
      'see, show, list, or inspect data, so it lands in the UI instead of only in chat. Also use it to',
      'explore schema (SHOW TABLES, SHOW COLUMNS FROM t, DESCRIBE t, PRAGMA table_info(t)).',
      'Read-only: only SELECT / WITH / SHOW / EXPLAIN / DESCRIBE / PRAGMA are allowed (writes rejected).',
      'Rows are capped (default 100); add your own LIMIT for less.'
    ].join(' '),
    {
      sql: z.string().describe('A single read-only SQL statement (SELECT/SHOW/EXPLAIN/DESCRIBE/WITH/PRAGMA).'),
      table: z.string().optional().describe('If the query previews one table, its name — used as the view header.')
    },
    async ({ sql, table }) => {
      activity('run_query', sql.slice(0, 60))
      try {
        const session = await findSessionAny(token)
        if (!session) return textResult({ error: 'run_query must be called from within a Rookery session.' })
        const result = await dbQuery(session.worktreePath, sql)
        // Show it in the UI regardless of outcome (errors render inline there too).
        pushCommand({ kind: 'db_result', callerKey: token, worktreePath: session.worktreePath, sql, table, result })
        if (result.error) return textResult({ error: result.error })
        return textResult({
          columns: result.columns,
          rows: result.rows,
          rowCount: result.rowCount,
          truncated: result.truncated ?? false
        })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'select_session',
    'Select (focus) a session in Rookery.',
    { session_id: z.string().describe('The Rookery session id to select.') },
    async ({ session_id }) => {
      activity('select_session', session_id)
      try {
        pushCommand({ kind: 'select_session', callerKey: token, sessionId: session_id })
        return textResult({ ok: true })
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
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
      activity('list_plans', worktree)
      try {
        return textResult(listPlans(worktree, branch))
      } catch (e) {
        return textResult({ error: (e as Error).message })
      }
    }
  )

  server.tool(
    'open_plan',
    'Open a plan file in Rookery.',
    {
      worktree: z.string().describe('The worktree path.'),
      relPath: z.string().describe('The plan file path relative to the worktree.')
    },
    async ({ worktree, relPath }) => {
      activity('open_plan', relPath)
      try {
        pushCommand({ kind: 'open_plan', callerKey: token, worktreePath: worktree, relPath })
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
      'candidates the user can shortlist (toggle) and pick one favorite from (radio).',
      'After you call it, STOP and wait — the user\'s selection arrives as a normal follow-up',
      'message (e.g. "Decision — …: Width: Narrow · Theme: Light. Pick: Signal rail"); continue from there.'
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
      // emitted from the live stream handler (agent.ts) which sees this tool_use —
      // here we only confirm the shape so a bad spec fails loudly, not silently.
      const spec = parseArtifactSpec({ type: 'decision', title, subtitle, groups, items, submitLabel })
      if (!spec) return textResult({ error: 'Invalid decision spec — check the field shapes and try again.' })
      activity('present_decision', title)
      return textResult({
        ok: true,
        note: 'Decision panel shown. Wait for the user\'s follow-up message with their selection before continuing.'
      })
    }
  )
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
  // The Fleet dashboard's read-only routes (+ focus), token-gated. Ahead of the
  // /mcp/<token> parse because they're not MCP calls and carry their own auth.
  if (await handleFleet(req, res, { focus: fleetFocus })) return

  // The `rookery <dir>` CLI hits this loopback route (not an MCP call) to add a
  // folder and bring it to front — Rookery's answer to `code .`.
  if (req.method === 'POST' && (req.url ?? '').split('?')[0] === '/open') {
    await handleOpen(req, res)
    return
  }

  const token = tokenFromUrl(req.url)
  if (!token) {
    res.statusCode = 404
    res.end('Not found')
    return
  }

  const server = new McpServer({ name: 'rookery', version: '1.0.0' })
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

// Bring the app window to the front (used by the CLI's open route and Fleet).
// On the headless server this is a no-op: the shim's show()/focus() are empty
// stubs and link's main process can't raise a window on another machine — the
// renderer raises itself there (see fleetFocus / App's select_session).
export function focusWindow(): void {
  const win = getWindow()
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
  if (process.platform === 'darwin') app.focus({ steal: true })
}

// A tap on a Fleet card. The select itself is the same push the select_session
// tool makes; `callerKey: 'fleet'` is what tells the renderer this came from
// outside, so an attached window knows to raise ITSELF on the user's machine.
// Reports what actually happened — on the server the raise is the client's job,
// and in a plain browser tab it will probably be ignored, which is worth saying
// out loud rather than answering a blind ok.
const FOCUS_ACK_MS = 2500

export async function fleetFocus(sessionId: string): Promise<FocusResult> {
  const where = await locateSession(sessionId)
  if (!where) return { ok: false, raised: false, focused: 'none', message: `Unknown session: ${sessionId}` }
  if (!where.projectPath)
    return {
      ok: false,
      raised: false,
      focused: 'none',
      message: 'That session\'s worktree no longer exists (or its project is not registered here), so there is nothing to open.'
    }
  // Ask the renderer and WAIT for its ack: it's the only side that knows whether
  // a window exists to raise. On the desktop main raises it too (authoritative,
  // and instant); on the server the ack is the whole answer.
  const requestId = randomUUID()
  const ack = new Promise<McpCommandResult | null>((resolve) => {
    const timer = setTimeout(() => {
      pendingResults.delete(requestId)
      resolve(null)
    }, FOCUS_ACK_MS)
    pendingResults.set(requestId, (result) => {
      clearTimeout(timer)
      resolve(result)
    })
    // Carry WHERE it lives: a Fleet tap almost always targets another project,
    // and the renderer can only select a session whose worktree list is loaded.
    pushCommand({
      kind: 'select_session',
      callerKey: FLEET_TOKEN,
      sessionId,
      requestId,
      worktreePath: where.worktreePath,
      projectPath: where.projectPath
    })
  })
  if (!process.env.ROOKERY_SERVER) focusWindow()
  const result = await ack
  if (!result?.ok)
    return {
      ok: false,
      raised: false,
      focused: 'none',
      message: 'No Rookery window took the command — nothing was selected. Is a window open and attached?'
    }
  const raised = result.raised === true || !process.env.ROOKERY_SERVER
  return {
    ok: true,
    raised,
    focused: raised ? 'window' : 'requested',
    message: raised
      ? 'Session selected and the Rookery window came forward.'
      : 'Session selected, but the window did not come forward (a browser tab usually ignores the raise) — switch to Rookery manually.'
  }
}

// `rookery <dir>`: add the folder as a project, then tell the renderer to refresh
// its list and select it, and pull the window to the front. Plain JSON in/out.
async function handleOpen(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const reply = (status: number, body: { ok: boolean; message: string }): void => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  }
  // CSRF / DNS-rebinding guard: the `rookery` CLI is plain curl with no Origin and
  // a loopback Host. A browser page attacking this route always sends an Origin,
  // and a rebinding attack arrives with a non-loopback Host — reject both. (Cheaper
  // and CLI-change-free vs. a shared token; the route only adds a local git repo.)
  const host = (req.headers.host ?? '').split(':')[0]
  if (req.headers.origin) return reply(403, { ok: false, message: 'Forbidden.' })
  if (host !== '127.0.0.1' && host !== 'localhost') return reply(403, { ok: false, message: 'Forbidden.' })
  try {
    const body = (await readBody(req)) as { path?: unknown } | undefined
    const path = typeof body?.path === 'string' ? body.path : ''
    if (!path) return reply(400, { ok: false, message: 'Missing "path".' })
    const { project, error } = await addProjectByPath(path)
    if (error || !project) return reply(400, { ok: false, message: error ?? 'Could not add the project.' })
    pushCommand({ kind: 'open_project', callerKey: GLOBAL_TOKEN, projectPath: project.path })
    focusWindow()
    reply(200, { ok: true, message: `Opened ${project.name} in Rookery.` })
  } catch (e) {
    reply(500, { ok: false, message: (e as Error).message })
  }
}

// Start the loopback-only HTTP server once at boot. Listens on an ephemeral port
// (0 → the OS picks); the real port is read back for the per-session config urls.
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
    // Tell the Fleet dashboard where we actually landed — a fallback port is
    // otherwise an invisible instance (see publishPort).
    publishPort(serverPort)
    // Auto-register in the user's global Claude config on boot, so a fresh install
    // on a new machine guarantees the rookery tools exist in every claude session
    // with no manual step. Only when we hold the preferred port — otherwise we'd
    // persist a registration pointing at a fallback ephemeral port that won't
    // survive the next launch. Idempotent + best-effort; the ⌘K "Install Rookery
    // MCP globally" command stays as the manual fallback (e.g. on a fallback port).
    if (boundPreferred) void ensureGlobalRegistered()
  }
  // Prefer the fixed port; if it's taken, retry once on an ephemeral port so the
  // app still works (global install just won't be durable until a restart frees it).
  httpServer.once('error', () => {
    httpServer?.listen(0, '127.0.0.1', onListening)
  })
  httpServer.listen(PREFERRED_PORT, '127.0.0.1', onListening)
}

// Register Rookery's MCP server in the user's GLOBAL Claude config (`-s user`),
// so any `claude` session — inside Rookery or in a plain terminal — gets the
// rookery tools. Replaces any prior entry first so re-running is idempotent.
// Only durable when we hold the preferred port (see PREFERRED_PORT).
export function installGlobal(): Promise<{ ok: boolean; message: string }> {
  const url = `http://127.0.0.1:${serverPort}/mcp/${GLOBAL_TOKEN}`
  const run = (args: string[]): Promise<{ code: number; out: string }> =>
    new Promise((resolve) => {
      execFile('claude', args, { timeout: 15_000 }, (err, stdout, stderr) => {
        resolve({ code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) as number : 0, out: `${stdout}${stderr}`.trim() })
      })
    })
  return (async () => {
    if (!serverPort) return { ok: false, message: 'The MCP server is not running yet — try again in a moment.' }
    // Best-effort remove of a stale entry; ignore "not found".
    await run(['mcp', 'remove', '-s', 'user', 'rookery'])
    const add = await run(['mcp', 'add', '-s', 'user', '-t', 'http', 'rookery', url])
    if (add.code !== 0) {
      const hint = /ENOENT|not found/i.test(add.out) ? ' (is the `claude` CLI on PATH?)' : ''
      return { ok: false, message: `Failed to register Rookery MCP${hint}: ${add.out || 'unknown error'}` }
    }
    const warn = boundPreferred ? '' : ' Note: Rookery is on a fallback port this run, so restart it once to make the registration durable.'
    return { ok: true, message: `Rookery MCP registered globally at ${url}. Any claude session can now drive Rookery.${warn}` }
  })()
}

// The `rookery` shell script: resolve the arg (default ".") to an absolute path
// and POST it to the open route. Pinned to PREFERRED_PORT — the same fixed port
// the global MCP install relies on, so a single running instance is reachable.
// ponytail: assumes the canonical port; a fallback-port instance isn't reachable
// by the CLI until restarted onto 41573.
const CLI_SCRIPT = `#!/bin/sh
# Rookery CLI — open a folder in the running Rookery app (like \`code .\`).
dir=$(cd "\${1:-.}" 2>/dev/null && pwd) || { echo "rookery: no such directory: \${1:-.}" >&2; exit 1; }
# No \`-f\`: keep the JSON body on 4xx so we can surface the app's real reason
# (e.g. "not a git repository") instead of masking it as a connection failure.
out=$(curl -sS -X POST "http://127.0.0.1:${PREFERRED_PORT}/open" -H 'content-type: application/json' -d "{\\"path\\":\\"$dir\\"}" 2>/dev/null) \\
  || { echo "rookery: couldn't reach the app — is Rookery running?" >&2; exit 1; }
# Server replies {"ok":bool,"message":str}; show the message, fail on ok:false.
msg=$(printf '%s' "$out" | sed -n 's/.*"message":"\\(.*\\)"}.*/\\1/p' | sed 's/\\\\"/"/g')
case "$out" in
  *'"ok":true'*) printf 'rookery: %s\\n' "\${msg:-done}" ;;
  *) printf 'rookery: %s\\n' "\${msg:-the app rejected the request}" >&2; exit 1 ;;
esac
`

// Write the `rookery` CLI into the first writable bin directory on PATH. Mirrors
// VS Code's `code` install; the ⌘K "Install rookery CLI" command calls this.
export function installCli(): { ok: boolean; message: string } {
  const candidates = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin')]
  for (const dir of candidates) {
    try {
      if (!existsSync(dir)) {
        if (dir.endsWith('.local/bin')) mkdirSync(dir, { recursive: true })
        else continue
      }
      const target = join(dir, 'rookery')
      writeFileSync(target, CLI_SCRIPT, { mode: 0o755 })
      return { ok: true, message: `Installed \`rookery\` to ${target}. Run \`rookery .\` in any git folder.` }
    } catch {
      continue
    }
  }
  return {
    ok: false,
    message: 'No writable bin dir on PATH (tried /opt/homebrew/bin, /usr/local/bin, ~/.local/bin).'
  }
}

// Boot-time idempotent wrapper around installGlobal(): if Claude already has the
// exact registration we'd write, do nothing (avoids the remove+add churn and the
// extra `claude` spawns on every launch); otherwise (re)install it. Never throws —
// a missing `claude` CLI or any error just leaves the manual command as fallback.
async function ensureGlobalRegistered(): Promise<void> {
  const url = `http://127.0.0.1:${serverPort}/mcp/${GLOBAL_TOKEN}`
  try {
    const current = await new Promise<string>((resolve) => {
      execFile('claude', ['mcp', 'get', 'rookery'], { timeout: 15_000 }, (_err, stdout, stderr) =>
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
// is known (the server starts at boot, well before any session spawns).
// "Claude drives the browser": when a Mac is attached over SSH it reverse-forwards
// its embedded browser's CDP onto THIS box's loopback (port 9333, see
// sshTunnel.ensureReverseCdp). While that's up, hand each Claude session a
// Playwright MCP pointed at it, so Claude can read the page/console and drive it.
// Server-only — the desktop's own browser CDP is local, not forwarded.
const BROWSER_CDP_PORT = 9333
let browserCdpUp = false

// On the desktop the embedded browser's CDP is LOCAL (not forwarded). index.ts
// sets this once the port is known; when set, every local session gets Playwright
// pointed at it so Claude can drive the in-app browser while testing. Server-only
// builds never set it and keep using the reverse-forwarded 9333 above.
let localCdpPort: number | null = null
export function setLocalBrowserCdp(port: number): void {
  localCdpPort = port
}

function probeBrowserCdp(): void {
  const sock = createConnection({ host: '127.0.0.1', port: BROWSER_CDP_PORT }, () => {
    browserCdpUp = true
    sock.destroy()
  })
  sock.setTimeout(700)
  const down = (): void => {
    browserCdpUp = false
    sock.destroy()
  }
  sock.on('timeout', down)
  sock.on('error', down)
}

// Poll the reverse-forwarded CDP so attach/detach of a Mac flips tool
// availability within a few seconds. Only on the headless server.
export function startBrowserCdpWatch(): void {
  if (!process.env.ROOKERY_SERVER) return
  probeBrowserCdp()
  setInterval(probeBrowserCdp, 5000).unref()
}

// The Playwright MCP tool namespace, exposed only while a browser is reachable —
// agent.ts adds it to --allowedTools so Claude can call it without a prompt.
export const browserToolName = (): string | null =>
  browserCdpUp || localCdpPort != null ? 'mcp__playwright' : null

export function mcpConfigFor(key: string): string {
  const file = join(app.getPath('temp'), `rookery-mcp-${key}.json`)
  const mcpServers: Record<string, unknown> = {
    rookery: {
      type: 'http',
      url: `http://127.0.0.1:${serverPort}/mcp/${encodeURIComponent(key)}`
    }
  }
  // Connect Playwright to the ALREADY-OPEN browser via CDP — not a fresh browser —
  // so Claude sees exactly what the user sees. Local desktop uses its own CDP port;
  // the attached server uses the Mac's reverse-forwarded 9333.
  const cdpPort = localCdpPort ?? (browserCdpUp ? BROWSER_CDP_PORT : null)
  if (cdpPort != null) {
    mcpServers.playwright = {
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest', '--cdp-endpoint', `http://127.0.0.1:${cdpPort}`]
    }
  }
  try {
    writeFileSync(file, JSON.stringify({ mcpServers }))
  } catch {
    // Non-fatal: agent.ts will still pass the path; a missing file just means no
    // rookery tools for that session.
  }
  return file
}

export function shutdown(): void {
  httpServer?.close()
  httpServer = undefined
  serverPort = 0
}
