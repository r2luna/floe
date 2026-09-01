# Floe MCP control server

Agents drive Floe the way the user does. An MCP server runs inside the Electron
main process (`src/main/mcpServer.ts`) and exposes every Floe action as a tool,
so a Claude session — spawned by Floe or running in a plain terminal — can
create worktrees, open sessions, message them, review diffs and run any UI
command.

## How callers connect

- **Transport**: streamable HTTP, loopback only (`127.0.0.1`), preferred port
  `41673` with an ephemeral fallback when a second instance holds it. Requests
  carrying an `Origin` header or a non-loopback `Host` are rejected (403) — the
  CSRF/DNS-rebinding guard the MCP spec recommends for HTTP servers.
- **Identity**: the URL path carries the caller — `/mcp/<key>`. In-app sessions
  get their own session id as the key; external sessions share `global`. A fresh
  stateless `McpServer` is built per request with the token closed over each
  tool, so a tool always knows who called it.
- **In-app sessions**: `agent.ts` spawns `claude` with
  `--mcp-config <temp>/floe-mcp-<key>.json --allowedTools mcp__floe`. The
  config file is rewritten per spawn (`mcpConfigFor`), so fallback ports don't
  matter there. Those two argv entries are also what the managed hooks'
  ps-ancestry walk (`hooks.ts` `DETECT_FLOE`) matches — the branch/edit/subagent
  /sleep policies only fire inside Floe-launched sessions.
- **External sessions**: registered in the user's global Claude config
  (`claude mcp add -s user -t http floe http://127.0.0.1:41673/mcp/global`).
  Auto-run at boot when the server holds the preferred port; the ⌘K command
  **Install Floe MCP globally** (`mcp.install`) is the manual fallback.

## The two tool layers

1. **Main-process tools** — actions that live in main (git, sessionStore, the
   agent conns): `list_projects`, `list_worktrees`, `create_worktree` (runs
   provisioning like the in-app flow), `remove_worktree`, `merge_worktree`,
   `worktree_status`, `list_branches`, `changed_files`, `file_diff`,
   `list_sessions`, `create_session` (`select` defaults to false — creating a
   background session must not steal the user's screen), `send_message` (with
   `wait=true` for synchronous session-to-session calls), `read_session_output`,
   `stop_session`, `select_session`, `create_followup` / `list_followups` /
   `cancel_followup`, `list_plans`, `read_plan`, `open_plan`,
   `present_decision` (renders the inline decision panel — `agent.ts` and
   `claudeSessions.ts` special-case the `mcp__floe__present_decision` tool_use
   block, injecting `type: 'decision'` before `parseArtifactSpec`), and the
   skills admin set `list_skills` / `read_skill` / `create_skill` /
   `update_skill` / `rename_skill` / `delete_skill` (Floe-owned skills,
   `config/skills.ts` — to *use* one, put `/name` in a prompt; expansion
   happens on send). `list_project_commands` / `add_project_command` write a
   project's own processes — the dev server, queue worker or watcher Floe runs
   in a worktree's command pane (`commands.toml`, `main/commands.ts`); the
   built-in `/setup-commands` skill is what fills them in from the repo.
   `start_merge` opens the **guided** merge checklist for a
   worktree (navigating the UI to its project if needed) and pauses at the
   review checkpoint for the user — `merge_worktree` stays the headless
   one-shot with no review stop.
2. **UI commands** — everything the renderer's command registry dispatches
   (the palette, the keymap): `list_commands` and `run_command`. These do a
   round-trip to the renderer (`mcp:command` → `mcp:command-result`), which runs
   the same `runCommand(REGISTRY, ctx, id, arg)` a key press does.

## Floe's MCP registry (third-party servers)

Floe also *administers* MCP servers, the way it owns skills: one entry, every
harness. The registry lives in `~/.config/floe/mcp.toml` (global) and
`projects/<dir>/mcp.toml` (per project, wins on a name clash) — see
`config/mcpServers.ts` and the template in the file itself. `mcpConfigFor`
merges the enabled entries into every per-session `--mcp-config`, so a server
registered once reaches each spawned session; changes apply to sessions spawned
after the edit.

- **The MCP panel** (⌘K → "MCP servers…", command `mcp.open`) is the admin UI,
  mirroring the skills panel: `n` add (scope under the `+`, name on the row —
  the entry is created disabled and its mcp.toml opens to fill in url/command),
  `e` edit, `t` enable/disable, `a` authenticate, `d` delete.
- **Connection state**: the panel's status chips come from the `claude:info`
  probe, which gets the same merged `--mcp-config` a real session does — so
  `connected` / `needs-auth` / `failed` is what a session actually sees.
- **Auth**: `a` runs `claude mcp login <name>` in a PTY (`main/mcpAuth.ts`);
  the consent URL opens in the browser and the CLI's loopback callback stores
  the token. Tokens are per-harness — Floe distributes the server definition,
  each harness holds its own credentials.
- **Tools**: `list_mcp_servers` / `add_mcp_server` / `update_mcp_server` /
  `remove_mcp_server` — the same CRUD, for agents.

UI-driving tools (`select_session`, `open_plan`, and the round-trip pair) need a
window; everything else works headless and answers `{ error: … }` instead of
throwing — tools never throw.

## The rule: a new command ships its MCP tooling with it

**A command an agent cannot call is not finished**, the same way a button
without a keybinding is not finished. When you add a user-facing action:

- **Renderer action** (a palette/keymap command): add it to the registry
  (`renderer/src/commands.ts` rule: handlers dispatch ids, never contain
  behaviour) **and** to `src/shared/commandIds.ts`. That is all — `run_command`
  / `list_commands` expose it automatically, and `registry.test.ts` enforces the
  lockstep in both directions.
- **Main-process action** (a new IPC handler / service function): add a
  dedicated tool in `registerTools()` (`src/main/mcpServer.ts`) in the same
  change. Follow the house pattern: zod raw shape with `.describe()` on every
  param, `try/catch`, `textResult(...)` for success **and** error, push
  `worktrees:updated` (or the relevant renderer event) when the tool changes
  state behind the UI's back. Add its name to the expected list in
  `mcpServer.test.ts`.
- **Renaming a tool** breaks the managed hooks (`hooks.ts` steers sessions to
  `mcp__floe__*` names) — update them together.

## Testing

`src/main/mcpServer.test.ts` boots the real server hermetically (electron
stubbed by the shared loader hook) and connects with the SDK client over HTTP.
It sets `FLOE_MCP_NO_REGISTER=1` so `pnpm test` never shells `claude mcp add`.
For a live check: run the app, then `claude mcp list` should show `floe`, and
any claude session can call `mcp__floe__list_projects`.
