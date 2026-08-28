# Fleet — the agent dashboard (a separate app)

A read-only panel showing **every agent running across every Rookery instance** (Mac + `link`)
and **who is talking to whom**. Built for a small touchscreen sitting under the desk: readable
from across the room, big targets, no hover.

Tap a card → that source's Rookery jumps to that session.

Running prototype (fake data): `prototype/fleet/index.html` — open it straight in a browser.

## Why a separate app and not a Rookery view

One Rookery = one machine. Fleet aggregates N. And the small screen has to keep showing the
panel while the Rookery window shows the session — two surfaces at once.

## How it plugs in (what already exists)

| Needed | Already there | Where |
|---|---|---|
| HTTP with auth, on both targets | the in-process MCP server, port 41573, token in the URL | `src/main/mcpServer.ts`, `src/main/mcpAuth.ts` |
| "who is running right now" | `hasActiveTurn(key)` — state lives in **main**, not the renderer | `src/main/agent.ts:454` |
| sessions / worktrees / projects | `getCreatedSessions` / `listWorktrees` / `listProjects` | `sessionStore.ts`, `git.ts`, `projects.ts` |
| "tap → jump to it" | `select_session` → `pushCommand` → renderer | `mcpServer.ts:628`, `types.ts:782` |
| the agent→agent edge | `send_message` / `ask_codex` carry `callerKey` (caller) + `session_id` (target) | `mcpServer.ts` |

**Do not use the WS bridge in `src/server`.** It is single-active-client by design
(`src/server/index.ts:247`): a second client *supersedes* the Rookery tab and parks it.

## What's missing (the Fleet backend, one file)

`src/main/fleet.ts`, mounted on the HTTP server `mcpServer.ts` already starts:

- `GET /fleet/snapshot` → `{ host, sessions: [{ id, title, project, branch, worktreePath, state, since, lastLine }] }`
  - `state`: `running | waiting | idle | error` — `running` from `hasActiveTurn`, `waiting` from a
    pending permission/AskUserQuestion, `error` from the watchdog.
- `GET /fleet/stream` → SSE. The same events main already pushes to the renderer, filtered down
  to: state changes + every new edge.
- `POST /fleet/focus {sessionId}` → `pushCommand({kind:'select_session'})`. One line.

**The only genuinely new piece: persisting the edge.** Today `send_message` only emits a
transient `McpActivity` (a chip in the UI) and it's gone. Fleet needs an append-only log:

```ts
type FleetEdge = { at: number; from: string; to: string; kind: 'send_message' | 'ask_codex'; preview: string; waited: boolean }
```

An in-memory ring buffer (last ~200) + `fleet.jsonl` in the dataDir. `from` = the MCP token's
`callerKey`, `to` = `session_id`. No new instrumentation in the agents: **all cross-talk already
goes through that one funnel** (the `block-native-agents` hook guarantees a subagent becomes a
Rookery session).

## The wire contract (what the client codes against)

Auth: `?token=…` on every route (also accepted as `Authorization: Bearer`), never the
server's `rk` cookie — the routes answer `Access-Control-Allow-Origin: *`, and wildcard CORS
plus cookie auth is exactly what lets any page in the browser drive them. Token = the
`rookery-token` file in the dataDir (`~/.rookery` on the server, `userData` on the desktop,
created on first use). ⌘K **Copy Fleet source URL** puts `<base>?token=…` on the clipboard.

Mounted on the desktop's MCP server (`http://127.0.0.1:41573`) and on the headless server's
own HTTP server — so `link` is reached at its normal URL (`https://ide.pinguim.io`), not at
41573, which is loopback-only there.

| route | reply |
|---|---|
| `GET /fleet/snapshot` | `{ host, at, sessions: FleetSession[], edges: FleetEdge[] }` |
| `GET /fleet/stream` | SSE — `snapshot` once, then `open`/`state` (a whole `FleetSession`), `close` (`{id}`), `edge` (one `FleetEdge`). `: keepalive` every 20s |
| `POST /fleet/focus` | `{ sessionId }` → `{ ok, raised, focused, message }` |

`FleetSession.since` is when the **current state** began — exact for `running` (the turn's
start) and `error` (the error), first-observed for `waiting`/`idle`, which carry no timestamp
of their own. `live` (a process exists) is separate from `state`. `exists` = the worktree is
still on disk; every session in the store is returned and the client filters.

