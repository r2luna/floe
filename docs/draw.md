# Draw — the Excalidraw panel

A whiteboard as a native Floe panel. The drawings are files in the worktree, and
an agent can open and draw in one over MCP — architecture diagrams, flows and
plan sketches made four-handed with the chat.

Two panel kinds, mirroring `plans` + `file`:

| Kind | What it is |
|---|---|
| `draw` | The list. Rail icon, `⌘K D`, `needsProject`. |
| `drawing` | The canvas. Contextual — you reach it by picking a row, never from the rail. |

## Where drawings live

The same two sources the plans panel reads, and the same branch→folder match
(`listSpecFiles` in `src/main/plans.ts`, shared by both):

- `.floe/draw/*.excalidraw` — gitignored scratch.
- `specs/<branch-ish>/*.excalidraw` — versioned beside the spec it illustrates.

`draw.new` reads which one it writes into off the row the cursor is on: a row
from a spec folder makes another drawing in that folder, anywhere else makes a
draft. The prompt says which before you type.

## The write contract

**Two writers share one file** — the user's canvas autosaves while an agent
writes over MCP — so the rule is that *nobody writes a whole scene*. Both sides
send a `DrawDelta`, which is a set of complete elements, and the main process
merges them:

```ts
export interface DrawDelta {
  upserts: DrawElement[]
}
```

`mergeElements(scene, delta)`, in `src/main/draw/index.ts`, is the only rule:
per element id the higher `version` wins, a tie is broken by the higher
`versionNonce`. That is exactly the reconciliation Excalidraw's own
collaboration uses, so the numbers that decide already arrive correct from the
canvas.

There is deliberately **no `deletedIds`**. Erasing is `isDeleted: true` with a
bumped `version` — an upsert like any other, so a removal and a concurrent edit
are compared the same way any two edits are. A list of bare ids would carry no
version, and main would have to invent one, letting a stale removal beat a newer
edit.

Tombstones stay in the file so a later merge can still see that the removal is
the newer fact; `applyDelta` drops the ones `isDeleted` for more than 24h, so
the file stops growing while the reconciliation window stays far wider than any
live canvas.

### Why applyDelta is synchronous

`applyDelta` is `readFileSync` → merge → `writeFileSync` → `renameSync`, with no
`await` anywhere in it. That is what serializes the two writers: the renderer's
IPC handler and the MCP tool run on the same main-process event loop, so a
function that never yields cannot interleave with itself. Split the read from
the write with an await and both callers would read the same scene, and the
second write would erase the first's elements. tmp+rename is a separate concern
— it stops a crash mid-write leaving half a JSON file, and does nothing about
lost updates.

Two Floe **instances** on one worktree are outside the contract, as they already
are for `sessionStore` and `plans`.

The same rule runs in reverse in the panel: `updateScene({ elements })` replaces
the whole set and would erase whatever the user drew in the last 600ms, so
`DrawingPanel` applies the disk delta *over* the elements the canvas holds right
now — by the same version comparison — and only then calls `updateScene`.

## Elements are written complete

`src/main/draw/skeleton.ts` expands the agent's shorthand into a full Excalidraw
element: seeds, version, defaults, a bound text child for a `label`, real
`startBinding`/`endBinding` plus computed `points` for an arrow. A `.excalidraw`
that only renders after Excalidraw's own `restore()` has patched it is not a
valid file — it would not open on excalidraw.com, and the whole premise here is
that the drawing is a file anything can read.

An arrow naming a shape that is not in the scene is an **error**, not a loose
arrow: the agent is told which id was wrong and rewrites the call.

### Captions are wrapped before they are written

A caption bound in a shape is clipped to that shape when it is drawn, so a line
wider than its box opens missing its first and last words — the failure you see
before anything else. Excalidraw wraps for itself, but only inside `restore()`,
which is exactly the patching a file Floe wrote must not need. So `skeleton.ts`
wraps: `text` lands already broken into lines that fit the box minus a 14px
margin on each side, `originalText` keeps the caption as the agent wrote it, and
the canvas re-wraps from that on the first edit.

That margin is wider than Excalidraw's own `BOUND_TEXT_PADDING` of 5, which is
what the canvas re-wraps to once a caption is edited there. Deliberately: a line
ending three pixels short of the border reads as crowded. Wrapping tighter than
the canvas would is the safe direction — the canvas only ever finds more room
than Floe assumed, never less.

The box then grows **down** to fit the lines. Growing it sideways would widen
one column of a layout the agent computed, and leaving it short would clip the
last line — the same eaten text, one axis over. A word too long for the line is
broken mid-word, which is what the canvas does with it too.

