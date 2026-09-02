// Floe-managed global Claude Code hooks. Previously the three floe-*
// PreToolUse hooks were hand-installed personal artifacts with no source in
// this repo — this file makes them app-managed: written to ~/.claude/hooks and
// merged into ~/.claude/settings.json on every boot, on BOTH targets (desktop +
// headless server boot the same index.ts), mirroring the MCP server's
// ensureGlobalRegistered (idempotent, best-effort, never throws, never
// clobbers unrelated user config).
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Shared ps-ancestry walk every managed hook uses to fire ONLY inside a
// Floe-launched session (its argv carries `--allowedTools mcp__floe` /
// `--mcp-config .../floe-mcp-*.json`) — a plain terminal session stays
// untouched.
const DETECT_FLOE = `is_floe=0
pid=\${PPID:-0}
hops=0
while [ "$pid" -gt 1 ] && [ "$hops" -lt 30 ]; do
  args=$(ps -ww -o args= -p "$pid" 2>/dev/null)
  case "$args" in
    *mcp__floe*|*floe-mcp-*) is_floe=1; break ;;
  esac
  pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  [ -z "$pid" ] && break
  hops=$((hops + 1))
done
[ "$is_floe" -eq 1 ] || exit 0`

interface ManagedHook {
  filename: string
  matcher: string
  statusMessage: string
  script: string
}

// All scripts are inlined (not bundled assets) so they survive both build
// targets without extraResources/__dirname path juggling across
// electron-builder vs the esbuild server shim.
const MANAGED_HOOKS: ManagedHook[] = [
  {
    filename: 'floe-block-branch.sh',
    matcher: 'Bash',
    statusMessage: 'Checking branch-creation policy…',
    script: `#!/usr/bin/env bash
# Floe: block branch creation inside a Floe-launched Claude session.
#
# When a session spawned by the Floe app tries to create a NEW branch in the
# current worktree (git checkout -b / switch -c / branch <name>), this denies the
# command and steers Claude to spin up a fresh worktree + session via the floe
# MCP instead — carrying a summary of the work forward so it continues there.
# Managed by the Floe app (src/main/hooks.ts) — edits here are overwritten on
# next boot.
set -u

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$cmd" ] && exit 0

# 1) Is this a branch-CREATING git command? (switching to / listing / deleting
#    an existing branch is fine — only creation is blocked.)
printf '%s' "$cmd" | grep -Eq \\
  'git[[:space:]].*(checkout[[:space:]]+-[bB]([[:space:]]|$)|switch[[:space:]]+(-[cC]|--create)([[:space:]]|$)|branch[[:space:]]+[^-[:space:]])' \\
  || exit 0

# 2) Only enforce inside a Floe-launched session.
${DETECT_FLOE}

# 3) Block and steer Claude to the floe MCP worktree+session flow.
read -r -d '' MSG <<'EOF'
Não crie uma branch nova neste worktree — isso trocaria a branch em que o usuário está trabalhando (main/master/develop) e sequestraria o checkout atual.

Em vez disso, continue o trabalho num worktree separado usando o MCP do Floe:
1. mcp__floe__create_worktree — cria um worktree novo (a branch nova é criada automaticamente nele; não precisa de git checkout -b).
2. mcp__floe__create_session — abre uma sessão NESSE worktree e passe um resumo do contexto atual (o que estava sendo feito, decisões já tomadas, próximos passos) para continuar de lá.

Não rode git checkout -b / git switch -c / git branch <nome> aqui.
EOF

jq -n --arg reason "$MSG" \\
  '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
exit 0
`
  },
  {
    filename: 'floe-confine-edits.sh',
    matcher: 'Edit|Write|MultiEdit|NotebookEdit',
    statusMessage: 'Checking project boundary…',
    script: `#!/usr/bin/env bash
# Floe: confine file edits to the session's own worktree.
#
# A Floe session is spawned with cwd = its worktree (src/main/agent.ts). This
# denies any file-writing tool (Edit/Write/MultiEdit/NotebookEdit) whose target
# path falls OUTSIDE that worktree subtree — so a session opened for project A
# can never edit the files of project B sitting elsewhere on disk. Managed by
# the Floe app (src/main/hooks.ts) — edits here are overwritten on next boot.
set -u

input=$(cat)

# Target path of whichever file tool fired (Edit/Write/MultiEdit use file_path,
# NotebookEdit uses notebook_path).
path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' 2>/dev/null)
[ -z "$path" ] && exit 0

# Session root = the worktree claude was spawned in (stable for the session).
root=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
[ -z "$root" ] && root=$PWD

# Only enforce inside a Floe-launched session.
${DETECT_FLOE}

# Canonicalize lexically (collapses .., joins relative paths onto root) WITHOUT
# requiring the file to exist — new files in not-yet-created dirs must pass too.
# ponytail: lexical only (no symlink resolution); fine for accident-prevention,
# upgrade to realpath -m if a symlink-escape threat ever matters.
abs=$(python3 -c 'import os,sys; print(os.path.normpath(os.path.join(sys.argv[1], sys.argv[2])))' "$root" "$path" 2>/dev/null)
rootp=$(python3 -c 'import os,sys; print(os.path.normpath(sys.argv[1]))' "$root" 2>/dev/null)
[ -z "$abs" ] && exit 0   # python missing → don't block legitimate work
[ -z "$rootp" ] && exit 0

# Inside the worktree subtree → allow.
case "$abs" in
  "$rootp"|"$rootp"/*) exit 0 ;;
esac

# Claude's own infrastructure (memory store, plans, settings, hooks) lives under
# ~/.claude and is NOT "another project" — let it through.
case "$abs" in
  "$HOME"/.claude/*) exit 0 ;;
esac

# Outside → deny and steer to the floe worktree/session flow.
read -r -d '' MSG <<EOF
Blocked: this file is OUTSIDE the project open in this session.

  target:  $abs
  project: $rootp

A Floe session may only edit files inside the worktree it was opened in. Editing another project's files from here is not allowed — that's how the "dash" session ended up altering the "os" project's files.

If you need to work on another project, open a dedicated session in it via Floe (mcp__floe__create_session in the correct worktree) and continue the work there. Do not edit paths outside $rootp.
EOF

jq -n --arg reason "$MSG" \\
  '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
exit 0
`
  },
  {
    filename: 'floe-block-sleep-wait.sh',
    matcher: 'Bash',
    statusMessage: 'Checking wait policy…',
    script: `#!/usr/bin/env bash
# Floe: block a Floe session from sitting on a bare, long \`sleep\` (the
# "wait N minutes then follow up" antipattern) and steer it to
# mcp__floe__create_followup instead — Floe owns the timer and fires the
# follow-up message itself, so the calling turn can end right away instead of
# holding the session open. Only fires on a command that is JUST a sleep (no
# other work chained on it) of 60s or more — a short sleep, or one chained with
# real work (e.g. \`sleep 5 && curl ...\`), is left alone. Managed by the Floe
# app (src/main/hooks.ts) — edits here are overwritten on next boot.
set -u

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$cmd" ] && exit 0

# Only enforce inside a Floe-launched session.
${DETECT_FLOE}

# A command that is nothing but a sleep call — nothing chained before or after.
long=$(python3 -c '
import re, sys
cmd = sys.argv[1].strip().rstrip(";&").strip()
m = re.fullmatch(r"sleep\\s+([0-9]*\\.?[0-9]+)([smhd]?)", cmd)
if not m:
    sys.exit(0)
n = float(m.group(1))
secs = n * {"": 1, "s": 1, "m": 60, "h": 3600, "d": 86400}[m.group(2)]
print("1" if secs >= 60 else "0")
' "$cmd" 2>/dev/null)
[ "$long" = "1" ] || exit 0

read -r -d '' MSG <<'EOF'
Não fique parado num sleep longo para depois conferir outra sessão (ou você mesma/o) — isso segura o turno à toa.

Em vez disso, delegue o waketime ao Floe:
  mcp__floe__create_followup { session_id?, delay_minutes, message }

Sem session_id ele volta pra esta própria sessão. O Floe dispara a mensagem quando o tempo passar — encerre o turno agora em vez de dormir.
EOF

jq -n --arg reason "$MSG" \\
  '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
exit 0
`
  }
]

