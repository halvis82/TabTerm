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

## Install

```sh
./scripts/install.sh
```

That generates the auth token, registers the native messaging host, stages the daemon, installs a
LaunchAgent so it starts at login, and runs a health check. It never edits your `.zshrc` and never
regenerates an existing token.

One step is manual, because Chrome no longer honors `--load-extension`: open `chrome://extensions`,
enable Developer mode, choose **Load unpacked**, and select `extension/dist`.

Then `Command+Shift+E` opens a terminal.

```sh
./scripts/doctor.sh     # check every link in the chain
./scripts/uninstall.sh  # reverse all of it
```

## Requirements

macOS, Chrome, Node 20 or later, zsh. Not cross-platform, and not planned to be.

## Status

Terminals work. A tab renders a real shell, survives being closed and reopened with its process
intact, and titles follow the working directory. Splits and workspaces are not built yet.

## License

MIT. See [LICENSE](LICENSE).
