import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { installHook } from '../config/hook.test-helper.ts'
import { makeGitRepo, type GitFixture } from '../gitFixture.test-helper.ts'

// The functions under test spawn their own git and inherit this environment, so
// the walls from git.test.ts go up here too: nothing may reach Floe's own history.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key]
const TMP = realpathSync(tmpdir())
process.env.GIT_CEILING_DIRECTORIES = TMP
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_SYSTEM = '/dev/null'
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Floe Test'
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@floe.invalid'

installHook()

const data = mkdtempSync(join(TMP, 'floe-integrations-data-'))
process.on('exit', () => rmSync(data, { recursive: true, force: true }))
const { setSharedDataDir } = await import('../dataDir.ts')
setSharedDataDir(data)

const { fetchPullRequest } = await import('../git.ts')
const { availableSources, createWorktreeFromSource, integrationStatus, listTaskIssues, searchSource } = await import('./index.ts')
const { openCredentials, readCredentials, sealCredentials, setCredential } = await import('./credentials.ts')
const { adfText, jiraOrigin } = await import('./jira.ts')

let repo: GitFixture
let scratch: string
const realFetch = globalThis.fetch
let calls: Array<{ url: string; auth: string }>

// A stand-in for gh: answers from a table of "<args> => <json>", so no test can
// reach GitHub.
function fakeGh(answers: Record<string, unknown>, fail: Record<string, string> = {}): void {
  const script = join(scratch, 'gh')
  const body = [
    '#!/usr/bin/env node',
    `const answers = ${JSON.stringify(answers)}`,
    `const fail = ${JSON.stringify(fail)}`,
    "const key = process.argv.slice(2, 4).join(' ') + ':' + (process.argv[4] ?? '')",
    'for (const [k, said] of Object.entries(fail)) if (key.startsWith(k)) { console.error(said); process.exit(1) }',
    'for (const [k, answer] of Object.entries(answers)) if (key.startsWith(k)) { console.log(JSON.stringify(answer)); process.exit(0) }',
    "console.error('Could not resolve to an issue or pull request'); process.exit(1)"
  ].join('\n')
  writeFileSync(script, body)
  chmodSync(script, 0o755)
  process.env.FLOE_GH_BIN = script
}

/** gh is not on this machine. */
function noGh(): void {
  process.env.FLOE_GH_BIN = join(scratch, 'no-such-gh')
}

// Answers by URL substring, first match wins. Anything unlisted is a 404.
function fakeApi(routes: Array<[string, unknown, number?]>): void {
  globalThis.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization ?? '' })
    const route = routes.find(([match]) => String(url).includes(match))
    return new Response(route ? JSON.stringify(route[1]) : '{}', { status: route ? (route[2] ?? 200) : 404 })
  }) as typeof fetch
}

const ghPull = {
  number: 12,
  title: 'Fix it',
  url: 'https://github.com/acme/app/pull/12',
  author: { login: 'ana' },
  headRefName: 'feat/Fix_it-1.0',
  baseRefName: 'main',
  isCrossRepository: false,
  isDraft: false
}
const ghIssue = { number: 34, title: 'Broken: the thing', url: 'https://github.com/acme/app/issues/34', author: { login: 'rui' } }

const bbPull = {
  id: 5,
  title: 'Add login',
  author: { display_name: 'Ana' },
  links: { html: { href: 'https://bitbucket.org/acme/app/pull-requests/5' } },
  source: { branch: { name: 'feat/login' }, repository: { full_name: 'acme/app' } },
  destination: { branch: { name: 'main' }, repository: { full_name: 'acme/app' } }
}

function bareRemote(): string {
  const bare = join(scratch, 'remote.git')
  spawnSync('git', ['clone', '--bare', '-q', repo.dir, bare], {
    env: { ...process.env, GIT_CEILING_DIRECTORIES: scratch }
  })
  return bare
}

