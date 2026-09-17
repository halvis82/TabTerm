#!/usr/bin/env bash
# Reports one agent lifecycle event to the daemon, then gets out of the way.
#
# Runs on the agent's critical path, so it must be fast and must never fail loudly: a hook that
# blocks or errors would degrade the tool it is reporting on. Everything here is best effort.
set -uo pipefail

HOOK="${1:-unknown}"
TOKEN_FILE="$HOME/.local/state/tabterm/token"
# The daemon's own bridge port. Overridable so a check can point this at a stub of it.
PORT="${TABTERM_AGENT_PORT:-7378}"

# No session id means this shell was not started by TabTerm, so there is nothing to report to.
[ -n "${TABTERM_SESSION:-}" ] || exit 0
[ -r "$TOKEN_FILE" ] || exit 0

TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null) || exit 0

# The agent's own session id, which is what `--resume` takes.
#
# The agent hands its hooks a JSON object on standard input, and its session id is in it. That is
# the only place it appears: it is not in the environment, and reading it off the screen is the
# thing this project does not do. See docs/09-agent-integration.md.
#
# Read only when something is actually piped in, so a hook run by hand from a terminal returns
# instead of waiting on a keyboard.
#
# Bounded, and that bound is the important part. This runs on the agent's critical path and the
# agent waits for it, so reading until end of input means trusting somebody else to close a pipe
# before we will let them carry on. One second is far longer than a payload takes to arrive and far
# shorter than the agent's own hook timeout, and a read that times out still reports the state,
# which is the half the product depends on.
AGENT_SESSION=""
if [ ! -t 0 ]; then
  PAYLOAD=""
  IFS= read -r -t 1 -d '' PAYLOAD <&0
  AGENT_SESSION=$(printf '%s' "$PAYLOAD" |
    sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
fi
# Anything that is not a plain identifier is dropped rather than put in a JSON string by hand.
case "$AGENT_SESSION" in
  *[!A-Za-z0-9._-]*) AGENT_SESSION="" ;;
esac

BODY="{\"sessionId\":\"$TABTERM_SESSION\",\"hook\":\"$HOOK\""
[ -n "$AGENT_SESSION" ] && BODY="$BODY,\"agentSessionId\":\"$AGENT_SESSION\""
BODY="$BODY}"

curl --silent --max-time 2 --output /dev/null \
  --header "x-tabterm-token: $TOKEN" \
  --header 'content-type: application/json' \
  --data "$BODY" \
  "http://127.0.0.1:$PORT/agent-event" 2>/dev/null || true

exit 0
