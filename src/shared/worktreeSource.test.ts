import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isIssueBranch,
  parseSourceRef,
  pickRemote,
  sourceBranch,
  sourceForInput,
  sourceLabel,
  sourcePremise,
  sourceWorktreePremise,
  type SourceItem
} from './worktreeSource.ts'

test('finds the GitHub remote when origin is somewhere else', () => {
  const repo = pickRemote(
    [
      'github\tgit@github.com:r2luna/floe.git (fetch)',
      'github\tgit@github.com:r2luna/floe.git (push)',
      'origin\tssh://git@git.pinguim.io/r2luna/floe.git (fetch)'
    ].join('\n'),
    'github.com'
  )
  assert.deepEqual(repo, { remote: 'github', slug: 'r2luna/floe' })
})

test('prefers upstream, where a fork finds its PRs', () => {
  const repo = pickRemote(
    'origin\thttps://github.com/me/floe.git (fetch)\nupstream\thttps://github.com/r2luna/floe.git (fetch)',
    'github.com'
  )
  assert.deepEqual(repo, { remote: 'upstream', slug: 'r2luna/floe' })
})

test('reads every URL shape git accepts', () => {
  for (const url of [
    'git@github.com:acme/app.git',
    'ssh://git@github.com/acme/app.git',
    'ssh://git@ssh.github.com:443/acme/app.git',
    'https://github.com/acme/app',
    'https://token@github.com/acme/app.git'
  ]) {
    assert.equal(pickRemote(`origin\t${url} (fetch)`, 'github.com')?.slug, 'acme/app', url)
  }
  assert.equal(pickRemote('origin\tgit@bitbucket.org:acme/app.git (fetch)', 'bitbucket.org')?.slug, 'acme/app')
  assert.equal(pickRemote('origin\thttps://me@bitbucket.org/acme/app.git (fetch)', 'bitbucket.org')?.slug, 'acme/app')
})

test('a remote on another host is not this one', () => {
  assert.equal(pickRemote('origin\thttps://gitlab.com/acme/app.git (fetch)', 'github.com'), null)
  assert.equal(pickRemote('origin\thttps://notgithub.com/acme/app.git (fetch)', 'github.com'), null)
  assert.equal(pickRemote('origin\tgit@github.com:acme/app.git (fetch)', 'bitbucket.org'), null)
})

test('a number or a URL names one item, anything else is a search', () => {
  assert.deepEqual(parseSourceRef('github', '#7753'), { ref: '7753' })
  assert.deepEqual(parseSourceRef('github', ' 7753 '), { ref: '7753' })
  assert.deepEqual(parseSourceRef('github', 'https://github.com/acme/app/pull/12'), { ref: '12', slug: 'acme/app' })
  assert.deepEqual(parseSourceRef('github', 'https://github.com/acme/app/issues/3#issuecomment-1'), {
    ref: '3',
    slug: 'acme/app'
  })
  assert.deepEqual(parseSourceRef('bitbucket', 'https://bitbucket.org/acme/app/pull-requests/12/fix/diff'), {
    ref: '12',
    slug: 'acme/app'
  })
  assert.equal(parseSourceRef('github', 'cycle time'), null)
  assert.equal(parseSourceRef('github', '#'), null)
})

test('a Jira key or link names one issue, in the case Jira uses', () => {
  assert.deepEqual(parseSourceRef('jira', 'sup2-1030'), { ref: 'SUP2-1030' })
  assert.deepEqual(parseSourceRef('jira', 'https://acme.atlassian.net/browse/SUP2-1030'), { ref: 'SUP2-1030' })
  assert.deepEqual(parseSourceRef('jira', 'https://acme.atlassian.net/jira/boards/1?selectedIssue=AB-9'), { ref: 'AB-9' })
  assert.equal(parseSourceRef('jira', '1030'), null)
  assert.equal(parseSourceRef('jira', 'cycle time'), null)
})

