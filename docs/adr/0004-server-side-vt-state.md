# ADR-0004 — Server-side headless VT state for reattach fidelity

**Status:** Accepted

## Context
A reopened tab needs to know what the screen looks like. Replaying a raw byte log does not work: the
moment an application used the alternate screen, the log contains a sequence of screens rather than
the current one, and replay produces garbage. This is the difference between a terminal that
reattaches and a terminal that clears and shows a fresh prompt.

## Decision
The daemon runs a headless terminal emulator per session, fed by the same byte stream as the
renderer, and serializes its state on attach. We use the headless build of the **same emulator** that
renders in the page.

## Consequences
- Reattach restores exact screen state, including a mid-edit vim buffer. This is the primary
  requirement, milestone M4.
- Using one emulator implementation makes daemon-versus-renderer parsing mismatches impossible by
  construction. That bug class is close to undebuggable.
- Per-session memory is tens of MB, not negligible. `11-performance.md` carries the numbers.
- The daemon must always drain the PTY, since the emulator must stay current even when detached.
- the VT fidelity spike validates round-trip fidelity against recorded fixtures before production code depends on it.

## Alternatives rejected
- **Raw byte log replay.** Breaks on alt-screen. Non-negotiable failure.
- **A different, lighter emulator daemon-side.** Any parsing divergence produces snapshots that
  restore subtly wrong.
- **No scrollback restore, screen only.** Loses the thing people actually reattach for.
