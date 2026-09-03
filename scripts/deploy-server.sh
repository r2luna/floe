#!/bin/bash
# Ship the headless daemon to a Floe server over SSH.
#
# The server holds artifacts only — no source, no git. What lives there is the
# bundle (out/server/index.js), a package.json naming the native addons, and the
# node_modules built for THAT machine's node. The bundle is replaced on every
# deploy; node_modules is not, because rebuilding a native addon per deploy is
# minutes of compiling to arrive at the same file.
#
#   FLOE_SERVER=user@host ./scripts/deploy-server.sh
#   FLOE_SERVER=r2luna@100.72.153.33 ./scripts/deploy-server.sh     # link
#
# FLOE_SERVER_DIR overrides the remote directory (default ~/floe), FLOE_SSH adds
# ssh options (identity, port).
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${FLOE_SERVER:?set FLOE_SERVER=user@host}"
DIR="${FLOE_SERVER_DIR:-floe}"
SSH_OPTS="${FLOE_SSH:-}"
# The version the addons are pinned to is the one the app itself builds against,
# so a remote terminal runs the same node-pty the desktop does.
PTY_VERSION="$(node -p "require('./package.json').dependencies['node-pty'].replace(/^[^0-9]*/, '')")"

echo "── build ─────────────────────────────────"
node scripts/build-server.mjs
# The browser UI the daemon serves (src/main/webServer.ts, docs/web.md). Skipped
# with FLOE_SKIP_WEB=1 when only the backend changed — it is the slow half.
[ -n "${FLOE_SKIP_WEB:-}" ] || pnpm exec vite build --config vite.config.web.ts

echo "── ship → $TARGET:~/$DIR ─────────────────"
# shellcheck disable=SC2086
ssh $SSH_OPTS "$TARGET" "mkdir -p ~/$DIR/out/server"
# shellcheck disable=SC2086
scp $SSH_OPTS -q out/server/index.js "$TARGET:~/$DIR/out/server/index.js"

# The web build is a few hundred files with hashed names, so it travels as one
# tar. Parked in /tmp here and unpacked in the provisioning block below — piping
# it straight into `ssh ... bash -s <<REMOTE` cannot work, because the heredoc is
# already that ssh's stdin and the tar would never arrive.
if [ -z "${FLOE_SKIP_WEB:-}" ]; then
  # shellcheck disable=SC2086
  tar czf - -C out web | ssh $SSH_OPTS "$TARGET" "cat > /tmp/floe-web.tgz"
fi

# Provisioning is idempotent: the package.json is written once, and node-pty is
# built only when it is missing or pinned to another version. npm 12 blocks
# install scripts until they are approved, and a native addon is nothing BUT its
# install script.
#
# Fed to `bash -s` rather than passed as a command string: the login shell over
# there may be fish, which does not read this dialect.
# shellcheck disable=SC2086
ssh $SSH_OPTS "$TARGET" bash -s <<REMOTE
set -e
cd ~/$DIR

# The web build is REPLACED, never merged: the chunk names are content-hashed,
# so unpacking over the old directory would keep every previous build's chunks
# there forever.
if [ -f /tmp/floe-web.tgz ]; then
  rm -rf out/web.new && mkdir -p out/web.new
  tar xzf /tmp/floe-web.tgz -C out/web.new
  rm -rf out/web
  mv out/web.new/web out/web
  rm -rf out/web.new /tmp/floe-web.tgz
  echo "web: \$(find out/web -type f | wc -l) files"
fi

if ! grep -q '"node-pty": "$PTY_VERSION"' package.json 2>/dev/null; then
  printf '%s\n' '{' '  "name": "floe-server",' '  "private": true,' \
    '  "dependencies": { "node-pty": "$PTY_VERSION" }' '}' > package.json
  rm -rf node_modules/node-pty
fi
if [ ! -f node_modules/node-pty/build/Release/pty.node ]; then
  echo "── building node-pty for this machine ──"
  npm install --no-audit --no-fund >/dev/null
  npm install-scripts approve node-pty >/dev/null 2>&1 || true
  npm rebuild node-pty >/dev/null
fi
systemctl --user restart floe-server.service
sleep 2
echo "floe-server: \$(systemctl --user is-active floe-server.service)"
node -e "require('node-pty'); console.log('node-pty: loads under', process.version)"
REMOTE
echo "✓ deployed"
