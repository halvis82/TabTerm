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

## 2.8 What a browser saying "I do not have it" is worth

The invariant below forbids ending a terminal on absence of evidence. That is right, and the first
version of it drew the line in the wrong place: it required an explicit `tab-closed` message for
**any** automatic ending, which made the background timeout unreachable for every tab closed
before that message existed. Sessions from days earlier sat in Running Now marked "background" and
outlived the setting meant to end them.

The line is now between two things that were treated as one:

| | |
|---|---|
| **Nobody is reporting**, or a browser has just connected, or an extension is being replaced | Silence. Not an account of anything. The terminal is kept |
| **A settled browser**, connected and reporting for thirty seconds, with its tabs enumerated, does not list this workspace | A live account of what that browser has. The timeout applies |

Every unsafe case is in the first row. Chrome quitting takes its reporter with it. A crash does the
same. A browser starting up, or an extension being replaced, produces a short list on the way past,
which is why a reporter has to have settled before its list counts as complete: it is not that the
list is wrong, it is that it is not finished.

**One unsettled reporter withholds the conclusion for everybody.** A second profile still waking up
knows nothing yet, and its silence must not be read as agreement with the browser that has finished
speaking.

This was revisited deliberately after being decided the other way two days earlier. Both readings
protect against losing work; only this one also does what the person asked the setting to do.

## 2.9 The invariant everything else here serves

**TabTerm never ends a live terminal without positive evidence of a deliberate act that
authorizes it.**

Absence is not intent. Disconnect is not intent. Shutdown is not intent. Failure is not intent.
Timeout alone is not intent. When uncertain, the process is preserved.

There are exactly six things that authorize TabTerm to signal somebody's process, and every one of
them is named in the type that the code requires at the moment of termination:

| Cause | What authorizes it |
|---|---|
| `user-kill` | A person chose Kill session |
| `user-closed-pane` | A person closed a pane that held nothing worth offering an undo for |
| `user-replaced-pane` | A person merged a session into a pane, displacing what was in it |
| `user-reset` | A person confirmed Reset TabTerm |
| `expired-after-tab-close` | A person closed that specific tab, and the background timeout they chose has run out. Carries the closing that authorized it |
| `expired-after-pane-close` | A person closed that pane, and its grace period has run out |

A process that exits on its own does not come through here at all: TabTerm did not end it.
Reconciling records does not either. A session the PTY host no longer has is let go of with
`forgetLostSession`, which signals nothing, because the process is already beyond reach and
sending a kill would reach whichever host is connected now.

**What is deliberately not on that list:** a closed socket, a browser quitting, a window closing,
a crash, a machine sleeping, an extension reloading, a tab being discarded, a daemon restarting, a
PTY host reconnecting, a reporter disappearing, a report that arrived empty or late or out of
order, and a second browser profile saying it does not have a workspace it never had.

---

### Killing the last session in a tab closes the tab

`Close session` on the only pane in a tab has always closed the tab. `Kill session` did not: it
ended the terminal and left the tab sitting there with a dead one in it.

The tab decides this itself, from the number of panes it had **when the kill was asked for**
rather than when the exit arrives. Those are different numbers: the daemon removes the killed pane
and sends a new layout, and that layout can be applied before the exit is announced, so a tab with
two panes looks like a tab with one at exactly the moment it is asked whether it had only one.

Only for a session this tab asked to end. A process that exits on its own leaves the tab up: its
output is usually the reason somebody ran it, and a tab that vanishes when a build finishes takes
the result with it.

### Ending is confirmed, and confirmation means gone

A destructive request that is only a frame put on a socket is a guess about what happened. The
daemon asks the PTY host to end a session and waits to be told what became of it.

**The answer means the process is gone, not that ending it was begun.** The host runs the
escalation, `SIGHUP` then `SIGTERM` then `SIGKILL`, and then asks whether the pid is still there.
Only `gone` lets the daemon discard its record. A reply meaning "termination started" would let it
forget a process that is still running, and a process nothing can see, reach or end is worse than
one lingering in a list.

