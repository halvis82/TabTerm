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

  That lock has to be exclusive in its contents and not only in its existence. Claiming it by
  creating the file and then writing the owner's pid leaves an instant where the file is there and
  empty; a second process reads no pid, takes that for no owner, removes the file and claims it,
  and two hosts then own one socket path. That is the failure this design cannot survive, since
  the loser unlinking the winner's socket takes every terminal on the machine with it. Observed
  2026-09-08 under load, about once in thirty-six starts: two hosts reached `listen()` together
  and one died with `EADDRINUSE`.

  The claim is now written to a private file and **linked** into place. `link` refuses a name that
  already exists, so it is exclusive in the same way, and the lock is never observable without an
  owner in it. A lock holding no pid is therefore read as a claim in progress and left alone,
  while a lock holding the pid of a process that is gone is still taken over: a crash always
  leaves a valid pid, because the pid is in the file before the name exists.
- **Updating the host itself still ends terminals**, when it is eventually restarted. The
  installer now compares the staged file and leaves it alone when the bytes are identical, so an
  ordinary update that changes only the daemon or the extension does not touch it at all. That
  makes it rare rather than solved: a release that genuinely changes the host still costs the
  sessions it is holding.
- Two things that were previously written only at shutdown are now written when they happen: a
  workspace row on creation, and the session-to-workspace link. State written only on a clean exit
  is not persisted state, and adoption reads exactly those two things.

## Coming back is a phase, not an instant

The host adds a socket to its broadcast set the moment it connects, before any handshake, so a
daemon that reconnects starts receiving **live** output immediately and asks for the range it
missed afterwards. Those are two streams down one socket with nothing sequencing them.

Measured, with a session that kept running across the break, the sequences arrived in this order:

```
171, 241, 109, 170, 171, 241
```

Bytes from after the break first, then older bytes from during it, then the same two again.
Applied to a terminal emulator in that order it is not a glitch; it is a wrong screen that nothing
downstream can detect, which for a product whose promise is the exact screen is the worst kind of
wrong. The daemon could not have sorted it out either, because the backend dropped the host's
sequence before anything saw it.

A connection therefore **reconciles** before it goes live. Live frames are held with their
sequence, the replay the daemon asks for lands in the same buffer, and the daemon says when it has
caught up: adoption and reconnection are the same situation, one with the whole history as its gap.
The held frames are then merged by sequence and each byte is delivered once, which is also what
removes the duplicated overlap. The same measurement afterwards:

```
106, 170, 171, 241
```

Two bounds stop this being a new way to fail. The hold is capped at 8 MB, after which it is
released in order, because a screen missing bytes is visible and recoverable while a daemon that
has run out of memory is not. And it is released anyway after five seconds, so a daemon that never
finishes catching up produces a late terminal rather than a silent one.

## A consumer that stops reading is dropped, not queued

This process holds every PTY master on the machine, and it is the one thing here that cannot be
restarted without ending somebody's work. When a daemon stops draining its socket, three things
could give, and only one of them is acceptable:

| | |
|---|---|
| Block the PTY | Somebody's build stops because a browser is busy. No |
| Queue in the host without limit | The one process that cannot be restarted runs out of memory. No |
| Drop that transport | Costs a reconnect, which is already whole. Yes |

Measured: a peer that connects and never reads leaves the host queueing without any bound at all.
Sixteen megabytes is now the limit for one connection, past which the connection is destroyed and
the terminals it was watching are untouched. The bounded ring and the replay protocol already exist
to make what follows correct, so the cost of being dropped is a reconnect and a catch-up.

The same rule covers replay, which is the largest thing this process ever hands over. A peer that
does not drain a replay must not be able to hold the ring in memory twice.

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
