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

### Three ways in, one implementation

Reachable as a switch in settings, as a prompt during install, and as a command. All three call
the same code, so they cannot disagree about which events are wired or what an entry looks like.

| Route | For |
|---|---|
| Settings, Agent events | Somebody who installed the extension and never opened a terminal to configure it |
| `scripts/install.sh` | The prompt during install, skipped when no terminal is attached |
| `node scripts/install-agent-hooks.mjs [--remove\|--status]` | Scripts, and anybody who prefers it |

The switch works because the daemon is a local process with filesystem access. The extension
cannot edit a settings file, and asking a browser page to do it would be worse if it could.

**Why this is a switch and not a line in the install output.** It used to be the latter, and the
result was that essentially nobody ran it. Agent state then does nothing, silently, with no way
to tell that from an agent CLI that simply never needed attention. A feature whose failure mode
is indistinguishable from working is not installed, whatever the documentation says.

The helper is built as its own bundle, separate from the daemon. The daemon imports `node:sqlite`
at load, so on a Node too old for it the daemon cannot even print its own help, and the installer
has to work before anything else does.

### Detected, and supported

Installation covers every **supported** agent CLI whose configuration directory exists. Others
are reported as found and unsupported rather than passed over in silence. Writing hooks in a
format that has not been verified produces entries that never fire, which is worse than nothing
because it looks like success.

| Agent CLI | Settings | State |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | Supported |
| Codex | `~/.codex/config.toml` | Detected, format not verified |

### Installed is not working

The status carries `lastEventAt` beside `installed`, because they are different claims. Hooks
present that have never fired is a real state, and the one worth being able to see.

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

## 5.5 The PATH a spawned command gets

A LaunchAgent starts with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. A terminal never noticed, because
a shell is spawned with `-l` and rebuilds its own environment on the way up. Anything spawned as a
**command** did notice, and no agent CLI is in those four directories: `claude` and `codex` live
in `~/.local/bin` and Homebrew. So launching an agent, resuming one, and every command a project
template declares failed to spawn at all.

The daemon asks the login shell for its `PATH` once and caches it, which is the same mechanism a
terminal already depends on, so what a command gets and what a person gets in a shell are the same
thing by construction. The executable is then resolved against that `PATH` here rather than left
to the spawn, because `posix_spawnp` searches the PATH of the process doing the spawning, not the
one being handed to the child.

A command that still cannot be found is reported **into the session's own output**, the way a
shell reports one, so it reaches the screen, the scrollback, and any tab that reattaches later. A
pane that showed an exit code and nothing else could not distinguish a missing agent CLI from a
crash.

---

## 6. Session resume

Each agent CLI keeps its own session records on disk. Claude writes to `~/.claude/projects/` and
Codex writes to `~/.codex/sessions/YYYY/MM/DD/`. TabTerm reads both, in
`daemon/src/agent-sessions.ts` and `daemon/src/codex-sessions.ts`.

- Resume IDs are discovered from the store, never guessed
- Offered in the launcher and on the expired-session recovery page
- **Never auto-resumes.** Listing is not resuming; a person clicks
- The id is passed as argv to the agent CLI, never through a shell

### They do not resume the same way

This is the difference that made resume look broken. Claude takes a flag and Codex takes a
subcommand:

| Agent | Command |
|---|---|
| Claude | `claude --resume <id>` |
| Codex | `codex resume <id>` |

`codex --resume <id>` is rejected with `error: unexpected argument '--resume' found`, which is
what every attempt to resume a Codex session produced. The table lives in
`daemon/src/agent-resume.ts` so a third agent is a row rather than a branch.

**In the session's own directory**, which the row carries. An agent resumed somewhere else has
different files in front of it: for Claude that is a different project, and for Codex it is a
conversation about the wrong tree.

### Both agents are always reachable

The merged list takes turns between the agents rather than sorting purely by recency. One agent
is usually the one in daily use, so its conversations are always the newest, and a list cut to a
few rows would never contain a single row for the other: the feature would be present, correct
and unreachable. Recency still decides the order within each agent, and whichever has the single
newest session leads.

### Nothing is offered that would fail

A row is a promise. Before a conversation is listed, three things are checked, none of which the
store knows:

1. **The CLI is reachable**, on the login shell's PATH rather than launchd's four directories
2. **The directory still exists.** Resuming into a deleted project fails immediately
3. **The store said which conversation it is.** A Claude summary sidecar has no `sessionId` and
   is refused by the CLI; a Codex rollout with no `session_meta` has neither an id nor a
   directory

The same rule governs the rest of the launcher: recent folders that have been deleted are
dropped from the list and from the table, and a saved workspace whose directories are all gone
is not offered for reopening.

### Reading somebody else's format

Two formats, and they agree on nothing. The Codex store states the working directory in its
first record, so nothing has to be reversed; its files are nested by date and sort
chronologically at every level, so the newest sessions are reached after reading a handful of
small directories rather than walking the whole tree.

The Claude store is the harder one:

This is an undocumented on-disk format that is free to change. Every assumption is checked and
every failure means "offer nothing" rather than an error. A store that has moved or changed
shape degrades to a launcher with no resume rows, never to a broken launcher.

**The directory naming is lossy and cannot be reversed.** The store names a directory after its
path with separators replaced, and underscores and dots are flattened the same way, so
`/a/b_c`, `/a/b-c` and `/a/b/c` all become `-a-b-c`. Guessing would attach a resume to the
wrong project.

The way around it is to go the other direction: the daemon encodes directories it already knows
from `recent_dirs` and looks for those names in the store. That is exact and free. Store
directories that no known path accounts for fall back to candidate decoding, and each candidate
is confirmed against the filesystem before being used; one that resolves to nothing is skipped.

**Labels are a bounded head read.** Session files reach megabytes and the first real message can
sit well past the start, behind session metadata and hook output, so 128 KB is read looking for
the first thing a person actually typed. Assistant turns, tool results, and injected context
wrapped in a tag are all skipped, since none of them make a useful label. A session with no
readable label still appears, identified by its id.

This is what would make reboot restore meaningful for agent panes: the process cannot survive,
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
