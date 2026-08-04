# 09 — Agent CLI Integration

An agent CLI works in TabTerm the moment a PTY exists, because it sees a real terminal. Nothing is
required for baseline functionality.

Everything in this document is about the layer above that: knowing what the agent is doing so the tab
can show it.

---

## 1. The rule

> Never parse the agent's terminal output to make a control decision.

Screen-scraping a TUI is brittle by construction. It breaks on every version bump, on every theme
change, on a narrow window, and silently. A favicon driven by a regex against rendered output is
worse than no favicon, because it will confidently be wrong.

agent CLI exposes a **hooks** system that fires a command on lifecycle events. That is a
structured, supported channel and it is what we use (ADR-0009).

---

## 2. Hook bridge

agent CLI hooks post to a daemon endpoint authenticated with the same token as the WebSocket.
The daemon correlates the event to a session via `TABTERM_SESSION` from the hook's environment.

```
agent CLI hook fires
  → posts { event, sessionId, payload } to the daemon
  → daemon updates session agentState
  → control connection emits agent-state
  → offscreen document decides notification
  → terminal page updates favicon and title
```

### Event mapping

| Hook event | Derived state | Surfaced as |
|---|---|---|
| User prompt submitted | `working` | Running favicon, elapsed timer starts |
| Tool use pending approval | `approval` | Approval favicon, **critical notification**, title status |
| Notification | `waiting` | Waiting favicon, important notification |
| Stop | `idle` | Idle favicon, completion notification if past the duration threshold |
| Session start | `starting` | Title switches to the agent form |
| Non-zero completion | `failed` | Failure favicon, critical notification |

### What hooks cannot tell us

Stated so no feature assumes it.

| Not available | Consequence |
|---|---|
| Fine-grained "thinking" versus "writing a file" | One `working` state, not a progress narrative |
| Token counts or cost, live | Not surfaced |
| The content of a pending approval, in general | Notification says an approval is pending, and points at the pane. The detail lives in the terminal where the user reads it |

We do not fill these gaps by scraping. A missing state is shown as unknown.

---

## 3. Installation and reversibility

Hook installation is **opt-in and reversible**.

1. It never rewrites unrelated settings. It adds its own entries and leaves everything else byte
   identical
2. It is idempotent. Running it twice produces one set of hooks
3. Uninstall removes exactly what was added
4. `tabterm doctor` reports whether hooks are installed and whether events are arriving
5. If the hook format changes in a future agent CLI version, the bridge degrades to no state
   information. It never crashes and never falls back to parsing output

---

## 4. Correlation across concurrent sessions

Multiple agent sessions run at once, in different panes and different projects. Every event
carries the session ID from `TABTERM_SESSION`, so correlation is exact rather than heuristic.

Tested explicitly with three concurrent agent sessions in one workspace, asserting that each
event lands on the right pane.

---

## 5. Fast launch

The default action is **open the agent in a new native Chrome tab**, because that preserves
the central model where terminal sessions behave like Chrome tabs. Opening in a split is the
secondary action.

```
Current terminal: ~/Projects/eeg-analysis
Action: Open agent

  → create a PTY with the same cwd (or the repository root, per config)
  → run the configured the agent command
  → open as a new native Chrome tab at currentIndex + 1
  → inherit the current tab's group
  → title: agent — eeg-analysis
  → track state in the favicon via the hook bridge
```

Configurable per project:

```json
{
  "agent": {
    "command": ["agent"],
    "defaultOpenMode": "new-tab",
    "cwdMode": "project-root"
  }
}
```

`command` is argv, never a shell string, per `05-security.md`.

Reachable from the command palette, the control bar, the right-click menu, the launcher, the project
dashboard, a file-path context menu, and a keyboard shortcut. The shortcut is configurable because
Chrome and other extensions may reserve combinations.

---

## 6. Session resume

agent CLI persists its own session records. TabTerm reads them to offer resume, per the session resume work.

- Resume IDs are discovered from the agent's session store, not guessed
- Offered on the expired-session recovery page and in the launcher
- **Never auto-resumes.** Always an explicit action
- If the store format changes, discovery returns nothing and the feature disappears cleanly. No crash

This is what makes reboot restore (the reboot restore work) meaningful for the agent panes: the process cannot survive,
but the conversation can be picked back up.

---

## 7. Deliberately not built

| Idea | Why not |
|---|---|
| Preview diffs in the browser | Requires structured diff data hooks do not provide. Would mean parsing output |
| Show files modified as browser UI | Same. The terminal already shows it |
| Rich in-browser permission approval buttons | Would require injecting input into the agent's TUI based on a browser click, which is a privileged action driven by parsed state. Explicitly against the rule in §1 |
| Jump to references | Superseded by generic path detection in the path detection work, which works for every tool rather than just the agent |

What we do instead: surface **state** richly (favicon, title, notification, elapsed time) and let the
terminal remain the place where the interaction happens. The tab tells you agent needs you. the agent
handles the rest.
