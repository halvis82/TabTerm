# 10 — Limitations

A tiered inventory of what Chrome and macOS will not permit, what they permit only in degraded form,
and what is merely hard.

**Read this before proposing a feature.** Tier 0 items have no workaround. Do not spend effort
rediscovering them, and do not let a plan quietly depend on one.

Update this file whenever a new constraint is discovered.

---

## Tier 0 — Impossible ❌

No API exists. No workaround. Design around these.

### 0.1 Native tab-strip drag-to-merge
Chrome's tab strip is native UI. Extensions receive `chrome.tabs.onMoved`, `onAttached`, and
`onDetached` **after** the fact and get no drop-target interception. Dragging tab A onto tab B and
reinterpreting it as "merge these terminals" cannot be done.

**Alternatives, all implemented:** command palette, keyboard shortcut, "split with previous
terminal," drag from TabTerm's own session list, drag a pane inside an existing workspace.
See `04-session-lifecycle.md` §6.

### 0.2 Deleting one entry from Chrome's recently-closed stack
`chrome.sessions` exposes `getRecentlyClosed()` and `restore()`. There is **no delete**. An expired
terminal's URL stays in `Cmd+Shift+T` history until it ages out naturally.

**Mitigation:** the expired-session recovery page. `04-session-lifecycle.md` §8.

### 0.3 Processes surviving a macOS reboot
OS-level and universal. Nothing can change it.

**Mitigation:** reboot restore recovers context (layout, cwd, last command, snapshot, agent resume ID),
never processes. Explicitly deferred and explicitly framed as context restore.

### 0.4 Intercepting browser-reserved shortcuts in a page
These never reach page JavaScript in a cancelable form on macOS Chrome:

```
Cmd+W   Cmd+T   Cmd+N   Cmd+Q   Cmd+Shift+T   Cmd+L   Cmd+1..9   Cmd+Opt+←/→
```

**Consequence:** in a multi-pane workspace, `Cmd+W` closes the entire
Chrome tab and detaches every pane. It cannot be remapped to "close the focused pane."

**Partial escape hatch:** `navigator.keyboard.lock()` captures them, but **only in fullscreen**.
Used by focus mode. Does not help in normal tabbed mode.

**Accepted.** Per-pane actions use `chrome.commands` bindings and the command palette. This costs a
keystroke, not a feature.

### 0.5 Absolute filesystem path from a Finder drag
HTML5 drag-and-drop yields a `File` object with a **name only**. `File.path` is an Electron
extension, not web. `webkitGetAsEntry()` gives paths relative to a dropped directory root, never
absolute. The File System Access API gives opaque handles.

**Disposition: cut.** See ADR-0014.

The valuable adjacent behavior works fine and is implemented instead: paths **printed by a command**
are clickable and Option-clickable, and `Cmd+Opt+C` in Finder copies a path as text
for a normal paste.

---

## Tier 1 — Possible only in degraded form ⚠️

The feature survives, but not in its obvious form.

### 1.1 Animated favicons in background tabs
Chrome throttles hidden-tab timers to roughly once per minute and pauses `requestAnimationFrame`
entirely. A `setInterval` favicon spinner **does not animate in a hidden tab**, which is precisely
the case the feature existed for.

WebSocket message delivery is *not* timer-throttled, so daemon-pushed frames do work, at the cost of
waking a renderer several times a second per hidden tab. That fights the goals in `11-performance.md`.

**Decision:** animate only when visible, discrete state icons when hidden. `06-chrome-integration.md` §5.

### 1.2 Tab discarding freezes status entirely
Chrome discards background tabs under memory pressure. The renderer is destroyed. The tab keeps its
title and favicon **frozen at discard time**, and the socket is gone. The status indicator silently
goes stale and lies.

**Structural consequence:** the favicon can never be the only status channel. Anything that must
reach the user while a tab is hidden or discarded originates from the offscreen document as a
notification. This is one of the two reasons for the three-connection model.

