# TabTerm

A macOS terminal system where local PTY sessions behave like native Chrome tabs.

A background daemon owns the processes. Chrome owns only the views. Terminals are ordinary Chrome
extension pages at stable URLs, so Chrome's own tab machinery works on them for free: reorder, pin,
move between windows, group, close, restore.

Closing a tab does not kill a terminal. Reopening it restores the running process and the exact
screen, including a pane in the middle of a `vim` edit with unsaved changes.

## Architecture

```
Chrome extension  ──┬── service worker      (dispatch only)
                    ├── offscreen document  (control connection, notifications, tab actions)
                    └── terminal pages      (one data connection each, per-pane streams)
                              │
                     authenticated loopback WebSocket
                              │
                    macOS daemon  ── PTY sessions ── zsh / editors / shells / servers
                              │
                    launchd LaunchAgent (starts at login)
```

## Documentation

| Document | Contents |
|---|---|
| [Overview](docs/00-overview.md) | What this is, principles, non-goals |
| [Architecture](docs/01-architecture.md) | Components, process model, connection classes |
| [Protocol](docs/02-protocol.md) | Wire format, framing, auth, flow control |
| [Data model](docs/03-data-model.md) | SQLite schema and shared types |
| [Session lifecycle](docs/04-session-lifecycle.md) | Attach, detach, expiry, merge, restore |
| [Security](docs/05-security.md) | Threat model, token bootstrap, untrusted input |
| [Chrome integration](docs/06-chrome-integration.md) | MV3 shape, tabs, groups, titles, favicons, keyboard |
| [Terminal fidelity](docs/07-terminal-fidelity.md) | VT state, serialization, renderers, resize |
| [Shell integration](docs/08-shell-integration.md) | OSC 7 and OSC 133 |
| [Agent integration](docs/09-agent-integration.md) | Agent CLI hook bridge and state surfacing |
| [Limitations](docs/10-limitations.md) | What Chrome and macOS will not permit |
| [Performance](docs/11-performance.md) | Memory budgets, flow control, throttling |
| [Testing](docs/12-testing.md) | Fixtures, round-trip tests, verification |
| [Packaging](docs/13-packaging.md) | App bundle, launchd, distribution, install |
| [Decisions](docs/adr/) | Architecture decision records |

The specification is kept current with the code. A change that alters the protocol, the schema, or a
documented behavior updates the corresponding document in the same commit.

## Layout

```
daemon/        PTYs, VT state, sessions, SQLite, protocol server
extension/     MV3 extension: service worker, offscreen doc, terminal pages
shared/        Types and protocol codec, imported by both
native-host/   Native messaging host, token bootstrap only
shell/         zsh integration, OSC 7 and OSC 133
launchd/       LaunchAgent plist
scripts/       install, uninstall, dev, doctor
docs/          Specification and decision records
```

## Setup

Everything runs locally and is built from source. Nothing is downloaded at install time, and
nothing needs to be notarized, because the bundle is built on your machine rather than shipped
to it.

### 1. Requirements

macOS 13 or newer, Chrome 120 or newer, **Node 22 or newer**, zsh.

Node 22 is a hard floor, not a preference: the daemon uses `node:sqlite`, which does not exist
before it. `install.sh` refuses to continue on an older runtime rather than failing later in a
way that looks like something else.

### 2. Build

```sh
git clone https://github.com/halvis82/TabTerm.git
cd TabTerm
npm install
npm run build
```

### 3. Install the daemon

```sh
./scripts/install.sh
```

That generates the auth token, registers the native messaging host, stages the daemon, installs
a LaunchAgent so it starts at login, and runs a health check.

It **never edits your `.zshrc`** and **never regenerates an existing token**. Two steps are
offered rather than performed, because both are things you should decide: the shell integration
and the agent CLI hooks.

### 4. Load the extension

Chrome no longer honors `--load-extension`, so this step is manual:

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → select `extension/dist`

The extension ID is pinned by the `key` in the manifest, so it stays the same across reloads and
reinstalls. That matters: every terminal tab is a `chrome-extension://<id>/...` URL, and a
changed ID would invalidate every one of them in your history.

### 5. macOS will ask for permission once

The first time a terminal reads `~/Documents`, `~/Desktop` or `~/Downloads`, macOS asks. It asks
about **TabTerm's daemon**, not about Terminal.app, so permissions you granted other terminals do
not carry over.

Allowing is a one-time decision per folder. **Denying is not fatal and not permanent**: the
command fails with `Operation not permitted` the way any permission error does, and you can
re-allow it later in System Settings, Privacy & Security, Files and Folders. Restart the daemon
afterwards so the new grant is picked up:

```sh
launchctl kickstart -k gui/$(id -u)/com.tabterm.daemon
```

