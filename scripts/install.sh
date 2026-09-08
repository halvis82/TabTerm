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
# The PTY host is staged as its own executable beside the daemon, because it is the half that
# must keep running while the daemon is replaced. See docs/adr/0017.
# Replaced only when it actually changed. This is the process holding every terminal, so
# copying over it unconditionally would mean the next restart of it ends everybody's work for
# no reason. See docs/adr/0017.
if [ -f "$LIBEXEC/pty-host.mjs" ] && cmp -s "$REPO/daemon/dist/pty-host.js" "$LIBEXEC/pty-host.mjs"; then
  echo "  pty host unchanged, left running"
else
  cp "$REPO/daemon/dist/pty-host.js" "$LIBEXEC/pty-host.mjs"
  echo "  pty host updated (running terminals keep going until it is next restarted)"
fi
# Standalone so it runs before, and independently of, a working daemon.
cp "$REPO/daemon/dist/agent-hooks-cli.js" "$LIBEXEC/agent-hooks.mjs"
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

# The daemon is launched through an app bundle, and the reason is privacy prompts.
#
# macOS attaches a privacy decision to the process's executable image. Launching Homebrew's node
# directly makes every prompt read "node" and records the decision against a bare path with no
# code requirement, which macOS does not honor next time: the prompt came back on every single
# launch of an agent. Inside a bundle the same decision attaches to com.tabterm.daemon and
# persists, which is why iTerm and VS Code are asked once and never again.
#
# The bundle carries its own copy of node, 68 KB, because a shell script cannot hold an identity:
# a script's executable image is the interpreter, and a launcher that execs node replaces the
# image with one outside the bundle. Only a real executable living inside it works.
#
# Everything else stays where it was. The daemon file, the PTY host and node_modules are still
# read from $LIBEXEC, because the daemon finds the host beside itself and moving it would replace
# the running host and end every terminal on the machine.
#
# The bundle keeps the runtime it was built with rather than taking today's, because the privacy
# decision is attached to that binary's signature: recopying node on every install would throw the
# decision away after an unrelated "brew upgrade", and the person would be asked again with
# nothing on screen to explain why. The already installed bundle is handed over for that reason.
# It is the copy macOS remembers, and dist/ is a build directory that a clean wipes.
APP="$LIBEXEC/TabTerm.app"
if TABTERM_NODE="$NODE" "$NODE" "$REPO/scripts/build-app-bundle.mjs" \
     --adopt-runtime "$APP/Contents/MacOS/node" >/dev/null 2>&1 &&
   [ -x "$REPO/dist/TabTerm.app/Contents/MacOS/node" ]; then
  rm -rf "$APP"
  cp -R "$REPO/dist/TabTerm.app" "$APP"
  # The copy loses nothing, but a signature checked by path wants re-sealing where it now lives.
  codesign --force --deep --sign - --identifier com.tabterm.daemon "$APP" >/dev/null 2>&1 || true
  if "$APP/Contents/MacOS/node" -e "require('node:sqlite')" >/dev/null 2>&1; then
    LAUNCH_NODE="$APP/Contents/MacOS/node"
    echo "  privacy identity: com.tabterm.daemon (prompts say TabTerm, and are asked once)"
  else
    LAUNCH_NODE="$NODE"
    echo "  WARNING: the bundled runtime does not run here, falling back to $NODE"
    echo "           privacy prompts will say \"node\" and may repeat"
  fi
elif "$APP/Contents/MacOS/node" -e "require('node:sqlite')" >/dev/null 2>&1; then
  # The build failed, and there is already a working bundle here from a previous install.
  #
  # Keep it. A failed build is a reason to leave the identity alone, not a reason to throw it
  # away: falling back to the bare interpreter here silently undoes the thing the bundle exists
  # for, and the only sign is one line in a long install. It happened, from a transient failure,
  # and the symptom is macOS asking for permission on every agent launch again days later.
  LAUNCH_NODE="$APP/Contents/MacOS/node"
  echo "  WARNING: could not rebuild the app bundle, keeping the one already installed"
  echo "           privacy identity is unchanged: com.tabterm.daemon"
