# 10 — Limitations

A tiered inventory of what Chrome and macOS will not permit, what they permit only in degraded form,
and what is merely hard.

**Read this before proposing a feature.** Tier 0 items have no workaround. Do not spend effort
rediscovering them, and do not let a plan quietly depend on one.

Update this file whenever a new constraint is discovered.

---

## The machine's own limits

### macOS hands out a fixed number of pseudo-terminals

`kern.tty.ptmx_max` is **511** by default. When that many are allocated, nothing on the machine
can open a terminal: not TabTerm, not iTerm, not anything, and the failure is an opaque
`posix_spawnp failed` that names nothing.

    sysctl kern.tty.ptmx_max        the cap
    ls /dev/ttys* | wc -l           how many are allocated
    sudo sysctl -w kern.tty.ptmx_max=999

It can be raised, but not freely: 999 is accepted and 1024 is rejected, and the setting does not
survive a reboot.

#### What actually consumed them, and it was us

Two wrong explanations were written here before the right one, so the evidence is recorded rather
than the conclusion alone.

A pseudo-terminal is allocated while its **master** handle is open, and the kernel frees it on the
last close of that handle (`ptmx_free_ioctl` in `bsd/kern/tty_ptmx.c`, and the limit is checked as
`pis_total - pis_free`, which is how many are allocated right now). Counting who held the
**slave** side found 13 on a machine sitting at 827, which is what made this look like a macOS
quirk. Counting masters found the answer:

    node    82123   820 handles on /dev/ptmx     <- TabTerm's own PTY host
    iTerm2  47521   101

**node-pty 1.1.0 never closes the master.** Measured directly: spawn ten, kill all ten, and ten
pseudo-terminals stay allocated. Repeat and it grows by ten each time. Killing the process group,
calling `pty.kill()`, `destroy()`, `_close()`, and closing the socket's file descriptor by hand
all leave it held. Every one of them comes back the instant the owning process exits.

So the cost is **one pseudo-terminal per session ever created, for the life of the PTY host**, and
the host is designed to run for months. That is not a testing artifact, it is the product slowly
consuming the machine's supply until no application can open a terminal. It is exactly the
2026-09-02 incident.

**Fixed by node-pty 1.2.0-beta.15**, where the same measurement moves the count by zero.

#### Reclaiming without a reboot

Restarting the PTY host frees every handle it holds, immediately. It ends the terminals that host
is running, which is the price, and it is a smaller one than a reboot:

    pkill -f 'libexec/tabterm/pty-host'

A reboot also works and is the only thing that resets the count for other applications leaking the
same way.

### A reloaded extension does not run until something wakes it

An MV3 service worker is event driven. After the extension is reloaded there is no page of ours
left alive and no event has happened, so nothing runs: not the top of the service worker, and not
`chrome.runtime.onInstalled`, which a programmatic `chrome.runtime.reload()` does not fire at all.

The tabs therefore come back on the worker's next start rather than at the instant of the reload,
which in practice is immediately: reloading from `chrome://extensions` fires `onInstalled`, and
any tab event at all starts the worker.

What this means for the reopen is that the worker's first moment is the one that matters, and it
is also the moment the record is most fragile. See `07-terminal-fidelity.md`.

### A unix socket path is capped at about a hundred bytes

`sockaddr_un.sun_path` is 104 bytes on macOS and 108 on Linux. Going over does not truncate or
warn: `listen` fails with `EINVAL`, which says nothing about length.

That is worth knowing because of what it broke. The PTY host's socket lived in the state
directory, so a deep enough home pushed it over the limit, the host never started, and the daemon
fell back to owning the PTYs itself. Terminals then stopped surviving a daemon restart, which is
the product's central promise, and the only trace was one warning line in a log. The socket moves
to the per-user temporary directory when the natural path does not fit, and the daemon writes
`ptyhost.where` in the state directory saying where it went.

