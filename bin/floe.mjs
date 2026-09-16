#!/usr/bin/env node
// The `floe` command: point it at a directory and that directory becomes a Floe
// project, on screen, in the app.
//
// Two ways in, tried in this order:
//   1. a Floe is already running and answers on its loopback control port —
//      POST /cli/open registers the repo and brings its window forward;
//   2. nothing answers — launch the app with `--open <path>` and let it do the
//      same work at boot (main/cli.ts owns both paths, so they agree).
//
// Zero dependencies on purpose. The shim in ~/.local/bin (installCli) runs this
// under the app's own Electron binary with ELECTRON_RUN_AS_NODE=1, so the
// command works on a machine with no node on PATH — and it passes the binary
// down as FLOE_APP_EXE, which is how step 2 knows what to start.

import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

// Same preferred port main/mcpServer.ts binds. A second Floe instance lands on
// an ephemeral one and this command won't find it — the first instance is the
// one holding the fixed port, and it is the one the user means.
const PORT = Number(process.env.FLOE_MCP_PORT || 41673)

const USAGE = `floe <path> — register a git repository with Floe and open it

  floe .              the directory you are in
  floe ~/code/app     any repository
  floe --version      the app version behind this command
`

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

/** Ask a running Floe. `null` means nothing was listening — the caller launches. */
async function tell(path) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/cli/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
      signal: AbortSignal.timeout(5000)
    })
    // A Floe too old to have this route answers 404, which reads nothing like
    // "update the app" unless it is said.
    if (res.status === 404)
      return { error: `The Floe on port ${PORT} is older than this command. Update it, or quit it and run this again.` }
    if (!res.ok) return { error: `Something other than Floe answered on port ${PORT} (${res.status}).` }
    return await res.json()
  } catch {
    return null
  }
}

function launch(path) {
  const exe = process.env.FLOE_APP_EXE
  if (!exe || !existsSync(exe)) {
    fail(
      `Floe is not running, and I don't know where the app is.\n` +
        `Open Floe and run this again, or set FLOE_APP_EXE to the app binary.`
    )
  }
  const env = { ...process.env }
  // We want the GUI, not another headless node: the shim set this for us.
  delete env.ELECTRON_RUN_AS_NODE
  spawn(exe, ['--open', path], { detached: true, stdio: 'ignore', env }).unref()
  process.stdout.write(`Starting Floe on ${path}…\n`)
}

const args = process.argv.slice(2)
if (args.includes('-h') || args.includes('--help')) {
  process.stdout.write(USAGE)
  process.exit(0)
}
if (args.includes('-v') || args.includes('--version')) {
  process.stdout.write(`${process.env.FLOE_APP_VERSION || 'unknown'}\n`)
  process.exit(0)
}

const target = args.find((a) => !a.startsWith('-'))
if (!target) {
  process.stderr.write(USAGE)
  process.exit(2)
}

const path = resolve(process.cwd(), target)
if (!existsSync(path) || !statSync(path).isDirectory()) fail(`Not a directory: ${path}`)

const answer = await tell(path)
if (!answer) launch(path)
else if (answer.error) fail(answer.error)
else process.stdout.write(`${answer.message}\n`)