Each step waits **until the process is gone** rather than for a fixed length of time; the patience
is a ceiling for something ignoring a signal, not a price every kill pays. An ordinary shell dies
on the first signal in a few milliseconds.

A host too old to answer, a host that says the process survived, a host that never replies, and no
identified host at all are all treated the same: not confirmed. The session stays where it is,
logged, and visible in Running Now.

### Nothing that names a session reaches an unidentified host

Holding the outbox until `hello` was not enough. A socket existing was enough for any **new**
message to be written straight to it, so a spawn, a write, a resize or a kill issued during the
handshake went to whichever process answered. After a host has been replaced that is a different
process holding different sessions.

The connection has three states now: disconnected, handshaking, ready. Only the handshake itself
may be written while handshaking, because it names no session and is what identifies the host at
all. Everything else is held. A kill is not even held: it answers "not confirmed" straight away,
since a queued kill is aimed at a process that may be gone by the time anything is flushed.

### The PTY host identifies itself

A socket is not an identity. The host generates an instance id when it starts and returns it in
`hello`, and the daemon compares it on every reconnection.

The same instance means the terminals are exactly where they were, whatever the socket did:
nothing is ended, sessions are reconciled, and output produced during the gap is replayed. A
different instance means the old host's sessions are genuinely beyond reach; those records are let
go of with `forgetLostSession`, which signals nothing, because sending a kill would reach a process
that never had them.

Anything the daemon was holding to send is dropped rather than delivered to a host it has not
identified. Writes, resizes and kills all name sessions, and a session id means nothing to a
different process; at best the frame is ignored, at worst a kill lands on an id the new host
happens to know. The outbox used to be flushed the moment a socket existed, before `hello` had
even been sent.

### The host resists ordinary signals

The host owns the only handles to every running session, so exiting it makes all of them
unreachable through TabTerm, which from the person's side is the same as having killed them.

A plain `SIGTERM` is not a statement of intent. It is what a packaging script, a stray
`killall node`, a `launchctl kickstart` aimed at the daemon, or a session manager tidying up
sends without knowing what this process is. A host holding sessions logs why it is staying and
carries on. An empty one stops, because there is nothing to lose.

The deliberate way to stop it is Reset, which ends the sessions first and leaves it holding
nothing. `TABTERM_HOST_FORCE_STOP=1` is the escape hatch for uninstalling.

### No terminal the daemon would take with it

`LocalPtyBackend` spawns terminals as children of the daemon, so every one of them dies when the
daemon does, and the daemon is restarted by an ordinary update. It used to be the automatic answer
whenever the durable host failed to start, with a warning in a log nobody reads.

A product whose promise is that processes outlive the interface has to fail closed when the thing
that keeps that promise is unavailable. With no host, no terminal is created: the daemon runs, the
interface works, and it says what is wrong. `TABTERM_ALLOW_LOCAL_PTY=1` brings the old behavior
back for development.

**Refused, not half-served.** `create` throws, in the one method every route to a new terminal
goes through, and the socket answers `pty-host-unavailable`. Building a session and a workspace
around a process that was never started would leave a pane showing nothing, a row in Running Now
for a pid that does not exist, and a person with no idea why.

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

**Detaching is not a step towards being ended.** It says somebody stopped looking. A backgrounded
tab, a discarded tab, a sleeping machine, a dropped socket, a quitting browser and a restarting
daemon all produce it, and none of them is anybody saying they are finished with a terminal.

The daemon genuinely cannot tell those apart, and that is exactly why a closed connection starts
no clock at all. The two questions are separate:

| | |
|---|---|
| A socket closed | transport and view state: `detached` |
| Somebody closed a specific tab | possible authorization to expire, and only then |

The second never arrives by inference. It arrives as a `tab-closed` message from the extension,
which is the only party that can see the difference between a person closing a tab and a browser
taking its windows down.

**And it is sent in two stages.** The extension checks that Chrome called this an individual tab
removal rather than a window closing, that it knows which workspace the tab held, and that no
other tab still shows it. Then it waits a moment and checks again: the same extension lifetime
still running, and the workspace still unshown.