A tap crosses projects, so the command carries `worktreePath` + `projectPath` and the renderer
switches project first, parking the target in `pendingSessionSelect` — the project-switch effect
lands on it instead of the remembered worktree. Without that, `selectSession()` alone silently
cleared the view (verified live: tapping a `rookery/master` card from the Home workspace landed
on an empty composer). A session whose worktree is gone answers `ok:false` rather than moving
the user nowhere.

`ok` = a live renderer took the select. `raised` = a window actually came forward. They come
apart constantly — on `link` main can't raise anything, and a browser tab ignores
`window.focus()` — so both are reported and Fleet can say "selected, but switch manually"
instead of claiming a jump that never happened. `ok:false` means nothing was selected at all
(no window attached).

Ids are local to an instance; edges carry bare local ids, so the client namespaces them by
source. `from` is the MCP path token, which IS the caller's session id — except the literal
`global`, a `claude` running in a plain terminal under the global MCP registration: they all
share one token, so that end can never resolve to a card. The client drops those edges; the
target end is a real session either way.

**`ask_codex` is a self-edge** (`from === to`). Codex is not a session and the
block-native-agents hook doesn't apply to it: `askCodex` spawns `codex exec` as an inline
subagent of the caller (`codex.ts` emits `subagent-start/progress` on the caller's key, with
no session id anywhere). So there is no second node — the caller is talking to its own
sidecar, and the client badges that one card instead of inventing a phantom.

`usage` (present once the probes have run) is pre-shaped for the footer:
`[{ label: 'CLAUDE', rows: [[name, pct, note?], …] }, { label: 'CODEX', rows: [...] }]`.
Both probes spawn a CLI, so neither ever runs on a request — Claude's rides the topbar's
5-min refresh, Codex's has its own timer (`startFleetUsage`).

## Sources (multi-instance)

Fleet keeps a `{ name, url, token }` list in `localStorage`. e.g. `mac → http://127.0.0.1:41573`,
`link → http://link:41573` (over the tailnet). Each source is an independent SSE; if one drops,
its chip dims and the rest keeps going. `POST /fleet/focus` goes to the source of the tapped card.

### 41573 is not enough: read `<dataDir>/fleet-ports/`

**Never hardcode 41573 as the Mac's only source.** Two desktop instances at once is the normal
shape (one attached to `link`, one local, plus ⌘⇧N), and only the first to boot gets the preferred
port — the second falls back to an ephemeral one. A client pinned to 41573 then draws an empty
board while the other instance's agents run. Observed live: `:41573` = 584 stored / 0 live (the
attached one), `:60755` = 3 running.

So every instance publishes the port it actually bound:

```
<dataDir>/fleet-ports/<pid>   # contents: the port, e.g. "60755"
```

`<dataDir>` is the directory Fleet already reads `rookery-token` from (`~/Library/Application
Support/rookery` on a packaged Mac). Read the whole directory, query every port, ignore the ones
that refuse the connection. There's no cleanup on quit — a crash could never unpublish anyway, so
a dead port is expected; `publishPort()` reaps files whose pid is gone on the next boot.

Sibling instances share that `dataDir`, so they serve the **same session store**: the same rows,
differing only in which ones are `live` in that process. Dedupe by session id and keep the busy
row (`live === true` or a `BUSY` state) — otherwise every session shows up twice, once asleep.

### An attached instance is not a Fleet source for the machine it's attached to

Correct by construction, and a trap: `/fleet/snapshot` always reports **local** state
(`getAllCreatedSessions()`, `hostname()`), even when that window is displaying `link`'s sessions
over the WS bridge. Point Fleet at an attached instance and you get the Mac's store with the Mac's
hostname while the screen shows link's agents — no indication of the mismatch. The Fleet source
for `link` is **link's own server** (`https://ide.pinguim.io/fleet/*`, with link's token — the
token lives on link, so a Mac token gets a 401), never the attached UI.

## UI

Wide, short strip. Three zones:

1. **Header** — source chips (`mac 2·1`, `link 3·1`) with a health dot, filters, clock.
2. **The board** — the session card grid, full width. A card is three lines:
   `● link homelab/caddy-tls` with the elapsed time right-aligned, the title, and the last line of
   work. A pulse bar runs along the bottom while it's working. Tap = focus in Rookery.
3. **Footer** — usage limits (Claude session/week, Codex). Already in `src/main/claudeInfo.ts`,
   `ClaudeInfo.codexUsage` included. Fleet just re-exposes them on the snapshot.