A terminal size is clamped to between 1 and 1000 in each direction, whatever a page asks for.
The VT allocates a line object per row, so a session asked for with `Number.MAX_SAFE_INTEGER`
rows killed the daemon with an out-of-memory abort, and every terminal on the machine with it.
Clamped rather than refused: a wrong size is cosmetic and the next real resize corrects it, while
refusing to open somebody's terminal because a measurement arrived garbled is a worse answer.

TabTerm holds the line at **100 live sessions** in the PTY host, which is the only process that
knows the total: the daemon can be replaced and Chrome can be closed while these keep running.
The hundred and first is refused with a sentence in the pane saying why. A hundred is far above
any honest use and far below the point of no return, and somebody with a hundred live terminals
has a runaway rather than a workload. It is not a user setting, because a number you can raise
while something is spawning in a loop is not a safety limit.

Ordinary use adds a handful a day and is nowhere near the cap. A full browser run adds about
eighty, so from a fresh boot there is room for roughly a dozen of them. The harness prints the
count before and after every run, warns separately when a run leaves a process alive and when
headroom is short, and refuses to start below 120 free.
See `AGENTS/BACKLOG.md` WP-27 for the incident this came from.

## Tier 0 — Impossible

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

### 0.6 Making the extension's own name in the toolbar menu do something

Right-clicking the toolbar icon opens a menu whose first row is the extension's name, drawn
greyed out above a separator. It looks exactly like a disabled menu item, and it is not one: it
is Chrome's own heading for the menu, the way a title bar is not a button. No API reaches it.
`chrome.contextMenus.create` with `contexts: ['action']` adds rows **below** the separator, and
that is the whole of what an extension may put there.

**Disposition: cut, with the useful half kept.** The first row an extension owns does what the
heading looks like it should: opens a terminal. Clicking the icon itself does the same thing,
which is the gesture that needs no menu at all.

### 0.7 Showing a notification without it being kept by the operating system

`chrome.notifications` has no option for "interrupt once and keep no record". On macOS the
notification is handed to the system, and whether it stays in Notification Centre afterwards is a
setting on Google Chrome in System Settings, not anything an extension can reach.

**Disposition: partly cut.** What is possible is done: an ordinary notification is withdrawn eight
seconds after it appears, which is what clicking it would have done, so nothing accumulates on
TabTerm's account. A critical one is left alone, because it is raised with `requireInteraction`
and taking it away on a timer would remove the only thing that makes it different.

If the operating system still keeps a copy, the switch that stops it is
**System Settings, Notifications, Google Chrome, Show in Notification Centre**. That is a decision
about Chrome as a whole and belongs to the person using it.

---

## Tier 1 — Possible only in degraded form 

The feature survives, but not in its obvious form.

### 1.1 Self-driven animation in background tabs
Measured on Chrome 150: in a hidden tab `requestAnimationFrame` is **fully paused, 0 frames**, and
`setInterval(1000)` degrades to **1 tick per minute**. A self-driven favicon spinner cannot animate
in a background tab.

The degradation is far sharper than a single sample suggests, and worth stating as a curve rather
than a number. Over eight minutes hidden, one `setInterval(1000)`:

| Minute | Ticks |
|---|---|
| 1 | 59 |
| 2 onward | 1 |

So the first minute is nearly unthrottled and everything after it is not. Anything sampled inside
that first minute reads as "slow but usable" and is wrong about every minute that follows.

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

### 1.7b A queue for an absent host has to choose what to lose

A daemon holds messages for a PTY host that is not currently there, bounded so that a host which
never returns cannot become unbounded memory. What the bound throws away is the whole question.

It threw away the oldest, which is close to the worst possible answer: the oldest message for a
session is its `spawn`, so a burst of typing evicted the thing that creates the terminal those
keystrokes are addressed to, and a burst of resizes evicted the keystrokes. Both losses were
silent.

