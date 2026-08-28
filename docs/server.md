# The server (headless backend) — install & update

Rookery ships in two shapes from one tree, two build targets:

- **Desktop** (`master`): `electron-vite build` → `electron-builder` (Electron main + preload).
- **Server** (headless, on `link`): `build:server` (`src/main` bundled under an Electron *shim* via esbuild → `out/server/index.js`) — no window, exposed to browsers/attached clients over WebSocket. All its tooling (`src/server/`, `src/main` shims, `bin/rookery-server.mjs`, `scripts/build-server.mjs`, `deploy/`) lives **here on `master`** — same tree, two build targets, runtime-guarded by `process.env.ROOKERY_SERVER`.

The box (`link`, tailnet `100.72.153.33`) holds **artifacts only** (`~/rookery`: `out/` + `bin/` + `package.json` + native `node_modules`), runs as the systemd **user** service `rookery` (`ROOKERY_PORT=80`, behind Caddy at `https://ide.pinguim.io`).

**Update `link` from the Mac** (from `master` — build locally, ship `out/`+`bin/` over SSH, restart; the web/attached clients auto-reconnect so the blip is invisible):

```bash
node scripts/build-server.mjs && pnpm exec electron-vite build
tar czf - out bin package.json | ssh link 'bash -lc "bash ~/rk-deploy.sh"'
```

`~/rk-deploy.sh` on the box preserves `node_modules` (native `node-pty` built for its arch), unpacks, and `systemctl --user restart rookery`.

**Manage on the box** (`rookery server <cmd>`, from `~/rookery`):

- `setup` — one-time idempotent bootstrap (writes the systemd unit, installs deps).
- `up` / `down` / `restart` / `status` — control + health + URLs.
- `update` — GitHub release (packaged) or `git pull` + rebuild (source checkout), then restart.

The unit's env is the config surface (`~/.config/systemd/user/rookery.service`): `ROOKERY_ALLOWED_ORIGINS` must list every client origin (the PWA `https://ide.pinguim.io`, plus the Electron origins `http://localhost:5173` in dev and `file://` packaged, for attached mode over WS), and `ROOKERY_VERSION` should track the shipped version (feeds the attach handshake's version-skew check). `daemon-reload` + `restart` after editing.

**Branch note:** desktop and server are **one tree** (`master`), two build targets, runtime-guarded by `process.env.ROOKERY_SERVER` — no more building features twice. The old long-lived `server` branch has been retired (master was already a functional superset after the attached-mode/unification work extracted the shared seam `buildRookeryApi`/`IpcLike`). Clients are separated by responsibility, not by branch: `src/main` = backend, `src/renderer` = desktop+web UI, `src/server` = headless shim + deploy tooling. A future native mobile (Swift) client would be another consumer of the same WS protocol.