**There is no permanent conversations column.** There was, and it was redundant: the pair list,
the direction, the cross-project mark and the last message were all already on the cards and in
the graph, and it spent 300px of a 1500px panel on 10px text nobody can read from across the room.
The one thing it had that nothing else did — the message text — is now an overlay you open on
purpose.

Filters are chips (`all / working / talking / cross-project / needs you`), no menus.

### Status is a tone, not a sentence

There are four states and they're already spelled out on the filter chips, so the cards don't
repeat them. State reaches you three ways, none of them a word:

- the **left border** of the card (peripheral vision — you see the red one without looking at it),
- a **tinted dot** next to the elapsed time (green working / amber waiting on you / red stalled /
  grey idle),
- the **pulse bar** along the bottom edge while a turn is running.

### Blinking means one thing: it needs you

`waiting` (blocked on a question or a permission) and `error` (watchdog gave up) **blink** — the
whole card breathes between its neutral surface and the tinted one, so it reads from across the
room, not just up close. Nodes in the graph and pills in ambient mode do the same.

Working agents deliberately **do not** blink; they already have the pulse bar. If everything
moves, nothing calls you — blinking is spent on the one state that needs a human.

Those cards also **sort to the front of the grid**, ahead of even cross-project blocks: a card
blinking below the fold calls nobody.

Under `prefers-reduced-motion` the blink is replaced by a solid tinted wash — same loudness, no
movement.

The word survives as the `title` and the accessible name, so hover and screen readers still get
it. Same rule everywhere else: the cross-project strip names the two projects and stops (two
different names *is* the message), and a thread bubble only carries a label when it's `codex` or
`⧗` — the caller is still blocked on that reply. A plain send gets nothing.

### Seeing that two agents are talking

A coloured border doesn't tell the story. Three layers, from most passive to most active:

1. **The pair sits together in the grid, wearing the same border.** While two agents are
   exchanging messages (a 5min window), their cards are emitted back to back and both get a cyan
   border — solid for same-project, dashed for cross-project — plus a small `⇄` marker.

   **A card never changes size.** The first version wrapped the pair in a box that spanned two
   columns and added a header strip and a footer line, so paired cards ended up a different size
   from lone ones and the whole grid went ragged. Every card now reserves 1px of *transparent*
   border, so the colour can appear without moving a pixel, and the grid's rhythm holds whether
   anyone is talking or not.

   Known limit: with an auto-filling grid, a pair can straddle a row break and lose its adjacency.
   The shared border and the right-hand column still tie them together, and the graph view is the
   answer when topology is what you're actually reading.
2. **The block's footer carries the last thing said**, so a glance tells you what the exchange is
   about without opening anything.
3. **The thread**, by tapping the `⇄` bond or pressing `c`: an overlay with the full exchange as
   bubbles — who spoke, whether it was `send_message` or `ask_codex`, and whether the caller
   **blocked waiting for the reply** (`wait=true`), which is the difference between "told them and
   moved on" and "is sitting there waiting". The two participants stay lit while the rest of the
   board dims. `Esc`, the close chip, or a tap outside puts it away.

### Cross-project (and cross-machine) conversations

Every edge has a **scope**, derived from its two ends — no new field:

| scope | when | treatment |
|---|---|---|
| `same` | one project (`caddy ⇄ mysql` in homelab) | normal block, solid outline. Routine. |
| `cross` | different projects, same machine (`life-os ⇄ pinguim`) | **dashed** outline + a strip on top, `● life-os ⇄ ● pinguim — CROSS-PROJECT`, carrying both hues |
| `remote` | different sources (`mac ⇄ link`) | same as `cross`, strip reads `CROSS-MACHINE`, prefixes the source |

The grid **sorts by rarity**: `remote` → `cross` → `same` → alone. A cross-project block floats
to the top without being asked; it's the event you don't want to miss. The `cross-project N`
filter isolates just those.

`remote` can't happen today (each Rookery is an island — `send_message` only reaches sessions in
its own instance). The model already covers it: once `from` becomes `source:sessionId`, the scope
falls into the right bucket on its own and the UI doesn't change.

### Graph view (3+ agents)

A paired block works for two agents and breaks for three. The `⁙` toggle in the header (or `g`)
swaps the card grid for a graph — the card grid stays the default because most of the time you're
reading state, not topology.

