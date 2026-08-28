---
name: deploy
description: Cut and publish a new Rookery release so the auto-updater can ship it, AND ship the matching headless server to the `link` box so both halves stay on the same version. Use when the user runs /deploy or asks to release, publish, or ship a new version. Handles preflight checks, version bump, signed build, GitHub publish, and the server update. Takes an optional bump level (patch/minor/major) as argument.
---

# Deploy — release a new Rookery version

Rookery auto-updates from **GitHub Releases**: `electron-updater` (see `src/main/autoUpdate.ts`)
polls the private `r2luna/rookery` repo, reads `latest-mac.yml`, downloads the signed `.zip`,
and applies it on restart. A release only reaches users if **all** of these hold:

- The GitHub release is **published** (not draft) — the updater ignores drafts.
- The version in `package.json` is **higher** than what users are running (semver compare).
- Every build is signed with the **same** identity (`Rookery Local Signing`) — Squirrel.Mac
  refuses an update whose signature doesn't match the installed app.
- The release carries `latest-mac.yml` **and** the `.zip` (Squirrel swaps the zip; the dmg is
  first-install only).

`pnpm release` (`electron-vite build && electron-builder --mac --publish always`) does the build +
publish. This skill wraps it with the preflight and version bump so nothing ships broken.

## Steps

Run these in order. **Stop and report** at the first failure — never publish past a failed check.

### 1. Preflight — abort if any fails
- **Branch + clean tree:** must be on `master` with nothing uncommitted.
  `git rev-parse --abbrev-ref HEAD` → `master`; `git status --porcelain` → empty.
  If the user is on a feature branch, tell them to merge to `master` first — releases ship from `master`.
- **Synced with origin:** `git fetch` then confirm `master` is not behind `origin/master`.
- **Signing identity present:** `security find-identity -v -p codesigning | grep "Rookery Local Signing"`.
  Missing → stop: without it Squirrel can't apply the update. (The cert must match prior releases.)
- **Publish token:** `gh auth status` must be logged in. The build reads `GH_TOKEN` — supply it from gh
  in step 3. Do not ask the user to paste a token.

### 2. Version bump
- Read current `version` from `package.json`.
- Bump level: use the `/deploy` argument if given (`patch`/`minor`/`major`); otherwise **ask** the user
  which, showing the resulting version. Default suggestion: `patch`.
- Edit `package.json` to the new version. Confirm it is strictly greater than the current one.
- Commit: `git commit -am "chore(release): vX.Y.Z"` then `git push origin master`.
  Push **before** publishing so the release tag points at the bump commit.

### 3. Build + publish
- Run: `GH_TOKEN=$(gh auth token) pnpm release`
- This builds the signed mac `.dmg` + `.zip`, creates the GitHub release `vX.Y.Z`, and uploads the
  assets + `latest-mac.yml`. It takes a few minutes (native rebuild + notarization-free signing).
- If it fails on signing, re-check the identity from step 1. If it fails on publish (401/403), the gh
  token lacks `repo` scope on the private repo.

### 4. Verify the release is live
- `gh release view vX.Y.Z --json isDraft,assets -q '.isDraft, [.assets[].name]'`
- Confirm **`isDraft` is `false`** and the asset list contains `latest-mac.yml`, a `.zip`, and a `.dmg`.
  A draft release or a missing `latest-mac.yml`/`.zip` means the updater will find nothing — fix before
  telling the user it's done.
- Report the published version and the release URL.

### 5. Install the new build into /Applications (this Mac)
The release auto-updates *other* machines, but the Mac that just built it shouldn't have to wait for the
6h auto-update check — drop the freshly-built app straight into `/Applications` so a quit+reopen runs the
new version now.

- `electron-builder` already left the signed bundle unpacked under `dist/mac*/Rookery.app` (alongside the
  `.dmg`). Install *that* — no need to mount the dmg. Use `ditto`, not `cp -R`: it preserves the code
  signature + xattrs (a `cp -R` can strip them and trip Gatekeeper):
  ```
  APP=$(ls -d dist/mac*/Rookery.app | head -1)
  rm -rf /Applications/Rookery.app && ditto "$APP" /Applications/Rookery.app
  ```
- Safe while Rookery is running — macOS keeps the running process on its old inode; the new version
  applies on the **next launch**. Do **not** force-quit: the deploy may be running from inside Rookery.
- Tell the user it's installed and to quit+reopen (or ⌘Q → relaunch) to pick it up.

### 6. Ship the matching server to `link` (do this every deploy — not optional)
Desktop and server are **one tree, two build targets** (`process.env.ROOKERY_SERVER`). The `/deploy` above
only ships the **desktop app**; the headless server on `link` must be updated in the **same** deploy or the
two drift and the attach handshake shows a "Version mismatch" banner (app vX.Y.Z vs server vA.B.C).

- **Build both targets and ship over SSH** (from `master`; clients auto-reconnect so the blip is invisible):
  ```
  node scripts/build-server.mjs && pnpm exec electron-vite build
  tar czf - out bin package.json | ssh link 'bash -lc "bash ~/rk-deploy.sh"'
  ```
  `~/rk-deploy.sh` preserves the box's native `node_modules` (node-pty built for its arch), unpacks, and
  `systemctl --user restart rookery`.
- **Bump `ROOKERY_VERSION` to match** — `rk-deploy.sh` restarts but does **not** touch the unit env, and the
  version-skew banner reads `ROOKERY_VERSION` from the systemd unit, not from the shipped code. So update it
  to the new `vX.Y.Z` (without the `v`) or the banner persists even with the new code running:
  ```
  ssh link 'bash -lc "sed -i \"s/^Environment=ROOKERY_VERSION=.*/Environment=ROOKERY_VERSION=X.Y.Z/\" ~/.config/systemd/user/rookery.service && systemctl --user daemon-reload && systemctl --user restart rookery"'
  ```
  (If the unit uses a different quoting for that line, edit it to match — the goal is `ROOKERY_VERSION` == the
  released version. `grep ROOKERY_VERSION ~/.config/systemd/user/rookery.service` to confirm first.)
- **Verify:** `ssh link 'bash -lc "rookery server status"'` (or reattach from the app and confirm the banner is
  gone). Report the server version alongside the desktop one.

## Notes
- **Receiving** updates is separate from publishing: each machine needs a PAT at
  `~/Library/Application Support/rookery/.gh-update-token` (the repo is private). That's per-machine
  setup, not part of deploy — see `src/main/autoUpdate.ts`.
- This ships **mac** only (matches the auto-updater, which is Squirrel.Mac/zip based). The Linux
  AppImage target exists in `electron-builder.yml` but is a manual `pnpm build:linux` — not wired to
  auto-update.
