// The worktree's premise — what this branch is FOR, written down once and handed
// to every session started here.
//
// The problem it solves: a worktree is a branch name and a diff. Everything else
// about it — the goal, what is deliberately out of scope, what "done" means —
// lives in the head of whoever created it, and gets retyped into the first
// message of every new chat until it stops being retyped and the model starts
// guessing.
//
// So a fresh worktree is asked one question while it provisions (provision.ts's
// premise step), and the answer is written to `.floe/premise.md` in a fixed
// shape. The file is the contract, not the conversation: `seedFor` (handoff.ts)
// prepends it to the FIRST turn of every session in this worktree, whichever
// harness answers, which is why the word cap below is part of the design rather
// than a nicety.
//
// One model call — composing the file — headless print-mode with no tools, so
// claude and codex run the same flow (config `[premise] provider`). It has a
// deterministic fallback: a machine without the CLI still writes a usable file
// from the raw answer.

import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { floeConfig } from './config/floe'
import { log } from './log'

/** Where a worktree keeps its premise, relative to the worktree root. */
export const PREMISE_REL = join('.floe', 'premise.md')

/** How long the model call gets before the flow falls back. */
const CALL_TIMEOUT_MS = 45_000

/** The cap the composer is told about, and the cap enforced on the way in. */
const MAX_WORDS = 200

export const premisePath = (worktreePath: string): string => join(worktreePath, PREMISE_REL)

/**
 * One question the interview asks.
 *
 * `options` present makes it a pick (the panel numbers them 1-9); absent makes
 * it free text. Either way the answer comes back as a string, because that is
 * all the composer needs — the options exist to save typing, not to constrain
 * what can be said.
 */
export interface PremiseQuestion {
  id: string
  question: string
  options?: string[]
}

export interface PremiseAnswer {
  question: string
  answer: string
}

/**
 * The one question a new worktree is asked.
 *
 * Fixed rather than generated per branch: working the question out took a model
 * call in front of the interview, so the user waited on a spinner before being
 * asked anything, and the goal is the only answer the composer actually needs.
 */
export const INTERVIEW_QUESTION: PremiseQuestion = {
  id: 'goal',
  question: 'In one sentence, what does this worktree have to deliver?'
}

/** The interview, or nothing when the config has it switched off. */
export function interviewQuestions(): PremiseQuestion[] {
  return floeConfig().premise.enabled ? [INTERVIEW_QUESTION] : []
}

export function readPremise(worktreePath: string): string | undefined {
  try {
    const text = readFileSync(premisePath(worktreePath), 'utf8').trim()
    return text || undefined
  } catch {
    return undefined
  }
}

export function writePremise(worktreePath: string, body: string): void {
  const file = premisePath(worktreePath)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, body.trimEnd() + '\n')
}

export const hasPremise = (worktreePath: string): boolean => existsSync(premisePath(worktreePath))

/**
 * The scaffold a hand-written premise starts from.
 *
 * Headings only. The editor command has to open something, and an empty buffer
 * asks the user to remember the shape — while a wrong guess at what the branch
 * is for would be worse than the blank it replaces.
 */
export const PREMISE_SCAFFOLD = `## Goal

## Scope

## Out of scope

## Constraints

## Done when
`

/** Make sure the file exists so an editor can open it. Returns its path. */
export function ensurePremiseFile(worktreePath: string): string {
  if (!hasPremise(worktreePath)) writePremise(worktreePath, PREMISE_SCAFFOLD)
  return premisePath(worktreePath)
}

/**
 * The premise as it reaches a model, or '' when there isn't one.
 *
 * Fenced in a named block for the same reason the handoff packet is: read back
 * out of the transcript it has to be recognisable as ours rather than as
 * something the user typed. Addressed to the model in the second person because
 * it is an instruction about the session it opens, not a document to summarise.
 */
export function premiseSeed(worktreePath: string): string {
  const premise = readPremise(worktreePath)
  if (!premise) return ''
  return (
    '<worktree-premise>\n' +
    'This is the standing brief for the worktree you are working in. It was ' +
    'written when the worktree was created and holds for the whole session — ' +
    'treat it as context you already have, not as the request. Do not ' +
    'acknowledge it; answer what is actually asked.\n\n' +
    premise.trim() +
    '\n</worktree-premise>\n\n'
  )
}

// --- the model call ---------------------------------------------------------

/**
 * Ask the configured premise model one question and get plain text back.
 *
 * Never throws: every failure — no CLI, a timeout, an empty answer — resolves to
 * null so the caller falls back rather than failing the worktree's setup over a
 * description.
 */
export function askPremiseModel(prompt: string, cwd: string): Promise<string | null> {
  const { provider, model, effort } = floeConfig().premise
  return provider === 'codex' ? askCodex(prompt, cwd, model) : askClaude(prompt, cwd, model, effort)
}

function askClaude(prompt: string, cwd: string, model: string, effort?: string): Promise<string | null> {
  // Print mode with no MCP config and no tools: the same shape as
  // generateWorktreeDesc, and for the same reason — a call that can raise a
  // permission prompt has nowhere to raise it and would hang the checklist.
  const args = ['-p', prompt, '--model', model]
  if (effort) args.push('--effort', effort)
  return new Promise((resolve) => {
    execFile(
      'claude',
      args,
      { cwd, env: process.env, timeout: CALL_TIMEOUT_MS, maxBuffer: 1 << 20 },
      (err, stdout) => {
        const text = (stdout || '').trim()
        if (err && !text) log('premise', { call: 'claude', error: err.message })
        resolve(text || null)
      }
    )
  })
}