### 1.3 SSH sessions produce almost no metadata
Everything in the history and time-context layers comes from shell integration emitting escape
sequences. Over SSH the **remote** shell must have the integration installed, or there is nothing
but raw bytes. `host:` and `exit:` history filters silently return empty for remote work.

Related: commands typed **inside** `vim`, an agent CLI, a REPL, or `less` are invisible to the history
layer. Only shell-level commands are ever captured. `08-shell-integration.md` §4.

### 1.4 Do Not Disturb is not detectable
Chrome notifications on macOS route through the native Notification Center, so macOS honors Focus
modes correctly. But the extension **cannot query DND state** and cannot know a notification was
swallowed. Fire and forget.

### 1.5 Tab group colors are a fixed enum
`chrome.tabGroups` accepts only grey, blue, red, yellow, green, pink, purple, cyan, orange.
No arbitrary hex. Workspace template `color` fields are validated against the enum.

### 1.6 Pinned tabs show no title
A pinned Chrome tab renders **only the favicon**. Rich dynamic titles are invisible for exactly the
sessions most likely to be pinned. Combined with 1.1, a pinned background session communicates
through one static 16 px icon.

### 1.7 Kitty graphics protocol
xterm.js supports Sixel and the iTerm2 inline-image protocol via addon, so images are partly
recoverable. The **Kitty graphics protocol is not supported**. Tools targeting it do not render.

---

## Tier 2 — Solvable, but structural ⚠️

Get these wrong early and the fix is a rewrite, not a patch.

### 2.1 macOS TCC identity
Processes spawned by the daemon inherit the **daemon's** privacy identity, not Terminal.app's.
`ls ~/Desktop` may fail. Full Disk Access granted to iTerm does not transfer. Prompts are attributed
to the daemon binary, and a bare `node` daemon means grants can be invalidated by a Node upgrade.

**Fix:** ship the daemon in a signed app bundle with a stable identifier so TCC has a durable
identity. Retrofitting forces every grant to be redone.

### 2.2 MV3 service worker lifetime
Terminates at ~30 s idle. It cannot hold the connection that must always exist, and it is the only
place that can act when no terminal tab exists.

**Fix:** three connection classes. `06-chrome-integration.md` §2.

### 2.3 Server-side VT state is mandatory and not cheap
Reattach must restore *screen state*, not replay bytes. Byte replay breaks the moment an app used
the alternate screen. So the daemon runs a headless emulator per session.

Consequences: the daemon must **always drain the PTY** (never backpressure toward a child process),
and per-session memory is tens of MB, not negligible.
`07-terminal-fidelity.md` §2.

### 2.4 Extension ID stability
Unpacked extension IDs derive from the load path. Without an explicit manifest `"key"`, reinstalling
from a different path changes the ID and **every stable session URL in Chrome's history and
recently-closed stack becomes dead**. Unrecoverable after the fact. The ID must therefore be minted before any session URL exists.

### 2.5 Token bootstrap
The daemon writes a secret to a 0600 file. The extension cannot read files. Bridged by a native
messaging host, whose manifest allowlist also authenticates the extension.

**Origin checks are not a security boundary.** Any local
process can forge the header, and any website can open a WebSocket to loopback with no CORS
preflight. The token is the only control. `05-security.md` §2.

### 2.6 Duplicate tab has no defined semantics by default
`chrome.tabs.duplicate` produces two tabs with the same URL and therefore two frontends on one PTY.
Decided as **mirror** by ADR-0011, with minimum-across-clients resize arbitration.

### 2.7 Multiple Chrome profiles
Each profile is a separate extension instance with its own service worker, all connecting to one
daemon. Handled by a per-profile client ID, with multi-profile attachment treated as mirroring.

### 2.8 Flow control is required, not an optimization
`cat` a large file and the PTY delivers faster than a renderer consumes. Without a credit window and
coalescing, the WebSocket send buffer grows unbounded and the tab dies. `02-protocol.md` §5.

