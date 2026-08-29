// The documented files Floe writes when they don't exist yet.
//
// These are not "examples" dropped next to the real config — they ARE the real
// config, generated with every block explained in place. The user (and any agent
// editing on their behalf) should be able to answer "what does this key do?"
// from the file itself, without opening docs. The surgical writer in toml.ts is
// what lets these comments survive everything the app writes afterwards.

export const FLOE_TOML = `# ==============================================================================
#  Floe — ~/.config/floe/floe.toml
# ==============================================================================
#  This file is yours. Hand-editable, safe to keep in your dotfiles repo.
#  Unknown keys and bad values are reported with their line number in Settings,
#  never silently ignored — and a bad value falls back to its default rather
#  than taking anything else down with it.
#
#  Your projects are NOT here: each one has its own directory under
#  \`projects/\`, so a change to one never touches another.
# ==============================================================================


# ------------------------------------------------------------------------------
# | Appearance
# ------------------------------------------------------------------------------
# |
# | The interface font and theme. \`font-family\` must name a font installed on
# | this machine; when it can't be found Floe falls back to the default
# | monospace and says so. \`theme\` takes one of the built-in themes
# | (\`omarchy\`, \`carbon\`) or a path to your own colors file.
# |
# ------------------------------------------------------------------------------

[appearance]
font-family = "CommitMonoPinguim"
font-size   = 13
theme       = "omarchy"


# ------------------------------------------------------------------------------
# | Default Agent
# ------------------------------------------------------------------------------
# |
# | Which model answers a new session, and how hard it thinks. The ids are the
# | CLI's own aliases (\`fable\`, \`opus\`, \`sonnet\`, \`haiku\`), so this list does
# | not go stale every time a model ships. \`effort\` ranges from \`low\` to \`max\`.
# |
# | \`provider\` picks who answers: \`claude\`, \`codex\`, \`opencode\`, \`gemini\`,
# | \`lmstudio\` or \`ollama\`. Switching model inside a session does not rewrite
# | this default — it only sets the starting point for the next one.
# |
# | \`system-prompt\` names a Markdown file in this directory, injected into every
# | CLI process Floe spawns, whatever project or worktree started it. It is
# | prose, so it stays its own file instead of one escaped string in here.
# |
# ------------------------------------------------------------------------------

[agent]
model         = "opus"
effort        = "high"
provider      = "claude"
system-prompt = "system-prompt.md"


# ------------------------------------------------------------------------------
# | Terminal
# ------------------------------------------------------------------------------
# |
# | The shell the terminal panel opens. By default Floe reads your login shell
# | from the OS user database, because an app launched from the GUI never
# | inherits $SHELL. Set this only to force something else.
# |
# ------------------------------------------------------------------------------

[terminal]
# shell = "/opt/homebrew/bin/fish"


# ------------------------------------------------------------------------------
# | Install Sandbox
# ------------------------------------------------------------------------------
# |
# | Installing dependencies runs arbitrary scripts from transitive packages
# | (preinstall/postinstall, composer plugins) — the classic supply-chain
# | vector. With the sandbox on, those scripts run inside bubblewrap with no
# | access to ~/.ssh, your gh token, your sops age key, or the sibling projects
# | next door.
# |
# | Linux only, since bwrap is a Linux tool. On macOS Floe runs unsandboxed and
# | logs that loudly, never in silence. \`FLOE_SANDBOX=0\` in the environment still
# | overrides this for a single run.
# |
# ------------------------------------------------------------------------------

[sandbox]
enabled = true


# ------------------------------------------------------------------------------
# | Auto Update
# ------------------------------------------------------------------------------
# |
# | Floe downloads new versions in the background, but never swaps the bundle on
# | quit — an update is only applied through the explicit "Restart now". This
# | interval controls how often it looks for releases while the app stays open.
# |
# ------------------------------------------------------------------------------

[update]
check-interval-hours = 6


# ------------------------------------------------------------------------------
# | Project Groups
# ------------------------------------------------------------------------------
# |
# | The headings the sidebar groups projects under, in the order they appear.
# | Which group a project belongs to is set in that project's own \`config.toml\`;
# | this list only fixes the order and keeps a group you have made but not filled
# | yet, which a project directory alone can't record.
# |
# | \`Projects\` is always first and always present — it is where a project whose
# | group is deleted lands.
# |
# ------------------------------------------------------------------------------

[projects]
groups = ["Projects"]

# ------------------------------------------------------------------------------
# | Integrations
# ------------------------------------------------------------------------------
# |
# | The non-secret half of each connection. Tokens and passwords do NOT live
# | here: they are encrypted by the OS keychain and kept outside this file, so it
# | can go into a dotfiles repo without risk. Connect from Settings.
# |
# | Which Jira project a repo maps to is per-project, so it lives in that
# | project's own \`config.toml\` rather than here.
# |
# ------------------------------------------------------------------------------

[integrations.jira]
# site  = "https://yourcompany.atlassian.net"
# email = "you@example.com"

[integrations.bitbucket]
# email = "you@example.com"
`

