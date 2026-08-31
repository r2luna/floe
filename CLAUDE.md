# Floe

An Electron app for managing git worktrees and Claude Code sessions across projects.
Desktop only — the v1 headless server was removed and gets rebuilt from scratch for v2.
The in-app MCP control server is back (`src/main/mcpServer.ts`): agents drive Floe over
`/mcp/<token>` — see [docs/mcp.md](docs/mcp.md).

## Core principle — keyboard first

**The base principle of this app is keyboard-first: the user must never have to reach for the mouse.**

Apply this to every feature and change:

- Every action reachable by clicking must also be reachable by a keyboard shortcut or the command palette (⌘K).
- After any panel/overlay/modal closes, focus must return to a sensible place — usually the message composer — so typing can continue immediately. Never leave focus stranded on a dismissed element.
- When a panel opens (e.g. the terminal), move focus into it so it's usable without a click.
- New interactive UI must be operable end-to-end from the keyboard before it's considered done. If you add a button, add (or reuse) a binding for it.
- Prefer flows that don't require pointer precision (no hover-only affordances, no drag-only interactions without a keyboard equivalent).

When in doubt, ask: "could the user do this with the mouse unplugged?" If not, it's not finished.

## Second principle — agent first

Everything the user can do, an agent must be able to do over the MCP server. When you add a
user-facing command or action, ship its MCP tooling in the same change:

- A renderer/palette command: register it in `renderer/src/commands.ts`'s registry + `src/shared/commandIds.ts` (lockstep enforced by `registry.test.ts`) — `run_command`/`list_commands` then expose it automatically.
- A main-process action (new IPC handler / service function): add a dedicated tool in `src/main/mcpServer.ts` `registerTools()` and list it in `mcpServer.test.ts`.

Ask: "could an agent do this without the UI?" If not, it's not finished. Details and the tool-writing pattern: [docs/mcp.md](docs/mcp.md).

## Layout & commands

- `src/main` — backend: sessions/agent (`agent.ts`, `sessionStore.ts`), git/worktrees, hooks, PTY, DB, provisioning. Tests live beside the file (`*.test.ts`).
- `src/renderer/src` — the UI (`App.tsx` + `use*.ts` hooks, styles in `index.css`).
- `src/preload` — the `buildFloeApi`/`IpcLike` seam over Electron IPC.
- `src/shared` — types used by both sides.

```bash
pnpm dev          # electron-vite dev
pnpm typecheck    # node + web
pnpm test         # node --test on src/**/*.test.ts
```

Typecheck + unit tests are not "tested" — drive the real app before calling something done.

## UI conventions

Buttons use the **outline-chip pattern** (never solid fills) and every tinted element ships a light-theme override. Read [docs/ui-conventions.md](docs/ui-conventions.md) before touching styles or adding any button/chip/badge.

## More docs — read when the task touches them

- [docs/message-queue.md](docs/message-queue.md) — type-while-busy queue semantics.
- [docs/http-client.md](docs/http-client.md) — embedded `.http` client.
