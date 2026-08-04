# ADR-0002 — Node + node-pty daemon, vanilla TypeScript extension

**Status:** Accepted

## Context
The daemon needs correct PTY semantics, a WebSocket server, and SQLite. The extension renders
terminals across potentially a dozen tabs at once.

## Decision
Daemon: Node with node-pty, `ws`, and SQLite. Extension: vanilla TypeScript, no framework.
A Rust daemon is explicitly deferred and not required.

## Consequences
- node-pty is a native module. Install may require Xcode CLT if prebuilds are unavailable, measured
  in the node-pty spike. This is the main cost of the choice.
- Shared types and the protocol codec live in `shared/` and are imported by both sides.
- No framework means no virtual DOM overhead multiplied across every terminal tab, per design
  principle 8. Terminal rendering is xterm.js; the surrounding UI is small.
- Rust remains available later for the daemon without changing the protocol.

## Alternatives rejected
- **Rust daemon in v1.** Lower memory and cleaner packaging, but slower to a correct PTY layer and
  the packaging win is largely erased by ADR-0006's app bundle anyway.
- **React in the extension.** Buys component ergonomics for a UI that is mostly one canvas.
