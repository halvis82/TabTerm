#!/usr/bin/env bash
# Removes everything install.sh created. Prompts before touching the database, which holds
# notes and saved commands.
set -uo pipefail
STATE="$HOME/.local/state/tabterm"
LIBEXEC="$HOME/.local/libexec/tabterm"
PLIST="$HOME/Library/LaunchAgents/com.tabterm.daemon.plist"
HOST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.tabterm.host.json"

echo "TabTerm uninstall"
launchctl bootout "gui/$(id -u)/com.tabterm.daemon" 2>/dev/null && echo "  LaunchAgent stopped" || echo "  LaunchAgent was not running"
rm -f "$PLIST" && echo "  plist removed"
rm -f "$HOST"  && echo "  native messaging host unregistered"
# Before the binaries go, since the helper that knows how to remove them lives among them.
# Hooks left behind would point at a script that no longer exists, and every agent turn would
# quietly try to run it.
if [ -f "$LIBEXEC/agent-hooks.mjs" ]; then
  node "$LIBEXEC/agent-hooks.mjs" remove >/dev/null 2>&1 && echo "  agent CLI hooks removed"
fi

rm -rf "$LIBEXEC" && echo "  binaries removed"
rm -f "$STATE/token" && echo "  token removed"

if [ -f "$STATE/tabterm.sqlite" ]; then
  read -r -p "  Delete the database (notes, saved commands, history)? [y/N] " reply
  case "$reply" in
    [yY]*) rm -f "$STATE"/tabterm.sqlite*; echo "  database deleted" ;;
    *) echo "  database kept at $STATE" ;;
  esac
fi

cat <<NEXT

Remove by hand, since install never added them automatically:
  - the TabTerm extension, at chrome://extensions
  - any TabTerm line in your .zshrc
NEXT
