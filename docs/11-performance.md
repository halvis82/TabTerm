# 11 — Performance and Memory

The premise is that a terminal tab is lighter than a typical website tab. That is true of the page.
It is not automatically true of the system.

---

## 1. Memory hierarchy, corrected

| Component | Cost | Note |
|---|---|---|
| PTY + zsh | Very small | |
| **TabTerm daemon, base** | Small | |
| **Daemon VT state, per session** | ⚠️ **Tens of MB** | Easy to underestimate. A headless emulator holding 10k lines is not cheap |
| xterm.js frontend, per pane | Modest, roughly 20 to 50 MB | Which is why hidden-pane suspension is mandatory, not optional |
| Chrome renderer, per tab | Modest, irreducible | |
| agent CLI | Potentially large | Not ours |
| Language servers, build systems | Potentially very large | Not ours |

The corrected picture: **twelve live sessions is a real cost on both sides**, not a rounding error.
Every budget below follows from that.

---

## 2. Budgets

Placeholders until measured. Any change that moves a number by more than 10 percent must justify
it in the change description.

| Metric | Target | Set by |
|---|---|---|
| Daemon RSS, 12 live sessions, balanced mode | To be set | the VT fidelity spike, the memory mode work |
| Daemon RSS, 12 live sessions, low mode | To be set | the memory mode work |
| Snapshot serialize, 10k scrollback | To be set | the VT fidelity spike |
| Attach to first paint, single pane | To be set | the attach and restore work |
| Attach to first paint, 3-pane workspace | To be set | the workspace restore work |
| 8 simultaneous restores, total stall | To be set | the startup restore work |
| Sustained PTY to rendered throughput | To be set | the throughput spike |
| History search, 100k rows, indexed | To be set | the history search work |
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

| Parameter | Initial | Final source |
|---|---|---|
| Credit window per stream | 256 KiB | the throughput spike |
| Coalescing interval | 6 ms | the throughput spike |
| Max chunk | 64 KiB | the throughput spike |

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