function hookCommand(h: ManagedHook): string {
  return `~/.claude/hooks/${h.filename}`
}

interface HookEntry {
  matcher?: string
  hooks?: Array<{ type?: string; command?: string; statusMessage?: string }>
}

// Pure so the merge logic is testable without touching ~/.claude. Appends any
// managed hook missing from PreToolUse (matched by command string), never
// touching or reordering entries that are already there — including ones a
// user added by hand. Returns null when nothing needs to change.
export function mergeAgentHook(settings: Record<string, unknown>): Record<string, unknown> | null {
  const hooks = (settings.hooks ??= {}) as Record<string, unknown>
  const pre = (hooks.PreToolUse ??= []) as HookEntry[]
  if (!Array.isArray(hooks.PreToolUse)) return null // malformed — don't touch it
  const present = new Set(pre.flatMap((e) => e.hooks?.map((h) => h.command) ?? []))
  const missing = MANAGED_HOOKS.filter((h) => !present.has(hookCommand(h)))
  if (missing.length === 0) return null
  for (const h of missing) {
    pre.push({ matcher: h.matcher, hooks: [{ type: 'command', command: hookCommand(h), statusMessage: h.statusMessage }] })
  }
  return settings
}

// Idempotently install every managed hook's script + settings.json entry.
// Best-effort; a failure here must never block boot, so every step is guarded
// and swallowed.
export function ensureAgentHookInstalled(): void {
  try {
    const dir = join(homedir(), '.claude')
    const hooksDir = join(dir, 'hooks')
    mkdirSync(hooksDir, { recursive: true })

    // 1) Scripts: write only if missing or stale (also flips the exec bit).
    for (const h of MANAGED_HOOKS) {
      const scriptPath = join(hooksDir, h.filename)
      let current = ''
      try {
        current = readFileSync(scriptPath, 'utf8')
      } catch {
        /* absent */
      }
      if (current !== h.script) atomicWrite(scriptPath, h.script)
      try {
        execFileSync('chmod', ['+x', scriptPath])
      } catch {
        /* non-fatal */
      }
    }

    // 2) settings.json: merge missing PreToolUse entries, preserving everything else.
    const settingsPath = join(dir, 'settings.json')
    let settings: Record<string, unknown> = {}
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    } catch {
      /* missing or unparseable — start fresh rather than corrupt it */
    }
    const merged = mergeAgentHook(settings)
    if (merged) atomicWrite(settingsPath, JSON.stringify(merged, null, 2) + '\n')
  } catch {
    /* never block boot on hook install */
  }
}

// Write via temp + rename so a torn read can never leave the user's global
// config half-written.
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.floe-tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}