beforeEach(() => {
  repo = makeGitRepo()
  scratch = realpathSync(mkdtempSync(join(TMP, 'floe-sources-')))
  rmSync(join(data, 'credentials.json'), { force: true })
  calls = []
  repo.write('a.txt', 'a\n')
  repo.commit('init')
  repo.git('branch', '-M', 'main')
})

afterEach(() => {
  delete process.env.FLOE_GH_BIN
  globalThis.fetch = realFetch
  repo.cleanup()
  rmSync(scratch, { recursive: true, force: true })
})

test('a project gets a tab for each forge it has a remote on, and always Jira', async () => {
  assert.deepEqual(await availableSources(repo.dir), ['jira'])
  repo.git('remote', 'add', 'origin', 'git@bitbucket.org:acme/app.git')
  assert.deepEqual(await availableSources(repo.dir), ['bitbucket', 'jira'])
  repo.git('remote', 'add', 'github', 'git@github.com:acme/app.git')
  assert.deepEqual(await availableSources(repo.dir), ['github', 'bitbucket', 'jira'])
})

test('with gh available, GitHub lists through it from the GitHub remote', async () => {
  repo.git('remote', 'add', 'origin', 'ssh://git@git.pinguim.io/acme/app.git')
  repo.git('remote', 'add', 'github', 'git@github.com:acme/app.git')
  fakeGh({ 'pr list:': [ghPull], 'issue list:': [ghIssue] })
  fakeApi([])
  const found = await searchSource(repo.dir, 'github')
  assert.equal(found.error, undefined)
  assert.deepEqual(found.items.map((i) => [i.kind, i.ref]), [['pr', '12'], ['issue', '34']])
  assert.equal(calls.length, 0, 'gh answered, so the API is never asked')
})

test('a repository with issues turned off still lists its PRs', async () => {
  repo.git('remote', 'add', 'origin', 'git@github.com:acme/app.git')
  fakeGh({ 'pr list:': [ghPull] }, { 'issue list:': 'the repository has disabled issues' })
  const found = await searchSource(repo.dir, 'github')
  assert.equal(found.error, undefined)
  assert.equal(found.items.length, 1)
})

test('without gh and without a token, the form says what to do', async () => {
  repo.git('remote', 'add', 'origin', 'git@github.com:acme/app.git')
  noGh()
  assert.match((await searchSource(repo.dir, 'github')).error ?? '', /gh auth login.*Settings/)
})

test('a logged-out gh falls back to the saved token', async () => {
  repo.git('remote', 'add', 'origin', 'git@github.com:acme/app.git')
  fakeGh({}, { 'pr list:': 'run: gh auth login', 'issue list:': 'run: gh auth login' })
  setCredential('github', 'token', 'ghp_secret')
  fakeApi([
    ['/pulls', []],
    ['/issues', [{ number: 34, title: 'Broken', html_url: 'u', user: { login: 'rui' } }]]
  ])
  const found = await searchSource(repo.dir, 'github')
  assert.deepEqual(found.items.map((i) => i.ref), ['34'])
  assert.equal(calls[0].auth, 'Bearer ghp_secret')
})

test('a gh failure that is not about access is reported, and the token is not tried', async () => {
  repo.git('remote', 'add', 'origin', 'git@github.com:acme/app.git')
  fakeGh({}, { 'pr list:': 'HTTP 502\nmore', 'issue list:': 'HTTP 502\nmore' })
  setCredential('github', 'token', 'ghp_secret')
  fakeApi([])
  assert.equal((await searchSource(repo.dir, 'github')).error, 'HTTP 502')
  assert.equal(calls.length, 0)
})

