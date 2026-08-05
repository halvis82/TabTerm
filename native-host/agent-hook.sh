#!/usr/bin/env bash
# Reports one agent lifecycle event to the daemon, then gets out of the way.
#
# Runs on the agent's critical path, so it must be fast and must never fail loudly: a hook that
# blocks or errors would degrade the tool it is reporting on. Everything here is best effort.
set -uo pipefail

HOOK="${1:-unknown}"
TOKEN_FILE="$HOME/.local/state/tabterm/token"
PORT=7378

# No session id means this shell was not started by TabTerm, so there is nothing to report to.
[ -n "${TABTERM_SESSION:-}" ] || exit 0
[ -r "$TOKEN_FILE" ] || exit 0

TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null) || exit 0

curl --silent --max-time 2 --output /dev/null \
  --header "x-tabterm-token: $TOKEN" \
  --header 'content-type: application/json' \
  --data "{\"sessionId\":\"$TABTERM_SESSION\",\"hook\":\"$HOOK\"}" \
  "http://127.0.0.1:$PORT/agent-event" 2>/dev/null || true

exit 0
