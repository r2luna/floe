#!/usr/bin/env node
// Colony evidence miner: what the board's own history says about its lane skills.
//
// The loop it serves: improve a lane skill from where it actually failed (asked
// the user when it must not, hand-off line that did not parse, lanes that keep
// sending the card back to each other, tasks that stopped), and archive the
// skills nobody uses. This prints the evidence, per lane, as markdown. It does
// not decide anything and it never writes: everything it opens is read-only.
//
//   node scripts/colony-mine.mjs [path ...] [options]
//
//   path             a data dir holding colony.json (the app's userData dir), a
//                    colony.json file, or a dir of step-report .html files.
//                    Default: the app's userData dir for this OS.
//   --reports DIR    extra step-report dir (repeatable). Each project's own
//                    <root>/.floe/colony/reports is read automatically.
//   --transcripts D  Claude transcript root (default ~/.claude/projects). Used
//                    only to find AskUserQuestion calls, when a visit's session
//                    can still be linked to one.
//   --project TEXT   only tasks whose project path contains TEXT
//   --since DATE     only visits on or after DATE (YYYY-MM-DD)
//   --stages a,b,c   the stages that SHOULD exist (default: the built-in six);
//                    one with no visits is listed as never run
//   --quotes N       quotes per finding (default 3)
//
// Plain Node, no dependencies. It tolerates missing or partial data and says what
// it could not read in the "Data coverage" section instead of failing.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2)
const positional = []
const opts = { reports: [], quotes: 3 }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) positional.push(a)
  else if (a === '--help' || a === '-h') opts.help = true
  else if (a === '--reports') opts.reports.push(argv[++i])
  else if (a === '--quotes') opts.quotes = Math.max(1, Number(argv[++i]) || 3)
  else opts[a.slice(2)] = argv[++i]
}
if (opts.help) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 28).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'))
  process.exit(0)
}

// The board's default stages and the lane skill each runs. Keep in step with
// `defaultBoard` in src/main/config/colony.ts; an unknown stage is still mined,
// it just shows no skill.
const DEFAULT_STAGES = {
  specifier: 'colony-specify',
  coder: 'colony-implement',
  cleaner: 'colony-refactor',
  architect: 'colony-architecture',
  hardener: 'colony-review',
  qa: 'colony-verify'
}
// Only this lane may put a question to a human (specs/colony/skills/LANE-CONTRACT.md).
const MAY_ASK = new Set(['specifier'])
const expectedStages = opts.stages ? opts.stages.split(',').map((s) => s.trim()).filter(Boolean) : Object.keys(DEFAULT_STAGES)

function userDataDir() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'floe')
  if (process.platform === 'win32') return join(process.env.APPDATA ?? homedir(), 'floe')
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'floe')
}

// ------------------------------------------------------------------ helpers

const notes = [] // what could not be read, shown under "Data coverage"
const note = (msg) => notes.push(msg)

function readJson(file, label) {
  if (!existsSync(file)) {
    note(`${label}: not found at \`${file}\``)
    return undefined
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    note(`${label}: unreadable (${err.message})`)
    return undefined
  }
}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

const day = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '?')
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '-')
const projectName = (p) => basename(p ?? '') || '?'

/** One line, no table-breaking characters, capped. */
function squash(text, max = 240) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