/**
 * The same question, asked of codex.
 *
 * `codex exec --json` streams JSONL; the answer is the last `agent_message`.
 * stdin is closed immediately — with the pipe open, `codex exec` waits on it
 * forever instead of taking the prompt it was given in argv (see codex.ts).
 */
function askCodex(prompt: string, cwd: string, model: string): Promise<string | null> {
  // The configured slug goes through unchecked — the same contract as
  // `[harness.codex] model`. Resolving it here would mean importing codex.ts,
  // which reaches electron and takes this module out of `node --test`.
  const args = ['exec', '--json', '--skip-git-repo-check', '-m', model, '-s', 'read-only', '--', prompt]
  return new Promise((resolve) => {
    const child = spawn('codex', args, { cwd, env: process.env })
    // Nothing is sent on stdin, and an OPEN stdin makes `codex exec` wait on it
    // forever instead of answering the prompt it already has in argv (codex.ts).
    child.stdin.end()
    child.stdin.on('error', () => {})

    let buffer = ''
    let reply = ''
    const finish = (): void => {
      clearTimeout(timer)
      resolve(reply.trim() || null)
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish()
    }, CALL_TIMEOUT_MS)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        reply = agentMessage(line) ?? reply
      }
    })
    // ENOENT arrives here rather than as a throw, and is the same nothing as a
    // model that had nothing to say: the caller falls back either way.
    child.on('error', finish)
    child.on('close', finish)
  })
}

/**
 * The text of one `agent_message` event, if that is what this line is.
 *
 * codex prints its own log lines into the same stream, and a chunk can split a
 * line in half — so anything that is not parseable JSON is not an error here,
 * it is just not the answer.
 */
function agentMessage(line: string): string | null {
  if (!line || line[0] !== '{') return null
  try {
    const msg = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } }
    if (msg.type !== 'item.completed' || msg.item?.type !== 'agent_message') return null
    return msg.item.text ?? null
  } catch {
    return null
  }
}

/**
 * Turn the answers into the premise file.
 *
 * The shape is fixed (Goal / Scope / Out of scope / Constraints / Done when)
 * because this text is injected into every session that starts here: a model
 * reading the same five headings every time spends nothing working out what it
 * is looking at, and a cap keeps that cost bounded. Sections with no answer
 * behind them are dropped rather than filled with a guess.
 */
export async function composePremise(
  worktreePath: string,
  branch: string,
  answers: PremiseAnswer[]
): Promise<string> {
  const given = answers.filter((a) => a.answer.trim())
  if (!given.length) return ''

  const transcript = given.map((a) => `Q: ${a.question}\nA: ${a.answer.trim()}`).join('\n\n')
  const prompt =
    'Write the standing brief for a git worktree, from this short interview with ' +
    'the developer who created it. It will be given to an AI assistant at the ' +
    'start of every session in this worktree, so write it FOR that reader: ' +
    'concrete, decided, no hedging, no praise, no restating the questions.\n\n' +
    `Branch: ${branch}\n\n${transcript}\n\n` +
    'Rules:\n' +
    '- Markdown, these headings only, in this order, each with 1-3 sentences:\n' +
    '  ## Goal, ## Scope, ## Out of scope, ## Constraints, ## Done when\n' +
    '- DROP any heading the interview does not actually answer. Never invent ' +
    'scope, constraints or acceptance criteria that were not said.\n' +
    `- Under ${MAX_WORDS} words in total.\n` +
    '- No title, no preamble, no closing remark. Start with "## Goal".'

  const raw = await askPremiseModel(prompt, worktreePath)
  const written = cleanPremise(raw)
  return written || fallbackPremise(given)
}

/** Strip a fence and anything before the first heading; enforce the word cap. */
export function cleanPremise(raw: string | null): string {
  if (!raw) return ''
  let text = raw.replace(/^\s*```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim()
  const first = text.indexOf('## ')
  if (first > 0) text = text.slice(first)
  if (!text.startsWith('## ')) return ''
  const words = text.split(/\s+/)
  // A cap, not a rewrite: an over-long answer is cut at the last complete line
  // inside the budget, so the file never ends mid-sentence.
  if (words.length > MAX_WORDS) {
    const budget = words.slice(0, MAX_WORDS).join(' ').length
    const cut = text.slice(0, budget)
    text = cut.slice(0, cut.lastIndexOf('\n')).trimEnd() || cut.trimEnd()
  }
  return text.trim()
}

/**
 * The premise when the model could not write one: the interview, verbatim.
 *
 * Worse prose than the composed version and deliberately still shipped — the
 * answers are the part that carries the information, and a worktree with a
 * plain Q/A brief is far better off than one with nothing.
 */
export function fallbackPremise(answers: PremiseAnswer[]): string {
  const goal = answers[0]
  const rest = answers.slice(1)
  return [
    '## Goal',
    goal.answer.trim(),
    ...(rest.length
      ? ['', '## Notes', ...rest.map((a) => `- ${a.question.replace(/\s+$/, '')} ${a.answer.trim()}`)]
      : [])
  ].join('\n')
}
