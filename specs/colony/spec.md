# Colony — the agent board, one per project

A kanban board where every column is an **agent profile** and every card is a **task
that owns its own worktree**. The board is project-scoped: switching projects switches
boards. The tasks are created by talking to the **nanny**, the board's own session,
which is also who answers "what is holding" across every column.

Mocks — open them, they are the layout this spec describes:

- [colony-panel.html](../../mocks/colony-panel.html) — the board in the lane, with
  the projects panel on one side and the card's chat on the other. Toggles for the
  theme, for collapsed columns, for board focus, and for chat ⇄ nanny.
- [colony-selected.html](../../mocks/colony-selected.html) — every state a card can
  be in, including selected-while-asking, against four ways of drawing the cursor.
- [colony-help.html](../../mocks/colony-help.html) — four ways of marking "needs
  you", kept as the record of what was rejected and why.

## Scope v1

- **In:** the `colony` panel and its board; stages read from config; per-stage caps
  and holding; the four per-task states; the six lane skills; the `nanny` session;
  task creation through the nanny; keyboard navigation with the card's chat
  following the cursor.
- **Later:** what each profile actually does and what context it gets; what makes a
  card advance on its own; archiving and history; anything cross-project.

## The shape

**One task = one worktree.** That is the whole reason the board is project-scoped and
not worktree-scoped: a task needs an isolated tree to work in, so the board sits one
level above and hands each card its own.

**One column = one agent profile.** A profile is a skill, a harness and a model. The
name is a label; those three are the behaviour, which is why the skill and the model
are printed under the column name in the header.

The skill is a **Floe skill**, resolved through `src/main/config/skills.ts` — not a
slash command belonging to some harness. That is the whole reason a lane can pick its
own model: `startTurn` expands the token into the prompt text before dispatch
(`src/main/turn.ts:104`), so one `spec` skill reaches opus, haiku and codex as the
same instructions. A lane naming `/spec` from Claude's own directory would break the
day that lane moves to another harness.

**The border belongs to the cursor; a badge carries the status.** A card can be
selected *and* asking at the same time, so the two marks are never allowed to share
a surface. Selection moves three things together — the border takes the cursor
slate, the surface lifts off the column, and the card's own text comes up a step —
and status rides as a small badge in the card's top row. Any state added later
(failed, stale, blocked on another task) is a badge in that same row, never a
border.

**A column is three bands, and the band is what carries the status** — no card prints
a status word:

| band | means | takes a spot? |
|---|---|---|
| `needs you N` | ran, stopped on a question for you | yes |
| *(unlabelled, the middle)* | an agent is working on it | yes |
| `holding N` | waiting to **enter** this column | no |

A task that finishes `coder` and finds `cleaner` full moves to **cleaner's** holding
band, not to a "done" pile in coder. The jam is drawn at the door it is stuck at, and
the column that caused it is the one showing `1/1`. Holding costs no spot, so a full
stage never freezes the stage behind it.

`inbox` and `done` are the two fixed ends — backlog and exit — and are the only
columns with no cap and no skill.

## Decisions

| # | Decision | Why |
|---|---|---|
| **D1** | New panel kind `colony`, `needsProject`, `order: 20`, `grow`, `min: 900` | It sits left of the session slot, so the card's chat opens to its right. Below ~900px the columns squeeze past reading; the lane scrolls instead. |
| **D2** | Empty columns collapse to a 30px spine | Eight stages at full width is ~1700px and leaves no room for the chat. Collapsed, the whole pipeline fits beside it and a column opens the moment it gets a card. |
| **D3** | The card prints no status word and no progress bar | The column says the stage, the band says the status. Both were tried in the mock and read as the same fact written twice. |
| **D4** | Holding lives in the **destination** column | See above. The alternative — parking it in the source column as "done, waiting" — hides the jam in the wrong place. |
| **D5** | Holding rows are one line: kind, name, diff, place in line | Nothing is running, so there is no elapsed and no token count. The diff is what separates a task an earlier stage worked from one straight out of the backlog. |
| **D6** | The cursor drives the right panel; `⏎` forces it | The chat is `slot: 'session'`, so it replaces rather than stacks. It follows after ~150ms idle so holding `j` does not load a transcript per keystroke. |
| **D7** | ~~`ESC` swaps that same slot to the nanny~~ → **superseded by D33.** The nanny is docked under the board and never swapped away | One session for the board, project-wide, is still right. Sharing the card chat's slot was not: they answer different questions, so opening a card lost the board. |
| **D8** | **No "new task" button.** Tasks are created by asking the nanny | She already has the board's context: base branch, which stage is full, what is queued ahead of it. A dialog would ask for the same things worse. `n` is the keyboard path — it jumps to the nanny with the composer focused. |
| **D9** | Stages come from config, never from code | Order, names, skills and caps are the user's. See below. |
| **D25** | Accent is reserved for "this needs you". The cursor wears `#55688f`, the slate `index.css` already gives a focused `[data-cursor]` | The attention strip, the needs-you band, a blocked card's border and the unread dot are all accent. A cursor in the same tone reads as a card asking to be answered, and the one colour that is supposed to pull your eye stops meaning anything. |
| **D26** | Selection = cursor slate border + lifted surface + a step up in the card's own text. Needs-you = an amber `?` badge in the top row, never a border | One mark alone is not findable across eight columns, and a card that is selected *while* asking has to read as both. A border-based help mark simply disappears under the cursor — visible in `colony-selected.html`, which is why the badge won. |
| **D27** | Cards opt out of `index.css`'s `[data-cursor]::before` | That 2px bar and wash is Floe's mark for full-width list rows, where an edge is the only place to put one. A card already has four borders, so the bar reads as decoration and stacks a second cursor mark on top of the first. The opt-out is required, because the selector is attribute-only and hits anything inside a focused panel. |

