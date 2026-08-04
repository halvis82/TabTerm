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

```
if pinned or persistent:
    never reap

if session is attached (including attached to a workspace elsewhere):
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

## 9. Chrome quitting

Chrome exiting closes every connection. Every session becomes detached. Because workspaces are
pinned by default, nothing is reaped.

On Chrome restart, either Chrome's own session restore reopens the tabs (which then reattach
normally), or the launcher lists every running session so they can be reopened deliberately. Both
paths are supported; which one happens depends on the user's Chrome setting, which we do not control.

---

## 10. macOS reboot

A process cannot survive a reboot. Nothing can change that.

What is restored, by the reboot restore work, is context: layout tree, per-pane cwd, last command, project, a text
snapshot of what was on screen, and any agent resume ID. Restore is offered, never automatic, and
the UI states plainly that processes were restarted rather than resumed.

This is explicitly a deferred, ambitious feature. Nothing before M6 depends on it.
