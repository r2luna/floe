# Colony lane eval

Synthetic eval for the lane skills in `src/main/config/colonySkills.ts`, so a skill edit can be
compared before/after. Dependency-free; not part of `pnpm gate` or `pnpm test`.

Each scenario (`scenarios.mjs`) is a tiny git repo (`base` on main, `work` on `feature/<id>`) plus a
brief. The runner sends the lane's skill text and the brief to `claude -p` (haiku, stdin closed) inside
a temp copy, then scores the final message and the resulting repo with deterministic checks:
one valid `COLONY:` line, last, no `AskUserQuestion`, no trailing `?`, plus per-scenario expectations
(verdict, artifact files, grep, a command's exit code, committed or not).

```bash
pnpm colony:eval --dry                          # validate scenarios, build fixtures, self-test checkers; no model
pnpm colony:eval --scenario verify-failing-suite --runs 1
pnpm colony:eval --json before.json             # all scenarios x 3 runs; table + JSON
pnpm colony:eval --json after.json              # ...after editing a skill
pnpm colony:eval --compare before.json after.json
```

Flags: `--runs N` (3), `--model` (haiku), `--lane a,b`, `--scenario substr,substr`, `--jobs` (4),
`--timeout sec` (420), `--budget usd` (1 per run), `--keep` (keep temp repos),
`--ref <git-rev>` (load the skills from that revision instead of the working tree).

Add a scenario by appending to `scenarios.mjs`; `--dry` rejects unknown lanes, skills, verdicts or regexes.
Limits: haiku is cheap but noisy, so read pass rates at N>=3; Bash is allow-listed to git/node/npm
and friends but node can still escape the temp dir (no sandbox); `codex exec` is not available to the
review lane, so it takes its documented "second opinion unavailable" path.