- One island per **connected component**, not per pair: `caddy ⇄ billing ⇄ mysql` is drawn as one
  conversation with three nodes. BFS over the adjacency, so 2 and 5 agents take the same path.
- **Deterministic circular layout**, no physics: nodes sorted by id and placed on a ring. On an
  always-on screen, a force simulation that re-settles every few seconds is worse than a layout
  that's merely adequate but never moves.
- Edges are **directional traffic, not undirected links**. Each edge is a dim static rail with
  one **flow line per direction that actually carried a message**, drawn sender → receiver: the
  dashes travel toward whoever received it, and an arrowhead lands on the receiving node. When
  both directions are live, the two streams are nudged onto opposite sides of the rail so you can
  see the exchange going both ways at once.
- Cyan and animated while the direction is live (5min); grey and **still** once it's older, with
  the arrowhead still carrying the direction. A screenshot and a `prefers-reduced-motion` screen
  read exactly the same as the live one, minus the movement.
- Edge **thickness = message volume** for that direction, so there's no number to read. The bond
  in the card view follows the same rule — it used to print the message count, and a bare number
  next to an arrow reads as "5 what?".
- **Dashes mean flow here, and nothing else.** The card view uses dashes for "cross-project"; the
  graph can't, or the two meanings collide. In the graph cross-project reads from the node hue
  dots — two different hues on the ends of an edge *is* the cross-project signal, and unlike a
  per-edge style it keeps working in a trio where one hop is cross and the other isn't.
- **Flat ellipse, not a circle**, and the box is sized from where the nodes actually landed. The
  panel is wide and short, so height is the scarce axis: a circular ring pushed the second half
  of every pair below the fold. A pair collapses to `ry = 0` — side by side, one row tall, and the
  vertical radius is capped by the pane's real height so a five-agent island can't grow past the
  bottom edge.
- **Ring order comes from a depth-first walk, not from the ids.** Sorting by id put unrelated
  agents next to each other and every wire crossed the middle. Walking the adjacency puts people
  who actually talk side by side. Still deterministic — lowest id first, neighbours sorted — so it
  never jitters between renders.

### The treatment: E — HUD + circuit

Chosen from the variants sheet, and applied to **both** views — the card grid and the graph. A
session is one object, so it gets one look wherever it's drawn:

- **Corner brackets, not boxes.** They frame the agent and take their tone from its state (cyan
  working, amber waiting, red stalled, grey idle). They live on the node's wrapper, not on the
  card, because the card's `::after` is already the just-opened ring pulse.
- **Board background** — a dot grid, so the traffic runs on a surface instead of empty black.
- **Straight wires**, no hub. The centre of an island is exactly where the edges have to stay
  legible, and rings there were decoration competing with the traffic.
- **A square packet rides each live wire** via `<mpath>` on the flow path. The dashes give the
  direction; the packet gives it a body. Hidden under `prefers-reduced-motion`.

Consequences worth knowing:

- The card **lost its left border**, which used to be the peripheral state cue. State now reads
  from the bracket tone, the dot next to the elapsed time, the pulse bar, and — for the case that
  matters — the blink. Nothing that needs you got quieter.
- The just-opened ring pulse moved from a pseudo-element onto the `animation` slot (both pseudos
  are brackets now). Safe, because a session that just opened is by definition `running` and never
  blinking — but that's the ceiling: if a card could ever be `fresh` *and* `waiting`, the ring
  would win and the blink would be suppressed for 1.8s.
- **Ambient mode keeps its orbit rings.** They're the whole point of that screen, and it's the one
  place where a big circle isn't competing with traffic.
- **The node is the card.** Literally the same `cardHtml` as the grid view — same project/branch
  line, same title, same last line of work, same state tone, same blink when it needs you. Two
  vocabularies for the same object was the mistake; switching views should change the *layout*,
  not what a session looks like. **Tap a node** = focus that session in Rookery. **Tap an edge** =
  open its thread. (No `1..9` digit on graph nodes: those keys follow the grid's order, and a
  wrong number is worse than none.)
- The islands are **centred** in the pane, horizontally and vertically (`safe center`, so they
  fall back to the top-left corner once they overflow instead of becoming unscrollable).
- The graph looks back **30 minutes**, not 5: a chain that took twenty minutes to play out would
  otherwise show up as disconnected fragments.

The card grid still pairs (a trio renders as two blocks there) — that's what the graph is for.

### Live, not reloaded

