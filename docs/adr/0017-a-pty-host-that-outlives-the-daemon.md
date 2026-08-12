# ADR-0017 — A PTY host process, so updating TabTerm does not kill your terminals

**Status:** Accepted

**Amends:** invariant 1 in `01-architecture.md`

## Context

The daemon owned every PTY directly, as a child process, and its shutdown handler called
`killPty` on all of them. Stopping the daemon therefore destroyed every running process and every
screen of output in every tab.

That is not an edge case. It is what happens on **every update**, because installing a new daemon
means restarting it. It is also what happens on every crash. Measured before this change, with a
shell running `sleep 600 &`:

```
$ launchctl kickstart -k gui/501/com.tabterm.daemon
sleep 600 IS GONE
tab now says: "This terminal session expired."
```

The product's central promise is that a terminal outlives the thing looking at it. It delivered
that for the *view*: close a Chrome tab, reopen it, and the process is still there. It did not
deliver it for the *daemon*, and the daemon is the part that changes.

The practical consequence was that the author of this project kept using another terminal for
real work and only tested with TabTerm, because a session could disappear whenever anything
shipped. A terminal you cannot trust with a long running job is a demo.

## Decision

**A separate process owns every PTY.** The daemon connects to it over a unix socket.

```
  before                          after

  ┌───────────────┐               ┌───────────────┐   ┌──────────────┐
  │ daemon        │               │ daemon        │──▶│ pty host     │
  │  ├ PTYs       │               │  no PTYs      │   │  ├ PTYs      │
  │  ├ protocol   │               │  ├ protocol   │   │  └ output    │
  │  ├ database   │               │  ├ database   │   │     buffers  │
  │  └ policy     │               │  └ policy     │   └──────────────┘
  └───────────────┘               └───────────────┘
   restarting this                 restarting this    …does not touch this
   killed everything
```

The host is **deliberately boring**: file descriptors and bytes, no database, no browser-facing
protocol, no policy. It has no reason to change when a feature is added, which is what makes the
daemon safe to replace.

Three properties make it work:

1. **Started detached.** A child in the daemon's process group dies with it, and
   `launchctl kickstart -k` kills the group. The host gets its own group and ignores `SIGHUP`,
   `SIGINT` and `SIGPIPE`. It stops only on an explicit `SIGTERM`.
2. **Stopping is not killing.** Both the host's shutdown and the daemon's now let go of a socket
   and leave every process running. Only the in-process fallback kills, because those PTYs are
   children of a process that is ending anyway.
3. **Adoption.** A daemon that starts and finds sessions already running takes them over, rebuilds
   each screen from the host's output buffer, and restores the workspace layout from the database,
   so the tab reconnects instead of being told its session expired.

`spawn` is deliberately **not** awaited. The control handler that calls it is synchronous and
handles a client's messages strictly in order, so awaiting a round trip would let a later message
overtake an earlier one and turn "create then write" into "write then create". Ordering is
guaranteed by the socket instead, and the pid arrives through a callback.

## Consequences

- **An update no longer costs you your work.** Verified: a shell, its backgrounded job, and its
  scrollback all survive `launchctl kickstart -k` and a bare `kill -9` of the daemon, and the tab
  reconnects to the same session with its earlier output on screen.
- **Invariant 1 is reworded.** "The daemon owns processes" becomes "the PTY host owns processes,
  the daemon owns everything else". The spirit is unchanged and stronger: no PTY is tied to the
  lifetime of anything a user can restart.
- **Invariant 3 moves.** Always draining the PTY is now the host's job, which is a better home for
  it: a daemon that is restarting, wedged, or absent can no longer apply backpressure to a build.
- **A second process to reason about**, with a lock so only one runs, and a fallback path when it
  cannot be started at all.
- **Updating the host itself still restarts terminals.** It is small and changes rarely, and the
  installer can compare it before restarting it, but this is not solved, only made rare.
- Two things that were previously written only at shutdown are now written when they happen: a
  workspace row on creation, and the session-to-workspace link. State written only on a clean exit
  is not persisted state, and adoption reads exactly those two things.

## Alternatives rejected

**Keep PTYs in the daemon and never restart it.** Not a design, a hope. Updates exist.

**tmux or screen underneath.** Real session survival for free, and rejected because it adds an
external dependency and puts a second terminal emulator between the shell and the one in
`07-terminal-fidelity.md`. Alternate screen handling, mouse reporting and resize semantics would
all become somebody else's decisions.

**Pass the PTY file descriptors to the replacement daemon.** The most elegant option: a new daemon
inherits the descriptors and the old one exits. Rejected because `node-pty` does not expose the
master descriptor, so there is nothing to pass without patching it.

**Persist the text and accept that processes die.** Cheaper, and it is what reboot restore already
does, correctly, for the case where processes genuinely cannot survive. It does not answer this
one: a build that was running is not restored by remembering what it printed.
