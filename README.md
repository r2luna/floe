# Floe

A keyboard-first desktop workspace that orchestrates **Claude Code** across parallel **git worktrees** — a colony of agents.

Inspired by Conductor (parallel agents + worktrees), Solo/SoloTerm (services + embedded terminal), and Polyscope (select code → talk to the agent). Built for one developer's workflow (Laravel + Herd + macOS), reusing the conventions of the `gw` worktree script.

## Stack
Electron + React + TypeScript + Vite (`electron-vite`), with `node-pty` + `xterm.js` for terminals.

## Develop
```bash
pnpm install
pnpm dev        # launch the app with HMR
pnpm typecheck  # tsc on main + renderer
pnpm build      # production build into out/
```

## Layout

Projects (grouped into project **groups**) are the top level; **worktrees** are Chrome-style tabs within a project. The window is a 3-pane workspace:

- **Left sidebar** — the worktree browser. Each worktree expands into its **sessions** (Claude agents), **terminals**, and **commands**, with live status: running agents, pending questions, dirty tree.
- **Center** — whatever the active item is: an agent transcript (streaming chat with thinking, tool use, permission prompts, and images opening in a zoom/pan lightbox), an interactive terminal, the nvim editor, a rendered file reader (read-only projects), or a command's output.
- **Right panel** — toggles between **Files** (tree + quick-open), **Review** (changed-files diff with inline comments), **Plans** (markdown saved under `.floe/plans`), **Tasks** (the tracker's issues), and **PRs** (the repo's open pull requests — review, comment, approve & merge).
- **Status bar** — current mode, model, quick toggles, and a compact **usage** readout (session/weekly/monthly limits + memory) that stays calm and only colors up as a limit approaches.

Everything is reachable from the keyboard. The command palette (`⌘⇧P`) lists every command with its live binding; the shortcuts cheatsheet (`⌘?`) is a searchable reference.

## Features

- **Worktrees** — create from a local branch or a fresh name (`⌘N`), with `gw`-style provisioning (`.worktrees/<branch>`, `.gw-base`, `.gw-note`, dependency install, Laravel/Herd/DB setup). Guided **merge** (fast-forward base to branch) and **remove** (confirm force on a dirty tree, optionally delete the branch) flows.
- **Claude sessions** — spawn `claude` in a worktree (`⌘T`), streaming over stream-json with interactive permission prompts. Cycle **mode** (Ask → Accept → Plan → Dangerous, `⇧⇥`), **model** (Fable → Opus → Sonnet → Haiku, `⌘⇧M`), and reasoning **effort** (Low → Medium → High → Xhigh → Max, `⌘⇧E`) — switching model/effort mid-session resumes seamlessly. Resume past sessions from disk (`⌘K S`). A message queue paces prompts while a session is busy.
- **Terminals** — real shells per worktree via `node-pty` + `xterm.js`, with scrollback (`⌘Y` to toggle). **Split into panes** (tmux-style) for side-by-side shells: `⌃S =` splits vertically, `⌃S -` horizontally; move focus between panes with `⌃J`/`⌃K`/`⌃L`/`⌃;` (left/down/up/right); `⌘W` closes the focused pane. Each pane is its own PTY and survives switching views (scrollback replays on return).
- **Commands** — per-worktree scripts (start/stop/restart) plus a dev-server launcher that auto-detects Node (npm/pnpm/yarn/bun) and Laravel (composer dev / artisan serve), streaming logs live.
- **Editor** — edit files in the worktree through an embedded nvim (`⌘L`), quick-open by name (`⌘P`).
- **Read-only mode** — flag a project read-only (`⌘K → Toggle read-only mode`) to browse it without an editor: opening a file (from the tree or `⌘P`) lands in a rendered **reader** instead of nvim — markdown as prose with **mermaid** diagrams, images inline, anything else as plain read-only text. Built for reading vaults like an Obsidian workspace; `e` still drops to nvim, `q`/`Esc` returns to the tree.
- **Review** — diff a worktree against its base (`⌘K G`): unified diffs with syntax highlighting, GitHub-style "viewed" markers, and Polyscope-style inline comments you submit to the active session. Ask Claude to commit the session's files (`⌘K C`) or everything uncommitted (`⌘K ⇧C`).
- **Pull requests** — the repo's open PRs in the right panel (`⌘K R`), via the `gh` CLI. Browse the list (status/draft/review chips), drill into a PR to review **each file's diff like Review**, leave **inline comments straight on the PR** (`c`, `⌘↵` to post), **ask Claude about the changes** (`⌘⇧↵`, same hand-off as Review), and **approve** (`a`) + **merge** (`m`, squash/merge/rebase) — all keyboard-driven. `gh`'s reasons (blocked merges, self-approval, …) surface inline.
- **Plans** — a gallery of Claude's plan-mode output saved under `.floe/plans` (`⌘K P`). Hand a plan straight to the active session to **implement it in the current worktree** (`i` in the gallery) — no new worktree, the plan markdown becomes the prompt.
- **pipeline** — a one-shot **workflow runner** that chains a sequence of Claude skills (specify → clarify → plan → tasks → commit → implement) so a feature goes from a one-line seed to an implementation without manual prompt hand-offs. Launch it from the palette: a dialog pre-fills from the current branch and accepts a **Jira code** (e.g. `DOS-123`) or a freeform **description**. The run shows as a live **rail under the session** in the sidebar (per-step status: pending / running / waiting / done / failed), and is **cancellable** and **resumable** from the palette. State **persists across restarts** — an in-flight pipeline reattaches paused so you can resume it, and Floe never re-fires prompts on launch. Only offered when the worktree actually has the required `ds-*` skills (**skill gating**).
- **Claude info** — surface `/usage`, `/mcp`, `/skills`, `/plugins` and handle MCP auth flows from the palette; the top-bar usage chip opens the full `/usage` panel.
- **Projects** — rename a project's in-app label, toggle read-only mode, or remove it from its group straight from the palette — all metadata-only, the repo on disk is never touched.
- **Remappable keys** — defaults live in `src/renderer/src/keybindings.ts`; user overrides in `~/.config/floe/keybindings` layer on top (any command rebindable, `null` to unbind). Edit them in nvim straight from the palette.

