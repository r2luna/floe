## Goal
Split colony execution so each step runs in its own single session, rather than sharing one session across steps.

## Scope
Refactor colony session handling to allocate one session per step.

## Done when
Each step in a colony run executes in its own dedicated session.