That wait is the point. Chrome's API makes no promise that an extension being reloaded, updated or
shut down never produces an `onRemoved` looking exactly like somebody closing a tab, and relying on
it not doing so is relying on an observation rather than on a contract. If the extension is being
replaced or the browser is going away, the lifetime is gone before the wait ends and the candidate
dies with it. The lifetime is a value in `chrome.storage.session`, which survives the worker being
stopped and started and does not survive a reload.

Losing a genuine close this way costs a terminal that lingers until somebody ends it by hand.

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
| The reap policy | The daemon, on a timer | Never while a tab exists. Never while nobody has said, until the abandonment horizon. §4 |
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
    never reap, until the abandonment horizon: reap after 7 days undetached

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

**A timer means "look again", never "act on what I decided when I set it."** When it fires, the
policy is asked again with everything known now, and a session whose reason to go has gone away
returns to `detached`. So does one whose reason goes away without the timer firing at all, which
it had not: a session put on a clock and then reprieved by a tab coming back kept the `expiring`
label for the rest of its life, having been told it was safe. That is the reprieve, and it is a state change like any other: it was
missing from the transition table, so it threw, and by then the timer had already been dropped.
The session was left in `expiring` with nothing to move it, neither reaped nor kept. The case is a
laptop waking, where every overdue timer fires at once, before Chrome has said which tabs it has,
and then the tabs come back.

**The clock measures elapsed time, not time since anybody last asked.**

A scheduled reap keeps a **deadline**, and re-deciding does not restart it. The timer used to be
cleared and started again from zero on every re-decision, and the policy is re-run for every idle
session on every report of open tabs, which the extension sends every two minutes. Any timeout
longer than that interval could therefore never elapse: a thirty minute setting left sessions
sitting in Running Now an hour later, marked background, because the countdown had restarted
twenty-nine times.

The deadline is kept only while the **reason** is unchanged. A different decision is a different
circumstance and starts a fresh clock, and the deadline is dropped outright wherever the clock is
void rather than paused: a tab reattaching, a session pinned or made persistent, and a change to
the timeout itself, which was measured against the old value.

This changes no rule about what may be ended. It only lets a decision that was already made
finish, and every safety check still runs again at the moment the timer fires.

**What may be written is what will be honored.** The background timeout is clamped by one
constant at both ends. Accepting a value on the wire that startup would refuse means a setting a
person chose is on disk, correct, and discarded on the next start in favour of the default, with a
log line as the only trace. The floor is the shortest the settings panel offers.

**A session whose process is already gone is not scheduled at all.** `exited` may only become
`reaped`, so asking for `expiring` threw, which sounds like a stray warning and is not: the two
callers that reschedule reaping loop over every session at once, and the throw escaped from a
socket close handler, so a single exited session stopped the loop and every session after it kept
whatever timer it already had. Twenty nine of these in one day on a real machine. The guard is in
`#scheduleReap`, which is the one place all three callers pass through.

Reap escalation: `SIGHUP` → wait → `SIGTERM` → wait → `SIGKILL`. A process group is signalled, not
just the leader, so orphaned children do not survive. Note what the first of those does to an exit
code: a hung-up shell exits non-zero, which is why a reaped session must never be reported as a
process that failed. See `06-chrome-integration.md` §7.

---

### There is no abandonment horizon any more

There used to be one: nobody has reported this workspace for a week, so end it. It was there for a
real problem. On 2026-09-02 enough unclaimed sessions accumulated to exhaust `kern.tty.ptmx_max`
and stop every terminal on the machine, in every application, including ones that share no code
with this project.

It is gone, because it was a timer with no authorization behind it. A week of silence is still
silence: a laptop shut in a drawer, a browser not started yet, an extension being replaced, a
report that arrived without this workspace in it. None of them is anybody closing a terminal, and
a rule that ends processes after a week of not knowing is a rule that ends processes on a guess.

**The intentional trade.** TabTerm would rather leak an abandoned session than risk ending an
active one. Those two mistakes are not comparable: the first costs a shell that outlives its
usefulness, which appears in Running Now with its folder and its last screen and can be ended by
hand in one click. The second costs somebody's work, and nothing brings it back.

