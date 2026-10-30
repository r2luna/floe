// Scenarios for the colony lane eval — data only, no model calls in here.
//
// A scenario is a tiny git repo plus a brief, and what the lane must do with it.
//   base  — files committed on `main`           (what the task was cut from)
//   work  — files committed on `feature/<id>`   (what earlier lanes left behind)
// The runner writes `specs/feature-<id>/task.md` from `brief`, so `work` never needs to.
//
// Every run is also held to the generic checks in run.mjs (one valid hand-off line,
// last in the message, no AskUserQuestion, no trailing question). `expect` is on top:
//   { verdict: ['pass', 'return:coder', 'stop'] }  hand-off must be one of these
//   { grep: 're', in: 'specs/x' | '.', absent? }    regex over text files (flags: i)
//   { file: 'path', absent? }                       path exists / does not exist
//   { run: 'sh cmd', exit: 0 }                      command in the fixture dir
//   { newCommits: true | false }                    lane committed (or deliberately did not)
//   { any: [...] } / { all: [...] }                 combinators

const pkg = JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node --test' } }, null, 2)
const pkgEsm = JSON.stringify(
  { name: 'fixture', version: '1.0.0', type: 'module', scripts: { test: 'node --test', lint: 'node scripts/lint.js' } },
  null,
  2
)
const AGENTS = `# Fixture\n\nTiny CommonJS project. Tests: \`npm test\` (node:test). Keep modules small.\n`
const dir = (id) => `specs/feature-${id}`

/** @type {import('./run.mjs').Scenario[]} */
export const SCENARIOS = []
const add = (s) => SCENARIOS.push(s)

// ---- specifier ----------------------------------------------------------------

{
  const id = 'specify-vague-brief'
  const d = dir(id)
  add({
    id, lane: 'specifier', skill: 'colony-specify', autonomous: true,
    name: 'Export todos',
    brief: 'Users want to get their todos out of the app. Add an export.',
    base: { 'package.json': pkg, 'AGENTS.md': AGENTS,
      'src/todos.js': `const todos = []\nmodule.exports = {\n  add: (text) => { todos.push({ text, done: false }) },\n  list: () => todos.slice()\n}\n` },
    work: {},
    expect: [
      { verdict: ['pass'] },
      { file: `${d}/spec.md` }, { file: `${d}/plan.md` }, { file: `${d}/tasks.md` },
      { grep: 'assum', in: d }, // the vague parts (format, destination) are decided and recorded, not asked
      { run: 'git diff main --quiet -- src', exit: 0 } // the specifier writes no product code
    ]
  })
}
{
  const id = 'specify-already-done'
  add({
    id, lane: 'specifier', skill: 'colony-specify', autonomous: true,
    name: 'Add --version flag',
    brief: 'Add a --version flag to the CLI that prints the package version.',
    base: { 'package.json': pkg, 'AGENTS.md': AGENTS,
      'src/cli.js': `const { version } = require('../package.json')\nif (process.argv.includes('--version')) {\n  console.log(version)\n  process.exit(0)\n}\nconsole.log('usage: cli [--version]')\n` },
    work: {},
    expect: [{ verdict: ['stop'] }, { file: `${dir(id)}/spec.md`, absent: true }]
  })
}
{
  const id = 'specify-inherits-decisions'
  const d = dir(id)
  add({
    id, lane: 'specifier', skill: 'colony-specify', autonomous: true,
    name: 'Export todos as CSV',
    brief: `Export todos.\n\n## Decisions\n- Q: Which file format? -> A: CSV only, no JSON\n- Q: Where does the file go? -> A: stdout, the caller redirects\n\n## Out of scope\n- Importing\n\n## Done when\n- \`node src/cli.js export\` prints one CSV row per todo`,
    base: { 'package.json': pkg, 'AGENTS.md': AGENTS,
      'src/todos.js': `module.exports = { list: () => [{ text: 'a', done: false }] }\n` },
    work: {},
    expect: [
      { verdict: ['pass'] },
      { file: `${d}/spec.md` },
      { grep: '->\\s*A:.*CSV.*\\(user\\)', in: d }, // decisions copied in verbatim, tagged (user)
      { grep: '->\\s*A:.*stdout.*\\(user\\)', in: d }
    ]
  })
}

