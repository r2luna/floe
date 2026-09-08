# MCP coverage: every harness, every action

**Status: done.** What shipped, and where it differs from the plan below, is in
[docs/mcp.md](../../docs/mcp.md). Three things changed during the work:

- codex is wired at the **app-server thread config** (`thread/start` /
  `thread/resume`), not at `codex exec` argv — `codexArgs()` only drives the
  `@codex` subagent. Each thread also needs
  `default_tools_approval_mode: 'approve'`, or every call is refused for want of
  an approval nobody can give.
- a query is handed **every server, switched off**, per harness: only Claude has
  `--strict-mcp-config`, and passing nothing would leave a query inheriting the
  globally-installed Floe server.
- registry credentials are **redacted in every MCP tool result**, and several
  planned tools were dropped rather than built (`colony_release`, the plugin and
  dev-server tools, thread comments, `notify`, the settings getters/setters, a
  second transcript reader) — each was a duplicate, dormant, or a persistent
  injection channel.

Audit finding: Floe's "agent first" principle is only half true. The MCP control
server exposes 56 tools, but only `claude` sessions ever receive it, the registry
cannot carry credentials, and a long tail of main-process capability has no tool
at all.

## A1 — Every harness gets the MCP config (F1, F3)

Today `agent.ts:459` is the only place `--mcp-config` is attached. `codex.ts`
`codexArgs()` and `runtimes.ts` (opencode, gemini) build their argv with no MCP
wiring, so a session answering as codex/opencode/gemini has zero `mcp__floe__*`
tools and zero registry servers — and the header comment in
`config/mcpServers.ts` ("the third-party servers every spawned harness gets") is
false.

New module `src/main/mcpHarness.ts`: one merged server map (floe + enabled
registry entries), projected per harness.

| harness  | mechanism (verified locally unless noted) |
| -------- | ----------------------------------------- |
| claude   | `--mcp-config <file>` (unchanged) |
| codex    | `-c mcp_servers.<name>.url="…"` / `.command` / `.args` / `.env` — verified with `codex mcp list -c …` on codex-cli 0.150.1 |
| opencode | `OPENCODE_CONFIG_CONTENT` env with `{"mcp":{"<name>":{"type":"remote","url":…,"enabled":true}}}` — verified: `opencode mcp list` reports `floetest connected` |
| gemini   | a generated settings JSON via `GEMINI_CLI_SYSTEM_SETTINGS_PATH` — NOT verified (gemini is not installed here) |
| lmstudio / ollama | nothing: no tools at all, per `shared/modes.ts` |

Rules kept:

- A query still gets nothing (D8) — the empty-config rule generalises to every
  harness, no token, no registry.
- `ask_codex` (the read-only second pair of eyes) stays MCP-free; only a codex
  session that IS the chat gets the tools.
- `installGlobal()` grows a per-harness install: `claude mcp add`, `codex mcp add
  --url`, plus opencode/gemini config writes, each best-effort and reported per
  harness.

## A2 — The registry can carry credentials (F2)

`McpServerEntry` gains `env` (stdio) and `headers` (http). Both parse from
`mcp.toml` tables, both are written by add/update, both project into every
harness config. New tools: `authenticate_mcp_server` (the `a` key in the panel)
and `mcp_server_status` (the `claude:info` probe an agent currently cannot see).

## A3/A4 — The tools the UI has and agents do not

- **Projects (F4)**: `add_project`, `remove_project`, `rename_project`,
  `set_project_options` (pinned/read-only/group).
- **Project commands (F5)**: `run_project_command`, `stop_project_command`,
  `read_command_output`, `remove_project_command`, plus dev server
  `start_dev_server` / `stop_dev_server`.
- **Waiting sessions (F6)**: `answer_session_question` — `list_sessions` already
  reports `needsYou` and there is no way to unblock it.
- **Session state (F7)**: `update_session` (model/effort/mode/title),
  `close_session`, `read_session_transcript`.
- **Review (F8)**: `list_commits`, `commit_diff`, `list_comments`, `add_comment`,
  `clear_review` / `restore_review`.
- **The tail (F9)**: `plan_phases`, `copy_plan`, `colony_nanny`,
  `colony_release`, `list_plugins`, `run_plugin_command`, `usage_stats`,
  `get_settings` / `set_system_prompt`, `notify`.

Every tool follows the house pattern: zod raw shape with `.describe()`,
`try/catch`, `textResult` for success and error, renderer push when it changes
state behind the UI's back, name added to `mcpServer.test.ts`.

## Docs

`docs/mcp.md` gains a "who gets the tools" section (the table above);
`AGENTS.md`'s agent-first rule stays as is.
