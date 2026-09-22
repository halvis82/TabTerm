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
| User prompt submitted | `working` | Running favicon, and the only hook that starts a turn's clock |
| Tool use pending approval | `approval` | Approval favicon, **critical notification**, title status |
| Notification | `waiting` | Waiting favicon until the tab is looked at, important notification |
| Stop | `idle` | Idle favicon, completion notification if past the duration threshold |
| Session start | `starting` | Title switches to the agent form |
| Non-zero completion | `failed` | Failure favicon, critical notification |

**A turn is timed from the prompt, and the hook name is what says so.** Two hooks derive `working`
and only one of them means a turn began, so the hook's own name travels with the state it mapped
to. Reading the start from the state instead meant a turn was restarted by its own interruptions:
`Notification` is a rest, so the tool call after a permission prompt was indistinguishable from the
beginning of new work, and an hour of it reported as the seconds since the last approval. A turn
that never asked anything was right, which is how it went unnoticed.

The number therefore includes the time a person spent answering, because "an agent finished, took
four minutes" is read as four minutes since they asked. Subtracting their thinking time gives a
defensible number that is not the one that sentence claims. A turn whose prompt was never seen,
after a daemon restart or hooks switched on mid-session, reports nothing at all rather than a
duration measured from whatever was seen first.

**A state is news when it is entered, not while it lasts.** Reported as five desktop
notifications in five seconds, all of them "an agent is waiting for you", from tabs where nothing
was happening. The daemon raised one for every event that reported a state rather than for a
session entering it, and an agent's hooks are not a state machine anybody controls: a notification
hook fires when the agent wants somebody, it can fire again, and a subagent fires its own.

Entering a state is news. Being in it is not. Entering it repeatedly is not news more than once a
minute either, because a person who has been told an agent is waiting does not need telling again
a second later, and a notification that arrives five times is not five times as useful. An
approval is exempt from that floor: it blocks the agent until somebody answers it, so a second one
really is a second thing waiting on a person.

**A notification usually arrives after the stop, not before it.** An agent raises it about a
minute after it finishes a turn, when nobody has replied. That ordering is why the waiting favicon
clears on being looked at rather than on the next event: there is no next event. See
`06-chrome-integration.md`.

**State is replayed to a client that attaches.** It is pushed on change and never polled, so a
reloaded tab would otherwise show idle for an agent that is waiting for somebody.

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

### The one thing only the hook knows

The payload an agent hands its hooks carries that agent's **own** session id, which is what
`--resume` takes. It is nowhere else: not in the environment the session was started with, and not
anywhere on the screen, which this product does not read anyway. So the hook script reads its
standard input, takes `session_id` out of it, and sends it along with the state.

Read only when something is actually piped in, so a hook run by hand from a terminal returns
instead of waiting on a keyboard, and capped, so a large payload cannot make a script on the
agent's critical path slow. The id is checked at both ends against a plain identifier and dropped
otherwise, because it ends up in text somebody is invited to paste into a shell.

It reaches a page twice: with the state it was learned from, and with the attach, for the same
reason a pane's name and its timers are on the attach. No hook fires because a page reloaded, so
without it a reattached tab could not offer the command until the agent was next spoken to.

### The hook never waits on anybody

The agent runs this script and waits for it, so anything in it that blocks is time the agent spends
not answering. Reading the payload until end of input meant trusting the agent to close a pipe
before we would let it carry on, and a writer that holds the pipe open turns a hook into a timeout
and loses the event entirely. That matters most for `Stop`, which is the event that ends a turn:
lose it and the turn's timer runs forever and the notification never comes.

The read is bounded at one second, far longer than a payload takes to arrive and far shorter than
the agent's own hook timeout. A read that times out still reports the state, which is the half the
product depends on; only the session id is missed.

Every hook that arrives is now recorded in the daemon log at `info` level: the hook name, the state
it maps to, and whether it ended a turn. Names and states only, never anything an agent said or was
asked. Before that, whether an agent's `Stop` was reaching the daemon at all was unanswerable, and
that single fact is what separates a broken hook from a broken turn from a broken notification.

### Copy the command that reopens it

Right clicking a pane running an agent, or its card in `Running now`, offers **Copy resume
command**, which is:

    cd <the session's directory> && claude --resume <the agent's session id>

The directory is part of the answer. `--resume` does work from anywhere, which was checked rather
than assumed: resuming from `/tmp` reopened the transcript of a session that had been running in a
project directory. What it does not do is put the agent back in the folder the conversation was
about, so it read and wrote the wrong files while showing the right transcript. `&&` rather than
`;` so a folder that has been renamed since stops the command instead of starting an agent
somewhere arbitrary.

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

### Started in the room it is going to run in

Everything the start screen starts is started at the size of the pane it will have, **after** that
screen has gone. The strip under the start screen is a few rows tall on purpose, because the
terminal keeps the bottom of the window while the screen is up, and that strip was what every
launch measured and asked the daemon for.

