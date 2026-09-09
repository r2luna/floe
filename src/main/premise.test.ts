import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The premise module is two halves: text handling that has to be right whatever
// the model says (parsing its JSON, capping its prose, falling back when it says
// nothing), and two CLI calls. The calls are stubbed at `node:child_process` —
// only for premise.ts, so config, fs and everything else stay real.

const trash: string[] = []
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  trash.push(dir)
  return dir
}
after(() => {
  for (const dir of trash) rmSync(dir, { recursive: true, force: true })
})

// A private config dir, so `[premise]` here is the machine's answer for these
// tests and the developer's own floe.toml is never read.
const HOME = tmp('floe-premise-home-')
process.env.HOME = HOME
process.env.XDG_CONFIG_HOME = join(HOME, '.config')
mkdirSync(join(HOME, '.config', 'floe'), { recursive: true })
writeFileSync(
  join(HOME, '.config', 'floe', 'floe.toml'),
  '[premise]\nenabled = true\nprovider = "claude"\nmodel = "sonnet"\n'
)

const hookSource = `
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
export async function resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: 'stub:electron', shortCircuit: true, format: 'module' }
  if (specifier === 'node:child_process' && (context.parentURL ?? '').endsWith('/premise.ts'))
    return { url: 'stub:child_process', shortCircuit: true, format: 'module' }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\\.[a-z]+$/i.test(specifier)) {
    try {
      const base = context.parentURL ? new URL(specifier, context.parentURL) : pathToFileURL(specifier)
      const tsPath = fileURLToPath(base) + '.ts'
      if (existsSync(tsPath)) return next(specifier + '.ts', context)
    } catch {}
  }
  return next(specifier, context)
}
const SOURCE = {
  'stub:electron': "export const app = { getPath: () => '/tmp' }; export class BrowserWindow {}; export default {};",
  // execFile is all the claude path uses: record the call, answer with whatever
  // the test planned for it.
  'stub:child_process':
    "export function execFile(cmd, args, opts, cb) {" +
    "\\n  const plan = globalThis.__premisePlan.shift() ?? { stdout: '' }" +
    "\\n  globalThis.__premiseCalls.push({ cmd, args, cwd: opts.cwd })" +
    "\\n  queueMicrotask(() => cb(plan.error ? new Error(plan.error) : null, plan.stdout ?? '', ''))" +
    "\\n  return {}" +
    "\\n}" +
    // codex's half: a child that streams the planned JSONL and closes.
    "\\nimport { EventEmitter } from 'node:events'" +
    "\\nexport function spawn(cmd, args, opts) {" +
    "\\n  const plan = globalThis.__premisePlan.shift() ?? {}" +
    "\\n  globalThis.__premiseCalls.push({ cmd, args, cwd: opts.cwd })" +
    "\\n  const child = new EventEmitter()" +
    "\\n  child.stdin = Object.assign(new EventEmitter(), { end() {} })" +
    "\\n  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} })" +
    "\\n  child.kill = () => {}" +
    "\\n  queueMicrotask(() => {" +
    "\\n    for (const chunk of plan.chunks ?? []) child.stdout.emit('data', chunk)" +
    "\\n    if (plan.error) child.emit('error', new Error(plan.error))" +
    "\\n    else child.emit('close', 0)" +
    "\\n  })" +
    "\\n  return child" +
    "\\n}"
}
export async function load(url, context, next) {
  if (SOURCE[url]) return { format: 'module', shortCircuit: true, source: SOURCE[url] }
  return next(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

declare global {
  // eslint-disable-next-line no-var
  var __premisePlan: Array<{ stdout?: string; error?: string; chunks?: string[] }>
  // eslint-disable-next-line no-var
  var __premiseCalls: Array<{ cmd: string; args: string[]; cwd: string }>
}

const { invalidateFloeConfig } = await import('./config/floe.ts')
const {
  askPremiseModel,
  cleanPremise,
  composePremise,
  ensurePremiseFile,
  fallbackPremise,
  hasPremise,
  interviewQuestions,
  parseQuestions,
  premisePath,
  premiseSeed,
  readPremise,
  writePremise
} = await import('./premise.ts')

function worktree(): string {
  return tmp('floe-premise-wt-')
}

// --- the file ---------------------------------------------------------------

test('a premise round-trips through the worktree, creating .floe on the way', () => {
  const wt = worktree()
  assert.equal(hasPremise(wt), false)
  assert.equal(readPremise(wt), undefined)

  writePremise(wt, '## Goal\nShip the thing.')

  assert.equal(hasPremise(wt), true)
  assert.equal(readPremise(wt), '## Goal\nShip the thing.')
  assert.equal(readFileSync(premisePath(wt), 'utf8').endsWith('\n'), true, 'files end with a newline')
})

test('a whitespace-only premise is no premise at all', () => {
  const wt = worktree()
  writePremise(wt, '   \n  \n')
  assert.equal(readPremise(wt), undefined)
  assert.equal(premiseSeed(wt), '')
})

test('ensurePremiseFile writes the scaffold once and never overwrites an answer', () => {
  const wt = worktree()
  ensurePremiseFile(wt)
  assert.match(readFileSync(premisePath(wt), 'utf8'), /## Goal/)

  writePremise(wt, '## Goal\nMine.')
  ensurePremiseFile(wt)
  assert.equal(readPremise(wt), '## Goal\nMine.')
})

test('the seed carries the premise inside a block a transcript can be read back from', () => {
  const wt = worktree()
  writePremise(wt, '## Goal\nInject the premise.')
  const seed = premiseSeed(wt)
  assert.match(seed, /^<worktree-premise>/)
  assert.match(seed, /<\/worktree-premise>\n\n$/)
  assert.match(seed, /Inject the premise\./)
})

test('no premise means nothing is prepended — not an empty block', () => {
  assert.equal(premiseSeed(worktree()), '')
})

// --- the model's JSON -------------------------------------------------------

test('questions survive a fence and a chatty preamble', () => {
  const parsed = parseQuestions(
    'Sure! Here they are:\n```json\n[{"id":"goal","question":"What ships?"},' +
      '{"id":"kind","question":"Which kind?","options":["feature","bug"]}]\n```'
  )
  assert.equal(parsed?.length, 2)
  assert.equal(parsed?.[0].question, 'What ships?')
  assert.deepEqual(parsed?.[1].options, ['feature', 'bug'])
})