test('with only a token, GitHub maps PRs and issues and drops the PRs the issues endpoint repeats', async () => {
  repo.git('remote', 'add', 'origin', 'git@github.com:acme/app.git')
  noGh()
  setCredential('github', 'token', 'ghp_secret')
  const pull = {
    number: 12,
    title: 'Fix login',
    html_url: 'https://github.com/acme/app/pull/12',
    user: { login: 'ana' },
    head: { ref: 'patch', repo: { full_name: 'them/app' } },
    base: { ref: 'main', repo: { full_name: 'acme/app' } }
  }
  fakeApi([
    ['/pulls', [pull]],
    ['/issues', [{ number: 12, title: 'Fix login', html_url: 'u', pull_request: {} }, { number: 34, title: 'Broken', html_url: 'v' }]]
  ])
  const found = await searchSource(repo.dir, 'github')
  assert.deepEqual(found.items.map((i) => [i.kind, i.ref, i.fork]), [['pr', '12', true], ['issue', '34', undefined]])
})

test('a token search filters PRs by title and asks the search API for issues', async () => {
  repo.git('remote', 'add', 'origin', 'git@github.com:acme/app.git')
  noGh()
  setCredential('github', 'token', 't')
  const pull = (number: number, title: string) => ({
    number,
    title,
    html_url: 'u',
    head: { ref: 'b', repo: { full_name: 'acme/app' } },
    base: { ref: 'main', repo: { full_name: 'acme/app' } }
  })
  fakeApi([
    ['/pulls', [pull(1, 'Fix LOGIN page'), pull(2, 'Other')]],
    ['/search/issues', { items: [{ number: 9, title: 'login is slow', html_url: 'w' }] }]
  ])
  const found = await searchSource(repo.dir, 'github', 'login')
  assert.deepEqual(found.items.map((i) => i.ref), ['1', '9'])
  assert.ok(calls.some((c) => c.url.includes(encodeURIComponent('repo:acme/app is:issue is:open login'))))
})

test('a token lookup finds either kind, and a number that is neither finds nothing', async () => {
  repo.git('remote', 'add', 'origin', 'git@github.com:acme/app.git')
  noGh()
  setCredential('github', 'token', 't')
  fakeApi([['/issues/34', { number: 34, title: 'Broken', html_url: 'u' }]])
  assert.equal((await searchSource(repo.dir, 'github', '#34')).items[0]?.kind, 'issue')
  assert.deepEqual(await searchSource(repo.dir, 'github', '#99'), { items: [] })
})

test('a number finds one item of either kind through gh too', async () => {
  repo.git('remote', 'add', 'origin', 'git@github.com:acme/app.git')
  fakeGh({ 'issue view:34': ghIssue })
  assert.equal((await searchSource(repo.dir, 'github', '#34')).items[0]?.kind, 'issue')
  assert.deepEqual(await searchSource(repo.dir, 'github', '#99'), { items: [] })
})

test('a link to another repository is refused by name', async () => {
  repo.git('remote', 'add', 'origin', 'git@github.com:acme/app.git')
  fakeGh({})
  const found = await searchSource(repo.dir, 'github', 'https://github.com/other/thing/pull/1')
  assert.match(found.error ?? '', /other\/thing.*acme\/app/)
})

test('a project without the remote says so', async () => {
  fakeGh({})
  assert.match((await searchSource(repo.dir, 'github')).error ?? '', /no GitHub remote/)
  assert.match((await searchSource(repo.dir, 'bitbucket')).error ?? '', /no Bitbucket remote/)
})

test('Bitbucket asks for its keys, then lists with email and token as Basic auth', async () => {
  repo.git('remote', 'add', 'origin', 'git@bitbucket.org:acme/app.git')
  assert.match((await searchSource(repo.dir, 'bitbucket')).error ?? '', /Bitbucket email and API token in Settings/)
  setCredential('bitbucket', 'email', 'me@acme.io')
  setCredential('bitbucket', 'token', 'bb_secret')
  fakeApi([['/pullrequests', { values: [bbPull] }]])
  const found = await searchSource(repo.dir, 'bitbucket')
  assert.equal(found.error, undefined, 'a tracker that is off (404) costs nothing')
  assert.deepEqual(found.items.map((i) => [i.kind, i.ref, i.head, i.base, i.fork]), [['pr', '5', 'feat/login', 'main', false]])
  assert.equal(calls[0].auth, `Basic ${Buffer.from('me@acme.io:bb_secret').toString('base64')}`)
})