// ---- coder --------------------------------------------------------------------

{
  const id = 'implement-clear-plan'
  const d = dir(id)
  add({
    id, lane: 'coder', skill: 'colony-implement', autonomous: true,
    name: 'slugify helper',
    brief: 'Add a slugify helper.',
    base: { 'package.json': pkg, 'AGENTS.md': AGENTS },
    work: {
      [`${d}/spec.md`]: `# Spec\n\nslugify(str) turns a title into a URL slug.\n\n- Given "  Hello, World! " When slugify Then "hello-world"\n- Runs of non-alphanumerics collapse to one "-"; no leading or trailing "-".\n`,
      [`${d}/plan.md`]: `# Plan\n\nNew module \`src/slug.js\`, CommonJS: \`module.exports = { slugify }\`. Test in \`test/slug.test.js\` with node:test.\n`,
      [`${d}/tasks.md`]: `# Tasks\n\n- [ ] T001 Write test/slug.test.js covering the examples in spec.md\n- [ ] T002 Implement src/slug.js so the test passes\n`
    },
    expect: [
      { verdict: ['pass'] },
      { run: 'node --test', exit: 0 },
      { run: `node -e "if (require('./src/slug').slugify('  Hello, World! ') !== 'hello-world') process.exit(1)"`, exit: 0 },
      { grep: '\\[x\\] T002', in: d },
      { newCommits: true }
    ]
  })
}
{
  const id = 'implement-underspecified'
  const d = dir(id)
  add({
    id, lane: 'coder', skill: 'colony-implement', autonomous: true,
    name: 'Retry fetchUser',
    brief: 'Retry failed user fetches.',
    base: { 'package.json': pkg, 'AGENTS.md': AGENTS,
      'src/api.js': `async function fetchUser(id, fetchImpl = fetch) {\n  const res = await fetchImpl('/users/' + id)\n  if (!res.ok) throw new Error('HTTP ' + res.status)\n  return res.json()\n}\nmodule.exports = { fetchUser }\n` },
    work: {
      [`${d}/spec.md`]: `# Spec\n\nA flaky network should not surface as an error on the first failure. fetchUser retries.\n`,
      [`${d}/plan.md`]: `# Plan\n\nWrap the request in src/api.js in a retry.\n`,
      [`${d}/tasks.md`]: `# Tasks\n\n- [ ] T001 Add retry to fetchUser in src/api.js (with a test)\n`
    },
    // Attempts, delay and which errors retry are all unstated. Decide-and-record, or hand back; never ask.
    expect: [{ any: [{ verdict: ['return:specifier'] }, { all: [{ verdict: ['pass'] }, { grep: 'assum', in: '.' }] }] }]
  })
}

// ---- cleaner ------------------------------------------------------------------

{
  const id = 'refactor-leave-clean-code'
  const d = dir(id)
  add({
    id, lane: 'cleaner', skill: 'colony-refactor', autonomous: true,
    name: 'clamp helper',
    brief: 'Add a clamp helper.',
    base: { 'package.json': pkg, 'AGENTS.md': AGENTS },
    work: {
      [`${d}/spec.md`]: `# Spec\n\nclamp(n, min, max) bounds n to the range.\n`,
      [`${d}/plan.md`]: `# Plan\n\nsrc/clamp.js, CommonJS.\n`,
      [`${d}/tasks.md`]: `# Tasks\n\n- [x] T001 test\n- [x] T002 implement\n`,
      'src/clamp.js': `function clamp(n, min, max) {\n  return Math.min(Math.max(n, min), max)\n}\nmodule.exports = { clamp }\n`,
      'test/clamp.test.js': `const test = require('node:test')\nconst assert = require('node:assert')\nconst { clamp } = require('../src/clamp')\ntest('clamp', () => {\n  assert.equal(clamp(5, 0, 3), 3)\n  assert.equal(clamp(-1, 0, 3), 0)\n  assert.equal(clamp(2, 0, 3), 2)\n})\n`
    },
    // Boring, clear, local code is the right answer: no abstraction invented, nothing to commit.
    expect: [{ verdict: ['pass'] }, { newCommits: false }, { run: 'node --test', exit: 0 }]
  })
}

