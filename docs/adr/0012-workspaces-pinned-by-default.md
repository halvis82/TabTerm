# ADR-0012 — Workspaces are pinned by default

**Status:** Accepted

## Context
An obvious policy is to reap detached sessions after 2 to 15 minutes. Under that
policy, closing a carefully built three-pane workspace and coming back an hour later destroys it, by
policy rather than by limitation. That is the opposite of the product's promise.

## Decision
Workspaces are pinned by default and never auto-reaped. Timer-based reaping applies to unnamed
scratch sessions only. Memory mode settings govern scratch sessions, not workspaces the user built
deliberately.

## Consequences
- The primary requirement (close a three-pane workspace, reopen it later, everything intact) holds
  for realistic gaps, not just for a quick accidental close.
- Memory grows with the number of workspaces the user keeps. Bounded by scrollback caps, not by
  reaping, consistent with the drain invariant.
- Users who want aggressive cleanup opt in per workspace or through low memory mode.
- The reap policy engine still handles listening servers, exited processes, and idle scratch shells.

## Alternatives rejected
- **Short timer-based reaping for everything.** Reaps things the user expects to find.
- **Never reap anything.** Scratch shells accumulate without bound.