test('a Bitbucket search quotes what was typed', async () => {
  repo.git('remote', 'add', 'origin', 'git@bitbucket.org:acme/app.git')
  setCredential('bitbucket', 'email', 'me@acme.io')
  setCredential('bitbucket', 'token', 't')
  fakeApi([['/pullrequests', { values: [] }]])
  await searchSource(repo.dir, 'bitbucket', 'a "b"')
  assert.ok(calls[0].url.includes(encodeURIComponent('state = "OPEN" AND title ~ "a \\"b\\""')))
})

test('a refused key says where to fix it, and never contains the key', async () => {
  repo.git('remote', 'add', 'origin', 'git@bitbucket.org:acme/app.git')
  setCredential('bitbucket', 'email', 'me@acme.io')
  setCredential('bitbucket', 'token', 'bb_secret')
  fakeApi([['/pullrequests', {}, 401]])
  const { error } = await searchSource(repo.dir, 'bitbucket')
  assert.match(error ?? '', /Bitbucket refused the key.*Settings/)
  assert.ok(!error?.includes('bb_secret'))
})

test('another HTTP failure and an unreachable service are both named', async () => {
  repo.git('remote', 'add', 'origin', 'git@bitbucket.org:acme/app.git')
  setCredential('bitbucket', 'email', 'me@acme.io')
  setCredential('bitbucket', 'token', 't')
  fakeApi([['/pullrequests', {}, 500]])
  assert.equal((await searchSource(repo.dir, 'bitbucket')).error, 'Bitbucket answered HTTP 500.')
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed')
  }) as typeof fetch
  assert.equal((await searchSource(repo.dir, 'bitbucket')).error, 'Could not reach Bitbucket.')
})

test('Jira asks for its keys, lists your open work, and searches across the site', async () => {
  assert.match((await searchSource(repo.dir, 'jira')).error ?? '', /Jira site, email and API token in Settings/)
  setCredential('jira', 'site', 'acme')
  setCredential('jira', 'email', 'me@acme.io')
  setCredential('jira', 'token', 'j_secret')
  fakeApi([['/search/jql', { issues: [{ key: 'SUP-1', fields: { summary: 'Cycle time', reporter: { displayName: 'Ana' } } }] }]])

  const mine = await searchSource(repo.dir, 'jira')
  assert.deepEqual(mine.items.map((i) => [i.ref, i.title, i.url, i.author]), [
    ['SUP-1', 'Cycle time', 'https://acme.atlassian.net/browse/SUP-1', 'Ana']
  ])
  assert.ok(calls[0].url.startsWith('https://acme.atlassian.net/rest/api/3/search/jql?'))
  assert.ok(calls[0].url.includes(encodeURIComponent('assignee = currentUser()')))
  assert.ok(calls[0].url.includes('fields=summary%2Creporter') || calls[0].url.includes('fields=summary,reporter'))

  await searchSource(repo.dir, 'jira', 'cycle "time"')
  assert.ok(calls[1].url.includes(encodeURIComponent('text ~ "cycle \\"time\\"" AND statusCategory != Done')))
})

test('a Jira key opens a worktree on a branch named after it, from the chosen base', async () => {
  repo.git('branch', 'other')
  setCredential('jira', 'site', 'https://acme.atlassian.net/jira/boards/1')
  setCredential('jira', 'email', 'me@acme.io')
  setCredential('jira', 'token', 't')
  fakeApi([['/issue/SUP-1', { key: 'SUP-1', fields: { summary: 'Cycle time' } }]])
  const found = await searchSource(repo.dir, 'jira', 'sup-1')
  assert.equal(found.items[0]?.ref, 'SUP-1')

  const made = await createWorktreeFromSource(repo.dir, 'jira', 'SUP-1', { base: 'other' })
  assert.equal(made.branch, 'SUP-1-Cycle-time')
  const tree = made.worktrees.find((w) => w.branch === made.branch)
  assert.ok(tree)
  assert.equal(readFileSync(join(tree.path, '.gw-base'), 'utf8').trim(), 'other')

  await assert.rejects(createWorktreeFromSource(repo.dir, 'jira', 'SUP-404'), /SUP-404 is not a pull request or issue in Jira/)
})