// ---- architect ----------------------------------------------------------------

{
  const id = 'architecture-gate-red'
  const d = dir(id)
  add({
    id, lane: 'architect', skill: 'colony-architecture', autonomous: true,
    name: 'Price quote command',
    brief: 'Add a quote command.',
    base: {
      'package.json': pkgEsm,
      'AGENTS.md': `# Fixture\n\n- ESM. Named exports only: never \`export default\`.\n- Business rules live in \`src/lib/\`; \`src/cli.js\` only parses arguments.\n- Gate: \`npm run lint\` and \`npm test\` must both be green.\n`,
      'scripts/lint.js': `import { readFileSync, readdirSync } from 'node:fs'\nlet bad = 0\nfor (const f of readdirSync('src', { recursive: true }).filter((f) => f.endsWith('.js'))) {\n  if (/export default/.test(readFileSync('src/' + f, 'utf8'))) { console.error('default export in src/' + f); bad = 1 }\n}\nprocess.exit(bad)\n`,
      'src/lib/money.js': `export const cents = (dollars) => Math.round(dollars * 100)\n`,
      'src/cli.js': `import { cents } from './lib/money.js'\nconsole.log(cents(Number(process.argv[2] ?? 0)))\n`
    },
    work: {
      [`${d}/spec.md`]: `# Spec\n\n\`quote <price> <qty>\` prints the total in cents with a 10% discount from 10 units.\n`,
      [`${d}/plan.md`]: `# Plan\n\nAdd the command.\n`,
      [`${d}/tasks.md`]: `# Tasks\n\n- [x] T001 quote command\n`,
      'src/cli.js': `import { cents } from './lib/money.js'\n\n// pricing rule written straight into the entry point\nexport default function quote(price, qty) {\n  const total = cents(price) * qty\n  return qty >= 10 ? Math.round(total * 0.9) : total\n}\nconsole.log(quote(Number(process.argv[2] ?? 0), Number(process.argv[3] ?? 1)))\n`
    },
    // Red gate + business rule in the CLI: send it back with a finding, do not redesign it here.
    expect: [{ verdict: ['return:coder'] }, { file: `${d}/architecture.md` }]
  })
}

// ---- hardener -----------------------------------------------------------------

{
  const id = 'review-seeded-bug'
  const d = dir(id)
  add({
    id, lane: 'hardener', skill: 'colony-review', autonomous: true,
    name: 'Pagination helper',
    brief: 'Add a paginate helper.',
    base: { 'package.json': pkg, 'AGENTS.md': AGENTS },
    work: {
      [`${d}/spec.md`]: `# Spec\n\npaginate(items, page, size) returns one page. Pages are 1-based: page 1 is the first \`size\` items.\n`,
      [`${d}/plan.md`]: `# Plan\n\nsrc/paginate.js, CommonJS.\n`,
      [`${d}/tasks.md`]: `# Tasks\n\n- [x] T001 test\n- [x] T002 implement\n`,
      // Page 1 starts at index size: the first page is skipped. The only test hits page 2, so it is green.
      'src/paginate.js': `function paginate(items, page, size) {\n  const start = page * size\n  return items.slice(start, start + size)\n}\nmodule.exports = { paginate }\n`,
      'test/paginate.test.js': `const test = require('node:test')\nconst assert = require('node:assert')\nconst { paginate } = require('../src/paginate')\ntest('page 2', () => {\n  assert.deepEqual(paginate([1, 2, 3, 4, 5, 6], 2, 2), [3, 4])\n})\n`
    },
    // Either fixed in place, or sent back with the finding. Waving it through is the failure.
    expect: [
      { verdict: ['pass', 'return:coder'] },
      { any: [{ verdict: ['return:coder'] }, { run: `node -e "const a=require('./src/paginate').paginate([1,2,3,4],1,2);if(a.join()!=='1,2')process.exit(1)"`, exit: 0 }] }
    ]
  })
}
{
  const id = 'review-clean-change'
  const d = dir(id)
  add({
    id, lane: 'hardener', skill: 'colony-review', autonomous: true,
    name: 'Sum helper',
    brief: 'Add a sum helper.',
    base: { 'package.json': pkg, 'AGENTS.md': AGENTS },
    work: {
      [`${d}/spec.md`]: `# Spec\n\nsum(numbers) adds an array of numbers; an empty array is 0.\n`,
      [`${d}/plan.md`]: `# Plan\n\nsrc/sum.js, CommonJS.\n`,
      [`${d}/tasks.md`]: `# Tasks\n\n- [x] T001 test\n- [x] T002 implement\n`,
      'src/sum.js': `const sum = (numbers) => numbers.reduce((a, b) => a + b, 0)\nmodule.exports = { sum }\n`,
      'test/sum.test.js': `const test = require('node:test')\nconst assert = require('node:assert')\nconst { sum } = require('../src/sum')\ntest('sum', () => {\n  assert.equal(sum([1, 2, 3]), 6)\n  assert.equal(sum([]), 0)\n})\n`
    },
    // Nothing material to flag: style nitpicks are noise, so a correct change must not bounce.
    expect: [{ verdict: ['pass'] }, { run: 'node --test', exit: 0 }]
  })
}

