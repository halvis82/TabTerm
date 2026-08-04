# 01 — Architecture

## Components

| Component | Process | Lifetime | Owns |
|---|---|---|---|
| **Daemon** (`tabtermd`) | Own process, started by launchd at login | Until logout or crash | PTYs, VT state, scrollback, session registry, SQLite, project index |
| **Native messaging host** | Short-lived, spawned by Chrome | One handshake | Token handoff only |
| **Service worker** | Chrome, MV3 | ~30 s idle, then terminated | Dispatch. Nothing durable. |
| **Offscreen document** | Chrome, one per profile | Long-lived (measured in the service worker lifetime spike) | Control connection, notifications, daemon-initiated tab actions |
| **Terminal page** | Chrome renderer, one per tab | Until tab closes or is discarded | xterm.js instances, one data connection, per-pane streams |
| **Shell integration** | Sourced into each spawned zsh | Session lifetime | OSC 7 and OSC 133 emission |

## The invariant that shapes everything

> The daemon owns processes. Chrome owns views. A view can vanish at any moment.

Chrome can and will destroy a terminal page without warning: tab close, tab discard under memory
pressure, renderer crash, Chrome quit. None of those may affect a PTY. Every frontend is therefore
treated as a cache of daemon state, never as the authority.

The consequence that people get wrong: the daemon cannot simply forward bytes. If it only forwarded,
a reattaching view would have no idea what the screen looks like. The daemon must maintain a full
terminal emulator per session so it can answer "what is on screen right now." See `07-terminal-fidelity.md`.

## Why three connection classes

MV3 service workers terminate after roughly 30 seconds idle. Chrome discards background tabs under
memory pressure, destroying their renderers. Neither can hold the one connection that must always
exist. So:

### Control connection — offscreen document, one per Chrome profile

Carries: session list, state change events, notification triggers, tab creation requests from the
daemon, workspace updates. Low volume, must survive indefinitely.

Lives in an offscreen document because the service worker cannot. Reconnects with exponential
backoff and is idempotent on resume: the daemon re-sends current state rather than a delta, so a
missed window costs nothing.

### Data connections — terminal pages, one per page

Carries: terminal output (binary), input, resize, scrollback requests, acks. High volume.

Lives in the page so its lifetime matches the renderer that consumes it. A page holding three panes
holds one connection multiplexing three streams, not three connections.

### Service worker — dispatch only

Handles `chrome.commands` shortcuts, context menus, and `chrome.action` clicks. It wakes, forwards
a message to the offscreen document, and dies. It stores nothing and holds no socket.

**Failure mode this prevents:** if the service worker held the connection, then after 30 seconds of
inactivity with all terminal tabs hidden or discarded, a agent CLI permission prompt would never
produce a notification. The user would sit waiting on a tab that looks idle.

## Data flow: a keystroke

```
keydown in xterm.js
  → data connection, binary input frame, streamId
  → daemon writes to PTY fd
  → shell processes
  → PTY output
  → daemon: (a) feed VT state machine  (b) append to scrollback  (c) enqueue for attached clients
  → coalesced ~4-8 ms, capped chunk, credit-windowed
  → data connection, binary output frame
  → xterm.js write, ack on write callback
```

Steps (a) and (b) happen whether or not any client is attached. **The daemon always drains the PTY.**
Pausing reads would block the child process on `write()`, which would look like a hung terminal.
Memory is bounded by evicting old scrollback, never by backpressure toward the shell.

## Data flow: reattaching a closed tab

```
Cmd+Shift+T
  → Chrome restores chrome-extension://<id>/terminal.html?workspace=<id>
  → page loads, does NOT connect yet
  → first visibilitychange to visible
  → data connection opens, authenticates
  → attach { workspaceId }
  → daemon returns workspace layout + per-pane snapshot (screen + attributes + cursor + alt-screen state)
  → page builds the split tree, constructs xterm.js per pane, writes each snapshot
  → daemon begins streaming live output from the snapshot point onward
```

Attach is lazy and deferred to visibility because Chrome restores every tab at once at startup.
Eight simultaneous snapshot replays is a measurable stall. See `11-performance.md`.