## Keybindings

`⌘K` is a chord leader (VS Code style): press `⌘K`, release, then the second key. `⌃S` is a second chord leader, scoped to the terminal, for splitting panes (see **Terminal panes** below).

### Navigation
| Keys | Action |
|------|--------|
| `⌘/` | Switch project |
| `⌘O` | Switch group |
| `⌘⇧P` | Command palette |
| `⌘P` | Go to file / quick-open |
| `⌘J` | Jump to session, terminal, or command |
| `⌘1`–`⌘8` | Jump to worktree N · `⌘9` last |
| `⌃⇥` / `⌃⇧⇥` | Next / previous worktree |
| `⌘⇧]` / `⌘⇧[` | Next / previous worktree |
| `⌃I` / `⌃O` | Previous / next item (agent, terminal, command) |
| `⌘?` | Keyboard shortcuts cheatsheet |

### Panels & view
| Keys | Action |
|------|--------|
| `⌘E` | Toggle left sidebar |
| `⌘B` | Toggle right panel |
| `⌘Y` | Toggle terminal |
| `⌘L` | Toggle editor |
| `⌘K F` | Show files |
| `⌘K G` | Review changed files |
| `⌘K P` | Show plans |
| `⌘K T` | Show tasks |
| `⌘K R` | Show pull requests |
| `i` | Implement the open plan in this worktree (in the plans gallery) |
| `⌃⇧J` / `⌃⇧K` | Scroll chat down / up |
| `Space` | Collapse / expand selected worktree |
| `⌘H` | Hide window |

### Terminal panes
| Keys | Action |
|------|--------|
| `⌃S =` | Split focused pane vertically (side by side) |
| `⌃S -` | Split focused pane horizontally (stacked) |
| `⌃J` / `⌃K` / `⌃L` / `⌃;` | Focus pane left / down / up / right |
| `⌘W` | Close focused pane (or the terminal on the last) |

Pane-focus keys only act inside a split terminal; with a single pane they pass through to the shell (`⌃L` clears, etc.).

### Worktrees & sessions
| Keys | Action |
|------|--------|
| `⌘N` | New worktree |
| `⌘K M` | Merge worktree into base |
| `⌘T` | New session |
| `⌘W` | Close session — or the focused terminal pane when a terminal is open |
| `⌘I` | Focus chat input |
| `⌘K S` | Resume session |
| `⌘K A` | Jump to next session waiting for an answer |

### Agent control
| Keys | Action |
|------|--------|
| `⇧⇥` | Cycle mode (Ask → Accept → Plan → Dangerous) |
| `⌘⇧M` | Cycle model (Fable → Opus → Sonnet → Haiku) |
| `⌘⇧E` | Cycle effort (Low → Medium → High → Xhigh → Max) |
| `⌘K C` | Commit this session's files (via Claude) |
| `⌘K ⇧C` | Commit all uncommitted changes (via Claude) |

### Commands
| Keys | Action |
|------|--------|
| `⇧S` | Start command |
| `⇧T` | Stop command |

Many more actions live in the command palette without default bindings — all remappable: **pipeline** start/cancel/resume, **PR** approve / merge / refresh, **rename / remove project**, **toggle read-only mode**, new/rename/close terminals, rename sessions, group management, collapse/expand all, mode/model direct-set, refresh review, and more.

## Status

Phases 0–2 are complete; 3–5 are partially in.

- **Phase 0 — shell:** ✅ Electron/React/TS, 3-pane layout, keybinding layer + command palette.
- **Phase 1 — worktrees:** ✅ Node engine honoring `gw` conventions, Laravel/Herd/DB provisioning, guided merge/FF and removal.
- **Phase 2 — agent terminal:** ✅ `node-pty` + `xterm.js` running `claude` in a worktree, stream-json control, mode/model/effort selection.
- **Phase 3 — review:** ✅ mostly — unified diffs, inline comments, "viewed" markers, commit-via-Claude.
- **Phase 4 — Jira + queue:** ◐ in-memory message queue done; Jira 3LO OAuth and pull issues → worktree not yet.
- **Phase 5 — services:** ✅ dev-server detection + launch (Node/Laravel), live logs, URL detection, start/stop/restart.
- **Phase 6 — GitHub:** ◐ via the `gh` CLI — issues listed in **Tasks** and a worktree opens straight from one; **pull requests** now have a full review panel (list → file diff → inline comment → approve/merge). The PR panel also speaks **Bitbucket Cloud** (REST API 2.0) for `bitbucket.org` remotes — connect an Atlassian API token via `⌘K → Connect Bitbucket`. When it can identify you, the list becomes a review queue: **needs your review** → **your pull requests** → **other** (on Bitbucket this needs the token's `read:account` scope; otherwise it stays a flat list).
