#!/usr/bin/env node
// The quality gate: lint, typecheck, tests, CRAP. Nothing ships red.
//
//   pnpm gate            # all four stages, exit 1 if any fails
//   pnpm gate --report   # same output, always exits 0
//   pnpm gate --top 40   # longer CRAP table
//
// Every stage runs even when an earlier one fails, so one run shows the whole
// picture. The test stage writes coverage that the CRAP stage then reads, so the
// suite is executed exactly once.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const has = (name) => args.includes(`--${name}`)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}

const lcov = join(mkdtempSync(join(tmpdir(), 'floe-gate-')), 'lcov.info')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

const stages = [
  {
    name: 'lint',
    why: 'oxlint over src, warnings included',
    cmd: ['npx', ['oxlint', 'src', '--deny-warnings']],
  },
  {
    name: 'typecheck',
    why: 'tsc for node + web',
    cmd: [pnpm, ['run', 'typecheck']],
  },
  {
    name: 'test',
    why: 'node --test, writing coverage for the CRAP stage',
    cmd: [
      process.execPath,
      [
        '--test',
        '--experimental-test-coverage',
        '--test-reporter=dot',
        '--test-reporter-destination=stdout',
        '--test-reporter=lcov',
        `--test-reporter-destination=${lcov}`,
        'src/**/*.test.ts',
      ],
    ],
  },
  {
    name: 'crap',
    why: `no gated function over CRAP ${flag('threshold', 30)}`,
    cmd: [
      process.execPath,
      ['scripts/crap.mjs', '--lcov', lcov, '--fail', '--top', flag('top', '15'), '--threshold', flag('threshold', '30')],
    ],
  },
]

const results = []
for (const stage of stages) {
  // A missing lcov means the test stage never got far enough to write one;
  // scoring CRAP against nothing would report every function at 0% coverage.
  if (stage.name === 'crap' && !existsSync(lcov)) {
    results.push({ name: stage.name, ok: false, note: 'skipped — no coverage from the test stage' })
    continue
  }
  process.stdout.write(`\n\x1b[1m── ${stage.name}\x1b[0m  ${stage.why}\n`)
  const [bin, argv] = stage.cmd
  const res = spawnSync(bin, argv, { cwd: ROOT, stdio: 'inherit' })
  results.push({ name: stage.name, ok: res.status === 0 })
}

const failed = results.filter((r) => !r.ok)
process.stdout.write('\n\x1b[1m── gate\x1b[0m\n')
for (const r of results) {
  const mark = r.ok ? '\x1b[32mpass\x1b[0m' : '\x1b[31mFAIL\x1b[0m'
  process.stdout.write(`  ${mark}  ${r.name}${r.note ? `  (${r.note})` : ''}\n`)
}
process.stdout.write(failed.length === 0 ? '\ngate green\n\n' : `\n${failed.length} stage(s) failed\n\n`)

if (failed.length > 0 && !has('report')) process.exit(1)