It now coalesces first, because a resize, a stash and a budget are statements of a current value
and only the last per session is true. Then it drops housekeeping for sessions with nothing at
stake. Only then does it give up one session's input, taking that session's `spawn` with it, and
it records which session so the terminal can be told. A write delivered to a session that was
never created is not a smaller loss than a dropped write.

### 1.8 chrome.commands rejects Command+Alt, and caps suggested keys at four
Measured on Chrome 150. `Command+Alt+<key>` is rejected by manifest validation in either modifier
order, so the originally planned `Cmd+Option+T`, `Cmd+Option+C`, `Cmd+Option+P`, and `Cmd+Option+R`
cannot be extension shortcuts at all.

Accepted patterns: `Command+Shift+<key>`, `Alt+Shift+<key>`, `MacCtrl+Shift+<key>`, `Command+<key>`,
`Alt+<key>`, `MacCtrl+<key>`, `Command+MacCtrl+<key>`.

**At most four commands may carry a suggested key.** Everything else reaches the command palette.

Manifest acceptance is not runtime binding: Chrome silently declines keys it reserves for itself,
and there is no error when it does.

**Measured, Chrome 150.** One command carries a suggested key and Chrome binds it:

| Command | Offered | Bound |
|---|---|---|
| `_execute_action` | `Command+Shift+Period` | ⇧⌘. |
| `new-terminal`, `open-command-menu`, `split-right`, `split-down`, `launch-agent` | nothing | unbound until chosen |

There were three commands and all three opened a terminal, which spent the entire budget of
rebindable keys on one action. The rest are declared without a suggested key: they appear in
`chrome://extensions/shortcuts` waiting for one, which is the point.

Read back with `chrome.commands.getAll()` from an extension page, not from the service worker,
which is usually asleep and not listed as a debuggable target. **What is read back is what the
interface shows**, because manifest acceptance is not assignment and a person can rebind
anything: a hand-written table once claimed `Option Shift T` for a command that had been rebound
to `Shift Command O`, which is worse than showing nothing.

Note what this measurement also caught: the docs and the installer told people to press
`Command+Shift+E`, which the manifest never offered. Reading the binding back is the only way to
know what a user will actually press.

### 1.7 Kitty graphics protocol
xterm.js supports Sixel and the iTerm2 inline-image protocol via addon, so images are partly
recoverable. The **Kitty graphics protocol is not supported**. Tools targeting it do not render.

---

## Tier 2 — Solvable, but structural 

Get these wrong early and the fix is a rewrite, not a patch.

### 2.1 macOS TCC identity, and the hang
Measured. Processes spawned by the daemon inherit the **daemon's** privacy identity, not
Terminal.app's. Full Disk Access held by Terminal and iTerm does nothing for the daemon.

**A bare `node` daemon is identified by absolute path.** The TCC database records the client as
`/opt/homebrew/Cellar/node@20/20.19.5/bin/node`, which contains the Node patch version. Upgrading
Node changes that path and **silently invalidates every grant**. Terminal and iTerm are recorded by
bundle identifier, which survives updates. That difference is the entire argument for shipping a
signed app bundle.

**Three states, and only the middle one is dangerous.**

| State | What a command does |
|---|---|
| Not yet decided | macOS raises a consent prompt and **the call blocks until it is answered**. In a terminal that presents as a frozen session with no error and no output, while a dialog sits somewhere the user may never look |
| Denied | The call fails immediately with `Operation not permitted`. Not a hang: the decision is recorded, so nothing prompts again |
| Allowed | Normal |

So the worst shape is the *undecided* one, not the denied one. A denial is a clean, ordinary
error that a shell reports the way it reports any permission problem. It is also reversible:
System Settings, Privacy & Security, Files and Folders (or Full Disk Access), then restart the
daemon so the new grant is picked up.

