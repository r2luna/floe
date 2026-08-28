import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// sandbox.ts has no electron imports, so import it directly (no loader hook).
const { sandboxAvailable, sandboxedSpawn } = await import('./sandbox.ts')

// The whole point of the module: an install running in the sandbox cannot read
// the secrets or sibling projects it would need to do supply-chain damage, yet
// can still read/write its own worktree. Only runs where bwrap can enforce it.
test('sandbox hides ~/.ssh and sibling projects but exposes the worktree', { skip: !sandboxAvailable() }, () => {
  const realHome = process.env.HOME
  const home = mkdtempSync(join(tmpdir(), 'rk-sandbox-home-'))
  try {
    // A fake $HOME with a secret and a sibling project next to the worktree.
    mkdirSync(join(home, '.ssh'), { recursive: true })
    writeFileSync(join(home, '.ssh', 'id_fake'), 'SECRET-KEY-MATERIAL')
    mkdirSync(join(home, 'code', 'other-project'), { recursive: true })
    writeFileSync(join(home, 'code', 'other-project', 'secret.txt'), 'SIBLING-SECRET')
    const worktree = join(home, 'code', 'wt')
    mkdirSync(worktree, { recursive: true })
    writeFileSync(join(worktree, 'package.json'), '{"name":"wt"}')

    // sandboxedSpawn reads process.env.HOME — point it at the fake home.
    process.env.HOME = home
    const sb = sandboxedSpawn(worktree)
    const sh = (script: string): { status: number | null; stdout: string } => {
      const r = spawnSync(sb.cmd, [...sb.args, '/bin/sh', '-c', script], { env: sb.env, encoding: 'utf8' })
      return { status: r.status, stdout: String(r.stdout) }
    }

    // The ssh key is invisible (tmpfs over $HOME), never in the output.
    assert.doesNotMatch(sh('cat "$HOME/.ssh/id_fake" 2>&1; true').stdout, /SECRET-KEY-MATERIAL/)
    // The sibling project is gone too.
    assert.doesNotMatch(sh('cat "$HOME/code/other-project/secret.txt" 2>&1; true').stdout, /SIBLING-SECRET/)
    // Positive control: the worktree is bound in, readable, and the shell works.
    const ok = sh(`cat ${worktree}/package.json && echo READY`)
    assert.equal(ok.status, 0)
    assert.match(ok.stdout, /"name":"wt"[\s\S]*READY/)
    // Positive control: the worktree is writable (installs must write node_modules).
    assert.equal(sh(`touch ${worktree}/written && echo OK`).status, 0)
  } finally {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    rmSync(home, { recursive: true, force: true })
  }
})

// The environment handed to the sandbox is an allowlist: the agent socket and any
// token are dropped, so even a forwarded ssh-agent can't be abused inside. This
// check runs everywhere (it doesn't need bwrap) — it's pure env construction.
test('sandbox env drops SSH_AUTH_SOCK and *_TOKEN, keeps PATH/HOME', () => {
  const saved = { ...process.env }
  try {
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock'
    process.env.GH_TOKEN = 'ghp_secret'
    process.env.AWS_SECRET_ACCESS_KEY = 'aws_secret'
    process.env.npm_config_registry = 'https://registry.npmjs.org/'
    const { env } = sandboxedSpawn('/tmp/wt')
    assert.equal(env.SSH_AUTH_SOCK, undefined)
    assert.equal(env.GH_TOKEN, undefined)
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined)
    assert.ok(env.PATH, 'PATH is preserved so the package manager resolves')
    assert.equal(env.npm_config_registry, 'https://registry.npmjs.org/')
    assert.equal(env.FORCE_COLOR, '0')
  } finally {
    for (const k of ['SSH_AUTH_SOCK', 'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'npm_config_registry']) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
})