test('a Jira site can be written three ways', () => {
  assert.equal(jiraOrigin('acme'), 'https://acme.atlassian.net')
  assert.equal(jiraOrigin('acme.atlassian.net'), 'https://acme.atlassian.net')
  assert.equal(jiraOrigin('http://acme.atlassian.net/jira/x'), 'https://acme.atlassian.net')
})


// Stands in for ssh: serves `them/...` from `fork` and anything else from `own`,
// so a remote can read as Bitbucket and still fetch from a directory.
function fakeSsh(own: string, fork: string): void {
  const script = join(scratch, 'ssh')
  writeFileSync(script, `#!/bin/sh\ncase "$*" in *them/*) exec git upload-pack "${fork}" ;; *) exec git upload-pack "${own}" ;; esac\n`)
  chmodSync(script, 0o755)
  process.env.GIT_SSH_COMMAND = script
}

test('a Bitbucket PR opens on its head, with the PR target as its base', async () => {
  repo.git('checkout', '-q', '-b', 'feat/login')
  repo.write('pr.txt', 'pr\n')
  repo.commit('pr work')
  repo.git('checkout', '-q', 'main')
  const bare = bareRemote()
  repo.git('branch', '-D', 'feat/login')
  repo.git('remote', 'add', 'origin', 'git@bitbucket.org:acme/app.git')
  fakeSsh(bare, bare)
  setCredential('bitbucket', 'email', 'me@acme.io')
  setCredential('bitbucket', 'token', 't')
  fakeApi([['/pullrequests/5', bbPull]])
  try {
    const made = await createWorktreeFromSource(repo.dir, 'bitbucket', '5')
    assert.equal(made.branch, 'feat/login')
    const tree = made.worktrees.find((w) => w.branch === 'feat/login')
    assert.ok(tree)
    assert.ok(existsSync(join(tree.path, 'pr.txt')))
    assert.equal(readFileSync(join(tree.path, '.gw-base'), 'utf8').trim(), 'main')
  } finally {
    delete process.env.GIT_SSH_COMMAND
  }
})

test('a Bitbucket fork PR is fetched from the fork, onto its own branch', async () => {
  const bare = bareRemote()
  const fork = join(scratch, 'fork.git')
  spawnSync('git', ['clone', '--bare', '-q', bare, fork], { env: { ...process.env, GIT_CEILING_DIRECTORIES: scratch } })
  repo.write('theirs.txt', 'theirs\n')
  repo.commit('their work')
  repo.git('push', '-q', fork, 'HEAD:refs/heads/patch')
  repo.git('reset', '-q', '--hard', 'HEAD~1')
  repo.git('remote', 'add', 'origin', 'git@bitbucket.org:acme/app.git')
  fakeSsh(bare, fork)
  setCredential('bitbucket', 'email', 'me@acme.io')
  setCredential('bitbucket', 'token', 't')
  fakeApi([
    [
      '/pullrequests/6',
      {
        ...bbPull,
        id: 6,
        source: { branch: { name: 'patch' }, repository: { full_name: 'them/app' } }
      }
    ]
  ])
  try {
    const made = await createWorktreeFromSource(repo.dir, 'bitbucket', '6')
    assert.equal(made.branch, 'pr-6')
    assert.equal(made.item.forkSlug, 'them/app')
    assert.ok(repo.git('log', '--format=%s', 'pr-6').includes('their work'))
  } finally {
    delete process.env.GIT_SSH_COMMAND
  }
})

