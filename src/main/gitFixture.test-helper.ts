// A throwaway git repository for tests, walled off from Floe's own.
//
// This exists because the obvious version is dangerous. `spawnSync('git', ...)`
// inherits the caller's cwd and any GIT_DIR / GIT_INDEX_FILE the environment
// carries (a pre-commit hook exports both), and git happily walks up out of a
// fixture directory to find an enclosing repository. A test that gets this
// wrong does not fail — it silently commits into Floe's own history. That has
// happened here: a stray `git add -A && git commit` deleted all 503 tracked
// files on the working branch.
//
// So every spawn here is pinned three ways: cwd is the fixture, every inherited
// GIT_* variable is dropped, and GIT_CEILING_DIRECTORIES stops the upward walk
// at the fixture's parent. `makeGitRepo()` then verifies the repository git
// actually resolved to is the one it created, before a test can write to it.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export type GitFixture = {
  /** The repository root — an absolute, symlink-resolved path. */
  dir: string
  /** Run git inside the fixture. Throws on a non-zero exit. */
  git: (...args: string[]) => string
  /** Write a file (parents created) and stage it. */
  write: (rel: string, body: string) => void
  /** Stage everything and commit. */
  commit: (message: string) => void
  cleanup: () => void
}

/** The env every fixture spawn gets: no inherited git state, no upward walk. */
function fixtureEnv(dir: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  return {
    ...env,
    GIT_CEILING_DIRECTORIES: dirname(dir),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  }
}

export function makeGitRepo(prefix = 'floe-fixture-'): GitFixture {
  // realpath because on macOS mkdtemp returns /var/... while git reports
  // /private/var/..., and the toplevel check below compares the two.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))

  const git = (...args: string[]): string => {
    const res = spawnSync('git', args, { cwd: dir, env: fixtureEnv(dir), encoding: 'utf8' })
    if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed in fixture: ${res.stderr || res.stdout}`)
    return res.stdout.trim()
  }

  git('init', '-b', 'main')

  // The whole point of the file. If git resolved to any repository other than
  // the one just created, the test is about to write to somebody else's history.
  const toplevel = git('rev-parse', '--show-toplevel')
  if (realpathSync(toplevel) !== dir) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error(`git fixture escaped its directory: resolved to ${toplevel}, expected ${dir}`)
  }

  return {
    dir,
    git,
    write(rel, body) {
      const abs = join(dir, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, body)
      git('add', rel)
    },
    commit(message) {
      git('add', '-A')
      git('commit', '-m', message)
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
