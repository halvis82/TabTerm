#!/usr/bin/env bash
# Start a headless Chrome with its own profile, for the browser suites.
#
# Headless by default and deliberately: these run while someone is using the machine, and a
# browser that steals focus every few seconds makes that impossible. Everything the suites need
# works without a window, including WebGL terminal rendering and real key events.
#
# The profile is throwaway and recreated each run, so a suite can never see state left by the
# previous one, and the developer's real Chrome profile is never opened.
set -uo pipefail
PORT="${TT_CDP_PORT:-9223}"
# One profile per port, so several browsers can run side by side. Suites are driven through the
# active target, and several of them sharing one browser fight over which tab that is: keystrokes
# land in somebody else's terminal and the failure looks like a product bug.
PROFILE="/tmp/tt-chrome-headless-$PORT"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

pkill -f "user-data-dir=$PROFILE" 2>/dev/null || true

# Waited for properly, because a dying Chrome still answers on its debugging port.
#
# This was `sleep 1`. A browser told to quit can take several seconds to let go of the port, and
# in that window the check below is satisfied by the one that is leaving: the new browser then
# fails to bind, exits, and the whole run drives a browser that is shutting down. That presents
# as every suite failing slowly, with no error anywhere, and it comes and goes with the machine's
# load. It cost an hour of looking for a product defect that was not there.
for _ in $(seq 1 20); do
  curl -s --max-time 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 || break
  sleep 0.5
done
# Still answering after ten seconds means something is stuck on it. Take the port by force
# rather than start a browser that cannot have it.
if curl -s --max-time 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  lsof -t -i ":$PORT" 2>/dev/null | while read -r pid; do kill -9 "$pid" 2>/dev/null || true; done
  sleep 1
fi

rm -rf "$PROFILE"
mkdir -p "$PROFILE/NativeMessagingHosts"

# A custom profile reads native messaging hosts from its own directory, not the standard one.
#
# And this one answers with **this run's** token rather than the installed daemon's. The extension
# asks the host the moment it starts, so writing the right token into its storage afterwards is a
# race: when the host answered first, every connection in the run was refused and every page said
# the daemon was not responding. Giving the browser a host of its own removes the race and the
# possibility of the suites ever reaching the daemon somebody is working in.
INSTALLED_MANIFEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.tabterm.host.json"
if [ -f "$INSTALLED_MANIFEST" ] && [ -n "${TT_DAEMON_TOKEN:-}" ]; then
  cat > "$PROFILE/tt-host.sh" <<WRAP
#!/bin/sh
TT_DAEMON_TOKEN="$TT_DAEMON_TOKEN" exec "$(command -v node)" "$PWD/test/browser/fake-host.mjs"
WRAP
  chmod +x "$PROFILE/tt-host.sh"
  # The allowed origins come from the installed manifest, so the extension id stays correct.
  python3 - "$INSTALLED_MANIFEST" "$PROFILE/NativeMessagingHosts/com.tabterm.host.json" \
    "$PROFILE/tt-host.sh" <<'PY'
import json, sys
src, dst, path = sys.argv[1], sys.argv[2], sys.argv[3]
manifest = json.load(open(src))
manifest['path'] = path
json.dump(manifest, open(dst, 'w'), indent=2)
PY
else
  cp "$INSTALLED_MANIFEST" "$PROFILE/NativeMessagingHosts/" 2>/dev/null || true
fi

nohup "$CHROME" \
  --user-data-dir="$PROFILE" \
  --headless=new \
  --remote-debugging-port="$PORT" \
  --remote-allow-origins='*' \
  --enable-unsafe-extension-debugging \
  --silent-debugger-extension-api \
  --no-first-run --no-default-browser-check \
  about:blank > /tmp/tt-headless.log 2>&1 < /dev/null &
disown

for _ in $(seq 1 25); do
  sleep 1
  # The browser this script started, not merely something answering: the profile is unique to
  # this port, so a process holding it is the one that was just asked for.
  if curl -s --max-time 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 &&
     pgrep -f "user-data-dir=$PROFILE" >/dev/null 2>&1; then
    exit 0
  fi
done
echo "headless Chrome never came up; see /tmp/tt-headless.log" >&2
exit 1
