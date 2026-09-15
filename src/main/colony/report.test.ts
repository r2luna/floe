import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHook } from '../config/hook.test-helper.ts'
import { makeGitRepo } from '../gitFixture.test-helper.ts'

// Same walls as git.test.ts: report.ts spawns git with this process's env.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key]
process.env.GIT_CEILING_DIRECTORIES = realpathSync(tmpdir())
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_SYSTEM = '/dev/null'

installHook()

const { snapshotTree } = await import('../git.ts')
const { reportData, renderReport, writeReport } = await import('./report.ts')
type ColonyTask = import('./store.ts').ColonyTask

const usage = { input: 10, output: 20, cacheRead: 300, cacheWrite: 0 }

test('each step gets its own diff and the diff since the first step; unmeasured visits are left out', async () => {
  const fx = makeGitRepo()
  const project = mkdtempSync(join(realpathSync(tmpdir()), 'floe-report-project-'))
  try {
    fx.write('a.txt', 'one\n')
    fx.commit('init')
    const t0 = await snapshotTree(fx.dir)
    writeFileSync(join(fx.dir, 'a.txt'), 'one\ntwo\n')
    const t1 = await snapshotTree(fx.dir)
    writeFileSync(join(fx.dir, 'b.txt'), 'bee\n')
    const t2 = await snapshotTree(fx.dir)

    const step = (treeBefore: string, treeAfter: string, text: string) => ({
      startedAt: 1,
      endedAt: 2,
      usage,
      treeBefore,
      treeAfter,
      findingsDeclared: true,
      findings: [{ severity: 'high' as const, fresh: true, text }],
      message: text
    })
    const task: ColonyTask = {
      id: 'task_abc123',
      project,
      name: 'measured',
      kind: 'feat',
      brief: 'x',
      stage: 'done',
      status: 'settled',
      passes: 3,
      worktreePath: fx.dir,
      createdAt: 0,
      updatedAt: 0,
      report: { since: 0 },
      visits: [
        { at: 0, stage: 'old', verdict: 'pass' },
        { at: 1, stage: 'coder', verdict: 'pass', step: step(t0, t1, 'first') },
        { at: 2, stage: 'architect', verdict: 'pass', step: step(t1, t2, '</script><b>x</b>') }
      ]
    }

    const data = await reportData(task)
    assert.deepEqual(data.steps.map((s) => s.stage), ['coder', 'architect'])
    assert.deepEqual(data.steps[0].files.map((f) => f.path), ['a.txt'])
    assert.deepEqual(data.steps[1].files.map((f) => f.path), ['b.txt'], 'the architect step is only what it wrote')
    assert.deepEqual(data.steps[1].sinceStart.map((f) => f.path), ['a.txt', 'b.txt'])

    // Model text cannot close the data script it is embedded in.
    const html = renderReport(data)
    assert.equal(html.match(/<\/script>/g)?.length, 2, 'only the two real closing tags')

    const { file } = await writeReport(task)
    assert.equal(file, join(project, '.floe', 'colony', 'reports', 'measured-abc123.html'))
    assert.ok(existsSync(file))
    assert.equal(readFileSync(join(project, '.floe', 'colony', 'reports', '.gitignore'), 'utf8'), '*\n')
  } finally {
    fx.cleanup()
    rmSync(project, { recursive: true, force: true })
  }
})
