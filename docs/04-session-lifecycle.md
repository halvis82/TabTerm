# 04 — Session Lifecycle

The daemon is the authority for terminal state. Chrome is a view. Every rule here follows from that.

---

## 1. State machine

```
                    create-session
                          │
                          ▼
                     ┌─────────┐
                     │starting │
                     └────┬────┘
                          │ first attach
                          ▼
        ┌───────────▶┌─────────┐
        │            │attached │◀──────────┐
        │            └────┬────┘           │
        │ attach          │ last client    │ attach before deadline
        │                 │ disconnects    │ (cancels reap)
        │                 ▼                │
        │            ┌─────────┐           │
        └────────────│detached │───────────┘
                     └────┬────┘
                          │ policy says reap
                          ▼
                     ┌─────────┐   deadline    ┌────────┐
                     │expiring │──────────────▶│ reaped │
                     └─────────┘               └────────┘
                          ▲
   child exits from any live state                │
        ──────────▶ ┌────────┐ ────── metadata TTL ┘
                    │ exited │
                    └────────┘
```

Transitions not shown are illegal and rejected with a logged error. The transition table is
exhaustively tested. There is no implicit state.

---

## 2. Attachment

A session may have **zero or more** attached clients simultaneously.

- **Zero** — detached. The PTY runs, the daemon still drains it and feeds the VT state machine.
- **One** — normal.
- **More than one** — mirrored. Produced by `chrome.tabs.duplicate` (ADR-0011), by two Chrome
  profiles, or by the same session appearing in a workspace and standalone. All views see the same
  stream and the same snapshot.

### Resize arbitration

The PTY has exactly one size. With N attached clients the applied size is the
**minimum cols and minimum rows across all attached clients**, computed independently per dimension.

- A client detaching triggers recomputation, which may grow the PTY.
- With zero clients the PTY retains its last size. It is not reset.
- Resize is throttled and debounced on the frontend before it reaches the wire.

This is the same rule tmux uses, for the same reason: any larger client would render into
columns the shell does not know exist.

---

## 3. Detach

Detaching is triggered by:

| Cause | Signal to daemon |
|---|---|
| Tab closed | Data connection closes |
| Chrome quit | All connections close |
| Tab discarded by Chrome | Data connection closes, indistinguishable from a close |
| Explicit detach action | `detach` control message |
| Pane merged into another workspace | `merge-session`, recorded distinctly |

The daemon cannot distinguish a tab close from a tab discard. Both are simply "the connection went
away." This is fine, because the response is identical: mark detached, start the policy clock.

A pane merged into a workspace is **not** a detach in the reap sense. It is still attached, just to
a different workspace. See §6.

---

## 4. Cleanup policy

The policy engine evaluates, in order. First match wins.

### Every way a session can end

The list, because "it should never happen unexpectedly" is only checkable against one. A session
ends when, and only when:

| Path | Who decides | Guard |
|---|---|---|
| The process exits | The shell, or what it is running | None wanted. This is the session finishing |
| `Kill session` | A person, from the pane menu | Explicit, and the entry is marked as destructive |
| Closing a session card | A person, from the start screen | Explicit |
| Closing a pane | A person | Explicit. Closes the tab when it is the only pane |
| `Reset everything` | A person, behind a confirmation | Explicit |
| The reap policy | The daemon, on a timer | Never while a tab exists, and never while nobody has said. §4 |
| The PTY host dying | A crash, or `kill` | The one path with no guard. The host holds the file descriptors, so nothing survives it |

Nothing else. In particular **no timer, no cleanup pass and no restart may end one**, and nothing
in this repository may end a session it did not create: a sweep in the test harness once pressed
the close control on every session card, which is every session the daemon holds, and ended a
terminal somebody was working in nineteen seconds after they had used it. It looked exactly like
the product losing work. See `AGENTS/BRIEFING.md`.

The host is the residual risk and is designed around rather than guarded: it is a separate
process that holds nothing but file descriptors and bytes, has no protocol negotiated with a
browser, no database and no policy, so it has almost no reason to change and therefore almost no
reason to restart. Updating TabTerm stages new host code and leaves the running process alone,
which is verified rather than assumed: with the installed file genuinely changed, a real install
leaves the same pid serving the same terminals. A daemon that meets a host speaking an older
protocol records the mismatch and still leaves it running, because restarting it would trade a
compatibility question for certain data loss.

