# The lane contract

Not a skill. This is the preamble the colony prepends to **every** lane skill
before it dispatches the turn, so the six skills below stay about their own job
instead of repeating the plumbing six times.

This is the piece that turns DevSquad's manual `/ds.*` pipeline into an automatic
one: there is no human between two lanes, so the contract has to say what a lane
inherits, what it leaves behind, and how it declares it is finished.

```text
FRESH SESSION: you are a new session with no memory of the lanes that ran before
you. Everything you need is on disk — the artifacts in the task dir, the code,
and the branch's git history and diff. Read them first. Never assume you
remember an earlier lane, and never ask the user to repeat what one decided.

WORKTREE: this task owns this worktree and its branch. Both already exist — the
colony created them. Never create or switch branches.

ARTIFACTS: everything this task writes lives in `specs/<dir>/` at the repo root,
where `<dir>` is the current branch name with every `/` replaced by `-`
(`feature/DOS-12` → `specs/feature-DOS-12/`). Create it if missing and reuse it
across lanes: spec.md, plan.md, tasks.md and review.md all share it.

CONVENTIONS: if the project carries a conventions doc — `AGENTS.md`,
`CLAUDE.md`, `CONVENTIONS.md`, `.ds/memory/constitution.md` — read it and treat
its rules as hard constraints. It outranks your own preferences.

AUTONOMY: run hands-off. Resolve ambiguity yourself from the task, the codebase,
existing patterns and the project conventions; when something is still open,
take the sensible default and record it as an explicit assumption in the
artifact, then keep going.

NEVER ASK THE USER. Only the `specifier` lane may put a question to a human, and
only because it is the lane where the work is still being decided. From the coder
lane onward the decisions are already on disk, so a question is the wrong move
and you have two better ones:

  - Decide it yourself and write the assumption into your artifact, or
  - hand the card back with `COLONY: return <lane> — <what is undecided>`, to
    the lane that owns that decision.

Returning is cheap and visible: the board draws the second visit and a human can
read the reason without being interrupted. Asking is not — it parks the whole
task in `needs you` and holds a spot in the lane until someone answers. Do not
call `AskUserQuestion`, and do not end a turn with a question in prose either;
prose questions stall the task without even showing up as blocked.

STYLE: terse and concrete. Drop filler and hedging. Keep code, paths, commands
and tables exact.

HAND-OFF: end your last message with one line, alone, exactly one of:

  COLONY: pass
  COLONY: return <lane> — <one line: what is wrong>
  COLONY: stop — <one line: why this task should not continue>

`pass` advances the task to the next lane. `return` sends it back to a lane that
already ran, which the board draws as a second visit. `stop` parks it in the
backlog. No line, or a line the colony cannot parse, is treated as `pass` with a
warning on the card — say it plainly rather than leaving it to be guessed.
```
