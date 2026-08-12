# 08 — Shell Integration

The daemon can see bytes. It cannot see meaning. Shell integration supplies the meaning: where you
are, when a command started, when it ended, and how it ended.

**We do not invent a protocol.** OSC 7 and OSC 133 already exist, are what iTerm2, WezTerm, Kitty,
and Ghostty use, and give us exactly the fields the design needs (ADR-0008).

---

## 1. What it enables

| Feature | Depends on |
|---|---|
| Dynamic tab titles from cwd and repository | OSC 7 |
| Relative path resolution for clickable paths | OSC 7, plus the command's cwd from OSC 133 |
| Command start, end, duration, exit code | OSC 133 |
| Time-aware context | OSC 133 |
| Cross-session command history | OSC 133 |
| Recent directories and project index | OSC 7 |
| Notification on long command completion | OSC 133 |
| Scrollback archive delimited by command | OSC 133 |

Without it, TabTerm still works as a terminal. Every feature above degrades to unavailable, not to
broken. The integration must fail silently when absent.

---

## 2. OSC 7 — current directory

```
ESC ] 7 ; file://<hostname><path> ESC \
```

Emitted on `chpwd`. The daemon parses it, updates the session's `cwd`, resolves the git root, and
maps the directory to a project.

The daemon **validates** the payload: length-capped, must be a `file://` URL, path must be absolute
and must exist. Hostile output emitting a fake OSC 7 changes a display field and nothing else. It
never reaches a spawn path or a filesystem write.

---

## 3. OSC 133 — command marks

The four marks:

| Mark | Sequence | Meaning |
|---|---|---|
| A | `ESC ] 133 ; A ST` | Prompt starts |
| B | `ESC ] 133 ; B ST` | Prompt ends, command input begins |
| C | `ESC ] 133 ; C ST` | Command output begins |
| D | `ESC ] 133 ; D ; <exit> ST` | Command finished with exit code |

From these the daemon derives a complete `CommandRecord` (`03-data-model.md` §3): command text,
cwd at launch, start time, end time, duration, exit code, and interrupted status.

### zsh wiring

```
preexec  → emit C, capture the command line and the current cwd
precmd   → emit D with $?, then A
PS1      → embed B at the end of the prompt
chpwd    → emit OSC 7
```

Interruption is derived from the exit code (`130` for `SIGINT`), producing `interrupted: true`
rather than a plain failure.

---

## 4. What it cannot see

Stated plainly so no feature quietly assumes otherwise.

| Blind spot | Consequence |
|---|---|
| **Commands inside full-screen apps** | Anything typed inside `vim`, an agent CLI, a REPL, or `less` produces no record. Only shell-level commands are captured |
| **Remote SSH sessions** | The remote shell must have the integration installed. Without it, `host:` and `exit:` history filters return nothing for that session. See `10-limitations.md` tier 1.3 |
| **Non-zsh shells** | v1 targets zsh only. bash and fish are not implemented |
| **Alt-screen periods** | Deliberately produce no command records and no archived output |

---

## 5. Working without it

**The integration is optional.** It is exact, instant, and free, and it requires editing a
dotfile, which most people have not done. "Your history, command timing, server detection, and
pane status do nothing until you edit `.zshrc`" is a bad answer to a question the operating
system can already answer.

`daemon/src/foreground.ts` and `daemon/src/command-tracker.ts` provide a fallback.

### How it works

A shell's foreground child is visible in `ps`, marked with `+` in its state field, **with its
full argv**. So the command line comes back exactly, from the OS, rather than being
reconstructed from keystrokes or scraped off the screen. Both of those alternatives are
heuristics, and a heuristic that puts the *wrong* command in someone's history is worse than one
that puts none there.

It walks down from the shell rather than looking only at direct children, because a command is
often a grandchild: `npm test` spawns node, `git log` spawns a pager.

### Why there is a timer here, when the rest of the daemon has none

`11-performance.md` requires any timer to justify why an event cannot serve instead:

- **Starting is event-driven.** Nothing happens until the user presses Enter, which the daemon
  already sees as input on its way to the PTY. One `ps` follows, once. Typing does not trigger
  anything — that would be a process listing per keystroke.
