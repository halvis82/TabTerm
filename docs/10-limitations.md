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

### 1.1 Self-driven animation in background tabs
Measured on Chrome 150: in a hidden tab `requestAnimationFrame` is **fully paused, 0 frames**, and
`setInterval(1000)` drops to 0.53/s and degrades further. A self-driven favicon spinner cannot
animate in a background tab.

What *does* work, also measured: **WebSocket delivery to a hidden tab is completely unthrottled**
(60 of 60 messages at 10 Hz, identical to a visible tab), and title and favicon writes still apply.
A hidden tab repainted its favicon 25 out of 25 times at 5 fps when the frames were pushed.

So this is a **cost tradeoff, not a capability limit**. A background tab can show live animated
status if the daemon drives it. We choose not to, because it wakes a renderer several times a second
per hidden tab for little benefit. **Decision:** animate when visible, push discrete state changes
when hidden. `06-chrome-integration.md` §5.

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

### 1.8 chrome.commands rejects Command+Alt, and caps suggested keys at four
Measured on Chrome 150. `Command+Alt+<key>` is rejected by manifest validation in either modifier
order, so the originally planned `Cmd+Option+T`, `Cmd+Option+C`, `Cmd+Option+P`, and `Cmd+Option+R`
cannot be extension shortcuts at all.

Accepted patterns: `Command+Shift+<key>`, `Alt+Shift+<key>`, `MacCtrl+Shift+<key>`, `Command+<key>`,
`Alt+<key>`, `MacCtrl+<key>`, `Command+MacCtrl+<key>`.

**At most four commands may carry a suggested key.** Everything else reaches the command palette.

Manifest acceptance is not runtime binding: Chrome silently declines keys it reserves for itself.
That distinction still needs one manual check with a normally installed extension.

### 1.7 Kitty graphics protocol
xterm.js supports Sixel and the iTerm2 inline-image protocol via addon, so images are partly
recoverable. The **Kitty graphics protocol is not supported**. Tools targeting it do not render.

---

## Tier 2 — Solvable, but structural ⚠️

Get these wrong early and the fix is a rewrite, not a patch.

### 2.1 macOS TCC identity, and the hang
Measured. Processes spawned by the daemon inherit the **daemon's** privacy identity, not
Terminal.app's. Full Disk Access held by Terminal and iTerm does nothing for the daemon.

**A bare `node` daemon is identified by absolute path.** The TCC database records the client as
`/opt/homebrew/Cellar/node@20/20.19.5/bin/node`, which contains the Node patch version. Upgrading
Node changes that path and **silently invalidates every grant**. Terminal and iTerm are recorded by
bundle identifier, which survives updates. That difference is the entire argument for shipping a
signed app bundle.

**The failure mode is a hang, not a denial.** Reading an ungranted directory does not return
`Operation not permitted`. macOS raises a blocking consent prompt and the call waits indefinitely.
In a terminal that presents as a **frozen session with no error and no output**, while a system
dialog sits somewhere the user may never look. This is the worst possible failure shape for a
terminal emulator and it must be handled explicitly, not left to chance.

**Fix:** ship the daemon in a signed app bundle with a stable identifier, and pre-warm consent at
install time rather than letting the first `ls ~/Downloads` hang. Retrofitting forces every grant to be redone.

### 2.2 MV3 service worker lifetime
Terminates at ~30 s idle. It cannot hold the connection that must always exist, and it is the only
place that can act when no terminal tab exists.

**Fix:** three connection classes. `06-chrome-integration.md` §2.

### 2.3 Server-side VT state is mandatory and not cheap
Reattach must restore *screen state*, not replay bytes. Byte replay breaks the moment an app used
the alternate screen. So the daemon runs a headless emulator per session.

Consequences: the daemon must **always drain the PTY**, never applying backpressure toward a child
process. Measured cost is around 30 MB per session at the 10,000-line default, so twelve live
sessions cost about 350 MB. The `low` memory mode brings that to 113 MB by capping scrollback at
2,000 lines. `07-terminal-fidelity.md` §2 and `11-performance.md` §1.

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
`/etc/zprofile`, `path_helper`, and user dotfiles.

Measured: from `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, a login shell produced 26 entries against 14 for
a non-login shell. Whether a non-login shell gets a usable `PATH` at all depends on where the user
put their edits, since `.zshrc` runs for interactive non-login shells and `.zprofile` does not. A
login shell is the only spawn that works regardless of dotfile layout.

### 2.11 Offscreen documents get only chrome.runtime
Measured on Chrome 150, and broader than it first appears. An offscreen document has **only**
`chrome.runtime`. There is no `chrome.storage`, no `chrome.runtime.sendNativeMessage`, no
`chrome.notifications`, no `chrome.tabs`, no `chrome.tabGroups`, and no `chrome.windows`.

So the context that can always hear from the daemon cannot act on anything, and the context that
can act, the service worker, is dead most of the time. Every daemon-initiated action is therefore a
relay: the offscreen document sends a runtime message, which both wakes the worker and asks it to
do the thing. Verified end to end with the worker confirmed dead beforehand.

Only one offscreen document may exist, and concurrent creation attempts throw.
See `06-chrome-integration.md` §2.

### 2.12 Chrome cannot execute anything in a TCC-protected folder
Chrome holds no grant for `~/Documents`, `~/Desktop`, or `~/Downloads`. A native messaging host
placed there fails to launch with `Operation not permitted`, reported to the extension only as
`Native host has exited`. Install helper binaries outside those folders.

### 2.13 node-pty spawn-helper loses its executable bit
The npm tarball extraction does not preserve the executable bit on node-pty's `spawn-helper` binary
on macOS, so every PTY spawn fails with a bare `posix_spawnp failed` that names no file. Reproduces
on every fresh install. Repaired by a postinstall step. See `13-packaging.md`.

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
| ~~2~~ | ~~`chrome.commands` accepts `Command+Alt`~~ | ❌ **Resolved: REJECTED.** See tier 1.8 |
| ~~3~~ | ~~Concurrent WebGL context ceiling~~ | ✅ Resolved: 16 per page, no limit across tabs up to 20 |
| ~~4~~ | ~~Hidden-tab favicon updates via push~~ | ✅ Resolved: fully unthrottled, 25/25 repaints at 5 fps |
| ~~5~~ | ~~node-pty prebuild availability~~ | ✅ Resolved: prebuild ships and is used |
| 6 | Whether Chrome discards a tab holding an open WebSocket | the background-tab status spike |
| 7 | Whether a signed app bundle yields an upgrade-surviving TCC grant | the TCC spike |
| ~~8~~ | ~~Round-trip fidelity of the headless emulator~~ | ✅ Resolved: 7/7 fixtures exact |
| ~~9~~ | ~~Sustained throughput ceiling~~ | ✅ Resolved: 50 MB/s, bounded by the VT parser |

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