const table = (head, rows) =>
  rows.length
    ? [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n')
    : ''

// Same grammar as parseHandoff in src/shared/colony.ts. Copied, not imported, so
// this stays plain Node. Last match wins; null is a turn with no readable line.
function parseHandoff(text) {
  const lines = String(text).split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim().replace(/^[-*>\s]+/, '').replace(/[`*_]/g, '').trim()
    const m = /^COLONY:\s*(pass|return|stop)\b(.*)$/i.exec(line)
    if (!m) continue
    const verdict = m[1].toLowerCase()
    const rest = m[2].trim().replace(/^[—–-]\s*/, '').trim()
    if (verdict === 'pass') return { verdict }
    if (verdict === 'stop') return { verdict, why: rest }
    const dash = /\s+[—–-]\s+/.exec(rest)
    const lane = (dash ? rest.slice(0, dash.index) : (rest.split(/\s+/)[0] ?? '')).trim()
    if (!lane) return null
    return { verdict, lane, why: (dash ? rest.slice(dash.index + dash[0].length) : rest.slice(lane.length)).trim() }
  }
  return null
}

/** Why a card went back or stopped, bucketed by keyword. A heuristic, labelled as one. */
function theme(why) {
  const w = String(why ?? '').toLowerCase()
  if (/uncommitted|not committed|never committed|commit never|nothing was committed|not yet committed/.test(w)) return 'work left uncommitted'
  if (/never finished|didn.?t finish|hadn.?t finished|unfinished|incomplete|still (running|pending)|cut off|ran out|stopped early|not finished|no work was done|no code was written|no implementation/.test(w))
    return 'turn ended before the work did'
  if (/not (yet )?(landed|merged|built|implemented)|has not landed|have not landed|unmerged|unbuilt|never merged|absent|unimplemented|not.*on any branch|no .* app to /.test(w))
    return 'a dependency is not in the tree'
  if (/api error|overloaded|\b5\d\d\b/.test(w)) return 'API error'
  return 'other'
}

/**
 * Evenly spread picks, one per task where possible, so three quotes are three
 * situations and not one task repeated.
 */
function pick(items, n, taskOf) {
  const seen = new Set()
  const distinct = items.filter((it) => {
    const key = taskOf(it)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const pool = distinct.length >= n ? distinct : [...distinct, ...items.filter((it) => !distinct.includes(it))]
  if (pool.length <= n) return pool
  return Array.from({ length: n }, (_, i) => pool[Math.floor((i * pool.length) / n)])
}

const quote = (v, text) => `"${squash(text)}" — ${v.taskName} (${projectName(v.project)}), ${v.stage}, ${day(v.at)}`

// --------------------------------------------------------------- load: store

const wanted = positional.length ? positional : [userDataDir()]
const storeFiles = []
const reportDirs = [...opts.reports]
let dataDir
for (const p of wanted) {
  if (!existsSync(p)) {
    note(`path \`${p}\` does not exist`)
  } else if (isDir(p) && existsSync(join(p, 'colony.json'))) {
    storeFiles.push(join(p, 'colony.json'))
    dataDir ??= p
  } else if (isDir(p) && readdirSync(p).some((f) => f.endsWith('.html'))) reportDirs.push(p)
  else if (!isDir(p) && p.endsWith('.json')) {
    storeFiles.push(p)
    dataDir ??= join(p, '..')
  } else note(`path \`${p}\` holds neither a colony.json nor step reports`)
}

let tasks = []
for (const f of storeFiles) {
  const data = readJson(f, 'colony.json')
  if (Array.isArray(data?.tasks)) tasks.push(...data.tasks)
  else if (data) note(`colony.json at \`${f}\` has no tasks array`)
}
if (opts.project) tasks = tasks.filter((t) => String(t.project).includes(opts.project))

const events = dataDir ? (readJson(join(dataDir, 'colony-events.json'), 'colony-events.json')?.events ?? []) : []
const sessionsFile = dataDir ? readJson(join(dataDir, 'sessions.json'), 'sessions.json') : undefined
const sessionList = Array.isArray(sessionsFile?.created) ? sessionsFile.created : Object.values(sessionsFile?.created ?? {})
const sessionById = new Map(sessionList.map((s) => [s.id, s]))

const since = opts.since ? Date.parse(opts.since) : undefined
if (opts.since && Number.isNaN(since)) note(`--since "${opts.since}" is not a date; ignored`)

// One flat list of visits, each carrying what its task says about it.
const visits = []
for (const t of tasks) {
  for (const v of Array.isArray(t.visits) ? t.visits : []) {
    visits.push({
      source: 'store',
      taskId: t.id,
      taskName: t.name ?? t.id,
      project: t.project,
      autonomous: t.autonomous,
      stage: v.stage ?? '?',
      verdict: ['pass', 'return', 'stop', 'none'].includes(v.verdict) ? v.verdict : 'none',
      why: v.why,
      at: v.at,
      sessionId: v.sessionId,
      step: v.step,
      message: v.step?.message
    })
  }
}

// ------------------------------------------------------------- load: reports

// Reports hold the same step records the store does, plus cards the store has
// since dropped. They only ADD what the store lacks: a report step matching a
// store visit (same card, same stage, ending within two minutes) just fills in a
// missing message.
for (const t of tasks) {
  const dir = t.project && join(t.project, '.floe', 'colony', 'reports')
  if (dir && isDir(dir) && !reportDirs.includes(dir)) reportDirs.push(dir)
}
let reportFiles = 0
let reportSteps = 0
let reportAdded = 0
const reportSeen = new Set()
for (const dir of reportDirs) {
  if (!isDir(dir)) {
    note(`reports dir \`${dir}\` does not exist`)
    continue
  }
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.html'))) {
    const file = join(dir, f)
    if (reportSeen.has(file)) continue
    reportSeen.add(file)
    let data
    try {
      const m = /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(readFileSync(file, 'utf8'))
      data = m ? JSON.parse(m[1]) : undefined
    } catch (err) {
      note(`report \`${f}\`: unreadable (${err.message})`)
      continue
    }
    if (!Array.isArray(data?.steps)) {
      note(`report \`${f}\`: no embedded data block`)
      continue
    }
    const projectRoot = dir.replace(/[\\/]\.floe[\\/]colony[\\/]reports$/, '')
    if (opts.project && !projectRoot.includes(opts.project)) continue
    reportFiles++
    for (const s of data.steps) {
      reportSteps++
      const twin = visits.find(
        (v) => v.taskId === data.task?.id && v.stage === s.stage && Math.abs((v.at ?? 0) - (s.endedAt ?? 0)) < 120_000
      )
      if (twin) {
        twin.message ??= s.message
        twin.step ??= { endedAt: s.endedAt, startedAt: s.startedAt, usage: s.usage, findingsDeclared: s.findingsDeclared, findings: s.findings, message: s.message }
        continue
      }
      reportAdded++
      visits.push({
        source: 'report',
        taskId: data.task?.id ?? f,
        taskName: data.task?.name ?? f,
        project: projectRoot,
        stage: s.stage ?? '?',
        verdict: ['pass', 'return', 'stop', 'none'].includes(s.verdict) ? s.verdict : 'none',
        why: s.why,
        at: s.endedAt,
        step: { endedAt: s.endedAt, startedAt: s.startedAt, usage: s.usage, findingsDeclared: s.findingsDeclared, findings: s.findings, message: s.message },
        message: s.message
      })
    }
  }
}