test('entries with no question are dropped, and a missing id is filled in', () => {
  const parsed = parseQuestions('[{"question":""},{"question":"Real one?"}]')
  assert.equal(parsed?.length, 1)
  assert.equal(parsed?.[0].id, 'q2', 'the id comes from the entry’s own position')
})

test('more than three questions are cut to three', () => {
  const many = JSON.stringify([1, 2, 3, 4, 5].map((n) => ({ question: `Q${n}?` })))
  assert.equal(parseQuestions(many)?.length, 3)
})

test('empty options are dropped rather than drawn as a pick with no choices', () => {
  const parsed = parseQuestions('[{"question":"Why?","options":[]}]')
  assert.equal(parsed?.[0].options, undefined)
})

test('junk, prose and non-arrays parse to nothing', () => {
  assert.equal(parseQuestions(null), null)
  assert.equal(parseQuestions('no json here'), null)
  assert.equal(parseQuestions('[not json]'), null)
  assert.equal(parseQuestions('{"question":"an object, not a list"}'), null)
  assert.equal(parseQuestions('[]'), null)
})

// --- the composed file ------------------------------------------------------

test('a fence and a preamble are stripped down to the first heading', () => {
  assert.equal(cleanPremise('```markdown\n## Goal\nShip it.\n```'), '## Goal\nShip it.')
  assert.equal(cleanPremise('Here you go:\n\n## Goal\nShip it.'), '## Goal\nShip it.')
})

