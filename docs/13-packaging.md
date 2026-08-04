# 13 — Packaging, Install, and Operations

Two artifacts have to reach the machine and find each other: a daemon that launchd starts at login,
and a Chrome extension with a permanent identity. Both have a macOS-specific trap.

---

## 1. The daemon must be an app bundle

Not a convenience. A requirement, driven by macOS TCC (`10-limitations.md` tier 2.1).

Processes spawned by the daemon inherit the **daemon's** privacy identity. If the daemon is a bare
`node` process:

- TCC prompts read "node" wants access to your Desktop
- The grant is tied to that binary path and can be invalidated by a Node upgrade or a Homebrew change
- Full Disk Access granted to iTerm does not transfer, and there is nothing stable to grant it to

So the daemon ships inside a signed bundle with a stable identifier:

```
TabTerm.app/
└── Contents/
    ├── Info.plist          CFBundleIdentifier: com.tabterm.daemon
    ├── MacOS/tabtermd      the executable launchd starts
    └── Resources/          bundled node runtime, daemon dist, migrations
```

The LaunchAgent points at `Contents/MacOS/tabtermd`, never at a Homebrew `node`. TCC grants then
attach to the bundle identifier and survive upgrades.

**the TCC spike confirms this behaves as described before the app bundle work implements it.** If a signed bundle turns
out not to give a stable grant, the plan changes.

---

## 2. LaunchAgent

`~/Library/LaunchAgents/com.tabterm.daemon.plist`

```xml
<key>Label</key>            <string>com.tabterm.daemon</string>
<key>ProgramArguments</key> <array><string>/Applications/TabTerm.app/Contents/MacOS/tabtermd</string></array>
<key>RunAtLoad</key>        <true/>
<key>KeepAlive</key>        <dict><key>SuccessfulExit</key><false/></dict>
<key>ProcessType</key>      <string>Interactive</string>
<key>StandardErrorPath</key><string>~/.local/state/tabterm/logs/stderr.log</string>
```

Notes:

- `KeepAlive` restarts on crash but not after a clean shutdown, so `tabterm stop` actually stops it
- `ProcessType: Interactive` keeps macOS from aggressively throttling it
- **The daemon and Chrome race at login.** This is the normal path. Terminal pages back off and
  connect when the daemon appears, rather than showing an error. See `04-session-lifecycle.md` §5

### The node-pty spawn-helper permission

node-pty shells out to a small `spawn-helper` binary to set up the controlling terminal. The npm
tarball extraction does not preserve its executable bit on macOS, so **every PTY spawn fails** with:

```
Error: posix_spawnp failed.
```

The message names no file, so it is easily misdiagnosed as an environment, cwd, or entitlement
problem. It is none of those. `scripts/postinstall.mjs` restores the bit on every install, and the
app bundle build must preserve it when copying `node_modules`.

This reproduces on every fresh install. It is handled by the build, never by hand.

### The `PATH` trap

A LaunchAgent starts with a minimal `PATH`. The daemon therefore always spawns `zsh -l`, a **login**
shell, which reconstructs the real environment via `/etc/zprofile`, `path_helper`, and user dotfiles.

