# ADR-0010 — Own the PTY rather than wrapping tmux

**Status:** Accepted

## Context
Session persistence, reattach, scrollback capture, and detach are collectively a reimplementation of
tmux. `tmux -CC` control mode, which iTerm2 uses, would hand us persistence, reattach, scrollback
capture, and detach for free over a line protocol.

## Decision
Own the PTY. Do not wrap tmux. Study `grid.c` and iTerm2's control-mode integration for how they
solved the problems, then solve them ourselves.

## Consequences
- Full control over VT semantics, resize behavior, and truecolor passthrough, none of which have to
  negotiate with a second emulator.
- The split layout is a browser-side tree that does not have to map onto tmux panes. Merge and detach
  stay symmetric operations on our own model.
- We carry the cost of ADR-0004's headless emulator ourselves.
- Users who already run tmux inside a shell are unaffected. Nested tmux is a fixture in the test set.

## Alternatives rejected
- **tmux control mode as the persistence layer.** Real shortcut, but tmux's VT and resize semantics
  would leak into every feature from shell integration onward, and its pane model does not match a
  browser split tree.