A diamond only gets half its box for a caption and an ellipse `1/√2` of it —
Excalidraw's own `getBoundTextMaxWidth` — so the wrap and the growth both go
through `usable(type)`. Wrapping a diamond to its full width draws the top and
bottom lines outside the slanted sides, which is what the first pass did.

An arrow's caption is never wrapped: an arrow's `width` is the span between two
boxes, and wrapping to it turns "enqueue" into a column of letters on any arrow
that runs mostly vertically.

## Keyboard

Everything around the canvas is the `PlansList` pattern: `⌘K D` opens the list,
`j`/`k` walks it, `⏎` opens, `n`/`r`/`d` create, rename and delete, `o` reveals
the file on disk, `/` filters.

Inside the canvas, Excalidraw's own keymap applies (`r` `o` `d` `a` `t` `v`,
`⌘Z`, `⌘⇧E`). For those to reach it, Floe has to stop eating bare keys — that is
the third key context, `raw`:

- `DrawingPanel` marks its root `data-raw-keys` and focuses the canvas inside it.
- `App.tsx` computes `raw = !!active?.closest('[data-raw-keys]')`.
- `resolveIn` (`src/shared/keymap.ts`) resolves **only chords with a modifier**
  while `raw` is on.
- `App.tsx` runs its key handler in the **capture** phase while `raw` is on, and
  in the bubble phase otherwise. Excalidraw stops propagation on some of the
  chords it claims — `⌃H` among them — so a bubble-only listener never sees the
  press, and `⌃H` is half of how you leave the canvas. Going first is safe here
  precisely because `raw` narrows resolution to modifier chords: a letter, or
  text typed into the canvas, resolves to nothing and falls straight through.

The rule is positional — read off the chord — rather than a `not raw` written
onto each bare binding. `{ key: 'escape', command: 'composer.leave', when:
'typing' }` names `typing`, so it escapes the implicit `not typing` and would
escape a `not raw` too; inside Excalidraw's text editor `typing` and `raw` are
both true, and Escape there belongs to the canvas, not to a blur.

What survives `raw` is what gets you out: `⌃H`/`⌃L`, `⌘K`, `⌘1`–`⌘9`, `⌘W`.

## Opening one

Three ways in, all landing on the same canvas:

- The **draw** panel's list (`⌘K D`, `⏎` on a row).
- The **files** tree and `⌘P`: a `.excalidraw` row opens a `drawing` panel, not
  the reader — the reader would show you the JSON, which is nobody's idea of
  opening a drawing. One helper, `panelForFile` in `panels.tsx`, decides that for
  every caller so the tree, `⌘P` and the search hits cannot disagree.
- An agent writing to one (see the MCP section — the panel opens itself).

There is no save action, because there is nothing to save: a drawing is written
the moment it is made and autosaved every 600ms, so it exists on disk from its
first stroke and reopens exactly as you left it.

**Where it lands.** `specs/<branch>/`, by default and on purpose — a drawing is
part of the work, so it travels with the branch and turns up in the commit
rather than sitting in a scratch directory nobody reviews. The branch is
discovered from `.git` when the caller does not name one (synchronously, since
`createDrawing` must not yield — see the write contract), so `scope: 'spec'` is
something an agent can ask for without first looking up where it is.

`scope: 'draft'` is the escape hatch: the gitignored `.floe/draw/`, for a
scribble that should not reach a commit. `draw.promote` (`s`, or the
`promote_drawing` tool) moves one of those into the project afterwards, and the
canvas follows it to its new path. A move, not a copy — two homes is how the
version in the commit and the one you keep editing quietly drift apart. A name
already taken at the destination is refused rather than overwritten.

Drafts live in `.floe/draw/`, which `listDir` shows (it only hides `.git` and
`.worktrees`), so they are reachable from the files tree as well as from the draw
panel. `⌘P` is git-backed and skips them, which is right: a gitignored scratch
drawing is not one of the project's files.

## Layout

The `drawing` panel is framed like every other one — card, border, header with
the drawing's name — and Excalidraw's own toolbar floats inside that frame. Its
`.panel-body` drops its padding rather than cancelling it with the terminal's
negative margin: a negative bottom margin does not stretch a `height: 100%` box,
so the canvas came up 8px short and left a seam above the card's edge. The body
also clips, because the canvas paints edge to edge and `.panel` rounds its
corners without hiding overflow.

## The font

The canvas draws in Floe's own face, not Excalidraw's handwritten one. Its font
list is closed — an element's `fontFamily` is a number into a fixed table — so a
font of ours cannot be added to it. What can be done is re-point the family it
draws with by default: text goes to a `<canvas>` via `ctx.font`, which resolves
against `document.fonts` at draw time, so `useAppFont` (in `DrawingPanel.tsx`)
replaces the registered face and calls `api.refresh()`.