// ---- qa -----------------------------------------------------------------------

{
  const id = 'verify-failing-suite'
  const d = dir(id)
  add({
    id, lane: 'qa', skill: 'colony-verify', autonomous: true,
    name: 'Bulk discount',
    brief: 'Add a bulk discount.',
    base: { 'package.json': pkg, 'AGENTS.md': AGENTS },
    work: {
      [`${d}/spec.md`]: `# Spec\n\napplyDiscount(total) takes 10% off orders of 100 or more.\n\n- Given 100 Then 90\n- Given 99 Then 99\n`,
      [`${d}/plan.md`]: `# Plan\n\nsrc/discount.js, CommonJS.\n`,
      [`${d}/tasks.md`]: `# Tasks\n\n- [x] T001 test\n- [x] T002 implement\n`,
      'src/discount.js': `const applyDiscount = (total) => (total > 100 ? total * 0.9 : total)\nmodule.exports = { applyDiscount }\n`,
      'test/discount.test.js': `const test = require('node:test')\nconst assert = require('node:assert')\nconst { applyDiscount } = require('../src/discount')\ntest('100 gets the discount', () => assert.equal(applyDiscount(100), 90))\ntest('99 does not', () => assert.equal(applyDiscount(99), 99))\n`
    },
    expect: [{ verdict: ['return:coder'] }, { file: `${d}/verify.md` }]
  })
}
{
  const id = 'verify-green'
  const d = dir(id)
  add({
    id, lane: 'qa', skill: 'colony-verify', autonomous: true,
    name: 'Is even',
    brief: 'Add isEven.',
    base: { 'package.json': pkg, 'AGENTS.md': AGENTS },
    work: {
      [`${d}/spec.md`]: `# Spec\n\nisEven(n) is true for even integers, false otherwise.\n\n- Given 4 Then true\n- Given 7 Then false\n`,
      [`${d}/plan.md`]: `# Plan\n\nsrc/even.js, CommonJS.\n`,
      [`${d}/tasks.md`]: `# Tasks\n\n- [x] T001 test\n- [x] T002 implement\n`,
      'src/even.js': `const isEven = (n) => n % 2 === 0\nmodule.exports = { isEven }\n`,
      'test/even.test.js': `const test = require('node:test')\nconst assert = require('node:assert')\nconst { isEven } = require('../src/even')\ntest('even', () => assert.equal(isEven(4), true))\ntest('odd', () => assert.equal(isEven(7), false))\n`
    },
    expect: [{ verdict: ['pass'] }, { run: 'node --test', exit: 0 }]
  })
}