## Config — a default that ships, overridden per project

Three layers, each one falling back to the one above it:

1. **Built-in default**, in code. A fresh install has a working colony without anyone
   writing a line of TOML.
2. **`~/.config/floe/floe.toml`** — the user's own default, for every project. Same
   place the rest of the machine-wide settings live (`src/main/config/floe.ts`).
3. **`~/.config/floe/projects/<dir>/colony.toml`** — this project's board. Same
   directory `commands.toml` already uses (`src/main/config/commandStore.ts`).

A stage carries five things. Order is the file's order, and it is the execution order:

| key | required | means |
|---|---|---|
| `name` | yes | the column label, free text |
| `skill` | yes | the **Floe** skill that runs when a task enters the stage |
| `harness` | no | `claude`, `codex`, `opencode`, `gemini`, `lmstudio`, `ollama` |
| `model` | no | the model that harness runs (`opus`, `sonnet`, `haiku`, …) |
| `cap` | no | how many tasks this stage works at once |

```toml
# ~/.config/floe/floe.toml — the default every project starts from
[colony]
cap = 5

[[colony.stage]]
name = "specifier"
skill = "colony-specify"
model = "opus"

[[colony.stage]]
name = "coder"
skill = "colony-implement"
model = "opus"

[[colony.stage]]
name = "qa"
skill = "colony-verify"
model = "haiku"      # a lane that runs the suite does not need opus
```

```toml
# ~/.config/floe/projects/rookery/colony.toml — this project only
cap = 3                # scalars inherit when unset; this one does not

[[stage]]
name = "coder"
skill = "colony-implement"

[[stage]]
name = "cleaner"
skill = "colony-refactor"
cap = 1                # a stage may lower its own cap
```

| # | Decision | Why |
|---|---|---|
| **D10** | The stage **list** is all-or-nothing: a project that declares any `[[stage]]` replaces the inherited list entirely | Patching an ordered list needs identity and position rules ("insert after coder", "drop qa") that nobody can read at a glance. Replacing is one rule and the file shows exactly what the board is. |
| **D11** | **Scalars inherit.** `cap` unset in the project file means the global `cap`; unset there means the built-in | So the common case — same stages, one project that wants a lower cap — is one line, not a copied list. |
| **D12** | `inbox` and `done` are never written in config | They are the ends of any board, not stages. Declaring them would invite deleting them. |
| **D13** | A stage removed from config while tasks sit in it keeps its column, greyed and capped at 0, until it empties | No task may disappear because a config file was edited. The column stops accepting new arrivals and drains. |
| **D14** | Reading never throws; a bad value falls back and lands in `errors` | The same contract `floe.ts` already has, and the reason an agent is allowed to edit these files at all. |
| **D15** | Order in the file **is** the execution order | One fact in one place. A separate `order = 3` key drifts from the file's own order the first time someone edits by hand. |
| **D16** | `harness` and `model` are per stage, and unset falls through to Floe's own session defaults | The whole point of a lane is that it can be cheap: a stage that runs the suite is haiku, a stage that designs is opus, and a review lane can be a different harness entirely so it is not the same model marking its own homework. No second default chain — unset means what a new session would have used. |
| **D17** | `skill` names a Floe skill, resolved in the store's own scope order — project beats global beats built-in | It is what makes the lane's model and harness free to change. It also means a lane is customized per project by writing `~/.config/floe/projects/<dir>/skills/<name>.md`, with no board config touched at all. |
| **D18** | The built-in default board (config layer 1) references **built-in** skills, shipped in `builtinSkills.ts` | Layer 1 has to work on a fresh install. A default board pointing at skills the user has not written yet would be a board that cannot run. |
| **D19** | A stage whose skill does not resolve **holds its tasks and starts nothing**, with the error in Settings | The alternative is sending the literal `/spec` to a harness that has never heard of it, which produces a confident answer to the wrong question. Failing closed is cheaper than an agent guessing. |

