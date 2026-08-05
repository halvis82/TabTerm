# 11 — Performance and Memory

The premise is that a terminal tab is lighter than a typical website tab. That is true of the page.
It is not automatically true of the system.

---

## 1. Memory hierarchy, corrected

| Component | Cost | Note |
|---|---|---|
| PTY + zsh | Very small | |
| **TabTerm daemon, base** | Small | |
| **Daemon VT state, per session** | **3.6 MB** at the 10k default | Measured across 12 live emulators. 0.5 MB at 1k, 1.9 MB at 5k, 17.7 MB at 50k |
| xterm.js frontend, per pane | Modest, roughly 20 to 50 MB | Which is why hidden-pane suspension is mandatory, not optional |
| Chrome renderer, per tab | Modest, irreducible | |
| agent CLI | Potentially large | Not ours |
| Language servers, build systems | Potentially very large | Not ours |

The measured picture: twelve live sessions cost about **44 MB of daemon memory** at the default
scrollback cap. That is modest. The renderer side dominates, which is why hidden-pane suspension
matters more than daemon frugality.

---

## 2. Budgets

Measured on arm64 with Node 20 unless marked otherwise. Any change that moves a number by more than
10 percent must justify it in the change description.

| Metric | Target | Measured |
|---|---|---|
| Daemon VT state, 12 sessions, balanced (10k) | under 60 MB | **43.7 MB** ✅ |
| Daemon VT state, 12 sessions, low (5k) | under 30 MB | **22.6 MB** ✅ |
| Daemon VT state, 12 sessions, full (50k) | under 250 MB | **212 MB** ⚠️ high by design |
| Snapshot serialize, 10k scrollback | under 50 ms | **32 ms median** ✅ |
| Snapshot serialize, 50k scrollback | under 200 ms | **168 ms** ⚠️ argues against 50k as a default |
| Snapshot size, 10k scrollback | — | 793 KB |
| Attach to first paint, single pane | To be set | the attach and restore work |
| Attach to first paint, 3-pane workspace | To be set | the workspace restore work |
| 8 simultaneous restores, total stall | under 8 s | **33 ms** measured ✅ |
| Sustained PTY through the VT parser | — | **50 MB/s** measured |
| History search, 100k rows, indexed | **< 50 ms** filtered, **< 150 ms** with fuzzy text | measured: 0.1 ms unfiltered page, 4.6 ms `project:` + `exit:`, 5.1 ms with text, 0.4 ms at offset 5000 |
| Detach pane to reattached tab | Perceptually instant | the pane detach work |
| Prompt latency added by shell integration | Not measurable | the OSC 7 work |

---

## 3. The drain invariant, and what bounds memory

> The daemon always reads the PTY. Memory is bounded by evicting scrollback, never by pausing reads.

Pausing reads fills the PTY buffer and blocks the child on `write()`. To the user that is a hung
terminal with no explanation. So:

- Output is always consumed, always fed to the VT state machine, always appended to scrollback
- Scrollback is a capped ring, spilling to `~/.local/state/tabterm/scrollback/` beyond the cap
- A detached session with zero frontends drains exactly as fast as an attached one
- A client that falls more than one credit window behind stops receiving, and gets a **fresh
  snapshot** on catch-up rather than a backlog replay

---

## 4. Flow control

Full protocol in `02-protocol.md` §5.

| Parameter | Value | Basis |
|---|---|---|
| Credit window per stream | 256 KiB | Four chunks in flight |
| Coalescing interval | 6 ms | Perceived latency, not bandwidth |
| Max chunk | 64 KiB | Peak parse rate, diminishing returns beyond |

**Measured, and it changes the reasoning.** The VT state machine is the bottleneck, not the socket:

| Stage | Throughput |
|---|---|
| Raw PTY read | 248 MB/s |
| PTY read + VT state machine | **50 MB/s** |
| Loopback WebSocket, 64 KiB binary frames | 1,783 MB/s |

The transport has roughly **35 times the headroom** of the parser. So the credit window is not there
to protect the socket. It protects the frontend renderer, which is the slowest consumer in the chain.
Coalescing buys 1.7x by cutting per-call overhead (66 MB/s at 256 B chunks, 110 MB/s at 64 KiB), which
is worth having but is not the main event.