The one state worth knowing about is *unanswered*: while a prompt is pending the command blocks,
which looks like a frozen terminal. `./scripts/doctor.sh` checks all three folders and tells the
three states apart.

#### Optional: stop an agent asking for permission on every launch

**Nothing here is required.** TabTerm works fully without it, every terminal behaves the same, and
no feature is lost. This section exists only to silence a prompt that repeats.

If you run Claude Code in TabTerm you may see this on every single launch:

> "TabTerm.app" would like to access data from other apps.

**TabTerm is not the one asking.** Claude Code probes
`~/Library/Application Support/Claude/org-plugins`, which belongs to the Claude *desktop* app.
macOS attributes a file access to the **responsible process**, which for a shell is whatever
started it, which is TabTerm. So the prompt carries TabTerm's name for something the agent does.

It repeats because that directory usually does not exist. A probe that never finds anything never
stops, so every launch asks again. Answering the prompt does not settle it: unlike the folder
prompts above, this decision is re-asked rather than remembered.

You have three options.

**1. Leave it and press "Don't Allow" each time.** Nothing breaks. You lose the agent's org
plugins, which most people do not use. This is the right choice if you find the prompt tolerable
or if the trade below does not appeal.

**2. Turn the probe off** by not running that agent in TabTerm. The prompt belongs to the agent,
not the terminal.

**3. Give TabTerm Full Disk Access**, which stops it:

> System Settings → Privacy & Security → Full Disk Access → **+** → `TabTerm.app` → enable

The bundle lives at `~/.local/libexec/tabterm/TabTerm.app`. `~/.local` is hidden in Finder, so use
Command+Shift+G and paste that path, or run `open -R ~/.local/libexec/tabterm/TabTerm.app`. The
toggle takes effect immediately; no restart is needed.

**Understand what that grants before you do it.** Full Disk Access is broad: it lets the process
read protected locations across your machine, including other applications' data, Mail, Messages
and Safari. You are granting it to the process that runs your shells, which means anything you run
in a TabTerm terminal inherits that reach. That is a real widening of what a terminal can touch,
and it is why this is the third option rather than the first. It is the same grant people give
iTerm and Terminal.app, and the same reasoning applies: convenient, and worth a moment's thought.

Confirmed on a real machine: with it enabled the prompt stops. Turning it off again brings the
prompts back and breaks nothing else, so it is safe to try and safe to undo.

**An update can undo this grant.** macOS records the grant against the app's code signature, and
the bundle is signed ad hoc, so its signature is a hash of its own contents. Change what is inside
it, an icon included, and it is a different app as far as the privacy system is concerned: the
grant stops applying and the prompt returns. If that happens, remove `TabTerm.app` from the Full
Disk Access list with the **-** button and add it again. `./scripts/doctor.sh` says which state you
are in, so check there first rather than guessing.

`./scripts/doctor.sh` reads the grant from the system privacy database and reports which of the
two states you are in.

### 6. Open a terminal

`Option+Shift+T`. `Shift+Command+.` and `Control+Shift+T` also work, and all three are
rebindable at `chrome://extensions/shortcuts`.

An extension shortcut is handled by the browser before the page sees it, so whatever it is bound
to is taken away from every site you visit. That is why the default is an Option combination:
web applications bind Command, so Option is nearly empty, and a terminal shortcut should not cost
you a shortcut in an application you already use.

### 7. Check it

```sh
./scripts/doctor.sh
```

Reports per item, so a failure points at one thing rather than at "it does not work". If
something is wrong, this is the first thing to run and usually the last.

```sh
./scripts/uninstall.sh   # reverses all of it
```

### Optional: shell integration

```sh
echo '[ -f ~/.local/share/tabterm/tabterm-integration.zsh ] && source ~/.local/share/tabterm/tabterm-integration.zsh' >> ~/.zshrc
```

**Not required.** Command history, timing, pane status, and local server detection all work
without it, because the daemon asks the OS what a shell is running instead of asking the shell.

What the integration adds: exit codes, shell builtins like `cd` and `export`, and commands that
finish faster than the fallback can see them. See
[shell integration](docs/08-shell-integration.md) §5.

### Optional: agent CLI hooks

```sh
node scripts/install-agent-hooks.mjs          # install
node scripts/install-agent-hooks.mjs --remove # reverse
```

Additive and reversible. It surfaces agent state — running, waiting for approval, finished — in
the tab title and favicon, so a hidden tab waiting on you is visible.

### Optional: plugins