/**
 * A project's own file.
 *
 * Generated with `path` empty and filled in through the normal editor, so a
 * project added from the UI comes out looking exactly like one written by hand.
 */
export const PROJECT_TOML = `# ==============================================================================
#  Floe — project
# ==============================================================================
#  Everything Floe knows about this project lives in this directory. The
#  directory name is only a label: \`path\` below is what identifies the project,
#  so renaming the directory changes nothing. Delete the directory to remove the
#  project from Floe.
#
#  This is config, not state. Sessions, caches and run history live elsewhere and
#  are never written here.
# ==============================================================================


# ------------------------------------------------------------------------------
# | Identity
# ------------------------------------------------------------------------------
# |
# | \`path\` points at the git repository. \`group\` decides where it sits in the
# | sidebar, \`name\` overrides the folder basename in the UI, \`pinned\` keeps it on
# | the rail even with no activity today, and \`read-only\` opens files in the
# | built-in viewer instead of your editor.
# |
# ------------------------------------------------------------------------------

path  = ""
group = "Projects"


# ------------------------------------------------------------------------------
# | Containerized Environment
# ------------------------------------------------------------------------------
# |
# | Optional. It only carries what can't be inferred reliably — the PHP version
# | above all, which is the reason to containerize at all. \`package-manager\` and
# | \`db\` have defaults inferred from the lockfile and the .env, but can be pinned
# | here. \`db-admin\` surfaces DBGate from the shared support stack.
# |
# | Delete this whole block to run the project on the host instead.
# |
# ------------------------------------------------------------------------------

# [env]
# mode            = "container"
# runtime         = "laravel"
# php             = "8.4"
# package-manager = "pnpm"
# db              = "mysql"
# db-admin        = true


# ------------------------------------------------------------------------------
# | Integrations
# ------------------------------------------------------------------------------
# |
# | Per-project integration settings. \`jira-project\` is the board key this repo's
# | issues belong to (e.g. "PROJ"); the credentials themselves are global and
# | live in floe.toml.
# |
# ------------------------------------------------------------------------------

# [integrations]
# jira-project = "PROJ"
`

/** A project's commands. Written only once the project actually has one. */
export const COMMANDS_TOML = `# ==============================================================================
#  Floe — project commands
# ==============================================================================
#  Named processes Floe can run for this project.
#
#  \`auto-start\` launches the command when a worktree is provisioned,
#  \`auto-restart\` brings it back when it dies, and \`watch\` lists globs that
#  restart it on change. \`cwd\` overrides the working directory, which defaults to
#  the worktree path. \`notify\` takes \`all\`, \`important\` or \`none\`.
#
#  A command is shared by every worktree of this project unless it names one:
#  add \`worktree = "/absolute/path"\` to scope it to a single branch, for a
#  throwaway process you only need there.
#
#    [[command]]
#    name     = "Stripe listen"
#    command  = "stripe listen --forward-to localhost:8000/webhook"
#    worktree = "/code/app-feat-billing"
# ==============================================================================
`
