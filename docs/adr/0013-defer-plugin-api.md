# ADR-0013 — Defer the plugin API until the seams are known

**Status:** Accepted, precondition met, implemented after M6

## Context
It is tempting to treat the plugin system as a major early feature with a large registration surface. Designing a stable API before the internals exist freezes abstractions chosen
from speculation rather than from use.

## Decision
No plugin API before milestone M6. Personal customizations are written as core code first.
The API is extracted from seams that have proven themselves, with a precondition of at least three
real customizations existing as core code.

## Consequences
- Early work is not constrained by an API contract that would need breaking anyway.
- `plugins/` and the local-trusted model still exist in the repository layout, unused until the plugin API work.
- Project-local **declarative** configuration is not blocked by this and lands in the workspace template work and the project trust work.
  It is data, not extension points.
- When the API is written it will hide the PTY, Chrome tabs, WebSocket, database, and renderer
  internals, but the boundaries will be drawn from evidence.

## Alternatives rejected
- **Build the API in Phase 3 as originally planned.** Guarantees a rewrite once the internals settle.

## Outcome

The precondition was met and the API was written after M6, from five features that existed as
core code first: clickable paths, per-pane status, the agent hook bridge, the server-detected
offer, and the launcher's own sections. Four hooks came out of those shapes —
`decorateText`, `paneStatus`, `launcherItems`, `onSessionEvent` — and none of them were guesses.

Deferring turned out to matter for a reason nobody predicted. **Chrome's MV3 forbids executing
code that did not ship inside the extension package**, so the obvious design — plugins running
in the terminal page — is impossible. An API designed in Phase 3 would have been built against
that assumption and thrown away. Plugins run in the daemon instead, which incidentally enforces
half the security model: a daemon-side plugin has no access to Chrome tabs, the WebSocket, or
the renderer, because none of those exist in its process.

See `daemon/src/plugin-api.ts` and `plugins/README.md`.
