#!/usr/bin/env bash
# Finish bootstrapping the Fleet repo and push it to git.pinguim.io.
#
# Why this is a script instead of me just doing it: this Rookery session is opened
# in the rookery worktree, and the confine-edits hook (correctly) refuses writes to
# another project's files. Run this from anywhere:
#
#   bash scripts/bootstrap-fleet.sh
#
# It is idempotent up to the first commit: it will refuse to clobber an existing
# git repo.
set -euo pipefail

FLEET="${FLEET_DIR:-$HOME/code/01.r2luna/01.projects/fleet}"
REMOTE="ssh://git@git.pinguim.io/r2luna/fleet.git"

[ -f "$FLEET/index.html" ] || { echo "no index.html in $FLEET — run the copy step first"; exit 1; }
[ -d "$FLEET/.git" ] && { echo "$FLEET is already a git repo — stopping"; exit 1; }

mkdir -p "$FLEET/tools"

cat > "$FLEET/.gitignore" <<'EOF'
.DS_Store
node_modules/
EOF

cat > "$FLEET/README.md" <<'EOF'
# Fleet

A read-only dashboard for every Claude agent running across every Rookery instance,
and for the conversations between them. Built for a small touchscreen that sits on
the desk all day: readable across the room, big targets, no hover.

Tap a card and the Rookery on that machine jumps to that session.

## Run it

    open index.html

No build step, no dependencies. It is one HTML file on purpose — the whole app is
a board, a graph and an overlay, and a bundler would not have earned its keep yet.

    index.html?view=graph     boot into the graph view
    index.html?ambient=1      boot into the resting screen

The committed data is eight synthetic sessions. To see your real board:

    node tools/seed-from-store.mjs        # reads the local Rookery session store
    git checkout index.html               # put the demo data back

Real session titles carry client names, branch names and pasted prompts, so they
are regenerated locally and never committed.

## Status

The UI is real; the data is not yet. Fleet expects three endpoints on each Rookery
instance, which do not exist yet:

    GET  /fleet/snapshot   every session, with state and last line
    GET  /fleet/stream     SSE: state changes and new conversation edges
    POST /fleet/focus      { sessionId } -> that Rookery selects the session

They belong on the HTTP server Rookery already runs for its MCP endpoint (port
41573, token auth, present on both the desktop and headless builds). The only
genuinely new piece is persisting the agent-to-agent edge: today `send_message`
emits a transient signal and it is gone.

See [docs/design.md](docs/design.md) for the full design, the reasoning behind each
decision, and the parts deliberately left out.

## Layout

    index.html                    the app
    docs/design.md                design + what to build on the Rookery side
    design/graph-variants.html    the five graph treatments, side by side (E won)
    tools/seed-from-store.mjs     reseed from a real Rookery store, locally
EOF

cat > "$FLEET/tools/seed-from-store.mjs" <<'EOF'
#!/usr/bin/env node
// Reseed index.html from a real Rookery session store, so the board shows your
// actual sessions instead of the demo eight.
//
//   node tools/seed-from-store.mjs [path/to/sessions.json]
//
// This is a script rather than committed data on purpose: real session titles
// carry client names, branch names and pasted prompts. Regenerate locally, never
// commit the result.
//
// The states are synthetic. The store has no live/idle flag — that comes from
// hasActiveTurn() in Rookery's main process, which is what the real
// GET /fleet/snapshot will report. See docs/design.md.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { basename, join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const STORE = process.argv[2] ||
  join(homedir(), 'Library/Application Support/Rookery/sessions.json')
if (!existsSync(STORE)) { console.error(`no session store at ${STORE}`); process.exit(1) }

const store = JSON.parse(readFileSync(STORE, 'utf8'))
let roots = null
const projectsFile = join(dirname(STORE), 'projects.json')
if (existsSync(projectsFile)) {
  const raw = JSON.parse(readFileSync(projectsFile, 'utf8'))
  roots = (Array.isArray(raw) ? raw : raw.projects || []).map((x) => x.path || x)
}

