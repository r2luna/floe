// The skills Floe ships with.
//
// Inlined here rather than read from `resources/` for the same reason the hook
// scripts are (main/hooks.ts): a file on disk would need extraResources and
// __dirname juggling across the electron-builder and esbuild targets, and get
// it wrong once and the feature is missing from a packaged build only.
//
// They are written to `~/.config/floe/builtin-skills/` on every boot and read
// back as scope `builtin` — real files, so the panel, the reader and the editor
// need to know nothing about them. Rewritten each boot means an update ships a
// corrected skill; a user who wants their own version writes a global or project
// skill of the same name, which wins the lookup (config/skills.ts).

export interface BuiltinSkill {
  name: string
  /** The markdown, frontmatter included — exactly what lands on disk. */
  text: string
}

const SETUP_COMMANDS = `---
name: setup-commands
description: Read this project and register its long-running commands in Floe.
---

# Set up this project's Floe commands

Floe runs a project's named processes — dev server, queue worker, scheduler,
file watcher — in the command pane of every worktree, from the project's
\`commands.toml\`. Your job: work out which processes THIS project has, confirm
them with the user, and register them.

## 1. See what is already there

Call \`list_project_commands\` with the current directory (a worktree path
resolves back to its project). Anything already registered is off the table —
adding a second row for the same process is the failure mode here, and
\`add_project_command\` refuses a duplicate name anyway.

## 2. Read the project, do not guess

Look at what the repo actually declares:

- \`package.json\` scripts, and the lockfile for the package manager
  (\`bun.lockb\` → bun, \`pnpm-lock.yaml\` → pnpm, \`yarn.lock\` → yarn, else npm).
- \`composer.json\` + \`artisan\` — Laravel: \`queue:work\`, \`schedule:work\`,
  \`horizon\`, \`reverb:start\`, \`pail\`.
- \`Procfile\`, \`Procfile.dev\`, \`docker-compose.yml\`, \`Makefile\`, \`justfile\`,
  \`mix.exs\`, \`Cargo.toml\`, \`go.mod\`, \`manage.py\`, \`Gemfile\`.
- The README's "development" / "getting started" section — the commands a human
  is told to run are the commands worth registering.

## 3. Keep the processes, drop the tasks

A Floe command is something that STAYS RUNNING and has output worth watching:
servers, workers, schedulers, watchers, tunnels. A task that finishes on its own
— tests, lint, typecheck, build — belongs in the terminal, not in the command
pane. The one exception is a task driven by \`watch\`: re-running on file change
is what makes it a process.

Per command, decide:

- \`auto_start\` — only for a service that is safe to run unattended in a fresh
  worktree. Never for anything that touches data (\`migrate:fresh\`, seeders, a
  db reset): provisioning would run it on every new worktree.
- \`auto_restart\` — for a service that should come back when it dies.
- \`watch\` — globs that restart it on change.
- \`cwd\` — only when the command must run somewhere other than the worktree root.

Name each row for what it is (\`Dev\`, \`Queue\`, \`Scheduler\`, \`Vite\`), not for the
shell line it runs. Use the project's own package manager. Skip anything that
needs credentials or an account (\`stripe listen\`, \`ngrok\`) unless the repo shows
it is part of normal development.

## 4. Confirm before writing

Show the candidates with \`present_decision\`: one multi-select group, the
recommended ones selected by default, each label carrying the command it will
run. Then STOP and wait — the user's choice arrives as a normal message.

## 5. Register them

For each chosen command call \`add_project_command\` (project scope unless the
user asked for one worktree). Then report what was added, one line each, with
the flags you set and why any of them was left off auto-start.
`

export const BUILTIN_SKILLS: BuiltinSkill[] = [{ name: 'setup-commands', text: SETUP_COMMANDS }]