if (since) {
  const inWindow = visits.filter((v) => (v.at ?? 0) >= since)
  visits.length = 0
  visits.push(...inWindow)
}

// ------------------------------------------------------------ load: transcripts

// A transcript is reachable only through the chain visit.sessionId -> sessions.json
// -> claudeId -> <root>/<project-slug>/<claudeId>.jsonl. Any link can be gone:
// closed sessions are pruned, and Claude cleans old transcripts.
const transcriptRoot = opts.transcripts ?? join(homedir(), '.claude', 'projects')
const transcriptIndex = new Map()
if (isDir(transcriptRoot)) {
  for (const d of readdirSync(transcriptRoot)) {
    const dir = join(transcriptRoot, d)
    if (!isDir(dir)) continue
    for (const f of readdirSync(dir)) if (f.endsWith('.jsonl')) transcriptIndex.set(f.slice(0, -6), join(dir, f))
  }
} else note(`transcript root \`${transcriptRoot}\` not found`)

let sessionsLinked = 0
let transcriptsFound = 0
const asks = [] // { visit, question, via }
for (const v of visits) {
  const s = v.sessionId ? sessionById.get(v.sessionId) : undefined
  if (!s) continue
  sessionsLinked++
  const file = [s.claudeId, ...(s.pastClaudeIds ?? [])].map((id) => transcriptIndex.get(id)).find(Boolean)
  if (!file) continue
  transcriptsFound++
  v.transcript = file
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  let lastAssistantText = ''
  for (const line of text.split('\n')) {
    if (!line.includes('"assistant"')) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    const content = rec?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type === 'tool_use' && block.name === 'AskUserQuestion') {
        const qs = block.input?.questions
        const q = Array.isArray(qs) ? qs.map((x) => x?.question).filter(Boolean).join(' / ') : ''
        asks.push({ visit: v, question: q || '(AskUserQuestion with no readable question)', via: 'AskUserQuestion' })
      } else if (block?.type === 'text') lastAssistantText = block.text
    }
  }
  const tail = lastAssistantText.split('\n').filter((l) => l.trim() && !/^\W*COLONY:/i.test(l.trim())).pop() ?? ''
  if (/\?\W*$/.test(tail) && !v.message) v.message = lastAssistantText
}

