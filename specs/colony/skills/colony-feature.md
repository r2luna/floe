---
name: colony-feature
description: Take a whole feature from idea to merged code — design it as an HTML prototype on the app's own design system, split it into dependency-ordered colony tasks, then run the board to the last merge without the user.
---

# Building a feature on the colony board

You take a feature — a new module, a set of screens, anything too big for one
task — from "I want X" to the last merge. Three phases, and each one ends on the
user's explicit approval. Nothing moves to the next phase without it.

1. **Design** — interview, then a clickable HTML prototype on the target app's
   real design system, iterated with the user in the browser.
2. **Plan** — the prototype split into tasks with dependencies, and a default
   for every open question.
3. **Run** — the tasks on the board, driven to the last merge without the user.

You write no product code, ever. The prototype and the plan are yours; the code
is the lanes'. Everything you write is in English, whatever language the user
asks in.

## Phase A: Design

### A1. Read the design system before drawing anything

Facts are yours to find, never the user's. Before the first question, read:

- the CSS tokens and fonts (colours, radii, spacing, type scale);
- the layout and the sidebar/navigation component;
- one or two existing module pages, the closest siblings of what is being built;
- how navigation groups and permissions are registered;
- the reusable components a feature like this would use — editors, comments,
  attachments, installers, whatever the app already has.

Dispatch sub-agents for the slow facts and keep going while they run.

### A2. Interview in rounds

Use the round format of `colony-add-task`: the whole frontier of open decisions
at once, each numbered `Q1…Qn` with your recommended answer, then stop and wait.
Grill scope, observable behaviour in every state (empty, error, slow), data,
permissions and edge cases. A question the repo can answer is not asked.

### A3. The prototype

One self-contained HTML file, committed later into the feature's parent branch:

- `specs/modules/<feature>/design/<feature>.html` when the project already has
  `specs/modules/`, otherwise `specs/<feature>/design/<feature>.html`.
- Tailwind from its browser CDN with the app's real tokens pasted into `@theme`,
  and the app's icon set (Lucide when it has none of its own).
- A sidebar that mirrors the real app, with the new navigation group in place.
- A top toolbar: one link per page (`P0…Pn`), a design-notes toggle and a
  dark-mode toggle.
- Hash routing: each page is its own `section[data-page]`.

**P0 is the overview:** page map; lifecycle and status flow; enums; data model;
module file layout, copied from an existing sibling module; the full permission
catalogue and a role matrix in the project's own format; guardrails; and the
open questions, `Q1…Qn`.

**One page per screen,** with realistic sample data taken from the user's own
examples — never lorem ipsum.

**Surfaces without a screen get a page too:** each MCP tool with the permission
it needs and a sample chat; skills; a "how to set up and use it" guide.

**Design notes** are yellow dashed boxes coded `F1…Fn`, placed on the page they
are about. They record decisions, reuse of existing code, and edge cases. A
toggle hides them all.

### A4. Iterate in the browser

Open the file with `open_browser` (`file://<absolute path>`) and take a
screenshot after every change — look at it before you say anything about it.
When the user adds a requirement midway, update every page it touches and add
the new `F` and `Q` codes; never leave one page describing the old design.

Answer feasibility questions from sources: the vendor's documentation, and
precedent already in the repo. Say where the answer came from.

**Gate:** the user approves the design. Ask, and wait.

## Phase B: Plan

### B1. Split the design

In dependency order:

1. **Foundation** — data model, enums, permissions, navigation, the skeleton.
2. **Parallel branches** — tasks that do not touch the same files, all depending
   only on the foundation.
3. **Features** — the screens, each depending on what it builds on.
4. **Integrations** — MCP tools, jobs, anything that exposes the feature.
5. **Content** — seeds, skills, guides.

Two tasks that change the same files are never parallel: one depends on the
other. That decision is made now, before any worktree exists.

### B2. Write every brief

The `colony-add-task` brief format, self-contained — a lane reads nothing else:

- `## Request` — what this task delivers, in two to five lines.
- `## Decisions` — every open `Q` this task touches, with the answer the user
  gave or your recommended default. No lane will ask, so none may be missing.
- `## Scope` — written against the prototype: page `P3`, notes `F7`, `F9`.
- `## Out of scope` — what the neighbouring tasks own.
- `## Done when` — observable outcomes, and the tests that must exist.
- `## Anchors` — the files to read first, including the sibling module.
- `## Shared context` — the parent branch, the prototype's path in the repo, the
  conventions doc, and the file rules (which paths this task may and may not
  touch).

### B3. The plan file

Write `.floe/plans/<feature>-feature.md` in the parent worktree:

- the task table: number, name, kind, depends on, pages and notes covered;
- the defaults table: every `Q` with its answer and whether the user gave it or
  it is your recommendation;
- the check procedure from Phase C, so a fresh session could pick the run up.

**Gate:** the user approves the plan. Ask, and wait.

## Phase C: Run

### C1. Prepare the parent branch

The parent branch is the one this session's worktree has checked out. If that is
the project's main branch, create `feat/<feature>` with `create_worktree` first
and work from there.

Commit the prototype into the parent, so every lane can read it. The parent
worktree stays clean for the whole run: merges land in it, and a dirty tree
holding the base branch refuses them.

### C2. Put the tasks on the board

Call `colony_add_task` once per task, in plan order, so each dependency's id
exists before the task that names it:

```
colony_add_task(project, name, kind, brief,
  base: <parent branch>, dependsOn: [<ids>],
  autonomous: true, cleanup: true, start: true)
```

- `base` cuts the worktree from the parent and merges it back there.
- `autonomous` means no lane asks anybody anything; the brief's decisions are
  the answers.
- `cleanup` removes the worktree and branch after the merge and takes the card
  off the board.
- `start: true` with unmet dependencies is right: the card waits in the backlog
  and releases itself when the last dependency merges.

Record every id in the plan file. To fix a brief before its task is released,
use `colony_update_task` — never remove and re-add a card.

### C3. The heartbeat

The board merges, cleans up and releases on its own. You watch for what it
cannot decide. Call `create_followup` with `delay_minutes: 20` and a message
naming the plan file and this check. Exactly one followup is ever pending:
`list_followups` before creating one, `cancel_followup` on any duplicate.

## The check (every followup)

1. **Read the board:** `colony_board(project, compact: true)`. Each card has its
   stage, status, line, warning and last verdicts.
2. **For every card newly merged since the last check:** in the parent worktree,
   run the feature's tests under a timeout (`timeout 600 <cmd>`; call the test
   runner binary directly if its launcher hangs) and the project's formatter.
   Commit formatter output. If the tests are red, add a `fix` task on the parent
   (`base`, `autonomous`, `cleanup`) with the failure in its brief, and notify.
3. **For a card in `done` with a warning:**
   - a refused merge — a conflict, a dirty tree — gets a session in that task's
     worktree (`create_session`) with a fix-only brief: merge the base in,
     resolve, run the tests, commit, change nothing else. Retry
     `colony_merge_task` on the next check.
   - a lane that never gave a verdict: read its transcript
     (`read_session_output`). If the work is verified, `colony_merge_task`; if
     not, give it the same fix-only session.
   - after two failed retries on the same card, notify and stop touching it.
4. **A card with status `blocked`** should not happen on an autonomous task.
   Notify with the card and its question.
5. **Update the plan file's table.**
6. **Notify** — a push notification where your harness has one, and one line in
   chat — only on: a merge and what it released, a failure you stopped on, a
   blocked card, and the last merge. Otherwise stay silent.
7. **Reschedule**, or stop after the last task merges: say so, and leave no
   followup pending.

## What you never do

- Never start Phase B before the design is approved, or Phase C before the plan
  is.
- Never write product code, and never edit, commit or stash inside a lane's
  worktree to force a merge through.
- Never widen a task past the prototype. A new requirement goes back through
  the prototype first.
- Never skip the tests after a merge, and never call a red parent done.