test('an answer that never reaches a heading is refused', () => {
  assert.equal(cleanPremise('I could not work out what this branch is for.'), '')
  assert.equal(cleanPremise(null), '')
})

test('an over-long premise is cut at a line boundary, not mid-sentence', () => {
  const long = '## Goal\n' + Array.from({ length: 60 }, (_, i) => `line ${i} of the goal here`).join('\n')
  const capped = cleanPremise(long)
  assert.ok(capped.split(/\s+/).length <= 200, 'inside the cap')
  assert.ok(long.startsWith(capped.split('\n')[0]), 'starts where the original does')
  assert.ok(!capped.endsWith('line'), 'never ends on a half-written line')
})

test('the fallback keeps every answer, with the first one as the goal', () => {
  const text = fallbackPremise([
    { question: 'What ships?', answer: 'The premise flow.' },
    { question: 'Out of scope?', answer: 'The sidebar subtitle.' }
  ])
  assert.match(text, /^## Goal\nThe premise flow\./)
  assert.match(text, /Out of scope\? The sidebar subtitle\./)
})

// --- the two calls ----------------------------------------------------------

test('the interview asks the configured model, in the worktree', async () => {
  globalThis.__premiseCalls = []
  globalThis.__premisePlan = [{ stdout: '[{"id":"goal","question":"What ships?"}]' }]
  const wt = worktree()

  const questions = await interviewQuestions(wt, 'feat/premise', 'master')

  assert.deepEqual(
    questions.map((q) => q.question),
    ['What ships?']
  )
  const call = globalThis.__premiseCalls[0]
  assert.equal(call.cmd, 'claude')
  assert.equal(call.cwd, wt, 'runs in the worktree it is asking about')
  assert.deepEqual(call.args.slice(-2), ['--model', 'sonnet'])
  assert.match(call.args[1], /feat\/premise/, 'the branch is in the prompt')
  assert.match(call.args[1], /master/, 'so is the base')
})

test('a model that cannot answer still leaves an interview to run', async () => {
  globalThis.__premiseCalls = []
  globalThis.__premisePlan = [{ error: 'claude not found' }]
  const questions = await interviewQuestions(worktree(), 'feat/premise')
  assert.ok(questions.length >= 2, 'the fixed questions stand in')
  assert.match(questions[0].question, /deliver/)
})

test('composing writes what the model returned, cleaned', async () => {
  globalThis.__premiseCalls = []
  globalThis.__premisePlan = [{ stdout: '```md\n## Goal\nWrite the premise once.\n```' }]
  const body = await composePremise(worktree(), 'feat/premise', [
    { question: 'What ships?', answer: 'the premise flow' }
  ])
  assert.equal(body, '## Goal\nWrite the premise once.')
  assert.match(globalThis.__premiseCalls[0].args[1], /What ships\?/, 'the interview is in the prompt')
})

test('a silent model composes the answers itself rather than losing them', async () => {
  globalThis.__premiseCalls = []
  globalThis.__premisePlan = [{ stdout: '   ' }]
  const body = await composePremise(worktree(), 'feat/premise', [
    { question: 'What ships?', answer: 'the premise flow' }
  ])
  assert.match(body, /## Goal\nthe premise flow/)
})

test('an interview nobody answered composes nothing at all', async () => {
  globalThis.__premiseCalls = []
  globalThis.__premisePlan = []
  const body = await composePremise(worktree(), 'feat/premise', [{ question: 'What ships?', answer: '  ' }])
  assert.equal(body, '')
  assert.equal(globalThis.__premiseCalls.length, 0, 'no model call for an empty interview')
})

test('the interview is off when the config says so', async () => {
  // The parse is cached per file, so the switch has to invalidate it — the same
  // move the file watcher makes when the user edits floe.toml.
  const path = join(HOME, '.config', 'floe', 'floe.toml')
  writeFileSync(path, '[premise]\nenabled = false\n')
  invalidateFloeConfig()
  try {
    globalThis.__premiseCalls = []
    assert.deepEqual(await interviewQuestions(worktree(), 'feat/premise'), [])
    assert.equal(globalThis.__premiseCalls.length, 0, 'nothing is asked of the model either')
  } finally {
    writeFileSync(path, '[premise]\nenabled = true\nprovider = "claude"\nmodel = "sonnet"\n')
    invalidateFloeConfig()
  }
})

test('the premise file is inside .floe, where the worktree keeps its scratch', () => {
  const wt = worktree()
  writePremise(wt, '## Goal\nx')
  assert.equal(existsSync(join(wt, '.floe', 'premise.md')), true)
})

// --- codex answers the same interview ---------------------------------------

/** Run with `[premise] provider = "codex"`, restoring claude afterwards. */
async function asCodex<T>(run: () => Promise<T>): Promise<T> {
  const path = join(HOME, '.config', 'floe', 'floe.toml')
  writeFileSync(path, '[premise]\nenabled = true\nprovider = "codex"\nmodel = "gpt-5.6-sol"\n')
  invalidateFloeConfig()
  try {
    return await run()
  } finally {
    writeFileSync(path, '[premise]\nenabled = true\nprovider = "claude"\nmodel = "sonnet"\n')
    invalidateFloeConfig()
  }
}

const jsonl = (obj: unknown): string => JSON.stringify(obj) + '\n'
const agentMessage = (text: string): string =>
  jsonl({ type: 'item.completed', item: { type: 'agent_message', text } })

test('codex is asked headlessly, read-only, with the configured slug', async () => {
  await asCodex(async () => {
    globalThis.__premiseCalls = []
    globalThis.__premisePlan = [{ chunks: [agentMessage('the answer')] }]

    const answer = await askPremiseModel('what is this branch for?', '/tmp/wt')

    assert.equal(answer, 'the answer')
    const call = globalThis.__premiseCalls[0]
    assert.equal(call.cmd, 'codex')
    assert.equal(call.cwd, '/tmp/wt')
    assert.deepEqual(call.args.slice(0, 7), [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-m',
      'gpt-5.6-sol',
      '-s',
      'read-only'
    ])
    assert.equal(call.args.at(-2), '--', 'a prompt starting with - cannot smuggle a flag')
    assert.equal(call.args.at(-1), 'what is this branch for?')
  })
})

test("codex's log lines and split chunks do not break the read", async () => {
  await asCodex(async () => {
    globalThis.__premiseCalls = []
    // A stray log line, an event split across two chunks, then the answer.
    globalThis.__premisePlan = [
      {
        chunks: [
          'thinking about it...\n' + jsonl({ type: 'thread.started', thread_id: 't1' }),
          agentMessage('first pass').slice(0, 20),
          agentMessage('first pass').slice(20) + agentMessage('the last word')
        ]
      }
    ]

    assert.equal(await askPremiseModel('q', '/tmp/wt'), 'the last word', 'the LAST message wins')
  })
})

test('a codex that never answers is a null, not a crash', async () => {
  await asCodex(async () => {
    globalThis.__premiseCalls = []
    globalThis.__premisePlan = [{ chunks: [], error: 'spawn codex ENOENT' }]
    assert.equal(await askPremiseModel('q', '/tmp/wt'), null)
  })
})

test('the interview runs end to end on codex too', async () => {
  await asCodex(async () => {
    globalThis.__premiseCalls = []
    globalThis.__premisePlan = [{ chunks: [agentMessage('[{"question":"What ships?"}]')] }]
    const questions = await interviewQuestions(worktree(), 'feat/premise')
    assert.deepEqual(
      questions.map((q) => q.question),
      ['What ships?']
    )
  })
})
