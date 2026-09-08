# Floe MCP control server

Agents drive Floe the way the user does. An MCP server runs inside the Electron
main process (`src/main/mcpServer.ts`) and exposes every Floe action as a tool,
so a session — spawned by Floe or running in a plain terminal, and answering as
any harness that has tools — can create worktrees, open sessions, message them,
review diffs and run any UI command.

## Who gets the tools

Every harness Floe can spawn, each in its own dialect — the projections live in
`main/mcpHarness.ts`, which turns one server list into whatever the CLI
answering the turn can read:

| harness | how it is handed the servers | wired in |
| --- | --- | --- |
| claude | `--mcp-config <file>` + `--allowedTools mcp__floe` | `agent.ts` |
| codex | `thread/start` / `thread/resume` `config.mcp_servers` | `codexServer.ts` |
| opencode | `OPENCODE_CONFIG_CONTENT`, merged over the user's config | `runtimes.ts` |
| gemini | a generated settings file via `GEMINI_CLI_SYSTEM_SETTINGS_PATH` | `runtimes.ts` |
| lmstudio / ollama | nothing — no tools at all (`shared/modes.ts`) | — |

Two things are not obvious, and both were checked against the real CLIs
(codex-cli 0.150.1, opencode 1.18.15):

- **codex needs `default_tools_approval_mode: 'approve'` per server.** Floe
  starts codex threads with `approvalPolicy: 'never'` (an approval request
  arrives as a server→client call answered with a flat decline), and without the
  per-server setting every call comes back *"MCP tool call requires approval, but
  approval policy is never"*.
- **A query has to be told NO, not just left out.** Claude has
  `--strict-mcp-config`; codex, opencode and gemini all merge Floe's config over
  the user's own, and Floe now registers itself globally in all three — so an
  empty config would leave a query inheriting the whole control plane. The query
  config therefore names every server Floe knows about and switches each one off
  (`queryServers`), with a placeholder url so no disabled entry carries a live
  token. (Verified: `-c mcp_servers={}` leaves inherited servers standing,
  `-c mcp_servers.<name>.enabled=false` takes one down.)

`ask_codex` — the `@codex` second pair of eyes — gets no Floe tools either. It
reads code; it does not drive the app.

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
- **External sessions**: a CLI started in a plain terminal reads only its own
  config, so Floe registers itself there too (`main/mcpInstall.ts`): `claude mcp
  add -s user`, `codex mcp add --url`, and a merge into
  `~/.config/opencode/opencode.json` and `~/.gemini/settings.json` that leaves
  every other key as the user wrote it (a file that does not parse is reported,
  never overwritten). Only the Claude registration runs at boot — it has a CLI
  that owns its own file — and only when the server holds the preferred port.
  The other three happen when the user asks: ⌘K **Install Floe MCP globally**
  (`mcp.install`). All of them point at `/mcp/global`.

## The two tool layers

1. **Main-process tools** — actions that live in main (git, sessionStore, the
   agent conns): `list_projects`, `list_worktrees`, `create_worktree` (runs
   provisioning like the in-app flow), `remove_worktree`, `merge_worktree`,
   `worktree_status`, `list_branches`, `changed_files`, `file_diff`,
   `list_sessions`, `create_session` (`select` defaults to false — creating a
   background session must not steal the user's screen), `send_message` (with
   `wait=true` for synchronous session-to-session calls), `ask_codex` (the local
   Codex CLI as a second pair of eyes — read-only in the caller's worktree, one
   resumable thread per session, capped at five exchanges before the agent has
   to check in; it joins the chat as `@codex`, see `main/codex.ts`),
   `read_session_output`,
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

   The rest of what the UI can do, added so "could an agent do this without the
   UI?" answers yes:

   - **Projects**: `add_project` / `remove_project` / `update_project` (name,
     group, pinned, read-only). The palette's `project.add` opens an input a
     person types into, so this was the one thing no agent could do at all.
   - **The worktree's processes**: `run_project_command`, `stop_project_command`,
     `read_command_output`, `remove_project_command` — stored definitions only,
     never arbitrary shell, and a row is stopped before it is deleted. The UI's
     `command.run` acts on whatever the cursor is on, which is no use here.
   - **Unblocking a session**: `session_prompts` says what it is parked on,
     `answer_session_prompt` answers it — but only for a session THIS caller
     created. A session the user is sitting in front of is theirs to answer, and
     approving its tool permissions from another agent is not something Floe
     does.
   - **Steering one**: `update_session` (harness, model, effort, mode, title —
     one write, so a mode the new harness cannot do snaps instead of failing the
     turn later) and `close_session`.
   - **Review**: `list_commits`, `commit_diff` and `set_review_base`
     (clear/restore/status) alongside `changed_files` / `file_diff`.
   - **Plans**: `plan_phases` and `copy_plan` (which refuses to overwrite).
   - **Accounts**: `harness_usage` — every harness's own plan window, for an
     agent deciding who to hand work to.
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
- **Credentials**: an entry carries `env` (stdio) and `headers` (http) — the
  API key or bearer token without which most third-party servers cannot connect.
  They are secrets in a plain file, and every projection above passes them
  through in its own spelling (codex takes `http_headers`, opencode
  `environment`). The MCP tools **redact them**: `list_mcp_servers` and the
  add/update results return the credential's name with `***` for its value,
  because every caller of those is an agent. The panel and the file still show
  what the user typed.
- **Tools**: `list_mcp_servers` / `add_mcp_server` / `update_mcp_server` /
  `remove_mcp_server` — the same CRUD, for agents — plus `mcp_server_status`
  (the `claude:info` probe behind the panel's chips) and
  `authenticate_mcp_server`, which starts `claude mcp login` and hands the
  consent page to the user. Neither ever returns a token.

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
- **A new harness** means a new projection in `mcpHarness.ts` (and its off
  switch for queries), not a special case at the spawn site.

## What is deliberately NOT a tool

- **Shell and terminals.** Every harness has its own way to run a command, in
  whatever sandbox its mode grants. A Floe tool that shelled out would run in the
  main process, outside that sandbox — a plan-mode session with a way to write.
- **Notifications** (`notify:show`) and **the system prompt**
  (`settings:setSystemPrompt`): one is a spam channel, the other is persistent
  prompt injection into every future session on the machine.
- **A tool for running plugin commands, and the dev server**: a plugin's
  *commands* already reach agents through `run_command` (they register into the
  same palette registry), and a plugin's own *tools* are registered directly by
  `registerPluginToolsOn` — a third door would be one too many. The dev server is
  a subsystem nothing in the UI drives any more; the project's own commands are
  the live abstraction.

Two things the audit left standing, both older and larger than this change:

**Nothing can interrupt a codex turn.** `stopAgent` knows Claude's conns only, so
`stop_session` (and the composer's own stop button, and `close_session`) leave a
codex turn running to its end. Fixing it means an interrupt on the app-server
side, which is its own change.

**The path token is identity, not authorization.** Any caller that
reaches the loopback port gets the whole tool registry, and a session's tools are
the same in `plan` as in `skip`. That is the agent-first bargain Floe already
made for Claude; extending it to the other harnesses does not change its shape,
but a capability-scoped token (read / write / destructive / admin) is the next
thing to build here.

## Testing

`src/main/mcpServer.test.ts` boots the real server hermetically (electron
stubbed by the shared loader hook) and connects with the SDK client over HTTP.
It sets `FLOE_MCP_NO_REGISTER=1` so `pnpm test` never shells `claude mcp add`.
For a live check: run the app, then `claude mcp list` should show `floe`, and
any claude session can call `mcp__floe__list_projects`.
