#!/usr/bin/env node
// Colony lane eval: run each lane skill against synthetic tasks and score the result
// with deterministic assertions. See README.md. Dependency-free; Node >= 22.18.
//
//   node scripts/colony-eval/run.mjs --dry
//   node scripts/colony-eval/run.mjs --scenario verify-failing-suite --runs 1
//   node scripts/colony-eval/run.mjs --json before.json   # ...edit a skill...
//   node scripts/colony-eval/run.mjs --json after.json
//   node scripts/colony-eval/run.mjs --compare before.json after.json

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { parseHandoff } from '../../src/shared/colony.ts'
import { SCENARIOS } from './scenarios.mjs'

/**
 * @typedef {{ verdict: string[] } | { grep: string, in: string, absent?: boolean } | { file: string, absent?: boolean }
 *   | { run: string, exit: number } | { newCommits: boolean } | { any: Expect[] } | { all: Expect[] }} Expect
 * @typedef {{ id: string, lane: string, skill: string, name: string, brief: string, autonomous: boolean,
 *   base: Record<string, string>, work: Record<string, string>, expect: Expect[] }} Scenario
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const SKILLS_FILE = 'src/main/config/colonySkills.ts'
const LANES = ['specifier', 'coder', 'cleaner', 'architect', 'hardener', 'qa']
// The whole fixture is a throwaway dir, but node/sh can still reach out of it: this
// is a cost/behaviour guard, not a sandbox. Everything else is denied in -p mode.
const ALLOWED_TOOLS = 'Read,Write,Edit,Glob,Grep,Bash(git:*),Bash(node:*),Bash(npm:*),Bash(ls:*),Bash(cat:*),Bash(timeout:*),Bash(mkdir:*),Bash(test:*)'

// ---- args ---------------------------------------------------------------------

function parseArgs(argv) {
  const o = { dry: false, runs: 3, model: 'haiku', jobs: 4, timeout: 420, budget: 1, keep: false,
    scenario: [], lane: [], json: null, ref: null, compare: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i] ?? die(`${a} needs a value`)
    if (a === '--dry') o.dry = true
    else if (a === '--keep') o.keep = true
    else if (a === '--runs') o.runs = Number(next())
    else if (a === '--model') o.model = next()
    else if (a === '--jobs') o.jobs = Number(next())
    else if (a === '--timeout') o.timeout = Number(next())
    else if (a === '--budget') o.budget = Number(next())
    else if (a === '--scenario') o.scenario = next().split(',')
    else if (a === '--lane') o.lane = next().split(',')
    else if (a === '--json') o.json = next()
    else if (a === '--ref') o.ref = next()
    else if (a === '--compare') o.compare = [next(), next()]
    else die(`unknown argument ${a}`)
  }
  if (!(o.runs >= 1) || !(o.jobs >= 1)) die('--runs and --jobs must be >= 1')
  return o
}

function die(msg) {
  console.error(`colony-eval: ${msg}`)
  process.exit(2)
}

// ---- skills -------------------------------------------------------------------

/** COLONY_SKILLS from the working tree, or from a git ref to compare against an older text. */
async function loadSkills(ref) {
  let url = pathToFileURL(join(ROOT, SKILLS_FILE)).href
  if (ref) {
    const shown = spawnSync('git', ['show', `${ref}:${SKILLS_FILE}`], { cwd: ROOT, encoding: 'utf8' })
    if (shown.status !== 0) die(`git show ${ref}:${SKILLS_FILE} failed: ${shown.stderr.trim()}`)
    const tmp = mkdtempSync(join(tmpdir(), 'colony-skills-'))
    writeFileSync(join(tmp, 'colonySkills.ts'), shown.stdout)
    url = pathToFileURL(join(tmp, 'colonySkills.ts')).href
  }
  return (await import(url)).COLONY_SKILLS
}

const stripFrontmatter = (text) => text.replace(/^---\n[\s\S]*?\n---\n/, '').trim()

// ---- fixtures -----------------------------------------------------------------

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'eval', GIT_AUTHOR_EMAIL: 'eval@example.invalid',
  GIT_COMMITTER_NAME: 'eval', GIT_COMMITTER_EMAIL: 'eval@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null'
}