test('a GitHub PR through gh opens on its exact head, not a slugged copy', async () => {
  const head = ghPull.headRefName
  repo.git('checkout', '-q', '-b', head)
  repo.write('pr.txt', 'pr\n')
  repo.commit('pr work')
  repo.git('checkout', '-q', 'main')
  const bare = bareRemote()
  repo.git('branch', '-D', head)
  repo.git('remote', 'add', 'github', 'git@github.com:acme/app.git')
  fakeSsh(bare, bare)
  fakeGh({ 'pr view:12': ghPull })
  try {
    const made = await createWorktreeFromSource(repo.dir, 'github', '12')
    assert.equal(made.branch, head)
    const tree = made.worktrees.find((w) => w.branch === head)
    assert.ok(tree && existsSync(join(tree.path, 'pr.txt')))
  } finally {
    delete process.env.GIT_SSH_COMMAND
  }
})

test('a same-repo PR checks out its exact head, tracking the remote', async () => {
  const head = ghPull.headRefName
  repo.git('checkout', '-q', '-b', head)
  repo.write('pr.txt', 'pr\n')
  repo.commit('pr work')
  repo.git('checkout', '-q', 'main')
  const bare = bareRemote()
  repo.git('branch', '-D', head)
  repo.git('remote', 'add', 'github', bare)

  await fetchPullRequest(repo.dir, 'github', { id: '12', head, fork: false }, head)

  assert.equal(repo.git('rev-parse', '--abbrev-ref', `${head}@{u}`).trim(), `github/${head}`)
  assert.ok(repo.git('log', '--format=%s', head).includes('pr work'))
})

test('a GitHub fork lands on its own branch from refs/pull, with no upstream', async () => {
  const bare = bareRemote()
  repo.git('remote', 'add', 'github', bare)
  repo.write('fork.txt', 'fork\n')
  repo.commit('fork work')
  repo.git('push', '-q', 'github', 'HEAD:refs/pull/7/head')
  repo.git('reset', '-q', '--hard', 'HEAD~1')

  await fetchPullRequest(repo.dir, 'github', { id: '7', head: 'patch-1', fork: true }, 'pr-7')

  assert.ok(repo.git('log', '--format=%s', 'pr-7').includes('fork work'))
  assert.notEqual(spawnSync('git', ['-C', repo.dir, 'rev-parse', 'pr-7@{u}']).status, 0)
  assert.ok(!repo.git('for-each-ref', 'refs/remotes').includes('pr/7'))
})

test('a Bitbucket fork is fetched from the fork itself', async () => {
  const bare = bareRemote()
  const fork = join(scratch, 'fork.git')
  spawnSync('git', ['clone', '--bare', '-q', bare, fork], { env: { ...process.env, GIT_CEILING_DIRECTORIES: scratch } })
  repo.write('theirs.txt', 'theirs\n')
  repo.commit('their work')
  repo.git('push', '-q', fork, 'HEAD:refs/heads/patch')
  repo.git('reset', '-q', '--hard', 'HEAD~1')
  repo.git('remote', 'add', 'origin', bare)

  await fetchPullRequest(repo.dir, 'origin', { id: '8', head: 'patch', fork: true, forkUrl: fork }, 'pr-8')

  assert.ok(repo.git('log', '--format=%s', 'pr-8').includes('their work'))
})

test('an existing branch is fast-forwarded but never loses its own commits', async () => {
  repo.git('checkout', '-q', '-b', 'feat')
  repo.write('one.txt', '1\n')
  repo.commit('one')
  repo.git('checkout', '-q', 'main')
  const bare = bareRemote()
  repo.git('remote', 'add', 'github', bare)
  repo.git('branch', '-f', 'feat', 'main')
  await fetchPullRequest(repo.dir, 'github', { id: '1', head: 'feat', fork: false }, 'feat')
  assert.ok(repo.git('log', '--format=%s', 'feat').includes('one'), 'behind: fast-forwarded')

  repo.git('checkout', '-q', 'feat')
  repo.write('mine.txt', 'mine\n')
  repo.commit('mine')
  repo.git('checkout', '-q', 'main')
  spawnSync('git', ['-C', bare, 'update-ref', 'refs/heads/feat', 'main'])
  await fetchPullRequest(repo.dir, 'github', { id: '1', head: 'feat', fork: false }, 'feat')
  assert.ok(repo.git('log', '--format=%s', 'feat').includes('mine'), 'diverged: kept')
})

