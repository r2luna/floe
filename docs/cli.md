# The `floe` command

```bash
floe .              # this directory becomes a Floe project, on screen
floe ~/code/app     # any repository
floe --help
```

One job: point it at a directory and that directory is a Floe project. The path
is resolved to its repository root, a directory Floe already has is not an error
(it just comes forward), and anything that is not a git repository is refused.

## Installing it

⌘K → **Install the floe command**. It writes `~/.local/bin/floe` — no sudo, same
path on macOS and Linux. If the message says to add `~/.local/bin` to your PATH,
do that and open a new shell.

The shim is a three-line `/bin/sh` script:

```sh
FLOE_APP_EXE="<the app binary>" ELECTRON_RUN_AS_NODE=1 exec "<the app binary>" "<the script>" "$@"
```

The app binary IS the node that runs the command, so the machine needs no node
of its own. `bin/floe.mjs` ships as an electron-builder `extraResources` entry
(nothing can exec a path inside the asar) and the install copies it under the
data dir, because a Linux AppImage mounts its resources at a fresh `/tmp` path
on every launch. Boot re-runs the copy (`refreshCli`), so an update reaches a
command that was installed months ago — and only for a shim Floe itself wrote,
never someone else's `floe` on PATH.

## How it reaches the app

Two routes, and both end in `main/cli.ts`'s `openProject`, so they cannot drift:

| state | route |
| --- | --- |
| Floe is running | `POST 127.0.0.1:41673/cli/open {path}` — the MCP control server's own port (`main/mcpServer.ts`), behind the same loopback + CSRF guard. Answers with the line the command prints. |
| Floe is not running | the command launches the app with `--open <path>`; main reads it off the argv and does the work once the renderer has loaded. |

Nothing here is MCP: the command is a dependency-free script and one JSON POST
is the whole conversation. Registering plus putting the project on screen is
`showProject` — a `select_project` push to the renderer, plus the window focus a
request from a terminal has to ask for explicitly on macOS.

A second Floe instance binds an ephemeral port, so the command always talks to
the instance holding 41673. Set `FLOE_MCP_PORT` to aim it somewhere else.

## For agents

`open_project` is the same action as a tool — register if needed, then select
and focus. `add_project` still only files the repo without moving the user's
screen. The install itself is the `cli.install` registry command, so
`run_command` reaches it like any other.