## The lanes

Six skills, drafted in [skills/](skills/), all six built-in (D18). They are Floe
adaptations of DevSquad's `ds-*` toolkit (`/Users/r2luna/code/02.ds/00.projects/os`)
and of Rookery's implementation pipeline
(`src/renderer/src/workflow/Pipeline.ts`), which had already made them
self-contained: inline instructions rather than `/ds.*` commands, one clean
session per step, and the hand-off entirely on disk.

| lane | skill | model | does |
|---|---|---|---|
| specifier | `colony-specify` | opus | spec.md, plan.md, tasks.md. Writes no code. |
| coder | `colony-implement` | opus | Executes tasks.md, tests first, commits. Deliberately does not widen. |
| cleaner | `colony-refactor` | opus | Rookery's `refactor` step: one better data structure, or an honest `skip`. |
| architect | `colony-architecture` | sonnet | Placement, boundaries, conventions — then runs every lint/typecheck/build gate the project has. |
| hardener | `colony-review` | opus | Rookery's `review` step, moved onto the code: adversarial review with a second opinion from another harness. |
| qa | `colony-verify` | haiku→sonnet | The suite, the gates, and driving the real app against the spec's acceptance criteria. |

Three things the manual toolkit did not have to solve, and this one does:

- **[LANE-CONTRACT.md](skills/LANE-CONTRACT.md)** — the preamble the colony
  prepends to every lane skill. Fresh session, where the artifacts live, the
  conventions doc, autonomy, and the hand-off line. Written once because there is
  no human between two lanes to carry it.
- **The hand-off line.** A lane ends its last message with `COLONY: pass`,
  `COLONY: return <lane> — <why>`, or `COLONY: stop — <why>`. That single line is
  what the board parses to move a card, which is the concrete answer to Q2.
- **Asking is a board state.** DevSquad's skills ask the user freely. Here an
  `AskUserQuestion` parks the whole task in `needs you` and burns a spot, so
  every lane's contract sets the bar high and says so.