test('an issue forks a new branch from the chosen base, and a second ask reuses it', async () => {
  repo.git('remote', 'add', 'origin', 'git@github.com:acme/app.git')
  repo.git('branch', 'other')
  fakeGh({ 'issue view:34': ghIssue })

  const made = await createWorktreeFromSource(repo.dir, 'github', '34', { base: 'other' })
  assert.equal(made.branch, '34-Broken-the-thing')
  assert.equal(made.existed, false)
  const tree = made.worktrees.find((w) => w.branch === made.branch)
  assert.ok(tree && existsSync(tree.path))
  assert.equal(readFileSync(join(tree.path, '.gw-base'), 'utf8').trim(), 'other')

  const again = await createWorktreeFromSource(repo.dir, 'github', '34')
  assert.equal(again.existed, true)
  assert.equal(again.worktrees.length, made.worktrees.length)
})

test('the tasks panel gets issues only, and Jira only once its keys are saved', async () => {
  repo.git('remote', 'add', 'origin', 'git@github.com:acme/app.git')
  fakeGh({ 'pr list:': [ghPull], 'issue list:': [ghIssue] })
  assert.deepEqual(
    (await listTaskIssues(repo.dir)).map((s) => [s.source, s.items.map((i) => [i.kind, i.ref])]),
    [['github', [['issue', '34']]]]
  )

  setCredential('jira', 'site', 'acme')
  setCredential('jira', 'email', 'me@acme.io')
  setCredential('jira', 'token', 't')
  fakeApi([['/search/jql', { issues: [{ key: 'SUP-1', fields: { summary: 'Cycle time' } }] }]])
  const both = await listTaskIssues(repo.dir)
  assert.deepEqual(both.map((s) => s.source), ['github', 'jira'])
  assert.equal(both[1].items[0].ref, 'SUP-1')
})

test('a source that cannot answer reports in its section', async () => {
  repo.git('remote', 'add', 'origin', 'git@github.com:acme/app.git')
  noGh()
  const [github] = await listTaskIssues(repo.dir)
  assert.match(github.error ?? '', /gh auth login/)
  assert.deepEqual(github.items, [])
})

test('a Bitbucket project lists no Bitbucket section', async () => {
  repo.git('remote', 'add', 'origin', 'git@bitbucket.org:acme/app.git')
  assert.deepEqual(await listTaskIssues(repo.dir), [])
})

test('opened from the tasks panel, a Jira issue writes its description into the premise', async () => {
  setCredential('jira', 'site', 'acme')
  setCredential('jira', 'email', 'me@acme.io')
  setCredential('jira', 'token', 't')
  const description = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Totals ' }, { type: 'text', text: 'per squad.' }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One' }] }] }] }
    ]
  }
  fakeApi([['/issue/SUP-1', { key: 'SUP-1', fields: { summary: 'Cycle time', description } }]])
  const made = await createWorktreeFromSource(repo.dir, 'jira', 'SUP-1', { writePremise: true })
  const tree = made.worktrees.find((w) => w.branch === made.branch)
  assert.ok(tree)
  const premise = readFileSync(join(tree.path, '.floe', 'premise.md'), 'utf8')
  assert.match(premise, /## Description\nTotals per squad\.\nOne/)

  fakeApi([['/issue/SUP-1', { key: 'SUP-1', fields: { summary: 'Retitled since' } }]])
  const again = await createWorktreeFromSource(repo.dir, 'jira', 'SUP-1')
  assert.equal(again.existed, true, 'found by its key, not its title')
  assert.equal(again.branch, made.branch)
})