### 2.9 Scrollback archive is mostly noise without semantic marking
Recording raw output captures every `vim` redraw and every progress-bar repaint. Only viable when
restricted to OSC 133-delimited command output regions with alt-screen periods skipped. Narrowed and
deferred to the scrollback archive work.

### 2.10 LaunchAgent environment
The daemon starts with a minimal `PATH`. Spawning `zsh -l` reconstructs the real environment through
`/etc/zprofile`, `path_helper`, and user dotfiles. A non-login shell produces a missing toolchain that
looks like a mysterious per-command bug.

---

## Tier 3 — Hard engineering, no wall ✅

Listed so nothing looks free.

| Item | Note |
|---|---|
| Reattach correctness across alt-screen apps | Falls out of 2.3 if VT state is right. Verified by fixture round-trip |
| Recursive split tree with resize and focus routing | Standard, tedious, property-testable |
| Option as Meta versus macOS alt-glyphs | Tradeoff with typing accented characters. Also conflicts with Option-click and Option-drag |
| Startup thundering herd | N tabs restore at once, possibly before the daemon is up. Lazy attach on visibility plus backoff |
| WebGL context ceiling | Chrome caps concurrent contexts. Handle `webglcontextlost`, degrade to canvas |
| Neovim reuse | `--listen` plus `--remote` works. Requires a shell wrapper so a manually typed `nvim` also gets a socket |
| agent state granularity | Hooks give approval, waiting, done, failed. Not "thinking versus writing" |
| Localhost server detection | Daemon-side, event-driven |
| Bracketed paste, OSC 8, truecolor, mouse, ligatures | Supported in xterm.js, some via addon |
| Job control and signals | Real PTY with a controlling terminal. Works |
| Daemon-initiated tab creation | `chrome.tabs.create` from a service worker needs no user gesture |
| Fonts | CSS `local()` resolves installed families |

---

## Unverified — confirm before depending on

Each has a Phase 0 spike. Nothing load-bearing may rely on an unverified assumption.

| # | Assumption | Spike |
|---|---|---|
| 1 | Offscreen document idle lifetime in current Chrome | the service worker lifetime spike |
| 2 | `chrome.commands` accepts `Command+Alt+T` and `Command+Alt+C` | the keyboard reachability spike |
| 3 | Concurrent WebGL context ceiling with N tabs and panes | the WebGL context spike |
| 4 | Hidden-tab favicon updates via WebSocket push are not coalesced away | the background-tab status spike |
| 5 | node-pty prebuild availability for darwin-arm64 on Node 20 | the node-pty spike |
| 6 | Whether Chrome discards a tab holding an open WebSocket | the background-tab status spike |
| 7 | Whether a signed app bundle yields an upgrade-surviving TCC grant | the TCC spike |
| 8 | Round-trip fidelity of the chosen headless emulator | the VT fidelity spike |
| 9 | Sustained throughput ceiling PTY to rendered output | the throughput spike |

---

## Assumptions that look reasonable and are wrong

Recorded so they are not reintroduced.

| Assumption | Correction |
|---|---|
| "Use one shared extension service worker" | ❌ MV3 service workers die at ~30 s idle. Three connection classes required |
| "Reject non-extension origins" as a security control | ❌ Origin headers are forgeable by any local process. The token is the only boundary |
| "TabTerm daemon: small" in the memory table | ❌ Wrong once server-side VT state exists. Tens of MB per session |
| "Duplicate" listed under natively supported tab behavior | ⚠️ Needs an explicit mirror-or-fork decision. Neither is a default |
| Dragging a file from Finder inserts its path | ❌ Impossible. Cut, tier 0.5 |
| PATAPIM cited as prior art | ❌ Unverifiable. Removed. Chrome Secure Shell / hterm added instead |
| Short reap timers are a safe default | ⚠️ Wrong for workspaces. Pinned by default, ADR-0012 |
| Missing: macOS TCC | ❌ Not mentioned at all. Now tier 2.1, on the critical path |
| Missing: tab discarding | ❌ Not mentioned at all. Now tier 1.2, forces the notification architecture |