// ----------------------------------------------------------------- analysis

const lanes = new Map() // stage -> bucket
const bucket = (stage) => {
  if (!lanes.has(stage)) lanes.set(stage, { stage, visits: [], cost: 0, measured: 0 })
  return lanes.get(stage)
}
for (const v of visits) {
  const b = bucket(v.stage)
  b.visits.push(v)
  if (v.step) {
    b.measured++
    b.cost += v.step.usage?.costUsd ?? 0
  }
}

/** The last paragraph of a message minus the hand-off line: where a question would sit. */
function tailOf(message) {
  const lines = String(message ?? '').split('\n').filter((l) => l.trim() && !/^\W*(COLONY|FINDINGS):/i.test(l.trim()))
  return lines.slice(-3).join(' ')
}
const endsInQuestion = (message) => {
  const last = String(message ?? '').split('\n').filter((l) => l.trim() && !/^\W*COLONY:/i.test(l.trim())).pop() ?? ''
  return /\?\W*$/.test(last.trim())
}

// A pass whose whole message is the hand-off line is the reply to the board's
// "reply with exactly one line" follow-up. The store does not record that a
// follow-up was sent, so this is the only trace of it — an inference, not a count.
const looksLikeFollowUpReply = (v) => {
  const m = String(v.message ?? '').trim()
  return m !== '' && !m.includes('\n') && /^\W*COLONY:/i.test(m)
}

const stageNames = new Set([...expectedStages, ...lanes.keys()])
const edges = new Map() // "from->to" -> visits[]
// A return's target is not on the visit (only the reason is); the card's next
// visit is where it went. Rebuild it from the visit order within each task.
const byTask = new Map()
for (const v of visits) {
  if (!byTask.has(v.taskId)) byTask.set(v.taskId, [])
  byTask.get(v.taskId).push(v)
}
for (const list of byTask.values()) {
  list.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
  list.forEach((v, i) => {
    if (v.verdict !== 'return') return
    const next = list[i + 1]
    // The target is the next stage that ran. A return with no later visit
    // either left the card parked (unknown lane) or the history was cut.
    v.returnedTo = next ? next.stage : undefined
    const key = `${v.stage} -> ${v.returnedTo ?? '(nothing ran after)'}`
    if (!edges.has(key)) edges.set(key, [])
    edges.get(key).push(v)
  })
}

// ------------------------------------------------------------------- report

const out = []
const p = (s = '') => out.push(s)

const stamps = visits.map((v) => v.at).filter(Number.isFinite)
const withMessage = visits.filter((v) => v.message)
const measured = visits.filter((v) => v.step)