| # | Decision | Why |
|---|---|---|
| **D20** | `specifier` writes spec **and** plan **and** tasks | Rookery spends four steps there (specify, clarify, plan, tasks). One lane keeps the board readable, and if it turns out too big for one turn, splitting it is one `[[stage]]` in config — which is the whole point of lanes being configuration. |
| **D21** | Only `coder` writes product code. Every later lane fixes small and local, or returns | A review turn that redesigns someone else's change is a second implementation with no plan behind it. |
| **D22** | `hardener` gets its second opinion by running `codex exec` from Bash | `ask_codex` is Rookery's tool and does not exist here. The CLI does, and it works from any harness's session. |
| **D23** | A `return` is drawn as a second visit, not as a fresh arrival | A task bouncing coder → architect → coder twice is the signal that something is wrong with the task, not with the lane. The card's `✓N` already counts passes. |
| **D24** | **Only `specifier` may ask the user anything.** Every lane from `coder` on is forbidden to, and hands the card back instead | By the coder lane the decisions are already on disk, so a question is asking a human to re-decide something written down. Returning the card says the same thing without interrupting anyone: it is visible on the board, it carries a reason, and it does not hold a spot. `specifier` keeps the licence because it is the lane where the work is still being decided — batched, three at most, recommendation first. |
| **D28** | **One session per STEP, not per task.** Each stage mints its own session in the task's worktree, titled `<task> · <stage>`; the card's `⏎` opens the step running now (or the last one that ran), and each visit records the session it ran in | It is what LANE-CONTRACT already promises every lane: a new session with no memory of the ones before it. Sharing one session across stages handed the coder the specifier's whole conversation, so the hand-off stopped being the artifacts on disk and became whatever was still in the transcript. It also keeps a lane's context to its own step instead of five steps it never needed. The earlier sessions stay in the worktree's session list, which is where a finished lane's transcript belongs. |
| **D29** | **A dependency is declared, and it gates RELEASE.** `dependsOn` carries task ids; a card with an unmet one stays in the backlog with `queued` set, and is released automatically the moment the last of them merges | Gating the lanes would be too late: once both worktrees are cut, the second is already built on a base missing the first, and no scheduling fixes that afterwards. A backlog card costs nothing, which is what makes waiting free. Declared rather than derived, because the manager knows two changes touch the same code *before* either has a tree — by the time a file overlap is visible the sequencing decision is already lost. A dependency id nobody recognises is dropped, not waited for: a card taken off the board would otherwise park everything behind it forever. |
| **D30** | **A card reaching `done` merges itself**, unless `automerge = false`. `colony_merge_task` is the same thing on demand | `mergeWorktree` is the safe one-shot — it refuses on a dirty tree, a dirty main worktree or a conflict, and leaves the branch exactly as it was. Every way it can fail is a `warn` on the card rather than a half-merged branch, so "merge it" needs no judgement and asking would only add a click. Merging is also the only thing that satisfies a dependency, so it is the only place the queue behind one can move. `automerge = false` is the kill switch for a board where you read the diff first. |
| **D31** | **The board wakes the nanny; she is never minted to be woken.** A card reaching `done`, stopping, or returning to a lane nobody has buffers a note and starts one turn in her existing session — after a 250ms beat, and never while she is mid-turn | She is the manager, so the events that need a decision should reach her rather than waiting to be noticed. Buffered because five lanes finishing inside a second is one thing to say, not five turns that each re-read the same board; parked behind an active turn because interrupting her would answer a question nobody asked and lose the one they did. Only an existing nanny, for the same reason `colony:nanny` leaves the opener to the renderer: minting her here would start a chat talking to a panel that is not on screen. |
| **D32** | `colony_conflicts` reports live worktrees changing the same files, grouped by the tasks that share them — and is never folded into the board | It is the net *under* D29, not a replacement: both trees already exist by the time it can see anything, so it reports a collision instead of preventing one. Worth having anyway — the alternative is finding out at the second merge. Kept out of `boardFor` because it runs git in every worktree, and the board is read on every card move. |
| **D33** | **The nanny is her own panel kind, docked below the board** (`order` 21, `slot: nanny`), and the card chat keeps the session slot | She is about the WHOLE board and a card's chat is about one card. Under D7 the two shared a slot, so every `⏎` on a card took the board's own session off screen — which is exactly the complaint that "I need the manager open to see what is happening" is making. Docking is not a new mechanism: `dock: 'below'` already exists with `⌘K /` and `⌃J/⌃K`, and it puts a panel in its left neighbour's column, which is what makes `order` 21 land it under the board. Docked only by DEFAULT — `open` hands a replacement the outgoing panel's layout, so a height you dragged is a height you keep. |
| **D34** | **The board log**: every unasked-for action is an event in `colony-events.json`, drawn above the nanny's chat with a rule down its left edge and the verb first | A merge that lands on your base branch while you are reading something else is only acceptable if it is written down and reversible. The nanny's transcript is not that record — she summarises, she is asked things out of order, and her turn can fail. An event is a fact with a timestamp, and it is deliberately shaped so it cannot be mistaken for something she said. |
| **D35** | A `merged` event carries the base branch and where it pointed **before and after**, and its row offers an undo that **refuses once base has moved on** | Both commits, not just the old one: resetting past whatever landed after the merge is not an undo, it is a second accident — and the board merges on its own, so the gap between the merge and the undo is exactly the gap another lane can finish in. The branch is moved, not reverted, so the work stays on the task branch: this un-lands it rather than deleting it. |
| **D36** | `automerge` is stated on the board and switchable from it — the one config value Floe writes for you | A kill switch you have to find in a TOML file is not a kill switch. It is also the only setting whose value has to be *visible*: cards landing on your base branch by themselves is not something you can have agreed to without being told. The strip says it in prose rather than wearing an icon, because "automerge" as a glyph tells you nothing. The key is written ABOVE the first `[[stage]]` header — TOML scopes a bare key to the table above it, so the same line at the bottom of a file with stages silently becomes `stage.automerge`: a value nothing reads, on a board that carries on merging. |
| **D37** | Every log row offers only actions that are REAL, and `show what is uncommitted` is offered on a refusal but never on a merge | A dead affordance in the one panel whose job is being trustworthy costs more than a missing one. After a merge the branch and base agree, so the changes panel would open empty and read as "nothing landed" — the honest place for it is the refusal, where uncommitted work in the lane's tree is usually the reason. `hold it again` on an auto-release parks the card and KEEPS its worktree: cutting it was the expensive part and a lane may already have run in it. |

## Still open

- **Q1** — what each profile does, what context it gets, and how it hands off.
- **Q2** — ~~what advances a card~~ → the `COLONY:` hand-off line above. Still open:
  what happens when a lane's turn dies without one, beyond "pass with a warning".
- **Q3** — where per-task state lives (which stage, how many passes, its history).
- **Q4** — does a task ever move backwards, and does the board show that it did.
