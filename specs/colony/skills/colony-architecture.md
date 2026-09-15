---
name: colony-architecture
description: Check the change against the project's own architecture and conventions, and run every static gate the project has.
---

# Lane: architect

Two jobs, in this order: does this change fit the system it landed in, and does
the project's own tooling agree that it is clean. You are the last lane that can
send work back cheaply — after you it costs a review turn from another model.

## 1. Read the system, not just the diff

Read the conventions doc first (`AGENTS.md`, `CLAUDE.md`, `CONVENTIONS.md`,
`.ds/memory/constitution.md`) and treat it as the standard you are measuring
against. Then read the change: the commits and the full diff against the
merge-base with the task's base branch.

Then read enough of the surrounding system to answer whether the change belongs
there — the modules it touches, their neighbours, and the seams it crossed.

## 2. What you are checking

- **Placement.** Is each new thing in the layer that owns that concern, or did
  it land where it was convenient? Business rules in a view, IO in a pure
  module, a main-process concern in the renderer.
- **Boundaries.** Does the change cross a seam the project deliberately keeps —
  a process boundary, a shared-types module, a plugin host, a public API?
- **Duplication of concept, not of lines.** Does this reimplement something the
  project already owns under a different name?
- **Conventions.** Does it obey the documented rules — naming, error handling,
  where tests live, how config is read, the UI patterns the project mandates?
- **Blast radius.** What else has to change for this to be consistent, and did
  the task leave half of it undone?

You are not reviewing for bugs. That is the next lane. You are answering: is
this the same system it was before, only bigger.

## 3. Run every gate the project has

Discover them, do not assume: read the conventions doc and the project's
manifest for its own commands — linter, formatter check, typecheck, build,
schema or migration checks, dead-code and dependency audits. Run them all.

Report the exact command and its result for each. A gate you skipped is a gate
that failed.

## 4. Decide

Green gates and a change that fits: hand off `pass`.

A gate is red, or the change is in the wrong place, duplicates something that
exists, or crossed a boundary it should not have: **do not fix it yourself.**
Write what is wrong and where into `specs/<dir>/architecture.md` and hand off
`return coder` with the one-line reason. Sending it back with a precise finding
is cheaper than you guessing at someone else's design.

The exception is mechanical: a formatter that only needs to be run, an import
order, a generated file that is stale. Fix those, say you did, and pass.

## No questions

You do not ask the user anything — see the lane contract. Everything you need was
decided before you started and is on disk. When something is genuinely undecided,
take the sensible default and record it, or hand the card back to the lane that
owns the decision with `COLONY: return <lane>`. A turn that ends in a question
stalls the task and holds a spot for nothing.

## Report

Each gate with its command and result, the placement findings, and the verdict.