p('# Colony evidence report')
p()
p(`Generated ${new Date().toISOString().slice(0, 10)} by \`scripts/colony-mine.mjs\`. Read-only.`)
p()
p('## Data coverage')
p()
p(
  table(
    ['source', 'what it gave'],
    [
      ['colony.json', `${tasks.length} tasks, ${visits.filter((v) => v.source === 'store').length} visits${stamps.length ? `, ${day(Math.min(...stamps))} to ${day(Math.max(...stamps))}` : ''}`],
      ['step reports (.html)', `${reportFiles} files, ${reportSteps} steps, ${reportAdded} not already in colony.json`],
      ['visits with a last message', `${withMessage.length} of ${visits.length} (${pct(withMessage.length, visits.length)}) — only cards the step report tracked keep it`],
      ['visits with measured step', `${measured.length} of ${visits.length}`],
      ['colony-events.json', events.length ? `${events.length} events` : 'none read'],
      ['sessions linked to a visit', `${sessionsLinked} of ${visits.length} (sessions.json is pruned when sessions close)`],
      ['transcripts found on disk', `${transcriptsFound} of ${visits.length}`]
    ]
  )
)
p()
if (!visits.length) {
  p('**No visits could be read, so there is nothing to mine.**')
  if (notes.length) {
    p()
    notes.forEach((n) => p(`- ${n}`))
  }
  console.log(out.join('\n'))
  process.exit(0)
}
p('Gaps that no flag can fix, because the board does not persist them:')
p()
p('- **A hand-off follow-up that worked.** The runner asks once for a verdict (`VERDICT_NUDGE`); the visit records only the final verdict, not that it was asked. Only a lane that still failed afterwards shows as `none`. The "likely follow-up reply" counts below are an inference from the message.')
p('- **A question asked and then answered.** A `blocked` card that gets an answer returns to `working`; no visit or event records the question. Questions are visible only in transcripts (when found) or in a last message that ends in one.')
p('- **Which lane a `return` named.** The visit keeps the reason, not the target; the target here is the next stage that ran.')
if (notes.length) {
  p()
  p('Could not read:')
  p()
  notes.forEach((n) => p(`- ${n}`))
}
p()

// ---- overview
p('## Overview by lane')
p()
const order = [...expectedStages, ...[...lanes.keys()].filter((s) => !expectedStages.includes(s))]
const rowOf = (stage) => {
  const b = lanes.get(stage)
  const vs = b?.visits ?? []
  const n = (k) => vs.filter((v) => v.verdict === k).length
  return [
    `\`${stage}\`${DEFAULT_STAGES[stage] ? ` (${DEFAULT_STAGES[stage]})` : ''}`,
    String(vs.length),
    String(n('pass')),
    String(n('return')),
    String(n('stop')),
    String(n('none')),
    vs.length ? pct(n('return') + n('stop') + n('none'), vs.length) : '-',
    b?.measured ? `$${b.cost.toFixed(2)} / ${b.measured}` : '-'
  ]
}
p(table(['lane (skill)', 'visits', 'pass', 'return', 'stop', 'none', 'not-pass', 'cost / measured steps'], order.map(rowOf)))
p()
p('`none` is a turn that ended with no readable `COLONY:` line even after the board asked once. `not-pass` is return + stop + none.')
p()

// ---- return edges
p('## Return edges')
p()
if (!edges.size) p('No `return` verdicts in the data.')
else {
  const sorted = [...edges.entries()].sort((a, b) => b[1].length - a[1].length)
  p(table(['edge', 'count', 'top reasons (keyword heuristic)'], sorted.map(([k, vs]) => {
    const t = new Map()
    for (const v of vs) t.set(theme(v.why), (t.get(theme(v.why)) ?? 0) + 1)
    return [k, String(vs.length), [...t.entries()].sort((a, b) => b[1] - a[1]).map(([name, c]) => `${name} ×${c}`).join('; ')]
  })))
  p()
  // Cards that bounced the same pair more than once are the "something is wrong with the task" signal.
  const bounced = [...byTask.values()].filter((list) => list.filter((v) => v.verdict === 'return').length >= 2)
  p(`Cards returned two or more times: **${bounced.length}** of ${byTask.size}${bounced.length ? ` — ${bounced.slice(0, 6).map((l) => `${l[0].taskName} (${l.filter((v) => v.verdict === 'return').length}×)`).join(', ')}` : ''}.`)
}
p()