For a shell it is one reflow and invisible. For an agent it is fatal: three rows is no room to draw
an interface in at all. Read out of his own daemon log, `pty.spawned cols 163 rows 3`, followed by
a resize to 47 rows and then `session.exited` twenty four seconds later. Reported as resuming an
agent session "just not working at all", with a prompt answered by `Interrupted`.

So the screen is dismissed first and the size taken afterwards: dismissing takes the strip off the
terminal and refits the panes in the same task, so the number that goes to the daemon describes the
pane the session is actually going to run in. One function does both, because they are one act, and
every launch from that screen goes through it: a layout, a template, a project, a restore, a custom
action, and a resumed agent.

### Both agents are always reachable

The merged list takes turns between the agents rather than sorting purely by recency. One agent
is usually the one in daily use, so its conversations are always the newest, and a list cut to a
few rows would never contain a single row for the other: the feature would be present, correct
and unreachable. Recency still decides the order within each agent, and whichever has the single
newest session leads.

### Six rows, and the rest one click away

The start screen is a shortcut, not an inventory, so the list is cut to six. It carries a control
saying how many more it holds, which opens it out to fifteen. The recent folder list below it works
the same way, and stops at the same place: a list long enough to scroll past the buttons under it
is a different screen, and the search box already covers finding something by name.

The two numbers come from one function, `listWindow`, because they have to agree. A section drawing
six while offering nine more is one list counted twice. What the control offers is what opening out
would add, not what is currently missing: derived from what is missing, it reaches zero the moment
the section opens and the control vanishes with no way to close the list again.

Being open is held in memory rather than stored. Opening a list out answers "where is that other
one", which is a question somebody has while looking, not a preference to carry between sessions.

### What is typed at an agent that is still starting is held, not lost

A resumed agent draws its input box seconds before it will act on anything: it reads a transcript
that can be tens of megabytes, sets the terminal up, and only then listens. A prompt typed into
that window came back with its first characters missing and the turn reported as
`[Request interrupted by user]`.

Measured through the product, typing as soon as the box appeared: **four of nine** attempts came
back interrupted, at a person's typing speed as well as at a synthetic one. The same conversations,
resumed in a plain terminal and typed into at the same moment, answered **eight times out of
eight**. So it is something about a session started here, and the cause is not found. This is not a
claim to have found it.

What it does is stop the loss. Keystrokes at a resumed agent are held until the pane has printed
something and then been quiet for 900 ms, with a floor of two seconds and a ceiling of twelve, and
then sent in the order they were typed. Nothing is dropped, because losing what somebody typed is
the fault being fixed and swallowing it silently would be the same fault wearing different clothes.

Only a resumed agent, and only its first moments. A shell is ready when it prints its prompt and
none of this goes near one. Somebody who types into the window is told once, in a line at the
corner, that what they type is being held; a resume nobody types at says nothing at all.

### The folder comes from the session, not from the directory it is filed under

The store names a directory after the project path with `/`, `_` and `.` all replaced by the same
hyphen. Only the first of those can be put back, so any project with an underscore or a dot in its
path decoded to nothing that exists, and **every conversation in it was invisible**. Asked directly:
"does it only get the ones from ~/ or the ones from any folder it was started in?" It was very
nearly the first. Measured on this machine: 50 conversations across 4 folders, with 9 of TabTerm's
own among the ones that could not be reached, because the path contains `personal_coding`.

Every record in a session file carries the folder the session was in, and the end of the file is
already read to learn the two other things a row needs, so the folder comes back exactly and the
directory's name stops being evidence at all. Afterwards: 66 conversations across 13 folders.

The directory name is still used when it happens to work, and a folder the daemon already knows is
still encoded forward, because both are cheaper than a read. What changed is that failing to decode
one no longer throws its conversations away.

Nothing is guessed. A session whose file does not say where it was is left out, and so is one whose
folder has since been moved or deleted, on the same reasoning as the rest of this section.

### One row per conversation, not one per file

Resuming writes a **new** file that records the same conversation id, so a conversation picked up
twice was offered three times over and every one of those rows resumed the same thing. Found on a
real store while checking something else: three rows for one conversation and two each for two more,
inside the first twelve offered.

The newest file wins, which is where the walk already is, and the conversation is taken as soon as
it is seen rather than after the list is filled, so a duplicate never takes one of the places.

**Both stores have this and both are fixed.** Codex writes a new rollout for a resumed conversation
in the same way, and its list showed the same row twice, minutes apart. There the newest rollout
wins too, which also means the label describes the conversation as it stands rather than as it
began.

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

### Sessions a program wrote, rather than a person

Claude Code records how each session was started, and sessions driven through its SDK are written
to the same store as sessions somebody typed. They are not work anyone would resume: they are a
program's own conversations, held with itself, and they are generated continuously. On one real
machine 123 of 161 stored sessions were `sdk-ts`, every one of them belonging to a single plugin,
and all of them newer than any real work. They filled the launcher and left nothing else visible.

**An entrypoint beginning `sdk` is not offered.** Matched on the prefix, so a later `sdk-py` needs
no release. Everything else is kept, including an entrypoint the daemon does not recognise and a
file too old to carry the field: a real session hidden from the list is a worse failure than an
odd one shown, and this is the only category known to be machine-made.

