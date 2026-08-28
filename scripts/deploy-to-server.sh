#!/bin/bash
# Push a new build to a Rookery server that only holds artifacts (no source there).
# Builds locally, ships out/ + bin/ over SSH (tar, no rsync needed), restarts the service.
# The browser web-bridge auto-reconnects, so the restart blip is invisible.
#
#   ./scripts/deploy-to-server.sh                       # defaults to the local Arch test VM
#   RK_SSH='-i ~/.ssh/id -p 22' RK_TARGET=rookery@server.tailnet.ts.net ./scripts/deploy-to-server.sh
set -euo pipefail
cd "$(dirname "$0")/.."

RK_TARGET="${RK_TARGET:-rookery@127.0.0.1}"
RK_SSH="${RK_SSH:--i $HOME/rookery-vm/id_rookery -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 2222}"

echo "── build ──────────────────────────────"
node scripts/build-server.mjs
pnpm exec electron-vite build >/dev/null

echo "── ship + restart ($RK_TARGET) ─────────"
# node_modules on the server (node-pty, built for its arch) is preserved across the extract.
tar czf - out bin package.json \
  | ssh $RK_SSH "$RK_TARGET" '
      cd ~/rookery &&
      mv node_modules /tmp/rk-nm 2>/dev/null || true &&
      tar xzf - &&
      mv /tmp/rk-nm node_modules 2>/dev/null || true &&
      export XDG_RUNTIME_DIR=/run/user/$(id -u) &&
      systemctl --user restart rookery &&
      sleep 2 &&
      echo "restarted: $(systemctl --user is-active rookery)"'
echo "✓ deploy done"