The pressure the horizon existed to relieve is answered where it belongs: sessions that nobody can
account for are **visible** rather than **destroyed**.

### A pane nobody used

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

**Nor does it apply to a pane that shares its workspace with others.** An arrangement somebody
built is work, whether or not a given pane in it has been typed into. On 2026-09-04 an extension
reload closed every TabTerm tab, and thirty seconds later five panes of a template were gone,
correctly by the letter of the rule and wrongly by every other measure. A workspace of one is
the case the rule was written for, and the case it keeps: opening a tab, looking at it, and
closing it leaves nothing behind.

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

`merge-session { sessionId, workspaceId, targetPaneId, direction, replace? }`

1. Daemon validates the session is not already in another workspace
2. Layout tree is updated transactionally: the target pane becomes a split containing itself and
   the merged session
3. Session record gets `attachedWorkspaceId` and `attachedPaneId`
4. The source standalone tab closes
5. **The PTY is untouched at every step.** Verified in tests by a running counter that must not skip

The receiving tab's Chrome group is preserved. A merge never moves the receiving tab.

### Merge into a pane rather than beside it

`replace` takes the target pane over: it keeps the pane and its id, puts the arriving session in
it, and ends the session that was there. `direction` does not apply.

This is what "bring a session here" means. A pane only offers that choice while nothing has been
typed into it, so the session being displaced is an untouched shell, and splitting the pane left
that shell beside the session somebody asked for, with the offer gone. The displaced session is
ended rather than left running, because it is in no layout and nothing can reach it.

Keeping the pane id matters beyond tidiness: the split ratios around a pane are recorded against
it, so a replacement leaves the rest of the arrangement exactly as it was.

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

The offer of a shell in the previous directory is focused, so Return takes it. Landing here from
Command+Shift+T is ordinary rather than exceptional, and a page whose only way forward is finding
a button with a mouse makes the restore read as a dead end when what somebody wanted was a shell
in that folder.

Focused, not taken. Nothing runs automatically, and that is what makes the page safe to land on:
a restored tab that started a shell by itself would mean Chrome reopening ten tabs starts ten
shells, in ten directories nobody asked about, against a pseudo-terminal supply that is finite
(`10-limitations.md`).

The previous cwd and last command come from SQLite, which retains expired session metadata per
the retention table.

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

Chrome exiting closes every connection. Every session becomes detached, and nothing is reaped.

**Not because workspaces happen to be pinned by default.** That was the old answer and it was a
weak one: it made safety depend on a setting somebody could change, and on a default that a
different rule might one day override. The reason is stronger and does not depend on configuration
at all.

A browser quitting produces no close evidence. Chrome tells the extension that its tabs are going
away with `isWindowClosing` set, which the extension declines to treat as anybody closing a
terminal; and a browser that is gone reports nothing at all, which is a gap in what is known
rather than a statement about anything. With no evidence, the reap policy answers
`no-close-evidence` and schedules nothing, whatever else is true of the session.

The same reasoning covers closing a window, quitting with Command+Q, a crash, and the machine
going to sleep. None of them can produce the one message that authorizes an expiry.

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
4. Replay the host's output buffer to rebuild each screen, **at the size it is really running
   at**, which the host reports alongside everything else. Replaying into an emulator of the wrong
   width wraps every line in the wrong place, and adoption used to pass eighty by twenty-four for
   every session regardless
5. Serve, so a reconnecting tab attaches to the session it had

Verified end to end against `kill -9` of the daemon, which is the worst case because nothing gets
to run on the way out: the process survived, the tab reconnected without an expiry page, the
earlier output was on screen, and the session still accepted commands.

### Every way a session can end, and what guards each

