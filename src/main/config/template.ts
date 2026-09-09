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
# | \`font-family\` must name a font installed on this machine; when it can't be
# | found the default monospace is used. Whatever you pick, the bundled Nerd Font
# | stays behind it as per-glyph fallback, so terminal icons keep resolving.
# |
# | \`font-size\` scales the whole surface — text, padding and rules together, the
# | way a terminal's font size does — rather than the text alone. 13 is the size
# | the interface is drawn at, so it is the neutral value.
# |
# | \`theme\` is \`dark\`, \`light\`, or \`system\`. The default, \`system\`, follows
# | the OS and flips live when it does; the other two pin the app to one theme.
# | Light is a full palette of its own, not a filter over dark.
# |
# | \`penguin\` picks which pinguim head greets you on a new session. Same head,
# | 24 faces — \`classic\`, \`sleepy\`, \`surprised\`, \`focused\`, \`skeptical\`,
# | \`cool\`, \`wink\`, \`cute\`, \`zen\`, \`robot\`, \`punk\`, \`tired\`, \`happy\`,
# | \`angry\`, \`dizzy\`, \`dreamer\`, \`ninja\`, \`scanner\`, \`spark\`, \`sad\`,
# | \`crown\`, \`tuft\`, \`antenna\`, \`chipped\`. Settings shows them all.
# |
# | \`penguin-color\` tints that head: \`accent\` (the app's own orange), \`ice\`,
# | \`green\`, \`blue\`, \`violet\`, \`amber\`, \`red\`, or \`plain\` (the text
# | colour). Each tone carries a dark and a light value, so the choice survives
# | the theme flipping under it.
# |
# | \`chat-layout\` is how the transcript arranges a turn. \`classic\` is the
# | IRC log the app shipped with — one column, no air between turns. The other
# | six each pull one lever on it: \`gutter\` puts the time and nick in a fixed
# | left column so every message starts at the same edge, \`surfaces\` gives
# | your own messages a recessed well, \`ruled\` draws a hairline between
# | speakers, \`rail\` hangs the turns off a timeline, \`split\` bands the tool
# | work away from the speech, and \`labels\` puts the nick on its own line
# | above the words. Every one of them is a block of CSS — the transcript
# | renders the same either way.
# |
# ------------------------------------------------------------------------------

[appearance]
font-family   = "CommitMonoPinguim"
font-size     = 13
theme         = "system"
penguin       = "classic"
penguin-color = "accent"
chat-layout   = "classic"


# ------------------------------------------------------------------------------
# | You
# ------------------------------------------------------------------------------
# |
# | \`name\` is who the launcher greets. Left empty, the app works it out from
# | the machine: \`git config user.name\` first (the name you already chose to be
# | known by here), then the macOS full name, then the login name. First name
# | only — "Good evening, Ada Lovelace" reads like a form letter.
# |
# ------------------------------------------------------------------------------

[user]
name = ""


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
# | \`mode\` is how much the agent may do without asking: \`plan\` (reads and
# | plans, writes nothing), \`ask\` (asks before each tool that acts), \`auto\`
# | (edits the worktree without asking) or \`bypass\` (no prompts, no sandbox).
# | Not every harness has all four — codex has no \`ask\`, gemini has no
# | \`plan\`, opencode stops at \`auto\` — and a mode a harness cannot do snaps
# | to the nearest safer one it can. ⌃⇧M cycles it inside a chat.
# |
# | \`system-prompt\` names a Markdown file in this directory, injected into every
# | CLI process Floe spawns, whatever project or worktree started it. It is
# | prose, so it stays its own file instead of one escaped string in here.
# |
# | The name is always resolved inside this directory — a path climbing out of it
# | falls back to \`system-prompt.md\`, so copying ~/.config/floe brings the
# | prompt with it. HTML comments in that file are stripped before it is sent.
# |
# ------------------------------------------------------------------------------

[agent]
model         = "opus"
effort        = "high"
provider      = "claude"
mode          = "ask"
system-prompt = "system-prompt.md"


# ------------------------------------------------------------------------------
# | Harness defaults
# ------------------------------------------------------------------------------
# |
# | \`[agent]\` above says what a NEW SESSION starts on. These say what each
# | harness answers with when a message names it but not a model — \`@codex fix
# | this\` at the START of a line hands that one message to codex, whatever the
# | session is set to.
# |
# | Both keys are optional. No \`model\` means the harness's own default; no
# | \`effort\` means the one already in the picker. Write the slug the harness
# | itself uses (\`codex\`'s model list, \`lms ls\`, \`ollama list\`) — it is
# | passed straight through, so it is never checked against a list here.
# |
# | A message can override both inline: \`@codex:gpt-5.6-sol:high\`.
# |
# ------------------------------------------------------------------------------

# [harness.codex]
# model  = "gpt-5.6-sol"
# effort = "high"

# [harness.lmstudio]
# model = "qwen/qwen3.6-35b-a3b"


# ------------------------------------------------------------------------------
# | Worktree premise
# ------------------------------------------------------------------------------
# |
# | A new worktree is interviewed about its own purpose while it provisions: a
# | few short questions in the setup checklist, and the answers become
# | \`.floe/premise.md\` inside the worktree. That file is handed to the FIRST
# | turn of every session started there, so a new chat already knows what the
# | branch is for without you saying it again.
# |
# | \`provider\` is \`claude\` or \`codex\`: the interview is two headless calls, and
# | those are the two that answer that way. \`model\` is passed straight through —
# | a claude name (\`sonnet\`, \`haiku\`) or a codex slug — so it is never checked
# | against a list here. \`effort\` is optional; unset means the harness's own.
# |
# | \`enabled = false\` turns the interview off. Premise files already written are
# | still read and still injected.
# |
# ------------------------------------------------------------------------------