Drop a `.mjs` file in `~/.config/tabterm/plugins/` and restart the daemon. See
[plugins/README.md](plugins/README.md) and `plugins/example.mjs`.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Nothing happens on the shortcut | Chrome may not have bound it. Check `chrome://extensions/shortcuts` |
| "TabTerm is not paired with the daemon yet" | Native messaging host is not registered, or points at a file Chrome cannot execute. `doctor.sh` says which |
| Terminals open but nothing runs | `node-pty`'s `spawn-helper` lost its executable bit. `doctor.sh` checks this specifically |
| The daemon will not start | Almost always Node older than 22. `doctor.sh` reports the version it found |
| History is empty | Expected on a fresh install; it fills as you run commands |
| A command touching `~/Documents`, `~/Desktop` or `~/Downloads` hangs | macOS is waiting on a privacy prompt you have not answered. Answer it; the command continues |
| The same command fails with `Operation not permitted` | You denied that folder. Re-allow it in System Settings, Privacy & Security, Files and Folders, then `launchctl kickstart -k gui/$(id -u)/com.tabterm.daemon` |

Anything else: `node scripts/diagnostics.mjs` writes a redacted bundle to your Desktop. It
contains no scrollback, command text, or environment values, and it says what it redacted.

## Distributing it

**The macOS side is built from source and needs no signing.** A locally built bundle carries no
quarantine attribute, so Gatekeeper does not assess it, and the ad-hoc signature is enough to
give macOS a stable identity to attach privacy grants to. A Developer ID and notarization are
only needed to ship a prebuilt `.app` for download.

```sh
npm run package:app   # dist/TabTerm.app, ad-hoc signed
```

**The Chrome extension is different.** If you publish to the Chrome Web Store, **the store
assigns the extension ID** and the manifest `key` cannot control it. A new ID breaks the native
messaging host allowlist and every stable tab URL, so it has to be recorded:

```sh
npm run package:extension -- --published   # dist/tabterm-extension-<version>.zip
# upload, then take the ID the store assigned:
#   1. put it in package.json under tabterm.extensionId
#   2. re-run ./scripts/install.sh
```

`package.json` is the single place that records it; `install.sh` and `doctor.sh` both read it,
and `TABTERM_EXT_ID=<id>` overrides it for a one-off.

There is also a managed-policy route that needs no store listing at all:

```sh
npm run package:extension -- --policy
```

That writes a plist and prints how to apply it. It is written, never installed: applying it
needs root and changes Chrome for every profile on the machine.

## Status

Complete. Terminals, splits, workspaces, restore across close and reopen with the process
intact, project templates behind a trust prompt, history search, saved commands, agent
integration, a local server dashboard, reboot restore, and a plugin API.

Plus a floating command menu with favorites, history, hotstrings and session statistics, tab
status in the favicon and title, and desktop notifications when a long command or an agent turn
finishes.

Terminals survive an update. PTYs live in a separate host process, so replacing the daemon does
not end anything running, and a restarted daemon adopts the sessions it finds. History is kept on
disk per session, bounded by a budget you set in megabytes.

664 unit tests and 124 browser checks. `npm run verify` gates every change.

Read [limitations](docs/10-limitations.md) before filing anything: what Chrome and macOS will
not permit is documented there with measurements, including the things that cannot be fixed.

## License

MIT. See [LICENSE](LICENSE).

## If terminals stop opening

Every terminal on the machine fails to start, including ones that have nothing to do with
TabTerm. TabTerm reports `posix_spawnp failed` and iTerm reports a session ending immediately.

macOS caps how many pseudo-terminals exist at once, and the cap is low:

    sysctl kern.tty.ptmx_max      # 511 by default
    ls /dev/ttys* | wc -l         # how many are allocated

When the second number reaches the first, nothing on the machine can open a terminal. Two ways
out, and the first does not need a restart:

    pkill -f 'libexec/tabterm/pty-host'     # frees everything TabTerm was holding
    sudo sysctl -w kern.tty.ptmx_max=999    # raises the cap, until the next reboot

Restarting the PTY host ends the terminals it was running, which is the price, and it is a smaller
one than rebooting. 999 rather than a round number: macOS rejects anything at or above 1024. To
make the cap survive a restart, put `kern.tty.ptmx_max=999` in `/etc/sysctl.conf`.

### Why it filled up

A pseudo-terminal stays allocated while its master handle is open, and **node-pty 1.1.0 never
closed that handle**. Every session cost one pseudo-terminal for the entire life of the PTY host,
which is designed to run for months, so the supply drained a session at a time until nothing on
the machine could open a terminal.

Measured on a machine at 827 allocated: TabTerm's host held 820 of them, and only 13 were open by
any process. Fixed by moving to node-pty 1.2.0-beta.15, where spawning and killing twenty
terminals moves the count by zero.

Other applications leak the same way. iTerm held 101 on the same machine, and only a reboot
clears those.