/** A clean env for anything run inside a fixture: git cannot walk up out of it. */
function fixtureEnv(cwd) {
  const env = { ...process.env, ...GIT_ENV, GIT_CEILING_DIRECTORIES: dirname(cwd) }
  for (const k of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE)$/.test(k)) delete env[k]
  return env
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: fixtureEnv(cwd), encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in fixture: ${r.stderr}`)
  return r.stdout.trim()
}

function writeFiles(cwd, files) {
  for (const [rel, text] of Object.entries(files)) {
    const p = join(cwd, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, text)
  }
}

const specDirOf = (s) => `specs/feature-${s.id}`

/** Build the scenario's repo in a fresh temp dir. Returns where, and how many commits it starts with. */
function makeFixture(s) {
  const cwd = join(realpathSync(mkdtempSync(join(tmpdir(), 'colony-eval-'))), 'repo')
  mkdirSync(cwd)
  git(cwd, 'init', '-q', '-b', 'main')
  writeFiles(cwd, s.base)
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', 'base')
  git(cwd, 'checkout', '-q', '-b', `feature/${s.id}`)
  writeFiles(cwd, { ...s.work, [`${specDirOf(s)}/task.md`]: s.brief + '\n' })
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', 'work so far')
  return { cwd, commits: Number(git(cwd, 'rev-list', '--count', 'HEAD')) }
}

/** What the colony sends a lane (runner.ts lanePrompt), with the skill text in place of `/skill`. */
function buildPrompt(s, skillText) {
  const autonomous =
    'AUTONOMOUS BOARD: nobody will answer a question on this task — not the user, not the nanny. ' +
    'Do not call AskUserQuestion and do not end a turn with a question. When a decision is open, take the ' +
    "recommended option (the brief's Decisions and Still open sections first), record it as (assumed) in your " +
    'artifact, and keep going.'
  return [
    stripFrontmatter(skillText), '', '---', '',
    `Task: ${s.name} (feature)`, `Artifacts: ${specDirOf(s)}/`, 'Base: main',
    ...(s.autonomous ? ['', autonomous] : []), '', s.brief.trim()
  ].join('\n')
}

// ---- running the model --------------------------------------------------------

/** One headless lane turn. Resolves { message, askedTool, costUsd, error }. */
function runClaude({ cwd, prompt, model, timeoutSec, budget }) {
  return new Promise((done) => {
    const args = ['-p', prompt, '--model', model, '--output-format', 'stream-json', '--verbose',
      '--no-session-persistence', '--permission-mode', 'acceptEdits', `--allowedTools=${ALLOWED_TOOLS}`,
      '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', 'project',
      '--max-budget-usd', String(budget)]
    // stdin 'ignore' is /dev/null: without it claude -p waits on the terminal forever.
    const child = spawn('claude', args, { cwd, env: fixtureEnv(cwd), stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutSec * 1000)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => { clearTimeout(timer); done({ message: '', askedTool: false, costUsd: 0, error: `spawn: ${e.message}` }) })
    child.on('close', () => {
      clearTimeout(timer)
      let message = ''
      let askedTool = false
      let costUsd = 0
      let error = timedOut ? `timed out after ${timeoutSec}s` : null
      for (const line of out.split('\n')) {
        let ev
        try { ev = JSON.parse(line) } catch { continue }
        if (ev.type === 'assistant') {
          for (const b of ev.message?.content ?? []) if (b.type === 'tool_use' && b.name === 'AskUserQuestion') askedTool = true
        } else if (ev.type === 'result') {
          message = typeof ev.result === 'string' ? ev.result : ''
          costUsd = ev.total_cost_usd ?? 0
          if (ev.is_error && !error) error = `claude error: ${ev.subtype ?? 'unknown'} ${message.slice(0, 200)}`
        }
      }
      if (!message && !error) error = `no result event. stderr: ${err.trim().slice(0, 300)}`
      done({ message, askedTool, costUsd, error })
    })
  })
}

// ---- assertions ---------------------------------------------------------------

const HANDOFF_LINE = /^\W*COLONY:/i

/** Checks every lane is held to, whatever the scenario. Pure: message in, results out. */
export function genericChecks(message, askedTool) {
  const lines = message.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const last = lines.at(-1) ?? ''
  const handoffLines = lines.filter((l) => HANDOFF_LINE.test(l))
  const handoff = parseHandoff(last)
  const body = handoff ? lines.slice(0, -1) : lines
  const lane = handoff?.verdict === 'return' ? handoff.lane : null
  return [
    { label: 'one hand-off line', ok: handoffLines.length === 1, detail: `${handoffLines.length} COLONY: lines` },
    { label: 'hand-off is last and parses', ok: handoff !== null, detail: `last line: ${last.slice(0, 80)}` },
    { label: 'return targets a real lane', ok: lane === null || LANES.includes(lane), detail: `lane "${lane}"` },
    { label: 'no AskUserQuestion', ok: !askedTool, detail: 'tool_use AskUserQuestion seen' },
    { label: 'no question to the user', ok: !(body.at(-1) ?? '').endsWith('?'), detail: `ends: ${(body.at(-1) ?? '').slice(-80)}` }
  ]
}

const verdictKey = (h) => (h ? (h.verdict === 'return' ? `return:${h.lane}` : h.verdict) : 'none')

function textFiles(root, rel) {
  const base = join(root, rel)
  if (!existsSync(base)) return []
  const out = []
  const walk = (p) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue
      const q = join(p, e.name)
      if (e.isDirectory()) walk(q)
      else if (statSync(q).size < 1_000_000) out.push(q)
    }
  }
  statSync(base).isDirectory() ? walk(base) : out.push(base)
  return out
}

function describeExpect(e) {
  if ('verdict' in e) return `verdict in [${e.verdict.join(', ')}]`
  if ('grep' in e) return `${e.absent ? 'no ' : ''}/${e.grep}/ in ${e.in}`
  if ('file' in e) return `${e.file} ${e.absent ? 'absent' : 'exists'}`
  if ('run' in e) return `\`${e.run.length > 50 ? e.run.slice(0, 47) + '...' : e.run}\` exits ${e.exit}`
  if ('newCommits' in e) return e.newCommits ? 'lane committed' : 'lane made no commit'
  if ('any' in e) return `any of (${e.any.map(describeExpect).join(' | ')})`
  return `all of (${e.all.map(describeExpect).join(' & ')})`
}

