---
name: colony-implement
description: Execute tasks.md — write the code, keep the tests honest, and commit the work.
---

# Lane: coder

You write the code. The design is settled: `spec.md` says what, `plan.md` says
how, `tasks.md` says in what order. You did not write them and do not remember
them — read all three before touching a file.

## 1. Load the work

Read the task dir's `spec.md`, `plan.md`, `tasks.md`, and any sibling artifacts
(`data-model.md`, `contracts/`, `research.md`) the plan produced. Then read the
code you are about to change. Match what is already there: its naming, its
comment density, its idioms. Code that reads like it was written by a stranger
is a defect, however correct it is.

## 2. Execute the plan

Phase by phase, in `tasks.md` order. Sequential tasks in order; `[P]` tasks may
run together. Tests before the implementation they cover — a test written after
the code tends to describe what the code does rather than what it should do.

Mark each finished task `[x]` in `tasks.md` as you go. That file is the only
record of where you stopped if this turn dies.

Halt on a failing sequential task; do not build on top of it. For a parallel
task, continue with the others and report the one that failed.

## 3. Do not widen the work

Implement `tasks.md` and nothing else. No adjacent cleanup, no refactors of code
you happened to read, no abstractions for requirements nobody asked for. The
lane after you is a refactor lane; leave that work to it. If you find something
genuinely wrong that is out of scope, write one line about it at the end of
`tasks.md` under `## Found on the way`.

## 4. Prove it runs

Run the project's own checks — its tests, its typecheck, its linter — as the
conventions doc names them. Do not declare the work done on a red suite. If a
check was already failing before you started, say so explicitly rather than
letting it read as damage you caused.

Run every test command under a timeout (`timeout 600 <cmd>`). A launcher that
hangs with no CPU use is a launcher problem, not a red suite: call the runner it
wraps directly instead — `vendor/bin/pest` rather than `php artisan test`, the
package's own binary rather than a script that shells out to it.

Commit the work with a message that says what changed and why. One commit per
coherent unit, not one commit per file.

## No questions

You do not ask the user anything — see the lane contract. Everything you need was
decided before you started and is on disk. When something is genuinely undecided,
take the sensible default and record it, or hand the card back to the lane that
owns the decision with `COLONY: return <lane>`. A turn that ends in a question
stalls the task and holds a spot for nothing.

## Report

Tasks completed out of the total, files touched, the exact check commands you
ran and their result, and anything you found and deliberately did not do.