Because grants attach to the daemon, denying affects **every terminal**, not just the one that
asked. `doctor.sh` probes all three folders and distinguishes the three states, with a timeout,
since a probe that hangs would be the same failure it is trying to detect.

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

## Tier 3 — Hard engineering, no wall yes

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
| ~~2~~ | ~~`chrome.commands` accepts `Command+Alt`~~ | **Resolved: REJECTED.** See tier 1.8 |
| ~~3~~ | ~~Concurrent WebGL context ceiling~~ | yes Resolved: 16 per page, no limit across tabs up to 20 |
| ~~4~~ | ~~Hidden-tab favicon updates via push~~ | yes Resolved: fully unthrottled, 25/25 repaints at 5 fps |
| ~~5~~ | ~~node-pty prebuild availability~~ | yes Resolved: prebuild ships and is used |
| 6 | Whether Chrome discards a tab holding an open WebSocket | the background-tab status spike |
| ~~7~~ | ~~Whether a signed app bundle yields an upgrade-surviving TCC grant~~ | **Resolved: it depends on the grant.** Measured 2026-09-08. Folder and app-data decisions are keyed by bundle identifier and survived an identity change untouched. Full Disk Access is recorded against the code signature, and an ad-hoc signature is a hash of the bundle's contents, so adding an icon voided it: the row went to `auth_value = 0`. See `13-packaging.md` |
| ~~8~~ | ~~Round-trip fidelity of the headless emulator~~ | yes Resolved: 7/7 fixtures exact |
| ~~9~~ | ~~Sustained throughput ceiling~~ | yes Resolved: 50 MB/s, bounded by the VT parser |

---

## Assumptions that look reasonable and are wrong

Recorded so they are not reintroduced.

| Assumption | Correction |
|---|---|
| "Use one shared extension service worker" | MV3 service workers die at ~30 s idle. Three connection classes required |
| "Reject non-extension origins" as a security control | Origin headers are forgeable by any local process. The token is the only boundary |
| "TabTerm daemon: small" in the memory table | Wrong once server-side VT state exists. Tens of MB per session |
| "Duplicate" listed under natively supported tab behavior | Needs an explicit mirror-or-fork decision. Neither is a default |
| Dragging a file from Finder inserts its path | Impossible. Cut, tier 0.5 |
| PATAPIM cited as prior art | Unverifiable. Removed. Chrome Secure Shell / hterm added instead |
| Short reap timers are a safe default | Wrong for workspaces. Pinned by default, ADR-0012 |
| Missing: macOS TCC | Not mentioned at all. Now tier 2.1, on the critical path |
| Missing: tab discarding | Not mentioned at all. Now tier 1.2, forces the notification architecture |



---

## What survives what

Measured, not assumed. Each row was produced by killing the thing named and observing the result.

| Failure | Process | Screen | Usable after |
|---|---|---|---|
| Tab closed and reopened | survives | yes | Immediately |
| Chrome killed with `SIGKILL` | survives | yes restored | Reopen the tab |
| Daemon updated or restarted | survives | yes | Immediately, adopted |
| Daemon killed with `SIGKILL` mid-command | keeps running to completion | yes | Immediately, no reload |
| Daemon absent, then returning | survives | yes | Reconnects itself, no reload |
| PTY host killed with `SIGKILL` | **cannot survive** | survives on disk | A new host starts automatically |
| Machine reboot | cannot survive | survives on disk | Restore offers the layout back |

The host is the one process whose death takes sessions with it, which is the price of it being
the only thing holding them. What was fixed after measuring: the daemon used to keep a dead
socket and never reconnect, so a killed host meant no terminal could be created again until the
daemon itself was restarted. It now reconnects, starts a replacement, and lets go of the sessions
that died with the old one so their tabs say so plainly instead of hanging.

**The network is not a factor.** Everything is local: a unix socket to the host and a loopback
WebSocket to the daemon. Losing internet connectivity does not affect a running terminal.