### A socket is not a tab

The rule that matters most, because getting it wrong loses somebody's work. **A session is never
ended while Chrome still has a tab for it**, and no timer starts until Chrome says the tab has
actually been closed.

The daemon cannot see Chrome. It used to infer "nobody wants this" from having no attached
client, and that inference is wrong in four ordinary situations that all look identical from the
daemon's side: a backgrounded tab, a tab in a collapsed group, a machine that went to sleep, and
a tab Chrome discarded to reclaim memory. Each of those closes the socket and none of them means
the person is finished. A terminal was once ended seventeen hours after its last command with its
tab sitting open.

So the extension, which can see tabs, tells the daemon. Every terminal tab carries its workspace
in its URL, so the report is the truth by construction rather than bookkeeping that can drift.
It is sent on tab creation, removal, replacement and URL change, at startup and install, and on a
two minute alarm that covers the cases which are not events at all: the service worker asleep
when a tab closed, a report lost while the daemon restarted, an extension that has only just
started.

The answer is deliberately three-valued. **Unknown is not the same as none.** Chrome closed,
Chrome crashed, or nothing reported yet are all gaps in what we know, and the only safe reading
of a gap is to keep the terminal. Chrome comes back and says what it has.

A report that fails to send leaves the daemon on its previous answer or on "nobody has told me",
both of which keep the terminal. The failure direction is never towards ending one.

**Thirty minutes** after the tab is genuinely closed, by default, and settable. It used to be
fifteen and it started at the wrong moment; now that nothing starts until the tab is gone, the
number can afford to be generous.

```
if pinned or persistent:
    never reap

if session is attached (including attached to a workspace elsewhere):
    never reap

if Chrome still has a tab for this session's workspace:
    never reap

if nobody has said whether a tab exists:
    never reap

if child process has exited:
    retain metadata per the retention table, then reap

if a listening server socket is attributed to this session:
    warn via notification, apply project policy, default: do not reap

if foreground process is an interactive agent or editor (agent, vim, nvim, emacs, ssh):
    reap after 10 minutes detached

if foreground process is the shell and it is idle:
    reap after 3 minutes detached

otherwise:
    reap after 5 minutes detached
```

**Workspaces are pinned by default** (ADR-0012). If you close a three-pane workspace tab and come
back an hour later, the panes are still there. Only unnamed scratch shells get reaped on a timer.

Before reaping, the daemon emits `session-expiring` with a deadline. Any attach before the deadline
cancels the reap. Every reap is logged with the matched rule.

Reap escalation: `SIGHUP` → wait → `SIGTERM` → wait → `SIGKILL`. A process group is signalled, not
just the leader, so orphaned children do not survive.

---

### A tab that was never used

A tab opened and closed without anything being run in it, and which never left the directory it
opened in, is ended a few seconds after its tab closes rather than being kept for the background
timeout. It is not work anybody comes back to, and keeping it is how a machine ends up holding
dozens of identical shells in the home directory, which is what made the list of running sessions
unreadable.

A `cd` on its own is a shell builtin and spawns nothing, so the directory is checked as well
rather than trusting the "has run a command" flag alone. The rule never applies to a session
holding a listening socket, or one opened to run a specific command, and pinning still outranks
it. The delay is short rather than zero, so closing a tab by accident is still recoverable by
reopening it.

---

## 5. Reattach and restore

### The sequence

1. Chrome restores `chrome-extension://<id>/terminal.html?workspace=<workspaceId>`
2. The page loads and **does not connect**
3. On the first `visibilitychange` to visible, the data connection opens and authenticates
4. `attach { workspaceId }`
5. The daemon returns the layout tree plus a snapshot per pane
6. The page builds the split tree, constructs one xterm.js per pane, writes each snapshot
7. The daemon streams live output from the snapshot's sequence point

### Why lazy

Chrome restores every tab at startup simultaneously. Eight eager attaches means eight snapshot
serializations and eight full-screen replays competing at once. Deferring to visibility means
exactly one runs immediately and the rest run when the user actually looks at them.

