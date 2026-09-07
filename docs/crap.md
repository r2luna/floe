# The gate: lint, typecheck, tests, CRAP

`pnpm gate` is the definition of done. Four stages, one command, ~15s:

| stage | command | fails when |
| --- | --- | --- |
| lint | `oxlint src --deny-warnings` | any warning or error |
| typecheck | `tsc` for node + web | any type error |
| test | `node --test` with coverage | any test fails |
| crap | `scripts/crap.mjs --fail` | any gated function is over CRAP 30 |

Every stage runs even after an earlier one fails, so one run shows the whole picture.
The test stage writes the lcov the CRAP stage reads — the suite runs once.

```bash
pnpm gate                 # the gate
pnpm gate --report        # same output, always exits 0
pnpm hooks:install        # wire it to pre-commit (git commit --no-verify to bypass once)
```

`.oxlintrc.json` turns off `no-control-regex`. Floe hosts a terminal: matching
`\x1b[...` escapes and rejecting `\x00-\x1f` in paths is the job, not an accident.
Every other rule oxlint ships is on, and warnings fail the gate.

## CRAP

Uncle Bob's [crap4j](https://github.com/unclebob/crap4java) metric, per function:

```
CRAP(f) = complexity(f)² · (1 − coverage(f))³ + complexity(f)
```

Complexity is only allowed when it is tested. At 0% coverage the limit of 30 permits
complexity 5. Complexity 15 needs ~70% coverage to pass; complexity 30 needs ~90%. The
way down is always one of two moves: split the function, or cover it.

- **Complexity** is McCabe over the TypeScript AST: `if`, ternary, loops, `case`, `catch`,
  and the boolean operators `&&` / `||` / `??` — crap4j counts boolean operators in Java,
  so we count them here.
- **A unit** is what a reader calls a function: a declaration, a method, or a `const`
  bound to an arrow. Callbacks nested inside one fold into it — their branches are the
  caller's risk, not a separate function's.
- **Coverage** is per-line, from `node --test --experimental-test-coverage`, restricted to
  the unit's line range. A file no test ever loads counts as 0%.

## Gated vs report-only

The limit of 30 is hard across `src/main`, `src/preload`, `src/shared` and `src/web`. No
baseline file, no per-function exemptions — a number over 30 is either fixed or the
change does not land.

`src/renderer` is measured and printed, but never fails the gate: `node --test` cannot
load `.tsx`, so every component reads 0% coverage and the score says "no component test
runner" rather than "risky code". Give the renderer a real runner and it can be gated
like the rest.

```bash
pnpm crap                                 # run tests with coverage, then report
pnpm crap --lcov f.info                   # reuse an existing lcov
pnpm crap --include 'src/main/**'         # narrow the report
pnpm crap --gate 'src/main/**' --fail     # narrow what is allowed to fail
pnpm crap --threshold 20 --top 40
pnpm crap --json
```

## Reading a number

```
    CRAP    cx     cov  location
   15500   124      0%  src/main/index.ts:256 registerIpc
    2056   153     57%  src/main/mcpServer.ts:344 registerTools
```

`registerTools` is the more complex of the two and scores 87x lower, because it is
tested. That gap is the whole point of the metric.
