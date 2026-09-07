import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { installHook } from './config/hook.test-helper.ts'
import { makeGitRepo, type GitFixture } from './gitFixture.test-helper.ts'

// `watchChanges` shells out to `git rev-parse --git-dir` with the ambient
// environment, and this suite can run from the pre-commit hook, which exports
// GIT_DIR and GIT_INDEX_FILE — it would then watch Floe's own git dir instead of
// the fixture's, and assert against events from this repository. Drop every
// inherited GIT_* and stop the upward walk at the tmpdir the fixtures live in.
// (Fixture-side git goes through makeGitRepo, which pins its own spawns.)
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key]
process.env.GIT_CEILING_DIRECTORIES = [tmpdir(), realpathSync(tmpdir())].join(':')

installHook()

const { isNoise, isTreeNoise, watchChanges } = await import('./reviewWatch.ts')

test('the git dir and node_modules reach neither panel', () => {
  for (const path of ['.git', '.git/index', 'node_modules', 'node_modules/x/y.js', 'a/node_modules/b']) {
    assert.equal(isTreeNoise(path), true, path)
    assert.equal(isNoise(path), true, path)
  }
})

test('.floe moves no diff but is a file in the tree', () => {
  // The bug this split exists for: an agent writing a plan must appear in the
  // tree without costing the Changes list a git call.
  assert.equal(isNoise('.floe/plans/2026-08-29.md'), true)
  assert.equal(isTreeNoise('.floe/plans/2026-08-29.md'), false)
})

test('ordinary source files reach both', () => {
  assert.equal(isNoise('src/main/files.ts'), false)
  assert.equal(isTreeNoise('src/main/files.ts'), false)
})

test('an unnamed event refreshes both rather than being dropped', () => {
  assert.equal(isNoise(null), false)
  assert.equal(isTreeNoise(null), false)
})

// --- watchChanges -----------------------------------------------------------
//
// Real fs.watch over real temp repos: the whole point of this function is which
// filesystem events reach which panel, and a stubbed watcher would assert only
// that the stub was called. Every test tears its watchers down through the
// public API (see the last one) so `node --test` can exit.

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Recorder {
  wc: WebContents
  sent: { channel: string; worktreePath: string }[]
}

function recorder(): Recorder {
  const sent: Recorder['sent'] = []
  const wc = {
    isDestroyed: () => false,
    send: (channel: string, payload: { worktreePath: string }) =>
      sent.push({ channel, worktreePath: payload.worktreePath })
  }
  return { wc: wc as unknown as WebContents, sent }
}

const fixtures: GitFixture[] = []

function repo(name: string): string {
  const fixture = makeGitRepo(`floe-watch-${name}-`)
  fixtures.push(fixture)
  return fixture.dir
}

// Arm the watcher and wait for it to go quiet: FSEvents can replay a change
// made just before the watch started (the fixture setup), and that would land
// in the assertion for whatever the test does next.
async function arm(rec: Recorder, path: string): Promise<void> {
  await watchChanges(rec.wc, path)
  await sleep(400)
  rec.sent.length = 0
}

// Wait until `want` many sends have landed, then one more debounce window so a
// send we did NOT want still has time to show up and fail the assertion.
async function expectSends(rec: Recorder, want: string[]): Promise<Recorder['sent']> {
  const deadline = Date.now() + 4000
  while (Date.now() < deadline && rec.sent.length < want.length) await sleep(20)
  await sleep(400)
  assert.deepEqual(
    rec.sent.map((s) => s.channel).sort(),
    [...want].sort(),
    `sent: ${JSON.stringify(rec.sent)}`
  )
  return rec.sent.splice(0)
}

async function expectQuiet(rec: Recorder): Promise<void> {
  await sleep(900)
  assert.deepEqual(rec.sent, [])
}

after(() => {
  for (const fixture of fixtures) fixture.cleanup()
})

test('a working-tree edit refreshes both the tree and the review', async () => {
  const root = repo('tree')
  const rec = recorder()
  await arm(rec, root)

  writeFileSync(join(root, 'a.ts'), 'export const a = 1')
  const sent = await expectSends(rec, ['files:changed', 'review:event'])
  // Both payloads name the worktree, so the renderer knows which one refreshed.
  assert.deepEqual(new Set(sent.map((s) => s.worktreePath)), new Set([root]))
})

test('a .floe write reaches the tree only, costing the review no git call', async () => {
  const root = repo('floe')
  // The directory exists before we arm: only paths *under* `.floe/` are noise,
  // and creating the dir itself is an ordinary tree change.
  mkdirSync(join(root, '.floe', 'plans'), { recursive: true })
  const rec = recorder()
  await arm(rec, root)

  writeFileSync(join(root, '.floe', 'plans', 'p.md'), 'plan')
  await expectSends(rec, ['files:changed'])
})

test('git state written behind the tree watcher still refreshes the review', async () => {
  const root = repo('gitdir')
  const rec = recorder()
  await arm(rec, root)

  // `.git/…` is tree noise, so only the separate git-dir watcher can see this —
  // an external commit/stage/reset from the user's terminal looks exactly so.
  writeFileSync(join(root, '.git', 'index'), 'fake index')
  await expectSends(rec, ['review:event'])

  writeFileSync(join(root, '.git', 'ORIG_HEAD'), 'deadbeef')
  await expectSends(rec, ['review:event'])

  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true })
  writeFileSync(join(root, '.git', 'refs', 'heads', 'feat'), 'deadbeef')
  await expectSends(rec, ['review:event'])
})

test('a git file that moves no diff refreshes nothing', async () => {
  const root = repo('quiet')
  const rec = recorder()
  await arm(rec, root)

  writeFileSync(join(root, '.git', 'COMMIT_EDITMSG'), 'wip')
  await expectQuiet(rec)
})

test('the Home workspace is skipped before the live watcher is touched', async () => {
  const root = repo('home')
  const rec = recorder()
  await arm(rec, root)

  // ~ has no diff to review and (on Linux) a recursive watch over it blocks the
  // event loop for seconds, so this returns before it closes anything.
  await watchChanges(rec.wc, homedir())
  writeFileSync(join(root, 'still-live.ts'), '')
  await expectSends(rec, ['files:changed', 'review:event'])
})

test('switching worktree stops the old one and reports the new path', async () => {
  const before = repo('before')
  const after_ = repo('after')
  const rec = recorder()
  await watchChanges(rec.wc, before)
  await arm(rec, after_)

  writeFileSync(join(before, 'stale.ts'), '')
  await expectQuiet(rec)

  writeFileSync(join(after_, 'fresh.ts'), '')
  const sent = await expectSends(rec, ['files:changed', 'review:event'])
  assert.deepEqual(new Set(sent.map((s) => s.worktreePath)), new Set([after_]))
  // Re-arming on the same path is a no-op, so the events keep going to the
  // WebContents the live watcher closed over, not to a later caller's.
  const later = recorder()
  await watchChanges(later.wc, after_)
  writeFileSync(join(after_, 'again.ts'), '')
  await expectSends(rec, ['files:changed', 'review:event'])
  assert.deepEqual(later.sent, [])
})

test('a vanished worktree leaves no watcher behind', async () => {
  const gone = join(tmpdir(), 'floe-watch-gone-does-not-exist')
  const rec = recorder()
  await arm(rec, gone)

  // The previous test's fixture is now unwatched — nothing it does is reported.
  writeFileSync(join(fixtures[fixtures.length - 1].dir, 'orphan.ts'), '')
  await expectQuiet(rec)
})