Within a workspace, panes restore in visibility order: visible panes first, then panes hidden behind
a maximized pane or a collapsed region.

### Daemon not running

The page shows a retrying state with the daemon's status, not a broken page and not an error. It
backs off exponentially and connects the moment the daemon appears. At login the daemon and Chrome
race; this is the normal path, not an error path.

---

## 6. Merge and detach of panes

### Merge

`merge-session { sessionId, workspaceId, targetPaneId, direction }`

1. Daemon validates the session is not already in another workspace
2. Layout tree is updated transactionally: the target pane becomes a split containing itself and
   the merged session
3. Session record gets `attachedWorkspaceId` and `attachedPaneId`
4. The source standalone tab closes
5. **The PTY is untouched at every step.** Verified in tests by a running counter that must not skip

The receiving tab's Chrome group is preserved. A merge never moves the receiving tab.

### Detach

`detach-pane { workspaceId, paneId }` returns the session's stable URL.

1. Pane removed from the layout, parent split collapsed into the sibling
2. Session's `attachedWorkspaceId` cleared
3. Extension creates a tab at the returned URL and attaches
4. PTY untouched

Detaching the last pane closes the workspace record and the tab.

### Why the native tab-strip gesture does not exist

Chrome owns the tab strip. Extensions receive `chrome.tabs.onMoved` after the fact and have no
drop-target interception. Dragging tab A onto tab B to merge them is impossible, permanently.
See `10-limitations.md` tier 0.1. The available surfaces are the command palette, a keyboard
shortcut, "split with previous terminal," dragging from TabTerm's own session list, and dragging a
pane inside an existing workspace.

---

## 7. Intentional merge versus accidental close

A session merged into a workspace had its standalone tab closed **on purpose**. Chrome does not know
that, so `Cmd+Shift+T` can restore that tab's URL.

The registry records the difference:

```
state: attached
attachedWorkspaceId: <workspace-id>
attachedPaneId: <pane-id>
```

When a restored tab requests a session in that state, the daemon returns
`session-attached-elsewhere`. The frontend then **automatically detaches the pane** back into the
restored standalone tab, because that is what the user's `Cmd+Shift+T` meant. The host workspace
closes the hole in its layout and both views stay correct.

The alternative, showing "this session is attached elsewhere" with a manual detach button, is
implemented as a config option but is not the default. Auto-detach makes `Cmd+Shift+T` feel like it
just works.

---

## 8. Expired sessions

Chrome provides no API to remove a specific entry from its recently-closed stack
(`10-limitations.md` tier 0.2). A restored URL for a reaped session is therefore normal and expected.

The page shows a recovery view, never an error:

```
This terminal session expired.

  Last directory:  ~/Projects/eeg-analysis
  Last command:    npm test
  Ended:           2h 14m ago

  [Start new shell in previous directory]
  [Restore saved workspace]
  [Open launcher]
  [Close tab]
```

Nothing runs automatically. The previous cwd and last command come from SQLite, which retains
expired session metadata per the retention table.

---

## 9. When a process exits

A pane whose process ends normally stops being a pane: the layout closes over it, and the
daemon broadcasts the new layout. That is what makes typing `exit` in a shell close its pane,
which is what everyone expects.

**A pane that was given an explicit command is treated differently.** Its output is the reason
it existed, and removing it the instant the command finishes would throw away exactly what the
user was waiting for. Those panes stay until they are closed deliberately.

The notice is written into the session's terminal state, not drawn by whichever client happens
to be attached:

```
[finished]
[exited with code 1]
[killed by signal 9]
```

Writing it into the VT state rather than the DOM means reattaching later shows the same thing,
and a snapshot taken after the exit still contains it. Implemented in
`daemon/src/session-manager.ts` and `daemon/src/main.ts`, covered by
`daemon/src/project-protocol.test.ts`.

An exited session that has left its workspace is no longer protected by the `in-a-workspace`
rule, so it is reaped a few seconds later per §4. One that stays in a workspace stays until its
pane is closed.

---

## 10. Chrome quitting

Chrome exiting closes every connection. Every session becomes detached. Because workspaces are
pinned by default, nothing is reaped.

