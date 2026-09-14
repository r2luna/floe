---
name: deploy
description: Cut and publish a new Floe release so the auto-updater can ship it. Use when the user runs /deploy or asks to release, publish, or ship a new version. Handles preflight checks, version bump, tag push, and watching the GitHub release workflow. Takes an optional bump level (patch/minor/major) as argument.
---

# Deploy — release a new Floe version

Releases are built by GitHub Actions, not on this machine. Pushing a `vX.Y.Z` tag to
`github.com/r2luna/floe` runs `.github/workflows/release.yml`: the gate, a draft release, an
unsigned macOS arm64 build (`.dmg` + `.zip` + `latest-mac.yml`) and a Linux AppImage
(`latest-linux.yml`) uploaded into it, then the draft is published.

The app's updater reads that release (`electron-builder.yml` `publish:` and
`src/main/autoUpdate.ts`). Linux installs itself. macOS builds are unsigned, so Squirrel.Mac cannot
swap them in: the app announces the version and "Install update" opens the release page.

## Steps

Run these in order. **Stop and report** at the first failure — never tag past a failed check.

### 1. Preflight — abort if any fails
- **Branch + clean tree:** on `master`, `git status --porcelain` empty. On a feature branch, tell
  the user to merge to `master` first.
- **Remote:** `git remote get-url github` points at `github.com/r2luna/floe`. `git fetch github`,
  and `master` is not behind `github/master`.
- **Gate:** `pnpm gate` passes.

### 2. Version bump
- Read `version` from `package.json`.
- Bump level: the `/deploy` argument if given. Otherwise decide it yourself, never ask: any
  user-facing feature → `minor`; only fixes, refactors or chores → `patch`; `major` only when the
  user says so. State the level and why in one line.
- Edit `package.json`, commit `chore(release): vX.Y.Z`, tag `vX.Y.Z` on that commit.
- `git push github master` then `git push github vX.Y.Z`. Also push `master` to `origin` if it
  exists, so the mirrors agree.

### 3. Watch the workflow
- `gh run list --repo r2luna/floe --workflow release.yml --limit 1` to get the run, then
  `gh run watch <id> --repo r2luna/floe --exit-status`.
- A failed run: `gh run view <id> --repo r2luna/floe --log-failed`, report the failing step. The
  tag stays; fix forward with a new patch version rather than moving a published tag.

### 4. Verify the release is live
- `gh release view vX.Y.Z --repo r2luna/floe --json isDraft,assets` → `isDraft` false, and the
  assets include the `.dmg`, the `.zip`, `latest-mac.yml`, the `.AppImage` and `latest-linux.yml`.
- Report the version and the release URL.
