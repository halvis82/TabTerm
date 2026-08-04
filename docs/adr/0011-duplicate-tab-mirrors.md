# ADR-0011 — Duplicating a tab mirrors the session

**Status:** Accepted

## Context
Duplicating a tab looks like it should work naturally. It does not.
`chrome.tabs.duplicate` produces two tabs with the same `?workspace=` and therefore two frontends on
one PTY. Neither mirroring nor forking is a default; one has to be chosen.

## Decision
Duplicate **mirrors**. Both views attach to the same session and see the same stream and the same
snapshot. PTY size is the minimum cols and minimum rows across all attached clients, computed per
dimension. A detaching client triggers recomputation, which may grow the PTY. With zero clients the
PTY retains its last size.

## Consequences
- Useful behavior for free: the same session visible in two windows, tmux-style.
- Resize arbitration becomes a required, tested rule rather than an accident.
- The same machinery covers two Chrome profiles attaching to one session, see ADR-0003 and the multi-profile work.
- Mirroring interacts with merge: a mirrored session merged into a workspace stays mirrored.

## Alternatives rejected
- **Fork a new session in the same cwd.** Loses the running process, which is what the user was
  looking at when they hit duplicate.
- **Refuse to duplicate.** Cannot. Chrome does not ask permission.