[premise]
enabled  = true
provider = "claude"
model    = "sonnet"
# effort = "medium"


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
# | Composer
# ------------------------------------------------------------------------------
# |
# | \`vim\` turns the message box into a modal editor: Escape leaves insert mode,
# | and normal mode has the motions, operators and text objects you already know
# | — \`ciw\`, \`di"\`, \`dd\`, \`yyp\`, \`v\` and \`V\`, counts, \`u\` and \`⌃r\`.
# |
# | Enter still sends the message from either mode, and sending puts you back in
# | insert — so a draft always starts typing. Escape in normal mode with nothing
# | half-typed goes back to closing the panel, as it does everywhere else.
# |
# ------------------------------------------------------------------------------

[composer]
vim = false


# ------------------------------------------------------------------------------
# | Editor
# ------------------------------------------------------------------------------
# |
# | The editor \`e\` opens the file under the cursor in.
# |
# | \`nvim\`, \`vim\` and \`helix\` are terminal editors: the file panel BECOMES the
# | editor, on Floe's own PTY, so nothing leaves the window and Escape-Escape
# | hands the panel back. One editor per worktree, so every file you open lands
# | in the same session.
# |
# | \`vscode\`, \`zed\` and \`sublime\` are separate apps, so \`e\` launches them with
# | the file and the line the cursor is on instead.
# |
# | Any other value is taken as a terminal editor binary and run in the panel.
# |
# ------------------------------------------------------------------------------

[editor]
command = "nvim"


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
# | Notifications
# ------------------------------------------------------------------------------
# |
# | \`sound\` plays when an agent finishes a turn, in any session. The sounds are
# | synthesized in the app, not files: \`chime\`, \`ping\`, \`pop\`, \`bell\`,
# | \`marimba\` or \`tada\` — Settings previews each one as you cycle through them.
# | \`off\` silences it.
# |
# ------------------------------------------------------------------------------

[notifications]
sound = "chime"


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
# | The Colony Board
# ------------------------------------------------------------------------------
# |
# | One column per agent profile, one card per task, one worktree per card. This
# | is the board every project starts from; a project overrides it in
# | \`projects/<dir>/colony.toml\`, which is read with the same two rules:
# |
# |   THE STAGE LIST IS ALL-OR-NOTHING. Declare any \`[[colony.stage]]\` here and
# |   it replaces the built-in six entirely. Patching an ordered list needs
# |   "insert after coder" rules nobody can read at a glance.
# |
# |   SCALARS INHERIT. \`cap\` unset in a project's file means this one.
# |
# | A stage carries five things, and the ORDER OF THE FILE IS THE EXECUTION
# | ORDER — there is no \`order\` key to drift from it:
# |
# |   name     the column label, free text
# |   skill    the FLOE skill that runs when a task enters (not a slash command
# |            belonging to one harness — that is what lets a lane change model)
# |   harness  claude, codex, opencode, gemini, lmstudio, ollama. Unset means
# |            whatever a new session would have used
# |   model    that harness's own slug. Unset, likewise
# |   cap      how many tasks this stage WORKS at once. Tasks waiting to ENTER it
# |            cost nothing, so a full stage never freezes the one behind it
# |
# | \`inbox\` and \`done\` are never written here. They are the ends of any board —
# | backlog and exit — not stages, and declaring them would invite deleting them.
# |
# | Commented out because the built-in board is the same list: uncomment to
# | change it. The six skills it names ship with Floe.
# |
# ------------------------------------------------------------------------------

# [colony]
# cap = 5
#
# [[colony.stage]]
# name  = "specifier"
# skill = "colony-specify"
# model = "opus"
#
# [[colony.stage]]
# name  = "coder"
# skill = "colony-implement"
# model = "opus"
#
# [[colony.stage]]
# name  = "cleaner"
# skill = "colony-refactor"
# model = "opus"
# cap   = 1
#
# [[colony.stage]]
# name  = "architect"
# skill = "colony-architecture"
# model = "sonnet"
#
# [[colony.stage]]
# name  = "hardener"
# skill = "colony-review"
# model = "opus"
#
# [[colony.stage]]
# name  = "qa"
# skill = "colony-verify"
# model = "haiku"   # a lane that runs the suite does not need opus


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

/** An MCP registry file. Written only once a scope actually has a server. */
export const MCP_TOML = `# ==============================================================================
#  Floe — MCP servers
# ==============================================================================
#  Third-party MCP servers Floe hands to every harness it spawns, so the same
#  server works whichever CLI answers the turn (like skills: one copy, every
#  harness). Global file: ~/.config/floe/mcp.toml — every project. A project's
#  own projects/<dir>/mcp.toml adds to it, and a project server wins over a
#  global one of the same name.
#
#  Each [[server]] entry:
#    name      = "context7"                # required, unique in its file
#    transport = "http"                    # "http" or "stdio"
#    url       = "https://mcp.example/…"   # http only
#    command   = "npx"                     # stdio only
#    args      = ["-y", "@some/mcp"]       # stdio only, optional
#    env       = { API_KEY = "…" }         # stdio only, optional
#    headers   = { Authorization = "Bearer …" }  # http only, optional
#    enabled   = true                      # optional, defaults to true
#
#  env and headers are the credentials the server needs. They are secrets in a
#  plain file: keep this one to yourself (chmod 600), and prefer a project file
#  outside the repo over committing a token.
# ==============================================================================
`
