#!/usr/bin/env bash
# Rebuilds the daemon and extension on change.
#
# A daemon restart must reconnect every live frontend. Getting that right during development
# is what makes crash recovery correct in production. See docs/13-packaging.md.
set -euo pipefail
cd "$(dirname "$0")/.."

node scripts/build-daemon.mjs --watch &
node scripts/build-extension.mjs --watch &
wait
