#!/usr/bin/env bash
# tabterm doctor: check every link in the chain and say which one is broken.
#
# Reports per item so a failure points at one thing. Never prints the token, command text, or
# terminal output. See docs/05-security.md §9.
set -uo pipefail

STATE="$HOME/.local/state/tabterm"
LIBEXEC="$HOME/.local/libexec/tabterm"
PLIST="$HOME/Library/LaunchAgents/com.tabterm.daemon.plist"
HOST_MANIFEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.tabterm.host.json"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
EXT_ID="${TABTERM_EXT_ID:-$(python3 -c "import json;print(json.load(open('$REPO/package.json'))['tabterm']['extensionId'])" 2>/dev/null)}"
EXT_ID="${EXT_ID:-mcchodnlokiofihbecdeicicfhmgpadb}"
PORT=7377
fails=0

ok()   { printf '  \033[32mOK\033[0m    %s\n' "$1"; }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fails=$((fails+1)); }

echo "TabTerm doctor"
echo

# --- daemon ---------------------------------------------------------------
if launchctl print "gui/$(id -u)/com.tabterm.daemon" >/dev/null 2>&1; then
  ok "LaunchAgent is loaded"
else
  bad "LaunchAgent not loaded. Run: launchctl bootstrap gui/$(id -u) $PLIST"
fi

if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then
  ok "daemon is listening on 127.0.0.1:$PORT"
else
  bad "nothing listening on 127.0.0.1:$PORT. Check $STATE/logs/stderr.log"
fi

# Loopback only. A daemon reachable off-box would be a serious problem.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | grep -q "127.0.0.1:$PORT"; then
  ok "bound to loopback only"
else
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    bad "listening on a non-loopback address. This should never happen"
  fi
fi

# --- token ----------------------------------------------------------------
if [ -f "$STATE/token" ]; then
  mode=$(stat -f '%Lp' "$STATE/token")
  if [ "$mode" = "600" ]; then
    ok "token present, mode 600"
  else
    bad "token has mode $mode, expected 600. The daemon refuses to start like this"
  fi
else
  bad "no token at $STATE/token. Run scripts/install.sh"
fi

