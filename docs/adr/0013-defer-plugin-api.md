# ADR-0013 — Defer the plugin API until the seams are known

**Status:** Accepted

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