// The store outlives the worktrees: removing a worktree leaves its sessions behind.
// Keep only what still exists on disk and belongs to a registered project — the
// same set Rookery's own list_sessions returns.
const alive = (store.created || []).filter((s) =>
  existsSync(s.worktreePath) && (!roots || roots.some((r) => s.worktreePath.startsWith(r))))

const LAST = {
  running: 'Working the current turn',
  idle: 'Turn finished',
  waiting: 'Blocked on a question',
  error: 'Turn stalled (watchdog)'
}

const sessions = alive.map((s, i) => {
  const cut = s.worktreePath.indexOf('/.worktrees/')
  const root = cut < 0 ? s.worktreePath : s.worktreePath.slice(0, cut)
  // Deterministic spread, so a rerun doesn't reshuffle the whole board.
  const state = i % 47 === 26 ? 'error' : i % 31 === 12 ? 'waiting' : i % 9 === 3 ? 'running' : 'idle'
  return {
    id: 'r' + i, src: 'mac',
    project: basename(root),
    branch: cut < 0 ? 'master' : basename(s.worktreePath),
    title: (s.title || 'Session').slice(0, 42),
    state, age: ((i * 137) % 90 + 1) * 60000, last: LAST[state]
  }
})

const working = sessions.filter((s) => s.state === 'running').map((s) => s.id)
const talks = []
for (let i = 0; i + 1 < Math.min(working.length, 8); i += 2) {
  talks.push({ from: working[i], to: working[i + 1], ago: 40 + i * 45 })
}

const block =
  `// Seeded by tools/seed-from-store.mjs — ${sessions.length} real sessions.\n` +
  `// Do not commit: real titles carry client and project names.\n` +
  `const SESSIONS = [\n` +
  sessions.map((s) =>
    `  { id:'${s.id}', src:'${s.src}', project:${JSON.stringify(s.project)}, ` +
    `branch:${JSON.stringify(s.branch)}, title:${JSON.stringify(s.title)}, ` +
    `state:'${s.state}', since:Date.now()-${s.age}, last:'${s.last}' },`).join('\n') +
  `\n];\n\nconst TALKS = [\n` +
  talks.map((t) =>
    `  { at:Date.now()-${t.ago * 1000}, from:'${t.from}', to:'${t.to}', ` +
    `kind:'send_message', preview:'seeded edge' },`).join('\n') +
  `\n];\n\nconst CHATTER = [\n  'seeded chatter',\n];`

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html')
const html = readFileSync(file, 'utf8')
const start = html.search(/\/\/ (Demo data|Seeded by)/)
const end = html.indexOf('];', html.indexOf('const CHATTER')) + 2
if (start < 0 || end < 2) { console.error("couldn't find the data block in index.html"); process.exit(1) }
writeFileSync(file, html.slice(0, start) + block + html.slice(end))
console.log(`seeded ${sessions.length} sessions — this edit is local, \`git checkout index.html\` restores the demo`)
EOF

cd "$FLEET"
git init -b master >/dev/null
git add -A
git commit -q -m "Fleet: agent dashboard prototype

A read-only board for every agent across every Rookery instance, and for the
conversations between them. One HTML file: card grid, graph view for
conversations with three or more agents, and an ambient screen for when nobody
is looking.

The backend it expects (/fleet/snapshot, /fleet/stream, /fleet/focus) does not
exist yet; docs/design.md has the plan and the reasoning."

git remote add origin "$REMOTE"
echo
echo "Committed. Pushing to $REMOTE …"
if git push -u origin master 2>/tmp/fleet-push.err; then
  echo "pushed."
else
  echo
  echo "Push failed — the repo probably does not exist yet and push-to-create is off:"
  sed 's/^/    /' /tmp/fleet-push.err
  echo
  echo "Create it once at https://git.pinguim.io/repo/create (name: fleet, private),"
  echo "then:  cd $FLEET && git push -u origin master"
fi
