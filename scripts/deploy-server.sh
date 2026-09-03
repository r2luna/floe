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

echo "── ship → $TARGET:~/$DIR ─────────────────"
# shellcheck disable=SC2086
ssh $SSH_OPTS "$TARGET" "mkdir -p ~/$DIR/out/server"
# shellcheck disable=SC2086
scp $SSH_OPTS -q out/server/index.js "$TARGET:~/$DIR/out/server/index.js"

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
