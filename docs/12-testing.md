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

**Run headless.** A visible browser is not required for terminal rendering, keyboard input,
splits, merge and detach, the launcher, or workspace restore, all of which have been verified with
no window at all. Headless also avoids taking focus from whoever is using the machine, which
matters over a long session.

A real window is needed only where the window itself is the subject: WebGL context limits, true
tab-visibility throttling, and tab discard. Those are the exception, and they should record and
restore the frontmost application around the run.

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

---

## Browser suites

`npm run test:browser` runs everything in `test/browser/suites/` against one daemon and several
headless browsers. A full run is about five minutes; the suites covering one change are about
thirty-five seconds.

    npm run test:browser                      everything
    npm run test:browser -- highlights        named suites only
    npm run test:browser -- --changed         whatever git says was touched

`TT_JOBS` sets how many run at once (4), `TT_SKIP_BUILD=1` skips the rebuild.

**Headless by default and deliberately.** These run while someone is using the machine, and a
browser that steals focus every few seconds makes that impossible. Everything the suites need
works without a window, including WebGL terminal rendering and real key events. The profile is
throwaway and recreated per run and per port, so a suite never sees state from the previous one
and the developer's own Chrome profile is never opened.

### Three phases, and the order is the design

| Phase | Suites | Why |
|---|---|---|
| First, alone | `reset`, `pane-chooser`, `resume-and-tabs`, `sessions`, `no-busy-loop` | They wipe state everything reads, or count things belonging to the whole browser |
| Middle, parallel | everything else, across `TT_JOBS` browsers | Independent: each opens its own tab and its own sessions |
| Last, alone | `survives-restart`, `resilience` | They take the daemon away on purpose |

Running a first-phase suite beside another does not produce a flake, it produces a confident
wrong answer. Running a last-phase suite early is worse: while the daemon is down every other
suite in every other browser waits on a connection that is not coming back. One of them once
took 1070 seconds and the suites running alongside it took 1075, all waiting on the same dead
daemon. The run also sweeps before that phase, so the daemon being killed is not holding every
session the run created.

**A browser per parallel worker, not one shared.** Input goes to the browser's active target, so
suites sharing one fight over which tab that is and keystrokes land in another suite's terminal.
Two suites crashed in parallel that passed alone.

### Wait for the condition, never for a duration

`openTerminal` polls until a prompt is actually on screen. `waitFor(client, expression)` asks the
page a question repeatedly; `waitUntil(fn)` does the same for something outside the browser, like
a daemon coming back. A fixed `sleep` is a guess that is too long when things go well and too
short when they do not, and the short case looks exactly like a product bug.

Wait for the thing being tested, not something near it. Waiting for `.launcher-row` to check the
resume rows waited for a recent folder, which renders immediately, so the click that followed
found nothing to press.

### The run was once twenty minutes, and none of it was the tests

Worth recording, because every one of these presented as "the suites are slow":

1. **`execFileSync` with `stdio: 'inherit'` waits for the pipe, not the process.** `launch.sh`
   starts Chrome in the background, Chrome inherits the pipe and never closes it, so the runner
   blocked before running a single suite
2. **The cleanup sweep ran for six minutes** after suites that had finished in forty, connecting
   to each tab in turn with no timeout. One unresponsive tab held the whole run open
3. **Suites shared a browser**, as above
4. **The daemon-killing suites ran first**, as above

### Two rules these suites learned the hard way

**Setup that touches shared state belongs to the runner, not a suite.** One suite restarted the
daemon so a loader would re-run. On its own it passed; in the batch it took down every suite
after it, and the output looked like nine unrelated product bugs.

**Input needs `rawKeyDown`, not `char`.** A CDP `char` event is not a keydown, so xterm never
turns it into a control sequence and `Ctrl+C` does nothing at all. That cost time three separate
times before it was written down in `helpers.mjs`.

**A click is a press and a release.** `element.click()` dispatches a click directly and never
produces the `mousedown` before it, so it passes against controls no person can operate: the pane
menu dismissed itself on `mousedown`, which removed the button before the release, and every
entry was dead to a real mouse while every test passed. Everything driven by a pointer goes
through `realClick`, which also scrolls the control into view and checks what is actually at the
point first, because a control below the fold has an off-screen box and the click lands on
whatever happens to be at those coordinates.

**Nothing may hardcode the debug port.** Suites run across several browsers, so `9223` asks a
browser the suite is not in. Use `listTargets`.

### What is asserted, and why these ones

| Suite | Guards |
|---|---|
| `terminal` | A tab is a real shell; Ctrl+C interrupts and Command+C does not |
| `workspace` | Splits, and reopening a workspace URL restoring the *same* panes |
| `palette` | Actions reachable by typing, absent when they cannot apply |
| `project-trust` | A cloned repository's config is shown and never acted on unasked |
| `no-busy-loop` | An idle tab sends almost nothing |
| `highlights` | Highlights merge rather than stack, stay where they were put, and cover only printed text |
| `resume-and-tabs` | Both agents are offered and actually resume; an unused tab is taken over rather than left |
| `opening-and-undo` | Opening a folder runs `cd` once, and undo restores the screen exactly |
| `menu-aftermath` | Clear and a marker both leave a prompt, and the folder box says what is there |

The last one is not hypothetical. The launcher recorded "this directory has no project config" by
deleting the entry, which made "asked, nothing there" indistinguishable from "never asked". Every
render asked again and every answer caused another render: thousands of messages a second.
Nothing looked broken, because a busy loop is invisible; what showed was every other message
starved behind it, so typing appeared to do nothing. It also got worse the more the product was
used, since each new recent folder added another question per render.