The replacement's `src` follows `[appearance] font-family` from floe.toml
through the `--mono` variable appearance.ts sets: `local(…)` for the first family
in the stack, which resolves when the configured font is installed on the system,
then `url(…)` for the bundled face, which resolves on the default. Excalidraw's
chrome follows through CSS instead — `--ui-font: var(--mono)` on the container.

Only the default family is re-pointed, so the other entries in Excalidraw's font
picker keep their own faces and choosing one there still means something. If a
future Excalidraw renames that family the override quietly stops applying and
the canvas goes back to its own font, which is the right failure for a cosmetic
override of a dependency's internals.

## Two things the canvas insists on

Both were found by driving the real app, and both look like they work until you
try to use them:

- **Focus goes on `.excalidraw-container`, not on the wrapper.** Excalidraw's key
  handler is on `document` but ignores anything that happens while focus is
  outside its own container. Focusing the wrapper turns `raw` on (so Floe stops
  eating keys) and yet `r` still draws nothing — the worst of both.
- **The canvas is drawn `transparent`, not in a theme colour.** Excalidraw
  renders the canvas and then inverts it in dark mode, so any colour handed to
  `viewBackgroundColor` comes out as its opposite. Drawing nothing there lets
  the panel's own `--panel` show through, which follows the theme for free and
  leaves no second colour to keep in sync. View only: the FILE keeps the white
  background `createDrawing` wrote, so the drawing still opens on a sane canvas
  in excalidraw.com.

## MCP

Seven tools in `registerTools()` (`src/main/mcpServer.ts`), all main-process
except `open_drawing`:

| Tool | What it does |
|---|---|
| `list_drawings(worktree, branch?)` | The worktree's scenes, with element count and mtime. |
| `read_drawing(worktree, path, raw?)` | The semantic summary; `raw: true` for the JSON. |
| `create_drawing(worktree, name, scope?, branch?)` | An empty valid scene, `draft` or `spec`. |
| `draw_elements(worktree, path, elements)` | Skeletons → complete elements → `applyDelta`. |
| `erase_elements(worktree, path, ids)` | Marks `isDeleted`, bumps `version`, upserts. |
| `move_elements(worktree, path, moves)` | Reposition without redrawing (which would drop the user's edits). |
| `promote_drawing(worktree, path, branch?)` | Moves a draft into `specs/<branch>/`. |
| `open_drawing(worktree, path)` | Round-trip to the UI: opens the canvas. |

**The panel opens itself.** `create_drawing`, and the first write to any given
drawing, push `open_drawing` without being asked — drawing is meant to be
watched, and leaving that to the agent remembering a second tool call made it a
coin flip. Only the first write per file: `open` re-focuses a panel that is
already there, and stealing focus on every stroke would make the chat unusable
while a diagram is being drawn. `open_drawing` called explicitly is still
unconditional, which is how you bring back a panel the user closed.

The skeleton an agent writes — only what carries meaning:

```jsonc
{ "id": "db", "type": "rectangle", "x": 100, "y": 100, "width": 200, "height": 80,
  "label": "Postgres", "strokeColor": "#1971c2", "backgroundColor": "#a5d8ff" }
{ "id": "e1", "type": "arrow", "start": "api", "end": "db", "label": "query" }
```

And what `read_drawing` gives back — a 40-element scene is ~60KB of JSON and
~40 lines of this:

```
rect  api  (100,100 200×80)  "API"        → e1 "query" → db
rect  db   (400,100 200×80)  "Postgres"
text  n1   (100,220)         "TODO: cache"
```

## Build

- `@excalidraw/excalidraw` is pinned exactly, not `^`: `skeleton.ts` writes the
  library's internal element shape and the merge reads its `version`/
  `versionNonce`, so a minor bump is a format question, not a patch.
- `electron.vite.config.ts` defines `process.env.IS_PREACT` — the package reads
  it at module scope to choose its React bundle.
- `scripts/copy-excalidraw-assets.mjs` (postinstall) copies 234 woff2 files into
  `src/renderer/public/excalidraw/fonts`, and `index.html` points
  `window.EXCALIDRAW_ASSET_PATH` at them. Without it the canvas fetches fonts
  from a CDN, which a desktop app offline cannot do. They are gitignored — they
  belong to the dependency.
- The canvas is imported through `lazy()`, and its stylesheet inside
  `DrawingPanel.tsx`, so a session that never opens a drawing pays nothing.
