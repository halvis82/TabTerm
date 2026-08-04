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

## 5. Installation

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

## 6. Editor wrapper

Editor reuse needs a Neovim server socket to reuse an existing editor instead of spawning a new one per
click. TabTerm controls the launch when it starts the editor, but not when the user types `nvim`
themselves.

The integration therefore injects a wrapper function that adds a listen socket to a
manually-invoked `nvim`. The socket path is derived from the session ID and lives under the
TabTerm state directory.

The wrapper is opt-in via config, because overriding a command in someone's shell is intrusive and
should be a choice.

---

## 7. Session identity in the environment

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
