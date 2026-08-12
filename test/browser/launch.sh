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
PROFILE=/tmp/tt-chrome-headless
PORT="${TT_CDP_PORT:-9223}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

pkill -f "user-data-dir=$PROFILE" 2>/dev/null || true
sleep 1
rm -rf "$PROFILE"
mkdir -p "$PROFILE/NativeMessagingHosts"

# A custom profile reads native messaging hosts from its own directory, not the standard one.
cp "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.tabterm.host.json" \
   "$PROFILE/NativeMessagingHosts/" 2>/dev/null || true

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
  if curl -s --max-time 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    exit 0
  fi
done
echo "headless Chrome never came up; see /tmp/tt-headless.log" >&2
exit 1