# --- native messaging host ------------------------------------------------
if [ -f "$HOST_MANIFEST" ]; then
  if grep -q "$EXT_ID" "$HOST_MANIFEST"; then
    ok "native messaging host registered for the expected extension id"
  else
    bad "host manifest exists but lists a different extension id"
  fi
  host_path=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['path'])" "$HOST_MANIFEST" 2>/dev/null)
  if [ -x "$host_path" ]; then
    ok "host binary is executable"
  else
    bad "host binary missing or not executable: $host_path"
  fi
  case "$host_path" in
    "$HOME/Documents"/*|"$HOME/Desktop"/*|"$HOME/Downloads"/*)
      bad "host lives in a TCC-protected folder. Chrome cannot execute it there" ;;
    *) ok "host is outside TCC-protected folders" ;;
  esac
else
  bad "no native messaging host manifest. Run scripts/install.sh"
fi

# --- staged binaries ------------------------------------------------------
if [ -f "$LIBEXEC/daemon.mjs" ]; then
  ok "daemon staged at $LIBEXEC"
else
  bad "daemon not staged. Run scripts/install.sh"
fi

helper=$(find "$LIBEXEC/node_modules/node-pty/prebuilds" -name spawn-helper 2>/dev/null | head -1)
if [ -n "$helper" ]; then
  if [ -x "$helper" ]; then
    ok "node-pty spawn-helper is executable"
  else
    bad "spawn-helper is not executable. Every PTY spawn will fail with posix_spawnp failed"
  fi
else
  warn "node-pty prebuilds not found beside the staged daemon"
fi

if [ -f "$STATE/tabterm.sqlite" ]; then
  ok "database present ($(du -h "$STATE/tabterm.sqlite" | cut -f1))"
fi

# --- runtime --------------------------------------------------------------
plist_node=$(python3 -c "
import plistlib,sys
try:
    d=plistlib.load(open(sys.argv[1],'rb'))
    print(d['ProgramArguments'][0])
except Exception: print('')
" "$PLIST" 2>/dev/null)
if [ -n "$plist_node" ] && [ -x "$plist_node" ]; then
  if "$plist_node" -e "require('node:sqlite')" >/dev/null 2>&1; then
    ok "daemon runtime has built-in SQLite ($("$plist_node" -v))"
  else
    bad "daemon runtime lacks node:sqlite. Needs Node 22 or newer, has $("$plist_node" -v)"
  fi
fi

# --- authenticated connectivity -------------------------------------------
# A listening port proves very little. A version mismatch, a stale token, and a wedged daemon
# all look identical from outside, and only an authenticated connection tells them apart.
# The LaunchAgent's node, not whatever is first on PATH. The daemon needs Node 22 or newer and
# a machine can easily have an older one earlier in PATH, which would make doctor's own probe
# fail and report that as a daemon problem. The tool you run when things are broken must not be
# broken by the same thing.
PROBE_NODE="${plist_node:-$(command -v node)}"
probe_out=$("$PROBE_NODE" "$(dirname "$0")/health-probe.mjs" 2>/dev/null)
if [ -n "$probe_out" ]; then
  authed=$(printf '%s' "$probe_out" | python3 -c "import json,sys;print(json.load(sys.stdin)['authenticated'])" 2>/dev/null)
  if [ "$authed" = "True" ]; then
    version=$(printf '%s' "$probe_out" | python3 -c "import json,sys;print(json.load(sys.stdin)['serverVersion'])" 2>/dev/null)
    sessions=$(printf '%s' "$probe_out" | python3 -c "import json,sys;print(json.load(sys.stdin)['sessionCount'])" 2>/dev/null)
    ok "authenticated to the daemon (version $version, $sessions live session(s))"
  else
    reason=$(printf '%s' "$probe_out" | python3 -c "import json,sys;print(json.load(sys.stdin)['error'] or 'unknown')" 2>/dev/null)
    bad "could not authenticate to the daemon: $reason"
  fi

  db_ok=$(printf '%s' "$probe_out" | python3 -c "import json,sys;d=json.load(sys.stdin).get('database') or {};print(d.get('ok'))" 2>/dev/null)
  if [ "$db_ok" = "True" ]; then
    schema=$(printf '%s' "$probe_out" | python3 -c "import json,sys;print((json.load(sys.stdin).get('database') or {}).get('schemaVersion'))" 2>/dev/null)
    ok "database passes integrity check (schema version $schema)"
  elif [ -n "$db_ok" ]; then
    bad "database failed its integrity check"
  fi
else
  warn "could not run the health probe using $PROBE_NODE"
fi

# --- shell integration ----------------------------------------------------
if [ -f "$HOME/.local/share/tabterm/tabterm-integration.zsh" ]; then
  if grep -q "tabterm-integration.zsh" "$HOME/.zshrc" 2>/dev/null; then
    ok "shell integration installed and sourced from .zshrc"
  else
    warn "shell integration not sourced. History and timing still work via the OS fallback,"
    echo "        but exit codes, builtins, and sub-second commands need it. To enable:"
    echo "        echo '[ -f ~/.local/share/tabterm/tabterm-integration.zsh ] && source ~/.local/share/tabterm/tabterm-integration.zsh' >> ~/.zshrc"
  fi
else
  warn "shell integration not staged. Run scripts/install.sh"
fi

# --- macOS privacy --------------------------------------------------------
# An ungranted folder HANGS rather than failing, so probe with a timeout.
probe_tcc() {
  local dir="$1"
  ( ls "$HOME/$dir" >/dev/null 2>&1 ) &
  local pid=$!
  local waited=0
  while kill -0 $pid 2>/dev/null && [ $waited -lt 6 ]; do sleep 1; waited=$((waited+1)); done
  if kill -0 $pid 2>/dev/null; then
    kill -9 $pid 2>/dev/null
    echo "hang"
  else
    wait $pid 2>/dev/null && echo "ok" || echo "denied"
  fi
}
for dir in Desktop Documents Downloads; do
  case "$(probe_tcc "$dir")" in
    ok)     ok "this shell can read ~/$dir" ;;
    denied) warn "~/$dir is denied. Re-allow at System Settings > Privacy & Security >
        Files and Folders, or Full Disk Access, then restart the daemon:
        launchctl kickstart -k gui/$(id -u)/com.tabterm.daemon" ;;
    hang)   bad "~/$dir HANGS on a consent prompt. A terminal doing this looks frozen" ;;
  esac
done

# --- disk -----------------------------------------------------------------
if [ -d "$STATE" ]; then
  size=$(du -sh "$STATE" 2>/dev/null | cut -f1)
  ok "state directory is $size"
fi

echo
if [ "$fails" -eq 0 ]; then
  echo "  Everything checks out. Open a terminal with Command+Shift+O."
else
  echo "  $fails problem(s) above."
fi
exit "$fails"
