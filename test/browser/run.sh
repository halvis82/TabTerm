#!/usr/bin/env bash
# Run every browser suite against one daemon and one headless browser.
#
# Setup that touches shared state lives here rather than in a suite. A suite that restarted the
# daemon for its own purposes once took down every suite that ran after it, and the failures
# looked like nine unrelated product bugs.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUITES="$ROOT/test/browser/suites"
export TT_CDP_PORT="${TT_CDP_PORT:-9223}"

# The daemon needs Node 22+; a machine can easily have an older one first on PATH.
if [ -x /opt/homebrew/opt/node@24/bin/node ]; then
  export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
fi

cd "$ROOT"
npm run --silent build >/dev/null 2>&1 || { echo "build failed"; exit 1; }

pkill -f "http.server 87" 2>/dev/null
bash "$ROOT/test/browser/launch.sh" || exit 1
node "$ROOT/test/browser/load-extension.mjs" >/dev/null || exit 1

pass=0; fail=0
for suite in "$SUITES"/*.mjs; do
  name=$(basename "$suite" .mjs)
  # iCloud sync conflict copies are stale duplicates of a real suite, and running one reports
  # yesterday's results beside today's under a name that looks almost right.
  case "$name" in *" "[0-9]) echo "  skipping conflict copy: $name"; continue ;; esac
  out=$(node "$suite" 2>&1)
  p=$(printf '%s\n' "$out" | grep -c "^  PASS")
  f=$(printf '%s\n' "$out" | grep -c "^  FAIL")
  pass=$((pass + p)); fail=$((fail + f))
  [ "$f" -gt 0 ] && printf '%s\n' "$out" | grep "^  FAIL"
  printf "  %-18s %s\n" "$name" "$(printf '%s\n' "$out" | tail -1 | xargs)"
done

# Anything a suite could not clean up itself, usually because it reloaded the page and lost the
# connection that would have done it. Sessions outlive the daemon now, so a leak here is a shell
# running on the machine until somebody notices.
node "$ROOT/test/browser/sweep.mjs" || true

pkill -f "http.server 87" 2>/dev/null
echo "  -----  $pass passed, $fail failed"
exit "$fail"