**The field is read from the end of the file, not the start.** It sits inside the first
conversation record, and in the machine-made sessions this exists to exclude, that record runs to a
median of 159 KB and a maximum of 623 KB. A bounded read of the start therefore returns a truncated
line that will not parse, finds no entrypoint, and keeps every session it was meant to reject. The
entrypoint is repeated on every turn, so the end carries it too: one 64 KB read from the end
classified 151 of 161 files, and the rest have no entrypoint anywhere and are kept regardless.

That is the same read the title comes from, so a candidate costs one read whether it is offered or
rejected.

**The check happens while the list is filled, not after it is cut.** Machine-made sessions are the
newest, so taking the newest `limit` and then filtering returns an almost empty list with real work
sitting just below the cut. The walk down the sorted candidates stops as soon as the list is full.

Codex needs no equivalent. Its store records an originator, and every value seen there is a person
at a terminal or at the desktop app.

### A session is labeled with the title the agent kept

Claude Code writes a short title for each session and rewrites it as the work moves on, so the last
one describes what the session became. That is what a row shows.

The first thing typed is the fallback, and a weak one: it is often a pasted file path, or a request
whose subject only became clear later. `/Users/me/Downloads/TabTerm.md talk to me. go through this
thoroughly` was a real row; the title for the same session was `Review TabTerm project plan and
feasibility`.

The title is read from the **end** of the file, because that is where the current one is. In a
97 MB transcript it sat 21 KB from the end. Codex writes no such record, so its rows keep the first
prompt.

### A stored turn is shown as sentences

What is in those files is what the agent was sent and what it sent back: markdown, tables written
with pipes, fenced code, and machinery that is not conversation at all. Flattened into one line for
a row in a list, that came out as noise. Reported with a picture: rows made entirely of
`<task-notification>`, and a paragraph whose middle was `| 8 | 52.0, 46.0, 42.3 | 9.7 points |`.

These rows exist to tell one stored session from another, so what belongs in them is the sentences.
A turn that is only machinery is dropped rather than shown blank, emphasis is kept as the words it
was emphasising, a table's cells are joined the way a sentence joins things, and code says that it
is code rather than pasting itself. Nothing is invented and ordinary prose is untouched. See
`readable-turn.ts`.

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

## What "launch an agent" runs

A setting, held by the daemon and shown as a text box in the settings panel. It defaults to
`claude`.

It has to be one, because the browser-wide shortcut of that name is a key somebody binds once and
presses for a year, and until now it ran whatever was compiled in. Someone whose agent is `codex`,
or `claude --model opus`, or a binary in `/Applications`, had no way to say so.

The string is split into argv by the daemon and **never handed to a shell**. Quotes are honoured,
because a path with a space in it is ordinary on a Mac. Nothing else is: no variables, no globs,
no operators. `claude; rm -rf ~` becomes a program named `claude;` that does not exist, which is a
harmless error rather than an instruction.

The shortcut and the toolbar menu entry both open **a new tab** with it running, which is what the
command is called. The shortcut used to split the focused terminal when there was one and open an
empty terminal when there was not, so the same key did two different things and neither was the
one on the label.

## Whether an agent is installed at all

Detection looks for the command on `PATH` and in the usual install locations, not merely for a
configuration directory in the home folder. `~/.claude` survives uninstalling Claude Code, and a
panel that says hooks are installed for a tool somebody does not have is worse than one that says
nothing.

When none is found, the panel says how to get one rather than only that there is none. When one
is found, it names **where the hooks live**, which is the agent's own settings file rather than
anything of TabTerm's: the hook script is ours, in `~/.local/libexec/tabterm`, and the entry that
calls it is written into the agent's configuration. That is the half worth pointing at when
somebody asks where this lives or wants to remove it by hand.

## Reading a session before resuming it

A resumable session shows one line: which agent, when, the first words of a prompt, and where.
That is not enough to tell three of them apart when all three begin "help me with".

So a row expands, in place, into the last turns of its conversation. What is below is pushed down
and nothing is covered, because deciding between three of these means reading them where they are.
One is open at a time, the panel is bounded in height, and it is drawn already scrolled to the
end, which is the part that says what a session was about by the time it stopped.

**Nothing is started to do this.** Resuming a session to find out whether you want to resume it
changes the thing being inspected, costs money and takes seconds. The agent's own store is read:
`~/.claude/projects/<encoded path>/<id>.jsonl` for Claude Code, and the newest rollout under
`~/.codex/sessions/` for Codex. The last 256 KB, so a session that has been running all day opens
instantly.

Tool calls, tool results, hook output and session metadata share those files and none of them is
conversation, so they are left out: a panel full of them says less than an empty one. The formats
are nobody's promise, so every record that is not recognised costs a turn and nothing more, and a
file that cannot be read at all says so in a sentence rather than failing.

The path is carried from the listing rather than worked out from the id. Claude's directory naming
is lossy, and a Codex rollout is named after a timestamp: neither survives the round trip, and a
transcript shown against the wrong session would be worse than none.
