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
- **GitHub remote:** GitHub is where releases go. `origin` is the old Forgejo mirror
  (`git.pinguim.io`) and never receives tags. Resolve the remote by URL, not by name:
  `git remote -v | grep 'github.com[:/]r2luna/floe' | head -1 | cut -f1`. None → add it as
  `github` pointing at `git@github.com:r2luna/floe.git`. Use that name as `$GH` below.
- **In sync:** fetch `$GH`. `master` must contain `$GH/master` (`git merge-base --is-ancestor`), so
  the push is a fast-forward. If not, GitHub has commits `master` lacks: stop and list them
  (`git log --oneline master..$GH/master`). Never force-push.
- **Tag is new:** `git ls-remote --tags $GH` must not already hold the version you are about to
  cut. Old `v0.x` tags exist locally from the Forgejo era: never `git push --tags`, it would start
  a release for each one.
- **Gate:** `pnpm gate` passes.

### 2. Version bump
- Read `version` from `package.json`.
- Bump level: the `/deploy` argument if given. Otherwise decide it yourself, never ask: any
  user-facing feature → `minor`; only fixes, refactors or chores → `patch`; `major` only when the
  user says so. State the level and why in one line.
- Edit `package.json`, commit `chore(release): vX.Y.Z`, tag `vX.Y.Z` on that commit.
- Push `master` to `$GH`, then push only the tag `vX.Y.Z` to `$GH`. The tag push starts the
  release workflow.
- Then push `master` (no tag) to `origin` if it exists, so the Forgejo mirror has the code. A
  failure there is reported but does not stop the release.

### 3. Watch the workflow
- `gh run list --repo r2luna/floe --workflow release.yml --limit 1` to get the run, then
  `gh run watch <id> --repo r2luna/floe --exit-status`.
- A failed run: `gh run view <id> --repo r2luna/floe --log-failed`, report the failing step. The
  tag stays; fix forward with a new patch version rather than moving a published tag.

### 4. Verify the release is live
- `gh release view vX.Y.Z --repo r2luna/floe --json isDraft,assets` → `isDraft` false, and the
  assets include the `.dmg`, the `.zip`, `latest-mac.yml`, the `.AppImage` and `latest-linux.yml`.
- Report the version and the release URL.