else
  LAUNCH_NODE="$NODE"
  echo "  WARNING: could not build the app bundle, falling back to $NODE"
  echo "           privacy prompts will say \"node\" and may repeat"
fi

PLIST="$HOME/Library/LaunchAgents/com.tabterm.daemon.plist"
mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|__NODE__|$LAUNCH_NODE|g" -e "s|__LIBEXEC__|$LIBEXEC|g" \
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

# The extension's code on disk is not the code Chrome is running: it reads an extension when it
# loads it and never again. So the last step of installing is asking the one thing that can do
# something about that, which is the extension itself. Nothing happens if Chrome is not running,
# and the terminals are in the PTY host either way.
"$NODE" "$REPO/scripts/reload-extension.mjs" || true

"$REPO/scripts/doctor.sh" || true

# Agent CLI hooks. Asked rather than assumed, because this writes to a configuration file we
# did not create. Skipped without a terminal, which is what a scripted install has.
if [ -t 0 ] && [ -f "$LIBEXEC/agent-hooks.mjs" ]; then
  if ! node "$LIBEXEC/agent-hooks.mjs" status 2>/dev/null | grep -q "hooks installed"; then
    echo
    echo "Agent CLI hooks report when an agent needs you and when it finishes a turn."
    echo "They are added to your agent settings, backed up first, and removable at any time."
    printf "  Install them now? [y/N] "
    read -r reply
    case "$reply" in
      [yY]*) node "$LIBEXEC/agent-hooks.mjs" install ;;
      *)     echo "  Skipped. Turn on Agent events in TabTerm settings whenever you like." ;;
    esac
  fi
fi

# --- a host from before this build ------------------------------------------
# macOS attaches a privacy decision to the process responsible for a request, and the PTY host is
# the ancestor of every shell, so it is the process macOS names. A host running an unbundled
# `node` cannot be given a durable decision, which is why the prompt comes back on every launch
# rather than once. This build's host runs inside TabTerm.app, which can.
#
# The host is never restarted automatically, because doing so ends every terminal it holds. Said
# here, prominently, because the doctor is somewhere people go when they already suspect a
# problem, and this is a problem that presents as macOS being annoying rather than as TabTerm
# being wrong.
stale_host=$(ps -eo pid=,command= | grep "[l]ibexec/tabterm/pty-host" |
  grep -v "TabTerm.app/Contents/MacOS/node" | head -1)
if [ -n "$stale_host" ]; then
  stale_pid=$(echo "$stale_host" | awk '{print $1}')
  held=$(pgrep -P "$stale_pid" 2>/dev/null | wc -l | tr -d ' ')
  cat <<STALE

  ---------------------------------------------------------------------------
  The terminal service is still the one from before this update.

  It runs an unbundled 'node', so macOS cannot remember a permission decision
  about it: that is why "node would like to access data from other apps" comes
  back every time you start an agent instead of asking once.

  This build's replacement runs as TabTerm.app and is asked about once.

  Restarting it ends the $held terminal(s) it is holding. Nothing restarts it
  for you, because that choice is yours:

      kill $stale_pid

  The daemon starts a new one within a second or two.
  ---------------------------------------------------------------------------
STALE
fi

cat <<NEXT

Next, once:
  1. Chrome, chrome://extensions, enable Developer mode
  2. Load unpacked, choose:
       $REPO/extension/dist
  3. Open a terminal with Option+Shift+T, or click the toolbar icon

The daemon now starts at login. It is running already.

Optional. History, timing and server detection already work without it.
It adds exit codes, shell builtins, and very short commands:
  echo '[ -f ~/.local/share/tabterm/tabterm-integration.zsh ] && source ~/.local/share/tabterm/tabterm-integration.zsh' >> ~/.zshrc

Not done automatically, on purpose:
  - your .zshrc is not edited

NEXT