Measured: from `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, a login shell produced 26 entries against 14
for a non-login shell, and the 12 it added included `/usr/local/bin` and `/opt/homebrew/sbin`.

Whether a non-login shell happens to get a usable `PATH` depends entirely on where the user put
their edits: `.zshrc` runs for interactive non-login shells, `.zprofile` does not. That is exactly
why it cannot be relied on. A login shell is the only spawn that works regardless of dotfile layout.
A non-login shell produces a missing toolchain that presents as a mysterious per-command bug.
`10-limitations.md` tier 2.10.

---

## 3. Extension distribution

The extension ID is permanent, minted in extension identity minting, and embedded as `"key"` in the manifest. Without it,
reinstalling from a different path changes the ID and kills every stable session URL in Chrome's
history. `10-limitations.md` tier 2.4.

Two acceptable channels, decided in extension identity minting:

| Channel | Pros | Cons |
|---|---|---|
| **Unlisted Web Store listing** | Stable ID, auto-enable at Chrome start, clean update path | Review process. An extension that connects to loopback and runs shell commands is a nontrivial review |
| **Managed-policy forcelist** | No review, auto-enable, fully local | Requires a managed preferences plist, more install machinery |

Loading unpacked works for development and is what Phase 0 through 2 use, with the explicit `"key"`
in place from day one so the ID never changes.

**Update rule:** an extension update must never change the ID. Every stable URL in every user's
Chrome history depends on it.

---

## 4. Native messaging host

Token bootstrap only (`05-security.md` §3).

```
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.tabterm.host.json
```

```json
{
  "name": "com.tabterm.host",
  "path": "/Applications/TabTerm.app/Contents/MacOS/tabterm-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://mcchodnlokiofihbecdeicicfhmgpadb/"]
}
```

`allowed_origins` is enforced by Chrome, which is what makes the host authenticate the extension in a
way the WebSocket alone cannot. The host reads one 0600 file and returns one message. It spawns
nothing and accepts no commands.

---

## 5. Install

`scripts/install.sh`, idempotent, safe to re-run.

1. Place `TabTerm.app`
2. Create `~/.config/tabterm/` and `~/.local/state/tabterm/{scrollback,logs}`
3. Generate the token at mode 0600 if absent. **Never regenerate an existing one**
4. Initialize the database, run migrations
5. Write the LaunchAgent plist, `launchctl bootstrap`
6. Write the native messaging host manifest with the permanent extension ID
7. Offer shell integration. Print the exact `.zshrc` line. **Never edit dotfiles automatically**
8. Offer agent CLI hook installation. Additive and reversible only
9. Print the extension install step
10. Run `tabterm doctor` and print the result

Steps 7 and 8 are offers, never actions. Editing someone's `.zshrc` or the agent settings without
asking is not acceptable, and both are the most likely things to break.

### Upgrade

Preserves the token, the database, all trust grants, and the extension ID. Migrations run forward.
A failed migration leaves the previous database intact and refuses to start rather than corrupting it.

### Uninstall

`scripts/uninstall.sh` removes: the LaunchAgent (`launchctl bootout` first), the app bundle, the
native host manifest, the token, and the state directory. It **prompts before deleting the database**,
because it holds notes and saved commands the user may want.

It prints, rather than performs, the `.zshrc` line to remove and the the agent hook entries to remove.
Same principle as install.

---

## 6. Diagnostics

`tabterm doctor` checks and reports with per-item status:

| Check | Detects |
|---|---|
| Daemon running and responsive | launchd or crash issues |
| Token file exists, mode 0600 | The most common auth failure |
| Extension connected, ID matches | ID drift, the tier 2.4 disaster |
| Native host manifest present and pointing at a real binary | Bootstrap failure |
| Shell integration sourced and emitting | Silent metadata loss |
| the agent hooks installed and events arriving | Silent state loss |
| TCC: can the daemon read `~/Desktop` | Tier 2.1, the least obvious failure |
| Database integrity and migration version | Corruption |
| Disk usage of scrollback and logs | Runaway growth |
| Session count and daemon RSS against budget | Memory regression |

`tabterm doctor --bundle` produces a redacted diagnostic archive and lists exactly what it includes.
Logs never contain command text, environment values, or terminal output by default.

---

## 7. Development

`scripts/dev.sh`:

- Daemon in watch mode, restarting on change without killing live PTYs where possible
- Extension build in watch mode
- A stub client for driving the daemon without Chrome

A daemon restart is a real event, not a dev-only edge case. It **must** reconnect every live frontend
and, where the design allows, preserve sessions across a restart. Getting this right during
development is what makes crash recovery correct in production.

---

## 8. Repository conventions

| Path | Committed | Notes |
|---|---|---|
| `docs/` | Yes | The specification |
| `daemon/`, `extension/`, `shared/`, `shell/`, `native-host/` | Yes | Source |
| `scripts/`, `launchd/`, `examples/` | Yes | |

| `plugins/` | No, except `.gitkeep` | Local personal customizations |
| `*.sqlite`, `state/`, `logs/`, `dist/`, `node_modules/` | No | `.gitignore` |
| Signing key | **No, and never in the repo** | Kept outside the working tree |