On Chrome restart, either Chrome's own session restore reopens the tabs (which then reattach
normally), or the launcher lists every running session so they can be reopened deliberately. Both
paths are supported; which one happens depends on the user's Chrome setting, which we do not control.

---

## 10.5 The daemon restarting

Updating TabTerm restarts the daemon, and so does any crash. **Neither ends a session.**

PTYs live in a separate host process that is not stopped when the daemon is replaced, so the shell,
anything it is running, and anything it backgrounded all keep going. See `adr/0017`.

A daemon that starts and finds live sessions **adopts** them:

1. Ask the host what is still running
2. Read each session's directory, shell and workspace from `session_meta`
3. Read the workspace layout, dropping panes whose session did not survive, because a pane that
   can never produce output is worse than an absent pane
4. Replay the host's output buffer to rebuild each screen
5. Serve, so a reconnecting tab attaches to the session it had

Verified end to end against `kill -9` of the daemon, which is the worst case because nothing gets
to run on the way out: the process survived, the tab reconnected without an expiry page, the
earlier output was on screen, and the session still accepted commands.

What this does **not** cover is the host itself being replaced or killed. That is rare by design,
and when it happens the sessions are genuinely gone and the tab falls back to §8.

---

## 10.6 Reset

Sessions now genuinely persist, which means they also accumulate, and a system that survives
everything needs a deliberate way to stop surviving.

A right click on the toolbar icon offers **Reset TabTerm**. It opens a confirmation rather than
acting, because the entry sits beside Settings and the cost of a misclick is somebody's running
work. The confirmation states the damage in numbers, warns separately when a session is mid
command, puts focus on Cancel, and styles the destructive button as destructive.

Confirming ends every session, deletes every history file, closes every TabTerm tab, and
optionally replaces the daemon and the PTY host. The host is stopped first and deliberately: it
is what keeps PTYs alive, so a reset that left it running would be a reset that changed nothing.
The daemon then exits non-zero, which is what asks launchd to start a new one.

**The confirmation draws before anything is connected.** Waiting for the daemon to report its
sessions first produced a blank page whenever the daemon was unreachable, which is precisely the
situation somebody reaches for a reset in. It renders with what it knows and fills in the counts
if they arrive.

---

## 11. macOS reboot

A process cannot survive a reboot. Nothing can change that.

What *is* restored is context: the layout tree, each pane's directory, its last command, its
explicit argv if it had one, and a text snapshot of what was on its screen. Implemented in
`daemon/src/restore-store.ts`.

### What is written down, and when

Snapshots are taken **on layout change and on shutdown**, never on a timer. A workspace that has
not changed does not need saving again, and a timer would write constantly for nothing. Shutdown
is the important one: a machine restarting is the case this exists for, and it is the last moment
the screens are still readable.

Two rules that exist because of what they prevent:

- **An empty screen never overwrites a captured one.** A pane whose session has already gone
  reports nothing, and letting that erase the recording would destroy the only reason to offer a
  restore.
- **A pane that left the layout stops being restorable.** Otherwise a pane someone deliberately
  closed would come back on every restart, which is the opposite of what closing it meant.

### What restore actually does

The layout is rebuilt as a chain of splits rather than by writing the old tree back, because the
stored tree names session ids that no longer exist. The *shape* is preserved; the identities are
not, which is the honest thing to do when the processes are gone.

Each pane comes back as a fresh shell in the directory it was in, showing the screen it had, and
then a line written into the terminal state itself:

```
[restored 2 hours ago. This is a new shell in ~/code/app, not the original process.]
```

That line is not decoration. The one thing this feature must never do is let someone believe
their build is still running.

**Replaying the last command is opt-in per restore, and even then it is typed, not run.** The
command lands at the prompt and waits for Enter. Re-running whatever was last in a pane is
occasionally exactly right and occasionally destructive, and the daemon cannot tell which.

Restore is **offered, never automatic**, and a used record is deleted, so the same layout is not
offered forever. Records are pruned after 14 days.

Covered end to end by `daemon/src/reboot-restore.test.ts`, which shares one database across two
daemon lifetimes and asserts the restored panes have the same directories and **different pids**.