// ---- per lane
for (const stage of order) {
  const b = lanes.get(stage)
  p(`## Lane \`${stage}\`${DEFAULT_STAGES[stage] ? ` (${DEFAULT_STAGES[stage]})` : ''}`)
  p()
  if (!b?.visits.length) {
    p('**Never ran** in this data: no visits. Candidate to archive only if the board is meant to use it — check that no `colony.toml` stage points at it before deciding.')
    p()
    continue
  }
  const vs = b.visits
  const tasksTouched = new Set(vs.map((v) => v.taskId)).size
  p(`${vs.length} visits across ${tasksTouched} tasks (${[...new Set(vs.map((v) => projectName(v.project)))].join(', ')}).`)
  p()

  // returns issued, by reason theme
  const returns = vs.filter((v) => v.verdict === 'return')
  if (returns.length) {
    p(`**Returned ${returns.length} times** (${pct(returns.length, vs.length)} of visits). Where it sent the card: ${[...new Set(returns.map((v) => v.returnedTo ?? '(nothing ran after)'))].map((to) => `${to} ×${returns.filter((v) => (v.returnedTo ?? '(nothing ran after)') === to).length}`).join(', ')}.`)
    const themes = new Map()
    for (const v of returns) themes.set(theme(v.why), [...(themes.get(theme(v.why)) ?? []), v])
    p()
    for (const [name, list] of [...themes.entries()].sort((a, c) => c[1].length - a[1].length)) {
      p(`- ${name}: ${list.length}`)
      for (const v of pick(list, opts.quotes, (x) => x.taskId)) p(`  - ${quote(v, v.why)} → ${v.returnedTo ?? '?'}`)
    }
    p()
  }
  const received = [...edges.entries()].filter(([k]) => k.endsWith(`-> ${stage}`)).flatMap(([, list]) => list)
  if (received.length) {
    const from = new Map()
    for (const v of received) from.set(v.stage, (from.get(v.stage) ?? 0) + 1)
    p(`**Received ${received.length} returns** from ${[...from.entries()].map(([k, c]) => `${k} ×${c}`).join(', ')}. That is the lane's output being rejected downstream — read these reasons for what this lane's skill fails to prevent.`)
    p()
  }

  // stops
  const stops = vs.filter((v) => v.verdict === 'stop')
  if (stops.length) {
    p(`**Stopped ${stops.length} times** — a decision the board could not make.`)
    p()
    const themes = new Map()
    for (const v of stops) themes.set(theme(v.why), [...(themes.get(theme(v.why)) ?? []), v])
    for (const [name, list] of [...themes.entries()].sort((a, c) => c[1].length - a[1].length)) {
      p(`- ${name}: ${list.length}`)
      for (const v of pick(list, opts.quotes, (x) => x.taskId)) p(`  - ${quote(v, v.why)}`)
    }
    p()
  }

  // hand-off lines
  const none = vs.filter((v) => v.verdict === 'none')
  const followUps = vs.filter((v) => v.verdict !== 'none' && looksLikeFollowUpReply(v))
  const malformed = vs.filter((v) => v.message && /COLONY\s*:/i.test(v.message) && !parseHandoff(v.message) && v.verdict === 'none')
  const unknownTarget = returns.filter((v) => v.returnedTo === undefined)
  if (none.length || followUps.length || unknownTarget.length) {
    p(`**Hand-off line:** ${none.length} visits ended with no readable line after the follow-up (\`none\`), ${followUps.length} gave a verdict in a message that is only the hand-off line (likely the follow-up's reply), ${malformed.length} contained \`COLONY:\` text that did not parse, ${unknownTarget.length} returns with no later visit (target missing or unknown lane).`)
    p()
    const apiDown = none.filter((v) => /^API Error:/i.test(String(v.message ?? '').trim()))
    const real = none.filter((v) => !apiDown.includes(v))
    const withText = real.filter((v) => v.message)
    if (apiDown.length) p(`- ${apiDown.length} of the \`none\` visits are an API error, not the lane's doing (\`${squash(apiDown[0].message, 50)}\`).`)
    if (real.length > withText.length) p(`- ${real.length - withText.length} \`none\` visits kept no message (the card was not report-tracked), so what the lane said last is unknown.`)
    for (const v of pick(withText, opts.quotes, (x) => x.taskId)) p(`- \`none\`, last message ended: ${quote(v, tailOf(v.message))}`)
    // A reply that is only "COLONY: pass" says nothing; a stop or return reply carries a reason worth reading.
    for (const v of pick(followUps.filter((x) => !/^\W*COLONY:\s*pass\W*$/i.test(String(x.message).trim())), opts.quotes, (x) => x.taskId)) p(`- likely follow-up reply: ${quote(v, v.message)}`)
    p()
  }
  const noReportBlock = b.visits.filter((v) => v.step && v.step.findingsDeclared === false && v.verdict !== 'none')
  if (b.measured) p(`FINDINGS block missing on ${noReportBlock.length} of ${b.measured} measured steps that did give a verdict.`)
  p()

  // questions
  const asked = vs.filter((v) => v.message && endsInQuestion(v.message))
  const askedTool = asks.filter((a) => a.visit.stage === stage)
  const stopQuestions = stops.filter((v) => /\?\s*$/.test(String(v.why ?? '').trim()))
  const questionCount = asked.length + askedTool.length + stopQuestions.length
  p(`**Questions to the user:** ${questionCount} found (${asked.length} turns whose last message ends in "?", ${askedTool.length} AskUserQuestion calls in linked transcripts, ${stopQuestions.length} stops phrased as a question). Coverage: ${vs.filter((v) => v.message).length} of ${vs.length} visits have a message, ${vs.filter((v) => v.transcript).length} a transcript.`)
  if (questionCount && !MAY_ASK.has(stage)) p(`This lane is not allowed to ask (LANE-CONTRACT: only \`specifier\` may).`)
  for (const v of pick(asked, opts.quotes, (x) => x.taskId)) p(`- ${quote(v, tailOf(v.message))}`)
  for (const a of pick(askedTool, opts.quotes, (x) => x.visit.taskId)) p(`- ${quote(a.visit, a.question)}`)
  p()

  // signal
  const noop = vs.filter(
    (v) => v.step && v.verdict === 'pass' && v.step.treeBefore && v.step.treeBefore === v.step.treeAfter && (v.step.findings ?? []).length === 0
  )
  if (b.measured) {
    p(`Measured steps: ${b.measured}, cost $${b.cost.toFixed(2)} ($${(b.cost / b.measured).toFixed(2)} each). ${noop.length} passed having changed no files and raised no findings${noop.length ? ' (a verify lane doing its job looks the same; read before archiving)' : ''}.`)
    p()
  }
}