- **Finishing has no event.** A process exiting produces no output, no input, and no signal the
  daemon can observe. So a check runs while a command is known to be in flight, and **only**
  then. An idle shell — the overwhelmingly common state — has no timer at all.

The interval is deliberately slack. Elapsed time is computed in the frontend from the start
timestamp, so a late end costs a slightly late "finished", never a wrong duration.

### It defers to the real thing

The first OSC 133 mark from a session shuts the fallback down for that session permanently, and
abandons anything it was mid-way through rather than completing it. Two sources of truth would
double every history entry.

### What the fallback cannot see

| Blind spot | Consequence |
|---|---|
| **Shell builtins** | `cd`, `export`, `alias` spawn no process, so they produce no record. For `export` this is an improvement: the command whose text is most sensitive is the one that never appears |
| **Exit codes** | The OS does not report one for a process that is already gone. Records are stored without an exit code rather than with a guessed one, because `exit:fail` has to mean something. The tab shows a third state for it rather than assuming success, see ADR-0016 |
| **Sub-second commands** | Something that finishes inside the start delay is never seen |

With the integration installed, all three of those work. That is the reason to install it, and
it is now the only reason.

The exit code is the one a person sees. Without it a tab can say a command **finished** but never
that it **failed**, so the green tick and the red cross in `06-chrome-integration.md` §5 simply
never appear. That is a better argument for sourcing it than any paragraph here.

### Installing it

Offered, never automatic. Three routes, all reaching the same code:

| Route | For |
|---|---|
| Settings, Shell integration | The common case, with the line added for you |
| The line printed by `scripts/install.sh` | Anybody who would rather paste it themselves |
| `scripts/doctor.sh` | Says whether it is sourced, and prints the line if not |

The line is guarded, marked, and removable:

```
[ -f "$HOME/.local/share/tabterm/tabterm-integration.zsh" ] && source "$HOME/.local/share/tabterm/tabterm-integration.zsh" # tabterm-shell-integration
```

**The guard is the load-bearing part.** An unguarded `source` of a file that TabTerm's uninstaller
has removed prints an error on every prompt, in every terminal, forever. `.zshrc` is backed up
once before the first change, only lines carrying the marker are ever removed, and turning it on
twice adds one line.

Whether it is really sourced is answered by a live session emitting command marks, not by reading
the profile. It can be sourced from anywhere, and a line that is present but never runs looks
identical from the file.

---

## 6. Installation

```
shell/tabterm-integration.zsh
```

Sourced from `.zshrc`:

```sh
[ -f ~/.local/share/tabterm/tabterm-integration.zsh ] \
  && source ~/.local/share/tabterm/tabterm-integration.zsh
```

Requirements on the script, all tested:

1. **Never clobbers existing hooks.** Uses `add-zsh-hook`, appends, never assigns over `precmd` or
   `preexec`
2. **No-ops outside TabTerm.** Detects `$TABTERM_SESSION` and does nothing when absent, so the same
   `.zshrc` works in iTerm and over SSH
3. **Adds no measurable prompt latency.** Verified by a benchmark, no subprocess spawns on the
   prompt path
4. **Degrades silently.** Every failure path is a no-op, never an error printed at the prompt
5. **Does not export secrets.** The session ID is not the auth token

Installation is offered, never performed automatically. `tabterm doctor` reports whether it is
present and working.

---

## 7. Editor wrapper

Editor reuse needs a Neovim server socket to reuse an existing editor instead of spawning a new one per
click. TabTerm controls the launch when it starts the editor, but not when the user types `nvim`
themselves.

The integration therefore injects a wrapper function that adds a listen socket to a
manually-invoked `nvim`. The socket path is derived from the session ID and lives under the
TabTerm state directory.

The wrapper is opt-in via config, because overriding a command in someone's shell is intrusive and
should be a choice.

---

## 8. Session identity in the environment

The daemon exports into each PTY:

| Variable | Purpose |
|---|---|
| `TABTERM_SESSION` | Session ID. Enables the integration, used to correlate hook events |
| `TABTERM_VERSION` | Feature detection |
| `TERM=xterm-256color` | |
| `COLORTERM=truecolor` | |

`TABTERM_SESSION` is a plain identifier, not a credential. It appears in `ps` output and in any
subprocess environment. Nothing authenticates on it. The auth token is never placed in a PTY
environment.
