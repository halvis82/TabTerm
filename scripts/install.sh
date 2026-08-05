#!/usr/bin/env bash
# Idempotent. Safe to re-run. Never edits dotfiles or agent settings without being asked.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$HOME/.local/state/tabterm"
CONFIG="$HOME/.config/tabterm"
# One source of truth: package.json. Override for a Web Store build, whose ID the store
# assigns and which will not match the manifest key.
#   TABTERM_EXT_ID=<published id> ./scripts/install.sh
EXT_ID="${TABTERM_EXT_ID:-$(python3 -c "import json;print(json.load(open('$REPO/package.json'))['tabterm']['extensionId'])" 2>/dev/null)}"
if [ -z "$EXT_ID" ]; then
  echo "could not read the extension id from package.json" >&2
  exit 1
fi
HOSTS="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
# The host binary must NOT live under Documents, Desktop, or Downloads. Chrome has no TCC
# grant for those, so exec fails with a bare "Operation not permitted" and Chrome reports it
# only as "Native host has exited". See docs/13-packaging.md.
LIBEXEC="$HOME/.local/libexec/tabterm"
# node:sqlite needs Node 22 or newer. Picking whatever is first on PATH would silently
# install a daemon that cannot open its own database. See docs/adr/0015.
pick_node() {
  for candidate in "$(command -v node)" /opt/homebrew/opt/node@24/bin/node \
                   /opt/homebrew/opt/node@23/bin/node /opt/homebrew/opt/node@22/bin/node \
                   /usr/local/bin/node; do
    [ -x "$candidate" ] || continue
    if "$candidate" -e "require('node:sqlite')" >/dev/null 2>&1; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}
if ! NODE="$(pick_node)"; then
  echo "  ERROR: no Node with built-in SQLite found. TabTerm needs Node 22 or newer."
  echo "         Install one, for example: brew install node@24"
  exit 1
fi
echo "  node:    $NODE ($("$NODE" -v))"

echo "TabTerm install"
mkdir -p "$STATE/scrollback" "$STATE/logs" "$CONFIG"
chmod 700 "$STATE" "$CONFIG"
echo "  state:  $STATE"

# Never regenerate an existing token: it would invalidate every paired client.
if [ -f "$STATE/token" ]; then
  echo "  token:  already present, left alone"
else
  node -e "require('fs').writeFileSync(process.argv[1], require('crypto').randomBytes(32).toString('hex'), {mode:0o600})" "$STATE/token"
  echo "  token:  generated"
fi
chmod 600 "$STATE/token"

mkdir -p "$HOSTS" "$LIBEXEC"
cp "$REPO/native-host/host.mjs" "$LIBEXEC/host.mjs"
cp "$REPO/native-host/agent-hook.sh" "$LIBEXEC/agent-hook.sh"
chmod +x "$LIBEXEC/agent-hook.sh"
cat > "$LIBEXEC/host-wrapper.sh" <<WRAP
#!/usr/bin/env bash
exec "$NODE" "$LIBEXEC/host.mjs"
WRAP
chmod +x "$LIBEXEC/host-wrapper.sh"
cat > "$HOSTS/com.tabterm.host.json" <<JSON
{
  "name": "com.tabterm.host",
  "description": "TabTerm token bootstrap",
  "path": "$LIBEXEC/host-wrapper.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON
echo "  native messaging host at $LIBEXEC, registered for $EXT_ID"

mkdir -p "$HOME/.local/share/tabterm"
cp "$REPO/shell/tabterm-integration.zsh" "$HOME/.local/share/tabterm/"
echo "  shell integration staged (not sourced automatically)"

npm --prefix "$REPO" run build >/dev/null
echo "  built daemon and extension"

# The daemon runs from ~/.local/libexec too, for the same TCC reason as the native host:
# a LaunchAgent cannot reliably execute code living under ~/Documents.
# Named .mjs so Node treats it as ESM without needing a package.json alongside. The bundle
# uses import.meta, which a .js file outside a "type": "module" package would reject.
cp "$REPO/daemon/dist/main.js" "$LIBEXEC/daemon.mjs"
# node-pty is a native module and cannot be bundled, so it ships beside the daemon.
mkdir -p "$LIBEXEC/node_modules"
for mod in node-pty; do
  rm -rf "$LIBEXEC/node_modules/$mod"
  cp -R "$REPO/node_modules/$mod" "$LIBEXEC/node_modules/$mod"
done
# Preserve the spawn-helper executable bit through the copy. Without it every PTY spawn fails
# with a bare "posix_spawnp failed" that names no file.
find "$LIBEXEC/node_modules/node-pty/prebuilds" -name spawn-helper -exec chmod 755 {} \;
echo "  daemon staged at $LIBEXEC"

PLIST="$HOME/Library/LaunchAgents/com.tabterm.daemon.plist"
mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|__NODE__|$NODE|g" -e "s|__LIBEXEC__|$LIBEXEC|g" \
    -e "s|__STATE__|$STATE|g" -e "s|__HOME__|$HOME|g" \
    "$REPO/launchd/com.tabterm.daemon.plist.template" > "$PLIST"
# bootout is asynchronous. Bootstrapping immediately after can race and silently fail, so
# wait for the service to actually disappear before loading the new definition.
launchctl bootout "gui/$(id -u)/com.tabterm.daemon" 2>/dev/null || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  launchctl print "gui/$(id -u)/com.tabterm.daemon" >/dev/null 2>&1 || break
  sleep 0.5
done
if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
  echo "  LaunchAgent installed and started"
else
  echo "  WARNING: launchctl bootstrap failed. Run it by hand:"
  echo "    launchctl bootstrap gui/$(id -u) $PLIST"
fi

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if nc -z 127.0.0.1 7377 2>/dev/null; then echo "  daemon is listening on 127.0.0.1:7377"; break; fi
  sleep 0.5
done

"$REPO/scripts/doctor.sh" || true

cat <<NEXT

Next, once:
  1. Chrome, chrome://extensions, enable Developer mode
  2. Load unpacked, choose:
       $REPO/extension/dist
  3. Open a terminal with Command+Shift+O, or click the toolbar icon

The daemon now starts at login. It is running already.

Optional, reports agent state to the tab favicon and notifications:
  node $REPO/scripts/install-agent-hooks.mjs          # add
  node $REPO/scripts/install-agent-hooks.mjs --remove # take back out

Optional. History, timing and server detection already work without it.
It adds exit codes, shell builtins, and very short commands:
  echo '[ -f ~/.local/share/tabterm/tabterm-integration.zsh ] && source ~/.local/share/tabterm/tabterm-integration.zsh' >> ~/.zshrc

Not done automatically, on purpose:
  - your .zshrc is not edited

NEXT