/** Evaluate one expectation against a finished fixture. Returns boolean. */
function holds(e, ctx) {
  if ('any' in e) return e.any.some((x) => holds(x, ctx))
  if ('all' in e) return e.all.every((x) => holds(x, ctx))
  if ('verdict' in e) return e.verdict.includes(verdictKey(ctx.handoff))
  if ('file' in e) return existsSync(join(ctx.cwd, e.file)) !== Boolean(e.absent)
  if ('newCommits' in e) return (Number(git(ctx.cwd, 'rev-list', '--count', 'HEAD')) > ctx.commits) === e.newCommits
  if ('grep' in e) {
    const re = new RegExp(e.grep, 'i')
    const hit = textFiles(ctx.cwd, e.in).some((f) => re.test(readFileSync(f, 'utf8')))
    return hit !== Boolean(e.absent)
  }
  const r = spawnSync('sh', ['-c', e.run], { cwd: ctx.cwd, env: fixtureEnv(ctx.cwd), timeout: 60_000, encoding: 'utf8' })
  return r.status === e.exit
}

function scoreRun(s, run, fx) {
  const lines = run.message.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const ctx = { cwd: fx.cwd, commits: fx.commits, handoff: parseHandoff(lines.at(-1) ?? '') }
  const checks = [
    ...genericChecks(run.message, run.askedTool),
    ...s.expect.map((e) => ({ label: describeExpect(e), ok: holds(e, ctx), detail: '' }))
  ]
  if (run.error) checks.unshift({ label: 'turn completed', ok: false, detail: run.error })
  return { pass: checks.every((c) => c.ok), verdict: verdictKey(ctx.handoff), checks }
}

// ---- dry mode -----------------------------------------------------------------

