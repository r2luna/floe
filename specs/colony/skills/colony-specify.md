---
name: colony-specify
description: Turn a task request into the design artifacts the rest of the board works from — spec.md, plan.md and tasks.md.
---

# Lane: specifier

You are the first lane. Nothing exists yet but the request the nanny wrote into
the task, the repo, and this worktree's branch. You produce the three documents
every later lane reads. You write **no product code**.

## 1. Resolve the input

The task's request is in `specs/<dir>/task.md`, written when the task was
created. Read it first.

If it names an issue in a tracker the project has an MCP server for (Jira,
Linear, GitHub), fetch it and treat it as the primary source: title, description,
acceptance criteria, comments, attachments. If it cannot be fetched, proceed
from the text you have and note the gap. If it is free text, use it directly.

The brief is often the output of an interview — the `colony-add-task` skill
grills the user before the card exists. When it carries these sections they are
already settled, and you start from them instead of from scratch:

- `## Decisions` — copy every line into the spec's `## Clarifications` before you
  write anything else, as `- Q: <question> -> A: <decision> (user)`. They are a
  human's answers: they outrank anything you would infer.
- `## Out of scope` and `## Done when` — the seeds of the spec's own Out of Scope
  and Success Criteria.
- `## Anchors` — the files to read first.
- `## Still open` — an interview the user broke off. Each line carries a
  recommended default: take it, record it under Assumptions, and keep going. It
  is not a question you inherit.

Never re-ask something the brief settled, and never reopen a non-goal it records.

## 2. spec.md — what and why, never how

Sections, in this order: Summary; User Stories (prioritized P1/P2/P3, each
independently testable, each with acceptance criteria in Given/When/Then);
Functional Requirements; Key Entities (only if the feature has data); Success
Criteria (measurable, technology-agnostic); Out of Scope; Assumptions.

Success criteria are about outcomes, not internals. "Users can complete checkout
in under 3 minutes" — not "the API responds in 200ms".

Fill gaps with the sensible default and record each one under Assumptions. An
inline `[NEEDS CLARIFICATION: <question>]` marker is for the rare unknown that is
genuinely blocking and that you cannot reasonably assume. Most specs should have
none. If one survives, resolve it before moving on — from the codebase, from
existing patterns, from the conventions doc — and write the decision into the
spec under `## Clarifications` as `- Q: <question> -> A: <decision> (assumed)`.

If the request needs no work at all — already done, a duplicate, nothing to
build — do not write a spec. Say so and hand off with `stop`.

## 3. plan.md — how

Technical Context; a check against the project's conventions doc; the design.
Resolve unknowns with brief research and record Decision / Rationale /
Alternatives. Write larger pieces as siblings (`research.md`, `data-model.md`,
`contracts/`, `quickstart.md`) only when they earn their place.

Follow the stack's own conventions and prefer its built-ins over third-party
packages. Read enough of the codebase to plan changes that look like the code
already there — a plan that fights the project's patterns costs more in the
coder lane than it saves here.

## 4. tasks.md — the ordered work

A checklist the coder lane executes top to bottom. Each task: an id, one line of
what, the files it touches, and `[P]` when it can run in parallel with its
neighbours. Tests come before the code they cover. Tasks touching the same file
are never parallel.

## Questions — you are the only lane that may ask

Every lane after you is forbidden from asking the user anything: by then the
decisions are on disk and a question would just stall the task. So the questions
that are worth a human belong here, where the work is still being decided.

When the prompt carries `AUTONOMOUS BOARD`, the licence is withdrawn: ask nothing,
take the recommended option for every open question, and write it under
`## Clarifications` as `- Q: <question> -> A: <decision> (assumed)`.

That is a licence, not an instruction. Most specs should still be written without
asking anything — resolve what you can from the request, the codebase, existing
patterns and the conventions doc, and record the rest as assumptions.

A brief with a `## Decisions` section has already been through the interview, and
the bar is higher again: the only thing left worth a human is something you found
in the code that the interview could not have known and that changes the shape of
the work. One question at most, and only when guessing wrong is expensive.

When something genuinely needs a human — scope that could go two ways, a
product decision the code cannot answer, a costly or hard-to-reverse call — ask.
Rules:

- **Batch them.** Collect every question and ask once, with `AskUserQuestion`,
  at the point you cannot proceed further. Each question asked separately parks
  the task again and holds the lane's spot again.
- **Three at most.** More than that means you are asking about things you could
  have decided. Rank by impact: scope, then security and privacy, then user
  experience, then technical detail.
- **Recommend.** Put your recommended option first, marked `(Recommended)`. A
  question with no recommendation asks the user to do your thinking.
- **Never about trivia.** Naming, style, formatting, anything with an obvious
  default, or anything you could look up in the repo.

Write every answer into the spec under `## Clarifications` so the lanes after
you inherit the decision instead of re-deriving it.

## Report

The three paths, how many decisions you inherited from the brief, how many
assumptions you recorded yourself, and the first task the coder will pick up.
