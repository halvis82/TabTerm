# 12 — Testing

Terminal emulation is a domain where "it looked right" is not evidence. This document defines what
counts as verified.

---

## 1. Levels

| Level | Scope | Runs |
|---|---|---|
| Unit | Pure logic: protocol codec, layout tree, state machine, policy engine, redaction | Every commit |
| Fixture | Recorded PTY byte streams against the VT state machine and snapshot round-trip | Every commit |
| Integration | Real daemon, real PTY, scripted client. No browser | Every commit |
| Browser | Real extension in real Chrome, driven where possible | Before a milestone gate |
| Manual | What cannot be automated, with a recorded pass or fail date | Before a milestone gate |

---

## 2. Fixtures

The core of terminal correctness testing. Fixtures are **recorded real PTY byte streams**, committed
as binary, with a manifest describing the capture.

Minimum set:

| Fixture | Exercises |
|---|---|
| `vim-edit` | Alt-screen, cursor movement, status line, unsaved buffer indicator |
| `nvim-splits` | Alt-screen, complex redraw, mouse mode |
| `agent-tui` | The agent CLI TUI, heavy redraw, wide unicode |
| `htop` | Continuous full-screen repaint, color, box drawing |
| `less-scroll` | Alt-screen enter and exit, scroll region |
| `tmux-nested` | Nested emulator behavior |
| `truecolor-torture` | 24-bit color, every attribute, attribute combinations |
| `unicode-width` | CJK, emoji, combining marks, zero-width joiners |
| `progress-bars` | Carriage returns, partial line rewrites |
| `osc-sequences` | OSC 7, OSC 8, OSC 133, title requests, and malformed variants |

Each fixture defines at least one **capture point**, including at least one inside the alternate
screen. That is where naive implementations break.

### The round-trip test

The single most important test in the codebase.

```
feed fixture up to capture point
  → serialize VT state
  → restore into a fresh emulator
  → assert cell-for-cell equality
```

Equality covers every cell's codepoints and attributes, cursor position, visibility and shape, saved
cursor, alt-screen flag, preserved primary screen, scroll region, character set state, and mode
flags.

A failure here is never "flaky." It is a fidelity gap and gets recorded in
`07-terminal-fidelity.md` §7.

---

## 3. Property tests

| Target | Property |
|---|---|
| Layout tree | Any random sequence of split, close, move, swap, and detach leaves a valid tree per the `03-data-model.md` invariants |
| Protocol codec | Encode then decode is identity for every message shape, including arbitrary binary payloads |
| Session state machine | No sequence of events reaches an undefined state. Every illegal transition is rejected, not silently ignored |
| Resize arbitration | Applied size is always the minimum across attached clients, for any attach and detach ordering |
| Redaction | No configured pattern ever survives into a persisted record |

---

## 4. Integration tests

Real daemon, real PTY, scripted client, no browser.

- Spawn, write, read, resize, kill. No zombie processes after 100 cycles
- Job control: `Ctrl+Z`, `fg`, `jobs` behave, proving a real controlling terminal
- Detach, wait past the grace period, assert the reap happened for the expected rule
- Detach, reattach before the deadline, assert the reap was cancelled
- **The PTY-untouched test:** a pane runs a counter. Merge it into a workspace, detach it back to a
  tab, close and reopen the tab. The counter must not skip, repeat, or reset. This is the single
  best proof that views are disposable
- Slow-client test: a client that acks slowly must not slow the PTY. Assert the daemon's read rate
  is unaffected
- `yes` for 60 s must not grow daemon RSS beyond the scrollback cap
- `cat` of a 500 MB file renders without a disconnect
- Concurrent-agent test: three sessions, assert every hook event lands on the right pane

---

## 5. Browser tests

Chrome behavior that can be driven is driven. Everything else is manual.

Automatable: tab creation and placement, group inheritance, stable URL round-trip, service worker
termination and recovery, offscreen document reconnection, notification firing.

---

## 6. Manual verification

A manual verification checklist is maintained outside the repository. Every item records a pass or fail **with a date and the
Chrome and macOS versions**. An item with no date is unverified regardless of what anyone remembers.

Required before every milestone gate:

- [ ] `Cmd+Shift+T` restores a closed terminal, process and screen intact
- [ ] `Cmd+Shift+T` restores a 3-pane workspace, all three intact, one mid-`vim`-edit
- [ ] Quit Chrome entirely, reopen, sessions reattach
- [ ] Force-terminate the service worker, terminals keep working
- [ ] Force a tab discard, reactivate, terminal recovers
- [ ] Hidden-tab notification fires with every terminal tab discarded
- [ ] Favicon states correct in a multi-pane workspace, priority order respected
- [ ] Option-click a printed path opens the right file at the right line
- [ ] Detach a pane, latency feels instant
- [ ] Merge two terminals, receiving tab's group preserved
- [ ] Restore a tab whose session was merged elsewhere, auto-detach behaves
- [ ] Restore an expired session's URL, recovery page appears, nothing auto-runs
- [ ] Fresh macOS user account: install, log out, log in, terminal works
- [ ] TCC: `ls ~/Desktop` works from a TabTerm shell after install

---

## 7. Security tests

Non-optional, per `05-security.md` §10.

- Connection from a non-loopback interface fails
- Unauthenticated frame before `auth-ok` closes the connection
- Auth frame after 2000 ms closes the connection
- Forged `Origin` with a valid token succeeds, **and this is expected**. The test documents that
  Origin is not a boundary
- Forged `Origin` with an invalid token fails
- Token file with mode wider than 0600 prevents daemon startup
- A fixture emitting a hostile OSC title cannot inject markup into the tab title
- A fixture emitting a fake file path produces no action for a nonexistent target
- A path containing shell metacharacters reaches the editor as a single argv element
- A project `plugin.ts` never executes without a trust grant
- A trust grant is invalidated when the file's content hash changes
- Every default redaction pattern is scrubbed before persistence

---

## 8. What is not tested and why

| Not tested | Reason |
|---|---|
| Pixel-identical rendering versus iTerm | Not a goal. `07-terminal-fidelity.md` §8 |
| Behavior on Linux or Windows | Out of scope. macOS only |
| Behavior in non-Chrome browsers | Out of scope by definition |
| Chrome's own tab restore mechanics | Chrome's job. We test that our page handles being restored |
| Reboot process survival | Impossible. Tier 0.3 |