The snapshot and the live stream must not race. The daemon marks a sequence point in the output
queue when it serializes, and streams from exactly that point. No gap, no duplication.

## Directory layout

```
tabterm/
├── shared/                     types + protocol codec, imported by both sides
│   └── src/
│       ├── protocol.ts
│       └── model.ts
├── daemon/
│   └── src/
│       ├── main.ts             entry, launchd-supervised
│       ├── config.ts
│       ├── log.ts
│       ├── lockfile.ts         single instance
│       ├── auth.ts             token generation, handshake
│       ├── server.ts           WebSocket, role routing
│       ├── flow-control.ts     credit windows, coalescing
│       ├── pty-manager.ts      node-pty, spawn, resize, signals
│       ├── vt-state.ts         headless emulator per session
│       ├── scrollback.ts       capped ring + disk spill
│       ├── session-manager.ts  registry
│       ├── session-state.ts    explicit state machine
│       ├── workspace-store.ts  layout trees
│       ├── cleanup.ts          reap policy engine
│       ├── process-state.ts    foreground process, listening ports
│       ├── project-index.ts    git roots, recent dirs
│       ├── command-log.ts      OSC 133 derived records
│       ├── agent-bridge.ts    hook endpoint
│       └── database.ts         SQLite + migrations
├── extension/
│   ├── manifest.json           contains the permanent "key"
│   └── src/
│       ├── service-worker.ts   dispatch only
│       ├── offscreen/
│       │   ├── offscreen.html
│       │   └── control-connection.ts
│       ├── transport/
│       │   └── daemon-client.ts    per-page data connection
│       ├── terminal/
│       │   ├── terminal-page.ts
│       │   ├── xterm-controller.ts
│       │   ├── renderer-policy.ts  webgl / canvas / dom + context loss
│       │   ├── selection.ts
│       │   ├── links.ts
│       │   ├── titles.ts
│       │   └── favicons.ts
│       ├── layout/
│       │   ├── split-tree.ts
│       │   ├── pane.ts
│       │   ├── attach.ts
│       │   └── detach.ts
│       ├── launcher/
│       ├── chrome/
│       │   ├── tabs.ts
│       │   ├── groups.ts
│       │   ├── commands.ts
│       │   └── notifications.ts
│       └── palette/
├── native-host/                token handoff only
├── shell/
│   └── tabterm-integration.zsh
├── launchd/
│   └── com.tabterm.daemon.plist
├── scripts/                    install, uninstall, dev, doctor
└── docs/
```

## Filesystem locations

| Path | Contents | Mode |
|---|---|---|
| `~/.config/tabterm/config.json` | User configuration | 0644 |
| `~/.local/state/tabterm/token` | Auth token | **0600, enforced at startup** |
| `~/.local/state/tabterm/tabterm.sqlite` | Metadata, history, notes | 0600 |
| `~/.local/state/tabterm/scrollback/` | Spilled scrollback | 0700 |
| `~/.local/state/tabterm/logs/` | Rotated logs | 0700 |
| `~/Library/LaunchAgents/com.tabterm.daemon.plist` | LaunchAgent | 0644 |

The daemon refuses to start if the token file mode is wider than 0600.

## Technology decisions

| Choice | Rationale | ADR |
|---|---|---|
| Node + node-pty | Fastest path to a correct PTY layer. Rust deferred, not required. | ADR-0002 |
| Own the PTY, do not wrap tmux | tmux's VT and resize semantics would leak into every feature from shell integration onward, and its pane model does not match a browser split tree. | ADR-0010 |
| Headless xterm for daemon-side VT state | Same emulator as the renderer, so fidelity mismatches are impossible by construction. | ADR-0004 |
| Loopback WebSocket, not native messaging, for streaming | Native messaging is stdio with a 1 MB message cap and awkward multi-tab lifecycle. Used only for the token handoff. | ADR-0005 |
| Vanilla TypeScript in the extension | Design principle 8. A framework buys nothing here and costs renderer memory across many tabs. | ADR-0002 |
| SQLite | Indexed history search without holding a database in JS memory. | ADR-0002 |
