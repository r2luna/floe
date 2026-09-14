# Floe

**Run a colony of coding agents in parallel, one git worktree each, without touching the mouse.**

[![CI](https://github.com/r2luna/floe/actions/workflows/ci.yml/badge.svg)](https://github.com/r2luna/floe/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/r2luna/floe)](https://github.com/r2luna/floe/releases/latest)
[![License: MIT + Commons Clause](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue)](LICENSE)

One agent at a time is a bottleneck. Five agents in one checkout step on each other's files.
Floe gives every task its own worktree and its own session, puts them all on one screen, and lets
you review, steer and merge each one from the keyboard.

Claude Code, Codex, Gemini, OpenCode, LM Studio and Ollama are all first-class. Pick the harness
per session, or ask a second one for a side opinion while the first keeps working.

<!-- screenshot: docs/screenshot.png -->

## Highlights

- **Worktrees as the unit of work.** `⌘N` cuts a branch into its own worktree and provisions it:
  `.env` copied and rewritten per branch, dependencies installed, a database of its own.
- **Sessions per worktree.** Start as many agent sessions on a branch as you need, jump between
  them with `⌃O` / `⌃I`, and see which ones are waiting on you.
- **Colony board.** A kanban where every card is a task with its own worktree and agent. The
  board's own session, the nanny, releases tasks, merges finished ones and logs every move.
- **Queries.** Type `@codex` mid-turn and a second agent answers in a side panel. Merge its
  conversation into the chat, let the chat peek at it, or discard it.
- **Review like a human.** A changes list and diffs with prose view for Markdown. Select lines
  with `v`, press `c`, and the range lands in the composer as context for the agent.
- **Guided merge and remove.** `⌘K M` merges a branch as a checklist you watch, with conflicts
  handed to an agent. `⌘K X` removes a worktree and asks before anything is lost.
- **Everything else in the same window.** Project commands with live logs, a real terminal, an
  embedded browser with devtools, plans, Excalidraw drawings and reusable skills.
- **Agents can drive Floe.** A built-in MCP server lets any harness open sessions, run commands,
  read diffs and merge worktrees. Everything you can do, an agent can do.
- **Plugins.** Extend Floe with runtime plugins loaded from `~/.config/floe/plugins`.

## Install

Download the latest build from [Releases](https://github.com/r2luna/floe/releases/latest).

| Platform | File |
| --- | --- |
| macOS (Apple Silicon) | `Floe-<version>-arm64.dmg` |
| Linux (x64) | `Floe-<version>.AppImage` |

**macOS builds are unsigned.** The first time, right-click Floe in Applications and choose Open,
or run:

```bash
xattr -dr com.apple.quarantine /Applications/Floe.app
```

**Updates.** The Linux AppImage updates itself. On macOS Floe tells you when a new version is out
and opens its release page.

### Requirements

- `git`
- At least one agent CLI installed and signed in: `claude`, `codex`, `gemini` or `opencode`, or a
  local model server (LM Studio, Ollama).

## Keyboard first

Every action has a key, and every key is listed in the app. Press **`?`** for the full cheat
sheet, or `⌘⇧P` for every command.

| Key | Does |
| --- | --- |
| `?` | Show every key binding |
| `⌘⇧P` | Command palette |
| `⌘P` | Find a chat or a file |
| `⌘N` / `⌘T` | New worktree / new session |
| `⌘1`–`⌘9` | Jump to a worktree |
| `⌃H` / `⌃L` | Move between panels |
| `j` / `k` | Move the cursor, in any list or file |
| `i` / `Esc` | Enter / leave the composer |
| `⌘K G` / `⌘K F` | Changes / files |
| `⌘K M` | Guided merge |

All bindings live in `~/.config/floe/keybindings.toml`, generated with every default and its
explanation. Edit a line to rebind, delete it to unbind.

## Build from source

```bash
pnpm install
pnpm dev          # run the app with hot reload
pnpm gate         # lint, typecheck, tests and the CRAP limit
pnpm build:mac    # or build:linux, installers in dist/
```

`pnpm hooks:install` runs the gate before every commit. See [AGENTS.md](AGENTS.md) for the
project's principles and layout.

## Releases

Pushing a `vX.Y.Z` tag that matches `package.json` runs the release workflow: the gate, then macOS
and Linux builds published to GitHub Releases, which is where the in-app updater looks.

## License

[MIT + Commons Clause](LICENSE). Use, modify and fork Floe freely, at work too. You may not sell
Floe, or a product or service whose value comes mainly from it.