function validExpect(e, errs, where) {
  const keys = ['verdict', 'grep', 'file', 'run', 'newCommits', 'any', 'all'].filter((k) => k in e)
  if (keys.length !== 1) return errs.push(`${where}: expectation needs exactly one of verdict/grep/file/run/newCommits/any/all`)
  if ('verdict' in e) {
    for (const v of e.verdict) {
      const m = /^(pass|stop|return:(\w+))$/.exec(v)
      if (!m || (m[2] && !LANES.includes(m[2]))) errs.push(`${where}: bad verdict "${v}"`)
    }
  } else if ('grep' in e) {
    try { new RegExp(e.grep, 'i') } catch { errs.push(`${where}: bad regex ${e.grep}`) }
  } else if ('run' in e) {
    if (typeof e.exit !== 'number') errs.push(`${where}: run needs exit`)
  } else if ('any' in e || 'all' in e) {
    for (const x of e.any ?? e.all) validExpect(x, errs, where)
  }
}

async function dry(o) {
  const errs = []
  const skills = await loadSkills(o.ref)
  if (SCENARIOS.length === 0) errs.push('no scenarios defined')
  const ids = new Set()
  for (const s of SCENARIOS) {
    const w = s.id
    if (ids.has(s.id)) errs.push(`${w}: duplicate id`)
    ids.add(s.id)
    if (!LANES.includes(s.lane)) errs.push(`${w}: unknown lane ${s.lane}`)
    if (!skills.some((k) => k.name === s.skill)) errs.push(`${w}: no skill named ${s.skill}`)
    if (!s.brief?.trim() || !s.name) errs.push(`${w}: needs name and brief`)
    if (!s.expect?.length) errs.push(`${w}: needs expectations`)
    s.expect?.forEach((e) => validExpect(e, errs, w))
  }
  for (const lane of LANES) {
    if (!SCENARIOS.some((s) => s.lane === lane)) errs.push(`lane ${lane} has no scenario`)
  }
  // Build every fixture for real (git, no model) and run the checkers on canned messages.
  for (const s of SCENARIOS) {
    try {
      const fx = makeFixture(s)
      const skill = skills.find((k) => k.name === s.skill)
      console.log(`  ok  ${s.lane.padEnd(9)} ${s.id.padEnd(30)} fixture ${Object.keys(s.base).length}+${Object.keys(s.work).length} files, prompt ${buildPrompt(s, skill?.text ?? '').length} chars`)
      rmSync(dirname(fx.cwd), { recursive: true, force: true })
    } catch (e) { errs.push(`${s.id}: fixture failed: ${e.message}`) }
  }
  const selftest = [
    ['clean pass', 'All done.\n\nCOLONY: pass', false, true],
    ['return', 'x\nCOLONY: return coder — suite is red', false, true],
    ['quotes the contract', 'Format is:\nCOLONY: pass\nCOLONY: stop — why\n\nCOLONY: pass', false, false],
    ['no hand-off', 'I finished.', false, false],
    ['trailing question', 'Should I use CSV?\nCOLONY: pass', false, false],
    ['asked via tool', 'ok\nCOLONY: pass', true, false],
    ['unknown lane', 'COLONY: return banana — no', false, false]
  ]
  for (const [name, msg, asked, want] of selftest) {
    if (genericChecks(msg, asked).every((c) => c.ok) !== want) errs.push(`selftest "${name}" should ${want ? 'pass' : 'fail'}`)
  }
  console.log(`${SCENARIOS.length} scenarios, ${selftest.length} checker self-tests, ${errs.length} problems`)
  for (const e of errs) console.log(`  FAIL ${e}`)
  process.exit(errs.length ? 1 : 0)
}

// ---- reporting ----------------------------------------------------------------

const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0)

function printTable(report) {
  const rows = report.scenarios.map((s) => {
    const passed = s.runs.filter((r) => r.pass).length
    const verdicts = [...new Set(s.runs.map((r) => r.verdict))].join(',')
    const failing = new Map()
    for (const r of s.runs) for (const c of r.checks) if (!c.ok) failing.set(c.label, (failing.get(c.label) ?? 0) + 1)
    return { s, passed, verdicts, failing }
  })
  const w = Math.max(...rows.map((r) => r.s.id.length), 8)
  console.log(`\n${'lane'.padEnd(10)} ${'scenario'.padEnd(w)}  pass   verdicts`)
  for (const r of rows) {
    console.log(`${r.s.lane.padEnd(10)} ${r.s.id.padEnd(w)}  ${`${r.passed}/${r.s.runs.length}`.padEnd(5)}  ${r.verdicts}`)
    for (const [label, n] of r.failing) console.log(`${' '.repeat(10)} ${' '.repeat(w)}    x ${label} (${n}/${r.s.runs.length})`)
  }
  console.log('\nlane       pass-rate')
  for (const lane of LANES) {
    const rs = rows.filter((r) => r.s.lane === lane)
    if (!rs.length) continue
    const n = rs.reduce((a, r) => a + r.s.runs.length, 0)
    console.log(`${lane.padEnd(10)} ${pct(rs.reduce((a, r) => a + r.passed, 0), n)}%  (${n} runs)`)
  }
  console.log(`\ncost $${report.costUsd.toFixed(3)}, model ${report.meta.model}, ${report.meta.runs} run(s) per scenario, skills ${report.meta.ref}`)
}