test('text that can only mean a PR or issue picks its tab, if that tab exists', () => {
  const all = ['github', 'bitbucket', 'jira'] as const
  assert.equal(sourceForInput('#', [...all]), 'github')
  assert.equal(sourceForInput('#', ['bitbucket', 'jira']), 'bitbucket')
  assert.equal(sourceForInput('#', ['jira']), undefined)
  assert.equal(sourceForInput('https://github.com/a/b/pull/1', ['jira']), undefined)
  assert.equal(sourceForInput('https://bitbucket.org/a/b/issues/1', [...all]), 'bitbucket')
  assert.equal(sourceForInput('https://acme.atlassian.net/browse/A-1', [...all]), 'jira')
  assert.equal(sourceForInput('PROJ-123', [...all]), undefined)
})

const pr: SourceItem = {
  source: 'github',
  kind: 'pr',
  ref: '12',
  title: 'Fix it',
  url: 'https://github.com/acme/app/pull/12',
  author: 'ana',
  head: 'dependabot/npm_and_yarn/vite-5.1.0',
  base: 'main'
}
const issue: SourceItem = {
  source: 'github',
  kind: 'issue',
  ref: '7753',
  title: 'SUP2-1030: Issue cycle time / include totals',
  url: 'https://github.com/acme/app/issues/7753',
  author: 'ana'
}
const jira: SourceItem = {
  source: 'jira',
  kind: 'issue',
  ref: 'SUP2-1030',
  title: 'Issue cycle time',
  url: 'https://acme.atlassian.net/browse/SUP2-1030',
  author: 'ana'
}

test('a PR keeps its head branch exactly, a fork gets its own name', () => {
  assert.equal(sourceBranch(pr), 'dependabot/npm_and_yarn/vite-5.1.0')
  assert.equal(sourceBranch({ ...pr, fork: true }), 'pr-12')
})

test('an issue branch is its reference and title, flat and valid', () => {
  assert.equal(sourceBranch(issue), '7753-SUP2-1030-Issue-cycle-time-include')
  assert.equal(sourceBranch(issue, { lowercase: true }), '7753-sup2-1030-issue-cycle-time-include')
  assert.equal(sourceBranch(jira), 'SUP2-1030-Issue-cycle-time')
})

test('a long title gives way and the reference never does', () => {
  const branch = sourceBranch({ ...jira, title: 'Include the totals for every squad on the cycle time page' })
  assert.equal(branch, 'SUP2-1030-Include-the-totals-for-every')
  assert.ok(branch.length <= 40)
  // One long word has no boundary to cut at, so it is cut where the limit falls.
  assert.equal(sourceBranch({ ...issue, ref: '1', title: 'a'.repeat(99) }), `1-${'a'.repeat(38)}`)
})

test('a branch belongs to its issue whatever the title has become, and only to that one', () => {
  assert.ok(isIssueBranch('SUP2-1030-old-title', jira))
  assert.ok(isIssueBranch('sup2-1030-old-title', jira))
  assert.ok(isIssueBranch('7753', issue))
  assert.ok(!isIssueBranch('77530-other', issue))
  assert.ok(!isIssueBranch('SUP2-10300-other', jira))
})

test('the worktree premise carries the description, clipped', () => {
  const premise = sourceWorktreePremise({ ...jira, body: 'Totals per squad.' })
  assert.match(premise, /Deliver jira issue SUP2-1030 from Jira: "Issue cycle time"\./)
  assert.ok(premise.includes('https://acme.atlassian.net/browse/SUP2-1030'))
  assert.match(premise, /## Description\nTotals per squad\./)
  assert.ok(!sourceWorktreePremise(jira).includes('## Description'))
  assert.ok(sourceWorktreePremise({ ...jira, body: 'a'.repeat(5000) }).endsWith('…'))
})

test('the label and the premise name the item the way its source does', () => {
  assert.equal(sourceLabel(pr), '#12')
  assert.equal(sourceLabel(jira), 'SUP2-1030')
  assert.equal(sourcePremise(pr), 'Pull request #12: Fix it (https://github.com/acme/app/pull/12)')
  assert.match(sourcePremise(issue), /^Issue #7753: /)
  assert.match(sourcePremise(jira), /^Jira issue SUP2-1030: /)
})