Practical consequence: `cat` of a 500 MB file costs about 10 seconds of pure daemon parse.

Terminal bytes go in binary WebSocket frames. Never base64, which would inflate high-throughput
output by a third for nothing.

Acks are sent from the xterm.js write callback, which fires after parsing, not after queueing.
Acking on queue would defeat the whole mechanism.

---

## 5. Renderer lifecycle

| State | Behavior |
|---|---|
| Visible focused pane | WebGL, full render |
| Visible unfocused pane | WebGL under the context budget, canvas beyond it |
| Hidden pane in a visible tab | Renderer suspended, no DOM updates |
| Hidden tab | All renderers suspended after a configured delay |
| Reactivated | Redraw from a daemon snapshot |

Suspension is safe and cheap because the daemon holds authoritative state. Discarding a renderer
costs one snapshot on return.

Chrome already pauses rendering for hidden tabs. We go further and release the renderer entirely,
because Chrome's pause still retains the buffers.

Resize is throttled and debounced on the frontend. Dragging a split divider must not produce a
`SIGWINCH` storm.

---

## 6. No polling

Any change introducing a timer must document why an event cannot serve instead. The daemon already
knows when a process state changes, a prompt returns, a command exits, a session detaches, or an
agent changes state. All of it is pushed.

### Local server discovery

`lsof` is expensive enough that a timer would be indefensible, so discovery runs on exactly two
triggers, both events:

- **A command starts.** One check is scheduled 2.5 seconds later: long enough for a dev server
  to bind, short enough that the offer arrives while the user is still watching the output that
  started it. Reported once per port, so restarting on the same port does not re-announce it.
  This depends on the shell integration's command-start mark; without it there is no event to
  hang the check on, the same way command history has none.
- **Someone opens the dashboard.** One `lsof` across every live session. A dashboard nobody is
  looking at costs nothing.

A session detaching also checks, but only for the reap policy: a shell holding a listening
socket must not be killed because a tab closed.

Stopping a server sends an interrupt to its terminal, exactly what a person would type. Not a
kill: the process shuts down the way it was written to, and nothing the shell owns is disturbed.
Restarting sends the recorded start command again after the prompt returns. Both ask first,
because both are irreversible and a misplaced click would take down something in use.

### Time-aware context

The one place a timer is legitimate, and it is tightly bounded:

- The daemon pushes discrete `command-start` and `command-end` events, never elapsed time
- The frontend computes elapsed locally
- Visible labels update at most **once per second**
- Hidden tabs stop their timers entirely
- Timers are destroyed on frontend unload
- No timestamp is stored in more than one place

Verified by a network trace showing zero periodic traffic in an idle session.

---

## 7. Data loading

Nothing loads wholesale.

| Data | Policy |
|---|---|
| Command history | Paged. Latest 50 in a session view, 100 per search page |
| Scrollback | Capped in the renderer, full history requested explicitly and paged |
| Notes and saved items | Loaded when the interface opens, never at page load |
| Session list | Summary fields only. Detail on selection |
| The SQLite database | **Never mirrored into JS memory.** Enforced by a query-only access layer |

---

## 8. Memory modes

the memory mode work. Switching applies without a restart.

| Setting | Low | Balanced | Full |
|---|---|---|---|
| Scrollback lines | 5,000 | 10,000 | 50,000 |
| Hidden renderer unload delay | Aggressive | Moderate | Lazy |
| Detached scratch shell reap | 3 min | 5 min | Policy |
| Detached agent or editor reap | 5 min | 10 min | Policy |
| Command output archive | Off | Off | On, 14 days |
| Favicon | State changes only | Animate when visible | Animate when visible |
| Command history | On | On | On, longer retention |

Workspaces are pinned by default in every mode (ADR-0012). Mode settings govern scratch sessions,
not workspaces the user built deliberately.

---

## 9. Why the frontend can be light

- Local content only, no network fetches, no ads, no analytics, no remote images
- Minimal HTML and CSS
- **No framework.** Vanilla TypeScript, per design principle 8
- One xterm.js instance per *visible* pane, not per session
- One data connection per page, multiplexing panes
- No background polling
- Panes redraw independently. One pane's output never redraws its siblings

The daemon carries the weight, which is correct: it is one process, it is shared across every tab
and every Chrome profile, and it is the only thing that has to be right.