function compare([a, b]) {
  const A = JSON.parse(readFileSync(a, 'utf8'))
  const B = JSON.parse(readFileSync(b, 'utf8'))
  const rate = (s) => pct(s.runs.filter((r) => r.pass).length, s.runs.length)
  console.log(`${a}  ->  ${b}\n${'scenario'.padEnd(32)} before  after  delta`)
  for (const sb of B.scenarios) {
    const sa = A.scenarios.find((x) => x.id === sb.id)
    if (!sa) { console.log(`${sb.id.padEnd(32)} (new)    ${rate(sb)}%`); continue }
    const d = rate(sb) - rate(sa)
    console.log(`${sb.id.padEnd(32)} ${`${rate(sa)}%`.padEnd(7)} ${`${rate(sb)}%`.padEnd(6)} ${d > 0 ? '+' : ''}${d}${d < 0 ? '  <- worse' : ''}`)
  }
  const total = (R) => pct(R.scenarios.reduce((n, s) => n + s.runs.filter((r) => r.pass).length, 0), R.scenarios.reduce((n, s) => n + s.runs.length, 0))
  console.log(`${'overall'.padEnd(32)} ${`${total(A)}%`.padEnd(7)} ${total(B)}%`)
}

// ---- main ---------------------------------------------------------------------

async function main() {
  const o = parseArgs(process.argv.slice(2))
  if (o.compare) return compare(o.compare)
  if (o.dry) return dry(o)
  const skills = await loadSkills(o.ref)
  const chosen = SCENARIOS.filter((s) => (!o.scenario.length || o.scenario.some((q) => s.id.includes(q))) && (!o.lane.length || o.lane.includes(s.lane)))
  if (!chosen.length) die('no scenario matches --scenario/--lane')
  const jobs = chosen.flatMap((s) => Array.from({ length: o.runs }, (_, i) => ({ s, i })))
  const results = new Map(chosen.map((s) => [s.id, []]))
  let next = 0
  let cost = 0
  const worker = async () => {
    while (next < jobs.length) {
      const { s, i } = jobs[next++]
      const skill = skills.find((k) => k.name === s.skill)
      const fx = makeFixture(s)
      const t0 = Date.now()
      const run = await runClaude({ cwd: fx.cwd, prompt: buildPrompt(s, skill.text), model: o.model, timeoutSec: o.timeout, budget: o.budget })
      const scored = scoreRun(s, run, fx)
      cost += run.costUsd
      results.get(s.id).push({ ...scored, costUsd: run.costUsd, seconds: Math.round((Date.now() - t0) / 1000), message: run.message })
      console.log(`${scored.pass ? 'PASS' : 'FAIL'} ${s.id} #${i + 1} -> ${scored.verdict} (${Math.round((Date.now() - t0) / 1000)}s)`)
      if (o.keep) console.log(`     kept ${fx.cwd}`)
      else rmSync(dirname(fx.cwd), { recursive: true, force: true })
    }
  }
  await Promise.all(Array.from({ length: Math.min(o.jobs, jobs.length) }, worker))
  const report = {
    meta: { model: o.model, runs: o.runs, ref: o.ref ?? 'working tree', date: new Date().toISOString() },
    costUsd: cost,
    scenarios: chosen.map((s) => ({ id: s.id, lane: s.lane, runs: results.get(s.id) }))
  }
  printTable(report)
  if (o.json) { writeFileSync(o.json, JSON.stringify(report, null, 2) + '\n'); console.log(`wrote ${o.json}`) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