test('a branch that only shares the number belongs to something else', async () => {
  repo.git('remote', 'add', 'origin', 'git@github.com:acme/app.git')
  repo.git('worktree', 'add', '-q', '-b', '34-local-task-34', join(scratch, 'task-tree'))
  fakeGh({ 'issue view:34': ghIssue })
  const made = await createWorktreeFromSource(repo.dir, 'github', '34')
  assert.equal(made.existed, false)
  assert.equal(made.branch, '34-Broken-the-thing')
})

test('a description with no document reads as empty', () => {
  assert.equal(adfText(null), '')
  assert.equal(adfText({ type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }] }), 'a\nb')
})

test('a token lookup keeps the description, and a null one is no description', async () => {
  repo.git('remote', 'add', 'origin', 'git@github.com:acme/app.git')
  noGh()
  setCredential('github', 'token', 't')
  fakeApi([['/issues/34', { number: 34, title: 'Broken', html_url: 'u', body: null }]])
  assert.equal((await searchSource(repo.dir, 'github', '#34')).items[0]?.body, undefined)
  fakeApi([['/issues/35', { number: 35, title: 'Broken', html_url: 'u', body: 'Why' }]])
  assert.equal((await searchSource(repo.dir, 'github', '#35')).items[0]?.body, 'Why')
})

test('asking for a number that is neither kind says so', async () => {
  repo.git('remote', 'add', 'origin', 'git@github.com:acme/app.git')
  fakeGh({})
  await assert.rejects(createWorktreeFromSource(repo.dir, 'github', '99'), /#99 is not a pull request or issue/)
})

test('the status says what is saved and never carries a key', async () => {
  noGh()
  setCredential('github', 'token', 'ghp_secret')
  setCredential('jira', 'site', 'acme')
  setCredential('jira', 'email', 'me@acme.io')
  setCredential('jira', 'token', 'j_secret')
  const status = await integrationStatus()
  assert.deepEqual(status, {
    github: { gh: false, token: true },
    bitbucket: { email: '', token: false },
    jira: { site: 'https://acme.atlassian.net', email: 'me@acme.io', token: true }
  })
  assert.ok(!JSON.stringify(status).includes('secret'))
})

test('gh counts as in use only when it says it is logged in', async () => {
  fakeGh({ 'auth status:': {} })
  assert.equal((await integrationStatus()).github.gh, true)
  fakeGh({}, { 'auth status:': 'You are not logged in' })
  assert.equal((await integrationStatus()).github.gh, false)
})

test('the credentials file is private, an empty value removes a key, and a field must exist', () => {
  setCredential('bitbucket', 'token', 'bb_secret')
  assert.equal(statSync(join(data, 'credentials.json')).mode & 0o777, 0o600)
  assert.equal(readCredentials().bitbucket?.token, 'bb_secret')
  setCredential('bitbucket', 'token', '')
  assert.equal(readCredentials().bitbucket?.token, undefined)
  assert.throws(() => setCredential('github', 'email', 'x'), /github has no setting named email/)
})

test('with a keychain the file holds no readable key, and one it cannot open reads as empty', () => {
  const cipher = {
    encrypt: (text: string) => Buffer.from(text.split('').reverse().join('')),
    decrypt: (data: Buffer) => data.toString().split('').reverse().join('')
  }
  const sealed = sealCredentials({ jira: { token: 'j_secret' } }, cipher)
  assert.ok(!sealed.includes('j_secret'))
  assert.equal(openCredentials(sealed, cipher).jira?.token, 'j_secret')
  assert.deepEqual(openCredentials(sealed, null), {})
  assert.deepEqual(openCredentials('not json', cipher), {})
  const broken = { ...cipher, decrypt: () => { throw new Error('keychain says no') } }
  assert.deepEqual(openCredentials(sealed, broken), {})
})