| How | When it is right | What holds it back |
|---|---|---|
| The process exits on its own | Always. The shell is gone | Nothing to guard: this is the terminal ending, not the daemon deciding |
| `Kill session` from a menu | A person asked for it, naming the pane | Acts on the pane that was right-clicked, not the focused one |
| Closing a pane with siblings | A person asked for it | **Not ended.** Held for five minutes so it can be taken back |
| Closing the only pane | The workspace goes with it and there is nowhere to put it back | Unreachable from the page, which refuses to close a lone pane |
| A shell displaced by a merge | It is in no layout, so nothing could ever reach it again | Only the pane that was replaced, never the one that replaced it |
| Reset | A person confirmed a sentence that says so | A confirmation, not a button |
| The reap policy's timer | Only what the policy decides, re-decided when the timer fires | The whole of §4, checked below |
| The PTY host being replaced | Those processes really are gone | The host is **asked** what it still has first |

The policy is the only one of these that is not a person asking, so it is the one that is swept
rather than sampled: **every combination of its inputs**, six thousand of them, checked against the
things that must never happen. A session with somebody looking at it is never ended. Nor is one
whose tab is open, unless its pane was deliberately closed and the undo window is running. Nor a
pinned or persistent one. Nor one serving on a port. Nor one that was given a command to run, by
the rule about untouched shells. Nor one sharing a workspace, which is the fault that ended five
terminals thirty seconds after an extension reload.

And "ends" is not the right question to ask of it. Everything the policy schedules is re-decided at
the moment the timer fires, so a long delay is not a countdown to a death, it is a promise to look
again later. The sweep asks how soon, not whether.

### A pane whose process ended stops being a pane, and the tab has to be told

The workspace drops the pane and the tabs showing that workspace are sent the new layout. The
sending is the part that was missing: it went out through the broadcast that reaches the **control
role only**, which is the service worker, so the announcement that a pane had gone was delivered
exclusively to the context that cannot draw anything. Every tab kept the pane.

A pane holding a dead terminal is worse than no pane. It looks exactly like a live one and
swallows everything typed into it, which is what "I can't close or kill a session from the
right-click menu" and "after closing an agent I can't always type commands again" both look like
from the outside. Neither was about the menu or the agent.

A pane that ran a **declared command** is the exception and keeps its pane: its output is the
reason it existed, and closing it the instant the command finished would throw away exactly what
was being waited for.

### A reconnect is not proof that anything died

When the connection to the host comes back, the daemon **asks what the host still has** before
letting go of anything. Sessions it still holds are kept and their missed output is replayed from
the sequence number the daemon last saw, so no screen comes back with a hole in it. Sessions it
does not have are genuinely gone.

This used to end every session the moment the socket reconnected, on the reasoning that a
reconnect means a new host and a new host means the old one's processes are gone. The second half
is true and the first half is not: the socket is reconnected after any close at all, including
ones the host survives, and its own error handler closes it. One `ECONNRESET` would have ended
every terminal on the machine while every one of their processes was still running and still
adoptable. Nobody hit it, which was luck rather than design.

If the host cannot be asked at all, **everything is kept**. The two mistakes are not equal: ending
a session cannot be undone, and keeping one costs a terminal that answers nothing until the next
reconnect, seconds away.

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

**A pane that was running an agent says so specifically:**

```
[restored 2 hours ago. The claude conversation above is history, not a running session.
 This is a new shell in ~/code/app. Resume it from the start screen.]
```

"This is a new shell" is true and, in front of a Claude or Codex transcript, still misleading:
the conversation is the thing on the screen, and the conversation is what is not running.
Somebody scrolling up to read what their agent said needs to be told that plainly, and told where
to pick it back up rather than left to work it out.

Which agent is read from what was **running in the pane**, not from how the pane was opened. A
shell somebody typed `claude` into is an agent pane just as much as one launched as one, and a
pane opened as an agent whose CLI has since exited is not one any more. The plain sentence is
kept for a plain shell, because agent language on every restore is how an honest line becomes one
people stop reading.

**Replaying the last command is opt-in per restore, and even then it is typed, not run.** The
command lands at the prompt and waits for Enter. Re-running whatever was last in a pane is
occasionally exactly right and occasionally destructive, and the daemon cannot tell which.

Restore is **offered, never automatic**, and a used record is deleted, so the same layout is not
offered forever. Records are pruned after 14 days.

Covered end to end by `daemon/src/reboot-restore.test.ts`, which shares one database across two
daemon lifetimes and asserts the restored panes have the same directories and **different pids**.
