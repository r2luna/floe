---
name: deploy
description: Cut and publish a new Rookery release so the auto-updater can ship it, AND ship the matching headless server to the `link` box so both halves stay on the same version. Use when the user runs /deploy or asks to release, publish, or ship a new version. Handles preflight checks, version bump, signed build, Forgejo publish, and the server update. Takes an optional bump level (patch/minor/major) as argument.
---

# Deploy — release a new Rookery version

The GitHub mirror (`r2luna/rookery`) is **archived** — do not use `gh release` for any of this.
Rookery auto-updates from a **self-hosted Forgejo generic package registry** at `git.pinguim.io`
(see `electron-builder.yml` `publish:` block and `src/main/autoUpdate.ts`): `electron-updater`
polls `https://git.pinguim.io/api/packages/r2luna/generic/rookery-updates/latest/latest-mac.yml`
anonymously (public package, no token needed to *receive*), downloads the signed `.zip`, and
applies it on restart. A release only reaches users if **all** of these hold:

- `latest-mac.yml` on the registry reports the new version, alongside the matching `.zip` (and
  `.dmg` for first installs) at that same fixed `.../latest/` path.
- The version in `package.json` is **higher** than what users are running (semver compare).
- Every build is signed with the **same** identity (`Rookery Local Signing`) — Squirrel.Mac
  refuses an update whose signature doesn't match the installed app.

`pnpm release` (`electron-vite build && electron-builder --mac --publish always`) only **builds**
the signed `.dmg`/`.zip`/`latest-mac.yml` into `dist/` — the `generic` provider has no uploader, so
this does not actually publish anything anywhere. Publishing is a separate step:
`node scripts/publish-update.mjs`, which wipes the registry's `latest` version and PUTs the three
files for the current `package.json` version. This skill wraps both with the preflight and version
bump so nothing ships broken.

## Steps

Run these in order. **Stop and report** at the first failure — never publish past a failed check.

### 1. Preflight — abort if any fails
- **Branch + clean tree:** must be on `master` with nothing uncommitted.
  `git rev-parse --abbrev-ref HEAD` → `master`; `git status --porcelain` → empty.
  If the user is on a feature branch, tell them to merge to `master` first — releases ship from `master`.
- **Synced with origin:** `git fetch` then confirm `master` is not behind `origin/master`.
- **Signing identity present:** `security find-identity -v -p codesigning | grep "Rookery Local Signing"`.
  Missing → stop: without it Squirrel can't apply the update. (The cert must match prior releases.)
- **Publish token:** `test -f ~/.rookery-forgejo-token` (or `$FORGEJO_TOKEN` set), scope `write:package`.
  Missing → stop: `scripts/publish-update.mjs` needs it to PUT to the registry. Do not ask the user to
  paste a token — if it's missing, tell them where it needs to live.

### 2. Version bump
- Read current `version` from `package.json`.
- Bump level: use the `/deploy` argument if given (`patch`/`minor`/`major`). Otherwise **decide it
  yourself — never ask.** Read `git log <last release tag/commit>..HEAD` and pick: any user-facing
  feature or new capability → `minor`; only fixes, refactors or chores → `patch`; `major` only when
  the user says so. State the level you picked and why in one line, then keep going.
- Edit `package.json` to the new version. Confirm it is strictly greater than the current one.
- Commit: `git commit -am "chore(release): vX.Y.Z"` then `git push origin master`.
  Push **before** publishing so the release tag points at the bump commit.

### 3. Build + publish
- Run: `pnpm release`
- This only **builds** the signed mac `.dmg` + `.zip` + `latest-mac.yml` into `dist/` (the `generic`
  provider has no uploader, so `--publish always` here doesn't upload anything). Takes a few minutes
  (native rebuild + notarization-free signing).
- If it fails on signing, re-check the identity from step 1.
- Then run: `node scripts/publish-update.mjs`
  This deletes the registry's `latest` version and PUTs `latest-mac.yml` + the `.zip` + the `.dmg` for
  the current `package.json` version. It throws if any `dist/` file for that version is missing (run
  the build first) or if a HTTP status isn't the expected one (401/403 → bad/missing token; check
  `~/.rookery-forgejo-token`).

### 4. Verify the release is live
- `curl -sS https://git.pinguim.io/api/packages/r2luna/generic/rookery-updates/latest/latest-mac.yml`
- Confirm the `version:` field matches `vX.Y.Z` and the `files:` list has both the `.zip` and `.dmg`.
  A stale version or missing files means the updater will find nothing (or the wrong thing) — fix
  before telling the user it's done.
- Report the published version.

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
  Known false negative: its health probe hits `127.0.0.1:$ROOKERY_PORT` but defaults to `41600` when
  `ROOKERY_PORT` isn't set in the invoking shell (it is `80` in the unit, not the SSH login shell) — a
  `health: sem resposta` here doesn't necessarily mean the server is down. Cross-check with
  `journalctl --user -u rookery -n 20` (look for `main booted — N handlers` with no error after it) or
  `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:80/?token=$(cat ~/.rookery/rookery-token)`
  on the box before treating it as a real failure.

## Notes
- **Receiving** updates needs no per-machine token — the registry package is public and
  `electron-updater` downloads anonymously (see `src/main/autoUpdate.ts`). Nothing to set up on
  client machines.
- **Publishing** needs the Forgejo token only on the machine that runs `/deploy` — it lives at
  `~/.rookery-forgejo-token` (or `$FORGEJO_TOKEN`), scope `write:package`.
- This ships **mac** only (matches the auto-updater, which is Squirrel.Mac/zip based). The Linux
  AppImage target exists in `electron-builder.yml` but is a manual `pnpm build:linux` — not wired to
  auto-update.
