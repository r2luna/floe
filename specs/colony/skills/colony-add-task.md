---
name: colony-add-task
description: Interview the user about a change until every decision is settled, then put it on the colony board with a brief that leaves the specifier nothing to ask.
---

# Adding a task to the board

You turn "I want X" into a task the specifier can work from without stopping to
ask anybody anything. The interview is the point: every decision settled here is
a decision no lane has to park a card on later.

You write no code and you do not design the solution. The brief carries WHAT is
wanted and WHICH WAY each open question was answered. How it gets built is the
specifier's lane.

Everything you write is in English, whatever language the user asks in — the
brief is read by lanes that write English artifacts and English commits.

## 1. Find the facts yourself

Facts are your job, never the user's. Before the first round:

- Call `colony_board` for the project. You need to know whether this change is
  already on it, and which live task this one would collide with.
- Read the code the request points at: the file, the symbol, the failing test,
  the conventions doc.
- Find out which branch the change belongs on. When it is part of a feature
  being built on its own branch, that branch is the task's `base`, not the
  project's main branch.

A question the repo can answer is a question you do not ask. When a fact is slow
to find, dispatch a sub-agent for it and ask the rest of the round while it runs
— only the questions downstream of that fact wait.

## 2. Grill in rounds

Map the change as a **design tree**: every decision branches into the decisions
that hang off it. The **frontier** is every decision whose prerequisites are
already settled — the questions you can ask NOW without guessing at answers you
have not heard yet.

Ask the whole frontier in one round. Number each question, give your recommended
answer, then stop and wait for the user.

```
❓ **Q1** - **<question title>**: <question body, may be several paragraphs, may offer choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body>

➡️ <your recommended answer>
```

Every round of answers reshapes the tree: settled decisions push the frontier
outward and unblock the questions that depended on them. Recompute the frontier
and ask the next round. A question whose answer depends on another question still
open in this round belongs to a LATER round.

The decisions are the user's. Put each to them and wait — never answer your own
question and carry on.

## 3. What is worth a round

Grill the things a lane cannot decide for itself, in this order:

1. **Scope** — where this change stops, and what is deliberately not in it.
2. **Observable behaviour** — what the user sees, in which states, including the
   empty, error and slow ones.
3. **Data** — what is stored, and what happens to what is stored already.
4. **Edge cases** — the inputs and races that would otherwise be discovered in
   the coder lane.
5. **Done when** — the outcome that makes this task finishable, checkable
   without reading the diff.

Not worth a round: naming, style, file placement, anything with an obvious
default, anything the repo already answers. Those are yours to decide.

The interview is done when the frontier is empty: every branch visited, nothing
left silently assumed. Say so, and do not create the task until the user confirms
you have a shared understanding.

## 4. Write the brief

Hand the interview back as the brief, because the brief is the only thing the
specifier reads. Sections in this order, skipping any that is empty:

```markdown
## Request
<the change in the user's own words, two to five lines>

## Decisions
- Q: <question> -> A: <what was decided>

## Scope
- <one line per thing in it>

## Out of scope
- <one line per thing deliberately left out>

## Done when
- <observable outcome, checkable without reading the diff>

## Anchors
- `path/to/file.ts:symbol` — what it is and why it matters here

## Still open
- <question> — recommended: <the default the specifier should take>
```

`## Decisions` is the part that pays for the interview: one line per answer, in
the user's terms, no reasoning. The specifier copies them into the spec's
`## Clarifications`, so anything you leave out here gets asked again.

`## Still open` is only for an interview the user broke off. Every line needs a
recommendation, or it is a question with nobody left to answer it.

## 5. Put it on the board

1. **name** — short kebab-case, the branch's last segment, what the change IS
   and not what it fixes (`backgrounded-polling`, not `fix-the-polling-bug`).
2. **kind** — `feat` for new behaviour, `fix` for broken behaviour, `chore` for
   the rest.
3. **dependsOn** — if a live task on the board is changing the same code, pass
   its id. That decision has to be made now; it cannot be made once both
   worktrees exist.
4. **base** — the branch to cut it from and merge it back into, when that is not
   the project's main branch. It must exist; it may be checked out in another
   worktree, and the merge lands there.
5. **autonomous** — `true` when nobody will be around to answer a lane's
   question. Every lane then takes the recommended option instead of asking, so
   every open question needs its default in `## Decisions` or `## Still open`.
6. **cleanup** — `true` to remove the worktree and delete the branch once the
   task merges, and take the card off the board.
7. Call `colony_add_task` with `start: true` unless the user said to park it. An
   unmet dependency still starts: the card waits in the backlog and releases
   itself when the dependency merges.

A mistake in a card that is still in the backlog is fixed with
`colony_update_task`, never by removing and re-adding it: the id stays, so
nothing that depends on it has to be re-pointed.

Two changes means two tasks. Split them, brief them separately, and say why you
split them.

Then report in two lines: what you created, and whether it started or is holding
behind something.

---

The round format is adapted from Matt Pocock's `grilling` skill:
<https://github.com/mattpocock/skills/blob/main/skills/productivity/grilling/SKILL.md>
