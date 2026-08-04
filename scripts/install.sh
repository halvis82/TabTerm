#!/usr/bin/env bash
# Idempotent. Safe to re-run. Never edits dotfiles or agent settings without being asked.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$HOME/.local/state/tabterm"
CONFIG="$HOME/.config/tabterm"
EXT_ID="mcchodnlokiofihbecdeicicfhmgpadb"
HOSTS="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
# The host binary must NOT live under Documents, Desktop, or Downloads. Chrome has no TCC
# grant for those, so exec fails with a bare "Operation not permitted" and Chrome reports it
# only as "Native host has exited". See docs/13-packaging.md.
LIBEXEC="$HOME/.local/libexec/tabterm"
NODE="$(command -v node)"

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

npm --prefix "$REPO" run build >/dev/null
echo "  built daemon and extension"

cat <<NEXT

Next, once:
  1. Chrome, chrome://extensions, enable Developer mode
  2. Load unpacked, choose:
       $REPO/extension/dist
  3. Start the daemon:
       node $REPO/daemon/dist/main.js
  4. Open a terminal with Command+Shift+E, or click the toolbar icon

Not done automatically, on purpose:
  - shell integration is not added to your .zshrc
  - no LaunchAgent is installed yet
NEXT