The panel is watched, never refreshed, so the DOM is **patched by key**, not rebuilt. Rebuilding
`innerHTML` on every tick was the original sin: every element was brand new each cycle, so
"entering" had no meaning, the attention blink restarted mid-cycle, and a node could never glide
anywhere. Now elements persist and only their changed fields are written.

What that buys, all of it free once identity exists:

- A session that **opens while you're looking** fades in and gets one cyan ring pulse. Often it
  arrives already wired into a conversation, because another agent is what opened it — that's the
  common case in the real system (`create_session` from an agent, then `send_message`).
- A session that **closes** fades and shrinks out instead of vanishing between frames.
- Graph nodes **glide** to their new position when an island's layout shifts, rather than
  teleporting.
- The flow dashes keep their phase: the SVG is only rewritten when the traffic actually changed,
  so the animation doesn't stutter every 3s.
- The blink runs continuously instead of restarting.

Enter/exit uses `@starting-style` + transitions rather than `@keyframes`, because the `animation`
slot belongs to the attention blink and a card has to be able to arrive *and* blink at once.

### Graph treatments — pick one

`prototype/fleet/graph-variants.html` draws the same three agents and the same four directed
edges five ways, so the choice is about the treatment and nothing else:

| | |
|---|---|
| **A · HUD** | corner brackets instead of boxes, faint grid, straight wires, square packets |
| **B · Orbital** | rings and a hub, agents parked on the orbits, arcs that bow around the centre |
| **C · Circuit** | orthogonal traces with vias at the corners, chip-like nodes, board background |
| **D · Neon** | bloom and glow — the reference video's look, and the one that breaks the no-solid-fill rule |
| **E · HUD + circuit** | A's brackets and straight wires on C's board — no hub, the centre of an island is where the traffic has to stay legible |

### Ambient mode

The screen is on all day under the desk, so after ~5min without a touch the panel becomes a fleet
clock: bracketed session pills drifting slowly over the same board, the count in the middle,
`TOUCH TO WAKE`. Readable from far away, moves just enough to be easy on the display, and the
first touch **only wakes** — it never triggers the card that happened to be under the finger.
Honours `prefers-reduced-motion`. `?ambient=1` boots straight into it.

The concentric rings are gone — they were the last circle in the app and they pulled more
attention than the agents orbiting on them. Same board grid and same corner brackets as the other
two views.

**Circuit traces connect the agents that are talking.** Orthogonal routing with a via at each
corner, in the same language as the board underneath. A trace **draws itself on** when a
conversation starts (`pathLength="1"` normalises the length, so the draw-on needs no measuring in
JS), stays cyan while the pair is live, fades to grey after 5 minutes, and carries a packet down
the wire while it's live. The corner's x is a deterministic hash of the pair, not the midpoint —
pairs sit roughly symmetric around the centre, so midpoints fused every vertical leg into one
spine down the middle of the screen.

Geometry is **read back off the pills every frame** (`getBoundingClientRect` in a rAF loop) rather
than computed alongside them. The pills glide over 3s; when the traces used the same tick's
numbers they jumped straight to the destination and spent three seconds ending in empty space. And
the SVG's `viewBox` is re-stated in that same loop — the pill positions are real viewport pixels,
so a stale viewBox silently scales every trace, which is what a resize (or a kiosk that lays out
at one size before getting its real one) used to do.

**Nothing rotates.** The drift comes from moving each pill's `left`/`top` on the 3s tick with a
3s *linear* transition: tick period and transition length match, so the motion is continuous and
every label stays upright. The first attempt spun the container and counter-rotated the labels,
which only holds while every element's animation is in phase — a session that opened after boot
joined the turn mid-way and came out tilted, sometimes upside down. The blink rides the brackets
and the dot rather than the pill, so the label stays readable while it calls you.

Project hue is derived from the name (hash → hue) and shows up only on the dot and the label —
it never fills a card. That keeps `xeneon-edge-agents` and `my-omarchy` distinguishable at a
glance without inventing a new palette entry per project.

## Deliberately left out

- **A force-directed graph.** The circular layout is worse-looking and better-behaved: it never
  re-settles, which matters more than prettiness on a screen nobody is watching continuously.
- **Transcripts in Fleet.** To read, you tap and land in Rookery — that's the whole point.
- **Actions (stop / send a message) from Fleet.** Read-only + focus. Keeps the read token far
  less dangerous and keeps the app stateless.