// ---- never ran
p('## Steps that never ran')
p()
const never = expectedStages.filter((s) => !(lanes.get(s)?.visits.length))
p(never.length ? never.map((s) => `- \`${s}\`${DEFAULT_STAGES[s] ? ` (${DEFAULT_STAGES[s]})` : ''}: 0 visits`).join('\n') : `None: every expected stage (${expectedStages.join(', ')}) has visits in this data.`)
p()
const unseen = tasks.filter((t) => !(t.visits ?? []).length)
p(`Tasks with no visit at all: ${unseen.length} of ${tasks.length}${unseen.length ? ` (${unseen.slice(0, 5).map((t) => t.name ?? t.id).join(', ')}${unseen.length > 5 ? ', …' : ''})` : ''}.`)
p()
p('Only lane skills leave a trace: `colony-nanny`, `colony-add-task` and `colony-feature` run outside the board, so a missing visit says nothing about them.')
p()

// ---- board events
if (events.length) {
  p('## Board events')
  p()
  const kinds = new Map()
  for (const e of events) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1)
  p([...kinds.entries()].map(([k, c]) => `${k} ×${c}`).join(', '))
  p()
  const lost = events.filter((e) => e.kind === 'lost')
  for (const e of lost.slice(0, opts.quotes)) p(`- "${squash(e.text)}" — ${e.taskName}, ${day(e.at)}`)
  p()
}

console.log(out.join('\n'))
